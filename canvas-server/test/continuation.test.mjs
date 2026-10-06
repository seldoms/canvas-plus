import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { createContinuation, extractTailFrame, runSeamQc, seamNeedsReview } from "../src/continuation.js";
import { ffmpegAvailable } from "../src/delivery.js";
import { createProjects } from "../src/projects.js";
import { createSlotCandidates } from "../src/slot-candidates.js";
import { submitGenerationIntent } from "../src/generation-intent.js";
import { loadRegistry } from "../src/skills.js";

/**
 * M3.5 H3 续接（单元级，真实 Project 存储 + 假任务队列 + 注入假 preflight/抽帧/QC，绝不真打 GPU）：
 *   · 开链：契约 §3.6 九个续接字段完整写入；空 prompt / segments 越界 / 非法 seed → 400；shot 不存在 → 404；
 *   · 编排：段 N done → 自动接续段 N+1（尾帧抽取 + I2VA 模板 + 幂等键）；failed/canceled → 链停；
 *   · 分叉：404 CANDIDATE_NOT_FOUND / 409 PARENT_NOT_DONE；原链候选不动；首段 index = 父段+1；
 *   · resume：已完成段不重复入队；失败段 :r<K> 新 attempt；在跑段直接返回；完成链 job:null；
 *   · 派生视图：链 → 段 → parent 回溯；分叉链 parentCandidateId 指向他链候选；
 *   · 接缝 QC：seam 写入 + needsReview 门槛（SSIM<0.85 / freeze / ΔdB>12）；review 端点语义；
 *   · select 扩展：采用 take → 整链 approved、其它 take superseded、无 takeId 候选不动；
 *   · stalled 扫描：幂等续提交，不重复入队。
 */

const STORYBOARD_MD = `---
name: storyboard
description: 测试分镜
---

# 分镜

## 提示词模板

你是分镜师。
`;

function makeEnv(t) {
    const root = mkdtempSync(join(tmpdir(), "canvas-continuation-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "02-storyboard"), { recursive: true });
    writeFileSync(join(skillsDir, "02-storyboard", "SKILL.md"), STORYBOARD_MD);
    writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));
    const config = { dataDir: join(root, "data") };
    mkdirSync(config.dataDir, { recursive: true });
    const projects = createProjects({ dataDir: config.dataDir, stages: loadRegistry(skillsDir).stages });
    return { root, config, projects };
}

function seedShot(projects, projectId) {
    const { episode } = projects.episodes.save(projectId, { title: "第一集" });
    const { scene } = projects.episodes.addScene(projectId, episode.id, { locationId: "内景 海边", time: "夜", intent: "告别" });
    const { shot } = projects.episodes.addShot(projectId, scene.id, { index: 1, storyboard: { prompt: "a woman picks up a seashell" } });
    return { episodeId: episode.id, sceneId: scene.id, shotId: shot.id };
}

/** 假任务队列：实现幂等键（同 key 返回原 Job）与 change 事件，runner 绝不执行。 */
function fakeJobs() {
    const store = new Map();
    const keys = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        enqueue(job) {
            const key = typeof job.meta?.idempotencyKey === "string" ? job.meta.idempotencyKey : "";
            if (key && keys.has(key)) return store.get(keys.get(key));
            const created = { ...job, status: "queued", outputs: [], createdAt: new Date().toISOString() };
            store.set(created.id, created);
            if (key) keys.set(key, created.id);
            emit(created);
            return created;
        },
        get: (id) => store.get(id) || null,
        set: (job) => store.set(job.id, job),
        list: () => [...store.values()],
        on(event, handler) {
            if (event === "change") handlers.push(handler);
            return () => {};
        },
        finish(id, status, patch = {}) {
            const job = store.get(id);
            Object.assign(job, patch, { status, finishedAt: new Date().toISOString() });
            emit(job);
            return job;
        },
    };
}

const DEFAULT_METRICS = {
    boundarySsim: 0.94,
    boundaryPsnrDb: 33.1,
    freezeDetected: false,
    parentTailRmsDb: -20.5,
    childHeadRmsDb: -22.4,
    audioSeamDeltaDb: 1.9,
    seamIntegratedLufs: -18.2,
    seamTruePeakDbfs: -4.1,
    width: 480,
    height: 832,
    fps: 24,
    audioSampleRate: 44100,
};

/** 建 continuation 实例：submitIntent 走真实 M1 链（假 jobs + 假编译器），preflight/抽帧/QC 全部注入假实现。 */
function makeContinuationEnv(t, { seamMetrics, wire = true } = {}) {
    const { config, projects } = makeEnv(t);
    const project = projects.create({ title: "续接" });
    const { episodeId, shotId } = seedShot(projects, project.id);
    const jobs = fakeJobs();
    const calls = { preflight: 0, tailFrame: [], seamQc: [] };
    const continuation = createContinuation({
        config,
        episodes: projects.episodes,
        jobs,
        submitIntent: (intent) =>
            submitGenerationIntent(intent, {
                jobs,
                runner: async () => ({ outputs: [] }),
                getProject: (id) => projects.get(id),
                promptCompiler: async (input) => ({ prompt: `compiled:${input.facts?.prompt ?? ""}` }),
            }),
        preflight: async () => {
            calls.preflight += 1;
        },
        extractTailFrame: async ({ videoPath, outputPath }) => {
            calls.tailFrame.push({ videoPath, outputPath });
            mkdirSync(dirname(outputPath), { recursive: true });
            writeFileSync(outputPath, "png");
        },
        runSeamQc: async (input) => {
            calls.seamQc.push(input);
            return { ...DEFAULT_METRICS, ...(seamMetrics || {}) };
        },
    });
    /** 捕获 handleTerminalJob 的异步接续 Promise（生产侧 fire-and-forget，测试必须 await）。 */
    const pending = [];
    if (wire) {
        jobs.on("change", (job) => {
            const promise = continuation.handleTerminalJob(job);
            if (promise) pending.push(promise);
        });
    }
    const settle = () => Promise.all(pending.splice(0));
    const slotId = `slot_${shotId}_clip`;
    const slotOf = () => projects.episodes.get(project.id, episodeId).shots.find((shot) => shot.id === shotId).generationSlots?.find((slot) => slot.id === slotId) || null;
    return { config, projects, project, shotId, episodeId, jobs, continuation, calls, settle, slotId, slotOf };
}

const doneOutputs = (jobId, file = "seg.mp4") => ({ outputs: [{ url: `/api/artifacts/${jobId}/${file}`, type: "video" }] });

// ——— 开链：字段完整性（契约 §3.6 新写入必须完整） ———

test("开链：T2VA 首段入队，Job meta 自描述 + 幂等键，候选九个续接字段完整", async (t) => {
    const { continuation, project, shotId, jobs, calls, slotId, slotOf } = makeContinuationEnv(t);

    const result = await continuation.startChain({ projectId: project.id, shotId, prompt: "海浪声中的告别", segments: 3, seed: 100 });
    assert.equal(result.takeId, result.chainId, "D35-1：takeId == continuationChainId");
    assert.equal(result.slotId, slotId);
    assert.match(result.chainId, /^chain_/);
    assert.equal(calls.preflight, 1, "提交前 preflight");

    const job = result.firstJob;
    assert.equal(job.template, "video_minimax_h3_t2v", "seg0 用 T2VA 模板");
    assert.deepEqual(job.meta.continuation, {
        chainId: result.chainId,
        takeId: result.takeId,
        segmentIndex: 0,
        totalSegments: 3,
        prompt: "海浪声中的告别",
        seed: 100,
        parentCandidateId: null,
    });
    assert.equal(job.meta.idempotencyKey, `continuation:${result.chainId}:seg0`);
    assert.equal(job.meta.projectId, project.id);
    assert.equal(job.meta.shotId, shotId);
    assert.equal(job.meta.slotId, slotId);
    assert.equal(job.params.PROMPT, "compiled:海浪声中的告别", "段 prompt 走 M1 编译链");
    assert.equal(job.params.SEED, 100);
    assert.equal(job.params.OUTPUT_PREFIX, `continuation/${result.chainId}_seg0`);
    assert.equal(jobs.list().length, 1);

    const candidate = slotOf().candidates[0];
    assert.equal(candidate.jobId, job.id);
    assert.equal(candidate.takeId, result.takeId);
    assert.equal(candidate.parentCandidateId, null);
    assert.equal(candidate.approvalStatus, "pending");
    assert.equal(candidate.continuationChainId, result.chainId);
    assert.equal(candidate.segmentIndex, 0);
    assert.equal(candidate.parentArtifactId, null);
    assert.equal(candidate.contextArtifactId, null);
    assert.equal(candidate.latentArtifactId, null);
    assert.equal(candidate.continuation, null);
    assert.equal(candidate.status, "queued");
});

test("开链校验：空 prompt / segments 越界 / 非法 seed → 400；shot 不存在 → 404", async (t) => {
    const { continuation, project, shotId, jobs } = makeContinuationEnv(t);
    await assert.rejects(() => continuation.startChain({ projectId: project.id, shotId, prompt: "  ", segments: 2 }), (error) => error.status === 400 && error.field === "prompt");
    await assert.rejects(() => continuation.startChain({ projectId: project.id, shotId, prompt: "x", segments: 0 }), (error) => error.status === 400 && error.field === "segments");
    await assert.rejects(() => continuation.startChain({ projectId: project.id, shotId, prompt: "x", segments: 9 }), (error) => error.status === 400 && error.field === "segments");
    await assert.rejects(() => continuation.startChain({ projectId: project.id, shotId, prompt: "x", segments: 2.5 }), (error) => error.status === 400 && error.field === "segments");
    await assert.rejects(() => continuation.startChain({ projectId: project.id, shotId, prompt: "x", segments: 2, seed: "abc" }), (error) => error.status === 400 && error.field === "seed");
    await assert.rejects(() => continuation.startChain({ projectId: project.id, shotId: "sh_nope", prompt: "x", segments: 2 }), (error) => error.status === 404 && error.code === "SHOT_NOT_FOUND");
    assert.equal(jobs.list().length, 0, "校验失败不得入队");
});

// ——— 编排：done 自动接续 / failed 链停 ———

test("段编排：seg0 done → 抽尾帧 + I2VA 自动提交 seg1；seg1 done 后链完成不再提交", async (t) => {
    const { continuation, project, shotId, jobs, calls, settle, slotOf } = makeContinuationEnv(t);

    const { chainId, firstJob } = await continuation.startChain({ projectId: project.id, shotId, prompt: "告别", segments: 2, seed: 7 });
    jobs.finish(firstJob.id, "done", doneOutputs(firstJob.id, "seg0.mp4"));
    await settle();

    assert.equal(jobs.list().length, 2, "seg0 done 后自动提交 seg1");
    const seg1 = jobs.list().find((job) => job.meta.continuation.segmentIndex === 1);
    assert.equal(seg1.template, "video_h3_i2v", "续接段用 I2VA 模板");
    assert.equal(seg1.meta.idempotencyKey, `continuation:${chainId}:seg1`);
    assert.equal(seg1.meta.continuation.totalSegments, 2);
    assert.equal(seg1.meta.continuation.seed, 8, "每段新 seed（父段 +1）");
    assert.equal(seg1.params.SEED, 8);
    assert.equal(calls.tailFrame.length, 1, "抽父段尾帧（内部步骤）");
    assert.ok(calls.tailFrame[0].videoPath.endsWith(`artifacts/${firstJob.id}/seg0.mp4`));
    assert.ok(seg1.params.INPUT_IMAGE.endsWith(`artifacts/${seg1.id}/context_frame.png`), "尾帧作为 first_frame 进模板");
    assert.equal(calls.seamQc.length, 0, "seg0 无接缝（N≥1 才做 QC）");

    const seg0Candidate = slotOf().candidates.find((candidate) => candidate.jobId === firstJob.id);
    assert.equal(seg0Candidate.status, "done");
    assert.equal(seg0Candidate.artifactUrl, `/api/artifacts/${firstJob.id}/seg0.mp4`);
    const seg1Candidate = slotOf().candidates.find((candidate) => candidate.jobId === seg1.id);
    assert.equal(seg1Candidate.parentArtifactId, `${chainId}/seg0#${firstJob.id}`);
    assert.equal(seg1Candidate.contextArtifactId, `/api/artifacts/${seg1.id}/context_frame.png`);

    jobs.finish(seg1.id, "done", doneOutputs(seg1.id, "seg1.mp4"));
    await settle();
    assert.equal(jobs.list().length, 2, "链已完成（1+1=totalSegments），不再提交");
    assert.equal(calls.seamQc.length, 1, "seg1 done 触发接缝 QC");
});

test("段编排：failed / canceled → 链停，不自动接续", async (t) => {
    const { continuation, project, shotId, jobs, settle, slotOf } = makeContinuationEnv(t);
    const { firstJob } = await continuation.startChain({ projectId: project.id, shotId, prompt: "告别", segments: 3 });
    jobs.finish(firstJob.id, "error", { error: "ComfyUI 执行失败" });
    await settle();
    assert.equal(jobs.list().length, 1, "failed 不自动接续");
    assert.equal(slotOf().candidates[0].status, "failed", "Job error → 候选 failed");
});

// ——— 接缝 QC：seam 写入 + needsReview 门槛 ———

async function runTwoSegmentChain(t, envOptions = {}) {
    const env = makeContinuationEnv(t, envOptions);
    const { continuation, project, shotId, jobs, settle } = env;
    const { firstJob } = await continuation.startChain({ projectId: project.id, shotId, prompt: "告别", segments: 2 });
    jobs.finish(firstJob.id, "done", doneOutputs(firstJob.id, "seg0.mp4"));
    await settle();
    const seg1 = jobs.list().find((job) => job.meta.continuation.segmentIndex === 1);
    jobs.finish(seg1.id, "done", doneOutputs(seg1.id, "seg1.mp4"));
    await settle();
    return { ...env, seg1 };
}

test("接缝 QC：指标写入子段候选 continuation.seam（契约最小形态 + metrics），默认不标 needsReview", async (t) => {
    const { slotOf, seg1 } = await runTwoSegmentChain(t);
    const candidate = slotOf().candidates.find((item) => item.jobId === seg1.id);
    assert.ok(candidate.continuation, "ContinuationMeta 已写入");
    assert.equal(candidate.continuation.overlapFrames, 1);
    assert.equal(candidate.continuation.addedFrames, 72, "73 帧段 - 1 重叠帧");
    assert.equal(candidate.continuation.width, 480);
    assert.equal(candidate.continuation.height, 832);
    assert.equal(candidate.continuation.fps, 24);
    assert.equal(candidate.continuation.audioSampleRate, 44100);
    const seam = candidate.continuation.seam;
    assert.equal(seam.reviewed, "pending");
    assert.equal(seam.needsReview, false);
    assert.equal(seam.freezeDetected, false);
    assert.equal(seam.rmsStepDb, 1.9);
    assert.equal(seam.audioCorrelation, null, "暂无量化手段的契约子字段填 null");
    assert.equal(seam.motionDrift, null);
    assert.equal(seam.metrics.boundarySsim, 0.94);
    assert.equal(seam.metrics.seamIntegratedLufs, -18.2);
    assert.equal(seam.metrics.seamTruePeakDbfs, -4.1);
});

test("接缝门槛：SSIM<0.85 / freeze / ΔdB>12 → needsReview:true（只标记不阻断）", async (t) => {
    const lowSsim = await runTwoSegmentChain(t, { seamMetrics: { boundarySsim: 0.8 } });
    assert.equal(lowSsim.slotOf().candidates.find((c) => c.jobId === lowSsim.seg1.id).continuation.seam.needsReview, true);
    const frozen = await runTwoSegmentChain(t, { seamMetrics: { freezeDetected: true } });
    assert.equal(frozen.slotOf().candidates.find((c) => c.jobId === frozen.seg1.id).continuation.seam.needsReview, true);
    const audioStep = await runTwoSegmentChain(t, { seamMetrics: { audioSeamDeltaDb: 26, parentTailRmsDb: -20, childHeadRmsDb: -46 } });
    const seam = audioStep.slotOf().candidates.find((c) => c.jobId === audioStep.seg1.id).continuation.seam;
    assert.equal(seam.needsReview, true);
    assert.equal(seam.rmsStepDb, 26);
    // 纯函数门槛：指标缺失（null）不误报。
    assert.equal(seamNeedsReview({ boundarySsim: null, freezeDetected: false, audioSeamDeltaDb: null }), false);
    assert.equal(seamNeedsReview(null), false);
});

test("接缝复核：review 写入 reviewed + reviewNote；非法值 400；无候选 404；无缝 409", async (t) => {
    const { continuation, slotOf, seg1, project, shotId } = await runTwoSegmentChain(t);
    const { candidate } = continuation.reviewSeam({ projectId: project.id, shotId, jobId: seg1.id, reviewed: "approved", note: "目看通过" });
    assert.equal(candidate.continuation.seam.reviewed, "approved");
    assert.equal(candidate.continuation.seam.reviewNote, "目看通过");
    // 落盘可查。
    const stored = slotOf().candidates.find((item) => item.jobId === seg1.id);
    assert.equal(stored.continuation.seam.reviewed, "approved");

    assert.throws(() => continuation.reviewSeam({ projectId: project.id, shotId, jobId: seg1.id, reviewed: "pending" }), (error) => error.status === 400 && error.field === "reviewed");
    assert.throws(() => continuation.reviewSeam({ projectId: project.id, shotId, jobId: "nope", reviewed: "approved" }), (error) => error.status === 404 && error.code === "CANDIDATE_NOT_FOUND");
    const seg0 = slotOf().candidates.find((item) => item.segmentIndex === 0);
    assert.throws(() => continuation.reviewSeam({ projectId: project.id, shotId, jobId: seg0.jobId, reviewed: "approved" }), (error) => error.status === 409 && error.code === "SEAM_MISSING");
});

// ——— 分叉：404/409 + 原链不动 ———

test("分叉：父候选缺失 404 / 未完成 409；成功分叉首段 index=父段+1，原链候选/产物不动", async (t) => {
    const { continuation, project, shotId, jobs, settle, slotOf } = makeContinuationEnv(t);
    const { chainId, firstJob } = await continuation.startChain({ projectId: project.id, shotId, prompt: "主线", segments: 2, seed: 50 });
    jobs.finish(firstJob.id, "done", doneOutputs(firstJob.id, "seg0.mp4"));
    await settle();

    await assert.rejects(
        () => continuation.startBranch({ projectId: project.id, shotId, parentCandidateId: "nope", prompt: "支线", segments: 1 }),
        (error) => error.status === 404 && error.code === "CANDIDATE_NOT_FOUND",
    );
    const seg1 = jobs.list().find((job) => job.meta.continuation.segmentIndex === 1);
    await assert.rejects(
        () => continuation.startBranch({ projectId: project.id, shotId, parentCandidateId: seg1.id, prompt: "支线", segments: 1 }),
        (error) => error.status === 409 && error.code === "PARENT_NOT_DONE",
    );

    const before = JSON.stringify(slotOf().candidates.filter((candidate) => candidate.continuationChainId === chainId));
    const branch = await continuation.startBranch({ projectId: project.id, shotId, parentCandidateId: firstJob.id, prompt: "支线", segments: 2, seed: 90 });
    assert.notEqual(branch.chainId, chainId);
    assert.equal(branch.takeId, branch.chainId, "分叉同时新建 takeId/continuationChainId");
    const branchSeg1 = branch.firstJob;
    assert.equal(branchSeg1.template, "video_h3_i2v");
    assert.equal(branchSeg1.meta.continuation.segmentIndex, 1, "分叉首段 = 父段 index+1");
    assert.equal(branchSeg1.meta.continuation.totalSegments, 3, "父段 index+1+segments");
    assert.equal(branchSeg1.meta.continuation.parentCandidateId, firstJob.id);
    assert.equal(branchSeg1.meta.continuation.seed, 90);

    const after = slotOf().candidates.filter((candidate) => candidate.continuationChainId === chainId);
    assert.equal(JSON.stringify(after), before, "原链候选一律不写");
    const branchCandidate = slotOf().candidates.find((candidate) => candidate.jobId === branchSeg1.id);
    assert.equal(branchCandidate.parentArtifactId, `${chainId}/seg0#${firstJob.id}`);
    assert.equal(branchCandidate.parentCandidateId, firstJob.id);
});

// ——— resume 幂等 ———

test("resume：已完成段不重复入队；取消段 :r1 新 attempt；在跑段直接返回；完成链 job:null", async (t) => {
    const { continuation, project, shotId, jobs, settle } = makeContinuationEnv(t);
    const { chainId, firstJob } = await continuation.startChain({ projectId: project.id, shotId, prompt: "告别", segments: 3 });
    jobs.finish(firstJob.id, "done", doneOutputs(firstJob.id, "seg0.mp4"));
    await settle();
    const seg1 = jobs.list().find((job) => job.meta.continuation.segmentIndex === 1);
    jobs.finish(seg1.id, "canceled");
    await settle();
    assert.equal(jobs.list().length, 2, "canceled 链停");

    // 恢复：seg0 完成不重跑；seg1 取消 → 新 attempt（:r1）。
    const resumed = await continuation.resumeChain({ projectId: project.id, shotId, chainId });
    assert.equal(resumed.resumedFromSegment, 1);
    assert.notEqual(resumed.job.id, seg1.id);
    assert.equal(resumed.job.meta.idempotencyKey, `continuation:${chainId}:seg1:r1`);
    assert.equal(jobs.list().length, 3, "只补跑缺失段");
    assert.equal(jobs.list().filter((job) => job.meta.continuation.segmentIndex === 0).length, 1, "seg0 不重复入队");

    jobs.finish(resumed.job.id, "done", doneOutputs(resumed.job.id, "seg1.mp4"));
    await settle();
    assert.equal(jobs.list().length, 4, "seg1 done 自动接续 seg2");

    // 再恢复：seg2 在跑 → 直接返回该 Job，不新增。
    const inflight = await continuation.resumeChain({ projectId: project.id, shotId, chainId });
    assert.equal(inflight.resumedFromSegment, 2);
    assert.equal(jobs.list().length, 4);

    const seg2 = jobs.list().find((job) => job.meta.continuation.segmentIndex === 2);
    jobs.finish(seg2.id, "done", doneOutputs(seg2.id, "seg2.mp4"));
    await settle();
    const completed = await continuation.resumeChain({ projectId: project.id, shotId, chainId });
    assert.equal(completed.resumedFromSegment, null);
    assert.equal(completed.job, null, "链已完成返回 job:null");
    assert.equal(jobs.list().length, 4);

    await assert.rejects(() => continuation.resumeChain({ projectId: project.id, shotId, chainId: "chain_nope" }), (error) => error.status === 404 && error.code === "CHAIN_NOT_FOUND");
});

// ——— 派生视图：链 → 段 → parent 回溯 ———

test("派生视图：按链分组、段状态以 Job 为准、分叉链 parentCandidateId 指向他链候选", async (t) => {
    const { continuation, project, shotId, jobs, settle } = makeContinuationEnv(t);
    const main = await continuation.startChain({ projectId: project.id, shotId, prompt: "主线", segments: 2 });
    jobs.finish(main.firstJob.id, "done", doneOutputs(main.firstJob.id, "seg0.mp4"));
    await settle();
    const mainSeg1 = jobs.list().find((job) => job.meta.continuation.chainId === main.chainId && job.meta.continuation.segmentIndex === 1);
    const branch = await continuation.startBranch({ projectId: project.id, shotId, parentCandidateId: main.firstJob.id, prompt: "支线", segments: 1 });

    const { chains } = continuation.listChains({ projectId: project.id, shotId });
    assert.equal(chains.length, 2);
    const mainChain = chains.find((chain) => chain.chainId === main.chainId);
    assert.equal(mainChain.takeId, main.chainId);
    assert.equal(mainChain.parentCandidateId, null);
    assert.equal(mainChain.status, "running", "seg1 在跑 → 链 running");
    assert.deepEqual(
        mainChain.segments.map((segment) => segment.segmentIndex),
        [0, 1],
    );
    const seg0View = mainChain.segments[0];
    assert.equal(seg0View.jobId, main.firstJob.id);
    assert.equal(seg0View.status, "done");
    assert.equal(seg0View.artifactUrl, `/api/artifacts/${main.firstJob.id}/seg0.mp4`);
    assert.equal(seg0View.approvalStatus, "pending");
    assert.equal(seg0View.needsReview, false);
    assert.equal(mainChain.segments[1].jobId, mainSeg1.id);

    const branchChain = chains.find((chain) => chain.chainId === branch.chainId);
    assert.equal(branchChain.parentCandidateId, main.firstJob.id, "分叉链 parentCandidateId 指向主链候选");
    assert.equal(branchChain.segments[0].segmentIndex, 1);

    jobs.finish(mainSeg1.id, "done", doneOutputs(mainSeg1.id, "seg1.mp4"));
    await settle();
    const done = continuation.listChains({ projectId: project.id, shotId }).chains.find((chain) => chain.chainId === main.chainId);
    assert.equal(done.status, "done");
    assert.equal(done.segments[1].seam.reviewed, "pending", "段视图带 seam");
});

// ——— select 扩展：approved / superseded ———

test("采用 take：整链段 approved、其它 take 段 superseded、无 takeId 候选不动", async (t) => {
    const { continuation, projects, project, shotId, jobs, settle, slotId, slotOf } = makeContinuationEnv(t);
    const main = await continuation.startChain({ projectId: project.id, shotId, prompt: "主线", segments: 1 });
    jobs.finish(main.firstJob.id, "done", doneOutputs(main.firstJob.id, "seg0.mp4"));
    await settle();
    const branch = await continuation.startBranch({ projectId: project.id, shotId, parentCandidateId: main.firstJob.id, prompt: "支线", segments: 1 });
    // 无 takeId 的画布候选（M2 通路）。
    jobs.set({ id: "image-canvas", kind: "image", template: "img_zimage_artistic", status: "done", outputs: [{ url: "/api/artifacts/image-canvas/out.png", type: "image" }], meta: { source: "canvas", projectId: project.id } });
    const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });
    slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-canvas" });

    // 采用分叉 take（jobId = take 末段候选）。
    slotCandidates.selectCandidate({ projectId: project.id, shotId, slotId, jobId: branch.firstJob.id });
    let candidates = slotOf().candidates;
    assert.equal(slotOf().selected, branch.firstJob.id);
    assert.equal(candidates.find((c) => c.jobId === branch.firstJob.id).approvalStatus, "approved");
    assert.equal(candidates.find((c) => c.jobId === main.firstJob.id).approvalStatus, "superseded", "被顶替的旧 take 段 → superseded");
    assert.equal(candidates.find((c) => c.jobId === "image-canvas").approvalStatus, undefined, "无 takeId 候选不受影响");

    // 改采用主 take：状态翻转。
    slotCandidates.selectCandidate({ projectId: project.id, shotId, slotId, jobId: main.firstJob.id });
    candidates = slotOf().candidates;
    assert.equal(candidates.find((c) => c.jobId === main.firstJob.id).approvalStatus, "approved");
    assert.equal(candidates.find((c) => c.jobId === branch.firstJob.id).approvalStatus, "superseded");
});

// ——— stalled 扫描：幂等续提交 ———

test("stalled 扫描：最后一段 done 且无活动段 → 续提交；重复扫描不重复入队；失败段命中幂等键", async (t) => {
    // wire:false —— 不接终态编排器，模拟「seg0 done 但服务端在接续前重启」。
    const { continuation, project, shotId, jobs } = makeContinuationEnv(t, { wire: false });
    const { chainId, firstJob } = await continuation.startChain({ projectId: project.id, shotId, prompt: "告别", segments: 2 });
    jobs.finish(firstJob.id, "done", doneOutputs(firstJob.id, "seg0.mp4"));
    assert.equal(jobs.list().length, 1, "无编排器：done 不自动接续");

    const first = await continuation.scanStalledChains();
    assert.equal(first.scanned, 1);
    assert.equal(first.resumed, 1);
    assert.equal(jobs.list().length, 2, "扫描续提交 seg1");

    const second = await continuation.scanStalledChains();
    assert.equal(second.resumed, 0, "seg1 在跑 → 不再续提交");
    assert.equal(jobs.list().length, 2);

    // seg1 失败 → 链停等人工 resume；扫描命中幂等键返回原失败 Job，绝不重复入队。
    const seg1 = jobs.list().find((job) => job.meta.continuation.segmentIndex === 1);
    jobs.finish(seg1.id, "error", { error: "失败" });
    const third = await continuation.scanStalledChains();
    assert.equal(jobs.list().length, 2, "幂等键命中原失败 Job，不新增");
    assert.equal(jobs.get(seg1.id).status, "error");
    assert.equal(third.resumed, 1, "续提交动作发生但被幂等键吸收");
    assert.ok(chainId);
});

// ——— 真机 QC（ffmpeg 可用时）：量化指标 + 尾帧抽取 ———

test("接缝 QC 真机：合成两段小视频，ffmpeg 产出全部量化指标；尾帧抽取出 PNG", async (t) => {
    if (!ffmpegAvailable()) return t.skip("本机无 ffmpeg");
    const dir = mkdtempSync(join(tmpdir(), "canvas-seam-qc-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { spawnSync } = await import("node:child_process");
    const make = (file, freq) =>
        spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x288:rate=24", "-f", "lavfi", "-i", `sine=frequency=${freq}`, "-t", "1", "-pix_fmt", "yuv420p", "-shortest", file], { stdio: "ignore" });
    const parentPath = join(dir, "parent.mp4");
    const childPath = join(dir, "child.mp4");
    assert.equal(make(parentPath, 440).status, 0);
    assert.equal(make(childPath, 550).status, 0);

    const metrics = await runSeamQc({ parentPath, childPath, workDir: join(dir, "qc") });
    assert.ok(metrics.boundarySsim > 0 && metrics.boundarySsim <= 1, `SSIM 落 (0,1]：${metrics.boundarySsim}`);
    assert.ok(metrics.boundaryPsnrDb === null || metrics.boundaryPsnrDb > 0);
    assert.equal(typeof metrics.freezeDetected, "boolean");
    assert.ok(Number.isFinite(metrics.parentTailRmsDb), "父尾 RMS 有读数");
    assert.ok(Number.isFinite(metrics.childHeadRmsDb), "子首 RMS 有读数");
    assert.ok(Number.isFinite(metrics.audioSeamDeltaDb), "音频落差有读数");
    assert.ok(Number.isFinite(metrics.seamIntegratedLufs), "接缝 LUFS 有读数");
    assert.ok(Number.isFinite(metrics.seamTruePeakDbfs), "真峰值有读数");
    assert.equal(metrics.width, 160);
    assert.equal(metrics.height, 288);
    assert.equal(metrics.fps, 24);
    assert.equal(metrics.audioSampleRate, 44100);

    const tail = join(dir, "tail.png");
    await extractTailFrame({ videoPath: parentPath, outputPath: tail });
    assert.ok(existsSync(tail), "尾帧 PNG 已抽出");
});

// ——— 存储层：续接字段归一归 episodes.js ———

test("存储层归一：续接字段缺省补 null、非法 approvalStatus 回落 pending、非续接候选不带续接字段", (t) => {
    const { projects, project, shotId, slotId, slotOf } = makeContinuationEnv(t);
    projects.episodes.appendSlotCandidate(project.id, shotId, slotId, {
        template: "video_h3_i2v",
        jobId: "video-x",
        artifactUrl: null,
        status: "queued",
        continuationChainId: "chain_a",
        segmentIndex: 2,
        approvalStatus: "bogus",
    });
    const candidate = slotOf().candidates[0];
    assert.equal(candidate.takeId, null, "续接写入缺省字段补 null（完整九个）");
    assert.equal(candidate.parentCandidateId, null);
    assert.equal(candidate.approvalStatus, "pending", "非法 approvalStatus 回落 pending");
    assert.equal(candidate.parentArtifactId, null);
    assert.equal(candidate.contextArtifactId, null);
    assert.equal(candidate.latentArtifactId, null);
    assert.equal(candidate.continuation, null);

    projects.episodes.appendSlotCandidate(project.id, shotId, slotId, { template: "img", jobId: "image-y", artifactUrl: "/api/artifacts/image-y/a.png", status: "done" });
    const plain = slotOf().candidates.find((item) => item.jobId === "image-y");
    assert.equal("takeId" in plain, false, "非续接候选不带续接字段（旧形状不回归）");

    // updateSlotCandidate：修补落盘、404、无变化幂等。
    const { candidate: patched } = projects.episodes.updateSlotCandidate(project.id, shotId, slotId, "video-x", { status: "done", artifactUrl: "/api/artifacts/video-x/out.mp4" });
    assert.equal(patched.status, "done");
    const stored = slotOf().candidates.find((item) => item.jobId === "video-x");
    assert.equal(stored.artifactUrl, "/api/artifacts/video-x/out.mp4", "修补已写盘");
    assert.throws(() => projects.episodes.updateSlotCandidate(project.id, shotId, slotId, "nope", { status: "done" }), (error) => error.status === 404 && error.code === "CANDIDATE_NOT_FOUND");
});

// ——— HTTP 真链路（隔离实例，ComfyUI/LLM 指向不可达地址，preflight 探测失败按放行，绝不真跑生成） ———

const httpRoot = mkdtempSync(join(tmpdir(), "canvas-continuation-http-"));
mkdirSync(join(httpRoot, "data"), { recursive: true });
mkdirSync(join(httpRoot, "skills"), { recursive: true });
writeFileSync(join(httpRoot, "skills", "registry.json"), JSON.stringify({ version: 1, stages: [] }));

process.env.CANVAS_SERVER_DATA_DIR = join(httpRoot, "data");
process.env.CANVAS_SERVER_SKILLS_DIR = join(httpRoot, "skills");
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_WEB_DIR = join(httpRoot, "webdist");
delete process.env.CANVAS_SERVER_PORT;
delete process.env.CANVAS_SERVER_HOST;

const httpMod = await import("../src/index.js");
await new Promise((resolve) => httpMod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${httpMod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => httpMod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_WEB_DIR"]) delete process.env[key];
    rmSync(httpRoot, { recursive: true, force: true });
});

const post = (url, payload) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const get = (url) => fetch(`${base}${url}`);

/** 经 API 建项目 + 一集一场一镜，返回 { projectId, shotId }。 */
async function seedShotHttp(title) {
    const project = (await (await post("/api/projects", { title })).json()).project;
    const episode = (await (await post(`/api/projects/${project.id}/episodes`, { title: "第一集" })).json()).episode;
    const scene = (await (await post(`/api/projects/${project.id}/episodes/${episode.id}/scenes`, { locationId: "内景 海边", time: "夜", intent: "告别" })).json()).scene;
    const shot = (await (await post(`/api/projects/${project.id}/scenes/${scene.id}/shots`, { index: 1, storyboard: { prompt: "seashell" } })).json()).shot;
    return { projectId: project.id, shotId: shot.id, slotId: `slot_${shot.id}_clip` };
}

test("HTTP：五条续接端点全链路（开链 201/400 → 视图 → resume → 分叉 404/409/201 → review 400/404/409）", async () => {
    const { projectId, shotId, slotId } = await seedShotHttp("续接 HTTP");

    // 校验：空 prompt 400、segments 越界 400。
    assert.equal((await post(`/api/projects/${projectId}/shots/${shotId}/continuation-chains`, { prompt: " ", segments: 2 })).status, 400);
    assert.equal((await post(`/api/projects/${projectId}/shots/${shotId}/continuation-chains`, { prompt: "x", segments: 9 })).status, 400);

    // 开链 201：{ chainId, takeId, slotId, firstJob }。
    const created = await post(`/api/projects/${projectId}/shots/${shotId}/continuation-chains`, { prompt: "海浪声中的告别", segments: 2, seed: 42 });
    assert.equal(created.status, 201);
    const chain = await created.json();
    assert.ok(chain.chainId && chain.takeId === chain.chainId);
    assert.equal(chain.slotId, slotId);
    assert.equal(chain.firstJob.meta.continuation.segmentIndex, 0);
    assert.equal(chain.firstJob.meta.continuation.totalSegments, 2);
    assert.equal(chain.firstJob.meta.idempotencyKey, `continuation:${chain.chainId}:seg0`);

    // 派生视图：链 → 段可回溯。
    const view = await (await get(`/api/projects/${projectId}/shots/${shotId}/continuation-chains`)).json();
    assert.equal(view.chains.length, 1);
    assert.equal(view.chains[0].chainId, chain.chainId);
    assert.equal(view.chains[0].segments[0].jobId, chain.firstJob.id);
    assert.equal(view.chains[0].segments[0].approvalStatus, "pending");
    assert.equal((await get(`/api/projects/${projectId}/shots/sh_nope/continuation-chains`)).status, 404);

    // resume：200 { chainId, resumedFromSegment, job }（seg0 在跑或已失败重试，均返回有效 Job）。
    const resumed = await post(`/api/projects/${projectId}/shots/${shotId}/continuation-chains/${chain.chainId}/resume`, {});
    assert.equal(resumed.status, 200);
    const resumeBody = await resumed.json();
    assert.equal(resumeBody.chainId, chain.chainId);
    assert.ok(resumeBody.job === null || typeof resumeBody.job.id === "string");
    assert.equal((await post(`/api/projects/${projectId}/shots/${shotId}/continuation-chains/chain_nope/resume`, {})).status, 404);

    // 分叉：404 CANDIDATE_NOT_FOUND；409 PARENT_NOT_DONE（seg0 候选 queued/failed，非 done）。
    assert.equal((await post(`/api/projects/${projectId}/shots/${shotId}/continuation-branches`, { parentCandidateId: "nope", prompt: "支线", segments: 1 })).status, 404);
    const notDone = await post(`/api/projects/${projectId}/shots/${shotId}/continuation-branches`, { parentCandidateId: chain.firstJob.id, prompt: "支线", segments: 1 });
    assert.equal(notDone.status, 409);
    assert.equal((await notDone.json()).error.code, "PARENT_NOT_DONE");

    // 分叉 201：经 recordImport + M2 候选通路造一条 done 父候选。
    const importJob = await httpMod.jobs.recordImport({ filename: "parent.mp4", buffer: Buffer.from("fake-video"), type: "video", meta: { projectId, source: "project" } });
    const appended = await post(`/api/projects/${projectId}/shots/${shotId}/slots/${slotId}/candidates`, { jobId: importJob.id });
    assert.equal(appended.status, 200);
    const branched = await post(`/api/projects/${projectId}/shots/${shotId}/continuation-branches`, { parentCandidateId: importJob.id, prompt: "支线剧情", segments: 1 });
    assert.equal(branched.status, 201);
    const branch = await branched.json();
    assert.notEqual(branch.chainId, chain.chainId);
    const viewAfter = await (await get(`/api/projects/${projectId}/shots/${shotId}/continuation-chains`)).json();
    assert.equal(viewAfter.chains.length, 2, "视图按 chainId 分组（主链 + 分叉链）");
    assert.equal(viewAfter.chains.find((item) => item.chainId === branch.chainId).parentCandidateId, importJob.id);

    // review：非法值 400；候选不存在 404；候选无缝 409。
    assert.equal((await post(`/api/projects/${projectId}/shots/${shotId}/continuation-reviews`, { jobId: chain.firstJob.id, reviewed: "pending" })).status, 400);
    assert.equal((await post(`/api/projects/${projectId}/shots/${shotId}/continuation-reviews`, { jobId: "nope", reviewed: "approved" })).status, 404);
    const noSeam = await post(`/api/projects/${projectId}/shots/${shotId}/continuation-reviews`, { jobId: chain.firstJob.id, reviewed: "approved" });
    assert.equal(noSeam.status, 409);
    assert.equal((await noSeam.json()).error.code, "SEAM_MISSING");
});

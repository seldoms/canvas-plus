import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";
import { createSlotCandidates } from "../src/slot-candidates.js";
import { loadRegistry } from "../src/skills.js";

/**
 * M2 槽位候选（单元级，真实 Project 存储 + 假任务源，绝不真跑生成）：
 *   · 追加幂等：同 jobId 重复追加不产生重复候选；槽位壳按 slot_<shotId>_<role> 规则自动创建；
 *   · select 校验：候选不存在 → 404 CANDIDATE_NOT_FOUND；slotId 不匹配规则 / shot 不存在 → 400；
 *   · PROJECT_MISMATCH：job.meta.projectId 与目标项目不符 → 409；
 *   · 自动投影：无 runId 的画布终态 Job 追加候选、selected 不动；有 runId / 非 done 不投影；
 *   · 合并规则（M2-D5）：run 级 keyframe 重投影不冲掉画布候选与指向它的 selected。
 */

const SCRIPT_OUTPUT = {
    logline: "末班车上的约定",
    synopsis: "深夜末班车上，司机与女孩的相遇。",
    characters: [{ id: "c1", name: "老周", profile: "司机", appearance: "中年", voice: "低沉" }],
    scenes: [{ id: "sc1", title: "公交车内", time: "夜", intent: "相遇", beats: ["上车"] }],
    episodes: [{ id: "ep1", index: 1, title: "相遇", durationSec: 30, synopsis: "起", sceneIds: ["sc1"] }],
};

const STORYBOARD_OUTPUT = {
    shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, shotSize: "全景", camera: "固定", action: "公交车驶入", dialogue: "", audio: "", prompt: "a bus arrives", negativePrompt: "" }],
};

const FRAMES_OUTPUT = {
    frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "夜间公交车停靠，全景", textOverlays: [] }],
};

const SCRIPT_MD = `---
name: novel-to-script
description: 测试剧本
---

# 剧本

## 提示词模板

你是影视剧本改编，返回含 logline/synopsis/characters/scenes/episodes 的 JSON。
`;

const STORYBOARD_MD = `---
name: storyboard
description: 测试分镜
---

# 分镜

## 提示词模板

你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。
`;

const KEYFRAME_MD = `---
name: keyframes
description: 测试关键帧
---

# 关键帧

## 提示词模板

你是关键帧提示词工程师，返回含 frames 数组的 JSON。
`;

function makeEnv(t) {
    const root = mkdtempSync(join(tmpdir(), "canvas-slot-candidates-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const skillsDir = join(root, "skills");
    const files = { "01-script": SCRIPT_MD, "02-storyboard": STORYBOARD_MD, "04-keyframes": KEYFRAME_MD };
    for (const [dir, content] of Object.entries(files)) {
        mkdirSync(join(skillsDir, dir), { recursive: true });
        writeFileSync(join(skillsDir, dir, "SKILL.md"), content);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { imageTemplate: "img-test", videoTemplate: "video-test", videoSeconds: 5, videoFps: 24, maxNovelChunkChars: 16000 } };
    mkdirSync(config.dataDir, { recursive: true });
    const projects = createProjects({ dataDir: config.dataDir, stages: loadRegistry(skillsDir).stages });
    return { root, skillsDir, config, projects };
}

/** 建一集一场一镜，返回 { episodeId, sceneId, shotId }（shotId 是稳定 sh_ 主键）。 */
function seedShot(projects, projectId) {
    const { episode } = projects.episodes.save(projectId, { title: "第一集" });
    const { scene } = projects.episodes.addScene(projectId, episode.id, { locationId: "内景 公交车内", time: "夜", intent: "相遇" });
    const { shot } = projects.episodes.addShot(projectId, scene.id, { index: 1, storyboard: { prompt: "bus arrives" } });
    return { episodeId: episode.id, sceneId: scene.id, shotId: shot.id };
}

/** 假任务源：按 id 直出预置 Job（含一条带产物输出的 done 任务与一条无输出任务）。 */
function fakeJobs(entries = {}) {
    const store = new Map(Object.entries(entries));
    return { get: (id) => store.get(id) || null, set: (job) => store.set(job.id, job) };
}

const doneJob = (id, meta = {}, outputs = [{ url: `/api/artifacts/${id}/out.png`, type: "image" }]) => ({
    id,
    kind: "image",
    template: "img_zimage_artistic",
    status: "done",
    outputs,
    meta,
    createdAt: new Date().toISOString(),
});

// ——— 追加：槽位壳创建 + 幂等 ———

test("追加候选：槽位不存在按规则建壳；同 jobId 重复追加不产生重复候选", (t) => {
    const { projects } = makeEnv(t);
    const project = projects.create({ title: "槽位" });
    const { shotId } = seedShot(projects, project.id);
    const slotId = `slot_${shotId}_key`;
    const jobs = fakeJobs({ "image-c1": doneJob("image-c1", { source: "canvas", projectId: project.id }) });
    const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });

    const first = slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-c1" });
    assert.equal(first.slot.id, slotId);
    assert.equal(first.slot.shotId, shotId);
    assert.equal(first.slot.role, "key");
    assert.equal(first.slot.selected, null, "追加绝不动 selected");
    assert.equal(first.slot.candidates.length, 1);
    const candidate = first.slot.candidates[0];
    assert.equal(candidate.jobId, "image-c1");
    assert.equal(candidate.template, "img_zimage_artistic");
    assert.equal(candidate.artifactUrl, "/api/artifacts/image-c1/out.png");
    assert.equal(candidate.status, "done");
    assert.equal(candidate.source, "canvas");
    assert.ok(candidate.createdAt);

    const second = slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-c1" });
    assert.equal(second.slot.candidates.length, 1, "同 jobId 幂等，不重复追加");

    // 落盘持久化：重读 episode 详情仍能拿到候选。
    const stored = projects.episodes.get(project.id, projects.get(project.id).episodes[0].id);
    assert.equal(stored.shots[0].generationSlots[0].candidates.length, 1);
});

// ——— 校验：JOB_NOT_FOUND / NO_ARTIFACT_OUTPUT / slotId 规则 / shot 不存在 / PROJECT_MISMATCH ———

test("追加候选校验：404 JOB_NOT_FOUND / NO_ARTIFACT_OUTPUT，400 slotId 规则与 shot 不存在，409 PROJECT_MISMATCH", (t) => {
    const { projects } = makeEnv(t);
    const project = projects.create({ title: "校验" });
    const other = projects.create({ title: "别的项目" });
    const { shotId } = seedShot(projects, project.id);
    const slotId = `slot_${shotId}_key`;
    const jobs = fakeJobs({
        "image-ok": doneJob("image-ok", { source: "canvas", projectId: project.id }),
        "image-mismatch": doneJob("image-mismatch", { source: "canvas", projectId: other.id }),
        "image-noout": doneJob("image-noout", { source: "canvas", projectId: project.id }, []),
    });
    const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });

    assert.throws(() => slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-nope" }), (error) => error.status === 404 && error.code === "JOB_NOT_FOUND");
    assert.throws(() => slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-noout" }), (error) => error.status === 404 && error.code === "NO_ARTIFACT_OUTPUT");
    assert.throws(() => slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-mismatch" }), (error) => error.status === 409 && error.code === "PROJECT_MISMATCH");
    assert.throws(() => slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId: "slot_other_key", jobId: "image-ok" }), (error) => error.status === 400);
    assert.throws(() => slotCandidates.appendCandidate({ projectId: project.id, shotId: "sh_nope", slotId: "slot_sh_nope_key", jobId: "image-ok" }), (error) => error.status === 400 && /镜头不存在/.test(error.message));
});

// ——— 采用：候选不存在 404；采用只改 selected ———

test("采用候选：设 selected；候选不存在 → 404 CANDIDATE_NOT_FOUND", (t) => {
    const { projects } = makeEnv(t);
    const project = projects.create({ title: "采用" });
    const { shotId } = seedShot(projects, project.id);
    const slotId = `slot_${shotId}_key`;
    const jobs = fakeJobs({ "image-c1": doneJob("image-c1", { source: "canvas", projectId: project.id }) });
    const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });

    assert.throws(() => slotCandidates.selectCandidate({ projectId: project.id, shotId, slotId, jobId: "image-c1" }), (error) => error.status === 404 && error.code === "CANDIDATE_NOT_FOUND");

    slotCandidates.appendCandidate({ projectId: project.id, shotId, slotId, jobId: "image-c1" });
    const { slot } = slotCandidates.selectCandidate({ projectId: project.id, shotId, slotId, jobId: "image-c1" });
    assert.equal(slot.selected, "image-c1");
    const again = slotCandidates.selectCandidate({ projectId: project.id, shotId, slotId, jobId: "image-c1" });
    assert.equal(again.slot.selected, "image-c1", "重复采用幂等");
});

// ——— 自动投影（M2-D6）：无 runId 的画布终态 Job 追加候选、selected 不动 ———

test("自动投影：done 且无 runId 的画布 Job 追加候选、不动 selected；有 runId / 非 done / 缺归属不投影", (t) => {
    const { projects } = makeEnv(t);
    const project = projects.create({ title: "自动投影" });
    const { shotId } = seedShot(projects, project.id);
    const slotId = `slot_${shotId}_key`;
    const jobs = fakeJobs();
    const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });
    const slotOf = () => {
        const episodeId = projects.get(project.id).episodes[0].id;
        const shot = projects.episodes.get(project.id, episodeId).shots.find((row) => row.id === shotId);
        return (shot.generationSlots || []).find((row) => row.id === slotId) || null;
    };

    // 非 done / 有 runId / 缺 slotId：一律不投影。
    jobs.set(doneJob("image-queued", { source: "canvas", projectId: project.id, shotId, slotId }));
    jobs.get("image-queued").status = "running";
    assert.equal(slotCandidates.projectCanvasTerminalJob(jobs.get("image-queued")), null);
    jobs.set(doneJob("image-run", { runId: "run_x", stageId: "keyframe", itemId: "sh1-start", projectId: project.id, shotId, slotId }));
    assert.equal(slotCandidates.projectCanvasTerminalJob(jobs.get("image-run")), null);
    jobs.set(doneJob("image-noslot", { source: "canvas", projectId: project.id, shotId }));
    assert.equal(slotCandidates.projectCanvasTerminalJob(jobs.get("image-noslot")), null);
    assert.equal(slotOf(), null, "上述三种都不该落候选");

    // 第一条画布 Job 终态 → 追加候选，selected 保持 null。
    jobs.set(doneJob("image-a", { source: "canvas", projectId: project.id, shotId, slotId }));
    slotCandidates.projectCanvasTerminalJob(jobs.get("image-a"));
    assert.equal(slotOf().candidates.length, 1);
    assert.equal(slotOf().selected, null, "自动投影绝不采用");

    // 显式采用第一条后，第二条终态投影只追加、selected 不动。
    slotCandidates.selectCandidate({ projectId: project.id, shotId, slotId, jobId: "image-a" });
    jobs.set(doneJob("image-b", { source: "canvas", projectId: project.id, shotId, slotId }));
    slotCandidates.projectCanvasTerminalJob(jobs.get("image-b"));
    assert.equal(slotOf().candidates.length, 2);
    assert.equal(slotOf().selected, "image-a", "自动投影不覆盖已有 selected");

    // 重放（重启重放 / 重复事件）幂等。
    slotCandidates.projectCanvasTerminalJob(jobs.get("image-a"));
    assert.equal(slotOf().candidates.length, 2);
});

// ——— 合并规则（M2-D5）：run 重投影不冲掉画布候选与指向它的 selected ———

function fakeLlm() {
    return {
        async chat(options) {
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("关键帧提示词工程师")
                ? FRAMES_OUTPUT
                : content.includes("分镜师")
                  ? STORYBOARD_OUTPUT
                  : content.includes("分集规划师")
                    ? { episodes: SCRIPT_OUTPUT.episodes }
                    : SCRIPT_OUTPUT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function fakePipelineJobs() {
    const store = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        enqueue(job) {
            const created = { ...job, status: "queued", outputs: [], createdAt: new Date().toISOString() };
            store.set(created.id, created);
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

test("合并规则：画布候选被采用后，run 级 keyframe 重投影仍保留画布候选与 selected", async (t) => {
    const { config, skillsDir, projects } = makeEnv(t);
    const jobs = fakePipelineJobs();
    const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });
    const pipeline = createPipeline({
        config,
        skillsDir,
        jobs,
        comfy: {},
        llm: fakeLlm(),
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => projects.get(id),
        applyScriptProjection: (id, output) => projects.applyScriptProjection(id, output),
        applyEpisodeProjection: (id, output) => projects.applyEpisodeProjection(id, output),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
        registerAssetRef: (id, input) => projects.assets.create(id, input),
        projectCanvasJob: (job) => slotCandidates.projectCanvasTerminalJob(job),
    });
    pipeline.bindJobs();

    const project = projects.create({ title: "合并", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    projects.assets.create(project.id, { role: "character", bindingId: "c1" });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    // 推终态：写真实产物文件（投影只落磁盘上存在的 URL），触发 run → Project 槽位投影。
    const jobId = `${run.id}-sh1-start`;
    mkdirSync(join(config.dataDir, "artifacts", jobId), { recursive: true });
    writeFileSync(join(config.dataDir, "artifacts", jobId, "out.png"), "png");
    jobs.finish(jobId, "done", { template: "img_qwen21_edit", outputs: [{ url: `/api/artifacts/${jobId}/out.png`, type: "image" }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done");

    const episodeId = projects.get(project.id).episodes[0].id;
    const slotOf = () => projects.episodes.get(project.id, episodeId).shots[0].generationSlots[0];
    assert.equal(slotOf().candidates.length, 1, "run 投影落一个候选");
    assert.equal(slotOf().selected, jobId);

    // 画布来源终态 Job（经 projectCanvasJob 注入走 projectJob 分支）→ 追加候选并被显式采用。
    const canvasJob = doneJob("image-canvas-1", { source: "canvas", projectId: project.id, shotId: slotOf().shotId, slotId: slotOf().id });
    jobs.set(canvasJob);
    pipeline.projectJob(canvasJob);
    assert.equal(slotOf().candidates.length, 2, "画布 Job 终态经 projectJob 分支追加候选");
    slotCandidates.selectCandidate({ projectId: project.id, shotId: slotOf().shotId, slotId: slotOf().id, jobId: canvasJob.id });
    assert.equal(slotOf().selected, canvasJob.id);

    // run 级 regenerate：同 shot 再来一条 run 候选并终态 → projectJob 回写 + 重投影走合并。
    const rerunJobId = `${run.id}-sh1-start-r2`;
    mkdirSync(join(config.dataDir, "artifacts", rerunJobId), { recursive: true });
    writeFileSync(join(config.dataDir, "artifacts", rerunJobId, "out.png"), "png");
    jobs.set(doneJob(rerunJobId, { runId: run.id, stageId: "keyframe", itemId: "sh1-start" }, [{ url: `/api/artifacts/${rerunJobId}/out.png`, type: "image" }]));
    pipeline.projectJob(jobs.get(rerunJobId));

    const slot = slotOf();
    const candidateIds = slot.candidates.map((candidate) => candidate.jobId);
    assert.ok(candidateIds.includes(canvasJob.id), "run 重投影不冲掉画布候选");
    assert.ok(candidateIds.includes(jobId) && candidateIds.includes(rerunJobId), "run 侧候选（含新候选）仍在");
    assert.equal(slot.selected, canvasJob.id, "selected 指向被保留的画布候选时保留原值");
});

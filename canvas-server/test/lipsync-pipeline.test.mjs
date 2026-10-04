import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/**
 * 对口型（lipsync）阶段接线验收：
 *   - 触发条件：该镜**有片段产物**且**有台词音频产物**才入队；无台词/音频失败的镜跳过；
 *   - 产物**另存**：对口型产物写进 run.stages.lipsync.output.clips[]，**绝不覆盖** assembly.output.clips；
 *   - 失败回落不阻塞：lip-sync 失败 → 成片照常出，该镜回落原片段，并写**可读 warning**；
 *   - 缓存兜底：每次 attempt 换 seed + 唯一 OUTPUT_PREFIX 且带 RECOVER_BY_PREFIX（见 generate 侧测试）；
 *   - 换一句台词 → 只重跑该镜对口型（入队新的 lip-sync 任务），**绝不重回 H3 视频**。
 */

/** 最小 skills 环境：登记含 lipsync 的七个 run 阶段。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-lipsync-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "design", title: "服化道", skill: "03-design", requires: ["script"], produces: "design" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design"], produces: "keyframes" },
                { id: "audio", title: "配音", skill: "06-audio", requires: ["storyboard", "design"], produces: "audio" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
                { id: "lipsync", title: "对口型", skill: "07-lipsync", requires: ["assembly"], produces: "clips" },
            ],
        }),
    );
    const config = {
        dataDir: join(root, "data"),
        pipeline: { lipsyncTemplate: "video_lipsync", audioTemplate: "audio_qwen3_tts", imageTemplate: "img-test", videoTemplate: "video-test", videoFps: 24 },
    };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

/** 可控任务源：靠 finish 手动推终态，驱动 Job→流水线回写投影。 */
function fakeJobQueue() {
    const store = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        store,
        enqueue(job) {
            const created = { ...job, status: "queued", outputs: [], createdAt: job.createdAt || new Date().toISOString() };
            store.set(created.id, created);
            emit(created);
            return created;
        },
        get: (id) => store.get(id) || null,
        list: () => [...store.values()],
        cancel(id) {
            const job = store.get(id);
            if (!job) return null;
            Object.assign(job, { status: "canceled" });
            emit(job);
            return job;
        },
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

/** 写一份「真实存在」的产物文件，让 upsertCandidate 的 resolvingOutputUrl 能命中。 */
function writeArtifact(config, jobId, filename, text = "mp4-bytes") {
    const dir = join(config.dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), text);
    return `/api/artifacts/${jobId}/${filename}`;
}

const CLIPS = {
    clips: [
        { id: "sh1-clip", shotId: "sh1", durationSec: 5, artifactUrl: "/api/artifacts/c1/clip.mp4", status: "done" },
        { id: "sh2-clip", shotId: "sh2", durationSec: 5, artifactUrl: "/api/artifacts/c2/clip.mp4", status: "done" },
        { id: "sh3-clip", shotId: "sh3", durationSec: 5, artifactUrl: "/api/artifacts/c3/clip.mp4", status: "done" },
    ],
    assembly: { order: ["sh1-clip", "sh2-clip", "sh3-clip"], transition: "cut", status: "queued" },
};

/** 三条台词音频：sh1 成功（有产物）、sh2 无 Cue、sh3 有 Cue 但 TTS 失败（无产物）。 */
const AUDIO = {
    audio: [
        { id: "cue_sh1", shotId: "sh1", startSec: 0, durationSec: 3, text: "你好", type: "dialogue", artifactUrl: "/api/artifacts/a1/cue_sh1.flac", status: "done" },
        { id: "cue_sh3", shotId: "sh3", startSec: 0, durationSec: 3, text: "走吧", type: "dialogue", artifactUrl: null, status: "error" },
    ],
};

function build(env, options = {}) {
    const jobs = options.jobs || fakeJobQueue();
    const record = [];
    const assemble =
        options.assemble ||
        (async (args) => {
            record.push(args);
            return { id: "delivery-x", url: "/api/artifacts/delivery-x/final.mp4", manifestUrl: "/api/artifacts/delivery-x/assembly-manifest.json", logPath: "/tmp/ffmpeg.log", coverUrl: null, bytes: 123, info: { hasVideo: true, hasAudio: true } };
        });
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm: {},
        runJob: options.runJob || (async () => ({ outputs: [] })),
        assemble,
    });
    pipeline.bindJobs();
    return { pipeline, jobs, record };
}

/** 建 run → 预置已有片段与配音产物 → 跑对口型阶段。 */
async function runLipsync(env, options = {}) {
    const { pipeline, jobs, record } = build(env, options);
    const run = pipeline.create({ novel: "夜色下的渡轮。" });
    pipeline.setStageInput(run.id, "assembly", { output: options.clips || CLIPS });
    pipeline.setStageInput(run.id, "audio", { output: options.audio || AUDIO });
    await pipeline.runStage(run.id, "lipsync");
    return { pipeline, jobs, record, runId: run.id, run: pipeline.get(run.id) };
}

test("对口型触发条件：仅有片段 + 有台词音频产物的镜入队，无台词/音频失败的镜跳过", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { jobs, run } = await runLipsync(env);

    const lipJobs = [...jobs.store.values()].filter((job) => job.meta.stageId === "lipsync");
    assert.equal(lipJobs.length, 1, `只应为「有片段 + 有台词音频」的镜头入队，实际 ${lipJobs.length}`);
    const job = lipJobs[0];
    assert.equal(job.kind, "video");
    assert.equal(job.template, "video_lipsync");
    assert.equal(job.meta.itemId, "sh1-clip-lipsync");
    // 输入 = 该镜片段 + 该镜 TTS 音频（模型无关素材槽）。
    assert.equal(job.params.INPUT_VIDEO, "/api/artifacts/c1/clip.mp4");
    assert.equal(job.params.INPUT_AUDIO, "/api/artifacts/a1/cue_sh1.flac");
    // 缓存兜底：每次 attempt 换 seed + 唯一 OUTPUT_PREFIX + 声明按前缀回落。
    assert.ok(Number.isFinite(job.params.SEED), "seed 必须是有限数（缓存击穿）");
    assert.match(job.params.OUTPUT_PREFIX, /^canvas\//);
    assert.equal(job.params.RECOVER_BY_PREFIX, true);

    const items = run.stages.lipsync.output.clips;
    assert.deepEqual(items.map((item) => item.id), ["sh1-clip-lipsync"], "只产一条对口型条目");
    const item = items[0];
    assert.equal(item.shotId, "sh1");
    assert.equal(item.sourceClipId, "sh1-clip");
    assert.equal(item.sourceClipUrl, "/api/artifacts/c1/clip.mp4");
    assert.equal(item.sourceAudioUrl, "/api/artifacts/a1/cue_sh1.flac");
});

test("对口型：无台词镜全跳过 → 阶段 done + 可读 warning（不产任务、不阻塞）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const onlySilent = { clips: [CLIPS.clips[1]], assembly: { order: ["sh2-clip"], transition: "cut", status: "queued" } };
    const { jobs, run } = await runLipsync(env, { clips: onlySilent });

    assert.equal([...jobs.store.values()].filter((job) => job.meta.stageId === "lipsync").length, 0, "无台词镜不产对口型任务");
    assert.deepEqual(run.stages.lipsync.output.clips, []);
    assert.equal(run.stages.lipsync.status, "done");
    assert.ok((run.stages.lipsync.warnings || []).some((w) => /没有需要对口型的镜头/.test(w)), "应有可读 warning 说明为何没跑");
});

test("对口型：产物另存不覆盖原片段，成片优先取对口型片段", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await runLipsync(env);

    const lipJob = [...jobs.store.values()].find((job) => job.meta.stageId === "lipsync");
    const lipUrl = writeArtifact(env.config, lipJob.id, "sh1-clip-lipsync_00001-audio.mp4");
    jobs.finish(lipJob.id, "done", { outputs: [{ url: lipUrl, type: "video", bytes: 500 }] });

    const run = pipeline.get(runId);
    // ① 对口型产物另存新条目
    assert.equal(run.stages.lipsync.output.clips[0].artifactUrl, lipUrl);
    // ② 原片段**未被覆盖**（assembly.output.clips 保持原 URL）
    assert.equal(run.stages.assembly.output.clips.find((c) => c.id === "sh1-clip").artifactUrl, "/api/artifacts/c1/clip.mp4");
    assert.equal(run.stages.assembly.output.clips.find((c) => c.id === "sh1-clip").lipSyncArtifactUrl, undefined);

    // ③ 成片用「派生副本」取对口型片段，原清单不动
    const done = await pipeline.assembleStage(runId);
    assert.equal(done.stages.assembly.output.assembly.status, "done");
    assert.equal(record.length, 1);
    const fedSh1 = record[0].clips.find((c) => c.id === "sh1-clip");
    assert.equal(fedSh1.artifactUrl, lipUrl, "成片该镜应用对口型后的新片段");
    assert.equal(fedSh1.lipSyncArtifactUrl, lipUrl);
    // 无对口型的镜仍用原片段
    assert.equal(record[0].clips.find((c) => c.id === "sh2-clip").artifactUrl, "/api/artifacts/c2/clip.mp4");
    assert.equal(done.stages.assembly.output.assembly.lipSync.used, 1);
    // 原片段清单仍未被改写
    assert.equal(done.stages.assembly.output.clips.find((c) => c.id === "sh1-clip").artifactUrl, "/api/artifacts/c1/clip.mp4");
});

test("对口型：失败不阻塞成片——回落原片段 + 可读 warning，成片照样出", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await runLipsync(env);

    const lipJob = [...jobs.store.values()].find((job) => job.meta.stageId === "lipsync");
    jobs.finish(lipJob.id, "error", { error: "LatentSync 超时（7200s）" });

    const run = pipeline.get(runId);
    assert.equal(run.stages.lipsync.output.clips[0].status, "error");
    assert.match(run.stages.lipsync.output.clips[0].warning, /对口型失败/, "失败要降级记 warning");

    // 成片照样出，该镜回落原片段
    const done = await pipeline.assembleStage(runId);
    assert.equal(done.stages.assembly.output.assembly.status, "done", "对口型失败绝不影响成片");
    const fedSh1 = record[0].clips.find((c) => c.id === "sh1-clip");
    assert.equal(fedSh1.artifactUrl, "/api/artifacts/c1/clip.mp4", "失败镜回落原片段");
    assert.equal(done.stages.assembly.output.assembly.lipSync.used, 0);
    assert.ok(
        (done.stages.assembly.warnings || []).some((w) => /回落原片段/.test(w)),
        `成片阶段应留下可读 warning：${JSON.stringify(done.stages.assembly.warnings)}`,
    );
});

test("对口型：换一句台词只重跑该镜对口型（追加 lip-sync 任务），绝不重回 H3 视频", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, runId } = await runLipsync(env);

    const first = [...jobs.store.values()].find((job) => job.meta.stageId === "lipsync");
    jobs.finish(first.id, "done", { outputs: [{ url: writeArtifact(env.config, first.id, "a.mp4"), type: "video", bytes: 500 }] });

    // 换台词：重跑 audio 得到新音频 URL（模拟），再跑对口型。
    const newAudio = { audio: [{ ...AUDIO.audio[0], artifactUrl: "/api/artifacts/a9/cue_sh1_v2.flac" }, AUDIO.audio[1]] };
    pipeline.setStageInput(runId, "audio", { output: newAudio });
    await pipeline.runStage(runId, "lipsync");

    const lipJobs = [...jobs.store.values()].filter((job) => job.meta.stageId === "lipsync");
    assert.equal(lipJobs.length, 2, "换台词后应为该镜追加一次对口型任务");
    assert.equal(lipJobs[1].params.INPUT_AUDIO, "/api/artifacts/a9/cue_sh1_v2.flac", "新任务用新音频");
    assert.notEqual(lipJobs[1].params.OUTPUT_PREFIX, lipJobs[0].params.OUTPUT_PREFIX, "每次 attempt 输出前缀唯一（缓存击穿 + 产物文件名确定）");
    // 关键：没有任何 H3/视频生成任务被入队（没有重跑整段视频）
    const generationJobs = [...jobs.store.values()].filter((job) => job.template && job.template !== "video_lipsync");
    assert.equal(generationJobs.length, 0, `换台词不得触发任何视频生成任务：${JSON.stringify(generationJobs.map((j) => j.template))}`);
    const item = pipeline.get(runId).stages.lipsync.output.clips[0];
    assert.equal(item.candidates.length, 2, "只追加候选，不删旧候选（可回滚）");
    assert.equal(item.sourceAudioUrl, "/api/artifacts/a9/cue_sh1_v2.flac");
});

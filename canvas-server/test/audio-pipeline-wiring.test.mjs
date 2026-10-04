import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/**
 * 配音阶段（audio）接线验收：
 *   - 只为**有对白**的镜头产音频，且 audio item 带 shotId + startSec；
 *   - TTS 任务失败不阻塞出片，且失败条目不进成片混音；
 *   - 音色描述 → Qwen3-TTS 命名音色的**后端适配**（内容层只给模型无关事实）。
 */

/** 最小 skills 环境：登记 script/storyboard/design/keyframe/audio/assembly 六个阶段。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-audio-"));
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
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { audioTemplate: "audio_qwen3_tts", audioDevice: "cuda", imageTemplate: "img-test", videoTemplate: "video-test", videoFps: 24 } };
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
function writeArtifact(config, jobId, filename, text = "flac-bytes") {
    const dir = join(config.dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), text);
    return `/api/artifacts/${jobId}/${filename}`;
}

const PROJECT = {
    id: "prj_1",
    script: {
        characters: [
            { id: "c1", name: "阿海", voice: "音色低沉沙哑，语速慢，带沿海口音" },
            { id: "c2", name: "小满", voice: "音色清亮但略带颤抖，带哭腔" },
        ],
    },
    episodes: [{ id: "ep_0001", sceneIds: ["sc1", "sc2"] }],
};

const SHOTS = {
    shots: [
        { id: "sh1", episodeId: "ep_0001", sceneId: "sc1", index: 1, durationSec: 4, action: "阿海问话", dialogue: "你好。（低声） 再见。", prompt: "captain asks" },
        { id: "sh2", episodeId: "ep_0001", sceneId: "sc2", index: 2, durationSec: 4, action: "小满走开", dialogue: "", prompt: "girl leaves" },
        { id: "sh3", sceneId: "sc2", index: 3, durationSec: 5, action: "小满回答", dialogue: "走吧。", prompt: "girl answers" },
    ],
};

const CLIPS = {
    clips: [
        { id: "sh1-clip", shotId: "sh1", durationSec: 4, artifactUrl: "/api/artifacts/c1/clip.mp4", status: "done" },
        { id: "sh2-clip", shotId: "sh2", durationSec: 4, artifactUrl: "/api/artifacts/c2/clip.mp4", status: "done" },
        { id: "sh3-clip", shotId: "sh3", durationSec: 5, artifactUrl: "/api/artifacts/c3/clip.mp4", status: "done" },
    ],
    assembly: { order: ["sh1-clip", "sh2-clip", "sh3-clip"], transition: "cut", status: "queued" },
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
        getProject: (id) => (id === "prj_1" ? PROJECT : null),
    });
    pipeline.bindJobs();
    return { pipeline, jobs, record };
}

/** 建 run → 预置 storyboard/design 产物（配音阶段的上游）→ 跑配音阶段。 */
async function runAudio(env, options = {}) {
    const { pipeline, jobs, record } = build(env, options);
    const run = pipeline.create({ novel: "夜色下的渡轮。", options: { projectId: "prj_1" } });
    pipeline.setStageInput(run.id, "storyboard", { output: SHOTS });
    pipeline.setStageInput(run.id, "design", { output: { characters: [] } });
    await pipeline.runStage(run.id, "audio");
    return { pipeline, jobs, record, runId: run.id, run: pipeline.get(run.id) };
}

test("配音：只为有对白镜头入队 TTS，audio item 带 shotId+startSec，台词已清洗", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { jobs, run, runId, pipeline } = await runAudio(env);

    // sh1 两句 + sh3 一句 = 3 个 audio 任务；sh2 无对白 → 不产音频（硬约束①）。
    const audioJobs = [...jobs.store.values()].filter((job) => job.kind === "audio");
    assert.equal(audioJobs.length, 3, "只应为有对白的镜头入队");
    for (const job of audioJobs) {
        assert.equal(job.template, "audio_qwen3_tts");
        assert.equal(job.meta.stageId, "audio");
        assert.ok(["sh1", "sh3"].includes(job.meta.itemId.split("_")[1]));
        assert.doesNotMatch(job.params.TEXT, /[（）()【】]/, "送进 TTS 的台词不得带括号表演注解");
        assert.ok(job.params.SPEAKER, `SPEAKER 不能为空：${JSON.stringify(job.params)}`);
        assert.equal(job.params.LANGUAGE, "Chinese");
        assert.equal(job.params.DEVICE, "cuda");
        const instructParts = job.params.INSTRUCT.split("，");
        assert.equal(new Set(instructParts).size, instructParts.length, `INSTRUCT 不应有重复段落：${job.params.INSTRUCT}`);
        assert.ok(Number.isFinite(job.params.SEED));
        assert.match(job.params.OUTPUT_PREFIX, /^canvas\//);
    }

    const audio = run.stages.audio.output.audio;
    assert.equal(audio.length, 3);
    assert.deepEqual([...new Set(audio.map((item) => item.shotId))].sort(), ["sh1", "sh3"]);
    for (const item of audio) {
        assert.equal(typeof item.startSec, "number");
        assert.equal(typeof item.durationSec, "number");
        assert.equal(item.type, "dialogue");
        assert.doesNotMatch(item.text, /[（）()【】]/);
    }
    // 多句均分：sh1 时长 4s → 0s / 2s。
    assert.deepEqual(audio.filter((item) => item.shotId === "sh1").map((item) => item.startSec).sort(), [0, 2]);
    assert.equal(pipeline.stages().some((stage) => stage.id === "audio"), true);
});

test("配音：音色描述按后端适配映射到 Qwen3-TTS 命名音色（同一角色跨镜头固定）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { jobs } = await runAudio(env);
    const byItem = Object.fromEntries([...jobs.store.values()].filter((job) => job.kind === "audio").map((job) => [job.meta.itemId, job.params.SPEAKER]));
    const speakers = [...new Set(Object.values(byItem))];
    // 阿海（低沉沙哑）与 小满（清亮颤抖）应映射到不同命名音色，且都在枚举内。
    assert.equal(speakers.length, 2, `两个角色应各有音色：${JSON.stringify(byItem)}`);
    const sh1 = Object.entries(byItem).filter(([id]) => id.includes("sh1")).map(([, s]) => s);
    assert.equal(new Set(sh1).size, 1, "同一镜内对白音色一致");
});

test("配音：TTS 失败不阻塞出片，失败条目不进成片混音", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await runAudio(env);

    const audioJobs = [...jobs.store.values()].filter((job) => job.kind === "audio");
    // 第 1、3 个任务成功（写真实产物），第 2 个失败。
    jobs.finish(audioJobs[0].id, "done", { outputs: [{ url: writeArtifact(env.config, audioJobs[0].id, "a.flac"), type: "audio", bytes: 100 }] });
    jobs.finish(audioJobs[1].id, "error", { error: "TTS 显存不足" });
    jobs.finish(audioJobs[2].id, "done", { outputs: [{ url: writeArtifact(env.config, audioJobs[2].id, "b.flac"), type: "audio", bytes: 120 }] });

    const run = pipeline.get(runId);
    const audio = run.stages.audio.output.audio;
    assert.equal(audio.filter((item) => item.artifactUrl).length, 2);
    const failed = audio.filter((item) => item.status === "error");
    assert.equal(failed.length, 1);
    assert.match(failed[0].warning, /配音失败/, "失败要降级记 warning");
    assert.equal([...jobs.store.values()].filter((job) => job.kind === "audio").length, 3, "配音失败不自动重试（不堆占 GPU 队列）");

    // 成片：片段齐 → 仍能出片；只有 2 条有产物的音频进混音（失败条目被跳过）。
    pipeline.setStageInput(runId, "assembly", { output: CLIPS });
    const done = await pipeline.assembleStage(runId);
    assert.equal(done.stages.assembly.output.assembly.status, "done");
    assert.equal(record.length, 1);
    const mixed = record[0].options.audio;
    assert.equal(mixed.length, 2, "只有有产物的音频条目进混音");
    for (const item of mixed) {
        assert.ok(item.ref && item.shotId !== undefined && typeof item.startSec === "number");
    }
});

test("配音：全部 TTS 失败时，成片依旧产出（无音轨但绝不失败）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await runAudio(env);
    for (const job of [...jobs.store.values()].filter((entry) => entry.kind === "audio")) jobs.finish(job.id, "error", { error: "147 不可达" });

    pipeline.setStageInput(runId, "assembly", { output: CLIPS });
    const done = await pipeline.assembleStage(runId);
    assert.equal(done.stages.assembly.output.assembly.status, "done");
    assert.deepEqual(record[0].options.audio, [], "没有任何音频产物时混音入参为空，但出片照常");
});

test("配音：无对白镜头不产任何音频任务/条目", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs } = build(env);
    const run = pipeline.create({ novel: "无声。", options: { projectId: "prj_1" } });
    pipeline.setStageInput(run.id, "storyboard", { output: { shots: [{ id: "sh1", sceneId: "sc1", durationSec: 4, action: "空镜", dialogue: "", prompt: "empty" }] } });
    pipeline.setStageInput(run.id, "design", { output: { characters: [] } });
    await pipeline.runStage(run.id, "audio");
    assert.equal([...jobs.store.values()].filter((job) => job.kind === "audio").length, 0);
    assert.deepEqual(pipeline.get(run.id).stages.audio.output.audio, []);
    assert.equal(pipeline.get(run.id).stages.audio.status, "done");
});

test("配音产物『登记了但文件不在磁盘上』→ 跳过该音轨 + 可读 warning，成片照样产出（不让整片挂）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await runAudio(env);

    const audioJobs = [...jobs.store.values()].filter((job) => job.kind === "audio");
    // 第 1 条写真实产物；第 2 条**只登记 URL、不落盘**（历史上会让 ffmpeg 挂掉整部成片）。
    jobs.finish(audioJobs[0].id, "done", { outputs: [{ url: writeArtifact(env.config, audioJobs[0].id, "a.flac"), type: "audio", bytes: 100 }] });
    jobs.finish(audioJobs[1].id, "done", { outputs: [{ url: `/api/artifacts/${audioJobs[1].id}/ghost.flac`, type: "audio", bytes: 100 }] });
    jobs.finish(audioJobs[2].id, "done", { outputs: [{ url: writeArtifact(env.config, audioJobs[2].id, "c.flac"), type: "audio", bytes: 100 }] });

    const run = pipeline.get(runId);
    const audio = run.stages.audio.output.audio;
    assert.equal(audio.filter((item) => item.artifactUrl).length, 3, "三条都登记了产物 URL（其中一条文件其实不在）");

    pipeline.setStageInput(runId, "assembly", { output: CLIPS });
    const done = await pipeline.assembleStage(runId);
    assert.equal(done.stages.assembly.status, "done", "成片必须照常产出，不能因缺一个音频文件整片失败");
    assert.equal(done.stages.assembly.output.assembly.status, "done");
    assert.equal(record[0].options.audio.length, 2, "只把磁盘上真实存在的音轨交给混音");
    const warnings = (done.stages.audio.warnings || []).join(" ");
    assert.match(warnings, /磁盘上不存在/, "缺失要降级成可读 warning");
    assert.match(warnings, /重跑这些条目的配音/, "warning 要给出可执行的下一步");
});

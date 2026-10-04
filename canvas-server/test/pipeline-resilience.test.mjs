import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/**
 * 重启收敛 / 自动重试 kind / 落盘原子性（audit #72 · #73 · #81）的验收：
 *   - #72：beginAssemble 只写 assembly.status="assembling"、从不改 stage.status，
 *          重启后必须由 reconcileRunning 收敛成明确终态，否则成片永久锁死；
 *   - #73：单镜自动重试的 job.kind 必须沿用原 job 的取值（design/casting/lipsync 曾被写成 undefined）；
 *   - #81：run.json / 阶段产物必须 tmp + rename 原子写，写窗口内被杀不能留下截断 JSON。
 */

/** 只登记用例真正用到的阶段；不跑 LLM，因此不需要 SKILL.md。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-pipeline-resilience-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    // design 是 LLM 阶段（先让模型产出参考图提示词，再入队生图），需要一个最小 SKILL.md。
    mkdirSync(join(skillsDir, "03-design"), { recursive: true });
    writeFileSync(
        join(skillsDir, "03-design", "SKILL.md"),
        "---\nname: design\ndescription: |\n  测试用服化道技能说明\n---\n\n# design\n\n## 输入\n\n- 编排器上下文\n\n## 输出契约\n\n字段名固定。\n\n## 内容创作红线（硬约束）\n\n- 测试红线-忠于原著：忠于原著，不为道德教化、过审改稿。\n\n## 提示词模板\n\n你是服化道，为角色与场景写参考图提示词，返回 JSON。\n\n## 校验规则\n\n- 只输出 JSON\n\n## 工具\n\n- /api/llm/*\n",
    );
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "design", title: "服化道", skill: "03-design", requires: [], produces: "design" },
                { id: "casting", title: "角色定妆", skill: "08-casting", requires: [], produces: "casting" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: [], produces: "clips" },
                { id: "audio", title: "配音", skill: "06-audio", requires: ["assembly"], produces: "audio" },
                { id: "lipsync", title: "对口型", skill: "07-lipsync", requires: ["assembly"], produces: "clips" },
            ],
        }),
    );
    const config = {
        dataDir: join(root, "data"),
        pipeline: { imageTemplate: "img-test", videoTemplate: "video-test", audioTemplate: "audio_qwen3_tts", lipsyncTemplate: "video_lipsync", videoFps: 24 },
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

const TEST_PROJECT = { id: "prj_test", plan: {} };
/** design 阶段的假 LLM：返回带参考图提示词的角色产物（其余用例不调模型）。 */
const DESIGN_REPLY = { characters: [{ id: "c1", name: "甲", closeupPrompt: "正面特写，素色背景" }], locations: [] };
const fakeLlm = () => ({ chat: async () => ({ choices: [{ message: { content: JSON.stringify(DESIGN_REPLY) } }] }) });

/** 注入 getProject（=启用自动重试）并订阅任务终态；runJob 只为让生成型/参考图阶段真的入队。 */
function build(env, options = {}) {
    const jobs = options.jobs || fakeJobQueue();
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm: options.llm || fakeLlm(),
        runJob: options.runJob || (async () => ({ outputs: [] })),
        getProject: (id) => (id === TEST_PROJECT.id ? TEST_PROJECT : null),
    });
    pipeline.bindJobs();
    return { pipeline, jobs };
}

const CLIP = { id: "sh1-clip", shotId: "sh1", durationSec: 5, artifactUrl: "/api/artifacts/c1/clip.mp4", status: "done" };
const CLIPS = { clips: [CLIP], assembly: { order: ["sh1-clip"], transition: "cut", status: "done" } };
const AUDIO = { audio: [{ id: "cue_sh1", shotId: "sh1", startSec: 0, durationSec: 3, text: "你好", type: "dialogue", artifactUrl: "/api/artifacts/a1/cue_sh1.flac", status: "done" }] };

const runFileOf = (env, runId) => join(env.config.dataDir, "runs", runId, "run.json");

/** 直接改写磁盘上的 run.json（构造「进程被杀留下的现场」，不经过任何内存对象）。 */
function patchRunJson(env, runId, patch) {
    const file = runFileOf(env, runId);
    const run = JSON.parse(readFileSync(file, "utf8"));
    patch(run);
    writeFileSync(file, JSON.stringify(run, null, 2));
}

// ——— #72 重启收敛错漏 assembly.status === "assembling" ———

test("reconcileRunning 收敛遗留的 assembling 成片为明确 error（可重新发起），不误伤已完成的成片", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env);

    // run A：ffmpeg 合成中途进程被杀 —— beginAssemble 只落了 assembly.status="assembling"，stage.status 仍是 done。
    const stuck = pipeline.create({ novel: "一段短小说", title: "卡住的成片" });
    patchRunJson(env, stuck.id, (run) => {
        run.createdAt = "2026-10-04T00:00:00.000Z";
        run.stages.assembly.status = "done";
        run.stages.assembly.output = { ...CLIPS, assembly: { status: "assembling", attempt: 1, startedAt: "2026-10-04T00:00:00.000Z" } };
    });

    // run B：正常完成的成片（必须原样保留）。
    const finished = pipeline.create({ novel: "一段短小说", title: "正常成片" });
    patchRunJson(env, finished.id, (run) => {
        run.createdAt = "2026-10-04T01:00:00.000Z";
        run.stages.assembly.status = "done";
        run.stages.assembly.output = {
            ...CLIPS,
            assembly: { status: "done", attempt: 1, url: "/api/artifacts/delivery-b/final.mp4", finishedAt: "2026-10-04T01:00:00.000Z" },
        };
    });

    // 模拟重启：新实例从磁盘读到这两条遗留现场。
    const restarted = build(env);
    assert.deepEqual(restarted.pipeline.reconcileRunning(), [stuck.id], "只收敛卡在 assembling 的 run");

    const after = restarted.pipeline.get(stuck.id).stages.assembly.output.assembly;
    assert.notEqual(after.status, "assembling", "收敛后不能仍是 assembling");
    assert.equal(after.status, "error", "落成明确终态 error，而不是另一个模糊状态");
    assert.match(after.error, /服务重启导致合成中断/);
    assert.ok(after.finishedAt, "收敛要写 finishedAt");
    assert.equal(restarted.pipeline.stageProgress(stuck.id).error, after.error, "进度也要能解释这次中断");

    const untouched = restarted.pipeline.get(finished.id).stages.assembly.output.assembly;
    assert.equal(untouched.status, "done", "正常成片不被误伤");
    assert.equal(untouched.url, "/api/artifacts/delivery-b/final.mp4", "成片地址不能被清");
    assert.equal(untouched.finishedAt, "2026-10-04T01:00:00.000Z", "已完成时间不能被改写");
    assert.equal(restarted.pipeline.beginAssemble(finished.id).reused, true, "已完成成片仍幂等复用，不重拼");

    assert.deepEqual(restarted.pipeline.reconcileRunning(), [], "已落终态，不再重复收敛");

    // 收敛后能重新发起合成：不再抛「成片正在合成中」（前端没有 force 入口，这是唯一的恢复路径）。
    const begun = restarted.pipeline.beginAssemble(stuck.id);
    assert.equal(begun.reused, false);
    assert.equal(begun.assembly.attempt, 2, "重拼走新 attempt");
    assert.equal(restarted.pipeline.get(stuck.id).stages.assembly.output.assembly.status, "assembling");
});

// ——— #73 自动重试 job 的 kind ———

test("自动重试沿用原 job 的 kind：lip sync 重试 job.kind=video（与正常入队一致）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs } = build(env);
    const run = pipeline.create({ novel: "夜色下的渡轮。" });
    pipeline.setStageInput(run.id, "assembly", { output: CLIPS });
    pipeline.setStageInput(run.id, "audio", { output: AUDIO });
    await pipeline.runStage(run.id, "lipsync");

    const source = [...jobs.store.values()].find((job) => job.meta.stageId === "lipsync");
    assert.equal(source.kind, "video", "正常入队 kind=video");

    jobs.finish(source.id, "error", { error: "GPU 挂了" });
    const retry = [...jobs.store.values()].find((job) => job.meta.stageId === "lipsync" && job.id !== source.id);
    assert.ok(retry, "失败应触发自动重试");
    assert.equal(retry.kind, "video", "重试 job 的 kind 必须与正常入队一致，不能是 undefined");
    assert.equal(retry.template, source.template, "沿用同一模板");
});

test("自动重试沿用原 job 的 kind：design 参考图重试 job.kind=image", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs } = build(env);
    const run = pipeline.create({ novel: "很久以前" });
    await pipeline.runStage(run.id, "design");

    const source = [...jobs.store.values()].find((job) => job.meta.stageId === "design");
    assert.ok(source, "design 参考图应入队");
    assert.equal(source.kind, "image", "正常入队 kind=image");

    jobs.finish(source.id, "error", { error: "GPU 挂了" });
    const retry = [...jobs.store.values()].find((job) => job.meta.stageId === "design" && job.id !== source.id);
    assert.ok(retry, "失败应触发自动重试");
    assert.equal(retry.kind, "image", "重试 job 的 kind 必须与正常入队一致，不能是 undefined");
});

test("自动重试沿用原 job 的 kind：casting 遗留候选（当前阶段不入队，防御性覆盖）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobQueue();
    const { pipeline } = build(env, { jobs });
    const run = pipeline.create({ novel: "很久以前" });
    // casting 现阶段是确定性组装身份卡、不调 LLM 也不入队，因此没有「正常入队 kind」；
    // 这里预置一条遗留失败候选 + 对应 job（kind=image，与 design 的脸产物同源），验证重试不会丢 kind。
    const source = jobs.enqueue({
        id: `${run.id}-c1-face`,
        kind: "image",
        template: "img-test",
        name: "c1-face",
        params: { PROMPT: "正面特写" },
        meta: { runId: run.id, stageId: "casting", itemId: "c1-face" },
    });
    jobs.finish(source.id, "error", { error: "GPU 挂了" });
    patchRunJson(env, run.id, (saved) => {
        saved.stages.casting.status = "error";
        saved.stages.casting.output = {
            references: [
                {
                    id: "c1-face",
                    status: "error",
                    template: "img-test",
                    jobId: source.id,
                    artifactUrl: null,
                    candidates: [{ jobId: source.id, status: "error", template: "img-test", params: { PROMPT: "正面特写" } }],
                },
            ],
        };
    });

    pipeline.projectJob(jobs.get(source.id));
    const retry = [...jobs.store.values()].find((job) => job.id !== source.id);
    assert.ok(retry, "失败应触发自动重试");
    assert.equal(retry.kind, source.kind, "重试 job 的 kind 必须等于原 job 的 kind，不能是 undefined");
    assert.equal(retry.kind, "image");
    assert.equal(retry.meta.stageId, "casting");
});

// ——— #81 saveRun / saveOutput 原子写 ———

test("saveRun / saveOutput 原子写：rename 换 inode（旧文件不被原地改写），残留 tmp 不影响读取", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env);
    const run = pipeline.create({ novel: "一段短小说", title: "原子写" });
    const dir = join(env.config.dataDir, "runs", run.id);
    const runJson = join(dir, "run.json");

    // 硬链住「写之前的那份」：tmp + rename 会换 inode，旧链永远看到上一版完整 JSON；
    // 原地 writeFileSync 截断同一个 inode，旧链会跟着变成半写内容 —— 这正是「写窗口内读到截断 JSON」的现场。
    const before = readFileSync(runJson, "utf8");
    linkSync(runJson, join(dir, "run.snapshot.json"));
    pipeline.setStageInput(run.id, "assembly", { output: CLIPS });
    assert.equal(readFileSync(join(dir, "run.snapshot.json"), "utf8"), before, "旧 run.json 不能被原地改写");
    const after = readFileSync(runJson, "utf8");
    assert.notEqual(after, before, "run.json 已更新到新版本");
    assert.equal(JSON.parse(after).stages.assembly.output.clips.length, 1, "写完是完整合法 JSON");

    // 阶段产物同理：重写 assembly.json 不能原地撕掉上一版。
    const assemblyJson = join(dir, "assembly.json");
    const firstOutput = readFileSync(assemblyJson, "utf8");
    linkSync(assemblyJson, join(dir, "assembly.snapshot.json"));
    pipeline.setStageInput(run.id, "assembly", { output: { clips: [CLIP], assembly: { order: [], transition: "cut", status: "done" } } });
    assert.equal(readFileSync(join(dir, "assembly.snapshot.json"), "utf8"), firstOutput, "旧阶段产物不能被原地改写");
    assert.equal(JSON.parse(readFileSync(assemblyJson, "utf8")).assembly.transition, "cut");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "写完不留临时文件");

    // 模拟「tmp 写了一半就被杀」：rename 之前崩溃只留下截断的 .tmp，run.json 本身仍是旧的完整内容。
    writeFileSync(join(dir, "run.json.9999dead.tmp"), '{"id":"run-1","stages":');
    const reread = build(env).pipeline.get(run.id);
    assert.equal(reread.id, run.id, "残留 tmp 不参与读取");
    assert.equal(reread.stages.assembly.output.clips[0].artifactUrl, CLIP.artifactUrl);
});

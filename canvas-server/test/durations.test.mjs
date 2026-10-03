/**
 * D1（时长档位跟着模型走 + 骨架对齐）与 D3（关键帧一次 ≥4 张、不达标自动重生成）的行为锁定。
 * 覆盖：档位元数据同源、帧数公式、骨架 Σ≠骨架 显式报错、单镜入队 ≥4 候选、QC 不达标自动重生成（预算有界）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
    DURATION_CATALOG,
    durationMetaForTemplate,
    durationsForTemplate,
    frameCountForDuration,
    isDurationAllowed,
    skeletonAlignment,
} from "../src/durations.js";
import { createPipeline } from "../src/pipeline.js";
import { listTemplates } from "../src/providers/comfy.js";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));
const H3_TEMPLATES = [
    "video_h3_i2v",
    "video_h3_ref2v",
    "video_h3_ref2v_image",
    "video_h3_ref2v_image_turbo",
    "video_h3_quantfunc_ref2v",
    "video_h3_talk",
    "video_minimax_h3_t2v",
];

// ————————————————————— durations.js 纯函数 —————————————————————

test("D1 档位帧数 = 24×秒+3（H3 原生口径，非法输入返回 null）", () => {
    assert.equal(frameCountForDuration(5), 123);
    assert.equal(frameCountForDuration(10), 243);
    assert.equal(frameCountForDuration(15), 363);
    assert.equal(frameCountForDuration(0), null);
    assert.equal(frameCountForDuration(-3), null);
    assert.equal(frameCountForDuration("不是数字"), null);
});

test("D1 档位登记表：H3 系 = [5,10,15]；非 H3 未查证一律 null + 待查证", () => {
    for (const name of H3_TEMPLATES) {
        assert.deepEqual(durationsForTemplate(name), [5, 10, 15], `${name} 应为 5/10/15 三档`);
        assert.equal(durationMetaForTemplate(name).verified, true, `${name} 应标记已查证`);
    }
    // Wan 未查证 → null，且显式标 verified:false + note 含「待查证」，不许拍脑袋。
    assert.equal(durationsForTemplate("video_wan_animate"), null);
    const wan = durationMetaForTemplate("video_wan_animate");
    assert.equal(wan.verified, false);
    assert.match(wan.note, /待查证/);
    // 未知视频模型同样按「待查证」处理。
    assert.match(durationMetaForTemplate("video_some_new_model").note, /待查证/);
    // 非视频模板无档位。
    assert.equal(durationMetaForTemplate("img_zimage_artistic").durations, null);
    assert.equal(DURATION_CATALOG.video_h3_i2v.frameRate ?? 24, 24);
});

test("D1 档位随模板清单同源下发（前端只读，不硬编码）", () => {
    const templates = listTemplates(workflowsDir);
    const h3 = templates.find((template) => template.name === "video_h3_i2v");
    assert.deepEqual(h3.durations, [5, 10, 15]);
    assert.equal(h3.durationMeta.frameCounts["5"], 123);
    assert.equal(h3.durationMeta.frameCounts["15"], 363);
    assert.equal(h3.durationMeta.formula, "24*sec+3");
    assert.equal(templates.find((template) => template.name === "video_wan_animate").durations, null);
    assert.equal(templates.find((template) => template.name === "img_qwen21_t2i").durations, null);
    // 每个模板都带 durations 字段（前端统一读取，不必判模板类型）。
    assert.ok(templates.every((template) => "durations" in template));
});

test("D1 isDurationAllowed：所选时长必须属于档位集合", () => {
    assert.equal(isDurationAllowed("video_h3_i2v", 5), true);
    assert.equal(isDurationAllowed("video_h3_i2v", 10), true);
    assert.equal(isDurationAllowed("video_h3_i2v", 7), false);
    // 档位未查证（null）→ 「不算合法」，不能声称它属于集合。
    assert.equal(isDurationAllowed("video_wan_animate", 5), false);
});

test("D1 skeletonAlignment：Σ段时长≠骨架时显式报出缺多少 / 超多少 / 不在档位", () => {
    const short = skeletonAlignment({ skeletonSeconds: 15, segments: [{ durationSec: 5 }, { durationSec: 5 }, { durationSec: 2 }], tiers: [5, 10, 15] });
    assert.equal(short.ok, false);
    assert.equal(short.totalSeconds, 12);
    assert.equal(short.missingSeconds, 3);
    assert.match(short.message, /还缺 3s/);
    assert.deepEqual(short.invalidDurations, [2], "2 不在档位里，要报出来");

    const exact = skeletonAlignment({ skeletonSeconds: 15, segments: [{ durationSec: 5 }, { durationSec: 10 }], tiers: [5, 10, 15] });
    assert.equal(exact.ok, true);
    assert.equal(exact.message, "");

    const over = skeletonAlignment({ skeletonSeconds: 15, segments: [{ durationSec: 10 }, { durationSec: 10 }], tiers: [5, 10, 15] });
    assert.equal(over.ok, false);
    assert.equal(over.overflowSeconds, 5);
    assert.match(over.message, /超出骨架 5s/);

    const missingSkeleton = skeletonAlignment({ skeletonSeconds: 0, segments: [{ durationSec: 5 }] });
    assert.equal(missingSkeleton.ok, false);
    assert.match(missingSkeleton.message, /未取到骨架时长/);
});

// ————————————————————— 编排器集成（假队列 / 假 LLM，不触发真实生成） —————————————————————

const SCRIPT = { logline: "一句话", synopsis: "梗概", characters: [], scenes: [{ id: "sc1" }] };
const SHOTS_ONE = { shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 4, prompt: "a girl walking", action: "走路" }] };
const SHOTS_THREE = {
    shots: [
        { id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, prompt: "p1", action: "a1" },
        { id: "sh2", sceneId: "sc1", index: 2, durationSec: 5, prompt: "p2", action: "a2" },
        { id: "sh3", sceneId: "sc1", index: 3, durationSec: 2, prompt: "p3", action: "a3" },
    ],
};
const FRAMES = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "少女走进老屋", textOverlays: [] },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "少女停在桌边", textOverlays: [] },
    ],
};

function makeSkillsEnv({ videoTemplate = "video_h3_i2v", maxKeyframesPerShot = 4 } = {}) {
    const root = mkdtempSync(join(tmpdir(), "canvas-durations-"));
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "测试剧本技能", "你是影视剧本改编，返回 JSON。\n原文：\n{{novel}}"],
        "02-storyboard": ["storyboard", "测试分镜技能", "你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。\n剧本：\n{{script}}"],
        "04-keyframes": ["keyframes", "测试关键帧技能", "你是关键帧提示词工程师，返回含 frames 数组的 JSON。\n分镜：\n{{storyboard}}"],
        "05-clip-assembly": ["clip-assembly", "测试片段技能", "你是片段合成师，返回含 clips 的 JSON。\n关键帧：\n{{keyframes}}"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(
            join(skillsDir, id, "SKILL.md"),
            `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n\n## 输入\n\n- 编排器上下文\n\n## 输出契约\n\n字段名固定。\n\n## 内容创作红线（硬约束）\n\n- 测试红线-忠于原著：忠于原著。\n\n## 提示词模板\n\n${prompt}\n\n## 校验规则\n\n- 只输出 JSON\n`,
        );
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
    const config = {
        dataDir: join(root, "data"),
        pipeline: {
            imageTemplate: "img-test",
            referenceImageTemplate: "img-test",
            editTemplate: "edit-test",
            videoTemplate,
            imageWidth: 768,
            imageHeight: 1344,
            imageBatch: 1,
            videoSeconds: 5,
            videoFps: 24,
            maxKeyframesPerShot,
        },
    };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function fakeLlm(reply) {
    const calls = [];
    return {
        calls,
        async chat(options) {
            calls.push(options);
            const content = options.messages.at(-1).content;
            const value = typeof reply === "function" ? reply(content) : reply;
            return { choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] };
        },
    };
}

function fakeJobQueue() {
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

function build(env, options = {}) {
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: options.jobs || fakeJobQueue(),
        comfy: {},
        llm: options.llm || fakeLlm(SCRIPT),
        runJob: options.runJob,
        getProject: options.getProject,
    });
    return { pipeline };
}

const PROJECT = { id: "prj_dur", plan: { episodeDurationSec: 15 }, assetRefs: [] };
const projectGetter = (id) => (id === PROJECT.id ? PROJECT : null);

function stageReply(content) {
    if (content.includes("关键帧提示词工程师")) return FRAMES;
    if (content.includes("分镜师")) return SHOTS_ONE;
    return SCRIPT;
}

test("D1 集成：Σ段时长≠骨架 → 分镜阶段显式报出缺多少秒（写进 skeleton 与 warnings）", async (t) => {
    const env = makeSkillsEnv({ videoTemplate: "video_h3_i2v" });
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const llm = fakeLlm((content) => (content.includes("分镜师") ? SHOTS_THREE : SCRIPT));
    const { pipeline } = build(env, { llm, jobs: fakeJobQueue(), getProject: projectGetter, runJob: async () => ({ outputs: [] }) });
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: PROJECT.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");

    const skeleton = pipeline.skeletonOf(run.id);
    assert.ok(skeleton, "分镜阶段应产出 skeleton 报告");
    assert.equal(skeleton.ok, false, "Σ=12 ≠ 骨架 15 → 不对齐");
    assert.deepEqual(skeleton.durations, [5, 10, 15]);
    assert.equal(skeleton.planSkeletonSeconds, 15);
    const episode = skeleton.episodes[0];
    assert.equal(episode.skeletonSeconds, 15);
    assert.equal(episode.totalSeconds, 12);
    assert.equal(episode.missingSeconds, 3, "缺 3 秒要显式报出");
    assert.deepEqual(episode.invalidDurations, [2]);

    const stage = pipeline.get(run.id).stages.storyboard;
    assert.ok(Array.isArray(stage.warnings) && stage.warnings.some((warning) => /未对齐骨架/.test(warning)), "缺段必须写进 stage.warnings，不静默");
    assert.ok(stage.warnings.some((warning) => /还缺 3s/.test(warning)));
});

test("D1 集成：骨架对齐（Σ=15）时 skeleton.ok=true 且无骨架告警", async (t) => {
    const env = makeSkillsEnv({ videoTemplate: "video_h3_i2v" });
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const even = { shots: [
        { id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, prompt: "p1", action: "a1" },
        { id: "sh2", sceneId: "sc1", index: 2, durationSec: 10, prompt: "p2", action: "a2" },
    ] };
    const llm = fakeLlm((content) => (content.includes("分镜师") ? even : SCRIPT));
    const { pipeline } = build(env, { llm, jobs: fakeJobQueue(), getProject: projectGetter, runJob: async () => ({ outputs: [] }) });
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: PROJECT.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    const skeleton = pipeline.skeletonOf(run.id);
    assert.equal(skeleton.ok, true);
    assert.equal(skeleton.episodes[0].totalSeconds, 15);
    assert.equal(skeleton.episodes[0].missingSeconds, 0);
    assert.ok(!(pipeline.get(run.id).stages.storyboard.warnings || []).some((warning) => /未对齐骨架/.test(warning)));
});

test("D1 后端校验：durationPolicy 给出「可选档位集合」并判所选时长是否合法", async (t) => {
    const env = makeSkillsEnv({ videoTemplate: "video_h3_i2v" });
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env, { jobs: fakeJobQueue(), runJob: async () => ({ outputs: [] }), getProject: projectGetter });
    const run = pipeline.create({ novel: "x", title: "y", options: { projectId: PROJECT.id } });
    const policy = pipeline.durationPolicy(run.id);
    assert.equal(policy.videoTemplate, "video_h3_i2v");
    assert.deepEqual(policy.durations, [5, 10, 15]);
    assert.equal(policy.selectedEpisodeDurationSec, 15);
    assert.equal(policy.allowed, true);
    assert.equal(policy.frameCounts["15"], 363);
});

test("D3：关键帧单镜一次入队 ≥4 个候选（假队列干跑，不触发真实生成）", async (t) => {
    const env = makeSkillsEnv({ videoTemplate: "video_h3_i2v", maxKeyframesPerShot: 4 });
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobQueue();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, getProject: projectGetter, runJob: async () => ({ outputs: [] }) });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: PROJECT.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    const frame = pipeline.get(run.id).stages.keyframe.output.frames.find((item) => item.id === "sh1-start");
    assert.ok(frame.candidates.length >= 4, `单镜候选数应 ≥4，实际 ${frame.candidates.length}`);
    const enqueued = jobs.list().filter((job) => job.meta?.itemId === "sh1-start");
    assert.equal(enqueued.length, frame.candidates.length, "候选数与真实入队数一致");
    // 多个候选换 seed（否则 4 张是同一张，失去多候选意义）。
    const seeds = new Set(frame.candidates.map((candidate) => candidate.params?.SEED).filter((seed) => seed !== undefined));
    assert.equal(seeds.size, frame.candidates.length, "每个候选应有不同 seed");
});

test("D3：不达标自动重生成（done 但 QC 判负 → 追加候选，预算有界不无限重试）", async (t) => {
    const env = makeSkillsEnv({ videoTemplate: "video_h3_i2v", maxKeyframesPerShot: 4 });
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobQueue();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, getProject: projectGetter, runJob: async () => ({ outputs: [] }) });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: PROJECT.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    const frameOf = () => pipeline.get(run.id).stages.keyframe.output.frames.find((item) => item.id === "sh1-start");
    assert.equal(frameOf().candidates.length, 4);

    // 4 个候选全部「成功但产物为空文件」→ QC 判负（不达标）。
    const ids = frameOf().candidates.map((candidate) => candidate.jobId);
    for (const id of ids) jobs.finish(id, "done", { outputs: [{ url: `/api/artifacts/job/${id}.png`, type: "image", bytes: 0 }] });
    assert.equal(frameOf().candidates.length, 5, "整条 item 无达标候选 → 自动重生成 1 次");
    const retry1 = frameOf().candidates.at(-1);
    assert.equal(retry1.autoRetry, true);
    assert.equal(retry1.status, "queued");
    assert.ok(!ids.includes(retry1.jobId), "重生成用新 jobId");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running");

    jobs.finish(retry1.jobId, "done", { outputs: [{ url: "/api/artifacts/job/r1.png", type: "image", bytes: 0 }] });
    assert.equal(frameOf().candidates.length, 6, "预算内再重生成 1 次");
    const retry2 = frameOf().candidates.at(-1);
    jobs.finish(retry2.jobId, "done", { outputs: [{ url: "/api/artifacts/job/r2.png", type: "image", bytes: 0 }] });
    assert.equal(frameOf().candidates.length, 6, "预算（maxItemRetries=2）用尽 → 不再无限重试");
});

test("D3：候选达标（产物非空）时不触发自动重生成", async (t) => {
    const env = makeSkillsEnv({ videoTemplate: "video_h3_i2v", maxKeyframesPerShot: 4 });
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobQueue();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, getProject: projectGetter, runJob: async () => ({ outputs: [] }) });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: PROJECT.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    const frameOf = () => pipeline.get(run.id).stages.keyframe.output.frames.find((item) => item.id === "sh1-start");
    const ids = frameOf().candidates.map((candidate) => candidate.jobId);
    for (const id of ids) jobs.finish(id, "done", { outputs: [{ url: `/api/artifacts/job/${id}.png`, type: "image", bytes: 204800, width: 768, height: 1344 }] });
    assert.equal(frameOf().candidates.length, 4, "有达标候选 → 不重生成");
    assert.ok(frameOf().candidates.every((candidate) => candidate.qc?.pass === true));
});

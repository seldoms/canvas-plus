import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPipeline } from "../src/pipeline.js";
import { extractTokens, renderTemplate } from "../src/providers/comfy.js";
import { loadRegistry, loadSkills, readSkill } from "../src/skills.js";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));
/** 这几个 token 由执行器统一兜底（见 src/generate.js），不要求编排器提供。 */
const RUNNER_FILLED = new Set(["SEED", "OUTPUT_PREFIX", "LORA_FILE", "LORA_STRENGTH"]);

/** 造一份最小可用的 skills 环境：4 个阶段 + registry。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-pipeline-"));
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "测试用剧本技能说明", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes 的 JSON。\n小说原文：\n{{novel}}"],
        "02-storyboard": ["storyboard", "测试用分镜技能说明", "你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。\n剧本：\n{{script}}"],
        "04-keyframes": ["keyframes", "测试用关键帧技能说明", "你是关键帧提示词工程师，为每个镜头写关键帧，返回含 frames 数组的 JSON。\n分镜：\n{{storyboard}}"],
        "05-clip-assembly": ["clip-assembly", "测试用片段合成技能说明", "你是片段合成师，规划片段与拼接顺序，返回含 clips 与 assembly 的 JSON。\n分镜：\n{{storyboard}}\n关键帧：\n{{keyframes}}"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(
            join(skillsDir, id, "SKILL.md"),
            `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n\n## 输入\n\n- 编排器上下文\n\n## 输出契约\n\n字段名固定。\n\n## 提示词模板\n\n${prompt}\n\n## 校验规则\n\n- 只输出 JSON\n\n## 工具\n\n- /api/llm/*\n`,
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
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
            ],
        }),
    );
    const config = {
        dataDir: join(root, "data"),
        pipeline: { imageTemplate: "img-test", editTemplate: "edit-test", videoTemplate: "video-test", videoSeconds: 5, videoFps: 24, maxKeyframesPerShot: 2 },
    };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function fakeJobs() {
    const enqueued = [];
    return {
        enqueued,
        enqueue(job) {
            const created = { ...job, status: "queued", outputs: [] };
            enqueued.push(created);
            return created;
        },
    };
}

const SCRIPT = { logline: "一句话", synopsis: "梗概", characters: [], scenes: [{ id: "sc1" }] };
const SHOTS = { shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "走路", dialogue: "", audio: "", prompt: "a girl walking", negativePrompt: "blur" }] };
// 生成型阶段：模型故意填了假的 template/jobId/artifactUrl，编排器必须全部覆盖。
const FRAMES = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "少女走进老屋，中景", template: "模型乱填", jobId: "假的", artifactUrl: "/假的.png", status: "done" },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "少女停在桌边，近景", template: "模型乱填", jobId: "假的", artifactUrl: "/假的2.png", status: "done" },
    ],
};
const CLIPS = {
    clips: [{ id: "sh1-clip", shotId: "sh1", keyframeId: "sh1-start", template: "模型乱填", jobId: "假的", artifactUrl: "/假的.mp4", durationSec: 4, status: "done" }],
    assembly: { order: [], transition: "dissolve", outputUrl: "/假的.mp4", status: "done" },
};

/** 按提示词模板里的角色标记分流，模拟模型按各阶段输出契约返回 JSON。 */
function stageReply(content) {
    if (content.includes("片段合成师")) return CLIPS;
    if (content.includes("关键帧提示词工程师")) return FRAMES;
    if (content.includes("分镜师")) return SHOTS;
    return SCRIPT;
}

/** 假 LLM：按 providers/llm.js 的契约返回上游原始响应对象。 */
function fakeLlm(reply = SCRIPT) {
    const calls = [];
    return {
        calls,
        async chat(options) {
            calls.push(options);
            const value = typeof reply === "function" ? reply(options.messages.at(-1).content) : reply;
            return { choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] };
        },
    };
}

function build(env, options = {}) {
    const jobs = options.jobs || fakeJobs();
    const llm = options.llm || fakeLlm();
    const pipeline = createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs, comfy: {}, llm, runJob: options.runJob });
    return { pipeline, jobs, llm };
}

test("loadRegistry 规整 requires/produces 并保持阶段顺序", (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));

    const registry = loadRegistry(env.skillsDir);
    assert.equal(registry.version, 1);
    assert.deepEqual(registry.stages.map((stage) => stage.id), ["script", "storyboard", "keyframe", "assembly"]);
    assert.deepEqual(registry.stages[0].requires, []);
    assert.deepEqual(registry.stages[0].produces, ["script"]);
    assert.deepEqual(registry.stages[2].requires, ["storyboard"]);
    assert.equal(registry.stages[2].title, "关键帧");
});

test("registry.json 损坏时按空处理并告警", (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    writeFileSync(join(env.skillsDir, "registry.json"), "{ 坏掉的 JSON");

    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.deepEqual(loadRegistry(env.skillsDir).stages, []);
    } finally {
        console.warn = warn;
    }
});

test("loadSkills 解析 YAML 头并跳过缺少头的技能", (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    mkdirSync(join(env.skillsDir, "99-broken"), { recursive: true });
    writeFileSync(join(env.skillsDir, "99-broken", "SKILL.md"), "# 没有 YAML 头\n");

    const warn = console.warn;
    console.warn = () => {};
    try {
        const skills = loadSkills(env.skillsDir);
        assert.deepEqual(skills.map((skill) => skill.id), ["01-script", "02-storyboard", "04-keyframes", "05-clip-assembly"]);
        assert.equal(skills[0].name, "novel-to-script");
        assert.match(skills[0].description, /测试用剧本技能说明/);
    } finally {
        console.warn = warn;
    }

    assert.match(readSkill(env.skillsDir, "01-script"), /## 提示词模板/);
    assert.throws(() => readSkill(env.skillsDir, "nope"), /找不到技能/);
});

test("create/get/list 初始化四个阶段为 pending", (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env);

    const run = pipeline.create({ novel: "很久以前有一个村子", title: "第一集" });
    assert.match(run.id, /^run-/);
    assert.equal(run.title, "第一集");
    assert.deepEqual(Object.keys(run.stages), ["script", "storyboard", "keyframe", "assembly"]);
    assert.equal(run.stages.script.status, "pending");
    assert.deepEqual(run.stages.script.artifacts, []);

    assert.equal(pipeline.get(run.id).novel, "很久以前有一个村子");
    assert.equal(pipeline.get("run-not-exist"), null);
    assert.equal(pipeline.get("../../etc"), null);
    assert.equal(pipeline.list().length, 1);
    assert.equal(pipeline.stages().length, 4);
    assert.throws(() => pipeline.create({ novel: "   " }), /缺少小说正文/);
});

test("run.json 损坏时按空处理并告警，不崩", (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env);
    const run = pipeline.create({ novel: "很久以前" });
    writeFileSync(join(env.config.dataDir, "runs", run.id, "run.json"), "{ 坏掉的 JSON");

    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(pipeline.get(run.id), null);
        assert.deepEqual(pipeline.list(), []);
        assert.throws(() => pipeline.setStageInput(run.id, "script", { note: "x" }), /流水线不存在/);
    } finally {
        console.warn = warn;
    }
});

test("runStage 依赖不满足或阶段未知时抛可读错误", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env);
    const run = pipeline.create({ novel: "很久以前" });

    await assert.rejects(() => pipeline.runStage(run.id, "storyboard"), /请先完成 剧本/);
    await assert.rejects(() => pipeline.runStage(run.id, "keyframe"), /请先完成 分镜拆解/);
    await assert.rejects(() => pipeline.runStage(run.id, "nope"), /未知阶段/);
    await assert.rejects(() => pipeline.runStage("run-not-exist", "script"), /流水线不存在/);
    assert.throws(() => pipeline.setStageInput(run.id, "nope", {}), /未知阶段/);
});

test("script 阶段成功路径：填充模板、解析 JSON、落盘产物", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const llm = fakeLlm((content) => {
        assert.match(content, /很久以前有一个村子/);
        return SCRIPT;
    });
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel: "很久以前有一个村子" });

    const done = await pipeline.runStage(run.id, "script");
    assert.equal(done.stages.script.status, "done");
    assert.equal(done.stages.script.output.logline, "一句话");
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].messages[0].role, "system");
    assert.deepEqual(llm.calls[0].response_format, { type: "json_object" });

    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "run.json")));
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "script.json")));
    const reread = pipeline.get(run.id);
    assert.equal(reread.stages.script.status, "done");
    assert.equal(reread.stages.script.output.logline, "一句话");
});

test("非法 JSON：重试一次仍失败则置 error 并保留原文", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const llm = fakeLlm("这不是 JSON，只是解释文字");
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel: "很久以前" });

    const failed = await pipeline.runStage(run.id, "script");
    assert.equal(llm.calls.length, 2);
    assert.equal(failed.stages.script.status, "error");
    assert.equal(failed.stages.script.output, null);
    assert.match(failed.stages.script.error, /模型未返回合法 JSON/);
    assert.match(failed.stages.script.error, /这不是 JSON/);
    assert.equal(pipeline.get(run.id).stages.script.status, "error");
});

test("setStageInput 修订产物置 done，其它键合并进 inputs", (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env);
    const run = pipeline.create({ novel: "很久以前" });

    const revised = pipeline.setStageInput(run.id, "script", { output: { ...SCRIPT, logline: "人工修订" } });
    assert.equal(revised.stages.script.status, "done");
    assert.equal(revised.stages.script.output.logline, "人工修订");
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "script.json")));
    assert.equal(pipeline.get(run.id).stages.script.output.logline, "人工修订");

    const patched = pipeline.setStageInput(run.id, "script", { note: "补充说明" });
    assert.equal(patched.stages.script.inputs.note, "补充说明");
    assert.equal(patched.stages.script.output.logline, "人工修订");

    // 直接提交该阶段产物本体（key = 阶段 produces 名）不视为修订，只进 inputs。
    const bare = pipeline.setStageInput(run.id, "script", { script: { ...SCRIPT, logline: "产物本体" } });
    assert.equal(bare.stages.script.output.logline, "人工修订");
    assert.equal(bare.stages.script.inputs.script.logline, "产物本体");
});

test("生成型阶段：回填 template/jobId/status 并入队，不采信模型编造的产物", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobs();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, runJob: async () => ({ outputs: [] }) });
    const run = pipeline.create({ novel: "很久以前" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    assert.match(llm.calls[1].messages.at(-1).content, /"logline"/);

    const keyed = await pipeline.runStage(run.id, "keyframe");
    assert.equal(keyed.stages.keyframe.status, "done");
    assert.match(llm.calls[2].messages.at(-1).content, /"shots"/);
    const frames = keyed.stages.keyframe.output.frames;
    assert.deepEqual(frames.map((frame) => [frame.id, frame.role, frame.status]), [["sh1-start", "start", "queued"], ["sh1-end", "end", "queued"]]);
    assert.equal(frames[0].template, "img-test");
    // end 帧不再指向 editTemplate（那是换装模板 img_boogu_outfit_edit，要 PERSON_IMAGE + CLOTHING_IMAGE，
    // 语义不符且必然报「缺少参数」），三种角色统一用 imageTemplate。
    assert.equal(frames[1].template, "img-test");
    assert.equal(frames[0].jobId, `${run.id}-sh1-start`);
    assert.equal(frames[1].jobId, `${run.id}-sh1-end`);
    assert.deepEqual(frames.map((frame) => frame.artifactUrl), [null, null]);
    assert.equal(jobs.enqueued.length, 2);
    assert.equal(jobs.enqueued[0].kind, "image");
    assert.equal(jobs.enqueued[0].template, "img-test");
    assert.equal(jobs.enqueued[0].params.INPUT_IMAGE, undefined);
    assert.equal(jobs.enqueued[0].params.PROMPT, "少女走进老屋，中景");
    // 尺寸参数必须补齐，否则真实模板会在渲染阶段报「缺少参数：WIDTH」
    assert.equal(jobs.enqueued[0].params.WIDTH, 768);
    assert.equal(jobs.enqueued[0].params.HEIGHT, 1344);
    assert.equal(jobs.enqueued[0].params.BATCH, 1);

    const assembled = await pipeline.runStage(run.id, "assembly");
    const clips = assembled.stages.assembly.output.clips;
    assert.deepEqual(clips.map((clip) => [clip.id, clip.keyframeId, clip.template, clip.status]), [["sh1-clip", "sh1-start", "video-test", "queued"]]);
    assert.equal(clips[0].durationSec, 4);
    assert.equal(clips[0].jobId, null);
    assert.equal(clips[0].artifactUrl, null);
    assert.deepEqual(assembled.stages.assembly.output.assembly, { order: ["sh1-clip"], transition: "dissolve", status: "queued" });
    // 只有两个关键帧入了队；片段因为起始帧还没有产物（没有 INPUT_IMAGE）保持 queued 不入队。
    assert.equal(jobs.enqueued.length, 2);
    assert.deepEqual(jobs.enqueued.map((job) => job.kind), ["image", "image"]);
});

test("没有 runJob 时生成型阶段只标记 queued，不入队", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobs();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs });
    const run = pipeline.create({ novel: "很久以前" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");

    const keyed = await pipeline.runStage(run.id, "keyframe");
    assert.equal(keyed.stages.keyframe.status, "done");
    assert.deepEqual(keyed.stages.keyframe.output.frames.map((frame) => frame.jobId), [null, null]);
    assert.equal(jobs.enqueued.length, 0);
});

test("编排器产出的参数必须覆盖真实模板要求的 token（契约回归）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    // 换成本仓库真实模板与真实尺寸默认值，模拟线上配置。
    env.config.workflowsDir = workflowsDir;
    env.config.pipeline = {
        imageTemplate: "img_zimage_artistic",
        editTemplate: "img_boogu_outfit_edit",
        videoTemplate: "video_h3_i2v",
        imageWidth: 768,
        imageHeight: 1344,
        imageBatch: 1,
        videoWidth: 768,
        videoHeight: 1344,
        videoSeconds: 5,
        videoFps: 24,
        maxKeyframesPerShot: 2,
    };

    const jobs = fakeJobs();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, runJob: async () => ({ outputs: [] }) });
    const run = pipeline.create({ novel: "很久以前" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    assert.ok(jobs.enqueued.length >= 1, "关键帧阶段至少应入队一个任务");
    for (const job of jobs.enqueued) {
        const templatePath = join(workflowsDir, `${job.template}.json`);
        const required = extractTokens(templatePath).filter((token) => !RUNNER_FILLED.has(token));
        const missing = required.filter((token) => job.params[token] === undefined || job.params[token] === "");
        assert.deepEqual(missing, [], `${job.template} 缺少参数：${missing.join("、")}`);
        // 用真实模板渲染一次，确认不会在渲染阶段就抛错。
        assert.doesNotThrow(
            () => renderTemplate(templatePath, { ...job.params, SEED: 1, OUTPUT_PREFIX: "canvas/test", LORA_FILE: "", LORA_STRENGTH: 1 }),
            `${job.template} 渲染失败`,
        );
    }
});

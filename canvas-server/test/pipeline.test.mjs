import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";
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
            `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n\n## 输入\n\n- 编排器上下文\n\n## 输出契约\n\n字段名固定。\n\n## 内容创作红线（硬约束）\n\n- 测试红线-忠于原著：忠于原著，不为道德教化、过审改稿。\n- 测试红线-不教化：不注入教化式结构。\n- 测试红线-风险只提示：风险只提示、不改稿。\n\n## 提示词模板\n\n${prompt}\n\n## 校验规则\n\n- 只输出 JSON\n\n## 工具\n\n- /api/llm/*\n`,
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
        pipeline: { imageTemplate: "img-test", editTemplate: "edit-test", videoTemplate: "video-test", videoSeconds: 5, videoFps: 24, maxKeyframesPerShot: 1 },
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

/** 可控任务源：不真跑任务，靠 finish/cancel 手动推终态，用来驱动 Job→流水线的回写投影。 */
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
            if (["done", "error", "canceled"].includes(job.status)) return job;
            Object.assign(job, { status: "canceled", finishedAt: new Date().toISOString() });
            emit(job);
            return job;
        },
        on(event, handler) {
            if (event === "change") handlers.push(handler);
            return () => {};
        },
        /** 手动推一个终态（done/error/canceled），触发 change 订阅者。 */
        finish(id, status, patch = {}) {
            const job = store.get(id);
            Object.assign(job, patch, { status, finishedAt: new Date().toISOString() });
            emit(job);
            return job;
        },
    };
}

const SCRIPT = { logline: "一句话", synopsis: "梗概", characters: [], scenes: [{ id: "sc1" }] };
const CHUNK_PARTIAL_A = { characters: [{ id: "c1", name: "甲", profile: "村民", appearance: "青年", voice: "清亮" }], scenes: [{ id: "sc1", title: "村口", location: "外景 村口", time: "日", intent: "出场", beats: ["甲走进村子"] }] };
const CHUNK_PARTIAL_B = { characters: [{ id: "c1", name: "乙", profile: "猎户", appearance: "壮汉", voice: "低沉" }], scenes: [{ id: "sc1", title: "山林", location: "外景 山林", time: "夜", intent: "冲突", beats: ["乙拦住甲"] }] };
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
    const pipeline = createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs, comfy: {}, llm, runJob: options.runJob, assemble: options.assemble, getProject: options.getProject, applyPlanSuggestion: options.applyPlanSuggestion, registerAssetRef: options.registerAssetRef });
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
    const llm = fakeLlm(SCRIPT);
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel: "很久以前有一个村子" });

    const done = await pipeline.runStage(run.id, "script");
    assert.equal(done.stages.script.status, "done");
    assert.equal(done.stages.script.output.logline, "一句话");
    // 多步编排：analyze（读原文，把小说填进模板）+ outline（分集规划）；单集时不再额外调模型
    assert.equal(llm.calls.length, 2);
    assert.match(llm.calls[0].messages.at(-1).content, /很久以前有一个村子/, "analyze 调用把小说填进模板");
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

test("script 阶段超长小说自动分块：N 次 map + 1 次 reduce，产物契约与单次调用一致", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxNovelChunkChars = 100; // 小阈值强制走分块流程
    const paragraph = "这是一段小说正文内容。";
    const partA = `【甲.txt】\n${paragraph.repeat(5)}`;
    const partB = `【乙.txt】\n${paragraph.repeat(5)}`;
    const llm = fakeLlm((content) => {
        if (content.includes("合并成一份完整剧本")) return SCRIPT;
        return content.includes("第 1/2 块") ? CHUNK_PARTIAL_A : CHUNK_PARTIAL_B;
    });
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel: `${partA}\n\n${partB}`, title: "长篇" });

    const done = await pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(done.stages.script.status, "done");
    // 2 块 → 2 次 map + 1 次 reduce（analyze）+ 1 次分集规划（outline）；单集不再额外调模型
    assert.equal(llm.calls.length, 4);
    assert.deepEqual(llm.calls.map((call) => call.model), ["test-model", "test-model", "test-model", "test-model"]);
    assert.match(llm.calls[0].messages.at(-1).content, /第 1\/2 块（来源：甲\.txt）/);
    assert.match(llm.calls[1].messages.at(-1).content, /第 2\/2 块（来源：乙\.txt）/);
    const reducePrompt = llm.calls[2].messages.at(-1).content;
    assert.match(reducePrompt, /合并成一份完整剧本/);
    assert.match(reducePrompt, /"name": "甲"/);
    assert.match(reducePrompt, /"name": "乙"/);
    // output 契约与单次调用完全一致，下游零感知（episodes 恒存在，多步编排保证非空）
    assert.deepEqual(Object.keys(done.stages.script.output).sort(), ["characters", "episodes", "logline", "scenes", "synopsis"]);
    assert.equal(done.stages.script.output.logline, "一句话");
    // 分块信息记在 stage.chunked，便于前端/排查；reused 是本次从缓存复用的块数（首跑为 0）
    assert.deepEqual(done.stages.script.chunked, { chunks: 2, labels: ["甲.txt", "乙.txt"], mergeModel: "test-model", reused: 0 });
    assert.equal(pipeline.get(run.id).stages.script.chunked.chunks, 2);
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "script.json")));
    // 每块的 map 结果单独落盘，这是断点续跑的物理基础
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "chunks", "1.json")), "第 1 块结果应已落盘");
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "chunks", "2.json")), "第 2 块结果应已落盘");
    // 成功后保留一条 phase:"done" 的进度，前端据此停止轮询而不必拉数 MB 的 run.json
    assert.equal(pipeline.stageProgress(run.id)?.phase, "done");
    // 创建时就给出的成本预估，口径必须与实际分块一致
    assert.deepEqual(run.estimate.chunked, true);
    assert.equal(run.estimate.chunks, 2);
    assert.equal(run.estimate.llmCalls, 3);
});

test("断点续跑：resume 复用已落盘的块，只补跑缺的那些", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxNovelChunkChars = 100;
    const paragraph = "这是一段小说正文内容。";
    const novel = `【甲.txt】\n${paragraph.repeat(5)}\n\n【乙.txt】\n${paragraph.repeat(5)}`;

    // 第一跑：第 1 块成功、第 2 块炸掉，模拟跑到一半崩了
    const broken = fakeLlm((content) => {
        if (content.includes("第 2/2 块")) throw new Error("上游 502");
        return CHUNK_PARTIAL_A;
    });
    const first = build(env, { llm: broken });
    const run = first.pipeline.create({ novel, title: "长篇" });
    const failed = await first.pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(failed.stages.script.status, "error");
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "chunks", "1.json")), "崩之前完成的块必须已落盘");
    assert.equal(first.llm.calls.length, 2, "第 1 块 + 失败的 1 次重试");

    // 第二跑带 resume：第 1 块直接复用，只补第 2 块 + reduce
    const healthy = fakeLlm((content) => {
        if (content.includes("合并成一份完整剧本")) return SCRIPT;
        return CHUNK_PARTIAL_B;
    });
    const second = build(env, { llm: healthy });
    const resumed = await second.pipeline.runStage(run.id, "script", { model: "test-model", resume: true });
    assert.equal(resumed.stages.script.status, "done");
    assert.deepEqual(second.llm.calls.map((call) => (call.messages.at(-1).content.match(/第 (\d)\/2 块/) || [])[1]).filter(Boolean), ["2"], "只应重跑第 2 块");
    assert.equal(resumed.stages.script.chunked.reused, 1);
    assert.equal(resumed.stages.script.chunked.chunks, 2);
    assert.deepEqual(Object.keys(resumed.stages.script.output).sort(), ["characters", "episodes", "logline", "scenes", "synopsis"]);
});

test("不带 resume 重跑会清空上次的分块缓存，避免小说改过之后复用陈旧块", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxNovelChunkChars = 100;
    const paragraph = "这是一段小说正文内容。";
    const novel = `【甲.txt】\n${paragraph.repeat(5)}\n\n【乙.txt】\n${paragraph.repeat(5)}`;
    const llm = fakeLlm((content) => (content.includes("合并成一份完整剧本") ? SCRIPT : content.includes("第 1/2 块") ? CHUNK_PARTIAL_A : CHUNK_PARTIAL_B));
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel, title: "长篇" });
    await pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(llm.calls.length, 4);
    await pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(llm.calls.length, 8, "不带 resume 应完整重跑（2 map + 1 reduce + 1 outline）×2");
    assert.equal(pipeline.get(run.id).stages.script.chunked.reused, 0);
});

test("取消：signal 已中止时立刻失败，不再打模型", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxNovelChunkChars = 100;
    const paragraph = "这是一段小说正文内容。";
    const novel = `【甲.txt】\n${paragraph.repeat(5)}\n\n【乙.txt】\n${paragraph.repeat(5)}`;
    const llm = fakeLlm(() => SCRIPT);
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel, title: "长篇" });
    const controller = new AbortController();
    controller.abort();
    const done = await pipeline.runStage(run.id, "script", { model: "test-model", signal: controller.signal });
    assert.equal(done.stages.script.status, "error");
    assert.match(done.stages.script.error, /已取消/);
    assert.equal(llm.calls.length, 0, "已取消就不该再发任何模型请求");
    assert.equal(pipeline.stageProgress(run.id)?.phase, "failed");
});

test("beginStage 拒绝在正在运行的阶段上重复触发", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel: "一段短小说", title: "短篇" });
    pipeline.beginStage(run.id, "script", {});
    assert.equal(pipeline.get(run.id).stages.script.status, "running");
    assert.throws(() => pipeline.beginStage(run.id, "script", {}), /正在运行中/);
});

test("reconcileRunning 把上次进程遗留的 running 阶段收敛为 error", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline } = build(env, { llm: fakeLlm(stageReply) });
    const run = pipeline.create({ novel: "一段短小说", title: "短篇" });
    pipeline.beginStage(run.id, "script", {}); // 只起步不执行，模拟进程被杀
    assert.equal(pipeline.get(run.id).stages.script.status, "running");

    const restarted = build(env, { llm: fakeLlm(stageReply) });
    assert.deepEqual(restarted.pipeline.reconcileRunning(), [run.id]);
    const after = restarted.pipeline.get(run.id);
    assert.equal(after.stages.script.status, "error");
    assert.match(after.stages.script.error, /服务重启导致中断/);
    assert.deepEqual(restarted.pipeline.reconcileRunning(), [], "再收敛一次应为空");
});

test("生成型阶段：回填 template/jobId/status 并入队，不采信模型编造的产物", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobQueue();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, runJob: async () => ({ outputs: [] }) });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    assert.match(llm.calls[2].messages.at(-1).content, /"logline"/);

    const keyed = await pipeline.runStage(run.id, "keyframe");
    // 不再「入队即 done」：start 帧已入队，阶段停在 running 等任务终态。
    assert.equal(keyed.stages.keyframe.status, "running");
    assert.match(llm.calls[3].messages.at(-1).content, /"shots"/);
    const frames = keyed.stages.keyframe.output.frames;
    assert.deepEqual(frames.map((frame) => [frame.id, frame.role, frame.status]), [["sh1-start", "start", "queued"], ["sh1-end", "end", "queued"]]);
    assert.equal(frames[0].template, "img-test");
    // end 帧不再指向 editTemplate（那是换装模板 img_boogu_outfit_edit，要 PERSON_IMAGE + CLOTHING_IMAGE，
    // 语义不符且必然报「缺少参数」），三种角色统一用 imageTemplate。
    assert.equal(frames[1].template, "img-test");
    assert.equal(frames[0].jobId, `${run.id}-sh1-start`);
    // end 帧要等同镜 start 帧产物才入队。
    assert.equal(frames[1].jobId, null);
    assert.deepEqual(frames.map((frame) => frame.artifactUrl), [null, null]);
    assert.deepEqual(frames[0].candidates.map((candidate) => candidate.status), ["queued"]);
    assert.equal(jobs.list().length, 1);
    const startJob = jobs.get(`${run.id}-sh1-start`);
    assert.equal(startJob.kind, "image");
    assert.equal(startJob.template, "img-test");
    assert.equal(startJob.params.INPUT_IMAGE, undefined);
    assert.equal(startJob.params.PROMPT, "少女走进老屋，中景");
    // 尺寸参数必须补齐，否则真实模板会在渲染阶段报「缺少参数：WIDTH」
    assert.equal(startJob.params.WIDTH, 768);
    assert.equal(startJob.params.HEIGHT, 1344);
    assert.equal(startJob.params.BATCH, 1);

    // start 帧任务完成 → 回写产物、重算 artifacts，并让 end 帧带上参考图入队。
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s1.png", type: "image" }] });
    const afterStart = pipeline.get(run.id).stages.keyframe;
    assert.equal(afterStart.output.frames[0].artifactUrl, "/api/artifacts/job/s1.png");
    assert.equal(afterStart.output.frames[0].status, "done");
    assert.deepEqual(afterStart.artifacts, [{ jobId: `${run.id}-sh1-start`, url: "/api/artifacts/job/s1.png" }]);
    const endJob = jobs.get(`${run.id}-sh1-end`);
    assert.ok(endJob, "end 帧应在前置就绪后入队");
    assert.equal(endJob.params.INPUT_IMAGE, "/api/artifacts/job/s1.png");
    assert.equal(afterStart.status, "running", "start 已完成但 end 刚入队仍在跑 → 阶段保持 running");

    // end 帧完成 → 阶段 done。
    jobs.finish(endJob.id, "done", { outputs: [{ url: "/api/artifacts/job/e1.png", type: "image" }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done");

    const assembled = await pipeline.runStage(run.id, "assembly");
    const clips = assembled.stages.assembly.output.clips;
    assert.deepEqual(clips.map((clip) => [clip.id, clip.keyframeId, clip.template, clip.status]), [["sh1-clip", "sh1-start", "video-test", "queued"]]);
    assert.equal(clips[0].durationSec, 4);
    // 关键帧 start 帧已就绪 → 片段真正入队，并带上起始帧地址。
    assert.ok(clips[0].jobId, "关键帧就绪后片段应入队");
    assert.equal(jobs.get(clips[0].jobId).kind, "video");
    assert.equal(jobs.get(clips[0].jobId).params.INPUT_IMAGE, "/api/artifacts/job/s1.png");
    assert.deepEqual(assembled.stages.assembly.output.assembly, { order: ["sh1-clip"], transition: "dissolve", status: "queued" });
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

/** 建一条跑到 keyframe 的流水线：script→storyboard→keyframe，返回已入队的 start 任务。 */
async function toKeyframe(env, { bind = true } = {}) {
    const jobs = fakeJobQueue();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, runJob: async () => ({ outputs: [] }) });
    if (bind) pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    return { pipeline, jobs, llm, run, startJob: jobs.get(`${run.id}-sh1-start`) };
}

test("P0-b：Job 终态回写流水线，item.artifactUrl 与 stage.artifacts 非空", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);

    const url = "/api/artifacts/job/start.png";
    jobs.finish(startJob.id, "done", { outputs: [{ url, type: "image" }] });

    const stage = pipeline.get(run.id).stages.keyframe;
    const frame = stage.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.artifactUrl, url);
    assert.equal(frame.status, "done");
    assert.equal(frame.selected, `${run.id}-sh1-start`);
    assert.deepEqual(frame.candidates.map((candidate) => [candidate.jobId, candidate.status, candidate.artifactUrl]), [[`${run.id}-sh1-start`, "done", url]]);
    assert.deepEqual(stage.artifacts, [{ jobId: `${run.id}-sh1-start`, url }]);
});

test("P0-b：end 帧取到同镜 start 帧 artifactUrl 才入队", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);
    assert.equal(jobs.get(`${run.id}-sh1-end`), null, "start 尚未产出时 end 不入队");

    const url = "/api/artifacts/job/start.png";
    jobs.finish(startJob.id, "done", { outputs: [{ url }] });

    const endJob = jobs.get(`${run.id}-sh1-end`);
    assert.ok(endJob, "start 产出后 end 应补入队");
    assert.equal(endJob.params.INPUT_IMAGE, url);
    assert.equal(pipeline.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-end").jobId, `${run.id}-sh1-end`);
});

test("P0-b：回写幂等——重复投递同一 change 事件不重复追加候选、不覆盖 selected", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);

    const url = "/api/artifacts/job/start.png";
    jobs.finish(startJob.id, "done", { outputs: [{ url }] });
    const before = pipeline.get(run.id).stages.keyframe.output.frames[0];

    // 同一终态事件重复投递两次（模拟重放/重复通知）。
    pipeline.projectJob(jobs.get(startJob.id));
    pipeline.projectJob(jobs.get(startJob.id));

    const after = pipeline.get(run.id).stages.keyframe.output.frames[0];
    assert.equal(after.candidates.length, before.candidates.length);
    assert.equal(after.selected, before.selected);
    assert.equal(after.artifactUrl, url);
});

test("P0-b：必需 Job 全失败→error，部分成功→partial", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));

    // 全失败：start 任务 error，end 因前置未就绪不入队 → 阶段 error。
    const failed = await toKeyframe(env);
    failed.jobs.finish(failed.startJob.id, "error", { error: "GPU 挂了" });
    assert.equal(failed.pipeline.get(failed.run.id).stages.keyframe.status, "error");
    assert.deepEqual(failed.pipeline.get(failed.run.id).stages.keyframe.artifacts, []);

    // 部分成功：start done、end error → partial。
    const partial = await toKeyframe(env);
    partial.jobs.finish(partial.startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s.png" }] });
    const endJob = partial.jobs.get(`${partial.run.id}-sh1-end`);
    partial.jobs.finish(endJob.id, "error", { error: "崩了" });
    assert.equal(partial.pipeline.get(partial.run.id).stages.keyframe.status, "partial");
    assert.equal(partial.pipeline.get(partial.run.id).stages.keyframe.artifacts.length, 1);
});

test("P0-b：全部成功才 done，且不是「入队即 done」", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);

    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running", "刚入队不能是 done");
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s.png" }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running", "start 完成、end 刚入队 → 仍在跑，不是 partial");
    const endJob = jobs.get(`${run.id}-sh1-end`);
    jobs.finish(endJob.id, "done", { outputs: [{ url: "/api/artifacts/job/e.png" }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done");
    assert.equal(pipeline.get(run.id).stages.keyframe.artifacts.length, 2);
});

test("P0-b：取消阶段传播到已入队 Job 并落 canceled", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);

    const result = pipeline.cancelStage(run.id, "keyframe");
    assert.equal(result.canceled, 1);
    assert.equal(jobs.get(startJob.id).status, "canceled");
    const stage = pipeline.get(run.id).stages.keyframe;
    assert.equal(stage.status, "canceled");
    assert.equal(stage.output.frames[0].status, "canceled");
    assert.equal(stage.output.frames[0].candidates.at(-1).status, "canceled");
});

test("P0-b：取消新 attempt 不污染已有成功阶段", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run } = await toKeyframeDone(env);
    const frameBefore = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start");
    const previousJobId = frameBefore.selected;
    const retry = await pipeline.executeRegenerate(pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" }));
    assert.notEqual(retry.jobId, previousJobId);
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running");
    const canceled = pipeline.cancelStage(run.id, "keyframe");
    assert.equal(canceled.canceled, 1);
    const frameAfter = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start");
    assert.equal(frameAfter.candidates.at(-1).status, "canceled");
    assert.equal(frameAfter.selected, previousJobId, "取消用户新 attempt 后回退到原成功候选");
    assert.equal(frameAfter.status, "done");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done", "阶段仍以已有成功候选为准");
});

test("P0-b：服务重启后从终态任务重放重建投影", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    // 第一个进程不订阅事件：任务 done 了，但流水线不知道（模拟回写断链）。
    const first = await toKeyframe(env, { bind: false });
    const url = "/api/artifacts/job/s.png";
    first.jobs.finish(first.startJob.id, "done", { outputs: [{ url }] });
    assert.equal(first.pipeline.get(first.run.id).stages.keyframe.output.frames[0].artifactUrl, null, "未订阅时不回写");

    // 第二个进程复用同一任务源（相当于 jobs.json），bindJobs 重放终态任务重建投影。
    const rebuilt = createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs: first.jobs, comfy: {}, llm: fakeLlm(stageReply), runJob: async () => ({ outputs: [] }) });
    rebuilt.bindJobs();
    const frames = rebuilt.get(first.run.id).stages.keyframe.output.frames;
    assert.equal(frames[0].artifactUrl, url);
    assert.equal(frames[0].status, "done");
    assert.deepEqual(rebuilt.get(first.run.id).stages.keyframe.artifacts, [{ jobId: first.startJob.id, url }]);
    assert.ok(first.jobs.get(`${first.run.id}-sh1-end`), "重放后 end 帧也应补入队");
});

test("P0-b：assembly 在关键帧产物就绪后真正入队（不为空 jobId）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);

    const url = "/api/artifacts/job/s.png";
    jobs.finish(startJob.id, "done", { outputs: [{ url }] });
    jobs.finish(jobs.get(`${run.id}-sh1-end`).id, "done", { outputs: [{ url: "/api/artifacts/job/e.png" }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done");

    const assembled = await pipeline.runStage(run.id, "assembly");
    const clip = assembled.stages.assembly.output.clips[0];
    assert.ok(clip.jobId, "关键帧就绪后片段 jobId 不为空");
    assert.equal(clip.status, "queued");
    assert.equal(jobs.get(clip.jobId).kind, "video");
    assert.equal(jobs.get(clip.jobId).params.INPUT_IMAGE, url);
});

test("index 集成：模块初始化即订阅回写，取消空阶段接口回 409", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-index-"));
    const env = makeEnv();
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
        rmSync(env.root, { recursive: true, force: true });
    });
    // 指向临时数据目录，绝不碰生产 data/；env 必须在 import 前设好。
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = env.skillsDir;
    const mod = await import("../src/index.js");
    assert.equal(typeof mod.pipeline.projectJob, "function");
    assert.equal(typeof mod.pipeline.bindJobs, "function");
    assert.equal(typeof mod.pipeline.cancelStage, "function");

    const run = mod.pipeline.create({ novel: "很久以前" });
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const port = mod.server.address().port;
    try {
        // 无 inflight、无已入队 Job → 409（沿用旧行为）。
        const idle = await fetch(`http://127.0.0.1:${port}/api/pipeline/runs/${run.id}/steps/script/cancel`, { method: "POST" });
        assert.equal(idle.status, 409);
        // 未知 run → 404（cancelStage 抛错被兜成 404）。
        const missing = await fetch(`http://127.0.0.1:${port}/api/pipeline/runs/run-nope/steps/script/cancel`, { method: "POST" });
        assert.equal(missing.status, 404);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

test("分块路径：map 与 reduce 提示词都带上阶段技能的内容创作红线", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxNovelChunkChars = 100;
    const paragraph = "这是一段小说正文内容。";
    const novel = `【甲.txt】\n${paragraph.repeat(5)}\n\n【乙.txt】\n${paragraph.repeat(5)}`;
    const llm = fakeLlm((content) => (content.includes("合并成一份完整剧本") ? SCRIPT : content.includes("第 1/2 块") ? CHUNK_PARTIAL_A : CHUNK_PARTIAL_B));
    const { pipeline } = build(env, { llm });
    const run = pipeline.create({ novel, title: "长篇" });

    const done = await pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(done.stages.script.status, "done");
    assert.equal(llm.calls.length, 4);
    const [mapA, mapB, reduce] = llm.calls.map((call) => call.messages.at(-1).content);
    // 逐块 map 与合并 reduce 都必须带上阶段技能的「内容创作红线（硬约束）」
    for (const [label, prompt] of [["map-1", mapA], ["map-2", mapB], ["reduce", reduce]]) {
        assert.match(prompt, /改编必须遵守阶段技能的内容创作红线（硬约束）/, `${label} 提示词缺少红线标题`);
        assert.match(prompt, /测试红线-忠于原著/, `${label} 提示词缺少忠于原著`);
        assert.match(prompt, /测试红线-不教化/, `${label} 提示词缺少不注入教化结构`);
        assert.match(prompt, /测试红线-风险只提示/, `${label} 提示词缺少风险只提示不改稿`);
    }
    // map 与 reduce 都要求“只输出契约允许的字段”，且保留各自契约 JSON 骨架
    assert.match(mapA, /只输出契约允许的字段/);
    assert.match(reduce, /只输出契约允许的字段/);
    assert.match(mapA, /"characters"/);
    assert.match(reduce, /"logline"/);
});

test("分块路径产物与单次调用同构：同一份 reduce 输出 → 逐字段一致", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));

    // 单次调用：短篇不触发分块
    const single = build(env, { llm: fakeLlm(SCRIPT) });
    const shortRun = single.pipeline.create({ novel: "短篇小说正文" });
    const singleDone = await single.pipeline.runStage(shortRun.id, "script");
    assert.equal(singleDone.stages.script.chunked, undefined, "短篇应走单次调用");

    // 分块调用：小阈值强制 map-reduce
    env.config.pipeline.maxNovelChunkChars = 100;
    const paragraph = "这是一段小说正文内容。";
    const novel = `【甲.txt】\n${paragraph.repeat(5)}\n\n【乙.txt】\n${paragraph.repeat(5)}`;
    const chunked = build(env, { llm: fakeLlm((content) => (content.includes("合并成一份完整剧本") ? SCRIPT : content.includes("第 1/2 块") ? CHUNK_PARTIAL_A : CHUNK_PARTIAL_B)) });
    const longRun = chunked.pipeline.create({ novel, title: "长篇" });
    const chunkedDone = await chunked.pipeline.runStage(longRun.id, "script");
    assert.equal(chunkedDone.stages.script.chunked.chunks, 2);

    // 两条路径最终产物逐键一致：下游 02/03 阶段零感知
    assert.deepEqual(chunkedDone.stages.script.output, singleDone.stages.script.output);
    assert.deepEqual(Object.keys(chunkedDone.stages.script.output).sort(), Object.keys(singleDone.stages.script.output).sort());
});

test("分块路径 resume：复用块结果不变，补跑块的提示词仍带红线", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxNovelChunkChars = 100;
    const paragraph = "这是一段小说正文内容。";
    const novel = `【甲.txt】\n${paragraph.repeat(5)}\n\n【乙.txt】\n${paragraph.repeat(5)}`;

    // 第一跑：第 2 块炸，第 1 块已落盘
    const broken = fakeLlm((content) => {
        if (content.includes("第 2/2 块")) throw new Error("上游 502");
        return CHUNK_PARTIAL_A;
    });
    const first = build(env, { llm: broken });
    const run = first.pipeline.create({ novel, title: "长篇" });
    const failed = await first.pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(failed.stages.script.status, "error");
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "chunks", "1.json")));

    // 第二跑 resume：第 1 块复用，只补第 2 块 + reduce
    const healthy = fakeLlm((content) => (content.includes("合并成一份完整剧本") ? SCRIPT : CHUNK_PARTIAL_B));
    const second = build(env, { llm: healthy });
    const resumed = await second.pipeline.runStage(run.id, "script", { model: "test-model", resume: true });
    assert.equal(resumed.stages.script.status, "done");
    assert.equal(resumed.stages.script.chunked.reused, 1, "第 1 块应复用缓存");
    // 补跑的第 2 块提示词仍带红线，且第 2 块结果照常落盘
    const rerun = second.llm.calls.find((call) => /第 2\/2 块/.test(call.messages.at(-1).content));
    assert.match(rerun.messages.at(-1).content, /测试红线-忠于原著/);
    assert.ok(existsSync(join(env.config.dataDir, "runs", run.id, "chunks", "2.json")));
});

// ——— 活扣 regenerate（逐条换模型重跑）———

/** 造几个最小模板文件供 family 校验；family 由文件名前缀推断（img→image、video→video）。 */
function makeWorkflows(root, names) {
    const dir = join(root, "workflows");
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, `${name}.json`), "{}");
    return dir;
}

/** 把关键帧阶段跑到 done（start / end 两个 Job 都成功），得到可安全重跑的流水线。 */
async function toKeyframeDone(env) {
    const ctx = await toKeyframe(env);
    ctx.jobs.finish(ctx.startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s.png" }] });
    ctx.jobs.finish(ctx.jobs.get(`${ctx.run.id}-sh1-end`).id, "done", { outputs: [{ url: "/api/artifacts/job/e.png" }] });
    assert.equal(ctx.pipeline.get(ctx.run.id).stages.keyframe.status, "done");
    return ctx;
}

test("regenerate：只给指定 item 追加一个候选，旧候选与其它 item 都不动", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.workflowsDir = makeWorkflows(env.root, ["img-alt", "img-alt2", "video-alt"]);
    const { pipeline, jobs, run } = await toKeyframeDone(env);

    const before = pipeline.get(run.id).stages.keyframe.output.frames;
    const beforeStart = structuredClone(before.find((frame) => frame.id === "sh1-start"));
    const beforeEnd = structuredClone(before.find((frame) => frame.id === "sh1-end"));

    // 未指定 template 时沿用阶段默认模板（此时阶段仍是 done，可安全试算）
    const defaulted = pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-end" });
    assert.equal(defaulted.plan.template, "img-test");

    const result = await pipeline.executeRegenerate(pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start", template: "img-alt" }));
    assert.equal(result.run.stages.keyframe.status, "running", "新候选入队后阶段回到 running");
    // 轻量进度也要刷新，否则前端会一直读到上一次的 phase:"done"
    assert.equal(pipeline.stageProgress(run.id)?.phase, "running");
    assert.match(pipeline.stageProgress(run.id)?.label, /sh1-start/);

    const frames = pipeline.get(run.id).stages.keyframe.output.frames;
    const start = frames.find((frame) => frame.id === "sh1-start");
    const end = frames.find((frame) => frame.id === "sh1-end");

    // ① 追加一个新候选，旧候选一条不少、内容原样保留
    assert.equal(start.candidates.length, beforeStart.candidates.length + 1);
    assert.deepEqual(start.candidates[0], beforeStart.candidates[0]);
    // ② 换的模型写进新候选，并同步到 item.template
    assert.equal(start.candidates.at(-1).template, "img-alt");
    assert.equal(start.template, "img-alt");
    assert.equal(start.selected, start.candidates.at(-1).jobId, "新候选成为 selected");
    assert.notEqual(start.selected, beforeStart.selected, "旧 selected 不被沿用");
    assert.notEqual(start.candidates.at(-1).jobId, beforeStart.candidates.at(-1).jobId, "新 jobId 不是旧 id");
    // ③ 其它 item 完全不动（回写过的 end 帧一条候选不增）
    assert.deepEqual(end, beforeEnd);
    // 新任务确实入队，kind=image、template 为新值、沿用原 params 与 meta
    const newJob = jobs.get(start.candidates.at(-1).jobId);
    assert.equal(newJob.kind, "image");
    assert.equal(newJob.template, "img-alt");
    assert.equal(newJob.params.PROMPT, "少女走进老屋，中景");
    assert.deepEqual(newJob.meta, { runId: run.id, stageId: "keyframe", itemId: "sh1-start" });
});

test("regenerate：assembly 阶段换 video 模板追加候选，错 family 模板被拒", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.workflowsDir = makeWorkflows(env.root, ["img-alt", "video-alt"]);
    const { pipeline, jobs, run, startJob } = await toKeyframe(env);
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s.png" }] });
    jobs.finish(jobs.get(`${run.id}-sh1-end`).id, "done", { outputs: [{ url: "/api/artifacts/job/e.png" }] });
    await pipeline.runStage(run.id, "assembly");
    const clipJob = jobs.get(pipeline.get(run.id).stages.assembly.output.clips[0].jobId);
    jobs.finish(clipJob.id, "done", { outputs: [{ url: "/api/artifacts/job/c.mp4" }] });
    assert.equal(pipeline.get(run.id).stages.assembly.status, "done");

    // 图模板不能塞进视频阶段 → 400
    assert.throws(
        () => pipeline.beginRegenerate(run.id, "assembly", { itemId: "sh1-clip", template: "img-alt" }),
        (error) => error.status === 400 && /不能用于/.test(error.message),
    );

    const result = await pipeline.executeRegenerate(pipeline.beginRegenerate(run.id, "assembly", { itemId: "sh1-clip", template: "video-alt" }));
    const clip = result.run.stages.assembly.output.clips[0];
    assert.equal(clip.candidates.length, 2, "是追加而非替换");
    assert.equal(clip.candidates.at(-1).template, "video-alt");
    const newJob = jobs.get(result.jobId);
    assert.equal(newJob.kind, "video");
    assert.equal(newJob.params.INPUT_IMAGE, "/api/artifacts/job/s.png");
});

test("regenerate：文本阶段 / item 不存在 / 模板非法 → 400 且无副作用", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.workflowsDir = makeWorkflows(env.root, ["img-alt", "video-alt"]);
    const { pipeline, jobs, run } = await toKeyframeDone(env);
    const snapshot = JSON.stringify(pipeline.get(run.id).stages.keyframe);
    const jobCount = jobs.list().length;

    // 文本阶段没有候选活扣
    assert.throws(() => pipeline.beginRegenerate(run.id, "script", { itemId: "sh1-start" }), (error) => error.status === 400 && /不是生成型阶段/.test(error.message));
    // item 不存在
    assert.throws(() => pipeline.beginRegenerate(run.id, "keyframe", { itemId: "nope", template: "img-alt" }), (error) => error.status === 400 && /没有条目/.test(error.message));
    // 模板不存在
    assert.throws(() => pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start", template: "nope" }), (error) => error.status === 400 && /模板不存在/.test(error.message));
    // 模板不属于该阶段 family（视频模板塞进关键帧）
    assert.throws(() => pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start", template: "video-alt" }), (error) => error.status === 400 && /不能用于/.test(error.message));
    // 未知阶段 / 流水线不存在
    assert.throws(() => pipeline.beginRegenerate(run.id, "nope", { itemId: "x" }), /未知阶段/);
    assert.throws(() => pipeline.beginRegenerate("run-nope", "keyframe", { itemId: "x" }), /流水线不存在/);

    // 所有拒绝路径都不得产生副作用
    assert.equal(JSON.stringify(pipeline.get(run.id).stages.keyframe), snapshot);
    assert.equal(jobs.list().length, jobCount);
});

test("regenerate：阶段运行中或该 item 已有未完成候选 → 409", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.workflowsDir = makeWorkflows(env.root, ["img-alt", "video-alt"]);

    // 场景一：阶段正 running（start 已入队、还没终态）
    const running = await toKeyframe(env);
    assert.equal(running.pipeline.get(running.run.id).stages.keyframe.status, "running");
    assert.throws(
        () => running.pipeline.beginRegenerate(running.run.id, "keyframe", { itemId: "sh1-start", template: "img-alt" }),
        (error) => error.status === 409 && /正在运行中/.test(error.message),
    );

    // 场景二：人为把阶段标成 done，但该条目仍挂着 queued 候选 → 条目级门禁 409
    const done = await toKeyframeDone(env);
    const output = structuredClone(done.pipeline.get(done.run.id).stages.keyframe.output);
    output.frames[0].candidates.push({ template: "img-alt", jobId: "manual-pending", artifactUrl: null, status: "queued", params: {}, createdAt: new Date().toISOString() });
    done.pipeline.setStageInput(done.run.id, "keyframe", { output });
    assert.equal(done.pipeline.get(done.run.id).stages.keyframe.status, "done", "人为修订后阶段是 done");
    assert.throws(
        () => done.pipeline.beginRegenerate(done.run.id, "keyframe", { itemId: "sh1-start", template: "img-alt" }),
        (error) => error.status === 409 && /已有未完成候选/.test(error.message),
    );
});

test("regenerate：连续两次各追加一条候选，不会合并成一条", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.workflowsDir = makeWorkflows(env.root, ["img-alt", "img-alt2", "video-alt"]);
    const { pipeline, jobs, run } = await toKeyframeDone(env);
    const baseCount = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start").candidates.length;

    const first = await pipeline.executeRegenerate(pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start", template: "img-alt" }));
    jobs.finish(first.jobId, "done", { outputs: [{ url: "/api/artifacts/job/re1.png" }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done", "第一次重跑完成后阶段回到 done");

    const second = await pipeline.executeRegenerate(pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start", template: "img-alt2" }));
    assert.notEqual(first.jobId, second.jobId, "两次重跑必须是两个不同 jobId");

    const start = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start");
    assert.equal(start.candidates.length, baseCount + 2, "两次重跑各自追加一条，不合并");
    const ids = start.candidates.map((candidate) => candidate.jobId);
    assert.equal(new Set(ids).size, ids.length, "候选 jobId 全部唯一");
    assert.ok(ids.includes(first.jobId) && ids.includes(second.jobId));
    // 第二次换的是新模板；第一次已成功的产物没有丢
    assert.equal(start.candidates.at(-1).template, "img-alt2");
    assert.equal(start.artifactUrl, "/api/artifacts/job/re1.png");
    assert.equal(start.candidates.find((candidate) => candidate.jobId === first.jobId).status, "done");
});

// ——— 半自动一：plan 驱动制作参数 ———

const TEST_PROJECT = {
    id: "prj_test",
    styleAnchor: "冷调赛博朋克，霓虹夜景，电影质感",
    plan: { ratio: "16:9", episodeDurationSec: 7, visualStyle: "写实真人", genre: "都市", tone: "悬疑" },
};

/** 项目化模式跑一条到 keyframe 的流水线（注入 getProject），返回可控任务源。 */
async function toProjectKeyframe(env, project, { reply = stageReply } = {}) {
    const jobs = fakeJobQueue();
    const llm = fakeLlm(reply);
    const { pipeline } = build(env, { llm, jobs, runJob: async () => ({ outputs: [] }), getProject: (id) => (id === project.id ? project : null) });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    return { pipeline, jobs, llm, run, startJob: jobs.get(`${run.id}-sh1-start`) };
}

test("plan 驱动：ratio 推导 32 倍数尺寸、styleAnchor 与设定进生图首句", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { jobs, run, startJob } = await toProjectKeyframe(env, TEST_PROJECT);

    // 16:9 → 短边沿用 config 短边 768，长边 768*16/9≈1365.33 吸附到 32 倍数 1376
    assert.equal(startJob.params.WIDTH, 1376);
    assert.equal(startJob.params.HEIGHT, 768);
    assert.equal(startJob.params.WIDTH % 32, 0);
    assert.equal(startJob.params.HEIGHT % 32, 0);

    // 生图提示词首句一字不差是 styleAnchor，其后接 visualStyle/genre/tone 创作上下文与原始 prompt
    const prompt = startJob.params.PROMPT;
    assert.equal(prompt.split("。")[0], TEST_PROJECT.styleAnchor);
    assert.match(prompt, /写实真人/);
    assert.match(prompt, /都市/);
    assert.match(prompt, /悬疑/);
    assert.ok(prompt.endsWith("少女走进老屋，中景"), prompt);

    assert.equal(jobs.list().length, 1, "只有参数与提示词变化，入队行为不变");
    assert.equal(run.options.projectId, "prj_test");
});

test("plan 驱动：生视频同样带 styleAnchor，episodeDurationSec 作片段默认时长", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const noDurationClips = { clips: [{ id: "sh1-clip", shotId: "sh1", keyframeId: "sh1-start" }], assembly: { order: [], transition: "cut" } };
    const reply = (content) => (content.includes("片段合成师") ? noDurationClips : stageReply(content));
    const { pipeline, jobs, run, startJob } = await toProjectKeyframe(env, TEST_PROJECT, { reply });

    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s.png" }] });
    jobs.finish(jobs.get(`${run.id}-sh1-end`).id, "done", { outputs: [{ url: "/api/artifacts/job/e.png" }] });
    const assembled = await pipeline.runStage(run.id, "assembly");
    const clip = assembled.stages.assembly.output.clips[0];

    // 片段未自带 durationSec → 用 plan.episodeDurationSec=7（不是 config.videoSeconds=5）
    assert.equal(clip.durationSec, 7);
    const clipJob = jobs.get(clip.jobId);
    assert.equal(clipJob.params.WIDTH, 1376);
    assert.equal(clipJob.params.HEIGHT, 768);
    assert.equal(clipJob.params.PROMPT.split("。")[0], TEST_PROJECT.styleAnchor);
    // LENGTH 走 17n+5 帧网格：7s*24=168 帧 → 不小于 168 的网格点 175
    assert.equal(clipJob.params.LENGTH, 175);
});

test("不传 getProject：生成参数与失败行为逐字不变（不自动重试）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toKeyframe(env); // 不带 getProject

    // 提示词与尺寸保持旧值（无 styleAnchor 前缀、无 ratio 推导）：整份 params 逐字段不变
    assert.deepEqual(startJob.params, { WIDTH: 768, HEIGHT: 1344, BATCH: 1, PROMPT: "少女走进老屋，中景" });

    // 失败即止：不追加任何候选
    jobs.finish(startJob.id, "error", { error: "GPU 挂了" });
    const frame = pipeline.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.candidates.length, 1);
    assert.equal(frame.candidates[0].autoRetry, undefined);
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "error");
});

// ——— 半自动二：单镜失败自动重试 ———

test("单镜失败自动重试：最多 2 次、保留全部旧候选、用尽后落 error", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toProjectKeyframe(env, TEST_PROJECT);
    const frameOf = () => pipeline.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frameOf().candidates.length, 1);

    jobs.finish(startJob.id, "error", { error: "第 1 次失败" });
    assert.equal(frameOf().candidates.length, 2, "首次失败 → 自动重试 1 次");
    const retry1 = frameOf().candidates.at(-1);
    assert.equal(retry1.autoRetry, true);
    assert.equal(retry1.status, "queued");
    assert.equal(retry1.template, "img-test", "重试沿用同一模板");
    assert.notEqual(retry1.jobId, startJob.id, "重试用新 jobId");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running", "有重试在跑 → 阶段 running");

    jobs.finish(retry1.jobId, "error", { error: "第 2 次失败" });
    assert.equal(frameOf().candidates.length, 3, "预算内再重试 1 次");
    const retry2 = frameOf().candidates.at(-1);
    assert.equal(retry2.autoRetry, true);

    jobs.finish(retry2.jobId, "error", { error: "第 3 次失败" });
    assert.equal(frameOf().candidates.length, 3, "预算用尽 → 不再追加候选");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "error", "用尽后阶段自然落 error");

    // 三次 attempt 全部保留（含失败的），各自 jobId 唯一
    const candidates = frameOf().candidates;
    assert.deepEqual(candidates.map((candidate) => candidate.status), ["error", "error", "error"]);
    assert.equal(new Set(candidates.map((candidate) => candidate.jobId)).size, 3);
    assert.ok(candidates.every((candidate) => candidate.artifactUrl === null));
});

test("自动重试次数可配：maxItemRetries=1 只重试一次", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    env.config.pipeline.maxItemRetries = 1;
    const { pipeline, jobs, run, startJob } = await toProjectKeyframe(env, TEST_PROJECT);
    const frameOf = () => pipeline.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");

    jobs.finish(startJob.id, "error", { error: "挂了" });
    assert.equal(frameOf().candidates.length, 2);
    jobs.finish(frameOf().candidates.at(-1).jobId, "error", { error: "又挂" });
    assert.equal(frameOf().candidates.length, 2, "maxItemRetries=1 用尽后不再重试");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "error");
});

test("自动重试计数幂等：同一失败事件重复投递 / 重启重放不多算", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, startJob } = await toProjectKeyframe(env, TEST_PROJECT);
    const frameOf = (pipe = pipeline) => pipe.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");

    jobs.finish(startJob.id, "error", { error: "挂了" });
    assert.equal(frameOf().candidates.length, 2);

    // 同一失败事件重复投递两次：latest 已是 queued 重试候选，不得再追加
    pipeline.projectJob(jobs.get(startJob.id));
    pipeline.projectJob(jobs.get(startJob.id));
    assert.equal(frameOf().candidates.length, 2);

    // 模拟进程重启：新实例 bindJobs 重放 jobs.list() 全部终态任务，仍不得多算
    const rebuilt = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm: fakeLlm(stageReply),
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === TEST_PROJECT.id ? TEST_PROJECT : null),
    });
    rebuilt.bindJobs();
    assert.equal(frameOf(rebuilt).candidates.length, 2, "重放不追加候选：重试次数只由候选列表导出");
    assert.equal(frameOf(rebuilt).candidates.filter((candidate) => candidate.autoRetry).length, 1);
});

test("自动重试：canceled 不触发重试，取消阶段不被重跑", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run } = await toProjectKeyframe(env, TEST_PROJECT);

    const result = pipeline.cancelStage(run.id, "keyframe");
    assert.equal(result.canceled, 1);
    const frame = pipeline.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.candidates.length, 1, "取消不追加重试候选");
    assert.equal(frame.candidates.at(-1).status, "canceled");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "canceled");
    assert.equal(jobs.list().length, 1, "取消后没有多出重试任务");
});

// ——— 半自动三：01 设定建议回填项目 plan ———

test("planSuggestion 回填：只填空字段、不覆盖用户已填、ratio/styleAnchor 不碰、重复投递幂等", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-plan-suggestion-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });

    const projects = createProjects({ dataDir: projectsRoot });
    // genre 用户已填、ratio 有值（不在建议范围）；其余保持 PLAN_DEFAULTS（未填写）
    const project = projects.create({ title: "甲", styleAnchor: "冷调", plan: { genre: "都市", ratio: "9:16" } });
    const suggestion = { genre: "悬疑", tone: "冷硬", visualStyle: "写实真人", dramaMode: "微电影向", audience: "年轻女性", episodeCount: 24, episodeDurationSec: 90 };
    const scriptReply = { ...SCRIPT, planSuggestion: suggestion };

    const { pipeline } = build(env, {
        llm: fakeLlm(() => scriptReply),
        jobs: fakeJobQueue(),
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
    });
    const before = projects.get(project.id);
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });

    await pipeline.runStage(run.id, "script");
    const after = projects.get(project.id);
    assert.equal(after.plan.genre, "都市", "用户已填 genre 一律不动");
    assert.equal(after.plan.tone, "冷硬", "空 tone 被回填");
    assert.equal(after.plan.visualStyle, "写实真人");
    assert.equal(after.plan.dramaMode, "微电影向");
    assert.equal(after.plan.audience, "年轻女性");
    assert.equal(after.plan.episodeCount, 24);
    assert.equal(after.plan.episodeDurationSec, 90);
    assert.equal(after.plan.ratio, "9:16", "ratio 不在建议范围，不碰");
    assert.equal(after.styleAnchor, "冷调", "styleAnchor 不在建议范围，不碰");
    assert.equal(after.version, before.version + 1, "回填走 update：原子写 + version 自增一次");

    // 幂等：rebuild 后重放同一剧本阶段（同 suggestion），不再写盘、version 不变
    const rebuilt = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: fakeJobQueue(),
        comfy: {},
        llm: fakeLlm(() => scriptReply),
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
    });
    await rebuilt.runStage(run.id, "script");
    assert.equal(projects.get(project.id).version, after.version, "重复投递/重启重放不反复覆盖");
});

test("planSuggestion：未注入 applyPlanSuggestion 时不回填（保持旧行为）", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-plan-nohook-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const project = projects.create({ title: "乙" });
    const { pipeline } = build(env, {
        llm: fakeLlm(() => ({ ...SCRIPT, planSuggestion: { tone: "冷硬" } })),
        jobs: fakeJobQueue(),
        getProject: (id) => projects.get(id),
        // 故意不注入 applyPlanSuggestion
    });
    const before = projects.get(project.id);
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    const after = projects.get(project.id);
    assert.equal(after.plan.tone, "", "未接线时不回填");
    assert.equal(after.version, before.version, "未接线时不写盘");
});




// ——— 半自动四：生成型阶段产物自动登记为项目 AssetRef ———

/** 假项目：getProject 返回同一对象，假 registerAssetRef 把引用写回 project.assetRefs，供幂等去重命中。 */
function fakeProject(overrides = {}) {
    return { id: "prj_assets", styleAnchor: "", plan: {}, assetRefs: [], ...overrides };
}

/** 假资产登记：形状对齐 assets.create 的产物，记录调用并把引用写回项目（不跑真存储）。 */
function fakeAssetRefStore(project) {
    const calls = [];
    return {
        calls,
        register(projectId, input) {
            calls.push({ projectId, input });
            const ref = {
                id: `as_fake_${calls.length}`,
                projectId,
                role: input.role,
                bindingId: input.bindingId,
                artifactIds: input.artifactIds ?? [],
                selectedArtifactId: input.selectedArtifactId ?? null,
                metadata: input.metadata ?? {},
            };
            project.assetRefs = [...(project.assetRefs || []), ref];
            return ref;
        },
    };
}

/** 项目化跑到 keyframe，注入假项目 + 假登记。返回可控任务源与登记记录。 */
async function toKeyframeWithAssets(env, { registerAssetRef } = {}) {
    const project = fakeProject();
    const store = fakeAssetRefStore(project);
    const jobs = fakeJobQueue();
    const { pipeline } = build(env, {
        llm: fakeLlm(stageReply),
        jobs,
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === project.id ? project : null),
        registerAssetRef: registerAssetRef ?? store.register,
    });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    return { pipeline, jobs, run, project, store, startJob: jobs.get(`${run.id}-sh1-start`) };
}

test("产物自动登记：生成型阶段产物回写后自动产生项目 AssetRef（role=keyframe）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, project, store, startJob } = await toKeyframeWithAssets(env);

    // 只规划还没产物 → 不登记
    assert.equal(store.calls.length, 0);
    assert.deepEqual(project.assetRefs, []);

    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s1.png", type: "image" }] });
    assert.equal(project.assetRefs.length, 1, "start 帧产物入账即自动登记一条引用");
    const ref = project.assetRefs[0];
    assert.equal(ref.role, "keyframe");
    assert.equal(ref.bindingId, "sh1-start");
    assert.deepEqual(ref.artifactIds, ["/api/artifacts/job/s1.png"]);
    assert.equal(ref.selectedArtifactId, "/api/artifacts/job/s1.png");
    assert.equal(ref.metadata.source, "pipeline");
    assert.equal(ref.metadata.runId, run.id);
    assert.equal(ref.metadata.stageId, "keyframe");
    assert.equal(ref.metadata.jobId, startJob.id);
    assert.equal(ref.metadata.artifactUrl, "/api/artifacts/job/s1.png");

    // end 帧完成 → 追加第二条（同镜不同条目，bindingId 取条目 id）
    jobs.finish(jobs.get(`${run.id}-sh1-end`).id, "done", { outputs: [{ url: "/api/artifacts/job/e1.png", type: "image" }] });
    assert.deepEqual(project.assetRefs.map((item) => [item.role, item.bindingId]), [["keyframe", "sh1-start"], ["keyframe", "sh1-end"]]);
});

test("产物自动登记幂等：同一产物重复回写 / 重启重放只登记一次", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, run, project, store, startJob } = await toKeyframeWithAssets(env);

    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s1.png", type: "image" }] });
    assert.equal(store.calls.length, 1);

    // 同一终态任务重复投递两次：命中去重，不再登记
    pipeline.projectJob(jobs.get(startJob.id));
    pipeline.projectJob(jobs.get(startJob.id));
    assert.equal(store.calls.length, 1);
    assert.equal(project.assetRefs.length, 1);

    // 模拟进程重启：新实例 bindJobs 重放 jobs.list() 全部终态任务，读到的旧引用同样命中去重
    const rebuilt = build(env, {
        llm: fakeLlm(stageReply),
        jobs,
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === project.id ? project : null),
        registerAssetRef: store.register,
    }).pipeline;
    rebuilt.bindJobs();
    assert.equal(store.calls.length, 1, "重启重放不重复登记");
    assert.equal(project.assetRefs.length, 1);
});

test("未注入 registerAssetRef：不登记、stage.artifacts 形状逐字不变（旧行为）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const project = fakeProject();
    const jobs = fakeJobQueue();
    const { pipeline } = build(env, {
        llm: fakeLlm(stageReply),
        jobs,
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === project.id ? project : null),
        // 故意不注入 registerAssetRef
    });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    const startJob = jobs.get(`${run.id}-sh1-start`);
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s1.png", type: "image" }] });

    assert.deepEqual(pipeline.get(run.id).stages.keyframe.artifacts, [{ jobId: startJob.id, url: "/api/artifacts/job/s1.png" }]);
    assert.deepEqual(project.assetRefs, [], "未接线时不写项目");
});

test("未绑定项目：生成产物不登记资产、不报错（产物照常回写）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const project = fakeProject();
    const store = fakeAssetRefStore(project);
    const jobs = fakeJobQueue();
    const { pipeline } = build(env, {
        llm: fakeLlm(stageReply),
        jobs,
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === project.id ? project : null),
        registerAssetRef: store.register,
    });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇" }); // 无 options.projectId
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    const startJob = jobs.get(`${run.id}-sh1-start`);
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s1.png", type: "image" }] });

    assert.equal(store.calls.length, 0, "无项目不登记");
    assert.deepEqual(project.assetRefs, []);
    assert.equal(pipeline.get(run.id).stages.keyframe.artifacts.length, 1, "产物照常回写");
});

test("产物自动登记：assembly 片段与成片本体登记为 clip，manifest/log/cover 附属文件不登记", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const project = fakeProject();
    const store = fakeAssetRefStore(project);
    const assemble = async (args) => ({
        id: args.options.id,
        url: `/api/artifacts/${args.options.id}/final.mp4`,
        manifestUrl: `/api/artifacts/${args.options.id}/assembly-manifest.json`,
        logPath: "/tmp/fake-ffmpeg.log",
        coverUrl: `/api/artifacts/${args.options.id}/cover.jpg`,
        bytes: 10,
        info: { durationSec: 2 },
    });
    const { pipeline } = build(env, {
        llm: fakeLlm(stageReply),
        jobs: fakeJobQueue(),
        runJob: async () => ({ outputs: [] }),
        assemble,
        getProject: (id) => (id === project.id ? project : null),
        registerAssetRef: store.register,
    });
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    pipeline.setStageInput(run.id, "assembly", {
        output: { clips: [{ id: "sh1-clip", shotId: "sh1", artifactUrl: "/api/artifacts/job-clip/sh1-clip.mp4", durationSec: 2, status: "done" }], assembly: { order: ["sh1-clip"], transition: "cut", status: "queued" } },
    });

    const done = await pipeline.assembleStage(run.id);
    assert.equal(done.stages.assembly.artifacts.filter((item) => item.kind === "film").length, 4, "artifacts 仍登记 4 条成片附属（不改旧行为）");
    assert.deepEqual(project.assetRefs.map((item) => [item.role, item.bindingId]), [["clip", "sh1-clip"], ["clip", `assembly-${run.id}`]]);
});

test("登记失败只告警、不拖垮生成阶段", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const warns = [];
    const boom = () => {
        throw new Error("资产存储炸了");
    };
    const { pipeline, jobs, run, startJob } = await toKeyframeWithAssets(env, { registerAssetRef: boom });

    const warn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
        jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/job/s1.png", type: "image" }] });
    } finally {
        console.warn = warn;
    }

    assert.equal(pipeline.get(run.id).stages.keyframe.output.frames[0].artifactUrl, "/api/artifacts/job/s1.png", "产物照常回写");
    assert.ok(warns.some((message) => message.includes("产物自动登记资产失败")), "登记失败要告警");
});

// ——— P0：styleAnchor 唯一事实源 + 胶片层条件叠加（Q1/G1） ———

const ANIM_PROJECT = {
    id: "prj_anim",
    styleAnchor: "二维动画，治愈系暖色调，柔光，圆润可爱的角色造型，干净线条",
    plan: { visualStyle: "二维动画", genre: "都市奇幻", tone: "治愈", ratio: "9:16", episodeDurationSec: 30, episodeCount: 2 },
};

/** 把 04-keyframes 技能模板改成引用 {{options.styleAnchor}}，用于验证 buildContext 的注入链路。 */
function useStyleAnchorSkill(env) {
    writeFileSync(
        join(env.skillsDir, "04-keyframes", "SKILL.md"),
        `---\nname: keyframes\ndescription: |\n  测试：风格锚点注入\n---\n\n# keyframes\n\n## 提示词模板\n\n你是关键帧提示词工程师。项目风格锚点：{{options.styleAnchor}}\n分镜：\n{{storyboard}}\n`,
    );
}

/** 取发给模型的关键帧提示词（含被替换后的占位符）。 */
function keyframePromptSent(llm) {
    const call = llm.calls.find((entry) => entry.messages.at(-1).content.includes("关键帧提示词工程师"));
    assert.ok(call, "关键帧阶段应调用过 LLM");
    return call.messages.at(-1).content;
}

test("styleAnchor 唯一事实源：buildContext 注入使 {{options.styleAnchor}} 被真替换，最终 PROMPT 首句 = 锚点原句", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    useStyleAnchorSkill(env);
    const { llm, startJob } = await toProjectKeyframe(env, ANIM_PROJECT);

    // ① 技能占位符被真替换：发给模型的关键帧提示词含锚点原句、不含字面占位符
    const sent = keyframePromptSent(llm);
    assert.ok(sent.includes(`项目风格锚点：${ANIM_PROJECT.styleAnchor}`), "注入的 styleAnchor 必须出现在技能提示词里");
    assert.ok(!sent.includes("{{options.styleAnchor}}"), "占位符必须被真替换，不能原样漏给模型");

    // 最终发给 ComfyUI 的 PROMPT 首句一字不差是锚点
    assert.equal(startJob.params.PROMPT.split("。")[0], ANIM_PROJECT.styleAnchor);
    assert.ok(startJob.params.PROMPT.includes(ANIM_PROJECT.styleAnchor));
});

test("胶片层条件叠加：二维动画锚点不出现胶片词，胶片写实锚点才追加 Luster 冻结层", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    useStyleAnchorSkill(env);

    // 二维动画锚点 → 胶片层默认关闭，全片 prompt 不得出现冲突介质词
    const anim = await toProjectKeyframe(env, ANIM_PROJECT);
    assert.doesNotMatch(anim.startJob.params.PROMPT, /film|Kodak|grain|tack-sharp|light leak|胶片/i, anim.startJob.params.PROMPT);

    // 胶片 / 写实锚点 → 命中关键词，追加 Luster 冻结层
    const filmProject = { id: "prj_film", styleAnchor: "35mm 胶片实拍，日系青春写实，生活流", plan: { visualStyle: "胶片写实", ratio: "16:9", episodeDurationSec: 6 } };
    const film = await toProjectKeyframe(env, filmProject);
    assert.ok(film.startJob.params.PROMPT.startsWith("35mm 胶片实拍"), film.startJob.params.PROMPT);
    assert.match(film.startJob.params.PROMPT, /fine grain|light leak|tack-sharp/i, "命中胶片锚点才叠加 Luster 层");
});

test("无项目锚点：buildContext 注入中性兜底锚点（不静默、不回落胶片默认锚点）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    useStyleAnchorSkill(env);
    const jobs = fakeJobQueue();
    const llm = fakeLlm(stageReply);
    const { pipeline } = build(env, { llm, jobs, runJob: async () => ({ outputs: [] }) }); // 不注入 getProject
    pipeline.bindJobs();

    const run = pipeline.create({ novel: "很久以前", title: "短篇" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    const sent = keyframePromptSent(llm);
    const injected = /项目风格锚点：(.+)/.exec(sent)?.[1]?.trim();
    assert.ok(injected, "缺锚点时必须注入明确的中性锚点，不能留占位符（不静默）");
    assert.ok(!sent.includes("{{options.styleAnchor}}"), "占位符必须被替换");
    assert.doesNotMatch(injected, /film|Kodak|grain|35mm|胶片/i, "兜底锚点不得回落胶片默认锚点");

    // 未绑项目且无锚点：生成层不叠加任何风格层，最终 PROMPT 与旧行为逐字一致
    assert.equal(jobs.get(`${run.id}-sh1-start`).params.PROMPT, "少女走进老屋，中景");
});

test("首句锚点只由一层负责：模型已写锚点时最终 PROMPT 不重复前置（去掉两头写）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    useStyleAnchorSkill(env);
    const body = `${ANIM_PROJECT.styleAnchor}。一只橘白小猫走进老屋，中景`;
    const reply = (content) => {
        if (content.includes("关键帧提示词工程师")) {
            return { frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: body, template: null, jobId: null, artifactUrl: null, status: "queued" }] };
        }
        return stageReply(content);
    };
    const { startJob } = await toProjectKeyframe(env, ANIM_PROJECT, { reply });

    const prompt = startJob.params.PROMPT;
    assert.equal(prompt, body, "锚点已在首句时不再前置，也不追加胶片层");
    assert.equal(prompt.split(ANIM_PROJECT.styleAnchor).length - 1, 1, "锚点只能出现一次（两头写已消除）");
});

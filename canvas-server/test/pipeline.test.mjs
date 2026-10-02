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
    // 2 块 → 2 次 map + 1 次 reduce，且每次都带阶段绑定的模型
    assert.equal(llm.calls.length, 3);
    assert.deepEqual(llm.calls.map((call) => call.model), ["test-model", "test-model", "test-model"]);
    assert.match(llm.calls[0].messages.at(-1).content, /第 1\/2 块（来源：甲\.txt）/);
    assert.match(llm.calls[1].messages.at(-1).content, /第 2\/2 块（来源：乙\.txt）/);
    const reducePrompt = llm.calls[2].messages.at(-1).content;
    assert.match(reducePrompt, /合并成一份完整剧本/);
    assert.match(reducePrompt, /"name": "甲"/);
    assert.match(reducePrompt, /"name": "乙"/);
    // output 契约与单次调用完全一致，下游零感知
    assert.deepEqual(Object.keys(done.stages.script.output).sort(), ["characters", "logline", "scenes", "synopsis"]);
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
    assert.deepEqual(Object.keys(resumed.stages.script.output).sort(), ["characters", "logline", "scenes", "synopsis"]);
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
    assert.equal(llm.calls.length, 3);
    await pipeline.runStage(run.id, "script", { model: "test-model" });
    assert.equal(llm.calls.length, 6, "不带 resume 应完整重跑 3 次");
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
    assert.match(llm.calls[1].messages.at(-1).content, /"logline"/);

    const keyed = await pipeline.runStage(run.id, "keyframe");
    // 不再「入队即 done」：start 帧已入队，阶段停在 running 等任务终态。
    assert.equal(keyed.stages.keyframe.status, "running");
    assert.match(llm.calls[2].messages.at(-1).content, /"shots"/);
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

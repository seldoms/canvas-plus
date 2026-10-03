import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/**
 * 流水线「语言适配」接线回归（离线、假 llmCall，不真跑 DeepSeek / 模型）：
 *   ① 关键帧（image，Qwen-Image 2.1 仅英文有官方依据）注入可用 llmCall → 入队前 precompilePrompts
 *      英文化成功 → job.params.PROMPT 无 [untranslated]、含改写正文；片段（video / H3）结构照旧；
 *   ② llmCall 抛错 → 只降级不阻塞：同步结构照旧产出、PROMPT 不含排查标记、item.warning 记录，
 *      绝不假装已英文化，也绝不因 LLM 失败而放弃入队。
 * 用真实 workflows 目录（默认 imageTemplate=img_qwen21_t2i → 需锁角色时换 img_qwen21_edit；videoTemplate=video_h3_i2v）。
 */

const REAL_WORKFLOWS = fileURLToPath(new URL("../workflows/", import.meta.url));

const SCRIPT = {
    logline: "末班车",
    synopsis: "末班车上的相遇。",
    characters: [{ id: "c1", name: "林晚", profile: "乘客", appearance: "青年女性", voice: "轻细" }],
    scenes: [{ id: "sc1", title: "公交车内", location: "公交车内", time: "夜", intent: "相遇", beats: ["上车"] }],
};

const STORYBOARD = {
    shots: [
        {
            id: "sh1",
            sceneId: "sc1",
            index: 1,
            durationSec: 5,
            shotSize: "全景",
            cameraSpec: { movement: { type: "pan", direction: "right", speed: "slow", stabilization: "steady" } },
            action: "林晚从站台阴影中走出，上台阶，进入公交车，身体猛地一颤。段末可见状态：林晚站在前门内，双手抱纸箱。",
            dialogue: "姑娘，这么晚，去哪儿？",
            audio: "环境音：公交车发动机怠速、衣服摩擦声；本镜有对白。",
            textOverlays: [{ text: "末班车", kind: "screen", position: "前挡风玻璃上方", style: "红底黄字" }],
            prompt: "A young woman stepping onto a bus, medium shot, realistic.",
            negativePrompt: "lowres, extra fingers",
        },
    ],
    scenes: [{ id: "sc1", location: "公交车内" }],
};

const DESIGN = {
    characters: [{ id: "c1", name: "林晚", outfit: "米白薄外套", closeupPrompt: "锚点。solo front closeup of a young woman, no text", turnaroundPrompt: "锚点。front / side / back view, no text" }],
    locations: [{ id: "loc1", name: "公交车内", sceneMasterPrompt: "锚点。empty bus interior at night, no people, no text" }],
};

const FRAMES = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "林晚 站在车厢里回望", textOverlays: [] },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "林晚 低头", textOverlays: [] },
    ],
};

const CLIPS = {
    clips: [{ id: "sh1-clip", shotId: "sh1", keyframeId: "sh1-start", durationSec: 5 }],
    assembly: { order: [], transition: "dissolve" },
};

const SKILL_DEFS = {
    "01-script": ["novel-to-script", "测试剧本", "你是影视剧本改编，返回含 characters/scenes 的 JSON。小说：{{novel}}"],
    "02-storyboard": ["storyboard", "测试分镜", "你是分镜师，返回含 shots 数组的 JSON。剧本：{{script}}"],
    "03-costume-props": ["costume-props", "测试服化道", "你是服化道师，返回含 characters/locations 的 JSON。剧本：{{script}}"],
    "04-keyframes": ["keyframes", "测试关键帧", "你是关键帧提示词工程师，返回含 frames 数组的 JSON。分镜：{{storyboard}}"],
    "05-clip-assembly": ["clip-assembly", "测试片段", "你是片段合成师，返回含 clips 与 assembly 的 JSON。分镜：{{storyboard}} 关键帧：{{keyframes}}"],
};

function skillMarkdown(name, description, prompt) {
    return ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, "", "## 提示词模板", "", prompt, ""].join("\n");
}

function makeEnv(root) {
    const skillsDir = join(root, "skills");
    for (const [id, [name, description, prompt]] of Object.entries(SKILL_DEFS)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), skillMarkdown(name, description, prompt));
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "design", title: "服化道", skill: "03-costume-props", requires: ["script"], produces: "design" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design"], produces: "keyframes" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
            ],
        }),
    );
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    return {
        skillsDir,
        config: {
            dataDir,
            workflowsDir: REAL_WORKFLOWS,
            pipeline: { imageTemplate: "img_qwen21_t2i", referenceImageTemplate: "img_qwen21_edit", videoTemplate: "video_h3_i2v", imageWidth: 768, imageHeight: 1344, imageBatch: 1, videoSeconds: 5, videoFps: 24 },
        },
    };
}

function stageReply(content) {
    if (content.includes("片段合成师")) return CLIPS;
    if (content.includes("关键帧提示词工程师")) return FRAMES;
    if (content.includes("服化道师")) return DESIGN;
    if (content.includes("分镜师")) return STORYBOARD;
    return SCRIPT;
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

function fakeProject(ratio = "") {
    const project = { id: "prj_pc_wiring", styleAnchor: "写实电影感，暖色路灯与冷调夜色的对比，浅景深", plan: ratio ? { ratio } : {}, assetRefs: [] };
    const register = (projectId, input) => {
        const ref = { id: `as_${project.assetRefs.length + 1}`, projectId, role: input.role, bindingId: input.bindingId, artifactIds: input.artifactIds ?? [], selectedArtifactId: input.selectedArtifactId ?? null, metadata: input.metadata ?? {} };
        project.assetRefs = [...project.assetRefs, ref];
        return ref;
    };
    const update = (projectId, refId, patch = {}) => {
        const ref = project.assetRefs.find((item) => item.id === refId);
        if (!ref) throw new Error(`资产引用不存在：${refId}`);
        Object.assign(ref, patch);
        return ref;
    };
    return { project, register, update };
}

/** 跑到「关键帧入队」，注入给定 llmCall（语言适配出口）。 */
async function runToKeyframe(t, llmCall, { ratio = "" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "canvas-pc-pipeline-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject(ratio);
    const jobs = fakeJobQueue();
    const llm = {
        async chat(options) {
            const content = String(options.messages.at(-1)?.content ?? "");
            return { choices: [{ message: { content: JSON.stringify(stageReply(content)) } }] };
        },
    };
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm,
        llmCall,
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === project.project.id ? project.project : null),
        registerAssetRef: project.register,
        updateAssetRef: project.update,
    });
    pipeline.bindJobs();

    const run = pipeline.create({ novel: "末班车的约定", title: "短片", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "design");
    for (const job of jobs.list().filter((entry) => entry.meta?.stageId === "design")) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/${job.id}/${job.id}.png`, type: "image" }] });
    await pipeline.runStage(run.id, "keyframe");
    return { run, jobs, pipeline, startJob: jobs.get(`${run.id}-sh1-start`) };
}

test("语言适配生效：注入可用 llmCall → 关键帧 PROMPT 英文化、无 [untranslated]、不阻塞入队", async (t) => {
    const REWRITE = "A cinematic wide shot of Lin Wan in a cream jacket stepping out of the platform shadows onto a night bus, realistic lighting.";
    let calls = 0;
    const llmCall = async () => {
        calls += 1;
        return REWRITE;
    };
    const { startJob, run, pipeline } = await runToKeyframe(t, llmCall);

    assert.ok(startJob, "LLM 改写成功与否都不得阻塞入队");
    assert.ok(calls >= 1, "precompilePrompts 应调用注入的语言适配 llmCall");
    const prompt = startJob.params.PROMPT;
    assert.equal(typeof prompt, "string");
    assert.ok(!prompt.includes("[untranslated"), "英文化成功后不得带未升级标记");
    assert.ok(prompt.includes(REWRITE), "PROMPT 应包含改写器产出的英文正文");

    const start = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start");
    assert.ok(!/未英文化/.test(start.warning || ""), "成功路径不该带未英文化 warning");
});

test("降级不阻塞：llmCall 抛错 → 同步结构照旧产出 + warning，仍入队", async (t) => {
    const llmCall = async () => {
        throw Object.assign(new Error("LLM 服务不可达"), { code: "llm_unavailable" });
    };
    const { startJob, run, pipeline } = await runToKeyframe(t, llmCall);

    assert.ok(startJob, "LLM 失败绝不能阻塞入队");
    const prompt = startJob.params.PROMPT;
    assert.equal(typeof prompt, "string");
    assert.ok(!prompt.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.match(prompt, /<image1> 为角色参考（林晚）/, "同步结构（参考图槽位映射）照旧产出");

    const start = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start");
    assert.match(String(start.warning || ""), /未英文化/, "降级必须记一条 warning");
});


test("改写稿反写项目画幅 → 整稿弃用：PROMPT 无横屏断言，warning 同时留在条目与 job meta", async (t) => {
    const llmCall = async () => "The image is a horizontal realistic cinematic medium close-up of Lin Wan stepping onto a night bus.";
    const { startJob, run, pipeline } = await runToKeyframe(t, llmCall, { ratio: "9:16" });

    assert.ok(startJob, "画幅冲突只降级，绝不阻塞入队");
    const prompt = startJob.params.PROMPT;
    assert.doesNotMatch(prompt, /horizontal/i, "错误的画幅方向绝不能进 PROMPT");
    assert.ok(!prompt.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.match(prompt, /画幅：9:16（竖屏构图/, "回落到同步结构稿，画幅事实仍在");

    const start = pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start");
    assert.match(String(start.warning || ""), /提示词改写失败：改写稿把画幅写成/, "条目上要留下冲突原因");
    assert.match(String(startJob.meta?.promptWarning || ""), /提示词改写失败：改写稿把画幅写成/, "job meta 也要能看到，排查时不必翻 run item");
});

test("显式重跑重新编译并保留旧 Job 参数快照", async (t) => {
    const rewrites = [
        "FIRST REWRITE: Lin Wan steps onto the night bus.",
        "SECOND REWRITE: Lin Wan turns back beneath the station lights.",
    ];
    let calls = 0;
    const llmCall = async () => rewrites[Math.min(calls++, rewrites.length - 1)];
    const { startJob, run, jobs, pipeline } = await runToKeyframe(t, llmCall);
    const initialPrompt = startJob.params.PROMPT;
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/first.png" }] });
    const end = jobs.get(`${run.id}-sh1-end`);
    assert.ok(end, "start 完成后才入队 end 帧");
    jobs.finish(end.id, "done", { outputs: [{ url: "/api/artifacts/end.png" }] });
    const retry = await pipeline.executeRegenerate(pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" }));
    const retryJob = jobs.get(retry.jobId);
    assert.notEqual(retryJob.id, startJob.id);
    assert.notEqual(retryJob.params.PROMPT, initialPrompt, "重跑必须重新编译当前提示词");
    assert.equal(retryJob.params.PROMPT, rewrites.at(-1));
    assert.equal(jobs.get(startJob.id).params.PROMPT, initialPrompt, "旧 Job 参数不可变");
    assert.ok(pipeline.get(run.id).stages.keyframe.output.frames.find((frame) => frame.id === "sh1-start").promptCompilation);
});

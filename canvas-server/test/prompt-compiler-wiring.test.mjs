import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/**
 * 提示词编译器「接线」回归：证明 generativePlan 真的在「发起生成请求」那一刻调用编译器 ——
 *   · 关键帧（image）用 Qwen-Image 2.1 编译器产出中文 + <imageN> 引用；
 *   · 片段（video）用 H3 编译器产出官方三段式，素材说明按实际注入的槽位生成。
 * 用真实 workflows 目录（默认 imageTemplate=img_qwen21_t2i → 需锁角色时自动换 img_qwen21_edit；
 * videoTemplate=video_h3_i2v）；假 LLM / 假任务源，绝不真跑模型。
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
    const config = {
        dataDir,
        workflowsDir: REAL_WORKFLOWS,
        pipeline: { imageTemplate: "img_qwen21_t2i", referenceImageTemplate: "img_qwen21_edit", videoTemplate: "video_h3_i2v", imageWidth: 768, imageHeight: 1344, imageBatch: 1, videoSeconds: 5, videoFps: 24 },
    };
    return { skillsDir, config };
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

function fakeProject() {
    const project = { id: "prj_pc_wiring", styleAnchor: "写实电影感，暖色路灯与冷调夜色的对比，浅景深", plan: {}, assetRefs: [] };
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

async function runToAssembly(t) {
    const root = mkdtempSync(join(tmpdir(), "canvas-pc-wiring-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject();
    const jobs = fakeJobQueue();
    const llm = {
        calls: [],
        async chat(options) {
            this.calls.push(options);
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
    const startJob = jobs.get(`${run.id}-sh1-start`);
    jobs.finish(startJob.id, "done", { outputs: [{ url: "/api/artifacts/start.png", type: "image" }] });
    const endJob = jobs.get(`${run.id}-sh1-end`);
    jobs.finish(endJob.id, "done", { outputs: [{ url: "/api/artifacts/end.png", type: "image" }] });

    await pipeline.runStage(run.id, "assembly");
    return { run, jobs, startJob, pipeline };
}

test("接线：关键帧（image）PROMPT 由 Qwen-Image 2.1 编译器产出（中文 + <imageN> 引用）", async (t) => {
    const { startJob } = await runToAssembly(t);
    assert.equal(startJob.template, "img_qwen21_edit", "需锁角色 → 换参考图模板");
    const prompt = startJob.params.PROMPT;
    assert.equal(typeof prompt, "string", "PROMPT 仍是字符串");
    assert.match(prompt, /参考图对应关系：/, "按实际注入槽位生成 <imageN> 引用");
    assert.match(prompt, /<image1> 为参考底图（林晚）/, "INPUT_IMAGE → <image1>，带角色名");
    assert.match(prompt, /<image2> 为场景参考/, "REF_IMAGE_1 → <image2>（场景）");
    assert.match(prompt, /景别：全景/);
    assert.ok(!prompt.includes("【核心创意】"), "图片阶段不是 H3 三段式");
});

test("接线：片段（video）PROMPT 由 H3 编译器产出官方三段式，素材说明按实际注入槽位生成", async (t) => {
    const { jobs, pipeline, run } = await runToAssembly(t);
    const clip = pipeline.get(run.id).stages.assembly.output.clips.find((entry) => entry.id === "sh1-clip");
    assert.ok(clip && clip.jobId, "关键帧就绪 → 片段入队");
    const prompt = jobs.get(clip.jobId).params.PROMPT;
    assert.equal(typeof prompt, "string", "PROMPT 仍是字符串");

    assert.match(prompt, /【参考素材说明】/);
    assert.match(prompt, /@图片1 是首帧参考图：/, "片段实际只注入起始帧 → 素材说明只写 @图片1");
    assert.ok(!prompt.includes("@图片2"), "未注入尾帧/参考 → 不凭空编造 @图片2");
    assert.match(prompt, /【核心创意】/);
    assert.match(prompt, /【画面过程说明】/);
    assert.match(prompt, /运镜：pan right（缓速）/, "结构化运镜编译成具体词");
    assert.match(prompt, /台词（务必在本镜 5 秒内说完/, "台词/时长对齐提示");
    assert.ok(prompt.includes("姑娘，这么晚，去哪儿？"), "台词逐字保留");
    assert.match(prompt, /屏幕文字「末班车」/, "画面文字写原文");
    assert.match(prompt, /不想要（避免出现）：/);
    assert.ok(prompt.includes("lowres"), "负向词并入不想要");
});

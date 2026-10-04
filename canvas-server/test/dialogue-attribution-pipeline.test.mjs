import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/**
 * 台词归属「接线」回归：证明后端在**发起生成那一刻**由编译器按模型能力元数据编译，且归属解析的
 * warning 会随 plan 留痕（不阻塞）：
 *   · sh1 走**旧字符串 dialogue**（向后兼容）→ 多角色镜头里归属无法确定 → speaker_ambiguous warning；
 *   · sh2 走**结构化 dialogueLines**（新契约，显式说话人）→ 每句归属到正确的人、无归属 warning。
 * 用真实 workflows 目录（video_h3_i2v）；假 LLM / 假任务源，绝不真跑模型。
 */

const REAL_WORKFLOWS = fileURLToPath(new URL("../workflows/", import.meta.url));

const SCRIPT = {
    logline: "灯塔",
    synopsis: "夜航相遇。",
    characters: [
        { id: "c1", name: "阿海", profile: "渡轮老船长", appearance: "约60岁男性", voice: "音色低沉沙哑，语速慢" },
        { id: "c2", name: "小满", profile: "守塔人之女", appearance: "20多岁女性", voice: "音色清亮但略带颤抖，带哭腔" },
    ],
    scenes: [{ id: "sc1", title: "夜航对话", location: "渡轮驾驶室", time: "夜", intent: "对话", beats: ["阿海问话", "小满应答"] }],
};

const STORYBOARD = {
    shots: [
        {
            id: "sh1",
            sceneId: "sc1",
            index: 1,
            durationSec: 5,
            shotSize: "中景",
            cameraSpec: { movement: { type: "static", direction: "none", speed: "slow", stabilization: "steady" } },
            action: "阿海向小满开口问话，小满低声应答。段末可见状态：两人对视。",
            // 旧字符串（向后兼容）：多角色镜头里无法确定归属 → 应回落并记 warning。
            dialogue: "姑娘，这么晚，去哪儿？（低沉、语速慢） 去对岸。（轻声）",
            audio: "环境音：船体低频震动；本镜有对白。",
            textOverlays: [{ text: "", kind: "none", position: "", style: "" }],
            prompt: "captain and girl talking on a ferry, medium shot, realistic.",
            negativePrompt: "lowres",
        },
        {
            id: "sh2",
            sceneId: "sc1",
            index: 2,
            durationSec: 5,
            shotSize: "近景",
            cameraSpec: { movement: { type: "static", direction: "none", speed: "slow", stabilization: "steady" } },
            action: "小满哭着说话，阿海交付钥匙。段末可见状态：钥匙在手。",
            // 新契约：逐条带说话人。
            dialogueLines: [
                { speaker: "小满", text: "我爸是守这座灯塔的。" },
                { speaker: "阿海", text: "我知道。" },
            ],
            audio: "环境音：海风；本镜有对白。",
            textOverlays: [{ text: "", kind: "none", position: "", style: "" }],
            prompt: "girl crying near a lighthouse, close shot, realistic.",
            negativePrompt: "lowres",
        },
    ],
    scenes: [{ id: "sc1", location: "渡轮驾驶室" }],
};

const DESIGN = {
    characters: [
        { id: "c1", name: "阿海", outfit: "深蓝色旧外套", closeupPrompt: "锚点。solo front closeup of an old captain, no text", turnaroundPrompt: "锚点。front / side / back view, no text" },
        { id: "c2", name: "小满", outfit: "深灰长款风衣", closeupPrompt: "锚点。solo front closeup of a young woman, no text", turnaroundPrompt: "锚点。front / side / back view, no text" },
    ],
    locations: [{ id: "loc1", name: "渡轮驾驶室", sceneMasterPrompt: "锚点。empty ferry wheelhouse at night, no people, no text" }],
};

const FRAMES = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "船长与小满在驾驶室", textOverlays: [] },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "两人对视", textOverlays: [] },
        { id: "sh2-start", shotId: "sh2", role: "start", prompt: "小满在灯塔下", textOverlays: [] },
        { id: "sh2-end", shotId: "sh2", role: "end", prompt: "钥匙递出", textOverlays: [] },
    ],
};

const CLIPS = {
    clips: [
        { id: "sh1-clip", shotId: "sh1", keyframeId: "sh1-start", durationSec: 5 },
        { id: "sh2-clip", shotId: "sh2", keyframeId: "sh2-start", durationSec: 5 },
    ],
    assembly: { order: [], transition: "cut" },
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
            Object.assign(job, { ...patch, status, finishedAt: new Date().toISOString() });
            emit(job);
            return job;
        },
    };
}

function fakeProject() {
    const project = { id: "prj_dialogue", styleAnchor: "写实电影感", plan: {}, assetRefs: [] };
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
    const root = mkdtempSync(join(tmpdir(), "canvas-dialogue-pipe-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject();
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
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === project.project.id ? project.project : null),
        registerAssetRef: project.register,
        updateAssetRef: project.update,
    });
    pipeline.bindJobs();

    const run = pipeline.create({ novel: "夜色下的渡轮。", title: "灯塔", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "design");
    for (const job of jobs.list().filter((entry) => entry.meta?.stageId === "design")) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/${job.id}.png`, type: "image" }] });

    await pipeline.runStage(run.id, "keyframe");
    // 关键帧：先完成的 start 才让 end 入队 → 多趟推进直到没有非终态任务。
    for (let pass = 0; pass < 6; pass += 1) {
        const pending = jobs.list().filter((entry) => entry.meta?.stageId === "keyframe" && !["done", "error", "canceled"].includes(entry.status));
        if (!pending.length) break;
        for (const job of pending) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/${job.id}.png`, type: "image" }] });
    }

    await pipeline.runStage(run.id, "assembly");
    return { run, jobs, pipeline };
}

test("接线：结构化台词逐条归属到正确的人、编号稳定 (S1)(S2)、<d> 内逐字正文", async (t) => {
    const { run, jobs, pipeline } = await runToAssembly(t);
    const clip = pipeline.get(run.id).stages.assembly.output.clips.find((entry) => entry.id === "sh2-clip");
    assert.ok(clip && clip.jobId, "关键帧就绪 → 片段入队");
    const job = jobs.get(clip.jobId);
    const prompt = job.params.PROMPT;
    assert.ok(prompt.includes("小满 (S2) says: <d>[English] 我爸是守这座灯塔的。</d>"), prompt);
    assert.ok(prompt.includes("阿海 (S1) says: <d>[English] 我知道。</d>"), prompt);
    assert.ok(!job.meta.promptWarning?.includes("无法确定"), "显式说话人 → 无归属 warning");
});

test("接线：旧字符串 dialogue 多角色镜头 → 归属回落 + plan warning 留痕（不阻塞）", async (t) => {
    const { run, jobs, pipeline } = await runToAssembly(t);
    const clip = pipeline.get(run.id).stages.assembly.output.clips.find((entry) => entry.id === "sh1-clip");
    const job = jobs.get(clip.jobId);
    assert.ok(/\b(S1)\b|\(S1\)/.test(job.params.PROMPT), job.params.PROMPT);
    assert.match(job.params.PROMPT, /阿海 \(S1\) says: <d>\[English\] 姑娘，这么晚，去哪儿？ 去对岸。<\/d>/, job.params.PROMPT);
    assert.match(job.meta.promptWarning || "", /无法确定/, `旧字符串多角色归属应记 warning：${job.meta.promptWarning}`);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPipeline } from "../src/pipeline.js";

/**
 * 关键帧参考链两处缺口的回归（真实数据 run-murvf1vq-aqyqm 现场复现）：
 *   ① img_qwen21_edit 的 INPUT_IMAGE 是必填槽，而 start 帧没有前一帧可作底图 → 42 个作业全被
 *      generate.js 参数校验拒掉。修法：start 帧从本镜解析出的参考图里取第一张充当 INPUT_IMAGE，
 *      其余顺序填 REF_IMAGE_*；已用作 INPUT_IMAGE 的那张不重复占 REF 槽；连参考图都没有 → blocked。
 *   ② 分镜产物常常只含 shots（无 scenes），shot 只有 sceneId、没有 locationId → reference-lock
 *      的 collectScenes 拿不到任何 scene，locationId 永远推不出来 → 场景母版进不了 REF_IMAGE。
 *      修法：分镜缺 scenes 时回落剧本阶段 scenes（其 location 名称可映射到 design.locations 锚点）。
 * 全用假 LLM / 假任务源，绝不真跑模型。
 */

const REAL_WORKFLOWS = fileURLToPath(new URL("../workflows/", import.meta.url));

// 剧本产物带 scenes（含 location 名称），这正是分镜产物缺失、却需要用来推 locationId 的那一层。
const SCRIPT = {
    logline: "末班车",
    synopsis: "夜班公交上的相遇。",
    characters: [
        { id: "c1", name: "林晚", profile: "乘客", appearance: "青年女性", voice: "轻细" },
        { id: "c2", name: "老周", profile: "司机", appearance: "中年男性", voice: "低沉" },
    ],
    scenes: [{ id: "sc1", title: "末班车上的相遇", location: "公交车内", time: "夜", intent: "悬念", beats: ["上车"] }],
};

// 关键点：分镜**只有 shots、没有 scenes**（与 run-murvf1vq-aqyqm 实测一致），shot 只有 sceneId。
const STORYBOARD = {
    shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", action: "林晚 望向 老周", dialogue: "", audio: "", prompt: "林晚 与 老周 在车厢里对视", negativePrompt: "" }],
};

const DESIGN = {
    characters: [
        { id: "c1", name: "林晚", outfit: "米白薄外套", closeupPrompt: "锚点。solo front closeup of a young woman, no text", turnaroundPrompt: "锚点。front / side / back view of the same young woman, no text" },
        { id: "c2", name: "老周", outfit: "司机制服", closeupPrompt: "锚点。solo front closeup of a middle-aged driver, no text", turnaroundPrompt: "锚点。front / side / back view of the same driver, no text" },
    ],
    locations: [{ id: "loc1", name: "公交车内", lighting: "顶灯 3200K", sceneMasterPrompt: "锚点。empty bus interior at night, fixed overhead light, no people, no text" }],
};

const FRAMES = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "林晚 站在车厢里回望", textOverlays: [] },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "林晚 低头", textOverlays: [] },
    ],
};

function makeEnv(root, { imageTemplate = "img_qwen21_t2i", referenceImageTemplate = "img_qwen21_edit" } = {}) {
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "测试剧本", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes 的 JSON。\n小说原文：\n{{novel}}"],
        "02-storyboard": ["storyboard", "测试分镜", "你是分镜师，返回含 shots 数组的 JSON。\n剧本：\n{{script}}"],
        "03-costume-props": ["costume-props", "测试服化道", "你是服化道师，返回含 characters/locations 的 JSON。\n剧本：\n{{script}}"],
        "04-keyframes": ["keyframes", "测试关键帧", "你是关键帧提示词工程师，返回含 frames 数组的 JSON。\n分镜：\n{{storyboard}}"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}\n`);
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
            ],
        }),
    );
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const config = {
        dataDir,
        workflowsDir: REAL_WORKFLOWS,
        pipeline: { imageTemplate, referenceImageTemplate, videoTemplate: "video_h3_i2v", imageWidth: 768, imageHeight: 1344, imageBatch: 1, videoSeconds: 5, videoFps: 24 },
    };
    return { skillsDir, config };
}

function fakeJobQueue() {
    const store = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        store,
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

function fakeLlm() {
    const calls = [];
    return {
        calls,
        async chat(options) {
            calls.push(options);
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("服化道师") ? DESIGN : content.includes("分镜师") ? STORYBOARD : content.includes("关键帧提示词工程师") ? FRAMES : SCRIPT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function fakeProject(id = "prj_ref_chain") {
    const project = { id, styleAnchor: "", plan: {}, assetRefs: [] };
    const calls = [];
    const register = (projectId, input) => {
        calls.push({ op: "create", projectId, input });
        const ref = { id: `as_${calls.length}`, projectId, role: input.role, bindingId: input.bindingId, artifactIds: input.artifactIds ?? [], selectedArtifactId: input.selectedArtifactId ?? null, metadata: input.metadata ?? {} };
        project.assetRefs = [...project.assetRefs, ref];
        return ref;
    };
    const update = (projectId, refId, patch = {}) => {
        calls.push({ op: "update", projectId, refId, input: patch });
        const ref = project.assetRefs.find((item) => item.id === refId);
        if (!ref) throw new Error(`资产引用不存在：${refId}`);
        Object.assign(ref, patch);
        return ref;
    };
    return { project, calls, register, update };
}

function build(env, { jobs, llm, getProject, registerAssetRef, updateAssetRef }) {
    return createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs, comfy: {}, llm, runJob: async () => ({ outputs: [] }), getProject, registerAssetRef, updateAssetRef });
}

/** 跑到 design 参考图全部终态（已绑定 AssetRef）。 */
async function runToDesignBound(root) {
    const env = makeEnv(root);
    const project = fakeProject();
    const jobs = fakeJobQueue();
    const pipeline = build(env, { jobs, llm: fakeLlm(), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register, updateAssetRef: project.update });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车的约定", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "design");
    for (const job of jobs.list().filter((job) => job.meta?.stageId === "design")) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/${job.id}/${job.id}.png`, type: "image" }] });
    return { env, project, jobs, pipeline, run };
}

// ——— ①+② 合并回归：分镜无 scenes → 场景母版仍进 REF；start 回退取 INPUT_IMAGE 且不重复占槽 ———

test("①+② start 帧无前一帧：INPUT_IMAGE=参考图第一张（角色），场景母版进 REF_IMAGE，且不重复占槽", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-refchain-start-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { project, jobs, pipeline, run } = await runToDesignBound(root);

    // 断言现场：分镜产物确实没有 scenes（否则本用例复现不了 #42 的断链）。
    assert.equal(pipeline.get(run.id).stages.storyboard.output.scenes, undefined, "分镜产物无 scenes（复现真实现场）");
    // 场景 AssetRef 确已绑定（不是绑定问题，而是 shot→locationId 推导没命中）。
    const loc1 = project.project.assetRefs.find((ref) => ref.role === "scene" && ref.bindingId === "loc1");
    assert.ok(loc1?.selectedArtifactId, "场景 loc1 母版已绑定 selectedArtifactId（区别于「未生成」）");

    await pipeline.runStage(run.id, "keyframe");
    const startJob = jobs.get(`${run.id}-sh1-start`);
    assert.ok(startJob, "start 帧已入队（不再因缺少 INPUT_IMAGE 被拒）");
    assert.equal(startJob.template, "img_qwen21_edit");

    const c1 = `/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`;
    const c2 = `/api/artifacts/${run.id}-c2-closeup/${run.id}-c2-closeup.png`;
    const loc = `/api/artifacts/${run.id}-loc1-master/${run.id}-loc1-master.png`;

    // start 无前一帧 → 参考图第一张（角色 c1 正脸特写）当 INPUT_IMAGE；其余顺序进 REF_IMAGE_*。
    assert.equal(startJob.params.INPUT_IMAGE, c1, "INPUT_IMAGE = 角色 c1 正脸特写（回退取参考图第一张）");
    assert.equal(startJob.params.REF_IMAGE_1, c2, "REF_IMAGE_1 = 角色 c2 正脸特写");
    assert.equal(startJob.params.REF_IMAGE_2, loc, "REF_IMAGE_2 = 场景 loc1 空场母版（分镜无 scenes 也能进 REF）");
    assert.equal(startJob.params.REF_IMAGE_3, undefined);
    // 不重复占槽：用作 INPUT_IMAGE 的那张绝不出现在 REF_IMAGE_* 里。
    const refValues = [startJob.params.REF_IMAGE_1, startJob.params.REF_IMAGE_2];
    assert.ok(!refValues.includes(startJob.params.INPUT_IMAGE), "用作 INPUT_IMAGE 的图不重复占 REF_IMAGE 槽");
    assert.equal(new Set([startJob.params.INPUT_IMAGE, ...refValues]).size, 3, "INPUT_IMAGE 与 REF_IMAGE_* 三张图各不同");
    assert.ok(Number.isInteger(startJob.params.SEED), "稳定 SEED 已注入");
});

test("② end 帧维持原逻辑：INPUT_IMAGE=本镜 start 产物，参考图全量进 REF_IMAGE_*（不回退、不丢场景）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-refchain-end-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { jobs, pipeline, run } = await runToDesignBound(root);
    await pipeline.runStage(run.id, "keyframe");

    const startUrl = `/api/artifacts/${run.id}-sh1-start/start.png`;
    jobs.finish(`${run.id}-sh1-start`, "done", { outputs: [{ url: startUrl }] });

    const endJob = jobs.get(`${run.id}-sh1-end`);
    assert.ok(endJob, "start 就绪后 end 入队");
    assert.equal(endJob.params.INPUT_IMAGE, startUrl, "end 用本镜 start 产物当底图（不是参考图回退）");
    assert.equal(endJob.params.REF_IMAGE_1, `/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`, "end 的参考图全量保留（含角色）");
    assert.equal(endJob.params.REF_IMAGE_2, `/api/artifacts/${run.id}-c2-closeup/${run.id}-c2-closeup.png`);
    assert.equal(endJob.params.REF_IMAGE_3, `/api/artifacts/${run.id}-loc1-master/${run.id}-loc1-master.png`, "end 场景母版也在 REF 序列");
    assert.notEqual(endJob.params.INPUT_IMAGE, endJob.params.REF_IMAGE_1, "end 的 INPUT_IMAGE 与 REF 槽不同源");
});

test("① 模板要求 INPUT_IMAGE 但无图可回退（参考图只到候选、未选定）→ 显式 blocked、不入队、原因可读", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-refchain-blocked-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject("prj_ref_chain_blocked");
    const jobs = fakeJobQueue();
    const pipeline = build(env, { jobs, llm: fakeLlm(), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register, updateAssetRef: project.update });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    // 单角色镜头：只提 c1，避免 c2 因无引用走另一条 no-ref blocked 分支，精准命中「INPUT_IMAGE 无图可回退」。
    pipeline.setStageInput(run.id, "storyboard", { output: { shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 4, action: "林晚 望向窗外", dialogue: "", audio: "", prompt: "林晚 独自站在车厢里", negativePrompt: "" }] } });
    // design 只声明、不入队（references 空），引用由人工预置：有候选 artifact 但未选定 → 只会 warning 不会 blocked。
    pipeline.setStageInput(run.id, "design", { output: { ...DESIGN, references: [] } });
    project.project.assetRefs = [
        { id: "as_c1", role: "character", bindingId: "c1", artifactIds: ["/api/artifacts/seed/c1.png"], selectedArtifactId: null, metadata: {} },
        { id: "as_loc1", role: "scene", bindingId: "loc1", artifactIds: ["/api/artifacts/seed/loc1.png"], selectedArtifactId: null, metadata: {} },
    ];

    const keyed = await pipeline.runStage(run.id, "keyframe");
    const frame = keyed.stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.status, "blocked", "模板要求底图却无图可回退 → blocked（不静默失败、不假装锁角色）");
    assert.match(frame.blockedReason, /INPUT_IMAGE/, frame.blockedReason);
    assert.match(frame.blockedReason, /img_qwen21_edit/, frame.blockedReason);
    assert.equal(jobs.get(`${run.id}-sh1-start`), null, "blocked 的帧不得入队");
});

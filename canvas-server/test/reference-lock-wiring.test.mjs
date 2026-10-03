import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPipeline } from "../src/pipeline.js";
import { stableSeed } from "../src/reference-lock.js";

/**
 * reference-lock / tool-adapter 接线回归（§11.5.4 / §12 第 2、3 优先级）：
 *   ① design 真正产出并绑定角色三视图/特写 + 场景母版参考图（幂等）
 *   ② 关键帧按 ShotBinding 注入 REF_IMAGE_* + 稳定 SEED；参考图能力不足 / 参考图缺失 → 显式 blocked
 *   ③ textOverlays 逐字拼进 PROMPT（修 #39）
 *   ④ 产物索引 URL 写入即指向真实文件（修 #40）
 * 全用假 LLM / 假任务源，绝不真跑模型。
 */

const REAL_WORKFLOWS = fileURLToPath(new URL("../workflows/", import.meta.url));

const SCRIPT = {
    logline: "末班车",
    synopsis: "夜班公交上的相遇。",
    characters: [
        { id: "c1", name: "林晚", profile: "乘客", appearance: "青年女性", voice: "轻细" },
        { id: "c2", name: "老周", profile: "司机", appearance: "中年男性", voice: "低沉" },
    ],
    scenes: [{ id: "sc1", title: "末班车上的女孩", location: "公交车内", time: "夜", intent: "悬念", beats: ["上车"] }],
};

const STORYBOARD = {
    shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 4, prompt: "林晚 站在车厢里回望", action: "回望", dialogue: "", audio: "" }],
    scenes: [{ id: "sc1", location: "公交车内" }],
};

const DESIGN = {
    characters: [
        { id: "c1", name: "林晚", outfit: "米白薄外套", closeupPrompt: "锚点。solo front closeup of a young woman, clean plain background, no text", turnaroundPrompt: "锚点。front / side / back view of the same young woman, no text" },
        { id: "c2", name: "老周", outfit: "司机制服", closeupPrompt: "锚点。solo front closeup of a middle-aged driver, no text", turnaroundPrompt: "锚点。front / side / back view of the same driver, no text" },
    ],
    locations: [{ id: "loc1", name: "公交车内", lighting: "顶灯 3200K 自上而下", sceneMasterPrompt: "锚点。empty bus interior at night, fixed overhead light, no people, no text" }],
};

const FRAMES = {
    frames: [
        {
            id: "sh1-start",
            shotId: "sh1",
            role: "start",
            prompt: "林晚 站在车厢里回望",
            textOverlays: [
                { text: "老城南路公交站", kind: "sign", position: "upper left", style: "bold sans" },
                { text: "3路", kind: "screen", position: "center", style: "led" },
                { text: "3路 末班车", kind: "ticket", position: "lower right", style: "print" },
            ],
        },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "林晚 低头哭泣", textOverlays: [{ text: "", kind: "none", position: "", style: "" }] },
    ],
};

function makeEnv(root, { workflowsDir = REAL_WORKFLOWS, imageTemplate = "img_qwen21_t2i", referenceImageTemplate = "img_qwen21_edit" } = {}) {
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
        workflowsDir,
        pipeline: { imageTemplate, referenceImageTemplate, videoTemplate: "video_h3_i2v", imageWidth: 768, imageHeight: 1344, imageBatch: 1, videoSeconds: 5, videoFps: 24 },
    };
    return { skillsDir, config };
}

/** 可控任务源：finish 手动推终态，驱动 Job→流水线回写投影。 */
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

function fakeLlm({ frames = FRAMES } = {}) {
    const calls = [];
    return {
        calls,
        async chat(options) {
            calls.push(options);
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("服化道师") ? DESIGN : content.includes("分镜师") ? STORYBOARD : content.includes("关键帧提示词工程师") ? frames : SCRIPT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

/** 假项目存储：引用写回同一对象，形状对齐 assets.create / assets.update 的产物。 */
function fakeProject(id = "prj_ref_lock") {
    const project = { id, styleAnchor: "", plan: {}, assetRefs: [] };
    const calls = [];
    const register = (projectId, input) => {
        calls.push({ op: "create", projectId, input });
        const ref = {
            id: `as_${calls.length}`,
            projectId,
            role: input.role,
            bindingId: input.bindingId,
            artifactIds: input.artifactIds ?? [],
            selectedArtifactId: input.selectedArtifactId ?? null,
            metadata: input.metadata ?? {},
        };
        project.assetRefs = [...project.assetRefs, ref];
        return ref;
    };
    // 对齐 assets.update：按 refId 就地改字段（含 role/artifactIds/selectedArtifactId/metadata），不新增引用。
    const update = (projectId, refId, patch = {}) => {
        calls.push({ op: "update", projectId, refId, input: patch });
        const ref = project.assetRefs.find((item) => item.id === refId);
        if (!ref) throw new Error(`资产引用不存在：${refId}`);
        Object.assign(ref, patch);
        if (ref.selectedArtifactId && !ref.artifactIds.includes(ref.selectedArtifactId)) throw new Error(`selectedArtifactId 不在 artifactIds 内：${ref.selectedArtifactId}`);
        return ref;
    };
    return { project, calls, register, update };
}

/** 人工预置角色/场景参考图引用（模拟「参考图已生成并选定」）。 */
function seedRefs(project, runId) {
    project.project.assetRefs = [
        { id: "seed_c1", role: "character", bindingId: "c1", artifactIds: ["/api/artifacts/seed/c1-closeup.png"], selectedArtifactId: "/api/artifacts/seed/c1-closeup.png", metadata: { runId, stageId: "design" } },
        { id: "seed_loc1", role: "scene", bindingId: "loc1", artifactIds: ["/api/artifacts/seed/loc1-master.png"], selectedArtifactId: "/api/artifacts/seed/loc1-master.png", metadata: { runId, stageId: "design" } },
    ];
}

function build(env, { jobs, llm, getProject, registerAssetRef, updateAssetRef }) {
    return createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm,
        runJob: async () => ({ outputs: [] }),
        getProject,
        registerAssetRef,
        updateAssetRef,
    });
}

/** 跑到 design 参考图全部终态（已绑定 AssetRef）。 */
async function runToDesignBound(root, opts = {}) {
    const env = makeEnv(root, opts);
    const project = fakeProject();
    const jobs = fakeJobQueue();
    const llm = fakeLlm(opts);
    const pipeline = build(env, { jobs, llm, getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register, updateAssetRef: project.update });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车的约定", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "design");
    const refJobs = jobs.list().filter((job) => job.meta?.stageId === "design");
    for (const job of refJobs) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/${job.id}/${job.id}.png`, type: "image" }] });
    return { env, project, jobs, llm, pipeline, run, refJobs };
}

// ——— ① design 阶段真正产出并绑定参考图 ———

test("① design 产出角色特写/三视图 + 场景母版参考图并绑定 AssetRef.selectedArtifactId", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-design-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { project, jobs, pipeline, run, refJobs } = await runToDesignBound(root);

    assert.deepEqual(refJobs.map((job) => job.meta.itemId).sort(), ["c1-closeup", "c1-turnaround", "c2-closeup", "c2-turnaround", "loc1-master"]);
    const c1Closeup = jobs.get(`${run.id}-c1-closeup`);
    assert.match(c1Closeup.params.PROMPT, /solo front closeup/);
    assert.equal(c1Closeup.params.OUTPUT_PREFIX, `canvas/${run.id}_c1-closeup`);

    assert.equal(pipeline.get(run.id).stages.design.status, "done");
    const c1 = project.project.assetRefs.find((ref) => ref.bindingId === "c1");
    assert.ok(c1, "角色 c1 绑定到 AssetRef");
    assert.equal(c1.selectedArtifactId, `/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`, "selectedArtifactId = 正脸特写");
    assert.deepEqual(c1.artifactIds, [`/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`, `/api/artifacts/${run.id}-c1-turnaround/${run.id}-c1-turnaround.png`]);
    const loc1 = project.project.assetRefs.find((ref) => ref.bindingId === "loc1");
    assert.equal(loc1.role, "scene");
    assert.equal(loc1.selectedArtifactId, `/api/artifacts/${run.id}-loc1-master/${run.id}-loc1-master.png`);
});

test("① design 参考图登记幂等：重复投递终态 / 重启重放只登记一次、不重复入队", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-design-idem-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { env, project, jobs, pipeline, run } = await runToDesignBound(root);

    const beforeRefs = project.project.assetRefs.length;
    const beforeCalls = project.calls.length;
    const beforeJobs = jobs.list().length;
    for (const job of jobs.list().filter((entry) => entry.meta?.stageId === "design")) pipeline.projectJob(jobs.get(job.id));
    assert.equal(project.project.assetRefs.length, beforeRefs, "重启重放不重复登记");
    assert.equal(project.calls.length, beforeCalls);

    const rebuilt = build(env, { jobs, llm: fakeLlm(), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register });
    rebuilt.bindJobs();
    assert.equal(project.project.assetRefs.length, beforeRefs);
    assert.equal(jobs.list().length, beforeJobs, "已有候选的条目不再重复入队");
    assert.equal(pipeline.get(run.id).stages.design.status, "done");
});

// ——— ② 关键帧按 ShotBinding 注入 REF_IMAGE_* + 稳定 SEED ———

test("② 关键帧 start 注入 REF_IMAGE_*（角色在前、场景在后）+ 稳定 SEED，并改用参考图模板", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-keyframe-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { project, jobs, pipeline, run } = await runToDesignBound(root);

    const keyed = await pipeline.runStage(run.id, "keyframe");
    assert.equal(keyed.stages.keyframe.status, "running");
    const startJob = jobs.get(`${run.id}-sh1-start`);
    assert.ok(startJob, "start 帧已入队");
    assert.equal(startJob.template, "img_qwen21_edit", "默认 img_qwen21_t2i 零 LoadImage → 需要锁角色时换参考图模板");
    assert.equal(startJob.params.REF_IMAGE_1, `/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`, "REF_IMAGE_1 = 角色 c1 正脸特写");
    assert.equal(startJob.params.REF_IMAGE_2, `/api/artifacts/${run.id}-loc1-master/${run.id}-loc1-master.png`, "REF_IMAGE_2 = 场景 loc1 空场母版");
    assert.equal(startJob.params.REF_IMAGE_3, undefined);
    assert.equal(startJob.params.SEED, stableSeed(project.project.id, "sh1", { c1: 0, loc1: 0 }), "SEED = stableSeed(projectId, shotId, assetRevision)");
    assert.equal(startJob.params.OUTPUT_PREFIX, `canvas/${run.id}_sh1-start`, "OUTPUT_PREFIX 按 run+条目隔离（#40）");
});

test("② SEED 对同输入稳定、资产 revision 变化即变", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-seed-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { project, jobs, pipeline, run } = await runToDesignBound(root);
    await pipeline.runStage(run.id, "keyframe");
    // 让 start / end 都终态，阶段回到 done，才能逐条试算
    jobs.finish(`${run.id}-sh1-start`, "done", { outputs: [{ url: `/api/artifacts/${run.id}-sh1-start/start.png` }] });
    jobs.finish(`${run.id}-sh1-end`, "done", { outputs: [{ url: `/api/artifacts/${run.id}-sh1-end/end.png` }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done");

    const first = pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" });
    const second = pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" });
    assert.equal(first.plan.params.SEED, second.plan.params.SEED, "同输入 → 同 seed");

    project.project.assetRefs.find((ref) => ref.bindingId === "c1").revision = 3;
    const changed = pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" });
    assert.notEqual(changed.plan.params.SEED, first.plan.params.SEED, "资产 revision 变 → seed 变");
});

test("② 无参考图能力：需要锁角色的镜头显式 blocked 且给出可解释原因（不假装锁定）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-blocked-template-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const t2iDir = mkdtempSync(join(tmpdir(), "canvas-reflock-wf-"));
    t.after(() => rmSync(t2iDir, { recursive: true, force: true }));
    writeFileSync(
        join(t2iDir, "img_t2i_only.json"),
        JSON.stringify({ "1": { class_type: "KSampler", inputs: { text: "{{PROMPT}}" } }, "2": { class_type: "SaveImage", inputs: { filename_prefix: "{{OUTPUT_PREFIX}}" } } }),
    );

    const env = makeEnv(root, { workflowsDir: t2iDir, imageTemplate: "img_t2i_only", referenceImageTemplate: "" });
    const project = fakeProject();
    const jobs = fakeJobQueue();
    const pipeline = build(env, { jobs, llm: fakeLlm(), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    pipeline.setStageInput(run.id, "design", { output: { ...DESIGN, references: [] } });

    const keyed = await pipeline.runStage(run.id, "keyframe");
    const frame = keyed.stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.status, "blocked", "需要锁角色但模板无参考图能力 → blocked");
    assert.match(frame.blockedReason, /不支持参考图/, frame.blockedReason);
    assert.equal(jobs.get(`${run.id}-sh1-start`), null, "blocked 的镜头不得入队（不静默降级）");
    assert.equal(keyed.stages.keyframe.status, "blocked");
    assert.ok(Array.isArray(keyed.stages.keyframe.blocked) && keyed.stages.keyframe.blocked.length >= 1, "blocked 在阶段层可见");
});

test("② 参考图缺失：能锁角色但缺候选 → 显式 blocked（reason 指明缺哪个绑定）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-missing-ref-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject();
    const jobs = fakeJobQueue();
    const pipeline = build(env, { jobs, llm: fakeLlm(), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    pipeline.setStageInput(run.id, "design", { output: { ...DESIGN, references: [] } });

    const keyed = await pipeline.runStage(run.id, "keyframe");
    const frame = keyed.stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.status, "blocked");
    assert.match(frame.blockedReason, /缺少角色\/场景参考图/);
    assert.match(frame.blockedReason, /c1/, frame.blockedReason);
    assert.equal(jobs.get(`${run.id}-sh1-start`), null);
});

// ——— ③ textOverlays 逐字拼进 PROMPT ———

test("③ textOverlays 逐字拼进 PROMPT；kind 全 none 不拼空串", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-overlay-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { jobs, pipeline, run } = await runToDesignBound(root);
    await pipeline.runStage(run.id, "keyframe");

    const startPrompt = jobs.get(`${run.id}-sh1-start`).params.PROMPT;
    assert.ok(startPrompt.includes('"老城南路公交站"'), startPrompt);
    assert.ok(startPrompt.includes('"3路"'), startPrompt);
    assert.ok(startPrompt.includes('"3路 末班车"'), startPrompt);
    assert.match(startPrompt, /on-screen text rendered verbatim/);

    // end 帧的 textOverlays 只有 kind:none → 不拼空串
    jobs.finish(`${run.id}-sh1-start`, "done", { outputs: [{ url: `/api/artifacts/${run.id}-sh1-start/start.png` }] });
    const endJob = jobs.get(`${run.id}-sh1-end`);
    assert.ok(endJob, "start 就绪后 end 入队");
    assert.ok(!endJob.params.PROMPT.includes("on-screen text rendered verbatim"), endJob.params.PROMPT);
    assert.ok(!endJob.params.PROMPT.includes('""'));
});

test("③ 缺 textOverlays 字段：不报错、只产生 QC warning；kind 非法仍逐字保留文字", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-overlay2-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject("prj_ref_lock3");
    const jobs = fakeJobQueue();
    const frames = {
        frames: [
            { id: "sh1-start", shotId: "sh1", role: "start", prompt: "林晚" }, // 故意缺 textOverlays
            { id: "sh2-start", shotId: "sh1", role: "key", prompt: "林晚", textOverlays: [{ text: "站牌文字", kind: "weird", position: "left" }] },
        ],
    };
    const pipeline = build(env, { jobs, llm: fakeLlm({ frames }), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    seedRefs(project, run.id);
    pipeline.setStageInput(run.id, "design", { output: { ...DESIGN, references: [] } });
    await pipeline.runStage(run.id, "keyframe");

    const framesOut = pipeline.get(run.id).stages.keyframe.output.frames;
    const missing = framesOut.find((entry) => entry.id === "sh1-start");
    assert.match(missing.warning, /textOverlays/, "缺 textOverlays 只产生 QC warning");
    const jobMissing = jobs.list().find((entry) => entry.meta?.itemId === "sh1-start");
    assert.ok(jobMissing, "缺 textOverlays 不阻断入队");
    assert.ok(!jobMissing.params.PROMPT.includes("on-screen text"));

    const invalidKind = jobs.list().find((entry) => entry.meta?.itemId === "sh2-start");
    assert.ok(invalidKind, "kind 非法不阻断");
    assert.ok(invalidKind.params.PROMPT.includes('"站牌文字"'), invalidKind.params.PROMPT);
});

// ——— ④ 产物索引 URL 断链（#40） ———

test("④ 回写只落磁盘上真实存在的产物 URL（拒绝指向不存在文件的索引）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-url-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { env, jobs, pipeline, run } = await runToDesignBound(root);
    await pipeline.runStage(run.id, "keyframe");

    const jobId = `${run.id}-sh1-start`;
    const goodUrl = `/api/artifacts/${jobId}/real.png`;
    const goodPath = join(env.config.dataDir, "artifacts", jobId, "real.png");
    mkdirSync(dirname(goodPath), { recursive: true });
    writeFileSync(goodPath, "PNG");
    // ComfyUI 回报的第一个文件名在磁盘上不存在（#40 场景），第二个才是本 job 真正写下的文件
    jobs.get(jobId).outputs = [{ url: `/api/artifacts/${jobId}/ghost.png`, type: "image" }, { url: goodUrl, type: "image" }];
    jobs.finish(jobId, "done", {});

    const frame = pipeline.get(run.id).stages.keyframe.output.frames.find((entry) => entry.id === "sh1-start");
    assert.equal(frame.artifactUrl, goodUrl, "索引只落真实存在的产物 URL");
    assert.equal(pipeline.get(run.id).stages.keyframe.artifacts.find((entry) => entry.jobId === jobId).url, goodUrl);
});

test("④ OUTPUT_PREFIX 按 run+条目隔离：不同 run 的同一 item 不再共用 ComfyUI 文件名前缀", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-prefix-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { jobs, pipeline, run } = await runToDesignBound(root);
    await pipeline.runStage(run.id, "keyframe");
    const startPrefix = jobs.get(`${run.id}-sh1-start`).params.OUTPUT_PREFIX;
    assert.equal(startPrefix, `canvas/${run.id}_sh1-start`);
    jobs.finish(`${run.id}-sh1-start`, "done", { outputs: [{ url: `/api/artifacts/${run.id}-sh1-start/start.png` }] });
    const endPrefix = jobs.get(`${run.id}-sh1-end`).params.OUTPUT_PREFIX;
    assert.equal(endPrefix, `canvas/${run.id}_sh1-end`);
    assert.notEqual(endPrefix, startPrefix, "同一 run 内不同条目前缀不同");
});

// ——— ①b/①c/①d 幂等判据修复：空引用不再挡住绑定（自愈存量空占位） ———

test("①b 存量空引用（artifactIds:[]）在本轮参考图终态后就地 update 填充，不新增重复引用（自愈）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-heal-empty-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = makeEnv(root);
    const project = fakeProject("prj_heal");
    const jobs = fakeJobQueue();
    const pipeline = build(env, { jobs, llm: fakeLlm(), getProject: (id) => (id === project.project.id ? project.project : null), registerAssetRef: project.register, updateAssetRef: project.update });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "末班车的约定", title: "短篇", options: { projectId: project.project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "design");
    // 复现 bug 现场：上一版 registerDesignAssets 预建的 3 条空引用（同 runId/stageId，artifactIds 空、selected null）
    project.project.assetRefs = [
        { id: "as_empty_c1", role: "character", bindingId: "c1", artifactIds: [], selectedArtifactId: null, metadata: { runId: run.id, stageId: "design" } },
        { id: "as_empty_c2", role: "character", bindingId: "c2", artifactIds: [], selectedArtifactId: null, metadata: { runId: run.id, stageId: "design" } },
        { id: "as_empty_loc1", role: "scene", bindingId: "loc1", artifactIds: [], selectedArtifactId: null, metadata: { runId: run.id, stageId: "design" } },
    ];
    const beforeIds = project.project.assetRefs.map((ref) => ref.id);
    for (const job of jobs.list().filter((entry) => entry.meta?.stageId === "design")) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/${job.id}/${job.id}.png`, type: "image" }] });

    // 关键断言：条数不变（就地 update，不新增引用）；原来的空引用被打通
    assert.deepEqual(project.project.assetRefs.map((ref) => ref.id), beforeIds, "空引用不新增重复引用（就地 update）");
    const c1 = project.project.assetRefs.find((ref) => ref.id === "as_empty_c1");
    assert.deepEqual(c1.artifactIds, [`/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`, `/api/artifacts/${run.id}-c1-turnaround/${run.id}-c1-turnaround.png`]);
    assert.equal(c1.selectedArtifactId, `/api/artifacts/${run.id}-c1-closeup/${run.id}-c1-closeup.png`, "空引用填上正脸特写");
    const loc1 = project.project.assetRefs.find((ref) => ref.id === "as_empty_loc1");
    assert.equal(loc1.selectedArtifactId, `/api/artifacts/${run.id}-loc1-master/${run.id}-loc1-master.png`, "场景空引用填上空场母版");
    assert.ok(project.calls.some((call) => call.op === "update" && call.refId === "as_empty_c1"), "空引用走 update 而非 create");
    assert.ok(!project.calls.some((call) => call.op === "create"), "绑定路径不产生任何新引用");
});

test("①c 已有产物引用：重复投递终态不覆盖已有 selectedArtifactId、不重复登记（幂等）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-bound-idem-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { project, jobs, pipeline, run } = await runToDesignBound(root);

    const turnaround = `/api/artifacts/${run.id}-c1-turnaround/${run.id}-c1-turnaround.png`;
    const c1 = project.project.assetRefs.find((ref) => ref.bindingId === "c1");
    c1.selectedArtifactId = turnaround; // 模拟既有/用户选择：采用版本不是默认正脸特写
    const beforeLen = project.project.assetRefs.length;
    const beforeCalls = project.calls.length;

    for (const job of jobs.list().filter((entry) => entry.meta?.stageId === "design")) pipeline.projectJob(jobs.get(job.id));

    assert.equal(project.project.assetRefs.length, beforeLen, "已有产物 → 不重复登记");
    assert.equal(project.calls.length, beforeCalls, "已有产物 → 既不 create 也不 update");
    assert.equal(c1.selectedArtifactId, turnaround, "不覆盖已有 selectedArtifactId");
});

test("①d 无任何已有引用：按 bindingId 新建引用（create），每个 binding 恰好一条", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-reflock-create-new-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { project, run } = await runToDesignBound(root);

    const forRun = project.project.assetRefs.filter((ref) => ref.metadata?.runId === run.id && ref.metadata?.stageId === "design");
    assert.deepEqual(forRun.map((ref) => ref.bindingId).sort(), ["c1", "c2", "loc1"], "每个 binding 一条新建引用");
    assert.ok(project.calls.some((call) => call.op === "create"), "无引用 → 走 create");
    assert.ok(!project.calls.some((call) => call.op === "update"), "无引用 → 不需要 update");
});

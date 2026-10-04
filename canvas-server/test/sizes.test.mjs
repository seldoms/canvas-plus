/**
 * 「画幅口径跟模型建议尺寸走」—— 模型规格档位（sizes.js）的行为锁定。
 * 覆盖：官方规格登记 / default 落官方清单 / 未查证标记 / 按画幅匹配 / 匹配不到回落 + warning /
 *       规格随模型清单同源下发（GET /api/providers）/ 片段尺寸不再产出官方没有的 768x1376。
 *
 * 权威数据源（只读）：research/win147-comfyui/registry.json → models.<key>.limits.resolutions。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SIZE_CATALOG, isSizeAllowed, normalizeRatio, sizeForRatio, sizeMetaForTemplate, sizesForTemplate } from "../src/sizes.js";
import { createPipeline } from "../src/pipeline.js";
import { listTemplates } from "../src/providers/comfy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const workflowsDir = resolve(HERE, "../workflows/");
/** 权威源（只读）：canvas-plus/research/win147-comfyui/registry.json。 */
const RESEARCH_REGISTRY = resolve(HERE, "../../research/win147-comfyui/registry.json");
const researchModels = JSON.parse(readFileSync(RESEARCH_REGISTRY, "utf8")).models;

const H3_TEMPLATES = [
    "video_h3_i2v",
    "video_h3_i2v_fl",
    "video_h3_ref2v",
    "video_h3_ref2v_image",
    "video_h3_ref2v_image_turbo",
    "video_h3_quantfunc_ref2v",
    "video_h3_talk",
    "video_minimax_h3_t2v",
];
const IMAGE_TEMPLATE_MODELS = {
    img_zimage_artistic: "z_image_turbo",
    img_flux_artistic: "flux1_dev",
    img_krea2_artistic: "krea2_turbo",
    img_boogu_outfit_edit: "boogu_edit",
    img_qwen21_t2i: "qwen_image_2_1",
    img_qwen21_edit: "qwen_image_2_1",
    scail2_action_transfer: "scail2",
    video_wan_animate: "wan22_animate",
};

// ————————————————————— sizes.js 纯函数 —————————————————————

test("规格登记表：每个已查证模型的 default 落在自己的官方清单里", () => {
    for (const [model, entry] of Object.entries(SIZE_CATALOG)) {
        if (!entry.verified || !Array.isArray(entry.sizes)) continue;
        const values = entry.sizes.map((size) => `${size.width}x${size.height}`);
        assert.ok(entry.default, `${model} 已查证但缺 default`);
        assert.ok(values.includes(entry.default), `${model} 的 default ${entry.default} 必须在其规格清单内`);
        // 每条规格必须有像素 + 画幅比例 + 证据等级。
        for (const size of entry.sizes) {
            assert.ok(Number(size.width) > 0 && Number(size.height) > 0, `${model} 规格像素非法`);
            assert.match(size.ratio, /^\d+:\d+$/, `${model} 规格缺合法画幅比例`);
            assert.ok(["official", "measured", "derived"].includes(size.source), `${model} 规格证据等级非法：${size.source}`);
        }
    }
    // H3 竖屏官方档 = 768x1344（不是按比例推导的 768x1376）。
    assert.equal(SIZE_CATALOG.minimax_h3.default, "768x1344");
});

test("规格登记表：标注 official 的像素必须在 registry.json 的 limits.resolutions 里逐字出现（不许拍脑袋）", () => {
    for (const [model, entry] of Object.entries(SIZE_CATALOG)) {
        if (!entry.verified || !Array.isArray(entry.sizes)) continue;
        const text = JSON.stringify(researchModels[model]?.limits?.resolutions ?? null);
        for (const size of entry.sizes) {
            if (size.source !== "official") continue;
            assert.ok(text.includes(`${size.width}x${size.height}`), `${model} 的 official 规格 ${size.width}x${size.height} 不在 registry resolutions 里：${text}`);
        }
    }
});

test("规格登记表：未查证模型一律 sizes:null + verified:false + 待查证（与 durations 同口径，不许自由填）", () => {
    // ltx23：registry limits.resolutions=null。
    assert.equal(SIZE_CATALOG.ltx23.sizes, null);
    assert.equal(SIZE_CATALOG.ltx23.verified, false);
    assert.match(SIZE_CATALOG.ltx23.note, /待查证/);
    // 未映射 / 未登记的模板同样按「待查证」处理。
    const unknown = sizeMetaForTemplate("video_some_new_model");
    assert.equal(unknown.sizes, null);
    assert.equal(unknown.verified, false);
    assert.match(unknown.note, /待查证/);
    // 非画面模板无规格（音频）。
    const audio = sizeMetaForTemplate("audio_qwen3_tts");
    assert.equal(audio.sizes, null);
    assert.equal(audio.mode, "none");
});

test("sizeForRatio：按项目画幅匹配该模型的官方档（H3 9:16=768x1344 / 16:9=1344x768；qwen2.1 16:9=2752x1536）", () => {
    const h3v = sizeForRatio("video_h3_i2v", "9:16");
    assert.equal(h3v.width, 768);
    assert.equal(h3v.height, 1344);
    assert.equal(h3v.matched, true);
    assert.equal(h3v.warning, null);
    const h3h = sizeForRatio("video_h3_i2v", "16:9");
    assert.deepEqual([h3h.width, h3h.height], [1344, 768]);
    const q = sizeForRatio("img_qwen21_t2i", "16:9");
    assert.deepEqual([q.width, q.height], [2752, 1536]);
    // 同一画幅有多档时优先 default 命中的那档（H3 9:16 有两档，default=768x1344）。
    assert.equal(sizeMetaForTemplate("video_h3_i2v").default, "768x1344");
    for (const name of H3_TEMPLATES) assert.equal(sizeForRatio(name, "9:16").height, 1344, `${name} 9:16 应为官方 768x1344`);
});

test("sizeForRatio：画幅无对应官方档 → 回落该模型 default + 记 warning（不臆造官方档位）", () => {
    // z_image_turbo 官方只有方形档 → 16:9 请求回落默认 1024x1024 并告警。
    const z = sizeForRatio("img_zimage_artistic", "16:9");
    assert.deepEqual([z.width, z.height], [1024, 1024]);
    assert.equal(z.matched, false);
    assert.match(z.warning, /没有 16:9 画幅/);
    assert.match(z.warning, /1024x1024/);
    // H3 没有 5:4 档 → 回落默认 768x1344 + warning。
    const h3 = sizeForRatio("video_h3_i2v", "5:4");
    assert.deepEqual([h3.width, h3.height], [768, 1344]);
    assert.equal(h3.matched, false);
    assert.match(h3.warning, /5:4/);
    // 未请求画幅 → 直接用默认，不算回落、不告警。
    const noRatio = sizeForRatio("video_h3_i2v", "");
    assert.deepEqual([noRatio.width, noRatio.height], [768, 1344]);
    assert.equal(noRatio.warning, null);
});

test("sizeForRatio：未登记官方规格的模板才回落旧的按比例推导（不臆造官方档位）", () => {
    // 测试桩模板未登记 → 保持旧行为（16:9 短边 768 推导）。
    const legacy = sizeForRatio("img-test", "16:9", { base: 768 });
    assert.deepEqual([legacy.width, legacy.height], [1376, 768]);
    assert.equal(legacy.source, "legacy");
    // 无画幅 → null，由调用方回落 config 默认宽高。
    assert.equal(sizeForRatio("img-test", "").width, null);
});

test("规格登记表：不存在官方没有的 768x1376 档（H3 不再产出 1376）", () => {
    const all = Object.values(SIZE_CATALOG)
        .flatMap((entry) => (Array.isArray(entry.sizes) ? entry.sizes : []))
        .map((size) => `${size.width}x${size.height}`);
    assert.ok(!all.includes("768x1376"), "官方登记表里不应出现 768x1376");
    // H3 任何画幅都不会取到 1376。
    for (const ratio of ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9"]) {
        const dims = sizeForRatio("video_h3_i2v", ratio);
        assert.notEqual(dims.size, "768x1376");
    }
});

test("isSizeAllowed：所选规格必须属于该模型官方清单；未查证一律 false", () => {
    assert.equal(isSizeAllowed("video_h3_i2v", "768x1344"), true);
    assert.equal(isSizeAllowed("video_h3_i2v", "768x1376"), false);
    assert.equal(isSizeAllowed("video_wan_animate", "1280x720"), true);
    assert.equal(isSizeAllowed("video_some_new_model", "768x1344"), false);
    assert.equal(normalizeRatio(" 9:16 "), "9:16");
    assert.equal(normalizeRatio("auto"), "");
});

// ————————————————————— 与模型清单同源下发 —————————————————————

test("规格随模板清单同源下发（前端只读，不硬编码）", () => {
    const templates = listTemplates(workflowsDir);
    const h3 = templates.find((template) => template.name === "video_h3_i2v");
    assert.ok(Array.isArray(h3.sizes) && h3.sizes.length, "video_h3_i2v 应下发 sizes");
    assert.ok(h3.sizes.some((size) => size.value === "768x1344" && size.ratio === "9:16" && size.source === "official"));
    assert.equal(h3.sizeMeta.default, "768x1344");
    assert.equal(h3.sizeMeta.model, "minimax_h3");
    // 每个模板都带 sizes 字段（前端统一读取，不必判模板类型）。
    assert.ok(templates.every((template) => "sizes" in template && "sizeMeta" in template));
    // 生图模板映射到对应 registry 模型。
    for (const [template, model] of Object.entries(IMAGE_TEMPLATE_MODELS)) {
        const info = templates.find((item) => item.name === template);
        assert.equal(info?.sizeMeta?.model, model, `${template} 应映射到 ${model}`);
        assert.ok(Array.isArray(info?.sizes) && info.sizes.length, `${template} 应下发 sizes`);
    }
    assert.deepEqual(sizesForTemplate("video_h3_i2v"), h3.sizes);
});

// ————————————————————— 编排器集成：片段尺寸取自登记表 —————————————————————

const SCRIPT = { logline: "一句话", synopsis: "梗概", characters: [], scenes: [{ id: "sc1" }] };
const SHOTS = { shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, prompt: "a girl walking", action: "走路" }] };
const FRAMES = { frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "少女走进老屋", textOverlays: [] }] };
const CLIPS = { clips: [{ id: "sh1-clip", shotId: "sh1", keyframeId: "sh1-start", durationSec: 5 }], assembly: { order: ["sh1-clip"], transition: "cut" } };

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-sizes-"));
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": "你是影视剧本改编，返回 JSON。\n原文：\n{{novel}}",
        "02-storyboard": "你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。\n剧本：\n{{script}}",
        "04-keyframes": "你是关键帧提示词工程师，返回含 frames 数组的 JSON。\n分镜：\n{{storyboard}}",
        "05-clip-assembly": "你是片段合成师，返回含 clips 的 JSON。\n关键帧：\n{{keyframes}}",
    };
    for (const [id, prompt] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${id}\ndescription: 测试\n---\n\n# ${id}\n\n## 提示词模板\n\n${prompt}\n`);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({ version: 1, stages: [
            { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
            { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
            { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
            { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
        ] }),
    );
    const config = {
        dataDir: join(root, "data"),
        pipeline: { imageTemplate: "img_qwen21_t2i", videoTemplate: "video_h3_i2v", imageWidth: 768, imageHeight: 1344, imageBatch: 1, videoWidth: 768, videoHeight: 1344, videoSeconds: 5, videoFps: 24, maxKeyframesPerShot: 4 },
    };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function fakeLlm(reply) {
    return { calls: [], async chat(options) { const value = reply(options.messages.at(-1).content); return { choices: [{ message: { content: JSON.stringify(value) } }] }; } };
}

function fakeJobQueue() {
    const store = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        enqueue(job) { const created = { ...job, status: "queued", outputs: [], createdAt: new Date().toISOString() }; store.set(created.id, created); emit(created); return created; },
        get: (id) => store.get(id) || null,
        list: () => [...store.values()],
        on(event, handler) { if (event === "change") handlers.push(handler); return () => {}; },
        finish(id, status, patch = {}) { const job = store.get(id); Object.assign(job, patch, { status, finishedAt: new Date().toISOString() }); emit(job); return job; },
    };
}

const PROJECT = { id: "prj_size", plan: { ratio: "9:16", episodeDurationSec: 15 }, assetRefs: [] };

test("集成：9:16 项目 + H3 视频模型 → 片段 WIDTH/HEIGHT = 官方 768x1344（不再 768x1376）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const jobs = fakeJobQueue();
    const llm = fakeLlm((content) => (content.includes("片段合成师") ? CLIPS : content.includes("关键帧提示词工程师") ? FRAMES : content.includes("分镜师") ? SHOTS : SCRIPT));
    const pipeline = createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs, comfy: {}, llm, runJob: async () => ({ outputs: [] }), getProject: (id) => (id === PROJECT.id ? PROJECT : null) });
    pipeline.bindJobs();
    const run = pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: PROJECT.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    // D3：关键帧单镜一次入队 ≥4 候选；全部以「达标产物」终态收尾，关键帧阶段才落 done。
    const frameJobs = jobs.list().filter((job) => job.kind === "image");
    assert.ok(frameJobs.length >= 1, "关键帧任务应入队");
    for (const job of frameJobs) jobs.finish(job.id, "done", { outputs: [{ url: `/api/artifacts/job/${job.id}.png`, type: "image", bytes: 204800, width: 768, height: 1344 }] });
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done");

    const assembled = await pipeline.runStage(run.id, "assembly");
    const clip = assembled.stages.assembly.output.clips[0];
    const clipJob = jobs.get(clip.jobId);
    assert.equal(clipJob.params.WIDTH, 768, "H3 竖屏官方短边 768");
    assert.equal(clipJob.params.HEIGHT, 1344, "H3 竖屏官方档 = 768x1344，不是 1376");
    assert.notEqual(clipJob.params.HEIGHT, 1376);
});

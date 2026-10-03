import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
    CATEGORIES,
    DEFAULT_ALIASES,
    buildTemplateScript,
    categoryForTemplate,
    computeAvailable,
    createModelRegistry,
    runtimeForProvider,
} from "../src/model-registry.js";

// 隔离环境：每条用例一个临时 dataDir，互不干扰。
const root = mkdtempSync(join(tmpdir(), "canvas-model-registry-"));
let seq = 0;
after(() => rmSync(root, { recursive: true, force: true }));
const newRegistry = () => createModelRegistry({ dataDir: join(root, `data-${seq++}`) });

// 合成「服务端可用源」：不读真实 workflows，保证单测稳定、可精确断言。
const TEMPLATES = [
    { name: "img_qwen21_t2i", family: "image", title: "Qwen-Image 2.1 文生图", tokens: ["PROMPT"] },
    { name: "img_qwen21_edit", family: "edit", title: "Qwen-Image 2.1 指令改图", tokens: ["PROMPT", "INPUT_IMAGE"] },
    { name: "upscale_4x", family: "upscale", title: "4 倍放大", tokens: ["INPUT_IMAGE"] },
    { name: "audio_qwen3_tts", family: "edit", title: "Qwen3-TTS 语音合成", tokens: ["TTS_TEXT"] },
    {
        name: "video_h3_i2v",
        family: "video",
        title: "H3 图生视频",
        tokens: ["PROMPT", "LENGTH", "WIDTH", "HEIGHT", "REF_IMAGE_1"],
        durations: [5, 10],
        durationMeta: { durations: [5, 10], frameRate: 24 },
    },
];
const PROVIDERS = [
    { name: "deepseek", baseUrl: "https://api.deepseek.com" },
    { name: "本地 ollama", baseUrl: "http://127.0.0.1:11434" },
];
const SOURCES = {
    templates: TEMPLATES,
    llmProviders: PROVIDERS,
    catalog: {
        img_qwen21_edit: { supportsReference: true, maxReferenceImages: 9 },
        video_h3_i2v: { supportsReference: true, maxReferenceImages: 1 },
    },
};

test("默认别名表：19 条且全部命中契约 §2.2 的中文别名", () => {
    assert.equal(Object.keys(DEFAULT_ALIASES).length, 19);
    assert.equal(DEFAULT_ALIASES.img_qwen21_t2i, "千问2.1 文生图");
    assert.equal(DEFAULT_ALIASES.img_qwen21_edit, "千问2.1 改图");
    assert.equal(DEFAULT_ALIASES.img_flux_artistic, "Flux 艺术生图");
    assert.equal(DEFAULT_ALIASES.img_krea2_artistic, "Krea2 艺术生图");
    assert.equal(DEFAULT_ALIASES.img_zimage_artistic, "ZImage 艺术生图");
    assert.equal(DEFAULT_ALIASES.img_boogu_outfit_edit, "Boogu 换装");
    assert.equal(DEFAULT_ALIASES.scail2_action_transfer, "Scail2 动作迁移");
    assert.equal(DEFAULT_ALIASES.upscale_4x, "4 倍放大");
    assert.equal(DEFAULT_ALIASES.video_h3_i2v, "H3 图生视频");
    assert.equal(DEFAULT_ALIASES.video_h3_i2v_fl, "H3 首尾帧生视频");
    assert.equal(DEFAULT_ALIASES.video_h3_talk, "H3 台词对口型");
    assert.equal(DEFAULT_ALIASES.video_h3_ref2v_image, "H3 参考图生视频");
    assert.equal(DEFAULT_ALIASES.video_h3_ref2v_image_turbo, "H3 参考图生视频 快速版");
    assert.equal(DEFAULT_ALIASES.video_h3_quantfunc_ref2v, "H3 参考图生视频 省显存版");
    assert.equal(DEFAULT_ALIASES.video_h3_ref2v, "H3 参考视频生视频");
    assert.equal(DEFAULT_ALIASES.video_minimax_h3_t2v, "H3 文生视频");
    assert.equal(DEFAULT_ALIASES.video_wan_animate, "Wan 动作驱动");
    assert.equal(DEFAULT_ALIASES.audio_qwen3_tts, "千问3 语音合成");
    assert.equal(DEFAULT_ALIASES.deepseek, "DeepSeek 对话");
});

test("分类映射四类：audio_* → audio，video → video，img/edit/upscale → image（音频不被错分进生图）", () => {
    assert.equal(categoryForTemplate({ name: "img_qwen21_t2i", family: "image" }), "image");
    assert.equal(categoryForTemplate({ name: "img_qwen21_edit", family: "edit" }), "image");
    assert.equal(categoryForTemplate({ name: "upscale_4x", family: "upscale" }), "image");
    assert.equal(categoryForTemplate({ name: "img_boogu_outfit_edit", family: "edit" }), "image");
    // comfy.js 的 familyOf() 会把 audio_qwen3_tts 判成 edit —— 契约要求它归 audio。
    assert.equal(categoryForTemplate({ name: "audio_qwen3_tts", family: "edit" }), "audio");
    assert.equal(categoryForTemplate({ name: "audio_foo", family: "audio" }), "audio");
    assert.equal(categoryForTemplate({ name: "video_h3_i2v", family: "video" }), "video");
    assert.equal(categoryForTemplate({ name: "video_wan_animate", family: "video" }), "video");

    const items = computeAvailable(SOURCES);
    assert.deepEqual([...new Set(items.map((i) => i.category))].sort(), [...CATEGORIES].sort());
    assert.equal(items.find((i) => i.name === "audio_qwen3_tts").category, "audio");
    assert.equal(items.find((i) => i.name === "deepseek").category, "text");
});

test("runtime 判定：本地地址/ollama → local，云端渠道 → cloud", () => {
    assert.equal(runtimeForProvider({ name: "deepseek", baseUrl: "https://api.deepseek.com" }), "cloud");
    assert.equal(runtimeForProvider({ name: "本地 ollama", baseUrl: "http://127.0.0.1:11434" }), "local");
    assert.equal(runtimeForProvider({ name: "lan", baseUrl: "http://192.168.123.147:11434" }), "local");
    assert.equal(runtimeForProvider({ name: "priv", baseUrl: "http://10.0.0.5:8000" }), "local");
    assert.equal(runtimeForProvider({ name: "内部 ollama", baseUrl: "" }), "local");
    // 模板源恒为 local
    const items = computeAvailable(SOURCES);
    assert.equal(items.find((i) => i.name === "img_qwen21_t2i").runtime, "local");
    assert.equal(items.find((i) => i.name === "本地 ollama").runtime, "local");
});

test("文件缺失 → 空表（不抛错）；损坏 → 空表 + warning（不 500）", () => {
    const registry = newRegistry();
    const empty = registry.list();
    assert.deepEqual(empty.models, []);
    assert.equal(empty.counts.total, 0);

    const dir = join(root, `corrupt-${seq++}`);
    const registry2 = createModelRegistry({ dataDir: dir });
    registry2.create({ name: "x", category: "image" });
    writeFileSync(join(dir, "model-registry.json"), "{ 不是合法 JSON", "utf8");
    const broken = registry2.list();
    assert.deepEqual(broken.models, []);
    assert.match(broken.warning || "", /损坏/);
});

test("CRUD：建档 / 查询 / 局部更新 / 删除；counts 覆盖四类", () => {
    const registry = newRegistry();
    const created = registry.create({ name: "img_qwen21_t2i", category: "image", alias: "千问2.1 文生图" });
    assert.match(created.id, /^mdl_/);
    assert.equal(created.enabled, true);
    assert.equal(created.runtime, "local");
    assert.equal(created.source, "manual");

    assert.equal(registry.get(created.id).name, "img_qwen21_t2i");
    assert.equal(registry.list().counts.image, 1);
    assert.equal(registry.list().counts.total, 1);

    const updated = registry.update(created.id, { alias: "改名了", enabled: false, category: "video" });
    assert.equal(updated.alias, "改名了");
    assert.equal(updated.enabled, false);
    assert.equal(updated.category, "video");
    assert.equal(registry.list().counts.video, 1);
    assert.equal(registry.list().counts.image, 0);
    assert.equal(registry.list().counts.enabled, 0);

    const { removed } = registry.remove(created.id);
    assert.equal(removed.id, created.id);
    assert.equal(registry.get(created.id), null);
    assert.throws(() => registry.update(created.id, { alias: "x" }), (e) => e.status === 404);
    assert.throws(() => registry.remove(created.id), (e) => e.status === 404);
});

test("name 唯一：重复登记返回 409", () => {
    const registry = newRegistry();
    registry.create({ name: "img_qwen21_t2i", category: "image" });
    assert.throws(() => registry.create({ name: "img_qwen21_t2i", category: "image" }), (e) => e.status === 409);
    assert.throws(() => registry.create({ category: "image" }), (e) => e.status === 400);
    assert.throws(() => registry.create({ name: "x", category: "bogus" }), (e) => e.status === 400);
});

test("name 不可改：PATCH 试图改真实标识 → 400", () => {
    const registry = newRegistry();
    const model = registry.create({ name: "img_qwen21_t2i", category: "image" });
    assert.throws(() => registry.update(model.id, { name: "别的名字" }), (e) => e.status === 400);
    // 传相同 name 视为无操作，不报错。
    assert.equal(registry.update(model.id, { name: "img_qwen21_t2i" }).name, "img_qwen21_t2i");
});

test("sync 补缺：全部可用项登记，enabled 默认 true、alias 取默认表", () => {
    const registry = newRegistry();
    const result = registry.sync(SOURCES);
    assert.deepEqual(result.added.sort(), ["audio_qwen3_tts", "deepseek", "img_qwen21_edit", "img_qwen21_t2i", "upscale_4x", "本地 ollama", "video_h3_i2v"].sort());
    assert.deepEqual(result.staled, []);
    assert.equal(result.kept, 0);

    const { models, counts } = registry.list();
    assert.equal(counts.total, TEMPLATES.length + PROVIDERS.length);
    assert.equal(counts.image, 3);
    assert.equal(counts.video, 1);
    assert.equal(counts.audio, 1);
    assert.equal(counts.text, 2);
    assert.equal(counts.enabled, counts.total);

    const t2i = models.find((m) => m.name === "img_qwen21_t2i");
    assert.equal(t2i.alias, "千问2.1 文生图");
    assert.equal(t2i.enabled, true);
    assert.equal(t2i.stale, false);
    assert.equal(t2i.runtime, "local");
    assert.equal(t2i.provider, "comfy");
    assert.equal(t2i.source, "template");
    assert.equal(t2i.template, "img_qwen21_t2i");

    const ds = models.find((m) => m.name === "deepseek");
    assert.equal(ds.category, "text");
    assert.equal(ds.runtime, "cloud");
    assert.equal(ds.provider, "llm");
    assert.equal(ds.source, "channel");
    assert.equal(ds.channelId, "deepseek");
    assert.equal(ds.alias, "DeepSeek 对话");

    const video = models.find((m) => m.name === "video_h3_i2v");
    assert.deepEqual(video.meta.durations, [5, 10]);
    assert.equal(video.meta.supportsReference, true);
    assert.equal(video.meta.referenceLimit, 1);
});

test("sync 幂等：重复调用不改变结果（added/staled 为空，kept 保留全部）", () => {
    const registry = newRegistry();
    const first = registry.sync(SOURCES);
    const total = registry.list().counts.total;
    const second = registry.sync(SOURCES);
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.staled, []);
    assert.equal(second.kept, total);
    assert.equal(first.added.length, total);
});

test("sync 不覆盖用户改过的 alias / enabled", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    const target = registry.list().models.find((m) => m.name === "img_qwen21_t2i");
    registry.update(target.id, { alias: "我的私有别名", enabled: false });

    registry.sync(SOURCES); // 再同步一次不得冲掉
    const after = registry.get(target.id);
    assert.equal(after.alias, "我的私有别名");
    assert.equal(after.enabled, false);
    // 未改过的条目仍保持默认别名与启用
    const untouched = registry.list().models.find((m) => m.name === "img_qwen21_edit");
    assert.equal(untouched.alias, "千问2.1 改图");
    assert.equal(untouched.enabled, true);
});

test("stale 标记：模板消失置 stale:true（不删），回归后清除", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    const staleName = "video_h3_i2v";

    // 从可用源里移除该模板（模拟模板被删）
    const reduced = { ...SOURCES, templates: TEMPLATES.filter((t) => t.name !== staleName) };
    const result = registry.sync(reduced);
    assert.deepEqual(result.staled, [staleName]);
    const staled = registry.list().models.find((m) => m.name === staleName);
    assert.equal(staled.stale, true);
    assert.ok(staled, "登记项不能被删除");

    // 模板回归 → 清除 stale
    registry.sync(SOURCES);
    assert.equal(registry.list().models.find((m) => m.name === staleName).stale, false);
});

test("手工登记项（source=manual）不参与 sync 的 stale 判定", () => {
    const registry = newRegistry();
    const manual = registry.create({ name: "my_custom_model", category: "image", source: "manual" });
    const result = registry.sync(SOURCES);
    assert.equal(result.staled.includes("my_custom_model"), false);
    assert.equal(registry.get(manual.id).stale, false);
});

test("原子写：落盘 JSON 合法、无 .tmp 残留、updatedAt 递增", () => {
    const dir = join(root, `atomic-${seq++}`);
    const registry = createModelRegistry({ dataDir: dir });
    registry.create({ name: "img_qwen21_t2i", category: "image" });
    const file = join(dir, "model-registry.json");
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.models));
    assert.equal(parsed.models.length, 1);
    assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")), "不应残留临时文件");
});

test("available 差异计算：未登记项进 missing，registered 为登记数", () => {
    const registry = newRegistry();
    const before = registry.available(SOURCES);
    assert.equal(before.registered, 0);
    assert.equal(before.available.length, TEMPLATES.length + PROVIDERS.length);
    assert.deepEqual(
        before.missing.map((m) => m.name).sort(),
        before.available.map((m) => m.name).sort(),
    );

    registry.sync(SOURCES);
    const after = registry.available(SOURCES);
    assert.equal(after.registered, TEMPLATES.length + PROVIDERS.length);
    assert.deepEqual(after.missing, []);
});

test("script：服务端生成的模板脚本存在且可编译（等价前端 buildGatewayTemplateScript）", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    const script = registry.list().models.find((m) => m.name === "img_qwen21_t2i").script;
    assert.ok(script.includes("const TEMPLATE = { name: \"img_qwen21_t2i\", family: \"image\", tokens: [\"PROMPT\"] }"));
    assert.ok(script.includes("/api/generate/"));
    // 前端 model-plugin 把它放进 async 函数体执行；此处只校验语法可编译。
    assert.doesNotThrow(() => new Function('"use strict"; return (async () => {' + script + "})();"));
    // 渠道类条目不生成模板脚本。
    const ds = registry.list().models.find((m) => m.name === "deepseek");
    assert.equal(ds.script, "");

    const videoScript = buildTemplateScript({ name: "video_h3_i2v", family: "video", title: "H3 图生视频", tokens: ["PROMPT", "LENGTH"] });
    assert.ok(videoScript.includes('family: "video"'));
    assert.ok(videoScript.includes("/api/generate/video"));
});

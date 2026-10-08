import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
    CATEGORIES,
    DEFAULT_ALIASES,
    DEFAULT_BASE_TASK,
    asModelIdList,
    buildGroups,
    buildTemplateScript,
    categoryForTemplate,
    composeAlias,
    computeAvailable,
    createModelRegistry,
    fallbackBaseTask,
    runtimeForProvider,
    textModelIds,
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

test("默认别名表：19 条、由 §2.5 的 base/task 派生（alias = base + 空格 + task）", () => {
    assert.equal(Object.keys(DEFAULT_ALIASES).length, 19);
    assert.equal(DEFAULT_ALIASES.img_qwen21_t2i, "千问2.1 文生图");
    assert.equal(DEFAULT_ALIASES.img_qwen21_edit, "千问2.1 改图");
    assert.equal(DEFAULT_ALIASES.img_flux_artistic, "Flux 艺术生图");
    assert.equal(DEFAULT_ALIASES.img_krea2_artistic, "Krea2 艺术生图");
    assert.equal(DEFAULT_ALIASES.img_zimage_artistic, "ZImage 艺术生图");
    assert.equal(DEFAULT_ALIASES.img_boogu_outfit_edit, "Boogu 换装");
    assert.equal(DEFAULT_ALIASES.scail2_action_transfer, "Scail2 动作迁移");
    // §2.5：base=放大 / task=4 倍 → alias=放大 4 倍（旧 §2.2 的「4 倍放大」已按 §2.5 归一）
    assert.equal(DEFAULT_ALIASES.upscale_4x, "放大 4 倍");
    assert.equal(DEFAULT_ALIASES.video_h3_i2v, "H3 图生视频");
    assert.equal(DEFAULT_ALIASES.video_h3_i2v_fl, "H3 首尾帧生视频");
    assert.equal(DEFAULT_ALIASES.video_h3_talk, "H3 台词对口型");
    assert.equal(DEFAULT_ALIASES.video_h3_ref2v_image, "H3 参考图生视频");
    // §2.5：同级变体用 · 分隔
    assert.equal(DEFAULT_ALIASES.video_h3_ref2v_image_turbo, "H3 参考图生视频 · 快速版");
    assert.equal(DEFAULT_ALIASES.video_h3_quantfunc_ref2v, "H3 参考图生视频 · 省显存版");
    assert.equal(DEFAULT_ALIASES.video_h3_ref2v, "H3 参考视频生视频");
    assert.equal(DEFAULT_ALIASES.video_minimax_h3_t2v, "H3 文生视频");
    assert.equal(DEFAULT_ALIASES.video_wan_animate, "Wan 动作驱动");
    assert.equal(DEFAULT_ALIASES.audio_qwen3_tts, "千问3 语音合成");
    assert.equal(DEFAULT_ALIASES.deepseek, "DeepSeek 对话");
});

test("默认 base/task 表：19 条与契约 §2.5 完全一致；H3 一组 8 个 task、千问2.1 一组 2 个", () => {
    assert.equal(Object.keys(DEFAULT_BASE_TASK).length, 19);
    assert.deepEqual(DEFAULT_BASE_TASK.img_qwen21_t2i, { base: "千问2.1", task: "文生图" });
    assert.deepEqual(DEFAULT_BASE_TASK.img_qwen21_edit, { base: "千问2.1", task: "改图" });
    assert.deepEqual(DEFAULT_BASE_TASK.upscale_4x, { base: "放大", task: "4 倍" });
    assert.deepEqual(DEFAULT_BASE_TASK.video_h3_ref2v_image_turbo, { base: "H3", task: "参考图生视频 · 快速版" });
    assert.deepEqual(DEFAULT_BASE_TASK.video_h3_quantfunc_ref2v, { base: "H3", task: "参考图生视频 · 省显存版" });
    assert.deepEqual(DEFAULT_BASE_TASK.deepseek, { base: "DeepSeek", task: "对话" });

    const values = Object.values(DEFAULT_BASE_TASK);
    assert.equal(values.filter((v) => v.base === "H3").length, 8, "生视频下 H3 应含 8 个 task");
    assert.equal(values.filter((v) => v.base === "千问2.1").length, 2, "生图下千问2.1 应含 2 个 task");

    // alias 单一事实源 = composeAlias(base, task)
    for (const [name, { base, task }] of Object.entries(DEFAULT_BASE_TASK)) {
        assert.equal(DEFAULT_ALIASES[name], composeAlias(base, task));
    }
});

test("回落链 fallbackBaseTask：默认表命中 → alias 拆分 → name 兜底", () => {
    assert.deepEqual(fallbackBaseTask("video_h3_i2v", ""), { base: "H3", task: "图生视频" });
    assert.deepEqual(fallbackBaseTask("no_such_model", "底座A 能力B"), { base: "底座A", task: "能力B" });
    assert.deepEqual(fallbackBaseTask("no_such_model", "单名无空格"), { base: "单名无空格", task: "" });
    assert.deepEqual(fallbackBaseTask("only_name", ""), { base: "only_name", task: "" });
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
    // 下面两条刻意用**中性私网地址**：runtime 判定的契约是「RFC1918 私网段 → local」
    // （见 src/model-registry.js 的 PRIVATE_HOST_RE）。请勿把它们"脱敏"成
    // 192.0.2.x / 198.51.100.x 之类的文档保留网段 —— 那是公网可路由地址，
    // 判定成 cloud 才是对的，改了会把这条例外分支的测试改红。
    // 真实部署的内网地址只出现在 config.json（已 gitignore）与 config.example.json（已脱敏）。
    assert.equal(runtimeForProvider({ name: "lan", baseUrl: "http://192.168.1.50:11434" }), "local");
    assert.equal(runtimeForProvider({ name: "priv", baseUrl: "http://10.0.0.5:8000" }), "local");
    // 反向锁定：公网可路由地址必须判 cloud，防止判定逻辑被"优化"成一律 local。
    assert.equal(runtimeForProvider({ name: "pub", baseUrl: "http://192.0.2.147:11434" }), "cloud");
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

test("sync 首次登记：base/task/alias 按 §2.5 默认表填；未命中条目回落", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    const { models } = registry.list();
    const byName = new Map(models.map((m) => [m.name, m]));

    const t2i = byName.get("img_qwen21_t2i");
    assert.equal(t2i.base, "千问2.1");
    assert.equal(t2i.task, "文生图");
    assert.equal(t2i.alias, "千问2.1 文生图");

    const upscale = byName.get("upscale_4x");
    assert.deepEqual({ base: upscale.base, task: upscale.task, alias: upscale.alias }, { base: "放大", task: "4 倍", alias: "放大 4 倍" });

    // 渠道命中默认表
    assert.deepEqual({ b: byName.get("deepseek").base, t: byName.get("deepseek").task }, { b: "DeepSeek", t: "对话" });

    // 未命中默认表的渠道（本地 ollama 无默认别名）→ base=name、task=""
    const ollama = byName.get("本地 ollama");
    assert.equal(ollama.base, "本地 ollama");
    assert.equal(ollama.task, "");

    // computeAvailable 也带 base/task
    const items = computeAvailable(SOURCES);
    assert.equal(items.find((i) => i.name === "video_h3_i2v").base, "H3");
    assert.equal(items.find((i) => i.name === "video_h3_i2v").task, "图生视频");
});

test("存量回填：只有 alias 的老条目补齐 base/task；不覆盖用户改过的 alias/enabled；幂等", () => {
    const dir = join(root, `backfill-${seq++}`);
    mkdirSync(dir, { recursive: true });
    const registry = createModelRegistry({ dataDir: dir });
    // 模拟存量登记：全部只有 alias（无 base/task），含一条被用户改过 alias、一条空 alias。
    const legacy = {
        version: 1,
        models: [
            { id: "mdl_1", name: "img_qwen21_t2i", alias: "千问2.1 文生图", category: "image", enabled: true, source: "template" },
            { id: "mdl_2", name: "img_qwen21_edit", alias: "千问2.1 改图", category: "image", enabled: true, source: "template" },
            { id: "mdl_3", name: "video_h3_i2v", alias: "H3 图生视频", category: "video", enabled: true, source: "template" },
            { id: "mdl_4", name: "custom_thing", alias: "自定基座 特殊能力", category: "image", enabled: false, source: "manual" },
            { id: "mdl_5", name: "lonely", alias: "", category: "audio", enabled: true, source: "manual" },
            { id: "mdl_6", name: "img_flux_artistic", alias: "我的Flux别名", category: "image", enabled: true, source: "template" },
        ],
    };
    writeFileSync(join(dir, "model-registry.json"), JSON.stringify(legacy), "utf8");

    // sync 空源也照样回填（回填独立于可用清单）
    const result = registry.sync({ templates: [], llmProviders: [] });
    assert.equal(result.backfilled, 6);

    const { models } = registry.list();
    const byName = new Map(models.map((m) => [m.name, m]));
    // 命中默认表
    assert.deepEqual({ b: byName.get("img_qwen21_t2i").base, t: byName.get("img_qwen21_t2i").task }, { b: "千问2.1", t: "文生图" });
    assert.deepEqual({ b: byName.get("video_h3_i2v").base, t: byName.get("video_h3_i2v").task }, { b: "H3", t: "图生视频" });
    // 未命中默认表 → alias 拆分（第一个空格）
    assert.equal(byName.get("custom_thing").base, "自定基座");
    assert.equal(byName.get("custom_thing").task, "特殊能力");
    // 空 alias → base = alias || name
    assert.equal(byName.get("lonely").base, "lonely");
    assert.equal(byName.get("lonely").task, "");
    // 用户改过的 alias 与 enabled 一律保留（回填只补字段，不重写 alias）
    assert.equal(byName.get("img_flux_artistic").alias, "我的Flux别名");
    assert.equal(byName.get("img_flux_artistic").base, "Flux");
    assert.equal(byName.get("custom_thing").alias, "自定基座 特殊能力");
    assert.equal(byName.get("custom_thing").enabled, false);

    // 幂等：再次 sync 不再回填，字段原样
    const again = registry.sync({ templates: [], llmProviders: [] });
    assert.equal(again.backfilled, 0);
    assert.equal(registry.get("mdl_1").base, "千问2.1");
    assert.equal(registry.get("mdl_1").alias, "千问2.1 文生图");
});

test("PATCH 改 base / task → alias 被重算为 base + 空格 + task；入参校验", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    const target = registry.list().models.find((m) => m.name === "img_qwen21_t2i");

    const byTask = registry.update(target.id, { task: "文生图 · 高清" });
    assert.equal(byTask.base, "千问2.1");
    assert.equal(byTask.task, "文生图 · 高清");
    assert.equal(byTask.alias, "千问2.1 文生图 · 高清");

    const byBase = registry.update(target.id, { base: "通义千问2.1" });
    assert.equal(byBase.base, "通义千问2.1");
    assert.equal(byBase.task, "文生图 · 高清");
    assert.equal(byBase.alias, "通义千问2.1 文生图 · 高清");

    // task 可为空串 → alias 只留 base
    assert.equal(registry.update(target.id, { task: "" }).alias, "通义千问2.1");
    // 校验：base 空 / 非字符串 → 400；task 非字符串 → 400
    assert.throws(() => registry.update(target.id, { base: "" }), (e) => e.status === 400);
    assert.throws(() => registry.update(target.id, { base: 123 }), (e) => e.status === 400);
    assert.throws(() => registry.update(target.id, { task: 7 }), (e) => e.status === 400);
});

test("PATCH base/task 后再次 sync 不被冲掉", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    const target = registry.list().models.find((m) => m.name === "img_qwen21_edit");
    registry.update(target.id, { base: "千问2.1", task: "图像编辑" });
    registry.sync(SOURCES);
    const after = registry.get(target.id);
    assert.equal(after.task, "图像编辑");
    assert.equal(after.alias, "千问2.1 图像编辑");
});

test("POST 新增支持 base/task（缺则按默认表/拆分推）；入参校验", () => {
    const registry = newRegistry();
    const hit = registry.create({ name: "img_qwen21_t2i", category: "image" });
    assert.deepEqual({ b: hit.base, t: hit.task, a: hit.alias }, { b: "千问2.1", t: "文生图", a: "千问2.1 文生图" });

    const explicit = registry.create({ name: "brand_new", category: "image", base: "新基座", task: "新能力" });
    assert.equal(explicit.alias, "新基座 新能力");

    // alias 显式优先于 base+task 组合视图
    const explicitAlias = registry.create({ name: "brand_new2", category: "image", base: "新基座", task: "另一个", alias: "自定义别名" });
    assert.equal(explicitAlias.alias, "自定义别名");
    assert.equal(explicitAlias.base, "新基座");
    assert.equal(explicitAlias.task, "另一个");

    // 无 base/task → 由 alias 拆分
    const split = registry.create({ name: "brand_new3", category: "image", alias: "底座A 能力B" });
    assert.deepEqual({ b: split.base, t: split.task }, { b: "底座A", t: "能力B" });

    assert.throws(() => registry.create({ name: "bad", category: "image", base: "" }), (e) => e.status === 400);
    assert.throws(() => registry.create({ name: "bad2", category: "image", task: 5 }), (e) => e.status === 400);
});

test("groups：按 category → base 聚合；默认表顺序优先、表外按 name 字典序；组内按默认表顺序", () => {
    const registry = newRegistry();
    registry.sync(SOURCES);
    registry.create({ name: "zzz_extra", category: "image", base: "Zeta", task: "杂项" });
    registry.create({ name: "aaa_extra", category: "image", base: "Alpha", task: "杂项" });

    const { groups } = registry.list();
    assert.deepEqual(groups.map((g) => g.category), ["text", "image", "video", "audio"]);

    const image = groups.find((g) => g.category === "image");
    // 默认表内 image 组：千问2.1（表首）→ 放大（表内最后）；表外 Alpha/Zeta 追加、按字典序
    assert.deepEqual(image.bases.map((b) => b.base), ["千问2.1", "放大", "Alpha", "Zeta"]);
    // 组内按默认表顺序：文生图 在 改图 之前
    const qwen = image.bases.find((b) => b.base === "千问2.1");
    assert.deepEqual(qwen.models.map((m) => m.task), ["文生图", "改图"]);
    // 组内每行不再重复 base —— models[].base 与组头一致，前端只渲染 task
    assert.ok(qwen.models.every((m) => m.base === "千问2.1"));

    // text 组：deepseek(DeepSeek 对话) 命中默认表，本地 ollama 表外
    const text = groups.find((g) => g.category === "text");
    assert.deepEqual(text.bases.map((b) => b.base), ["DeepSeek", "本地 ollama"]);

    // buildGroups 纯函数同构
    assert.deepEqual(buildGroups(registry.list().models), groups);
});

// ——— 静态文本模型清单（产品负责人 2026-10-03 定：模型清单只读注册表，网关不探测上游） ———

const DECLARED_PROVIDERS = [
    { name: "deepseek", baseUrl: "https://api.deepseek.com", models: ["deepseek-flash", " deepseek-v4-pro ", "", "deepseek-flash"] },
    { name: "dead", baseUrl: "https://ai.input.im" }, // 未声明模型：连不上也不再拖住清单，直接不产出 id
];

test("asModelIdList：trim / 去空 / 去重保序；非数组一律空", () => {
    assert.deepEqual(asModelIdList(["a", " a ", "", null, "b"]), ["a", "b"]);
    assert.deepEqual(asModelIdList(undefined), []);
    assert.deepEqual(asModelIdList("a"), []);
});

test("computeAvailable：渠道声明的 models 归一后落进 meta.models", () => {
    const items = computeAvailable({ templates: [], llmProviders: DECLARED_PROVIDERS });
    const deepseek = items.find((item) => item.name === "deepseek");
    assert.deepEqual(deepseek.meta.models, ["deepseek-flash", "deepseek-v4-pro"]);
    assert.deepEqual(items.find((item) => item.name === "dead").meta.models, []);
});

test("textModelIds：只展开已启用 text 条目的声明模型为「渠道名::模型名」", () => {
    const models = [
        { name: "deepseek", category: "text", enabled: true, channelName: "deepseek", meta: { models: ["deepseek-flash", "deepseek-v4-pro"] } },
        { name: "dead", category: "text", enabled: true, channelName: "dead", meta: { models: [] } },
        { name: "off", category: "text", enabled: false, channelName: "off", meta: { models: ["m"] } },
        { name: "img_qwen21_t2i", category: "image", enabled: true, channelName: "", meta: { models: ["不该出现"] } },
        { name: "only-id", category: "text", enabled: true, channelId: "chan", meta: { models: ["m1"] } },
    ];
    assert.deepEqual(textModelIds(models), ["deepseek::deepseek-flash", "deepseek::deepseek-v4-pro", "chan::m1"]);
    assert.deepEqual(textModelIds([]), []);
});

test("registry.textModels()：sync 后即可静态读出清单，不需要任何网络探测", () => {
    const registry = newRegistry();
    assert.deepEqual(registry.textModels(), [], "空表 → 空清单（不抛错）");
    registry.sync({ templates: TEMPLATES, llmProviders: DECLARED_PROVIDERS, catalog: {} });
    assert.deepEqual(registry.textModels(), ["deepseek::deepseek-flash", "deepseek::deepseek-v4-pro"]);
});

test("sync 刷新渠道的 meta.models / meta.baseUrl（服务端事实），且不碰用户改过的 alias / enabled", () => {
    const registry = newRegistry();
    registry.sync({ templates: [], llmProviders: DECLARED_PROVIDERS, catalog: {} });
    const entry = registry.list({ category: "text" }).models.find((model) => model.name === "deepseek");
    registry.update(entry.id, { alias: "我的对话模型", enabled: false });

    const changed = [{ name: "deepseek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-v4-pro"] }];
    const result = registry.sync({ templates: [], llmProviders: changed, catalog: {} });

    assert.deepEqual(result.refreshed, ["deepseek"]);
    const after = registry.list({ category: "text" }).models.find((model) => model.name === "deepseek");
    assert.deepEqual(after.meta.models, ["deepseek-v4-pro"], "声明变了要跟上，否则静态清单停在旧快照");
    assert.equal(after.meta.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(after.alias, "我的对话模型", "alias 是用户改的，sync 不得覆盖");
    assert.equal(after.enabled, false, "enabled 是用户改的，sync 不得覆盖");
    assert.deepEqual(registry.textModels(), [], "停用的渠道不产出模型 id");
});

test("sync 幂等：声明未变时不重复刷新（refreshed 为空）", () => {
    const registry = newRegistry();
    const sources = { templates: [], llmProviders: DECLARED_PROVIDERS, catalog: {} };
    registry.sync(sources);
    const second = registry.sync(sources);
    assert.deepEqual(second.refreshed, []);
    assert.deepEqual(second.added, []);
});

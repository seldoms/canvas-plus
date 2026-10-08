import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    DEFAULT_RULES_FILE,
    TEMPLATE_RULE_KEYS,
    clearModelRulesCache,
    h3DefaultProtocol,
    h3PromptProtocols,
    languagePolicy,
    limitsFor,
    loadModelRules,
    negativePolicy,
    pitfallsFor,
    presetFor,
    ruleKeyForTemplate,
    rulesForTemplate,
    textInImageRule,
} from "../src/model-rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 权威源（只读）：canvas-plus/research/win147-comfyui/registry.json。 */
const RESEARCH_REGISTRY = resolve(HERE, "../../research/win147-comfyui/registry.json");

/** 调研 registry.json 里的 13 个模型键（不得抽样）。 */
const EXPECTED_MODEL_KEYS = [
    "qwen_image",
    "qwen_image_edit_2509",
    "qwen_image_2_1",
    "krea2_turbo",
    "flux1_dev",
    "z_image_turbo",
    "boogu_edit",
    "wan21_t2v",
    "wan22_animate",
    "scail2",
    "minimax_h3",
    "ltx23",
    "upscale_4x_ultrasharp",
];

/** 映射表里 8 个走 minimax_h3 的视频模板。 */
const H3_VIDEO_TEMPLATES = [
    "video_h3_i2v",
    "video_h3_i2v_fl",
    "video_h3_talk",
    "video_h3_ref2v",
    "video_h3_ref2v_image",
    "video_h3_ref2v_image_turbo",
    "video_h3_quantfunc_ref2v",
    "video_minimax_h3_t2v",
];

// ── 规则表加载 ────────────────────────────────────────────────────────────────
test("loadModelRules: 默认规则表可加载且含全部 13 个模型（不抽样）", () => {
    const rules = loadModelRules({ force: true });
    assert.equal(rules.warning, null);
    assert.deepEqual(Object.keys(rules.models).sort(), [...EXPECTED_MODEL_KEYS].sort());
    assert.equal(Object.keys(rules.models).length, 13);
    // 顶层还有 machine / not_recommended / rewriter_assets（H3 双口径另测）。
    assert.equal(rules.machine.host, "192.0.2.147");
    assert.equal(rules.machine.gpu, "RTX 5060 Ti 16G");
    assert.ok(Array.isArray(rules.not_recommended) && rules.not_recommended.length > 0);
    assert.ok(Array.isArray(rules.rewriter_assets) && rules.rewriter_assets.length > 0);
    assert.ok(DEFAULT_RULES_FILE.endsWith(join("config", "model-prompt-rules.json")));
});

test("loadModelRules: 每个模型的规则字段完整（label/prompt/limits/presets 必到）", () => {
    const { models } = loadModelRules();
    for (const key of EXPECTED_MODEL_KEYS) {
        const rule = models[key];
        assert.ok(rule && typeof rule === "object", `${key} 缺失`);
        assert.equal(typeof rule.label, "string", `${key}.label`);
        assert.ok(rule.prompt && typeof rule.prompt === "object", `${key}.prompt`);
        assert.ok(rule.limits && typeof rule.limits === "object", `${key}.limits`);
        assert.ok(Array.isArray(rule.pitfalls), `${key}.pitfalls`);
        // registry 里每个模型都有 presets（ltx23/upscale 的 presets 非 null；upscale 的 presets 为 null 已在下文单测）。
        assert.ok("presets" in rule, `${key}.presets 字段必须存在`);
        assert.ok("instance" in rule && "scenarios" in rule && "weights" in rule, `${key} 关键元字段`);
    }
});

// ── 模板名 → 规则键映射 ───────────────────────────────────────────────────────
test("ruleKeyForTemplate / rulesForTemplate: 映射表每一项都能命中", () => {
    const { models } = loadModelRules();
    const entries = Object.entries(TEMPLATE_RULE_KEYS);
    assert.equal(entries.length, 17, `映射项数异常：${entries.length}`);
    for (const [template, key] of entries) {
        assert.equal(ruleKeyForTemplate(template), key, `${template} 映射键`);
        const rule = rulesForTemplate(template);
        assert.ok(rule, `${template} 未命中规则`);
        assert.equal(rule.key, key, `${template}.key`);
        assert.ok(models[key], `规则表缺 ${key}`);
    }
});

test("映射表: 8 个视频 H3 模板全部 → minimax_h3", () => {
    assert.equal(H3_VIDEO_TEMPLATES.length, 8);
    for (const template of H3_VIDEO_TEMPLATES) {
        assert.equal(ruleKeyForTemplate(template), "minimax_h3", template);
        assert.equal(rulesForTemplate(template).key, "minimax_h3");
    }
    // 断言这 8 个确实都在映射表里且值一致
    const h3 = Object.entries(TEMPLATE_RULE_KEYS).filter(([, key]) => key === "minimax_h3").map(([tpl]) => tpl);
    assert.deepEqual(h3.sort(), [...H3_VIDEO_TEMPLATES].sort());
});

test("映射表: 其余图像/动作模板分别命中对应规则键", () => {
    assert.equal(ruleKeyForTemplate("img_qwen21_t2i"), "qwen_image_2_1");
    assert.equal(ruleKeyForTemplate("img_qwen21_edit"), "qwen_image_2_1");
    assert.equal(ruleKeyForTemplate("img_flux_artistic"), "flux1_dev");
    assert.equal(ruleKeyForTemplate("img_krea2_artistic"), "krea2_turbo");
    assert.equal(ruleKeyForTemplate("img_zimage_artistic"), "z_image_turbo");
    assert.equal(ruleKeyForTemplate("img_boogu_outfit_edit"), "boogu_edit");
    assert.equal(ruleKeyForTemplate("scail2_action_transfer"), "scail2");
    assert.equal(ruleKeyForTemplate("upscale_4x"), "upscale_4x_ultrasharp");
    assert.equal(ruleKeyForTemplate("video_wan_animate"), "wan22_animate");
});

test("未映射模板 / 空名回 null（无规则，走通用兜底）", () => {
    for (const name of ["audio_qwen3_tts", "deepseek", "unknown_template", "", null, undefined]) {
        assert.equal(ruleKeyForTemplate(name), null, `${name} 应回 null`);
        assert.equal(rulesForTemplate(name), null, `${name} 规则应回 null`);
        assert.equal(languagePolicy(name), null);
        assert.equal(negativePolicy(name), null);
        assert.equal(textInImageRule(name), null);
        assert.equal(presetFor(name), null);
        assert.equal(limitsFor(name), null);
        assert.deepEqual(pitfallsFor(name), []);
    }
});

// ── 便捷查询：关键值断言 ──────────────────────────────────────────────────────
test("languagePolicy: krea2_turbo / flux1_dev 的 input_language 是 en", () => {
    assert.equal(languagePolicy("img_krea2_artistic").input_language, "en");
    assert.equal(languagePolicy("img_flux_artistic").input_language, "en");
    assert.equal(languagePolicy("img_krea2_artistic").translate_to, "en");
    assert.equal(languagePolicy("img_flux_artistic").translate_to, "en");
    // 规则键层同值复核
    const { models } = loadModelRules();
    assert.equal(models.krea2_turbo.prompt.input_language, "en");
    assert.equal(models.flux1_dev.prompt.input_language, "en");
});

test("languagePolicy: 双语 / 中文模型的 input_language 与 translate_to", () => {
    const qwen = languagePolicy("img_qwen21_t2i");
    assert.equal(qwen.input_language, "bilingual");
    assert.equal(qwen.translate_to, "en");
    assert.equal(typeof qwen.translate_note, "string");

    assert.equal(languagePolicy("img_zimage_artistic").input_language, "bilingual");
    assert.equal(languagePolicy("img_boogu_outfit_edit").input_language, "bilingual");
    assert.equal(languagePolicy("video_wan_animate").input_language, "bilingual");
    assert.equal(languagePolicy("video_h3_i2v").input_language, "zh");
});

test("negativePolicy: wan21_t2v 的 negative 是 required（官方中文负面串）", () => {
    const { models } = loadModelRules();
    assert.equal(models.wan21_t2v.prompt.negative, "required");
    assert.ok(models.wan21_t2v.prompt.negative_default.startsWith("色调艳丽"));
    assert.equal(typeof models.wan21_t2v.prompt.negative_note, "string");
});

test("negativePolicy: minimax_h3 / qwen_image_2_1 的 negative 是 none", () => {
    assert.equal(negativePolicy("video_h3_i2v").negative, "none");
    assert.equal(negativePolicy("img_qwen21_t2i").negative, "none");
    const { models } = loadModelRules();
    assert.equal(models.minimax_h3.prompt.negative, "none");
    assert.equal(models.qwen_image_2_1.prompt.negative, "none");
    // H3 的 negative_note 明说没有负面字段 + 不要 BGM 写 N/A
    assert.match(models.minimax_h3.prompt.negative_note, /没有负面字段/);
    assert.match(models.minimax_h3.prompt.negative_note, /non_diegetic_music: N\/A/);
});

test("negativePolicy: optional / zero_out 档位也能取到", () => {
    assert.equal(negativePolicy("img_boogu_outfit_edit").negative, "optional");
    assert.equal(negativePolicy("video_wan_animate").negative, "optional");
    assert.ok(negativePolicy("video_wan_animate").negative_default.startsWith("色调艳丽"));
    assert.equal(negativePolicy("img_flux_artistic").negative, "zero_out");
});

test("textInImageRule: H3 引号包原文；未定义/未映射回 null", () => {
    const h3 = textInImageRule("video_h3_i2v");
    assert.match(h3, /双引号/);
    assert.match(h3, /营业中/);
    // registry 里 wan22_animate.text_in_image 为 null
    assert.equal(textInImageRule("video_wan_animate"), null);
    assert.equal(textInImageRule("audio_qwen3_tts"), null);
});

test("presetFor: 速度/质量档取值正确，非法档 / 无 presets 回 null", () => {
    const speed = presetFor("video_h3_i2v", "speed");
    assert.equal(speed.steps, 8);
    assert.equal(speed.cfg, 1.0);

    const quality = presetFor("video_h3_i2v", "quality");
    assert.equal(quality.steps, 20);
    assert.equal(quality.cfg, 6.0);
    assert.equal(quality.sampler, "res_multistep");

    // 缺省 mode 按 speed
    assert.deepEqual(presetFor("img_krea2_artistic"), presetFor("img_krea2_artistic", "speed"));
    assert.equal(presetFor("img_krea2_artistic", "speed").mu, 1.15);

    // 非法档回 null
    assert.equal(presetFor("video_h3_i2v", "bogus"), null);
    // registry 里 upscale_4x_ultrasharp.presets = null
    assert.equal(presetFor("upscale_4x", "speed"), null);
    assert.equal(presetFor("upscale_4x", "quality"), null);
});

test("limitsFor / pitfallsFor: 取到硬限制与坑清单（不改语义、不截断）", () => {
    const limits = limitsFor("img_qwen21_t2i");
    assert.equal(limits.multi_image_max, 10);
    assert.ok(Array.isArray(limits.resolutions) && limits.resolutions.length === 7);

    const pitfalls = pitfallsFor("video_h3_i2v");
    assert.ok(pitfalls.length >= 4);
    assert.ok(pitfalls.some((p) => /15 秒档 16G 易卡死/.test(p)));

    assert.equal(limitsFor("audio_qwen3_tts"), null);
    assert.deepEqual(pitfallsFor("audio_qwen3_tts"), []);
});

// ── H3 双口径（本地字段口径默认 + 云端中文三段式） ─────────────────────────────
test("h3PromptProtocols: 两种口径都在，且标明本地默认为 local_fields", () => {
    const protocols = h3PromptProtocols();
    assert.ok(protocols, "h3_prompt_protocols 缺失");
    assert.equal(protocols.default, "local_fields");
    assert.ok(protocols.local_fields);
    assert.ok(protocols.cloud_manual_markdown);
    assert.match(protocols.note, /video-models\.md:149-165/);
});

test("h3 本地字段口径: 关键帧对齐指令行 + 三字段 + <Picture 1>", () => {
    const local = h3PromptProtocols().local_fields;
    assert.deepEqual(local.fields_fixed_order, [
        "integrated_multimodal_description",
        "overall_soundscape",
        "non_diegetic_music",
    ]);
    assert.match(local.reference_material_tags, /<Picture 1>/);
    assert.match(local.reference_material_tags, /不是 @图片1/);
    assert.match(local.no_bgm_rule, /non_diegetic_music: N\/A/);

    const align = local.keyframe_alignment_line;
    assert.deepEqual(align.required_for, ["I2VA", "FL2VA", "L2VA"]);
    assert.deepEqual(align.absent_for, ["T2VA"]);
    assert.match(align.rule, /第一行/);
    assert.match(align.rule, /两位小数/);
    assert.match(align.i2va_example, /0\.00 seconds/);

    // 运镜官方词表三维
    assert.ok(local.camera_vocab.types.includes("Zoom"));
    assert.ok(local.camera_vocab.types.includes("Roll"));
    assert.match(local.camera_vocab.amplitude, /small\|large/);
    assert.match(local.camera_vocab.speed, /slow\|fast/);

    // 台词/画面文字铁律
    assert.match(local.dialogue.speaker_id, /\(S1\)/);
    assert.match(local.dialogue.content, /<d>\[English\]/);
    assert.match(local.image_text, /双引号/);
    assert.ok(local.ref2va_six_fields.length === 6);
    assert.ok(local.iron_rules.some((r) => /总时长必须等于目标视频时长/.test(r)));
});

test("h3 云端口径: 中文手册三段式（参考素材说明 + 核心创意 + 画面过程说明）", () => {
    const cloud = h3PromptProtocols().cloud_manual_markdown;
    assert.equal(cloud.sections.length, 3);
    assert.match(cloud.sections[0], /参考素材说明/);
    assert.match(cloud.sections[1], /核心创意/);
    assert.match(cloud.sections[2], /画面过程说明/);
    assert.match(cloud.source, /video-models\.md:163/);
});

test("h3DefaultProtocol: 展开默认口径并带本地默认标记", () => {
    const def = h3DefaultProtocol();
    assert.equal(def.name, "local_fields");
    assert.match(def.label, /本地默认/);
    assert.deepEqual(def.fields_fixed_order, [
        "integrated_multimodal_description",
        "overall_soundscape",
        "non_diegetic_music",
    ]);
});

// ── 容错：文件缺失 / 损坏 ─────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "canvas-model-rules-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("loadModelRules: 文件缺失 → 空表 + warning，不抛", () => {
    const missing = join(tmp, "nope", "model-prompt-rules.json");
    const rules = loadModelRules({ file: missing, force: true });
    assert.equal(rules.warning !== null, true);
    assert.deepEqual(rules.models, {});
    assert.equal(rules.machine, null);
    assert.equal(rules.h3_prompt_protocols, null);
    assert.equal(rulesForTemplate("video_h3_i2v", { file: missing }), null);
    assert.equal(languagePolicy("img_qwen21_t2i", { file: missing }), null);
});

test("loadModelRules: 文件损坏（非法 JSON）→ 空表 + warning，不抛", () => {
    const broken = join(tmp, "broken.json");
    writeFileSync(broken, "{ 这不是 JSON ", "utf8");
    const rules = loadModelRules({ file: broken, force: true });
    assert.equal(rules.warning !== null, true);
    assert.deepEqual(rules.models, {});
    assert.equal(rulesForTemplate("video_h3_i2v", { file: broken }), null);
    assert.deepEqual(pitfallsFor("video_h3_i2v", { file: broken }), []);
});

test("loadModelRules: 合法但 models 非对象 → 空表（不抛）", () => {
    const weird = join(tmp, "weird.json");
    writeFileSync(weird, JSON.stringify({ models: [1, 2, 3] }), "utf8");
    const rules = loadModelRules({ file: weird, force: true });
    assert.deepEqual(rules.models, {});
    assert.equal(rulesForTemplate("video_h3_i2v", { file: weird }), null);
});

test("规则表缓存：同一路径复用；clearModelRulesCache 后重读", () => {
    clearModelRulesCache();
    const first = loadModelRules();
    const second = loadModelRules();
    assert.equal(first, second);
    clearModelRulesCache();
    const third = loadModelRules();
    assert.notEqual(first, third);
    assert.deepEqual(Object.keys(third.models).sort(), [...EXPECTED_MODEL_KEYS].sort());
});

// ── 与调研逐项对账（权威源只读） ──────────────────────────────────────────────
test("对账: config/model-prompt-rules.json 与 research registry.json 提升字段逐项一致", () => {
    assert.ok(existsSync(RESEARCH_REGISTRY), `调研源缺失：${RESEARCH_REGISTRY}`);
    const research = JSON.parse(readFileSync(RESEARCH_REGISTRY, "utf8"));
    const lifted = loadModelRules({ force: true });

    // 13 个模型及每个模型的全部字段都一致（deep-equal，不抽样、不改写语义）
    assert.deepEqual(Object.keys(lifted.models).sort(), Object.keys(research.models).sort());
    assert.equal(Object.keys(lifted.models).length, 13);
    for (const key of Object.keys(research.models)) {
        assert.deepEqual(lifted.models[key], research.models[key], `模型 ${key} 与调研不一致`);
    }
    // 顶层 machine / not_recommended / rewriter_assets 原样保留
    assert.deepEqual(lifted.machine, research.machine);
    assert.deepEqual(lifted.not_recommended, research.not_recommended);
    assert.deepEqual(lifted.rewriter_assets, research.rewriter_assets);

    // 文件头部注释声明来源
    const raw = JSON.parse(readFileSync(DEFAULT_RULES_FILE, "utf8"));
    assert.match(raw._readme, /research\/win147-comfyui\/registry\.json/);
    assert.match(raw._readme, /以调研为准/);
});

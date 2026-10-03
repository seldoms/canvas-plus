import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { extractTokens, renderTemplate } from "../src/providers/comfy.js";
import { ASSET_TOKENS } from "../src/generate.js";
import { analyzeTemplate, resolveToolForShot, scanTemplateDir } from "../src/tool-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");
const TEMPLATE = "audio_qwen3_tts";
const TEMPLATE_PATH = join(WORKFLOWS_DIR, `${TEMPLATE}.json`);

/** 一手事实：直接读真实模板文件，不造假数据。 */
const RAW = readFileSync(TEMPLATE_PATH, "utf8");

/** 音频模板对外声明的入参槽位（调用方必须能喂）。 */
const CALLER_TOKENS = ["TEXT", "SPEAKER", "INSTRUCT", "LANGUAGE", "DEVICE"];
/** generate.js runJob 自动补默认值的 token（SEED 随机、OUTPUT_PREFIX 由任务名生成）。 */
const AUTO_TOKENS = ["SEED", "OUTPUT_PREFIX"];

/** 一组可渲染的真实入参（老周），随后各测试按需覆盖单字段。 */
const BASE_PARAMS = {
    TEXT: "姑娘，这么晚，去哪儿？",
    SPEAKER: "Uncle_fu",
    INSTRUCT: "中年男性，沙哑低沉，音量偏低，语速慢，略带关心",
    LANGUAGE: "Chinese",
    DEVICE: "cuda",
    SEED: 42,
    OUTPUT_PREFIX: "canvas/tts_laozhou",
};

// ── 1. 被现有模板扫描逻辑识别（tool-adapter.scanTemplateDir / analyzeTemplate） ──
test("scanTemplateDir 能识别 audio_qwen3_tts：非图非视频，不需要参考图", () => {
    const catalog = scanTemplateDir(WORKFLOWS_DIR);
    const info = catalog[TEMPLATE];
    assert.ok(info, "scanTemplateDir 必须扫到 audio_qwen3_tts");
    // TTS 模板既没有视频节点也没有生图/解码节点 → capability 归入 other（不是 image/video）。
    assert.equal(info.capability, "other");
    assert.equal(info.supportsReference, false);
    assert.equal(info.maxReferenceImages, 0);
    assert.deepEqual(info.referenceSlots, []);
    assert.equal(info.slots.PROMPT, false);
    assert.equal(info.slots.INPUT_IMAGE, false);
});

test("analyzeTemplate 直接吃模板字符串也得到同样的能力声明", () => {
    const info = analyzeTemplate(RAW);
    assert.equal(info.capability, "other");
    assert.equal(info.supportsReference, false);
    assert.deepEqual(info.tokens, [...CALLER_TOKENS, ...AUTO_TOKENS].sort());
});

// ── 2. 节点真实存在：只由 Qwen3TTS 节点组 + SaveAudio 构成 ─────────────────────
test("模板节点构成：ModelLoader → CustomVoice → SaveAudio，无生图/生视频节点", () => {
    const graph = JSON.parse(RAW);
    const classes = Object.values(graph).map((node) => node.class_type).sort();
    assert.deepEqual(classes, ["SaveAudio", "TDQwen3TTSCustomVoice", "TDQwen3TTSModelLoader"]);
    // 音色（speaker）与音色设计（instruct）都必须来自入参占位符，才可能「跨镜头固定音色」。
    assert.equal(graph["2"].inputs.speaker, "{{SPEAKER}}");
    assert.equal(graph["2"].inputs.instruct, "{{INSTRUCT}}");
    assert.equal(graph["2"].inputs.text, "{{TEXT}}");
    assert.equal(graph["2"].inputs.language, "{{LANGUAGE}}");
    assert.equal(graph["3"].inputs.filename_prefix, "{{OUTPUT_PREFIX}}");
});

// ── 3. 占位符与 generate.js 槽位声明一致 ───────────────────────────────────────
test("模板占位符全部落在「调用方入参 ∪ generate.js 自动补齐」内，且不含任何素材槽", () => {
    const tokens = extractTokens(TEMPLATE_PATH);
    assert.deepEqual(tokens.slice().sort(), [...CALLER_TOKENS, ...AUTO_TOKENS].sort());
    // 音频模板不消费任何图像素材；若出现 INPUT_IMAGE/REF_IMAGE_n，runJob 会去做上传，
    // 那说明模板串了血统。
    for (const token of tokens) assert.ok(!ASSET_TOKENS.includes(token), `${token} 不应该是素材槽`);
});

test("模拟 generate.js runJob 的 token 补齐：只喂调用方入参也不会缺参", () => {
    // 复刻 generate.js runJob 第 72-78 行的补齐规则（只补 SEED / OUTPUT_PREFIX 这类）。
    const params = { ...BASE_PARAMS };
    delete params.SEED;
    delete params.OUTPUT_PREFIX;
    params.SEED ??= 123456;
    params.OUTPUT_PREFIX ??= "canvas/auto";
    const missing = extractTokens(TEMPLATE_PATH).filter((t) => params[t] === undefined || params[t] === null);
    assert.deepEqual(missing, [], "补齐后不应再缺任何占位符");
    assert.doesNotThrow(() => renderTemplate(TEMPLATE_PATH, params));
});

// ── 4. 渲染正确性：入参真的落到节点上，节点引用不被数字化破坏 ─────────────────
test("renderTemplate：文本/音色/语言/指令落到 CustomVoice，输出前缀落到 SaveAudio", () => {
    const graph = renderTemplate(TEMPLATE_PATH, BASE_PARAMS);
    assert.equal(graph["2"].inputs.text, BASE_PARAMS.TEXT);
    assert.equal(graph["2"].inputs.speaker, BASE_PARAMS.SPEAKER);
    assert.equal(graph["2"].inputs.instruct, BASE_PARAMS.INSTRUCT);
    assert.equal(graph["2"].inputs.language, BASE_PARAMS.LANGUAGE);
    assert.equal(graph["1"].inputs.device, "cuda");
    assert.equal(graph["3"].inputs.filename_prefix, BASE_PARAMS.OUTPUT_PREFIX);
    // 节点引用必须是字符串 id（ComfyUI 用 prompt 字典键解析），不能被 toNumberTree 变成数字。
    assert.deepEqual(graph["2"].inputs.model, ["1", 0]);
    assert.deepEqual(graph["3"].inputs.audio, ["2", 0]);
});

test("同一 SPEAKER + INSTRUCT、不同 TEXT → 音色锚点字段完全一致（跨镜头可复现）", () => {
    const first = renderTemplate(TEMPLATE_PATH, { ...BASE_PARAMS, TEXT: "姑娘，这么晚，去哪儿？" });
    const second = renderTemplate(TEMPLATE_PATH, { ...BASE_PARAMS, TEXT: "终点站早就没人了。" });
    assert.equal(first["2"].inputs.speaker, second["2"].inputs.speaker);
    assert.equal(first["2"].inputs.instruct, second["2"].inputs.instruct);
    assert.equal(first["2"].inputs.language, second["2"].inputs.language);
    assert.notEqual(first["2"].inputs.text, second["2"].inputs.text);
});

test("不同角色 → 不同 speaker/instruct，两条对白拿到不同音色", () => {
    const laozhou = renderTemplate(TEMPLATE_PATH, BASE_PARAMS);
    const girl = renderTemplate(TEMPLATE_PATH, {
        ...BASE_PARAMS,
        TEXT: "终点站。",
        SPEAKER: "Serena",
        INSTRUCT: "年轻女孩，声音轻柔微弱，语速慢，犹豫",
        OUTPUT_PREFIX: "canvas/tts_girl",
    });
    assert.notEqual(laozhou["2"].inputs.speaker, girl["2"].inputs.speaker);
    assert.notEqual(laozhou["2"].inputs.instruct, girl["2"].inputs.instruct);
});

// ── 5. 与能力路由协作：不需要参考图时判可用 ────────────────────────────────────
test("resolveToolForShot：音频模板无需参考图即可判 ok", () => {
    const catalog = scanTemplateDir(WORKFLOWS_DIR);
    const verdict = resolveToolForShot({ template: TEMPLATE, needReferenceImages: 0, catalog });
    assert.equal(verdict.ok, true);
});

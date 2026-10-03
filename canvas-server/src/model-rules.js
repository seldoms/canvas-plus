/**
 * 模型提示词规则层（Model Prompt Rules）—— 按「用户所选模型」取该模型的提示词标准。
 *
 * 背景（产品定调）：不论用户在前端如何配置情节，选定模型发起生成时，后端必须**按该模型的标准**
 * 写提示词再发给模型接口。本模块是该标准在后端的**只读查询层**：
 *   1. `loadModelRules()` 读 `canvas-server/config/model-prompt-rules.json`
 *      —— 该文件是 `research/win147-comfyui/registry.json`（win147 调研）的逐项后端副本；
 *   2. `rulesForTemplate()` 把后端模板名（img_qwen21_t2i / video_h3_i2v …）映射到规则键；
 *   3. `languagePolicy` / `negativePolicy` / `textInImageRule` / `presetFor` 便捷取用；
 *   4. H3 的两种提示词口径（本地字段口径 / 云端中文三段式）以数据形式暴露，标明本地默认。
 *
 * 纯查询层：只读文件、无网络、无启动副作用。文件缺失/损坏 → 空规则表 + warning，**绝不抛**。
 * 规则权威源是调研，修改规则需先改 `research/win147-comfyui/registry.json` 再重建本 json
 * （见 `config/model-prompt-rules.json` 头部 `_readme`）。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * serverRoot = canvas-server/。
 * 刻意不 import `config.js`：它 `import` 时就执行 `loadConfig()`（mkdir data/ 等副作用），
 * 纯规则查询层不需要；这里用与 config.js 完全相同的表达式，避免耦合。
 */
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 默认规则表路径：`canvas-server/config/model-prompt-rules.json`。 */
export const DEFAULT_RULES_FILE = resolve(serverRoot, "config", "model-prompt-rules.json");

/**
 * 模板名 → 规则键（registry key）映射。
 * **直接照搬调研给定的映射表，不自己猜**；未登记的后端模板（如 `audio_qwen3_tts`）走通用兜底，回 null。
 */
export const TEMPLATE_RULE_KEYS = Object.freeze({
    img_qwen21_t2i: "qwen_image_2_1",
    img_qwen21_edit: "qwen_image_2_1",
    img_flux_artistic: "flux1_dev",
    img_krea2_artistic: "krea2_turbo",
    img_zimage_artistic: "z_image_turbo",
    img_boogu_outfit_edit: "boogu_edit",
    scail2_action_transfer: "scail2",
    upscale_4x: "upscale_4x_ultrasharp",
    video_h3_i2v: "minimax_h3",
    video_h3_i2v_fl: "minimax_h3",
    video_h3_talk: "minimax_h3",
    video_h3_ref2v: "minimax_h3",
    video_h3_ref2v_image: "minimax_h3",
    video_h3_ref2v_image_turbo: "minimax_h3",
    video_h3_quantfunc_ref2v: "minimax_h3",
    video_minimax_h3_t2v: "minimax_h3",
    video_wan_animate: "wan22_animate",
});

/** 预设档位合法取值。 */
const PRESET_MODES = Object.freeze(["speed", "quality"]);

/** 按路径缓存解析结果（规则表是只读常量，读一次即可）；测试可传 `{ force: true }` 绕过。 */
const CACHE = new Map();

function emptyRules(warning = null) {
    return {
        models: {},
        machine: null,
        not_recommended: [],
        rewriter_assets: [],
        h3_prompt_protocols: null,
        prompt_tier_policy: null,
        warning,
    };
}

function readRulesFile(file) {
    if (!file || !existsSync(file)) {
        const warning = `model-prompt-rules.json 缺失，按空规则表处理：${file}`;
        console.warn(`[model-rules] ${warning}`);
        return emptyRules(warning);
    }
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        const models = raw && typeof raw.models === "object" && !Array.isArray(raw.models) ? raw.models : {};
        return {
            models,
            machine: raw?.machine ?? null,
            not_recommended: Array.isArray(raw?.not_recommended) ? raw.not_recommended : [],
            rewriter_assets: Array.isArray(raw?.rewriter_assets) ? raw.rewriter_assets : [],
            h3_prompt_protocols: raw?.h3_prompt_protocols ?? null,
            prompt_tier_policy: raw?.prompt_tier_policy ?? null,
            warning: null,
        };
    } catch (error) {
        const warning = `model-prompt-rules.json 损坏，按空规则表处理：${file}（${error.message}）`;
        console.warn(`[model-rules] ${warning}`);
        return emptyRules(warning);
    }
}

/**
 * 加载模型提示词规则表。
 * 文件缺失/损坏 → 空表 + `warning`，**不抛异常**（调用方按「无规则、走通用兜底」处理）。
 * @param {{ file?: string, force?: boolean }} [options] file：自定义路径（测试/多环境）；force：跳缓存。
 * @returns {{ models: Record<string, object>, machine: object|null, not_recommended: object[],
 *             rewriter_assets: object[], h3_prompt_protocols: object|null, warning: string|null }}
 */
export function loadModelRules(options = {}) {
    const file = options?.file ? resolve(String(options.file)) : DEFAULT_RULES_FILE;
    if (!options?.force && CACHE.has(file)) return CACHE.get(file);
    const result = readRulesFile(file);
    CACHE.set(file, result);
    return result;
}

/** 清空内部缓存（测试用；不改动磁盘）。 */
export function clearModelRulesCache() {
    CACHE.clear();
}

/** 模板名 → 规则键；未映射（或空名）回 null（= 无规则，走通用兜底）。 */
export function ruleKeyForTemplate(templateName) {
    const name = String(templateName ?? "").trim();
    if (!name) return null;
    return TEMPLATE_RULE_KEYS[name] ?? null;
}

/**
 * 取某后端模板的完整规则。
 * @returns {null | { key: string, label: string, instance: number, scenarios: string[],
 *   license?: string, weights: object, nodes?: string[], prompt: object, limits: object,
 *   presets: object, workflow: string|null, upgrade?: object, pitfalls: string[] }}
 *   未映射模板 / 规则表缺该键 → null。
 */
export function rulesForTemplate(templateName, options = {}) {
    const key = ruleKeyForTemplate(templateName);
    if (!key) return null;
    const { models } = loadModelRules(options);
    const rule = models?.[key];
    if (!rule || typeof rule !== "object") return null;
    return { key, ...rule };
}

/** 语言策略：`{ input_language, translate_to, translate_note }`；无规则回 null。 */
export function languagePolicy(templateName, options = {}) {
    const rule = rulesForTemplate(templateName, options);
    if (!rule?.prompt) return null;
    const { prompt } = rule;
    return {
        input_language: prompt.input_language ?? null,
        translate_to: prompt.translate_to ?? null,
        translate_note: prompt.translate_note ?? null,
    };
}

/** 负面提示词策略：`{ negative, negative_default, negative_note }`；无规则回 null。 */
export function negativePolicy(templateName, options = {}) {
    const rule = rulesForTemplate(templateName, options);
    if (!rule?.prompt) return null;
    const { prompt } = rule;
    return {
        negative: prompt.negative ?? null,
        negative_default: prompt.negative_default ?? null,
        negative_note: prompt.negative_note ?? null,
    };
}

/** 画面内文字规则（字符串）；无规则或规则未定义回 null。 */
export function textInImageRule(templateName, options = {}) {
    const rule = rulesForTemplate(templateName, options);
    return rule?.prompt ? (rule.prompt.text_in_image ?? null) : null;
}

/**
 * 取采样预设。
 * @param {string} templateName
 * @param {"speed"|"quality"} [mode] 档位；非法/缺省时按 speed。
 * @returns {object|null} 预设对象；无规则 / 无该档回 null。
 */
export function presetFor(templateName, mode = "speed", options = {}) {
    const rule = rulesForTemplate(templateName, options);
    if (!rule?.presets || typeof rule.presets !== "object") return null;
    const wanted = String(mode ?? "").trim() || "speed";
    if (!PRESET_MODES.includes(wanted)) return null;
    const preset = rule.presets[wanted];
    return preset && typeof preset === "object" ? preset : null;
}

/** 分辨率/时长等硬限制对象；无规则回 null。 */
export function limitsFor(templateName, options = {}) {
    const rule = rulesForTemplate(templateName, options);
    return rule?.limits ?? null;
}

/** 坑清单（字符串数组）；无规则回空数组。 */
export function pitfallsFor(templateName, options = {}) {
    const rule = rulesForTemplate(templateName, options);
    return Array.isArray(rule?.pitfalls) ? rule.pitfalls : [];
}

/**
 * H3 双口径（原样数据）：`{ default, note, local_fields, cloud_manual_markdown }`。
 * `default === "local_fields"` 表示本地默认走字段口径（依据 sources/video-models.md:149-165）。
 * 规则表缺失回 null。
 */
export function h3PromptProtocols(options = {}) {
    return loadModelRules(options).h3_prompt_protocols ?? null;
}

/**
 * H3 当前默认口径的展开对象：`{ name, ...protocol }`，name 取 `h3PromptProtocols().default`。
 * 无数据回 null。
 */
export function h3DefaultProtocol(options = {}) {
    const protocols = h3PromptProtocols(options);
    if (!protocols) return null;
    const name = protocols.default;
    if (!name) return null;
    const protocol = protocols[name];
    return protocol && typeof protocol === "object" ? { name, ...protocol } : { name };
}

/**
 * 分级口径（原样数据）：`{ _readme, tier_one, tier_two, rewritable_models, conflict_policy }`。
 * 一级=强约束（编译器直拼、不进改写器），二级=画面细节（可改写）。规则表缺失回 null。
 * 权威实现仍在 `src/prompt-compiler.js`；本项只是数据化登记，供查询层/前端展示与对账。
 */
export function promptTierPolicy(options = {}) {
    return loadModelRules(options).prompt_tier_policy ?? null;
}

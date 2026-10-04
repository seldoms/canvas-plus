/**
 * 台词归属模型能力元数据（Dialogue Attribution Capabilities）—— 「各模型如何表达台词归属」的唯一事实源。
 *
 * 立身之本（产品负责人原话，2026-10-04）：
 *   「角色的台词归属在不同模型里面是如何定义的，你按这个思路来啊，发起相关流程就自动调用 skill 进行最终提示词生产」
 *   即：**台词归属的口径跟着模型走**，是模型的能力元数据（服务端唯一持有），不是内容层拍脑袋写死的。
 *
 * 这照 `durations.js`（时长档位）/ `sizes.js`（画幅档位）的**现成套路**做：
 *   模板名 --ruleKeyForTemplate--> registry 模型键 --> 本模块登记该模型的「台词归属表示法」。
 *   `providers/comfy.js` 的 `listTemplates()` 会把本模块的 `dialogueMetaForTemplate()` 挂到模板清单上，
 *   于是 `GET /api/providers` 的 `comfy.templates[].dialogueMeta` 就是本口径的接口出口 —— 前端只读，绝不硬编码。
 *
 * 三类口径（调研依据 research/win147-comfyui 与 config/model-prompt-rules.json）：
 *   · minimax_h3        —— 原生音视频联合模型：说话人用**稳定 ID `(S1)(S2)`**（同一角色跨镜同 ID），
 *                          台词正文包在 **`<d>[English] …</d>`** 内逐字不译；括号表演注解剥出 <d> 落到描述层。
 *                          渲染实现**复用 prompt-compiler.js 的 h3DialogueSentence**，本模块只登记口径、不另创一套。
 *   · qwen3_tts（TTS）  —— **没有「谁说的」概念**：只吃「文本 + 命名音色枚举 `SPEAKER` + 音色描述 `INSTRUCT`」。
 *                          台词归属在内容层解成「这条台词属于哪个角色」，后端在发起生成时把该角色的
 *                          VoiceProfile 映射成 SPEAKER/INSTRUCT；同一角色跨镜共用同一 VoiceProfile → 音色一致。
 *   · 纯生视频 / 生图   —— **不承载台词归属**（对白/旁白走独立配音轨 + 字幕，与画面分开生产）。
 *                          未登记 / 未映射的模板一律 `mode: "none"`（对白不由该模型承载）。
 *
 * 纯查询层：只读 `model-rules.js` 的映射表，无网络、无磁盘、无启动副作用。
 */

import { ruleKeyForTemplate } from "./model-rules.js";

/** 合法的台词归属口径。 */
export const DIALOGUE_MODES = Object.freeze(["speaker_id_block", "voice_enum", "none"]);

/**
 * 未在 `model-rules.TEMPLATE_RULE_KEYS` 登记映射的后端模板 → 台词归属键。
 * （TTS 模板不进图片/视频规则表，故单独登记；命名与 registry 模型键风格一致。）
 */
export const TEMPLATE_DIALOGUE_KEYS = Object.freeze({
    audio_qwen3_tts: "qwen3_tts",
});

/** 纯生视频 / 生图 / 改图 / 超分：不承载台词归属（对白走独立配音轨 + 字幕）。 */
const noneEntry = (label) => ({
    mode: "none",
    verified: true,
    note: `${label}：不承载台词归属（对白/旁白由独立配音轨 + 字幕承载，与画面分开生产）`,
});

/**
 * 台词归属登记表。key 是 registry 模型键（与 sizes.js 的 SIZE_CATALOG 同源口径）。
 *   mode:               "speaker_id_block" | "voice_enum" | "none"
 *   speakerIdStyle:     speaker_id_block 专用：说话人 ID 的写法（"paren" = (S1)）
 *   stableIds:          是否要求同一角色跨镜保持同 ID（H3 官方要求 true）
 *   utteranceTag:       台词正文包裹标签（H3 = "d" → <d>…</d>）
 *   utteranceLangTag:   台词正文语言标签（H3 = "English"，正文逐字不译）
 *   performanceSink:    括号表演注解落到哪里（H3 = integrated_multimodal_description）
 *   speakerField:       voice_enum 专用：命名音色字段名（TTS = "SPEAKER"）
 *   instructField:      voice_enum 专用：音色描述字段名（TTS = "INSTRUCT"）
 *   verified:           是否已一手查证（不许拍脑袋登记）
 *   note:               口径说明，供接口与前端展示
 */
export const DIALOGUE_CATALOG = Object.freeze({
    // —— 原生音视频联合模型：说话人稳定 ID + <d> 逐字台词 ——
    minimax_h3: {
        mode: "speaker_id_block",
        speakerIdStyle: "paren",
        stableIds: true,
        utteranceTag: "d",
        utteranceLangTag: "English",
        performanceSink: "integrated_multimodal_description",
        verified: true,
        note: "H3 原生音视频联合模型：说话人用稳定 ID (S1)(S2)（同一角色跨镜同 ID），台词正文包在 <d>[English] …</d> 内逐字不译；括号表演注解剥出 <d> 落到描述层。",
    },

    // —— TTS：没有「谁说的」，只有命名音色 + 音色描述 ——
    qwen3_tts: {
        mode: "voice_enum",
        speakerField: "SPEAKER",
        instructField: "INSTRUCT",
        stableIds: false,
        verified: true,
        note: "TTS 没有「谁说的」概念：只吃「文本 + 命名音色枚举 SPEAKER + 音色描述 INSTRUCT」。台词归属在内容层解成「这条台词属于哪个角色」，后端在发起生成时把该角色的 VoiceProfile 映射成 SPEAKER/INSTRUCT；同一角色跨镜共用同一 VoiceProfile → 音色一致。",
    },

    // —— 纯生视频：不承载台词归属 ——
    wan21_t2v: noneEntry("Wan 2.1 文生视频"),
    wan22_animate: noneEntry("Wan 2.2 Animate 驱动生视频"),
    scail2: noneEntry("SCAIL-2 姿态驱动生视频"),
    ltx23: noneEntry("LTX 2.3 生视频"),

    // —— 生图 / 改图 / 超分：不承载台词归属 ——
    qwen_image: noneEntry("Qwen-Image 生图"),
    qwen_image_2_1: noneEntry("Qwen-Image 2.1 生图"),
    krea2_turbo: noneEntry("Krea 2 Turbo 生图"),
    flux1_dev: noneEntry("FLUX.1 生图"),
    z_image_turbo: noneEntry("Z-Image Turbo 生图"),
    boogu_edit: noneEntry("Boogu 改图"),
    qwen_image_edit_2509: noneEntry("Qwen-Image Edit 改图"),
    upscale_4x_ultrasharp: noneEntry("4 倍超分"),
});

/**
 * 后端模板名 → 台词归属键。
 * 先走 `model-rules` 的官方映射（图片/视频），再走本模块为 TTS 等登记的后备映射；都没有回 null。
 * @param {string} name 后端模板名
 * @returns {string|null}
 */
export function dialogueKeyForTemplate(name) {
    const key = ruleKeyForTemplate(name);
    if (key) return key;
    const name2 = String(name ?? "").trim();
    return name2 ? (TEMPLATE_DIALOGUE_KEYS[name2] ?? null) : null;
}

/**
 * 取模板的台词归属元数据（接口与前端消费的形状）。与 durationMetaForTemplate / sizeMetaForTemplate 同构。
 * 永远返回一个对象，调用方不必判空；未登记 / 未映射 → `mode: "none"`。
 * @param {string} name 后端模板名
 */
export function dialogueMetaForTemplate(name) {
    const key = dialogueKeyForTemplate(name);
    const entry = key ? DIALOGUE_CATALOG[key] : null;
    return {
        model: key || null,
        mode: entry?.mode || "none",
        speakerIdStyle: entry?.speakerIdStyle ?? null,
        stableIds: Boolean(entry?.stableIds),
        utteranceTag: entry?.utteranceTag ?? null,
        utteranceLangTag: entry?.utteranceLangTag ?? null,
        performanceSink: entry?.performanceSink ?? null,
        speakerField: entry?.speakerField ?? null,
        instructField: entry?.instructField ?? null,
        verified: Boolean(entry?.verified),
        note:
            entry?.note ||
            "该模板未登记台词归属口径：不承载台词（对白/旁白由独立配音轨 + 字幕承载），或待查证。",
    };
}

/** 模板的台词归属口径（"speaker_id_block" | "voice_enum" | "none"）。 */
export function dialogueModeForTemplate(name) {
    return dialogueMetaForTemplate(name).mode;
}

/** 该模板是否承载「台词归属」（H3 / TTS 为 true，纯视频/生图为 false）。 */
export function templateCarriesDialogue(name) {
    return dialogueModeForTemplate(name) !== "none";
}

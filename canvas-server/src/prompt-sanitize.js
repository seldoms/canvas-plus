/**
 * 提交前提示词净化 —— 剥掉「没被解析掉的画布节点引用」。
 *
 * 背景（2026-10-05 实测）：画布节点的生成请求会把**未解析的节点引用 token** 和**节点显示标签**
 * 一起塞进 params.PROMPT，实测提交给 ComfyUI 的原文长这样：
 *
 *     @[node:txt-sc-hotel-signin]
 *
 *     【文本1】
 *     电影感写实摄影，……（用户写的提示词）
 *
 * `@[node:...]` 与 `【文本1】` 都是**给人/前端看的引用语法**，不是画面事实。它们一旦进正向提示词，
 * 文生图模型就会照着把这些字符画成字形（实测招牌上出现「号晨贸沃置宁小低方」这类伪字）。
 *
 * 本模块只做一件事：把这类引用语法从提示词里剥掉。**纯函数、不读盘、不发请求**。
 * 与 workbench-jobs.js 里「前端漏剥 `渠道id::` 前缀」的兜底同一口径：旧版前端产物不能拖垮整条链路。
 */

/** 未解析的节点引用 token：`@[node:<id>]`（兼容 id 里出现任意非 `]` 字符）。 */
const NODE_REF_TOKEN = /@\[node:[^\]]*\]/g;

/** 节点显示标签：`【文本1】` / `【图片2】` / `【视频1】` / `【音频1】` / `【节点1】` / `【分组1】`。 */
const NODE_LABEL = /【(?:文本|图片|视频|音频|节点|分组)\s*\d*】/g;

/**
 * 剥离提示词里的节点引用语法与多余空白。
 * @param {unknown} raw 原始提示词
 * @returns {string} 净化后的提示词（绝不返回 undefined）
 */
export function sanitizePrompt(raw) {
    return String(raw ?? "")
        .replace(NODE_REF_TOKEN, " ")
        .replace(NODE_LABEL, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * 提示词里是否还残留节点引用语法（供测试与排查断言）。
 * 注意：上面两个正则带 `g` 标志，`test()` 会带 lastIndex 状态 —— 这里用无状态副本，避免误判。
 */
export function hasNodeReference(raw) {
    const text = String(raw ?? "");
    return /@\[node:[^\]]*\]/.test(text) || /【(?:文本|图片|视频|音频|节点|分组)\s*\d*】/.test(text);
}

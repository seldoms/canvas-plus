/**
 * 模型分辨率/画幅档位（Size Tiers）—— 「画幅口径跟着模型建议尺寸走」的唯一事实源。
 *
 * 产品口径（产品负责人原话，2026-10-04）：
 *   「画幅口径跟模型建议尺寸走啊，做成可选项，选模型，再选规格」
 *   分辨率/画幅是**模型的能力元数据**，不是用户自由填的数字。每个模型自带一组官方建议规格，
 *   选了模型就只能从它的规格里选；前端只读，绝不硬编码。
 *
 * 权威数据源（**只读，不许改**）：`research/win147-comfyui/registry.json` → `models.<key>.limits.resolutions`。
 *   本文件是它的逐模型**后端副本解析层** —— 与 model-rules.js 同源：模板名经 `ruleKeyForTemplate`
 *   映射到 registry 模型键，再取本模块按 registry 登记的结构化规格。每条规格标注证据等级：
 *     - `official`：registry 里**直接写明**的像素（如 H3 竖屏 768x1344 / 16:9=1344x768；qwen_image_2_1 7 档）。
 *     - `measured`：registry 里写明「社区实测」的像素（如 z_image_turbo 2048x2048）。
 *     - `derived` ：registry 只给了**区间/档位名/比例**（如 krea2 1K~2K 区间、boogu 1K/1.5K/2K 档位、
 *                  H3 的 21:9/4:3/1:1/3:4 比例），按官方规则（短边/档位像素 + 对齐）推导，非凭空捏造。
 *   **未查证**（`limits.resolutions` 为 null，如 ltx23）→ 规格给 null + `verified:false`，前端只展示
 *   「待查证」，**不允许自由填**（与 durations.js 的 D1 口径完全一致）。
 *
 * ⚠️ 关键修复（pilot-issues #77）：片段尺寸此前由 pipeline 的 `dimensionsForRatio("9:16", 768)`
 *   实时按比例推导 → **768x1376**（官方**没有**这一档）→ 拼接时被二次重采样。
 *   现在片段/关键帧/成片尺寸一律经本模块的 `sizeForRatio` 从登记表取（H3 竖屏 = 官方 768x1344）。
 *   ⚠️ 未登记规格的模板（测试桩 img-test / 未查证模型）才回落到旧的按比例推导，保证不臆造官方档位。
 */

// 模板名 → registry 模型键（复用 model-rules 已冻结的映射表，不另起一套）。
import { ruleKeyForTemplate } from "./model-rules.js";

/** 规格登记的像素比例口径（画幅字符串，如 "9:16"）。 */
export const RATIO_RE = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/;

/** 规格 id / 展示值：`WxH`（与前端 config.size、workbench-jobs.parseSize 一致）。 */
export const sizeId = (width, height) => `${width}x${height}`;

/**
 * 模型键 → 规格登记表。key 是 registry 的模型键（不是后端模板名）。
 *   sizes:    官方建议规格数组 `{ width, height, ratio, source }`；**null = 未查证**（前端只展示「待查证」）。
 *   default:  该模型的默认规格（画幅匹配不到时回落的目标）。
 *   verified: 是否已一手查证（不许拍脑袋登记）。
 *   align:    官方对齐口径（32/16），供展示与推导说明。
 *   mode:     "select"（可选规格）/ "scale"（无独立规格，随输入缩放）/ "none"（无画面规格）。
 *   note:     查证口径 / 说明，供接口与前端展示。
 */
export const SIZE_CATALOG = Object.freeze({
    // —— 生图 ——（research/win147-comfyui/registry.json → models.<key>.limits.resolutions）
    qwen_image: {
        sizes: [
            { width: 1328, height: 1328, ratio: "1:1", source: "official" },
            { width: 1664, height: 928, ratio: "16:9", source: "official" },
            { width: 928, height: 1664, ratio: "9:16", source: "official" },
            { width: 1472, height: 1104, ratio: "4:3", source: "official" },
            { width: 1104, height: 1472, ratio: "3:4", source: "official" },
            { width: 1584, height: 1056, ratio: "3:2", source: "official" },
            { width: 1056, height: 1584, ratio: "2:3", source: "official" },
        ],
        default: "1328x1328",
        verified: true,
        align: 32,
        mode: "select",
        note: "官方 7 档约 1.3~1.7MP，32 对齐（registry qwen_image.limits.resolutions）",
    },
    qwen_image_2_1: {
        sizes: [
            { width: 2048, height: 2048, ratio: "1:1", source: "official" },
            { width: 2400, height: 1792, ratio: "4:3", source: "official" },
            { width: 1792, height: 2400, ratio: "3:4", source: "official" },
            { width: 2528, height: 1696, ratio: "3:2", source: "official" },
            { width: 1696, height: 2528, ratio: "2:3", source: "official" },
            { width: 2752, height: 1536, ratio: "16:9", source: "official" },
            { width: 1536, height: 2752, ratio: "9:16", source: "official" },
        ],
        default: "2048x2048",
        verified: true,
        align: 32,
        mode: "select",
        note: "官方 7 档 max 2K，32 对齐（registry qwen_image_2_1.limits.resolutions）",
    },
    krea2_turbo: {
        sizes: [
            { width: 1024, height: 1024, ratio: "1:1", source: "official" },
            { width: 2048, height: 2048, ratio: "1:1", source: "official" },
            { width: 1344, height: 768, ratio: "16:9", source: "derived" },
            { width: 768, height: 1344, ratio: "9:16", source: "derived" },
            { width: 1216, height: 832, ratio: "3:2", source: "derived" },
            { width: 832, height: 1216, ratio: "2:3", source: "derived" },
            { width: 1152, height: 896, ratio: "4:3", source: "derived" },
            { width: 896, height: 1152, ratio: "3:4", source: "derived" },
            { width: 1792, height: 768, ratio: "21:9", source: "derived" },
        ],
        default: "1024x1024",
        verified: true,
        align: 16,
        mode: "select",
        note: "官方 1K~2K 区间任选、自动 pad 到 16 倍数；比例档按官方区间推导（registry krea2_turbo.limits.resolutions）",
    },
    flux1_dev: {
        sizes: [
            { width: 1024, height: 1024, ratio: "1:1", source: "official" },
            { width: 1024, height: 768, ratio: "4:3", source: "official" },
            { width: 1344, height: 768, ratio: "16:9", source: "derived" },
            { width: 768, height: 1344, ratio: "9:16", source: "derived" },
            { width: 1216, height: 832, ratio: "3:2", source: "derived" },
            { width: 832, height: 1216, ratio: "2:3", source: "derived" },
            { width: 896, height: 1152, ratio: "3:4", source: "derived" },
            { width: 1792, height: 768, ratio: "21:9", source: "derived" },
        ],
        default: "1024x1024",
        verified: true,
        align: 32,
        mode: "select",
        note: "官方 256~1440 区间，默认 1024x1024（BFL API 默认 1024x768），32 对齐（registry flux1_dev.limits.resolutions）",
    },
    z_image_turbo: {
        sizes: [
            { width: 1024, height: 1024, ratio: "1:1", source: "official" },
            { width: 2048, height: 2048, ratio: "1:1", source: "measured" },
        ],
        default: "1024x1024",
        verified: true,
        align: 32,
        mode: "select",
        note: "官方示例 1024x1024；社区实测原生到 2048x2048（registry z_image_turbo.limits.resolutions）",
    },
    boogu_edit: {
        // 官方档位名 1K/1.5K/2K × 官方比例矩阵；像素按档位短边 + 32 对齐推导（registry 只给了档位名与比例）。
        sizes: [
            { width: 1024, height: 1024, ratio: "1:1", source: "derived" },
            { width: 768, height: 1152, ratio: "2:3", source: "derived" },
            { width: 1152, height: 768, ratio: "3:2", source: "derived" },
            { width: 768, height: 1024, ratio: "3:4", source: "derived" },
            { width: 1024, height: 768, ratio: "4:3", source: "derived" },
            { width: 512, height: 1024, ratio: "1:2", source: "derived" },
            { width: 1024, height: 512, ratio: "2:1", source: "derived" },
            { width: 576, height: 1024, ratio: "9:16", source: "derived" },
            { width: 1024, height: 576, ratio: "16:9", source: "derived" },
            { width: 1536, height: 1536, ratio: "1:1", source: "derived" },
            { width: 2048, height: 2048, ratio: "1:1", source: "derived" },
        ],
        default: "1024x1024",
        verified: true,
        align: null,
        mode: "select",
        note: "官方档位 1K/1.5K/2K + 比例矩阵（1:1 2:3 3:2 3:4 4:3 1:2 2:1 9:16 16:9）；Edit 输出比例跟随输入图（registry boogu_edit.limits.resolutions）",
    },
    qwen_image_edit_2509: {
        sizes: null,
        default: null,
        verified: false,
        align: null,
        mode: "none",
        note: "编辑模型官方未列独立分辨率（输出跟随输入图缩放），无规格可选 —— 待查证",
    },

    // —— 生视频 ——
    wan21_t2v: {
        sizes: [
            { width: 1280, height: 720, ratio: "16:9", source: "official" },
            { width: 832, height: 480, ratio: "16:9", source: "official" },
        ],
        default: "1280x720",
        verified: true,
        align: null,
        mode: "select",
        note: "官方 832x480 / 1280x720；1.3B 只支持 480P（registry wan21_t2v.limits.resolutions）",
    },
    wan22_animate: {
        sizes: [
            { width: 1280, height: 720, ratio: "16:9", source: "official" },
            { width: 720, height: 1280, ratio: "9:16", source: "derived" },
        ],
        default: "1280x720",
        verified: true,
        align: 16,
        mode: "select",
        note: "预处理按面积 1280x720，宽高必须 16 倍数（registry wan22_animate.limits.resolutions）",
    },
    scail2: {
        sizes: [
            { width: 704, height: 1280, ratio: "9:16", source: "official" },
            { width: 1280, height: 704, ratio: "16:9", source: "derived" },
        ],
        default: "704x1280",
        verified: true,
        align: 32,
        mode: "select",
        note: "官方 512p / 704p（姿态驱动更好，如 704x1280），32 对齐（registry scail2.limits.resolutions）",
    },
    minimax_h3: {
        // 短边 768 原生（16:9=1344x768）；竖屏 480x832 / 768x1344；align 32；ratios 21:9 16:9 4:3 1:1 3:4 9:16。
        sizes: [
            { width: 768, height: 1344, ratio: "9:16", source: "official" },
            { width: 1344, height: 768, ratio: "16:9", source: "official" },
            { width: 480, height: 832, ratio: "9:16", source: "official" },
            { width: 1792, height: 768, ratio: "21:9", source: "derived" },
            { width: 1024, height: 768, ratio: "4:3", source: "derived" },
            { width: 768, height: 768, ratio: "1:1", source: "derived" },
            { width: 768, height: 1024, ratio: "3:4", source: "derived" },
        ],
        default: "768x1344",
        verified: true,
        align: 32,
        mode: "select",
        // ⚠️ 9:16 官方档是 768x1344（不是按比例推导的 768x1376）。
        note: "官方短边 768 原生（16:9=1344x768）、竖屏 480x832 / 768x1344，32 对齐（registry minimax_h3.limits.resolutions）",
    },
    ltx23: {
        sizes: null,
        default: null,
        verified: false,
        align: null,
        mode: "none",
        note: "官方分辨率未查证（registry ltx23.limits.resolutions=null）—— 待查证，暂不提供规格选择",
    },

    // —— 非「选规格」模型 ——
    upscale_4x_ultrasharp: {
        sizes: null,
        default: null,
        verified: true,
        align: null,
        mode: "scale",
        note: "4 倍放大：输出尺寸 = 输入 × 4，无独立规格可选",
    },
});

const isSizeTemplate = (name) => /^(img|video)[_-]/i.test(String(name ?? ""));

/**
 * 取模板的规格元数据（接口与前端消费的形状）。与 durationMetaForTemplate 完全同构。
 * 模板名经 ruleKeyForTemplate 映射到 registry 模型键；未映射 / 未登记的模板返回规格 null。
 * @param {string} name 后端模板名
 */
export function sizeMetaForTemplate(name) {
    const template = String(name ?? "").trim();
    const model = template ? ruleKeyForTemplate(template) : null;
    const entry = model ? SIZE_CATALOG[model] : null;
    const sizes = entry && Array.isArray(entry.sizes) ? entry.sizes.map((size) => ({ ...size, value: sizeId(size.width, size.height) })) : null;
    return {
        sizes,
        verified: Boolean(entry?.verified),
        model: model || null,
        default: entry && entry.default ? String(entry.default) : null,
        mode: entry?.mode || "none",
        align: entry?.align ?? null,
        note: entry?.note || (isSizeTemplate(template) ? "该模型未登记官方规格，待查证" : "非图像/视频模板，无画面规格"),
    };
}

/** 选定模板 → 可选规格数组（含 value=WxH）；未登记 / 无规格返回 null。 */
export function sizesForTemplate(name) {
    return sizeMetaForTemplate(name).sizes;
}

/** 归一化画幅字符串 "9:16" → "9:16"；非法返回 ""。 */
export function normalizeRatio(ratio) {
    const match = RATIO_RE.exec(String(ratio ?? "").trim());
    if (!match) return "";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0) || !(height > 0)) return "";
    return `${match[1]}:${match[2]}`;
}

/** 把像素值吸附到最近的 32 倍数（未登记规格的模板回落用；与 generate.js/pipeline 兜底同一口径）。 */
function snap32(value) {
    return Math.max(32, Math.round(Number(value) / 32) * 32);
}

/**
 * 「实时按比例推导」—— **仅用于未登记官方规格的模板的兜底**（如测试桩 / 未查证模型）。
 * ⚠️ 已登记官方规格的模板（H3 等）绝不走这里，否则又会算出官方没有的 768x1376。
 */
function ratioDimensions(ratio, base) {
    const wanted = normalizeRatio(ratio);
    if (!wanted) return null;
    const [w, h] = wanted.split(":").map(Number);
    const short = Math.max(32, Number(base) || 768);
    return { WIDTH: snap32(w >= h ? (short * w) / h : short), HEIGHT: snap32(h >= w ? (short * h) / w : short) };
}

/**
 * 按项目画幅取该模型的官方规格。**同族唯一取用口径**（片段 / 关键帧 / 成片都用它）。
 *
 * 规则：
 *   1. 已登记规格的模型：命中该画幅的官方档 → 用它（同一画幅有多档时优先 default 命中的那档）；
 *      匹配不到（或该档位列表里没有这个画幅）→ 回落该模型的 default，并记 `warning`。
 *      未请求画幅（ratio 为空）→ 直接用 default，不算回落、不告警。
 *   2. 未登记规格的模板（未查证模型 / 测试桩）：回落旧的按比例推导；无画幅则返回 null，
 *      由调用方回落到 config 默认宽高。
 *
 * @param {string} template 后端模板名
 * @param {string} ratio 项目画幅（如 "9:16"）
 * @param {{ base?: number }} [options] base：未登记规格时的短边基准
 * @returns {{width:number|null,height:number|null,size:string|null,ratio:string,source:string,matched:boolean,template:string,model:string|null,warning:string|null}}
 */
export function sizeForRatio(template, ratio, options = {}) {
    const wanted = normalizeRatio(ratio);
    const meta = sizeMetaForTemplate(template);
    const result = { width: null, height: null, size: null, ratio: wanted, source: null, matched: false, template: String(template ?? ""), model: meta.model, warning: null };

    if (meta.sizes && meta.sizes.length) {
        const byDefault = meta.sizes.find((size) => size.value === meta.default);
        const matchedSize = wanted ? meta.sizes.find((size) => size.ratio === wanted && size.value === meta.default) || meta.sizes.find((size) => size.ratio === wanted) : null;
        const hit = matchedSize || byDefault || meta.sizes[0];
        const matched = wanted ? Boolean(matchedSize) : true; // 未请求画幅 → 用 default 是预期行为，不算回落
        return {
            ...result,
            width: hit.width,
            height: hit.height,
            size: hit.value,
            ratio: hit.ratio,
            source: hit.source,
            matched,
            warning: matched ? null : `模型「${meta.model || template}」的官方规格里没有 ${wanted} 画幅，已回落默认 ${hit.value}`,
        };
    }

    // 未登记官方规格 → 旧的按比例推导兜底（不臆造官方档位）。
    const legacy = ratioDimensions(wanted, options.base);
    if (!legacy) return result;
    return { ...result, width: legacy.WIDTH, height: legacy.HEIGHT, size: sizeId(legacy.WIDTH, legacy.HEIGHT), source: "legacy", matched: true };
}

/**
 * 所选规格是否属于该模板的官方规格集合（后端校验入口）。
 * 规格未查证 / 模板无规格 → false（「所选规格必须属于该集合」，未查证就不能声称它合法）。
 * @param {string} name 模板名
 * @param {string} value 规格值 "WxH"
 */
export function isSizeAllowed(name, value) {
    const sizes = sizesForTemplate(name);
    if (!sizes) return false;
    const wanted = String(value ?? "").trim().toLowerCase();
    return sizes.some((size) => size.value.toLowerCase() === wanted);
}

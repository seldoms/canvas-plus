/**
 * 生成参数能力校验（Capacity Guard）—— 在**发起生成请求那一刻**按所选模型的能力元数据校验
 * 像素上限 / 宽高是否在官方可选档 / 时长帧数是否合法，超限**当场返回可读错误**，
 * 不再让请求一路跑到 147 才在 `MiniMaxH3AudioConditioningT8` 抛 `execution_error`
 * （用户看到的是难懂的「模型调用脚本执行失败」）。
 *
 * 一手证据（147，2026-10-04，任务 video-mutm8c0y-mewdg / 模板 video_h3_i2v）：
 *   提交 WIDTH=2048 HEIGHT=2048（4,194,304 像素）时节点 MiniMaxH3AudioConditioningT8 抛 ValueError：
 *     "Requested canvas has 4,194,304 pixels and exceeds the configured MiniMax H3 2.0MP cap
 *      of 2,088,960 pixels (1920x1088); reduce width/height"
 *   → 上限 2,088,960 像素（1920x1088）**登记在 sizes.js 的 SIZE_CATALOG[].maxPixels**（不止注释）。
 *
 * 设计口径：
 *   - **不许静默放过**：任一校验不过 → 返回可读 error，调用方原样回 400。
 *   - **不许静默改参**：本模块只**判**不改；真正要吸附时调用方必须把「改成了什么」写进返回。
 *   - 未登记能力元数据的模板（未映射 / 测试桩）→ 不臆造、不校验（跳过）。
 *   - 三条校验（按模型能力元数据）：
 *       1. 像素上限：width × height > maxPixels → 拒（写清上限与当前值）。
 *       2. 宽高在档：模型有官方规格时，`WxH` 必须命中其中一档。
 *       3. 时长档位：模型有登记帧数档位时，LENGTH（帧）必须落在 17k+5 帧网格上。
 */

import { pixelCapForTemplate, sizeMetaForTemplate } from "./sizes.js";
import { durationsForTemplate } from "./durations.js";

const toPosInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** 像素数展示：4,194,304（与 147 报错原文同口径）。 */
const withThousands = (value) => Number(value).toLocaleString("en-US");

/**
 * 校验宽高：像素上限 + 是否在模型官方可选档内。
 * WIDTH/HEIGHT 任一缺失/非法 → 跳过（有些模板本就不吃 WIDTH/HEIGHT，不能误拦）。
 * @returns {{ok:boolean,error?:string,code?:string,details?:object}}
 */
export function validateSizeParams(name, params = {}) {
    const width = toPosInt(params?.WIDTH ?? params?.width);
    const height = toPosInt(params?.HEIGHT ?? params?.height);
    if (!width || !height) return { ok: true };

    const cap = pixelCapForTemplate(name);
    const meta = sizeMetaForTemplate(name);
    const pixels = width * height;
    const sizeValue = `${width}x${height}`;

    // 1) 像素上限（根治「跑到 147 才炸」的那条）。
    if (cap && pixels > cap.maxPixels) {
        const limit = cap.maxSize ? `${cap.maxSize}（${withThousands(cap.maxPixels)} 像素）` : `${withThousands(cap.maxPixels)} 像素`;
        return {
            ok: false,
            code: "size_over_pixel_cap",
            error: `该模型「${cap.model || name}」画面上限 ${limit}，当前 ${width}×${height} = ${withThousands(pixels)} 像素超了 ${withThousands(pixels - cap.maxPixels)} 像素，请换更小尺寸`,
            details: { model: cap.model || null, maxPixels: cap.maxPixels, maxSize: cap.maxSize, capSource: cap.source, width, height, pixels },
        };
    }

    // 2) 宽高必须在官方可选档内（模型登记了规格才校验）。
    //    只对**视频模板**强制：视频档位少且已一手查证，画布「参考生视频」是本次事故入口；
    //    生图工作台本就走「官方规格只读下拉」，其模型脚本另有历史档位口径，不在此处收紧以免误伤。
    const isVideo = /^video[_-]/i.test(String(name ?? ""));
    if (isVideo && meta.sizes && meta.sizes.length && !meta.sizes.some((size) => size.value === sizeValue)) {
        return {
            ok: false,
            code: "size_not_in_catalog",
            error: `尺寸 ${sizeValue} 不在模型「${meta.model || name}」的可选档内；可选：${meta.sizes.map((size) => `${size.value}(${size.ratio})`).join(" / ")}`,
            details: { model: meta.model || null, allowed: meta.sizes.map((size) => size.value) },
        };
    }

    return { ok: true };
}

/**
 * 校验时长帧数：模型有登记帧数档位时，LENGTH（帧）必须落在 17k+5 帧网格上。
 * LENGTH 缺失/非法 → 跳过（非视频模板 / 调用方未传帧数）。
 * @returns {{ok:boolean,error?:string,code?:string,details?:object}}
 */
export function validateDurationParams(name, params = {}) {
    const tiers = durationsForTemplate(name);
    if (!tiers || !tiers.length) return { ok: true };
    const length = toPosInt(params?.LENGTH ?? params?.length);
    if (!length) return { ok: true };
    // 17k+5 网格：与 durations.js 的帧数口径同源（官方工作流 Math Expression 的吸附网格）。
    const onGrid = length >= 5 && (length - 5) % 17 === 0;
    if (!onGrid) {
        return {
            ok: false,
            code: "length_off_frame_grid",
            error: `时长帧数 LENGTH=${length} 不在模型「${name}」的 17k+5 帧网格上（如 5s=124、10s=243、15s=362），请按模型档位给时长`,
            details: { template: name, length, tiers },
        };
    }
    return { ok: true };
}

/**
 * 提交前总校验：像素上限 / 宽高在档 / 时长帧数。任一条不过 → `{ok:false,error,code}`。
 * 调用方（发起生成请求那一刻）拿到 error 就原样回 400，不静默放过、不静默改参。
 * @param {string} name 后端模板名
 * @param {object} params 提交参数（含 WIDTH/HEIGHT/LENGTH）
 */
export function validateGenerationParams(name, params = {}) {
    const size = validateSizeParams(name, params);
    if (!size.ok) return size;
    const duration = validateDurationParams(name, params);
    if (!duration.ok) return duration;
    return { ok: true };
}

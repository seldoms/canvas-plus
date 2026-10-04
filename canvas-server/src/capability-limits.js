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
 *   - **不许静默放过**：连自适应都找不到合法档（模板无 sizes / 上限缺失）→ 返回可读 error，调用方原样回 400。
 *   - **自适应但不偷改**：本模块的 adapt* 把尺寸/时长吸附到模型合法档，并把「改成了什么」
 *     通过 sizeAdjust / durationAdjust 交回调用方写进该次任务留痕（界面不堆字，任务记录里查得到）。
 *   - 未登记能力元数据的模板（未映射 / 测试桩）→ 不臆造、不校验（跳过）。
 *   - 三条校验（按模型能力元数据）：
 *       1. 像素上限：width × height > maxPixels → 拒（写清上限与当前值）。
 *       2. 宽高在档：模型有官方规格时，`WxH` 必须命中其中一档。
 *       3. 时长档位：模型有登记帧数档位时，LENGTH（帧）必须落在 17k+5 帧网格上。
 */

import { normalizeRatio, pixelCapForTemplate, sizeMetaForTemplate } from "./sizes.js";
import { durationsForTemplate, frameCountForDuration } from "./durations.js";

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

// ————————————————————— 自适应（把「拒绝」换成「按模型能力自动吸附到合法档」）————————————————————

/**
 * 产品口径（2026-10-04 拍板）：
 *   「这个能不能自适应一下，只要方向对，分辨率该压缩的就压缩一下，该放大的就放大一下？」
 * 即：**不要「报错拒绝」，要「自动调整到合法档」** —— 把包袱从用户身上拿走。
 *   1. 从 WIDTH/HEIGHT 判方向/比例（16:9 / 9:16 / 1:1 / 21:9 / 4:3 / 3:4 …）；
 *   2. 在该模板合法档里找**同比例**的 → 挑「不超该模型像素上限前提下像素最大」的那档
 *      （**能放大就放大**把模型能力用满；超上限就压）；
 *   3. 没有严格同比例 → 挑**比例最接近**的（并列时取像素更大且不超上限的）；
 *   4. **不报错**，直接按调整后的尺寸继续。
 * 且**绝不静默偷改**：调整结果通过 `sizeAdjust` 交回调用方写进该次任务留痕。
 *
 * 兜底（**不许静默放过**）：模板无合法档 / 上限缺失 / 连一个不超上限的档都找不到
 *   → 回落既有的可读拒绝（validateSizeParams）。模板不吃 WIDTH/HEIGHT（缺参/非法）→ 原样放行。
 *
 * ⚠️ 已经是「合法档且不超上限」的尺寸**原样放行**，不因为「能放大」就偷偷改用户明确选的合法档
 *   （`1280x720` 不是 H3 的合法档，所以会走自适应放大成官方 16:9 的 `1344x768`；
 *    而用户明确选的 `1344x768` / `768x1344` 等合法档不会被改）。
 *
 * @param {string} name 后端模板名
 * @param {object} params 提交参数（含 WIDTH/HEIGHT）
 * @param {{sizes?:Array|null, cap?:object|null}} [options] 仅供测试注入临时能力元数据（模拟「无规格 / 缺上限」的模板）；生产调用不传。
 * @returns {{ok:true,params:object,sizeAdjust:object|null}|{ok:false,code:string,error:string,details?:object}}
 */
export function adaptSizeParams(name, params = {}, options = {}) {
    const width = toPosInt(params?.WIDTH ?? params?.width);
    const height = toPosInt(params?.HEIGHT ?? params?.height);
    // 缺参 / 非法（如 "auto"）→ 该模板本就不以 WIDTH/HEIGHT 驱动，原样放行、不臆改。
    if (!width || !height) return { ok: true, params: { ...params }, sizeAdjust: null };

    const meta = sizeMetaForTemplate(name);
    const cap = options.cap !== undefined ? options.cap : pixelCapForTemplate(name);
    const sizes = options.sizes !== undefined ? options.sizes : Array.isArray(meta.sizes) ? meta.sizes : null;
    const sizeValue = `${width}x${height}`;
    const withinCap = !cap || width * height <= cap.maxPixels;

    // 已是合法档且不超上限 → 原样放行（不偷改用户明确选的合法档）。
    if (sizes && sizes.some((size) => size.value === sizeValue) && withinCap) {
        return { ok: true, params: { ...params }, sizeAdjust: null };
    }

    // 兜底：模板无合法档 / 上限缺失 → 无法自适应 → 回落既有可读拒绝（不静默放过）。
    if (!sizes || !sizes.length || !cap) return fallbackSizeVerdict(name, params);

    // 只在上限内挑档（能放大就放大，但绝不挑超上限的）。
    const candidates = sizes.filter((size) => size.width * size.height <= cap.maxPixels);
    if (!candidates.length) return fallbackSizeVerdict(name, params);

    // ① 判方向/比例：W×H 约简成最简画幅（1920x1080 → 16:9，2048x2048 → 1:1）。
    const ratio = ratioOfSize(width, height);
    const wantedAspect = width / height;
    const aspectOf = (item) => {
        const value = aspectValue(item?.ratio);
        return value != null ? value : item && item.height > 0 ? item.width / item.height : null;
    };

    // ② 同比例档：画幅字符串相等，或数值比例相当（兼容 21:9/7:3 这类同值别名）。
    const sameRatio = candidates.filter((size) => {
        const label = normalizeRatio(size.ratio);
        if (label && ratio && label === ratio) return true;
        const aspect = aspectOf(size);
        return aspect != null && Math.abs(aspect - wantedAspect) <= 1e-6 * Math.max(1, Math.abs(aspect));
    });

    let chosen;
    let matchedSameRatio = true;
    if (sameRatio.length) {
        // 同比例里取像素最大的 → 把模型能力用满（能放大就放大；都超上限时已在上面过滤）。
        chosen = sameRatio.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
    } else {
        // ③ 无严格同比例 → 挑比例最接近的（并列取像素更大者）。
        matchedSameRatio = false;
        chosen = candidates
            .slice()
            .sort((a, b) => {
                const da = Math.abs((aspectOf(a) ?? Number.POSITIVE_INFINITY) - wantedAspect);
                const db = Math.abs((aspectOf(b) ?? Number.POSITIVE_INFINITY) - wantedAspect);
                if (Math.abs(da - db) > 1e-9) return da - db;
                return b.width * b.height - a.width * a.height;
            })[0];
    }

    const to = `${chosen.width}x${chosen.height}`;
    const capMp = `${(cap.maxPixels / (1024 * 1024)).toFixed(1)}MP`;
    const overCap = width * height > cap.maxPixels;
    const reasonParts = [overCap ? `超出该模型 ${capMp} 上限（${cap.maxSize || cap.maxPixels} 像素）` : `不在该模型可选档内`];
    reasonParts.push(matchedSameRatio ? `按 ${ratio} 比例吸附到合法档 ${to}` : `无 ${ratio} 同比例档，取比例最接近的 ${to}`);

    const adjusted = { ...params, WIDTH: chosen.width, HEIGHT: chosen.height };
    // 调用方若用小写 width/height，同步其口径，避免只改一半。
    if (params && Object.prototype.hasOwnProperty.call(params, "width")) adjusted.width = chosen.width;
    if (params && Object.prototype.hasOwnProperty.call(params, "height")) adjusted.height = chosen.height;

    return {
        ok: true,
        params: adjusted,
        sizeAdjust: { from: sizeValue, to, ratio, reason: reasonParts.join("；") },
        details: { model: cap.model || null, maxPixels: cap.maxPixels, maxSize: cap.maxSize || null, matchedSameRatio },
    };
}

/** 自适应失败的回落：直接跑既有校验，能过就放行、不过就原样回可读拒绝。 */
function fallbackSizeVerdict(name, params) {
    const verdict = validateSizeParams(name, params);
    if (!verdict.ok) return { ok: false, code: verdict.code, error: verdict.error, details: verdict.details };
    return { ok: true, params: { ...params }, sizeAdjust: null };
}

/**
 * 时长自适应：LENGTH（帧）不在 `17k+5` 网格上 → **向上吸附**（复用 durations.js 的既有口径，不另造）。
 * 超出该模型登记档位上限的帧数 → 吸附到**最大合法档**并留痕（给可读结果，不静默放过）。
 * LENGTH 缺失/非法、或该模型无登记档位 → 原样放行。
 * @returns {{ok:true,params:object,durationAdjust:object|null}}
 */
export function adaptDurationParams(name, params = {}) {
    const tiers = durationsForTemplate(name);
    const length = toPosInt(params?.LENGTH ?? params?.length);
    if (!tiers || !tiers.length || !length) return { ok: true, params: { ...params }, durationAdjust: null };

    const maxFrames = frameCountForDuration(Math.max(...tiers));
    const onGrid = length >= 5 && (length - 5) % 17 === 0;

    let target;
    let reason;
    if (onGrid && maxFrames && length > maxFrames) {
        // 在网格上但超过模型档位上限 → 吸附到最大合法档（可读结果，不静默放过）。
        target = maxFrames;
        reason = `时长 ${length} 帧超出模型档位上限（最长 ${Math.max(...tiers)}s = ${maxFrames} 帧），已吸附到最大合法档 ${maxFrames} 帧`;
    } else if (onGrid) {
        return { ok: true, params: { ...params }, durationAdjust: null };
    } else {
        // 不在 17k+5 网格 → 向上吸附（frameCountForDuration 的既有口径）。
        const snapped = frameCountForDuration(length / 24) ?? 17 * Math.max(0, Math.ceil((length - 5) / 17)) + 5;
        if (maxFrames && snapped > maxFrames) {
            target = maxFrames;
            reason = `时长 ${length} 帧超出模型档位上限（最长 ${Math.max(...tiers)}s = ${maxFrames} 帧），已吸附到最大合法档 ${maxFrames} 帧`;
        } else {
            target = snapped;
            reason = `时长 ${length} 帧不在 ${tiers.join("/")}s 的 17k+5 帧网格上，已向上吸附到 ${target} 帧`;
        }
    }

    const adjusted = { ...params, LENGTH: target };
    if (params && Object.prototype.hasOwnProperty.call(params, "length")) adjusted.length = target;
    return {
        ok: true,
        params: adjusted,
        durationAdjust: { from: length, to: target, grid: "17k+5@24fps", reason },
    };
}

/**
 * 提交前**自适应总入口**：先按模型合法档把 WIDTH/HEIGHT 吸附到「同比例、上限内像素最大」的档，
 * 再把 LENGTH 向上吸附到 17k+5 网格；任一环节连自适应都做不到 → 回落既有可读拒绝。
 * 调用方拿到 `ok:false` 就原样回 400；拿到 `ok:true` 就用 `params` 提交、把 `sizeAdjust/durationAdjust` 写进该次任务留痕。
 * @param {string} name 后端模板名
 * @param {object} params 提交参数
 * @param {{sizes?:Array|null, cap?:object|null}} [options] 仅供测试注入临时能力元数据；生产调用不传。
 * @returns {{ok:true,params:object,sizeAdjust:object|null,durationAdjust:object|null}|{ok:false,code?:string,error:string,details?:object}}
 */
export function adaptGenerationParams(name, params = {}, options = {}) {
    const size = adaptSizeParams(name, params, options);
    if (!size.ok) return { ok: false, code: size.code, error: size.error, details: size.details };
    const duration = adaptDurationParams(name, size.params);
    if (!duration.ok) return { ok: false, code: duration.code, error: duration.error, details: duration.details };
    return { ok: true, params: duration.params, sizeAdjust: size.sizeAdjust || null, durationAdjust: duration.durationAdjust || null };
}

/** 两正整数最大公约数（判画幅约简用）。 */
function gcd(a, b) {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y) [x, y] = [y, x % y];
    return x || 1;
}

/** W×H → 最简画幅字符串（1920x1080 → "16:9"，2048x2048 → "1:1"）；非法返回 ""。 */
export function ratioOfSize(width, height) {
    const w = toPosInt(width);
    const h = toPosInt(height);
    if (!w || !h) return "";
    const g = gcd(w, h);
    return `${w / g}:${h / g}`;
}

/** 画幅字符串 → 数值比例（"16:9" → 1.777…）；非法返回 null。 */
function aspectValue(ratio) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio ?? "").trim());
    if (!match) return null;
    const w = Number(match[1]);
    const h = Number(match[2]);
    return w > 0 && h > 0 ? w / h : null;
}

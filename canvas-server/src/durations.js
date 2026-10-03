/**
 * 模型时长档位（Duration Tiers）—— D1「时长锚点跟着模型走」的唯一事实源。
 *
 * 产品口径（docs/content/docs/progress/pilot-issues.md「产品负责人拍板（2026-10-03）」D1）：
 *   时长档位是**模型的能力元数据**，不是用户自由填的数字。每个模型自带一组相对固定的时长选项，
 *   选了模型就只能从它的档位里选；**先定时长骨架，再往骨架里填内容，Σ段时长必须等于骨架**。
 *
 * 与「模型清单」同源：模板清单（providers/comfy.js listTemplates）从这里取档位挂到每个模板上，
 * 于是 `GET /api/providers` 的 `comfy.templates[].durations` 就是档位的接口出口 —— 前端只读，
 * 绝不硬编码。
 *
 * 帧数口径：H3 原生 24fps，`帧数 = 24 × 秒 + 3`（5s→123、10s→243、15s→363）。
 * 注意：本模块的 frameCountForDuration 描述的是**模型声明的档位帧数**；实际提交 ComfyUI 的
 * `LENGTH` 仍由编排器按可接受的帧网格吸附（见 pipeline.js frameCountFor），两者口径不同、不可混用。
 */

/** H3 原生帧率。 */
export const MODEL_FRAME_RATE = 24;

/** 已一手查证的 H3 档位：只有 5 / 10 / 15 三档（pilot-issues.md D1）。 */
export const H3_DURATIONS = Object.freeze([5, 10, 15]);

/**
 * 档位帧数公式：`24 × 秒 + 3`。秒非法（非正数 / 非有限数）返回 null，调用方据此不展示帧数。
 * @param {number} seconds 时长（秒）
 * @param {number} [frameRate] 帧率，默认 24
 * @returns {number|null}
 */
export function frameCountForDuration(seconds, frameRate = MODEL_FRAME_RATE) {
    const sec = Number(seconds);
    const fps = Number(frameRate) > 0 ? Number(frameRate) : MODEL_FRAME_RATE;
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return Math.round(sec * fps) + 3;
}

/**
 * 模板名 → 档位登记表。
 *   durations: 秒档位数组；**null = 未查证**（前端只展示「待查证」，不允许自由填）。
 *   verified:  是否已一手查证（不许拍脑袋登记）。
 *   note:      查证口径 / 说明，供接口与前端展示。
 * H3 之外的模型（Wan / MiniMax 其他变体等）必须**逐个查证后**再补进来，查不到就保持 null。
 */
export const DURATION_CATALOG = Object.freeze({
    video_h3_i2v: { durations: H3_DURATIONS, verified: true, note: "H3 图生视频（I2V）" },
    video_h3_ref2v: { durations: H3_DURATIONS, verified: true, note: "H3 参考视频生视频" },
    video_h3_ref2v_image: { durations: H3_DURATIONS, verified: true, note: "H3 参考图生视频" },
    video_h3_ref2v_image_turbo: { durations: H3_DURATIONS, verified: true, note: "H3 参考图生视频（Turbo 8 步）" },
    video_h3_quantfunc_ref2v: { durations: H3_DURATIONS, verified: true, note: "H3 QuantFunc INT4 参考图生视频" },
    video_h3_talk: { durations: H3_DURATIONS, verified: true, note: "H3 台词对口型" },
    video_minimax_h3_t2v: { durations: H3_DURATIONS, verified: true, note: "MiniMax H3 文生视频" },
    // 非 H3 模型：官方档位待逐个查证后登记；在查证前一律 null —— 宁可标「待查证」，不许拍脑袋。
    video_wan_animate: { durations: null, verified: false, note: "Wan 动画驱动：官方时长档位待查证，暂不提供档位选择" },
});

const isVideoTemplate = (name) => /^video[_-]/i.test(String(name ?? ""));

/**
 * 取模板的档位元数据（接口与前端消费的形状）。未登记的 video 模板返回 durations:null + 待查证说明；
 * 非视频模板返回 durations:null + 无档位说明。永远返回一个对象，调用方不必判空。
 * @param {string} name 模板名
 */
export function durationMetaForTemplate(name) {
    const key = String(name ?? "").trim();
    const entry = key ? DURATION_CATALOG[key] : null;
    const durations = entry && Array.isArray(entry.durations) ? [...entry.durations] : null;
    return {
        durations,
        verified: Boolean(entry?.verified),
        frameRate: MODEL_FRAME_RATE,
        formula: "24*sec+3",
        frameCounts: durations ? Object.fromEntries(durations.map((sec) => [String(sec), frameCountForDuration(sec)])) : null,
        note: entry?.note || (isVideoTemplate(key) ? "该视频模型未登记时长档位，待查证" : "非视频模板，无时长档位"),
    };
}

/**
 * 选定视频模板 → 可选时长集合（秒数组）。未登记 / 非视频模板返回 null（无档位，不约束）。
 * @param {string} name 模板名
 * @returns {number[]|null}
 */
export function durationsForTemplate(name) {
    const entry = DURATION_CATALOG[String(name ?? "").trim()];
    return entry && Array.isArray(entry.durations) ? [...entry.durations] : null;
}

/**
 * 所选时长是否属于该模板的档位集合（后端校验入口）。模板无可查证档位时返回 false ——
 * 「所选时长必须属于该集合」，档位未查证就不能声称它合法。
 */
export function isDurationAllowed(name, seconds) {
    const durations = durationsForTemplate(name);
    if (!durations) return false;
    const sec = Number(seconds);
    return Number.isFinite(sec) && durations.includes(sec);
}

const EPS = 1e-6;
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

/**
 * 骨架对齐校验：每集骨架 = 档位时长；Σ(段时长) 必须等于骨架，**缺一段都要显式报出**。
 *
 * @param {object} args
 * @param {number} args.skeletonSeconds 骨架时长（秒，来自模型档位）
 * @param {Array<{durationSec:number}>} args.segments 该集的分段（分镜/片段）
 * @param {number[]|null} [args.tiers] 档位集合；给定时逐段校验 durationSec 是否属于档位
 * @returns {{skeletonSeconds:number,totalSeconds:number,diffSeconds:number,missingSeconds:number,overflowSeconds:number,durationSegments:number,invalidDurations:number[],tiers:number[]|null,ok:boolean,message:string}}
 *   diffSeconds = 骨架 - Σ段时长（>0 表示缺、<0 表示超）；message 为空串表示完全对齐。
 */
export function skeletonAlignment({ skeletonSeconds, segments, tiers } = {}) {
    const skeleton = Number(skeletonSeconds) > 0 ? Number(skeletonSeconds) : 0;
    const list = Array.isArray(segments) ? segments : [];
    const durations = list.map((seg) => Number(seg?.durationSec)).filter((value) => Number.isFinite(value) && value > 0);
    const total = round3(durations.reduce((sum, value) => sum + value, 0));
    const diff = round3(skeleton - total);
    const missingSeconds = diff > EPS ? diff : 0;
    const overflowSeconds = diff < -EPS ? -diff : 0;
    const tierSet = Array.isArray(tiers) && tiers.length ? tiers.map(Number) : null;
    const invalid = tierSet ? durations.filter((value) => !tierSet.includes(value)) : [];
    const problems = [];
    if (!skeleton) problems.push("未取到骨架时长（每集时长必须从模型档位里选）");
    if (missingSeconds > 0) problems.push(`还缺 ${missingSeconds}s（Σ段时长 ${total}s / 骨架 ${skeleton}s，共 ${list.length} 段）`);
    if (overflowSeconds > 0) problems.push(`超出骨架 ${overflowSeconds}s（Σ段时长 ${total}s / 骨架 ${skeleton}s，共 ${list.length} 段）`);
    if (invalid.length) problems.push(`有 ${invalid.length} 段时长不在模型档位 [${tierSet.join("/")}] 内：${[...new Set(invalid)].join("/")}`);
    return {
        skeletonSeconds: skeleton,
        totalSeconds: total,
        diffSeconds: diff,
        missingSeconds,
        overflowSeconds,
        durationSegments: durations.length,
        invalidDurations: [...new Set(invalid)],
        tiers: tierSet,
        ok: skeleton > 0 && !invalid.length && Math.abs(diff) <= EPS,
        message: problems.join("；"),
    };
}

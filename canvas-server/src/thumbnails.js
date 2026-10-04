/**
 * thumbnails.js —— 产物**真缩略图**（列表 / 卡片一律小图，目标单张 ≤ 约 50KB）。
 *
 * 为什么需要（一手实测）：远程访问时「我的资产」列表把**原图**当缩略图用 ——
 * 单张 PNG **1,774,840 字节（1.7MB）**、一页 149 张 ≈ 250MB，4Mbps 链路上
 * **第一张可见图要 23.9s** 才出现。这不是预览组件的问题，是列表本身在传 MB 级原图。
 *
 * 实现口径（**不引新依赖**）：平台**本来就在调 ffmpeg**（delivery.js / edit-export.js 的
 * concat / xfade / 抽封面都走外部 ffmpeg 可执行文件），这里复用同一台机器的 ffmpeg
 * 做「缩放 + 转 WebP」，不引入 sharp / jimp 之类的新 npm 包。
 *   - 图片：`-vf scale='min(W,iw)':'min(W,ih)':force_original_aspect_ratio=decrease` → 单帧 WebP
 *   - 视频：取首帧同一套缩放（列表里视频也用静帧当封面，不再让浏览器拉整段元数据）
 * 产物落 `data/thumbnails/<jobId>/<原名>.<宽>.webp`，**按需生成 + 落盘缓存**：
 * 源文件 mtime 更新或缓存缺失才重跑 ffmpeg；同路径并发只跑一次。
 *
 * 拿不到（格式不支持 / ffmpeg 缺失 / 超时）一律返回 null，由路由**回退到原图** ——
 * 宁可退回大图，也绝不出现裂图。
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { safeJoin } from "./files.js";

export const THUMB_DEFAULT_WIDTH = 320;
export const THUMB_MIN_WIDTH = 64;
export const THUMB_MAX_WIDTH = 640;
/** WebP 质量：72 在 320px 缩略图上肉眼无损，字节数远低于 50KB 目标。 */
export const THUMB_WEBP_QUALITY = 72;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"]);

function extOf(filename) {
    const match = String(filename ?? "").toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? match[0] : "";
}

/** 该扩展名能否生成缩略图（图片 + 视频；音频/其它 → 不处理，路由回退原图）。 */
export function isThumbnailable(filename) {
    const ext = extOf(filename);
    return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
}

export function isVideoName(filename) {
    return VIDEO_EXT.has(extOf(filename));
}

/** 把外部传入的 `w` 规范化到 [64, 640]，非法/缺失 → 默认 320。 */
export function normalizeThumbWidth(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return THUMB_DEFAULT_WIDTH;
    return Math.min(THUMB_MAX_WIDTH, Math.max(THUMB_MIN_WIDTH, Math.round(value)));
}

/**
 * 缩略图磁盘路径：`<thumbsDir>/<jobId>/<原名去扩展>.<宽>.webp`。
 * 用 safeJoin 阻断 `../` 越权；拼不出（非法路径）返回 null。
 */
export function thumbPathFor(thumbsDir, jobId, filename, width) {
    const base = String(filename ?? "").replace(/\.[^./\\]+$/, "");
    // 文件名必须是**单个**路径段：带分隔符 / 是 `..` 一律拒绝（safeJoin 兜底之外再挡一层）。
    if (!base || base === ".." || base === "." || base.includes("/") || base.includes("\\")) return null;
    return safeJoin(thumbsDir, String(jobId), `${base}.${normalizeThumbWidth(width)}.webp`);
}

/** ffmpeg 缩放表达式：长边不超过 width、保持比例、**绝不放大**。 */
export function scaleFilter(width) {
    const w = normalizeThumbWidth(width);
    return `scale='min(${w},iw)':'min(${w},ih)':force_original_aspect_ratio=decrease`;
}

/**
 * 构建 ffmpeg 参数（纯函数，可单测）。日志走 stderr，产物写 outPath。
 * 视频先 `-ss 0` 定位再解码（快且确定）；抽 1 帧、丢音轨、编码 WebP。
 */
export function buildThumbArgs({ sourcePath, outPath, width, video = false }) {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (video) args.push("-ss", "0");
    args.push("-i", sourcePath, "-vf", scaleFilter(width), "-frames:v", "1", "-an");
    args.push("-c:v", "libwebp", "-quality", String(THUMB_WEBP_QUALITY), "-f", "webp", outPath);
    return args;
}

/** 缓存是否可用：缩略图存在且不比源文件旧。 */
export function isFresh(outPath, sourcePath) {
    try {
        return statSync(outPath).mtimeMs >= statSync(sourcePath).mtimeMs;
    } catch {
        return false;
    }
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
    return new Promise((resolve) => {
        execFile(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
            resolve({ ok: !error && existsSync(args[args.length - 1]), error: error ? `${error.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ""}` : null });
        });
    });
}

/**
 * 生成器工厂。
 * @param {{ dataDir?: string, ffmpegPath?: string, timeoutMs?: number, concurrency?: number, warn?: (msg: string) => void }} options
 */
export function createThumbnails({ dataDir = "data", ffmpegPath = "ffmpeg", timeoutMs = 30000, concurrency = 3, warn = console.warn } = {}) {
    const thumbsDir = join(dataDir, "thumbnails");
    mkdirSync(thumbsDir, { recursive: true });

    const inflight = new Map();
    let active = 0;
    const waiting = [];

    /** 简单信号量：同时最多 concurrency 个 ffmpeg，避免一页 149 张把机器打满。 */
    function acquire() {
        if (active < concurrency) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => waiting.push(resolve));
    }
    function release() {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
    }

    async function generate({ jobId, filename, sourcePath, width }) {
        const outPath = thumbPathFor(thumbsDir, jobId, filename, width);
        if (!outPath) return null;
        if (isFresh(outPath, sourcePath)) return { path: outPath, width: normalizeThumbWidth(width), cached: true };
        if (inflight.has(outPath)) return inflight.get(outPath);

        const task = (async () => {
            await acquire();
            try {
                // 排队期间可能已被别的请求生成好。
                if (isFresh(outPath, sourcePath)) return { path: outPath, width: normalizeThumbWidth(width), cached: true };
                mkdirSync(dirname(outPath), { recursive: true });
                const args = buildThumbArgs({ sourcePath, outPath, width, video: isVideoName(filename) });
                const result = await runFfmpeg(ffmpegPath, args, timeoutMs);
                if (!result.ok) {
                    warn(`[thumbnails] 生成失败 ${basename(sourcePath)}：${result.error}`);
                    return null;
                }
                return { path: outPath, width: normalizeThumbWidth(width), cached: false };
            } finally {
                release();
            }
        })();

        inflight.set(outPath, task);
        try {
            return await task;
        } finally {
            inflight.delete(outPath);
        }
    }

    return { thumbsDir, generate, pathFor: (jobId, filename, width) => thumbPathFor(thumbsDir, jobId, filename, width) };
}

/**
 * input-image.js —— 在**发起生成那一刻**取「该次任务实际输入图」的真实像素宽高。
 *
 * 依据（147 一手源码，2026-10-04）：`MiniMaxH3AudioConditioningT8` 对 `first_frame` 走
 * `resize_image(..., "disabled")` = **不保持比例直接拉伸**；而平台是「先选画布再喂图」，
 * 所以画布比例必须**以输入图的真实比例为准**，否则必然变形。
 *
 * 这里只负责「把该次提交里的输入图参数解析成真实宽高」：
 *   - 输入图参数按**主驱动图优先**取：FIRST_FRAME（首帧）> INPUT_IMAGE（底图）> REF_IMAGE_1..3（参考图）；
 *     仅取模板**实际声明**的 token（由调用方从模板 JSON 扫出，不硬编码模板名）。
 *   - 值可以是：`/api/artifacts/<jobId>/<file>`（本机产物）、http(s) 远端 URL、本机路径、data URL。
 *     `comfy:` 前缀 / 裸文件名（已在 ComfyUI 侧）解析不了 → 返回 null，**绝不臆造尺寸**。
 *   - **只读文件头（前 64KB）**，大图不整读；远端带 Range 且短超时（失败即放弃，不拖住提交）。
 *
 * 解析不出（无输入图 / 读不到 / 未知格式 / 头截断）→ null，调用方回落「按提交尺寸自适应」。
 */

import { open } from "node:fs/promises";
import { existsSync } from "node:fs";

import { bufferFromDataUrl, imageDimensions } from "./image-dims.js";
import { safeJoin } from "./files.js";
import { ratioOfSize } from "./capability-limits.js";

/** 输入图 token 优先级：主驱动图（首帧 / 底图）优先于额外参考图。 */
export const INPUT_IMAGE_TOKENS = ["FIRST_FRAME", "INPUT_IMAGE", "REF_IMAGE_1", "REF_IMAGE_2", "REF_IMAGE_3"];

/** 只读文件头字节数：足够覆盖 PNG/JPEG/GIF/WebP/BMP 的尺寸元数据。 */
export const HEAD_BYTES = 64 * 1024;
/** 远端取头的短超时：失败即放弃（提交路径绝不被远端拖住）。 */
export const REMOTE_TIMEOUT_MS = 5000;

/**
 * 从提交参数里挑「该次输入图」的 token 与值。只认调用方给的模板 token 集合（不硬编码模板名）；
 * 未给 tokens 时按默认优先级兜底。
 * @returns {{token:string,value:string}|null}
 */
export function pickInputImageParam(params = {}, tokens = null) {
    const pool = Array.isArray(tokens) && tokens.length ? INPUT_IMAGE_TOKENS.filter((token) => tokens.includes(token)) : INPUT_IMAGE_TOKENS.slice();
    for (const token of pool) {
        const value = params?.[token];
        if (typeof value === "string" && value.trim()) return { token, value: value.trim() };
    }
    return null;
}

/** 读本机文件前 HEAD_BYTES 字节；读不到返回 null。 */
async function readHead(file) {
    try {
        const handle = await open(file, "r");
        try {
            const buffer = Buffer.alloc(HEAD_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
            return bytesRead > 0 ? buffer.subarray(0, bytesRead) : null;
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

/**
 * 把一个输入图值解析成字节头。认不出的引用形态（`comfy:` / 裸文件名）→ null。
 * @param {string} value
 * @param {{dataDir?:string, fetchImpl?:Function}} [deps] fetchImpl 仅供测试注入。
 */
export async function readInputImageHead(value, { dataDir, fetchImpl } = {}) {
    const text = String(value ?? "").trim();
    if (!text) return null;

    const inline = bufferFromDataUrl(text);
    if (inline) return inline;

    if (/^https?:\/\//i.test(text)) {
        const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
        try {
            const response = await doFetch(text, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` }, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
            if (!response?.ok) return null;
            const full = Buffer.from(await response.arrayBuffer());
            return full.subarray(0, HEAD_BYTES);
        } catch {
            return null;
        }
    }

    // 上游阶段回填的产物地址是网关自己的相对路径 → 直接读本地产物文件（不依赖 publicUrl 配绝对地址）。
    if (text.startsWith("/api/artifacts/")) {
        const segments = text.slice("/api/artifacts/".length).split("/").filter(Boolean);
        const file = dataDir ? safeJoin(dataDir, "artifacts", ...segments) : null;
        if (!file) return null;
        return existsSync(file) ? readHead(file) : null;
    }

    // 本机绝对 / 相对路径（含分隔符）才当文件；裸文件名是 ComfyUI 侧引用，跳过。
    if (/[\\/]/.test(text)) return readHead(text);

    return null;
}

/**
 * 解析该次提交的输入图真实宽高。
 * @param {object} params 提交参数（含 FIRST_FRAME / INPUT_IMAGE / REF_IMAGE_n）
 * @param {string[]|null} tokens 模板实际声明的 token（来自 extractTokens）
 * @param {{dataDir?:string, fetchImpl?:Function}} [deps]
 * @returns {Promise<{token:string,source:string,width:number,height:number,ratio:string}|null>}
 */
export async function resolveInputImageSize(params = {}, tokens = null, deps = {}) {
    const picked = pickInputImageParam(params, tokens);
    if (!picked) return null;
    const head = await readInputImageHead(picked.value, deps);
    if (!head) return null;
    const dims = imageDimensions(head);
    if (!dims) return null;
    return { token: picked.token, source: picked.value, width: dims.width, height: dims.height, ratio: ratioOfSize(dims.width, dims.height), type: dims.type };
}

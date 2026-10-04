/**
 * image-dims.js —— 从图片字节流解析**真实像素宽高**的纯函数（零依赖）。
 *
 * 为什么需要：147 的 `MiniMaxH3AudioConditioningT8` 对 `first_frame` 走
 * `resize_image(..., "disabled")` = **不保持比例直接拉伸**（见 capability-limits.js 头注释）。
 * 画布是「先选画布再喂图」，要避免变形就必须**以输入图的真实比例**去选画布档 ——
 * 而前端传来的尺寸不可信（可能缺失/过期/被改），所以在这里从**实际输入图字节**读宽高。
 *
 * 只读文件头：调用方应只把前 ~64KB 喂进来（大图不必整读）。支持平台素材的常见格式：
 *   PNG / JPEG / GIF / WebP / BMP。解析不出（截断/未知格式）→ 返回 null，调用方按「无图」处理，
 *   **绝不臆造尺寸**。
 *
 * @param {Buffer|Uint8Array} buffer 图片字节（至少包含文件头）
 * @returns {{width:number,height:number,type:string}|null}
 */

/** 大端 / 小端无符号整数读取（越界返回 NaN，调用方据此判失败）。 */
const u16be = (buf, at) => (at + 2 <= buf.length ? buf.readUInt16BE(at) : NaN);
const u32be = (buf, at) => (at + 4 <= buf.length ? buf.readUInt32BE(at) : NaN);
const u16le = (buf, at) => (at + 2 <= buf.length ? buf.readUInt16LE(at) : NaN);
const u32le = (buf, at) => (at + 4 <= buf.length ? buf.readUInt32LE(at) : NaN);
const u24le = (buf, at) => (at + 3 <= buf.length ? buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) : NaN);

const startsWith = (buf, bytes, at = 0) => bytes.every((value, index) => buf[at + index] === value);

const ok = (width, height, type) => (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height, type } : null);

/** PNG：8 字节签名 + IHDR（宽高为大端 u32，固定在第 16/20 字节）。 */
function pngDimensions(buf) {
    if (!startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
    if (!startsWith(buf, [0x49, 0x48, 0x44, 0x52], 12)) return null; // "IHDR" 必须在偏移 12
    return ok(u32be(buf, 16), u32be(buf, 20), "png");
}

/** GIF：签名 + 逻辑屏幕宽高（小端 u16，偏移 6/8）。 */
function gifDimensions(buf) {
    if (!(startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return null;
    return ok(u16le(buf, 6), u16le(buf, 8), "gif");
}

/** BMP：BM 头 + DIB 宽高（小端 i32；高度可为负 = 自上而下）。 */
function bmpDimensions(buf) {
    if (!startsWith(buf, [0x42, 0x4d])) return null;
    const width = u32le(buf, 18);
    const rawHeight = u32le(buf, 22);
    // 高度为负表示 top-down，像素数取绝对值；转成有符号再取绝对值。
    const height = rawHeight > 0x7fffffff ? 0x100000000 - rawHeight : rawHeight;
    return ok(width, Math.abs(height), "bmp");
}

/** WebP：RIFF/WEBP 容器，按 VP8 / VP8L / VP8X 三种载荷各自解析画布尺寸。 */
function webpDimensions(buf) {
    if (!(startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8))) return null;
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") {
        // 关键帧起始码 0x9d 0x01 0x2a 在偏移 23..25；宽高为 14 位小端。
        if (!startsWith(buf, [0x9d, 0x01, 0x2a], 23)) return null;
        return ok(u16le(buf, 26) & 0x3fff, u16le(buf, 28) & 0x3fff, "webp");
    }
    if (chunk === "VP8L") {
        // 偏移 21 起的 4 字节小端：14 位宽-1，紧接 14 位高-1。
        const bits = u32le(buf, 21);
        if (!Number.isFinite(bits)) return null;
        return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, "webp");
    }
    if (chunk === "VP8X") {
        // 偏移 24 起 3 字节宽-1、偏移 27 起 3 字节高-1。
        return ok(u24le(buf, 24) + 1, u24le(buf, 27) + 1, "webp");
    }
    return null;
}

/**
 * JPEG：从偏移 2 起逐段扫描 marker，命中 SOFn（0xC0..0xCF，排除 C4/C8/CC）后
 * 在「precision(1) + height(2) + width(2)」处读取尺寸。
 */
function jpegDimensions(buf) {
    if (!startsWith(buf, [0xff, 0xd8])) return null;
    let at = 2;
    while (at + 4 <= buf.length) {
        if (buf[at] !== 0xff) { at += 1; continue; } // 跳过填充字节 0xFF
        let marker = buf[at + 1];
        while (marker === 0xff && at + 2 < buf.length) { at += 1; marker = buf[at + 1]; } // 连续 0xFF 填充
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // 无长度段
        if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS：之后没有 SOF 了
        const length = u16be(buf, at + 2);
        if (!Number.isFinite(length) || length < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return ok(u16be(buf, at + 7), u16be(buf, at + 5), "jpeg"); // height 在 width 之前
        at += 2 + length;
    }
    return null;
}

/**
 * 解析图片真实像素宽高。未知格式 / 头被截断 → null（调用方按「无图」处理）。
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number,height:number,type:string}|null}
 */
export function imageDimensions(buffer) {
    if (!buffer || typeof buffer.length !== "number" || buffer.length < 16) return null;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return pngDimensions(buf) || gifDimensions(buf) || bmpDimensions(buf) || webpDimensions(buf) || jpegDimensions(buf) || null;
}

/** data URL（`data:image/png;base64,....`）→ Buffer；非 data URL 返回 null。 */
export function bufferFromDataUrl(value) {
    const match = /^data:[^;,]*;base64,(.*)$/s.exec(String(value ?? "").trim());
    if (!match) return null;
    try {
        return Buffer.from(match[1], "base64");
    } catch {
        return null;
    }
}

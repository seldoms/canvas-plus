import { createWriteStream, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { guessContentType } from "./http.js";

export { guessContentType };

export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** 拼接路径并确保结果仍在 root 之内，阻断 `../` 越权读取。 */
export function safeJoin(root, ...segments) {
    const target = resolve(root, ...segments);
    const normalizedRoot = resolve(root);
    if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) return null;
    return target;
}

export function sanitizeName(value, fallback = "file") {
    const cleaned = String(value ?? "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 120);
    return cleaned || fallback;
}

export function extensionFor(filename, contentType) {
    const fromName = basename(filename || "").match(/\.[A-Za-z0-9]{2,5}$/);
    if (fromName) return fromName[0].toLowerCase();
    const type = String(contentType || "").toLowerCase();
    if (type.includes("png")) return ".png";
    if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
    if (type.includes("webp")) return ".webp";
    if (type.includes("gif")) return ".gif";
    if (type.includes("mp4")) return ".mp4";
    if (type.includes("webm")) return ".webm";
    if (type.includes("quicktime")) return ".mov";
    if (type.includes("mpeg")) return ".mp3";
    if (type.includes("wav")) return ".wav";
    return ".bin";
}

export async function saveBuffer(filePath, buffer) {
    ensureDir(resolve(filePath, ".."));
    await streamPipeline(Readable.from(buffer), createWriteStream(filePath));
    return filePath;
}

export function fileSize(filePath) {
    try {
        return statSync(filePath).size;
    } catch {
        return undefined;
    }
}

export function listFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(dir, entry.name));
}

/** 产物对外 URL：相对路径优先，配置了 publicUrl 时输出绝对地址。 */
export function artifactUrl(config, jobId, filename) {
    const path = `/api/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
    return config?.publicUrl ? `${String(config.publicUrl).replace(/\/+$/, "")}${path}` : path;
}

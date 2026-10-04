import { createReadStream, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { extname } from "node:path";

/**
 * 可压缩类型（都是文本类）：图片 / 字体 / 视频本身就是压缩格式，再压反而变大。
 * ⚠️ 这条是为**远程访问**加的：前端产物是 MB 级的 JS，不压缩时远程首屏要等好几秒
 * （实测 gzip 省约 67%：4Mbps 链路上 7.9s → 2.0s）。
 */
const COMPRESSIBLE_EXT = new Set([".html", ".css", ".js", ".mjs", ".map", ".svg", ".json", ".xml", ".txt", ".md", ".webmanifest"]);

/** gzip 结果缓存：key 含 mtime/size，构建产物变一次就换 key，不会串旧内容。 */
const gzipCache = new Map();
const GZIP_CACHE_MAX = 64;

function gzipCached(filePath, info) {
    const key = `${filePath}|${info.mtimeMs}|${info.size}`;
    const hit = gzipCache.get(key);
    if (hit) return hit;
    const body = gzipSync(readFileSync(filePath), { level: 9 });
    if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value);
    gzipCache.set(key, body);
    return body;
}

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".srt": "text/plain; charset=utf-8",
};

export function guessContentType(filePath) {
    return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function applyCors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-expose-headers", "*");
    res.setHeader("access-control-max-age", "86400");
}

export function sendJson(res, status, body) {
    const payload = JSON.stringify(body ?? null);
    applyCors(res);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
}

export function sendError(res, status, message, code) {
    sendJson(res, status, { error: { message: String(message), ...(code ? { code } : {}) } });
}

export function readBody(req, limitBytes = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new Error(`请求体超过上限 ${limitBytes} 字节`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

export async function readJson(req, limitBytes) {
    const raw = await readBody(req, limitBytes);
    if (!raw.length) return {};
    return JSON.parse(raw.toString("utf8"));
}

export function serveFile(req, res, filePath, { download = false } = {}) {
    let info;
    try {
        info = statSync(filePath);
    } catch {
        sendError(res, 404, "文件不存在");
        return;
    }
    if (!info.isFile()) {
        sendError(res, 404, "文件不存在");
        return;
    }
    // ── 缓存策略：**HTML 必须 no-cache**，其余（带 hash 的产物 / 按 job 分目录的产物）可 immutable。
    // 之前一律 immutable 是个真 bug：重建后浏览器继续用**旧 index.html**，它引用的是**已被删除的旧资源**，
    // 页面直接废掉/卡住（实测一个已删除的 /assets/*.js 会被 SPA 兜底返回 HTML）。
    const isHtml = extname(filePath).toLowerCase() === ".html";
    const headers = {
        "content-type": guessContentType(filePath),
        "content-length": info.size,
        "accept-ranges": "bytes",
        "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
    };
    if (isHtml) headers.etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
    if (download) headers["content-disposition"] = `attachment; filename="${encodeURIComponent(filePath.split(/[\\/]/).pop())}"`;
    applyCors(res);

    // ── gzip（仅完整响应、且是文本类、且确实压得小）────────────────────────────
    // Range 请求（视频/音频拖动、断点续传）**不走压缩** —— 压缩后的字节偏移对不上 range。
    const rangeHeader = req.headers.range;
    const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    const compressible = COMPRESSIBLE_EXT.has(extname(filePath).toLowerCase()) && info.size > 1024;
    if (!rangeHeader && acceptsGzip && compressible) {
        try {
            const body = gzipCached(filePath, info);
            if (body.length < info.size) {
                headers["content-encoding"] = "gzip";
                headers["content-length"] = body.length;
                headers["vary"] = "accept-encoding";
                res.writeHead(200, headers);
                res.end(body);
                return;
            }
        } catch {
            // 压缩失败就按原文发送，绝不让它变成 500
        }
    }

    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : info.size - 1;
        if (start >= info.size || end >= info.size || start > end) {
            res.writeHead(416, { ...headers, "content-range": `bytes */${info.size}` });
            res.end();
            return;
        }
        res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
}

/**
 * 极简路由表。pattern 用 `:name` 占位，例如 `/api/jobs/:id/cancel`。
 * 支持通配前缀 `*path`，仅用于 LLM 透传这类需要原样转发路径的场景。
 */
export function createRouter() {
    const routes = [];

    const add = (method, pattern, handler) => {
        const wildcard = pattern.includes("*");
        const names = [];
        const regexSource = pattern
            .split("/")
            .map((segment) => {
                if (!segment) return "";
                if (segment.startsWith(":")) {
                    names.push(segment.slice(1));
                    return "([^/]+)";
                }
                if (segment.startsWith("*")) {
                    names.push(segment.slice(1));
                    return "(.*)";
                }
                return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            })
            .join("/");
        routes.push({ method: method.toUpperCase(), wildcard, names, regex: new RegExp(`^${regexSource}/?$`), handler });
    };

    const dispatch = async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const pathname = decodeURIComponent(url.pathname);
        if (req.method === "OPTIONS") {
            applyCors(res);
            res.writeHead(204);
            res.end();
            return true;
        }
        for (const route of routes) {
            if (route.method !== req.method && route.method !== "ANY") continue;
            const match = route.regex.exec(pathname);
            if (!match) continue;
            const params = {};
            route.names.forEach((name, index) => {
                params[name] = match[index + 1];
            });
            await route.handler(req, res, { params, url, pathname });
            return true;
        }
        return false;
    };

    return { add, dispatch, get: (p, h) => add("GET", p, h), post: (p, h) => add("POST", p, h), any: (p, h) => add("ANY", p, h) };
}

export function corsPreflight(res) {
    applyCors(res);
    res.writeHead(204);
    res.end();
}

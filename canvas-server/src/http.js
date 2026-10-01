import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";

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
    const headers = {
        "content-type": guessContentType(filePath),
        "content-length": info.size,
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
    };
    if (download) headers["content-disposition"] = `attachment; filename="${encodeURIComponent(filePath.split(/[\\/]/).pop())}"`;
    applyCors(res);

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

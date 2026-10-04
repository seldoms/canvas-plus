import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";

import { serveFile } from "../src/http.js";

/**
 * HEAD 安全性（audit #75 追修）的验收：
 *   - HEAD 映射到 GET 之后，静态/产物响应**只发头不发体**：状态码 / content-type / content-length
 *     （取自 statSync）/ gzip 的 content-encoding 与 GET 一致，但绝不 createReadStream、绝不读文件内容。
 *     旧写法 `createReadStream(file).pipe(res)` 在 HEAD 下照样把文件读干（实测 268435456 字节全读）。
 *   - 产物路由 `variant=thumb` 的**按需生成**不得被 HEAD 触发：HEAD 必须安全幂等，无副作用。
 *   - 已验证行为不变：HEAD /api/health → 200 JSON、未命中 /api/* → 404 JSON、SPA 路由仍回退 index.html。
 */

// ——— 起真服务的最小环境（只需 data/skills/webdist；上游一律指向不可达地址，绝不真跑生成） ———

const root = mkdtempSync(join(tmpdir(), "canvas-head-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

// 假 ffmpeg：把最后一个参数当输出文件写出来。用它证明「这次 HEAD 到底有没有触发缩略图生成」。
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });
const fakeFfmpeg = join(binDir, "ffmpeg");
writeFileSync(fakeFfmpeg, '#!/bin/sh\nfor last; do :; done\nmkdir -p "$(dirname "$last")"\nprintf webp > "$last"\n');
chmodSync(fakeFfmpeg, 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

const JOB = "job-headprobe";
const artifactDir = join(dataDir, "artifacts", JOB);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "probe.png"), Buffer.alloc(4096, 7));
const thumbnailFile = () => join(dataDir, "thumbnails", JOB, "probe.64.webp");

const webDist = join(root, "webdist");
mkdirSync(webDist, { recursive: true });
writeFileSync(join(webDist, "index.html"), "<!doctype html><title>stub</title>");

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_WEB_DIR = webDist;
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_WEB_DIR", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_LLM_URL"]) {
        delete process.env[key];
    }
    rmSync(root, { recursive: true, force: true });
});

// ——— 单测：桩响应记录 write/pipe 写入的 body 字节 ———

/** 记录 body 字节数的桩响应：真实 Writable，所以 stream 一 pipe 进来就会被数到。 */
function sinkResponse() {
    const parts = [];
    const res = new Writable({
        write(chunk, _encoding, callback) {
            parts.push(chunk.length);
            callback();
        },
    });
    res.head = null;
    res.setHeader = () => {};
    res.writeHead = (status, headers) => {
        res.head = { status, headers: headers || {} };
    };
    res.bodyBytes = () => parts.reduce((total, size) => total + size, 0);
    return res;
}

/** 调 serveFile 并等到响应真正结束，再返回桩响应（pipe 是异步的，不等就恒为 0 字节）。 */
async function callServeFile(req, filePath) {
    const res = sinkResponse();
    const finished = new Promise((resolve) => res.on("finish", resolve));
    serveFile(req, res, filePath);
    await finished;
    return res;
}

const HEAD = (headers = {}) => ({ method: "HEAD", headers });
const GET = (headers = {}) => ({ method: "GET", headers });

test("HEAD 大文件只发头：content-length 取自 statSync、零 body（不把文件读出来），GET 仍逐字发体", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-head-file-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    // 稀疏文件：只有真去读才会付出 256MiB 的代价（GET 对照用小文件，避免测试自己变慢）。
    const big = join(dir, "big.mp4");
    writeFileSync(big, Buffer.alloc(0));
    truncateSync(big, 268435456);

    const head = await callServeFile(HEAD(), big);
    assert.equal(head.head.status, 200);
    assert.equal(head.head.headers["content-type"], "video/mp4", "content-type 与 GET 一致");
    assert.equal(head.head.headers["content-length"], 268435456, "content-length 取自 statSync");
    assert.equal(head.bodyBytes(), 0, "HEAD 不得产生任何 body —— 旧写法 pipe 会把 256MiB 全数写进来");
    assert.ok(head.writableEnded, "HEAD 必须结束响应，不能挂着连接");

    const small = join(dir, "small.bin");
    writeFileSync(small, Buffer.alloc(4096, 7));
    const get = await callServeFile(GET(), small);
    assert.equal(get.head.status, 200);
    assert.equal(get.bodyBytes(), 4096, "对照：桩响应确实会数到 GET 的 body（HEAD 的 0 不是因为桩坏了）");
});

test("HEAD 与 GET 的 gzip 头一致：HEAD 不压缩、不读文件，GET 后 HEAD 逐字复用压缩头的长度", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-head-gzip-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const js = join(dir, "app.js");
    writeFileSync(js, "const answer = 42;\n".repeat(400));
    const rawSize = statSync(js).size;

    // 冷缓存 HEAD：不压缩（压缩就要读整份文件），长度按 statSync 声明，且不产生 body。
    const cold = await callServeFile(HEAD({ "accept-encoding": "gzip" }), js);
    assert.equal(cold.head.headers["content-encoding"], "gzip", "GET 会 gzip 的响应，HEAD 的 content-encoding 必须一致");
    assert.equal(cold.head.headers["content-length"], rawSize);
    assert.equal(cold.bodyBytes(), 0, "HEAD 不得读文件内容");

    // GET：同一份文件真的压缩发体，并把 gzip 结果放进缓存。
    const get = await callServeFile(GET({ "accept-encoding": "gzip" }), js);
    assert.equal(get.head.headers["content-encoding"], "gzip");
    assert.ok(get.bodyBytes() > 0 && get.bodyBytes() < rawSize, "GET 发的是压缩后的体");

    // 缓存命中后的 HEAD：与 GET 的头逐字一致（编码 + gzipped 长度）。
    const warm = await callServeFile(HEAD({ "accept-encoding": "gzip" }), js);
    assert.equal(warm.head.headers["content-encoding"], get.head.headers["content-encoding"]);
    assert.equal(warm.head.headers["content-length"], get.head.headers["content-length"]);
    assert.equal(warm.bodyBytes(), 0);

    // 反例：扩展名可压缩但内容压不小（随机字节）→ GET 按原文发，HEAD 不得凭空声明 gzip。
    const noise = join(dir, "noise.json");
    writeFileSync(noise, randomBytes(4096));
    const noiseGet = await callServeFile(GET({ "accept-encoding": "gzip" }), noise);
    assert.equal(noiseGet.head.headers["content-encoding"], undefined, "压不小就按原文发，GET 不带 content-encoding");
    const noiseHead = await callServeFile(HEAD({ "accept-encoding": "gzip" }), noise);
    assert.equal(noiseHead.head.headers["content-encoding"], undefined, "缓存里有 gzip 条目但 GET 没用它，HEAD 也不能声明 gzip");
    assert.equal(noiseHead.bodyBytes(), 0);
});

test("HEAD /api/health 仍 200 JSON；HEAD 未命中 /api/* 仍 404 JSON", async () => {
    const health = await fetch(`${base}/api/health`, { method: "HEAD" });
    assert.equal(health.status, 200, "HEAD 必须能打到 /api/health");
    assert.match(health.headers.get("content-type") || "", /application\/json/);
    assert.equal(await health.text(), "", "HEAD 不产生 body");

    const nope = await fetch(`${base}/api/nope`, { method: "HEAD" });
    assert.equal(nope.status, 404);
    assert.match(nope.headers.get("content-type") || "", /application\/json/);
});

test("HEAD 非 API 路由仍回退 index.html（SPA 兜底不变）", async () => {
    const res = await fetch(`${base}/pipeline/whatever`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(await res.text(), "", "HEAD 不产生 body");
});

test("HEAD ?variant=thumb 只发头：不跑 ffmpeg、不落盘缩略图（GET 仍按需生成）", async () => {
    const url = `${base}/api/artifacts/${JOB}/probe.png?variant=thumb&w=64`;
    const res = await fetch(url, { method: "HEAD" });
    assert.equal(res.status, 200, "未缓存缩略图时回退原图头，仍是 200");
    assert.equal(res.headers.get("content-type"), "image/png", "HEAD 回退的是原图，不是新生成的缩略图");
    assert.equal(res.headers.get("content-length"), "4096");
    assert.equal(existsSync(thumbnailFile()), false, "HEAD 不得触发按需生成（未鉴权 HEAD 就能让 ffmpeg 白跑）");
    assert.equal(await res.text(), "", "HEAD 不产生 body");

    // 对照：GET 必须真的生成 —— 证明上一条不是因为「生成功能坏了」而通过。
    const get = await fetch(url);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "image/webp");
    assert.equal(existsSync(thumbnailFile()), true, "GET 必须真的生成并落盘缩略图");

    // 已缓存的缩略图，HEAD 照常发头（与 GET 同一份缩略图），仍然零 body。
    const cachedHead = await fetch(url, { method: "HEAD" });
    assert.equal(cachedHead.status, 200);
    assert.equal(cachedHead.headers.get("content-type"), "image/webp", "已缓存时 HEAD 发的是缩略图，不是回退原图");
    assert.equal(cachedHead.headers.get("content-length"), String(statSync(thumbnailFile()).size));
    assert.equal(await cachedHead.text(), "", "HEAD 不产生 body");
});

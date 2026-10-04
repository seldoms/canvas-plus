/**
 * input-image.js 行为锁定：把该次提交的输入图参数解析成**真实像素宽高**。
 * 覆盖：token 优先级（FIRST_FRAME > INPUT_IMAGE > REF_IMAGE_1）、本机产物 / 本机路径 / data URL /
 * 远端（注入 fetchImpl）、以及「认不出的引用（comfy:/裸文件名）→ null（绝不臆造）」。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HEAD_BYTES, pickInputImageParam, readInputImageHead, resolveInputImageSize } from "../src/input-image.js";

// 真实 64x48 PNG（Pillow 编码；与 image-dims 测试同源）。
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAU0lEQVR4nO3PQQ3AIADAQEAIOpGIrIngcVnSU9DOe/b4s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaB9aAYBvtkCYLMAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_B64, "base64");

function makeDataDir() {
    const dir = join(tmpdir(), `canvas-input-image-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(dir, "artifacts", "job-1"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "job-1", "frame.png"), PNG);
    return dir;
}

test("pickInputImageParam：主驱动图优先（FIRST_FRAME > INPUT_IMAGE > REF_IMAGE_1），且只认模板声明的 token", () => {
    const params = { INPUT_IMAGE: "/a/input.png", FIRST_FRAME: "/a/first.png", REF_IMAGE_1: "/a/ref.png" };
    assert.deepEqual(pickInputImageParam(params, ["INPUT_IMAGE", "FIRST_FRAME", "REF_IMAGE_1"]), { token: "FIRST_FRAME", value: "/a/first.png" });
    assert.deepEqual(pickInputImageParam(params, ["INPUT_IMAGE", "REF_IMAGE_1"]), { token: "INPUT_IMAGE", value: "/a/input.png" });
    assert.deepEqual(pickInputImageParam({ REF_IMAGE_1: "/a/ref.png" }, ["INPUT_IMAGE", "REF_IMAGE_1"]), { token: "REF_IMAGE_1", value: "/a/ref.png" });
    // 模板没声明 FIRST_FRAME → 即便提交里带了也不取（不臆造）。
    assert.deepEqual(pickInputImageParam(params, ["INPUT_IMAGE"]), { token: "INPUT_IMAGE", value: "/a/input.png" });
    assert.equal(pickInputImageParam({}, ["INPUT_IMAGE"]), null);
    assert.equal(pickInputImageParam({ INPUT_IMAGE: "  " }, ["INPUT_IMAGE"]), null);
});

test("readInputImageHead：本机产物（/api/artifacts/...）/ data URL / 本机路径 都能读到字节头；裸名与 comfy: 认不出", async () => {
    const dataDir = makeDataDir();
    try {
        const fromArtifact = await readInputImageHead("/api/artifacts/job-1/frame.png", { dataDir });
        assert.deepEqual([fromArtifact.length, fromArtifact.subarray(0, 4).toString("latin1")], [PNG.length, "\u0089PNG"]);

        const fromPath = await readInputImageHead(join(dataDir, "artifacts", "job-1", "frame.png"), { dataDir });
        assert.equal(fromPath.length, PNG.length);

        const fromDataUrl = await readInputImageHead(`data:image/png;base64,${PNG_B64}`, { dataDir });
        assert.equal(fromDataUrl.length, PNG.length);

        // 越权路径也拦截（safeJoin 之外）→ null。
        assert.equal(await readInputImageHead("/api/artifacts/job-1/../../../etc/passwd", { dataDir }), null);
        // 已上传到 ComfyUI 的裸名 / comfy: 前缀 → 读不到 → null（绝不臆造）。
        assert.equal(await readInputImageHead("frame.png", { dataDir }), null);
        assert.equal(await readInputImageHead("comfy:frame.png", { dataDir }), null);
        // 不存在的产物 → null。
        assert.equal(await readInputImageHead("/api/artifacts/job-2/missing.png", { dataDir }), null);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test("readInputImageHead：远端 http(s) 走注入 fetch（带 Range、失败/非 2xx → null）", async () => {
    let seen = null;
    const okFetch = async (url, init) => {
        seen = { url, range: init.headers.Range };
        return { ok: true, async arrayBuffer() { return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength); } };
    };
    const head = await readInputImageHead("https://example.com/frame.png", { fetchImpl: okFetch });
    assert.equal(head.length, PNG.length);
    assert.deepEqual(seen, { url: "https://example.com/frame.png", range: `bytes=0-${HEAD_BYTES - 1}` });

    const missing = await readInputImageHead("https://example.com/404.png", { fetchImpl: async () => ({ ok: false }) });
    assert.equal(missing, null);
    const boom = await readInputImageHead("https://example.com/err.png", { fetchImpl: async () => { throw new Error("network"); } });
    assert.equal(boom, null);
});

test("resolveInputImageSize：全链路 → token/真实宽高/最简画幅；无图/未知格式 → null", async () => {
    const dataDir = makeDataDir();
    try {
        const size = await resolveInputImageSize({ INPUT_IMAGE: "/api/artifacts/job-1/frame.png" }, ["INPUT_IMAGE"], { dataDir });
        assert.deepEqual(size, { token: "INPUT_IMAGE", source: "/api/artifacts/job-1/frame.png", width: 64, height: 48, ratio: "4:3", type: "png" });

        // data URL + 首帧 token。
        const first = await resolveInputImageSize({ FIRST_FRAME: `data:image/png;base64,${PNG_B64}` }, ["FIRST_FRAME"], { dataDir });
        assert.equal(first.token, "FIRST_FRAME");
        assert.deepEqual([first.width, first.height, first.ratio], [64, 48, "4:3"]);

        // 无输入图 → null（纯文生视频走这里）。
        assert.equal(await resolveInputImageSize({ PROMPT: "x" }, ["INPUT_IMAGE"], { dataDir }), null);
        // 值认不出 → null。
        assert.equal(await resolveInputImageSize({ INPUT_IMAGE: "frame.png" }, ["INPUT_IMAGE"], { dataDir }), null);
        // 非图片字节（如文本文件）→ 解析不出尺寸 → null。
        writeFileSync(join(dataDir, "artifacts", "job-1", "note.txt"), "hello world this is not an image");
        assert.equal(await resolveInputImageSize({ INPUT_IMAGE: "/api/artifacts/job-1/note.txt" }, ["INPUT_IMAGE"], { dataDir }), null);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});

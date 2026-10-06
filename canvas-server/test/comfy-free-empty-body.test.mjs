/**
 * ComfyUI 命令端点的空响应体（防「成功被误报成失败」回归）：
 *
 * 实测 147 的 POST /free 返回 `HTTP/1.1 200` + `Content-Length: 0`，
 * 原`json()` 无条件 .json() → 抛 `Unexpected end of JSON input`，
 * 使continuation 的 preflight 每次都记一条 warn（虽按读数放行、不阻断，
 * 但把成功误报为失败，掩盖真实故障）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createComfyClient } from "../src/providers/comfy.js";

/** 起一个假 ComfyUI：按 path 决定返回状态码与原始文本。 */
async function withFakeComfy(t, routes, fn) {
    const server = createServer((req, res) => {
        const route = routes[req.url];
        if (!route) {
            res.writeHead(404).end("{}");
            return;
        }
        res.writeHead(route.status || 200, { "Content-Type": route.contentType || "application/json" });
        res.end(route.body ?? "");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    return fn(createComfyClient({ comfy: { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 } }));
}

test("free()：200 + 空响应体应成功返回 null（不抛 JSON 解析错）", async (t) => {
    const comfy = await withFakeComfy(t, { "/free": { status: 200, body: "" } }, (c) => c);
    const result = await comfy.free({ unloadModels: false, freeMemory: true });
    assert.equal(result, null);
});

test("systemStats()：正常 JSON 仍应照常解析（不回退成 null）", async (t) => {
    const stats = { system: { comfyui_version: "0.38.2", ram_free: 123 }, devices: [{ name: "rtx", vram_total: 1, vram_free: 1 }] };
    const comfy = await withFakeComfy(t, { "/system_stats": { status: 200, body: JSON.stringify(stats) } }, (c) => c);
    const result = await comfy.systemStats();
    assert.equal(result.system.comfyui_version, "0.38.2");
    assert.equal(result.system.ram_free, 123);
});

test("free()：非 2xx 仍应抛错（不能被空体容错吞掉真实故障）", async (t) => {
    const comfy = await withFakeComfy(t, { "/free": { status: 500, body: "" } }, (c) => c);
    await assert.rejects(() => comfy.free({}));
});

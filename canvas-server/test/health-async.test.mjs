import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #68 验收：`/api/health` 不再同步等上游。
 * 用一个「接受连接但永不响应」的黑洞服务器冒充挂死的 ComfyUI，
 * 证明存活接口仍立即 200，且 comfy 段给出形状兼容的 pending 快照；
 * 硬超时到点后自动降级成明确的失败结果（字段名不变）。
 */
const root = mkdtempSync(join(tmpdir(), "health-async-"));
const blackholeSockets = new Set();
const blackhole = net.createServer((socket) => {
    blackholeSockets.add(socket);
    socket.on("close", () => blackholeSockets.delete(socket));
    // 故意不 write / 不 end：连接一直挂着，模拟上游「连得上、答不出」。
});
await new Promise((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
const comfyUrl = `http://127.0.0.1:${blackhole.address().port}`;

const ENV = {
    CANVAS_SERVER_DATA_DIR: join(root, "data"),
    CANVAS_SERVER_SKILLS_DIR: join(root, "skills"),
    CANVAS_SERVER_COMFY_URL: comfyUrl,
    CANVAS_SERVER_WEB_DIR: join(root, "webdist"),
};
for (const [key, value] of Object.entries(ENV)) process.env[key] = value;

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

test.after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const socket of blackholeSockets) socket.destroy();
    blackhole.close();
    rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(ENV)) delete process.env[key];
});

test("ComfyUI 挂死时 /api/health 立即 200：comfy 段给 pending 快照且字段结构兼容", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/api/health`);
    const elapsed = Date.now() - started;
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok(elapsed < 1000, `存活接口应立即应答（不等上游），实际 ${elapsed}ms`);

    assert.equal(body.ok, true, "本进程能应答即存活");
    assert.equal(body.llm.probed, false);
    assert.equal(body.llm.source, "registry");

    // comfy 段：字段名 ok / baseUrl / devices 必须保留（前端 GatewayHealth 依赖）。
    assert.equal(body.comfy.ok, false);
    assert.equal(body.comfy.baseUrl, comfyUrl);
    assert.equal(body.comfy.pending, true, "未就绪要给出明确的 pending 状态");
    assert.ok(Array.isArray(body.comfy.devices), "pending 快照也必须带 devices 字段");

    // queue 形状不变。
    assert.deepEqual(Object.keys(body.queue).sort(), ["pending", "running"]);
    assert.equal(typeof body.queue.running, "number");
    assert.equal(typeof body.queue.pending, "number");

    assert.ok(body.service.ok, "service 段不受影响");
    assert.equal(typeof body.service.uptimeSec, "number");
});

test("就绪后自动反映：短超时到点后 comfy 段从 pending 降级成明确失败（不再是 pending）", async () => {
    // healthProbe 的硬超时是 3s；等过它，让后台探测完成降级。
    await new Promise((resolve) => setTimeout(resolve, 3300));
    const body = await (await fetch(`${base}/api/health`)).json();

    assert.equal(body.comfy.ok, false);
    assert.ok(!body.comfy.pending, "超时降级后不应再是 pending");
    assert.ok(body.comfy.error, "应给出可解释的失败原因");
    assert.equal(body.comfy.baseUrl, comfyUrl, "baseUrl 字段仍在");
    assert.ok(Array.isArray(body.comfy.devices), "devices 字段仍在");
});

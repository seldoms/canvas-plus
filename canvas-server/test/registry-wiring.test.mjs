import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RESOURCE_CLASS } from "../src/contracts.js";
import { createJobQueue } from "../src/jobs.js";

/**
 * registry.js 接入任务链路的接线测试（P0-d 第一步，D6）：
 * ① GPU 生图/生视频共用一条本地队列且并发不超过 1；
 * ② CPU 任务不被 GPU 队列堵住，可并行；
 * ③ 提交前 canRun 不通过时被拒且无副作用；
 * ④ Job 带 deviceId 与排队/执行/失败时间；
 * ⑤ /api/health 的 queue 字段形状不变。
 */

function tempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}

test("① GPU_IMAGE 与 GPU_VIDEO 共用同一条默认并发 1 的本地队列", async (t) => {
    const root = tempDir("canvas-jobs-gpu-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const queue = createJobQueue({ dataDir: root, concurrency: 1, label: "test" });

    let active = 0;
    let peak = 0;
    const started = [];
    const runner = (job) =>
        new Promise((resolve) => {
            started.push(job.id);
            active += 1;
            peak = Math.max(peak, active);
            setTimeout(() => {
                active -= 1;
                resolve({ outputs: [] });
            }, 20);
        });

    queue.enqueue({ id: "img-1", kind: "image", resourceClass: RESOURCE_CLASS.GPU_IMAGE }, runner);
    queue.enqueue({ id: "vid-1", kind: "video", resourceClass: RESOURCE_CLASS.GPU_VIDEO }, runner);
    queue.enqueue({ id: "img-2", kind: "image", resourceClass: RESOURCE_CLASS.GPU_IMAGE }, runner);

    // 同一队列串行：最多一个在跑，其余排队。
    assert.equal(queue.counts().running, 1);
    assert.equal(queue.counts().pending, 2);

    await queue.waitForIdle({ timeoutMs: 5000, intervalMs: 5 });

    assert.equal(peak, 1, "GPU_IMAGE/GPU_VIDEO 必须共用同一队列，峰值并发不超过 1");
    assert.deepEqual(started, ["img-1", "vid-1", "img-2"], "同队列 FIFO，不因资源类别插队");
    assert.equal(queue.get("img-1").queue, queue.get("vid-1").queue, "两类资源应落在同一队列键上");
});

test("① 未声明 resourceClass 时按 kind/backend 推断，本地生图/生视频仍同队列", async (t) => {
    const root = tempDir("canvas-jobs-infer-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const queue = createJobQueue({ dataDir: root });
    const noop = async () => ({ outputs: [] });

    queue.enqueue({ id: "a", kind: "image" }, noop);
    queue.enqueue({ id: "b", kind: "video" }, noop);
    queue.enqueue({ id: "c", kind: "image", backend: "runninghub" }, noop);

    assert.equal(queue.get("a").resourceClass, RESOURCE_CLASS.GPU_IMAGE);
    assert.equal(queue.get("b").resourceClass, RESOURCE_CLASS.GPU_VIDEO);
    assert.equal(queue.get("c").resourceClass, RESOURCE_CLASS.API);
    assert.equal(queue.get("a").queue, queue.get("b").queue, "本地生图/生视频共用 GPU 队列");
    assert.notEqual(queue.get("a").queue, queue.get("c").queue, "RunningHub API 独立队列");

    await queue.waitForIdle({ timeoutMs: 5000, intervalMs: 5 });
});

test("② CPU 任务不被 GPU 队列堵住，可并行执行", async (t) => {
    const root = tempDir("canvas-jobs-cpu-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const queue = createJobQueue({ dataDir: root, concurrency: 1 });

    let releaseGpu;
    const gpuRunner = () => new Promise((resolve) => { releaseGpu = resolve; });

    queue.enqueue({ id: "gpu-1", kind: "image", resourceClass: RESOURCE_CLASS.GPU_IMAGE }, gpuRunner);
    queue.enqueue({ id: "cpu-1", kind: "assemble", resourceClass: RESOURCE_CLASS.CPU }, async () => ({ outputs: [] }));

    assert.equal(queue.get("gpu-1").status, "running");
    assert.notEqual(queue.get("cpu-1").status, "queued", "CPU 队列独立，不应排在 GPU 任务后面");
    assert.equal(queue.counts().running, 2, "GPU 与 CPU 应能同时在跑");

    releaseGpu();
    await queue.waitForIdle({ timeoutMs: 5000, intervalMs: 5 });
    assert.equal(queue.get("gpu-1").status, "done");
    assert.equal(queue.get("cpu-1").status, "done");
});

test("④ Job 带 deviceId，并记录排队 / 执行 / 失败时间与原因", async (t) => {
    const root = tempDir("canvas-jobs-device-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const queue = createJobQueue({
        dataDir: root,
        concurrency: 1,
        resolveDevice: (resourceClass) =>
            resourceClass === RESOURCE_CLASS.GPU_IMAGE || resourceClass === RESOURCE_CLASS.GPU_VIDEO ? "gpu-5060" : null,
    });

    queue.enqueue({ id: "img-1", kind: "image" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { outputs: [] };
    });
    // 显式传入的 deviceId 优先于解析器。
    queue.enqueue({ id: "img-2", kind: "image", deviceId: "gpu-explicit" }, async () => ({ outputs: [] }));
    queue.enqueue({ id: "bad", kind: "image" }, async () => {
        throw new Error("显存不足");
    });

    await queue.waitForIdle({ timeoutMs: 5000, intervalMs: 5 });

    const ok = queue.get("img-1");
    assert.equal(ok.deviceId, "gpu-5060");
    assert.ok(ok.queuedAt && ok.startedAt && ok.finishedAt);
    assert.equal(typeof ok.waitMs, "number");
    assert.ok(ok.runMs >= 0);
    assert.equal(ok.status, "done");

    assert.equal(queue.get("img-2").deviceId, "gpu-explicit");

    const bad = queue.get("bad");
    assert.equal(bad.status, "error");
    assert.equal(bad.error, "显存不足");
    assert.equal(bad.deviceId, "gpu-5060");
    assert.ok(bad.finishedAt);
});

test("⑤ 提交前 canRun 校验：设备不可用直接拒绝且不入队；/api/health queue 形状不变", async (t) => {
    const root = tempDir("canvas-wiring-http-");
    const workflows = join(root, "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
        join(workflows, "img_test.json"),
        JSON.stringify({ "1": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64 } } }),
    );

    const envKeys = ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_WORKFLOWS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_COMFY_URL"];
    const previous = {};
    for (const key of envKeys) previous[key] = process.env[key];
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_WORKFLOWS_DIR = workflows;
    process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
    process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";

    t.after(() => {
        for (const key of envKeys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
        rmSync(root, { recursive: true, force: true });
    });

    const mod = await import("../src/index.js");
    assert.ok(mod.registry, "index.js 应导出 registry");

    // 注册表里确实登记了本地 GPU 设备、ComfyUI 模板 Tool 与 API 分类 Tool。
    const gpu = mod.registry.listDevices({ resourceClass: RESOURCE_CLASS.GPU_IMAGE })[0];
    assert.ok(gpu, "应登记本地 GPU 设备");
    assert.equal(mod.registry.getTool("img_test")?.resourceClass, RESOURCE_CLASS.GPU_IMAGE);
    assert.equal(mod.registry.getTool("z-image/turbo")?.resourceClass, RESOURCE_CLASS.API);

    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const port = mod.server.address().port;
    try {
        // /api/health 的 queue 形状必须仍是 { running, pending }。
        const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
        assert.deepEqual(Object.keys(health.queue).sort(), ["pending", "running"]);
        assert.equal(typeof health.queue.running, "number");
        assert.equal(typeof health.queue.pending, "number");
        assert.equal(health.queue.running, 0);
        assert.equal(health.queue.pending, 0);

        // 设备不可用 → 提交被拒（400 + 可读原因），且不入队、不产生任何 Job。
        mod.registry.setDeviceHealth(gpu.id, "down");
        const before = mod.jobs.list().length;
        const rejected = await fetch(`http://127.0.0.1:${port}/api/generate/image`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ template: "img_test", params: {} }),
        });
        assert.equal(rejected.status, 400);
        const message = (await rejected.json()).error.message;
        assert.match(message, /无法提交生图任务/);
        assert.match(message, /不可用/, "拒绝原因应可读");

        assert.equal(mod.jobs.list().length, before, "被拒请求不得入队");
        assert.equal(mod.jobs.counts().pending, 0);

        // 未注册的模板同样被拒（能力不匹配/未知 Tool），不静默改走别的设备。
        mod.registry.setDeviceHealth(gpu.id, "ok");
        const unknown = await fetch(`http://127.0.0.1:${port}/api/generate/image`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ template: "img_not_registered", params: {} }),
        });
        assert.equal(unknown.status, 400);
        assert.match((await unknown.json()).error.message, /未注册/);
        assert.equal(mod.jobs.list().length, before);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

import test from "node:test";
import assert from "node:assert/strict";

import { createProbeCache } from "../src/probe-cache.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("未就绪：get 立即返回 pending 快照（含 devices 空数组），并触发一次后台探测、不阻塞", () => {
    let calls = 0;
    const cache = createProbeCache({ ttlMs: 60000, timeoutMs: 5000 });
    cache.define("comfy", {
        baseUrl: "http://comfy",
        probe: () => {
            calls += 1;
            return new Promise(() => {}); // 永不返回：模拟上游还没就绪
        },
        pending: () => ({ ok: false, baseUrl: "http://comfy", devices: [], error: "探测中", pending: true }),
    });

    const started = Date.now();
    const snap = cache.get("comfy");
    assert.ok(Date.now() - started < 50, "get 必须同步、立即返回，不等探测");
    assert.deepEqual(snap, { ok: false, baseUrl: "http://comfy", devices: [], error: "探测中", pending: true });
    assert.ok(Array.isArray(snap.devices), "pending 快照必须保留 devices 字段（前端依赖）");
    assert.equal(calls, 1, "首次 get 发起一次后台探测");

    // 还没就绪：再取仍是 pending，且不会重复发起（inflight 去重）。
    assert.equal(cache.get("comfy").pending, true);
    assert.equal(calls, 1, "inflight 期间不重复探测");
});

test("就绪：探测完成后 get 返回真实结果，并在 TTL 内复用（只探测一次）", async () => {
    let calls = 0;
    const cache = createProbeCache({ ttlMs: 60000, timeoutMs: 5000 });
    cache.define("comfy", {
        baseUrl: "http://comfy",
        probe: async () => {
            calls += 1;
            return { ok: true, baseUrl: "http://comfy", version: "1.2.3", devices: [{ name: "cuda:0", vramTotal: 16, vramFree: 9 }] };
        },
        pending: () => ({ ok: false, baseUrl: "http://comfy", devices: [], error: "探测中", pending: true }),
    });

    cache.get("comfy"); // 触发首探
    await tick();
    await tick();

    const ready = cache.get("comfy");
    assert.equal(ready.ok, true);
    assert.equal(ready.version, "1.2.3");
    assert.equal(ready.devices.length, 1);
    assert.equal(ready.pending, undefined, "就绪后不应再带 pending");

    cache.get("comfy");
    cache.get("comfy");
    assert.equal(calls, 1, "TTL 内应复用缓存，不重复探测");
});

test("超时：探测永不返回时按 timeoutMs 降级成 ok:false + 可解释 error", async () => {
    const cache = createProbeCache({ ttlMs: 60000, timeoutMs: 20 });
    cache.define("runninghub", { baseUrl: "http://rh", probe: () => new Promise(() => {}) });

    assert.equal(cache.get("runninghub").pending, true);
    await sleep(60);
    const degraded = cache.get("runninghub");
    assert.equal(degraded.ok, false);
    assert.equal(degraded.baseUrl, "http://rh");
    assert.match(degraded.error, /超时/);
});

test("探测抛错：降级成 ok:false 且保留错误信息，不向外抛", async () => {
    const cache = createProbeCache({ ttlMs: 60000, timeoutMs: 5000 });
    cache.define("x", {
        baseUrl: "http://x",
        probe: async () => {
            throw new Error("boom");
        },
    });

    cache.get("x");
    await tick();
    await tick();
    const result = cache.get("x");
    assert.equal(result.ok, false);
    assert.match(result.error, /boom/);
});

test("TTL 过期：stale-while-revalidate —— 先返回旧值，再后台刷新出新值", async () => {
    let clock = 1000;
    let calls = 0;
    const cache = createProbeCache({ ttlMs: 1000, now: () => clock });
    cache.define("x", {
        baseUrl: "http://x",
        probe: async () => {
            calls += 1;
            return { ok: true, n: calls };
        },
    });

    cache.get("x");
    await tick();
    await tick();
    assert.equal(cache.get("x").n, 1);

    clock += 2000; // 超过 TTL
    const stale = cache.get("x"); // 立即返回旧值（不阻塞）
    assert.equal(stale.n, 1, "过期时先返回旧值");
    await tick();
    await tick();
    assert.equal(calls, 2, "过期后已在后台重新探测");
    assert.equal(cache.get("x").n, 2, "再取拿到新值");
});

test("refreshAll 强制刷新全部并等待就绪", async () => {
    const cache = createProbeCache({ ttlMs: 60000, timeoutMs: 5000 });
    cache.define("a", { baseUrl: "http://a", probe: async () => ({ ok: true, baseUrl: "http://a" }) });
    cache.define("b", { baseUrl: "http://b", probe: async () => ({ ok: false, baseUrl: "http://b", error: "down" }) });

    const [a, b] = await cache.refreshAll();
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(cache.get("a").ok, true);
    assert.equal(cache.get("missing"), null, "未注册的名字返回 null");
});

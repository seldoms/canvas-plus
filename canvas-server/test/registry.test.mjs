import test from "node:test";
import assert from "node:assert/strict";

import { RESOURCE_CLASS } from "../src/contracts.js";
import { createRegistry, HEALTH, PROBE_TIMEOUT_MAX_MS, PROBE_TIMEOUT_MS, probeTimeoutOf } from "../src/registry.js";

/** 标准测试夹具：本地 ComfyUI（GPU）+ 本地 LLM + RunningHub（API）+ ffmpeg（CPU）。 */
function baseRegistry() {
    const registry = createRegistry();
    registry.registerDevice({
        id: "gpu-5060",
        label: "RTX 5060 Ti",
        resourceClasses: [RESOURCE_CLASS.GPU_IMAGE, RESOURCE_CLASS.GPU_VIDEO],
        vramTotalMb: 16384,
        vramFreeMb: 12000,
    });
    registry.registerDevice({ id: "cpu-ubuntu", label: "ffmpeg CPU", resourceClasses: [RESOURCE_CLASS.CPU] });

    registry.registerProvider({
        id: "comfy-local",
        kind: "comfy",
        label: "本地 ComfyUI",
        resourceClasses: [RESOURCE_CLASS.GPU_IMAGE, RESOURCE_CLASS.GPU_VIDEO],
        baseUrl: "http://192.168.123.147:8188",
        deviceId: "gpu-5060",
    });
    registry.registerProvider({
        id: "llm-local",
        kind: "llm",
        label: "本地 LLM",
        resourceClasses: [RESOURCE_CLASS.LLM],
        baseUrl: "http://127.0.0.1:11434",
    });
    registry.registerProvider({
        id: "runninghub",
        kind: "api",
        label: "RunningHub 云端",
        resourceClasses: [RESOURCE_CLASS.API],
        baseUrl: "https://www.runninghub.ai/openapi/v2",
    });

    registry.registerTool({
        id: "img_zimage_artistic",
        capability: "image.generate",
        paramsSchema: { PROMPT: { type: "string" } },
        resourceClass: RESOURCE_CLASS.GPU_IMAGE,
        providers: ["comfy-local"],
        cancelable: true,
        retryable: true,
    });
    registry.registerTool({
        id: "video_h3_i2v",
        capability: "video.generate",
        paramsSchema: { PROMPT: { type: "string" }, LENGTH: { type: "number" } },
        resourceClass: RESOURCE_CLASS.GPU_VIDEO,
        providers: ["comfy-local"],
        cancelable: true,
        retryable: true,
    });
    registry.registerTool({
        id: "ffmpeg_concat",
        capability: "video.concat",
        paramsSchema: {},
        resourceClass: RESOURCE_CLASS.CPU,
        providers: [],
        cancelable: false,
        retryable: true,
    });
    return registry;
}

test("注册与查询 Tool / Provider / Device 的基本字段", () => {
    const registry = baseRegistry();

    const tool = registry.getTool("img_zimage_artistic");
    assert.equal(tool.capability, "image.generate");
    assert.equal(tool.resourceClass, RESOURCE_CLASS.GPU_IMAGE);
    assert.deepEqual(tool.providers, ["comfy-local"]);
    assert.equal(tool.cancelable, true);
    assert.equal(tool.retryable, true);

    const provider = registry.getProvider("comfy-local");
    assert.equal(provider.kind, "comfy");
    assert.equal(provider.deviceId, "gpu-5060");
    assert.equal(provider.health, HEALTH.OK);

    const device = registry.getDevice("gpu-5060");
    assert.equal(device.vramTotalMb, 16384);
    assert.equal(device.maxConcurrency, 1);

    assert.equal(registry.getTool("不存在"), null);
    assert.deepEqual(registry.listTools().map((item) => item.id).sort(), ["ffmpeg_concat", "img_zimage_artistic", "video_h3_i2v"]);
    assert.deepEqual(registry.counts(), { tools: 3, providers: 3, devices: 2 });
});

test("按 resourceClass 分类过滤 Tool / Provider / Device", () => {
    const registry = baseRegistry();

    assert.deepEqual(registry.listTools({ resourceClass: RESOURCE_CLASS.GPU_VIDEO }).map((t) => t.id), ["video_h3_i2v"]);
    assert.deepEqual(registry.listTools({ resourceClass: RESOURCE_CLASS.CPU }).map((t) => t.id), ["ffmpeg_concat"]);
    assert.deepEqual(registry.listTools({ capability: "image.generate" }).map((t) => t.id), ["img_zimage_artistic"]);
    assert.deepEqual(registry.listTools({ provider: "comfy-local" }).map((t) => t.id).sort(), ["img_zimage_artistic", "video_h3_i2v"]);

    assert.deepEqual(registry.listProviders({ resourceClass: RESOURCE_CLASS.GPU_VIDEO }).map((p) => p.id), ["comfy-local"]);
    assert.deepEqual(registry.listProviders({ kind: "llm" }).map((p) => p.id), ["llm-local"]);
    assert.deepEqual(registry.listDevices({ resourceClass: RESOURCE_CLASS.CPU }).map((d) => d.id), ["cpu-ubuntu"]);
    assert.deepEqual(registry.listDevices({ resourceClass: RESOURCE_CLASS.GPU_VIDEO }).map((d) => d.id), ["gpu-5060"]);
});

test("能力路由：命中的 tool 返回可用 provider 与设备", () => {
    const registry = baseRegistry();

    const image = registry.canRun("img_zimage_artistic");
    assert.equal(image.ok, true);
    assert.equal(image.provider.id, "comfy-local");
    assert.equal(image.device.id, "gpu-5060");

    // 指定设备时同样命中。
    const video = registry.canRun("video_h3_i2v", { deviceId: "gpu-5060" });
    assert.equal(video.ok, true);
    assert.equal(video.device.id, "gpu-5060");

    // LLM / API 类不绑本地设备。
    registry.registerTool({
        id: "llm_chat",
        capability: "text.chat",
        paramsSchema: {},
        resourceClass: RESOURCE_CLASS.LLM,
        providers: ["llm-local"],
        cancelable: true,
        retryable: true,
    });
    const chat = registry.canRun("llm_chat");
    assert.equal(chat.ok, true);
    assert.equal(chat.device, null);
    assert.equal(chat.provider.id, "llm-local");
});

test("能力不匹配时拒绝：GPU_VIDEO 的 tool 不能落到只有 GPU_IMAGE 的设备", () => {
    const registry = createRegistry();
    // 设备只声明 GPU_IMAGE；provider 同时具备两类能力（避免在 provider 层先被拦）。
    registry.registerDevice({ id: "gpu-image-only", resourceClasses: [RESOURCE_CLASS.GPU_IMAGE] });
    registry.registerProvider({
        id: "comfy-mixed",
        kind: "comfy",
        resourceClasses: [RESOURCE_CLASS.GPU_IMAGE, RESOURCE_CLASS.GPU_VIDEO],
        deviceId: "gpu-image-only",
    });
    registry.registerTool({
        id: "video_x",
        capability: "video.generate",
        paramsSchema: {},
        resourceClass: RESOURCE_CLASS.GPU_VIDEO,
        providers: ["comfy-mixed"],
        cancelable: true,
        retryable: true,
    });

    // 无 GPU_VIDEO 设备可选。
    const noDevice = registry.canRun("video_x");
    assert.equal(noDevice.ok, false);
    assert.equal(noDevice.code, "RESOURCE_MISMATCH");

    // 显式指定一台不具备该能力的设备。
    const mismatch = registry.canRun("video_x", { deviceId: "gpu-image-only" });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, "RESOURCE_MISMATCH");
    assert.match(mismatch.reason, /不具备/);

    // provider 层不匹配：声明的 provider 只有 GPU_IMAGE。
    registry.registerProvider({ id: "comfy-image", kind: "comfy", resourceClasses: [RESOURCE_CLASS.GPU_IMAGE] });
    registry.registerTool({
        id: "video_y",
        capability: "video.generate",
        paramsSchema: {},
        resourceClass: RESOURCE_CLASS.GPU_VIDEO,
        providers: ["comfy-image"],
        cancelable: true,
        retryable: true,
    });
    assert.equal(registry.canRun("video_y").code, "RESOURCE_MISMATCH");

    // 未注册 tool / tool 未声明任何 provider。
    assert.equal(registry.canRun("nope").code, "UNKNOWN_TOOL");
    registry.registerTool({
        id: "tool_no_provider",
        capability: "video.concat",
        paramsSchema: {},
        resourceClass: RESOURCE_CLASS.CPU,
        providers: [],
        cancelable: false,
        retryable: true,
    });
    assert.equal(registry.canRun("tool_no_provider").code, "NO_PROVIDER");
});

test("设备或 Provider 不可用时拒绝，并给出降级候选；恢复后重新可用", () => {
    const registry = baseRegistry();

    registry.setDeviceHealth("gpu-5060", HEALTH.DOWN);
    const down = registry.canRun("img_zimage_artistic");
    assert.equal(down.ok, false);
    assert.equal(down.code, "DEVICE_UNAVAILABLE");
    assert.deepEqual(down.degraded, [{ kind: "device", id: "gpu-5060", health: HEALTH.DOWN }]);
    // 降级候选仍可被查询到（用于前端展示「排队/不可用」，不伪装成可用）。
    assert.deepEqual(registry.listDevices({ healthy: false }).map((d) => d.id), ["gpu-5060"]);
    assert.deepEqual(registry.listDevices({ healthy: true, resourceClass: RESOURCE_CLASS.GPU_IMAGE }).map((d) => d.id), []);

    // 显式指定不可用设备同样拒绝。
    assert.equal(registry.canRun("img_zimage_artistic", { deviceId: "gpu-5060" }).code, "DEVICE_UNAVAILABLE");

    registry.setDeviceHealth("gpu-5060", HEALTH.OK);
    assert.equal(registry.canRun("img_zimage_artistic").ok, true);

    registry.setProviderHealth("comfy-local", HEALTH.DOWN);
    const providerDown = registry.canRun("img_zimage_artistic");
    assert.equal(providerDown.ok, false);
    assert.equal(providerDown.code, "PROVIDER_UNAVAILABLE");
    assert.deepEqual(providerDown.degraded, [{ kind: "provider", id: "comfy-local", health: HEALTH.DOWN }]);

    registry.setProviderHealth("comfy-local", HEALTH.OK);
    assert.equal(registry.canRun("img_zimage_artistic").ok, true);
});

test("重复 id 默认抛错，replace:true 可覆盖", () => {
    const registry = baseRegistry();

    assert.throws(
        () => registry.registerTool({ ...registry.getTool("img_zimage_artistic") }),
        (error) => error.code === "DUPLICATE_ID",
    );
    assert.throws(
        () => registry.registerProvider({ ...registry.getProvider("comfy-local") }),
        (error) => error.code === "DUPLICATE_ID",
    );
    assert.throws(
        () => registry.registerDevice({ ...registry.getDevice("gpu-5060") }),
        (error) => error.code === "DUPLICATE_ID",
    );

    const replaced = registry.registerTool(
        { ...registry.getTool("img_zimage_artistic"), capability: "image.generate.v2" },
        { replace: true },
    );
    assert.equal(replaced.capability, "image.generate.v2");
    assert.equal(registry.getTool("img_zimage_artistic").capability, "image.generate.v2");
    assert.equal(registry.counts().tools, 3);
});

test("非法声明被拒绝（resourceClass / 必填字段 / health）", () => {
    const registry = createRegistry();

    assert.throws(
        () => registry.registerTool({ id: "bad", capability: "x", paramsSchema: {}, resourceClass: "GPU", providers: [], cancelable: true, retryable: true }),
        (error) => error.code === "INVALID_RESOURCE_CLASS",
    );
    assert.throws(
        () => registry.registerTool({ id: "bad", paramsSchema: {}, resourceClass: RESOURCE_CLASS.CPU, providers: [], cancelable: true, retryable: true }),
        (error) => error.code === "INVALID_TOOL",
    );
    assert.throws(
        () => registry.registerDevice({ id: "d", resourceClasses: [RESOURCE_CLASS.GPU_IMAGE], health: "broken" }),
        (error) => error.code === "INVALID_HEALTH",
    );
    assert.throws(() => registry.setDeviceHealth("missing", HEALTH.OK), (error) => error.code === "UNKNOWN_DEVICE");
});

test("探活超时约定：默认 8s，且不允许复用任务级长超时", () => {
    assert.equal(probeTimeoutOf({}), PROBE_TIMEOUT_MS);
    assert.equal(probeTimeoutOf({ probeTimeoutMs: 3000 }), 3000);
    // 传入任务级超时（如 RunningHub 30 分钟）会被钳到上限，避免探活被挂住。
    assert.equal(probeTimeoutOf({ probeTimeoutMs: 1_800_000 }), PROBE_TIMEOUT_MAX_MS);
    assert.equal(probeTimeoutOf({ probeTimeoutMs: -1 }), PROBE_TIMEOUT_MS);
});

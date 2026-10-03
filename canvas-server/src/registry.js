/**
 * Tool / Provider / Device Registry —— D6「按资源调度」的静态声明与查询层（P0-d 第一步）。
 *
 * 纯模块：只依赖 contracts.js 的冻结常量，无副作用、不读写文件、不接触网络、不启动任何循环。
 * 本模块只回答三件事：**有什么能力、现在能不能跑、该落在哪台设备**；**不实现队列与并发控制**
 * （jobs.js 的改造与路由接线留给后续批次）。注册表不主动探活，健康状态由接线方写入。
 *
 * 契约依据：
 * - domain-contract.md §3.9（Tool 字段：id/capability/paramsSchema/resourceClass/providers/cancelable/retryable）
 * - development-plan.md §5.3（Tool/Provider/Device Registry 要求）、§4.1 P0-d、§7.4（设备不可用等系统行为）
 */

import { RESOURCE_CLASS } from "./contracts.js";

/** resourceClass 合法取值（直接复用冻结契约，不另定义一份）。 */
const RESOURCE_CLASSES = new Set(Object.values(RESOURCE_CLASS));

/** 需要绑定本地设备才能执行的资源类别；LLM / API 允许无本地设备。 */
const DEVICE_BOUND = new Set([RESOURCE_CLASS.GPU_IMAGE, RESOURCE_CLASS.GPU_VIDEO, RESOURCE_CLASS.CPU]);

/** 健康状态：只有 OK 视为可用；UNKNOWN 不作可用（不拿没探过的设备去调度）。 */
export const HEALTH = Object.freeze({ OK: "ok", DOWN: "down", UNKNOWN: "unknown" });
const HEALTH_VALUES = new Set(Object.values(HEALTH));

/**
 * 探活/列资源类超时（毫秒）。**绝不能复用长任务超时**：
 * HANDOFF.md 记录过一个死渠道复用 chat 的 600s 超时，把 /api/health 挂住 20 分钟。
 */
export const PROBE_TIMEOUT_MS = 8_000;
export const PROBE_TIMEOUT_MAX_MS = 30_000;

function registryError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function ensureId(record, kind) {
    if (typeof record?.id !== "string" || !record.id.trim()) {
        throw registryError("INVALID_ID", `${kind} 缺少合法 id`);
    }
    return record.id;
}

function assertResourceClass(value, kind) {
    if (!RESOURCE_CLASSES.has(value)) {
        throw registryError("INVALID_RESOURCE_CLASS", `${kind} 的 resourceClass 非法：${value}`);
    }
}

/** Provider / Device 用 resourceClasses[] 声明（设备可同时具备 GPU_IMAGE 与 GPU_VIDEO）。 */
function normalizeClasses(record, kind) {
    const classes = record.resourceClasses ?? (record.resourceClass ? [record.resourceClass] : []);
    if (!Array.isArray(classes) || classes.length === 0) {
        throw registryError("INVALID_RESOURCE_CLASS", `${kind} 至少需要一个 resourceClass`);
    }
    for (const item of classes) assertResourceClass(item, kind);
    return [...new Set(classes)];
}

function assertHealth(value, kind) {
    if (value !== undefined && !HEALTH_VALUES.has(value)) {
        throw registryError("INVALID_HEALTH", `${kind} 的 health 非法：${value}`);
    }
    return value ?? HEALTH.OK;
}

function isHealthy(record) {
    return record.health === HEALTH.OK;
}

function supports(record, resourceClass) {
    return record.resourceClasses.includes(resourceClass);
}

/** 探活超时取值：record 可覆盖，但有上限，绝不允许传入任务级长超时。 */
export function probeTimeoutOf(record) {
    const raw = Number(record?.probeTimeoutMs);
    const value = Number.isFinite(raw) && raw > 0 ? raw : PROBE_TIMEOUT_MS;
    return Math.min(value, PROBE_TIMEOUT_MAX_MS);
}

function degrade(kind, record) {
    return { kind, id: record.id, health: record.health };
}

/**
 * 创建一份注册表实例。同一进程可持有多个（例如测试、按项目隔离），互不影响。
 */
export function createRegistry() {
    const tools = new Map();
    const providers = new Map();
    const devices = new Map();

    function add(store, kind, record, { replace = false } = {}) {
        ensureId(record, kind);
        if (store.has(record.id) && !replace) {
            throw registryError("DUPLICATE_ID", `${kind} id 已存在：${record.id}`);
        }
        store.set(record.id, { ...record });
        return record;
    }

    // ---- 注册 ----

    function registerTool(tool, options) {
        ensureId(tool, "Tool");
        if (typeof tool.capability !== "string" || !tool.capability.trim()) {
            throw registryError("INVALID_TOOL", `Tool 缺少 capability：${tool.id}`);
        }
        assertResourceClass(tool.resourceClass, "Tool");
        if (tool.paramsSchema === null || typeof tool.paramsSchema !== "object" || Array.isArray(tool.paramsSchema)) {
            throw registryError("INVALID_TOOL", `Tool 的 paramsSchema 必须是对象：${tool.id}`);
        }
        if (!Array.isArray(tool.providers) || tool.providers.some((id) => typeof id !== "string")) {
            throw registryError("INVALID_TOOL", `Tool 的 providers 必须是字符串数组：${tool.id}`);
        }
        if (typeof tool.cancelable !== "boolean" || typeof tool.retryable !== "boolean") {
            throw registryError("INVALID_TOOL", `Tool 的 cancelable/retryable 必须是布尔值：${tool.id}`);
        }
        return add(tools, "Tool", tool, options);
    }

    function registerProvider(provider, options) {
        ensureId(provider, "Provider");
        if (typeof provider.kind !== "string" || !provider.kind.trim()) {
            throw registryError("INVALID_PROVIDER", `Provider 缺少 kind：${provider.id}`);
        }
        const normalized = {
            ...provider,
            resourceClasses: normalizeClasses(provider, "Provider"),
            health: assertHealth(provider.health, "Provider"),
        };
        return add(providers, "Provider", normalized, options);
    }

    function registerDevice(device, options) {
        ensureId(device, "Device");
        const normalized = {
            ...device,
            resourceClasses: normalizeClasses(device, "Device"),
            health: assertHealth(device.health, "Device"),
            maxConcurrency: Number.isInteger(device.maxConcurrency) && device.maxConcurrency > 0 ? device.maxConcurrency : 1,
        };
        return add(devices, "Device", normalized, options);
    }

    // ---- 查询 ----

    function getTool(id) {
        return tools.get(id) || null;
    }

    function getProvider(id) {
        return providers.get(id) || null;
    }

    function getDevice(id) {
        return devices.get(id) || null;
    }

    function listTools(filter = {}) {
        return [...tools.values()].filter((tool) => {
            if (filter.resourceClass && tool.resourceClass !== filter.resourceClass) return false;
            if (filter.capability && tool.capability !== filter.capability) return false;
            if (filter.provider && !tool.providers.includes(filter.provider)) return false;
            return true;
        });
    }

    function listProviders(filter = {}) {
        return [...providers.values()].filter((provider) => {
            if (filter.resourceClass && !supports(provider, filter.resourceClass)) return false;
            if (filter.kind && provider.kind !== filter.kind) return false;
            if (filter.healthy === true && !isHealthy(provider)) return false;
            if (filter.healthy === false && isHealthy(provider)) return false;
            if (filter.deviceId && provider.deviceId !== filter.deviceId) return false;
            return true;
        });
    }

    function listDevices(filter = {}) {
        return [...devices.values()].filter((device) => {
            if (filter.resourceClass && !supports(device, filter.resourceClass)) return false;
            if (filter.healthy === true && !isHealthy(device)) return false;
            if (filter.healthy === false && isHealthy(device)) return false;
            return true;
        });
    }

    function setProviderHealth(id, health) {
        assertHealth(health, "Provider");
        const provider = providers.get(id);
        if (!provider) throw registryError("UNKNOWN_PROVIDER", `未注册的 Provider：${id}`);
        provider.health = health;
        return provider;
    }

    function setDeviceHealth(id, health) {
        assertHealth(health, "Device");
        const device = devices.get(id);
        if (!device) throw registryError("UNKNOWN_DEVICE", `未注册的 Device：${id}`);
        device.health = health;
        return device;
    }

    // ---- 能力路由（纯查询，不排队、不执行）----

    function reject(code, reason, extra = {}) {
        return { ok: false, code, reason, tool: null, provider: null, device: null, ...extra };
    }

    function pickProvider(candidates, deviceId) {
        return candidates.find((provider) => provider.deviceId === deviceId) || candidates[0];
    }

    /**
     * 回答「这个 tool 现在能不能跑、应该在哪台设备上跑」。
     * @param {string} toolId
     * @param {{ deviceId?: string }} [options] 指定设备时用于校验能力与健康。
     * @returns {{ ok: boolean, code?: string, reason?: string, tool?, provider?, device?, degraded?, undeclared? }}
     */
    function canRun(toolId, options = {}) {
        const { deviceId } = options;
        const tool = tools.get(toolId);
        if (!tool) return reject("UNKNOWN_TOOL", `未注册的 Tool：${toolId}`);

        const undeclared = tool.providers.filter((id) => !providers.has(id));
        const capable = tool.providers.map((id) => providers.get(id)).filter((p) => p && supports(p, tool.resourceClass));
        const healthy = capable.filter(isHealthy);

        if (capable.length === 0) {
            const code = tool.providers.length ? "RESOURCE_MISMATCH" : "NO_PROVIDER";
            return reject(code, `工具「${toolId}」需要 ${tool.resourceClass} 能力，没有支持的 Provider`, { undeclared });
        }
        if (healthy.length === 0) {
            return reject("PROVIDER_UNAVAILABLE", `工具「${toolId}」的 Provider 当前均不可用`, {
                undeclared,
                degraded: capable.map((p) => degrade("provider", p)),
            });
        }

        // LLM / API 允许没有本地设备。
        if (!DEVICE_BOUND.has(tool.resourceClass)) {
            return { ok: true, code: null, reason: null, tool, provider: healthy[0], device: null, undeclared };
        }

        const matching = [...devices.values()].filter((device) => supports(device, tool.resourceClass));

        if (deviceId !== undefined) {
            const requested = devices.get(deviceId);
            if (!requested || !supports(requested, tool.resourceClass)) {
                return reject("RESOURCE_MISMATCH", `设备「${deviceId}」不具备 ${tool.resourceClass} 能力`, {
                    undeclared,
                    degraded: matching.map((device) => degrade("device", device)),
                });
            }
            if (!isHealthy(requested)) {
                return reject("DEVICE_UNAVAILABLE", `设备「${deviceId}」当前不可用（${requested.health}）`, {
                    undeclared,
                    degraded: [degrade("device", requested)],
                });
            }
            return { ok: true, code: null, reason: null, tool, provider: pickProvider(healthy, requested.id), device: requested, undeclared };
        }

        const usable = matching.filter(isHealthy);
        if (usable.length === 0) {
            if (matching.length === 0) {
                return reject("RESOURCE_MISMATCH", `没有任何设备声明 ${tool.resourceClass} 能力`, { undeclared });
            }
            return reject("DEVICE_UNAVAILABLE", `具备 ${tool.resourceClass} 能力的设备当前均不可用`, {
                undeclared,
                degraded: matching.map((device) => degrade("device", device)),
            });
        }
        const device = usable[0];
        return { ok: true, code: null, reason: null, tool, provider: pickProvider(healthy, device.id), device, undeclared };
    }

    function counts() {
        return { tools: tools.size, providers: providers.size, devices: devices.size };
    }

    return {
        registerTool,
        registerProvider,
        registerDevice,
        getTool,
        getProvider,
        getDevice,
        listTools,
        listProviders,
        listDevices,
        setProviderHealth,
        setDeviceHealth,
        canRun,
        counts,
    };
}

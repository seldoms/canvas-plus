import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { compactApiParams } from "./request";
import { gatewayBaseUrl } from "./gateway";

/**
 * 模型注册表接口客户端（契约见 docs/content/docs/progress/model-registry-contract.md §3）。
 *
 * 模型清单由服务端唯一持有：浏览器渠道退化为「连接与凭据」，不再承担「有哪些模型」的职责。
 * 传输沿用 projects.ts 的写法：axios + gatewayBaseUrl，错误统一收敛成带中文提示的 Error。
 */

export type ModelCategory = "text" | "image" | "video" | "audio";
export type ModelRuntime = "local" | "cloud";

/** 条目附加元数据（服务端填，前端只读）；title 是别名回落链的一环。 */
export type ModelRegistryMeta = {
    family?: string;
    durations?: number[];
    durationMeta?: Record<string, unknown> | null;
    supportsReference?: boolean;
    referenceLimit?: number;
    title?: string;
    [key: string]: unknown;
};

/** §2 ModelEntry：注意 `name` 是真实标识，请求侧只用它；`alias` 仅影响展示。 */
export type ModelRegistryEntry = {
    id: string;
    name: string;
    /** §2.4 分组键（基座/模型名，如「千问2.1」「H3」）；同一 base 的条目归为一组，组头只显示一次。 */
    base?: string | null;
    /** §2.4 能力名（组内那一行的标题，如「文生图」「改图」）。 */
    task?: string | null;
    alias?: string | null;
    category: ModelCategory;
    enabled: boolean;
    runtime: ModelRuntime;
    provider?: string;
    source?: string;
    template?: string | null;
    channelId?: string | null;
    channelName?: string | null;
    script?: string;
    meta?: ModelRegistryMeta | null;
    stale?: boolean;
    createdAt?: string;
    updatedAt?: string;
};

export type ModelRegistryCounts = {
    text: number;
    image: number;
    video: number;
    audio: number;
    total: number;
    enabled: number;
};

export type ModelRegistryList = {
    models: ModelRegistryEntry[];
    counts: ModelRegistryCounts;
};

/** §3 available：服务端发现的可用模型清单（未登记项也在内）。 */
export type ModelRegistryAvailableEntry = {
    name: string;
    category: ModelCategory;
    runtime?: ModelRuntime;
    [key: string]: unknown;
};

export type ModelRegistryAvailable = {
    available: ModelRegistryAvailableEntry[];
    registered: number;
    missing: ModelRegistryAvailableEntry[];
};

export type ModelRegistrySyncResult = {
    added: ModelRegistryEntry[];
    staled: ModelRegistryEntry[];
    kept: number;
};

export type ModelRegistryCreateInput = {
    name: string;
    category: ModelCategory;
    alias?: string;
    enabled?: boolean;
    provider?: string;
    source?: string;
    template?: string;
    channelId?: string;
};

/** §3 PATCH：只允许改 base / task / alias / enabled / category（name 不可改）。 */
export type ModelRegistryPatchInput = {
    base?: string;
    task?: string;
    alias?: string;
    enabled?: boolean;
    category?: ModelCategory;
};

type RegistryApiError = Error & { status: number };

function registryError(message: string, status: number): RegistryApiError {
    return Object.assign(new Error(message), { status });
}

async function registryRequest<T>(config: AxiosRequestConfig): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl() });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status ?? 0;
            const payload = error.response?.data as { error?: { message?: string } } | undefined;
            if (payload?.error?.message) throw registryError(i18n.t("gateway.failed", { message: payload.error.message }), status);
            if (error.response) throw registryError(i18n.t("gateway.httpFailed", { status }), status);
            throw registryError(i18n.t("gateway.unreachable"), 0);
        }
        throw error instanceof Error ? error : registryError(i18n.t("gateway.unreachable"), 0);
    }
}

/** 列表响应兼容 `{ <key>: [] }` 外壳与裸数组。 */
function unwrapList<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === "object") {
        const value = (data as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value as T[];
    }
    return [];
}

/** 单实体响应兼容 `{ <key>: entity }` 外壳与裸实体。 */
function unwrapEntity<T>(data: unknown, keys: string[]): T {
    if (data && typeof data === "object") {
        const record = data as Record<string, unknown>;
        for (const key of keys) if (record[key] && typeof record[key] === "object") return record[key] as T;
    }
    return data as T;
}

function toNumber(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function countByCategory(models: ModelRegistryEntry[], category: ModelCategory) {
    return models.filter((model) => model.category === category).length;
}

function readCounts(source: unknown, models: ModelRegistryEntry[]): ModelRegistryCounts {
    const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
    return {
        text: toNumber(record.text, countByCategory(models, "text")),
        image: toNumber(record.image, countByCategory(models, "image")),
        video: toNumber(record.video, countByCategory(models, "video")),
        audio: toNumber(record.audio, countByCategory(models, "audio")),
        total: toNumber(record.total, models.length),
        enabled: toNumber(record.enabled, models.filter((model) => model.enabled).length),
    };
}

/**
 * 注册表响应必须是「对象且带 models 数组」或裸数组。
 * 网关还没挂 /api/model-registry 时会回落到托管的前端 index.html（返回字符串），
 * 这里直接判成不可用并抛错 —— 让调用方回退到浏览器渠道，而不是把 HTML 当成空清单。
 */
function assertRegistryPayload(data: unknown) {
    if (Array.isArray(data)) return;
    if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).models)) return;
    throw registryError(i18n.t("gateway.unreachable"), 0);
}

/** GET /api/model-registry：列出登记 + counts；支持 category / enabled 过滤。 */
export async function fetchModelRegistry(query?: { category?: string; enabled?: boolean }): Promise<ModelRegistryList> {
    const params = compactApiParams({ category: query?.category, enabled: query?.enabled ? "true" : undefined });
    const data = await registryRequest<unknown>({
        method: "get",
        url: "/api/model-registry",
        params: Object.keys(params).length ? params : undefined,
    });
    assertRegistryPayload(data);
    const models = unwrapList<ModelRegistryEntry>(data, "models");
    const source = data && typeof data === "object" ? (data as Record<string, unknown>).counts : undefined;
    return { models, counts: readCounts(source, models) };
}

/** 便捷：只要清单数组（picker 数据源）。 */
export async function listModelRegistry(query?: { category?: string; enabled?: boolean }) {
    return (await fetchModelRegistry(query)).models;
}

/** GET /api/model-registry/available：服务端可用模型清单 + 差异计数。 */
export async function fetchAvailableModels(): Promise<ModelRegistryAvailable> {
    const data = await registryRequest<unknown>({ method: "get", url: "/api/model-registry/available" });
    if (!Array.isArray(data) && (!data || typeof data !== "object")) throw registryError(i18n.t("gateway.unreachable"), 0);
    const available = unwrapList<ModelRegistryAvailableEntry>(data, "available");
    const registered = data && typeof data === "object" ? toNumber((data as Record<string, unknown>).registered, available.length) : available.length;
    return { available, registered, missing: unwrapList<ModelRegistryAvailableEntry>(data, "missing") };
}

/** POST /api/model-registry：新增登记（name 唯一，重复返回 409）。 */
export async function createModelRegistryEntry(input: ModelRegistryCreateInput) {
    const data = await registryRequest<unknown>({ method: "post", url: "/api/model-registry", data: input });
    return unwrapEntity<ModelRegistryEntry>(data, ["model", "entry"]);
}

/** PATCH /api/model-registry/:id：局部更新 alias / enabled / category。 */
export async function patchModelRegistryEntry(id: string, patch: ModelRegistryPatchInput) {
    const data = await registryRequest<unknown>({ method: "patch", url: `/api/model-registry/${encodeURIComponent(id)}`, data: patch });
    return unwrapEntity<ModelRegistryEntry>(data, ["model", "entry"]);
}

/** DELETE /api/model-registry/:id：只删登记，不动模板/渠道本身。 */
export async function deleteModelRegistryEntry(id: string) {
    await registryRequest<unknown>({ method: "delete", url: `/api/model-registry/${encodeURIComponent(id)}` });
}

/** POST /api/model-registry/sync：补缺 + 标记 stale（不覆盖用户 alias/enabled）。 */
export async function syncModelRegistry(): Promise<ModelRegistrySyncResult> {
    const data = await registryRequest<unknown>({ method: "post", url: "/api/model-registry/sync" });
    return {
        added: unwrapList<ModelRegistryEntry>(data, "added"),
        staled: unwrapList<ModelRegistryEntry>(data, "staled"),
        kept: data && typeof data === "object" ? toNumber((data as Record<string, unknown>).kept, 0) : 0,
    };
}

/** 展示名回落链：alias → meta.title → name（§2 / §4.3）。☁️ 由调用方按 runtime 加，不进文字。 */
export function modelRegistryDisplayName(entry: Pick<ModelRegistryEntry, "alias" | "name" | "meta">) {
    const alias = entry.alias?.trim();
    if (alias) return alias;
    const title = entry.meta?.title?.trim();
    if (title) return title;
    return entry.name;
}

/**
 * §2.4 分组键 base：以后端字段为准（**不从前端拆 alias**，避免把展示名当数据源）。
 * 字段尚未就绪时回落到展示名，保证「一组一条、组头非空」，页面不崩、不伪造分组。
 */
export function modelRegistryBase(entry: Pick<ModelRegistryEntry, "base" | "alias" | "name" | "meta">) {
    return entry.base?.trim() || modelRegistryDisplayName(entry);
}

/**
 * §2.4 组内行的 task（能力名）：以后端字段为准。
 * - base 已就绪但 task 缺失：行内回落展示名，不丢信息；
 * - base 也缺失（字段未就绪的过渡态）：组头已承担展示名，行内返回空串，避免同一串文字上下重复。
 */
export function modelRegistryTask(entry: Pick<ModelRegistryEntry, "task" | "base" | "alias" | "name" | "meta">) {
    const task = entry.task?.trim();
    if (task) return task;
    return entry.base?.trim() ? modelRegistryDisplayName(entry) : "";
}

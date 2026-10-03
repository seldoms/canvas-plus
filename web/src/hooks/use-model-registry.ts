import { useEffect, useState } from "react";

import { listModelRegistry, type ModelRegistryEntry } from "@/services/api/model-registry";

/**
 * 工作台模型下拉的数据源：读服务端模型注册表（只读）。
 *
 * 返回 status 让调用方区分「注册表已就绪但为空」与「接口不可用」：
 * - ready：服务端持有清单，picker 以它为准（即使为空也不再回退浏览器渠道）。
 * - loading / error / idle：接口没就绪（网关回落 SPA、后端未上线等），调用方回退浏览器渠道，保持旧行为。
 */

export type RegistryModelsStatus = "idle" | "loading" | "ready" | "error";
export type RegistryModelsState = { status: RegistryModelsStatus; models: ModelRegistryEntry[] };

const EMPTY_STATE: RegistryModelsState = { status: "idle", models: [] };
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; state: RegistryModelsState }>();
const inflight = new Map<string, Promise<RegistryModelsState>>();
const listeners = new Set<() => void>();
let version = 0;

function cachedState(key: string): RegistryModelsState {
    if (!key) return EMPTY_STATE;
    return cache.get(key)?.state ?? { status: "loading", models: [] };
}

/** 写操作（PATCH / sync）后清缓存，让已挂载的 picker 重新拉取。 */
export function invalidateRegistryModelCache() {
    cache.clear();
    version += 1;
    listeners.forEach((listener) => listener());
}

async function loadRegistryModels(category: string): Promise<RegistryModelsState> {
    const existing = inflight.get(category);
    if (existing) return existing;
    const promise = listModelRegistry({ enabled: true, category })
        .then((models): RegistryModelsState => ({ status: "ready", models }))
        .catch((): RegistryModelsState => ({ status: "error", models: [] }))
        .then((state) => {
            cache.set(category, { at: Date.now(), state });
            inflight.delete(category);
            return state;
        });
    inflight.set(category, promise);
    return promise;
}

export function useRegistryModelOptions(category?: string): RegistryModelsState {
    const key = (category || "").trim();
    const [state, setState] = useState<RegistryModelsState>(() => cachedState(key));
    const [tick, setTick] = useState(version);

    useEffect(() => {
        const rerender = () => setTick(version);
        listeners.add(rerender);
        return () => {
            listeners.delete(rerender);
        };
    }, []);

    useEffect(() => {
        if (!key) {
            setState(EMPTY_STATE);
            return;
        }
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            setState(cached.state);
            return;
        }
        let active = true;
        setState({ status: "loading", models: cached?.state.models ?? [] });
        void loadRegistryModels(key).then((next) => {
            if (active) setState(next);
        });
        return () => {
            active = false;
        };
        // tick 变化 = 强制失效重取（invalidateRegistryModelCache）。
    }, [key, tick]);

    return state;
}

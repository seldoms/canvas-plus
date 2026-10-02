import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import type { GatewayPipelineRunStageSummary } from "@/services/api/gateway";

/** 最近 run 的本地记录：后端没有重命名端点，改名只改这里，用于刷新后辨认历史。 */
export type PipelineRunRecord = {
    id: string;
    title: string;
    createdAt: string;
    /** 后端列表带来的阶段「标题 + 状态」摘要，供历史列表展示；旧记录可能没有。 */
    stages?: Record<string, GatewayPipelineRunStageSummary>;
};

const PIPELINE_RUNS_KEY = "infinite-canvas:pipeline_runs_v1";
/** 只留最近这些条，避免 localforage 无限增长。 */
const MAX_RECENT_RUNS = 30;

type PipelineStore = {
    hydrated: boolean;
    recentRuns: PipelineRunRecord[];
    /** 最近一次打开的 run，刷新后据此自动恢复。 */
    activeRunId: string;
    setActiveRun: (id: string) => void;
    upsertRun: (run: PipelineRunRecord) => void;
    renameRun: (id: string, title: string) => void;
    /** 用后端列表（权威的 run 清单）覆盖本地列表，但保留用户已改的本地标题。 */
    syncRuns: (runs: PipelineRunRecord[]) => void;
};

// localforage 是异步字符串存储，包一层 JSON 序列化给 zustand persist（与 use-asset-store 同款写法）。
const pipelineStorage: PersistStorage<PipelineStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        return value ? (JSON.parse(value) as StorageValue<PipelineStore>) : null;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const usePipelineStore = create<PipelineStore>()(
    persist(
        (set) => ({
            hydrated: false,
            recentRuns: [],
            activeRunId: "",
            setActiveRun: (id) => set({ activeRunId: id }),
            // 已有本地记录时保留其标题（可能已被改名），只刷新阶段摘要。
            upsertRun: (run) =>
                set((state) =>
                    state.recentRuns.some((item) => item.id === run.id)
                        ? { recentRuns: state.recentRuns.map((item) => (item.id === run.id ? { ...item, stages: run.stages ?? item.stages } : item)) }
                        : { recentRuns: [run, ...state.recentRuns].slice(0, MAX_RECENT_RUNS) },
                ),
            renameRun: (id, title) => set((state) => ({ recentRuns: state.recentRuns.map((item) => (item.id === id ? { ...item, title } : item)) })),
            syncRuns: (runs) =>
                set((state) => {
                    const titles = new Map(state.recentRuns.map((item) => [item.id, item.title]));
                    return { recentRuns: runs.map((run) => ({ ...run, title: titles.get(run.id) ?? run.title })).slice(0, MAX_RECENT_RUNS) };
                }),
        }),
        {
            name: PIPELINE_RUNS_KEY,
            storage: pipelineStorage,
            partialize: (state) => ({ recentRuns: state.recentRuns, activeRunId: state.activeRunId }) as StorageValue<PipelineStore>["state"],
            onRehydrateStorage: () => () => {
                usePipelineStore.setState({ hydrated: true });
            },
        },
    ),
);

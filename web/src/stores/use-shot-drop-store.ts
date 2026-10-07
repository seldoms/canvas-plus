import { create } from "zustand";

import type { StoryboardShot } from "@/lib/canvas/shot-bridge";
import type { CanvasShotRef } from "@/types/canvas";

/**
 * 「分镜镜头发到画布」的跨页投递单（P2-B5）。
 *
 * 为什么走 store 而不是 router state：画布数据只存在浏览器 IndexedDB 里，跨页带参数
 * 必须经过 store（与 P0 `setActiveRun` 同一套做法）。
 *
 * 为什么**不进 persist**：这是一次性投递单，落盘会在刷新后留下幽灵任务——用户刷新一下，
 * 画布凭空多出几个节点，而且他自己不记得为什么。不落盘，最多丢一次投递。
 */
export type CanvasShotDrop = {
    /** 目标画布 id（画布本地 id，不是服务端 projectId）。 */
    canvasId: string;
    shots: StoryboardShot[];
    ref: Omit<CanvasShotRef, "shotId">;
    /** 集/场的可读标签，用于节点标题（如「第1集 · 内景」）。 */
    labels?: { episode?: string | null; scene?: string | null };
};

type ShotDropStore = {
    pending: CanvasShotDrop | null;
    /** 投递分镜：写入待处理单，画布页挂载时消费。 */
    drop: (drop: CanvasShotDrop) => void;
    /** 画布页消费后清空（只消费一次，避免重复插节点）。 */
    take: (canvasId: string) => CanvasShotDrop | null;
    clear: () => void;
};

export const useShotDropStore = create<ShotDropStore>()((set, get) => ({
    pending: null,
    drop: (drop) => set({ pending: drop }),
    take: (canvasId) => {
        const current = get().pending;
        if (!current || current.canvasId !== canvasId) return null;
        set({ pending: null });
        return current;
    },
    clear: () => set({ pending: null }),
}));
import type { GatewayPipelineRunSummary, GatewayStageStatus } from "@/services/api/gateway";

/**
 * 工作区阶段门禁推导（P0-a M4，**临时实现**）。
 *
 * 现状：`GET /api/projects/:id/context` 只回 `{ project, episodes, runIds, canvasIds }`，
 * 没有 p0a 方案 §3.2 建议的服务端 `stageGates[]`。因此这里用**项目关联 run 的阶段状态**
 * 在前端推导门禁：拿 `listPipelineRuns()` 的摘要，按 `context.runIds` 过滤后合并成
 * 「阶段 → 状态」。等 M2 补上服务端 `stageGates[]` 后，本文件应整体替换为直接读该字段。
 *
 * 不造假：读不到阶段状态时返回 `unknown`（不拦截），绝不臆造完成度。
 */

export type StageStatusMap = Record<string, GatewayStageStatus>;

/** 状态优先级：done 最高，用于把多个 run 的同一阶段收敛成一个状态。 */
const STATUS_PRIORITY: GatewayStageStatus[] = ["done", "running", "partial", "error", "canceled", "pending"];

/** 把项目关联的多个 run 的阶段摘要合并成「阶段 → 状态」；同一阶段取优先级最高的状态。 */
export function mergeStageStatus(runs: GatewayPipelineRunSummary[], runIds: string[]): StageStatusMap {
    const linked = new Set(runIds);
    const merged: StageStatusMap = {};
    for (const run of runs) {
        if (!linked.has(run.id)) continue;
        for (const [stageId, stage] of Object.entries(run.stages)) {
            const current = merged[stageId];
            if (!current || STATUS_PRIORITY.indexOf(stage.status) < STATUS_PRIORITY.indexOf(current)) merged[stageId] = stage.status;
        }
    }
    return merged;
}

/** 从阶段状态里挑出某几个状态对应的阶段 id，用于「运行中 / 失败待续跑」提示。 */
export function stagesWithStatus(stageStatus: StageStatusMap, statuses: GatewayStageStatus[]) {
    return Object.entries(stageStatus)
        .filter(([, status]) => statuses.includes(status))
        .map(([stageId]) => stageId);
}

export type GateState = "ready" | "blocked" | "unknown";

export type WorkspaceGate = {
    state: GateState;
    /** 未完成（非 done）的上游阶段 id；blocked 时有值。 */
    blockedStages: string[];
    /** 是否存在未解决的「阻断级」风险提示（ReviewNote.level = "block"，R9）。 */
    blockedByNotes: boolean;
};

/**
 * 门禁判定：上游阶段全部 done 且无未解决 block 提示才放行。
 * - 有 block 风险提示 → blocked（R9：block 作为阶段门禁阻断）。
 * - 无上游要求 → ready。
 * - 有上游要求但读不到阶段状态（项目无关联 run / 网关不可达）→ unknown，不拦截。
 * - 有阶段状态但上游未完成 → blocked，并回未完成阶段 id。
 */
export function evaluateGate(requires: string[], stageStatus: StageStatusMap, hasRunInfo: boolean, blockingNoteCount: number): WorkspaceGate {
    const blockedStages = requires.filter((stage) => stageStatus[stage] !== "done");
    if (blockingNoteCount > 0) return { state: "blocked", blockedStages, blockedByNotes: true };
    if (!requires.length) return { state: "ready", blockedStages: [], blockedByNotes: false };
    if (!hasRunInfo) return { state: "unknown", blockedStages, blockedByNotes: false };
    if (blockedStages.length) return { state: "blocked", blockedStages, blockedByNotes: false };
    return { state: "ready", blockedStages: [], blockedByNotes: false };
}

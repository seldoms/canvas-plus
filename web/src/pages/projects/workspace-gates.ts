import type { GatewayPipelineRunSummary, GatewayStageStatus } from "@/services/api/gateway";
import type { ProjectGate } from "@/services/api/projects";

import type { WorkspaceDef } from "./workspaces";
import { WORKSPACES } from "./workspaces";

/**
 * 工作区阶段门禁推导（P0-a M4）。
 *
 * 优先级：服务端 `GET /api/projects/:id/gates` 里本工作区阶段的判定（`resolveWorkspaceGate`）；
 * 服务端不可用（未就绪 / 404 / 网关不可达）时回退到**前端根据关联 run 的阶段状态**推导：
 * 拿 `listPipelineRuns()` 的摘要，按**当前选中的 run**（多 run 时由工作区选择器切换，默认第一个）
 * 过滤后合并成「阶段 → 状态」—— 不再固定取 `runIds[0]`。
 *
 * 不造假：读不到阶段状态时返回 `unknown`（不拦截），绝不臆造完成度。
 */

export type StageStatusMap = Record<string, GatewayStageStatus>;

/** 状态优先级：done 最高，用于把多个 run 的同一阶段收敛成一个状态。 */
// blocked 表示「被阻断、没跑」（参考图能力不足 / 素材缺失，不入队），不是「跑错了」：
// error 是执行失败需排障，blocked 是前置条件缺失需补料，故排在 error 之后；
// 又比 canceled（用户主动取消）更该被看见，故排在 canceled 之前、pending 之前。
const STATUS_PRIORITY: GatewayStageStatus[] = ["done", "running", "partial", "error", "blocked", "canceled", "pending"];

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

/** 门禁结论来自服务端 /gates 还是前端回退推导。 */
export type GateSource = "server" | "fallback";

export type WorkspaceGate = {
    state: GateState;
    /** 未完成（非 done）或被阻断的上游阶段 id；blocked 时有值。 */
    blockedStages: string[];
    /** 是否存在未解决的「阻断级」风险提示（ReviewNote.level = "block"，R9）；仅回退推导时有值。 */
    blockedByNotes: boolean;
    /** 服务端门禁的原因说明；source = server 时优先展示。 */
    reason?: string;
    source: GateSource;
};

/**
 * 回退推导：上游阶段全部 done 且无未解决 block 提示才放行。
 * - 有 block 风险提示 → blocked（R9：block 作为阶段门禁阻断）。
 * - 无上游要求 → ready。
 * - 有上游要求但读不到阶段状态（项目无关联 run / 网关不可达）→ unknown，不拦截。
 * - 有阶段状态但上游未完成 → blocked，并回未完成阶段 id。
 */
export function evaluateGate(requires: string[], stageStatus: StageStatusMap, hasRunInfo: boolean, blockingNoteCount: number): WorkspaceGate {
    const blockedStages = requires.filter((stage) => stageStatus[stage] !== "done");
    if (blockingNoteCount > 0) return { state: "blocked", blockedStages, blockedByNotes: true, source: "fallback" };
    if (!requires.length) return { state: "ready", blockedStages: [], blockedByNotes: false, source: "fallback" };
    if (!hasRunInfo) return { state: "unknown", blockedStages, blockedByNotes: false, source: "fallback" };
    if (blockedStages.length) return { state: "blocked", blockedStages, blockedByNotes: false, source: "fallback" };
    return { state: "ready", blockedStages: [], blockedByNotes: false, source: "fallback" };
}

/**
 * 工作区门禁：优先用服务端 /gates 中本工作区阶段（`workspace.stage`）的判定；
 * 该阶段无门禁（如 canvas）或服务端不可用时回退前端推导。
 */
export function resolveWorkspaceGate(
    workspace: WorkspaceDef,
    stageStatus: StageStatusMap,
    hasRunInfo: boolean,
    blockingNoteCount: number,
    serverGates: ProjectGate[],
): WorkspaceGate {
    const server = workspace.stage ? serverGates.find((gate) => gate.stageId === workspace.stage) : undefined;
    if (server) {
        return {
            state: server.ready ? "ready" : "blocked",
            blockedStages: server.blockedBy,
            blockedByNotes: false,
            reason: server.reason,
            source: "server",
        };
    }
    return evaluateGate(workspace.requires, stageStatus, hasRunInfo, blockingNoteCount);
}

/**
 * 本工作区能否直接运行本阶段（P0-a 运行入口门禁）。
 * 与「能否查看」区分：查看在 unknown 时不拦截，但**运行会绕过门禁**，所以要求更严：
 * - 无阶段（canvas）→ 不可运行；
 * - 门禁 blocked → 不可运行；
 * - 有上游要求但状态未确认（unknown，如无关联 run / 服务端 /gates 不可用）→ 不可运行，避免跳过上游直接产出；
 * - 阶段本身无上游要求（如剧本）→ 放行。
 */
export function canRunStage(workspace: WorkspaceDef, gate: WorkspaceGate) {
    if (!workspace.stage) return false;
    if (gate.state === "blocked") return false;
    if (workspace.requires.length && gate.state !== "ready") return false;
    return true;
}

/** 项目「下一步」：按工作区阶段顺序找出第一个还没 done 的阶段，给出能否运行与原因。 */
export type NextStep = {
    stage: string;
    runnable: boolean;
    reason: string;
    blockedStages: string[];
    source: GateSource;
};

/**
 * 总览页「下一步」推导：门禁优先。
 * 阶段顺序以 workspaces.ts 为唯一来源（canvas 无阶段，跳过）；已 done 的阶段（据关联 run 状态）跳过。
 * 服务端 /gates 命中该阶段时用其 ready/reason；未就绪或命名暂不匹配时回退前端推导，读不到就不臆造（runnable=false）。
 */
export function resolveNextStep(gates: ProjectGate[], stageStatus: StageStatusMap): NextStep | null {
    const order = WORKSPACES.map((item) => item.stage).filter((stage): stage is string => Boolean(stage));
    const stage = order.find((item) => stageStatus[item] !== "done");
    if (!stage) return null;
    const server = gates.find((gate) => gate.stageId === stage);
    if (server) return { stage, runnable: server.ready, reason: server.reason, blockedStages: server.blockedBy, source: "server" };
    const def = WORKSPACES.find((item) => item.stage === stage);
    const blockedStages = (def?.requires ?? []).filter((item) => stageStatus[item] !== "done");
    return { stage, runnable: blockedStages.length === 0, reason: "", blockedStages, source: "fallback" };
}

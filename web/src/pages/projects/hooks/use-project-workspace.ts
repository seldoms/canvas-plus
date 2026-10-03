import { useCallback, useEffect, useMemo, useState } from "react";

import { listPipelineRuns, type GatewayPipelineRunSummary } from "@/services/api/gateway";
import { listProjectGates, type ProjectGate } from "@/services/api/projects";

import { mergeStageStatus } from "../workspace-gates";
import { useProjectDetail } from "./use-project-detail";

/**
 * 工作区页面私有 hook：加载项目上下文 + 关联 run 的阶段状态 + 服务端阶段门禁，供各工作区消费。
 *
 * 页面只消费这里返回的数据与动作，不直接碰请求；门禁判定放 workspace-gates.ts，
 * 本 hook 只负责「取数据 + 组合」。服务端 /gates 不可用时清空 gates，由判定函数回退前端推导。
 */
export function useProjectWorkspace(projectId: string) {
    const { context, loading, error, refresh: refreshContext } = useProjectDetail(projectId);
    const [runs, setRuns] = useState<GatewayPipelineRunSummary[]>([]);
    const [runsLoading, setRunsLoading] = useState(false);
    const [runsError, setRunsError] = useState("");
    const [gates, setGates] = useState<ProjectGate[]>([]);
    const [gatesLoading, setGatesLoading] = useState(false);
    /** 会话内选中的 run（多 run 时工作区选择器切换）；不落盘，刷新后回落第一个。 */
    const [selectedRunId, setSelectedRunId] = useState("");

    /** 项目关联 run；选择器与门禁/时间线都以它为准。 */
    const runIds = context?.runIds ?? [];
    /** 当前选中的 run：选择有效则用它，否则回落第一个（保持既有默认行为）。 */
    const activeRunId = selectedRunId && runIds.includes(selectedRunId) ? selectedRunId : runIds[0] ?? "";
    const selectRun = useCallback((id: string) => setSelectedRunId(id), []);

    /** 关联 run 的阶段状态来自全局 run 列表（后端暂无 project 级摘要接口，见回报的风险点）。 */
    const loadRuns = useCallback(async () => {
        setRunsLoading(true);
        setRunsError("");
        try {
            setRuns(await listPipelineRuns());
        } catch (loadError) {
            setRunsError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setRunsLoading(false);
        }
    }, []);

    /** 服务端门禁；后端未就绪（404 / 网关不可达）时清空，判定函数自动回退前端推导。 */
    const loadGates = useCallback(async () => {
        if (!projectId) return;
        setGatesLoading(true);
        try {
            setGates(await listProjectGates(projectId));
        } catch {
            setGates([]);
        } finally {
            setGatesLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void loadRuns();
    }, [loadRuns]);

    useEffect(() => {
        void loadGates();
    }, [loadGates]);

    const stageStatus = useMemo(() => mergeStageStatus(runs, activeRunId ? [activeRunId] : []), [runs, activeRunId]);
    const hasRunInfo = Object.keys(stageStatus).length > 0;
    const blockingNotes = useMemo(() => (context?.project.reviewNotes ?? []).filter((note) => note.level === "block" && !note.resolvedAt), [context]);

    const refresh = useCallback(async () => {
        await Promise.all([refreshContext(), loadRuns(), loadGates()]);
    }, [refreshContext, loadRuns, loadGates]);

    return { context, loading, error, refresh, stageStatus, hasRunInfo, blockingNotes, runsLoading, runsError, gates, gatesLoading, runIds, activeRunId, selectRun };
}

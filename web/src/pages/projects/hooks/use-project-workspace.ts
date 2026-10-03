import { useCallback, useEffect, useMemo, useState } from "react";

import { listPipelineRuns, type GatewayPipelineRunSummary } from "@/services/api/gateway";

import { mergeStageStatus } from "../workspace-gates";
import { useProjectDetail } from "./use-project-detail";

/**
 * 工作区页面私有 hook：加载项目上下文 + 关联 run 的阶段状态，供各工作区骨架消费。
 *
 * 页面只消费这里返回的数据与动作，不直接碰请求；门禁推导放 workspace-gates.ts，
 * 本 hook 只负责「取数据 + 组合」。`stageGates[]` 落地前的临时方案，见 workspace-gates.ts。
 */
export function useProjectWorkspace(projectId: string) {
    const { context, loading, error, refresh: refreshContext } = useProjectDetail(projectId);
    const [runs, setRuns] = useState<GatewayPipelineRunSummary[]>([]);
    const [runsLoading, setRunsLoading] = useState(false);
    const [runsError, setRunsError] = useState("");

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

    useEffect(() => {
        void loadRuns();
    }, [loadRuns]);

    const stageStatus = useMemo(() => mergeStageStatus(runs, context?.runIds ?? []), [runs, context]);
    const hasRunInfo = Object.keys(stageStatus).length > 0;
    const blockingNotes = useMemo(() => (context?.project.reviewNotes ?? []).filter((note) => note.level === "block" && !note.resolvedAt), [context]);

    const refresh = useCallback(async () => {
        await Promise.all([refreshContext(), loadRuns()]);
    }, [refreshContext, loadRuns]);

    return { context, loading, error, refresh, stageStatus, hasRunInfo, blockingNotes, runsLoading, runsError };
}

import { useMemo } from "react";
import { useParams } from "react-router-dom";

import { KeyframeBoard } from "./components/keyframe-board";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useKeyframeJobErrors, useKeyframeRun } from "./hooks/use-project-keyframes";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { buildKeyframeShots, failedJobIds } from "./keyframes-model";
import { getWorkspace } from "./workspaces";

/** 关键帧工作区：按镜头分组展示关键帧候选图（站内弹窗预览），显示模板/种子/参考图数量与失败原因。 */
export default function KeyframesWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    const { run, loading, error } = useKeyframeRun({ runId: workspace.activeRunId, stageStatus: workspace.stageStatus.keyframe ?? "" });
    const jobIds = useMemo(() => failedJobIds(run), [run]);
    const jobErrors = useKeyframeJobErrors(jobIds);
    const shots = useMemo(() => buildKeyframeShots(run, jobErrors), [run, jobErrors]);

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("keyframes")} {...workspace}>
            <KeyframeBoard shots={shots} loading={loading} error={error} onRetry={() => void workspace.refresh()} />
        </WorkspaceLayout>
    );
}

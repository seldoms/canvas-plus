import { useParams } from "react-router-dom";

import { CastingBoard } from "./components/casting-board";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectCasting } from "./hooks/use-project-casting";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/**
 * 角色定妆工作区：每个角色一张身份卡（定脸 + 定声音），站内弹窗试听平台音色。
 * 未确认角色时下游（关键帧 / 配音）显示为「已阻断」，并写清哪个角色缺脸还是缺声。
 */
export default function CastingWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    const casting = useProjectCasting({ runId: workspace.activeRunId, stageStatus: workspace.stageStatus.casting ?? "" });

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("casting")} {...workspace}>
            <CastingBoard
                views={casting.views}
                voices={casting.voices}
                labels={casting.labels}
                loading={casting.loading}
                error={casting.error}
                voicesError={casting.voicesError}
                saving={casting.saving}
                actionError={casting.actionError}
                onConfirm={casting.confirm}
                onModify={casting.modify}
                onVoiceChange={casting.changeVoice}
                onGenerateFace={() => void casting.generateFace()}
                onPreview={casting.preview}
                onRetry={() => void casting.refresh()}
            />
        </WorkspaceLayout>
    );
}

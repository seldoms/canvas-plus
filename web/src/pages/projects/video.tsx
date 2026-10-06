import { useParams } from "react-router-dom";

import { ContinuationBoard } from "./components/continuation-board";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/**
 * 视频·后期工作区：门禁与上游状态由 WorkspaceLayout 承担；正文挂 H3 续接链面板（M3.5-D2），
 * 整片拼接/导出仍由既有 /pipeline 与「导出成片」面板负责。
 */
export default function VideoWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("video")} {...workspace}>
            <ContinuationBoard projectId={projectId} />
        </WorkspaceLayout>
    );
}

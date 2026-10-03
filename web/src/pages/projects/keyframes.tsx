import { useParams } from "react-router-dom";

import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 关键帧工作区骨架（P0-a M4）：展示上游资产状态与门禁；候选/采用能力后续开放。 */
export default function KeyframesWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return <WorkspaceLayout projectId={projectId} workspace={getWorkspace("keyframes")} {...workspace} />;
}

import { useParams } from "react-router-dom";

import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 视频·后期工作区骨架（P0-a M4）：展示关键帧上游状态与门禁；拼接/导出由既有 /pipeline 承担。 */
export default function VideoWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return <WorkspaceLayout projectId={projectId} workspace={getWorkspace("video")} {...workspace} />;
}

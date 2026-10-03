import { useParams } from "react-router-dom";

import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 分镜工作区骨架（P0-a M4）：展示已确认剧本与阶段门禁，编辑能力后续开放。 */
export default function StoryboardWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return <WorkspaceLayout projectId={projectId} workspace={getWorkspace("storyboard")} {...workspace} />;
}

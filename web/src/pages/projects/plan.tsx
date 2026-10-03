import { useParams } from "react-router-dom";

import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 规划·剧本工作区骨架（P0-a M4）：只读展示上下文与阶段门禁，写入动作跳转既有 /pipeline。 */
export default function PlanWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return <WorkspaceLayout projectId={projectId} workspace={getWorkspace("plan")} {...workspace} />;
}

import { useParams } from "react-router-dom";

import { ProjectSourcePanel } from "./components/project-source-panel";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 规划·剧本工作区（P0-a M4）：展示上下文与门禁，并在本工作区内提供唯一的「导入 / 替换原文」入口。 */
export default function PlanWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    // project.sourceRevisionId 目前不在 Project 类型里（后端有落盘），这里按契约取一次。
    const sourceRevisionId = (workspace.context?.project as { sourceRevisionId?: string | null } | undefined)?.sourceRevisionId ?? null;
    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("plan")} {...workspace}>
            <ProjectSourcePanel projectId={projectId} sourceRevisionId={sourceRevisionId} refresh={workspace.refresh} />
        </WorkspaceLayout>
    );
}

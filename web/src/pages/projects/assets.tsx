import { useParams } from "react-router-dom";

import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 资产工作区骨架（P0-a M4）：展示分镜上下游与门禁；全局素材库 /assets 不动，项目内资产引用后续接入。 */
export default function AssetsWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return <WorkspaceLayout projectId={projectId} workspace={getWorkspace("assets")} {...workspace} />;
}

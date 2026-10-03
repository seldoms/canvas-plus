import { useParams } from "react-router-dom";

import { AssetRefPanel } from "./components/asset-ref-panel";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectAssets } from "./hooks/use-project-assets";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/**
 * 资产工作区（P0-a）：按 role 分组展示**项目 AssetRef（服务端上下文）**，可登记新引用、改绑定对象、切换采用的产物。
 * 每条带产物缩略图，点缩略图站内弹窗预览。
 */
export default function AssetsWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    // 唯一数据源：项目上下文的 assetRefs（服务端），不再读前端本地素材 store。
    const assets = useProjectAssets(projectId, workspace.context?.project.assetRefs);

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("assets")} {...workspace}>
            <AssetRefPanel
                refs={assets.refs}
                script={workspace.context?.project.script}
                loading={workspace.loading}
                onPatch={assets.patchRef}
                onAdd={assets.addRef}
                creating={assets.creating}
                savingRefId={assets.savingRefId}
            />
        </WorkspaceLayout>
    );
}

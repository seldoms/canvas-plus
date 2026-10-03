import { useParams } from "react-router-dom";

import { AssetRefPanel } from "./components/asset-ref-panel";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectAssets } from "./hooks/use-project-assets";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 资产工作区（P0-a）：按 role 分组展示 AssetRef，可登记新引用、改绑定对象、切换采用的产物。 */
export default function AssetsWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    const assets = useProjectAssets(projectId);

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("assets")} {...workspace}>
            <AssetRefPanel
                refs={assets.refs}
                loading={assets.loading}
                error={assets.error}
                onRetry={() => void assets.refresh()}
                onPatch={assets.patchRef}
                onAdd={assets.addRef}
                creating={assets.creating}
                savingRefId={assets.savingRefId}
            />
        </WorkspaceLayout>
    );
}

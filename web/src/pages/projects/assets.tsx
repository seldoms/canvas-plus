import { useParams } from "react-router-dom";

import { AssetPackOverview } from "./components/asset-pack-overview";
import { AssetRefPanel } from "./components/asset-ref-panel";
import { ConsistencyPanel } from "./components/consistency-panel";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectAssets } from "./hooks/use-project-assets";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/**
 * 资产工作区（P0-a）：两层视图 —— **资料包总览（按剧本实体）** + **引用清单（按条目）**。
 * 上层回答「还差谁」，下层回答「怎么改」；两者同一个数据源（服务端项目上下文的 assetRefs）。
 */
export default function AssetsWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    // 唯一数据源：项目上下文的 assetRefs（服务端），不再读前端本地素材 store。
    const assets = useProjectAssets(projectId, workspace.context?.project.assetRefs);

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("assets")} {...workspace}>
            {/* 口径体检放最前：改资产之前先看清「现在改会踩到什么」。只读，不代劳修复。 */}
            <ConsistencyPanel projectId={projectId} />
            <AssetPackOverview refs={assets.refs} script={workspace.context?.project.script} loading={workspace.loading} />
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

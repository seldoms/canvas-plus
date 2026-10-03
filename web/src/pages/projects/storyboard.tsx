import { useParams } from "react-router-dom";

import { StoryboardBoard } from "./components/storyboard-board";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { useStoryboard } from "./hooks/use-storyboard";
import { getWorkspace } from "./workspaces";

/** 分镜工作区（P0-a）：集 → 场 → 镜三层展示，镜级就地编辑与调序，关联资产摘要。 */
export default function StoryboardWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    const storyboard = useStoryboard(projectId, workspace.context?.episodes ?? []);

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("storyboard")} {...workspace}>
            <StoryboardBoard
                episodes={storyboard.episodes}
                episodeId={storyboard.episodeId}
                onSelectEpisode={storyboard.setEpisodeId}
                scenes={storyboard.scenes}
                loading={storyboard.loading}
                error={storyboard.error}
                onRetry={() => void storyboard.refresh()}
                onSaveShot={storyboard.saveShot}
                savingShotId={storyboard.savingShotId}
                onMoveShot={storyboard.moveShot}
                reordering={storyboard.reordering}
                assets={workspace.context?.project.assetRefs ?? []}
            />
        </WorkspaceLayout>
    );
}

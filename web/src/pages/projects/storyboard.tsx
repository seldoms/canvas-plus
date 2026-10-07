import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";

import { StoryboardBoard } from "./components/storyboard-board";
import { StoryboardRhythmBar } from "./components/storyboard-rhythm-bar";
import { SendShotsToCanvas } from "./components/send-shots-to-canvas";
import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { useStoryboard } from "./hooks/use-storyboard";
import { getWorkspace } from "./workspaces";

/** 分镜工作区（P0-a）：集 → 场 → 镜三层展示，镜级就地编辑与调序，关联资产摘要。 */
export default function StoryboardWorkspacePage() {
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    const storyboard = useStoryboard(projectId, workspace.context?.episodes ?? []);

    // 节奏条与镜头列表共享选中态：selectedShotId 管高亮联动，detailShotId 管打开镜头抽屉。
    const [selectedShotId, setSelectedShotId] = useState("");
    const [detailShotId, setDetailShotId] = useState("");
    const openShotDetail = useCallback((shotId: string) => {
        setSelectedShotId(shotId);
        setDetailShotId(shotId);
    }, []);

    // 「发到画布」投的是**当前选中镜**；没选中时给当前集的**全部**镜头（批量排布的常见场景）。
    const allShots = storyboard.scenes.flatMap((scene) => scene.shots);
    const sendableShots = selectedShotId ? allShots.filter((shot) => shot.id === selectedShotId) : allShots;

    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("storyboard")} {...workspace}>
            {sendableShots.length ? (
                <div className="flex justify-end pb-2">
                    <SendShotsToCanvas projectId={projectId} shots={sendableShots} />
                </div>
            ) : null}
            <StoryboardRhythmBar
                scenes={storyboard.scenes}
                selectedShotId={selectedShotId}
                onSelectShot={setSelectedShotId}
                onOpenShotDetail={openShotDetail}
            />
            <StoryboardBoard
                projectId={projectId}
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
                selectedShotId={selectedShotId}
                onSelectShot={setSelectedShotId}
                detailShotId={detailShotId}
                onOpenShotDetail={openShotDetail}
                onCloseShotDetail={() => setDetailShotId("")}
            />
        </WorkspaceLayout>
    );
}

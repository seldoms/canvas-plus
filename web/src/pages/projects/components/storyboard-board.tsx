import { Alert, App, Button, Empty, Spin, Tag, Typography } from "antd";
import { ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { SceneWithShots, ShotPatchInput } from "@/services/api/projects";
import { cn } from "@/lib/utils";
import type { AssetRef, Episode, Scene, Shot } from "@/types/domain";

import { readShotFields, sceneLabel, shotRelation } from "../storyboard-model";
import { ShotEditorDrawer } from "./shot-editor-drawer";

/**
 * 分镜工作区看板：左列选「集」，右列按「场 → 镜」铺开；镜行可就地编辑与调序。
 * 数据与写回动作来自 useStoryboard，本组件只做编排与渲染。
 *
 * 选中态（selectedShotId）与详情态（detailShotId）由上层（storyboard.tsx）持有，
 * 与上方「节奏条」共享：点节奏条某格 / 点镜行都会让对应镜高亮并打开同一个镜头抽屉。
 */
export function StoryboardBoard({
    episodes,
    episodeId,
    onSelectEpisode,
    scenes,
    loading,
    error,
    onRetry,
    onSaveShot,
    savingShotId,
    onMoveShot,
    reordering,
    assets,
    selectedShotId,
    onSelectShot,
    detailShotId,
    onOpenShotDetail,
    onCloseShotDetail,
}: {
    episodes: Episode[];
    episodeId: string;
    onSelectEpisode: (id: string) => void;
    scenes: SceneWithShots[];
    loading: boolean;
    error: string;
    onRetry: () => void;
    onSaveShot: (shotId: string, patch: ShotPatchInput) => Promise<unknown>;
    savingShotId: string;
    onMoveShot: (shots: Shot[], shotId: string, delta: -1 | 1) => Promise<void>;
    reordering: boolean;
    assets: AssetRef[];
    selectedShotId: string;
    onSelectShot: (shotId: string) => void;
    detailShotId: string;
    onOpenShotDetail: (shotId: string) => void;
    onCloseShotDetail: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();

    const detail = useMemo(() => {
        for (const scene of scenes) {
            const shot = scene.shots.find((item) => item.id === detailShotId);
            if (shot) return { shot, scene };
        }
        return null;
    }, [scenes, detailShotId]);

    const move = async (shots: Shot[], shot: Shot, delta: -1 | 1) => {
        try {
            await onMoveShot(shots, shot.id, delta);
            message.success(t("projects.storyboardView.reorderSaved"));
        } catch (moveError) {
            message.error(t("projects.storyboardView.reorderFailed", { message: moveError instanceof Error ? moveError.message : String(moveError) }));
        }
    };

    return (
        <>
            <div className="grid gap-0 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-800 lg:grid-cols-[180px_1fr]">
                <aside className="max-h-[68vh] overflow-y-auto border-b border-stone-200 p-2 dark:border-stone-800 lg:border-b-0 lg:border-r">
                    {episodes.length ? (
                        <div className="space-y-0.5">
                            {episodes.map((episode) => (
                                <button
                                    key={episode.id}
                                    type="button"
                                    onClick={() => onSelectEpisode(episode.id)}
                                    className={cn(
                                        "flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition",
                                        episode.id === episodeId
                                            ? "bg-black/5 font-medium text-stone-950 dark:bg-white/10 dark:text-stone-100"
                                            : "text-stone-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10",
                                    )}
                                >
                                    <span className="text-xs tabular-nums text-stone-400">{episode.index}</span>
                                    <span className="min-w-0 truncate">{episode.title || t("projects.storyboardView.untitled")}</span>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.storyboardView.episodeEmpty")} />
                    )}
                </aside>

                <div className="max-h-[68vh] overflow-y-auto p-3">
                    {loading ? (
                        <div className="flex justify-center py-16">
                            <Spin />
                        </div>
                    ) : error ? (
                        <Alert
                            type="error"
                            showIcon
                            message={t("projects.storyboardView.loadFailed")}
                            description={error}
                            action={
                                <Button size="small" onClick={onRetry}>
                                    {t("projects.storyboardView.retry")}
                                </Button>
                            }
                        />
                    ) : scenes.length ? (
                        scenes.map((scene) => (
                            <section key={scene.id} className="mb-5 last:mb-0">
                                <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 pb-1.5 backdrop-blur">
                                    <Tag className="!mr-0">{t("projects.storyboardView.sceneTag", { index: scene.index })}</Tag>
                                    <span className="min-w-0 truncate text-sm font-medium">{sceneLabel(scene) || t("projects.storyboardView.sceneUnnamed")}</span>
                                    <span className="ml-auto shrink-0 text-xs text-stone-400">{t("projects.storyboardView.shotCount", { count: scene.shots.length })}</span>
                                </div>
                                {scene.shots.length ? (
                                    <div className="space-y-0.5">
                                        {scene.shots.map((shot, position) => (
                                            <ShotRow
                                                key={shot.id}
                                                shot={shot}
                                                position={position}
                                                total={scene.shots.length}
                                                scene={scene}
                                                assets={assets}
                                                reordering={reordering}
                                                selected={selectedShotId === shot.id}
                                                onSelect={() => onSelectShot(shot.id)}
                                                onOpenDetail={() => onOpenShotDetail(shot.id)}
                                                onMove={(delta) => void move(scene.shots, shot, delta)}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="!my-2" description={t("projects.storyboardView.shotEmpty")} />
                                )}
                            </section>
                        ))
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-16" description={t("projects.storyboardView.sceneEmpty")} />
                    )}
                </div>
            </div>

            <ShotEditorDrawer
                open={Boolean(detail)}
                shot={detail?.shot ?? null}
                scene={detail?.scene ?? null}
                assets={assets}
                saving={Boolean(detail && savingShotId === detail.shot.id)}
                onClose={onCloseShotDetail}
                onSave={(patch) => (detail ? onSaveShot(detail.shot.id, patch) : Promise.resolve())}
            />
        </>
    );
}

/** 单镜行：镜号 + 时长/景别/动作 + 关系摘要 + 调序/编辑；selected 与节奏条对应格互高亮。 */
function ShotRow({
    shot,
    position,
    total,
    scene,
    assets,
    reordering,
    selected,
    onSelect,
    onOpenDetail,
    onMove,
}: {
    shot: Shot;
    position: number;
    total: number;
    scene: Scene;
    assets: AssetRef[];
    reordering: boolean;
    selected: boolean;
    onSelect: () => void;
    onOpenDetail: () => void;
    onMove: (delta: -1 | 1) => void;
}) {
    const { t } = useTranslation();
    const fields = readShotFields(shot);
    const relation = shotRelation(shot, scene, assets);
    const none = t("projects.storyboardView.none");
    const sceneText = sceneLabel(scene) || t("projects.storyboardView.sceneUnnamed");

    return (
        <div
            onClick={onSelect}
            className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-2 py-2 transition",
                selected
                    ? "border-stone-300 bg-black/[0.04] dark:border-stone-600 dark:bg-white/[0.06]"
                    : "border-transparent hover:border-stone-200 hover:bg-black/[0.02] dark:hover:border-stone-700 dark:hover:bg-white/[0.03]",
            )}
        >
            <span
                className={cn(
                    "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-xs tabular-nums",
                    selected ? "bg-stone-900 text-white dark:bg-white dark:text-stone-900" : "bg-black/5 text-stone-500 dark:bg-white/10 dark:text-stone-400",
                )}
            >
                {shot.index}
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    <span className="font-medium">{fields.shotSize || none}</span>
                    <span className="text-xs text-stone-400">{fields.durationSec ? t("common.durationSeconds", { seconds: fields.durationSec }) : none}</span>
                    <span className="min-w-0 truncate text-stone-600 dark:text-stone-300">{fields.action || none}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500 dark:text-stone-400">
                    <Relation label={t("projects.storyboardView.relationScene")} value={sceneText} />
                    <Relation label={t("projects.storyboardView.relationAssets")} value={relation.assetRefs.length || none} />
                    <Relation label={t("projects.storyboardView.relationKeyframe")} value={relation.keyframeSlots || none} />
                    <Relation label={t("projects.storyboardView.relationClip")} value={relation.clipSlots || none} />
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                <Button
                    type="text"
                    size="small"
                    className="!px-1.5"
                    icon={<ChevronUp className="size-3.5" />}
                    disabled={position === 0 || reordering}
                    onClick={(event) => {
                        event.stopPropagation();
                        onMove(-1);
                    }}
                    title={t("projects.storyboardView.moveUp")}
                />
                <Button
                    type="text"
                    size="small"
                    className="!px-1.5"
                    icon={<ChevronDown className="size-3.5" />}
                    disabled={position === total - 1 || reordering}
                    onClick={(event) => {
                        event.stopPropagation();
                        onMove(1);
                    }}
                    title={t("projects.storyboardView.moveDown")}
                />
                <Button
                    type="text"
                    size="small"
                    className="!px-1.5"
                    icon={<Pencil className="size-3.5" />}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpenDetail();
                    }}
                >
                    {t("projects.storyboardView.editShot")}
                </Button>
            </div>
        </div>
    );
}

function Relation({ label, value }: { label: string; value: string | number }) {
    return (
        <Typography.Text type="secondary" className="!text-xs">
            {label}：{value}
        </Typography.Text>
    );
}

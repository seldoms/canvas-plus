import { Tooltip, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { SceneWithShots } from "@/services/api/projects";

import { readShotFields, readTextOverlays, sceneLabel, shotSizeFamily, sortByIndex, truncateText, type ShotSizeFamily } from "../storyboard-model";

/** 景别族 → 格底色：暖（近/特写）· 中性（中景系）· 冷（全景系）· 未知（虚线占位）。 */
const FAMILY_CLASS: Record<ShotSizeFamily, string> = {
    warm: "bg-amber-400 text-amber-950 hover:bg-amber-300 dark:bg-amber-500/90 dark:text-amber-950 dark:hover:bg-amber-400",
    neutral: "bg-stone-300 text-stone-800 hover:bg-stone-200 dark:bg-stone-600 dark:text-stone-50 dark:hover:bg-stone-500",
    cool: "bg-sky-400 text-sky-950 hover:bg-sky-300 dark:bg-sky-600/90 dark:text-sky-50 dark:hover:bg-sky-500",
    unknown: "border border-dashed border-stone-300 bg-transparent text-stone-400 dark:border-stone-600 dark:text-stone-500",
};

/**
 * 分镜节奏条：一条横向时间线，每镜一格，格宽按时长等比、格色按景别族的冷暖着色。
 * 一眼看出哪里拖（格宽）、哪段全是中景（中性色扎堆）；每格有文字（镜号/时长/景别），不靠颜色单独区分。
 * 点格：高亮并打开镜头详情；hover 给动作摘要 + 是否有对白 / 画上文字。与下方镜头列表经 selectedShotId 双向联动。
 *
 * 数据源与镜头列表同源（workspace 的 storyboard 数据）；读不到时长/景别如实留空占位，不编数。
 */
export function StoryboardRhythmBar({
    scenes,
    selectedShotId,
    onSelectShot,
    onOpenShotDetail,
}: {
    scenes: SceneWithShots[];
    selectedShotId: string;
    onSelectShot: (shotId: string) => void;
    onOpenShotDetail: (shotId: string) => void;
}) {
    const { t } = useTranslation();
    const none = t("projects.storyboardView.none");

    const cells = [...scenes]
        .sort((a, b) => a.index - b.index)
        .flatMap((scene) => sortByIndex(scene.shots ?? []).map((shot) => ({ shot, scene })));

    if (!cells.length) {
        return (
            <section className="rounded-xl border border-dashed border-stone-200 px-3 py-2 text-xs text-stone-400 dark:border-stone-800 dark:text-stone-500">
                {t("projects.rhythmBar.empty")}
            </section>
        );
    }

    const totalSeconds = cells.reduce((sum, { shot }) => sum + readShotFields(shot).durationSec, 0);

    return (
        <section>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.rhythmBar.title")}
                </Typography.Title>
                <Typography.Text type="secondary" className="!text-xs">
                    {t("projects.rhythmBar.summary", { shots: cells.length, seconds: totalSeconds })}
                </Typography.Text>
            </div>

            <div className="flex h-14 items-stretch gap-0.5 rounded-lg border border-stone-200 bg-black/[0.02] p-1 dark:border-stone-800 dark:bg-white/[0.03]">
                {cells.map(({ shot, scene }) => {
                    const fields = readShotFields(shot);
                    const family = shotSizeFamily(fields.shotSize);
                    const overlays = readTextOverlays(shot);
                    const hasDialogue = fields.dialogue.trim() !== "";
                    const hasText = overlays.length > 0;
                    const selected = selectedShotId === shot.id;
                    const durationLabel = fields.durationSec > 0 ? t("common.durationSeconds", { seconds: fields.durationSec }) : t("projects.rhythmBar.unknownDuration");
                    const sizeLabel = fields.shotSize || t("projects.rhythmBar.unknownShotSize");
                    const dialogueLabel = hasDialogue ? t("projects.rhythmBar.hasDialogue") : t("projects.rhythmBar.noDialogue");
                    const textLabel = hasText ? t("projects.rhythmBar.hasText") : t("projects.rhythmBar.noText");
                    const actionSummary = truncateText(fields.action, 48) || none;
                    const sceneText = sceneLabel(scene) || t("projects.storyboardView.sceneUnnamed");
                    const ariaLabel = `${`sh${shot.index}`} · ${sizeLabel} · ${durationLabel} · ${sceneText} · ${actionSummary} · ${dialogueLabel} · ${textLabel}`;

                    return (
                        <Tooltip
                            key={shot.id}
                            mouseEnterDelay={0.15}
                            title={
                                <div className="max-w-60 space-y-0.5 text-xs">
                                    <div className="font-medium">
                                        {`sh${shot.index}`} · {sizeLabel} · {durationLabel}
                                    </div>
                                    <div className="opacity-90">{actionSummary}</div>
                                    <div className="opacity-70">
                                        {dialogueLabel} · {textLabel}
                                    </div>
                                </div>
                            }
                        >
                            <button
                                type="button"
                                aria-label={ariaLabel}
                                aria-pressed={selected}
                                onClick={() => onOpenShotDetail(shot.id)}
                                onFocus={() => onSelectShot(shot.id)}
                                style={{ flexGrow: fields.durationSec > 0 ? fields.durationSec : 1, flexBasis: 0 }}
                                className={cn(
                                    "flex min-w-0 flex-col justify-center gap-0.5 overflow-hidden rounded px-1 py-1 text-left text-[10px] leading-tight transition",
                                    FAMILY_CLASS[family],
                                    selected && "z-10 ring-2 ring-stone-900 ring-offset-1 ring-offset-background dark:ring-white",
                                )}
                            >
                                <span className="truncate font-semibold tabular-nums">{`sh${shot.index}`}</span>
                                <span className="truncate tabular-nums">{durationLabel}</span>
                                <span className="truncate">{sizeLabel}</span>
                            </button>
                        </Tooltip>
                    );
                })}
            </div>
        </section>
    );
}

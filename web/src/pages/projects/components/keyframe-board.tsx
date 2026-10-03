import { Alert, Button, Card, Empty, Image, Spin, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl, type GatewayGenerationStatus } from "@/services/api/gateway";

import type { KeyframeShot } from "../keyframes-model";

/** 镜头状态 → AntD Tag 颜色；文案统一走 pipeline.candidates.status.*。 */
const STATUS_COLORS: Record<GatewayGenerationStatus, string> = {
    queued: "default",
    running: "processing",
    done: "success",
    error: "error",
    blocked: "purple",
    canceled: "default",
};

/**
 * 关键帧工作区正文：按镜头分组铺开候选图缩略图，点缩略图站内弹窗预览。
 *
 * 全部缩略图共用一个 Image.PreviewGroup（关掉 × 按钮，点遮罩 / Esc 关闭），弹窗里可左右切换；
 * 每个镜头一行元信息：模板 / 种子 / 参考图数量 / 图片数，失败条目逐条给出可读原因。
 */
export function KeyframeBoard({
    shots,
    loading,
    error,
    onRetry,
}: {
    shots: KeyframeShot[];
    loading: boolean;
    error: string;
    onRetry: () => void;
}) {
    const { t } = useTranslation();

    if (error) {
        return (
            <Alert
                type="error"
                showIcon
                message={t("projects.keyframes.loadFailed")}
                description={error}
                action={
                    <Button size="small" onClick={onRetry}>
                        {t("projects.retry")}
                    </Button>
                }
            />
        );
    }

    if (loading && !shots.length) {
        return (
            <div className="flex justify-center py-12">
                <Spin />
            </div>
        );
    }

    if (!shots.length) {
        return <Empty className="py-12" description={t("projects.keyframes.empty")} />;
    }

    const imageCount = shots.reduce((total, shot) => total + shot.images.length, 0);

    return (
        <section>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.keyframes.title")}
                </Typography.Title>
                <Typography.Text type="secondary" className="!text-xs">
                    {t("projects.keyframes.summary", { shots: shots.length, images: imageCount })}
                </Typography.Text>
            </div>
            <Image.PreviewGroup preview={{ closeIcon: false }}>
                <div className="space-y-3">
                    {shots.map((shot) => (
                        <ShotGroup key={shot.id} shot={shot} />
                    ))}
                </div>
            </Image.PreviewGroup>
        </section>
    );
}

function ShotGroup({ shot }: { shot: KeyframeShot }) {
    const { t } = useTranslation();
    const none = t("projects.keyframes.none");

    return (
        <Card size="small">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">
                    {t("projects.keyframes.shot", { index: shot.index })}
                </span>
                {shot.durationSec > 0 ? (
                    <span className="text-xs text-stone-400 dark:text-stone-500">{t("projects.keyframes.seconds", { count: shot.durationSec })}</span>
                ) : null}
                <Tag color={STATUS_COLORS[shot.status]}>{t(`pipeline.candidates.status.${shot.status}`)}</Tag>
            </div>

            {shot.blockedMissing.length || shot.blockedReason ? (
                <div className="mt-1 space-y-0.5 text-xs text-violet-600 dark:text-violet-400">
                    {shot.blockedMissing.length
                        ? shot.blockedMissing.map((entry) => (
                              <div key={`${entry.role}:${entry.bindingId}:${entry.reason}`} className="break-words">
                                  {t("projects.keyframes.blockedMissing", {
                                      role: t(`projects.keyframes.roles.${entry.role}`, { defaultValue: entry.role }),
                                      bindingId: entry.bindingId,
                                      reason: t(`projects.keyframes.blockedReasons.${entry.reason}`, { defaultValue: t("projects.keyframes.blockedReasons.other") }),
                                  })}
                              </div>
                          ))
                        : <div className="break-words">{shot.blockedReason}</div>}
                </div>
            ) : null}

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500 dark:text-stone-400">
                <span>
                    {t("projects.keyframes.template")}
                    <span className="ml-1 font-mono text-stone-700 dark:text-stone-200">{shot.template || none}</span>
                </span>
                <span>
                    {t("projects.keyframes.seed")}
                    <span className="ml-1 font-mono text-stone-700 dark:text-stone-200">{shot.seed || none}</span>
                </span>
                <span>
                    {t("projects.keyframes.references")}
                    <span className="ml-1 text-stone-700 dark:text-stone-200">{shot.referenceCount}</span>
                </span>
                <span>{t("projects.keyframes.images", { count: shot.images.length })}</span>
            </div>

            {shot.images.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {shot.images.map((candidate) => (
                        <span
                            key={candidate.jobId}
                            className={cn(
                                "relative block size-24 overflow-hidden rounded border border-stone-200/80 bg-black/5 dark:border-stone-700/80 dark:bg-white/5",
                                candidate.selected && "ring-2 ring-stone-400 dark:ring-stone-500",
                            )}
                        >
                            <Image
                                src={resolveGatewayUrl(candidate.artifactUrl || "")}
                                alt={candidate.template}
                                title={[candidate.template, candidate.seed ? `seed ${candidate.seed}` : ""].filter(Boolean).join(" · ")}
                                loading="lazy"
                                rootClassName="block h-full w-full cursor-pointer"
                                className="h-full w-full object-cover"
                                style={{ height: "100%", width: "100%", objectFit: "cover" }}
                                preview={{ cover: false, closeIcon: false }}
                            />
                        </span>
                    ))}
                </div>
            ) : null}

            {shot.failures.map((failure) => (
                <div key={failure.jobId} className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-red-600 dark:text-red-400">
                    <span className="shrink-0 font-medium">{t(`pipeline.candidates.status.${failure.status}`)}</span>
                    {failure.reason ? <span className="break-words">{failure.reason}</span> : null}
                </div>
            ))}
        </Card>
    );
}

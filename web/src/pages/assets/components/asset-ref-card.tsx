import { Button, Tag } from "antd";
import { Download, ExternalLink, ImageOff, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveGatewayUrl } from "@/services/api/gateway";
import { PreviewableMedia } from "@/components/workbench";
import type { AssetOverviewRef } from "@/services/api/projects";

import { mediaKindOf } from "../asset-overview-model";

/**
 * 总览里的单张资产卡：缩略图（图片走站内预览、视频点开弹窗）+ 名称 + 所属项目 + 类型 + 产物数。
 * 卡片本身不发请求；预览/下载/跳转由父级编排。
 */
export function AssetRefCard({
    refItem,
    onPreviewVideo,
    onDownload,
    onOpenProject,
}: {
    refItem: AssetOverviewRef;
    onPreviewVideo: (ref: AssetOverviewRef) => void;
    onDownload: (ref: AssetOverviewRef) => void;
    onOpenProject: (projectId: string) => void;
}) {
    const { t } = useTranslation();
    const isVideo = mediaKindOf(refItem) === "video";
    const src = refItem.url ? resolveGatewayUrl(refItem.url) : "";
    const roleLabel = t(`assets.roles.${refItem.role}`, { defaultValue: refItem.role });

    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className="relative aspect-[4/3] w-full overflow-hidden bg-stone-100 dark:bg-stone-900">
                {src ? (
                    isVideo ? (
                        <button type="button" className="group block h-full w-full cursor-pointer" onClick={() => onPreviewVideo(refItem)} title={refItem.name}>
                            <video src={src} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                            <span className="absolute inset-0 flex items-center justify-center bg-black/25 transition group-hover:bg-black/40">
                                <Play className="size-8 text-white" fill="currentColor" />
                            </span>
                        </button>
                    ) : (
                        <PreviewableMedia id={refItem.id} kind="image" src={src} title={refItem.name} className="block h-full w-full">
                            <img src={src} alt={refItem.name} loading="lazy" className="h-full w-full object-cover" />
                        </PreviewableMedia>
                    )
                ) : (
                    <span className="flex h-full w-full items-center justify-center text-stone-400 dark:text-stone-600" title={t("projects.assetsView.noArtifact")}>
                        <ImageOff className="size-6" />
                    </span>
                )}
            </div>

            <div className="min-w-0 p-3">
                <div className="flex items-start justify-between gap-2">
                    <h2 className="line-clamp-1 text-sm font-medium text-stone-950 dark:text-stone-100" title={refItem.bindingId}>
                        {refItem.name}
                    </h2>
                    <Tag className="!mr-0 shrink-0">{roleLabel}</Tag>
                </div>
                <button
                    type="button"
                    className="mt-1 block max-w-full cursor-pointer truncate text-left text-xs text-stone-500 hover:underline dark:text-stone-400"
                    title={refItem.projectTitle}
                    onClick={() => onOpenProject(refItem.projectId)}
                >
                    {refItem.projectTitle}
                </button>
                <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{t("assets.overview.artifactCount", { count: refItem.artifactCount })}</span>
                    <div className="flex items-center gap-1">
                        <Button size="small" type="text" icon={<Download className="size-3.5" />} disabled={!src} onClick={() => onDownload(refItem)}>
                            {t("assets.overview.download")}
                        </Button>
                        <Button size="small" type="text" icon={<ExternalLink className="size-3.5" />} onClick={() => onOpenProject(refItem.projectId)}>
                            {t("assets.overview.openProject")}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

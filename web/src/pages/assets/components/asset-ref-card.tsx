import { Button, Tag } from "antd";
import { Download, ExternalLink, ImageOff, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ArtifactActions } from "@/components/artifact-actions";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { PreviewableMedia } from "@/components/workbench";
import type { AssetOverviewRef } from "@/services/api/projects";

import { mediaKindOf } from "../asset-overview-model";

/**
 * 总览里的单张资产卡：缩略图（图片走站内预览、视频点开弹窗）+ 名称 + 所属项目 + 类型 + 产物数。
 * 卡片本身不发请求；预览/下载/跳转/归档由父级编排。
 *
 * 归档入口（本轮补）：**直接放在卡片上、一眼可见**（规范 §2.1）。
 * 之前归档只在另一个 Segmented 视图「全部产物」里，本视图 157 张卡一个归档按钮都没有。
 * - 归档态由父级**批量**取回（url→state），卡片只同步查表，不各自发请求；
 * - 已归档 → 缩略图上打「已归档」标 + 按钮变「恢复」（规范 §2.2，选“打标”并全站一致）；
 * - **不提供「彻底删除」**（规范 §2.4：彻底删除只在「我的资产 →全部产物」的产物管理器里）。
 *   产物未登记进后端产物索引时（archivable=false）不渲染归档按钮，避免点了必然失败。
 */
export function AssetRefCard({
    refItem,
    archived = false,
    archivable = false,
    onArtifactsChanged,
    onPreviewVideo,
    onDownload,
    onOpenProject,
}: {
    refItem: AssetOverviewRef;
    archived?: boolean;
    archivable?: boolean;
    onArtifactsChanged?: () => void;
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
                            <img src={src} alt={refItem.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                        </PreviewableMedia>
                    )
                ) : (
                    <span className="flex h-full w-full items-center justify-center text-stone-400 dark:text-stone-600" title={t("projects.assetsView.noArtifact")}>
                        <ImageOff className="size-6" />
                    </span>
                )}
                {archived ? (
                    <Tag className="!absolute !left-2 !top-2 !m-0 !border-0 !bg-amber-100 !text-amber-700 dark:!bg-amber-900/60 dark:!text-amber-200">
                        {t("artifacts.archivedTag")}
                    </Tag>
                ) : null}
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
                        {archivable ? (
                            <ArtifactActions
                                targets={[{ url: refItem.url }]}
                                state={archived ? "archived" : "active"}
                                onChanged={onArtifactsChanged}
                            />
                        ) : null}
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

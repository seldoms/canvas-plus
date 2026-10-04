import { App, Button, Empty, Input, Modal, Segmented, Select, Spin, Tag } from "antd";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { saveAs } from "file-saver";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { MediaPreviewGroup } from "@/components/workbench";
import { listAssetRefsOverview, type AssetOverview, type AssetOverviewRef } from "@/services/api/projects";

import { artifactFileName, filterAssetRefs, roleFilterOptions } from "./asset-overview-model";
import { ArtifactManager } from "./components/artifact-manager";
import { AssetRefCard } from "./components/asset-ref-card";

/**
 * 我的资产（/assets）：跨项目资产总览。
 * 数据源 = 服务端聚合端点 GET /api/asset-refs（不再读浏览器本地收藏库 useAssetStore）。
 * 支持按项目 / 类型筛选与按名称搜索、站内弹窗预览、跳回所属项目、下载单条产物。
 */
export default function AssetsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [overview, setOverview] = useState<AssetOverview | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [keyword, setKeyword] = useState("");
    const [roleFilter, setRoleFilter] = useState("all");
    const [projectFilter, setProjectFilter] = useState("all");
    const [videoRef, setVideoRef] = useState<AssetOverviewRef | null>(null);
    /** 视图切换：资产引用（跨项目 AssetRef）↔ 全部产物（归档 / 彻底删除）。 */
    const [view, setView] = useState<"refs" | "artifacts">("refs");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setOverview(await listAssetRefsOverview());
            setError("");
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const total = overview?.counts.total ?? 0;
    const roles = useMemo(() => roleFilterOptions(overview?.counts.byRole ?? {}), [overview]);
    const projects = overview?.counts.byProject ?? [];
    const filtered = useMemo(
        () => filterAssetRefs(overview?.assetRefs ?? [], { keyword, role: roleFilter, projectId: projectFilter }),
        [overview, keyword, roleFilter, projectFilter],
    );

    const download = async (refItem: AssetOverviewRef) => {
        if (!refItem.url) return;
        try {
            const response = await fetch(resolveGatewayUrl(refItem.url));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            saveAs(await response.blob(), artifactFileName(refItem));
        } catch {
            message.error(t("assets.overview.downloadFailed"));
        }
    };

    const openProject = (projectId: string) => navigate(`/projects/${projectId}/assets`);

    return (
        <div className="h-full overflow-y-auto bg-background text-stone-900 dark:text-stone-100">
            <div className="w-full px-6 py-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("assets.title")}</h1>
                        <span className="text-sm text-stone-500 dark:text-stone-400">{t("assets.overview.total", { count: total })}</span>
                        <Segmented
                            size="small"
                            value={view}
                            onChange={(value) => setView(value as "refs" | "artifacts")}
                            options={[
                                { value: "refs", label: t("artifacts.view.refs") },
                                { value: "artifacts", label: t("artifacts.view.artifacts") },
                            ]}
                        />
                    </div>
                    {view === "refs" ? (
                        <div className="flex items-center gap-2">
                            <Input
                                allowClear
                                className="w-full max-w-sm"
                                prefix={<Search className="size-4 text-stone-400" />}
                                value={keyword}
                                placeholder={t("assets.overview.search")}
                                onChange={(event) => setKeyword(event.target.value)}
                            />
                            <Button icon={<RefreshCw className={cn("size-4", loading && "animate-spin")} />} onClick={() => void load()} disabled={loading}>
                                {t("assets.overview.refresh")}
                            </Button>
                        </div>
                    ) : null}
                </div>

                {view === "refs" ? (
                    <>
                <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Tag.CheckableTag checked={roleFilter === "all"} className={cn("prompt-filter-tag", roleFilter === "all" && "is-active")} onChange={() => setRoleFilter("all")}>
                            {t("common.all")}
                        </Tag.CheckableTag>
                        {roles.map(({ role, count }) => (
                            <Tag.CheckableTag
                                key={role}
                                checked={roleFilter === role}
                                className={cn("prompt-filter-tag", roleFilter === role && "is-active")}
                                onChange={() => setRoleFilter(role)}
                            >
                                {t(`assets.roles.${role}`, { defaultValue: role })} {count}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                    <Select
                        className="min-w-[200px]"
                        value={projectFilter}
                        onChange={setProjectFilter}
                        options={[{ value: "all", label: t("assets.overview.allProjects") }, ...projects.map((project) => ({ value: project.projectId, label: `${project.projectTitle} (${project.count})` }))]}
                    />
                </div>

                <div className="mt-5">
                    {loading && !overview ? (
                        <div className="flex justify-center py-24">
                            <Spin />
                        </div>
                    ) : error && !overview ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-24" description={error} />
                    ) : filtered.length ? (
                        <MediaPreviewGroup>
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                                {filtered.map((refItem) => (
                                    <AssetRefCard key={refItem.id} refItem={refItem} onPreviewVideo={setVideoRef} onDownload={download} onOpenProject={openProject} />
                                ))}
                            </div>
                        </MediaPreviewGroup>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-24" description={total ? t("assets.overview.emptyFiltered") : t("assets.overview.empty")} />
                    )}
                </div>
                    </>
                ) : (
                    <ArtifactManager />
                )}
            </div>

            <Modal open={Boolean(videoRef)} title={videoRef?.name || undefined} footer={null} width={960} destroyOnHidden onCancel={() => setVideoRef(null)}>
                {videoRef?.url ? <video src={resolveGatewayUrl(videoRef.url)} controls autoPlay className="mt-2 w-full rounded-lg bg-black" /> : null}
            </Modal>
        </div>
    );
}

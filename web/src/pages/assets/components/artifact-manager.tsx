import { App, Button, Checkbox, Empty, Image, Space, Spin, Switch, Tag, Tooltip } from "antd";
import { Archive, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArtifactActions } from "@/components/artifact-actions";
import { archiveArtifacts, deleteArtifacts, listArtifacts, restoreArtifacts, type ArtifactItem } from "@/services/api/artifacts";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { artifactThumbSrc } from "@/lib/artifact-thumb";

/**
 * 「我的资产」→ 全部产物：素材生命周期管理。
 * 只有这里提供「彻底删除」（danger + 二次确认弹窗，弹窗列出待删清单 + 引用警告、被引用的不可选）；
 * 默认只显示 active，可切「显示已归档」→ 看到并把归档的素材恢复。
 */
const VIDEO_URL = /\.(mp4|webm|mov|mkv|m4v|avi)(?:[?#].*)?$/i;

function mediaKindOf(item: ArtifactItem): "image" | "video" {
    return item.kind === "video" || VIDEO_URL.test(item.url) ? "video" : "image";
}

export function ArtifactManager() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const [items, setItems] = useState<ArtifactItem[]>([]);
    const [counts, setCounts] = useState({ active: 0, archived: 0 });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [showArchived, setShowArchived] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listArtifacts({ state: showArchived ? "all" : "active", limit: 300 });
            setItems(result.items);
            setCounts(result.counts);
            setError("");
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, [showArchived]);

    useEffect(() => {
        void load();
    }, [load]);

    // 切换筛选后清掉选择，避免残留跨状态的选中项。
    useEffect(() => {
        setSelected(new Set());
    }, [showArchived]);

    const refText = useCallback(
        (item: ArtifactItem) =>
            item.refs
                .map((ref) => {
                    const project = ref.projectName || ref.projectId || "—";
                    return ref.shotId ? t("artifacts.refWarningShot", { project, shot: ref.shotId }) : t("artifacts.refWarning", { project });
                })
                .join("；"),
        [t],
    );

    const toggle = (id: string, checked: boolean) => {
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    const selectedItems = useMemo(() => items.filter((item) => selected.has(item.id)), [items, selected]);
    const selectedActiveIds = selectedItems.filter((item) => item.state === "active").map((item) => item.id);

    const bulkArchive = async () => {
        if (!selectedActiveIds.length) {
            message.info(t("artifacts.emptyFiltered"));
            return;
        }
        setBusy(true);
        try {
            const result = await archiveArtifacts(selectedActiveIds);
            const undo = async () => {
                try {
                    await restoreArtifacts(result.archived);
                    message.success(t("artifacts.restored"));
                    await load();
                } catch (undoError) {
                    message.error(undoError instanceof Error ? undoError.message : String(undoError));
                }
            };
            message.success({
                content: (
                    <span className="inline-flex items-center gap-2">
                        {t("artifacts.archivedCount", { count: result.archived.length })}
                        <a role="button" onClick={() => void undo()}>
                            {t("artifacts.undo")}
                        </a>
                    </span>
                ),
                duration: 6,
            });
            setSelected(new Set());
            await load();
        } catch (archiveError) {
            message.error(archiveError instanceof Error ? archiveError.message : String(archiveError));
        } finally {
            setBusy(false);
        }
    };

    const requestDelete = (targets: ArtifactItem[]) => {
        if (!targets.length) return;
        const deletable = targets.filter((item) => item.state !== "deleted" && item.refs.length === 0);
        const blocked = targets.filter((item) => item.refs.length > 0);
        modal.confirm({
            title: t("artifacts.deleteConfirmTitle"),
            width: 560,
            okText: t("artifacts.delete"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true, disabled: !deletable.length },
            content: (
                <div className="space-y-3">
                    <p className="!mb-0 text-sm text-stone-600 dark:text-stone-300">{t("artifacts.deleteConfirmBody", { count: deletable.length })}</p>
                    {deletable.length ? (
                        <div>
                            <div className="mb-1 text-xs font-medium text-stone-500 dark:text-stone-400">{t("artifacts.deleteListTitle")}</div>
                            <ul className="max-h-40 overflow-y-auto rounded border border-stone-200 p-2 text-xs dark:border-stone-800">
                                {deletable.map((item) => (
                                    <li key={item.id} className="truncate py-0.5">
                                        {item.filename}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                    {blocked.length ? (
                        <div>
                            <div className="mb-1 text-xs font-medium text-amber-600 dark:text-amber-400">{t("artifacts.blockedListTitle")}</div>
                            <ul className="max-h-40 overflow-y-auto rounded border border-amber-200 p-2 text-xs dark:border-amber-900/60">
                                {blocked.map((item) => (
                                    <li key={item.id} className="py-0.5">
                                        <span className="font-medium">{item.filename}</span>
                                        <span className="ml-2 text-amber-600 dark:text-amber-400">{refText(item)}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </div>
            ),
            onOk: async () => {
                if (!deletable.length) return;
                setBusy(true);
                try {
                    const result = await deleteArtifacts(deletable.map((item) => item.id));
                    if (result.blocked.length) message.warning(t("artifacts.blockedWarning", { count: result.blocked.length }));
                    if (result.deleted.length) message.success(t("artifacts.deletedCount", { count: result.deleted.length }));
                    setSelected(new Set());
                    await load();
                } catch (deleteError) {
                    message.error(deleteError instanceof Error ? deleteError.message : String(deleteError));
                    throw deleteError;
                } finally {
                    setBusy(false);
                }
            },
        });
    };

    return (
        <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <Tag className="!m-0">{t("artifacts.activeCount", { count: counts.active })}</Tag>
                    {counts.archived ? <Tag className="!m-0 !border-0 !bg-stone-100 !text-stone-500 dark:!bg-stone-800">{counts.archived}</Tag> : null}
                    <Switch checked={showArchived} onChange={setShowArchived} size="small" />
                    <span className="text-xs text-stone-500 dark:text-stone-400">{t("artifacts.showArchived")}</span>
                </div>
                <Space>
                    <Button size="small" icon={<Archive className="size-3.5" />} disabled={!selectedActiveIds.length || busy} onClick={() => void bulkArchive()}>
                        {t("artifacts.archiveSelected")}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedItems.some((item) => item.state !== "deleted") || busy} onClick={() => requestDelete(selectedItems)}>
                        {t("artifacts.deleteSelected")}
                    </Button>
                </Space>
            </div>

            {loading && !items.length ? (
                <div className="flex justify-center py-24">
                    <Spin />
                </div>
            ) : error && !items.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-24" description={error} />
            ) : items.length ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {items.map((item) => {
                        const checked = selected.has(item.id);
                        const video = mediaKindOf(item) === "video";
                        const src = resolveGatewayUrl(item.url);
                        const thumbSrc = artifactThumbSrc(src);
                        return (
                            <div
                                key={item.id}
                                className={`overflow-hidden rounded-lg border bg-background ${checked ? "border-blue-400 dark:border-blue-500" : "border-stone-200 dark:border-stone-800"}`}
                            >
                                <div className="relative aspect-[4/3] w-full overflow-hidden bg-stone-100 dark:bg-stone-900">
                                    {video ? (
                                        /* 封面用缩略图、不预拉视频；点播放才取原视频。 */
                                        <video src={src} poster={thumbSrc} muted playsInline preload="none" controls className="h-full w-full object-contain" />
                                    ) : (
                                        /* 缩略图走服务端小图；点开预览仍给**原图**（preview.src）。 */
                                        <Image src={thumbSrc} alt={item.filename} className="h-full w-full object-cover" style={{ height: "100%", width: "100%", objectFit: "cover" }} preview={{ closeIcon: false, src }} />
                                    )}
                                    <Checkbox className="absolute left-2 top-2" checked={checked} onChange={(event) => toggle(item.id, event.target.checked)} />
                                    {item.refs.length ? (
                                        <Tooltip title={refText(item)}>
                                            <Tag color="warning" className="!absolute !right-2 !top-2 !m-0">
                                                {t("artifacts.referenced")}
                                            </Tag>
                                        </Tooltip>
                                    ) : null}
                                    {item.state === "archived" ? <Tag className="!absolute !bottom-2 !left-2 !m-0">{t("artifacts.archivedTag")}</Tag> : null}
                                </div>
                                <div className="min-w-0 p-3">
                                    <div className="truncate text-sm font-medium text-stone-950 dark:text-stone-100" title={item.filename}>
                                        {item.filename}
                                    </div>
                                    <div className="mt-1 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                        <Tag className="!m-0 !border-0 !bg-stone-100 !text-stone-500 dark:!bg-stone-800">{t(`artifacts.origin.${item.source.origin}`, { defaultValue: item.source.origin })}</Tag>
                                        {item.source.role ? <span>{item.source.role}</span> : null}
                                    </div>
                                    <div className="mt-2 flex items-center justify-end">
                                        <ArtifactActions
                                            targets={[{ id: item.id }]}
                                            state={item.state === "archived" ? "archived" : "active"}
                                            allowDelete
                                            onChanged={() => void load()}
                                            onRequestDelete={() => requestDelete([item])}
                                        />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-24" description={t("artifacts.empty")} />
            )}

            {selectedItems.length ? (
                <div className="sticky bottom-0 mt-4 flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-card/95 px-4 py-2 backdrop-blur dark:border-stone-800">
                    <span className="text-sm text-stone-600 dark:text-stone-300">{t("artifacts.selected", { count: selectedItems.length })}</span>
                    <Space>
                        <Button size="small" icon={<Archive className="size-3.5" />} disabled={!selectedActiveIds.length || busy} onClick={() => void bulkArchive()}>
                            {t("artifacts.archiveSelected")}
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedItems.some((item) => item.state !== "deleted") || busy} onClick={() => requestDelete(selectedItems)}>
                            {t("artifacts.deleteSelected")}
                        </Button>
                        <Button size="small" onClick={() => setSelected(new Set())}>
                            {t("common.cancel")}
                        </Button>
                    </Space>
                </div>
            ) : null}
        </div>
    );
}

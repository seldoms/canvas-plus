import { App, Button, Card, Empty, Input, Select, Spin, Tag, Typography } from "antd";
import { ImageOff, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { MediaPreviewGroup, PreviewableMedia } from "@/components/workbench";
import type { AssetRefCreateInput, AssetRefPatchInput } from "@/services/api/projects";
import type { AssetRef } from "@/types/domain";

import { assetRefAdopted, assetRefCover, assetRefScope, bindingName, buildAssetRefPatch, groupAssetRefs, shortId } from "../asset-ref-model";
import { AddAssetRefModal } from "./add-asset-ref-modal";
import { artifactThumbSrc } from "@/lib/artifact-thumb";

/**
 * 资产工作区看板：按 role 分组列出**项目 AssetRef**，每条带产物缩略图（点开站内弹窗预览）、绑定名、候选数与采用状态，
 * 可登记新引用、改 bindingId、在多候选间切换采用的 artifact。
 * 数据与写回动作来自 useProjectAssets（服务端上下文为唯一数据源），本组件只做编排与渲染。
 */
export function AssetRefPanel({
    refs,
    script,
    loading,
    onPatch,
    onAdd,
    creating,
    savingRefId,
}: {
    refs: AssetRef[];
    /** 项目剧本（用于把 bindingId 解析成人读名字）；形状未冻结，按 unknown 处理。 */
    script: unknown;
    loading: boolean;
    onPatch: (refId: string, patch: AssetRefPatchInput) => Promise<unknown>;
    onAdd: (input: AssetRefCreateInput) => Promise<unknown>;
    creating: boolean;
    savingRefId: string;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState(false);
    const groups = useMemo(() => groupAssetRefs(refs), [refs]);

    return (
        <section>
            <div className="mb-3 flex items-center justify-between">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.assetsView.refsTitle")}
                </Typography.Title>
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
                    {t("projects.assetsView.addRef")}
                </Button>
            </div>
            <Card size="small">
                <div className="max-h-[64vh] overflow-y-auto pr-1">
                    {loading && !refs.length ? (
                        <div className="flex justify-center py-16">
                            <Spin />
                        </div>
                    ) : groups.length ? (
                        groups.map((group) => (
                            <div key={group.role} className="mb-5 last:mb-0">
                                <div className="mb-1.5 flex items-center gap-2">
                                    <span className="text-sm font-medium">{t(`projects.assetsView.roles.${group.role}`)}</span>
                                    <Tag className="!mr-0">{group.refs.length}</Tag>
                                </div>
                                {/* 同一类别（≈同一阶段）的缩略图共用一个预览组，弹窗里可 ←→↑↓ 切换。 */}
                                <MediaPreviewGroup>
                                    <div className="space-y-1.5">
                                        {group.refs.map((ref) => (
                                            <AssetRefRow key={ref.id} refItem={ref} script={script} saving={savingRefId === ref.id} onPatch={onPatch} />
                                        ))}
                                    </div>
                                </MediaPreviewGroup>
                            </div>
                        ))
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-12" description={t("projects.assetsView.refsEmpty")} />
                    )}
                </div>
            </Card>
            <AddAssetRefModal open={adding} creating={creating} onClose={() => setAdding(false)} onAdd={onAdd} />
        </section>
    );
}

/** 单条资产：缩略图 + role 标签 + 绑定名 + 采用状态 + 候选数 + 切换采用 / 改绑定。 */
function AssetRefRow({ refItem, script, saving, onPatch }: { refItem: AssetRef; script: unknown; saving: boolean; onPatch: (refId: string, patch: AssetRefPatchInput) => Promise<unknown> }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [bindingId, setBindingId] = useState(refItem.bindingId);
    const [editing, setEditing] = useState(false);

    // 服务端返回新值（成功写回）时同步本地草稿。
    useEffect(() => setBindingId(refItem.bindingId), [refItem.bindingId]);

    const cover = assetRefCover(refItem);
    const name = bindingName(refItem, script);
    const adopted = assetRefAdopted(refItem);
    const bindingDirty = Boolean(bindingId.trim()) && bindingId.trim() !== refItem.bindingId;
    const artifactOptions = refItem.artifactIds.map((id) => ({ value: id, label: shortId(id) }));

    const saveBinding = async () => {
        try {
            await onPatch(refItem.id, buildAssetRefPatch(refItem, { bindingId, selectedArtifactId: refItem.selectedArtifactId ?? null }));
            setEditing(false);
            message.success(t("projects.assetsView.bindSaved"));
        } catch (patchError) {
            // 失败保留用户输入，不回退 bindingId 输入框。
            message.error(t("projects.assetsView.updateFailed", { message: patchError instanceof Error ? patchError.message : String(patchError) }));
        }
    };

    const changeSelected = async (value: string | null) => {
        try {
            await onPatch(refItem.id, { selectedArtifactId: value || null });
            message.success(t("projects.assetsView.selectSaved"));
        } catch (patchError) {
            message.error(t("projects.assetsView.updateFailed", { message: patchError instanceof Error ? patchError.message : String(patchError) }));
        }
    };

    return (
        <div className="flex items-start gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
            {cover ? (
                <PreviewableMedia
                    id={refItem.id}
                    kind="image"
                    src={resolveGatewayUrl(cover)}
                    thumbSrc={artifactThumbSrc(resolveGatewayUrl(cover))}
                    title={name}
                    className="block size-24 shrink-0 cursor-zoom-in overflow-hidden rounded border border-stone-200/80 bg-black/5 dark:border-stone-700/80 dark:bg-white/5"
                >
                    <img src={artifactThumbSrc(resolveGatewayUrl(cover))} alt={name} loading="lazy" className="size-24 object-cover" />
                </PreviewableMedia>
            ) : (
                <span
                    className="flex size-24 shrink-0 items-center justify-center rounded border border-dashed border-stone-300 text-stone-400 dark:border-stone-700 dark:text-stone-500"
                    title={t("projects.assetsView.noArtifact")}
                >
                    <ImageOff className="size-5" />
                </span>
            )}

            <div className="min-w-0 flex-1 py-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Tag className="!mr-0 shrink-0">{t(`projects.assetsView.roles.${refItem.role}`)}</Tag>
                    <span className="truncate text-sm font-medium text-stone-950 dark:text-stone-100" title={refItem.bindingId}>
                        {name}
                    </span>
                    <Tag className={cn("!mr-0 shrink-0", !adopted && "!bg-transparent !text-stone-400 dark:!text-stone-500")} color={adopted ? "blue" : undefined}>
                        {adopted ? t("projects.assetsView.adopted") : t("projects.assetsView.notAdopted")}
                    </Tag>
                    <span className="text-xs text-stone-400 dark:text-stone-500">{t(`projects.assetsView.scope.${assetRefScope(refItem)}`)}</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="text-xs text-stone-500 dark:text-stone-400">{t("projects.assetsView.artifactCount", { count: refItem.artifactIds.length })}</span>
                    {refItem.artifactIds.length ? (
                        <Select
                            size="small"
                            className="min-w-[180px]"
                            value={refItem.selectedArtifactId ?? undefined}
                            placeholder={t("projects.assetsView.selectedArtifact")}
                            options={artifactOptions}
                            allowClear
                            loading={saving}
                            onChange={(value) => void changeSelected(value ?? null)}
                        />
                    ) : null}
                    {editing ? (
                        <>
                            <Input
                                size="small"
                                className="min-w-[160px] max-w-xs"
                                value={bindingId}
                                onChange={(event) => setBindingId(event.target.value)}
                                onPressEnter={() => bindingDirty && void saveBinding()}
                                placeholder={t("projects.assetsView.bindingPlaceholder")}
                            />
                            <Button size="small" type="text" loading={saving} disabled={!bindingDirty} onClick={() => void saveBinding()}>
                                {t("projects.assetsView.saveBinding")}
                            </Button>
                        </>
                    ) : (
                        <Button size="small" type="text" className="!h-auto !px-0 !text-xs" onClick={() => setEditing(true)}>
                            {t("projects.assetsView.editBinding")}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

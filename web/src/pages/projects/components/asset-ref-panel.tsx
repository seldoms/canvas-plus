import { Alert, App, Button, Card, Empty, Input, Select, Spin, Tag, Typography } from "antd";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AssetRefCreateInput, AssetRefPatchInput } from "@/services/api/projects";
import type { AssetRef } from "@/types/domain";

import { assetRefScope, buildAssetRefPatch, groupAssetRefs, shortId } from "../asset-ref-model";
import { AddAssetRefModal } from "./add-asset-ref-modal";

/**
 * 资产工作区看板：按 role 分组列出 AssetRef，可登记新引用、改 bindingId、在多候选间切换采用的 artifact。
 * 数据与写回动作来自 useProjectAssets，本组件只做编排与渲染。
 */
export function AssetRefPanel({
    refs,
    loading,
    error,
    onRetry,
    onPatch,
    onAdd,
    creating,
    savingRefId,
}: {
    refs: AssetRef[];
    loading: boolean;
    error: string;
    onRetry: () => void;
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
                    {loading ? (
                        <div className="flex justify-center py-16">
                            <Spin />
                        </div>
                    ) : error ? (
                        <Alert
                            type="error"
                            showIcon
                            message={t("projects.assetsView.loadFailed")}
                            description={error}
                            action={
                                <Button size="small" onClick={onRetry}>
                                    {t("projects.assetsView.retry")}
                                </Button>
                            }
                        />
                    ) : groups.length ? (
                        groups.map((group) => (
                            <div key={group.role} className="mb-5 last:mb-0">
                                <div className="mb-1.5 flex items-center gap-2">
                                    <span className="text-sm font-medium">{t(`projects.assetsView.roles.${group.role}`)}</span>
                                    <Tag className="!mr-0">{group.refs.length}</Tag>
                                </div>
                                <div className="space-y-1">
                                    {group.refs.map((ref) => (
                                        <AssetRefRow key={ref.id} refItem={ref} saving={savingRefId === ref.id} onPatch={onPatch} />
                                    ))}
                                </div>
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

/** 单条引用：作用范围 + 绑定对象（就地改）+ 采用的候选产物（切换）。 */
function AssetRefRow({ refItem, saving, onPatch }: { refItem: AssetRef; saving: boolean; onPatch: (refId: string, patch: AssetRefPatchInput) => Promise<unknown> }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [bindingId, setBindingId] = useState(refItem.bindingId);
    const [selected, setSelected] = useState(refItem.selectedArtifactId ?? "");

    // 服务端返回新值（成功写回）时同步本地草稿。
    useEffect(() => setBindingId(refItem.bindingId), [refItem.bindingId]);
    useEffect(() => setSelected(refItem.selectedArtifactId ?? ""), [refItem.selectedArtifactId]);

    const bindingDirty = Boolean(bindingId.trim()) && bindingId.trim() !== refItem.bindingId;
    const artifactOptions = refItem.artifactIds.map((id) => ({ value: id, label: shortId(id) }));

    const saveBinding = async () => {
        try {
            await onPatch(refItem.id, buildAssetRefPatch(refItem, { bindingId, selectedArtifactId: refItem.selectedArtifactId ?? null }));
            message.success(t("projects.assetsView.bindSaved"));
        } catch (patchError) {
            // 失败保留用户输入，不回退 bindingId 输入框。
            message.error(t("projects.assetsView.updateFailed", { message: patchError instanceof Error ? patchError.message : String(patchError) }));
        }
    };

    const changeSelected = async (value: string) => {
        const previous = refItem.selectedArtifactId ?? "";
        setSelected(value);
        try {
            await onPatch(refItem.id, { selectedArtifactId: value || null });
            message.success(t("projects.assetsView.selectSaved"));
        } catch (patchError) {
            setSelected(previous); // 采用关系未落库，选择回到原值。
            message.error(t("projects.assetsView.updateFailed", { message: patchError instanceof Error ? patchError.message : String(patchError) }));
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
            <Tag className="!mr-0 shrink-0">{t(`projects.assetsView.scope.${assetRefScope(refItem)}`)}</Tag>
            <Input size="small" className="min-w-[160px] flex-1" value={bindingId} onChange={(event) => setBindingId(event.target.value)} onPressEnter={() => bindingDirty && void saveBinding()} placeholder={t("projects.assetsView.bindingPlaceholder")} />
            <Button size="small" type="text" loading={saving} disabled={!bindingDirty} onClick={() => void saveBinding()}>
                {t("projects.assetsView.saveBinding")}
            </Button>
            {refItem.artifactIds.length ? (
                <Select
                    size="small"
                    className="min-w-[150px]"
                    value={selected || undefined}
                    placeholder={t("projects.assetsView.selectedArtifact")}
                    options={artifactOptions}
                    allowClear
                    loading={saving}
                    onChange={(value) => void changeSelected(value ?? "")}
                />
            ) : (
                <Typography.Text type="secondary" className="!text-xs">
                    {t("projects.assetsView.noArtifact")}
                </Typography.Text>
            )}
            <Typography.Text type="secondary" className="!text-xs">
                {t("projects.assetsView.artifactCount", { count: refItem.artifactIds.length })}
            </Typography.Text>
        </div>
    );
}

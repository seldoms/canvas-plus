import { App, AutoComplete, Modal, Select, Space, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { attachAssetRef, getProjectContext, listProjects, type AssetRefAttachInput } from "@/services/api/projects";
import type { AssetRole, Project } from "@/types/domain";

import { ASSET_ROLES } from "@/pages/projects/asset-ref-model";

/** 归因对象的最小信息：只够渲染下拉项，不把整本剧本拉进组件。 */
type PackEntity = { id: string; name: string };

/** 从项目剧本里解析出可归因的实体：角色取 characters，场景取 scenes 的地点，道具剧本无清单故留空。 */
function entitiesForRole(role: AssetRole, project: Project | null): PackEntity[] {
    const script = (project?.script ?? null) as Record<string, unknown> | null;
    if (!script || !project) return [];
    const collect = (key: "characters" | "scenes"): PackEntity[] => {
        const rows = Array.isArray(script[key]) ? script[key] : [];
        const out: PackEntity[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
            const item = row as Record<string, unknown>;
            const id = typeof item?.id === "string" ? item.id.trim() : "";
            if (!id || seen.has(id)) continue;
            // 场景用 location（纯地点名，与门禁匹配口径一致），title 只是场次标题。
            const name = [item.name, item.location, item.title].find((value) => typeof value === "string" && value.trim());
            seen.add(id);
            out.push({ id, name: typeof name === "string" && name.trim() ? name.trim() : id });
        }
        return out;
    };
    if (role === "character") return collect("characters");
    if (role === "scene") return collect("scenes");
    return [];
}

export type AttachAssetModalProps = {
    open: boolean;
    onClose: () => void;
    /** 本次要归入的产物：本网关产物地址 + 来源 job（用于归因与提示）。 */
    artifact: { url: string; jobId?: string | null; name?: string } | null;
    /** 预选项目（从项目页触发时用）。 */
    defaultProjectId?: string;
    /** 归入成功后回调（刷新资料包等）。 */
    onAttached?: (result: { projectId: string; created: boolean; addedArtifactIds: number }) => void;
};

/**
 * 「归入项目资料包」弹窗 —— 把工作台产物挂到项目某个实体上。
 *
 * 为什么走 attach 而不是已有的 create：create 每次都新增一条引用，
 * 同一角色归入多张图就会留下多条同 bindingId 的引用，选参考图时随机命中（实测踩过）。
 * attach 是 upsert：命中已有引用就追加候选。
 *
 * 实体选项全部来自项目真实剧本，不写死任何示例名；
 * 剧本里没有对应清单（如道具）时允许手填 bindingId，而不是逼用户去猜一个 id。
 */
export function AttachAssetModal({ open, onClose, artifact, defaultProjectId, onAttached }: AttachAssetModalProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [projectId, setProjectId] = useState(defaultProjectId ?? "");
    const [role, setRole] = useState<AssetRole>("character");
    const [bindingId, setBindingId] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const [projectOptions, setProjectOptions] = useState<{ value: string; label: string }[]>([]);
    const [project, setProject] = useState<Project | null>(null);

    // 每次打开重置，避免带上一次的输入。
    useEffect(() => {
        if (!open) return;
        setProjectId(defaultProjectId ?? "");
        setRole("character");
        setBindingId("");
    }, [open, defaultProjectId]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void listProjects()
            .then((rows) => {
                if (cancelled) return;
                const options = rows.map((row) => ({ value: row.id, label: row.title || row.id }));
                setProjectOptions(options);
                // 没预选项目时默认选最近更新的那个，省一次点击。
                if (!defaultProjectId && options.length) setProjectId((current) => current || options[0].value);
            })
            .catch(() => {
                if (!cancelled) setProjectOptions([]);
            });
        return () => {
            cancelled = true;
        };
    }, [open, defaultProjectId]);

    // 只在选了项目后拉剧本，解析出这个项目真有的角色/场景实体。
    useEffect(() => {
        if (!open || !projectId) {
            setProject(null);
            return;
        }
        let cancelled = false;
        void getProjectContext(projectId)
            .then((context) => {
                if (!cancelled) setProject(context?.project ?? null);
            })
            .catch(() => {
                if (!cancelled) setProject(null);
            });
        return () => {
            cancelled = true;
        };
    }, [open, projectId]);

    const entities = useMemo(() => entitiesForRole(role, project), [role, project]);
    const entityOptions = useMemo(() => entities.map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` })), [entities]);

    const submit = useCallback(async () => {
        const target = bindingId.trim();
        const url = artifact?.url?.trim();
        if (!url) {
            message.warning(t("attachAsset.noArtifact"));
            return;
        }
        if (!projectId) {
            message.warning(t("attachAsset.pickProject"));
            return;
        }
        if (!target) {
            message.warning(t("attachAsset.bindingRequired"));
            return;
        }
        const input: AssetRefAttachInput = { role, bindingId: target, artifactId: url, sourceJobId: artifact?.jobId ?? undefined, name: artifact?.name ?? undefined };
        setSubmitting(true);
        try {
            const result = await attachAssetRef(projectId, input);
            message.success(result.created ? t("attachAsset.created") : t("attachAsset.appended", { count: result.addedArtifactIds }));
            onAttached?.({ projectId, created: result.created, addedArtifactIds: result.addedArtifactIds });
            onClose();
        } catch (error) {
            message.error(t("attachAsset.failed", { message: error instanceof Error ? error.message : String(error) }));
        } finally {
            setSubmitting(false);
        }
    }, [artifact, bindingId, message, onAttached, onClose, projectId, role, t]);

    const entityHint = entities.length ? t("attachAsset.pickEntityHint", { count: entities.length }) : t("attachAsset.manualHint");

    return (
        <Modal
            open={open}
            title={t("attachAsset.title")}
            onCancel={onClose}
            onOk={() => void submit()}
            confirmLoading={submitting}
            okText={t("attachAsset.submit")}
            cancelText={t("common.cancel")}
        >
            <Space direction="vertical" size={12} className="w-full pt-2">
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("attachAsset.project")}</span>
                    <Select
                        className="w-full"
                        value={projectId || undefined}
                        placeholder={t("attachAsset.pickProject")}
                        options={projectOptions}
                        showSearch
                        optionFilterProp="label"
                        onChange={setProjectId}
                    />
                </label>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("attachAsset.category")}</span>
                    <Select className="w-full" value={role} options={ASSET_ROLES.map((value) => ({ value, label: t(`projects.assetsView.roles.${value}`) }))} onChange={(value: AssetRole) => setRole(value)} />
                </label>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("attachAsset.target")}</span>
                    {entityOptions.length ? (
                        <Select className="w-full" value={bindingId || undefined} placeholder={entityHint} options={entityOptions} showSearch optionFilterProp="label" onChange={setBindingId} />
                    ) : (
                        // 剧本里没有该类实体（如道具）时允许手填 id，不硬凑一份假清单。
                        <AutoComplete className="w-full" value={bindingId} placeholder={entityHint} options={[]} onChange={setBindingId} />
                    )}
                </label>
                <Typography.Text type="secondary" className="!text-xs">
                    {t("attachAsset.upsertHint")}
                </Typography.Text>
            </Space>
        </Modal>
    );
}
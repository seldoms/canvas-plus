import { App, Button, Input, Modal, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AssetRefCreateInput } from "@/services/api/projects";
import type { AssetRole } from "@/types/domain";

import { ASSET_ROLES } from "../asset-ref-model";

/** 登记资产引用弹窗：选 role + 填绑定对象 id（剧本里的角色/场景/道具）。 */
export function AddAssetRefModal({
    open,
    creating,
    onClose,
    onAdd,
}: {
    open: boolean;
    creating: boolean;
    onClose: () => void;
    onAdd: (input: AssetRefCreateInput) => Promise<unknown>;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [role, setRole] = useState<AssetRole>("character");
    const [bindingId, setBindingId] = useState("");

    // 每次打开重置为空表单，避免带上一次的输入。
    useEffect(() => {
        if (open) {
            setRole("character");
            setBindingId("");
        }
    }, [open]);

    const roleOptions = useMemo(() => ASSET_ROLES.map((value) => ({ value, label: t(`projects.assetsView.roles.${value}`) })), [t]);

    const submit = async () => {
        const trimmed = bindingId.trim();
        if (!trimmed) {
            message.warning(t("projects.assetsView.bindingRequired"));
            return;
        }
        try {
            await onAdd({ role, bindingId: trimmed });
            message.success(t("projects.assetsView.created"));
            onClose();
        } catch (createError) {
            // 失败保留已填写内容，不关闭弹窗。
            message.error(t("projects.assetsView.createFailed", { message: createError instanceof Error ? createError.message : String(createError) }));
        }
    };

    return (
        <Modal open={open} title={t("projects.assetsView.addTitle")} onCancel={onClose} onOk={() => void submit()} confirmLoading={creating} okText={t("projects.assetsView.create")} cancelText={t("projects.assetsView.cancel")}>
            <Space direction="vertical" size={12} className="w-full pt-2">
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("projects.assetsView.role")}</span>
                    <Select className="w-full" value={role} options={roleOptions} onChange={(value: AssetRole) => setRole(value)} />
                </label>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("projects.assetsView.bindingId")}</span>
                    <Input value={bindingId} placeholder={t("projects.assetsView.bindingPlaceholder")} onChange={(event) => setBindingId(event.target.value)} onPressEnter={() => void submit()} />
                </label>
                <Typography.Text type="secondary" className="!text-xs">
                    {t("projects.assetsView.addHint")}
                </Typography.Text>
            </Space>
        </Modal>
    );
}

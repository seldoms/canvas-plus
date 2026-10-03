import { App, Button, Popconfirm, Space, Tooltip } from "antd";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { archiveArtifacts, deleteArtifacts, isArtifactUrl, restoreArtifacts } from "@/services/api/artifacts";

/**
 * 产物操作（共用）：归档 / 恢复 /（仅 allowDelete 时）彻底删除。
 *
 * 设计定调：**生产动线上只给「归档」**（可逆）；**只有「我的资产」页传 allowDelete** 才给「彻底删除」。
 * - 归档成功后弹气泡带「撤销」，撤销即调 /restore 复原；
 * - 传入 onRequestDelete（资产页二次确认弹窗）时，删除按钮只回调、不直接删；
 *   未传时用 Popconfirm 就地确认（护栏，默认动线不会走到）。
 */
export type ArtifactTarget = { id?: string; url?: string };

type Props = {
    targets: ArtifactTarget[];
    /** 当前状态：active 显示「归档」、archived 显示「恢复」。 */
    state?: "active" | "archived";
    /** 仅「我的资产」页传 true，才出现「彻底删除」。 */
    allowDelete?: boolean;
    /** 操作成功后回调（刷新列表/引用）。 */
    onChanged?: () => void;
    /** 传了则删除交回父级处理（资产页的确认弹窗）：参数是规范化后的目标。 */
    onRequestDelete?: (targets: ArtifactTarget[]) => void;
    iconOnly?: boolean;
};

/** 目标 → 规范键（优先后端 id；否则仅当 URL 指向本网关产物时才用它）。 */
export function resolveArtifactKeys(targets: ArtifactTarget[]): string[] {
    return targets
        .map((target) => (target.id ? String(target.id) : isArtifactUrl(target.url) ? String(target.url) : ""))
        .filter(Boolean);
}

export function ArtifactActions({ targets, state = "active", allowDelete = false, onChanged, onRequestDelete, iconOnly = false }: Props) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const keys = resolveArtifactKeys(targets);
    if (!keys.length) return null;

    const run = async (task: () => Promise<void>) => {
        setBusy(true);
        try {
            await task();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const archive = () =>
        run(async () => {
            const result = await archiveArtifacts(keys);
            if (!result.archived.length) {
                message.error(t("artifacts.archiveFailed"));
                return;
            }
            const undo = async () => {
                try {
                    await restoreArtifacts(result.archived);
                    message.success(t("artifacts.restored"));
                    onChanged?.();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : String(error));
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
            onChanged?.();
        });

    const restore = () =>
        run(async () => {
            const result = await restoreArtifacts(keys);
            message.success(t("artifacts.restoredCount", { count: result.restored.length }));
            onChanged?.();
        });

    const removeInline = () =>
        run(async () => {
            const result = await deleteArtifacts(keys);
            if (result.blocked.length) {
                message.warning(t("artifacts.blockedWarning", { count: result.blocked.length }));
            } else if (result.deleted.length) {
                message.success(t("artifacts.deletedCount", { count: result.deleted.length }));
            }
            onChanged?.();
        });

    const deleteButton = (
        <Button
            key="delete"
            size="small"
            danger
            type="text"
            loading={busy}
            icon={<Trash2 className="size-3.5" />}
            onClick={onRequestDelete ? () => onRequestDelete(targets) : undefined}
        >
            {iconOnly ? null : t("artifacts.delete")}
        </Button>
    );

    return (
        <Space size={2} wrap>
            {state === "archived" ? (
                <Tooltip title={t("artifacts.restore")}>
                    <Button size="small" type="text" loading={busy} icon={<RotateCcw className="size-3.5" />} onClick={() => void restore()}>
                        {iconOnly ? null : t("artifacts.restore")}
                    </Button>
                </Tooltip>
            ) : (
                <Tooltip title={t("artifacts.archive")}>
                    <Button size="small" type="text" loading={busy} icon={<Archive className="size-3.5" />} onClick={() => void archive()}>
                        {iconOnly ? null : t("artifacts.archive")}
                    </Button>
                </Tooltip>
            )}
            {allowDelete ? (
                onRequestDelete ? (
                    deleteButton
                ) : (
                    <Popconfirm
                        key="delete-confirm"
                        title={t("artifacts.deleteConfirmTitle")}
                        description={t("artifacts.deleteConfirmBody", { count: keys.length })}
                        okText={t("common.delete")}
                        cancelText={t("common.cancel")}
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void removeInline()}
                    >
                        {deleteButton}
                    </Popconfirm>
                )
            ) : null}
        </Space>
    );
}

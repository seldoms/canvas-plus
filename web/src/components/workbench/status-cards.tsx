import { Button, Progress, Typography } from "antd";
import { LoaderCircle, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkbenchJobProgress } from "./types";

/**
 * 「生成中」占位卡片：进度/节点名全部来自后端 progress{value,max,node}。
 * 没有 max 时至少显示后端节点状态（排队中/生成中/已提交）。可取消（生图/视频共用）。
 */
export function PendingMediaCard({ progress, onCancel, aspectClassName = "aspect-square" }: { progress?: WorkbenchJobProgress; onCancel?: () => void; aspectClassName?: string }) {
    const { t } = useTranslation();
    const max = Number(progress?.max) || 0;
    const value = Number(progress?.value) || 0;
    const detail = max > 0 ? `${value}/${max}` : progress?.node || t("workbench.generating");
    return (
        <div className={`relative overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900 ${aspectClassName}`}>
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{detail}</span>
                {max > 0 ? <Progress percent={Math.round((value / max) * 100)} size="small" showInfo={false} className="!mb-0 !w-24" /> : null}
                {onCancel ? (
                    <Button size="small" icon={<XCircle className="size-3.5" />} onClick={onCancel}>
                        {t("workbench.cancel")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

/** 「失败 / 已取消」卡片：取消态不给重试（取消是用户主动动作），失败可重试。 */
export function FailedMediaCard({ error, canceled = false, onRetry, aspectClassName = "aspect-square" }: { error: string; canceled?: boolean; onRetry?: () => void; aspectClassName?: string }) {
    const { t } = useTranslation();
    if (canceled) {
        return (
            <div className={`overflow-hidden rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900 ${aspectClassName}`}>
                <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
                    <XCircle className="size-6 text-stone-400" />
                    <div className="text-sm font-medium text-stone-500 dark:text-stone-400">{t("workbench.canceled")}</div>
                </div>
            </div>
        );
    }
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className={`flex flex-col items-center justify-center gap-3 p-5 text-center ${aspectClassName}`}>
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            {onRetry ? (
                <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                    <Button size="small" danger onClick={onRetry}>
                        {t("workbench.retry")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

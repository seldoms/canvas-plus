import { Button, Progress, Typography } from "antd";
import { LoaderCircle, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { jobProgressPercent } from "./task-utils";
import type { WorkbenchJobProgress } from "./types";

/**
 * 「生成中」占位卡片：进度/节点名全部来自后端 progress{value,max,node,percent}。
 *
 * 比例**优先用后端下发的 percent**（已按「分母会增长」钳制成单调），
 * 只有 percent 缺失时才退回本地算value/max。老job 记录（无 percent）走后者，
 * 因此两条路都要过 task-utils 的单调钳制。
 * 没有 max 也没有 percent 时至少显示后端节点状态（排队中/生成中/已提交）。可取消（生图/视频共用）。
 */
export function PendingMediaCard({ progress, onCancel, aspectClassName = "aspect-square" }: { progress?: WorkbenchJobProgress; onCancel?: () => void; aspectClassName?: string }) {
    const { t } = useTranslation();
    // 比例走 task-utils 的统一判据（优先用后端下发的单调 percent），不要在这里裸算。
    const percent = jobProgressPercent(progress);
    const hasPercent = percent >= 0;
    // 有真实比例时不再显示 value/max —— max 会随新节点加入而变大，
    // 「13/21」本身就在暗示 62%，而真实已到 92%，文案与实际不符比没有文案更糟。
    const detail = hasPercent ? `${percent}%` : progress?.node || t("workbench.generating");
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
                {hasPercent ? <Progress percent={percent} size="small" showInfo={false} className="!mb-0 !w-24" /> : null}
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

import { Button, Empty, Spin } from "antd";
import { Pencil, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { GatewayStageStatus } from "@/services/api/gateway";
import { usePipelineStore, type PipelineRunRecord } from "@/stores/use-pipeline-store";

const STATUS_DOT: Record<GatewayStageStatus, string> = {
    pending: "text-stone-400 dark:text-stone-500",
    running: "text-amber-600 dark:text-amber-400",
    partial: "text-orange-600 dark:text-orange-400",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    canceled: "text-stone-400 dark:text-stone-500",
};

/** 后端 createdAt 是 ISO，这里按本地时区显示到分钟即可。 */
function formatTime(iso: string) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 当前阶段：正在跑的最优先，其次是最靠后的非待运行阶段，都没有就取第一个。 */
function currentStage(run: PipelineRunRecord) {
    const stages = Object.values(run.stages || {});
    return stages.find((stage) => stage.status === "running") || [...stages].reverse().find((stage) => stage.status !== "pending") || stages[0] || null;
}

export function PipelineHistory({ loading, onOpen, onRename, onCreate, onRefresh }: { loading: boolean; onOpen: (id: string) => void; onRename: (id: string, title: string) => void; onCreate: () => void; onRefresh: () => void }) {
    const { t } = useTranslation();
    const recentRuns = usePipelineStore((state) => state.recentRuns);
    const activeRunId = usePipelineStore((state) => state.activeRunId);

    return (
        <div className="mt-5">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">历史流水线</span>
                <div className="ml-auto flex items-center gap-1">
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreate}>
                        新建流水线
                    </Button>
                    <Button size="small" type="text" icon={<RefreshCw className={cn("size-3.5", loading && "animate-spin")} />} disabled={loading} onClick={onRefresh}>
                        刷新
                    </Button>
                </div>
            </div>

            {loading && !recentRuns.length ? (
                <div className="flex justify-center py-10">
                    <Spin />
                </div>
            ) : !recentRuns.length ? (
                <Empty className="py-10" description="暂无历史流水线" />
            ) : (
                <div className="mt-2 divide-y divide-stone-200/70 dark:divide-stone-800/70">
                    {recentRuns.map((item) => {
                        const stage = currentStage(item);
                        const isActive = item.id === activeRunId;
                        return (
                            <div
                                key={item.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => onOpen(item.id)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onOpen(item.id);
                                }}
                                className={cn("flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-1 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]", isActive && "bg-black/[0.03] dark:bg-white/[0.05]")}
                            >
                                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">{item.title || item.id}</span>
                                {isActive ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">当前</span> : null}
                                <span className="text-xs text-stone-500 dark:text-stone-400">{formatTime(item.createdAt)}</span>
                                {stage ? (
                                    <span className={cn("inline-flex items-center gap-1 text-xs", STATUS_DOT[stage.status])}>
                                        <span className="size-1.5 rounded-full bg-current" />
                                        {stage.title} · {t(`pipeline.status.${stage.status}`)}
                                    </span>
                                ) : (
                                    <span className="text-xs text-stone-400 dark:text-stone-500">{item.id}</span>
                                )}
                                <Button
                                    className="ml-auto"
                                    size="small"
                                    type="text"
                                    icon={<Pencil className="size-3.5" />}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onRename(item.id, item.title);
                                    }}
                                >
                                    {t("common.edit")}
                                </Button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

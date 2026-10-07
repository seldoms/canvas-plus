import { Button, Tooltip } from "antd";
import { AlertTriangle, Ban, CircleDashed, Loader2, Lock, Play, RotateCcw, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { StageStatus } from "./mock-data";

export const STATUS_META: Record<StageStatus, { label: string; className: string; dot: string }> = {
    pending: { label: "待生产", className: "text-stone-500 dark:text-stone-400", dot: "bg-stone-300 dark:bg-stone-600" },
    running: { label: "生产中", className: "text-amber-600 dark:text-amber-400", dot: "animate-pulse bg-amber-400" },
    partial: { label: "部分完成", className: "text-orange-600 dark:text-orange-400", dot: "bg-orange-400" },
    done: { label: "已完成", className: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-400" },
    error: { label: "有失败", className: "text-red-600 dark:text-red-400", dot: "bg-red-400" },
    blocked: { label: "被阻断", className: "text-violet-600 dark:text-violet-400", dot: "bg-violet-400" },
    canceled: { label: "已取消", className: "text-stone-500 dark:text-stone-400", dot: "bg-stone-300 dark:bg-stone-600" },
};

export function StatusBadge({ status, className }: { status: StageStatus; className?: string }) {
    const meta = STATUS_META[status];
    return (
        <span className={cn("inline-flex items-center gap-1.5 text-xs", meta.className, className)}>
            <span className={cn("size-1.5 rounded-full", meta.dot)} />
            {meta.label}
        </span>
    );
}

/**
 * 阶段工作台统一骨架（清单 §2 末行）：
 * 每个阶段就地看到 —— 适用模型、操作入口（运行/续跑/取消/重试失败）、当前成果（children）、失败原因（alerts）。
 * 模型选择按能力域配对，由调用方传入 modelSlot，不再是一个万能下拉。
 */
export function StageShell({
    index,
    title,
    status,
    modelSlot,
    alerts,
    children,
    dependsLocked,
}: {
    index: number;
    title: string;
    status: StageStatus;
    modelSlot?: ReactNode;
    alerts?: ReactNode;
    children: ReactNode;
    dependsLocked?: string;
}) {
    const running = status === "running";
    return (
        <section className="rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-transparent">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200/80 px-5 py-3.5 dark:border-stone-800/80">
                <span className="flex items-baseline gap-2">
                    <span className="text-[11px] tabular-nums text-stone-400 dark:text-stone-500">{String(index + 1).padStart(2, "0")}</span>
                    <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{title}</span>
                </span>
                <StatusBadge status={status} />
                {dependsLocked ? (
                    <Tooltip title={`上游未完成：${dependsLocked}`}>
                        <span className="inline-flex items-center gap-1 text-xs text-stone-400 dark:text-stone-500">
                            <Lock className="size-3.5" />
                            待上游
                        </span>
                    </Tooltip>
                ) : null}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    {modelSlot}
                    {running ? (
                        <Button size="small" danger icon={<Ban className="size-3.5" />}>取消</Button>
                    ) : (
                        <Button size="small" type="primary" icon={<Play className="size-3.5" />} disabled={Boolean(dependsLocked)}>
                            {status === "pending" ? "运行本阶段" : "继续生产"}
                        </Button>
                    )}
                    {status === "error" || status === "partial" ? (
                        <Button size="small" icon={<Wrench className="size-3.5" />}>重试失败项</Button>
                    ) : null}
                    {status !== "pending" && !running ? (
                        <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />}>重跑</Button>
                    ) : null}
                </div>
            </header>
            {alerts ? <div className="space-y-2 px-5 pt-4">{alerts}</div> : null}
            <div className="px-5 py-4">{children}</div>
        </section>
    );
}

/** 面板内的分区小标题 */
export function PanelSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
    return (
        <div className="mt-4 first:mt-0">
            <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-stone-500 dark:text-stone-400">{title}</span>
                {extra}
            </div>
            {children}
        </div>
    );
}

/** 行内失败提示（失败原因就地可见，而不是藏在日志里） */
export function InlineError({ children }: { children: ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="size-3.5" />
            {children}
        </span>
    );
}

export function RunningDot() {
    return <Loader2 className="size-3.5 animate-spin text-amber-500" />;
}

export { CircleDashed };

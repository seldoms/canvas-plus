import { AlertTriangle, CircleDashed, Loader2 } from "lucide-react";
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
 * 阶段工作台容器（瘦身版）：阶段标题/状态/模型/操作已并入顶部步骤条行，
 * 这里只保留成果内容与就地失败提示，让生产内容吃掉几乎全部版面。
 */
export function StageShell({ alerts, children }: { alerts?: ReactNode; children: ReactNode }) {
    return (
        <section className="rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-transparent">
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

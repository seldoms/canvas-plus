import { Button, Tag, Tooltip } from "antd";
import { BookOpen, GitBranch, History, PanelLeftClose, PanelLeftOpen, Plus, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";

import { EPISODES, PROJECT, RUNS } from "./mock-data";

/**
 * 生产侧栏 —— 项目 → 集 → 执行记录三级上下文收进左栏（原上下文条的纵向化）：
 * - 集即全局唯一的集选择入口，各阶段面板不再各自带集导航；
 * - 执行记录按选中集过滤，分支 run 带分叉图标；
 * - 打开 run 后左栏即锁定态的视觉锚点（快照设置明细在「剧本」阶段的制作设定里展示）；
 * - 可收起为窄轨：只留展开钮 + 集序号，把主体让给创作窗口。
 */
export function PipelineSidebar({
    episodeId,
    runId,
    collapsed,
    onSelectEpisode,
    onSelectRun,
    onToggleCollapsed,
}: {
    episodeId: string;
    runId: string | null;
    collapsed: boolean;
    onSelectEpisode: (id: string) => void;
    onSelectRun: (id: string) => void;
    onToggleCollapsed: () => void;
}) {
    const episodeRuns = RUNS.filter((run) => run.episodeId === episodeId);

    if (collapsed) {
        return (
            <aside className="flex w-10 shrink-0 flex-col items-center overflow-y-auto rounded-xl border border-stone-200 bg-white py-2 dark:border-stone-800 dark:bg-transparent">
                <Tooltip title="展开侧栏" placement="right">
                    <button
                        type="button"
                        onClick={onToggleCollapsed}
                        className="inline-flex size-7 items-center justify-center rounded-md text-stone-500 transition hover:bg-black/5 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-white"
                        aria-label="展开侧栏"
                    >
                        <PanelLeftOpen className="size-4" />
                    </button>
                </Tooltip>
                <div className="mt-2 flex flex-col items-center gap-1 border-t border-stone-200/60 pt-2 dark:border-stone-800/60">
                    {EPISODES.map((ep) => {
                        const active = ep.id === episodeId;
                        return (
                            <Tooltip key={ep.id} title={`第 ${ep.index} 集 · ${ep.title}`} placement="right">
                                <button
                                    type="button"
                                    onClick={() => onSelectEpisode(ep.id)}
                                    className={cn(
                                        "inline-flex size-7 items-center justify-center rounded-md text-[11px] tabular-nums transition",
                                        active
                                            ? "bg-stone-950 font-medium text-white dark:bg-white dark:text-stone-900"
                                            : "text-stone-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10",
                                    )}
                                >
                                    {String(ep.index).padStart(2, "0")}
                                </button>
                            </Tooltip>
                        );
                    })}
                </div>
                <Tooltip title="QC 通过" placement="right">
                    <span className="mt-auto mb-1 size-1.5 rounded-full bg-emerald-500" />
                </Tooltip>
            </aside>
        );
    }

    return (
        <aside className="flex w-52 shrink-0 flex-col overflow-y-auto rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-transparent">
            {/* 项目 */}
            <div className="flex items-center gap-2 px-3.5 pb-2 pt-3.5">
                <BookOpen className="size-4 shrink-0 text-stone-400" />
                <span className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">《{PROJECT.title}》</span>
                <Tooltip title="收起侧栏">
                    <button
                        type="button"
                        onClick={onToggleCollapsed}
                        className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-stone-400 transition hover:bg-black/5 hover:text-stone-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
                        aria-label="收起侧栏"
                    >
                        <PanelLeftClose className="size-3.5" />
                    </button>
                </Tooltip>
            </div>

            {/* 集 */}
            <div className="border-t border-stone-200/60 px-2 py-2 dark:border-stone-800/60">
                <div className="flex items-center px-1.5 pb-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400">集 · {EPISODES.length}</span>
                    <Button size="small" type="text" icon={<Plus className="size-3.5" />} className="ml-auto -mr-1 h-5 px-1 text-[11px]">新建</Button>
                </div>
                {EPISODES.map((ep) => {
                    const active = ep.id === episodeId;
                    return (
                        <button
                            key={ep.id}
                            type="button"
                            onClick={() => onSelectEpisode(ep.id)}
                            className={cn(
                                "w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] transition hover:bg-black/5 dark:hover:bg-white/10",
                                active && "bg-black/5 font-medium dark:bg-white/10",
                            )}
                        >
                            <span className="tabular-nums text-stone-400">{String(ep.index).padStart(2, "0")}</span>
                            <span className="ml-1.5 text-stone-800 dark:text-stone-200">{ep.title}</span>
                        </button>
                    );
                })}
            </div>

            {/* 执行记录（按集过滤） */}
            <div className="border-t border-stone-200/60 px-2 py-2 dark:border-stone-800/60">
                <div className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">执行记录</div>
                {episodeRuns.length ? (
                    episodeRuns.map((run) => {
                        const active = run.id === runId;
                        return (
                            <button
                                key={run.id}
                                type="button"
                                onClick={() => onSelectRun(run.id)}
                                className={cn(
                                    "w-full rounded-lg px-2.5 py-1.5 text-left transition hover:bg-black/5 dark:hover:bg-white/10",
                                    active && "bg-black/5 dark:bg-white/10",
                                )}
                            >
                                <span className="flex items-center gap-1.5 text-[13px] text-stone-800 dark:text-stone-200">
                                    {run.parentId ? <GitBranch className="size-3 shrink-0 text-stone-400" /> : null}
                                    <span className="truncate">{run.title.replace(/^第 \d+ 集 · /, "")}</span>
                                </span>
                                <span className="mt-0.5 block pl-4 text-[11px] tabular-nums text-stone-400">{run.createdAt}</span>
                            </button>
                        );
                    })
                ) : (
                    <div className="px-2.5 py-1.5 text-[11px] text-stone-400">本集尚无执行记录</div>
                )}
            </div>

            {/* 底部：QC / 历史 / Demo 标记 */}
            <div className="mt-auto flex items-center gap-1.5 border-t border-stone-200/60 px-3 py-2.5 dark:border-stone-800/60">
                <Tooltip title="结构、引用、对白时序检查已通过；声纹与嘴型需人工复核（不做越界承诺）">
                    <Tag icon={<ShieldCheck className="size-3" />} color="success" className="mr-0 inline-flex items-center gap-1 text-[11px]">
                        QC
                    </Tag>
                </Tooltip>
                <Button size="small" type="text" icon={<History className="size-3.5" />} className="h-6 px-1.5 text-[11px]">历史</Button>
                <span className="ml-auto rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300">Demo</span>
            </div>
        </aside>
    );
}

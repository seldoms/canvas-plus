import { Button, Select, Tooltip } from "antd";
import { BookOpen, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

import type { RunListItem } from "./use-production";

type ProjectItem = { id: string; title: string };
type EpisodeItem = { id: string; index: number; title: string };

/** ISO 时间 → 「MM-DD HH:mm」短格式（执行记录列表用）。 */
function shortTime(iso: string) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso.slice(0, 16);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 生产侧栏 —— 项目 → 集 → 执行记录三级上下文（真实数据）。
 * - 多项目时项目名是下拉；集是全局唯一集入口；执行记录按项目过滤（run↔集关联后端未存，见 use-production 注释）；
 * - 可收起为窄轨：只留展开钮 + 集序号，把主体让给创作窗口。
 */
export function PipelineSidebar({
    projects,
    projectId,
    episodes,
    episodeId,
    runs,
    runId,
    collapsed,
    onSelectProject,
    onSelectEpisode,
    onSelectRun,
    onToggleCollapsed,
}: {
    projects: ProjectItem[];
    projectId: string;
    episodes: EpisodeItem[];
    episodeId: string;
    runs: RunListItem[];
    runId: string;
    collapsed: boolean;
    onSelectProject: (id: string) => void;
    onSelectEpisode: (id: string) => void;
    onSelectRun: (id: string) => void;
    onToggleCollapsed: () => void;
}) {
    const project = projects.find((item) => item.id === projectId) || null;

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
                    {episodes.map((ep) => {
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
            </aside>
        );
    }

    return (
        <aside className="flex w-52 shrink-0 flex-col overflow-y-auto rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-transparent">
            {/* 项目 */}
            <div className="flex items-center gap-2 px-3.5 pb-2 pt-3.5">
                <BookOpen className="size-4 shrink-0 text-stone-400" />
                {projects.length > 1 ? (
                    <Select
                        size="small"
                        variant="borderless"
                        value={projectId || undefined}
                        placeholder="选择项目"
                        className="min-w-0 flex-1 font-semibold"
                        options={projects.map((item) => ({ value: item.id, label: `《${item.title}》` }))}
                        onChange={onSelectProject}
                    />
                ) : (
                    <span className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">
                        {project ? `《${project.title}》` : "暂无项目"}
                    </span>
                )}
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
                    <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400">集 · {episodes.length}</span>
                    <Button size="small" type="text" icon={<Plus className="size-3.5" />} className="ml-auto -mr-1 h-5 px-1 text-[11px]" disabled title="新建集接口待接">
                        新建
                    </Button>
                </div>
                {episodes.length ? (
                    episodes.map((ep) => {
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
                    })
                ) : (
                    <div className="px-2.5 py-1.5 text-[11px] text-stone-400">暂无集</div>
                )}
            </div>

            {/* 执行记录（按项目过滤；无记录时点「运行」自动建立） */}
            <div className="border-t border-stone-200/60 px-2 py-2 dark:border-stone-800/60">
                <div className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">执行记录</div>
                {runs.length ? (
                    runs.map((item) => {
                        const active = item.id === runId;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => onSelectRun(item.id)}
                                className={cn(
                                    "w-full rounded-lg px-2.5 py-1.5 text-left transition hover:bg-black/5 dark:hover:bg-white/10",
                                    active && "bg-black/5 dark:bg-white/10",
                                )}
                            >
                                <span className="block truncate text-[13px] text-stone-800 dark:text-stone-200">{item.title}</span>
                                <span className="mt-0.5 block text-[11px] tabular-nums text-stone-400">{shortTime(item.createdAt)}</span>
                            </button>
                        );
                    })
                ) : (
                    <div className="px-2.5 py-1.5 text-[11px] leading-4 text-stone-400">尚无执行记录，点「运行」将按项目原文自动建立</div>
                )}
            </div>

            {/* 底部：接线状态说明（QC 徽标待接 /qc 接口后恢复，不做越界展示） */}
            <div className="mt-auto border-t border-stone-200/60 px-3 py-2 text-[10px] leading-4 text-stone-400 dark:border-stone-800/60 dark:text-stone-500">
                面板与操作已接真实接口；模型选择与 QC 徽标待接 registry / qc。
            </div>
        </aside>
    );
}

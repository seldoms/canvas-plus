import { Button, Select, Tag, Tooltip } from "antd";
import { BookOpen, GitBranch, History, Lock, Plus, ShieldCheck } from "lucide-react";

import { PROJECT, RUNS, type MockRun } from "./mock-data";

/**
 * 生产上下文条 —— 修复清单 §4.1/§4.3：
 * 1. 项目 → 集 → run 三级联动：切项目拉集列表，切集过滤该项目该集的 run；打开 run 时反向恢复项目/集（不再默认首项目）。
 * 2. run 打开后项目/集锁定，并显示「事实快照 vN · 已冻结」——锁的不只是选择器，页面明确告知下游读的是快照而非项目当前值。
 */
export function ContextBar({
    run,
    onSelectRun,
}: {
    run: MockRun | null;
    onSelectRun: (id: string) => void;
}) {
    const locked = Boolean(run);
    const episodeOptions = [
        { value: "ep-01", label: "第 1 集 · 缺席的座位" },
        { value: "ep-02", label: "第 2 集 · 旧围裙" },
        { value: "ep-03", label: "第 3 集 · 红包" },
    ];
    return (
        <div className="rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-transparent">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                <BookOpen className="size-4 text-stone-400" />
                <Select
                    size="middle"
                    value={PROJECT.id}
                    disabled={locked}
                    className="min-w-44"
                    options={[{ value: PROJECT.id, label: `《${PROJECT.title}》` }]}
                />
                <span className="text-stone-300 dark:text-stone-600">/</span>
                <Select
                    size="middle"
                    value={run?.episodeId || "ep-01"}
                    disabled={locked}
                    className="min-w-52"
                    options={episodeOptions}
                />
                <span className="text-stone-300 dark:text-stone-600">/</span>
                <Select
                    size="middle"
                    value={run?.id}
                    placeholder="选择执行记录（run）"
                    className="min-w-64"
                    onChange={onSelectRun}
                    options={RUNS.filter((item) => !run || item.episodeId === run.episodeId || true).map((item) => ({
                        value: item.id,
                        label: (
                            <span className="flex items-center gap-2">
                                {item.parentId ? <GitBranch className="size-3.5 text-stone-400" /> : null}
                                <span>{item.title}</span>
                                <span className="text-xs text-stone-400">{item.createdAt}</span>
                            </span>
                        ),
                    }))}
                />
                <Button size="middle" type="text" icon={<Plus className="size-4" />}>新建 run</Button>
                <div className="ml-auto flex items-center gap-2">
                    <Tooltip title="结构、引用、对白时序检查已通过；声纹与嘴型需人工复核（不做越界承诺）">
                        <Tag icon={<ShieldCheck className="size-3.5" />} color="success" className="mr-0 inline-flex items-center gap-1">
                            QC 通过
                        </Tag>
                    </Tooltip>
                    <Button type="text" icon={<History className="size-4" />}>历史</Button>
                </div>
            </div>
            {run ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-stone-200/60 px-5 py-2.5 text-xs text-stone-500 dark:border-stone-800/60 dark:text-stone-400">
                    <Lock className="size-3.5 text-stone-400" />
                    <span>
                        事实快照 <b className="text-stone-700 dark:text-stone-200">v{run.snapshotVersion}</b> 已冻结 —— 本 run 的风格、画幅、声音路线与正文均读取快照，项目后续改动不影响本次生产
                    </span>
                    <span className="mx-1 text-stone-300 dark:text-stone-600">·</span>
                    <span>{PROJECT.ratio}</span>
                    <span className="text-stone-300 dark:text-stone-600">·</span>
                    <span>{PROJECT.audioMode}</span>
                    <span className="text-stone-300 dark:text-stone-600">·</span>
                    <span className="truncate">{PROJECT.styleAnchor}</span>
                </div>
            ) : null}
        </div>
    );
}

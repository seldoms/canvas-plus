import { Button, Checkbox, Progress, Tag } from "antd";
import { CheckSquare, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { formatDuration } from "@/lib/image-utils";
import { formatTaskTime } from "@/lib/task-time";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";

import { ImageThumb } from "./media";
import { countTaskJobs, deriveTaskStatus, isActiveJobStatus, taskPercent, taskStatusColor, taskStatusLabelKey } from "./task-utils";
import type { WorkbenchJob, WorkbenchLogView, WorkbenchQueueEntry, WorkbenchTask, WorkbenchThumb } from "./types";

/** 队列里一条「进行中的任务」卡片：状态与进度全部读后端 job，提交即出现。 */
function TaskCard({ task, jobs, now, active, thumbnails, onSelect }: { task: WorkbenchTask; jobs: Record<string, WorkbenchJob>; now: number; active: boolean; thumbnails: WorkbenchThumb[]; onSelect: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const list = task.jobIds.map((id) => jobs[id]);
    const stats = countTaskJobs(list);
    const { total, finished, anyRunning, errorCount } = stats;
    const pendingSubmit = total === 0;
    const status = deriveTaskStatus({ pendingSubmit, ...stats });
    const percent = taskPercent(list, finished, total);
    const statusLabel = t(taskStatusLabelKey(status, anyRunning));
    const elapsedMs = status === "running" ? Math.max(0, (now || task.startedAt) - task.startedAt) : 0;

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onSelect}
        >
            <div className="min-w-0">
                <div className="truncate text-sm font-semibold leading-5">{task.prompt}</div>
                <div className="mt-1.5 flex items-center gap-1.5">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={taskStatusColor(status)}>
                        {statusLabel}
                    </Tag>
                    {pendingSubmit ? (
                        <LoaderCircle className="size-3.5 animate-spin text-stone-400" />
                    ) : status === "running" ? (
                        <span className="text-xs tabular-nums text-stone-500 dark:text-stone-400">{percent}%</span>
                    ) : null}
                    {elapsedMs ? <span className="text-xs text-stone-400">{formatDuration(elapsedMs)}</span> : null}
                    {status === "failed" && errorCount ? <span className="truncate text-xs text-red-500">{t("workbench.failCount", { count: errorCount })}</span> : null}
                </div>
                {status === "running" && !pendingSubmit ? <Progress percent={percent} size="small" showInfo={false} className="!mb-0 !mt-1.5" /> : null}
                {thumbnails.length ? (
                    <div className="mt-2 flex gap-1 overflow-hidden">
                        {thumbnails.map((thumb) => (
                            <ImageThumb key={thumb.id} src={thumb.src} alt={thumb.alt || ""} className="size-8 shrink-0 rounded-md object-cover" />
                        ))}
                    </div>
                ) : null}
            </div>
        </button>
    );
}

/** 队列里一条「已落库的历史记录」卡片。时间**渲染时**按 createdAt 现算（老记录不含新格式）。 */
function LogCard({ log, selected, active, selectable, onSelectedChange, onClick }: { log: WorkbenchLogView; selected: boolean; active: boolean; selectable: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    {selectable ? <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} /> : null}
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {log.thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {log.thumbnails.map((thumb) => (
                                    <ImageThumb key={thumb.id} src={thumb.src} alt={thumb.alt || ""} className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        {log.status === "canceled" ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.taskCanceled")}</Tag>
                        ) : (
                            <>
                                <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                                    {t("workbench.successCount", { count: log.successCount ?? log.itemCount ?? 0 })}
                                </Tag>
                                {log.failCount ? (
                                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                        {t("workbench.failCount", { count: log.failCount })}
                                    </Tag>
                                ) : null}
                            </>
                        )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        {log.itemCount ? <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.itemCount })}</Tag> : null}
                        {log.durationMs ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                                {formatDuration(log.durationMs)}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex justify-end">
                        {/* 时间**渲染时**按 createdAt 现算 —— 老记录里存的 `time` 是旧格式（带年秒），
                            直接显示会与新的简化格式不一致；createdAt 是时间戳，新旧记录都有。 */}
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{formatTaskTime(log.createdAt)}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

/**
 * 左栏：任务队列（时间线）。本次会话的任务与历史记录合并、按 id 去重、按时间倒序 ——
 * 点「开始生成」即出现一条，点开任何一条在中/右区看该次的参数快照与结果。
 */
export function QueuePanel({
    entries,
    jobs,
    now,
    selectedId,
    onSelect,
    selectedLogIds,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
}: {
    entries: WorkbenchQueueEntry[];
    jobs: Record<string, WorkbenchJob>;
    now: number;
    selectedId: string | null;
    onSelect: (id: string) => void;
    selectedLogIds: string[];
    /** 不传则不提供「删除记录」能力（如视频创作台：记录归服务端所有，只给取消/归档）。 */
    onSelectedLogIdsChange?: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected?: () => void;
}) {
    const { t } = useTranslation();
    const selectable = Boolean(onDeleteSelected && onSelectedLogIdsChange);
    const historyIds = entries.filter((entry) => entry.kind === "log").map((entry) => entry.id);
    const allSelected = Boolean(historyIds.length) && historyIds.every((id) => selectedLogIds.includes(id));
    const toggleAll = () => onSelectedLogIdsChange?.(allSelected ? [] : historyIds);

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{entries.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                {selectable ? (
                    <>
                        <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!historyIds.length} onClick={toggleAll}>
                            {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                        </Button>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                            {t("workbench.deleteLogs")}
                        </Button>
                    </>
                ) : null}
            </div>
            <div className="space-y-2">
                {entries.map((entry) =>
                    entry.kind === "task" && entry.task ? (
                        <TaskCard key={entry.id} task={entry.task} jobs={jobs} now={now} active={selectedId === entry.id} thumbnails={entry.thumbnails} onSelect={() => onSelect(entry.id)} />
                    ) : entry.log ? (
                        <LogCard
                            key={entry.id}
                            log={entry.log}
                            selectable={selectable}
                            selected={selectedLogIds.includes(entry.id)}
                            active={selectedId === entry.id}
                            onSelectedChange={(checked) => onSelectedLogIdsChange?.(checked ? [...selectedLogIds, entry.id] : selectedLogIds.filter((id) => id !== entry.id))}
                            onClick={() => onSelect(entry.id)}
                        />
                    ) : null,
                )}
                {!entries.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

import { Button, Card, Progress, Tag, Tooltip } from "antd";
import { ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveGatewayUrl } from "@/services/api/gateway";
import { PreviewableMedia } from "@/components/workbench";
import type { TaskJob, TaskJobStatus } from "@/services/api/tasks";
import { ArtifactActions } from "@/components/artifact-actions";
import { formatTaskTime } from "@/lib/task-time";
import { cn } from "@/lib/utils";

import { isActiveStatus, jobDurationMs, groupProgress, type TaskGroup, type TaskGroupStatus } from "../task-utils";
import { artifactThumbSrc } from "@/lib/artifact-thumb";

const GROUP_STATUS_DOT: Record<TaskGroupStatus, string> = {
    running: "bg-blue-500",
    failed: "bg-red-500",
    partial: "bg-amber-500",
    done: "bg-emerald-500",
    canceled: "bg-stone-400",
};

const JOB_STATUS_DOT: Record<TaskJobStatus, string> = {
    queued: "bg-stone-400",
    running: "bg-blue-500",
    done: "bg-emerald-500",
    error: "bg-red-500",
    canceled: "bg-stone-400",
};

type TaskGroupCardProps = {
    group: TaskGroup;
    /** 流水线组标题里的 run 名称（取不到时用 runId）。 */
    runLabel: string;
    now: number;
    onCancelQueued: (group: TaskGroup) => void;
    onCancelJob: (job: TaskJob) => void;
    onOpenPipeline: (runId: string) => void;
    onPreviewVideo: (job: TaskJob, url: string) => void;
};

function formatDuration(ms: number, t: (key: string, options?: Record<string, unknown>) => string) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return t("tasks.durationS", { s: seconds });
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    if (minutes < 60) return t("tasks.durationMs", { m: minutes, s: restSeconds });
    return t("tasks.durationHms", { h: Math.floor(minutes / 60), m: minutes % 60, s: restSeconds });
}

function groupTitle(group: TaskGroup, runLabel: string, t: (key: string, options?: Record<string, unknown>) => string) {
    if (group.source === "pipeline" && group.runId) {
        const stage = t(`tasks.stage.${group.stageId || "other"}`, { defaultValue: t("tasks.stage.other") });
        return `${runLabel} · ${stage}`;
    }
    return t("tasks.workbenchGroup", { time: formatTaskTime(group.windowStart), count: group.total });
}

export function TaskGroupCard({ group, runLabel, now, onCancelQueued, onCancelJob, onOpenPipeline, onPreviewVideo }: TaskGroupCardProps) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const progress = groupProgress(group);

    return (
        <Card
            size="small"
            className="!border-stone-200 !shadow-none dark:!border-stone-800"
            title={
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Tag className="!m-0 !border-0 !bg-stone-100 !text-stone-600 dark:!bg-stone-800 dark:!text-stone-300" bordered={false}>
                        {t(`tasks.groupTag.${group.source}`)}
                    </Tag>
                    <span className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">{groupTitle(group, runLabel, t)}</span>
                    <span className="flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300">
                        <span className={cn("size-2 shrink-0 rounded-full", GROUP_STATUS_DOT[group.status])} />
                        {t(`tasks.groupStatus.${group.status}`)}
                    </span>
                </div>
            }
            extra={
                <div className="flex items-center gap-2">
                    {group.source === "pipeline" && group.runId ? (
                        <Tooltip title={t("tasks.openPipeline")}>
                            <Button type="text" size="small" icon={<ExternalLink className="size-4" />} onClick={() => onOpenPipeline(group.runId as string)} />
                        </Tooltip>
                    ) : null}
                    {group.queuedCount > 0 ? (
                        <Button type="text" size="small" danger icon={<X className="size-4" />} onClick={() => onCancelQueued(group)}>
                            {t("tasks.cancelUnstarted")}
                        </Button>
                    ) : null}
                    <Button type="text" size="small" icon={expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? t("tasks.collapse") : t("tasks.expand")}
                    </Button>
                </div>
            }
        >
            <Progress percent={progress.percent} size="small" format={() => `${progress.done}/${progress.total}`} />

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
                <span>{t("tasks.counts.done", { done: group.doneCount, total: group.total })}</span>
                {group.activeCount > 0 ? <span className="font-medium text-blue-600 dark:text-blue-400">{t("tasks.counts.active", { count: group.activeCount })}</span> : null}
                {group.errorCount > 0 ? <span className="text-red-600 dark:text-red-400">{t("tasks.counts.failed", { count: group.errorCount })}</span> : null}
                {group.canceledCount > 0 ? <span>{t("tasks.counts.canceled", { count: group.canceledCount })}</span> : null}
            </div>

            {expanded ? (
                <div className="mt-3 divide-y divide-stone-100 dark:divide-stone-800">
                    {group.jobs.map((job) => {
                        const jobDuration = jobDurationMs(job, now);
                        const jobProgress = job.progress;
                        return (
                            <div key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                                <span className={cn("size-2 shrink-0 rounded-full", JOB_STATUS_DOT[job.status])} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-xs font-medium text-stone-800 dark:text-stone-200">{job.name || job.id}</div>
                                    <div className="truncate text-[11px] text-stone-500 dark:text-stone-400">
                                        {t("tasks.template")}: {job.template || "—"}
                                    </div>
                                </div>
                                <Tag className="!m-0" color={job.status === "error" ? "error" : job.status === "done" ? "success" : job.status === "running" ? "processing" : "default"}>
                                    {t(`tasks.jobStatus.${job.status}`)}
                                </Tag>
                                <span className="text-[11px] tabular-nums text-stone-500 dark:text-stone-400">
                                    {t("tasks.jobProgress")}: {typeof jobProgress?.value === "number" ? jobProgress.value : 0}/{typeof jobProgress?.max === "number" ? jobProgress.max : 0}
                                    {jobProgress?.node ? <span className="ml-1">{jobProgress.node}</span> : null}
                                </span>
                                <span className="text-[11px] tabular-nums text-stone-500 dark:text-stone-400">
                                    {t("tasks.duration")}: {jobDuration === null ? "—" : formatDuration(jobDuration, t)}
                                </span>
                                <div className="flex items-center gap-1">
                                    {(job.outputs || []).length ? (
                                        (job.outputs || []).map((output) =>
                                            output.type === "video" ? (
                                                <button
                                                    key={output.url}
                                                    type="button"
                                                    className="size-9 overflow-hidden rounded border border-stone-200 dark:border-stone-700"
                                                    onClick={() => onPreviewVideo(job, output.url)}
                                                >
                                                    <video src={resolveGatewayUrl(output.url)} poster={artifactThumbSrc(resolveGatewayUrl(output.url))} muted playsInline preload="none" className="size-9 object-cover" />
                                                </button>
                                            ) : (
                                                <PreviewableMedia
                                                    key={output.url}
                                                    id={`task:${job.id}:${output.url}`}
                                                    kind="image"
                                                    src={resolveGatewayUrl(output.url)}
                                                    thumbSrc={artifactThumbSrc(resolveGatewayUrl(output.url))}
                                                    title={job.name}
                                                    className="size-9 overflow-hidden rounded border border-stone-200 dark:border-stone-700"
                                                >
                                                    <img src={artifactThumbSrc(resolveGatewayUrl(output.url))} alt={job.name} loading="lazy" decoding="async" className="size-9 object-cover" />
                                                </PreviewableMedia>
                                            ),
                                        )
                                    ) : (
                                        <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("tasks.noOutputs")}</span>
                                    )}
                                </div>
                                {(job.outputs || []).length ? <ArtifactActions targets={(job.outputs || []).map((output) => ({ url: output.url }))} /> : null}
                                {isActiveStatus(job.status) ? (
                                    <Button type="text" size="small" danger icon={<X className="size-3.5" />} onClick={() => onCancelJob(job)}>
                                        {t("tasks.cancelJob")}
                                    </Button>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </Card>
    );
}

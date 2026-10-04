import { App, Button, Empty, Input, Modal, Segmented, Select, Spin } from "antd";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";
import { cancelGatewayJob, resolveGatewayUrl } from "@/services/api/gateway";
import { MediaPreviewGroup } from "@/components/workbench";
import { listTaskJobs, listTaskRuns, type TaskJob } from "@/services/api/tasks";

import { TaskGroupCard } from "./components/task-group-card";
import { buildTaskGroups, filterTaskGroups, summarizeJobs, type TaskGroup, type TaskFilters, type TaskGroupStatus, type TaskKindFilter, type TaskScope, type TaskSourceFilter } from "./task-utils";

/**
 * 任务管理（/tasks）：只读现成 GET /api/jobs，把全量任务按批次聚合展示。
 * 顶部总览计数、按来源/类型/状态筛选、展开单条明细、取消（二次确认）。纯前端，不改后端。
 */
export default function TasksPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();

    const [jobs, setJobs] = useState<TaskJob[]>([]);
    const [runTitles, setRunTitles] = useState<Map<string, string>>(new Map());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [now, setNow] = useState(() => Date.now());
    const [scope, setScope] = useState<TaskScope>("recent");
    const [source, setSource] = useState<TaskSourceFilter>("all");
    const [kind, setKind] = useState<TaskKindFilter>("all");
    const [status, setStatus] = useState<TaskFilters["status"]>("all");
    const [videoPreview, setVideoPreview] = useState<{ job: TaskJob; url: string } | null>(null);

    const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        try {
            const [jobList, runList] = await Promise.all([listTaskJobs(), listTaskRuns().catch(() => [])]);
            setJobs(jobList);
            setRunTitles(new Map(runList.map((run) => [run.id, run.title || run.id])));
            setError("");
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            if (!silent) setLoading(false);
            setNow(Date.now());
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // 有排队/运行中的任务时每 5 秒刷新一次，全部结束即停。
    useEffect(() => {
        if (!jobs.some((job) => job.status === "running" || job.status === "queued")) return;
        const timer = window.setInterval(() => void load(true), 5000);
        return () => window.clearInterval(timer);
    }, [jobs, load]);

    const overview = useMemo(() => summarizeJobs(jobs), [jobs]);
    const groups = useMemo(() => buildTaskGroups(jobs), [jobs]);
    const visibleGroups = useMemo(() => filterTaskGroups(groups, { scope, source, kind, status }, now), [groups, scope, source, kind, status, now]);

    const cancelQueued = (group: TaskGroup) => {
        const targets = group.jobs.filter((job) => job.status === "queued");
        if (!targets.length) return;
        modal.confirm({
            title: t("tasks.cancelQueuedTitle"),
            content: t("tasks.cancelQueuedBody", { count: targets.length, active: group.activeCount }),
            okText: t("tasks.cancelUnstarted"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: async () => {
                const results = await Promise.all(targets.map((job) => cancelGatewayJob(job.id).then(() => true).catch(() => false)));
                const failed = results.filter((ok) => !ok).length;
                if (failed) message.error(t("tasks.cancelFailed"));
                else message.success(t("tasks.cancelDone", { count: targets.length }));
                await load(true);
            },
        });
    };

    const cancelJob = (job: TaskJob) => {
        const running = job.status === "running";
        modal.confirm({
            title: running ? t("tasks.cancelRunningTitle") : t("tasks.cancelSingleTitle"),
            content: running ? t("tasks.cancelRunningBody") : t("tasks.cancelSingleBody"),
            okText: t("tasks.cancelConfirm"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    await cancelGatewayJob(job.id);
                    message.success(t("tasks.cancelDone", { count: 1 }));
                } catch {
                    message.error(t("tasks.cancelFailed"));
                }
                await load(true);
            },
        });
    };

    const openPipeline = () => navigate("/pipeline");

    const overviewCards = [
        { key: "running", value: overview.running, accent: "text-blue-600 dark:text-blue-400" },
        { key: "done", value: overview.done, accent: "text-emerald-600 dark:text-emerald-400" },
        { key: "failed", value: overview.error, accent: "text-red-600 dark:text-red-400" },
    ];

    return (
        <div className="h-full overflow-y-auto bg-background text-stone-800 dark:text-stone-100">
            <div className="w-full px-6 py-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("tasks.title")}</h1>
                    <Button icon={<RefreshCw className={cn("size-4", loading && "animate-spin")} />} onClick={() => void load()} disabled={loading}>
                        {t("tasks.refresh")}
                    </Button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3">
                    {overviewCards.map((card) => (
                        <div key={card.key} className="rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                            <div className={cn("text-2xl font-semibold tabular-nums", card.accent)}>{card.value}</div>
                            <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{t(`tasks.overview.${card.key}`)}</div>
                        </div>
                    ))}
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Segmented
                        value={scope}
                        onChange={(value) => setScope(value as TaskScope)}
                        options={[
                            { value: "recent", label: t("tasks.scope.recent") },
                            { value: "all", label: t("tasks.scope.all") },
                        ]}
                    />
                    <Select
                        value={source}
                        onChange={setSource}
                        className="min-w-[150px]"
                        options={[
                            { value: "all", label: t("tasks.source.all") },
                            { value: "pipeline", label: t("tasks.source.pipeline") },
                            { value: "workbench", label: t("tasks.source.workbench") },
                        ]}
                    />
                    <Select
                        value={kind}
                        onChange={setKind}
                        className="min-w-[130px]"
                        options={[
                            { value: "all", label: t("tasks.type.all") },
                            { value: "image", label: t("tasks.type.image") },
                            { value: "video", label: t("tasks.type.video") },
                        ]}
                    />
                    <Select
                        value={status}
                        onChange={setStatus}
                        className="min-w-[140px]"
                        options={[
                            { value: "all", label: t("tasks.status.all") },
                            ...(["running", "failed", "partial", "done", "canceled"] as TaskGroupStatus[]).map((value) => ({ value, label: t(`tasks.groupStatus.${value}`) })),
                        ]}
                    />
                </div>

                <div className="mt-5">
                    {loading && !jobs.length ? (
                        <div className="flex justify-center py-24">
                            <Spin />
                        </div>
                    ) : error && !jobs.length ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-24" description={t("tasks.loadFailed")} />
                    ) : visibleGroups.length ? (
                        <MediaPreviewGroup>
                            <div className="space-y-3">
                                {visibleGroups.map((group) => (
                                    <TaskGroupCard
                                        key={group.key}
                                        group={group}
                                        runLabel={(group.runId && runTitles.get(group.runId)) || group.runId || ""}
                                        now={now}
                                        onCancelQueued={cancelQueued}
                                        onCancelJob={cancelJob}
                                        onOpenPipeline={openPipeline}
                                        onPreviewVideo={(job, url) => setVideoPreview({ job, url })}
                                    />
                                ))}
                            </div>
                        </MediaPreviewGroup>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-24" description={jobs.length ? t("tasks.emptyFiltered") : t("tasks.empty")} />
                    )}
                </div>
            </div>

            <Modal open={Boolean(videoPreview)} title={videoPreview?.job.name || undefined} footer={null} width={960} destroyOnHidden onCancel={() => setVideoPreview(null)}>
                {videoPreview?.url ? <video src={resolveGatewayUrl(videoPreview.url)} controls autoPlay className="mt-2 w-full rounded-lg bg-black" /> : null}
            </Modal>
        </div>
    );
}

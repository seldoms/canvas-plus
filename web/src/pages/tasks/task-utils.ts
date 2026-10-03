import type { TaskJob, TaskJobStatus } from "@/services/api/tasks";

/**
 * 任务管理页的纯数据整理：分组、状态推导、进度与耗时计算、筛选。
 * 不含 i18n / 不含请求，供 index.tsx 与 components/ 直接调用。
 */

export type TaskSource = "pipeline" | "workbench";
export type TaskGroupStatus = "running" | "failed" | "partial" | "done" | "canceled";

/** 工作台任务按相邻提交时间窗口聚合：同一窗口内（默认 2 分钟）归为一批。 */
export const WORKBENCH_WINDOW_MS = 2 * 60 * 1000;
/** 「最近」的判定窗口：24 小时内有更新。 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 流水线 job id 形如 run-<runId 第 2/3 段>-... ; runId 本身形如 run-murvf1vq-aqyqm。 */
const RUN_ID_RE = /^(run-[^-]+-[^-]+)/;

export type TaskGroup = {
    key: string;
    source: TaskSource;
    runId?: string;
    stageId?: string;
    /** 工作台组的时间范围（ISO）。 */
    windowStart?: string;
    windowEnd?: string;
    jobs: TaskJob[];
    total: number;
    doneCount: number;
    queuedCount: number;
    runningCount: number;
    activeCount: number;
    errorCount: number;
    canceledCount: number;
    status: TaskGroupStatus;
    latestAt: number;
};

export type TaskGroupExtra = Pick<TaskGroup, "runId" | "stageId" | "windowStart" | "windowEnd">;

export function isPipelineJob(job: TaskJob): boolean {
    return job.id.startsWith("run-");
}

export function isActiveStatus(status: TaskJobStatus): boolean {
    return status === "running" || status === "queued";
}

export function jobRunId(job: TaskJob): string {
    const metaRun = typeof job.meta?.runId === "string" ? job.meta.runId : "";
    if (metaRun) return metaRun;
    const match = RUN_ID_RE.exec(job.id);
    return match ? match[1] : job.id;
}

export function jobStageId(job: TaskJob): string {
    const metaStage = typeof job.meta?.stageId === "string" ? job.meta.stageId : "";
    if (metaStage) return metaStage;
    return /(^|-)clip(-|$)/.test(job.id) ? "assembly" : "keyframe";
}

export function jobTime(job: TaskJob): number {
    const raw = job.createdAt || job.updatedAt || "";
    const value = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(value) ? value : 0;
}

/** 单条耗时：优先 startedAt→finishedAt，运行中按当前时间计，未开始返回 null。 */
export function jobDurationMs(job: TaskJob, now: number = Date.now()): number | null {
    const startRaw = job.startedAt || job.createdAt || "";
    const start = startRaw ? Date.parse(startRaw) : NaN;
    if (!Number.isFinite(start)) return null;
    const endRaw = job.finishedAt || (isActiveStatus(job.status) ? "" : job.updatedAt || "");
    const end = endRaw ? Date.parse(endRaw) : now;
    if (!Number.isFinite(end) || end < start) return null;
    return end - start;
}

/** 组状态由组内 job 状态推导。 */
export function deriveGroupStatus(jobs: TaskJob[]): TaskGroupStatus {
    let active = 0;
    let error = 0;
    let canceled = 0;
    let done = 0;
    for (const job of jobs) {
        if (isActiveStatus(job.status)) active += 1;
        else if (job.status === "error") error += 1;
        else if (job.status === "canceled") canceled += 1;
        else if (job.status === "done") done += 1;
    }
    if (active > 0) return "running";
    if (error > 0) return "failed";
    if (canceled > 0 && done > 0) return "partial";
    if (canceled > 0) return "canceled";
    if (jobs.length > 0 && done === jobs.length) return "done";
    return "partial";
}

function makeGroup(key: string, source: TaskSource, jobs: TaskJob[], extra: TaskGroupExtra): TaskGroup {
    const count = (status: TaskJobStatus) => jobs.filter((job) => job.status === status).length;
    const doneCount = count("done");
    const queuedCount = count("queued");
    const runningCount = count("running");
    const errorCount = count("error");
    const canceledCount = count("canceled");
    const latestAt = jobs.reduce((max, job) => Math.max(max, jobTime(job)), 0);
    return {
        key,
        source,
        jobs,
        total: jobs.length,
        doneCount,
        queuedCount,
        runningCount,
        activeCount: queuedCount + runningCount,
        errorCount,
        canceledCount,
        status: deriveGroupStatus(jobs),
        latestAt,
        ...extra,
    };
}

/** 把全量 job 分成「流水线组（runId+stage）」与「工作台组（相邻时间窗口）」。 */
export function buildTaskGroups(jobs: TaskJob[], windowMs: number = WORKBENCH_WINDOW_MS): TaskGroup[] {
    const groups: TaskGroup[] = [];

    const byRunStage = new Map<string, TaskJob[]>();
    for (const job of jobs) {
        if (!isPipelineJob(job)) continue;
        const runId = jobRunId(job);
        const stageId = jobStageId(job);
        const key = `${runId}::${stageId}`;
        const list = byRunStage.get(key);
        if (list) list.push(job);
        else byRunStage.set(key, [job]);
    }
    for (const [key, list] of byRunStage) {
        const [runId, stageId] = key.split("::");
        groups.push(makeGroup(key, "pipeline", list, { runId, stageId }));
    }

    const workbench = jobs.filter((job) => !isPipelineJob(job)).sort((a, b) => jobTime(a) - jobTime(b));
    let bucket: TaskJob[] = [];
    let lastTime = 0;
    const flush = () => {
        if (!bucket.length) return;
        const first = bucket[0];
        const last = bucket[bucket.length - 1];
        groups.push(makeGroup(`workbench::${jobTime(first)}`, "workbench", bucket, { windowStart: first.createdAt, windowEnd: last.createdAt }));
        bucket = [];
    };
    for (const job of workbench) {
        const time = jobTime(job);
        if (bucket.length && time - lastTime > windowMs) flush();
        bucket.push(job);
        lastTime = time;
    }
    flush();

    for (const group of groups) group.jobs.sort((a, b) => jobTime(b) - jobTime(a));
    groups.sort((a, b) => {
        const aActive = a.activeCount > 0 ? 1 : 0;
        const bActive = b.activeCount > 0 ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.latestAt - a.latestAt;
    });
    return groups;
}

export type TaskScope = "recent" | "all";
export type TaskStatusFilter = "all" | TaskGroupStatus;
export type TaskKindFilter = "all" | "image" | "video";
export type TaskSourceFilter = "all" | TaskSource;

export type TaskFilters = {
    scope: TaskScope;
    source: TaskSourceFilter;
    kind: TaskKindFilter;
    status: TaskStatusFilter;
};

export function filterTaskGroups(groups: TaskGroup[], filters: TaskFilters, now: number = Date.now()): TaskGroup[] {
    const result: TaskGroup[] = [];
    for (const group of groups) {
        if (filters.source !== "all" && group.source !== filters.source) continue;
        if (filters.status !== "all" && group.status !== filters.status) continue;
        if (filters.scope === "recent" && group.activeCount === 0 && now - group.latestAt > RECENT_WINDOW_MS) continue;
        if (filters.kind === "all") {
            result.push(group);
            continue;
        }
        const jobs = group.jobs.filter((job) => job.kind === filters.kind);
        if (!jobs.length) continue;
        const { key, source, runId, stageId, windowStart, windowEnd } = group;
        result.push(makeGroup(key, source, jobs, { runId, stageId, windowStart, windowEnd }));
    }
    return result;
}

export type TaskOverview = {
    running: number;
    done: number;
    error: number;
    canceled: number;
    total: number;
};

/** 顶部总览计数：进行中 = 排队中 + 生成中。 */
export function summarizeJobs(jobs: TaskJob[]): TaskOverview {
    const overview: TaskOverview = { running: 0, done: 0, error: 0, canceled: 0, total: jobs.length };
    for (const job of jobs) {
        if (isActiveStatus(job.status)) overview.running += 1;
        else if (job.status === "done") overview.done += 1;
        else if (job.status === "error") overview.error += 1;
        else if (job.status === "canceled") overview.canceled += 1;
    }
    return overview;
}

export function groupProgress(group: TaskGroup): { done: number; total: number; percent: number } {
    const percent = group.total ? Math.round((group.doneCount / group.total) * 100) : 0;
    return { done: group.doneCount, total: group.total, percent };
}

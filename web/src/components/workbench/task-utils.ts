/**
 * 工作台队列的纯逻辑（生图 / 视频共用）：状态推导、进度口径、队列时间线合并。
 *
 * 全部只读后端事实（job.status / job.progress / job.outputs），不自己造槽位状态。
 * 抽成纯函数便于两条工作台共用同一口径，也便于单独验证。
 */
import { clampLikeHook } from "./progress-clamp";
import type { WorkbenchJob, WorkbenchJobProgress, WorkbenchLogView, WorkbenchQueueEntry, WorkbenchTask, WorkbenchTaskStatus, WorkbenchThumb } from "./types";

/** 未结束状态（含未知，未知视为待确认 → 继续轮询）。 */
export function isActiveJobStatus(status?: string): boolean {
    return status === "queued" || status === "running" || status === undefined;
}

/** 单个 job 的耗时（后端 startedAt→finishedAt）；拿不到时间返回 0。 */
export function jobDurationMs(job: WorkbenchJob): number {
    const start = job.startedAt ? Date.parse(job.startedAt) : NaN;
    const end = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
}

/** 组内各状态计数。 */
export function countTaskJobs(list: Array<WorkbenchJob | undefined>) {
    const total = list.length;
    const finished = list.filter((job) => job && !isActiveJobStatus(job.status)).length;
    const anyRunning = list.some((job) => job?.status === "running");
    const hasActive = list.some((job) => isActiveJobStatus(job?.status));
    const doneCount = list.filter((job) => job?.status === "done").length;
    const errorCount = list.filter((job) => job?.status === "error").length;
    const canceledCount = list.filter((job) => job?.status === "canceled").length;
    return { total, finished, anyRunning, hasActive, doneCount, errorCount, canceledCount };
}

/**
 * 任务组状态：提交中 > 进行中 > 全取消 > 全失败 > 部分成功 > 完成。
 * 完成与否只认后端 status。
 */
export function deriveTaskStatus({ pendingSubmit, hasActive, doneCount, errorCount, canceledCount }: { pendingSubmit: boolean; hasActive: boolean; doneCount: number; errorCount: number; canceledCount: number }): WorkbenchTaskStatus {
    if (pendingSubmit || hasActive) return "running";
    if (doneCount === 0 && errorCount === 0 && canceledCount > 0) return "canceled";
    if (doneCount === 0 && errorCount > 0) return "failed";
    if (doneCount > 0 && (errorCount > 0 || canceledCount > 0)) return "partial";
    return "done";
}

/**
 * 单个 job 的进度百分比，取值0–100。
 *
 * ## 为什么要有这个函数，而不是各处直接 `value / max * 100`
 *   后端已把ComfyUI 的「累计字典」口径修成单调不回退，但前端仍不能裸算：
 *   - 轮询是**跨请求**的，可能读到修复上线前写下的旧 job 记录（progress{1,1} → 0/0 → …），
 *     也有后端某次覆盖导致的一次回落；
 *   - 进度条往回走会让用户以为界面坏了，比显示得不准更糟。
 *   所以这里是**最后一道防线**：只接受不低于历史值的比例。
 *
 * @param progress 后端 progress { value, max, node }
 * @param previousPercent 上一次渲染出的百分比；无则传 0
 * @returns 0–100 的整数；没有可用max 时返回 -1，表示「后端没给真实进度」
 */
export function jobProgressPercent(progress: WorkbenchJobProgress | undefined, previousPercent = 0): number {
    const floor = Number.isFinite(previousPercent) ? Math.max(0, previousPercent) : 0;
    const supplied = Number(progress?.percent);
    // 优先用后端下发的单调百分比 —— 它已经按「分母会增长」的教训钳制过。
    if (Number.isFinite(supplied) && supplied >= 0) {
        return clampLikeHook(Math.min(100, supplied), floor);
    }
    // 后端没给（如修复上线前的旧 job 记录）才退回本地计算，并同样钳制。
    const max = Number(progress?.max) || 0;
    if (max <= 0) return -1; // 没有真实分母 → 如实说没有，不画一条 0% 的假进度
    return clampLikeHook(Math.round((Math.min(Number(progress?.value) || 0, max) / max) * 100), floor);
}

/** 组进度：单条任务优先用后端 progress 的真实比例；多条任务退回「已完成/总数」。 */
export function taskPercent(list: Array<WorkbenchJob | undefined>, finished: number, total: number, previousPercent = 0): number {
    const single = total === 1 ? list[0] : undefined;
    if (single) {
        const percent = jobProgressPercent(single.progress, previousPercent);
        if (percent >= 0) return percent;
    }
    return total ? Math.max(Math.round((finished / total) * 100), previousPercent || 0) : 0;
}

/** 状态标签的 i18n key。 */
export function taskStatusLabelKey(status: WorkbenchTaskStatus, anyRunning: boolean): string {
    if (status === "running") return anyRunning ? "workbench.taskRunning" : "workbench.taskQueued";
    if (status === "done") return "workbench.taskDone";
    if (status === "partial") return "workbench.taskPartial";
    if (status === "canceled") return "workbench.taskCanceled";
    return "workbench.taskFailed";
}

export function taskStatusColor(status: WorkbenchTaskStatus): string {
    return status === "running" ? "blue" : status === "done" ? "green" : status === "partial" ? "orange" : status === "canceled" ? "default" : "red";
}

/**
 * 队列时间线：本次会话的任务 ∪ 历史记录，按 id 去重、按时间倒序。
 * 同一 id（任务完成后落成记录）只保留先出现的任务条目（携带实时状态）。
 */
export function buildQueueEntries({
    tasks,
    logs,
    jobs,
    taskThumbnails,
}: {
    tasks: WorkbenchTask[];
    logs: WorkbenchLogView[];
    jobs: Record<string, WorkbenchJob>;
    taskThumbnails: (task: WorkbenchTask, jobs: Record<string, WorkbenchJob>) => WorkbenchThumb[];
}): WorkbenchQueueEntry[] {
    const seen = new Set<string>();
    const entries: WorkbenchQueueEntry[] = [];
    for (const task of tasks) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        entries.push({ id: task.id, kind: "task", createdAt: Date.parse(task.createdAt) || task.startedAt, task, thumbnails: taskThumbnails(task, jobs) });
    }
    for (const log of logs) {
        if (seen.has(log.id)) continue;
        seen.add(log.id);
        entries.push({ id: log.id, kind: "log", createdAt: log.createdAt, log, thumbnails: log.thumbnails });
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return entries;
}

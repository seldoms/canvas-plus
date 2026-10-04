/**
 * 工作台（生图 / 视频）共享队列的类型。
 *
 * 生图工作台与视频创作台共用同一套「任务队列 + 参数快照 + 取消/归档」策略，
 * 队列组件与状态推导都是共享件，页面只负责组装数据与渲染各自的结果形态。
 * 这里定义两边都认的**最小事实形状**：后端 job、提交任务、队列条目、历史记录视图。
 */
import type { ReferenceImage } from "@/types/image";

/** 后端任务状态（GET /api/jobs 的 job.status）。 */
export type WorkbenchJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type WorkbenchJobOutput = {
    filename?: string;
    url: string;
    type?: string;
    bytes?: number;
    width?: number;
    height?: number;
};

export type WorkbenchJobProgress = {
    value?: number;
    max?: number;
    node?: string;
};

/** 后端任务（生图/视频同构；状态与进度是唯一事实源，前端不自己算槽位）。 */
export type WorkbenchJob = {
    id: string;
    kind?: string;
    backend?: string;
    template?: string;
    name?: string;
    status: WorkbenchJobStatus;
    progress?: WorkbenchJobProgress;
    outputs?: WorkbenchJobOutput[];
    params?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    error?: string;
    createdAt?: string;
    updatedAt?: string;
    startedAt?: string;
    finishedAt?: string;
};

/** 任务组状态（由组内 job 推导）。 */
export type WorkbenchTaskStatus = "running" | "done" | "partial" | "failed" | "canceled";

/** 一次提交拆成 N 个服务端 job；jobIds 是唯一事实源。 */
export type WorkbenchTask = {
    id: string;
    prompt: string;
    count: number;
    template: string;
    jobIds: string[];
    startedAt: number;
    createdAt: string;
    /** 提交中占位：已落记录但还没拿到 jobIds。 */
    pending?: boolean;
};

/** 队列/记录里的小缩略图（取不到 src 时共享组件给图标占位，不渲染破图）。 */
export type WorkbenchThumb = { id: string; src?: string; alt?: string };

/** 参数快照里的一个标签（值 + 可选颜色），值来自历史事实，与当前表单隔离。 */
export type WorkbenchSnapshotTag = { key?: string; label: string; color?: string };

/** 历史记录视图：队列右列渲染只需要这些字段（页面负责从各自的记录形状映射）。 */
export type WorkbenchLogView = {
    id: string;
    createdAt: number;
    title: string;
    status: "success" | "failed" | "canceled";
    durationMs?: number;
    successCount?: number;
    failCount?: number;
    itemCount?: number;
    thumbnails: WorkbenchThumb[];
};

/** 队列里的一条：本次会话的任务，或一条历史记录（按 id 去重、按时间倒序 = 时间线）。 */
export type WorkbenchQueueEntry = {
    id: string;
    kind: "task" | "log";
    createdAt: number;
    task?: WorkbenchTask;
    log?: WorkbenchLogView;
    /** 任务条目的缩略图（历史记录的缩略图在 log.thumbnails 上）。 */
    thumbnails: WorkbenchThumb[];
};

/** 参数快照面板的数据（提示词 + 标签 + 参考图），生图/视频共用。 */
export type WorkbenchSnapshot = {
    prompt: string;
    tags: WorkbenchSnapshotTag[];
    references: ReferenceImage[];
};

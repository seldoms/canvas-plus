import axios from "axios";

import { gatewayBaseUrl } from "./gateway";

/**
 * 任务管理页（/tasks）数据源：只读现成接口，不新增后端契约。
 * - GET /api/jobs → 全量任务（含分组用的 meta.runId / meta.stageId / meta.itemId）
 * - GET /api/pipeline/runs → 流水线 run 摘要，用于分组标题
 * 取消复用 gateway.ts 既有的 cancelGatewayJob，本文件保持只读。
 */

export type TaskJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type TaskJobOutput = {
    filename?: string;
    url: string;
    type: string;
    bytes?: number;
};

export type TaskJobMeta = {
    runId?: string;
    stageId?: string;
    itemId?: string;
    promptWarning?: string;
    [key: string]: unknown;
};

export type TaskJobProgress = {
    value?: number;
    max?: number;
    node?: string;
};

export type TaskJob = {
    id: string;
    kind: string;
    backend?: string;
    template?: string;
    name?: string;
    status: TaskJobStatus;
    meta?: TaskJobMeta;
    outputs?: TaskJobOutput[];
    params?: Record<string, unknown>;
    progress?: TaskJobProgress;
    promptId?: string;
    createdAt?: string;
    updatedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
};

/** GET /api/pipeline/runs 的元素（只取标题与所属项目）。 */
export type TaskRunSummary = {
    id: string;
    title: string;
    projectId?: string;
};

async function taskRequest<T>(url: string): Promise<T> {
    try {
        const response = await axios.request<T>({ method: "get", url, baseURL: gatewayBaseUrl(), timeout: 20000 });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) throw new Error(error.response ? `HTTP ${error.response.status}` : "unreachable");
        throw error instanceof Error ? error : new Error(String(error));
    }
}

/** GET /api/jobs → 全量任务列表。 */
export async function listTaskJobs(): Promise<TaskJob[]> {
    const data = await taskRequest<{ jobs?: TaskJob[] }>("/api/jobs");
    return Array.isArray(data?.jobs) ? data.jobs : [];
}

/** GET /api/pipeline/runs → run 摘要（标题 / 项目）。 */
export async function listTaskRuns(): Promise<TaskRunSummary[]> {
    const data = await taskRequest<{ runs?: Array<{ id?: unknown; title?: unknown; options?: { projectId?: unknown } | null }> }>("/api/pipeline/runs");
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    return runs
        .filter((run) => typeof run?.id === "string" && run.id)
        .map((run) => ({
            id: String(run.id),
            title: typeof run.title === "string" ? run.title : "",
            projectId: typeof run.options?.projectId === "string" ? run.options.projectId : undefined,
        }));
}

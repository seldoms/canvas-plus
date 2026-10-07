import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { gatewayBaseUrl } from "./gateway";

/**
 * 生图工作台服务端队列客户端（POST /api/images/enqueue + GET /api/jobs）。
 *
 * 工作台不再浏览器直连模型：提交交给服务端入队，任务状态/进度一律从 GET /api/jobs 读后端，
 * 刷新/切页/重开后按 jobId 恢复，不再依赖页面内存。
 */

export type ImageJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type ImageJobOutput = {
    filename?: string;
    url: string;
    type?: string;
    bytes?: number;
    width?: number;
    height?: number;
};

export type ImageJobProgress = {
    value?: number;
    max?: number;
    node?: string;
};

export type ImageJob = {
    id: string;
    kind?: string;
    backend?: string;
    template?: string;
    name?: string;
    status: ImageJobStatus;
    progress?: ImageJobProgress;
    outputs?: ImageJobOutput[];
    params?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    error?: string;
    createdAt?: string;
    updatedAt?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type ImageEnqueueBody = {
    template: string;
    prompt: string;
    count?: number;
    size?: string;
    references?: Array<{ url: string }>;
    seed?: number;
    /**
     * 生成归因（P2-B4）：五元组齐全时任务终态自动投影为项目槽位候选。
     * 服务端口径与 /api/generate/* 一致（contextFromBody）；**不要传 runId/stageId**，
     * 那会让服务端跳过画布投影分支。
     */
    projectId?: string;
    episodeId?: string;
    sceneId?: string;
    shotId?: string;
    slotId?: string;
};

export type ImageEnqueueResult = { jobs: Array<{ id: string; status: ImageJobStatus; template: string }> };

export type ImageJobQuery = {
    kind?: string;
    /** 逗号分隔的多状态，如 "queued,running"。 */
    status?: string;
    limit?: number;
    since?: string;
};

/** 未结束状态（含未知，未知视为待确认 → 继续轮询）。 */
export function isActiveJobStatus(status?: ImageJobStatus): boolean {
    return status === "queued" || status === "running" || status === undefined;
}

async function imageJobRequest<T>(config: AxiosRequestConfig): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl() });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status ?? 0;
            const payload = error.response?.data as { error?: { message?: string } } | undefined;
            if (payload?.error?.message) throw new Error(i18n.t("gateway.failed", { message: payload.error.message }));
            if (error.response) throw new Error(i18n.t("gateway.httpFailed", { status }));
            throw new Error(i18n.t("gateway.unreachable"));
        }
        throw error instanceof Error ? error : new Error(i18n.t("gateway.unreachable"));
    }
}

/** POST /api/images/enqueue：一次提交入队 count 个 kind=image 任务，返回 jobIds。 */
export async function enqueueImages(body: ImageEnqueueBody, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ImageEnqueueResult> {
    const data = await imageJobRequest<{ jobs?: ImageEnqueueResult["jobs"] }>({
        method: "post",
        url: "/api/images/enqueue",
        data: body,
        signal: options?.signal,
        // 后端入队前会用 DeepSeek 编译提示词，给足上界；编译器慢/不可用时后端自己降级，不会挂死。
        timeout: options?.timeoutMs ?? 180_000,
    });
    if (!Array.isArray(data?.jobs)) throw new Error(i18n.t("gateway.unreachable"));
    return { jobs: data.jobs };
}

/** GET /api/jobs（可选 kind/status/limit/since）：工作台任务轮询与恢复的唯一读源。 */
export async function listImageJobs(query: ImageJobQuery = {}): Promise<ImageJob[]> {
    const data = await imageJobRequest<{ jobs?: ImageJob[] }>({
        method: "get",
        url: "/api/jobs",
        params: {
            kind: query.kind,
            status: query.status,
            limit: query.limit,
            since: query.since,
        },
        timeout: 20_000,
    });
    return Array.isArray(data?.jobs) ? data.jobs : [];
}

/** GET /api/jobs/:id：单条任务详情（终态产物靠它补齐）。 */
export async function getImageJob(id: string): Promise<ImageJob> {
    const data = await imageJobRequest<{ job?: ImageJob }>({ method: "get", url: `/api/jobs/${encodeURIComponent(id)}`, timeout: 20_000 });
    if (!data?.job) throw new Error(i18n.t("gateway.unreachable"));
    return data.job;
}

/** POST /api/jobs/:id/cancel：取消单个任务。 */
export async function cancelImageJob(id: string): Promise<ImageJob> {
    const data = await imageJobRequest<{ job?: ImageJob }>({ method: "post", url: `/api/jobs/${encodeURIComponent(id)}/cancel`, timeout: 20_000 });
    if (!data?.job) throw new Error(i18n.t("gateway.unreachable"));
    return data.job;
}

import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";

import { gatewayBaseUrl } from "./gateway";
import { cancelImageJob, getImageJob, listImageJobs, type ImageJob, type ImageJobQuery } from "./image-jobs";

/**
 * 视频创作台的服务端队列客户端。
 *
 * 与生图工作台同构：提交交给服务端入队（`POST /api/generate/video`），任务状态/进度全部从
 * `GET /api/jobs` 读后端；**提交时把参数快照写进 job.meta** → 记录天然持久化在服务端（jobs.json），
 * 刷新/切页/换设备都能按 kind=video 重建成队列与历史，不再只活在浏览器里。
 *
 * `/api/generate/video` 是网关既有的冻结契约（{ template, name, params, meta } → { job }），
 * 走的是同一条本地 GPU 串行队列，产物落在 `/api/artifacts/<jobId>/<file>`。
 */

export type VideoEnqueueBody = {
    template: string;
    name?: string;
    params: Record<string, unknown>;
    meta?: Record<string, unknown>;
};

async function videoJobRequest<T>(config: AxiosRequestConfig): Promise<T> {
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

/** POST /api/generate/video：入队一个 kind=video 任务，返回后端 job。 */
export async function enqueueVideoJob(body: VideoEnqueueBody): Promise<ImageJob> {
    const data = await videoJobRequest<{ job?: ImageJob }>({ method: "post", url: "/api/generate/video", data: body, timeout: 30_000 });
    if (!data?.job?.id) throw new Error(i18n.t("gateway.unreachable"));
    return data.job;
}

/** 视频任务读源（与生图共用同一套 GET /api/jobs 客户端，只是固定 kind=video）。 */
export const listVideoJobs = (query: Omit<ImageJobQuery, "kind"> = {}): Promise<ImageJob[]> => listImageJobs({ ...query, kind: "video" });
export const getVideoJob = getImageJob;
export const cancelVideoJob = cancelImageJob;

export type { ImageJob as VideoJob } from "./image-jobs";

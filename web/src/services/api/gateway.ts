import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { DEFAULT_GATEWAY_URL, normalizeGatewayUrl, useConfigStore } from "@/stores/use-config-store";

export { DEFAULT_GATEWAY_URL };

export type GatewayArtifact = {
    filename: string;
    url: string;
    type: "image" | "video" | "audio" | "file";
    width?: number;
    height?: number;
    bytes?: number;
};

export type GatewayJobKind = "image" | "video" | "upscale" | "edit";
export type GatewayJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type GatewayJob = {
    id: string;
    kind: GatewayJobKind;
    template: string;
    name: string;
    params: Record<string, unknown>;
    status: GatewayJobStatus;
    promptId?: string;
    progress?: { value: number; max: number; node?: string };
    outputs: GatewayArtifact[];
    error?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
};

export type GatewayHealth = {
    ok: boolean;
    llm: { ok: boolean; baseUrl: string; error?: string };
    comfy: { ok: boolean; baseUrl: string; error?: string };
    queue: { running: number; pending: number };
};

export type GatewayTemplateInfo = { name: string; family: "image" | "video" | "upscale" | "edit"; title: string; tokens: string[] };

export type GatewayProviders = {
    llm: { models: string[] };
    comfy: { templates: GatewayTemplateInfo[]; models: { checkpoints: string[]; loras: string[]; vae: string[] } };
};

/** `/api/skills` 目前返回 skills 目录信息或流水线阶段信息，两种形状都兼容。 */
export type GatewaySkillInfo = { id: string; name?: string; title?: string; description?: string; path?: string; skill?: string; requires?: string[]; produces?: string[] };
export type GatewayStageInfo = { id: string; title: string; skill: string; requires: string[]; produces: string[] };

export type GatewayStageStatus = "pending" | "running" | "done" | "error";

export type GatewayRunStage = {
    id: string;
    title: string;
    status: GatewayStageStatus;
    inputs: Record<string, unknown>;
    output: unknown;
    artifacts: GatewayArtifact[];
    error?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type GatewayPipelineRun = {
    id: string;
    title: string;
    novel: string;
    createdAt: string;
    updatedAt: string;
    stages: Record<string, GatewayRunStage>;
};

export type GatewayGenerateBody = { template: string; params: Record<string, unknown>; name?: string };
export type GatewayStageInputPatch = { inputs?: Record<string, unknown>; output?: unknown };

/** 网关地址以配置里的「本地网关地址」为准，显式传参时优先。 */
export function gatewayBaseUrl(baseUrl?: string) {
    return normalizeGatewayUrl(baseUrl || useConfigStore.getState().config.gatewayUrl) || DEFAULT_GATEWAY_URL;
}

/** 网关产物 URL 默认是相对路径（`/api/artifacts/...`），补全后才能直接喂给 <img> / <video>。 */
export function resolveGatewayUrl(url: string, baseUrl?: string) {
    if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
    return `${gatewayBaseUrl(baseUrl)}${url.startsWith("/") ? url : `/${url}`}`;
}

async function gatewayRequest<T>(config: AxiosRequestConfig, baseUrl?: string): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl(baseUrl) });
        return response.data;
    } catch (error) {
        if (axios.isCancel(error)) throw error;
        throw new Error(gatewayErrorMessage(error));
    }
}

function gatewayErrorMessage(error: unknown) {
    if (axios.isAxiosError(error)) {
        const payload = error.response?.data as { error?: { message?: string } } | undefined;
        if (payload?.error?.message) return i18n.t("gateway.failed", { message: payload.error.message });
        if (error.response) return i18n.t("gateway.httpFailed", { status: error.response.status });
        return i18n.t("gateway.unreachable");
    }
    return error instanceof Error ? error.message : i18n.t("gateway.unreachable");
}

export async function fetchGatewayHealth(baseUrl?: string) {
    return gatewayRequest<GatewayHealth>({ method: "get", url: "/api/health", timeout: 8000 }, baseUrl);
}

export async function fetchGatewayProviders(baseUrl?: string) {
    return gatewayRequest<GatewayProviders>({ method: "get", url: "/api/providers" }, baseUrl);
}

export async function fetchGatewaySkills(baseUrl?: string) {
    const data = await gatewayRequest<{ skills: GatewaySkillInfo[] }>({ method: "get", url: "/api/skills" }, baseUrl);
    return data.skills;
}

export async function fetchGatewayStages(baseUrl?: string) {
    const data = await gatewayRequest<{ stages: GatewayStageInfo[] }>({ method: "get", url: "/api/pipeline/stages" }, baseUrl);
    return data.stages;
}

export async function submitGatewayImage(body: GatewayGenerateBody, baseUrl?: string) {
    return submitGatewayJob("image", body, baseUrl);
}

export async function submitGatewayVideo(body: GatewayGenerateBody, baseUrl?: string) {
    return submitGatewayJob("video", body, baseUrl);
}

async function submitGatewayJob(kind: "image" | "video", body: GatewayGenerateBody, baseUrl?: string) {
    const data = await gatewayRequest<{ job: GatewayJob }>({ method: "post", url: `/api/generate/${kind}`, data: body }, baseUrl);
    return data.job;
}

export async function fetchGatewayJob(id: string, baseUrl?: string) {
    const data = await gatewayRequest<{ job: GatewayJob }>({ method: "get", url: `/api/jobs/${encodeURIComponent(id)}` }, baseUrl);
    return data.job;
}

export async function listGatewayJobs(options?: { status?: GatewayJobStatus; limit?: number }, baseUrl?: string) {
    const data = await gatewayRequest<{ jobs: GatewayJob[] }>({ method: "get", url: "/api/jobs", params: options }, baseUrl);
    return data.jobs;
}

export async function cancelGatewayJob(id: string, baseUrl?: string) {
    const data = await gatewayRequest<{ job: GatewayJob }>({ method: "post", url: `/api/jobs/${encodeURIComponent(id)}/cancel` }, baseUrl);
    return data.job;
}

export async function uploadGatewayAsset(file: File | Blob, baseUrl?: string) {
    const form = new FormData();
    form.append("file", file, file instanceof File ? file.name : "upload.bin");
    return gatewayRequest<{ name: string; comfyName: string }>({ method: "post", url: "/api/uploads", data: form }, baseUrl);
}

export async function createPipelineRun(input: { novel: string; title?: string; options?: Record<string, unknown> }, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "post", url: "/api/pipeline/runs", data: input }, baseUrl);
    return data.run;
}

export async function getPipelineRun(id: string, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "get", url: `/api/pipeline/runs/${encodeURIComponent(id)}` }, baseUrl);
    return data.run;
}

export async function runPipelineStage(runId: string, stageId: string, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "post", url: `/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stageId)}/run` }, baseUrl);
    return data.run;
}

export async function updatePipelineStageInput(runId: string, stageId: string, patch: GatewayStageInputPatch, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "post", url: `/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stageId)}/input`, data: patch }, baseUrl);
    return data.run;
}

import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import type { Plan, Project } from "@/types/domain";
import { gatewayBaseUrl } from "./gateway";

/**
 * Project 接口客户端（P0-a）。
 * 后端路由见 canvas-server/src/index.js「P0-a Project 内核」段，落盘见 canvas-server/src/projects.js。
 * 传输沿用 gateway.ts 的写法：axios + gatewayBaseUrl，错误统一收敛成带中文提示的 Error。
 */

/** 列表摘要的完成度；后端 summarize() 只回计数，不回 checklist 明细。 */
export type ProjectCompletion = {
    episodes: number;
    episodesDone: number;
    checklistTotal: number;
    checklistDone: number;
};

/** GET /api/projects 的元素；不含 styleAnchor / script / 正文。 */
export type ProjectSummary = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    version: number;
    completion: ProjectCompletion;
};

/**
 * GET /api/projects/:id/context 的响应体（顶层即上下文，不套 { context } 外壳）。
 * episodes 是集索引（id/index/title/status），完整集详情按需再取 episodes/<id>.json。
 */
export type ProjectContext = {
    project: Project;
    episodes: Project["episodes"];
    runIds: string[];
    canvasIds: string[];
};

/** POST /api/projects 请求体；title 必填，其余可省，plan 缺字段由服务端补默认值。 */
export type ProjectCreateInput = {
    title: string;
    styleAnchor?: string;
    plan?: Partial<Plan>;
    script?: unknown;
    ownerUserId?: string;
};

/** PATCH /api/projects/:id 请求体；字段与 projects.js 的 MUTABLE_FIELDS 一致。 */
export type ProjectUpdateInput = {
    /** 乐观版本校验控制位；带上则与磁盘 version 比对，不一致回 409。 */
    expectedVersion?: number;
    title?: string;
    styleAnchor?: string;
    plan?: Partial<Plan>;
    script?: unknown;
    checklist?: Project["checklist"];
    reviewNotes?: Project["reviewNotes"];
    ownerUserId?: string;
};

/** 带 HTTP 状态的接口错误，供调用方区分 404（不存在）与其它失败。 */
type ProjectApiError = Error & { status: number };

function projectError(message: string, status: number): ProjectApiError {
    return Object.assign(new Error(message), { status });
}

async function projectRequest<T>(config: AxiosRequestConfig): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl() });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status ?? 0;
            const payload = error.response?.data as { error?: { message?: string } } | undefined;
            if (payload?.error?.message) throw projectError(i18n.t("gateway.failed", { message: payload.error.message }), status);
            if (error.response) throw projectError(i18n.t("gateway.httpFailed", { status }), status);
            throw projectError(i18n.t("gateway.unreachable"), 0);
        }
        throw error instanceof Error ? error : projectError(i18n.t("gateway.unreachable"), 0);
    }
}

export async function listProjects(options?: { includeArchived?: boolean }) {
    const data = await projectRequest<{ projects: ProjectSummary[] }>({
        method: "get",
        url: "/api/projects",
        params: options?.includeArchived ? { includeArchived: 1 } : undefined,
    });
    // 网关还没重启（未挂 /api/projects）时请求会回落到托管的前端 index.html，这里兜底成空列表，避免页面崩。
    return data?.projects ?? [];
}

export async function createProject(input: ProjectCreateInput) {
    const data = await projectRequest<{ project: Project }>({ method: "post", url: "/api/projects", data: input });
    if (!data?.project) throw projectError(i18n.t("projects.createFailed"), 0);
    return data.project;
}

export async function getProject(id: string) {
    const data = await projectRequest<{ project: Project }>({ method: "get", url: `/api/projects/${encodeURIComponent(id)}` });
    if (!data?.project) throw projectError(i18n.t("projects.detail.loadFailed"), 0);
    return data.project;
}

/** 项目不存在（404）时返回 null，页面按空态处理，其余失败继续抛错。 */
export async function getProjectContext(id: string): Promise<ProjectContext | null> {
    try {
        const context = await projectRequest<ProjectContext>({ method: "get", url: `/api/projects/${encodeURIComponent(id)}/context` });
        return context?.project ? context : null;
    } catch (error) {
        if ((error as ProjectApiError).status === 404) return null;
        throw error;
    }
}

export async function updateProject(id: string, patch: ProjectUpdateInput) {
    const data = await projectRequest<{ project: Project }>({ method: "patch", url: `/api/projects/${encodeURIComponent(id)}`, data: patch });
    return data.project;
}

export async function archiveProject(id: string) {
    const data = await projectRequest<{ project: Project }>({ method: "post", url: `/api/projects/${encodeURIComponent(id)}/archive` });
    return data.project;
}

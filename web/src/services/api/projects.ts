import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import type { ArtifactId, AssetRef, AssetRole, Episode, EpisodeId, Plan, Project, Scene, SceneId, Shot, ShotId } from "@/types/domain";
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

/* ------------------------------------------------------------------ *
 * 分镜 / 资产引用 / 门禁（P0-a 前端编辑，接口形状已冻结）
 *
 * 后端并行实现中：请求失败一律抛带 status 的 Error（400 不合法 / 409 冲突 / 404 不存在），
 * 页面据此提示并保留用户已输入内容，不回退。
 * ------------------------------------------------------------------ */

/** 集详情：Episode + scenes[]，每场含 shots[]（GET /episodes/:epId）。 */
export type SceneWithShots = Scene & { shots: Shot[] };
export type EpisodeDetail = Episode & { scenes: SceneWithShots[] };

/**
 * PATCH /api/projects/:id/shots/:shotId 请求体。
 * 字段与 02 分镜契约一致（`Shot.storyboard` 内部形态）；`index` 可重排，`id` 不在此列。
 */
export type ShotPatchInput = {
    index?: number;
    durationSec?: number;
    shotSize?: string;
    camera?: string;
    action?: string;
    dialogue?: string;
    audio?: string;
    prompt?: string;
    negativePrompt?: string;
    generationSlots?: Shot["generationSlots"];
};

/** POST /api/projects/:id/asset-refs 请求体；role + bindingId 必填，其余可省。 */
export type AssetRefCreateInput = {
    role: AssetRole;
    bindingId: string;
    episodeId?: EpisodeId;
    sceneId?: SceneId;
    shotId?: ShotId;
    artifactIds?: ArtifactId[];
    selectedArtifactId?: ArtifactId | null;
    metadata?: Record<string, unknown>;
};

/** PATCH /api/projects/:id/asset-refs/:refId 请求体；只改绑定与候选采用。 */
export type AssetRefPatchInput = {
    bindingId?: string;
    artifactIds?: ArtifactId[];
    selectedArtifactId?: ArtifactId | null;
};

/** GET /api/projects/:id/gates 元素。 */
export type ProjectGate = {
    stageId: string;
    ready: boolean;
    reason: string;
    blockedBy: string[];
};

/** 单实体响应兼容 `{ <key>: entity }` 外壳与裸实体：形状已冻结但外壳未逐字约定，两种都接。 */
function unwrapEntity<T>(data: unknown, key: string): T {
    if (data && typeof data === "object" && key in (data as Record<string, unknown>)) {
        return (data as Record<string, unknown>)[key] as T;
    }
    return data as T;
}

/** 列表响应兼容 `{ <key>: [] }` 外壳与裸数组。 */
function unwrapList<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === "object") {
        const value = (data as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value as T[];
    }
    return [];
}

/** 读集详情（含各场镜头）；不存在返回 null。 */
export async function getEpisode(projectId: string, episodeId: string): Promise<EpisodeDetail | null> {
    const data = await projectRequest<unknown>({
        method: "get",
        url: `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`,
    });
    const episode = unwrapEntity<EpisodeDetail | null>(data, "episode");
    if (!episode?.id) return null;
    // scenes 可能内嵌在集详情里，也可能作为同级字段返回；两种都接。
    const siblingScenes = data && typeof data === "object" ? (data as Record<string, unknown>).scenes : undefined;
    const scenes = Array.isArray(episode.scenes) ? episode.scenes : Array.isArray(siblingScenes) ? (siblingScenes as SceneWithShots[]) : [];
    return { ...episode, scenes };
}

/** 改镜：可改分镜字段与 index；id 不在 body 内，重排只改 index。 */
export async function updateShot(projectId: string, shotId: string, patch: ShotPatchInput) {
    const data = await projectRequest<unknown>({
        method: "patch",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}`,
        data: patch,
    });
    return unwrapEntity<Shot>(data, "shot");
}

export async function listAssetRefs(projectId: string): Promise<AssetRef[]> {
    const data = await projectRequest<unknown>({ method: "get", url: `/api/projects/${encodeURIComponent(projectId)}/asset-refs` });
    return unwrapList<AssetRef>(data, "assetRefs");
}

export async function createAssetRef(projectId: string, input: AssetRefCreateInput) {
    const data = await projectRequest<unknown>({ method: "post", url: `/api/projects/${encodeURIComponent(projectId)}/asset-refs`, data: input });
    return unwrapEntity<AssetRef>(data, "assetRef");
}

export async function updateAssetRef(projectId: string, refId: string, patch: AssetRefPatchInput) {
    const data = await projectRequest<unknown>({
        method: "patch",
        url: `/api/projects/${encodeURIComponent(projectId)}/asset-refs/${encodeURIComponent(refId)}`,
        data: patch,
    });
    return unwrapEntity<AssetRef>(data, "assetRef");
}

/** 读项目级阶段门禁；后端未就绪时抛错，由调用方回退前端推导。 */
export async function listProjectGates(projectId: string): Promise<ProjectGate[]> {
    const data = await projectRequest<unknown>({ method: "get", url: `/api/projects/${encodeURIComponent(projectId)}/gates` });
    return unwrapList<ProjectGate>(data, "gates").map((gate) => ({
        stageId: String(gate.stageId ?? ""),
        ready: Boolean(gate.ready),
        reason: String(gate.reason ?? ""),
        // 服务端 gates.js 抛的 blockedBy 是**结构化对象数组**（`{type:"upstream",stageId}` 或
        // `{type:"review",noteId,message}`），不是字符串数组。这里只取上游阶段名给门禁文案插值用；
        // 原样透传对象会被 `t(\`pipeline.stages.${stage}\`)` 拼成 `pipeline.stages.[object Object]`。
        blockedBy: Array.isArray(gate.blockedBy)
            ? (gate.blockedBy as unknown[])
                  .map((item) => (typeof item === "string" ? item : String((item as { stageId?: unknown })?.stageId ?? "")))
                  .filter(Boolean)
            : [],
    }));
}

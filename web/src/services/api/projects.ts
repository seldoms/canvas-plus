import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import type { ArtifactId, AssetRef, AssetRefId, AssetRole, CandidateStatus, Episode, EpisodeId, Plan, Project, ProjectId, Scene, SceneId, Shot, ShotId } from "@/types/domain";
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

/** 列项目的集索引（GET /api/projects/:id/episodes）；网关未挂该端点时兜底成空列表。 */
export async function listEpisodes(projectId: string): Promise<Episode[]> {
    const data = await projectRequest<unknown>({ method: "get", url: `/api/projects/${encodeURIComponent(projectId)}/episodes` });
    return unwrapList<Episode>(data, "episodes");
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

/** 跨项目资产总览里的一条记录：服务端已把常用字段解析好（见 canvas-server/README.md「资产总览」）。 */
export type AssetOverviewRef = {
    id: AssetRefId;
    projectId: ProjectId;
    projectTitle: string;
    role: AssetRole;
    kind: string;
    name: string;
    bindingId: string;
    /** 渲染用产物 URL（相对路径，需过 resolveGatewayUrl）；无产物为空串。 */
    url: string;
    artifactCount: number;
    episodeId: string;
    sceneId: string;
    shotId: string;
    stageId: string;
    createdAt: string | null;
    updatedAt: string | null;
};

/** GET /api/asset-refs 的响应；counts 供筛选项与页头统计，warnings 是跳过的损坏项目。 */
export type AssetOverview = {
    assetRefs: AssetOverviewRef[];
    counts: {
        total: number;
        byRole: Record<string, number>;
        byProject: { projectId: string; projectTitle: string; count: number }[];
    };
    warnings: string[];
};

/** 读跨项目资产总览；网关未挂该端点时回落到 SPA 页，这里兜底成空总览，避免页面崩。 */
export async function listAssetRefsOverview(): Promise<AssetOverview> {
    const data = await projectRequest<Partial<AssetOverview> | null>({ method: "get", url: "/api/asset-refs" });
    const assetRefs = Array.isArray(data?.assetRefs) ? data.assetRefs : [];
    const byRole = data?.counts?.byRole && typeof data.counts.byRole === "object" ? data.counts.byRole : {};
    const byProject = Array.isArray(data?.counts?.byProject) ? data.counts.byProject : [];
    return {
        assetRefs,
        counts: { total: Number(data?.counts?.total) || assetRefs.length, byRole, byProject },
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
    };
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

/* ------------------------------------------------------------------ *
 * 画布绑定与槽位候选（M2，契约见 m2-implementation-plan.md §3）
 * ------------------------------------------------------------------ */

/** 绑定：把画布登记到服务端项目 canvasIds（幂等 attach）。 */
export async function attachCanvasRef(projectId: string, canvasId: string) {
    const data = await projectRequest<unknown>({ method: "post", url: `/api/projects/${encodeURIComponent(projectId)}/canvas-refs`, data: { canvasId } });
    return unwrapEntity<Project>(data, "project");
}

/** 解绑：从服务端项目 canvasIds 移除画布（幂等 detach）。 */
export async function detachCanvasRef(projectId: string, canvasId: string) {
    const data = await projectRequest<unknown>({ method: "delete", url: `/api/projects/${encodeURIComponent(projectId)}/canvas-refs/${encodeURIComponent(canvasId)}` });
    return unwrapEntity<Project>(data, "project");
}

/** 槽位候选（M2 契约）：candidate = { template, jobId, artifactUrl, status, source, createdAt }。 */
export type SlotCandidate = {
    template?: string;
    jobId: string;
    artifactUrl?: string | null;
    status?: string;
    source?: string;
    createdAt?: string;
};

/** 槽位视图：候选追加 / 采用端点都回 { slot }。 */
export type GenerationSlotView = {
    id: string;
    shotId?: string;
    role?: string;
    selected: string | null;
    candidates: SlotCandidate[];
};

function unwrapSlot(data: unknown): GenerationSlotView {
    const slot = unwrapEntity<Partial<GenerationSlotView>>(data, "slot");
    return {
        id: String(slot?.id ?? ""),
        ...(slot?.shotId ? { shotId: String(slot.shotId) } : {}),
        ...(slot?.role ? { role: String(slot.role) } : {}),
        selected: slot?.selected ? String(slot.selected) : null,
        candidates: Array.isArray(slot?.candidates) ? (slot.candidates as SlotCandidate[]) : [],
    };
}

/** POST .../slots/:slotId/candidates { jobId }：把已完成 Job 追加为槽位候选（幂等）。 */
export async function appendSlotCandidate(projectId: string, shotId: string, slotId: string, jobId: string) {
    const data = await projectRequest<unknown>({
        method: "post",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/slots/${encodeURIComponent(slotId)}/candidates`,
        data: { jobId },
    });
    return unwrapSlot(data);
}

/** POST .../slots/:slotId/select { jobId }：采用候选（设 slot.selected）；jobId 传 null 撤销采用（清空 selected）。 */
export async function selectSlotCandidate(projectId: string, shotId: string, slotId: string, jobId: string | null) {
    const data = await projectRequest<unknown>({
        method: "post",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/slots/${encodeURIComponent(slotId)}/select`,
        data: { jobId },
    });
    return unwrapSlot(data);
}

/* ------------------------------------------------------------------ *
 * H3 多段续接链（M3.5；契约 §3.6 续接扩展，服务端业务见 canvas-server/src/continuation.js）
 * ------------------------------------------------------------------ */

/** 接缝量化指标：服务端单项测不到时写 null，缺项也可能整体缺省，故全部可选。 */
export type ContinuationSeamMetrics = {
    boundarySsim?: number | null;
    boundaryPsnrDb?: number | null;
    parentTailRmsDb?: number | null;
    childHeadRmsDb?: number | null;
    audioSeamDeltaDb?: number | null;
    seamIntegratedLufs?: number | null;
    seamTruePeakDbfs?: number | null;
};

/** 接缝 QC：契约最小形态子字段 + 量化值 metrics；未产出 QC 时为 null。 */
export type ContinuationSeam = {
    audioCorrelation: number | null;
    rmsStepDb: number | null;
    freezeDetected: boolean;
    motionDrift: number | null;
    reviewed: string;
    reviewNote?: string;
    needsReview?: boolean;
    metrics?: ContinuationSeamMetrics;
};

/** 链内一段；segmentIndex 从 0 开始，status 已由服务端折算成候选状态口径。 */
export type ContinuationSegment = {
    segmentIndex: number;
    jobId: string;
    status: CandidateStatus;
    artifactUrl: string | null;
    seam: ContinuationSeam | null;
    approvalStatus: string;
    needsReview: boolean;
};

/** 一条续接链（派生视图）：takeId == chainId；分叉链的 parentCandidateId 指向他链候选。 */
export type ContinuationChain = {
    chainId: string;
    takeId: string;
    parentCandidateId: string | null;
    status: string;
    segments: ContinuationSegment[];
};

/** 开链 / 分叉的返回：首段 Job 已入队。 */
export type ContinuationStartResult = {
    chainId: string;
    takeId: string;
    slotId: string;
    firstJobId: string;
};

/** GET .../continuation-chains：纯派生链视图（链 → 段 → parent 可回溯）。 */
export async function listContinuationChains(projectId: string, shotId: string) {
    const data = await projectRequest<unknown>({
        method: "get",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/continuation-chains`,
    });
    return unwrapList<ContinuationChain>(data, "chains");
}

function unwrapStart(data: unknown): ContinuationStartResult {
    const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const firstJob = body.firstJob as { id?: string } | undefined;
    return {
        chainId: String(body.chainId ?? ""),
        takeId: String(body.takeId ?? ""),
        slotId: String(body.slotId ?? ""),
        firstJobId: String(firstJob?.id ?? ""),
    };
}

/** POST .../continuation-chains：开新链（seg0 走 T2VA）；segments 为 1..8 的整数，prompt 非空。 */
export async function startContinuationChain(
    projectId: string,
    shotId: string,
    input: { prompt: string; segments: number; seed?: number | null; template?: string | null; params?: Record<string, unknown> },
) {
    const data = await projectRequest<unknown>({
        method: "post",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/continuation-chains`,
        data: input,
    });
    return unwrapStart(data);
}

/** POST .../continuation-branches：从 done 候选分叉（父候选非 done → 409 PARENT_NOT_DONE）。 */
export async function startContinuationBranch(projectId: string, shotId: string, input: { parentCandidateId: string; prompt: string; segments: number; seed?: number | null }) {
    const data = await projectRequest<unknown>({
        method: "post",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/continuation-branches`,
        data: input,
    });
    return unwrapStart(data);
}

/** POST .../continuation-chains/:chainId/resume：已完成段幂等跳过、只补缺失段；链已完成回 job:null。 */
export async function resumeContinuationChain(projectId: string, shotId: string, chainId: string) {
    const data = await projectRequest<{ resumedFromSegment?: number | null; job?: { id?: string } | null }>({
        method: "post",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/continuation-chains/${encodeURIComponent(chainId)}/resume`,
    });
    return { resumedFromSegment: data?.resumedFromSegment ?? null, jobId: data?.job?.id ?? null };
}

/** POST .../continuation-reviews { jobId, reviewed, note? }：接缝人工复核（写 continuation.seam.reviewed + reviewNote）。 */
export async function reviewContinuationSeam(projectId: string, shotId: string, input: { jobId: string; reviewed: "approved" | "rejected"; note?: string }) {
    const data = await projectRequest<unknown>({
        method: "post",
        url: `/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/continuation-reviews`,
        data: input,
    });
    // 服务端回 { candidate }；候选形状与契约 §3.6 一致，这里只取复核要用的两个字段。
    const candidate = unwrapEntity<{ jobId?: string; continuation?: { seam?: ContinuationSeam | null } | null }>(data, "candidate");
    return { jobId: String(candidate?.jobId ?? input.jobId), seam: candidate?.continuation?.seam ?? null };
}

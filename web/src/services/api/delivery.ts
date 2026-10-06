import i18n from "@/i18n";
import type { GatewayPipelineRun } from "./gateway";
import { getPipelineRun, resolveGatewayUrl } from "./gateway";
import { getProjectContext, type ProjectContext } from "./projects";

/**
 * 「导出交付包」的数据来源与产物下载。
 *
 * 只复用现有接口：项目上下文 `/api/projects/:id/context` + 每个关联 run 的
 * `/api/pipeline/runs/:id`，产物字节直接取 run 的 `assembly` 回写的 `/api/artifacts/<id>/<file>`。
 * 不新增后端端点；成片信息来自 `stage.output.assembly`（url / coverUrl / manifestUrl / deliverableId / info）。
 */

export type ProjectDeliverySource = {
    context: ProjectContext;
    /** 该项目关联的 run 详情；单个 run 拉取失败时跳过，不因一个 run 拖垮整次导出。 */
    runs: GatewayPipelineRun[];
};

/** 读取项目上下文与该项目的全部 run 详情。projectId 不存在时抛错（由页面提示）。 */
export async function loadProjectDeliverySource(projectId: string): Promise<ProjectDeliverySource> {
    const context = await getProjectContext(projectId);
    if (!context) throw new Error(i18n.t("projects.delivery.notFound"));
    const runs = await Promise.all(context.runIds.map((runId) => getPipelineRun(runId).catch(() => null)));
    return { context, runs: runs.filter((run): run is GatewayPipelineRun => Boolean(run)) };
}

/** 单次下载结果：失败带可读原因（写进交付清单的缺失项），绝不静默丢弃。 */
export type ArtifactFetch =
    | { ok: true; blob: Blob; bytes: number }
    | { ok: false; reason: string };

export type ArtifactTextFetch = { ok: true; text: string } | { ok: false; reason: string };

/**
 * 下载产物字节。先用 content-length 预判大小，超过 maxBytes 直接放弃读取而非拉满内存；
 * 无该响应头时按实际 blob 大小兜底判断。任何网络/HTTP 失败都返回原因。
 */
export async function downloadArtifactBlob(url: string, maxBytes: number): Promise<ArtifactFetch> {
    if (!url) return { ok: false, reason: i18n.t("projects.delivery.unreachable") };
    try {
        const response = await fetch(resolveGatewayUrl(url));
        if (!response.ok) return { ok: false, reason: i18n.t("projects.delivery.downloadFailed", { status: response.status }) };
        const declared = Number(response.headers.get("content-length") || 0);
        if (declared > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false, reason: i18n.t("projects.delivery.fileTooLarge", { size: formatBytes(declared) }) };
        }
        const blob = await response.blob();
        if (blob.size > maxBytes) return { ok: false, reason: i18n.t("projects.delivery.fileTooLarge", { size: formatBytes(blob.size) }) };
        return { ok: true, blob, bytes: blob.size };
    } catch {
        return { ok: false, reason: i18n.t("projects.delivery.unreachable") };
    }
}

/** 读取文本型产物（拼接清单 assembly-manifest.json），用于发现字幕等可选交付物。 */
export async function fetchArtifactText(url: string): Promise<ArtifactTextFetch> {
    if (!url) return { ok: false, reason: i18n.t("projects.delivery.unreachable") };
    try {
        const response = await fetch(resolveGatewayUrl(url));
        if (!response.ok) return { ok: false, reason: i18n.t("projects.delivery.downloadFailed", { status: response.status }) };
        return { ok: true, text: await response.text() };
    } catch {
        return { ok: false, reason: i18n.t("projects.delivery.unreachable") };
    }
}

function formatBytes(bytes: number) {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${bytes}B`;
}

/**
 * 成片合成结果：与后端 `executeAssemble` 回写进 `stages.assembly.output.assembly` 的字段一一对应。
 * 状态机：`assembling`（ffmpeg 在跑）→ `done`（有 url）/ `error`（有可读 error）。`reused` 是 200 复用。
 */
export type GatewayAssembly = {
    status: "assembling" | "done" | "error" | string;
    /** 成片产物地址（`/api/artifacts/...`）；仅 `done` 有。 */
    url?: string;
    coverUrl?: string | null;
    manifestUrl?: string | null;
    logUrl?: string | null;
    deliverableId?: string;
    bytes?: number;
    /** 成片信息；`durationSec` 是成片总时长。 */
    info?: { durationSec?: number } | null;
    /**
     * 独立字幕产物（SRT，与成片同交付目录、可下载导入剪映）。
     * 成片 mp4 **默认不含字幕**（`burned:false`）；`url` 供预览自动挂载，无台词时为 null。
     */
    subtitles?: {
        burned?: boolean;
        cueCount?: number;
        lines?: number;
        url?: string | null;
        name?: string | null;
        reason?: string;
    } | null;
    order?: unknown;
    transition?: string;
    attempt?: number;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
};

/** 从 run 详情读成片信息（assembly 阶段 output.assembly）；没有返回 null。服务端回写、前端只读。 */
export function readRunAssembly(run: GatewayPipelineRun | null | undefined): GatewayAssembly | null {
    const output = run?.stages?.assembly?.output as { assembly?: GatewayAssembly } | undefined;
    return output?.assembly ?? null;
}

export type AssembleResult = {
    run: GatewayPipelineRun;
    /** 后端是否后台执行（202）。 */
    inflight: boolean;
    /** 已有成片被直接复用（200），未重复调 ffmpeg。 */
    reused: boolean;
    assembly: GatewayAssembly | null;
};

/**
 * 触发「合成成片」：POST /api/pipeline/runs/:id/steps/assembly/assemble。
 * 后端同步部分做门禁（片段未全部成功 → 400 带可读原因）；通过后 202 后台跑 ffmpeg，
 * 已有成片且未带 `force` 时 200 `reused` 直接回原结果。400/网络错误转成可读 Error。
 */
export async function assemblePipelineRun(runId: string, body: Record<string, unknown> = {}, baseUrl?: string): Promise<AssembleResult> {
    let response: Response;
    try {
        response = await fetch(resolveGatewayUrl(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/assembly/assemble`, baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error(i18n.t("gateway.unreachable"));
    }
    const payload = (await response.json().catch(() => null)) as
        | { run?: GatewayPipelineRun; inflight?: boolean; reused?: boolean; assembly?: GatewayAssembly; error?: { message?: string } }
        | null;
    if (!response.ok) throw new Error(payload?.error?.message || i18n.t("gateway.httpFailed", { status: response.status }));
    if (!payload?.run) throw new Error(i18n.t("gateway.unreachable"));
    return {
        run: payload.run,
        inflight: Boolean(payload.inflight),
        reused: Boolean(payload.reused),
        assembly: readRunAssembly(payload.run) ?? payload.assembly ?? null,
    };
}

// ——— 完整交付包（服务端拼装） ———
// 与上面的浏览器端打包**并存且不重叠**：
//   - 浏览器端（useProjectDelivery）：成片 + 封面 + 字幕 + 清单，直接 saveAs 下载，零服务端负担；
//   - 服务端（exportDeliveryPackage）：另外产出 **clips/ 分集原片 + FCPXML + EDL**，
//     这些是「导入剪映继续剪」必需的材料，浏览器端做不了（要重新扫盘上所有片段再拼时间线）。
// 用户要「能直接进剪映的完整工程」时才走服务端。

/** 服务端导出 manifest 的最小形状（完整字段见 edit-export.js 的 export-manifest.json）。 */
export type ExportPackageManifest = {
    pkgId?: string;
    runId?: string | null;
    projectId?: string | null;
    createdAt?: string;
    partial?: boolean;
    missing?: unknown[];
    episodes?: Array<{ episodeId: string; index?: number; title?: string; partial?: boolean; finalFile?: string | null; durationSec?: number | null }>;
    package?: { zipPath?: string; files?: Array<{ path: string; bytes?: number }> };
};

export type ExportPackageResult = {
    inflight: boolean;
    runId: string;
    episodeId: string | null;
};

/**
 * 触发服务端素材包导出：POST /api/pipeline/runs/:id/steps/assembly/export。
 * 真实 ffmpeg 拼接与打包是分钟级，后端 **202 立刻返回**；进度看 run 的 progress 端点。
 * 完成后用 `fetchExportPackage` 读 manifest。
 */
export async function exportDeliveryPackage(runId: string, body: Record<string, unknown> = {}, baseUrl?: string): Promise<ExportPackageResult> {
    let response: Response;
    try {
        response = await fetch(resolveGatewayUrl(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/assembly/export`, baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error(i18n.t("gateway.unreachable"));
    }
    const payload = (await response.json().catch(() => null)) as
        | { runId?: string; inflight?: boolean; episodeId?: string | null; error?: { message?: string } }
        | null;
    if (!response.ok) throw new Error(payload?.error?.message || i18n.t("gateway.httpFailed", { status: response.status }));
    return { inflight: Boolean(payload?.inflight), runId: payload?.runId ?? runId, episodeId: payload?.episodeId ?? null };
}

/**
 * 读服务端导出结果：GET /api/pipeline/runs/:id/steps/assembly/export[?packageId=]。
 * **不重跑导出**，纯读盘上已落盘的 manifest；还没导出时返回 `{ manifest: null, packages: [] }`。
 */
export async function fetchExportPackage(runId: string, packageId?: string, baseUrl?: string): Promise<{ packageId: string | null; packages: string[]; manifest: ExportPackageManifest | null }> {
    let response: Response;
    const query = packageId ? `?packageId=${encodeURIComponent(packageId)}` : "";
    try {
        response = await fetch(resolveGatewayUrl(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/assembly/export${query}`, baseUrl));
    } catch {
        throw new Error(i18n.t("gateway.unreachable"));
    }
    const payload = (await response.json().catch(() => null)) as
        | { packageId?: string | null; packages?: string[]; manifest?: ExportPackageManifest; error?: { message?: string } }
        | null;
    if (!response.ok) throw new Error(payload?.error?.message || i18n.t("gateway.httpFailed", { status: response.status }));
    return {
        packageId: payload?.packageId ?? null,
        packages: payload?.packages ?? [],
        manifest: payload?.manifest ?? null,
    };
}

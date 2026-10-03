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

import axios from "axios";

import { gatewayBaseUrl } from "./gateway";

/**
 * 产物归档 / 彻底删除（素材生命周期）客户端。
 * - GET  /api/artifacts            → 产物列表（带来源与引用信息）
 * - POST /api/artifacts/archive    → 归档（可逆）
 * - POST /api/artifacts/restore    → 恢复归档
 * - POST /api/artifacts/delete     → 彻底删除（必须 confirm，被引用默认拒删）
 */

export type ArtifactOrigin = "workbench" | "pipeline";

export type ArtifactSource = {
    origin: ArtifactOrigin;
    runId?: string;
    stageId?: string;
    itemId?: string;
    role?: string;
    template?: string;
    projectId?: string;
};

/** 一条引用记录：谁引用了这个产物（项目 + 镜头 + 角色）。 */
export type ArtifactRefRow = {
    projectId: string | null;
    projectName: string | null;
    shotId: string | null;
    role: string | null;
};

export type ArtifactState = "active" | "archived" | "deleted";

export type ArtifactItem = {
    id: string;
    jobId: string;
    filename: string;
    url: string;
    kind: string;
    bytes: number | null;
    source: ArtifactSource;
    createdAt: string | null;
    state: ArtifactState;
    archivedAt?: string | null;
    refs: ArtifactRefRow[];
};

export type ArtifactListResult = {
    items: ArtifactItem[];
    nextCursor?: string;
    counts: { active: number; archived: number };
};

export type ArtifactBlockedRow = {
    id: string;
    jobId: string;
    filename: string;
    refs: ArtifactRefRow[];
};

async function artifactRequest<T>(config: { method: string; url: string; data?: unknown; params?: Record<string, unknown> }): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl(), timeout: 30000 });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const message = (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
            throw new Error(message || (error.response ? `HTTP ${error.response.status}` : "unreachable"));
        }
        throw error instanceof Error ? error : new Error(String(error));
    }
}

/** GET /api/artifacts：默认只列 active；state=all 时含已归档。 */
export async function listArtifacts(params: { state?: "active" | "archived" | "all"; kind?: string; origin?: ArtifactOrigin; projectId?: string; limit?: number; cursor?: string } = {}): Promise<ArtifactListResult> {
    const data = await artifactRequest<ArtifactListResult>({ method: "get", url: "/api/artifacts", params });
    return { items: Array.isArray(data?.items) ? data.items : [], nextCursor: data?.nextCursor, counts: data?.counts ?? { active: 0, archived: 0 } };
}

export async function archiveArtifacts(ids: string[]): Promise<{ archived: string[]; missing: string[] }> {
    const data = await artifactRequest<{ archived?: string[]; missing?: string[] }>({ method: "post", url: "/api/artifacts/archive", data: { ids } });
    return { archived: data?.archived ?? [], missing: data?.missing ?? [] };
}

export async function restoreArtifacts(ids: string[]): Promise<{ restored: string[]; missing: string[] }> {
    const data = await artifactRequest<{ restored?: string[]; missing?: string[] }>({ method: "post", url: "/api/artifacts/restore", data: { ids } });
    return { restored: data?.restored ?? [], missing: data?.missing ?? [] };
}

/** POST /api/artifacts/delete（confirm 恒为 true）；返回 blocked 时表示这些还被引用、未删。 */
export async function deleteArtifacts(ids: string[]): Promise<{ deleted: string[]; blocked: ArtifactBlockedRow[]; missing: string[] }> {
    const data = await artifactRequest<{ deleted?: string[]; blocked?: ArtifactBlockedRow[]; missing?: string[] }>({
        method: "post",
        url: "/api/artifacts/delete",
        data: { ids, confirm: true },
    });
    return { deleted: data?.deleted ?? [], blocked: data?.blocked ?? [], missing: data?.missing ?? [] };
}

/** 产物 URL 是否指向本网关的产物（用于判断能否归档，避免对本地 blob 误发请求）。 */
export function isArtifactUrl(url?: string): boolean {
    return typeof url === "string" && url.includes("/api/artifacts/");
}

/** POST /api/artifacts/import（multipart）的字段；传了 slotId 服务端会自动投影为槽位候选，前端不要再重复调 candidates 追加。 */
export type ArtifactImportFields = {
    source?: string;
    projectId?: string;
    episodeId?: string;
    sceneId?: string;
    shotId?: string;
    slotId?: string;
    idempotencyKey?: string;
};

export type ArtifactImportResult = {
    job: { id: string; status?: string; kind?: string; meta?: Record<string, unknown> };
    artifact: { id: string; url: string; bytes?: number; kind?: string };
};

/** 登记外部文件为 Artifact（M2-D4）：合成已完成 Job（status=done、kind=import），同 idempotencyKey 幂等返回同一 job+artifact。 */
export async function importArtifact(file: Blob, fields: ArtifactImportFields, filename = "canvas-import.png"): Promise<ArtifactImportResult> {
    const form = new FormData();
    form.append("file", file, filename);
    for (const [key, value] of Object.entries(fields)) {
        if (value) form.append(key, value);
    }
    const data = await artifactRequest<ArtifactImportResult>({ method: "post", url: "/api/artifacts/import", data: form });
    if (!data?.artifact?.url || !data?.job?.id) throw new Error("unreachable");
    return data;
}

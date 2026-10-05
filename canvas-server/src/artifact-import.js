/**
 * artifact-import.js —— 登记外部文件为 Artifact（M2-D4）：把画布存量图片等外部字节
 * 包装成一次「导入」，合成 status="done"、kind="import" 的 Job（字节落盘与 Job 记账在
 * jobs.recordImport），产物经 jobs.outputs 进 artifacts.js 懒索引，不另开索引来源。
 *
 * 纯业务模块：不 import http.js；只做校验与编排。错误形状沿用 generation-intent.js
 * （status + code + field）。幂等：同 idempotencyKey 返回同一 job + artifact。
 */

/** 归属字段：fields → job.meta 的直通清单（有值才写，契约 §3.10 同口径）。 */
const CONTEXT_FIELDS = ["projectId", "episodeId", "sceneId", "shotId", "slotId"];

function contractError(status, code, message, field) {
    return Object.assign(new Error(message), { status, code, field });
}

/** contentType → 产物类别（与 generate.js 的 image/video 归类同口径，其余一律 file）。 */
function typeOf(contentType) {
    const text = String(contentType || "").toLowerCase();
    if (text.startsWith("image/")) return "image";
    if (text.startsWith("video/")) return "video";
    if (text.startsWith("audio/")) return "audio";
    return "file";
}

export function createArtifactImport({ jobs, getProject } = {}) {
    if (typeof jobs?.recordImport !== "function") throw new Error("createArtifactImport 需要注入 jobs.recordImport");

    /**
     * @param {{ filename: string, buffer: Buffer, contentType?: string, fields?: object }} input
     * @returns {Promise<{ job: object, artifact: { id: string, url: string, bytes: number, kind: string } }>}
     */
    async function importArtifact({ filename, buffer, contentType, fields } = {}) {
        if (!Buffer.isBuffer(buffer) || !buffer.length) throw contractError(400, "CONTRACT_INVALID", "未找到导入文件", "file");
        const source = fields && typeof fields === "object" ? fields : {};
        const meta = { source: source.source ? String(source.source) : "canvas" };
        for (const field of CONTEXT_FIELDS) {
            if (source[field]) meta[field] = String(source[field]);
        }
        // 归属项目必须真实存在（与 M1 提交链同口径）：悬空 projectId 不写进事实链。
        if (meta.projectId && typeof getProject === "function" && !getProject(meta.projectId)) {
            throw contractError(409, "PROJECT_NOT_FOUND", `项目不存在：${meta.projectId}`, "projectId");
        }
        if (source.idempotencyKey) meta.idempotencyKey = String(source.idempotencyKey);
        const kind = typeOf(contentType);
        const job = await jobs.recordImport({ filename, buffer, type: kind, meta });
        const output = (Array.isArray(job.outputs) ? job.outputs : []).find((item) => item?.url);
        return { job, artifact: { id: `${job.id}/${output.filename}`, url: output.url, bytes: output.bytes, kind: output.type || kind } };
    }

    return { importArtifact };
}

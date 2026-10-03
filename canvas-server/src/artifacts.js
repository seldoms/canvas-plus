import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, safeJoin } from "./files.js";

/**
 * 产物归档 / 彻底删除内核（只做目录读写 + 纯函数，不依赖 HTTP；路由接线在 index.js）。
 *
 * 索引落 `data/artifacts-index.json`，**从 jobs 的 outputs[] 懒构建**：读时发现新产物就补录，
 * 归档状态以索引为准（重建索引不会丢失 user 归档过的状态）。
 * 产物磁盘位置：`data/artifacts/<jobId>/<filename>`（与 GET /api/artifacts/<jobId>/<filename> 同源）。
 *
 * 术语：
 *   - 归档（archive）：可逆，只改索引 state，不动文件；生产动线只允许归档。
 *   - 彻底删除（delete）：不可逆，删文件 + 标 state=deleted + 追加 deletions 审计；
 *     **被项目/流水线引用的产物默认拒删**（返回引用方），只有「我的资产」页才提供。
 */

function nowIso() {
    return new Date().toISOString();
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/** 从产物 URL 抽 filename（相对 / 绝对 URL 均可）；抽不出返回空串。 */
function filenameFromUrl(url) {
    const text = String(url ?? "");
    const clean = text.split(/[?#]/)[0];
    const segment = clean.split("/").filter(Boolean).pop() || "";
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * 把「产物 id（`<jobId>/<filename>`）、相对 URL、绝对 URL」统一成规范 id。
 * 认不出两段结构（jobId + filename）返回空串，调用方按 missing 处理（不误删）。
 */
export function canonicalArtifactId(raw) {
    let text = String(raw ?? "").trim();
    if (!text) return "";
    const marker = "/api/artifacts/";
    const at = text.indexOf(marker);
    if (at >= 0) text = text.slice(at + marker.length);
    text = text.split(/[?#]/)[0];
    const parts = text.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    const jobId = parts[0];
    const filename = parts.slice(1).join("/");
    const decode = (value) => {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };
    return `${decode(jobId)}/${decode(filename)}`;
}

/** 引用去重：同一 (projectId, shotId, role) 只留一条，且只暴露这四项。 */
function dedupeRefs(refs) {
    const seen = new Set();
    const result = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
        if (!ref || typeof ref !== "object") continue;
        const row = {
            projectId: ref.projectId ?? null,
            projectName: ref.projectName ?? null,
            shotId: ref.shotId ?? null,
            role: ref.role ?? null,
        };
        // 全空的引用没有意义（既无项目也无镜头），丢弃，宁空不误拦。
        if (!row.projectId && !row.shotId && !row.role) continue;
        const key = JSON.stringify(row);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(row);
    }
    return result;
}

export function createArtifacts({ dataDir, listJobs, listRuns, listAssetRefs, resolveProjectName } = {}) {
    const indexPath = join(ensureDir(dataDir || "data"), "artifacts-index.json");
    const artifactsDir = join(dataDir || "data", "artifacts");

    /** 容错读取索引：缺失/损坏一律按空索引处理，绝不让服务崩。 */
    function readIndex() {
        if (!existsSync(indexPath)) return { items: [], deletions: [] };
        try {
            const raw = JSON.parse(readFileSync(indexPath, "utf8"));
            return {
                items: Array.isArray(raw?.items) ? raw.items : [],
                deletions: Array.isArray(raw?.deletions) ? raw.deletions : [],
            };
        } catch (error) {
            console.warn(`[artifacts] 索引损坏，按空处理：${indexPath}（${error.message}）`);
            return { items: [], deletions: [] };
        }
    }

    /** 临时文件 + 同目录 rename：避免读到写了一半的索引。 */
    function writeIndex(index) {
        ensureDir(dirname(indexPath));
        const temp = `${indexPath}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(temp, JSON.stringify(index, null, 2));
        renameSync(temp, indexPath);
        return index;
    }

    /** runId → projectId（run.options.projectId 是契约认可的过渡位）。 */
    function buildRunProjectIndex() {
        const map = new Map();
        for (const run of safeList(listRuns)) {
            const projectId = run?.options?.projectId;
            if (run?.id && projectId) map.set(String(run.id), String(projectId));
        }
        return map;
    }

    function projectName(projectId) {
        if (!projectId || typeof resolveProjectName !== "function") return null;
        try {
            return resolveProjectName(String(projectId)) || null;
        } catch {
            return null;
        }
    }

    /**
     * 反查产物被谁引用：产物 URL → refs。
     * 两类来源：
     *   - 流水线：run.stages[*].output.frames/clips/references[].candidates[].artifactUrl
     *   - 项目资产引用：项目 AssetRef 的 artifactIds / selectedArtifactId / metadata.artifactUrl
     * 查不到就空数组（宁空不误拦）。
     */
    function buildRefIndex() {
        const byUrl = new Map();
        const add = (url, ref) => {
            const key = String(url ?? "").trim();
            if (!key) return;
            const list = byUrl.get(key) || [];
            list.push(ref);
            byUrl.set(key, list);
        };

        for (const run of safeList(listRuns)) {
            const projectId = run?.options?.projectId ? String(run.options.projectId) : null;
            const projectName_ = projectId ? projectName(projectId) : null;
            for (const stage of Object.values(run?.stages || {})) {
                const output = stage?.output;
                const items = output?.frames || output?.clips || output?.references || [];
                for (const item of Array.isArray(items) ? items : []) {
                    for (const candidate of Array.isArray(item?.candidates) ? item.candidates : []) {
                        if (!candidate?.artifactUrl) continue;
                        add(candidate.artifactUrl, {
                            projectId,
                            projectName: projectName_,
                            shotId: item?.shotId ?? item?.id ?? null,
                            role: item?.role ?? null,
                        });
                    }
                }
            }
        }

        for (const ref of safeList(listAssetRefs)) {
            if (!ref || typeof ref !== "object") continue;
            const row = {
                projectId: ref.projectId ? String(ref.projectId) : null,
                projectName: ref.projectName ? String(ref.projectName) : null,
                shotId: ref.shotId ? String(ref.shotId) : null,
                role: ref.role ? String(ref.role) : null,
            };
            const urls = [];
            if (Array.isArray(ref.artifactIds)) urls.push(...ref.artifactIds);
            if (ref.selectedArtifactId) urls.push(ref.selectedArtifactId);
            const meta = ref.metadata && typeof ref.metadata === "object" ? ref.metadata : {};
            if (meta.artifactUrl) urls.push(meta.artifactUrl);
            for (const url of urls) add(url, row);
        }

        return byUrl;
    }

    /** jobs.outputs[] → 待补录的产物行。 */
    function collectOutputs() {
        const rows = [];
        for (const job of safeList(listJobs)) {
            if (!job?.id) continue;
            for (const output of Array.isArray(job.outputs) ? job.outputs : []) {
                if (!output?.url) continue;
                const filename = output.filename || filenameFromUrl(output.url);
                if (!filename) continue;
                rows.push({ job, output, filename });
            }
        }
        return rows;
    }

    /** 由 job 推出来源信息（哪些字段进 source 只在这里决定）。 */
    function sourceOf(job, runProject) {
        const meta = job.meta && typeof job.meta === "object" ? job.meta : {};
        const runId = meta.runId ? String(meta.runId) : null;
        const source = { origin: runId ? "pipeline" : "workbench" };
        if (runId) source.runId = runId;
        if (meta.stageId) source.stageId = String(meta.stageId);
        if (meta.itemId) source.itemId = String(meta.itemId);
        if (job.template) source.template = String(job.template);
        if (runId) {
            const stageId = meta.stageId ? String(meta.stageId) : "";
            if (stageId === "keyframe") source.role = "keyframe";
            else if (stageId === "assembly") source.role = "clip";
            const projectId = runProject.get(runId);
            if (projectId) source.projectId = projectId;
        }
        return source;
    }

    /**
     * 懒构建：读时把 jobs 里新出现的产物补录进索引；已有条目保留其 state，
     * 只刷新 refs / 补齐 source.projectId。有变化才落盘。
     */
    function ensureIndex() {
        const index = readIndex();
        const byId = new Map(index.items.map((item) => [item.id, item]));
        const refIndex = buildRefIndex();
        const runProject = buildRunProjectIndex();
        let changed = false;

        for (const { job, output, filename } of collectOutputs()) {
            const id = `${job.id}/${filename}`;
            let item = byId.get(id);
            if (!item || typeof item !== "object") {
                item = {
                    id,
                    jobId: String(job.id),
                    filename,
                    url: output.url,
                    kind: output.type || job.kind || "file",
                    bytes: Number.isFinite(Number(output.bytes)) ? Number(output.bytes) : null,
                    source: sourceOf(job, runProject),
                    createdAt: job.finishedAt || job.createdAt || job.updatedAt || null,
                    state: "active",
                    archivedAt: null,
                    refs: [],
                };
                index.items.push(item);
                byId.set(id, item);
                changed = true;
            }
            const refs = dedupeRefs(refIndex.get(item.url) || []);
            if (JSON.stringify(refs) !== JSON.stringify(item.refs || [])) {
                item.refs = refs;
                changed = true;
            }
            if (!item.source) item.source = sourceOf(job, runProject);
            if (!item.source.projectId) {
                const projectId = (item.source.runId && runProject.get(item.source.runId)) || refs[0]?.projectId || null;
                if (projectId) {
                    item.source.projectId = projectId;
                    changed = true;
                }
            }
        }

        if (changed) writeIndex(index);
        return index;
    }

    const asArray = (value) => (Array.isArray(value) ? value : []);

    /**
     * GET /api/artifacts：默认只列 active（生产动线看到的是「在用」的素材）；
     * state=archived/all 用于资产页切换。counts 在 state 过滤前算（供页头统计）。
     */
    function list({ state = "active", kind, origin, projectId, limit, cursor } = {}) {
        const index = ensureIndex();
        let items = index.items.filter((item) => item && item.state !== "deleted");

        if (kind) items = items.filter((item) => item.kind === kind);
        if (origin) items = items.filter((item) => item.source?.origin === origin);
        if (projectId) {
            items = items.filter(
                (item) => item.source?.projectId === projectId || (Array.isArray(item.refs) && item.refs.some((ref) => ref.projectId === projectId)),
            );
        }

        const counts = {
            active: items.filter((item) => item.state === "active").length,
            archived: items.filter((item) => item.state === "archived").length,
        };

        if (state && state !== "all") items = items.filter((item) => item.state === state);

        items = [...items].sort(
            (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || String(b.id).localeCompare(String(a.id)),
        );

        const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 100;
        let start = 0;
        if (cursor) {
            const at = items.findIndex((item) => item.id === cursor);
            start = at >= 0 ? at + 1 : 0;
        }
        const page = items.slice(start, start + size);
        const nextCursor = start + size < items.length && page.length ? page[page.length - 1].id : undefined;
        return { items: page, ...(nextCursor ? { nextCursor } : {}), counts };
    }

    function archive({ ids, actor } = {}) {
        const index = ensureIndex();
        const byId = new Map(index.items.map((item) => [item.id, item]));
        const archived = [];
        const missing = [];
        for (const raw of asArray(ids)) {
            const id = canonicalArtifactId(raw);
            const item = id ? byId.get(id) : null;
            if (!item || item.state === "deleted") {
                missing.push(raw);
                continue;
            }
            if (item.state !== "archived") {
                item.state = "archived";
                item.archivedAt = nowIso();
                if (actor) item.archivedBy = String(actor);
            }
            archived.push(item.id);
        }
        writeIndex(index);
        return { archived, missing };
    }

    function restore({ ids } = {}) {
        const index = ensureIndex();
        const byId = new Map(index.items.map((item) => [item.id, item]));
        const restored = [];
        const missing = [];
        for (const raw of asArray(ids)) {
            const id = canonicalArtifactId(raw);
            const item = id ? byId.get(id) : null;
            if (!item || item.state === "deleted") {
                missing.push(raw);
                continue;
            }
            if (item.state !== "active") {
                item.state = "active";
                item.archivedAt = null;
                delete item.archivedBy;
            }
            restored.push(item.id);
        }
        writeIndex(index);
        return { restored, missing };
    }

    /** 删文件：产物目录空了顺手清掉，保持磁盘整洁；文件不存在也当作删成功（幂等）。 */
    function removeArtifactFile(jobId, filename) {
        const file = safeJoin(artifactsDir, String(jobId), String(filename));
        if (!file) return false;
        try {
            rmSync(file, { force: true });
        } catch (error) {
            console.warn(`[artifacts] 删除文件失败：${file}（${error.message}）`);
            return false;
        }
        try {
            const dir = safeJoin(artifactsDir, String(jobId));
            if (dir && existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
        } catch {
            /* 目录非空或不存在 → 保留，不影响结果 */
        }
        return true;
    }

    /**
     * POST /api/artifacts/delete：必须 confirm === true（缺省即 400，防误触）。
     * 被引用（refs 非空）的产物默认拒删，进 blocked 并回引用方；其余真删。
     * partial success：deleted 只含真删了的，blocked/missing 各自记录。
     */
    function remove({ ids, confirm, actor } = {}) {
        if (confirm !== true) throw httpError(400, "彻底删除需要显式确认：请求体需带 confirm:true");
        const index = ensureIndex();
        const byId = new Map(index.items.map((item) => [item.id, item]));
        const deleted = [];
        const blocked = [];
        const missing = [];
        const audit = [];
        for (const raw of asArray(ids)) {
            const id = canonicalArtifactId(raw);
            const item = id ? byId.get(id) : null;
            if (!item || item.state === "deleted") {
                missing.push(raw);
                continue;
            }
            const refs = dedupeRefs(item.refs || []);
            if (refs.length) {
                blocked.push({ id: item.id, jobId: item.jobId, filename: item.filename, refs });
                continue;
            }
            removeArtifactFile(item.jobId, item.filename);
            item.state = "deleted";
            item.deletedAt = nowIso();
            if (actor) item.deletedBy = String(actor);
            deleted.push(item.id);
            audit.push({ id: item.id, jobId: item.jobId, filename: item.filename, url: item.url, source: item.source });
        }
        if (audit.length) index.deletions.push({ at: nowIso(), actor: actor ? String(actor) : null, items: audit });
        writeIndex(index);
        return { deleted, blocked, missing };
    }

    return { list, archive, restore, remove, indexPath, ensureIndex };
}

function safeList(fn) {
    if (typeof fn !== "function") return [];
    try {
        const value = fn();
        return Array.isArray(value) ? value : [];
    } catch (error) {
        console.warn(`[artifacts] 读取上游数据失败：${error.message}`);
        return [];
    }
}

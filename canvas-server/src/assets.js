import { readdirSync } from "node:fs";
import { join } from "node:path";

import { ASSET_ROLE } from "./contracts.js";

/**
 * AssetRef 存储内核（P0-a 深水区）。
 * 只登记引用，不复制 artifact 字节（D2）；实体挂在 project.json 的 assetRefs[] 上。
 * bindingId 是角色/场景/道具的一致性锚点；role 取值见 contracts.js 的 ASSET_ROLE。
 */

const ROLES = new Set(Object.values(ASSET_ROLE));
const MUTABLE = new Set(["role", "bindingId", "artifactIds", "selectedArtifactId", "metadata", "episodeId", "sceneId", "shotId"]);

export function createAssets(store) {
    const { ulid, badRequest, httpError, requireArray, requireProject, persistProject, readJson, dataDir } = store;

    const refsOf = (project) => (Array.isArray(project.assetRefs) ? project.assetRefs : []);
    const requireRef = (project, id) => {
        const ref = refsOf(project).find((item) => item.id === id);
        if (!ref) throw httpError(404, `资产引用不存在：${id}`);
        return ref;
    };
    const assertRole = (role) => {
        if (!ROLES.has(String(role))) throw badRequest(`资产类别 role 非法：${role || "(空)"}`);
    };
    const assertSelection = (ref) => {
        if (ref.selectedArtifactId && !ref.artifactIds.includes(ref.selectedArtifactId)) throw badRequest(`selectedArtifactId 不在 artifactIds 内：${ref.selectedArtifactId}`);
    };

    function list(projectId, { role } = {}) {
        const { project } = requireProject(projectId);
        let refs = refsOf(project);
        if (role !== undefined && role !== null && role !== "") {
            assertRole(role);
            refs = refs.filter((item) => item.role === role);
        }
        return refs;
    }

    /** 登记一条引用：role 必须在枚举内，bindingId 必填。 */
    function create(projectId, input = {}) {
        const { project, dir } = requireProject(projectId);
        const body = input && typeof input === "object" ? input : {};
        assertRole(body.role);
        const bindingId = String(body.bindingId ?? "").trim();
        if (!bindingId) throw badRequest("资产引用缺少绑定锚点 bindingId");
        const assetRef = {
            id: `as_${ulid()}`,
            projectId: project.id,
            role: String(body.role),
            bindingId,
            artifactIds: requireArray(body.artifactIds ?? [], "artifactIds"),
            selectedArtifactId: body.selectedArtifactId ? String(body.selectedArtifactId) : null,
            metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
        };
        assertSelection(assetRef);
        for (const key of ["episodeId", "sceneId", "shotId"]) if (body[key]) assetRef[key] = String(body[key]);
        project.assetRefs = [...refsOf(project), assetRef];
        persistProject(dir, project);
        return assetRef;
    }

    function update(projectId, assetRefId, patch = {}) {
        const { project, dir } = requireProject(projectId);
        const ref = requireRef(project, assetRefId);
        const body = patch && typeof patch === "object" ? patch : {};
        for (const key of Object.keys(body)) if (!MUTABLE.has(key)) throw badRequest(`未知字段：${key}`);
        if (body.role !== undefined) {
            assertRole(body.role);
            ref.role = String(body.role);
        }
        if (body.bindingId !== undefined) {
            const value = String(body.bindingId).trim();
            if (!value) throw badRequest("bindingId 不能为空");
            ref.bindingId = value;
        }
        if (body.artifactIds !== undefined) ref.artifactIds = requireArray(body.artifactIds, "artifactIds");
        if (body.selectedArtifactId !== undefined) ref.selectedArtifactId = body.selectedArtifactId ? String(body.selectedArtifactId) : null;
        if (body.metadata !== undefined) ref.metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
        for (const key of ["episodeId", "sceneId", "shotId"]) {
            if (body[key] === undefined) continue;
            if (body[key] === null || body[key] === "") delete ref[key];
            else ref[key] = String(body[key]);
        }
        assertSelection(ref);
        persistProject(dir, project);
        return ref;
    }

    /** 切换采用的候选：artifactId 必须在 artifactIds[] 内。 */
    function select(projectId, assetRefId, { artifactId } = {}) {
        const { project, dir } = requireProject(projectId);
        const ref = requireRef(project, assetRefId);
        const id = String(artifactId ?? "");
        if (!id) throw badRequest("缺少 artifactId");
        if (!ref.artifactIds.includes(id)) throw badRequest(`artifactId 不在 artifactIds 内：${id}`);
        ref.selectedArtifactId = id;
        persistProject(dir, project);
        return ref;
    }

    /** 解除某个 artifact 的引用（不删 artifact 文件）；若它正被采用则一并清空。 */
    function unlink(projectId, assetRefId, { artifactId } = {}) {
        const { project, dir } = requireProject(projectId);
        const ref = requireRef(project, assetRefId);
        const id = String(artifactId ?? "");
        if (!id) throw badRequest("缺少 artifactId");
        ref.artifactIds = ref.artifactIds.filter((item) => item !== id);
        if (ref.selectedArtifactId === id) ref.selectedArtifactId = null;
        persistProject(dir, project);
        return ref;
    }

    /** 渲染用产物 URL：选中产物优先 → metadata.artifactUrl → artifactIds[0]；都取不到返回空串。 */
    function renderUrl(ref) {
        if (ref.selectedArtifactId) return String(ref.selectedArtifactId);
        const meta = ref.metadata && typeof ref.metadata === "object" ? ref.metadata : {};
        if (meta.artifactUrl) return String(meta.artifactUrl);
        const first = Array.isArray(ref.artifactIds) ? ref.artifactIds[0] : "";
        return first ? String(first) : "";
    }

    /**
     * 跨项目资产总览（只读聚合）：把全部活动项目的 AssetRef 摊平成带项目归属的记录，
     * 并把常用字段（role/kind/name/url/artifactCount…）解析好，让前端不必猜字段层级；
     * 同时给出按 role、按项目的计数，供筛选项与页头统计。
     * 排序：项目按 updatedAt 新→旧，组内按 id 的 ULID 时序新→旧。
     * 容错：project.json 缺失/损坏、assetRefs 非数组、单条引用损坏 → 跳过并记 warning，绝不 500。
     */
    function overview() {
        const warnings = [];
        const root = join(dataDir, "projects");
        let entries = [];
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch (error) {
            warnings.push(`项目目录不可读：${error.message}`);
            return { assetRefs: [], counts: { total: 0, byRole: {}, byProject: [] }, warnings };
        }
        const rows = [];
        const byRole = {};
        const projects = new Map();
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const project = readJson(join(root, entry.name, "project.json"));
            if (!project || typeof project !== "object") {
                warnings.push(`跳过损坏项目：${entry.name}`);
                continue;
            }
            if (project.assetRefs !== undefined && !Array.isArray(project.assetRefs)) {
                warnings.push(`跳过损坏项目：${entry.name}（assetRefs 非数组）`);
                continue;
            }
            const projectId = String(project.id ?? entry.name);
            const projectTitle = String(project.title ?? projectId);
            const updatedAt = String(project.updatedAt ?? "");
            const refs = Array.isArray(project.assetRefs) ? project.assetRefs : [];
            for (const ref of refs) {
                if (!ref || typeof ref !== "object") {
                    warnings.push(`跳过损坏资产引用：${projectId}`);
                    continue;
                }
                const meta = ref.metadata && typeof ref.metadata === "object" ? ref.metadata : {};
                const role = String(ref.role ?? "");
                rows.push({
                    id: String(ref.id ?? ""),
                    projectId,
                    projectTitle,
                    role,
                    kind: meta.kind ? String(meta.kind) : "",
                    name: meta.name ? String(meta.name) : String(ref.bindingId ?? ""),
                    bindingId: String(ref.bindingId ?? ""),
                    url: renderUrl(ref),
                    artifactCount: Array.isArray(ref.artifactIds) ? ref.artifactIds.length : 0,
                    episodeId: ref.episodeId ? String(ref.episodeId) : "",
                    sceneId: ref.sceneId ? String(ref.sceneId) : "",
                    shotId: ref.shotId ? String(ref.shotId) : "",
                    stageId: meta.stageId ? String(meta.stageId) : "",
                    createdAt: ref.createdAt ? String(ref.createdAt) : null,
                    updatedAt: ref.updatedAt ? String(ref.updatedAt) : null,
                });
                byRole[role] = (byRole[role] ?? 0) + 1;
                const current = projects.get(projectId) ?? { projectId, projectTitle, count: 0, updatedAt };
                current.count += 1;
                projects.set(projectId, current);
            }
        }
        // 项目序：updatedAt 新→旧（缺失回落 projectId），组内按 id 的 ULID 时序新→旧。
        const order = new Map(
            [...projects.values()]
                .sort((a, b) => {
                    const byTime = String(b.updatedAt).localeCompare(String(a.updatedAt));
                    return byTime !== 0 ? byTime : b.projectId.localeCompare(a.projectId);
                })
                .map((item, index) => [item.projectId, index]),
        );
        rows.sort((a, b) => {
            const diff = (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0);
            return diff !== 0 ? diff : String(b.id).localeCompare(String(a.id));
        });
        const byProject = [...projects.values()]
            .map(({ projectId, projectTitle, count }) => ({ projectId, projectTitle, count }))
            .sort((a, b) => b.count - a.count || a.projectTitle.localeCompare(b.projectTitle));
        return { assetRefs: rows, counts: { total: rows.length, byRole, byProject }, warnings };
    }

    return { list, create, update, select, unlink, overview };
}

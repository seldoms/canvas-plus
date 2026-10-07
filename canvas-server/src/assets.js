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

    /**
     * 归入资料包（upsert 语义）——「把一个产物挂到某个实体上」的第一等入口。
     *
     * 为什么必须有它，而不是让调用方自己 create：
     *   - `create` 每调一次就**新增一条** AssetRef。同一个角色归入三张图会得到三条同 bindingId 的引用，
     *     而 reference-lock 的 findAssetRef 只取第一条 —— 这就是 asset-consistency.js 里
     *     duplicate-binding 检查对应的那个坑（选参考图随机命中）。
     *   - 换句话说，「归入」被写成了「新增」，幂等性被推给每个调用方（前端、Agent、流水线），
     *     实际上谁都没做好。upsert 必须收在存储层，否则重复引用会持续产生。
     *
     * 语义：同 role + 同 bindingId 视为同一条引用，产物**追加**进 artifactIds（去重、保时序）；
     * 没有已采用的产物时自动采用本次归入的那个（除非显式 select:false）。
     * 不同 bindingId / 不同 role 一律新建 —— 不同实体就是不同条目，不合并。
     */
    function attach(projectId, input = {}) {
        const { project, dir } = requireProject(projectId);
        const body = input && typeof input === "object" ? input : {};
        assertRole(body.role);
        const role = String(body.role);
        const bindingId = String(body.bindingId ?? "").trim();
        if (!bindingId) throw badRequest("归入资料包缺少绑定锚点 bindingId");
        const artifactId = String(body.artifactId ?? "").trim();
        if (!artifactId) throw badRequest("归入资料包缺少产物 artifactId");

        const incoming = [artifactId];
        for (const extra of requireArray(body.artifactIds ?? [], "artifactIds")) {
            const value = String(extra ?? "").trim();
            if (value && !incoming.includes(value)) incoming.push(value);
        }

        // 归因元数据：让「这个产物是哪次生成、哪个阶段产出的」在资料包里查得到，
        // 而不是只剩一条孤零零的 URL。这是「产物带归因即被项目看见」的落点。
        const meta = body.metadata && typeof body.metadata === "object" ? { ...body.metadata } : {};
        for (const key of ["sourceJobId", "stageId", "kind", "name"]) {
            const value = String(body[key] ?? "").trim();
            if (value) meta[key] = value;
        }

        const existing = refsOf(project).find((ref) => ref.role === role && String(ref.bindingId ?? "").trim() === bindingId);
        if (existing) {
            const merged = Array.isArray(existing.artifactIds) ? [...existing.artifactIds] : [];
            let added = 0;
            for (const id of incoming) {
                if (merged.includes(id)) continue;
                merged.push(id);
                added += 1;
            }
            existing.artifactIds = merged;
            if (!existing.metadata || typeof existing.metadata !== "object") existing.metadata = {};
            // metadata 只补空、不覆盖：后一次归入不该把先前的来源信息抹掉。
            for (const [key, value] of Object.entries(meta)) {
                if (existing.metadata[key] === undefined || existing.metadata[key] === "") existing.metadata[key] = value;
            }
            for (const key of ["episodeId", "sceneId", "shotId"]) if (body[key]) existing[key] = String(body[key]);

            if (body.select === false) {
                // 显式不采用：只进候选池等人工选，不猜、不覆盖已有采用。
            } else if (body.selectedArtifactId !== undefined && body.selectedArtifactId !== null && String(body.selectedArtifactId).trim()) {
                const wanted = String(body.selectedArtifactId).trim();
                if (!merged.includes(wanted)) throw badRequest(`selectedArtifactId 不在 artifactIds 内：${wanted}`);
                existing.selectedArtifactId = wanted;
            } else if (!existing.selectedArtifactId && incoming.length) {
                existing.selectedArtifactId = incoming[0];
            }
            assertSelection(existing);
            persistProject(dir, project);
            return { assetRef: existing, created: false, addedArtifactIds: added };
        }

        const assetRef = {
            id: `as_${ulid()}`,
            projectId: project.id,
            role,
            bindingId,
            artifactIds: incoming,
            selectedArtifactId: null,
            metadata: meta,
        };
        if (body.select !== false) assetRef.selectedArtifactId = incoming[0];
        for (const key of ["episodeId", "sceneId", "shotId"]) if (body[key]) assetRef[key] = String(body[key]);
        project.assetRefs = [...refsOf(project), assetRef];
        persistProject(dir, project);
        return { assetRef, created: true, addedArtifactIds: incoming.length };
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

    return { list, create, attach, update, select, unlink, overview };
}

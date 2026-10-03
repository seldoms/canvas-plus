import { ASSET_ROLE } from "./contracts.js";

/**
 * AssetRef 存储内核（P0-a 深水区）。
 * 只登记引用，不复制 artifact 字节（D2）；实体挂在 project.json 的 assetRefs[] 上。
 * bindingId 是角色/场景/道具的一致性锚点；role 取值见 contracts.js 的 ASSET_ROLE。
 */

const ROLES = new Set(Object.values(ASSET_ROLE));
const MUTABLE = new Set(["role", "bindingId", "artifactIds", "selectedArtifactId", "metadata", "episodeId", "sceneId", "shotId"]);

export function createAssets(store) {
    const { ulid, badRequest, httpError, requireArray, requireProject, persistProject } = store;

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

    return { list, create, update, select, unlink };
}

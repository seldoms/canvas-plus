import type { AssetRef, AssetRole } from "@/types/domain";

import type { AssetRefPatchInput } from "@/services/api/projects";

/**
 * 资产工作区纯函数：AssetRef 分组、作用范围判定、绑定名解析与 PATCH body 组装。
 * 只做数据整形，不发请求；契约见 domain-contract §3.8。
 */

/** 展示顺序与 role 枚举一致（character/scene/prop/keyframe/clip）。 */
export const ASSET_ROLES: AssetRole[] = ["character", "scene", "prop", "keyframe", "clip"];

export type AssetRefGroup = { role: AssetRole; refs: AssetRef[] };

/** 按 role 分组；组序固定，组内按 bindingId 排列，空组不产出。 */
export function groupAssetRefs(refs: AssetRef[]): AssetRefGroup[] {
    return ASSET_ROLES.map((role) => ({
        role,
        refs: refs.filter((ref) => ref.role === role).sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
    })).filter((group) => group.refs.length > 0);
}

/** 引用的作用范围：镜 → 场 → 集 → 项目，取最具体的一层。 */
export function assetRefScope(ref: AssetRef): "shot" | "scene" | "episode" | "project" {
    if (ref.shotId) return "shot";
    if (ref.sceneId) return "scene";
    if (ref.episodeId) return "episode";
    return "project";
}

/** 缩略图对应的产物：优先采用的，其次第一条候选；都没有返回空串（渲染层给占位）。 */
export function assetRefCover(ref: AssetRef): string {
    return ref.selectedArtifactId || ref.artifactIds[0] || "";
}

/** 是否已采用候选产物。 */
export function assetRefAdopted(ref: AssetRef): boolean {
    return Boolean(ref.selectedArtifactId);
}

/** 剧本里能解析出人读名称的实体：characters[{id,name}]、scenes[{id,title,location}]。 */
type ScriptEntity = { id: string; name: string };

function scriptEntities(script: unknown, keys: string[]): ScriptEntity[] {
    if (!script || typeof script !== "object") return [];
    const record = script as Record<string, unknown>;
    const entities: ScriptEntity[] = [];
    for (const key of keys) {
        const list = record[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const row = item as Record<string, unknown>;
            const id = typeof row.id === "string" ? row.id.trim() : "";
            const name = [row.name, row.title, row.location].find((value) => typeof value === "string" && value.trim());
            if (id && typeof name === "string") entities.push({ id, name: name.trim() });
        }
    }
    return entities;
}

/**
 * 绑定对象的人读名称：先查剧本 characters / scenes 里同 id 的条目，
 * 再用 AssetRef.metadata.name（流水线登记时写入），都取不到回落到 bindingId。
 */
export function bindingName(ref: AssetRef, script: unknown): string {
    const keys = ref.role === "character" ? ["characters"] : ref.role === "scene" ? ["scenes"] : ["characters", "scenes"];
    const match = scriptEntities(script, keys).find((entity) => entity.id === ref.bindingId);
    if (match) return match.name;
    const metaName = typeof ref.metadata?.name === "string" ? ref.metadata.name.trim() : "";
    return metaName || ref.bindingId;
}

/** 组装 PATCH body：只带真正改动的字段，未改不写。 */
export function buildAssetRefPatch(original: AssetRef, draft: { bindingId: string; selectedArtifactId: string | null }): AssetRefPatchInput {
    const patch: AssetRefPatchInput = {};
    const bindingId = draft.bindingId.trim();
    if (bindingId && bindingId !== original.bindingId) patch.bindingId = bindingId;
    if (draft.selectedArtifactId !== original.selectedArtifactId) patch.selectedArtifactId = draft.selectedArtifactId;
    return patch;
}

/** 候选产物短标识：artifact id 通常较长，列表里截断展示。 */
export function shortId(id: string, length = 10) {
    return id.length > length ? `${id.slice(0, length)}…` : id;
}

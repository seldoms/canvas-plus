import type { AssetRef, AssetRole } from "@/types/domain";

import type { AssetRefPatchInput } from "@/services/api/projects";

/**
 * 资产工作区纯函数：AssetRef 分组、作用范围判定与 PATCH body 组装。
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

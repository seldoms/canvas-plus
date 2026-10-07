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

/* ------------------------------------------------------------------ *
 * 资料包聚合（P1）
 * ------------------------------------------------------------------ */

/** 资料包的角色类别：只有这三类有「剧本里应当存在」的实体清单。keyframe/clip 是镜头级产物，不进包。 */
export const PACK_ROLES = ["character", "scene", "prop"] as const;
export type PackRole = (typeof PACK_ROLES)[number];

/** 单个实体在资料包里的状态：已采用 / 有候选待选 / 剧本里有但一条都没归入。 */
export type PackStatus = "adopted" | "candidates" | "missing";

export type PackEntry = {
    bindingId: string;
    name: string;
    status: PackStatus;
    candidateCount: number;
    /** 采用中的产物（相对路径）；无则空串。 */
    url: string;
    refId: string | null;
    /** 产物来源（metadata.sourceJobId / stageId），归因可查时才非空。 */
    source: string;
};

export type AssetPack = {
    role: PackRole;
    entries: PackEntry[];
    /** 剧本里应当存在的实体数（道具类剧本无清单，为 0）。 */
    expected: number;
    adopted: number;
    missing: number;
};

/**
 * 把 AssetRef 聚合成「资料包」视角：**以剧本实体为主轴**，而不是以引用条目为主轴。
 *
 * 为什么必须换主轴：原AssetRefPanel 按 role 分组列引用，看不出「这部戏有哪几个角色、
 * 哪个还没锁参考图」—— 而这正是定妆/服化道阶段要回答的问题。
 * 现在每个剧本实体占一行，缺图的角色一眼可见，缺口不会再静默溜过去。
 *
 * 剧本里没有清单的类别（道具）只列已登记的引用，expected=0，不假装知道该有几个。
 */
export function buildAssetPacks(refs: AssetRef[], script: unknown): AssetPack[] {
    const list = Array.isArray(refs) ? refs : [];
    return PACK_ROLES.map((role) => {
        const roleRefs = list.filter((ref) => ref.role === role);
        const expected = role === "prop" ? [] : scriptEntities(script, role === "character" ? ["characters"] : ["scenes"]);
        const byBinding = new Map(roleRefs.map((ref) => [ref.bindingId, ref]));
        // 剧本实体在前（缺口要显眼），剧本外的引用排在后面（多半是道具或临时登记）。
        const extra = roleRefs.filter((ref) => !expected.some((entity) => entity.id === ref.bindingId));
        const rows: PackEntry[] = [
            ...expected.map((entity) => toPackEntry(entity.id, packEntityName(role, entity, script), byBinding.get(entity.id))),
            ...extra.map((ref) => toPackEntry(ref.bindingId, bindingName(ref, script), ref)),
        ];
        return {
            role,
            entries: rows,
            expected: expected.length,
            adopted: rows.filter((row) => row.status === "adopted").length,
            missing: rows.filter((row) => row.status === "missing").length,
        };
    }).filter((pack) => pack.entries.length > 0);
}

/**
 * 场景实体要显示**地点名**（渡轮驾驶室），不是场次标题（夜航对话）。
 *
 * 这不是审美问题：门禁与reference-lock 都按纯地点名匹配 assetRef.bindingId，
 * 页面上显示「夜航对话」而绑定的是「渡轮驾驶室」，用户会以为绑定错了而去改它 —— 越改越坏。
 */
function packEntityName(role: PackRole, entity: ScriptEntity, script: unknown): string {
    if (role !== "scene") return entity.name;
    const rows = script && typeof script === "object" ? (script as Record<string, unknown>).scenes : null;
    const row = Array.isArray(rows) ? rows.find((item) => (item as Record<string, unknown>)?.id === entity.id) : null;
    const location = (row as Record<string, unknown> | null)?.location;
    return typeof location === "string" && location.trim() ? location.trim() : entity.name;
}

function toPackEntry(bindingId: string, name: string, ref: AssetRef | undefined): PackEntry {
    const adopted = Boolean(ref?.selectedArtifactId);
    const candidateCount = ref?.artifactIds.length ?? 0;
    const meta = ref?.metadata ?? {};
    const source = [meta.stageId, meta.sourceJobId].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" · ");
    return {
        bindingId,
        name,
        status: adopted ? "adopted" : candidateCount > 0 ? "candidates" : "missing",
        candidateCount,
        url: ref ? assetRefCover(ref) : "",
        refId: ref?.id ?? null,
        source,
    };
}

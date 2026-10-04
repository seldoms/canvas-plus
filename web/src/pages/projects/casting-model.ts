import { resolveGatewayUrl, type GatewayArtifact, type GatewayPipelineRun } from "@/services/api/gateway";
import type { CastingCharacter, CastingFace, CastingScope, CastingVoice } from "@/services/api/casting";

/**
 * 「角色定妆」工作区纯逻辑：把 `run.stages.casting.output.characters[]`（身份卡契约）摊成
 * 渲染层直接可用的视图对象；并提供确认 / 修改的不可变更新函数与「下游拦截」推导。
 *
 * 零 IO、零 React：只读传入的数据、只产出结构，便于单测与复用。
 */

export type CastingCharacterView = CastingCharacter & {
    /** 正脸特写可渲染 URL（空串 = 未生成）。 */
    closeupUrl: string;
    /** 三视图可渲染 URL 列表。 */
    turnaroundUrls: string[];
    /** 试听产物可渲染 URL（空串 = 未试听）。 */
    previewUrl: string;
    /** 是否已生成正脸特写。 */
    hasFace: boolean;
};

/** 一个未确认角色缺什么：脸 / 声。 */
export type CastingBlocker = { characterId: string; name: string; missing: Array<"face" | "voice"> };

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown, fallback = 1) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** 产物 id → 可渲染 URL：id 本身是路径/URL 就直接用；否则在阶段产物里按包含关系兜底匹配。 */
function assetUrl(id: string, artifacts: GatewayArtifact[]): string {
    if (!id) return "";
    if (/^(https?:|data:|blob:|\/)/i.test(id)) return resolveGatewayUrl(id);
    const hit = artifacts.find((artifact) => artifact.url && artifact.url.includes(id));
    return hit ? resolveGatewayUrl(hit.url) : "";
}

function normalizeFace(raw: unknown): CastingFace {
    const value = record(raw) ?? {};
    return {
        closeupArtifactId: text(value.closeupArtifactId),
        turnaroundArtifactIds: stringList(value.turnaroundArtifactIds),
        confirmed: value.confirmed === true,
    };
}

function normalizeVoice(raw: unknown): CastingVoice {
    const value = record(raw) ?? {};
    return {
        voiceProfileId: text(value.voiceProfileId),
        speaker: text(value.speaker),
        design: text(value.design),
        speed: number(value.speed, 1),
        language: text(value.language),
        previewArtifactId: text(value.previewArtifactId),
        confirmed: value.confirmed === true,
    };
}

function normalizeCharacter(raw: unknown, index: number): CastingCharacter | null {
    const value = record(raw);
    if (!value) return null;
    const characterId = text(value.characterId) || `c${index + 1}`;
    return {
        characterId,
        name: text(value.name) || characterId,
        face: normalizeFace(value.face),
        voice: normalizeVoice(value.voice),
        confirmed: value.confirmed === true,
        version: number(value.version, 1),
        lockedAt: typeof value.lockedAt === "string" && value.lockedAt ? value.lockedAt : null,
    };
}

const castingArtifacts = (run: GatewayPipelineRun | null): GatewayArtifact[] => run?.stages?.casting?.artifacts ?? [];

/** run 的 casting 角色清单；缺阶段或形状不对时返回空数组。 */
export function castingCharacters(run: GatewayPipelineRun | null): CastingCharacter[] {
    const output = record(run?.stages?.casting?.output);
    const characters = output?.characters;
    if (!Array.isArray(characters)) return [];
    return characters.map((raw, index) => normalizeCharacter(raw, index)).filter((item): item is CastingCharacter => Boolean(item));
}

/** 角色清单 → 视图对象（解析产物 URL）。 */
export function buildCastingViews(run: GatewayPipelineRun | null): CastingCharacterView[] {
    const artifacts = castingArtifacts(run);
    return castingCharacters(run).map((character) => {
        const closeupUrl = assetUrl(character.face.closeupArtifactId, artifacts);
        return {
            ...character,
            closeupUrl,
            turnaroundUrls: character.face.turnaroundArtifactIds.map((id) => assetUrl(id, artifacts)).filter(Boolean),
            previewUrl: assetUrl(character.voice.previewArtifactId, artifacts),
            hasFace: Boolean(closeupUrl),
        };
    });
}

/**
 * 「拦住要可见」推导：casting 未产出，或存在未确认角色（脸 / 声缺一即算）时，
 * 关键帧 / 配音两个下游阶段被阻断。返回逐角色缺什么，供复用既有 blocked 文案渲染。
 */
export function castingBlockers(characters: CastingCharacter[]): CastingBlocker[] {
    const blockers: CastingBlocker[] = [];
    for (const character of characters) {
        const missing: Array<"face" | "voice"> = [];
        if (!character.face.confirmed) missing.push("face");
        if (!character.voice.confirmed) missing.push("voice");
        if (missing.length) blockers.push({ characterId: character.characterId, name: character.name, missing });
    }
    return blockers;
}

/** casting 阶段是否算完成：产出了角色且无未确认项。 */
export function castingComplete(run: GatewayPipelineRun | null): boolean {
    const characters = castingCharacters(run);
    return characters.length > 0 && castingBlockers(characters).length === 0;
}

/** 确认 / 修改某一范围（脸 / 声 / 角色）；修改（confirmed=false）时 version+1 且清 lockedAt。 */
export function setConfirmation(characters: CastingCharacter[], characterId: string, scope: CastingScope, confirmed: boolean): CastingCharacter[] {
    return characters.map((character) => {
        if (character.characterId !== characterId) return character;
        const face = { ...character.face };
        const voice = { ...character.voice };
        if (scope === "face" || scope === "all") face.confirmed = confirmed;
        if (scope === "voice" || scope === "all") voice.confirmed = confirmed;
        const overall = face.confirmed && voice.confirmed;
        return {
            ...character,
            face,
            voice,
            confirmed: overall,
            version: confirmed ? character.version : character.version + 1,
            lockedAt: overall ? character.lockedAt ?? new Date().toISOString() : null,
        };
    });
}

/**
 * 改音色字段（音色名 / 描述 / 语速 / 语言）。已确认的声音被改动即视为「修改」：
 * 取消声音确认、version+1、清 lockedAt，需重新确认。
 */
export function updateVoice(characters: CastingCharacter[], characterId: string, patch: Partial<Pick<CastingVoice, "speaker" | "design" | "speed" | "language">>): CastingCharacter[] {
    return characters.map((character) => {
        if (character.characterId !== characterId) return character;
        const voice = { ...character.voice, ...patch };
        const changed = (Object.keys(patch) as Array<keyof typeof patch>).some((key) => patch[key] !== character.voice[key]);
        if (!changed) return character;
        const wasConfirmed = character.voice.confirmed;
        return {
            ...character,
            // 音色参数一变，原确认即失效，需重新确认（若此前已确认则 version+1）。
            voice: { ...voice, confirmed: false },
            confirmed: false,
            version: wasConfirmed ? character.version + 1 : character.version,
            lockedAt: null,
        };
    });
}

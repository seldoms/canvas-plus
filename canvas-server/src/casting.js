/**
 * 角色定妆（Casting）身份卡契约层 —— 「锁脸锁声音」的**唯一事实源**。
 *
 * 产品口径（产品负责人拍板，2026-10-04）：
 *   角色定妆是**独立环节**（从服化道里拆出来），和关键帧一样重要；只做两件事 —— **定脸 + 定声音**；
 *   **未确认不得进下游**（keyframe / audio 被拦住）；声音从平台音色库中选（见 voices.js）。
 *
 * 身份卡冻结契约（字段名不得改，见 skills/03b-casting/SKILL.md）：
 *   {
 *     "characters": [{
 *       "characterId": "c1",
 *       "name": "阿海",
 *       "face": { "closeupArtifactId": "", "turnaroundArtifactIds": [], "confirmed": false },
 *       "voice": { "voiceProfileId": "vp_c1", "speaker": "Uncle_fu", "design": "低沉沙哑，语速偏慢",
 *                  "speed": 1, "language": "Chinese", "previewArtifactId": "", "confirmed": false },
 *       "confirmed": false,      // = 脸与声都真
 *       "version": 1,
 *       "lockedAt": null
 *     }]
 *   }
 *
 * 本模块是**纯逻辑**：不读盘、不发网络请求、不 import pipeline.js。
 *   - face 的产物 id **复用**现有参考图链路（design 阶段的 closeupPrompt / turnaroundPrompt →
 *     design.output.references → artifactUrl），这里只做「从 design 产物里取脸」的读取与归一，不重写生成/绑定；
 *   - voice 的 speaker / language **只能**取自平台音色库（voices.js），非法值在本文与接口层双重拦截；
 *   - confirmed 分三级：face.confirmed / voice.confirmed / 角色 confirmed（= 两者都真）。
 */

import { QWEN3_TTS_DEFAULT_LANGUAGE, QWEN3_TTS_DEFAULT_SPEAKER, isLanguageAllowed, isSpeakerAllowed, qwen3Language, qwen3Speaker } from "./voices.js";

/** 角色定妆产物契约版本。 */
export const CASTING_CONTRACT_VERSION = 1;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null && String(value).trim() !== "";
const str = (value) => (value === undefined || value === null ? "" : String(value).trim());
const num = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/** 空脸（未生成产物、未确认）。 */
export function emptyFace() {
    return { closeupArtifactId: "", turnaroundArtifactIds: [], confirmed: false };
}

/** 空声音（未选音色、未确认）。 */
export function emptyVoice() {
    return { voiceProfileId: "", speaker: "", design: "", speed: 1, language: QWEN3_TTS_DEFAULT_LANGUAGE, previewArtifactId: "", confirmed: false };
}

/** 归一 face：保证三键在位；artifact id 收敛为字符串 / 字符串数组。 */
export function normalizeFace(raw) {
    const object = isPlainObject(raw) ? raw : {};
    const turnaround = Array.isArray(object.turnaroundArtifactIds) ? object.turnaroundArtifactIds.map(str).filter(Boolean) : [];
    return {
        closeupArtifactId: str(object.closeupArtifactId),
        turnaroundArtifactIds: turnaround,
        confirmed: object.confirmed === true,
    };
}

/** 归一 voice：保证七键在位；speaker/language 出界时回落为默认（不静默保留非法值）。 */
export function normalizeVoice(raw) {
    const object = isPlainObject(raw) ? raw : {};
    const speaker = str(object.speaker);
    const language = str(object.language);
    const speed = num(object.speed);
    return {
        voiceProfileId: str(object.voiceProfileId),
        speaker: isSpeakerAllowed(speaker) ? speaker : "",
        design: str(object.design),
        speed: speed !== null && speed > 0 ? speed : 1,
        language: isLanguageAllowed(language) ? language : QWEN3_TTS_DEFAULT_LANGUAGE,
        previewArtifactId: str(object.previewArtifactId),
        confirmed: object.confirmed === true,
    };
}

/** 脸是否「已确认真实」：确认过 + 至少有一张产物（正脸特写或三视图）。 */
export function faceReady(face) {
    const normalized = normalizeFace(face);
    const hasArtifact = nonEmpty(normalized.closeupArtifactId) || normalized.turnaroundArtifactIds.length > 0;
    return normalized.confirmed === true && hasArtifact;
}

/** 声音是否「已确认真实」：确认过 + 音色是平台合法枚举。 */
export function voiceReady(voice) {
    const normalized = normalizeVoice(voice);
    return normalized.confirmed === true && isSpeakerAllowed(normalized.speaker);
}

/** 归一单张身份卡（兼容旧数据：缺字段补默认，非法枚举回落）。 */
export function normalizeCharacterCard(raw, index = 0) {
    const object = isPlainObject(raw) ? raw : {};
    const characterId = str(object.characterId ?? object.id) || `c${index + 1}`;
    const version = num(object.version);
    const card = {
        characterId,
        name: str(object.name),
        face: normalizeFace(object.face),
        voice: normalizeVoice(object.voice),
        confirmed: object.confirmed === true,
        version: version !== null && version >= 1 ? Math.floor(version) : 1,
        lockedAt: nonEmpty(object.lockedAt) ? str(object.lockedAt) : null,
    };
    // 角色 confirmed 必须与「脸 + 声都真」自洽：写了 true 但实际不满足时如实回落 false。
    card.confirmed = card.confirmed === true && faceReady(card.face) && voiceReady(card.voice);
    if (!card.confirmed) card.lockedAt = null;
    return card;
}

/** 归一整个 casting 产物（旧数据 / 缺字段一律补全，绝不抛错）。 */
export function normalizeCasting(output) {
    const characters = Array.isArray(output?.characters) ? output.characters.map((card, index) => normalizeCharacterCard(card, index)) : [];
    return { characters };
}

/**
 * 从 design 产物里取某角色的**脸产物**（复用现有参考图链路，不重写生成/绑定）。
 * 优先 design.output.references 里该角色的 closeup / turnaround 条目（绑定时写入 artifactUrl）；
 * 回落 design.characters[].referenceArtifactIds / turnaroundArtifactIds（LLM 直接产出的字段）。
 */
export function faceArtifactsFor(design, characterId) {
    const id = str(characterId);
    const refs = Array.isArray(design?.references) ? design.references : [];
    const mine = refs.filter((ref) => str(ref?.bindingId) === id && (str(ref?.role) === "character" || str(ref?.role) === ""));
    const closeup = mine.find((ref) => str(ref?.kind) === "closeup" && nonEmpty(ref?.artifactUrl));
    const turnarounds = mine.filter((ref) => str(ref?.kind) === "turnaround" && nonEmpty(ref?.artifactUrl)).map((ref) => str(ref.artifactUrl));
    const designChar = characterFor(design, id);
    const legacyCloseup = Array.isArray(designChar?.referenceArtifactIds) ? str(designChar.referenceArtifactIds[0]) : str(designChar?.referenceArtifactIds);
    const legacyTurn = Array.isArray(designChar?.turnaroundArtifactIds) ? designChar.turnaroundArtifactIds.map(str).filter(Boolean) : [];
    return {
        closeupArtifactId: str(closeup?.artifactUrl) || legacyCloseup,
        turnaroundArtifactIds: turnarounds.length ? turnarounds : legacyTurn,
    };
}

/** 按 id（其次 name）在 design.characters 里找角色。 */
function characterFor(design, idOrName) {
    const key = str(idOrName);
    if (!key) return null;
    const list = Array.isArray(design?.characters) ? design.characters : [];
    return list.find((item) => str(item?.id) === key) || list.find((item) => str(item?.name) === key) || null;
}

/**
 * 组装 casting 产物：从剧本角色 + design 脸产物 + VoiceProfile 声音事实，确定性生成身份卡。
 * - face：**复用** design 参考图产物（closeupArtifactId / turnaroundArtifactIds），本轮取不到就沿用 prev；
 * - voice：speaker 经 voices.js 适配成合法枚举，language 归一为枚举，design/speed 取内容层事实；
 * - 确认状态：本轮**不改变** face/voice 的 confirmed（确认是人做的动作）——只在新产物里保持一致与自洽；
 *   本轮结构变化（如换角色）时旧确认自然失效（新卡默认未确认）。
 * @param {object} args
 * @param {Array}  [args.characters]   剧本角色数组（characters[].id/.name）
 * @param {object} [args.design]       03 服化道产物（含 references / characters）
 * @param {Array}  [args.voiceProfiles] projectVoiceProfiles 产出的 VoiceProfile 超集
 * @param {object} [args.prev]         上一次 casting 产物（用于继承已确认状态）
 */
export function buildCastingOutput({ characters = [], design = null, voiceProfiles = [], prev = null } = {}) {
    const prevById = new Map((Array.isArray(prev?.characters) ? prev.characters : []).map((card) => [str(card?.characterId ?? card?.id), card]));
    const profileById = new Map((Array.isArray(voiceProfiles) ? voiceProfiles : []).map((profile) => [str(profile?.characterId ?? profile?.id), profile]));
    const cards = [];
    (Array.isArray(characters) ? characters : []).forEach((character, index) => {
        const characterId = str(character?.id ?? character?.characterId);
        if (!characterId) return;
        const old = normalizeCharacterCard(prevById.get(characterId) || {}, index);
        const artifacts = faceArtifactsFor(design, characterId);
        const designChar = characterFor(design, characterId) || {};
        const profile = profileById.get(characterId) || null;

        const closeupArtifactId = artifacts.closeupArtifactId || old.face.closeupArtifactId;
        const turnaroundArtifactIds = artifacts.turnaroundArtifactIds.length ? artifacts.turnaroundArtifactIds : old.face.turnaroundArtifactIds;
        const face = {
            closeupArtifactId,
            turnaroundArtifactIds: [...turnaroundArtifactIds],
            // 本轮产物仍在（或曾被确认过且产物未丢）才保留「脸已确认」；否则如实回落 false。
            confirmed: old.face.confirmed === true && (nonEmpty(closeupArtifactId) || turnaroundArtifactIds.length > 0),
        };

        const rawSpeaker = str(profile?.speaker);
        const speaker = isSpeakerAllowed(rawSpeaker) ? rawSpeaker : (old.voice.speaker || qwen3Speaker(profile || {}, character || designChar));
        const language = isLanguageAllowed(str(profile?.language)) ? str(profile.language) : qwen3Language(profile?.language || designChar?.language);
        const designText = str(profile?.design || profile?.timbre || designChar?.design || designChar?.voiceDesign || old.voice.design);
        const speed = num(profile?.speed) ?? old.voice.speed ?? 1;
        const voice = {
            voiceProfileId: str(profile?.id) || old.voice.voiceProfileId || "",
            speaker,
            design: designText,
            speed: speed > 0 ? speed : 1,
            language,
            previewArtifactId: old.voice.previewArtifactId || "",
            confirmed: old.voice.confirmed === true && isSpeakerAllowed(speaker),
        };

        const card = {
            characterId,
            name: str(character?.name) || old.name,
            face,
            voice,
            confirmed: face.confirmed === true && voice.confirmed === true,
            version: old.version || 1,
            lockedAt: old.lockedAt,
        };
        if (!card.confirmed) card.lockedAt = null;
        cards.push(card);
    });
    return { characters: cards };
}

/**
 * 角色定妆就绪度（门禁唯一判据）：
 *   ready = 有角色 且 每个角色的脸与声音都已确认真实。
 * blocked 逐角色列出**缺什么**（脸 / 声音），供 blockedReason 文案与前端定位。
 */
export function castingReadiness(output) {
    const cards = Array.isArray(output?.characters) ? output.characters.map((card, index) => normalizeCharacterCard(card, index)) : [];
    const characters = cards.map((card) => {
        const missing = [];
        if (!faceReady(card.face)) missing.push("脸");
        if (!voiceReady(card.voice)) missing.push("声音");
        return { characterId: card.characterId, name: card.name || card.characterId, faceReady: faceReady(card.face), voiceReady: voiceReady(card.voice), confirmed: card.confirmed === true, missing };
    });
    const blocked = characters.filter((card) => card.missing.length > 0);
    const present = cards.length > 0;
    const ready = present && blocked.length === 0;
    return { present, ready, characters, blocked, reason: ready ? "" : castingBlockReason(present, blocked) };
}

/** 生成可读的拦截原因（写进 keyframe / audio 的 blockedReason / error）。 */
export function castingBlockReason(present, blocked) {
    if (!present) return "角色定妆尚未产出：casting 阶段没有角色身份卡，请先完成「角色定妆」（定脸 + 定声音）";
    const detail = blocked.map((card) => `角色「${card.name}」缺 ${card.missing.join("、")}`).join("；");
    return `角色定妆未完成，不能进入下游：${detail}。请先在「角色定妆」确认真脸与声音`;
}

/** 是否所有角色都已确认真实（供调用方快速判真）。 */
export function isCastingConfirmed(output) {
    return castingReadiness(output).ready;
}

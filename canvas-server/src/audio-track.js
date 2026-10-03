/**
 * 声音生产对象投影层：把 VoiceProfile 与 AudioCue 从「剧本 / 分镜 / 资产」归一，
 * 并幂等投影到 Project 侧，供门禁与交付读取。
 *
 * 设计见 docs/content/docs/progress/development-plan.md §11.5.1 与 §13.5：
 *   - VoiceProfile：角色音色锚点（§11.5.1 / 契约 §10.2）
 *   - AudioCue    ：时间轴上的声音条目（§13.5 / 契约 §10.2）
 *
 * 本模块是**纯逻辑 + 幂等投影**：
 *   - 不读磁盘、不发网络请求、不 import pipeline.js / projects.js；
 *   - Cue 的生成与逐条校验**复用已交付的 audio.js**（cuesFromShots / validateCues），不重写一遍；
 *   - 投影函数（applyAudioProjection）照 projects.js `persistDerived` 模式：相同跳过、
 *     已有非空集不覆盖、**不改 version**（派生记账不触发 D7 乐观并发冲突）。
 *
 * 字段兼容说明：契约 §10.2 冻结的 VoiceProfile 字段是
 *   `id / characterId / language / speaker / design / referenceArtifactId / version`，
 * AudioCue 字段是 `id / shotId / type / startSec / endSec / text / characterId / voiceProfileId / artifactId / status`。
 * audio.js 正是按这套字段挂载音色与校验。本层在此基础上**追加**便于门禁/前端读取的派生字段
 * （VoiceProfile：speakerId / name / timbre / speed；AudioCue：episodeId / speakerId / durationSec），
 * 因此输出对象是契约字段的超集，既能被 audio.js 直接消费，也满足以 `durationSec` 计时的读取方。
 */

import { cuesFromShots, validateCues } from "./audio.js";
import { PRODUCTION_ID_PREFIX } from "./contracts.js";

/** 需要绑定音色的声音类型（对白 / 旁白）。 */
const DIALOGUE_TYPES = new Set(["dialogue", "narration"]);

/** 默认语言（契约 §10.2：VoiceProfile.language 默认 zh-CN）。 */
const DEFAULT_LANGUAGE = "zh-CN";

/** 镜头缺失 durationSec 时给 Cue 的兜底时长（秒），与 audio.js 的 CUE_FALLBACK_SEC 对齐。 */
const CUE_FALLBACK_SEC = 3;

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

const num = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/** 返回第一个非空字符串（去空白）；全部为空时返回 fallback。 */
const firstNonEmpty = (...values) => {
    for (const value of values) {
        if (nonEmpty(value)) return String(value).trim();
    }
    return "";
};

/** 稳定 JSON 序列化，用于幂等比较（键序固定来自本模块构造的对象）。 */
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 正数版本号，非法/缺失时回落 1（契约 §10.2：version ≥ 1）。 */
const normalizeVersion = (value) => {
    const parsed = num(value);
    return parsed !== null && parsed >= 1 ? Math.floor(parsed) : 1;
};

// ---------------------------------------------------------------------------
// 1. VoiceProfile 归一
// ---------------------------------------------------------------------------

/**
 * 把 01 剧本的 `characters[].voice` + design 的角色信息归一到 VoiceProfile。
 *
 * 归一路径（后者仅在前面缺失时兜底）：
 *   id               ← character.voiceProfileId → voice.id → design.voiceProfileId → `vp_<characterId>`
 *   characterId      ← character.id（稳定身份）
 *   speakerId        ← characterId（说话角色的稳定 id，与 AudioCue.speakerId 同源）
 *   name             ← character.name → voice.name → design.name
 *   language         ← voice.language → design.language → project.plan.language → "zh-CN"
 *   timbre           ← voice.timbre → （字符串 voice）→ design.timbre → design.voice
 *   speed            ← voice.speed → design.speed → 1
 *   speaker          ← voice.speaker/speakerId → design.speaker/speakerId → timbre → name
 *   design           ← voice.design → design.design/voiceDesign → timbre
 *   referenceArtifactId ← voice.referenceArtifactId → design.referenceArtifactId → null
 *
 * `characters[].voice` 既可能是字符串（如剧本阶段提示词产出的音色描述），
 * 也可能是对象 `{ speaker, language, timbre, speed, design, ... }`，两种都支持。
 *
 * @param {object}  args
 * @param {object}  [args.project]     项目对象；用于回落 `project.script.characters` / `project.plan.language`。
 * @param {object}  [args.design]      03 服化道/资产阶段产物；从 `design.characters[]` 合并音色设计信息。
 * @param {Array}   [args.characters]  显式角色数组（优先于 project.script.characters）。
 * @returns {{profiles:Array, warnings:Array}} profiles 为 VoiceProfile 超集；warnings 逐条可解释。
 */
export function projectVoiceProfiles({ project, design, characters } = {}) {
    const warnings = [];
    const source = Array.isArray(characters)
        ? characters
        : Array.isArray(design?.characters)
            ? design.characters
            : Array.isArray(project?.script?.characters)
                ? project.script.characters
                : Array.isArray(project?.characters)
                    ? project.characters
                    : [];

    // design 角色索引：按 id 与 name 双键，便于与剧本角色合并。
    const designById = new Map();
    for (const item of Array.isArray(design?.characters) ? design.characters : []) {
        if (nonEmpty(item?.id)) designById.set(String(item.id).trim(), item);
        if (nonEmpty(item?.name)) designById.set(`name:${String(item.name).trim()}`, item);
    }

    const planLanguage = firstNonEmpty(project?.plan?.language, project?.plan?.locale);
    const profiles = [];
    const seenIds = new Set();

    source.forEach((character, index) => {
        if (!isPlainObject(character)) {
            warnings.push({ code: "invalid_character", message: `第 ${index + 1} 个角色不是对象，已跳过` });
            return;
        }
        const characterId = firstNonEmpty(character.id, `c${index + 1}`);
        const designChar = isPlainObject(designById.get(characterId))
            ? designById.get(characterId)
            : isPlainObject(designById.get(`name:${firstNonEmpty(character.name)}`))
                ? designById.get(`name:${firstNonEmpty(character.name)}`)
                : {};
        const voice = character.voice;
        const voiceObj = isPlainObject(voice) ? voice : {};

        const id = firstNonEmpty(
            character.voiceProfileId,
            voiceObj.id,
            designChar.voiceProfileId,
            `${PRODUCTION_ID_PREFIX.voiceProfile}${characterId}`,
        );
        if (seenIds.has(id)) {
            warnings.push({ code: "duplicate_voice_profile", profileId: id, message: `VoiceProfile「${id}」重复出现，已跳过后续同 id 角色` });
            return;
        }
        seenIds.add(id);

        const name = firstNonEmpty(character.name, voiceObj.name, designChar.name);
        const language = firstNonEmpty(voiceObj.language, designChar.language, planLanguage, DEFAULT_LANGUAGE);
        const timbre = firstNonEmpty(
            voiceObj.timbre,
            typeof voice === "string" ? voice : "",
            designChar.timbre,
            designChar.voice,
        );
        const designText = firstNonEmpty(voiceObj.design, designChar.design, designChar.voiceDesign, timbre);
        const speaker = firstNonEmpty(
            voiceObj.speaker,
            voiceObj.speakerId,
            designChar.speaker,
            designChar.speakerId,
            timbre,
            name,
        );
        const speed = num(voiceObj.speed ?? designChar.speed) ?? 1;
        const referenceArtifactId = firstNonEmpty(voiceObj.referenceArtifactId, designChar.referenceArtifactId) || null;

        if (!nonEmpty(name)) {
            warnings.push({ code: "missing_name", characterId, profileId: id, message: `角色「${characterId}」缺 name，VoiceProfile 只能以 id 标识` });
        }
        if (!timbre && !designText) {
            warnings.push({ code: "missing_timbre", characterId, profileId: id, message: `角色「${characterId}」缺 voice/timbre 描述，TTS 音色不可复现` });
        }
        if (!referenceArtifactId) {
            warnings.push({ code: "missing_reference", characterId, profileId: id, message: `VoiceProfile「${id}」缺 referenceArtifactId，口型对齐参考待补` });
        }

        profiles.push({
            id,
            characterId,
            speakerId: characterId,
            name,
            language,
            timbre,
            speed,
            // —— 以下为契约 §10.2 字段（audio.js 直接消费 speaker / design / referenceArtifactId / version）——
            speaker: speaker || characterId,
            design: designText,
            referenceArtifactId,
            version: normalizeVersion(character.voiceProfileVersion ?? voiceObj.version ?? designChar.version),
        });
    });

    return { profiles, warnings };
}

// ---------------------------------------------------------------------------
// 2. AudioCue 归一（复用 audio.js cuesFromShots）
// ---------------------------------------------------------------------------

/** 建立「场景 → 集」索引，供 Cue 归集 episodeId（项目 episodes 的 sceneIds 是唯一来源）。 */
function sceneToEpisodeIndex(project) {
    const index = new Map();
    for (const episode of Array.isArray(project?.episodes) ? project.episodes : []) {
        const episodeId = firstNonEmpty(episode?.id);
        if (!episodeId) continue;
        for (const sceneId of Array.isArray(episode?.sceneIds) ? episode.sceneIds : []) {
            if (nonEmpty(sceneId)) index.set(String(sceneId).trim(), episodeId);
        }
        for (const scene of Array.isArray(episode?.scenes) ? episode.scenes : []) {
            if (nonEmpty(scene?.id)) index.set(String(scene.id).trim(), episodeId);
        }
    }
    return index;
}

/**
 * 由分镜生成 AudioCue 列表。
 *
 * 生成规则**完全复用** audio.js 的 `cuesFromShots`（一句占满 / 多句均分 / 空对白不生成 / sfx·ambience·music 可选），
 * 本函数只做两件事：
 *   1. 从 `project.episodes[].sceneIds` 反查镜头所属 episodeId，补上 Project 侧归属；
 *   2. 补齐读取方需要的派生字段（speakerId = characterId、durationSec = endSec - startSec），
 *      并保留契约字段 endSec / characterId / artifactId。
 *
 * @param {object}  args
 * @param {object}  [args.project]        项目对象；用于脚本角色匹配与 episodeId 归属。
 * @param {object|Array} [args.storyboard] 分镜阶段产物（`{ shots: [...] }`）或镜头数组。
 * @param {Array}   [args.voiceProfiles]  VoiceProfile 数组；缺省回落 project.voiceProfiles。
 * @returns {Array} AudioCue[]（契约字段超集；无对白镜头返回空数组而非报错）。
 */
export function projectAudioCues({ project, storyboard, voiceProfiles } = {}) {
    const shots = Array.isArray(storyboard)
        ? storyboard
        : Array.isArray(storyboard?.shots)
            ? storyboard.shots
            : [];
    const characters = Array.isArray(project?.script?.characters)
        ? project.script.characters
        : Array.isArray(project?.characters)
            ? project.characters
            : [];
    const profiles = Array.isArray(voiceProfiles)
        ? voiceProfiles
        : Array.isArray(project?.voiceProfiles)
            ? project.voiceProfiles
            : [];

    const raw = cuesFromShots({ shots, characters, voiceProfiles: profiles });
    const shotById = new Map(shots.map((shot) => [shot?.id ?? shot?.shotId, shot]));
    const sceneToEpisode = sceneToEpisodeIndex(project);

    return raw.map((cue) => {
        const shot = shotById.get(cue.shotId);
        const episodeId = firstNonEmpty(shot?.episodeId, sceneToEpisode.get(String(shot?.sceneId ?? "").trim()), "");
        const start = num(cue.startSec);
        const end = num(cue.endSec);
        const durationSec = start !== null && end !== null
            ? round3(Math.max(0, end - start))
            : CUE_FALLBACK_SEC;
        return {
            id: cue.id,
            episodeId,
            shotId: cue.shotId,
            speakerId: cue.characterId ?? null,
            voiceProfileId: cue.voiceProfileId ?? null,
            text: cue.text ?? "",
            // 表演提示（台词括号注解）与解析出的语速：注解供人工/口型参考，speed 供构造 TTS 请求体；
            // 二者都**不进朗读文本**（text 已是清洗后的纯台词）。
            performance: cue.performance ?? "",
            speed: num(cue.speed) ?? null,
            startSec: start ?? 0,
            durationSec,
            type: cue.type,
            status: cue.status ?? "draft",
            // —— 契约 §10.2 / audio.js 兼容字段：对齐校验与混音仍按这套字段消费 ——
            endSec: end ?? start ?? 0,
            characterId: cue.characterId ?? null,
            artifactId: cue.artifactId ?? null,
        };
    });
}

// ---------------------------------------------------------------------------
// 3. 声画对齐检查（复用 audio.js validateCues + 逐条可解释）
// ---------------------------------------------------------------------------

/**
 * 逐条可解释的声画对齐检查。
 *
 * 复用 audio.js `validateCues` 得到 block / warn / pass（对白超时长、缺 VoiceProfile、
 * 空文本、时间区间、采样率、压混等），再补上 audio.js 未覆盖的镜头级信息：
 *   - 无对白的镜头 → `info`（仅提示，不阻断）
 *
 * 分级语义：
 *   block — 对白估算时长 > 镜头时长 / 缺（或不存在）VoiceProfile / 引用不存在镜头 / 时间区间非法
 *   warn  — 空文本（字幕缺内容）/ 语速超上限 / 缺口型参考 / 采样率·峰值·响度越界 / 对白与 BGM 缺压混
 *   info  — 无对白镜头（正常现象，不计入失败）
 *   pass  — 全部检查通过的 Cue
 *
 * @param {object} args
 * @param {Array}  [args.cues]
 * @param {Array}  [args.shots]
 * @param {Array}  [args.voiceProfiles]
 * @returns {{pass:number, warn:number, block:number, info:number, ok:boolean, items:Array}}
 *          pass/warn/block/info 为各自条数；items 为逐条明细（level / cueId / shotId / code / reason）。
 */
export function alignmentReport({ cues = [], shots = [], voiceProfiles = [] } = {}) {
    const cueList = Array.isArray(cues) ? cues : [];
    const shotList = Array.isArray(shots) ? shots : [];
    const { pass, warn, block } = validateCues({ cues: cueList, shots: shotList, voiceProfiles });

    const toItem = (level, entry) => ({
        level,
        cueId: entry.cueId ?? null,
        shotId: entry.shotId ?? null,
        code: entry.code,
        reason: entry.reason,
    });
    const items = [
        ...block.map((entry) => toItem("block", entry)),
        ...warn.map((entry) => toItem("warn", entry)),
        ...pass.map((entry) => toItem("pass", entry)),
    ];

    // 镜头级信息：无对白镜头不生成对白 Cue，仅提示，不阻断。
    const dialogueShotIds = new Set(
        cueList.filter((cue) => DIALOGUE_TYPES.has(cue?.type)).map((cue) => cue.shotId),
    );
    let info = 0;
    for (const shot of shotList) {
        const shotId = shot?.id ?? shot?.shotId;
        if (!nonEmpty(shotId)) continue;
        if (!dialogueShotIds.has(shotId)) {
            items.push({
                level: "info",
                cueId: null,
                shotId,
                code: "shot_without_dialogue",
                reason: `镜头「${shotId}」无对白，不生成对白 Cue（仅提示，不阻断）`,
            });
            info += 1;
        }
    }

    return {
        pass: pass.length,
        warn: warn.length,
        block: block.length,
        info,
        ok: block.length === 0,
        items,
    };
}

// ---------------------------------------------------------------------------
// 4. 幂等投影到 Project 侧
// ---------------------------------------------------------------------------

/**
 * 把 VoiceProfile / AudioCue 幂等投影回 Project 对象（照 projects.js `persistDerived` 模式）。
 *
 * 冻结语义：
 *   - **相同跳过**：候选集与现有集深度相等 → 不写、`applied=false`（重启重放不重复写）。
 *   - **已有非空集不覆盖**：`project.voiceProfiles` / `project.audioCues` 任一非空即保持原值，
 *     绝不冲掉用户/上游已确认的音色与 Cue（与 applyEpisodeProjection 的「旧数据不动」一致）。
 *   - **不改 version**：这是派生记账，不是用户编辑，递增 version 会平白触发 D7 乐观并发冲突。
 *   - 磁盘落盘由调用方（projects.js）走 persistDerived 完成；本函数只更新对象内存与 updatedAt。
 *
 * @param {object} project 项目对象（原地更新并返回）。
 * @param {object} [payload]
 * @param {Array}  [payload.profiles]
 * @param {Array}  [payload.cues]
 * @returns {{project:object|null, applied:boolean, appliedProfiles:boolean, appliedCues:boolean}}
 */
export function applyAudioProjection(project, { profiles, cues } = {}) {
    if (!isPlainObject(project)) {
        return { project: null, applied: false, appliedProfiles: false, appliedCues: false };
    }
    const nextProfiles = Array.isArray(profiles) ? profiles : [];
    const nextCues = Array.isArray(cues) ? cues : [];
    const currentProfiles = Array.isArray(project.voiceProfiles) ? project.voiceProfiles : [];
    const currentCues = Array.isArray(project.audioCues) ? project.audioCues : [];

    // 仅当「现有为空」且「候选非空」且「内容确有不同」时才写；否则保持不动 → 幂等。
    const appliedProfiles = currentProfiles.length === 0 && nextProfiles.length > 0 && !sameJson(currentProfiles, nextProfiles);
    const appliedCues = currentCues.length === 0 && nextCues.length > 0 && !sameJson(currentCues, nextCues);
    if (!appliedProfiles && !appliedCues) {
        return { project, applied: false, appliedProfiles: false, appliedCues: false };
    }

    if (appliedProfiles) project.voiceProfiles = nextProfiles;
    if (appliedCues) project.audioCues = nextCues;
    project.updatedAt = new Date().toISOString();
    // 不触碰 project.version（派生记账，见 persistDerived 注释）。

    return { project, applied: true, appliedProfiles, appliedCues };
}

/**
 * 声音生产纯逻辑模块。
 *
 * 设计动机见 docs/content/docs/progress/development-plan.md §11.5.1 与 §13.5：
 * 「声音」不再是全局 `audioModel / audioVoice / audioFormat` 配置，而是三种可追踪的生产对象：
 *   - VoiceProfile：角色音色锚点（id / characterId / speaker / design / referenceArtifactId / version）
 *   - AudioCue    ：时间轴上的声音条目（dialogue | narration | sfx | ambience | music）
 *   - 独立对白轨  ：由 AudioCue 混音得到的 AudioTrack，是短剧的事实源
 *
 * 本模块是**纯函数**：不读磁盘、不发网络请求、不 import pipeline.js，
 * 每个函数都可独立单测，所有对用户的提示都通过返回值/抛错表达，绝不写死 console。
 */

/** 与前端 web/src/services/api/audio.ts 的请求体字段保持一致，供 buildTtsRequest 输出。 */
export const TTS_BODY_KEYS = ["model", "input", "voice", "response_format", "speed", "instructions"];

/** 允许的音频采样率（§13.5「音频采样率」检查）。 */
export const SUPPORTED_SAMPLE_RATES = [16000, 22050, 24000, 32000, 44100, 48000];

/** 峰值上限：混音前每轨峰值不得高于 -1 dBFS（§13.5「峰值/响度」检查）。 */
export const PEAK_DB_MAX = -1;

/** 成片对白响度目标区间（LUFS，§13.5「峰值/响度」检查）。 */
export const LOUDNESS_LUFS_RANGE = [-18, -9];

/** 对白语速上限（字/秒）：超出则字幕无法在镜头内读完，仅告警（§13.5「字幕文本」检查）。 */
export const MAX_CHARS_PER_SEC = 8;

/** 镜头缺失 durationSec 时给 Cue 的兜底时长（秒），保证 Cue 仍可生成。 */
export const CUE_FALLBACK_SEC = 3;

const DIALOGUE_TYPES = new Set(["dialogue", "narration"]);
const ALL_CUE_TYPES = ["dialogue", "narration", "sfx", "ambience", "music"];

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;
const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

// ---------------------------------------------------------------------------
// 1. TTS 请求体构造
// ---------------------------------------------------------------------------

/**
 * 构造 OpenAI 兼容 `/v1/audio/speech` 的请求体。
 *
 * 字段名严格对齐 web/src/services/api/audio.ts 里 requestAudioGeneration 的 axios.post body：
 *   { model, input, voice, response_format, speed, ...(instructions ? { instructions } : {}) }
 *
 * @param {object}        args
 * @param {object}        args.voiceProfile VoiceProfile 对象；`speaker` 作为 `voice`，`design` 作为 `instructions`。
 * @param {string}        args.text         要合成的文本（台词/旁白）。
 * @param {string}        [args.format]     音频格式，默认 "mp3"（对齐前端 audioFormat 默认值）。
 * @param {number|string} [args.speed]      语速，默认 1（对齐前端 audioSpeed 默认值）。
 * @returns {object} 可直接作为 POST body 的纯数据对象；只包含 TTS_BODY_KEYS 中的字段。
 */
export function buildTtsRequest({ voiceProfile, text, format, speed } = {}) {
    if (!voiceProfile || typeof voiceProfile !== "object") {
        throw new Error("缺少 VoiceProfile：无法构造 TTS 请求");
    }
    if (!nonEmpty(text)) {
        throw new Error("TTS 文本为空：无法构造 TTS 请求");
    }
    const voice = voiceProfile.speaker || voiceProfile.voice;
    if (!nonEmpty(voice)) {
        throw new Error("VoiceProfile 缺少 speaker：无法构造 TTS 请求");
    }

    const body = {
        input: text,
        voice,
        response_format: nonEmpty(format) ? format : "mp3",
        speed: num(speed) ?? 1,
    };
    // model 是 OpenAI 兼容接口的必填项；由调用方（productionAudio.dialogue 的 toolId/model）注入。
    if (nonEmpty(voiceProfile.model)) body.model = voiceProfile.model;
    // design 是音色设计提示，对应前端的 audioInstructions。
    if (nonEmpty(voiceProfile.design)) body.instructions = voiceProfile.design;

    return body;
}

// ---------------------------------------------------------------------------
// 2. Cue Sheet 生成
// ---------------------------------------------------------------------------

/** 把镜头台词切成句子：按中英文句末标点与换行切。 */
function splitDialogue(text) {
    return String(text)
        .split(/[\n\r]+|(?<=[。！？!?；;])/)
        .map((part) => part.trim())
        .filter((part) => part !== "");
}

/** 解析该镜头的角色：显式 characterId > characterIds[0] > 按角色名在台词中匹配。 */
function resolveCharacterId(shot, characters) {
    if (nonEmpty(shot.characterId)) return shot.characterId;
    if (Array.isArray(shot.characterIds) && nonEmpty(shot.characterIds[0])) return shot.characterIds[0];
    const dialogue = typeof shot.dialogue === "string" ? shot.dialogue : "";
    const hit = (characters || []).find((character) => nonEmpty(character?.name) && dialogue.includes(character.name));
    return hit?.id || null;
}

/** 按 characterId 找 VoiceProfile；shot.voiceProfileId 显式指定时优先。 */
function resolveVoiceProfileId(shot, characterId, voiceProfiles) {
    if (nonEmpty(shot.voiceProfileId)) return shot.voiceProfileId;
    const hit = (voiceProfiles || []).find((profile) => profile?.characterId === characterId);
    return hit?.id || null;
}

/**
 * 从镜头列表生成对白 Cue（旁白/音效/环境声/BGM 默认允许为空数组）。
 *
 * 生成规则（写死于此，避免后续接线时来回猜）：
 *   1. 一个镜头 `dialogue` 为空的，不生成对白 Cue（返回空数组即合法）。
 *   2. 台词按句末标点切成 N 句；N=1 时占满整个镜头；
 *      N>1 时把 [0, durationSec] **按句顺序均分**，第 i 句覆盖 [i*step, (i+1)*step)。
 *      （不做逐字时长预测，先保证时间轴不重叠、不越界，精细对齐留给后续对齐 Job。）
 *   3. `startSec` 默认 0，`endSec` 默认取镜头 `durationSec`；镜头缺时长时用 CUE_FALLBACK_SEC 兜底。
 *   4. 同镜多句的 `id` 用 `cue_<shotId>_dialogue_<NN>` 稳定编号。
 *   5. narration/sfx/ambience/music 仅在镜头显式给出对应字段时才生成，否则对应数组为空。
 *
 * @param {object} args
 * @param {Array}  args.shots         镜头数组，元素含 id / durationSec / dialogue 等。
 * @param {Array}  [args.characters]  角色数组，用于按名字推断 characterId。
 * @param {Array}  [args.voiceProfiles] VoiceProfile 数组，用于按 characterId 挂载音色。
 * @returns {Array} AudioCue[]
 */
export function cuesFromShots({ shots, characters = [], voiceProfiles = [] } = {}) {
    const cues = [];
    for (const shot of Array.isArray(shots) ? shots : []) {
        const shotId = shot?.id ?? shot?.shotId;
        if (!nonEmpty(shotId)) continue;
        const duration = num(shot.durationSec);
        const total = duration !== null && duration > 0 ? duration : CUE_FALLBACK_SEC;

        const dialogue = typeof shot.dialogue === "string" ? shot.dialogue : "";
        const sentences = splitDialogue(dialogue);
        if (sentences.length > 0) {
            const characterId = resolveCharacterId(shot, characters);
            const voiceProfileId = resolveVoiceProfileId(shot, characterId, voiceProfiles);
            const step = total / sentences.length;
            sentences.forEach((text, index) => {
                cues.push({
                    id: `cue_${shotId}_dialogue_${String(index + 1).padStart(2, "0")}`,
                    shotId,
                    type: "dialogue",
                    startSec: round3(index * step),
                    endSec: round3((index + 1) * step),
                    text,
                    characterId,
                    voiceProfileId,
                    artifactId: null,
                    status: "draft",
                });
            });
        }

        // 可选：旁白（shot.narration）——同样支持多句均分。
        for (const [field, type] of [["narration", "narration"]]) {
            const lines = splitDialogue(shot[field] || "");
            if (lines.length === 0) continue;
            const step = total / lines.length;
            lines.forEach((text, index) => {
                cues.push({
                    id: `cue_${shotId}_${type}_${String(index + 1).padStart(2, "0")}`,
                    shotId,
                    type,
                    startSec: round3(index * step),
                    endSec: round3((index + 1) * step),
                    text,
                    characterId: null,
                    voiceProfileId: null,
                    artifactId: null,
                    status: "draft",
                });
            });
        }

        // 可选：音效/环境声/音乐——镜头给了文本就生成一条占满镜头的 Cue，缺失则留空。
        for (const type of ["sfx", "ambience", "music"]) {
            const value = shot[type];
            if (!nonEmpty(value)) continue;
            cues.push({
                id: `cue_${shotId}_${type}_01`,
                shotId,
                type,
                startSec: 0,
                endSec: round3(total),
                text: typeof value === "string" ? value : "",
                characterId: null,
                voiceProfileId: null,
                artifactId: null,
                status: "draft",
            });
        }
    }
    return cues;
}

// ---------------------------------------------------------------------------
// 3. Cue Sheet 校验
// ---------------------------------------------------------------------------

const issue = (cue, code, reason) => ({ cueId: cue.id, shotId: cue.shotId, code, reason });

/**
 * 逐条按 §13.5 检查清单校验 Cue Sheet，返回可解释的分级结果。
 *
 * 覆盖项：
 *   block — 对白时长 > 镜头时长 / VoiceProfile 不存在 / 角色与 VoiceProfile 不匹配 /
 *           时间区间非法 / 引用了不存在的镜头
 *   warn  — 文本为空（无字幕）/ 同镜多句时间重叠 / 缺口型参考音频 /
 *           语速超出字幕可读上限 / 采样率不在支持列表 / 峰值或响度越界 / 对白与 BGM 缺压混
 *
 * @param {object} args
 * @param {Array}  args.cues
 * @param {Array}  args.shots
 * @param {Array}  [args.voiceProfiles]
 * @returns {{pass:Array,warn:Array,block:Array}} 每项含 cueId / shotId / code / reason。
 */
export function validateCues({ cues = [], shots = [], voiceProfiles = [] } = {}) {
    const pass = [];
    const warn = [];
    const block = [];
    const shotById = new Map((shots || []).map((shot) => [shot?.id ?? shot?.shotId, shot]));
    const profileById = new Map((voiceProfiles || []).map((profile) => [profile?.id, profile]));

    const list = Array.isArray(cues) ? cues : [];
    for (const cue of list) {
        const problems = [];
        const add = (level, code, reason) => {
            const entry = issue(cue, code, reason);
            if (level === "block") block.push(entry);
            else warn.push(entry);
            problems.push(code);
        };

        const shot = shotById.get(cue.shotId);
        if (!shot) {
            add("block", "unknown_shot", `Cue 引用了不存在的镜头「${cue.shotId}」，无法对齐时间轴`);
        }

        const start = num(cue.startSec);
        const end = num(cue.endSec);
        if (start === null || end === null || start < 0 || end <= start) {
            add("block", "invalid_range", `时间区间非法（startSec=${cue.startSec}, endSec=${cue.endSec}），必须满足 0 ≤ start < end`);
        }

        if (DIALOGUE_TYPES.has(cue.type)) {
            // 对白时长与镜头时长
            if (shot && end !== null && start !== null && num(shot.durationSec) > 0
                && end - start > Number(shot.durationSec)) {
                add("block", "dialogue_too_long",
                    `对白时长 ${round3(end - start)}s 超过镜头时长 ${shot.durationSec}s，必须拆句或缩略`);
            }

            // 字幕文本
            if (!nonEmpty(cue.text)) {
                add("warn", "empty_text", "对白文本为空，将生成无声 Cue，字幕轨会缺内容");
            } else if (start !== null && end !== null && end > start) {
                const rate = cue.text.trim().length / (end - start);
                if (rate > MAX_CHARS_PER_SEC) {
                    add("warn", "too_fast_for_subtitle",
                        `语速约 ${round3(rate)} 字/秒（上限 ${MAX_CHARS_PER_SEC}），字幕在镜头内读不完`);
                }
            }

            // 角色与 VoiceProfile
            const profile = cue.voiceProfileId ? profileById.get(cue.voiceProfileId) : null;
            if (!cue.voiceProfileId) {
                add("block", "voice_profile_missing", "对白 Cue 未挂 VoiceProfile，无法确定音色");
            } else if (!profile) {
                add("block", "voice_profile_missing", `VoiceProfile「${cue.voiceProfileId}」不存在`);
            } else {
                if (cue.characterId && profile.characterId !== cue.characterId) {
                    add("block", "character_mismatch",
                        `Cue 角色「${cue.characterId}」与 VoiceProfile「${profile.id}」绑定的「${profile.characterId}」不一致`);
                }
                // 口型参考音频
                if (!nonEmpty(profile.referenceArtifactId)) {
                    add("warn", "missing_lip_reference",
                        `VoiceProfile「${profile.id}」缺 referenceArtifactId，无法做口型对齐参考`);
                }
            }
        }

        // 采样率
        if (cue.sampleRate !== undefined && cue.sampleRate !== null) {
            const rate = num(cue.sampleRate);
            if (rate === null || !SUPPORTED_SAMPLE_RATES.includes(rate)) {
                add("warn", "sample_rate",
                    `采样率 ${cue.sampleRate} 不在支持列表 [${SUPPORTED_SAMPLE_RATES.join(", ")}]`);
            }
        }

        // 峰值/响度
        if (cue.peakDb !== undefined && cue.peakDb !== null && num(cue.peakDb) > PEAK_DB_MAX) {
            add("warn", "peak_over",
                `峰值 ${cue.peakDb} dBFS 高于上限 ${PEAK_DB_MAX} dBFS，会削波`);
        }
        if (cue.loudnessLufs !== undefined && cue.loudnessLufs !== null) {
            const value = num(cue.loudnessLufs);
            if (value === null || value < LOUDNESS_LUFS_RANGE[0] || value > LOUDNESS_LUFS_RANGE[1]) {
                add("warn", "loudness_out_of_range",
                    `响度 ${cue.loudnessLufs} LUFS 超出目标区间 [${LOUDNESS_LUFS_RANGE.join(", ")}]`);
            }
        }

        if (problems.length === 0) {
            pass.push(issue(cue, "ok", "通过：时间轴、音色、字幕与技术参数均满足检查清单"));
        }
    }

    // 同一镜头多句重叠（仅对白）
    const byShot = new Map();
    for (const cue of list) {
        if (cue.type !== "dialogue") continue;
        if (!byShot.has(cue.shotId)) byShot.set(cue.shotId, []);
        byShot.get(cue.shotId).push(cue);
    }
    for (const [shotId, group] of byShot) {
        if (group.length < 2) continue;
        const sorted = [...group].sort((a, b) => num(a.startSec) - num(b.startSec));
        for (let i = 1; i < sorted.length; i += 1) {
            const prev = sorted[i - 1];
            const cur = sorted[i];
            if (num(cur.startSec) < num(prev.endSec)) {
                warn.push({
                    cueId: cur.id,
                    shotId,
                    code: "overlap",
                    reason: `与同镜 Cue「${prev.id}」时间重叠（${cur.startSec}s < ${prev.endSec}s），对白会互相盖住`,
                });
            }
        }
    }

    // 对白与 BGM 的压混关系：对白与 music Cue 时间重叠但缺 ducking 参数即告警
    const musicCues = list.filter((cue) => cue.type === "music");
    for (const cue of list) {
        if (!DIALOGUE_TYPES.has(cue.type)) continue;
        for (const music of musicCues) {
            if (music.shotId !== cue.shotId) continue;
            const overlaps = num(cue.startSec) < num(music.endSec) && num(music.startSec) < num(cue.endSec);
            if (overlaps && cue.duckDb === undefined && music.duckDb === undefined) {
                warn.push({
                    cueId: cue.id,
                    shotId: cue.shotId,
                    code: "no_ducking",
                    reason: `对白与 BGM「${music.id}」时间重叠但未设置压混（duckDb），BGM 会盖住对白`,
                });
            }
        }
    }

    return { pass, warn, block };
}

// ---------------------------------------------------------------------------
// 4. 混音入参组装
// ---------------------------------------------------------------------------

/**
 * 组装 ffmpeg amix 的输入描述（纯数据，不调用 ffmpeg，不改 delivery.js）。
 *
 * 输出结构可被 `delivery.js` 消费：其 `audio[].ref` 与 buildAssemblyPlan 的 `audio` 入参
 * 同构（`{ ref }`），可直接喂给 delivery 的 `resolveMediaPath` + `buildConcatArgs`。
 *
 * @param {object} args
 * @param {Array}  [args.clips]  视频片段 [{ id, ref, durationSec }]。
 * @param {Array}  [args.cues]   AudioCue[]；只有能解析出 `ref`（cue.ref 或 cue.artifactId）的才会进音频输入。
 * @param {Array}  [args.tracks] 音轨定义 [{ id, type, gainDb, muted }]。
 * @returns {object} 稳定的混音输入描述。
 */
export function buildMixInput({ clips = [], cues = [], tracks = [] } = {}) {
    const videoClips = (Array.isArray(clips) ? clips : []).map((clip, index) => ({
        id: clip?.id ?? clip?.shotId ?? `clip_${index}`,
        index,
        ref: clip?.ref ?? clip?.artifactUrl ?? null,
        durationSec: num(clip?.durationSec) ?? null,
    }));

    const normalizedTracks = (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
        id: track?.id ?? `track_${index}`,
        type: track?.type ?? "dialogue",
        gainDb: num(track?.gainDb) ?? 0,
        muted: track?.muted === true,
    }));

    const audio = (Array.isArray(cues) ? cues : [])
        .map((cue) => {
            const ref = cue?.ref ?? cue?.artifactId ?? null;
            if (!ref) return null;
            return {
                ref,
                cueId: cue.id ?? null,
                shotId: cue.shotId ?? null,
                type: cue.type ?? "dialogue",
                trackId: cue.trackId ?? null,
                startSec: num(cue.startSec) ?? 0,
                endSec: num(cue.endSec) ?? null,
                gainDb: num(cue.gainDb) ?? 0,
                delayMs: Math.round((num(cue.startSec) ?? 0) * 1000),
            };
        })
        .filter(Boolean);

    return {
        version: 1,
        clips: videoClips,
        audio,
        tracks: normalizedTracks,
        amix: { inputs: audio.length, duration: "longest", normalize: 0 },
        totalDurationSec: round3(videoClips.reduce((sum, clip) => sum + (clip.durationSec || 0), 0)),
    };
}

export { ALL_CUE_TYPES };

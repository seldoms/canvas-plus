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
// 0. 台词清洗与语速解析（括号表演注解不进生产参数）
// ---------------------------------------------------------------------------

/**
 * 表演注解括号：中文全角 `（）` / `【】` 与半角 `()` / `[]`。
 * 括号里的内容是**给人看的表演提示**（语气 / 音量 / 语速 / 情绪），不是要朗读的台词，
 * 也**不得**驱动 TTS 的生产参数（见 resolveSpeechSpeed —— 默认忽略注解，需显式 `honorPerformance: true` 才采纳）。
 */
const BRACKET_PAIRS = {
    "（": "）",
    "(": ")",
    "【": "】",
    "[": "]",
};
const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));

/** 包裹台词的外层引号对（只剥掉「整段被引号包住」的成对引号，段内引号原样保留）。 */
const WRAPPING_QUOTE_PAIRS = [
    ["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"], ["\"", "\""], ["'", "'"],
];

/** 正常语速（倍率，1 = 正常）。无显式语速且无有效线索时的默认值。 */
export const SPEED_NORMAL = 1;
/** 语速下限保护：注解最多把语速压到这里（正常语速的 0.85 倍），绝不允许更低。 */
export const SPEED_LOWER_BOUND = 0.85;
/** 语速上限保护：注解最多把语速提到这里（正常语速的 1.15 倍），绝不允许更高。 */
export const SPEED_UPPER_BOUND = 1.15;
/** 单条语速线索对语速的调整步长（先得 0.8 / 1.2，再由上下限收敛到边界）。 */
const SPEED_HINT_STEP = 0.2;

/** 空白归一：全角空格→半角、连续空白（含换行）折叠为单个空格、去首尾空白。 */
function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
}

/** 归一朗读文本：空白归一 + 反复剥掉整段外层成对引号（段内引号保留）。 */
function normalizeSpokenText(value) {
    let text = normalizeWhitespace(value);
    let changed = true;
    while (changed && text.length >= 2) {
        changed = false;
        for (const [open, close] of WRAPPING_QUOTE_PAIRS) {
            if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length - 1) {
                text = normalizeWhitespace(text.slice(open.length, text.length - close.length));
                changed = true;
                break;
            }
        }
    }
    return text;
}

/**
 * 把分镜台词的**括号表演注解**从台词正文里剥出来。
 *
 * 分镜阶段产出的 `dialogue` 常写成
 * 「姑娘，这么晚，去哪儿？（低声、音量低、语速慢、略带关心）」——
 * 括号里是给配音 / 口型参考的**表演提示**，不是要朗读的台词。若原样送进 TTS，
 * 注解里的「语速慢」会被当成指令把语音拖慢。本函数把两者拆开：正文只留纯台词，注解另存。
 *
 * 规则：
 *   - 剥掉 `（）` `()` `【】` `[]` 及其内容（支持嵌套），全角 / 半角混用都能处理；
 *   - 纯台词做空白归一（多段换行折叠为空格）、剥掉整段外层成对引号；段内引号原样保留；
 *   - 若剥完为空（整条台词都是注解），**回退原文**并给出 warning（绝不静默丢台词）。
 *
 * @param {string} raw 原始 dialogue 字符串。
 * @returns {{ text: string, performance: string, warnings: Array<{code:string, reason:string}> }}
 *          text=纯台词；performance=表演注解（多段用「；」连接，无注解为空串）；warnings=可解释告警。
 */
export function splitDialogue(raw) {
    const source = typeof raw === "string" ? raw : "";
    const warnings = [];
    const performances = [];
    const removed = new Array(source.length).fill(false);
    const stack = [];
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (BRACKET_PAIRS[ch] !== undefined) {
            stack.push({ open: ch, start: i });
            continue;
        }
        if (CLOSING_BRACKETS.has(ch) && stack.length > 0 && BRACKET_PAIRS[stack[stack.length - 1].open] === ch) {
            const top = stack.pop();
            if (stack.length === 0) {
                for (let j = top.start; j <= i; j += 1) removed[j] = true;
                const inner = normalizeWhitespace(source.slice(top.start + 1, i));
                if (inner !== "") performances.push(inner);
            }
            continue;
        }
        // 不匹配的右括号 / 普通字符：一律当正文保留，不丢字。
    }

    let kept = "";
    for (let i = 0; i < source.length; i += 1) {
        if (!removed[i]) kept += source[i];
    }
    const text = normalizeSpokenText(kept);
    const performance = performances.join("；");

    if (text === "") {
        const fallback = normalizeSpokenText(source);
        warnings.push({
            code: "empty_after_cleaning",
            reason: `台词剥掉括号注解后为空，已回退原文「${fallback}」并告警，请人工确认该行是否为纯表演提示`,
        });
        return { text: fallback, performance, warnings };
    }
    return { text, performance, warnings };
}

/**
 * 取镜头的原始台词条目（未解析说话人）：优先新契约 `shot.dialogueLines[]`，否则回落旧字符串 `shot.dialogue`。
 * 旧字符串一律归一成**一条、无明确说话人**的台词（向后兼容红线，绝不臆断拆分归属）。
 */
function rawDialogueEntries(shot) {
    const structured = Array.isArray(shot?.dialogueLines) ? shot.dialogueLines : null;
    if (structured && structured.length) {
        const out = [];
        for (const entry of structured) {
            if (typeof entry === "string") {
                const text = entry.trim();
                if (text) out.push({ speaker: "", text, performance: "", voiceover: false });
                continue;
            }
            if (!entry || typeof entry !== "object") continue;
            const text = String(entry.text ?? entry.line ?? entry.dialogue ?? "");
            const performance = String(entry.performance ?? "").trim();
            const speaker = String(entry.speaker ?? entry.speakerId ?? entry.characterId ?? entry.name ?? "").trim();
            if (!text.trim() && !performance) continue;
            out.push({ speaker, text, performance, voiceover: typeof entry.voiceover === "boolean" ? entry.voiceover : null });
        }
        if (out.length) return out;
    }
    const legacy = typeof shot?.dialogue === "string" ? shot.dialogue.trim() : "";
    return legacy ? [{ speaker: "", text: legacy, performance: "", voiceover: null }] : [];
}

/** 台词正文截断（warning 用，避免超长）。 */
function truncateText(value, max = 20) {
    const text = String(value ?? "").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 归一一个镜头的台词为「逐条带说话人」的结构，并逐级回落解析说话人（记 warning，**不阻塞**）。
 *
 * 输入兼容（向后兼容红线）：
 *   · `shot.dialogueLines[]`（新契约）：每条含 `speaker`（角色名或角色 id；也可写 `speakerId`/`characterId`/`name`）
 *     + `text`（纯台词正文）+ 可选 `performance`（表演注解）+ 可选 `voiceover`。
 *   · `shot.dialogue`（旧字符串）：整条当作「一条、无明确说话人」的台词 —— 旧项目一律仍能跑。
 *
 * 说话人解析**逐级回落**（越靠后越不可靠；④⑥ 会记 warning）：
 *   ① 台词显式标注的说话人（命中角色表）；
 *   ② 镜头级 `characterId` / `characterIds[0]`（内容层已指明归属）；
 *   ③ 台词正文里出现的角色名；
 *   ④ 镜头 `action`/`dialogue` 文本里出现的角色名（多于一个 → 取第一个并 warning）；
 *   ⑤ 该镜只有一个角色 → 用它（无歧义）；
 *   ⑥ 回落该镜第一个角色（warning；保证有音可混、不阻塞）。
 * 指不到任何角色时 → `speaker.name = null`（如实标记，不编造）。
 *
 * @param {object}  shot        镜头
 * @param {Array}   [characters] 本镜角色表（角色来自 script 阶段产物）
 * @param {Array}   [cast]       全局角色表（用于稳定编号；缺省回落 characters）
 * @returns {{ lines: Array<object>, warnings: Array<{code:string,reason:string}> }}
 */
export function resolveDialogueLines(shot, characters = [], cast = null) {
    const shotChars = Array.isArray(characters) ? characters.filter((c) => c && typeof c === "object") : [];
    const roster = Array.isArray(cast) && cast.length ? cast.filter((c) => c && typeof c === "object") : shotChars;
    const entries = rawDialogueEntries(shot);
    const warnings = [];
    const charKey = (value) => String(value ?? "").trim();
    const matchIn = (ref, list) => {
        const key = charKey(ref);
        return key ? list.find((c) => charKey(c?.id) === key || charKey(c?.name) === key) || null : null;
    };
    const indexOf = (char) => Math.max(0, roster.indexOf(char));
    const nameOf = (char) => charKey(char?.name) || null;

    const lines = [];
    for (const entry of entries) {
        // 台词正文与表演注解分开：正文里若仍残留括号注解，一并剥出（复用 splitDialogue，不另写括号解析）。
        const cleaned = splitDialogue(entry.text);
        const onlyAnnotation = cleaned.warnings.some((w) => w?.code === "empty_after_cleaning");
        const performance = [entry.performance, cleaned.performance].map((s) => String(s ?? "").trim()).filter(Boolean).join("；");

        let char = null;
        let source = "";
        let warning = null;

        // ① 显式说话人
        const explicitRef = charKey(entry.speaker);
        if (explicitRef) {
            const hit = matchIn(explicitRef, roster.length ? roster : shotChars);
            if (hit) {
                char = hit;
                source = "explicit";
            } else {
                warning = {
                    code: "speaker_unknown_character",
                    reason: `台词说话人「${explicitRef}」不在角色表里，已按回落链解析（不得乱填归属）`,
                };
            }
        }
        // ② 镜头级角色 id
        if (!char) {
            const shotRef = charKey(shot?.characterId) || charKey(Array.isArray(shot?.characterIds) ? shot.characterIds[0] : "");
            const hit = shotRef ? matchIn(shotRef, roster.length ? roster : shotChars) : null;
            if (hit) {
                char = hit;
                source = "shot_character_id";
            }
        }
        // ③ 台词正文里的角色名
        if (!char) {
            const hit = roster.find((c) => charKey(c?.name) && String(entry.text ?? "").includes(charKey(c.name)));
            if (hit) {
                char = hit;
                source = "line_text";
            }
        }
        // ④ 镜头文本里的角色名
        if (!char) {
            const hay = `${String(shot?.action ?? "")} ${String(shot?.dialogue ?? "")}`;
            const hits = roster.filter((c) => charKey(c?.name) && hay.includes(charKey(c.name)));
            if (hits.length === 1) {
                char = hits[0];
                source = "shot_text";
            } else if (hits.length > 1) {
                char = hits[0];
                source = "shot_text_ambiguous";
                warning = {
                    code: "speaker_ambiguous",
                    reason: `镜头文本点名了多个角色（${hits.map(nameOf).join("、")}），无法确定「${truncateText(entry.text)}」归属，已取第一个并告警`,
                };
            }
        }
        // ⑤ 单角色兜底
        if (!char && shotChars.length === 1) {
            char = shotChars[0];
            source = "single_character";
        }
        // ⑥ 首个角色兜底（warning，不阻塞）
        if (!char && roster.length) {
            char = roster[0];
            source = "fallback_first";
            warning = {
                code: "speaker_fallback_first",
                reason: `无法从分镜确定「${truncateText(entry.text)}」的说话角色，已回落使用第一个角色「${nameOf(char) || charKey(char?.id)}」的音色`,
            };
        }
        if (warning && !warnings.some((w) => w.code === warning.code && w.reason === warning.reason)) warnings.push(warning);

        lines.push({
            speaker: { name: nameOf(char), characterId: charKey(char?.id) || null, index: char ? indexOf(char) : 0 },
            speakerRef: explicitRef,
            source: source || (char ? "unknown" : "none"),
            text: cleaned.text,
            performance,
            onlyAnnotation,
            voiceover: entry.voiceover,
            warnings: cleaned.warnings,
        });
    }
    return { lines, warnings };
}

/** 从表演注解里探测语速线索：慢 → -step，快 → +step，both/无 → 0。 */
function detectSpeedHint(performance) {
    const source = String(performance ?? "");
    const slow = /慢|缓/.test(source);
    const fast = /快|急促|加速/.test(source);
    if (slow && !fast) return -SPEED_HINT_STEP;
    if (fast && !slow) return SPEED_HINT_STEP;
    return 0;
}

/**
 * 解析一条对白的**显式语速**（倍率，1 = 正常语速）。
 *
 * 优先级（显式 > 线索 > 默认）：
 *   1. `voiceProfile.speed` 显式给定 → 直接采用（权威配置，不再受注解影响）；
 *   2. `options.speed` 调用方显式给定 → 采用；
 *   3. 否则取**正常语速**（SPEED_NORMAL）。
 * 表演注解里的「语速慢 / 语速快」**只作线索、不是指令**：最多把语速在
 * [SPEED_LOWER_BOUND, SPEED_UPPER_BOUND] 内小幅收敛，绝不会把语速压到下限以下。
 *
 * @param {object} args
 * @param {object} [args.voiceProfile] VoiceProfile；其 `speed` 为显式语速时最优先。
 * @param {string} [args.performance]  splitDialogue 剥出的表演注解。
 * @param {object} [args.options]      调用方覆盖项，支持 `{ speed }`。
 * @returns {{ speed: number, source: "voiceProfile"|"options"|"performance"|"default", reason: string }}
 */
export function resolveSpeechSpeed({ voiceProfile, performance, options } = {}) {
    const opt = options && typeof options === "object" ? options : {};

    const profileSpeed = num(voiceProfile?.speed);
    if (profileSpeed !== null && profileSpeed > 0) {
        return {
            speed: profileSpeed,
            source: "voiceProfile",
            reason: `VoiceProfile 显式指定 speed=${profileSpeed}，以显式配置为准（注解不参与）`,
        };
    }

    const optionSpeed = num(opt.speed);
    if (optionSpeed !== null && optionSpeed > 0) {
        return {
            speed: optionSpeed,
            source: "options",
            reason: `调用方显式指定 speed=${optionSpeed}，以显式配置为准（注解不参与）`,
        };
    }

    // 注解（LLM 自己写的表演提示）**默认不参与生产参数**：它是文学发挥，不是用户指令。
    // 只有调用方显式传 `honorPerformance: true` 才把它当线索；默认取正常语速。
    if (opt.honorPerformance !== true) {
        return {
            speed: SPEED_NORMAL,
            source: "default",
            reason: "默认正常语速 1.0（表演注解不参与生产参数；如需采纳注解请显式传 honorPerformance: true）",
        };
    }

    const hint = detectSpeedHint(performance);
    if (hint === 0) {
        return {
            speed: SPEED_NORMAL,
            source: "default",
            reason: "无显式语速且注解未给语速线索，取正常语速 1.0",
        };
    }

    const desired = SPEED_NORMAL + hint;
    const speed = Math.min(SPEED_UPPER_BOUND, Math.max(SPEED_LOWER_BOUND, desired));
    const direction = hint > 0 ? "偏快" : "偏慢";
    const bound = hint > 0 ? SPEED_UPPER_BOUND : SPEED_LOWER_BOUND;
    const reason = speed === desired
        ? `注解提示语速${direction}，仅作线索小幅收敛 → speed=${speed}`
        : `注解提示语速${direction}，但注解不是指令，已按${hint > 0 ? "上" : "下"}限保护收敛到 ${speed}（正常语速的 ${bound} 倍）`;
    return { speed, source: "performance", reason };
}

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
 * @param {number|string|object} [args.speed] 语速，默认 1（对齐前端 audioSpeed 默认值）。
 *        既接受数字/字符串，也接受 `resolveSpeechSpeed()` 的返回值对象（取其 `.speed`）。
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

    // speed 可以是数字/字符串，也可以是 resolveSpeechSpeed 的 `{ speed, source, reason }` 结果对象。
    const speedValue = speed && typeof speed === "object" ? speed.speed : speed;
    const body = {
        input: text,
        voice,
        response_format: nonEmpty(format) ? format : "mp3",
        speed: num(speedValue) ?? SPEED_NORMAL,
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
function splitSentences(text) {
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

/** 按 characterId 找 VoiceProfile 对象；shot.voiceProfileId 显式指定时优先。 */
function findVoiceProfile(shot, characterId, voiceProfiles) {
    if (nonEmpty(shot.voiceProfileId)) {
        const explicit = (voiceProfiles || []).find((profile) => profile?.id === shot.voiceProfileId);
        if (explicit) return explicit;
    }
    return (voiceProfiles || []).find((profile) => profile?.characterId === characterId) || null;
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

        // 逐条台词带说话人：新契约 `dialogueLines[]` 每条自带说话人；旧字符串 `dialogue` 归一成「一条、无明确说话人」，
        // 按说话人逐级回落解析（见 resolveDialogueLines）—— 保证多角色镜头里每句落到正确的人，且不阻塞。
        const { lines } = resolveDialogueLines(shot, characters);
        const spoken = [];
        for (const line of lines) {
            const sentences = splitSentences(line.text);
            if (sentences.length === 0) continue;
            const characterId = line.speaker.characterId || resolveCharacterId(shot, characters);
            const voiceProfile = findVoiceProfile(shot, characterId, voiceProfiles);
            const voiceProfileId = voiceProfile?.id || null;
            // 语速是显式参数：默认正常；注解里「语速慢」只作线索，且有下限保护。
            const { speed } = resolveSpeechSpeed({ voiceProfile, performance: line.performance });
            for (const text of sentences) {
                spoken.push({ text, performance: line.performance, speed, characterId, voiceProfileId, warnings: line.warnings });
            }
        }
        if (spoken.length > 0) {
            const step = total / spoken.length;
            spoken.forEach((entry, index) => {
                cues.push({
                    id: `cue_${shotId}_dialogue_${String(index + 1).padStart(2, "0")}`,
                    shotId,
                    type: "dialogue",
                    startSec: round3(index * step),
                    endSec: round3((index + 1) * step),
                    text: entry.text,
                    performance: entry.performance,
                    speed: entry.speed,
                    characterId: entry.characterId,
                    voiceProfileId: entry.voiceProfileId,
                    artifactId: null,
                    status: "draft",
                    warnings: entry.warnings,
                });
            });
        }

        // 可选：旁白（shot.narration）——同样支持多句均分，并做同样的清洗。
        for (const [field, type] of [["narration", "narration"]]) {
            const narration = splitDialogue(typeof shot[field] === "string" ? shot[field] : "");
            const lines = splitSentences(narration.text);
            if (lines.length === 0) continue;
            const { speed } = resolveSpeechSpeed({ performance: narration.performance });
            const step = total / lines.length;
            lines.forEach((text, index) => {
                cues.push({
                    id: `cue_${shotId}_${type}_${String(index + 1).padStart(2, "0")}`,
                    shotId,
                    type,
                    startSec: round3(index * step),
                    endSec: round3((index + 1) * step),
                    text,
                    performance: narration.performance,
                    speed,
                    characterId: null,
                    voiceProfileId: null,
                    artifactId: null,
                    status: "draft",
                    warnings: narration.warnings,
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

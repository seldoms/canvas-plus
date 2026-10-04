/**
 * 平台音色库（Voice Library）—— 「声音从平台音色库中选」的**唯一事实源**。
 *
 * 产品口径（产品负责人拍板，2026-10-04）：
 *   角色定妆（casting）阶段要同时**定脸 + 定声音**，且「声音从平台音色库中选」——
 *   音色不是用户自由填的字符串，而是**平台侧 TTS 模型自带的一组命名音色枚举**；
 *   选了音色就只能从这组枚举里选。前端只读（`GET /api/tts/voices` / `GET /api/providers`），
 *   **绝不硬编码**。
 *
 * 权威数据源（**只读探测，不改 147**）：
 *   `GET http://192.168.123.147:8188/object_info/TDQwen3TTSCustomVoice`
 *   → input.required.speaker  = ["Aiden","Dylan","Eric","Ono_anna","Ryan","Serena","Sohee","Uncle_fu","Vivian"]
 *   → input.required.language = ["Auto","Chinese","English","Japanese","Korean","German","French","Russian","Portuguese","Spanish","Italian"]
 *   → input.optional.instruct = STRING（音色描述，落到工作流的 {{INSTRUCT}}）
 *   本文件是该枚举的**后端副本登记表** —— 与 durations.js / sizes.js 同一套路：
 *   模板清单（providers/comfy.js listTemplates）从这里取音色挂到音频模板上，于是
 *   `GET /api/providers` 的 `comfy.templates[].voices` 就是音色的接口出口。
 *
 * ⚠️ 与 durations.js / sizes.js 的差异：本模块登记的音色**不随模板名通用**，目前只有
 * `audio_qwen3_tts`（工作流 workflows/audio_qwen3_tts.json → 节点 TDQwen3TTSCustomVoice）这一个模板。
 * 别的 TTS 模型要接进来，必须**先一手查证它自己的命名音色枚举**再登记，不许拍脑袋复用。
 */

/** 音色库数据源（只读探测地址）。 */
export const VOICE_LIBRARY_SOURCE = "http://192.168.123.147:8188/object_info/TDQwen3TTSCustomVoice";

/** 当前唯一登记的 TTS 模板（工作流节点 TDQwen3TTSCustomVoice）。 */
export const QWEN3_TTS_TEMPLATE = "audio_qwen3_tts";

/**
 * 命名音色枚举（与 147 `TDQwen3TTSCustomVoice.speaker` 的 ENUM 逐字一致）。
 * 顺序保持 147 返回的原始顺序，前端可直接照排。
 */
export const QWEN3_TTS_SPEAKERS = Object.freeze(["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"]);

/** 语种枚举（与 147 `TDQwen3TTSCustomVoice.language` 的 ENUM 逐字一致）。 */
export const QWEN3_TTS_LANGUAGES = Object.freeze(["Auto", "Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"]);

/** 147 侧默认音色 / 默认语种（object_info 的 default）。 */
export const QWEN3_TTS_DEFAULT_SPEAKER = "Aiden";
export const QWEN3_TTS_DEFAULT_LANGUAGE = "Auto";

/** 命名音色的中文说明（纯展示用，不影响取值域）。 */
export const QWEN3_TTS_SPEAKER_LABELS = Object.freeze({
    Aiden: "Aiden · 男声",
    Dylan: "Dylan · 男声",
    Eric: "Eric · 男声",
    Ono_anna: "Ono_anna · 女声",
    Ryan: "Ryan · 男声",
    Serena: "Serena · 女声",
    Sohee: "Sohee · 女声",
    Uncle_fu: "Uncle_fu · 中年男声",
    Vivian: "Vivian · 女声",
});

/** 仅这些模板下发音色档位；其余模板 voices:null（与 sizes.js 未登记即 null 同口径）。 */
const isVoiceTemplate = (name) => String(name ?? "").trim() === QWEN3_TTS_TEMPLATE;

/** 所选音色是否属于平台音色库（后端校验入口）。空值/未知一律 false —— 未登记就不能声称它合法。 */
export function isSpeakerAllowed(speaker) {
    return QWEN3_TTS_SPEAKERS.includes(String(speaker ?? "").trim());
}

/** 所选语种是否属于平台音色库（后端校验入口）。 */
export function isLanguageAllowed(language) {
    return QWEN3_TTS_LANGUAGES.includes(String(language ?? "").trim());
}

/**
 * BCP-47 / 自由语种串 → Qwen3-TTS `language` 枚举（147 `TDQwen3TTSCustomVoice.language`）。
 * 已在枚举内 → 原样返回；否则取语种基码映射；未知回落 `Auto`（模型自判）。
 * （口径与 pipeline.js 历史实现逐字一致，只是搬到一个可复用的叶子模块。）
 */
export function qwen3Language(language) {
    const key = String(language ?? "").trim();
    if (isLanguageAllowed(key)) return key;
    const base = key.toLowerCase().split(/[-_]/)[0];
    const table = { zh: "Chinese", cmn: "Chinese", en: "English", ja: "Japanese", ko: "Korean", de: "German", fr: "French", ru: "Russian", pt: "Portuguese", es: "Spanish", it: "Italian" };
    return table[base] || QWEN3_TTS_DEFAULT_LANGUAGE;
}

/**
 * 把「角色音色事实」适配成 Qwen3-TTS 的命名音色（`{{SPEAKER}}`）。
 *
 * 架构铁律：内容层只产出**模型无关的音色描述**（如「音色低沉沙哑，语速慢」），把描述映射成某个 TTS 模型的
 * 音色枚举属于**后端适配**，发生在发起生成请求这一刻（与 prompt-compiler 同族）。因此本函数不写进任何内容产物。
 * 优先级：内容层已给合法枚举 → 直接用；否则按音色描述的音高线索（低沉/清亮）→ 否则按性别 → 否则按角色 id 稳定散列。
 * @param {object} profile    VoiceProfile / 身份卡 voice（含 speaker / timbre / design）
 * @param {object} [character] 剧本角色（含 appearance / name 等）
 * @returns {string} 恒为 QWEN3_TTS_SPEAKERS 之一
 */
export function qwen3Speaker(profile, character) {
    const raw = String(profile?.speaker ?? "").trim();
    if (QWEN3_TTS_SPEAKERS.includes(raw)) return raw;
    const voiceText = [profile?.timbre, profile?.design].filter(Boolean).join(" ");
    const low = /低沉|沙哑|低音|浑厚|醇厚|粗|磁/.test(voiceText);
    const high = /清亮|明亮|高音|尖|细|清脆|甜/.test(voiceText);
    if (low && !high) return "Uncle_fu";
    if (high && !low) return "Serena";
    const text = [character?.appearance, character?.profile, character?.name, profile?.name].filter(Boolean).join(" ");
    const female = /女性|女|少女|姑娘|女孩|妈|母|姐|妹|她/.test(text);
    const male = /男性|男|老船长|船长|爸|父|爷|叔|他/.test(text);
    if (female && !male) return "Serena";
    if (male && !female) return "Aiden";
    const seedText = String(profile?.characterId ?? profile?.name ?? profile?.id ?? "voice");
    let hash = 0;
    for (const ch of seedText) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return hash % 2 === 0 ? "Aiden" : "Dylan";
}

/**
 * 音色库清单（接口出口形状）。给前端渲染「音色下拉 + 语种下拉」，前端只读不硬编码。
 * @returns {{template:string,speakers:string[],speakersDetailed:Array,speakerLabels:object,languages:string[],defaultSpeaker:string,defaultLanguage:string,source:string,verified:boolean,note:string}}
 */
export function listVoices() {
    return {
        template: QWEN3_TTS_TEMPLATE,
        // 前端契约字段名是 `voices`（见 web/src/services/api/tts.ts）；speakers 是等价别名，保留便于人读。
        voices: [...QWEN3_TTS_SPEAKERS],
        speakers: [...QWEN3_TTS_SPEAKERS],
        speakersDetailed: QWEN3_TTS_SPEAKERS.map((id) => ({ id, value: id, label: QWEN3_TTS_SPEAKER_LABELS[id] || id })),
        speakerLabels: { ...QWEN3_TTS_SPEAKER_LABELS },
        languages: [...QWEN3_TTS_LANGUAGES],
        defaultSpeaker: QWEN3_TTS_DEFAULT_SPEAKER,
        defaultLanguage: QWEN3_TTS_DEFAULT_LANGUAGE,
        source: VOICE_LIBRARY_SOURCE,
        verified: true,
        note: "命名音色与语种枚举来自 147 TDQwen3TTSCustomVoice（只读探测）",
    };
}

/**
 * 取模板的音色元数据（接口与前端消费的形状）。未登记音色的模板返回 speakers:null + 说明；
 * 永远返回一个对象，调用方不必判空。
 * @param {string} name 模板名
 */
export function voiceMetaForTemplate(name) {
    const key = String(name ?? "").trim();
    if (!isVoiceTemplate(key)) {
        return { template: key, speakers: null, voices: null, languages: null, defaultSpeaker: null, defaultLanguage: null, source: VOICE_LIBRARY_SOURCE, verified: false, note: "非 TTS 模板，无命名音色档位" };
    }
    return {
        template: key,
        speakers: [...QWEN3_TTS_SPEAKERS],
        voices: [...QWEN3_TTS_SPEAKERS],
        languages: [...QWEN3_TTS_LANGUAGES],
        defaultSpeaker: QWEN3_TTS_DEFAULT_SPEAKER,
        defaultLanguage: QWEN3_TTS_DEFAULT_LANGUAGE,
        source: VOICE_LIBRARY_SOURCE,
        verified: true,
        note: "命名音色与语种枚举来自 147 TDQwen3TTSCustomVoice（只读探测）",
    };
}

/** 选定 TTS 模板 → 可选命名音色集合；非 TTS 模板返回 null（不约束）。 */
export function voicesForTemplate(name) {
    return voiceMetaForTemplate(name).speakers;
}

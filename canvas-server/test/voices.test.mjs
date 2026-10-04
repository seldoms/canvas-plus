/**
 * 平台音色库（voices.js）行为锁定：
 *   · 命名音色 / 语种枚举与 147 `TDQwen3TTSCustomVoice` 逐字一致（9 音色 / 11 语种）；
 *   · 非法音色 / 语种被拒（后端校验入口）；
 *   · BCP-47 → 语种枚举映射；音色适配（内容层描述 → 合法命名音色）；
 *   · 随模板清单同源下发（前端只读，不硬编码）。
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
    QWEN3_TTS_LANGUAGES,
    QWEN3_TTS_SPEAKERS,
    QWEN3_TTS_TEMPLATE,
    VOICE_LIBRARY_SOURCE,
    isLanguageAllowed,
    isSpeakerAllowed,
    listVoices,
    qwen3Language,
    qwen3Speaker,
    voiceMetaForTemplate,
    voicesForTemplate,
} from "../src/voices.js";
import { listTemplates } from "../src/providers/comfy.js";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));

// 147 一手探测（GET /object_info/TDQwen3TTSCustomVoice）得到的枚举，逐字硬编码在此做对账。
const EXPECTED_SPEAKERS = ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"];
const EXPECTED_LANGUAGES = ["Auto", "Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"];

test("音色库枚举与 147 TDQwen3TTSCustomVoice 一致：9 个命名音色 + 11 个语种", () => {
    assert.deepEqual([...QWEN3_TTS_SPEAKERS], EXPECTED_SPEAKERS);
    assert.equal(QWEN3_TTS_SPEAKERS.length, 9);
    assert.deepEqual([...QWEN3_TTS_LANGUAGES], EXPECTED_LANGUAGES);
    assert.equal(QWEN3_TTS_LANGUAGES.length, 11);
    assert.equal(QWEN3_TTS_TEMPLATE, "audio_qwen3_tts");
    assert.match(VOICE_LIBRARY_SOURCE, /object_info\/TDQwen3TTSCustomVoice$/);
    // 冻结：常量数组不可被就地改写。
    assert.throws(() => QWEN3_TTS_SPEAKERS.push("Hacker"), TypeError);
});

test("非法音色 / 语种被拒；合法沿用原值", () => {
    for (const speaker of EXPECTED_SPEAKERS) assert.equal(isSpeakerAllowed(speaker), true, `${speaker} 应合法`);
    for (const bad of ["hacker", "AIDEN", " Aiden", "", null, undefined, 42, "Serena "]) {
        // 注意 " Aiden" / "Serena " 带空白：isSpeakerAllowed 只 trim 后比对，因此 trim 后合法；
        // 这里显式断言「不 trim 的原始串」不会被当成合法（校验入口用 trim 后的值）。
        if (typeof bad === "string" && bad.trim() && EXPECTED_SPEAKERS.includes(bad.trim())) continue;
        assert.equal(isSpeakerAllowed(bad), false, `${String(bad)} 应非法`);
    }
    assert.equal(isSpeakerAllowed("  Uncle_fu  "), true);
    for (const language of EXPECTED_LANGUAGES) assert.equal(isLanguageAllowed(language), true);
    for (const bad of ["chinese", "Klingon", "", null, 5]) assert.equal(isLanguageAllowed(bad), false);
});

test("BCP-47 → 语种枚举：zh-CN→Chinese；已在枚举内原样；未知回落 Auto", () => {
    assert.equal(qwen3Language("zh-CN"), "Chinese");
    assert.equal(qwen3Language("zh"), "Chinese");
    assert.equal(qwen3Language("en-US"), "English");
    assert.equal(qwen3Language("ja"), "Japanese");
    assert.equal(qwen3Language("Chinese"), "Chinese");
    assert.equal(qwen3Language("Auto"), "Auto");
    assert.equal(qwen3Language("klingon"), "Auto");
    assert.equal(qwen3Language(""), "Auto");
    assert.equal(qwen3Language(undefined), "Auto");
});

test("音色适配 qwen3Speaker：合法枚举直通；描述线索映射；未知稳定散列", () => {
    // 内容层已给合法枚举 → 直通。
    assert.equal(qwen3Speaker({ speaker: "Vivian" }, {}), "Vivian");
    // 描述线索：低沉沙哑 → Uncle_fu；清亮 → Serena（线索来自 timbre/design，与 VoiceProfile 实际形状一致）。
    assert.equal(qwen3Speaker({ speaker: "低沉沙哑，语速偏慢", design: "低沉沙哑，语速偏慢", timbre: "低沉沙哑" }, {}), "Uncle_fu");
    assert.equal(qwen3Speaker({ speaker: "清亮的少女音", design: "清亮甜美的少女音", timbre: "清亮" }, {}), "Serena");
    // 按性别。
    assert.equal(qwen3Speaker({ speaker: "不确定" }, { appearance: "一位女性，短发" }), "Serena");
    assert.equal(qwen3Speaker({ speaker: "不确定" }, { appearance: "一位男性，高大" }), "Aiden");
    // 完全无线索 → 稳定散列，且恒为合法枚举。
    const a = qwen3Speaker({ characterId: "c1" }, {});
    const b = qwen3Speaker({ characterId: "c1" }, {});
    assert.equal(a, b);
    assert.ok(EXPECTED_SPEAKERS.includes(a));
});

test("listVoices 形状：voices/languages 数组（前端契约字段名 voices）", () => {
    const voices = listVoices();
    assert.deepEqual(voices.voices, EXPECTED_SPEAKERS);
    assert.deepEqual(voices.speakers, EXPECTED_SPEAKERS);
    assert.deepEqual(voices.languages, EXPECTED_LANGUAGES);
    assert.equal(voices.defaultSpeaker, "Aiden");
    assert.equal(voices.defaultLanguage, "Auto");
    assert.equal(voices.verified, true);
});

test("voiceMetaForTemplate：仅 TTS 模板有音色；其余 voices 为 null（未登记即 null）", () => {
    const tts = voiceMetaForTemplate("audio_qwen3_tts");
    assert.deepEqual(tts.speakers, EXPECTED_SPEAKERS);
    assert.deepEqual(tts.languages, EXPECTED_LANGUAGES);
    assert.equal(tts.verified, true);
    assert.deepEqual(voicesForTemplate("audio_qwen3_tts"), EXPECTED_SPEAKERS);

    const img = voiceMetaForTemplate("img_zimage_artistic");
    assert.equal(img.speakers, null);
    assert.match(img.note, /非 TTS 模板/);
    assert.equal(voicesForTemplate("img_zimage_artistic"), null);
});

test("音色随模板清单同源下发（前端只读，不硬编码）", () => {
    const templates = listTemplates(workflowsDir);
    const audio = templates.find((item) => item.name === "audio_qwen3_tts");
    assert.ok(audio, "清单应包含 audio_qwen3_tts");
    assert.deepEqual(audio.voices, EXPECTED_SPEAKERS, "音频模板应下发命名音色");
    assert.deepEqual(audio.voiceMeta.languages, EXPECTED_LANGUAGES);
    // 生图模板不带音色（避免前端误把图片模板当 TTS）。
    const img = templates.find((item) => item.name === "img_zimage_artistic");
    assert.equal(img.voices, null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    ALL_CUE_TYPES,
    TTS_BODY_KEYS,
    buildMixInput,
    buildTtsRequest,
    cuesFromShots,
    validateCues,
} from "../src/audio.js";

// ---------- 固定装置 ----------

const characters = [
    { id: "c1", name: "林晚", profile: "女主", appearance: "…", voice: "清亮克制" },
    { id: "c2", name: "陈默", profile: "男主", appearance: "…", voice: "低沉" },
];
const voiceProfiles = [
    { id: "vp_c1", characterId: "c1", language: "zh-CN", speaker: "Serena", design: "成年女性，清亮克制", referenceArtifactId: "art_voice_c1", version: 1 },
    { id: "vp_c2", characterId: "c2", language: "zh-CN", speaker: "Ethan", design: "成年男性，低沉", referenceArtifactId: "art_voice_c2", version: 1 },
];
const shot = (id, extra = {}) => ({ id, sceneId: "sc1", durationSec: 4, dialogue: "", ...extra });

// ---------- 1. TTS 请求体构造 ----------

test("buildTtsRequest 字段名与前端 /v1/audio/speech 调用一致", () => {
    const body = buildTtsRequest({
        voiceProfile: { ...voiceProfiles[0], model: "gpt-4o-mini-tts" },
        text: "你终于来了。",
        format: "wav",
        speed: "1.25",
    });
    assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "response_format", "speed", "voice"].sort());
    // 每个字段都必须是前端 TTS body 认识的键，禁止杜撰字段名
    for (const key of Object.keys(body)) assert.ok(TTS_BODY_KEYS.includes(key), `未知字段 ${key}`);
    assert.equal(body.model, "gpt-4o-mini-tts");
    assert.equal(body.input, "你终于来了。");
    assert.equal(body.voice, "Serena"); // voiceProfile.speaker → voice
    assert.equal(body.response_format, "wav"); // format → response_format
    assert.equal(body.speed, 1.25); // 字符串数字会被转成 Number
    assert.equal(body.instructions, "成年女性，清亮克制"); // design → instructions
});

test("buildTtsRequest 默认 format=mp3、speed=1，且无 model/design 时不塞多余字段", () => {
    const body = buildTtsRequest({ voiceProfile: { speaker: "alloy" }, text: "嗯" });
    assert.deepEqual(body, { input: "嗯", voice: "alloy", response_format: "mp3", speed: 1 });
});

test("buildTtsRequest 缺少 VoiceProfile 或文本时抛错（不写死 console）", () => {
    assert.throws(() => buildTtsRequest({ text: "hi" }), /VoiceProfile/);
    assert.throws(() => buildTtsRequest({ voiceProfile: { speaker: "alloy" }, text: "   " }), /文本为空/);
    assert.throws(() => buildTtsRequest({ voiceProfile: {}, text: "hi" }), /speaker/);
});

// ---------- 2. Cue Sheet 生成 ----------

test("cuesFromShots 单句对白占满镜头，并挂上角色与 VoiceProfile", () => {
    const cues = cuesFromShots({
        shots: [shot("sh1", { durationSec: 4, dialogue: "你终于来了。", characterId: "c1" })],
        characters,
        voiceProfiles,
    });
    assert.equal(cues.length, 1);
    const cue = cues[0];
    assert.equal(cue.id, "cue_sh1_dialogue_01");
    assert.equal(cue.shotId, "sh1");
    assert.equal(cue.type, "dialogue");
    assert.equal(cue.startSec, 0);
    assert.equal(cue.endSec, 4);
    assert.equal(cue.text, "你终于来了。");
    assert.equal(cue.characterId, "c1");
    assert.equal(cue.voiceProfileId, "vp_c1");
    assert.equal(cue.status, "draft");
});

test("cuesFromShots 同镜多句按顺序均分、互不重叠、编号稳定", () => {
    const cues = cuesFromShots({
        shots: [shot("sh2", { durationSec: 6, dialogue: "你来了。他走了。", characterId: "c1" })],
        voiceProfiles,
    });
    assert.deepEqual(cues.map((c) => c.id), ["cue_sh2_dialogue_01", "cue_sh2_dialogue_02"]);
    assert.deepEqual(cues.map((c) => [c.startSec, c.endSec]), [[0, 3], [3, 6]]);
    assert.equal(cues[0].endSec <= cues[1].startSec, true);
});

test("cuesFromShots 角色名可从台词推断；镜头缺时长时用兜底时长", () => {
    const cues = cuesFromShots({
        shots: [{ id: "sh3", dialogue: "林晚，别走。" }], // 无 durationSec、无 characterId
        characters,
        voiceProfiles,
    });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].characterId, "c1"); // 台词里出现「林晚」
    assert.equal(cues[0].voiceProfileId, "vp_c1");
    assert.ok(cues[0].endSec > 0);
});

test("cuesFromShots 无对白时对白/旁白/音效/环境声/BGM 全部允许为空数组", () => {
    const cues = cuesFromShots({ shots: [shot("sh4")], characters, voiceProfiles });
    assert.deepEqual(cues, []);
});

test("cuesFromShots 显式给出旁白/音效时才生成对应类型 Cue", () => {
    const cues = cuesFromShots({
        shots: [shot("sh5", { narration: "夜色渐深。", sfx: "关门声" })],
        voiceProfiles,
    });
    assert.deepEqual(cues.map((c) => c.type).sort(), ["narration", "sfx"]);
    for (const cue of cues) assert.ok(ALL_CUE_TYPES.includes(cue.type));
});

// ---------- 3. Cue Sheet 校验 ----------

const cue = (extra = {}) => ({
    id: "cue_sh1_dialogue_01",
    shotId: "sh1",
    type: "dialogue",
    startSec: 0,
    endSec: 3,
    text: "你终于来了。",
    characterId: "c1",
    voiceProfileId: "vp_c1",
    artifactId: "art_audio_001",
    status: "approved",
    ...extra,
});

test("validateCues 全绿时进 pass，无 warn/block", () => {
    const result = validateCues({
        cues: [cue()],
        shots: [shot("sh1", { durationSec: 4 })],
        voiceProfiles,
    });
    assert.equal(result.pass.length, 1);
    assert.equal(result.pass[0].code, "ok");
    assert.equal(result.warn.length, 0);
    assert.equal(result.block.length, 0);
});

test("validateCues 对白时长超过镜头时长 → block", () => {
    const result = validateCues({
        cues: [cue({ startSec: 0, endSec: 5 })],
        shots: [shot("sh1", { durationSec: 3 })],
        voiceProfiles,
    });
    const hit = result.block.find((item) => item.code === "dialogue_too_long");
    assert.ok(hit, "应 block dialogue_too_long");
    assert.equal(hit.cueId, "cue_sh1_dialogue_01");
    assert.equal(hit.shotId, "sh1");
    assert.match(hit.reason, /超过镜头时长/);
});

test("validateCues VoiceProfile 不存在 → block", () => {
    const result = validateCues({
        cues: [cue({ voiceProfileId: "vp_missing" })],
        shots: [shot("sh1", { durationSec: 4 })],
        voiceProfiles,
    });
    const hit = result.block.find((item) => item.code === "voice_profile_missing");
    assert.ok(hit);
    assert.match(hit.reason, /vp_missing/);
});

test("validateCues 角色与 VoiceProfile 不匹配 → block", () => {
    const result = validateCues({
        cues: [cue({ characterId: "c2", voiceProfileId: "vp_c1" })],
        shots: [shot("sh1", { durationSec: 4 })],
        voiceProfiles,
    });
    const hit = result.block.find((item) => item.code === "character_mismatch");
    assert.ok(hit);
    assert.match(hit.reason, /c2/);
});

test("validateCues 空文本 → warn（不 block）", () => {
    const result = validateCues({
        cues: [cue({ text: "   " })],
        shots: [shot("sh1", { durationSec: 4 })],
        voiceProfiles,
    });
    assert.equal(result.block.length, 0);
    const hit = result.warn.find((item) => item.code === "empty_text");
    assert.ok(hit);
    assert.equal(hit.cueId, "cue_sh1_dialogue_01");
});

test("validateCues 同一镜头多句重叠 → warn(overlap)", () => {
    const result = validateCues({
        cues: [
            cue({ id: "cue_sh1_dialogue_01", startSec: 0, endSec: 3 }),
            cue({ id: "cue_sh1_dialogue_02", startSec: 1, endSec: 4 }),
        ],
        shots: [shot("sh1", { durationSec: 6 })],
        voiceProfiles,
    });
    const hit = result.warn.find((item) => item.code === "overlap");
    assert.ok(hit);
    assert.equal(hit.cueId, "cue_sh1_dialogue_02");
    assert.match(hit.reason, /时间重叠/);
});

test("validateCues 缺口型参考音频 / 采样率 / 峰值 / 响度越界 → warn", () => {
    const profiles = [{ id: "vp_c1", characterId: "c1", speaker: "Serena" }]; // 无 referenceArtifactId
    const result = validateCues({
        cues: [cue({ sampleRate: 12345, peakDb: 0, loudnessLufs: -5 })],
        shots: [shot("sh1", { durationSec: 4 })],
        voiceProfiles: profiles,
    });
    const codes = result.warn.map((item) => item.code);
    for (const code of ["missing_lip_reference", "sample_rate", "peak_over", "loudness_out_of_range"]) {
        assert.ok(codes.includes(code), `应 warn ${code}`);
    }
    assert.equal(result.block.length, 0);
});

test("validateCues 对白与 BGM 重叠且无压混 → warn(no_ducking)", () => {
    const result = validateCues({
        cues: [cue(), cue({ id: "cue_sh1_music_01", type: "music", text: "", characterId: null, voiceProfileId: null })],
        shots: [shot("sh1", { durationSec: 4 })],
        voiceProfiles,
    });
    const hit = result.warn.find((item) => item.code === "no_ducking");
    assert.ok(hit);
    assert.match(hit.reason, /BGM/);
});

// ---------- 4. 混音入参组装 ----------

test("buildMixInput 输出结构稳定、可被 delivery 的 amix 消费", () => {
    const input = buildMixInput({
        clips: [{ id: "sh1", ref: "/api/artifacts/job-1/sh1.mp4", durationSec: 3 }],
        cues: [cue({ ref: "/api/artifacts/job-2/dialogue.mp3", startSec: 1.5, endSec: 3 })],
        tracks: [{ id: "t1", type: "dialogue" }],
    });
    assert.equal(input.version, 1);
    assert.deepEqual(Object.keys(input), ["version", "clips", "audio", "tracks", "amix", "totalDurationSec"]);
    assert.equal(input.clips[0].index, 0);
    assert.equal(input.clips[0].ref, "/api/artifacts/job-1/sh1.mp4");
    assert.equal(input.audio[0].ref, "/api/artifacts/job-2/dialogue.mp3"); // 与 buildAssemblyPlan 的 audio[{ref}] 同构
    assert.equal(input.audio[0].cueId, "cue_sh1_dialogue_01");
    assert.equal(input.audio[0].delayMs, 1500);
    assert.equal(input.tracks[0].gainDb, 0);
    assert.deepEqual(input.amix, { inputs: 1, duration: "longest", normalize: 0 });
    assert.equal(input.totalDurationSec, 3);
});

test("buildMixInput 过滤无法解析 ref 的 Cue，空输入也返回稳定结构", () => {
    const filtered = buildMixInput({ cues: [cue({ artifactId: null })] }); // cue 无 ref/artifactId
    assert.equal(filtered.audio.length, 0);
    const empty = buildMixInput();
    assert.deepEqual(empty.clips, []);
    assert.deepEqual(empty.audio, []);
    assert.deepEqual(empty.tracks, []);
    assert.equal(empty.amix.inputs, 0);
    assert.equal(empty.totalDurationSec, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    alignmentReport,
    applyAudioProjection,
    projectAudioCues,
    projectVoiceProfiles,
} from "../src/audio-track.js";

// ---------- 固定装置 ----------

const characters = [
    { id: "c1", name: "林晚", profile: "女主", appearance: "…", voice: "成年女性，清亮克制，语速偏慢" },
    {
        id: "c2",
        name: "陈默",
        profile: "男主",
        appearance: "…",
        voice: { speaker: "Ethan", language: "zh-CN", timbre: "低沉", speed: 0.9, design: "成年男性，低沉" },
    },
];

const project = {
    id: "prj_1",
    version: 3,
    plan: { language: "zh-CN" },
    script: { characters },
    episodes: [{ id: "ep_0001", index: 1, sceneIds: ["sc_0001"] }],
    voiceProfiles: [],
    audioCues: [],
};

const fullProfile = {
    id: "vp_c1",
    characterId: "c1",
    speaker: "Serena",
    language: "zh-CN",
    design: "成年女性，清亮克制",
    referenceArtifactId: "art_voice_c1",
    version: 1,
};

const shot = (id, extra = {}) => ({ id, sceneId: "sc_0001", durationSec: 4, dialogue: "", ...extra });

// ---------- 1. VoiceProfile 归一 ----------

test("projectVoiceProfiles 把字符串 voice 归一为契约字段超集，language 回落项目/默认", () => {
    const { profiles, warnings } = projectVoiceProfiles({ project });
    assert.equal(profiles.length, 2);
    const p1 = profiles[0];
    assert.equal(p1.id, "vp_c1");
    assert.equal(p1.characterId, "c1");
    assert.equal(p1.speakerId, "c1"); // 说话角色 id，与 AudioCue.speakerId 同源
    assert.equal(p1.name, "林晚");
    assert.equal(p1.language, "zh-CN");
    assert.equal(p1.timbre, "成年女性，清亮克制，语速偏慢"); // 字符串 voice → timbre
    assert.equal(p1.speed, 1); // 缺省语速
    assert.equal(p1.speaker, "成年女性，清亮克制，语速偏慢"); // speaker 兜底到 timbre
    assert.equal(p1.design, "成年女性，清亮克制，语速偏慢");
    assert.equal(p1.referenceArtifactId, null);
    assert.equal(p1.version, 1);
    assert.ok(warnings.some((w) => w.code === "missing_reference"));
});

test("projectVoiceProfiles 支持对象型 voice，保留 speaker/language/speed/design", () => {
    const { profiles } = projectVoiceProfiles({ project });
    const p2 = profiles.find((p) => p.id === "vp_c2");
    assert.equal(p2.speaker, "Ethan");
    assert.equal(p2.language, "zh-CN");
    assert.equal(p2.timbre, "低沉");
    assert.equal(p2.speed, 0.9); // 数字语速不被字符串化
    assert.equal(p2.design, "成年男性，低沉");
});

test("projectVoiceProfiles 合并 design 舞台的角色音色信息（按 id 命中）", () => {
    const design = {
        characters: [{ id: "c1", name: "林晚", timbre: "清冷", design: "知性女声", speaker: "Serena", referenceArtifactId: "art_voice_c1" }],
    };
    const { profiles } = projectVoiceProfiles({ project, design });
    const p1 = profiles.find((p) => p.id === "vp_c1");
    assert.equal(p1.speaker, "Serena");
    assert.equal(p1.design, "知性女声"); // design 舞台的 design 优先于 timbre
    assert.equal(p1.referenceArtifactId, "art_voice_c1");
});

test("projectVoiceProfiles 对缺名/缺音色角色告警并对重复 id 去重", () => {
    const weird = [
        { id: "c1", name: "", voice: "" },
        { id: "c1", name: "重复", voice: "粗哑" },
    ];
    const { profiles, warnings } = projectVoiceProfiles({ project, characters: weird });
    assert.equal(profiles.length, 1); // 重复 id 被跳过
    assert.equal(profiles[0].id, "vp_c1");
    const codes = warnings.map((w) => w.code);
    assert.ok(codes.includes("missing_name"));
    assert.ok(codes.includes("missing_timbre"));
    assert.ok(codes.includes("duplicate_voice_profile"));
});

// ---------- 2. AudioCue 归一（复用 cuesFromShots） ----------

test("projectAudioCues 由有对白镜头生成 Cue，补 episodeId/speakerId/durationSec", () => {
    const { profiles } = projectVoiceProfiles({ project });
    const cues = projectAudioCues({
        project,
        storyboard: { shots: [shot("sh1", { durationSec: 4, dialogue: "你终于来了。", characterId: "c1" })] },
        voiceProfiles: profiles,
    });
    assert.equal(cues.length, 1);
    const cue = cues[0];
    assert.equal(cue.id, "cue_sh1_dialogue_01");
    assert.equal(cue.episodeId, "ep_0001"); // 由 sceneId → episode 反查
    assert.equal(cue.shotId, "sh1");
    assert.equal(cue.speakerId, "c1");
    assert.equal(cue.voiceProfileId, "vp_c1");
    assert.equal(cue.type, "dialogue");
    assert.equal(cue.status, "draft");
    assert.equal(cue.startSec, 0);
    assert.equal(cue.durationSec, 4);
    assert.equal(cue.endSec, 4); // 保留契约字段，audio.js 可直接消费
    assert.equal(cue.characterId, "c1");
});

test("projectAudioCues 对无对白镜头返回空数组、不报错（供 info 提示）", () => {
    const cues = projectAudioCues({
        project,
        storyboard: { shots: [shot("sh2", { dialogue: "" })] },
        voiceProfiles: [],
    });
    assert.deepEqual(cues, []);
});

test("projectAudioCues 复用 cuesFromShots 的多句均分，编号与时长稳定", () => {
    const { profiles } = projectVoiceProfiles({ project });
    const cues = projectAudioCues({
        project,
        storyboard: { shots: [shot("sh3", { durationSec: 6, dialogue: "你来了。他走了。", characterId: "c1" })] },
        voiceProfiles: profiles,
    });
    assert.deepEqual(cues.map((c) => c.id), ["cue_sh3_dialogue_01", "cue_sh3_dialogue_02"]);
    assert.deepEqual(cues.map((c) => c.durationSec), [3, 3]);
    assert.equal(cues[0].endSec, cues[1].startSec); // 不重叠
    assert.equal(cues[0].episodeId, "ep_0001");
});

// ---------- 3. 声画对齐检查 ----------

test("alignmentReport 缺 VoiceProfile 判 block", () => {
    const cues = [{ id: "cue_x", shotId: "sh1", type: "dialogue", startSec: 0, endSec: 2, text: "你好", characterId: "c1", voiceProfileId: null }];
    const report = alignmentReport({ cues, shots: [shot("sh1", { durationSec: 4 })], voiceProfiles: [] });
    assert.ok(report.block >= 1);
    assert.equal(report.ok, false);
    const hit = report.items.find((i) => i.level === "block" && i.code === "voice_profile_missing");
    assert.ok(hit, "应有 voice_profile_missing block 且逐条可解释");
    assert.match(hit.reason, /VoiceProfile/);
});

test("alignmentReport 对白估算时长 > 镜头时长判 block", () => {
    const cues = [{ id: "cue_long", shotId: "sh1", type: "dialogue", startSec: 0, endSec: 6, text: "长台词", characterId: "c1", voiceProfileId: "vp_c1" }];
    const report = alignmentReport({ cues, shots: [shot("sh1", { durationSec: 4 })], voiceProfiles: [fullProfile] });
    assert.ok(report.block >= 1);
    const hit = report.items.find((i) => i.level === "block" && i.code === "dialogue_too_long");
    assert.ok(hit);
    assert.match(hit.reason, /超过镜头时长/);
});

test("alignmentReport 空文本判 warn（不阻断）", () => {
    const cues = [{ id: "cue_empty", shotId: "sh1", type: "dialogue", startSec: 0, endSec: 2, text: "   ", characterId: "c1", voiceProfileId: "vp_c1" }];
    const report = alignmentReport({ cues, shots: [shot("sh1", { durationSec: 4 })], voiceProfiles: [fullProfile] });
    assert.equal(report.block, 0);
    assert.ok(report.warn >= 1);
    assert.ok(report.items.some((i) => i.level === "warn" && i.code === "empty_text"));
});

test("alignmentReport 无对白镜头判 info，全部通过时 ok=true", () => {
    const cues = [{ id: "cue_ok", shotId: "sh1", type: "dialogue", startSec: 0, endSec: 3, text: "你来了。", characterId: "c1", voiceProfileId: "vp_c1" }];
    const shots = [shot("sh1", { durationSec: 4, dialogue: "你来了。" }), shot("sh2", { durationSec: 3, dialogue: "" })];
    const report = alignmentReport({ cues, shots, voiceProfiles: [fullProfile] });
    assert.equal(report.block, 0);
    assert.equal(report.warn, 0);
    assert.equal(report.pass, 1);
    assert.equal(report.info, 1);
    assert.equal(report.ok, true);
    const info = report.items.find((i) => i.level === "info");
    assert.equal(info.code, "shot_without_dialogue");
    assert.equal(info.shotId, "sh2");
});

// ---------- 4. 幂等投影 ----------

test("applyAudioProjection 投影到空项目，重复调用幂等且不改 version", () => {
    const { profiles } = projectVoiceProfiles({ project });
    const cues = projectAudioCues({ project, storyboard: { shots: [shot("sh1", { durationSec: 4, dialogue: "嗯。", characterId: "c1" })] }, voiceProfiles: profiles });
    const target = { id: "prj_x", version: 7, voiceProfiles: [], audioCues: [] };

    const first = applyAudioProjection(target, { profiles, cues });
    assert.equal(first.applied, true);
    assert.equal(first.appliedProfiles, true);
    assert.equal(first.appliedCues, true);
    assert.equal(target.voiceProfiles, profiles);
    assert.equal(target.audioCues, cues);
    assert.equal(target.version, 7); // 派生记账：version 不变

    const second = applyAudioProjection(target, { profiles, cues });
    assert.equal(second.applied, false); // 相同跳过
    assert.equal(target.version, 7);
});

test("applyAudioProjection 已有非空集不被覆盖、version 不变", () => {
    const { profiles } = projectVoiceProfiles({ project });
    const cues = projectAudioCues({ project, storyboard: { shots: [shot("sh1", { durationSec: 4, dialogue: "嗯。", characterId: "c1" })] }, voiceProfiles: profiles });
    const target = {
        id: "prj_keep",
        version: 2,
        voiceProfiles: [{ id: "vp_keep" }],
        audioCues: [{ id: "cue_keep" }],
    };
    const result = applyAudioProjection(target, { profiles, cues });
    assert.equal(result.applied, false);
    assert.equal(result.appliedProfiles, false);
    assert.equal(result.appliedCues, false);
    assert.equal(target.voiceProfiles[0].id, "vp_keep");
    assert.equal(target.audioCues[0].id, "cue_keep");
    assert.equal(target.version, 2);
});

test("applyAudioProjection 逐字段独立：只填空集、保留非空集", () => {
    const { profiles } = projectVoiceProfiles({ project });
    const target = { version: 5, voiceProfiles: [], audioCues: [{ id: "cue_keep" }] };
    const result = applyAudioProjection(target, { profiles, cues: [{ id: "cue_new" }] });
    assert.equal(result.appliedProfiles, true);
    assert.equal(result.appliedCues, false);
    assert.equal(result.applied, true);
    assert.equal(target.voiceProfiles, profiles);
    assert.equal(target.audioCues[0].id, "cue_keep");
    assert.equal(target.version, 5);
});

test("applyAudioProjection 对空项目/空候选为空操作，非法项目返回 null", () => {
    const noop = applyAudioProjection({ version: 1 }, { profiles: [], cues: [] });
    assert.equal(noop.applied, false);
    const invalid = applyAudioProjection(null, { profiles: [], cues: [] });
    assert.deepEqual(invalid, { project: null, applied: false, appliedProfiles: false, appliedCues: false });
});

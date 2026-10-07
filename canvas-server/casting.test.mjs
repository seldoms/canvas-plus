/**
 * 角色定妆身份卡契约层（casting.js）行为锁定：
 *   · 冻结契约字段归一 / 旧数据兼容（缺字段补默认、非法枚举回落）；
 *   · confirmed 三级自洽（脸 + 声都真才算角色确认）；
 *   · faceReady / voiceReady / castingReadiness 判据（缺脸还是缺声）；
 *   · buildCastingOutput：复用 design 脸产物 + VoiceProfile 声音事实，重跑继承已确认状态。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    buildCastingOutput,
    castingReadiness,
    emptyFace,
    emptyVoice,
    faceArtifactsFor,
    faceReady,
    isCastingConfirmed,
    normalizeCasting,
    normalizeCharacterCard,
    normalizeFace,
    normalizeVoice,
    voiceReady,
} from "../src/casting.js";

const DESIGN = {
    characters: [{ id: "c1", name: "阿海", closeupPrompt: "x", turnaroundPrompt: "y" }],
    references: [
        { id: "c1-closeup", bindingId: "c1", role: "character", kind: "closeup", artifactUrl: "/api/artifacts/j1/closeup.png", status: "done" },
        { id: "c1-turnaround", bindingId: "c1", role: "character", kind: "turnaround", artifactUrl: "/api/artifacts/j2/turnaround.png", status: "done" },
    ],
};

const PROFILES = [{ id: "vp_c1", characterId: "c1", name: "阿海", speaker: "低沉沙哑，语速偏慢", design: "低沉沙哑，语速偏慢", language: "zh-CN", speed: 0.9, timbre: "低沉" }];

test("emptyFace / emptyVoice 契约键齐全且默认值正确", () => {
    // source：脸的取料来源标记（pack=人工从资料包选用/归入、design=03 自动绑定、prev=沿用上次、none=未取到）。
    assert.deepEqual(emptyFace(), { closeupArtifactId: "", turnaroundArtifactIds: [], confirmed: false, source: "none" });
    assert.deepEqual(emptyVoice(), { voiceProfileId: "", speaker: "", design: "", speed: 1, language: "Auto", previewArtifactId: "", confirmed: false });
});

test("normalizeFace / normalizeVoice：缺字段补默认、非法枚举回落、字符串数组收敛", () => {
    assert.deepEqual(normalizeFace({}), { closeupArtifactId: "", turnaroundArtifactIds: [], confirmed: false, source: "none" });
    assert.deepEqual(normalizeFace({ turnaroundArtifactIds: ["a", "", null, "b"], confirmed: true }), { closeupArtifactId: "", turnaroundArtifactIds: ["a", "b"], confirmed: true, source: "none" });
    // 非法 source 枚举 → none，绝不把未知值透传给前端当来源显示。
    assert.equal(normalizeFace({ source: "hacker" }).source, "none");
    assert.equal(normalizeFace({ source: "pack" }).source, "pack");
    // 非法音色 → 回落空串；非法语种 → 回落 Auto；speed 非法 → 1。
    assert.deepEqual(normalizeVoice({ speaker: "hacker", language: "Klingon", speed: -2 }), {
        voiceProfileId: "",
        speaker: "",
        design: "",
        speed: 1,
        language: "Auto",
        previewArtifactId: "",
        confirmed: false,
    });
    assert.equal(normalizeVoice({ speaker: "Uncle_fu", language: "Chinese", speed: 1.2 }).speaker, "Uncle_fu");
});

test("normalizeCharacterCard：confirmed 与「脸+声都真」自洽（不许写了 true 却其实不满足）", () => {
    const lying = normalizeCharacterCard({ characterId: "c1", face: { closeupArtifactId: "a", confirmed: true }, voice: { speaker: "Uncle_fu", confirmed: true }, confirmed: true, version: 3, lockedAt: "2026-10-04T00:00:00.000Z" });
    assert.equal(lying.confirmed, true);
    assert.equal(lying.version, 3);
    // 脸确认了但没产物 → 实际不真 → 角色 confirmed 回落 false，lockedAt 清空。
    const fake = normalizeCharacterCard({ characterId: "c2", face: { confirmed: true }, voice: { speaker: "Serena", confirmed: true }, confirmed: true, lockedAt: "x" });
    assert.equal(fake.confirmed, false);
    assert.equal(fake.lockedAt, null);
    // 缺 characterId → 按 index 生成 c1 / 默认 version 1。
    assert.equal(normalizeCharacterCard({}, 0).characterId, "c1");
    assert.equal(normalizeCharacterCard({}, 0).version, 1);
});

test("faceReady / voiceReady 判据：确认 + 有产物 / 确认 + 合法音色", () => {
    assert.equal(faceReady({ closeupArtifactId: "a", confirmed: true }), true);
    assert.equal(faceReady({ turnaroundArtifactIds: ["b"], confirmed: true }), true);
    assert.equal(faceReady({ confirmed: true }), false, "无产物不算已锁脸");
    assert.equal(faceReady({ closeupArtifactId: "a", confirmed: false }), false);
    assert.equal(voiceReady({ speaker: "Uncle_fu", confirmed: true }), true);
    assert.equal(voiceReady({ speaker: "hacker", confirmed: true }), false, "非法音色不算已锁声");
    assert.equal(voiceReady({ speaker: "Uncle_fu", confirmed: false }), false);
});

test("castingReadiness：存在未确认角色 → blocked 逐角色列出缺脸/缺声", () => {
    const output = normalizeCasting({
        characters: [
            { characterId: "c1", name: "阿海", face: { closeupArtifactId: "a", confirmed: true }, voice: { speaker: "Uncle_fu", confirmed: false } },
            { characterId: "c2", name: "小满", face: { confirmed: false }, voice: { speaker: "Serena", confirmed: true } },
        ],
    });
    const r = castingReadiness(output);
    assert.equal(r.ready, false);
    assert.equal(r.present, true);
    assert.deepEqual(r.blocked.map((b) => [b.characterId, b.missing]), [
        ["c1", ["声音"]],
        ["c2", ["脸"]],
    ]);
    assert.match(r.reason, /阿海.*声音/);
    assert.match(r.reason, /小满.*脸/);

    // 无角色 → present:false，reason 提示先完成角色定妆。
    const none = castingReadiness({ characters: [] });
    assert.equal(none.present, false);
    assert.equal(none.ready, false);
    assert.match(none.reason, /尚未产出/);
});

test("castingReadiness：全部确认真实 → ready（放行下游）", () => {
    const output = normalizeCasting({
        characters: [
            { characterId: "c1", name: "阿海", face: { closeupArtifactId: "a", confirmed: true }, voice: { speaker: "Uncle_fu", confirmed: true }, confirmed: true },
            { characterId: "c2", name: "小满", face: { turnaroundArtifactIds: ["b"], confirmed: true }, voice: { speaker: "Serena", confirmed: true }, confirmed: true },
        ],
    });
    const r = castingReadiness(output);
    assert.equal(r.ready, true);
    assert.equal(r.blocked.length, 0);
    assert.equal(r.reason, "");
    assert.equal(isCastingConfirmed(output), true);
});

test("faceArtifactsFor：复用 design.references（closeup/turnaround），回落 characters 字段", () => {
    assert.deepEqual(faceArtifactsFor(DESIGN, "c1"), {
        closeupArtifactId: "/api/artifacts/j1/closeup.png",
        turnaroundArtifactIds: ["/api/artifacts/j2/turnaround.png"],
    });
    // references 缺失 → 回落 design.characters[].referenceArtifactIds / turnaroundArtifactIds。
    const legacy = { characters: [{ id: "c9", referenceArtifactIds: ["/art/c9.png"], turnaroundArtifactIds: ["/art/c9t.png"] }] };
    assert.deepEqual(faceArtifactsFor(legacy, "c9"), { closeupArtifactId: "/art/c9.png", turnaroundArtifactIds: ["/art/c9t.png"] });
    // 无任何脸产物 → 空。
    assert.deepEqual(faceArtifactsFor({}, "cX"), { closeupArtifactId: "", turnaroundArtifactIds: [] });
});

test("buildCastingOutput：脸取 design 产物、声取 VoiceProfile（适配成合法枚举），重跑继承已确认状态", () => {
    const characters = [
        { id: "c1", name: "阿海" },
        { id: "c2", name: "小满" },
    ];
    const out = buildCastingOutput({ characters, design: DESIGN, voiceProfiles: PROFILES });
    assert.equal(out.characters.length, 2);
    const c1 = out.characters.find((card) => card.characterId === "c1");
    assert.equal(c1.face.closeupArtifactId, "/api/artifacts/j1/closeup.png");
    assert.deepEqual(c1.face.turnaroundArtifactIds, ["/api/artifacts/j2/turnaround.png"]);
    assert.equal(c1.face.confirmed, false, "新产物默认未确认");
    assert.equal(c1.voice.voiceProfileId, "vp_c1");
    assert.equal(c1.voice.speaker, "Uncle_fu", "『低沉沙哑』应适配成 Uncle_fu");
    assert.equal(c1.voice.language, "Chinese", "zh-CN → Chinese");
    assert.equal(c1.voice.speed, 0.9);
    assert.equal(c1.confirmed, false);
    assert.equal(c1.lockedAt, null);
    // c2 无 design 产物 / 无 VoiceProfile → 脸空、声仍合法枚举（散列兜底）。
    const c2 = out.characters.find((card) => card.characterId === "c2");
    assert.equal(c2.face.closeupArtifactId, "");
    assert.equal(c2.voice.speaker.length > 0, true);

    // 重跑：把 c1 的脸+声都确认，再 build 一次 → 产物仍在时确认状态被继承。
    const confirmedPrev = {
        characters: [
            { characterId: "c1", name: "阿海", face: { closeupArtifactId: "/api/artifacts/j1/closeup.png", turnaroundArtifactIds: ["/api/artifacts/j2/turnaround.png"], confirmed: true }, voice: { voiceProfileId: "vp_c1", speaker: "Uncle_fu", design: "低沉沙哑", speed: 1, language: "Chinese", previewArtifactId: "/api/artifacts/p/preview.flac", confirmed: true }, confirmed: true, version: 2, lockedAt: "2026-10-04T00:00:00.000Z" },
        ],
    };
    const again = buildCastingOutput({ characters, design: DESIGN, voiceProfiles: PROFILES, prev: confirmedPrev });
    const c1again = again.characters.find((card) => card.characterId === "c1");
    assert.equal(c1again.face.confirmed, true, "重跑应继承脸确认");
    assert.equal(c1again.voice.confirmed, true, "重跑应继承声确认");
    assert.equal(c1again.voice.previewArtifactId, "/api/artifacts/p/preview.flac");
    assert.equal(c1again.confirmed, true);
    assert.equal(c1again.version, 2);
});

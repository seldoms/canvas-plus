import assert from "node:assert/strict";
import { test } from "node:test";

import {
    computeInputFingerprint,
    isReusable,
    normalizeAudioCue,
    normalizeCharacterRef,
    normalizeProvenance,
    normalizeProjectBrief,
    normalizeRevisionRef,
    normalizeSceneRef,
    normalizeShotCamera,
    normalizeStaleStatus,
    normalizeVoiceProfile,
    parseLegacyCamera,
} from "../src/production-contracts.js";

/**
 * 生产对象契约单测（§13 / §11.5 追加冻结）——本波只验规整/校验与旧 camera 解析，不接线流水线。
 * 每个实体覆盖三类：合法样例通过 / 缺字段安全默认 / 非法值被拒或降级。
 */

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error("期望抛出异常，但没有");
}

const fieldsOf = (warnings) => warnings.map((item) => item.field);
const codesOf = (warnings) => warnings.map((item) => item.code);

/* ------------------------------ ProjectBrief（§13.1） ------------------------------ */

test("ProjectBrief：合法样例整份通过，无告警", () => {
    const brief = {
        market: "global",
        languages: ["zh-CN", "en-US"],
        platformProfiles: ["vertical-short-drama-9x16"],
        episodeCount: 2,
        episodeDurationSec: 30,
        visualMode: "external_drama",
        audioMode: "separate_dialogue_track",
        delivery: { video: "h264-aac-mp4", subtitles: ["vtt", "srt"], cover: true },
        budget: { maxJobs: 200, maxExternalCredits: 50 },
        rights: [{ scope: "source", status: "to_review" }],
        version: 1,
    };
    const { value, warnings } = normalizeProjectBrief(brief);
    assert.deepEqual(value, brief);
    assert.equal(warnings.length, 0);
});

test("ProjectBrief：缺字段全部规范化为安全默认并逐条告警", () => {
    const { value, warnings } = normalizeProjectBrief({});
    assert.deepEqual(value, {
        market: "global",
        languages: [],
        platformProfiles: [],
        episodeCount: 1,
        episodeDurationSec: 120,
        visualMode: "local_short",
        audioMode: "separate_dialogue_track",
        delivery: { video: "h264-aac-mp4", subtitles: [], cover: false },
        budget: { maxJobs: 0, maxExternalCredits: 0 },
        rights: [],
        version: 1,
    });
    assert.equal(warnings.length, 11);
    assert.ok(codesOf(warnings).every((code) => code === "defaulted"));
    for (const field of ["market", "languages", "episodeCount", "visualMode", "audioMode", "delivery", "budget", "rights", "version"]) {
        assert.ok(fieldsOf(warnings).includes(field), `应告警 ${field}`);
    }
});

test("ProjectBrief：非法值降级到安全默认（含 §13.1 样例 external_video_api 与 §11.5.1 别名 separate_track）", () => {
    const { value, warnings } = normalizeProjectBrief({ visualMode: "external_video_api", audioMode: "separate_track", episodeCount: -3, rights: "nope" });
    assert.equal(value.visualMode, "local_short");
    assert.equal(value.audioMode, "separate_dialogue_track");
    assert.equal(value.episodeCount, 1);
    assert.deepEqual(value.rights, []);
    for (const field of ["visualMode", "audioMode", "episodeCount", "rights"]) {
        assert.ok(warnings.some((item) => item.field === field && item.code === "degraded"), `${field} 应降级`);
    }
});

test("ProjectBrief：非对象输入被拒（400）", () => {
    assert.equal(catchError(() => normalizeProjectBrief(5)).status, 400);
    assert.equal(catchError(() => normalizeProjectBrief("x")).status, 400);
});

/* ------------------------------ VoiceProfile（§11.5.1） ------------------------------ */

test("VoiceProfile：合法样例整份通过", () => {
    const profile = {
        id: "vp_c1",
        characterId: "c1",
        language: "zh-CN",
        speaker: "Serena",
        design: "成年女性，清亮、克制、语速偏慢，紧张时尾音上扬",
        referenceArtifactId: "art_voice_c1_anchor",
        version: 1,
    };
    const { value, warnings } = normalizeVoiceProfile(profile);
    assert.deepEqual(value, profile);
    assert.equal(warnings.length, 0);
});

test("VoiceProfile：缺可选字段回落安全默认", () => {
    const { value, warnings } = normalizeVoiceProfile({ id: "vp_c2", characterId: "c2" });
    assert.deepEqual(value, { id: "vp_c2", characterId: "c2", language: "zh-CN", speaker: "", design: "", referenceArtifactId: null, version: 1 });
    assert.deepEqual(fieldsOf(warnings).sort(), ["design", "language", "referenceArtifactId", "speaker", "version"]);
});

test("VoiceProfile：缺稳定身份 id / characterId 被拒（400）；空 language 降级回 zh-CN", () => {
    assert.equal(catchError(() => normalizeVoiceProfile({ characterId: "c1" })).status, 400);
    assert.equal(catchError(() => normalizeVoiceProfile({ id: "vp_c1" })).field, "characterId");
    const degraded = normalizeVoiceProfile({ id: "vp_c1", characterId: "c1", language: "   " });
    assert.equal(degraded.value.language, "zh-CN");
    assert.equal(degraded.warnings[0].code, "degraded");
});

/* ------------------------------ AudioCue（§13.5） ------------------------------ */

test("AudioCue：合法样例整份通过", () => {
    const cue = {
        id: "cue_sh12_dialogue_01",
        shotId: "sh12",
        type: "dialogue",
        startSec: 1.2,
        endSec: 3.8,
        text: "你终于来了。",
        characterId: "c1",
        voiceProfileId: "vp_c1",
        artifactId: "art_audio_001",
        status: "approved",
    };
    const { value, warnings } = normalizeAudioCue(cue);
    assert.deepEqual(value, cue);
    assert.equal(warnings.length, 0);
});

test("AudioCue：缺可选字段回落安全默认，endSec 缺省对齐 startSec", () => {
    const { value, warnings } = normalizeAudioCue({ id: "cue_1", type: "sfx" });
    assert.deepEqual(value, { id: "cue_1", shotId: "", type: "sfx", startSec: 0, endSec: 0, text: "", characterId: null, voiceProfileId: null, artifactId: null, status: "draft" });
    assert.deepEqual(fieldsOf(warnings).sort(), ["artifactId", "characterId", "shotId", "startSec", "status", "text", "voiceProfileId"]);
});

test("AudioCue：type 缺失/非法被拒（400）", () => {
    assert.equal(catchError(() => normalizeAudioCue({ id: "cue_1" })).field, "type");
    assert.equal(catchError(() => normalizeAudioCue({ id: "cue_1", type: "boom" })).field, "type");
    assert.equal(catchError(() => normalizeAudioCue({})).field, "id");
});

test("AudioCue：时间区间倒挂被拒（400）", () => {
    const error = catchError(() => normalizeAudioCue({ id: "cue_1", type: "dialogue", startSec: 5, endSec: 2 }));
    assert.equal(error.status, 400);
    assert.equal(error.field, "endSec");
});

/* ------------------------------ CharacterRef / SceneRef（§11.5.2） ------------------------------ */

test("CharacterRef：合法样例整份通过（含 metadata.views / confirmed）", () => {
    const ref = {
        id: "aref_c1",
        role: "character",
        bindingId: "c1",
        artifactIds: ["art_c1_turnaround", "art_c1_closeup"],
        selectedArtifactId: "art_c1_turnaround",
        metadata: { views: ["front", "three_quarter", "side", "back"], confirmed: true },
    };
    const { value, warnings } = normalizeCharacterRef(ref);
    assert.deepEqual(value, ref);
    assert.equal(warnings.length, 0);
});

test("SceneRef：role 固定为 scene，合法样例通过", () => {
    const { value } = normalizeSceneRef({ id: "aref_s1", bindingId: "s1", artifactIds: ["art_scene_master"], selectedArtifactId: "art_scene_master", metadata: { views: ["master"], confirmed: false } });
    assert.equal(value.role, "scene");
    assert.deepEqual(value.artifactIds, ["art_scene_master"]);
    assert.equal(value.metadata.confirmed, false);
});

test("生产引用：缺可选字段回落安全默认", () => {
    const { value, warnings } = normalizeCharacterRef({ id: "aref_c2", bindingId: "c2" });
    assert.deepEqual(value, { id: "aref_c2", role: "character", bindingId: "c2", artifactIds: [], selectedArtifactId: null, metadata: { views: [], confirmed: false } });
    assert.deepEqual(fieldsOf(warnings).sort(), ["artifactIds", "metadata"]);
});

test("生产引用：role 不符 / 缺 id / 缺 bindingId / 选中不在候选内 → 全部被拒（400）", () => {
    assert.equal(catchError(() => normalizeSceneRef({ id: "aref_s1", role: "character", bindingId: "s1" })).field, "role");
    assert.equal(catchError(() => normalizeCharacterRef({ bindingId: "c1" })).field, "id");
    assert.equal(catchError(() => normalizeCharacterRef({ id: "aref_c1" })).field, "bindingId");
    const error = catchError(() => normalizeCharacterRef({ id: "aref_c1", bindingId: "c1", artifactIds: ["a1"], selectedArtifactId: "a2" }));
    assert.equal(error.status, 400);
    assert.equal(error.field, "selectedArtifactId");
});

/* ------------------------------ ShotCamera（§11.5.2） ------------------------------ */

test("ShotCamera：合法样例整份通过（focus / movement 子结构）", () => {
    const camera = {
        position: "subject-front-right",
        height: "chest",
        angle: "15deg-up",
        lens: "50mm",
        aperture: "f2.8",
        focus: { from: "door", to: "face", atSec: 2.2 },
        movement: { type: "dolly", direction: "forward", speed: "slow", stabilization: "steady" },
    };
    const { value, warnings } = normalizeShotCamera(camera);
    assert.deepEqual(value, camera);
    assert.equal(warnings.length, 0);
});

test("ShotCamera：缺字段回落空安全默认（空串 / null），不告警", () => {
    const { value, warnings } = normalizeShotCamera({});
    assert.deepEqual(value, { position: "", height: "", angle: "", lens: "", aperture: "", focus: null, movement: null });
    assert.equal(warnings.length, 0);
});

test("ShotCamera：focus / movement 非对象降级为 null 并告警", () => {
    const { value, warnings } = normalizeShotCamera({ focus: "manual", movement: 3 });
    assert.equal(value.focus, null);
    assert.equal(value.movement, null);
    assert.deepEqual(fieldsOf(warnings).sort(), ["focus", "movement"]);
    assert.ok(codesOf(warnings).every((code) => code === "degraded"));
});

test("parseLegacyCamera：旧中文长字符串可拆出机位/焦段/光圈/运镜", () => {
    const { camera, reason } = parseLegacyCamera("机位：正面平视近景，50mm，f/2.8，固定镜头");
    assert.equal(reason, null);
    assert.equal(camera.position, "subject-front");
    assert.equal(camera.angle, "eye-level");
    assert.equal(camera.height, "chest");
    assert.equal(camera.lens, "50mm");
    assert.equal(camera.aperture, "f2.8");
    assert.equal(camera.movement.type, "static");
});

test("parseLegacyCamera：解析不出来返回 null + 原因，不抛异常", () => {
    const blank = parseLegacyCamera("");
    assert.equal(blank.camera, null);
    assert.match(blank.reason, /为空/);
    const garbage = parseLegacyCamera("###");
    assert.equal(garbage.camera, null);
    assert.match(garbage.reason, /未识别/);
    assert.equal(parseLegacyCamera(123).camera, null);
});

/* ------------------------------ Provenance（§13.9） ------------------------------ */

test("Provenance：合法样例整份通过", () => {
    const provenance = {
        projectId: "prj_1",
        workflowRunId: "run_1",
        inputRevisions: { script: "rev_12", design: "rev_8", audio: "rev_3" },
        toolSnapshot: { toolId: "video.external.v1", providerId: "provider_a", model: "model_x" },
        deviceId: null,
        costEstimate: { localGpuSec: 0, externalCredits: 2.4 },
        startedAt: "2026-10-03T12:00:00.000Z",
    };
    const { value, warnings } = normalizeProvenance(provenance);
    assert.deepEqual(value, provenance);
    assert.equal(warnings.length, 0);
});

test("Provenance：缺字段回落安全默认", () => {
    const { value, warnings } = normalizeProvenance({});
    assert.deepEqual(value, { projectId: "", workflowRunId: "", inputRevisions: {}, toolSnapshot: { toolId: "", providerId: "", model: "" }, deviceId: null, costEstimate: { localGpuSec: 0, externalCredits: 0 }, startedAt: null });
    assert.equal(warnings.length, 7);
});

test("Provenance：非法数值 / 非法映射降级", () => {
    const { value, warnings } = normalizeProvenance({ costEstimate: { localGpuSec: -5, externalCredits: "x" }, inputRevisions: "bad" });
    assert.deepEqual(value.costEstimate, { localGpuSec: 0, externalCredits: 0 });
    assert.deepEqual(value.inputRevisions, {});
    assert.ok(warnings.some((item) => item.field === "costEstimate.localGpuSec" && item.code === "degraded"));
    assert.ok(warnings.some((item) => item.field === "inputRevisions" && item.code === "degraded"));
});

/* ------------------------------ RevisionRef / InputFingerprint / StaleStatus（§11.5.3） ------------------------------ */

test("RevisionRef：合法样例通过；缺 revision 默认 1；缺 id 被拒", () => {
    assert.deepEqual(normalizeRevisionRef({ type: "assetRef", id: "aref_c1", revision: 2 }).value, { type: "assetRef", id: "aref_c1", revision: 2 });
    const missing = normalizeRevisionRef({ id: "aref_c1" });
    assert.equal(missing.value.revision, 1);
    assert.equal(missing.value.type, "");
    assert.equal(catchError(() => normalizeRevisionRef({})).field, "id");
});

test("InputFingerprint：稳定序列化（key 顺序无关、值不同则不同）", () => {
    assert.equal(computeInputFingerprint({ a: 1, b: 2 }), computeInputFingerprint({ b: 2, a: 1 }));
    assert.notEqual(computeInputFingerprint({ a: 1, b: 2 }), computeInputFingerprint({ a: 1, b: 3 }));
    assert.match(computeInputFingerprint({ a: 1 }), /^[0-9a-f]{64}$/);
});

test("isReusable：指纹一致 + done + 已选产物，三者缺一不可", () => {
    const input = { script: "rev_1", design: "rev_2" };
    const fingerprint = computeInputFingerprint(input);
    assert.equal(isReusable({ inputFingerprint: fingerprint, status: "done", selectedArtifactId: "art_1" }, input), true);
    assert.equal(isReusable({ inputFingerprint: fingerprint, status: "running", selectedArtifactId: "art_1" }, input), false);
    assert.equal(isReusable({ inputFingerprint: "deadbeef", status: "done", selectedArtifactId: "art_1" }, input), false);
    assert.equal(isReusable({ inputFingerprint: fingerprint, status: "done", selectedArtifactId: null }, input), false);
});

test("StaleStatus：stale / fresh 通过，未知值降级为 fresh 并告警", () => {
    assert.deepEqual(normalizeStaleStatus("stale"), { value: "stale", warnings: [] });
    assert.deepEqual(normalizeStaleStatus("fresh"), { value: "fresh", warnings: [] });
    const degraded = normalizeStaleStatus("expired");
    assert.equal(degraded.value, "fresh");
    assert.equal(degraded.warnings[0].code, "degraded");
    assert.equal(normalizeStaleStatus(undefined).warnings[0].code, "defaulted");
});

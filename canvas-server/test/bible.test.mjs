import assert from "node:assert/strict";
import { test } from "node:test";

import {
    BIBLE_STATE,
    bumpRevision,
    isConsumable,
    mergeBiblePatch,
    normalizeAudioBible,
    normalizeCharacterBible,
    normalizeProjectBrief,
    normalizeSeriesBible,
    normalizeWorldBible,
    transition,
} from "../src/bible.js";

/**
 * 制作圣经与确认锁单测（P0-f）——五类实体规整/校验 + `draft → review → approved → locked` 状态机 + revision 语义。
 * 覆盖：合法样例通过 / 缺字段安全默认 / 非法值被拒或降级 / 全部合法迁移 + 非法迁移被拒 / 只有 approved·locked 可消费 /
 *       改锁定对象产生新 revision 且原对象不变 / 幂等合并。
 */

const fieldsOf = (warnings) => warnings.map((item) => item.field);
const codesOf = (warnings) => warnings.map((item) => item.code);
const warn = (warnings, field, code) => warnings.some((w) => w.field === field && w.code === code);

/* ------------------------------ ProjectBrief（§13.1） ------------------------------ */

const validBrief = {
    genre: ["悬疑", "都市"],
    tone: ["冷峻", "快节奏"],
    audience: ["women-18-34"],
    market: "global",
    languages: ["zh-CN", "en-US"],
    platformProfiles: ["vertical-short-drama-9x16"],
    episodeCount: 2,
    episodeDurationSec: 30,
    visualMode: "local_short",
    audioMode: "separate_dialogue_track",
    delivery: { video: "h264-aac-mp4", subtitles: ["vtt", "srt"], cover: true },
    budget: { maxJobs: 200, maxExternalCredits: 50 },
    rights: [{ scope: "source", status: "to_review" }],
    version: 1,
};

test("ProjectBrief：合法样例整份通过，无告警", () => {
    const { value, warnings } = normalizeProjectBrief(validBrief);
    assert.deepEqual(value, validBrief);
    assert.equal(warnings.length, 0);
});

test("ProjectBrief：缺字段全部回落安全默认并逐条告警", () => {
    const { value, warnings } = normalizeProjectBrief({});
    assert.deepEqual(value.genre, []);
    assert.deepEqual(value.tone, []);
    assert.deepEqual(value.audience, []);
    assert.equal(value.market, "global");
    assert.equal(value.visualMode, "local_short");
    assert.equal(value.audioMode, "separate_dialogue_track");
    assert.equal(value.episodeDurationSec, 120);
    assert.equal(value.version, 1);
    for (const field of ["genre", "tone", "audience", "market", "visualMode", "budget", "version"]) {
        assert.ok(warn(warnings, field, "defaulted"), `期望 ${field} 有 defaulted 告警`);
    }
});

test("ProjectBrief：非法题材/基调降级为空数组，非法 visualMode 降级为 local_short", () => {
    const { value, warnings } = normalizeProjectBrief({ genre: 123, tone: "冷峻", audience: null, visualMode: "external_video_api" });
    assert.deepEqual(value.genre, []);
    assert.deepEqual(value.tone, []);
    assert.deepEqual(value.audience, []);
    assert.equal(value.visualMode, "local_short");
    assert.ok(warn(warnings, "genre", "degraded"));
    assert.ok(warnings.some((w) => w.field === "visualMode" && w.code === "degraded" && w.got === "external_video_api"));
});

test("ProjectBrief：整份输入非对象时降级为空规格并告警（不抛异常）", () => {
    const { value, warnings } = normalizeProjectBrief("不是对象");
    assert.deepEqual(value.genre, []);
    assert.ok(warn(warnings, "ProjectBrief", "degraded"));
});

/* ------------------------------ SeriesBible（§13.2） ------------------------------ */

const validSeries = {
    id: "sb_1",
    logline: "被冤枉的女主复仇",
    theme: "正义与代价",
    worldview: "现代都市",
    timeline: ["三年前", "当下"],
    narrativeRules: ["不出现超自然"],
    immutableFacts: ["女主父亲已故"],
    styleAnchors: ["冷色调", "手持"],
    characterIds: ["c1", "c2"],
    locationIds: ["loc1"],
    episodeSkeleton: [{ index: 1, title: "第一集", logline: "入局" }],
    relationships: [{ from: "c1", to: "c2", kind: "rival" }],
    status: "draft",
    revision: 1,
};

test("SeriesBible：合法样例整份通过，无告警，id 稳定", () => {
    const { value, warnings } = normalizeSeriesBible(validSeries);
    assert.deepEqual(value, validSeries);
    assert.equal(value.id, "sb_1");
    assert.equal(warnings.length, 0);
});

test("SeriesBible：缺 id 记 required，其余字段安全默认", () => {
    const { value, warnings } = normalizeSeriesBible({});
    assert.equal(value.id, "");
    assert.equal(value.logline, "");
    assert.deepEqual(value.episodeSkeleton, []);
    assert.deepEqual(value.relationships, []);
    assert.equal(value.status, "draft");
    assert.equal(value.revision, 1);
    assert.ok(warn(warnings, "id", "required"));
    assert.ok(warn(warnings, "styleAnchors", "defaulted"));
});

test("SeriesBible：非法 revision / 数组字段降级", () => {
    const { value, warnings } = normalizeSeriesBible({ id: "sb_1", revision: 0, styleAnchors: "冷色调", episodeSkeleton: "骨架" });
    assert.equal(value.revision, 1);
    assert.deepEqual(value.styleAnchors, []);
    assert.deepEqual(value.episodeSkeleton, []);
    assert.ok(warn(warnings, "revision", "degraded"));
    assert.ok(warn(warnings, "styleAnchors", "degraded"));
    assert.ok(warn(warnings, "episodeSkeleton", "degraded"));
});

test("SeriesBible：非法 status 降级为 draft", () => {
    const { value, warnings } = normalizeSeriesBible({ id: "sb_1", status: "published" });
    assert.equal(value.status, "draft");
    assert.ok(warn(warnings, "status", "degraded"));
});

/* ------------------------------ CharacterBible（§13.2 / §11.5.2） ------------------------------ */

const validCharacter = {
    id: "c1",
    name: "林晚",
    identity: "复仇女主",
    appearance: "黑色长发，左眉有疤",
    turnaroundArtifactIds: ["art_front", "art_side", "art_back"],
    closeupArtifactIds: ["art_closeup"],
    costumes: [{ name: "职业装", revision: 2, artifactIds: ["art_costume_v2"] }],
    performanceBounds: { allowed: ["克制"], forbidden: ["大笑"] },
    voiceProfileId: "vp_c1",
    language: "zh-CN",
    speechHabits: ["句子短促"],
    status: "approved",
    revision: 3,
};

test("CharacterBible：合法样例整份通过，无告警", () => {
    const { value, warnings } = normalizeCharacterBible(validCharacter);
    assert.deepEqual(value, validCharacter);
    assert.equal(warnings.length, 0);
});

test("CharacterBible：缺 id 记 required，无音色引用默认 null", () => {
    const { value, warnings } = normalizeCharacterBible({});
    assert.equal(value.id, "");
    assert.equal(value.voiceProfileId, null);
    assert.equal(value.language, "zh-CN");
    assert.deepEqual(value.costumes, []);
    assert.deepEqual(value.performanceBounds, { allowed: [], forbidden: [] });
    assert.ok(warn(warnings, "id", "required"));
    assert.ok(warn(warnings, "voiceProfileId", "defaulted"));
});

test("CharacterBible：非法服装/表演边界/三视图/音色引用被降级", () => {
    const { value, warnings } = normalizeCharacterBible({
        id: "c1",
        costumes: "职业装",
        performanceBounds: 5,
        turnaroundArtifactIds: {},
        voiceProfileId: 42,
    });
    assert.deepEqual(value.costumes, []);
    assert.deepEqual(value.performanceBounds, { allowed: [], forbidden: [] });
    assert.deepEqual(value.turnaroundArtifactIds, []);
    assert.equal(value.voiceProfileId, null);
    assert.ok(warn(warnings, "costumes", "degraded"));
    assert.ok(warn(warnings, "performanceBounds", "degraded"));
    assert.ok(warn(warnings, "turnaroundArtifactIds", "degraded"));
    assert.ok(warn(warnings, "voiceProfileId", "degraded"));
});

/* ------------------------------ WorldBible（§13.2 / §11.5.2） ------------------------------ */

const validWorld = {
    id: "loc1",
    name: "旧公寓",
    era: "当代",
    sceneMasterArtifactId: "art_master",
    floorPlanArtifactId: "art_plan",
    keyViewArtifactIds: ["art_v1", "art_v2"],
    dayNightVersions: ["day", "night"],
    weatherVersions: ["rain"],
    lightDirection: "window-left",
    allowedProps: ["台灯"],
    forbiddenProps: ["空调"],
    status: "locked",
    revision: 2,
};

test("WorldBible：合法样例整份通过，无告警", () => {
    const { value, warnings } = normalizeWorldBible(validWorld);
    assert.deepEqual(value, validWorld);
    assert.equal(warnings.length, 0);
});

test("WorldBible：缺 id 记 required，母版引用默认 null", () => {
    const { value, warnings } = normalizeWorldBible({});
    assert.equal(value.id, "");
    assert.equal(value.sceneMasterArtifactId, null);
    assert.equal(value.lightDirection, "");
    assert.deepEqual(value.dayNightVersions, []);
    assert.ok(warn(warnings, "id", "required"));
    assert.ok(warn(warnings, "sceneMasterArtifactId", "defaulted"));
});

test("WorldBible：昼夜/天气非法取值被拒（丢弃），非法光源方向降级", () => {
    const { value, warnings } = normalizeWorldBible({
        id: "loc1",
        dayNightVersions: ["day", "noon", "night"],
        weatherVersions: ["rain", "meteor"],
        lightDirection: 123,
        keyViewArtifactIds: "art_v1",
    });
    assert.deepEqual(value.dayNightVersions, ["day", "night"]);
    assert.deepEqual(value.weatherVersions, ["rain"]);
    assert.equal(value.lightDirection, "");
    assert.deepEqual(value.keyViewArtifactIds, []);
    assert.equal(warnings.filter((w) => w.code === "rejected").length, 2);
    assert.ok(warn(warnings, "lightDirection", "degraded"));
    assert.ok(warn(warnings, "keyViewArtifactIds", "degraded"));
});

/* ------------------------------ AudioBible（§13.2 / §11.5.1） ------------------------------ */

const validAudio = {
    id: "ab_1",
    voiceProfileIds: ["vp_c1", "vp_c2"],
    language: "zh-CN",
    pronunciationNotes: ["女主前后鼻音不分"],
    emotionRange: ["克制", "崩溃"],
    bgmDirection: "低音弦乐铺底",
    ambience: ["雨声", "车流"],
    forbiddenSounds: ["罐头笑声"],
    status: "review",
    revision: 1,
};

test("AudioBible：合法样例整份通过，无告警", () => {
    const { value, warnings } = normalizeAudioBible(validAudio);
    assert.deepEqual(value, validAudio);
    assert.equal(warnings.length, 0);
});

test("AudioBible：缺 id 记 required，语言默认 zh-CN", () => {
    const { value, warnings } = normalizeAudioBible({});
    assert.equal(value.id, "");
    assert.equal(value.language, "zh-CN");
    assert.deepEqual(value.voiceProfileIds, []);
    assert.deepEqual(value.forbiddenSounds, []);
    assert.ok(warn(warnings, "id", "required"));
    assert.ok(warn(warnings, "bgmDirection", "defaulted"));
});

test("AudioBible：非法音色引用/情绪范围/禁用声音降级", () => {
    const { value, warnings } = normalizeAudioBible({
        id: "ab_1",
        voiceProfileIds: "vp_c1",
        emotionRange: 5,
        pronunciationNotes: null,
        forbiddenSounds: "笑声",
    });
    assert.deepEqual(value.voiceProfileIds, []);
    assert.deepEqual(value.emotionRange, []);
    assert.deepEqual(value.pronunciationNotes, []);
    assert.deepEqual(value.forbiddenSounds, []);
    assert.ok(warn(warnings, "voiceProfileIds", "degraded"));
    assert.ok(warn(warnings, "emotionRange", "degraded"));
    assert.ok(warn(warnings, "forbiddenSounds", "degraded"));
});

/* ------------------------------ 确认锁状态机 ------------------------------ */

test("状态机：draft → review → approved → locked 全链路合法", () => {
    const step1 = transition(BIBLE_STATE.DRAFT, "submit_review", "alice");
    assert.deepEqual({ ok: step1.ok, next: step1.next, reason: step1.reason }, { ok: true, next: BIBLE_STATE.REVIEW, reason: null });
    const step2 = transition(step1.next, "approve", "alice");
    assert.equal(step2.ok, true);
    assert.equal(step2.next, BIBLE_STATE.APPROVED);
    const step3 = transition(step2.next, "lock", "alice");
    assert.equal(step3.ok, true);
    assert.equal(step3.next, BIBLE_STATE.LOCKED);
    assert.equal(step3.revisionBump, false);
});

test("状态机：review → reject 回退 draft（不产生新 revision）", () => {
    const result = transition(BIBLE_STATE.REVIEW, "reject", "bob");
    assert.equal(result.ok, true);
    assert.equal(result.next, BIBLE_STATE.DRAFT);
    assert.equal(result.revisionBump, false);
});

test("状态机：approved → reopen 回退 draft 且必须产生新 revision", () => {
    const result = transition(BIBLE_STATE.APPROVED, "reopen", "bob");
    assert.equal(result.ok, true);
    assert.equal(result.next, BIBLE_STATE.DRAFT);
    assert.equal(result.revisionBump, true);
});

test("状态机：locked → revise 回到 draft 且必须产生新 revision", () => {
    const result = transition(BIBLE_STATE.LOCKED, "revise", "bob");
    assert.equal(result.ok, true);
    assert.equal(result.next, BIBLE_STATE.DRAFT);
    assert.equal(result.revisionBump, true);
});

test("状态机：draft 直达 locked 被拒且原因可读", () => {
    const result = transition(BIBLE_STATE.DRAFT, "lock", "alice");
    assert.equal(result.ok, false);
    assert.equal(result.next, null);
    assert.match(result.reason, /draft/);
    assert.match(result.reason, /submit_review|approve/);
});

test("状态机：review 直达 locked 被拒且原因可读", () => {
    const result = transition(BIBLE_STATE.REVIEW, "lock", "alice");
    assert.equal(result.ok, false);
    assert.equal(result.next, null);
    assert.match(result.reason, /approve/);
});

test("状态机：locked 再 submit_review 被拒且提示用 revise", () => {
    const result = transition(BIBLE_STATE.LOCKED, "submit_review", "alice");
    assert.equal(result.ok, false);
    assert.equal(result.next, null);
    assert.match(result.reason, /revise/);
});

test("状态机：未知状态 / 未知动作被拒且原因可读", () => {
    const unknownState = transition("published", "approve", "alice");
    assert.equal(unknownState.ok, false);
    assert.match(unknownState.reason, /未知确认锁状态/);

    const unknownAction = transition(BIBLE_STATE.DRAFT, "fly", "alice");
    assert.equal(unknownAction.ok, false);
    assert.equal(unknownAction.next, null);
    assert.match(unknownAction.reason, /非法迁移/);
});

test("状态机：对象形态的 current（带 status）同样可迁移；actor 缺省归一为 system", () => {
    const result = transition({ status: BIBLE_STATE.REVIEW }, "approve");
    assert.equal(result.ok, true);
    assert.equal(result.next, BIBLE_STATE.APPROVED);
    assert.equal(result.actor, "system");
});

test("isConsumable：只有 approved / locked 可被下游消费", () => {
    assert.equal(isConsumable(BIBLE_STATE.APPROVED), true);
    assert.equal(isConsumable(BIBLE_STATE.LOCKED), true);
    assert.equal(isConsumable(BIBLE_STATE.DRAFT), false);
    assert.equal(isConsumable(BIBLE_STATE.REVIEW), false);
    assert.equal(isConsumable({ status: BIBLE_STATE.LOCKED }), true);
    assert.equal(isConsumable({ status: BIBLE_STATE.REVIEW }), false);
});

/* ------------------------------ revision 语义 ------------------------------ */

test("bumpRevision：产生新 revision、状态回 draft、原对象不变", () => {
    const original = Object.freeze({ id: "sb_1", revision: 2, status: BIBLE_STATE.LOCKED });
    const next = bumpRevision(original, "alice");
    assert.notEqual(next, original);
    assert.equal(next.revision, 3);
    assert.equal(next.status, BIBLE_STATE.DRAFT);
    assert.equal(next.previousRevision, 2);
    assert.equal(next.changedBy, "alice");
    assert.equal(original.revision, 2);
    assert.equal(original.status, BIBLE_STATE.LOCKED);
});

test("bumpRevision：非法 revision 先归一、changedBy 缺省归一为 system", () => {
    const next = bumpRevision({ id: "c1", revision: 0, status: BIBLE_STATE.APPROVED });
    assert.equal(next.revision, 2);
    assert.equal(next.changedBy, "system");
});

/* ------------------------------ mergeBiblePatch（幂等合并） ------------------------------ */

test("mergeBiblePatch：未变字段不动，仅改动字段更新", () => {
    const bible = { id: "sb_1", revision: 1, status: BIBLE_STATE.DRAFT, logline: "A", theme: "old" };
    const result = mergeBiblePatch(bible, { theme: "new" });
    assert.equal(result.bible.theme, "new");
    assert.equal(result.bible.logline, "A");
    assert.equal(result.bible.status, BIBLE_STATE.DRAFT);
    assert.equal(result.requiresNewRevision, false);
    assert.equal(result.changed, true);
});

test("mergeBiblePatch：幂等——重复应用同一 patch 不再产生变化", () => {
    const bible = { id: "sb_1", revision: 1, status: BIBLE_STATE.DRAFT, styleAnchors: ["a"] };
    const first = mergeBiblePatch(bible, { styleAnchors: ["a", "b"] });
    assert.equal(first.changed, true);
    const second = mergeBiblePatch(first.bible, { styleAnchors: ["a", "b"] });
    assert.equal(second.changed, false);
    assert.equal(second.bible, first.bible);
    assert.equal(second.requiresNewRevision, false);
});

test("mergeBiblePatch：已锁对象改动不覆盖，返回 requiresNewRevision + 新 revision", () => {
    const locked = Object.freeze({ id: "c1", revision: 3, status: BIBLE_STATE.LOCKED, name: "A" });
    const result = mergeBiblePatch(locked, { name: "B" });
    assert.equal(result.requiresNewRevision, true);
    assert.equal(result.revision, 4);
    assert.equal(result.bible, locked);
    assert.equal(result.bible.name, "A");
    assert.equal(locked.name, "A");
    assert.equal(locked.revision, 3);
});

test("mergeBiblePatch：已锁对象 + 无实际变化的 patch 不要求新 revision（幂等）", () => {
    const locked = { id: "c1", revision: 3, status: BIBLE_STATE.LOCKED, name: "A" };
    const result = mergeBiblePatch(locked, { name: "A" });
    assert.equal(result.requiresNewRevision, false);
    assert.equal(result.changed, false);
    assert.equal(result.revision, 3);
    assert.equal(result.bible, locked);
});

test("mergeBiblePatch：非锁定对象深度合并嵌套字段", () => {
    const bible = { id: "c1", revision: 2, status: BIBLE_STATE.REVIEW, delivery: { video: "h264", cover: false } };
    const result = mergeBiblePatch(bible, { delivery: { cover: true } });
    assert.deepEqual(result.bible.delivery, { video: "h264", cover: true });
    assert.equal(result.requiresNewRevision, false);
    assert.equal(result.revision, 2);
    assert.equal(bible.delivery.cover, false);
});

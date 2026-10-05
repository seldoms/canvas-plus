import assert from "node:assert/strict";
import { test } from "node:test";

import { checkStageArtifact, formatArtifactErrors } from "../src/stage-artifact-check.js";

/* ---------------- 正例夹具（形状取自各段 SKILL.md 的输出契约） ---------------- */
const SCRIPT = {
    logline: "雾散之前，她必须找到那只皮箱的主人",
    synopsis: "浓雾清晨，沈知微抱着旧皮箱登上渡船。",
    characters: [{ id: "c1", name: "沈知微", profile: "学生", appearance: "十九岁女性，齐耳短发", voice: "清亮" }],
    scenes: [{ id: "sc1", title: "渡口", location: "外景/河岸渡口", time: "清晨", intent: "登船", beats: ["踏上跳板"] }],
    episodes: [{ id: "ep1", title: "第一集", durationSec: 120, synopsis: "登船", sceneIds: ["sc1"] }],
};
const STORYBOARD = {
    episodes: [{ id: "ep1", sceneIds: ["sc1"] }],
    shots: [{ id: "sh1", episodeId: "ep1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", camera: "固定机位", action: "踏上跳板", dialogue: "", prompt: "a girl steps onto a pier" }],
};
const DESIGN = {
    characters: [{ id: "c1", name: "沈知微", outfit: "藏青学生装", makeup: "素颜", hair: "齐耳短发", props: ["旧皮箱"], palette: "#1b2a41", prompt: "navy tunic", confirmed: true }],
    locations: [{ id: "loc1", name: "渡口", setDressing: "木栈桥", lighting: "东侧逆光", palette: "#6b7b8c", prompt: "misty pier", confirmed: true }],
    references: [{ id: "ref1", bindingId: "c1", role: "character", kind: "closeup", prompt: "face closeup", template: "img_qwen21_edit", jobId: "job_1", artifactUrl: "/api/artifacts/job_1/f1.png", status: "done" }],
};
const CASTING = {
    characters: [{ characterId: "c1", name: "沈知微", face: { closeupArtifactId: "a1", turnaroundArtifactIds: ["a2"], confirmed: true }, voice: { voiceProfileId: "vp_c1", speaker: "Cherry", design: "清亮", speed: 1, language: "Chinese", confirmed: true }, confirmed: true, version: 1 }],
};
const KEYFRAME = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "a girl steps onto a pier", template: "img_zimage", jobId: "job_2", artifactUrl: null, status: "queued" },
        { id: "sh1-end", shotId: "sh1", role: "end", prompt: "the girl stands still", template: "img_zimage", jobId: "job_3", artifactUrl: null, status: "queued" },
    ],
};
const AUDIO = {
    audio: [{ id: "cue_sh1_dialogue_01", shotId: "sh1", startSec: 0, endSec: 2.5, durationSec: 2.5, type: "dialogue", text: "上船要趁早。", characterId: "c1", voiceProfileId: "vp_c1", artifactUrl: null, status: "queued" }],
};
const ASSEMBLY = {
    clips: [{ id: "sh1-clip", shotId: "sh1", keyframeId: "sh1-start", template: "video_h3_i2v", jobId: "job_4", artifactUrl: null, durationSec: 4, status: "queued" }],
    assembly: { order: ["sh1-clip"], transition: "cut", status: "queued", url: null, manifestUrl: null },
};

const UPSTREAM = { script: SCRIPT, storyboard: STORYBOARD, design: DESIGN, keyframe: KEYFRAME };
const FIXTURES = { script: SCRIPT, storyboard: STORYBOARD, design: DESIGN, casting: CASTING, keyframe: KEYFRAME, audio: AUDIO, assembly: ASSEMBLY };
const upstreamFor = (stageId) => Object.fromEntries(Object.entries(UPSTREAM).filter(([id]) => id !== stageId));
const clone = (value) => JSON.parse(JSON.stringify(value));
const check = (stageId, output, upstream = upstreamFor(stageId)) => checkStageArtifact(stageId, output, upstream);
const errorCodes = (result) => result.errors.map((item) => item.code);

for (const stageId of Object.keys(FIXTURES)) {
    test(`正例：${stageId} 合规产物零 error`, () => {
        const result = check(stageId, clone(FIXTURES[stageId]));
        assert.deepEqual(errorCodes(result), [], `不该有 error：${JSON.stringify(result.errors)}`);
        assert.equal(result.ok, true);
    });
}

test("未知阶段不产生任何问题项（不误拦）", () => {
    const result = checkStageArtifact("plan", { anything: true }, {});
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test("formatArtifactErrors：压成一句可读中文，超过 3 条给余量", () => {
    assert.equal(formatArtifactErrors([]), "");
    assert.match(formatArtifactErrors([{ path: "shots[0].sceneId", message: "引用的剧本场次「sc9」不存在" }]), /产物未通过契约校验（1 处）/);
    const many = Array.from({ length: 5 }, (_, index) => ({ path: `p${index}`, message: "坏了" }));
    assert.match(formatArtifactErrors(many), /另有 2 处/);
});

/* ---------------- 击穿用例：每条规则一个反例 ---------------- */
const CASES = [
    ["script", "场次 id 重复", (d) => d.scenes.push({ ...d.scenes[0] }), "script.scene_duplicate"],
    ["script", "角色 id 重复", (d) => d.characters.push({ ...d.characters[0] }), "script.character_duplicate"],
    ["script", "分集 id 重复", (d) => d.episodes.push({ ...d.episodes[0] }), "script.episode_duplicate"],
    ["script", "分集引用了不存在的场次", (d) => { d.episodes[0].sceneIds = ["sc9"]; }, "script.episode_scene_ref"],
    ["storyboard", "镜头 id 重复", (d) => d.shots.push({ ...d.shots[0] }), "storyboard.shot_duplicate"],
    ["storyboard", "sceneId 不在剧本里", (d) => { d.shots[0].sceneId = "sc9"; }, "storyboard.scene_ref"],
    ["design", "造型角色 id 重复", (d) => d.characters.push({ ...d.characters[0] }), "design.character_duplicate"],
    ["design", "场景 id 重复", (d) => d.locations.push({ ...d.locations[0] }), "design.location_duplicate"],
    ["design", "造型角色不在剧本里", (d) => { d.characters[0].id = "c9"; }, "design.character_ref"],
    ["casting", "定妆角色 id 重复", (d) => d.characters.push({ ...d.characters[0] }), "casting.character_duplicate"],
    ["keyframe", "关键帧 id 重复", (d) => d.frames.push({ ...d.frames[0] }), "keyframe.frame_duplicate"],
    ["keyframe", "shotId 不在分镜里", (d) => { d.frames[0].shotId = "sh9"; }, "keyframe.shot_ref"],
    ["keyframe", "帧角色非法", (d) => { d.frames[0].role = "middle"; }, "keyframe.role"],
    ["audio", "配音条目 id 重复", (d) => d.audio.push({ ...d.audio[0] }), "audio.cue_duplicate"],
    ["audio", "shotId 不在分镜里", (d) => { d.audio[0].shotId = "sh9"; }, "audio.shot_ref"],
    ["audio", "时间倒挂", (d) => { d.audio[0].endSec = 0; }, "audio.time_range"],
    ["audio", "起始时间为负", (d) => { d.audio[0].startSec = -1; d.audio[0].endSec = 1; }, "audio.time_range"],
    ["assembly", "片段 id 重复", (d) => d.clips.push({ ...d.clips[0] }), "assembly.clip_duplicate"],
    ["assembly", "shotId 不在分镜里", (d) => { d.clips[0].shotId = "sh9"; }, "assembly.shot_ref"],
    ["assembly", "keyframeId 不存在", (d) => { d.clips[0].keyframeId = "sh9-start"; }, "assembly.keyframe_ref"],
];

for (const [stageId, name, mutate, code] of CASES) {
    test(`击穿 ${stageId} · ${name} → ${code}`, () => {
        const output = clone(FIXTURES[stageId]);
        mutate(output);
        const result = check(stageId, output);
        assert.ok(errorCodes(result).includes(code), `期望 ${code}，实际：${JSON.stringify(result.errors)}`);
        assert.equal(result.ok, false);
        // 每条问题项必须说清在哪、错在哪，而不是"校验失败"。
        const hit = result.errors.find((item) => item.code === code);
        assert.ok(hit.path.length > 0 && hit.message.length >= 6, `提示不具体：${JSON.stringify(hit)}`);
    });
}

/* ---------------- 必须放过的合法缺失（防误拦，与击穿同等重要） ---------------- */
test("放过：可选增强字段缺失不产生任何问题项", () => {
    const storyboard = clone(STORYBOARD);
    // cameraSpec / dialogueLines / textOverlays / negativePrompt 都是可选增强
    const result = check("storyboard", storyboard);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test("放过：jobId / artifactUrl / selected / candidates 为空属正常", () => {
    const keyframe = check("keyframe", clone(KEYFRAME));
    assert.deepEqual(errorCodes(keyframe), [], "关键帧尚未出图不是 error");
    const assembly = check("assembly", clone(ASSEMBLY));
    assert.deepEqual(errorCodes(assembly), [], "片段尚未产出不是 error");
    assert.ok(assembly.warnings.some((item) => item.code === "assembly.clip_pending"));
});

test("放过：keyframeId=null 只提示不阻断", () => {
    const output = clone(ASSEMBLY);
    output.clips[0].keyframeId = null;
    const result = check("assembly", output);
    assert.deepEqual(errorCodes(result), []);
    assert.ok(result.warnings.some((item) => item.code === "assembly.keyframe_missing"));
});

test("放过：design 参考图未产出只提示", () => {
    const output = clone(DESIGN);
    output.references[0].artifactUrl = "";
    const result = check("design", output);
    assert.deepEqual(errorCodes(result), []);
    assert.ok(result.warnings.some((item) => item.code === "design.reference_pending"));
});

test("上游集合缺失或为空时只提示，不判 error（否则新项目永远过不去）", () => {
    const storyboard = check("storyboard", clone(STORYBOARD), {});
    assert.deepEqual(errorCodes(storyboard), []);
    assert.ok(storyboard.warnings.some((item) => item.code === "storyboard.scene_ref"));

    const keyframe = check("keyframe", clone(KEYFRAME), {});
    assert.deepEqual(errorCodes(keyframe), [], "没有分镜产物也不能判 keyframe 引用断裂");

    const keyframeEmpty = check("keyframe", clone(KEYFRAME), { storyboard: { shots: [] } });
    assert.deepEqual(errorCodes(keyframeEmpty), [], "分镜镜头集合为空同理");
});

test("放过：绑定项目后 shots[].episodeId 是项目侧 id（ep_0001），不得判为引用断裂", () => {
    // 实测踩过：编排器把 episodeId 归一成项目侧 id，与剧本侧（ep1）不同源。
    const output = clone(STORYBOARD);
    output.shots[0].episodeId = "ep_0001";
    const result = check("storyboard", output);
    assert.deepEqual(errorCodes(result), []);
    assert.equal(result.warnings.some((item) => item.code === "storyboard.episode_ref"), false, "真实问题由 normalizeShotEpisodeIds 的 unresolved/remapped 兜底");
});

test("放过：引用 id 本身为空只提示", () => {
    const output = clone(STORYBOARD);
    output.shots[0].sceneId = "";
    const result = check("storyboard", output);
    assert.deepEqual(errorCodes(result), []);
    assert.ok(result.warnings.some((item) => item.code === "storyboard.scene_ref"));
});

test("空产物不炸：各段 null / 空对象都只给问题项或空结果", () => {
    for (const stageId of Object.keys(FIXTURES)) {
        assert.doesNotThrow(() => check(stageId, null));
        assert.doesNotThrow(() => check(stageId, {}));
    }
    assert.deepEqual(errorCodes(check("keyframe", {})), [], "空 frames 不是引用错误（由编排器的非空校验负责）");
});

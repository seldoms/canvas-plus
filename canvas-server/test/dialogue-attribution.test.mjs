import assert from "node:assert/strict";
import { test } from "node:test";

import { cuesFromShots, resolveDialogueLines } from "../src/audio.js";
import {
    DIALOGUE_CATALOG,
    dialogueKeyForTemplate,
    dialogueMetaForTemplate,
    dialogueModeForTemplate,
    templateCarriesDialogue,
} from "../src/dialogue-roles.js";
import { compileH3VideoPrompt, h3DialogueSentence } from "../src/prompt-compiler.js";

/**
 * 台词归属（按模型走的内容契约 + 模型能力元数据）验收：
 *   · A 内容契约：分镜台词升级为逐条带说话人（dialogueLines[]），旧字符串 dialogue 向后兼容；
 *   · B 模型能力元数据：H3=(S1)+<d>；TTS=SPEAKER+INSTRUCT；纯视频/生图=无；
 *   · D 解析/回落/旧格式兼容/同角色跨镜音色一致/H3 (S1) 与 <d> 逐字保留/无台词不产。
 * fixture 取真实 run run-musrs21x-pri3c 的两个角色（阿海 / 小满）与分镜台词形状（只读事实）。
 */

// —— 全局角色表（说话人 (Sx) 稳定编号的事实源，顺序即编号顺序）——
const CAST = [
    { id: "c1", name: "阿海" },
    { id: "c2", name: "小满" },
];
const voiceProfiles = [
    { id: "vp_c1", characterId: "c1", speaker: "Uncle_fu" },
    { id: "vp_c2", characterId: "c2", speaker: "Serena" },
];

const STYLE = { anchor: "写实电影感，暖色路灯与冷调夜色的对比", context: "写实电影感", filmLayer: "" };
const scene = { id: "sc1", name: "渡轮驾驶室（夜）" };

/** 结构化分镜：一个镜头 3 句台词、2 个说话人（阿海/小满/阿海）。 */
const SH1 = {
    id: "sh1",
    sceneId: "sc1",
    durationSec: 5,
    shotSize: "中景",
    action: "阿海扶舵轮看向小满，开口问话；小满抬头应答；阿海平静提醒。段末可见状态：两人对视。",
    audio: "环境音：船体低频震动、海浪轻拍；本镜有对白。",
    dialogueLines: [
        { speaker: "阿海", text: "姑娘，这么晚，去哪儿？", performance: "低沉、语速慢" },
        { speaker: "小满", text: "去对岸。", performance: "轻声" },
        { speaker: "阿海", text: "对岸的灯，早就灭了。", performance: "平静" },
    ],
};

const compileH3 = (shot, extra = {}) =>
    compileH3VideoPrompt({ template: "video_h3_talk", shot, scene, characters: CAST, cast: CAST, style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5, ...extra });

/* ————————————————————————— 1. 模型能力元数据（B） ————————————————————————— */

test("模型能力元数据：H3=(S1)+<d> 稳定 ID；TTS=SPEAKER+INSTRUCT；纯视频/生图=无", () => {
    const h3 = dialogueMetaForTemplate("video_h3_talk");
    assert.equal(h3.mode, "speaker_id_block");
    assert.equal(h3.speakerIdStyle, "paren");
    assert.equal(h3.stableIds, true);
    assert.equal(h3.utteranceTag, "d");
    assert.equal(h3.utteranceLangTag, "English");

    const tts = dialogueMetaForTemplate("audio_qwen3_tts");
    assert.equal(tts.mode, "voice_enum");
    assert.equal(tts.speakerField, "SPEAKER");
    assert.equal(tts.instructField, "INSTRUCT");
    assert.equal(tts.stableIds, false, "TTS 没有「谁说的」，只有命名音色");

    for (const template of ["video_wan_animate", "img_qwen21_t2i", "img_qwen21_edit", "img_flux_artistic"]) {
        assert.equal(dialogueModeForTemplate(template), "none", `${template} 不承载台词归属`);
    }
    assert.equal(templateCarriesDialogue("video_h3_talk"), true);
    assert.equal(templateCarriesDialogue("audio_qwen3_tts"), true);
    assert.equal(templateCarriesDialogue("video_wan_animate"), false);
});

test("模型能力元数据：模板名映射（model-rules 优先 + TTS 后备映射）；未登记→none", () => {
    assert.equal(dialogueKeyForTemplate("video_h3_talk"), "minimax_h3");
    assert.equal(dialogueKeyForTemplate("audio_qwen3_tts"), "qwen3_tts");
    assert.equal(dialogueKeyForTemplate("完全不存在的模板"), null);
    assert.equal(dialogueMetaForTemplate("完全不存在的模板").mode, "none");
    assert.ok(DIALOGUE_CATALOG.minimax_h3 && DIALOGUE_CATALOG.qwen3_tts);
});

/* ————————————————————— 2. 结构化解析 / 回落 / 旧格式兼容（A·D） ————————————————————— */

test("结构化解析：dialogueLines 每条带说话人，显式说话人优先（source=explicit）", () => {
    const { lines, warnings } = resolveDialogueLines(SH1, CAST, CAST);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line) => line.speaker.name), ["阿海", "小满", "阿海"]);
    assert.deepEqual(lines.map((line) => line.speaker.characterId), ["c1", "c2", "c1"]);
    assert.deepEqual(lines.map((line) => line.source), ["explicit", "explicit", "explicit"]);
    assert.deepEqual(lines.map((line) => line.text), ["姑娘，这么晚，去哪儿？", "去对岸。", "对岸的灯，早就灭了。"]);
    assert.deepEqual(lines.map((line) => line.performance), ["低沉、语速慢", "轻声", "平静"]);
    assert.deepEqual(warnings, [], "显式说话人不需要回落告警");
});

test("旧格式兼容：dialogue 是字符串 → 当成一条、无明确说话人（单角色镜头可无歧义解析）", () => {
    const { lines, warnings } = resolveDialogueLines(
        { id: "sh1", action: "向对方开口问话", dialogue: "姑娘，这么晚，去哪儿？（低沉、语速慢）" },
        [CAST[0]],
        [CAST[0]],
    );
    assert.equal(lines.length, 1, "旧字符串不臆断拆分归属，只当一条");
    assert.equal(lines[0].source, "single_character");
    assert.equal(lines[0].speaker.name, "阿海");
    assert.equal(lines[0].text, "姑娘，这么晚，去哪儿？", "括号注解剥出正文");
    assert.equal(lines[0].performance, "低沉、语速慢");
    assert.deepEqual(warnings, [], "单角色无歧义 → 不告警");
});

test("逐级回落 + warning：旧字符串在多角色镜头里无法确定归属 → 取第一个并记 speaker_ambiguous（不阻塞）", () => {
    const { lines, warnings } = resolveDialogueLines(
        { id: "sh1", action: "阿海问小满话", dialogue: "姑娘，这么晚，去哪儿？" },
        CAST,
        CAST,
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].speaker.characterId, "c1", "取第一个角色兜底（有音可混）");
    assert.ok(warnings.some((w) => w.code === "speaker_ambiguous"), `应告警歧义：${JSON.stringify(warnings)}`);
});

test("逐级回落：显式说话人指向不存在的角色 → speaker_unknown_character + 继续回落", () => {
    const { lines, warnings } = resolveDialogueLines(
        { id: "sh1", dialogueLines: [{ speaker: "不存在的人", text: "喂。" }] },
        [CAST[0]],
        [CAST[0]],
    );
    assert.equal(lines[0].speaker.name, "阿海", "回落链继续解析");
    assert.ok(warnings.some((w) => w.code === "speaker_unknown_character"));
});

test("逐级回落：镜头级 characterId 命中（source=shot_character_id）；台词点名角色名（source=line_text）", () => {
    const shotId = resolveDialogueLines({ id: "s", characterId: "c2", dialogue: "嗯。" }, CAST, CAST);
    assert.equal(shotId.lines[0].speaker.name, "小满");
    assert.equal(shotId.lines[0].source, "shot_character_id");

    const lineText = resolveDialogueLines({ id: "s", dialogue: "阿海，别走。" }, CAST, CAST);
    assert.equal(lineText.lines[0].speaker.characterId, "c1");
    assert.equal(lineText.lines[0].source, "line_text");
});

test("无台词：dialogueLines=[] 且 dialogue 为空 → 不产任何台词条目", () => {
    assert.deepEqual(resolveDialogueLines({ id: "s", dialogueLines: [], dialogue: "" }, CAST, CAST).lines, []);
    assert.deepEqual(resolveDialogueLines({ id: "s" }, CAST, CAST).lines, []);
});

/* ————————————————————— 3. H3 编译：(S1) 稳定 + <d> 逐字正文（D） ————————————————————— */

test("H3：逐条带说话人，每句归属到正确的人、编号稳定 (S1)(S2)、<d> 内逐字是正文（不含括号注解）", () => {
    const out = compileH3(SH1);
    // 三句、两个说话人、编号按全局 cast 稳定：阿海=S1、小满=S2。
    assert.ok(out.includes("阿海 (S1) says: <d>[English] 姑娘，这么晚，去哪儿？</d>"), out);
    assert.ok(out.includes("小满 (S2) says: <d>[English] 去对岸。</d>"), out);
    assert.ok(out.includes("阿海 (S1) says: <d>[English] 对岸的灯，早就灭了。</d>"), out);
    // 顺序：阿海 → 小满 → 阿海。
    const i1 = out.indexOf("姑娘，这么晚，去哪儿？");
    const i2 = out.indexOf("去对岸。");
    const i3 = out.indexOf("对岸的灯，早就灭了。");
    assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, "台词顺序必须与分镜一致");
    // <d> 内逐字是正文：不含括号注解（[English] 里的半角方括号是语言标签，不算注解）。
    const block = out.slice(out.indexOf("<d>"), out.indexOf("</d>") + 4);
    assert.ok(!/[（(【]/.test(block), `<d> 内不得含括号注解：${block}`);
    // 表演注解移到描述层（多角色多条用「；」连接），绝不塞回 <d>。
    assert.ok(out.includes("Performance: 低沉、语速慢；轻声；平静."), out);
});

test("H3：(Sx) 跨镜稳定 —— 同一角色在别的镜头仍拿同一个号", () => {
    const sh2 = {
        id: "sh2",
        sceneId: "sc1",
        durationSec: 5,
        shotSize: "近景",
        action: "小满哭着说话；阿海沉默递钥匙。",
        audio: "环境音：海风；本镜有对白。",
        dialogueLines: [
            { speaker: "小满", text: "我爸是守这座灯塔的。" },
            { speaker: "阿海", text: "我知道。" },
        ],
    };
    const out = compileH3(sh2);
    assert.ok(out.includes("小满 (S2) says: <d>[English] 我爸是守这座灯塔的。</d>"), out);
    assert.ok(out.includes("阿海 (S1) says: <d>[English] 我知道。</d>"), out);
});

test("H3：无台词不产（无 <d>、无 (S1)、无 says）", () => {
    const out = compileH3({ id: "sh3", sceneId: "sc1", durationSec: 5, action: "空镜。", audio: "环境音：海浪。", dialogueLines: [], dialogue: "" });
    assert.ok(!out.includes("<d>") && !out.includes("</d>"), out);
    assert.ok(!/\(S\d+\)/.test(out), out);
    assert.ok(!out.includes("says"), out);
    assert.ok(!out.includes("Performance:"), out);
});

test("H3：台词正文里残留的括号注解也被剥出 <d>（逐字是正文）", () => {
    const out = compileH3({ id: "sh1", sceneId: "sc1", durationSec: 5, action: "阿海说话。", dialogueLines: [{ speaker: "阿海", text: "去哪儿？（低声）" }] });
    assert.ok(out.includes("<d>[English] 去哪儿？</d>"), out);
    const block = out.slice(out.indexOf("<d>"), out.indexOf("</d>") + 4);
    assert.ok(!/[（(]/.test(block), block);
});

test("h3DialogueSentence：旧字符串单角色仍可用（向后兼容），(S1) + <d> 形状不变", () => {
    const out = h3DialogueSentence({ dialogue: "姑娘，这么晚，去哪儿？（低声、音量低、语速慢、略带关心）" }, [CAST[0]]);
    assert.ok(out.includes("阿海 (S1) says: <d>[English] 姑娘，这么晚，去哪儿？</d>"));
    assert.match(out, /mouth movements synchronized/);
});

/* ————————————————————— 4. 配音：逐条说话人 + 跨镜音色一致（D） ————————————————————— */

test("cuesFromShots：结构化台词逐条挂到正确角色 → 正确 VoiceProfile（跨镜音色一致）", () => {
    const shA = { id: "sh1", sceneId: "sc1", durationSec: 6, ...SH1 };
    const shB = {
        id: "sh2",
        sceneId: "sc1",
        durationSec: 4,
        dialogueLines: [
            { speaker: "小满", text: "嗯。" },
            { speaker: "阿海", text: "走吧。" },
        ],
    };
    const cues = cuesFromShots({ shots: [shA, shB], characters: CAST, voiceProfiles });
    const byText = Object.fromEntries(cues.map((cue) => [cue.text, cue]));
    assert.equal(byText["姑娘，这么晚，去哪儿？"].characterId, "c1");
    assert.equal(byText["姑娘，这么晚，去哪儿？"].voiceProfileId, "vp_c1");
    assert.equal(byText["去对岸。"].characterId, "c2");
    assert.equal(byText["去对岸。"].voiceProfileId, "vp_c2");
    assert.equal(byText["对岸的灯，早就灭了。"].voiceProfileId, "vp_c1");
    // 跨镜一致：小满在 sh1/sh2 都拿 vp_c2；阿海都拿 vp_c1。
    assert.equal(byText["嗯。"].voiceProfileId, "vp_c2");
    assert.equal(byText["走吧。"].voiceProfileId, "vp_c1");
});

test("cuesFromShots：无台词镜头不产对白 Cue（硬约束）", () => {
    const cues = cuesFromShots({ shots: [{ id: "shx", sceneId: "sc1", durationSec: 4, dialogueLines: [], dialogue: "" }], characters: CAST, voiceProfiles });
    assert.deepEqual(cues.filter((cue) => cue.type === "dialogue"), []);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    SPEED_LOWER_BOUND,
    SPEED_NORMAL,
    SPEED_UPPER_BOUND,
    buildTtsRequest,
    cuesFromShots,
    resolveSpeechSpeed,
    splitDialogue,
} from "../src/audio.js";

// 真实 run run-murvf1vq-aqyqm 的分镜台词（一手证据，原样摘录）。
// 修复前：这些「语速慢」注解被原样当成 TTS instruct，合成出 2.4~2.5 字/秒的拖慢语音。
const REAL_DIALOGUE = {
    sh5: "姑娘，这么晚，去哪儿？（低声、音量低、语速慢、略带关心）",
    sh6: "终点站。（声音轻柔、微弱、语速慢、犹豫）",
    sh7: "终点站早就没人了。（语气低沉、音量中等、语速慢、尾音下沉）",
};

// ---------- 1. 台词清洗 splitDialogue ----------

test("splitDialogue 全角括号：正文与表演注解正确分离", () => {
    const r = splitDialogue(REAL_DIALOGUE.sh5);
    assert.equal(r.text, "姑娘，这么晚，去哪儿？");
    assert.equal(r.performance, "低声、音量低、语速慢、略带关心");
    assert.deepEqual(r.warnings, []);
});

test("splitDialogue 半角括号同样剥除（英文台词）", () => {
    const r = splitDialogue("Are you okay? (soft voice, slow)");
    assert.equal(r.text, "Are you okay?");
    assert.equal(r.performance, "soft voice, slow");
});

test("splitDialogue 剥除【】与 [] 及其内容", () => {
    assert.equal(splitDialogue("你来了。【旁白提示】").text, "你来了。");
    const half = splitDialogue("你来了。[narration]");
    assert.equal(half.text, "你来了。");
    assert.equal(half.performance, "narration");
});

test("splitDialogue 无注解时 performance 为空串、正文原样、无告警", () => {
    const r = splitDialogue("终点站早就没人了。");
    assert.equal(r.text, "终点站早就没人了。");
    assert.equal(r.performance, "");
    assert.deepEqual(r.warnings, []);
});

test("splitDialogue 多段台词 + 多个注解：正文合并、注解用「；」连接", () => {
    const r = splitDialogue("第一句。（低声）\n第二句。（高声）");
    assert.equal(r.text, "第一句。 第二句。");
    assert.equal(r.performance, "低声；高声");
});

test("splitDialogue 只有注解 → 回退原文 + warning（不静默丢台词）", () => {
    const r = splitDialogue("（低声、语速慢）");
    assert.equal(r.text, "（低声、语速慢）");
    assert.equal(r.performance, "低声、语速慢");
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].code, "empty_after_cleaning");
    assert.match(r.warnings[0].reason, /回退原文/);
});

test("splitDialogue 嵌套括号：整段剥除，注解保留内层内容", () => {
    const r = splitDialogue("你好（低声（带鼻音））啊");
    assert.equal(r.text, "你好啊");
    assert.equal(r.performance, "低声（带鼻音）");
});

test("splitDialogue 剥整段外层引号，段内引号保留（嵌套引号）", () => {
    const r = splitDialogue("「他说：（小声）你好。」");
    assert.equal(r.text, "他说：你好。");
    assert.equal(r.performance, "小声");
});

test("splitDialogue 空白归一：全角空格与连续空白折叠为单个半角空格", () => {
    assert.equal(splitDialogue("  你　好   呀  ").text, "你 好 呀");
});

// ---------- 2. 语速解析 resolveSpeechSpeed ----------

test("resolveSpeechSpeed 无显式语速、无线索 → 默认正常语速 1.0", () => {
    const r = resolveSpeechSpeed({});
    assert.equal(r.speed, SPEED_NORMAL);
    assert.equal(r.source, "default");
});

test("resolveSpeechSpeed 注解默认不参与生产参数：带「语速慢」注解仍取正常语速 1.0", () => {
    const r = resolveSpeechSpeed({ performance: "低声、音量低、语速慢、略带关心" });
    assert.equal(r.speed, SPEED_NORMAL, "注解是 LLM 的文学发挥，默认不得放慢语速（产品负责人反馈过「说话速度太慢了」）");
    assert.equal(r.source, "default");
    assert.match(r.reason, /默认正常语速|不参与生产参数/);
});

test("resolveSpeechSpeed 仅在显式 honorPerformance: true 时才采纳注解，且被下限保护夹在 0.85（不会压死）", () => {
    const r = resolveSpeechSpeed({ performance: "低声、音量低、语速慢、略带关心", options: { honorPerformance: true } });
    assert.equal(r.speed, SPEED_LOWER_BOUND);
    assert.ok(r.speed >= SPEED_LOWER_BOUND, "不得超过下限");
    assert.equal(r.source, "performance");
    assert.match(r.reason, /下限保护|线索/);
});

test("resolveSpeechSpeed 注解「语速快」默认同样不参与；显式开启时才被上限保护夹在 1.15", () => {
    const dft = resolveSpeechSpeed({ performance: "急促、语速快" });
    assert.equal(dft.speed, SPEED_NORMAL);
    const r = resolveSpeechSpeed({ performance: "急促、语速快", options: { honorPerformance: true } });
    assert.equal(r.speed, SPEED_UPPER_BOUND);
    assert.ok(r.speed <= SPEED_UPPER_BOUND, "不得超过上限");
});

test("resolveSpeechSpeed voiceProfile.speed 显式值优先于注解", () => {
    const r = resolveSpeechSpeed({ voiceProfile: { speed: 1.1 }, performance: "语速慢、低沉" });
    assert.equal(r.speed, 1.1);
    assert.equal(r.source, "voiceProfile");
});

test("resolveSpeechSpeed options.speed 显式值优先于注解", () => {
    const r = resolveSpeechSpeed({ performance: "语速慢", options: { speed: 0.95 } });
    assert.equal(r.speed, 0.95);
    assert.equal(r.source, "options");
});

// ---------- 3. cuesFromShots 消费纯台词 ----------

test("cuesFromShots：cue.text 是纯台词、cue.performance 有注解、cue.speed 合理", () => {
    const cues = cuesFromShots({
        shots: [{ id: "sh5", durationSec: 6, dialogue: REAL_DIALOGUE.sh5, characterId: "c1" }],
        characters: [{ id: "c1", name: "老周" }],
        voiceProfiles: [{ id: "vp_c1", characterId: "c1", speaker: "Ethan" }],
    });
    assert.equal(cues.length, 1);
    const cue = cues[0];
    assert.equal(cue.text, "姑娘，这么晚，去哪儿？"); // 注解不进 text
    assert.equal(cue.performance, "低声、音量低、语速慢、略带关心");
    assert.equal(cue.speed, SPEED_NORMAL); // 注解默认不参与 → 正常语速（注解仅存于 cue.performance 供人工参考）
    assert.ok(cue.speed >= SPEED_LOWER_BOUND && cue.speed <= SPEED_UPPER_BOUND);
    assert.equal(cue.voiceProfileId, "vp_c1");
    assert.deepEqual(cue.warnings, []);
});

test("cuesFromShots 清洗后为空 → cue.text 回退原文且 cue.warnings 告警", () => {
    const cues = cuesFromShots({ shots: [{ id: "shx", durationSec: 3, dialogue: "（语速慢）" }] });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, "（语速慢）");
    assert.ok(cues[0].warnings.length >= 1);
    assert.equal(cues[0].warnings[0].code, "empty_after_cleaning");
});

// ---------- 4. buildTtsRequest 承载解析语速 ----------

test("buildTtsRequest 接受 resolveSpeechSpeed 结果对象，缺省仍为正常语速", () => {
    const speed = resolveSpeechSpeed({ performance: "语速慢" });
    const body = buildTtsRequest({ voiceProfile: { speaker: "Ethan" }, text: "终点站。", speed });
    assert.equal(body.speed, SPEED_NORMAL);
    const def = buildTtsRequest({ voiceProfile: { speaker: "Ethan" }, text: "终点站。" });
    assert.equal(def.speed, 1);
});

// ---------- 5. 真实数据回归 ----------

test("真实分镜台词 sh5/sh6/sh7 清洗后注解不再进入 TTS 文本", () => {
    for (const [id, raw] of Object.entries(REAL_DIALOGUE)) {
        const { text, performance } = splitDialogue(raw);
        assert.ok(text.length > 0, `${id} 纯台词不得为空`);
        assert.ok(!/[（(【\[]/.test(text), `${id} 纯台词仍残留括号`);
        assert.ok(!/语速慢/.test(text), `${id} 纯台词仍残留「语速慢」`);
        assert.ok(/语速慢/.test(performance), `${id} 注解应保留「语速慢」供人工参考`);
        const { speed } = resolveSpeechSpeed({ performance });
        assert.ok(speed >= SPEED_LOWER_BOUND, `${id} 语速不得低于下限`);
    }
});

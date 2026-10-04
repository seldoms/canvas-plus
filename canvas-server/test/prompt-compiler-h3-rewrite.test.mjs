import assert from "node:assert/strict";
import { test } from "node:test";

import { compileH3VideoPrompt, compilePromptForTemplate, compilePromptForTemplateAsync, stripUntranslatedMarker } from "../src/prompt-compiler.js";
import { ruleKeyForTemplate } from "../src/model-rules.js";

/**
 * H3 英文化改写（专用整段入口）回归。
 *
 * 背景（已查实的两处断点）：
 *   ① H3 的 compileH3VideoPrompt / compileH3Ref2VA 从不追加 [untranslated] 标记 → 流水线的
 *      untranslatedWarning 恒为 null → 视频条目永远不走英文化改写；
 *   ② 即使追加，两个编译器的解构参数里也没有 rewrite → 改写稿被静默丢弃。
 * 规则层自相矛盾：minimax_h3.prompt.translate_to = "en"（该英文化），却把「结构固定」误当成「正文也不用改」。
 *
 * 本文件覆盖 5 类：
 *   ① 同步稿必须带 [untranslated] 标记，且 stripUntranslatedMarker 能剥净；
 *   ② 合法改写稿 → 正文英文，字段名 / 对齐指令行 / <d> 台词块 / 英文双引号画面文字 / 运镜句 /
 *      负向句 / N/A 哨兵全由编译器自己拼，台词与画面文字**逐字保留且只出现一次**；
 *   ③ 漏标签 / 篡改台词 / 把锚点内联进正文 → 一律弃稿回落同步中文稿（并记 onWarning）；
 *   ④ Ref2VA 同样消费 rewrite（detailed_description），六段结构不变；
 *   ⑤ async 专用入口：三段标签源 + 逐字锁 system，成功/失败两条链路。
 */

const STYLE = { anchor: "写实电影感，暖色路灯与冷调夜色的对比，浅景深", ratio: "9:16" };

const SHOT = {
    id: "sh1",
    durationSec: 5,
    shotSize: "全景",
    action: "林晚从站台阴影中走出，上台阶，进入公交车。段末可见状态：林晚站在前门内。",
    dialogue: "姑娘，这么晚，去哪儿？",
    audio: "环境音：公交车发动机怠速、衣服摩擦声；本镜有对白。",
    nonDiegeticMusic: "低沉的弦乐铺底。",
    textOverlays: [{ text: "末班车", kind: "screen", position: "前挡风玻璃上方" }],
    cameraSpec: { movement: { type: "pan", direction: "right", speed: "slow" } },
    negativePrompt: "lowres, extra fingers",
};
const SCENE = { id: "sc1", name: "公交车前门外的站台（夜）" };
const CHARACTERS = [{ id: "c1", name: "林晚" }];

const INPUT = {
    template: "video_h3_i2v",
    family: "video",
    shot: SHOT,
    scene: SCENE,
    characters: CHARACTERS,
    cast: CHARACTERS,
    style: STYLE,
    slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] },
    overlays: SHOT.textOverlays,
    durationSec: 5,
};

/** 编译器直拼的台词块 —— 改写稿必须逐字回显这一句（ANCHOR 行）。 */
const DIALOGUE = "林晚 (S1) says: <d>[English] 姑娘，这么晚，去哪儿？</d>";
/** 编译器直拼的画面文字句 —— 改写稿必须逐字回显（ANCHOR 行）。 */
const OVERLAY = 'On-screen text kept verbatim: A screen (前挡风玻璃上方) reading "末班车".';

const VISUAL_EN = "A young woman in a cream jacket steps out of the platform shadows, climbs the steps and boards a night bus.";

function validRewrite({ visual = VISUAL_EN, soundscape = "The bus engine idles; fabric rustles.", music = "A low string pad sustains underneath." } = {}) {
    return [
        "【画面描述事实】",
        visual,
        `ANCHOR: ${DIALOGUE}`,
        `ANCHOR: ${OVERLAY}`,
        "",
        "【环境声与动作声】",
        soundscape,
        "",
        "【配乐】",
        music,
    ].join("\n");
}

const count = (text, needle) => text.split(needle).length - 1;

/* ————————————————————— ① 同步稿标记 ————————————————————— */

test("① H3 同步稿：模型要求英文（translate_to=en）且无 rewrite → 末尾追加 [untranslated] 标记，结构照旧", () => {
    assert.equal(ruleKeyForTemplate("video_h3_i2v"), "minimax_h3");
    const out = compileH3VideoPrompt({ ...INPUT });
    assert.ok(out.startsWith("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."));
    assert.match(out, /\[untranslated: MiniMax H3/);
    // 标记只加在末尾：字段结构逐字不变（供流水线 2318 行那道闸门判定）。
    const body = stripUntranslatedMarker(out);
    assert.ok(!body.includes("[untranslated"));
    assert.match(body, /integrated_multimodal_description:/);
    assert.match(body, /overall_soundscape:/);
    assert.match(body, /non_diegetic_music:/);
});

test("① Ref2VA 同步稿同样带标记（六段结构不变）", () => {
    const out = compileH3VideoPrompt({ ...INPUT, template: "video_h3_ref2v", slots: { images: [{ url: "/a/g.png", kind: "reference", role: "character", name: "林晚" }] } });
    assert.ok(out.startsWith("subject_definitions:"));
    assert.match(out, /\[untranslated: MiniMax H3/);
});

/* ————————————————————— ② 合法改写稿 ————————————————————— */

test("② 合法 rewrite：正文英文、锚点逐字保留且只出现一次、运镜/画面文字/负向句由编译器直拼", () => {
    const out = compileH3VideoPrompt({ ...INPUT, rewrite: validRewrite() });
    assert.ok(!out.includes("[untranslated"), "有效改写稿不得带未英文化标记");
    assert.ok(out.includes(VISUAL_EN), "LLM 正文进 integrated_multimodal_description");
    assert.ok(out.includes(DIALOGUE), "<d> 台词块逐字保留");
    assert.equal(count(out, DIALOGUE), 1, "台词只能出现一次（LLM 回显必须被剥离，不得与编译器直拼重复）");
    assert.match(out, /reading "末班车"/, "画面文字逐字保留（英文双引号）");
    assert.equal(count(out, '"末班车"'), 1, "画面文字只能出现一次");
    assert.match(out, /The camera pans right at slow speed\./, "运镜句由编译器直拼");
    assert.match(out, /The frame begins from <Picture 1>, preserving its composition/, "模式引用句由编译器直拼");
    assert.match(out, /画面保持干净稳定/, "负向句（并入正向）由编译器直拼");
    assert.match(out, /overall_soundscape: The bus engine idles; fabric rustles\./, "环境声取改写稿");
    assert.match(out, /non_diegetic_music: A low string pad sustains underneath\./, "配乐取改写稿");
    assert.ok(!out.includes("ANCHOR:"), "锚点行不得进产物");
});

test("② 改写稿的声轨段被采用；写 N/A 时编译器如实落 N/A 哨兵", () => {
    const shot = { ...SHOT, nonDiegeticMusic: "", audio: "" };
    const out = compileH3VideoPrompt({ ...INPUT, shot, rewrite: validRewrite({ soundscape: "The night bus brakes with a soft hiss.", music: "N/A" }) });
    assert.match(out, /overall_soundscape: The night bus brakes with a soft hiss\./, "环境声取改写稿（旧编译器会丢掉整个 rewrite）");
    assert.match(out, /non_diegetic_music: N\/A/, "改写稿写 N/A → 编译器落 N/A 哨兵");
    assert.ok(out.includes(VISUAL_EN));
    assert.ok(!out.includes("[untranslated"));
});

/* ————————————————————— ③ 弃稿回落 ————————————————————— */

test("③ 篡改台词（翻译）→ 弃稿：回落同步中文稿 + 标记，篡改正文不得进产物", () => {
    const tampered = validRewrite().replace("姑娘，这么晚，去哪儿？", "Where are you going so late?");
    const out = compileH3VideoPrompt({ ...INPUT, rewrite: tampered });
    assert.match(out, /\[untranslated/, "逐字锁不过 → 必须回落并标记");
    assert.ok(out.includes(DIALOGUE), "回落后用编译器直拼的逐字台词");
    assert.ok(!out.includes("Where are you going so late?"), "被翻译的台词绝不能进产物");
});

test("③ 漏标签 → 弃稿：回落同步中文稿 + 标记", () => {
    const out = compileH3VideoPrompt({ ...INPUT, rewrite: `${VISUAL_EN}\n${DIALOGUE}` });
    assert.match(out, /\[untranslated/);
    assert.ok(!out.includes(VISUAL_EN), "无法按标签回填 → 英文正文也不采用");
});

test("③ 画面文字被移出英文双引号 → 弃稿", () => {
    const rewrite = validRewrite().replace('"末班车"', "末班车");
    const out = compileH3VideoPrompt({ ...INPUT, rewrite });
    assert.match(out, /\[untranslated/, "画面文字必须逐字留在英文双引号内");
});

test("③ 锚点内联进正文（内容还在、但不在 ANCHOR 行）→ 弃稿，避免台词被渲染两遍", () => {
    const rewrite = [
        "【画面描述事实】",
        `A young woman boards a night bus while ${DIALOGUE}`,
        `On-screen text kept verbatim: A screen reading "末班车".`,
        "",
        "【环境声与动作声】",
        "N/A",
        "",
        "【配乐】",
        "N/A",
    ].join("\n");
    const out = compileH3VideoPrompt({ ...INPUT, rewrite });
    assert.match(out, /\[untranslated/, "锚点未按 ANCHOR 行返回 → 剥离不净，必须弃稿");
    assert.equal(count(out, DIALOGUE), 1, "产物里台词仍只出现一次");
});

/* ————————————————————— ④ Ref2VA ————————————————————— */

test("④ Ref2VA 合法 rewrite：detailed_description 英文 + 锚点逐字，六段顺序不变", () => {
    const input = { ...INPUT, template: "video_h3_ref2v", slots: { images: [{ url: "/a/g.png", kind: "reference", role: "character", name: "林晚" }] } };
    const out = compileH3VideoPrompt({ ...input, rewrite: validRewrite() });
    const order = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"];
    let last = -1;
    for (const field of order) {
        const at = out.indexOf(field);
        assert.ok(at > last, `${field} 必须存在且顺序固定`);
        last = at;
    }
    assert.ok(!out.includes("[untranslated"));
    assert.match(out, /retention_analysis: <Picture 1> \(林晚\): fully_preserved/);
    assert.ok(out.includes(`detailed_description: The subjects are defined by <Picture 1> (林晚). ${VISUAL_EN}`), out.slice(0, 400));
    assert.equal(count(out, DIALOGUE), 1, "Ref2VA 的 <d> 台词同样逐字且只出现一次");
    assert.match(out, /non_diegetic_music: A low string pad sustains underneath\./);
});

/* ————————————————————— ⑤ async 专用入口 ————————————————————— */

test("⑤ async 专用入口：三段标签源 + 逐字照抄 system；合法改写 → 英文产物无标记", async () => {
    const calls = [];
    const llmCall = async ({ system, user }) => {
        calls.push({ system, user });
        return validRewrite();
    };
    const out = await compilePromptForTemplateAsync({ ...INPUT, llmCall });
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, /verbatim/);
    assert.match(calls[0].system, /never translate/);
    const source = calls[0].user;
    assert.ok(source.includes("【画面描述事实】") && source.includes("【环境声与动作声】") && source.includes("【配乐】"), "必须打成三段带标签的源");
    assert.ok(source.includes(`ANCHOR: ${DIALOGUE}`), "台词锚点必须进源（否则无从校验逐字保留）");
    assert.ok(source.includes(OVERLAY), "画面文字锚点必须进源");
    assert.ok(!out.includes("[untranslated"));
    assert.ok(out.includes(VISUAL_EN));
});

test("⑤ async：篡改台词 → onWarning 记原因 + 回落同步稿（带标记，供调用方弃用）", async () => {
    const warnings = [];
    const out = await compilePromptForTemplateAsync({
        ...INPUT,
        llmCall: async () => validRewrite().replace("姑娘，这么晚，去哪儿？", "Where are you going?"),
        onWarning: (error) => warnings.push(error.message),
    });
    assert.equal(warnings.length, 1, "弃稿必须记一条 warning");
    assert.match(warnings[0], /台词/);
    assert.match(out, /\[untranslated/);
    assert.ok(out.includes(DIALOGUE));
    assert.ok(!out.includes("Where are you going?"));
});

test("⑤ async：缺少主标签 → onWarning + 回落同步稿", async () => {
    const warnings = [];
    const out = await compilePromptForTemplateAsync({ ...INPUT, llmCall: async () => "just an english sentence", onWarning: (error) => warnings.push(error.message) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /标签/);
    assert.match(out, /\[untranslated/);
});

test("⑤ async：未注入 llmCall → 同步稿 + 标记（绝不假装已英文化）", async () => {
    const out = await compilePromptForTemplateAsync({ ...INPUT });
    assert.match(out, /\[untranslated/);
    assert.equal(out, compilePromptForTemplate(INPUT));
});

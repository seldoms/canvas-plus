import assert from "node:assert/strict";
import { test } from "node:test";

import {
    COMPILER_RULES,
    compileFluxImagePrompt,
    compileGenericPrompt,
    compileH3VideoPrompt,
    compileKrea2ImagePrompt,
    compilePromptForTemplate,
    compilePromptForTemplateAsync,
    compileQwen21ImagePrompt,
    compilerFor,
    h3AlignmentLine,
    h3Mode,
    negativeClause,
    presetForTemplate,
    readStyleFields,
    speakerId,
} from "../src/prompt-compiler.js";

/**
 * 提示词编译器（策略层）纯函数测试：**按 model-rules.js 的规则表分派**。
 *
 * 固化的正确口径（本次推倒重写的方向）：
 *   · H3 走**本地字段口径**：I2VA/FL2VA/L2VA 首行是关键帧对齐指令行（时间两位小数、后空一行），
 *     正文三字段固定顺序 integrated_multimodal_description / overall_soundscape / non_diegetic_music，
 *     参考素材 <Picture 1>，不要 BGM 写 non_diegetic_music: N/A，运镜用官方词表自然句式，
 *     台词 (S1) + <d>[English] ...</d> 逐字不翻译；
 *   · Qwen 2.1 用 <image1>~<image10>（禁止「图1」式指代），官方英文口径靠改写器，拿不到就显式 [untranslated]；
 *   · Krea2 / FLUX 仅英文有官方依据 → 无 llmCall 时中文 + [untranslated]，不得默默发中文；
 *   · 负面按 negativePolicy 分派，**不存在「英文负向词→中文映射表」**；
 *   · 通用兜底与旧行为逐字一致（兼容红线）。
 *
 * fixture 用真实 run-murvf1vq-aqyqm 的 sh1/sh2/sh5（只读事实形状）。
 */

const SH1 = {
    id: "sh1",
    sceneId: "sc1",
    durationSec: 5,
    shotSize: "全景",
    action: "公交车从画面右侧驶入，减速，停靠在站台，前门打开。车门打开时发出气动声。段末可见状态：公交车停稳，前门打开，车厢内灯光透出。",
    dialogue: "",
    audio: "环境音：深夜街道远处车流声、公交车发动机怠速声、车门气动声；本镜无对白。",
    textOverlays: [{ text: "末班车", kind: "screen", position: "公交车前挡风玻璃上方的电子显示屏", style: "红底黄字，LED点阵字体，略微闪烁" }],
    cameraSpec: { movement: { type: "static", direction: "none", speed: "slow", stabilization: "steady" } },
    prompt: "A late-night city street, a bus with its front door opening at a bus stop, wide shot, realistic.",
    negativePrompt: "extra fingers, deformed face, text watermark, lowres, overexposed, no people besides driver inside bus, no other vehicles close-up",
};

const SH2 = {
    id: "sh2",
    sceneId: "sc1",
    durationSec: 4,
    shotSize: "中景",
    action: "女孩从站台阴影中走出，上台阶，进入公交车，身体猛地一颤，打了个寒颤。段末可见状态：女孩站在前门内，身体微缩，双手抱纸箱。",
    dialogue: "",
    audio: "环境音：脚步踩在柏油路上、公交车发动机怠速、衣服摩擦声；本镜无对白。",
    textOverlays: [{ text: "", kind: "none", position: "", style: "" }],
    cameraSpec: { movement: { type: "pan", direction: "right", speed: "slow", stabilization: "steady" } },
    prompt: "A young woman walking out of shadow at bus stop, medium shot, realistic.",
    negativePrompt: "extra fingers, lowres",
};

const SH5 = {
    id: "sh5",
    sceneId: "sc1",
    durationSec: 4,
    shotSize: "近景",
    action: "老周未回头，嘴唇启动，低声说话。段末可见状态：老周保持驾驶姿势，目光向前，后视镜中有女孩模糊影像。",
    dialogue: "姑娘，这么晚，去哪儿？（低声、音量低、语速慢、略带关心）",
    audio: "环境音：公交车行驶低频震动、暖风声；本镜有对白。",
    textOverlays: [{ text: "", kind: "none", position: "", style: "" }],
    cameraSpec: { movement: { type: "static", direction: "none", speed: "slow", stabilization: "steady" } },
    prompt: "Over-the-shoulder shot of a middle-aged bus driver, side profile, near view, realistic.",
    negativePrompt: "extra fingers, lowres",
};

const STYLE = {
    anchor: "写实电影感，暖色路灯与冷调夜色的对比，浅景深，细腻胶片颗粒",
    context: "写实电影感，暖色路灯与冷调夜色的对比，浅景深，细腻胶片颗粒",
    filmLayer: "overexposure melting contours, grey-blue shadows, fine grain",
};

const scene = { id: "sc1", name: "公交车前门外的站台（夜）" };

const I2VA_LINE = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";

/* ————————————————————— H3 本地字段口径 ————————————————————— */

test("H3 I2VA：首行是关键帧对齐指令行，时间两位小数、后空一行", () => {
    const out = compileH3VideoPrompt({
        template: "video_h3_i2v",
        shot: SH1,
        scene,
        characters: [],
        style: STYLE,
        slots: { images: [{ url: "/a/first.png", kind: "first_frame" }] },
        overlays: SH1.textOverlays,
        durationSec: 5,
    });
    assert.ok(out.startsWith(`${I2VA_LINE}\n\n`), `首行必须是对齐指令行且后空一行：${JSON.stringify(out.slice(0, 120))}`);
    assert.equal(out.split("\n")[0], I2VA_LINE);
    assert.ok(!out.includes("@图片1"), "本地口径用 <Picture 1>，不是 @图片1");
    assert.ok(out.includes("<Picture 1>"));
});

test("H3 T2VA：无关键帧对齐指令行，直接三字段", () => {
    const out = compileH3VideoPrompt({ template: "video_minimax_h3_t2v", shot: SH2, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    assert.ok(out.startsWith("integrated_multimodal_description:"), out.slice(0, 80));
    assert.ok(!out.includes("For the target video"));
    assert.ok(!out.includes("How the reference pictures align"));
});

test("H3 FL2VA：首行是英文对齐说明，且结束时间=目标时长（两位小数）", () => {
    const out = compileH3VideoPrompt({
        template: "video_h3_i2v_fl",
        shot: SH2,
        scene,
        characters: [{ name: "女孩" }],
        style: STYLE,
        slots: { images: [{ url: "/a/f.png", kind: "first_frame" }, { url: "/a/l.png", kind: "last_frame" }] },
        overlays: [],
        durationSec: 4,
    });
    const first = out.split("\n")[0];
    assert.ok(first.startsWith("How the reference pictures align with the target video — "), first);
    assert.match(first, /0\.00-second mark/);
    assert.match(first, /4\.00-second mark/, "结束时间必须等于目标时长 4.00 秒");
    assert.ok(first.includes("Picture 1") && first.includes("Picture 2"));
});

test("H3 三字段固定顺序 + 字段名 + non_diegetic_music: N/A", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: SH1.textOverlays, durationSec: 5 });
    const iDesc = out.indexOf("integrated_multimodal_description:");
    const iSound = out.indexOf("overall_soundscape:");
    const iMusic = out.indexOf("non_diegetic_music:");
    assert.ok(iDesc >= 0 && iSound > iDesc && iMusic > iSound, "三字段必须按固定顺序出现");
    assert.match(out, /non_diegetic_music: N\/A/, "不要 BGM → 官方字段名 + N/A");
    assert.ok(!out.includes("非叙事性音乐"), "旧的错误字段名不得出现");
    assert.ok(!out.includes("【核心创意】") && !out.includes("【画面过程说明】"), "旧的三段式标题不得出现");
});

test("H3 参考素材用 <Picture 1>（不是 @图片1），不在正文里写上传顺序编号", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.ok(out.includes("<Picture 1>"));
    assert.ok(!/@图片/.test(out));
});

test("H3 运镜：官方词表 + 自然句式（static / pan right slow）", () => {
    const still = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5 });
    assert.match(still, /The camera holds a static shot\./);
    const pan = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH2, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    assert.match(pan, /The camera pans right at slow speed\./);
});

test("H3 台词：说话人稳定 ID (S1) + <d>[English] ...</d> 只放纯台词正文", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_talk", shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 4 });
    assert.match(out, /\(S1\)/);
    assert.ok(out.includes("<d>[English] 姑娘，这么晚，去哪儿？</d>"), "台词正文逐字保留、不翻译");
    assert.ok(!out.includes("<d>[Chinese]"), "口径固定用 [English] 标签（见规则表 dialogue.content）");
    // 括号表演注解已剥出 <d>（见「验收问题②」）：只留纯台词正文。
    const block = out.slice(out.indexOf("<d>"), out.indexOf("</d>") + 4);
    assert.ok(!/[（(]/.test(block), `<d> 内不得含括号表演注解：${block}`);
    assert.ok(out.includes("Performance: 低声、音量低、语速慢、略带关心."), "注解移到描述层作表演提示");
});

test("H3 台词带括号表演注解：<d> 内只有纯台词，注解以描述层表演提示出现（不塞回 <d>）", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_talk", shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 4 });
    const start = out.indexOf("<d>");
    const end = out.indexOf("</d>");
    assert.ok(start >= 0 && end > start, "有台词正文 → 必须输出 <d> 块");
    const block = out.slice(start, end + 4);
    assert.ok(!/[（(]/.test(block), `<d> 块内不得含括号（全角/半角都不行）：${block}`);
    assert.ok(!block.includes("低声") && !block.includes("语速慢"), "表演注解不得留在 <d> 内");
    assert.ok(out.includes("低声、音量低、语速慢、略带关心"), "注解不得丢失");
    assert.ok(out.includes("Performance: 低声、音量低、语速慢、略带关心."), "注解写进描述层作表演提示");
    // 半角括号同样处理（英文台词）。
    const half = compileH3VideoPrompt({ template: "video_h3_talk", shot: { ...SH5, dialogue: "Are you okay? (soft voice, slow)" }, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    assert.ok(half.includes("<d>[English] Are you okay?</d>"), half);
    assert.ok(!/<d>[^<]*[（(]/.test(half), "半角括号注解也不得进 <d>");
});

test("H3 台词只有括号注解、无正文：<d> 块整块不输出（不输出空 <d>[English] </d>）", () => {
    const shot = { ...SH5, dialogue: "（低声、语速慢）", audio: "环境音：公交车行驶低频震动；本镜无对白。" };
    const out = compileH3VideoPrompt({ template: "video_h3_talk", shot, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 4 });
    assert.ok(!out.includes("<d>") && !out.includes("</d>"), `整条只有注解 → 不输出 <d> 块：${out}`);
    assert.ok(!/\(S1\)/.test(out), "无台词正文 → 不写说话人");
    assert.ok(!out.includes("says"), "无台词正文 → 不写 says");
    assert.ok(!out.includes("Performance:"), "无台词正文 → 不为不存在的台词写歧义表演提示");
});

test("H3 Ref2VA：台词注解同样剥出 <d> 并进 detailed_description 描述层", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_ref2v", shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/g.png", kind: "reference", role: "character", name: "老周" }] }, overlays: [], durationSec: 4 });
    const block = out.slice(out.indexOf("<d>"), out.indexOf("</d>") + 4);
    assert.ok(!/[（(]/.test(block), `<d> 内不得含括号：${block}`);
    assert.ok(out.includes("Performance: 低声、音量低、语速慢、略带关心."), "注解进 detailed_description");
});

/* ————————————————————— 验收问题①：style 防御性归一（readStyleFields） ————————————————————— */

test("readStyleFields：字符串→纯锚点、对象→只取字符串字段、null/其它→全空（绝不函数/对象强转）", () => {
    assert.deepEqual(readStyleFields("写实电影感"), { anchor: "写实电影感", context: "", filmLayer: "" });
    assert.deepEqual(readStyleFields("  带空白  "), { anchor: "带空白", context: "", filmLayer: "" });
    assert.deepEqual(readStyleFields({ anchor: "a", context: "c", filmLayer: "l" }), { anchor: "a", context: "c", filmLayer: "l" });
    assert.deepEqual(readStyleFields({ anchor: "a", context: 123, filmLayer: {} }), { anchor: "a", context: "", filmLayer: "" }, "非字符串字段视为空");
    assert.deepEqual(readStyleFields(null), { anchor: "", context: "", filmLayer: "" });
    assert.deepEqual(readStyleFields(undefined), { anchor: "", context: "", filmLayer: "" });
    assert.deepEqual(readStyleFields(42), { anchor: "", context: "", filmLayer: "" });
    // 关键：绝不能解析到 String.prototype.anchor（函数）。
    assert.equal(typeof readStyleFields("x").anchor, "string");
    assert.ok(!readStyleFields("x").anchor.includes("native code"));
});

test("style 传字符串：H3 输出不含 native code，字符串作为风格锚点进描述层（不再踩 String.prototype.anchor）", () => {
    const ANCHOR = "写实电影感，暖色路灯与冷调夜色的对比，浅景深，细腻胶片颗粒";
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: ANCHOR, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.ok(!out.includes("native code"), `不得把 String.prototype.anchor 函数体写进提示词：${out.slice(0, 220)}`);
    assert.ok(!out.includes("function anchor"), "不得出现 function anchor 字样");
    assert.ok(out.includes(`Live-action, cinematic, ${ANCHOR}.`), "字符串 style 视为纯锚点，进描述层");
    // Ref2VA 分支同样经 readStyleFields。
    const ref2 = compileH3VideoPrompt({ template: "video_h3_ref2v", shot: SH1, scene, characters: [], style: ANCHOR, slots: { images: [{ url: "/a/g.png", kind: "reference", role: "scene" }] }, overlays: [], durationSec: 5 });
    assert.ok(!ref2.includes("native code"));
    assert.ok(ref2.includes(`${ANCHOR}.`), "Ref2VA detailed_description 用锚点");
    // 中文降级分支（imageFactsCn）同样经 readStyleFields。
    const krea = compileKrea2ImagePrompt({ template: "img_krea2_artistic", shot: SH1, style: ANCHOR, slots: { images: [] }, basePrompt: SH1.prompt });
    assert.ok(!krea.includes("native code"));
    assert.ok(krea.includes(`风格：${ANCHOR}`), "Krea2 中文降级把字符串 style 当锚点");
    // styleHead 出口（Qwen）同样不注入垃圾。
    const qwen = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH1, scene, characters: [], style: ANCHOR, slots: { images: [] }, legacyBody: "a bus" });
    assert.ok(!qwen.includes("native code"));
    // 通用兜底：字符串 style 且无 context → 与「只有 anchor 的对象」同口径（不前置，逐字不变）。
    assert.equal(compileGenericPrompt({ style: ANCHOR, legacyBody: "a bus arrives" }), "a bus arrives");
});

test("style 传对象：与既有行为一致（回归，逐字不变）", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.ok(out.includes(`Live-action, cinematic, ${STYLE.anchor}.`), "对象 anchor 仍进描述层");
    // styleHead 对正确对象的既有输出逐字不变（兼容红线）。
    const body = `${STYLE.anchor}，一辆末班车。`;
    assert.equal(compileGenericPrompt({ style: STYLE, legacyBody: body }), `${body} ${STYLE.filmLayer}`);
    assert.equal(compileGenericPrompt({ style: {}, legacyBody: "a bus arrives" }), "a bus arrives");
});

test("style 传 null / 非字符串字段：不崩、不注入垃圾", () => {
    const nullOut = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: null, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.equal(typeof nullOut, "string");
    assert.ok(!nullOut.includes("native code") && !nullOut.includes("undefined") && !nullOut.includes("[object Object]"), nullOut.slice(0, 200));
    assert.ok(nullOut.includes("[Shot 1] Live-action, cinematic, a wide shot"), "空 style → 退回中性头部");
    // 含非字符串字段的对象：全部视为空（不得 String(函数) 进提示词）。
    assert.equal(compileGenericPrompt({ style: { anchor: 123, context: {}, filmLayer: () => "zzz" }, legacyBody: "x" }), "x");
    assert.equal(compileGenericPrompt({ style: { anchor: null, context: [], filmLayer: 0 }, legacyBody: "y" }), "y");
    // 数字 style（经分派入口）不崩。
    const num = compilePromptForTemplate({ template: "video_h3_i2v", family: "video", shot: SH1, scene, characters: [], style: 42, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.equal(typeof num, "string");
    assert.ok(!num.includes("native code"));
});

test("H3 画外音：写 says in an off-screen voiceover 且紧跟嘴唇保持闭合", () => {
    const shot = { ...SH5, voiceover: true };
    const out = compileH3VideoPrompt({ template: "video_h3_talk", shot, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 4 });
    assert.match(out, /says in an off-screen voiceover/);
    assert.match(out, /lips remain completely closed/);
});

test("H3 画面文字：英文双引号包原文（逐字不翻译）", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: SH1.textOverlays, durationSec: 5 });
    assert.match(out, /reading "末班车"/);
});

test("H3 soundscape：1–4 句环境/动作/非语言人声，剔除「本镜有/无对白」旁白，且不含台词", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_talk", shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 4 });
    const sound = out.split("\n").find((line) => line.startsWith("overall_soundscape:"));
    assert.ok(sound.includes("公交车行驶低频震动"), sound);
    assert.ok(!sound.includes("本镜有对白"), "「本镜有对白」是元信息，不进 soundscape");
    assert.ok(!sound.includes("姑娘，这么晚"), "soundscape 不含台词");
});

test("H3 多场景：在文件内写清切镜点（两位小数时间码）", () => {
    const shot = { ...SH1, cuts: [{ atSec: 3.5, text: "公交车停稳，前门打开" }] };
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 6 });
    assert.match(out, /\[Shot 2\] At 00:03\.500, the camera cuts to/);
});

test("H3 Ref2VA：六段固定顺序（subject_definitions … non_diegetic_music）", () => {
    const out = compileH3VideoPrompt({
        template: "video_h3_ref2v",
        shot: SH2,
        scene,
        characters: [{ name: "女孩" }],
        style: STYLE,
        slots: { images: [{ url: "/a/g.png", kind: "reference", role: "character", name: "女孩" }] },
        overlays: [],
        durationSec: 4,
    });
    const order = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"];
    const idx = order.map((name) => out.indexOf(name));
    assert.ok(idx.every((i) => i >= 0), `Ref2VA 六段都要在：${out.slice(0, 200)}`);
    for (let i = 1; i < idx.length; i += 1) assert.ok(idx[i] > idx[i - 1], `${order[i]} 顺序必须靠后`);
    assert.match(out, /fully_preserved/);
});

test("h3Mode：按模板意图 + 实际注入槽位判定 I2VA/FL2VA/L2VA/T2VA/Ref2VA", () => {
    assert.equal(h3Mode("video_h3_i2v", []), "I2VA");
    assert.equal(h3Mode("video_h3_i2v_fl", [{ kind: "first_frame" }, { kind: "last_frame" }]), "FL2VA");
    assert.equal(h3Mode("video_minimax_h3_t2v", []), "T2VA");
    assert.equal(h3Mode("video_h3_ref2v", []), "Ref2VA");
    assert.equal(h3Mode("video_h3_i2v", [{ kind: "last_frame" }]), "L2VA");
});

/* ————————————————————— 负面词：按 negativePolicy 分派 ————————————————————— */

test("negativeClause：minimax_h3 / qwen_image_2_1 不产出负面段（negative=none，改写进正向）", () => {
    assert.equal(negativeClause("video_h3_i2v"), "");
    assert.equal(negativeClause("img_qwen21_t2i"), "");
    assert.equal(negativeClause("img_qwen21_edit"), "");
});

test("negativeClause：wan21_t2v（required）产出官方中文负面串", () => {
    const out = negativeClause("wan21_t2v");
    assert.match(out, /^negative_prompt: 色调艳丽/);
    assert.ok(out.includes("JPEG压缩残留"), "官方中文负面串逐字沿用");
});

test("negativeClause：wan22_animate（optional）产出官方中文负面串；flux1_dev（zero_out）不产出", () => {
    assert.match(negativeClause("video_wan_animate"), /^negative_prompt: 色调艳丽/);
    assert.equal(negativeClause("img_flux_artistic"), "", "FLUX 官方反对负面 → ConditioningZeroOut，不写负面段");
});

test("H3 输出不再出现英文负向词（旧映射已拆除）", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.ok(!/extra fingers|deformed face|lowres|overexposed|watermark|no people besides/i.test(out), "英文负向词表不得被搬进 H3 输出");
});

/* ————————————————————— H3 不碰 generic 口径 ————————————————————— */

test("通用兜底：无 style.context 时原样返回 legacyBody（不退化）", () => {
    assert.equal(compileGenericPrompt({ style: {}, legacyBody: "a bus arrives" }), "a bus arrives");
});

test("通用兜底：style 锚点已在首句则不重复前置，胶片层按锚点追加", () => {
    const body = `${STYLE.anchor}，一辆末班车。`;
    const out = compileGenericPrompt({ style: STYLE, legacyBody: body });
    assert.equal(out, `${body} ${STYLE.filmLayer}`);
    assert.equal(out.split(STYLE.anchor).length - 1, 1);
});

test("通用兜底：legacyBody 已含文字层则不重复追加；未含则逐字补上", () => {
    const overlays = [{ text: "末班车", kind: "screen", position: "top", style: "led" }];
    const already = compileGenericPrompt({ style: {}, legacyBody: 'bus. on-screen text rendered verbatim: screen text "末班车" at top in led', overlays });
    assert.equal(already.split("on-screen text rendered verbatim").length - 1, 1);
    const appended = compileGenericPrompt({ style: {}, legacyBody: "bus arrives", overlays });
    assert.match(appended, /on-screen text rendered verbatim/);
    assert.ok(appended.includes('"末班车"'));
});

/* ————————————————————— Qwen 2.1：<imageN> + 显式标记 ————————————————————— */

test("Qwen 2.1：参考图用 <image1>/<image2>（禁止「图1」式自然语言指代）", () => {
    const out = compileQwen21ImagePrompt({
        template: "img_qwen21_edit",
        shot: SH1,
        scene,
        characters: [{ name: "老周" }],
        style: {},
        slots: { images: [{ url: "/a/input.png", kind: "input_image", role: "character", name: "老周" }, { url: "/a/ref1.png", kind: "reference", role: "scene", name: "公交车内" }] },
        overlays: [],
        legacyBody: SH1.prompt,
    });
    assert.match(out, /<image1>/);
    assert.match(out, /<image2>/);
    assert.ok(!/图1|图片1/.test(out), "禁止「图1」式指代");
});

test("Qwen 2.1：无改写器结果 → 显式 [untranslated] 标记（不得假装已英文化）", () => {
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH5, scene, characters: [{ name: "老周" }], style: {}, slots: { images: [] }, overlays: [], basePrompt: SH5.prompt, legacyBody: SH5.prompt });
    assert.match(out, /\[untranslated/);
});

test("Qwen 2.1：有改写器英文结果 → 直接采用（不再带标记）", () => {
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH5, scene, characters: [{ name: "老周" }], style: {}, slots: { images: [] }, overlays: [], rewrite: "A long English prompt describing the finished image." });
    assert.equal(out, "A long English prompt describing the finished image.");
    assert.ok(!out.includes("[untranslated"));
});

test("Qwen 2.1：透明背景 → 官方 RGBA 咒语", () => {
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH5, scene, characters: [], style: {}, slots: { images: [], transparent: true }, overlays: [], legacyBody: "a driver" });
    assert.match(out, /This is an RGBA image with transparency\./);
    assert.match(out, /alpha channel and the background is transparent/);
});

test("Qwen 2.1：图上文字英文双引号逐字（走 pipeline 同口径 clause）", () => {
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH1, scene, characters: [], style: {}, slots: { images: [] }, overlays: SH1.textOverlays, legacyBody: "x" });
    assert.match(out, /on-screen text rendered verbatim/);
    assert.ok(out.includes('"末班车"'));
});

/* ————————————————————— Krea2 / FLUX：强制英文（无 LLM 显式标记） ————————————————————— */

test("Krea2：无 llmCall/rewrite → 中文降级 + [untranslated]（不默默发中文）", () => {
    const out = compileKrea2ImagePrompt({ template: "img_krea2_artistic", shot: SH1, scene, characters: [], style: {}, slots: { images: [] }, basePrompt: SH1.prompt });
    assert.match(out, /\[untranslated/);
});

test("Krea2 / FLUX：有 rewrite → 输出英文（官方仅英文有依据）", () => {
    const krea = compileKrea2ImagePrompt({ template: "img_krea2_artistic", shot: SH1, style: {}, rewrite: "A cinematic photograph of a bus at night." });
    assert.equal(krea, "A cinematic photograph of a bus at night.");
    const flux = compileFluxImagePrompt({ template: "img_flux_artistic", shot: SH1, style: {}, rewrite: "A photographic scene of a night bus." });
    assert.equal(flux, "A photographic scene of a night bus.");
});

/* ————————————————————— 参数档：presetFor ————————————————————— */

test("presetForTemplate：按模板取官方参数档（不硬编码 steps/cfg/sampler）", () => {
    const h3 = presetForTemplate("video_h3_i2v", "speed");
    assert.equal(h3.steps, 8);
    assert.equal(h3.cfg, 1.0);
    assert.equal(h3.sampler, "res_multistep");
    const qwen = presetForTemplate("img_qwen21_t2i", "quality");
    assert.equal(qwen.steps, 25);
    assert.equal(qwen.cfg, 1.0);
    assert.equal(presetForTemplate("img-test", "speed"), null, "无规则模板回 null");
});

/* ————————————————————— 分派表 ————————————————————— */

test("compilerFor：按规则表分派 —— H3 / Qwen 2.1 / Krea2 / FLUX / generic", () => {
    assert.equal(compilerFor("video_h3_i2v", "video").id, "h3-local-fields");
    assert.equal(compilerFor("video_minimax_h3_t2v", "video").id, "h3-local-fields");
    assert.equal(compilerFor("video_h3_ref2v_image", "video").id, "h3-local-fields");
    assert.equal(compilerFor("img_qwen21_t2i", "image").id, "qwen-image-2.1");
    assert.equal(compilerFor("img_qwen21_edit", "image").id, "qwen-image-2.1");
    assert.equal(compilerFor("img_krea2_artistic", "image").id, "krea2");
    assert.equal(compilerFor("img_flux_artistic", "image").id, "flux");
    assert.equal(compilerFor("img_zimage_artistic", "image").id, "generic", "双语有官方依据 → 通用兜底");
    assert.equal(compilerFor("upscale_4x", "image").id, "generic");
});

test("compilePromptForTemplate：按模板分派，产物始终是字符串", () => {
    const h3 = compilePromptForTemplate({ template: "video_h3_i2v", family: "video", shot: SH1, scene, characters: [], style: {}, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.match(h3, /^For the target video, at 0\.00 seconds/);
    const qwen = compilePromptForTemplate({ template: "img_qwen21_t2i", family: "image", shot: SH5, scene, characters: [{ name: "老周" }], style: {}, slots: { images: [] }, legacyBody: "a driver" });
    assert.match(qwen, /\[untranslated/);
    const generic = compilePromptForTemplate({ template: "img_zimage_artistic", family: "image", shot: SH5, style: {}, legacyBody: "an artistic prompt" });
    assert.equal(generic, "an artistic prompt");
});

test("compilePromptForTemplate：异常输入不抛错、回落字符串", () => {
    assert.equal(typeof compilePromptForTemplate(), "string");
    assert.equal(typeof compilePromptForTemplate({ template: "video_h3_i2v", family: "video", shot: null, slots: null }), "string");
});

test("分派表：最后一条是 catch-all 兜底", () => {
    assert.equal(COMPILER_RULES[COMPILER_RULES.length - 1].id, "generic");
    assert.equal(COMPILER_RULES.at(-1).match({ template: "任意", family: "other" }), true);
});

/* ————————————————————— async 出口：官方改写器英文化 ————————————————————— */

test("compilePromptForTemplateAsync：Qwen 2.1 经官方改写器英文化（llmCall 注入，模块不发请求）", async () => {
    const calls = [];
    const llmCall = async ({ system, user }) => {
        calls.push({ system, user });
        return "A long English prompt describing the finished image in detail.";
    };
    const out = await compilePromptForTemplateAsync({ template: "img_qwen21_t2i", family: "image", shot: SH5, scene, characters: [{ name: "老周" }], style: {}, slots: { images: [] }, llmCall });
    assert.equal(out, "A long English prompt describing the finished image in detail.");
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, /Image Prompt Rewriting Expert/, "用的是 qwen-image-2.1-pe 官方系统提示词");
});

test("compilePromptForTemplateAsync：无官方改写器的模型（H3）回落 sync 出口", async () => {
    const out = await compilePromptForTemplateAsync({ template: "video_h3_i2v", family: "video", shot: SH1, scene, characters: [], style: {}, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, durationSec: 5, llmCall: async () => "should not be used" });
    assert.match(out, /^For the target video, at 0\.00 seconds/);
});

/* ————————————————————— 关键帧对齐指令行 / 说话人 ID（直接单测） ————————————————————— */

test("h3AlignmentLine：I2VA/FL2VA/L2VA 官方原文口径、时间两位小数；T2VA 无此行", () => {
    assert.equal(h3AlignmentLine("I2VA", 5), I2VA_LINE);
    assert.equal(h3AlignmentLine("T2VA", 5), "");
    const fl = h3AlignmentLine("FL2VA", 8);
    assert.match(fl, /^How the reference pictures align with the target video — /);
    assert.match(fl, /8\.00-second mark/);
    const l2 = h3AlignmentLine("L2VA", 6);
    assert.match(l2, /<Picture 1> \(from \[Shot 1\]\) aligns with the 6\.00-second mark/);
});

test("speakerId：稳定递增编号 (S1)(S2)…", () => {
    assert.equal(speakerId(0), "S1");
    assert.equal(speakerId(1), "S2");
    assert.equal(speakerId(9), "S10");
});

test("H3 negative=none：无独立负面段，负向约束改写进正向（不搬运英文负向词）", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.ok(!out.includes("negative_prompt:"), "H3 没有负面字段");
    assert.match(out, /画面保持干净稳定/, "负向约束并进正向的洁净句");
});

test("Qwen 2.1：negative=none 也改写进正向，不产出负面字段", () => {
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH1, scene, characters: [], style: {}, slots: { images: [] }, overlays: [], basePrompt: SH1.prompt, legacyBody: SH1.prompt });
    assert.ok(!out.includes("negative_prompt:"));
    assert.match(out, /画面保持干净稳定/);
});

test("compilePromptForTemplateAsync：Krea2 无官方改写器 → 经 llmCall 英文化", async () => {
    const calls = [];
    const llmCall = async ({ system, user }) => {
        calls.push({ system, user });
        return "A cinematic night-time photograph of a city bus at a stop.";
    };
    const out = await compilePromptForTemplateAsync({ template: "img_krea2_artistic", family: "image", shot: SH1, scene, characters: [], style: {}, slots: { images: [] }, llmCall });
    assert.equal(out, "A cinematic night-time photograph of a city bus at a stop.");
    assert.equal(calls.length, 1);
    assert.match(calls[0].system, /English prompt/, "无官方改写器时用通用英文化 system");
    assert.ok(!out.includes("[untranslated"));
});

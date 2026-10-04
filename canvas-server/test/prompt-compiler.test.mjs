import assert from "node:assert/strict";
import { test } from "node:test";

import {
    COMPILER_RULES,
    aspectRatioConflict,
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
const VERTICAL_STYLE = { ...STYLE, ratio: "9:16" };

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

test("分级：画幅事实写进 Qwen 同步稿与 H3 稿；改写成功产物一级块在前、改写稿只作二级块", () => {
    const qwenSync = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH1, scene, style: VERTICAL_STYLE, slots: { images: [] } });
    assert.match(qwenSync, /画幅：9:16（竖屏构图/, "同步稿必须把画幅当事实写进去");
    assert.ok(qwenSync.includes(VERTICAL_STYLE.anchor), "同步稿一级块含风格锚点");

    // 分级：一级（风格/画幅）由编译器直拼在前，改写稿只作二级块 —— 绝不整稿替换；
    // 编译器不对英文改写稿做正则手术（手术改不干净会留下「开头竖屏、正文横屏」的自相矛盾稿）。
    const rewrite = "The image is a vertical portrait cinematic medium close-up of a bus at night, 9:16 aspect ratio.";
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH1, scene, style: VERTICAL_STYLE, slots: { images: [] }, rewrite });
    assert.ok(out.endsWith(rewrite), "改写稿原样作为二级块贴在末尾");
    assert.ok(out.startsWith(VERTICAL_STYLE.anchor), "一级块以风格锚点起首");
    assert.ok(out.indexOf("画幅：9:16（竖屏构图") < out.indexOf(rewrite), "一级块必须在二级块之前");

    const h3 = compileH3VideoPrompt({
        template: "video_h3_i2v",
        shot: SH1,
        scene,
        style: VERTICAL_STYLE,
        slots: { images: [{ url: "/a/first.png", kind: "first_frame" }] },
        durationSec: 5,
    });
    assert.match(h3, /vertical portrait/);
    assert.match(h3, /9:16 aspect ratio/);
});

test("aspectRatioConflict：抓住实测故障句，不误伤运镜与物体朝向", () => {
    // 实测故障原句（竖屏项目的改写稿首句写成 horizontal）
    assert.match(
        aspectRatioConflict("The image is a horizontal realistic cinematic medium close-up, held entirely in a static frame, of a man in his sixties.", VERTICAL_STYLE),
        /horizontal/,
    );
    // ① 显式相反比例：位置不限
    assert.match(aspectRatioConflict("A night bus terminus, shot in 16:9 for a cinematic feel.", VERTICAL_STYLE), /16:9/);
    assert.match(aspectRatioConflict("aspect ratio: 16 x 9", VERTICAL_STYLE), /16 x 9/);
    // ② 方向词与构图名词紧邻
    assert.match(aspectRatioConflict("The bus arrives at night. Keep the whole scene in a landscape frame.", VERTICAL_STYLE), /landscape frame/);
    assert.match(aspectRatioConflict("The frame is horizontal.", VERTICAL_STYLE), /frame is horizontal/);
    // ③ 首句「整幅画面主语 + 系动词 + 方向词」
    assert.match(aspectRatioConflict("The video is shot in widescreen with the subject centered.", VERTICAL_STYLE), /video is shot in widescreen/);
    // 横屏项目反向同理；方形项目两个方向都算冲突
    const WIDE = { ...STYLE, ratio: "16:9" };
    assert.match(aspectRatioConflict("The image is a vertical portrait composition of a bus at night.", WIDE), /portrait composition/);
    assert.match(aspectRatioConflict("The video is shot in 9:16 with the subject centered.", WIDE), /9:16/);
    assert.equal(aspectRatioConflict("The image is a horizontal landscape composition, 16:9 aspect ratio.", WIDE), null);
    assert.match(aspectRatioConflict("The image is a horizontal landscape frame of a bus.", { ...STYLE, ratio: "1:1" }), /landscape frame/);

    // 不得误伤：运镜、物体朝向、人像、正确画幅
    assert.equal(aspectRatioConflict("The camera makes a slow horizontal pan across the terminus sign.", VERTICAL_STYLE), null, "运镜不是画幅断言");
    assert.equal(aspectRatioConflict("Horizontal movement of the bus across the frame.", VERTICAL_STYLE), null);
    assert.equal(aspectRatioConflict("A narrow horizontal band of deep navy sky runs across the very top edge of the frame.", VERTICAL_STYLE), null, "物体朝向不是画幅断言");
    assert.equal(aspectRatioConflict("The shot is a portrait of a man in his sixties, framed tightly.", WIDE), null, "portrait 作「人像」解时不误判");
    assert.equal(aspectRatioConflict("The image is a vertical portrait cinematic medium close-up, 9:16 aspect ratio.", VERTICAL_STYLE), null);
    // 没有画幅事实 → 不判定（不猜测）
    assert.equal(aspectRatioConflict("The image is a horizontal landscape composition.", STYLE), null);
    assert.equal(aspectRatioConflict("", VERTICAL_STYLE), null);
});

test("改写稿把竖屏写成横屏 → 整稿弃用、回落同步稿并记 warning（错误方向不交给模型）", async () => {
    const warnings = [];
    const out = await compilePromptForTemplateAsync({
        template: "img_qwen21_t2i",
        family: "image",
        shot: SH1,
        scene,
        characters: [{ name: "老周" }],
        style: VERTICAL_STYLE,
        slots: { images: [] },
        llmCall: async () => "The image is a horizontal realistic cinematic medium close-up of a bus at night.",
        onWarning: (error) => warnings.push(error.message),
    });
    assert.equal(warnings.length, 1, "冲突必须留排查 warning");
    assert.match(warnings[0], /画幅/);
    assert.doesNotMatch(out, /horizontal/i, "错误方向绝不能进 PROMPT");
    assert.match(out, /画幅：9:16（竖屏构图/, "回落到同步结构稿，画幅事实仍在");
});

test("改写稿画幅正确 → 照旧采用英文稿，不记 warning", async () => {
    const warnings = [];
    const out = await compilePromptForTemplateAsync({
        template: "img_qwen21_t2i",
        family: "image",
        shot: SH1,
        scene,
        characters: [{ name: "老周" }],
        style: VERTICAL_STYLE,
        slots: { images: [] },
        llmCall: async () => "The image is a vertical portrait cinematic medium close-up of a bus at night, 9:16 aspect ratio.",
        onWarning: (error) => warnings.push(error.message),
    });
    assert.deepEqual(warnings, []);
    assert.match(out, /vertical portrait/);
});

test("分级：改写器拿不到一级（画幅/比例/画面内文字都不进 llmCall 输入）", async () => {
    const calls = [];
    const out = await compilePromptForTemplateAsync({
        template: "img_qwen21_t2i",
        family: "image",
        shot: SH1,
        scene,
        characters: [],
        style: VERTICAL_STYLE,
        slots: { images: [] },
        overlays: SH1.textOverlays,
        llmCall: async ({ system, user }) => {
            calls.push({ system, user });
            return "A vertical portrait night scene.";
        },
    });
    assert.equal(calls.length, 1);
    // system 是官方改写器资产；一级约束只可能出现在我们喂进去的输入载荷 user 里 —— 断言它不在。
    const seen = calls[0].user;
    assert.ok(!/画幅/.test(seen), "画幅约束不得进改写器输入");
    assert.ok(!/9\s*:\s*16/.test(seen), "比例不得进改写器输入");
    assert.ok(!seen.includes("固定生产事实"), "一级约束行不得进改写器输入");
    assert.ok(!seen.includes("末班车"), "画面内文字（一级）不得进改写器输入");
    // 产物里一级块照旧在（编译器直拼），且顺序在一级在改写稿之前。
    assert.match(out, /画幅：9:16（竖屏构图/, "产物必须含一级画幅事实");
    assert.ok(out.includes(SH1.textOverlays[0].text), "画面内文字逐字进产物");
    assert.ok(out.indexOf("画幅：9:16（竖屏构图") < out.indexOf("A vertical portrait night scene."), "一级块在二级块之前");
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
    assert.ok(krea.includes(ANCHOR), "Krea2 中文降级把字符串 style 当锚点（一级块含锚点原文）");
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

test("Qwen 2.1：同步降级只保留结构化事实，去掉重复风格、英文尾巴和英文混排", () => {
    const shot = {
        ...SH5,
        shotSize: "中近景",
        action: "老周把车票放进女孩手心，同时说话，女孩摊开手接住",
        cameraSpec: { movement: { type: "static", direction: "none", speed: "slow" } },
        textOverlays: [{ text: "末班车", kind: "ticket", position: "女孩手心中的旧车票票面", style: "黄底黑字" }],
    };
    const out = compileQwen21ImagePrompt({
        template: "img_qwen21_edit",
        shot,
        scene: { name: "终点站站牌下" },
        characters: [{ name: "老周" }, { name: "女孩" }],
        style: STYLE,
        slots: { images: [] },
        basePrompt: "the man placing an old paper ticket into the woman's open palm",
        legacyBody: "the man placing an old paper ticket into the woman's open palm",
        overlays: shot.textOverlays,
    });
    assert.equal(out.split(STYLE.anchor).length - 1, 1, "风格锚点只能出现一次");
    assert.ok(!out.includes(STYLE.filmLayer), "同步降级不得拼入旧版英文画质尾巴");
    assert.ok(!out.includes("the man placing"), "旧版英文 prompt 快照不能与结构化 action 重复");
    assert.ok(!out.includes("on-screen text rendered verbatim"), "同步降级不得混入英文文字层句式");
    assert.match(out, /固定机位/);
    assert.match(out, /票据文字/);
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

test("Qwen 2.1：同步降级的图上文字保持中文事实并逐字保留原文", () => {
    const out = compileQwen21ImagePrompt({ template: "img_qwen21_t2i", shot: SH1, scene, characters: [], style: {}, slots: { images: [] }, overlays: SH1.textOverlays, legacyBody: "x" });
    assert.match(out, /画面中必须清晰呈现以下文字/);
    assert.ok(out.includes("「末班车」"));
    assert.ok(!out.includes("on-screen text rendered verbatim"));
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


/* ————————————————————— H3 画面内文字：空 textOverlays 的强禁令 ————————————————————— */
/*
 * 产品口径：短剧默认独立配音（视频归 H3、台词归 TTS），画面里绝不能自带字幕 —— 字幕要由我们
 * 后期按音轨逐句烧。已抽帧核实：即使 textOverlays 全空，H3 也会把 <d> 台词块烧成画面内文字。
 * 故 textOverlays 为空时编译器必须显式下「画面内无任何文字/字幕」的禁令；非空时逐字口径一字不改。
 */

const H3_NO_TEXT_MARK = "Absolutely no on-screen text of any kind is present";

test("H3：textOverlays 为空 → 提示词含「画面内无文字/字幕」强禁令，且 <d> 台词块仍在", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_talk", shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: [], durationSec: 4 });
    assert.ok(out.includes(H3_NO_TEXT_MARK), "空 textOverlays 必须下画面内无文字禁令");
    assert.match(out, /must never be displayed as text, subtitles, or captions/, "禁令必须点名台词不得显示为文字");
    // ⚠️ 铁律：禁令只加文字约束，<d> 台词块照旧保留（H3 靠它合成台词与口型）。
    assert.match(out, /<d>\[English\] 姑娘，这么晚，去哪儿？<\/d>/, "<d> 台词块必须保留");
    // 禁令不破坏一级/字段结构：首行仍是对齐指令行，三字段顺序不变。
    assert.ok(out.startsWith(I2VA_LINE), out.slice(0, 80));
    assert.match(out, /non_diegetic_music: N\/A/);
});

test("H3：textOverlays 为空（kind 全 none 数组）同样下禁令", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH2, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: SH2.textOverlays, durationSec: 4 });
    assert.ok(out.includes(H3_NO_TEXT_MARK), "kind 全 none 等价于空 → 必须下禁令");
});

test("H3：textOverlays 非空 → 逐字保留原句，且不得混入无文字禁令（逐字未改）", () => {
    const out = compileH3VideoPrompt({ template: "video_h3_i2v", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, overlays: SH1.textOverlays, durationSec: 5 });
    assert.match(out, /reading "末班车"/, "画面内文字逐字进产物（原文不改）");
    assert.ok(!out.includes(H3_NO_TEXT_MARK), "有文字事实时不得出现无文字禁令（否则自相矛盾）");
});

test("H3 无文字禁令只作用于 H3：通用兜底 / 其他模型 textOverlays 为空仍逐字不变", () => {
    // 通用兜底：空 overlays → legacyBody 原样返回，绝不追加 H3 禁令。
    assert.equal(compileGenericPrompt({ style: {}, legacyBody: "bus at night", overlays: [] }), "bus at night");
    assert.ok(!compileGenericPrompt({ style: {}, legacyBody: "bus at night", overlays: [] }).includes(H3_NO_TEXT_MARK));
    // H3 之外的视频/图片模板：产物不含 H3 禁令。
    const generic = compilePromptForTemplate({ template: "img_zimage_artistic", family: "image", shot: SH1, scene, characters: [], style: {}, slots: { images: [] }, overlays: [], basePrompt: SH1.prompt, legacyBody: SH1.prompt });
    assert.ok(!generic.includes(H3_NO_TEXT_MARK), "非 H3 模板不得出现 H3 禁令");
});


/* ————————————————————— 图像提示词：台词绝不进图像（否则被渲染成画面内字幕） ————————————————————— */
/*
 * 真跑溯源：img_qwen21_edit 的关键帧 PROMPT 原文里出现「Along the bottom edge of the frame, three lines
 * of small white Chinese subtitles ... read "姑娘，这么晚，去哪儿？" ...」—— 图像改写器把内容事实里的
 * `台词：…` 逐字渲染成了画面内字幕，关键帧自带字幕，H3（I2VA）再原样烧进视频。
 * 图像只负责画面；台词归 TTS，字幕后期按音轨逐句烧。故图像改写载荷必须**不含台词正文**。
 */
test("图像（分级改写）：改写器载荷不得含台词正文（否则被渲染成画面内字幕）", async () => {
    const calls = [];
    const shot = { ...SH5, dialogue: "姑娘，这么晚，去哪儿？（低声、语速慢）" };
    await compilePromptForTemplateAsync({
        template: "img_qwen21_edit",
        family: "image",
        shot,
        scene,
        characters: [{ name: "老周" }],
        style: VERTICAL_STYLE,
        slots: { images: [{ url: "/a/f.png", kind: "input_image" }] },
        overlays: shot.textOverlays,
        llmCall: async ({ system, user }) => {
            calls.push({ system, user });
            return "A cinematic vertical night scene of a bus driver.";
        },
    });
    assert.equal(calls.length >= 1, true, "必须调用改写器");
    for (const call of calls) {
        assert.ok(!call.user.includes("姑娘，这么晚"), `改写器载荷不得含台词正文：${call.user}`);
        assert.ok(!call.system.includes("姑娘，这么晚"), "改写器 system 不得含台词正文");
    }
    // 画面事实照旧在（只是不再带台词）。
    assert.match(calls[0].user, /画面内容：/, "画面内容仍在改写载荷里");
});

test("图像（通用改写）：无分级编译器的模板同样不把台词喂进改写器", async () => {
    const seen = [];
    const shot = { ...SH5, dialogue: "姑娘，这么晚，去哪儿？" };
    await compilePromptForTemplateAsync({
        template: "scail2_action_transfer",
        family: "image",
        shot,
        scene,
        characters: [{ name: "老周" }],
        style: {},
        slots: { images: [] },
        overlays: shot.textOverlays,
        llmCall: async ({ system, user }) => {
            seen.push({ system, user });
            return "A cinematic night scene.";
        },
    });
    assert.ok(seen.length >= 1, "必须真的走到改写器（否则本用例空转）");
    for (const call of seen) assert.ok(!call.user.includes("姑娘，这么晚"), `通用改写载荷不得含台词：${call.user}`);
});

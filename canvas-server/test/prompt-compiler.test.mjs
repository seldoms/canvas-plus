import assert from "node:assert/strict";
import { test } from "node:test";

import {
    COMPILER_RULES,
    compileH3VideoPrompt,
    compilePromptForTemplate,
    compileQwen21ImagePrompt,
    compileGenericPrompt,
    compilerFor,
} from "../src/prompt-compiler.js";

/**
 * 提示词编译器纯函数测试：按所选模型把「模型无关的内容事实」编译成该模型要的提示词。
 * 覆盖 H3 三段式 / 素材说明按实际槽位生成 / 台词时长对齐 / 文字逐字 / 不想要 / 首尾帧不切镜；
 * Qwen-Image 2.1 中文 + <imageN> 引用 + RGBA 透明；通用兜底；分派表。
 * 用真实 run-murvf1vq-aqyqm 的 sh1/sh2/sh5 事实形状做 fixture（不含任何模型专属提示词）。
 */

/** 真实 sh1（固定机位全景，有画面文字「末班车」，无台词）。 */
const SH1 = {
    id: "sh1",
    sceneId: "sc1",
    durationSec: 5,
    shotSize: "全景",
    action: "公交车从画面右侧驶入，减速，停靠在站台，前门打开。车门打开时发出气动声。段末可见状态：公交车停稳，前门打开，车厢内灯光透出。",
    dialogue: "",
    audio: "环境音：深夜街道远处车流声、公交车发动机怠速声、车门气动声；本镜无对白。",
    textOverlays: [{ text: "末班车", kind: "screen", position: "公交车前挡风玻璃上方的电子显示屏", style: "红底黄字，LED点阵字体，略微闪烁" }],
    cameraSpec: { position: "subject-front", lens: "35mm", aperture: "f4", movement: { type: "static", direction: "none", speed: "slow", stabilization: "steady" } },
    prompt: "A late-night city street, a bus with its front door opening at a bus stop, wide shot, realistic.",
    negativePrompt: "extra fingers, deformed face, lowres",
};

/** 真实 sh2（pan 摇镜，有首尾帧 + 女孩参考）。 */
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

/** 真实 sh5（固定机位近景，老周有台词）。 */
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

// ——— H3 三段式结构 ———

test("H3：输出官方三段式（参考素材说明 + 核心创意 + 画面过程说明）", () => {
    const out = compileH3VideoPrompt({
        shot: SH1,
        scene,
        characters: [],
        style: STYLE,
        slots: { images: [{ url: "/a/first.png", kind: "first_frame" }] },
        overlays: SH1.textOverlays,
        durationSec: 5,
    });
    assert.match(out, /【参考素材说明】/);
    assert.match(out, /【核心创意】/);
    assert.match(out, /【画面过程说明】/);
    assert.ok(out.indexOf("【参考素材说明】") < out.indexOf("【核心创意】"), "素材说明在最前");
    assert.ok(out.indexOf("【核心创意】") < out.indexOf("【画面过程说明】"), "核心创意在过程说明前");
});

test("H3：无素材时【参考素材说明】整段跳过（官方规则）", () => {
    const out = compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5 });
    assert.ok(!out.includes("【参考素材说明】"), "无素材不出现空段头");
    assert.match(out, /【核心创意】/);
    assert.match(out, /【画面过程说明】/);
});

test("H3：核心创意含主体/地点/事件/风格/运镜五要素", () => {
    const out = compileH3VideoPrompt({ shot: SH2, scene, characters: [{ id: "c2", name: "女孩" }], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    assert.match(out, /女孩/);
    assert.match(out, /在公交车前门外的站台（夜）/);
    assert.match(out, /女孩从站台阴影中走出/);
    assert.match(out, /题材风格：写实电影感/);
    assert.match(out, /运镜：pan right（缓速）/);
});

test("H3：运镜由 cameraSpec 编译成具体词（static → 固定机位）", () => {
    const out = compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5 });
    assert.match(out, /固定机位（static，无推拉摇移）/);
    assert.ok(!out.includes("pan "), "固定机位不出现 pan");
});

// ——— 素材说明按「本次实际注入的槽位」生成 ———

test("H3 素材说明：只有首帧 → 只有 @图片1，且无「上传顺序」行", () => {
    const out = compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [{ url: "/a/first.png", kind: "first_frame" }] }, overlays: [], durationSec: 5 });
    assert.match(out, /@图片1 是首帧参考图：/);
    assert.ok(!out.includes("@图片2"), "只有一个槽就只出现 @图片1");
    assert.ok(!out.includes("图片上传顺序"), "单图不写上传顺序");
});

test("H3 素材说明：首帧 + 尾帧 + 2 张角色参考 → 上传顺序 + 逐张用途（编号按注入顺序）", () => {
    const out = compileH3VideoPrompt({
        shot: SH2,
        scene,
        characters: [{ name: "女孩" }],
        style: STYLE,
        slots: {
            images: [
                { url: "/a/first.png", kind: "first_frame" },
                { url: "/a/last.png", kind: "last_frame" },
                { url: "/a/girl.png", kind: "reference", role: "character", name: "女孩" },
                { url: "/a/old.png", kind: "reference", role: "character", name: "老周" },
            ],
        },
        overlays: [],
        durationSec: 4,
    });
    assert.match(out, /图片上传顺序：@图片1 → @图片2 → @图片3 → @图片4/);
    assert.match(out, /@图片1 是首帧参考图：/);
    assert.match(out, /@图片2 是尾帧参考图：/);
    assert.match(out, /@图片3 是角色参考（女孩）：锁定面容、发型、服装与体型。/);
    assert.match(out, /@图片4 是角色参考（老周）：锁定面容、发型、服装与体型。/);
    assert.match(out, /忽略参考图中的背景、水印、界面文字与压缩伪影。/);
});

test("H3 素材说明：编号严格跟着注入顺序走（不写死在内容层）", () => {
    const make = (images) => compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images }, overlays: [], durationSec: 5 });
    // 同样两张图，注入顺序不同 → 用途跟着编号走
    const a = make([
        { url: "/a/x.png", kind: "first_frame" },
        { url: "/a/y.png", kind: "reference", role: "scene", name: "站台" },
    ]);
    const b = make([
        { url: "/a/y.png", kind: "reference", role: "scene", name: "站台" },
        { url: "/a/x.png", kind: "first_frame" },
    ]);
    assert.match(a, /@图片1 是首帧参考图/);
    assert.match(a, /@图片2 是场景参考/);
    assert.match(b, /@图片1 是场景参考/);
    assert.match(b, /@图片2 是首帧参考图/);
});

test("H3：首帧+尾帧同时注入 → 明确「两帧之间只补过渡、不切镜」", () => {
    const out = compileH3VideoPrompt({
        shot: SH2,
        scene,
        characters: [],
        style: STYLE,
        slots: { images: [{ url: "/a/f.png", kind: "first_frame" }, { url: "/a/l.png", kind: "last_frame" }] },
        overlays: [],
        durationSec: 4,
    });
    assert.match(out, /首尾两帧之间只补动作、光影与声音，不发生切镜/);
});

// ——— 台词/时长对齐 ———

test("H3：有台词 → 写入「务必在本镜 N 秒内说完、口型对齐」并逐字保留台词", () => {
    const out = compileH3VideoPrompt({ shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    assert.match(out, /台词（务必在本镜 4 秒内说完，语速与口型严格对齐）/);
    assert.ok(out.includes("姑娘，这么晚，去哪儿？（低声、音量低、语速慢、略带关心）"), "台词逐字保留");
    assert.ok(!out.includes("台词偏长"), "9 字台词 / 4 秒 ≈ 2.25s < 4s，不应误报偏长");
});

test("H3：台词明显超长 → 追加压缩语速/删字提示", () => {
    const long = { ...SH5, dialogue: "姑娘这么晚了你一个人要去哪里呀这都已经末班车了我看你脸色不太好要不要坐前面一点儿暖和暖和别冻着了" };
    const out = compileH3VideoPrompt({ shot: long, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    assert.match(out, /台词偏长，请压缩语速或删字以保证口型对齐/);
});

test("H3：台词括号里的表演提示不计入语速估算（只看真正要说的话）", () => {
    const out = compileH3VideoPrompt({ shot: SH5, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 4 });
    const line = out.split("\n").find((entry) => entry.startsWith("台词"));
    assert.ok(line.includes("低声、音量低、语速慢、略带关心"), "表演提示原样保留在台词里");
    assert.ok(!/偏长/.test(line), "表演提示不计字数");
});

// ——— 文字逐字 / 不想要 / 段末状态 / 时间轴 / 音效 ———

test("H3：画面文字必须写原文（中文引号逐字）", () => {
    const out = compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: SH1.textOverlays, durationSec: 5 });
    assert.match(out, /屏幕文字「末班车」/);
    assert.match(out, /位置：公交车前挡风玻璃上方的电子显示屏/);
});

test("H3：不想要把负向词并入正向句，并补上通用排除项", () => {
    const out = compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5 });
    assert.match(out, /不想要（避免出现）：/);
    assert.ok(out.includes("extra fingers"), "负向词原文并入");
    assert.match(out, /画面文字乱码、多余人物、字幕、水印、切镜/);
});

test("H3：段末可见状态与时间轴分段都在（边界落在可见变化处）", () => {
    const out = compileH3VideoPrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5 });
    assert.match(out, /0-[0-9.]+秒：全景，公交车从画面右侧驶入/);
    assert.match(out, /段末可见状态（约 5 秒）：公交车停稳，前门打开，车厢内灯光透出。/);
    assert.match(out, /非叙事性音乐：N\/A（只保留现场原声，不要 BGM）/);
    assert.ok(out.includes("音效：环境音：深夜街道远处车流声"), "音效逐字保留");
});

// ——— Qwen-Image 2.1 ———

test("Qwen 2.1：中文主体/景别/场景/运镜编译进 PROMPT", () => {
    const out = compileQwen21ImagePrompt({ shot: SH5, scene, characters: [{ name: "老周", outfit: "深蓝色公交制服" }], style: STYLE, slots: { images: [] }, overlays: [], basePrompt: SH5.prompt, legacyBody: SH5.prompt });
    assert.match(out, /主体：老周（深蓝色公交制服）/);
    assert.match(out, /景别：近景/);
    assert.match(out, /场景：公交车前门外的站台（夜）/);
    assert.match(out, /机位与运镜：固定机位（static，无推拉摇移）/);
});

test("Qwen 2.1：参考图以 <image1>/<image2> 引用，对应 INPUT_IMAGE / REF_IMAGE_N 的注入顺序", () => {
    const out = compileQwen21ImagePrompt({
        shot: SH1,
        scene,
        characters: [{ name: "老周" }],
        style: STYLE,
        slots: {
            images: [
                { url: "/a/input.png", kind: "input_image", role: "character", name: "老周" },
                { url: "/a/ref1.png", kind: "reference", role: "scene", name: "公交车内" },
            ],
        },
        overlays: [],
        basePrompt: SH1.prompt,
        legacyBody: SH1.prompt,
    });
    assert.match(out, /参考图对应关系：/);
    assert.match(out, /<image1> 为参考底图（老周）/);
    assert.match(out, /<image2> 为场景参考/);
});

test("Qwen 2.1：需要透明背景 → 使用官方 RGBA 句式", () => {
    const out = compileQwen21ImagePrompt({ shot: SH5, scene, characters: [], style: STYLE, slots: { images: [], transparent: true }, overlays: [], basePrompt: "x", legacyBody: "x" });
    assert.match(out, /^This is an RGBA format image with transparency\./);
});

test("Qwen 2.1：图上文字逐字（双引号原文）", () => {
    const out = compileQwen21ImagePrompt({ shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: SH1.textOverlays, basePrompt: "x", legacyBody: "x" });
    assert.match(out, /on-screen text rendered verbatim/);
    assert.ok(out.includes('"末班车"'), "文字逐字保留");
});

test("Qwen 2.1：风格锚点前置、胶片层按锚点追加", () => {
    const out = compileQwen21ImagePrompt({ shot: SH5, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], basePrompt: "a driver", legacyBody: "a driver" });
    assert.ok(out.startsWith("写实电影感，暖色路灯与冷调夜色的对比，浅景深，细腻胶片颗粒。"), "风格锚点在最前");
    assert.match(out, /overexposure melting contours/);
});

// ——— 通用兜底 ———

test("通用兜底：无 style.context 时原样返回 legacyBody（不退化）", () => {
    const out = compileGenericPrompt({ style: {}, legacyBody: "a bus arrives" });
    assert.equal(out, "a bus arrives");
});

test("通用兜底：style 锚点已在首句则不重复前置", () => {
    const body = `${STYLE.anchor}，一辆末班车。`;
    const out = compileGenericPrompt({ style: STYLE, legacyBody: body });
    assert.equal(out, `${body} ${STYLE.filmLayer}`);
    assert.equal(out.split(STYLE.anchor).length - 1, 1, "锚点只出现一次");
});

test("通用兜底：legacyBody 已含文字层则不重复追加；未含则逐字补上", () => {
    const overlays = [{ text: "末班车", kind: "screen", position: "top", style: "led" }];
    const already = compileGenericPrompt({ style: {}, legacyBody: 'bus. on-screen text rendered verbatim: screen text "末班车" at top in led', overlays });
    assert.equal(already.split("on-screen text rendered verbatim").length - 1, 1, "不重复");
    const appended = compileGenericPrompt({ style: {}, legacyBody: "bus arrives", overlays });
    assert.match(appended, /on-screen text rendered verbatim/);
    assert.ok(appended.includes('"末班车"'));
});

// ——— 分派表 ———

test("compilerFor：H3 视频系 → h3-video（含 minimax_h3 变体）", () => {
    assert.equal(compilerFor("video_h3_i2v", "video").id, "h3-video");
    assert.equal(compilerFor("video_minimax_h3_t2v", "video").id, "h3-video");
    assert.equal(compilerFor("video_h3_ref2v_image", "video").id, "h3-video");
    assert.equal(compilerFor("video_h3_talk", "video").id, "h3-video");
});

test("compilerFor：Qwen-Image 2.1 系 → qwen-image-2.1（t2i / edit）", () => {
    assert.equal(compilerFor("img_qwen21_t2i", "image").id, "qwen-image-2.1");
    assert.equal(compilerFor("img_qwen21_edit", "image").id, "qwen-image-2.1");
});

test("compilerFor：家族不符不误命中（H3 只在 video 家族）", () => {
    assert.equal(compilerFor("video_h3_i2v", "image").id, "generic", "family=image 不给 H3 编译器");
    assert.equal(compilerFor("img_flux_artistic", "image").id, "generic");
    assert.equal(compilerFor("upscale_4x", "image").id, "generic");
});

test("compilePromptForTemplate：按模板分派，产物始终是字符串", () => {
    const h3 = compilePromptForTemplate({ template: "video_h3_i2v", family: "video", shot: SH1, scene, characters: [], style: STYLE, slots: { images: [] }, overlays: [], durationSec: 5, legacyBody: "x" });
    assert.match(h3, /【核心创意】/);
    const qwen = compilePromptForTemplate({ template: "img_qwen21_t2i", family: "image", shot: SH5, scene, characters: [{ name: "老周" }], style: STYLE, slots: { images: [] }, overlays: [], legacyBody: "a driver" });
    assert.match(qwen, /主体：老周/);
    const generic = compilePromptForTemplate({ template: "img_flux_artistic", family: "image", shot: SH5, style: {}, legacyBody: "an artistic prompt" });
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

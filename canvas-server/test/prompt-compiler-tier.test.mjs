import assert from "node:assert/strict";
import { test } from "node:test";

import {
    aspectRatioConflict,
    compileGenericPrompt,
    compilePromptForTemplate,
    compilePromptForTemplateAsync,
} from "../src/prompt-compiler.js";
import { promptTierPolicy, ruleKeyForTemplate } from "../src/model-rules.js";

/**
 * 分级编译回归（一级强约束 / 二级画面细节 / 二级服从一级）。
 *
 * 覆盖 4 类断言：
 *   ① 一级块一定在产物里（风格 / 画幅 / 比例）；
 *   ② 改写器拿不到一级（回显假 llmCall：一级不在它收到/返回的内容里）；
 *   ③ 二级出现相反画幅 → 一级保留、二级被纠正 → 产物无相反画幅断言（真实故障句）；
 *   ④ 合法句式不误伤（horizontal pan / a horizontal band of sky / a portrait of a man）。
 * 另加兼容红线：无官方改写器模型产物与既有逐字一致（generic 兜底 / H3 结构不动）。
 */

const STYLE = {
    anchor: "写实电影感，暖色路灯与冷调夜色的对比，浅景深，细腻胶片颗粒",
    context: "写实电影感，暖色路灯与冷调夜色的对比，浅景深，细腻胶片颗粒",
    filmLayer: "overexposure melting contours, grey-blue shadows, fine grain",
};
const VERTICAL_STYLE = { ...STYLE, ratio: "9:16" };

const SHOT = {
    id: "sh1",
    durationSec: 5,
    shotSize: "全景",
    action: "公交车从画面右侧驶入，减速，停靠在站台，前门打开。",
    dialogue: "",
    textOverlays: [{ text: "末班车", kind: "screen", position: "前挡风玻璃上方", style: "红底黄字" }],
    cameraSpec: { movement: { type: "static", direction: "none", speed: "slow" } },
};
const SCENE = { id: "sc1", name: "公交车前门外的站台（夜）" };

/** 真实故障原句（竖屏项目被改写写成 horizontal）。 */
const FAULT = "The image is a horizontal realistic cinematic medium close-up, held entirely in a static frame, of a man in his sixties.";

function asyncInput(extra = {}) {
    return {
        template: "img_qwen21_t2i",
        family: "image",
        shot: SHOT,
        scene: SCENE,
        characters: [],
        style: VERTICAL_STYLE,
        slots: { images: [] },
        ...extra,
    };
}

/* ————————————————————— ① 一级块一定在产物里 ————————————————————— */

test("① 一级块一定在产物里：同步产物含风格锚点 + 画幅·比例", () => {
    const out = compilePromptForTemplate(asyncInput());
    assert.ok(out.includes(STYLE.anchor), "同步产物必须含风格锚点");
    assert.match(out, /画幅：9:16（竖屏构图/, "同步产物必须含画幅事实");
});

test("① 一级块一定在产物里：改写成功产物也含一级（改写稿自己没写画幅/风格）", async () => {
    const rewrite = "A cinematic medium close-up of a city bus pulling into a night stop.";
    const out = await compilePromptForTemplateAsync(asyncInput({ llmCall: async () => rewrite }));
    assert.ok(out.includes(rewrite), "改写稿作为二级块原样保留");
    assert.ok(out.includes(STYLE.anchor), "一级风格锚点由编译器直拼");
    assert.match(out, /画幅：9:16（竖屏构图/, "一级画幅事实由编译器直拼");
    assert.ok(out.indexOf(STYLE.anchor) < out.indexOf(rewrite), "一级块排在二级块之前");
});

/* ————————————————————— ② 改写器拿不到一级 ————————————————————— */

test("② 改写器拿不到一级：回显 llmCall 看不到画幅/比例/画面内文字", async () => {
    const seen = [];
    const echo = async ({ system, user }) => {
        seen.push({ system, user });
        return user; // 回显输入 —— 断言一级既不在「收到」也不在「返回」的内容里
    };
    const out = await compilePromptForTemplateAsync(asyncInput({ llmCall: echo, overlays: SHOT.textOverlays }));
    assert.equal(seen.length, 1);
    // system 是官方改写器资产（其正文自带 9:16 示例），不属于我们的一级约束；
    // 一级约束只可能出现在我们喂进去的输入载荷 user 里 —— 断言它不在。
    const got = seen[0].user;
    assert.ok(!/画幅/.test(got), "画幅约束不得进改写器输入");
    assert.ok(!/9\s*:\s*16/.test(got), "比例不得进改写器输入");
    assert.ok(!got.includes("固定生产事实"), "一级约束行不得进改写器输入");
    assert.ok(!got.includes("末班车"), "画面内文字不得进改写器输入/输出");
    assert.ok(!seen[0].system.includes("固定生产事实"), "官方 system 里也不得被塞入我们的一级约束行");
    // 产物里一级照旧在（编译器直拼），且画面内文字逐字。
    assert.match(out, /画幅：9:16（竖屏构图/);
    assert.ok(out.includes("末班车"), "画面内文字逐字进产物");
});

test("②′ 风格锚点无条件锁一级：无/有画幅事实两种情形，锚点都在产物、都不在改写器输入/输出", async () => {
    for (const [label, style] of [["无画幅事实", STYLE], ["有画幅事实", VERTICAL_STYLE]]) {
        const seen = [];
        const echo = async ({ system, user }) => {
            seen.push({ system, user });
            return user; // 回显输入 —— 锚点若被喂进去，必然出现在返回里
        };
        const out = await compilePromptForTemplateAsync(asyncInput({ style, llmCall: echo }));
        assert.equal(seen.length, 1, `${label}：应恰好调用改写器一次`);
        const got = seen[0].user;
        // ① 改写器「收到」的内容不含锚点（二级源不再有「风格：」行）。
        assert.ok(!got.includes(STYLE.anchor), `${label}：锚点不得进改写器输入`);
        assert.ok(!got.includes("风格："), `${label}：二级源不得带「风格：」行`);
        // 官方 system 里也不得被塞入我们的锚点。
        assert.ok(!seen[0].system.includes(STYLE.anchor), `${label}：官方 system 不得含锚点`);
        // ② 产物里锚点恒在（一级直拼），且排在二级回显稿之前。
        assert.ok(out.includes(STYLE.anchor), `${label}：产物必须含一级风格锚点`);
        assert.ok(out.includes(got), `${label}：二级回显稿作为二级块保留`);
        assert.ok(out.indexOf(STYLE.anchor) < out.indexOf(got), `${label}：一级锚点排在二级之前`);
        // ③ 同步产物同样恒含锚点。
        assert.ok(compilePromptForTemplate(asyncInput({ style })).includes(STYLE.anchor), `${label}：同步产物也含锚点`);
        // ④ 画幅事实仍按有无如实呈现。
        if (style.ratio) assert.match(out, /画幅：9:16（竖屏构图/, `${label}：画幅事实一级直拼`);
        else assert.ok(!/画幅/.test(out), `${label}：无画幅事实时产物不含画幅句`);
    }
});

/* ————————————————————— ③ 真实故障句：一级保留、二级被纠正 ————————————————————— */

test("③ 二级出现相反画幅 → 一级照旧、二级被纠正一次；产物无相反画幅", async () => {
    let calls = 0;
    const llmCall = async () => (calls++ === 0 ? FAULT : "A vertical portrait cinematic medium close-up of a city bus at night.");
    const warnings = [];
    const out = await compilePromptForTemplateAsync(asyncInput({ llmCall, onWarning: (e) => warnings.push(e.message) }));
    assert.equal(calls, 2, "应纠正重写一次");
    assert.deepEqual(warnings, [], "纠正成功不记 warning");
    assert.doesNotMatch(out, /horizontal/i, "相反画幅断言绝不能进产物");
    assert.match(out, /画幅：9:16（竖屏构图/, "一级画幅事实保留");
    assert.ok(out.includes("A vertical portrait cinematic medium close-up"), "采用纠正后的二级");
});

test("③ 纠正后仍冲突 → 只保留一级 + 同步稿二级并记 warning（不整稿弃用）", async () => {
    const warnings = [];
    const out = await compilePromptForTemplateAsync(asyncInput({ llmCall: async () => FAULT, onWarning: (e) => warnings.push(e.message) }));
    assert.equal(warnings.length, 1, "仍冲突必须记一条 warning");
    assert.match(warnings[0], /画幅/);
    assert.doesNotMatch(out, /horizontal/i, "相反画幅断言绝不能进产物");
    assert.match(out, /画幅：9:16（竖屏构图/, "一级保留");
    assert.match(out, /景别：全景/, "二级回落到同步结构稿");
    assert.ok(!out.includes("[untranslated"), "冲突回退不是「未英文化」，不带排查标记");
});

test("③ aspectRatioConflict 仍能抓住真实故障句（检测保留）", () => {
    assert.match(aspectRatioConflict(FAULT, VERTICAL_STYLE), /horizontal/);
});

/* ————————————————————— ④ 合法句式不误伤 ————————————————————— */

test("④ 合法句式不误伤：horizontal pan / a horizontal band of sky / a portrait of a man", async () => {
    const OK = [
        "The camera makes a slow horizontal pan across the terminus sign.",
        "A narrow horizontal band of deep navy sky runs across the very top edge of the frame.",
        "The shot is a portrait of a man in his sixties, framed tightly.",
    ];
    for (const rewrite of OK) {
        const warnings = [];
        const out = await compilePromptForTemplateAsync(asyncInput({ llmCall: async () => rewrite, onWarning: (e) => warnings.push(e.message) }));
        assert.deepEqual(warnings, [], `不得误伤：${rewrite}`);
        assert.ok(out.includes(rewrite), "合法二级照旧采用");
        assert.match(out, /画幅：9:16（竖屏构图/, "一级照旧在");
    }
});

/* ————————————————————— 兼容红线 ————————————————————— */

test("兼容红线：无官方改写器模型走通用兜底，产物逐字与 compileGenericPrompt 一致", async () => {
    for (const template of ["img_zimage_artistic", "img_boogu_outfit_edit", "scail2_action_transfer", "video_wan_animate", "upscale_4x"]) {
        const input = { template, family: "image", shot: SHOT, scene: SCENE, characters: [], style: {}, slots: { images: [] }, legacyBody: `a legacy body for ${template}` };
        const sync = compilePromptForTemplate(input);
        assert.equal(sync, compileGenericPrompt(input), `${template} 同步产物必须与通用兜底逐字一致`);
        const asyncOut = await compilePromptForTemplateAsync({ ...input, llmCall: async () => "IGNORED REWRITE" });
        assert.equal(asyncOut, sync, `${template} 异步出口必须与同步产物逐字一致（无官方改写器）`);
    }
});

test("兼容红线：H3 结构不动（同步/异步产物都从对齐指令行起、结构一致）", async () => {
    const input = { template: "video_h3_i2v", family: "video", shot: SHOT, scene: SCENE, characters: [], style: {}, slots: { images: [{ url: "/a/f.png", kind: "first_frame" }] }, durationSec: 5 };
    const sync = compilePromptForTemplate(input);
    assert.ok(sync.startsWith("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."));
    const asyncOut = await compilePromptForTemplateAsync({ ...input, llmCall: async () => "ignored" });
    assert.equal(asyncOut, sync, "H3 无官方改写器 → 异步出口结构照旧");
});

/* ————————————————————— 规则表口径 ————————————————————— */

test("规则表口径：prompt_tier_policy 与编译器分级范围一致", () => {
    const policy = promptTierPolicy();
    assert.ok(policy && typeof policy === "object", "规则表须登记分级口径");
    assert.deepEqual([...policy.rewritable_models].sort(), ["flux1_dev", "krea2_turbo", "qwen_image_2_1"]);
    assert.ok(policy.tier_one.includes("aspect_ratio"));
    assert.ok(policy.tier_one.includes("text_overlays"));
    assert.ok(policy.tier_one.includes("style_anchor"));
    assert.ok(policy.tier_two.includes("slot_mapping"));
    // 会消费 rewrite 的编译器所在模板 → 正好命中分级范围。
    for (const template of ["img_qwen21_t2i", "img_qwen21_edit", "img_krea2_artistic", "img_flux_artistic"]) {
        assert.ok(policy.rewritable_models.includes(ruleKeyForTemplate(template)), `${template} 应在分级范围`);
    }
    for (const template of ["video_h3_i2v", "img_zimage_artistic", "img_boogu_outfit_edit", "scail2_action_transfer", "video_wan_animate", "upscale_4x"]) {
        assert.ok(!policy.rewritable_models.includes(ruleKeyForTemplate(template)), `${template} 不应在分级范围`);
    }
});

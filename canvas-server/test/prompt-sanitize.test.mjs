import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizePrompt, hasNodeReference } from "../src/prompt-sanitize.js";

test("剥掉未解析的节点引用 token 与节点显示标签", () => {
    const raw = "@[node:txt-sc-hotel-signin]\n\n【文本1】\n电影感写实摄影，中国城市酒店婚礼签到台。";
    const out = sanitizePrompt(raw);
    assert.equal(hasNodeReference(out), false);
    assert.equal(out.includes("@[node:"), false);
    assert.equal(out.includes("【文本1】"), false);
    assert.equal(out.includes("电影感写实摄影，中国城市酒店婚礼签到台。"), true);
});

test("保留用户自己写的方括号标题（不能误伤）", () => {
    const raw = "【单张人物半身定妆照·只画一个人】\n人物：38岁中国男性。";
    assert.equal(sanitizePrompt(raw), raw);
});

test("多个 token / 标签混合时全部剥掉，且不留下多余空行", () => {
    const raw = "@[node:a]\n@[node:b]\n【图片2】\n【文本3】\n画面：空荡的街道。";
    const out = sanitizePrompt(raw);
    assert.equal(hasNodeReference(out), false);
    assert.equal(out, "画面：空荡的街道。");
});

test("空值安全：undefined / null / 非字符串不炸", () => {
    assert.equal(sanitizePrompt(undefined), "");
    assert.equal(sanitizePrompt(null), "");
    assert.equal(sanitizePrompt(123), "123");
});

test("正常提示词原样返回（幂等）", () => {
    const raw = "冷调压抑，中国乡镇小饭馆包间，圆桌上摆着十来个家常菜。";
    assert.equal(sanitizePrompt(raw), raw);
    assert.equal(sanitizePrompt(sanitizePrompt(raw)), raw);
});

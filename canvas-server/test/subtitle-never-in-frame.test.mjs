/**
 * 产品铁律：**字幕绝不进画面**。
 *
 * 成片要过剪映精剪 —— 烧死在画面里的字幕是像素、没法改。对白字幕一律由后期以**独立 .srt 文件**提供，
 * 任何画面（关键帧 / 片段 / 成片）都不得渲染字幕。
 *
 * 本测试**逐模板真编译最终提示词**，断言：
 *   ① 提示词里没有「字幕」相关内容（`subtitle` / `caption` / `字幕`）—— 唯一允许的例外是
 *      H3 侧那句**显式禁止**画面内文字的兜底禁令（它在说"不要有字幕"，不是"要字幕"）；
 *   ② **故意塞进来的 `kind: "subtitle"` 文字层，其文本绝不进画面**（纵深防御）；
 *   ③ **正向对照**：同一批文字层里的真实物体文字（`kind: "sign"`，如站牌）**必须照常进画面** ——
 *      没有这条对照，"没泄漏"就可能只是"根本没传进去"的空结论。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compilePromptForTemplate } from "../src/prompt-compiler.js";

const here = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(here, "..", "workflows");

const DIALOGUE_TEXT = "姑娘，这么晚，去哪儿？";
const OVERLAY_SUB = "这句是字幕不该进画面";
const OVERLAY_SIGN = "老城南路公交站";

const overlays = [
    { text: OVERLAY_SIGN, kind: "sign", position: "站牌", style: "" },
    { text: OVERLAY_SUB, kind: "subtitle", position: "画面底部", style: "白字黑边" },
];
const style = { ratio: "9:16", visualMode: "live_action" };
const scene = { location: "渡轮驾驶室", timeOfDay: "夜" };
const characters = [{ id: "c1", name: "阿海" }];
const cast = [{ key: "c1", name: "阿海", speakerId: "S1" }];
const shot = {
    id: "sh1",
    index: 1,
    durationSec: 5,
    shotSize: "中景",
    camera: "",
    action: "阿海转头看向小满",
    dialogue: `阿海：${DIALOGUE_TEXT}（低沉、语速慢）`,
    dialogueLines: [{ speaker: "阿海", text: DIALOGUE_TEXT, performance: "低沉、语速慢" }],
    textOverlays: overlays,
    prompt: "",
    negativePrompt: "",
};

/** H3 侧「不得出现任何画面内文字」的兜底禁令 —— 它在说"不要字幕"，是合法例外，检查前摘掉。 */
const PROHIBITION = /Absolutely no on-screen text[\s\S]*?in the picture\./g;

const templates = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

test("字幕绝不进画面：逐模板编译最终提示词，不得含任何字幕相关内容（含正向对照）", () => {
    assert.ok(templates.length >= 15, `模板清单应覆盖全部生产模板，实际 ${templates.length}`);

    const compiled = [];
    for (const template of templates) {
        let text = "";
        try {
            text = compilePromptForTemplate({
                template,
                shot,
                scene,
                characters,
                cast,
                style,
                overlays,
                slots: { images: [{ url: "/api/artifacts/x/f.png", kind: "first_frame" }] },
                durationSec: 5,
            });
        } catch {
            continue; // 该模板不吃这类输入，跳过
        }
        if (typeof text !== "string" || !text.trim()) continue;
        compiled.push({ template, text });
    }
    assert.ok(compiled.length >= 15, `应至少真编译到 15 个模板，实际 ${compiled.length}`);

    for (const { template, text } of compiled) {
        const stripped = text.replace(PROHIBITION, "");
        assert.ok(
            !/subtitle|caption|字幕/i.test(stripped),
            `${template}：最终提示词里出现了字幕相关内容 —— 字幕绝不进画面（成片要过剪映精剪）`,
        );
        assert.ok(
            !text.includes(OVERLAY_SUB),
            `${template}：kind:"subtitle" 的文字层文本泄漏进了画面提示词（应被 plain 丢弃）`,
        );
        // 正向对照：真实物体文字必须照常进画面，否则"没泄漏"只是"没传进去"的空结论
        assert.ok(
            text.includes(OVERLAY_SIGN),
            `${template}：正向对照失败 —— 画面内物体文字（sign）本该进画面却不见了，本条断言与上面的"无字幕"结论同时失效`,
        );
    }
});

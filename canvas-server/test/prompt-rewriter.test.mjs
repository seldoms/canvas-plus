/**
 * 官方提示词改写器（策略层资产）行为锁定。
 *
 * 覆盖：
 *   1. 5 个改写器系统提示词文件都能加载且变体非空；
 *   2. Boogu 反向断言：系统提示词块**不含任何安全改写/回避/过滤指令**（合规红线），且剔除处已就地标注；
 *   3. Wan 六套（中英 × LM/VL/双图VL）变体选择正确；
 *   4. llmCall 被以正确的 system 传入（假函数捕获入参并断言），模块内不发请求；
 *   5. 超长 → 返回 truncated 标记（不静默截断）；
 *   6. rewriterForTemplate 映射正确；
 *   7. 文件缺失容错；llmCall 必须注入；pe 的 impl 判定。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
    H3_MAX_PROMPT_CHARS,
    PROMPTS_DIR,
    REWRITER_IDS,
    REWRITERS,
    buildPlan,
    countWords,
    detectLang,
    listRewriters,
    loadRewriterFile,
    rewriterDescriptorForTemplate,
    rewriterForTemplate,
    rewritePrompt,
    systemPromptFor,
} from "../src/prompt-rewriter.js";

const MODULE_PATH = fileURLToPath(new URL("../src/prompt-rewriter.js", import.meta.url));
const fakeLlm = (reply) => {
    const calls = [];
    const fn = async (arg) => {
        calls.push(arg);
        return typeof reply === "function" ? reply(arg) : reply;
    };
    fn.calls = calls;
    return fn;
};

// ————————————————————— 1. 五个资产可加载 —————————————————————

test("改写器资产：5 个文件全部可加载，登记变体均非空", () => {
    assert.deepEqual([...REWRITER_IDS].sort(), [
        "boogu-rewriter",
        "qwen-image-2.1-pe",
        "qwen-image-rewrite",
        "scail2-enhancer",
        "wan-prompt-extend",
    ]);
    for (const id of REWRITER_IDS) {
        const file = loadRewriterFile(id);
        assert.ok(file, `${id} 资产应可加载`);
        assert.ok(file.path.startsWith(PROMPTS_DIR), `${id} 路径应在 prompts/rewriters/ 下`);
        assert.ok(Object.keys(file.meta).length > 0, `${id} 应有 rewriter-meta 头`);
        for (const variant of REWRITERS[id].variants) {
            const text = file.prompts[variant];
            assert.ok(typeof text === "string" && text.trim().length > 50, `${id}.${variant} 系统提示词应非空`);
        }
    }
});

test("改写器资产：meta 头照调研登记 source/backend/rule/reuse", () => {
    const wan = loadRewriterFile("wan-prompt-extend").meta;
    assert.equal(wan.source, "Wan2.1 repo wan/utils/prompt_extend.py");
    assert.equal(wan.backend, "qwen-plus / qwen-vl-max / 本地 Qwen2.5(VL)");
    assert.match(wan.rule, /80~100 字/);
    assert.match(wan.reuse, /SCAIL-2\/WanAnimate/);

    const boogu = loadRewriterFile("boogu-rewriter").meta;
    assert.match(boogu.warning, /第 14 条/);
    assert.equal(boogu.stripped_clause, "boogu-14（【安全合规】/ [Safety and compliance] · 原第 14 条「安全改写」）");
});

test("改写器模块：不自行发起网络请求（零 http 依赖，llmCall 由外部注入）", () => {
    const src = readFileSync(MODULE_PATH, "utf-8");
    assert.doesNotMatch(src, /from\s+["']node:https?["']/, "不得 import http/https");
    assert.doesNotMatch(src, /\bfetch\s*\(/, "不得直接调用 fetch");
    assert.doesNotMatch(src, /XMLHttpRequest|require\(["']axios/, "不得引入网络层");
    assert.match(src, /from\s+["']node:fs["']/, "只允许 fs/path/url");
});

// ————————————————————— 2. Boogu 合规红线（反向断言） —————————————————————

test("Boogu 反向断言：系统提示词块不含任何安全改写/回避/过滤指令", () => {
    const file = loadRewriterFile("boogu-rewriter");
    // 精确到「指令措辞」，避免误伤 'explicitly asked' / 'avoid Western scenes' 这类正常风格规则。
    const FORBIDDEN = [
        "安全改写",
        "安全合规",
        "色情",
        "露骨",
        "违法",
        "改写为合法",
        "规避",
        "回避",
        "敏感词",
        "safe rewrite",
        "safety and compliance",
        "safety rewrite",
        "sexually explicit",
        "pornographic",
        "explicit content",
        "illegal",
        "compliance",
        "evade",
        "filter out",
    ];
    for (const variant of ["zh", "en"]) {
        const text = file.prompts[variant];
        const low = text.toLowerCase();
        for (const bad of FORBIDDEN) {
            assert.ok(!text.includes(bad) && !low.includes(bad.toLowerCase()), `Boogu.${variant} 系统提示词不得残留「${bad}」`);
        }
    }
});

test("Boogu 剔除处已就地标注：档内可见说明 + meta 标记", () => {
    const file = loadRewriterFile("boogu-rewriter");
    assert.match(file.meta.stripped_clause, /boogu-14/);
    assert.match(file.raw, /原第 14 条（`?【安全合规】`? \/ `?\[Safety and compliance\]`? ·“安全改写”）已整条剔除|原第 14 条/);
    assert.match(file.raw, /剔除说明/);
    assert.match(file.raw, /AGENTS\.md · 内容创作规范/);
    // 说明块位于系统提示词块之外（保证喂给模型的 system 是纯净的）
    const promptStart = file.raw.indexOf('<<<REWRITER-PROMPT id="zh">>>');
    const annotIdx = file.raw.indexOf("剔除说明");
    assert.ok(annotIdx > 0 && annotIdx < promptStart, "剔除说明应在 zh 提示词块之前");
    assert.equal(REWRITERS["boogu-rewriter"].strippedClause, "boogu-14");
});

// ————————————————————— 3. Wan 六套变体选择 —————————————————————

test("Wan 变体：中英 × LM/VL/双图VL 六套全部选得对", () => {
    const cases = [
        [{ targetLang: "zh", context: { wan: "lm" } }, "lm_zh"],
        [{ targetLang: "en", context: { wan: "lm" } }, "lm_en"],
        [{ targetLang: "zh", context: { wan: "vl" } }, "vl_zh"],
        [{ targetLang: "en", context: { wan: "vl" } }, "vl_en"],
        [{ targetLang: "zh", context: { wan: "vl2" } }, "vl2_zh"],
        [{ targetLang: "en", context: { wan: "vl2" } }, "vl2_en"],
        // 布尔写法亦应等价命中
        [{ targetLang: "zh", context: { multiImages: true } }, "vl2_zh"],
        [{ targetLang: "en", context: { vl: true } }, "vl_en"],
    ];
    for (const [opts, want] of cases) {
        assert.equal(buildPlan("wan-prompt-extend", { text: "x", ...opts }).variantId, want, JSON.stringify(opts));
    }
    // 官方默认 tar_lang='zh'、无图 → lm_zh
    assert.equal(buildPlan("wan-prompt-extend", { text: "x" }).variantId, "lm_zh");
});

test("Wan 变体：选中的 system 与官方对应表一致", () => {
    const zh = loadRewriterFile("wan-prompt-extend").prompts;
    assert.match(zh.lm_zh, /^你是一位Prompt优化师，旨在将用户输入改写为优质Prompt/);
    assert.match(zh.lm_en, /^You are a prompt engineer, aiming to rewrite user inputs/);
    assert.match(zh.vl_zh, /旨在参考用户输入的图像的细节内容/);
    assert.match(zh.vl2_zh, /第一张是视频的第一帧，第二张时视频的最后一帧/);
    assert.match(zh.vl2_en, /the first is the first frame of the video/);
    assert.match(zh.lm_zh, /1\.\s*对于过于简短的用户输入|1\. 对于过于简短/);
});

// ————————————————————— 4. llmCall 入参 —————————————————————

test("rewritePrompt：llmCall 收到正确的 system（= 所选变体系统提示词原文）与 user=源文本", async () => {
    const llm = fakeLlm("改写结果");
    const text = "一个扎双马尾的女孩在雨里奔跑，镜头跟拍";
    const out = await rewritePrompt({ rewriterId: "wan-prompt-extend", text, targetLang: "zh", context: { wan: "lm" }, llmCall: llm });
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(Object.keys(llm.calls[0]).sort(), ["system", "user"]);
    assert.equal(llm.calls[0].user, text);
    assert.equal(llm.calls[0].system, systemPromptFor("wan-prompt-extend", "lm_zh"));
    assert.equal(out.text, "改写结果");
    assert.equal(out.meta.rewriterId, "wan-prompt-extend");
    assert.equal(out.meta.variant, "lm_zh");
    assert.equal(out.meta.impl, "prompt");
    assert.ok(out.meta.systemPromptPath.endsWith("wan-prompt-extend.md"));
    assert.equal(out.meta.chars, "改写结果".length);
    assert.equal(out.meta.truncated, false);
});

test("rewritePrompt：Qwen-Edit 变体把 EDIT 系统提示词交给 llmCall，且按任务类型分治（JSON 协议在系统提示词内）", async () => {
    const llm = fakeLlm('{"Rewritten":"add a light-gray cat in the bottom-right corner"}');
    const out = await rewritePrompt({ rewriterId: "qwen-image-rewrite", text: "加只动物", context: { task: "edit" }, llmCall: llm });
    assert.equal(out.meta.variant, "edit");
    assert.match(llm.calls[0].system, /# Edit Prompt Enhancer/);
    assert.match(llm.calls[0].system, /Replace "xx" to "yy"/);
    assert.match(llm.calls[0].system, /"Rewritten": "\.\.\."/);
    assert.equal(out.text, "add a light-gray cat in the bottom-right corner");
    assert.equal(out.meta.parsed, "json");
});

// ————————————————————— 5. 上限 / truncated —————————————————————

test("Qwen T2I：超 200 词 → truncated 标记，且不静默截断（正文原样返回）", async () => {
    const long = Array.from({ length: 250 }, (_, i) => `w${i}`).join(" ");
    const out = await rewritePrompt({ rewriterId: "qwen-image-rewrite", text: "x", targetLang: "en", llmCall: fakeLlm(long) });
    assert.equal(out.meta.truncated, true);
    assert.equal(out.meta.limit.words, 200);
    assert.equal(out.meta.limit.actual, 250);
    assert.equal(out.meta.limit.enforced, "flag-only");
    // 不截断：正文仍为模型原样输出（magic suffix 按官方口径直接拼接）
    assert.equal(out.meta.words, 250);
    assert.equal(out.text, long + REWRITERS["qwen-image-rewrite"].magicSuffix.t2i_en);
});

test("Qwen T2I：未超上限 → truncated=false，并拼接官方 magic prompt", async () => {
    const out = await rewritePrompt({ rewriterId: "qwen-image-rewrite", text: "一只猫", targetLang: "zh", llmCall: fakeLlm("一只橘猫坐在窗台") });
    assert.equal(out.meta.truncated, false);
    assert.equal(out.meta.magicAppended, true);
    assert.equal(out.text, "一只橘猫坐在窗台超清，4K，电影级构图");
});

test("rewritePrompt：context.appendMagic=false 时不拼 magic", async () => {
    const out = await rewritePrompt({ rewriterId: "qwen-image-rewrite", text: "a cat", targetLang: "en", context: { appendMagic: false }, llmCall: fakeLlm("A cat.") });
    assert.equal(out.text, "A cat.");
    assert.equal(out.meta.magicAppended, undefined);
});

test("H3 提示词上限常量（研究结论：官方云端手册 7000 字符）", () => {
    assert.equal(H3_MAX_PROMPT_CHARS, 7000);
    // H3 没有官方改写器资产 → 桥接返回 null，交由 H3 自身结构规范处理
    assert.equal(rewriterForTemplate("video_h3_i2v"), null);
});

// ————————————————————— 6. qwen-image-2.1-pe 的 impl 判定 —————————————————————

test("qwen-image-2.1-pe：impl='prompt'（系统提示词全文可取），并标注 officialImpl='weights'", async () => {
    const llm = fakeLlm("a long english prompt, about four hundred words ...");
    const out = await rewritePrompt({ rewriterId: "qwen-image-2.1-pe", text: "一杯咖啡", llmCall: llm });
    assert.equal(out.meta.impl, "prompt");
    assert.equal(out.meta.officialImpl, "weights");
    assert.equal(out.meta.variant, "pe_t2i");
    assert.ok(out.meta.systemPromptPath.endsWith("qwen-image-2.1-pe.md"));
    assert.deepEqual(out.meta.targetRange.words, [400, 500]);
    assert.match(llm.calls[0].system, /^# Image Prompt Rewriting Expert/);
    // 编辑路径
    const edit = await rewritePrompt({ rewriterId: "qwen-image-2.1-pe", text: "把标题改成夏日", context: { peTask: "i2i" }, llmCall: fakeLlm("x") });
    assert.equal(edit.meta.variant, "pe_i2i");
});

test("buildPlan：impl='weights' 的改写器返回 requiresWeights 信号（不假装能用）", () => {
    const fakeRegistry = { "dummy-weights": { file: "dummy.md", impl: "weights", variants: ["v"], defaultVariant: "v" } };
    const plan = buildPlan("dummy-weights", { text: "x" }, fakeRegistry);
    assert.equal(plan.requiresWeights, true);
    assert.equal(plan.impl, "weights");
    assert.equal(REWRITERS["qwen-image-2.1-pe"].impl, "prompt", "PE 已确认系统提示词可取，走 prompt");
});

// ————————————————————— 7. SCAIL-2 两段式 —————————————————————

test("scail2-enhancer：caption / replacement 两段可选，槽位可填充", async () => {
    const file = loadRewriterFile("scail2-enhancer");
    assert.match(file.prompts.caption, /You are captioning sampled frames/);
    assert.match(file.prompts.replacement, /\{instruction\}/);
    assert.match(file.prompts.replacement, /around 90-140 words/);
    assert.ok(file.assets.examples && file.assets.examples.length > 100, "few-shot 示例资产应在档");

    const cap = await rewritePrompt({ rewriterId: "scail2-enhancer", text: "抽帧事实", context: { stage: "caption" }, llmCall: fakeLlm("caption text") });
    assert.equal(cap.meta.variant, "caption");

    const llm = fakeLlm("final prompt");
    const rep = await rewritePrompt({
        rewriterId: "scail2-enhancer",
        text: "source video",
        context: { scail2: { instruction: "replace the man", caption: "a man walks", examples: "EX" } },
        llmCall: llm,
    });
    assert.equal(rep.meta.variant, "replacement");
    assert.equal(rep.meta.slotsFilled, true);
    assert.match(llm.calls[0].system, /replace the man/);
    assert.match(llm.calls[0].system, /a man walks/);
    assert.doesNotMatch(llm.calls[0].system, /\{instruction\}|\{caption\}|\{examples\}/);
    // 默认段 = replacement
    assert.equal(buildPlan("scail2-enhancer", { text: "x" }).variantId, "replacement");
});

// ————————————————————— 8. rewriterForTemplate 桥接 —————————————————————

test("rewriterForTemplate：Wan 全系 / SCAIL-2 / Qwen 系 / Boogu 映射正确，无资产返回 null", () => {
    const map = {
        video_wan_animate: "wan-prompt-extend",
        video_wan_t2v: "wan-prompt-extend",
        scail2_action_transfer: "wan-prompt-extend",
        img_qwen21_t2i: "qwen-image-2.1-pe",
        img_qwen21_edit: "qwen-image-2.1-pe",
        img_qwen_t2i: "qwen-image-rewrite",
        img_qwen_image_edit_2509: "qwen-image-rewrite",
        img_boogu_outfit_edit: "boogu-rewriter",
        // 无官方改写器的模板
        video_h3_i2v: null,
        video_minimax_h3_t2v: null,
        img_flux_artistic: null,
        img_krea2_artistic: null,
        img_zimage_artistic: null,
        upscale_4x: null,
        audio_qwen3_tts: null,
        "": null,
    };
    for (const [tpl, want] of Object.entries(map)) {
        assert.equal(rewriterForTemplate(tpl), want, `模板 ${tpl || "(空)"}`);
    }
    // SCAIL-2 换人/替换专用路径 → 两段式
    assert.equal(rewriterForTemplate("scail2_character_replace"), "scail2-enhancer");
    const d = rewriterDescriptorForTemplate("scail2_action_transfer");
    assert.equal(d.rewriterId, "wan-prompt-extend");
    assert.ok(d.alternatives.includes("scail2-enhancer"));
    assert.equal(rewriterDescriptorForTemplate("未知模板"), null);
});

// ————————————————————— 9. 错误 / 容错 —————————————————————

test("容错：提示词文件缺失时 loadRewriterFile 返回 null，rewritePrompt 抛清晰错误", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rw-"));
    try {
        assert.equal(loadRewriterFile("wan-prompt-extend", { dir: empty }), null);
        assert.equal(systemPromptFor("wan-prompt-extend", "lm_zh", { dir: empty }), null);
        await assert.rejects(
            rewritePrompt({ rewriterId: "wan-prompt-extend", text: "x", context: { promptsDir: empty }, llmCall: fakeLlm("y") }),
            /文件缺失/,
        );
    } finally {
        rmSync(empty, { recursive: true, force: true });
    }
});

test("入参校验：未知 rewriterId / 未注入 llmCall / 空 text 一律 TypeError", async () => {
    await assert.rejects(rewritePrompt({ rewriterId: "nope", text: "x", llmCall: fakeLlm("y") }), TypeError);
    await assert.rejects(rewritePrompt({ rewriterId: "wan-prompt-extend", text: "x" }), /llmCall 必须由调用方注入/);
    await assert.rejects(rewritePrompt({ rewriterId: "wan-prompt-extend", text: "   ", llmCall: fakeLlm("y") }), /text/);
});

// ————————————————————— 10. 小工具 & 清单 —————————————————————

test("detectLang / countWords：中英粗判与词数口径", () => {
    assert.equal(detectLang("一只猫"), "zh");
    assert.equal(detectLang("a cat"), "en");
    assert.equal(detectLang(""), "en");
    assert.equal(countWords("a b c"), 3);
    assert.equal(countWords("你好世界"), 4);
    assert.equal(countWords("hello 你好"), 3); // 2 cjk + 1 latin
    assert.equal(countWords(""), 0);
});

test("listRewriters：返回 5 条、均可加载，Boogu 带 strippedClause", () => {
    const list = listRewriters();
    assert.equal(list.length, 5);
    for (const item of list) {
        assert.equal(item.available, true, `${item.rewriterId} 应可用`);
        assert.equal(item.impl, "prompt");
        assert.ok(item.variants.length > 0);
    }
    const boogu = list.find((x) => x.rewriterId === "boogu-rewriter");
    assert.equal(boogu.strippedClause, "boogu-14");
    assert.match(boogu.warnings, /第 14 条/);
    const pe = list.find((x) => x.rewriterId === "qwen-image-2.1-pe");
    assert.equal(pe.officialImpl, "weights");
});

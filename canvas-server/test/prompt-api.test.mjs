import assert from "node:assert/strict";
import { test } from "node:test";

import { compilePromptForRequest } from "../src/prompt-api.js";

/**
 * prompt-api（POST /api/prompt/compile 的业务口）三路回归：
 *   · rewrite 未传  → 保持同步结构，降级标记只留在 meta，不进入 prompt；
 *   · rewrite:true + 可用 llmCall → 英文化生效（无标记、language=en、meta.llm 回填）；
 *   · 降级路径     → llmCall 抛错时同步结构照旧产出 + meta warning，绝不假装已英文化。
 * 用假 callLlm（rich 版）隔离真实 DeepSeek，不产生网络请求。
 */

const SHOT = { action: "林晚从站台阴影中走出，上台阶，进入公交车", shotSize: "全景", camera: "缓慢横摇" };

/** 假 rich 版 callLlm：返回 { text, model, finishReason, chars }。 */
const fakeLlm = (text, { finishReason = "stop", model = "deepseek-flash" } = {}) => async () => ({
    text,
    model,
    finishReason,
    chars: text.length,
    usage: null,
});

test("rewrite 未传：同步行为，降级标记不进入实际 PROMPT", async () => {
    const { prompt, meta } = await compilePromptForRequest({ template: "img_qwen21_t2i", family: "image", shot: SHOT });
    assert.equal(typeof prompt, "string");
    assert.ok(!prompt.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.equal(meta.untranslated, true);
    assert.equal(meta.language, "zh");
    assert.equal(meta.modelKey, "qwen_image_2_1");
    assert.equal(meta.rewriterId, "qwen-image-2.1-pe");
    assert.equal(meta.llm, null, "未走 LLM → llm 为 null");
    assert.equal(meta.applied.structure, true);
    assert.ok(Array.isArray(meta.notes) && meta.notes.some((n) => /未英文化/.test(n)));
});

test("rewrite:true + 可用 llmCall：官方改写器英文化生效，无 [untranslated]", async () => {
    const text = "A cinematic wide shot of Lin Wan stepping out of the platform shadows onto a night bus, realistic lighting.";
    const { prompt, meta } = await compilePromptForRequest(
        { template: "img_qwen21_t2i", family: "image", shot: SHOT, style: { anchor: "cinematic" }, rewrite: true },
        { callLlm: fakeLlm(text) },
    );
    assert.ok(!prompt.includes("[untranslated"), "英文化成功后不得带未升级标记");
    assert.ok(prompt.includes(text), "PROMPT 应包含改写器产出的英文正文");
    assert.equal(meta.untranslated, false);
    assert.equal(meta.language, "en");
    assert.equal(meta.rewriterId, "qwen-image-2.1-pe");
    assert.deepEqual(meta.llm, { model: "deepseek-flash", finishReason: "stop", chars: text.length });
    assert.equal(meta.notes, undefined, "成功路径不该有 notes");
});

test("rewrite:true + 无官方改写器的英文模型（Krea2）：走通用翻译路径英文化", async () => {
    const text = "A photorealistic close-up of a woman in a cream jacket on a bus, soft rim light.";
    const { prompt, meta } = await compilePromptForRequest({ template: "img_krea2_artistic", family: "image", shot: SHOT, rewrite: true }, { callLlm: fakeLlm(text) });
    assert.ok(!prompt.includes("[untranslated"));
    assert.ok(prompt.includes(text));
    assert.equal(meta.modelKey, "krea2_turbo");
    assert.equal(meta.rewriterId, null, "Krea2 无官方改写器 → null");
    assert.equal(meta.language, "en");
    assert.equal(meta.llm.finishReason, "stop");
});

test("降级路径：llmCall 抛错 → 同步结构照旧产出 + notes，不抛给调用方", async () => {
    const failing = async () => {
        throw Object.assign(new Error("LLM 请求失败"), { code: "llm_unavailable" });
    };
    const { prompt, meta } = await compilePromptForRequest({ template: "img_qwen21_t2i", family: "image", shot: SHOT, rewrite: true }, { callLlm: failing });
    assert.equal(typeof prompt, "string");
    assert.ok(!prompt.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.ok(prompt.includes("景别：全景"), "同步结构（景别等）照旧产出");
    assert.equal(meta.untranslated, true);
    assert.equal(meta.language, "zh");
    assert.equal(meta.llm, null, "改写失败 → 无 llm 元数据");
    assert.ok(meta.notes.some((n) => /改写失败/.test(n)), "改写异常必须进入 notes");
});

test("降级路径：LLM 返回 finish_reason=length → 拒绝残缺稿，降级为同步稿", async () => {
    const truncated = async () => ({ text: "just a partial english fragment", model: "deepseek-flash", finishReason: "length", chars: 30, usage: null });
    const { prompt, meta } = await compilePromptForRequest({ template: "img_qwen21_t2i", family: "image", shot: SHOT, rewrite: true }, { callLlm: truncated });
    assert.ok(!prompt.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.equal(meta.untranslated, true);
    assert.equal(meta.llm.finishReason, "length", "meta.llm 仍回填截断信号供排查");
    assert.ok(meta.notes.some((n) => /截断/.test(n)));
});

test("缺少 template → 抛 400 业务错误", async () => {
    await assert.rejects(compilePromptForRequest({ shot: SHOT }), (error) => error.status === 400 && /缺少 template/.test(error.message));
});

test("视频模板（H3）：字段结构照旧；模型要求英文正文 → 未英文化标记只留 meta，不进 PROMPT", async () => {
    const { prompt, meta } = await compilePromptForRequest({ template: "video_h3_i2v", family: "video", shot: SHOT, durationSec: 5 });
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.includes("integrated_multimodal_description:"), "H3 本地字段口径结构照旧");
    assert.ok(!prompt.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.equal(meta.modelKey, "minimax_h3");
    assert.equal(meta.untranslated, true, "H3 官方改写规范要求正文英文：没有改写稿时须如实标未英文化");
    assert.equal(meta.language, "zh");
    assert.ok(meta.notes.some((n) => /未英文化/.test(n)));
});

test("视频模板（H3）rewrite:true + 可用 llmCall：专用整段英文化入口生效，台词/画面文字逐字保留", async () => {
    const shot = { ...SHOT, dialogue: "这么晚才回来？" };
    const overlays = [{ text: "末班车", kind: "screen" }];
    const text = [
        "【画面描述事实】",
        "A cinematic wide shot of Lin Wan stepping out of the platform shadows onto a night bus.",
        'ANCHOR: The speaker (S1) says: <d>[English] 这么晚才回来？</d>',
        'ANCHOR: On-screen text kept verbatim: A screen reading "末班车".',
        "【环境声与动作声】",
        "N/A",
        "【配乐】",
        "N/A",
    ].join("\n");
    const { prompt, meta } = await compilePromptForRequest(
        { template: "video_h3_i2v", family: "video", shot, overlays, style: { anchor: "cinematic" }, durationSec: 5, rewrite: true },
        { callLlm: fakeLlm(text) },
    );
    assert.ok(!prompt.includes("[untranslated"), "英文化成功后不得带未升级标记");
    assert.ok(prompt.includes("A cinematic wide shot of Lin Wan"), "PROMPT 应包含改写器产出的英文正文");
    assert.match(prompt, /<d>\[English\] 这么晚才回来？<\/d>/, "台词逐字保留");
    assert.match(prompt, /reading "末班车"/, "画面文字逐字保留");
    assert.equal(meta.untranslated, false);
    assert.equal(meta.language, "en");
    assert.equal(meta.modelKey, "minimax_h3");
    assert.deepEqual(meta.llm, { model: "deepseek-flash", finishReason: "stop", chars: text.length });
    assert.equal(meta.notes, undefined, "成功路径不该有 notes");
});

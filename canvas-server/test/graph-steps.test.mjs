/**
 * 总采样步数：让进度分母从一开始就是常量（graph-steps.js）。
 *
 * ## 为什么必须有这个模块
 *   ComfyUI 的 progress_state.nodes 是**累计字典**，分母一路增长（真机实测 2 → 3 → 5 → 13），
 *   而先跑完的小权重节点会瞬间把比值顶到 100%。于是「已完成 / 已知总步数」这个比值
 *   既会**倒退**（92% → 61%），又会**虚高**（整条视频全程 100%）。
 *   但采样节点的总步数在**提交前**就写在 graph 里 —— 那才是可信的常量分母。
 *
 * ## fixture 的来历
 *   2026-10-08 真机 renderTemplate('workflows/video_h3_ref2v_image_turbo.json') 出的真实形状：
 *     节点 11 MiniMaxH3DualClockSamplerT8  inputs.steps = 8（真正耗时最长的采样）
 *     节点 14 SamplerCustomAdvancedinputs.sigmas 长度 = 2 → 步数 1（秒完）
 *   节点 14 的 max 极小却先跑完，所以只用 nodes 之和会把比值顶到 100%。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { totalSamplingSteps } from "../src/graph-steps.js";
import { renderTemplate } from "../src/providers/comfy.js";

test("采样步数：显式 steps 的采样节点按 steps 算", () => {
    const result = totalSamplingSteps({
        "11": { class_type: "MiniMaxH3DualClockSamplerT8", inputs: { steps: 8 } },
    });
    assert.equal(result.totalSteps, 8);
    assert.equal(result.samplingNodes.length, 1);
    assert.equal(result.samplingNodes[0].id, "11");
});

test("采样步数：SamplerCustomAdvanced 用 sigmas 长度 - 1（sigmas 比步数多一个起点）", () => {
    // 真机实测：节点 14 的 sigmas 长度 = 2 → 步数 1。
    const result = totalSamplingSteps({
        "14": { class_type: "SamplerCustomAdvanced", inputs: { sigmas: [1.0, 0.0] } },
    });
    assert.equal(result.totalSteps, 1, "长度 2 → 步数 1");
    // sigmas 长度 5 → 步数 4
    assert.equal(totalSamplingSteps({ "1": { class_type: "SamplerCustomAdvanced", inputs: { sigmas: [1, 0.8, 0.5, 0.2, 0] } } }).totalSteps, 4);
});

test("采样步数：只认采样节点，加载/解码/保存节点不算算力", () => {
    const result = totalSamplingSteps({
        "1": { class_type: "UNETLoader", inputs: {} },
        "2": { class_type: "VAEDecode", inputs: {} },
        "3": { class_type: "SaveImage", inputs: {} },
        "11": { class_type: "MiniMaxH3DualClockSamplerT8", inputs: { steps: 8 } },
    });
    assert.equal(result.totalSteps, 8, "只有采样节点计入");
    assert.equal(result.samplingNodes.length, 1);
});

test("采样步数：多个采样节点求和（真机视频模板就是这种）", () => {
    const result = totalSamplingSteps({
        "11": { class_type: "MiniMaxH3DualClockSamplerT8", inputs: { steps: 8 } },
        "14": { class_type: "SamplerCustomAdvanced", inputs: { sigmas: [1, 0] } },
    });
    assert.equal(result.totalSteps, 9, "8 + 1");
});

test("采样步数：没有可识别采样节点时返回 null（不拿 0 冒充总步数）", () => {
    assert.equal(totalSamplingSteps({ "1": { class_type: "SaveImage", inputs: {} } }), null);
    assert.equal(totalSamplingSteps({}), null);
    assert.equal(totalSamplingSteps(null), null);
    // 有采样节点但步数不可知 → 也不参与，避免用错步数算比例。
    assert.equal(totalSamplingSteps({ "1": { class_type: "KSampler", inputs: { seed: 1 } } }), null);
    // steps 为 0 / 负数 / 非数 → 同样不认。
    assert.equal(totalSamplingSteps({ "1": { class_type: "KSampler", inputs: { steps: 0 } } }), null);
    assert.equal(totalSamplingSteps({ "1": { class_type: "KSampler", inputs: { steps: -3 } } }), null);
    assert.equal(totalSamplingSteps({ "1": { class_type: "KSampler", inputs: { steps: "abc" } } }), null);
});

test("采样步数：对仓库里的真实视频模板能算出非零总步数（防止模板改了口径就静默失效）", () => {
    const graph = renderTemplate("workflows/video_h3_ref2v_image_turbo.json", {
        INPUT_IMAGE: "x.png",
        PROMPT: "p",
        WIDTH: 768,
        HEIGHT: 1344,
        LENGTH: 81,
        SEED: 1,
        OUTPUT_PREFIX: "o",
    });
    const result = totalSamplingSteps(graph);
    assert.ok(result, "真实视频模板必须能算出总步数，否则进度会退回 observed 分母");
    assert.ok(result.totalSteps > 0, "总步数必须为正");
    // 真机实测这两个节点：11 号 steps=8、14 号 sigmas 长度 2。
    assert.equal(result.totalSteps, 9, "与真机探测到的节点形状一致：8 + 1");
});

test("采样步数：真实 TTS 模板同样可算（之前只用 TTS 验证过）", () => {
    const graph = renderTemplate("workflows/audio_qwen3_tts.json", {
        DEVICE: "cuda",
        TEXT: "t",
        SPEAKER: "Vivian",
        LANGUAGE: "Chinese",
        INSTRUCT: "",
        SEED: 1,
        OUTPUT_PREFIX: "o",
    });
    const result = totalSamplingSteps(graph);
    // TTS 没有常规采样节点，可能为 null —— 允许，但不许抛错。
    assert.ok(result === null || result.totalSteps > 0);
});
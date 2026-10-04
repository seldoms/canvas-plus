/**
 * 生成参数能力上限（capability-limits.js + sizes.js 的 maxPixels）行为锁定。
 *
 * 覆盖验收点：
 *   - 超限被拒且原因可读（2048x2048 → 写出 H3 上限 1920x1088 / 2,088,960 像素）；
 *   - 合法档放行（1344x768）；
 *   - 上限取自服务端能力元数据（sizes.js → listTemplates → /api/providers）；
 *   - 每个视频模板的每个规格档都不超该模型的像素上限。
 *
 * 一手证据：147 任务 video-mutm8c0y-mewdg 的 ValueError 原文（见 sizes.js / capability-limits.js 头注释）。
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SIZE_CATALOG, pixelCapForTemplate, sizeMetaForTemplate } from "../src/sizes.js";
import { validateDurationParams, validateGenerationParams, validateSizeParams } from "../src/capability-limits.js";
import { listTemplates } from "../src/providers/comfy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const workflowsDir = resolve(HERE, "../workflows/");

const H3_TEMPLATES = [
    "video_h3_i2v",
    "video_h3_i2v_fl",
    "video_h3_ref2v",
    "video_h3_ref2v_image",
    "video_h3_ref2v_image_turbo",
    "video_h3_quantfunc_ref2v",
    "video_h3_talk",
    "video_minimax_h3_t2v",
];

// 147 一手证据：H3 2.0MP cap = 1920x1088 = 2,088,960 像素。
const H3_CAP_PIXELS = 2088960;

// ————————————————————— 上限登记在能力元数据里 —————————————————————

test("像素上限登记进服务端能力元数据（不是只写在注释里）", () => {
    // sizes.js 的 SIZE_CATALOG 是唯一事实源：maxPixels / maxSize / capSource 都在数据里。
    assert.equal(SIZE_CATALOG.minimax_h3.maxPixels, H3_CAP_PIXELS);
    assert.equal(SIZE_CATALOG.minimax_h3.maxSize, "1920x1088");
    assert.equal(SIZE_CATALOG.minimax_h3.capSource, "147-error");

    const cap = pixelCapForTemplate("video_h3_i2v");
    assert.deepEqual(cap, { model: "minimax_h3", maxPixels: H3_CAP_PIXELS, maxSize: "1920x1088", source: "147-error" });

    // 每个 H3 视频模板都能取到同一上限。
    for (const name of H3_TEMPLATES) {
        assert.equal(pixelCapForTemplate(name)?.maxPixels, H3_CAP_PIXELS, `${name} 应取到 H3 上限`);
    }
    // 未映射模板不臆造上限。
    assert.equal(pixelCapForTemplate("video_lipsync"), null);
    assert.equal(pixelCapForTemplate("img_test"), null);
});

test("上限随模板清单同源下发（GET /api/providers 的 sizeMeta.maxPixels）", () => {
    const templates = listTemplates(workflowsDir);
    const h3 = templates.find((template) => template.name === "video_h3_i2v");
    assert.equal(h3.sizeMeta.maxPixels, H3_CAP_PIXELS);
    assert.equal(h3.sizeMeta.maxSize, "1920x1088");
    assert.equal(h3.sizeMeta.capSource, "147-error");
    // 尺寸元数据同一形状：sizeMetaForTemplate 与列表下发一致。
    assert.equal(sizeMetaForTemplate("video_h3_i2v").maxPixels, H3_CAP_PIXELS);
});

// ————————————————————— 超限被拒 + 合法档放行 —————————————————————

test("超限被拒：2048x2048（4,194,304 像素）当场给出可读原因", () => {
    const verdict = validateSizeParams("video_h3_i2v", { WIDTH: 2048, HEIGHT: 2048 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "size_over_pixel_cap");
    // 文案要写清「上限是多少、当前超了多少」。
    assert.match(verdict.error, /1920×1088|1920x1088/, "应写明模型上限尺寸");
    assert.match(verdict.error, /2,?088,?960|2\.0MP/, "应写明上限像素 / 2.0MP");
    assert.match(verdict.error, /2048×2048|2048x2048/, "应写明当前尺寸");
    assert.match(verdict.error, /4,194,304/, "应写明当前像素");
    assert.equal(verdict.details.maxPixels, H3_CAP_PIXELS);
});

test("超限被拒：validateGenerationParams 总入口同样拦（含 LENGTH 场景）", () => {
    const verdict = validateGenerationParams("video_h3_i2v", { WIDTH: 2048, HEIGHT: 2048, LENGTH: 124 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /上限/);
});

test("合法档放行：H3 官方 1344x768 / 768x1344 / 480x832 全部通过", () => {
    const legal = [[1344, 768], [768, 1344], [480, 832], [1792, 768], [1024, 768]];
    for (const [WIDTH, HEIGHT] of legal) {
        const verdict = validateGenerationParams("video_h3_i2v", { WIDTH, HEIGHT, LENGTH: 124 });
        assert.equal(verdict.ok, true, `${WIDTH}x${HEIGHT} 应放行：${verdict.error || ""}`);
    }
});

test("非官方档被拒：不在 optional 档内的尺寸写清可选清单", () => {
    const verdict = validateSizeParams("video_h3_i2v", { WIDTH: 999, HEIGHT: 999 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "size_not_in_catalog");
    assert.match(verdict.error, /不在模型/);
    assert.match(verdict.error, /1344x768/);
});

test("未登记 WIDTH/HEIGHT（缺参 / 非法）不误拦", () => {
    assert.equal(validateSizeParams("video_h3_i2v", {}).ok, true);
    assert.equal(validateSizeParams("video_h3_i2v", { WIDTH: "auto", HEIGHT: null }).ok, true);
    // 未映射模板（无能力元数据）不校验。
    assert.equal(validateGenerationParams("video_lipsync", { WIDTH: 4096, HEIGHT: 4096 }).ok, true);
});

// ————————————————————— 时长帧数落在 17k+5 网格 —————————————————————

test("时长帧数：LENGTH 必须落在 17k+5 网格上（124/243/362 合法，100 非法）", () => {
    assert.equal(validateDurationParams("video_h3_i2v", { LENGTH: 124 }).ok, true);
    assert.equal(validateDurationParams("video_h3_i2v", { LENGTH: 243 }).ok, true);
    assert.equal(validateDurationParams("video_h3_i2v", { LENGTH: 362 }).ok, true);
    const bad = validateDurationParams("video_h3_i2v", { LENGTH: 100 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "length_off_frame_grid");
    assert.match(bad.error, /17k\+5/);
    // 无档位模型 / 缺 LENGTH → 跳过。
    assert.equal(validateDurationParams("video_lipsync", { LENGTH: 100 }).ok, true);
    assert.equal(validateDurationParams("video_h3_i2v", {}).ok, true);
});

// ————————————————————— 每个视频模板的每个档都不超限 —————————————————————

test("审计：每个视频模板的每个官方规格档都不超该模型的像素上限", () => {
    const templates = listTemplates(workflowsDir).filter((template) => template.family === "video");
    assert.ok(templates.length >= 8, "应扫到至少 8 个视频模板");
    let checked = 0;
    for (const template of templates) {
        const cap = pixelCapForTemplate(template.name);
        const sizes = template.sizes;
        if (!cap || !Array.isArray(sizes)) continue;
        for (const size of sizes) {
            const pixels = size.width * size.height;
            assert.ok(
                pixels <= cap.maxPixels,
                `${template.name} 的档 ${size.value}（${pixels} 像素）超过 ${cap.model} 上限 ${cap.maxPixels}`,
            );
            checked += 1;
        }
    }
    assert.ok(checked >= 9, `应至少核对 9 个视频档（H3 7 档 + Wan 2 档），实际 ${checked}`);
    // H3 的派生档 1792x768 必须真算像素数并确认未超限（1,376,256 < 2,088,960）。
    const h3 = templates.find((template) => template.name === "video_h3_i2v");
    const derived = h3.sizes.find((size) => size.value === "1792x768");
    assert.ok(derived, "H3 应有 1792x768 派生档");
    assert.equal(derived.width * derived.height, 1376256);
    assert.ok(derived.width * derived.height <= H3_CAP_PIXELS);
});

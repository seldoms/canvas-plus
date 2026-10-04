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
import { adaptDurationParams, adaptGenerationParams, adaptSizeParams, ratioOfSize, validateDurationParams, validateGenerationParams, validateSizeParams } from "../src/capability-limits.js";
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

// ————————————————————— 自适应：把「拒绝」换成「按比例吸附到合法档」 —————————————————————

test("ratioOfSize：从 W×H 判方向/比例（16:9 / 9:16 / 1:1 / 21:9 别名 / 4:3 / 3:4）", () => {
    assert.equal(ratioOfSize(1920, 1080), "16:9");
    assert.equal(ratioOfSize(1280, 720), "16:9");
    assert.equal(ratioOfSize(1080, 1920), "9:16");
    assert.equal(ratioOfSize(2048, 2048), "1:1");
    assert.equal(ratioOfSize(1400, 600), "7:3"); // 与 H3 的 21:9 档同值（21/9 = 7/3）
    assert.equal(ratioOfSize(1024, 768), "4:3");
    assert.equal(ratioOfSize(768, 1024), "3:4");
    assert.equal(ratioOfSize("auto", 720), "");
});

test("自适应①：2048x2048（超 H3 2.0MP 上限）→ 768x768，并留痕 from/to/ratio/reason", () => {
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 2048, HEIGHT: 2048, PROMPT: "x" });
    assert.equal(result.ok, true, "自适应不许报错");
    assert.equal(result.params.WIDTH, 768);
    assert.equal(result.params.HEIGHT, 768);
    // 其它参数原样保留。
    assert.equal(result.params.PROMPT, "x");
    // 留痕可查（UI 不堆字，但任务记录里查得到）。
    assert.deepEqual(
        { from: result.sizeAdjust.from, to: result.sizeAdjust.to, ratio: result.sizeAdjust.ratio },
        { from: "2048x2048", to: "768x768", ratio: "1:1" },
    );
    assert.match(result.sizeAdjust.reason, /上限/);
    assert.match(result.sizeAdjust.reason, /1:1/);
});

test("自适应②：1920x1080（16:9，未登记档）→ 1344x768（同比例最大合法档）", () => {
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 1920, HEIGHT: 1080 });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1344, 768]);
    assert.equal(result.sizeAdjust.from, "1920x1080");
    assert.equal(result.sizeAdjust.to, "1344x768");
    assert.equal(result.sizeAdjust.ratio, "16:9");
});

test("自适应③：1280x720（16:9，比官方小）→ 放大成 1344x768（把模型能力用满）", () => {
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 1280, HEIGHT: 720 });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1344, 768]);
    assert.equal(result.sizeAdjust.to, "1344x768");
    assert.equal(result.sizeAdjust.ratio, "16:9");
    // 确实是放大（像素变多）。
    assert.ok(1344 * 768 > 1280 * 720);
});

test("自适应：已是合法档且不超上限 → 原样放行（不偷改用户明确选的合法档）", () => {
    for (const [WIDTH, HEIGHT] of [[1344, 768], [768, 1344], [480, 832], [1792, 768], [1024, 768], [768, 1024]]) {
        const result = adaptSizeParams("video_h3_i2v", { WIDTH, HEIGHT });
        assert.equal(result.ok, true);
        assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [WIDTH, HEIGHT], `${WIDTH}x${HEIGHT} 不该被改`);
        assert.equal(result.sizeAdjust, null);
    }
});

test("自适应④：未知名比例 → 挑比例最接近且不超上限的合法档", () => {
    // 1000x500 = 2:1（H3 无该档）→ 最接近 16:9(1.778) vs 21:9(2.333)：16:9 更近 → 1344x768。
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 1000, HEIGHT: 500 });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1344, 768]);
    assert.equal(result.sizeAdjust.ratio, "2:1");
    assert.match(result.sizeAdjust.reason, /最接近/);
    // 选出的档绝不超上限。
    assert.ok(result.params.WIDTH * result.params.HEIGHT <= H3_CAP_PIXELS);
    // 21:9(=7:3) 同值别名：1400x600 直接命中 1792x768（同比例，非「最接近」）。
    const alias = adaptSizeParams("video_h3_i2v", { WIDTH: 1400, HEIGHT: 600 });
    assert.deepEqual([alias.params.WIDTH, alias.params.HEIGHT], [1792, 768]);
    assert.equal(alias.sizeAdjust.to, "1792x768");
});

test("自适应：两侧都超上限时也不挑超上限的档（wan22_animate 16:9 → 上限内）", () => {
    const result = adaptSizeParams("video_wan_animate", { WIDTH: 4096, HEIGHT: 2304 });
    assert.equal(result.ok, true);
    assert.ok(result.params.WIDTH * result.params.HEIGHT <= 921600, "吸附结果必须在上限内");
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1280, 720]);
});

test("兜底：模板无合法档 / 上限缺失 → 回落既有可读拒绝（不许静默放过）", () => {
    // 连一个不超上限的合法档都没有（模拟能力元数据缺失 tiers）→ adaptSizeParams 回落 validateSizeParams。
    const rejected = adaptGenerationParams("video_h3_i2v", { WIDTH: 2048, HEIGHT: 2048 }, { sizes: [] });
    assert.equal(rejected.ok, false, "找不到合法档必须回落拒绝，不许静默放过");
    assert.equal(rejected.code, "size_over_pixel_cap");
    assert.match(rejected.error, /1920x1088|1920×1088|2,088,960/);
    // 无能力元数据的模板（未映射 / 测试桩）→ 不臆造、不校验，原样放行（与旧口径一致）。
    const unknown = adaptSizeParams("video_some_new_model", { WIDTH: 4096, HEIGHT: 4096 });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.sizeAdjust, null);
    assert.deepEqual([unknown.params.WIDTH, unknown.params.HEIGHT], [4096, 4096]);
});

test("自适应：缺参 / 非法 WIDTH/HEIGHT 不误拦（有些模板不吃 WIDTH/HEIGHT）", () => {
    assert.equal(adaptSizeParams("video_h3_i2v", {}).ok, true);
    assert.equal(adaptSizeParams("video_h3_i2v", {}).sizeAdjust, null);
    const weird = adaptSizeParams("video_h3_i2v", { WIDTH: "auto", HEIGHT: null });
    assert.equal(weird.ok, true);
    assert.equal(weird.sizeAdjust, null);
});

// ————————————————————— 时长自适应（同口径上行吸附到 17k+5 网格） —————————————————————

test("时长自适应：LENGTH 不在 17k+5 网格 → 向上吸附（100 → 107），并留痕", () => {
    const result = adaptDurationParams("video_h3_i2v", { LENGTH: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.params.LENGTH, 107, "100 帧向上吸附到 17k+5 的 107");
    assert.deepEqual({ from: result.durationAdjust.from, to: result.durationAdjust.to }, { from: 100, to: 107 });
    assert.match(result.durationAdjust.reason, /17k\+5/);
    // 已在网格上（124/243/362）→ 原样放行、不留痕。
    for (const length of [124, 243, 362]) {
        const ok = adaptDurationParams("video_h3_i2v", { LENGTH: length });
        assert.equal(ok.params.LENGTH, length);
        assert.equal(ok.durationAdjust, null);
    }
});

test("时长自适应：超出训练区间不截断 —— LENGTH=480 按网格吸附到 481，绝不静默压成 362 帧", () => {
    const result = adaptDurationParams("video_h3_i2v", { LENGTH: 480 });
    assert.equal(result.ok, true);
    // 旧实现把 480 帧静默压成 362 帧（15.08s），截短后 H3 prompt 的「总时长=目标时长」必然失配。
    assert.notEqual(result.params.LENGTH, 362, "绝不静默截断到 362 帧（旧 bug）");
    assert.equal(result.params.LENGTH, 481, "480 不在 17k+5 网格 → 向上吸附到 481（节点自己也会吸附）");
    assert.equal(result.durationAdjust.from, 480);
    assert.equal(result.durationAdjust.to, 481);
    assert.equal(result.durationAdjust.frames, 481);
    assert.deepEqual(result.durationAdjust.range, [124, 362]);
    assert.match(result.durationAdjust.reason, /训练区间/);
    assert.match(result.durationAdjust.reason, /质量/);

    // 已在网格上但超训练区间 → **参数原样返回**，只在 durationAdjust 里留痕（不改参数）。
    const onGrid = adaptDurationParams("video_h3_i2v", { LENGTH: 481 });
    assert.equal(onGrid.params.LENGTH, 481, "481 在网格上 → 原样返回");
    assert.equal(onGrid.durationAdjust.from, 481);
    assert.equal(onGrid.durationAdjust.to, 481);
    assert.deepEqual(onGrid.durationAdjust.range, [124, 362]);
    assert.match(onGrid.durationAdjust.reason, /训练区间/);
    assert.match(onGrid.durationAdjust.reason, /可能影响质量/);

    // 低于训练区间（线上实测 LENGTH=90 / 3.750s 有 11 条 done）同样不截断、只留痕。
    const low = adaptDurationParams("video_h3_i2v", { LENGTH: 90 });
    assert.equal(low.params.LENGTH, 90, "90 帧在网格上 → 原样返回，不因低于训练区间被改");
    assert.equal(low.durationAdjust.frames, 90);
    assert.deepEqual(low.durationAdjust.range, [124, 362]);
    assert.match(low.durationAdjust.reason, /训练区间/);
});

test("时长自适应：无档位模型 / 缺 LENGTH → 原样放行", () => {
    assert.equal(adaptDurationParams("video_lipsync", { LENGTH: 100 }).durationAdjust, null);
    assert.equal(adaptDurationParams("video_h3_i2v", {}).durationAdjust, null);
});

// ————————————————————— 总入口：一次给齐尺寸 + 时长留痕 —————————————————————

test("总入口 adaptGenerationParams：尺寸自适应 + 时长吸附，两条留痕都带", () => {
    const result = adaptGenerationParams("video_h3_i2v", { WIDTH: 2048, HEIGHT: 2048, LENGTH: 100, PROMPT: "p" });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT, result.params.LENGTH], [768, 768, 107]);
    assert.equal(result.params.PROMPT, "p");
    assert.equal(result.sizeAdjust.to, "768x768");
    assert.equal(result.durationAdjust.to, 107);
});

// ————————————— 尺寸自适应基准 =【输入图的真实比例】（产品口径 2026-10-05）—————————————
// 依据：147 节点 `first_frame → resize_image(..., "disabled")` = 不保持比例直接拉伸，
// 平台「先选画布再喂图」→ 比例不一致必变形 → **以图为准**，并留痕 basis:"input-image"。

test("以图为准①：图 4:3 + 提交 16:9（1344x768 合法档）→ 选 4:3 档 1024x768，留痕 basis:\"input-image\"", () => {
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 1344, HEIGHT: 768, PROMPT: "x" }, { image: { width: 1024, height: 768 } });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1024, 768], "以图比例为准选 4:3 档");
    assert.equal(result.params.PROMPT, "x");
    assert.equal(result.sizeAdjust.basis, "input-image");
    assert.equal(result.sizeAdjust.ratio, "4:3");
    assert.equal(result.sizeAdjust.from, "1344x768");
    assert.equal(result.sizeAdjust.to, "1024x768");
    assert.equal(result.sizeAdjust.image, "1024x768");
    assert.equal(result.sizeAdjust.imageRatio, "4:3");
    assert.match(result.sizeAdjust.reason, /以图为准/);
    // 图与画布同比例 → 不产生变形标注。
    assert.equal(result.sizeAdjust.aspectMismatch, undefined);
});

test("以图为准②：图 16:9 + 提交 16:9 → 按提交走（放大到同比例最大档），basis:\"requested\"", () => {
    // 提交 1280x720（16:9，非官方档）→ 放大到官方 16:9 的 1344x768。
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 1280, HEIGHT: 720 }, { image: { width: 1920, height: 1080 } });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1344, 768]);
    assert.equal(result.sizeAdjust.basis, "requested", "图比例与提交一致 → 按提交走");
    assert.equal(result.sizeAdjust.to, "1344x768");
    assert.ok(1344 * 768 > 1280 * 720, "确实是放大");
    // 提交已是官方合法档且与图比例一致 → 原样放行、不留痕。
    const passthrough = adaptSizeParams("video_h3_i2v", { WIDTH: 1344, HEIGHT: 768 }, { image: { width: 1920, height: 1080 } });
    assert.equal(passthrough.sizeAdjust, null);
    assert.deepEqual([passthrough.params.WIDTH, passthrough.params.HEIGHT], [1344, 768]);
});

test("以图为准③：无输入图（纯文生视频）→ 仍按 params.WIDTH/HEIGHT 自适应，basis:\"requested\"", () => {
    const noImage = adaptSizeParams("video_h3_i2v", { WIDTH: 1920, HEIGHT: 1080 });
    assert.deepEqual([noImage.params.WIDTH, noImage.params.HEIGHT], [1344, 768]);
    assert.equal(noImage.sizeAdjust.basis, "requested");
    assert.equal(noImage.sizeAdjust.image, undefined);
    // 显式传 null / 非法 image 也等同无图（不臆造）。
    assert.equal(adaptSizeParams("video_h3_i2v", { WIDTH: 1920, HEIGHT: 1080 }, { image: null }).sizeAdjust.basis, "requested");
    assert.equal(adaptSizeParams("video_h3_i2v", { WIDTH: 1920, HEIGHT: 1080 }, { image: { width: 0, height: 0 } }).sizeAdjust.basis, "requested");
});

test("以图为准④：大比例差被标注 aspectMismatch（图 7:5 无同比例档 → 取最接近 4:3，差 4.8% > 2%）", () => {
    const result = adaptSizeParams("video_h3_i2v", { WIDTH: 1344, HEIGHT: 768 }, { image: { width: 1400, height: 1000 } });
    assert.equal(result.ok, true);
    assert.equal(result.sizeAdjust.basis, "input-image");
    assert.equal(result.sizeAdjust.imageRatio, "7:5");
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT], [1024, 768], "H3 无 7:5 档 → 取最接近的 4:3");
    assert.ok(result.sizeAdjust.aspectMismatch, "仍有 >2% 比例差必须被标注");
    assert.deepEqual(
        { image: result.sizeAdjust.aspectMismatch.image, canvas: result.sizeAdjust.aspectMismatch.canvas },
        { image: "7:5", canvas: "4:3" },
    );
    assert.match(result.sizeAdjust.aspectMismatch.note, /比例差/);
    // 同比例（图 4:3）→ 不标注。
    assert.equal(adaptSizeParams("video_h3_i2v", { WIDTH: 1344, HEIGHT: 768 }, { image: { width: 1024, height: 768 } }).sizeAdjust.aspectMismatch, undefined);
});

test("以图为准⑤：兜底不变 —— 有图但无合法档 → 回落可读拒绝（不静默放过）", () => {
    const rejected = adaptGenerationParams("video_h3_i2v", { WIDTH: 2048, HEIGHT: 2048 }, { sizes: [], image: { width: 1024, height: 768 } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "size_over_pixel_cap");
    assert.match(rejected.error, /1920x1088|1920×1088|2,088,960/);
});

test("以图为准⑥：总入口把 image 选项一路带到尺寸自适应（图 4:3 + 提交 16:9 + LENGTH）", () => {
    const result = adaptGenerationParams("video_h3_i2v", { WIDTH: 1344, HEIGHT: 768, LENGTH: 100 }, { image: { width: 1024, height: 768 } });
    assert.equal(result.ok, true);
    assert.deepEqual([result.params.WIDTH, result.params.HEIGHT, result.params.LENGTH], [1024, 768, 107]);
    assert.equal(result.sizeAdjust.basis, "input-image");
    assert.equal(result.durationAdjust.to, 107);
});

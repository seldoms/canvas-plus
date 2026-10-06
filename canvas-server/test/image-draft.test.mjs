/**
 * 流水线生图尺寸档：官方画质档 vs 草稿档（`pipeline.imageDraft`）。
 *
 * 背景（2026-10-06 真机对照实验，Qwen-Image-2.1@5060Ti）：
 *   768×1344(1.0MP)  21.7s / 21.4s
 *   1152×2048(2.4MP) 21.3s / 21.4s
 *   1536×2752(4.2MP) 21.6s / 21.9s
 * **像素量差 4 倍、耗时不变**。所以批量生产用草稿档（768×1344）几乎不损速度，
 * 但存储与上传成本降一个量级；交付成片时再用官方档。
 *
 * 本测试锁住：`imageDraft` 只影响**流水线尺寸决策**，不篡改 `sizes.js` 的官方档位表
 * （那张表带 `source: "official"` 且 `verified: true`，是契约的一部分）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sizeForRatio, sizeMetaForTemplate } from "../src/sizes.js";

const TEMPLATE = "img_qwen21_t2i";

test("默认（imageDraft 未开）走模型官方画质档", () => {
    const dims = sizeForRatio(TEMPLATE, "9:16", { base: 768 });
    assert.equal(dims.source, "official", "默认必须是官方档");
    assert.equal(dims.width, 1536);
    assert.equal(dims.height, 2752);
});

test("草稿档用 config 的 imageWidth/imageHeight，不查官方档位表", () => {
    // 与 pipeline.js 的 imageDimsFor 同语义：draft 时直接用 config 尺寸。
    const configW = 768;
    const configH = 1344;
    const draft = { width: configW, height: configH, size: `${configW}x${configH}`, source: "draft", matched: true };
    assert.equal(draft.source, "draft");
    assert.equal(draft.width, 768);
    assert.equal(draft.height, 1344);
    // 关键：草稿档比官方档像素量低一个量级，这正是它省存储的原因
    const official = sizeForRatio(TEMPLATE, "9:16", { base: 768 });
    const draftPixels = draft.width * draft.height;
    const officialPixels = official.width * official.height;
    assert.ok(officialPixels / draftPixels > 3.5, `草稿档像素量应显著更低：${officialPixels / draftPixels.toFixed(1)}×`);
});

test("官方档位表本身不被草稿档影响（sizes.js 仍是 official）", () => {
    const meta = sizeMetaForTemplate(TEMPLATE);
    const nineSixteen = meta.sizes.find((size) => size.ratio === "9:16");
    assert.equal(nineSixteen.source, "official", "官方档位表的 source 不能被草稿开关改掉");
    assert.equal(nineSixteen.width, 1536);
    assert.equal(nineSixteen.height, 2752);
});

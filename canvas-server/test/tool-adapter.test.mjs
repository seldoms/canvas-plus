import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    analyzeTemplate,
    listReferenceCapableTemplates,
    resolveToolForShot,
    scanTemplateDir,
} from "../src/tool-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");

/** 读真实模板（一手事实，不造假数据）。 */
function readWorkflow(name) {
    return readFileSync(join(WORKFLOWS_DIR, `${name}.json`), "utf8");
}

const CATALOG = scanTemplateDir(WORKFLOWS_DIR);

// ── 1. 纯文生图模板：没有任何参考图入口 ────────────────────────────────────────
test("analyzeTemplate: img_qwen21_t2i 纯文生图，不支持参考图", () => {
    const info = analyzeTemplate(readWorkflow("img_qwen21_t2i"));
    assert.equal(info.capability, "image");
    assert.equal(info.supportsReference, false);
    assert.equal(info.maxReferenceImages, 0);
    assert.deepEqual(info.referenceSlots, []);
    // 有 PROMPT 槽，没有任何图像输入槽。
    assert.equal(info.slots.PROMPT, true);
    assert.equal(info.slots.INPUT_IMAGE, false);
    for (let i = 1; i <= 9; i += 1) assert.equal(info.slots[`REF_IMAGE_${i}`], false);
});

// ── 2. 参考图编辑模板：INPUT_IMAGE + REF_IMAGE_1..9，刚好 10 张 ────────────────
test("analyzeTemplate: img_qwen21_edit 支持参考图，最多 10 张", () => {
    const info = analyzeTemplate(readWorkflow("img_qwen21_edit"));
    assert.equal(info.capability, "image");
    assert.equal(info.supportsReference, true);
    assert.ok(info.maxReferenceImages >= 9, `期望 >=9，实际 ${info.maxReferenceImages}`);
    assert.equal(info.maxReferenceImages, 10);
    assert.equal(info.slots.INPUT_IMAGE, true);
    for (let i = 1; i <= 9; i += 1) assert.equal(info.slots[`REF_IMAGE_${i}`], true);
    // 参考图槽位有序，主输入图在前。
    assert.equal(info.referenceSlots[0], "INPUT_IMAGE");
    assert.equal(info.referenceSlots.length, 10);
    assert.deepEqual(info.referenceSlots.slice(1), Array.from({ length: 9 }, (_, i) => `REF_IMAGE_${i + 1}`));
});

// ── 3. 能力分类靠真实节点：视频模板判 video，放大模板判 image ───────────────────
test("analyzeTemplate: capability 由真实节点类型判定（video / image / other）", () => {
    assert.equal(analyzeTemplate(readWorkflow("video_minimax_h3_t2v")).capability, "video");
    assert.equal(analyzeTemplate(readWorkflow("video_wan_animate")).capability, "video");
    assert.equal(analyzeTemplate(readWorkflow("upscale_4x")).capability, "image");
    // 既无视频也无图像产出节点的合成图 → other。
    assert.equal(analyzeTemplate({ "1": { class_type: "PrimitiveInt", inputs: { value: 1 } } }).capability, "other");
});

// ── 4. 非标准命名的图像素材槽（换装模板的人物图/服装图）也被识别 ────────────────
test("analyzeTemplate: 换装模板 PERSON_IMAGE / CLOTHING_IMAGE 计入参考图容量", () => {
    const info = analyzeTemplate(readWorkflow("img_boogu_outfit_edit"));
    assert.equal(info.supportsReference, true);
    assert.equal(info.maxReferenceImages, 2);
    assert.equal(info.slots.PERSON_IMAGE, true);
    assert.equal(info.slots.CLOTHING_IMAGE, true);
    assert.deepEqual(info.referenceSlots, ["CLOTHING_IMAGE", "PERSON_IMAGE"]);
});

// ── 5. 单张输入图模板：i2v / upscale 支持 1 张 ────────────────────────────────
test("analyzeTemplate: 单图模板（i2v / upscale）恰好支持 1 张输入图", () => {
    for (const name of ["video_h3_i2v", "upscale_4x"]) {
        const info = analyzeTemplate(readWorkflow(name));
        assert.equal(info.supportsReference, true, name);
        assert.equal(info.maxReferenceImages, 1, name);
        assert.deepEqual(info.referenceSlots, ["INPUT_IMAGE"], name);
    }
});

// ── 6. 接受对象与字符串两种输入，结果一致 ─────────────────────────────────────
test("analyzeTemplate: 接受 JSON 字符串与已解析对象，结果一致", () => {
    const text = readWorkflow("img_qwen21_edit");
    const fromString = analyzeTemplate(text);
    const fromObject = analyzeTemplate(JSON.parse(text));
    assert.deepEqual(fromString, fromObject);
});

// ── 7. 不得硬编码模板名单：自造模板也能被正确识别 ──────────────────────────────
test("analyzeTemplate: 未见过的新模板同样被扫出能力（不硬编码名单）", () => {
    const custom = {
        "1": { class_type: "LoadImage", inputs: { image: "{{INPUT_IMAGE}}" } },
        "2": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_3}}" } },
        "3": { class_type: "TextEncodeAnything", inputs: { text: "{{PROMPT}}" } },
        "4": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    };
    const info = analyzeTemplate(custom);
    assert.equal(info.capability, "image");
    assert.equal(info.supportsReference, true);
    assert.equal(info.maxReferenceImages, 2);
    assert.deepEqual(info.referenceSlots, ["INPUT_IMAGE", "REF_IMAGE_3"]);
    assert.equal(info.slots.REF_IMAGE_3, true);
    assert.equal(info.slots.REF_IMAGE_1, false);
});

// ── 8. 有占位符但无 LoadImage 节点时，不算参考图能力（必须是真实节点） ──────────
test("analyzeTemplate: 占位符存在但无 LoadImage 节点，不算支持参考图", () => {
    const fake = {
        "1": { class_type: "SomeNode", inputs: { note: "{{REF_IMAGE_1}}" } },
        "2": { class_type: "SaveImage", inputs: {} },
    };
    const info = analyzeTemplate(fake);
    assert.equal(info.supportsReference, false);
    assert.equal(info.maxReferenceImages, 0);
});

// ── 9. scanTemplateDir：扫出全部模板且结构完整 ────────────────────────────────
test("scanTemplateDir: 扫出 workflows 下全部模板，逐个带能力声明", () => {
    const names = Object.keys(CATALOG).sort();
    assert.equal(names.length, 16, `实际模板数 ${names.length}`);
    for (const [name, info] of Object.entries(CATALOG)) {
        assert.equal(typeof info.supportsReference, "boolean", name);
        assert.equal(typeof info.maxReferenceImages, "number", name);
        assert.ok(["image", "video", "other"].includes(info.capability), name);
        assert.ok(Array.isArray(info.referenceSlots), name);
    }
    // 命名规律与能力分类一致（交叉验证分类器）。
    assert.equal(CATALOG.img_qwen21_t2i.supportsReference, false);
    assert.equal(CATALOG.img_qwen21_edit.supportsReference, true);
    assert.equal(CATALOG.upscale_4x.capability, "image");
});

// ── 10. scanTemplateDir：目录不存在返回空对象，不抛错 ──────────────────────────
test("scanTemplateDir: 目录不存在时返回空对象", () => {
    assert.deepEqual(scanTemplateDir(join(WORKFLOWS_DIR, "__not_exist__")), {});
    assert.deepEqual(scanTemplateDir(""), {});
});

// ── 11. 核心判定：需要参考图却选了 t2i → 必须显式 ok:false ─────────────────────
test("resolveToolForShot: 需要参考图但选 t2i，显式返回不可用（不假装锁角色）", () => {
    const result = resolveToolForShot({ template: "img_qwen21_t2i", needReferenceImages: true, catalog: CATALOG });
    assert.equal(result.ok, false);
    assert.equal(result.template, "img_qwen21_t2i");
    assert.match(result.reason, /不支持参考图/);
    assert.match(result.reason, /无法锁定角色/);
    // 不得夹带任何表示「已锁定」的成功字段。
    assert.equal(result.supportsReference, undefined);
    assert.equal(result.locked, undefined);
});

// ── 12. 需要参考图且选了 edit → 可用 ──────────────────────────────────────────
test("resolveToolForShot: 需要参考图且模板支持 → ok:true", () => {
    const result = resolveToolForShot({ template: "img_qwen21_edit", needReferenceImages: true, catalog: CATALOG });
    assert.equal(result.ok, true);
    assert.equal(result.template, "img_qwen21_edit");
    assert.match(result.reason, /可锁定角色/);
});

// ── 13. 不需要参考图时，t2i 本身可用 ─────────────────────────────────────────
test("resolveToolForShot: 不需要参考图时纯文生图模板可用", () => {
    assert.equal(resolveToolForShot({ template: "img_qwen21_t2i", catalog: CATALOG }).ok, true);
    assert.equal(resolveToolForShot({ template: "img_qwen21_t2i", needReferenceImages: 0, catalog: CATALOG }).ok, true);
    assert.equal(resolveToolForShot({ template: "img_qwen21_t2i", needReferenceImages: false, catalog: CATALOG }).ok, true);
});

// ── 14. 数量超过模板容量时拒绝（需求可解释） ──────────────────────────────────
test("resolveToolForShot: 参考图数量超过模板上限时拒绝", () => {
    // i2v 只有 1 个输入图槽，要 3 张参考图 → 超容量。
    const tooMany = resolveToolForShot({ template: "video_h3_i2v", needReferenceImages: 3, catalog: CATALOG });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.reason, /最多接受 1 张参考图/);

    // edit 有 10 张容量，要 9 张没问题。
    const fits = resolveToolForShot({ template: "img_qwen21_edit", needReferenceImages: 9, catalog: CATALOG });
    assert.equal(fits.ok, true);
});

// ── 15. 未知模板 → 显式拒绝 ──────────────────────────────────────────────────
test("resolveToolForShot: 未知模板 / 缺少 template 时拒绝", () => {
    const unknown = resolveToolForShot({ template: "no_such_template", needReferenceImages: true, catalog: CATALOG });
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /未知模板/);

    const empty = resolveToolForShot({ catalog: CATALOG });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /缺少 template/);
});

// ── 16. 也接受直接传入 analyzeTemplate 结果 ───────────────────────────────────
test("resolveToolForShot: template 可传 analyzeTemplate 结果对象", () => {
    const inline = analyzeTemplate(readWorkflow("img_qwen21_t2i"));
    const result = resolveToolForShot({ template: { ...inline, name: "inline_t2i" }, needReferenceImages: 2 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /不支持参考图/);
});

// ── 17. listReferenceCapableTemplates：过滤 + 按能力分类 ─────────────────────
test("listReferenceCapableTemplates: 只列支持参考图的模板，可按能力过滤", () => {
    const all = listReferenceCapableTemplates(CATALOG);
    assert.ok(all.includes("img_qwen21_edit"));
    assert.ok(!all.includes("img_qwen21_t2i"), "纯文生图不应出现在参考图模板列表");
    assert.equal(all.length, all.filter(Boolean).length);

    const imageOnly = listReferenceCapableTemplates(CATALOG, "image");
    assert.ok(imageOnly.includes("img_qwen21_edit"));
    assert.ok(imageOnly.every((name) => CATALOG[name].capability === "image"));

    const videoOnly = listReferenceCapableTemplates(CATALOG, "video");
    assert.ok(videoOnly.includes("video_h3_i2v"));
    assert.ok(videoOnly.every((name) => CATALOG[name].capability === "video"));

    assert.deepEqual(listReferenceCapableTemplates({}, "image"), []);
});

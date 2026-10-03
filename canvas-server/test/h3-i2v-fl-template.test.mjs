/**
 * 「首尾帧 + 多参考图」H3 视频模板（video_h3_i2v_fl）的契约锁定（#52）。
 *
 * 覆盖三层：
 *   1. 模板层：scanTemplateDir / analyzeTemplate 能靠真实节点识别它（video + 参考图槽 1..9）；
 *   2. 参数层：占位符与 generate.js 的槽位声明一致（ASSET_TOKENS，首尾帧都是素材槽）；
 *   3. 行为层：首帧必填；尾帧与参考图可选——未给时**摘除节点而非报错**（走 disableEmptyImageRefs），
 *      并登记了中文标题与 D1 时长档位（[5,10,15] / frameCounts 124/243/362）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ASSET_TOKENS, createLocalRunner } from "../src/generate.js";
import { extractTokens, renderTemplate, listTemplates } from "../src/providers/comfy.js";
import { scanTemplateDir } from "../src/tool-adapter.js";
import { durationMetaForTemplate, durationsForTemplate } from "../src/durations.js";

const WORKFLOWS_DIR = fileURLToPath(new URL("../workflows/", import.meta.url));
const TEMPLATE = "video_h3_i2v_fl";
const TEMPLATE_PATH = join(WORKFLOWS_DIR, `${TEMPLATE}.json`);
const CATALOG = scanTemplateDir(WORKFLOWS_DIR);

/** 该模板的槽位契约：首尾帧 + 多参考图 + 常规生成参数。 */
const EXPECTED_TOKENS = [
    "FIRST_FRAME",
    "LAST_FRAME",
    ...Array.from({ length: 9 }, (_, index) => `REF_IMAGE_${index + 1}`),
    "HEIGHT",
    "LENGTH",
    "OUTPUT_PREFIX",
    "PROMPT",
    "SEED",
    "WIDTH",
].sort();

/** 非素材类生成参数（不需要上传 ComfyUI）。 */
const PLAIN_TOKENS = new Set(["PROMPT", "WIDTH", "HEIGHT", "LENGTH", "SEED", "OUTPUT_PREFIX"]);

/** 尾帧节点 20 + 9 个参考图节点 21..29 是「可按需摘除」的可选槽。 */
const OPTIONAL_NODE_IDS = ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"];

const refParams = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`REF_IMAGE_${i + 1}`, `comfy:ref${i + 1}.png`]));

const baseParams = (extra) => ({
    FIRST_FRAME: "comfy:first.png",
    PROMPT: "女孩走进老屋，最后停在桌边",
    WIDTH: 480,
    HEIGHT: 832,
    LENGTH: 124,
    SEED: 7,
    OUTPUT_PREFIX: "canvas/h3-fl-test",
    ...extra,
});

const conditioningOf = (graph) => Object.values(graph).find((node) => node.class_type === "MiniMaxH3AudioConditioningT8");

// ── 1. 模板层：真实节点被扫出 video + 9 个参考图槽 ─────────────────────────────
test("video_h3_i2v_fl：scanTemplateDir 靠真实节点识别为 video 且暴露 9 个参考图槽", () => {
    assert.ok(CATALOG[TEMPLATE], "新模板应被 scanTemplateDir 扫描到");
    const info = CATALOG[TEMPLATE];
    assert.equal(info.capability, "video");
    assert.equal(info.supportsReference, true);
    assert.equal(info.maxReferenceImages, 9);
    assert.deepEqual(info.referenceSlots, Array.from({ length: 9 }, (_, i) => `REF_IMAGE_${i + 1}`));
    assert.equal(info.slots.PROMPT, true);
    assert.equal(info.slots.REF_IMAGE_1, true);
    assert.equal(info.slots.REF_IMAGE_9, true);
    // 首尾帧不是 REF_IMAGE_n，不进 referenceSlots（它们是独立的 first_frame / last_frame 输入）。
    assert.ok(!info.referenceSlots.includes("FIRST_FRAME"));
    assert.ok(!info.referenceSlots.includes("LAST_FRAME"));
});

test("video_h3_i2v_fl：节点真的接到了 first_frame / last_frame / ref_images(autogrow)", () => {
    const graph = renderTemplate(TEMPLATE_PATH, baseParams({ LAST_FRAME: "comfy:last.png", ...refParams(9) }));
    const conditioning = conditioningOf(graph);
    assert.ok(conditioning, "应存在 MiniMaxH3AudioConditioningT8 节点");
    assert.deepEqual(conditioning.inputs.first_frame, ["9", 0]);
    assert.deepEqual(conditioning.inputs.last_frame, ["20", 0]);
    // autogrow 必须写成点号平铺键（写成嵌套对象会被 ComfyUI 静默丢弃参考图）。
    assert.equal(conditioning.inputs.ref_images, undefined);
    assert.deepEqual(conditioning.inputs["ref_images.ref_image_0"], ["21", 0]);
    assert.deepEqual(conditioning.inputs["ref_images.ref_image_8"], ["29", 0]);
    assert.equal(typeof conditioning.inputs.first_frame[0], "string", "节点引用必须保持字符串");
    assert.equal(conditioning.inputs.width, 480);
    assert.equal(typeof conditioning.inputs.width, "number");
});

// ── 2. 参数层：占位符与 generate.js 槽位声明一致 ──────────────────────────────
test("video_h3_i2v_fl：占位符与 generate.js 槽位声明一致（含首尾帧素材槽）", () => {
    const tokens = extractTokens(TEMPLATE_PATH);
    assert.deepEqual(tokens.slice().sort(), EXPECTED_TOKENS);
    for (const token of tokens) {
        const isAsset = ASSET_TOKENS.includes(token);
        assert.ok(isAsset || PLAIN_TOKENS.has(token), `${token} 既不是素材槽也不是已知生成参数`);
    }
    // 首帧 / 尾帧都是素材槽（要上传 ComfyUI），否则 LoadImage 会拿到本机路径。
    assert.ok(ASSET_TOKENS.includes("FIRST_FRAME"), "FIRST_FRAME 必须是素材槽");
    assert.ok(ASSET_TOKENS.includes("LAST_FRAME"), "LAST_FRAME 必须是素材槽");
});

// ── 3. 行为层：首帧必填；尾帧/参考图可选，未给时摘除节点而非报错 ──────────────
function fakeComfy() {
    return {
        uploaded: [],
        lastGraph: null,
        async uploadFile(_buffer, filename) {
            this.uploaded.push(filename);
            return filename;
        },
        async queuePrompt(graph) {
            this.lastGraph = graph;
            return "pid-fl";
        },
        async history() {
            return { status: { status_str: "success" }, outputs: { 16: { videos: [{ filename: "out.mp4" }] } } };
        },
        async queueCounts() {
            return { running: 0, pending: 0 };
        },
        async interrupt() {},
        async view() {
            return Buffer.from("MP4");
        },
    };
}

function fakeJobs() {
    let handler = null;
    let pending = null;
    return {
        enqueue(job, run) {
            handler = run;
            pending = job;
            return { ...job, status: "queued" };
        },
        async run() {
            const ctx = { patch() {}, progress() {}, signal: new AbortController().signal };
            return handler(pending, ctx);
        },
    };
}

function makeRunner(dataDir) {
    const comfy = fakeComfy();
    const jobs = fakeJobs();
    const config = { workflowsDir: WORKFLOWS_DIR, dataDir, comfy: { timeoutMs: 60_000, pollIntervalMs: 1 } };
    return { comfy, jobs, runner: createLocalRunner({ config, comfy, jobs }) };
}

function newDir(t) {
    const dir = mkdtempSync(join(tmpdir(), "h3-fl-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("video_h3_i2v_fl：首帧必填——未给 FIRST_FRAME 时显式报错（且不牵连可选的 LAST_FRAME）", async (t) => {
    const { jobs, runner } = makeRunner(newDir(t));
    runner.submit({ kind: "video", template: TEMPLATE, params: baseParams({ FIRST_FRAME: undefined, PROMPT: "p" }) });
    await assert.rejects(jobs.run(), (error) => {
        assert.match(error.message, /缺少参数/);
        assert.match(error.message, /FIRST_FRAME/);
        assert.doesNotMatch(error.message, /LAST_FRAME/);
        return true;
    });
});

test("video_h3_i2v_fl：只给首帧也能跑——尾帧与参考图自动摘除，不报错", async (t) => {
    const { comfy, jobs, runner } = makeRunner(newDir(t));
    runner.submit({ kind: "video", template: TEMPLATE, params: baseParams() });

    const logs = [];
    const original = console.log;
    console.log = (message) => logs.push(String(message));
    try {
        await jobs.run();
    } finally {
        console.log = original;
    }

    const graph = comfy.lastGraph;
    assert.ok(graph, "应已提交渲染后的图");
    for (const id of OPTIONAL_NODE_IDS) assert.equal(graph[id], undefined, `可选的尾帧/参考图节点 ${id} 应被摘除`);
    const conditioning = conditioningOf(graph);
    assert.deepEqual(conditioning.inputs.first_frame, ["9", 0]);
    assert.equal(conditioning.inputs.last_frame, undefined, "未给尾帧时不应有 last_frame 引用");
    assert.equal(
        Object.keys(conditioning.inputs).some((key) => key.startsWith("ref_images.")),
        false,
        "未给参考图时不应有 ref_images.* 引用",
    );
    // 全图不留任何对已摘除节点的悬空引用。
    for (const [id, node] of Object.entries(graph)) {
        for (const [key, value] of Object.entries(node.inputs || {})) {
            const ref = Array.isArray(value) ? String(value[0]) : undefined;
            assert.ok(!OPTIONAL_NODE_IDS.includes(ref), `节点 ${id}.${key} 悬空引用已摘除的节点 ${ref}`);
        }
    }
    assert.match(logs.join("\n"), /未指定的参考图槽位，已摘除节点/);
});

test("video_h3_i2v_fl：给尾帧 + 2 张参考图时精确接线，多余槽位摘除", async (t) => {
    const dir = newDir(t);
    // 首尾帧与参考图都是「素材槽」，用真实本机文件走一遍上传路径。
    const writeAsset = (name) => {
        const file = join(dir, name);
        writeFileSync(file, Buffer.from("PNG"));
        return file;
    };
    const { comfy, jobs, runner } = makeRunner(dir);
    runner.submit({
        kind: "video",
        template: TEMPLATE,
        params: baseParams({
            FIRST_FRAME: writeAsset("first.png"),
            LAST_FRAME: writeAsset("last.png"),
            REF_IMAGE_1: writeAsset("ref1.png"),
            REF_IMAGE_2: writeAsset("ref2.png"),
        }),
    });
    await jobs.run();

    const graph = comfy.lastGraph;
    const conditioning = conditioningOf(graph);
    assert.deepEqual(conditioning.inputs.first_frame, ["9", 0]);
    assert.deepEqual(conditioning.inputs.last_frame, ["20", 0]);
    // REF_IMAGE_1 → ref_image_0，REF_IMAGE_2 → ref_image_1：从 0 连续，避免 autogrow 下标空洞。
    assert.deepEqual(conditioning.inputs["ref_images.ref_image_0"], ["21", 0]);
    assert.deepEqual(conditioning.inputs["ref_images.ref_image_1"], ["22", 0]);
    assert.equal(conditioning.inputs["ref_images.ref_image_2"], undefined);
    assert.equal(graph["20"].inputs.image, "last.png");
    for (const id of ["23", "24", "25", "26", "27", "28", "29"]) assert.equal(graph[id], undefined, `空参考槽节点 ${id} 应被摘除`);
    // 首尾帧与参考图都是本机素材槽，提交前应各上传一次。
    assert.deepEqual(comfy.uploaded.slice().sort(), ["first.png", "last.png", "ref1.png", "ref2.png"]);
});

// ── 4. 登记：中文标题 + D1 时长档位 ──────────────────────────────────────────
test("video_h3_i2v_fl：已登记中文标题，且档位随模板清单同源下发（D1）", () => {
    const template = listTemplates(WORKFLOWS_DIR).find((item) => item.name === TEMPLATE);
    assert.ok(template, "listTemplates 应包含新模板");
    assert.equal(template.title, "H3 首尾帧多参考图生视频");
    assert.notEqual(template.title, TEMPLATE, "必须登记中文标题，不能回退成裸模板名");
    assert.equal(template.family, "video");

    assert.deepEqual(template.durations, [5, 10, 15]);
    assert.deepEqual(durationsForTemplate(TEMPLATE), [5, 10, 15]);
    const meta = durationMetaForTemplate(TEMPLATE);
    assert.equal(meta.verified, true);
    assert.deepEqual(meta.frameCounts, { 5: 124, 10: 243, 15: 362 });
    assert.equal(meta.formula, "17k+5 @24fps（向上吸附）");
    assert.equal(template.durationMeta.frameCounts["10"], 243);
});

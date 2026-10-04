import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ASSET_TOKENS, createLocalRunner } from "../src/generate.js";
import { extractTokens } from "../src/providers/comfy.js";

/**
 * 对口型工作流（video_lipsync）与「ComfyUI 缓存命中 → /history 空 outputs」兜底的验收：
 *   - 模板参数层：只有模型无关素材槽 + 唯一输出前缀，**不得出现模型专属参数**；
 *   - 素材层：音频槽带 `input/` 前缀（VHS_LoadAudio 语义），视频槽保持裸名；
 *   - 缓存兜底：outputs 为空时按 OUTPUT_PREFIX 从输出目录**按文件名回落**取回产物（不误判失败）；
 *     未声明兜底的任务维持「无产物即失败」的旧语义。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");
const TEMPLATE = "video_lipsync";
const TEMPLATE_PATH = join(WORKFLOWS_DIR, `${TEMPLATE}.json`);

/** 允许的模型无关 token：素材槽 + 通用生成参数（与其它视频模板同口径）。 */
const PLAIN_TOKENS = new Set(["SEED", "OUTPUT_PREFIX"]);

function fakeComfy({ expectedFilename, outputs = {} } = {}) {
    return {
        uploaded: [],
        lastGraph: null,
        viewed: [],
        async uploadFile(_buffer, filename) {
            this.uploaded.push(filename);
            return filename;
        },
        async queuePrompt(graph) {
            this.lastGraph = graph;
            return "pid-lip";
        },
        // 默认模拟缓存命中：执行成功但 outputs 为空；传 outputs 时模拟正常执行。
        async history() {
            return { status: { status_str: "success" }, outputs };
        },
        async queueCounts() {
            return { running: 0, pending: 0 };
        },
        async interrupt() {},
        async view({ filename, subfolder, type }) {
            this.viewed.push({ filename, subfolder, type });
            if (expectedFilename && filename !== expectedFilename) throw new Error(`no such output: ${filename}`);
            return Buffer.from("MP4-CACHED");
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

function makeRunner(dir, comfy) {
    const jobs = fakeJobs();
    const config = { workflowsDir: WORKFLOWS_DIR, dataDir: dir, comfy: { timeoutMs: 60_000, pollIntervalMs: 1 } };
    return { jobs, runner: createLocalRunner({ config, comfy, jobs }) };
}

function newDir(t) {
    const dir = mkdtempSync(join(tmpdir(), "lipsync-cache-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** 建好素材文件（片段 + 音频），返回可直接喂给 submit 的 /api/artifacts URL。 */
function seedAssets(dir) {
    mkdirSync(join(dir, "artifacts", "assets"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "assets", "clip.mp4"), Buffer.from("VIDEO"));
    writeFileSync(join(dir, "artifacts", "assets", "cue.flac"), Buffer.from("AUDIO"));
    return { INPUT_VIDEO: "/api/artifacts/assets/clip.mp4", INPUT_AUDIO: "/api/artifacts/assets/cue.flac" };
}

test("video_lipsync 模板：只有模型无关素材槽与通用参数（内容层无模型专属参数）", () => {
    const tokens = extractTokens(TEMPLATE_PATH);
    for (const token of tokens) {
        assert.ok(ASSET_TOKENS.includes(token) || PLAIN_TOKENS.has(token), `${token} 既不是素材槽也不是通用生成参数`);
    }
    assert.ok(ASSET_TOKENS.includes("INPUT_VIDEO"), "INPUT_VIDEO 必须是素材槽（要上传 ComfyUI）");
    assert.ok(ASSET_TOKENS.includes("INPUT_AUDIO"), "INPUT_AUDIO 必须是素材槽（要上传 ComfyUI）");
    // 模型专属参数（步数/嘴部强度/帧率/静音补白/模式/节点类名）只允许出现在模板 JSON 里，不得作为 token 暴露。
    const raw = readFileSync(TEMPLATE_PATH, "utf8");
    for (const forbidden of ["INFERENCE_STEPS", "LIPS_EXPRESSION", "FPS", "SILENT_PADDING", "MODE", "NODE", "SEED_VALUE"]) {
        assert.ok(!tokens.includes(forbidden), `内容层不得暴露模型专属参数 ${forbidden}`);
    }
    assert.match(raw, /LatentSyncNode/, "真实模型参数应写在模板 JSON 里");
});

test("video_lipsync：音频槽带 input/ 前缀，视频槽保持裸名", async (t) => {
    const dir = newDir(t);
    const assets = seedAssets(dir);
    const comfy = fakeComfy({ outputs: { 5: { gifs: [{ filename: "out.mp4", subfolder: "canvas", type: "output" }] } } });
    const { jobs, runner } = makeRunner(dir, comfy);
    runner.submit({ kind: "video", template: TEMPLATE, params: { ...assets, SEED: 1, OUTPUT_PREFIX: "canvas/run_x_sh1-clip-lipsync" } });
    await jobs.run();

    assert.deepEqual(comfy.uploaded.slice().sort(), ["clip.mp4", "cue.flac"]);
    assert.equal(comfy.lastGraph["1"].inputs.video, "clip.mp4", "VHS_LoadVideo 吃裸文件名");
    assert.equal(comfy.lastGraph["2"].inputs.audio_file, "input/cue.flac", "VHS_LoadAudio 吃 input/ 前缀");
});

test("缓存命中兜底：history 无 outputs 时按 OUTPUT_PREFIX 从输出目录回落取回产物", async (t) => {
    const dir = newDir(t);
    const assets = seedAssets(dir);
    const comfy = fakeComfy({ expectedFilename: "run_x_sh1-clip-lipsync_00001-audio.mp4" });
    const { jobs, runner } = makeRunner(dir, comfy);
    runner.submit({
        kind: "video",
        template: TEMPLATE,
        params: { ...assets, SEED: 1, OUTPUT_PREFIX: "canvas/run_x_sh1-clip-lipsync", RECOVER_BY_PREFIX: true },
    });
    const result = await jobs.run();

    assert.equal(result.outputs.length, 1, "缓存命中也要拿到 1 个产物（不误判失败）");
    const out = result.outputs[0];
    assert.equal(out.recovered, true);
    assert.match(out.url, /^\/api\/artifacts\/.*run_x_sh1-clip-lipsync_00001-audio\.mp4$/);
    // 回落查询用的是「输出目录 + 预期文件名」（subfolder 从前缀目录派生）。
    assert.deepEqual(comfy.viewed[0], { filename: "run_x_sh1-clip-lipsync_00001-audio.mp4", subfolder: "canvas", type: "output" });
    assert.ok(readFileSync(join(dir, "artifacts", String(out.url.split("/")[3]), "run_x_sh1-clip-lipsync_00001-audio.mp4")).length > 0);
});

test("缓存兜底只在显式声明时生效：未声明 RECOVER_BY_PREFIX 仍按「无产物即失败」处理", async (t) => {
    const dir = newDir(t);
    const assets = seedAssets(dir);
    const comfy = fakeComfy({ expectedFilename: "run_x_sh1-clip-lipsync_00001-audio.mp4" });
    const { jobs, runner } = makeRunner(dir, comfy);
    runner.submit({ kind: "video", template: TEMPLATE, params: { ...assets, SEED: 1, OUTPUT_PREFIX: "canvas/run_x_sh1-clip-lipsync" } });
    await assert.rejects(jobs.run(), (error) => {
        assert.match(error.message, /未返回任何产物/);
        return true;
    });
    assert.equal(comfy.viewed.length, 0, "未声明兜底时不应去按名取回");
});

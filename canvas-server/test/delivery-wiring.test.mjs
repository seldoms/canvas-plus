import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildAssemblyPlan, buildConcatArgs, ffmpegAvailable } from "../src/delivery.js";
import { artifactUrl, ensureDir, safeJoin } from "../src/files.js";
import { createPipeline } from "../src/pipeline.js";

/**
 * 「片段 → 成片」闭环的接线测试：独立触发端点、片段未就绪门禁、成片信息回写 stage.artifacts、
 * 幂等、manifest/日志可追踪、失败可诊断。
 * 大部分用例用假后期执行体（记录调用 + 落盘占位产物）以便在无 ffmpeg 时也能确定性地验证编排层；
 * 真机用例走 delivery.js 的真实 ffmpeg，ffmpeg/ffprobe 缺失时 skip。
 */

const hasFfmpeg = ffmpegAvailable("ffmpeg") && ffmpegAvailable("ffprobe");

const scratch = [];
test.after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** 最小 skills 环境：只有一个 assembly 阶段，足够覆盖合成接线而无需跑任何 LLM。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-assemble-"));
    scratch.push(root);
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "05-clip-assembly"), { recursive: true });
    writeFileSync(
        join(skillsDir, "05-clip-assembly", "SKILL.md"),
        "---\nname: clip-assembly\ndescription: |\n  测试用片段合成技能说明\n---\n\n# clip-assembly\n\n## 提示词模板\n\n{{storyboard}}\n",
    );
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({ version: 1, stages: [{ id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: [], produces: "clips" }] }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { videoWidth: 64, videoHeight: 64, videoFps: 10 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

const clip = (id, extra = {}) => ({ id, shotId: `${id}-shot`, artifactUrl: `/api/artifacts/job-${id}/${id}.mp4`, durationSec: 2, status: "done", ...extra });

/** 直接写入 assembly 阶段产物（等价于「人工修订产物」入口），跳过 LLM 规划。 */
function seedAssembly(pipeline, run, clips, assembly = {}) {
    return pipeline.setStageInput(run.id, "assembly", {
        output: { clips, assembly: { order: clips.map((item) => item.id), transition: "cut", status: "queued", ...assembly } },
    });
}

function build(env, { jobs = { list: () => [], on: () => {} }, assemble } = {}) {
    return createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs, comfy: {}, llm: {}, assemble });
}

/** 假后期执行体：记录调用参数，落盘占位成片/清单/日志，返回与 delivery.assembleEpisode 同形状的结果。 */
function makeFakeAssemble(config) {
    const calls = [];
    const assemble = async (args) => {
        calls.push(args);
        const id = args.options.id;
        const dir = ensureDir(safeJoin(config.dataDir, "artifacts", id));
        const filename = `${args.episodeId}-final.mp4`;
        const outputPath = join(dir, filename);
        writeFileSync(outputPath, "fake-mp4-bytes");
        const manifestPath = join(dir, "assembly-manifest.json");
        writeFileSync(manifestPath, JSON.stringify({ status: "done", plan: { episodeId: args.episodeId, order: args.order } }, null, 2));
        const logPath = join(dir, "ffmpeg.log");
        writeFileSync(logPath, "$ ffmpeg ...\n");
        return {
            id,
            dir,
            status: "done",
            outputPath,
            url: artifactUrl(config, id, filename),
            bytes: 14,
            info: { durationSec: 4, width: 64, height: 64, hasVideo: true, hasAudio: false },
            coverUrl: artifactUrl(config, id, "cover.jpg"),
            manifestPath,
            manifestUrl: artifactUrl(config, id, "assembly-manifest.json"),
            logPath,
        };
    };
    return { assemble, calls };
}

// ---------- ① 门禁：片段未就绪拒绝合成 ----------

test("门禁：clips 未全部成功时拒绝合成并给出明确原因，不调用后期执行体", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { assemble, calls } = makeFakeAssemble(env.config);
    const pipeline = build(env, { assemble });

    const run = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run, [clip("sh1-clip"), clip("sh2-clip", { artifactUrl: null, status: "queued" })]);
    await assert.rejects(() => pipeline.assembleStage(run.id), /还有 1\/2 个片段未成功，不能合成成片：sh2-clip（queued）/);
    assert.equal(calls.length, 0, "门禁拒绝时不该触发 ffmpeg");
    assert.equal(pipeline.get(run.id).stages.assembly.output.assembly.status, "queued", "拒绝后不得改成 assembling/done");

    // 全部 done 但缺产物地址同样拒绝（不能把「没有产物」当「可拼接」）。
    const run2 = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run2, [clip("a-clip", { status: "done", artifactUrl: null })]);
    await assert.rejects(() => pipeline.assembleStage(run2.id), /a-clip 没有产物地址/);

    // 失败片段（status:error）也计入未就绪。
    const run3 = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run3, [clip("a-clip"), clip("b-clip", { status: "error", artifactUrl: null })]);
    await assert.rejects(() => pipeline.assembleStage(run3.id), /1\/2 个片段未成功.*b-clip（error）/s);

    // 还没有片段清单时给出可操作提示。
    const run4 = pipeline.create({ novel: "短篇小说" });
    await assert.rejects(() => pipeline.assembleStage(run4.id), /还没有产物/);
});

// ---------- ② 成功路径（假执行体）：回写 + artifacts ----------

test("成功回写：assembly 记录成片信息，stage.artifacts 登记成片，参数按职责交给 delivery", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { assemble, calls } = makeFakeAssemble(env.config);
    const pipeline = build(env, { assemble });
    const run = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run, [clip("sh1-clip"), clip("sh2-clip")]);

    const done = await pipeline.assembleStage(run.id, { quality: "high", transition: "fade" });
    const assembly = done.stages.assembly.output.assembly;
    assert.equal(assembly.status, "done");
    assert.equal(assembly.deliverableId, `assembly-${run.id}`);
    assert.equal(assembly.url, `/api/artifacts/assembly-${run.id}/${run.id}-final.mp4`);
    assert.match(assembly.manifestUrl, /assembly-manifest\.json$/);
    assert.match(assembly.logUrl, /ffmpeg\.log$/);
    assert.equal(assembly.info.durationSec, 4);
    assert.equal(assembly.bytes, 14);

    // 编排器只把「清单 + 参数」交给 delivery：order/transition/quality/id，ffmpeg 参数不在编排器里拼。
    assert.deepEqual(calls[0].order, ["sh1-clip", "sh2-clip"]);
    assert.equal(calls[0].transition, "fade");
    assert.equal(calls[0].options.quality, "high");
    assert.equal(calls[0].options.id, `assembly-${run.id}`);
    assert.equal(calls[0].clips.length, 2);
    assert.equal(calls[0].episodeId, run.id);

    // 成片信息确实回写 stage.artifacts，且 url 是现有产物路由的形状 /api/artifacts/<id>/<file>。
    const film = done.stages.assembly.artifacts.filter((item) => item.kind === "film");
    assert.deepEqual(film.map((item) => item.role), ["output", "manifest", "log", "cover"]);
    assert.equal(film[0].url, assembly.url);
    assert.ok(film.every((item) => item.url.startsWith(`/api/artifacts/assembly-${run.id}/`)), "成片条目应指向交付目录");
    // 片段条目仍在，成片条目是追加而非覆盖。
    assert.equal(done.stages.assembly.artifacts.filter((item) => item.url.endsWith(".mp4") && item.kind !== "film").length, 2);

    // 落盘：重新读 run.json 仍能看到成片。
    assert.equal(pipeline.get(run.id).stages.assembly.output.assembly.url, assembly.url);
});

// ---------- ③ 幂等 ----------

test("幂等：重复调用不重复拼、不覆盖已有成片；force 才重拼到新目录", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { assemble, calls } = makeFakeAssemble(env.config);
    const pipeline = build(env, { assemble });
    const run = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run, [clip("sh1-clip")]);

    const first = await pipeline.assembleStage(run.id);
    assert.equal(calls.length, 1);
    assert.equal(first.stages.assembly.output.assembly.deliverableId, `assembly-${run.id}`);

    const second = await pipeline.assembleStage(run.id);
    assert.equal(calls.length, 1, "重复调用应复用已完成的成片，不再调 ffmpeg");
    assert.equal(second.stages.assembly.output.assembly.url, first.stages.assembly.output.assembly.url);
    assert.equal(second.stages.assembly.output.assembly.deliverableId, `assembly-${run.id}`);

    const forced = await pipeline.assembleStage(run.id, { force: true });
    assert.equal(calls.length, 2, "只有 force:true 才真正重拼");
    assert.equal(forced.stages.assembly.output.assembly.deliverableId, `assembly-${run.id}-r2`);
    assert.equal(forced.stages.assembly.output.assembly.attempt, 2);
    assert.notEqual(forced.stages.assembly.output.assembly.url, first.stages.assembly.output.assembly.url);
    // 旧成片目录保留，重拼不覆盖上一次的物理产物。
    assert.ok(existsSync(join(env.config.dataDir, "artifacts", `assembly-${run.id}`)), "旧成片目录应保留");
    assert.ok(existsSync(join(env.config.dataDir, "artifacts", `assembly-${run.id}-r2`)), "重拼落到新目录");
});

test("并发保护：assembling 状态下再次触发被拒，force 例外", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const pipeline = build(env);
    const run = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run, [clip("sh1-clip")]);
    pipeline.beginAssemble(run.id); // 只起步不执行，模拟正在拼
    assert.equal(pipeline.get(run.id).stages.assembly.output.assembly.status, "assembling");
    assert.throws(() => pipeline.beginAssemble(run.id), /正在合成中/);
});

// ---------- ④ 失败可诊断 ----------

test("失败可诊断：保留清单/日志地址，错误带原因，不写成功成片 artifacts", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const failing = async (args) => {
        const id = args.options.id;
        const dir = ensureDir(safeJoin(env.config.dataDir, "artifacts", id));
        writeFileSync(join(dir, "assembly-manifest.json"), JSON.stringify({ status: "failed" }));
        const logPath = join(dir, "ffmpeg.log");
        writeFileSync(logPath, "$ ffmpeg ...\n[error] 找不到输入片段");
        throw Object.assign(new Error(`ffmpeg 退出码 1，日志：${logPath}`), { code: 1, logPath });
    };
    const pipeline = build(env, { assemble: failing });
    const run = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run, [clip("sh1-clip")]);

    const failed = await pipeline.assembleStage(run.id);
    const assembly = failed.stages.assembly.output.assembly;
    assert.equal(assembly.status, "error");
    assert.match(assembly.error, /合成成片失败：ffmpeg 退出码 1/);
    assert.match(assembly.manifestUrl, /assembly-manifest\.json$/);
    assert.match(assembly.logUrl, /ffmpeg\.log$/);
    assert.deepEqual(failed.stages.assembly.artifacts.filter((item) => item.kind === "film"), [], "失败不得登记成功成片");
    assert.equal(pipeline.stageProgress(run.id)?.phase, "failed");
});

// ---------- quality 档位映射（delivery 侧，不泄漏 ffmpeg 参数到编排器） ----------

test("quality 映射到 ffmpeg preset/crf，默认档与既有 standard 一致", () => {
    const base = { clips: [clip("a"), clip("b")], now: "t" };
    const std = buildConcatArgs(buildAssemblyPlan(base), { inputPaths: ["/x/a.mp4", "/x/b.mp4"], outputPath: "/o/f.mp4" });
    assert.equal(std[std.indexOf("-preset") + 1], "veryfast");
    assert.equal(std[std.indexOf("-crf") + 1], "20");
    assert.equal(buildAssemblyPlan(base).quality, "standard");

    const high = buildConcatArgs(buildAssemblyPlan({ ...base, quality: "high" }), { inputPaths: ["/x/a.mp4", "/x/b.mp4"], outputPath: "/o/f.mp4" });
    assert.equal(high[high.indexOf("-preset") + 1], "slow");
    assert.equal(high[high.indexOf("-crf") + 1], "18");

    assert.throws(() => buildAssemblyPlan({ ...base, quality: "ultra" }), /不支持的成片质量/);
});

// ---------- 真机：真实 ffmpeg 拼出可解析成片 ----------

/** 用 ffmpeg 造一段纯色测试片段（不依赖外部素材）。 */
function makeClip(path, { size = "64x64", color = "red", duration = 1 } = {}) {
    const args = ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=10:d=${duration}`, "-pix_fmt", "yuv420p", "-c:v", "libx264", path];
    const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return path;
}

test("真机：assembleStage 走真实 ffmpeg 产出可解析成片并回写（ffmpeg 缺失时 skip）", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const artDir = ensureDir(join(env.config.dataDir, "artifacts"));
    makeClip(join(ensureDir(join(artDir, "job-a")), "a.mp4"), { color: "red", duration: 1 });
    makeClip(join(ensureDir(join(artDir, "job-b")), "b.mp4"), { size: "96x48", color: "blue", duration: 1 });

    const pipeline = build(env); // 默认执行体 = delivery.assembleEpisode
    const run = pipeline.create({ novel: "短篇小说" });
    seedAssembly(pipeline, run, [
        clip("sh1-clip", { artifactUrl: "/api/artifacts/job-a/a.mp4", durationSec: 1 }),
        clip("sh2-clip", { artifactUrl: "/api/artifacts/job-b/b.mp4", durationSec: 1 }),
    ]);

    const done = await pipeline.assembleStage(run.id);
    const assembly = done.stages.assembly.output.assembly;
    const dir = join(artDir, `assembly-${run.id}`);
    assert.equal(assembly.status, "done");
    assert.ok(existsSync(join(dir, `${run.id}-final.mp4`)), "成片文件应落盘");
    assert.ok(assembly.bytes > 0);
    assert.equal(assembly.info.hasVideo, true);
    assert.equal(assembly.info.width, 64, "异尺寸片段应被统一到目标尺寸");
    assert.ok(assembly.info.durationSec > 1.5, `成片时长应接近 2s，实际 ${assembly.info.durationSec}`);
    assert.ok(existsSync(join(dir, "ffmpeg.log")), "ffmpeg 日志应保留");
    const manifest = JSON.parse(readFileSync(join(dir, "assembly-manifest.json"), "utf8"));
    assert.equal(manifest.status, "done");
    assert.deepEqual(manifest.plan.clips.map((item) => item.id), ["sh1-clip", "sh2-clip"]);
    assert.equal(manifest.output.url, assembly.url);
    assert.ok(assembly.coverUrl, "默认应产出封面");
});

// ---------- HTTP 端点：门禁 400 / 幂等复用 200 / 成片 url 经产物路由可访问 ----------

test("HTTP：端点门禁 400、幂等复用 200，成片 url 经 /api/artifacts 可访问", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-assemble-http-"));
    const env = makeEnv();
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
        rmSync(env.root, { recursive: true, force: true });
    });
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = env.skillsDir;
    const mod = await import("../src/index.js");
    assert.equal(typeof mod.pipeline.beginAssemble, "function");
    assert.equal(typeof mod.pipeline.assembleStage, "function");

    const run = mod.pipeline.create({ novel: "短篇小说" });
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const port = mod.server.address().port;
    const endpoint = `http://127.0.0.1:${port}/api/pipeline/runs/${run.id}/steps/assembly/assemble`;
    try {
        // 门禁：clips 未就绪 → 400 + 明确原因。
        mod.pipeline.setStageInput(run.id, "assembly", {
            output: { clips: [{ id: "c1", status: "queued", artifactUrl: null, durationSec: 2 }], assembly: { order: ["c1"], transition: "cut", status: "queued" } },
        });
        const gated = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(gated.status, 400);
        assert.match((await gated.json()).error.message, /未成功/);

        // 幂等复用：已成片 → 200 reused，且成片 url 走现有产物路由可访问。
        const id = `assembly-${run.id}`;
        const filename = `${run.id}-final.mp4`;
        ensureDir(safeJoin(mod.config.dataDir, "artifacts", id));
        writeFileSync(join(safeJoin(mod.config.dataDir, "artifacts", id), filename), "stub-mp4");
        mod.pipeline.setStageInput(run.id, "assembly", {
            output: {
                clips: [{ id: "c1", status: "done", artifactUrl: "/api/artifacts/job-a/a.mp4", durationSec: 2 }],
                assembly: { order: ["c1"], transition: "cut", status: "done", deliverableId: id, url: `/api/artifacts/${id}/${filename}` },
            },
        });
        const reused = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(reused.status, 200);
        const body = await reused.json();
        assert.equal(body.reused, true);
        assert.equal(body.assembly.url, `/api/artifacts/${id}/${filename}`);

        const film = await fetch(`http://127.0.0.1:${port}${body.assembly.url}`);
        assert.equal(film.status, 200, "成片 url 应能被 /api/artifacts 路由解析");
        assert.equal(await film.text(), "stub-mp4");

        // 未知 run → 400（与 /run 系列的参数错误口径一致）。
        const missing = await fetch(`http://127.0.0.1:${port}/api/pipeline/runs/run-nope/steps/assembly/assemble`, { method: "POST" });
        assert.equal(missing.status, 400);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

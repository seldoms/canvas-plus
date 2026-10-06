/**
 * 成片响度归一（EBU R128）测试 —— 分「逐段」与「整片」两档。
 *
 * 为什么要做：H3 每段独立生成，段间响度会漂。2026-10-06 实测两段差 6.8dB
 * （RMS -44.6 vs -51.4），而 cut 档音轨是**硬接**的（acrossfade 只在转场档走），
 * 观众会听到明显音量跳变。接缝 QC 也量到 rmsStepDb=5.9。
 *
 * 关键结论（真机 ffmpeg 实测）：**只在末端做一次 loudnorm 解决不了段间差**——
 * 它把整片拉到 -16，但段间相对差原样保留（实测归一后仍差 5.8dB）。
 * 必须在 concat **之前逐段归一**：实测段间差降到 0.1dB，整体 I=-16.0 LUFS。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAssemblyPlan, buildConcatArgs, buildLoudnormChain } from "../src/delivery.js";

const clip = (id, extra = {}) => ({ id, shotId: `${id}-shot`, artifactUrl: `/api/artifacts/job-${id}/${id}.mp4`, durationSec: 2, ...extra });

const CLIPS = [clip("a"), clip("b")];

function planOf(extra = {}) {
    return buildAssemblyPlan({ episodeId: "ep_1", clips: CLIPS, order: ["a", "b"], ...extra });
}

function filterOf(plan, { audioPaths = [], normalizeClips } = {}) {
    const opts = { inputPaths: ["/x/a1.mp4", "/x/a2.mp4"], audioPaths, outputPath: "/out.mp4" };
    if (normalizeClips !== undefined) opts.normalizeClips = normalizeClips;
    const args = buildConcatArgs(plan, opts);
    return args[args.indexOf("-filter_complex") + 1];
}

test("默认开启两档，且逐段默认跟随整片（同为 -16 LUFS）", () => {
    const plan = planOf();
    assert.deepEqual(plan.loudnorm, { i: -16, lra: 11, tp: -1.5 });
    assert.deepEqual(buildLoudnormChain(plan, "master"), ["loudnorm=I=-16:LRA=11:TP=-1.5"]);
    // 未显式给 clipI 时逐段跟随整片——只调 i 时两档一起变，符合直觉
    assert.deepEqual(buildLoudnormChain(plan, "clip"), ["loudnorm=I=-16:LRA=11:TP=-1.5"]);
});

test("loudnorm=false 两档一起关闭", () => {
    const plan = planOf({ loudnorm: false });
    assert.equal(plan.loudnorm, null);
    assert.deepEqual(buildLoudnormChain(plan, "master"), []);
    assert.deepEqual(buildLoudnormChain(plan, "clip"), []);
});

test("可覆盖整片目标值（分级输出）", () => {
    const plan = planOf({ loudnorm: { i: -23, tp: -2 } });
    assert.deepEqual(buildLoudnormChain(plan, "master"), ["loudnorm=I=-23:LRA=11:TP=-2"]);
    // 未单独指定 clipI 时逐段跟随整片目标
    assert.deepEqual(buildLoudnormChain(plan, "clip"), ["loudnorm=I=-23:LRA=11:TP=-2"]);
});

test("逐段档可独立覆盖（片段动态范围与整片不同时）", () => {
    const plan = planOf({ loudnorm: { i: -16, clipI: -20 } });
    assert.deepEqual(buildLoudnormChain(plan, "master"), ["loudnorm=I=-16:LRA=11:TP=-1.5"]);
    assert.deepEqual(buildLoudnormChain(plan, "clip"), ["loudnorm=I=-20:LRA=11:TP=-1.5"]);
});

test("每个片段在 concat 之前各自归一（这是解决段间跳变的关键位置）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }));
    // 两个片段各一次 + 整片一次 = 3 次
    assert.equal((filter.match(/loudnorm=/g) || []).length, 3, "应逐段 2 次 + 整片 1 次");
    assert.match(filter, /\[0:a\]aresample=44100,aformat=[^,]+,loudnorm=I=-16[^[]*\[ca0\]/);
    assert.match(filter, /\[1:a\]aresample=44100,aformat=[^,]+,loudnorm=I=-16[^[]*\[ca1\]/);
    // 逐段归一必须在 concat 之前
    assert.ok(filter.indexOf("loudnorm=I=-16") < filter.indexOf("concat="), "逐段归一应在 concat 之前");
});

test("整片归一在 apad 之后（顺序关键）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }));
    const iPad = filter.indexOf("apad");
    const iMaster = filter.lastIndexOf("loudnorm=");
    assert.ok(iPad >= 0 && iMaster >= 0, "apad 与整片归一都必须在");
    assert.ok(iPad < iMaster, "整片归一必须在 apad 之后——先补静音再归一，否则尾部静音会拉偏测量");
});

test("normalizeClips=false 退回旧行为（逐段不归一，只剩整片）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }), { normalizeClips: false });
    assert.equal((filter.match(/loudnorm=/g) || []).length, 1, "只应剩整片归一");
    assert.match(filter, /\[acat\]apad\[apadded\];\[apadded\]loudnorm=I=-16/);
});

test("独立对白轨：amix → apad → 整片归一（逐段归一不作用于外部轨）", () => {
    const filter = filterOf(planOf({ audio: [{ shotId: "a-shot", ref: "/api/t1.wav" }, { shotId: "b-shot", ref: "/api/t2.wav" }] }), { audioPaths: ["/x/t1.wav", "/x/t2.wav"] });
    const iAmix = filter.indexOf("amix=");
    const iPad = filter.indexOf("apad");
    const iLoud = filter.lastIndexOf("loudnorm=");
    assert.ok(iAmix >= 0 && iPad >= 0 && iLoud >= 0, "三段都必须在");
    assert.ok(iAmix < iPad && iPad < iLoud, "顺序必须是 amix → apad → 整片归一");
    assert.match(filter, /\[amixed\]apad\[apadded\];\[apadded\]loudnorm=/);
});

test("无音轨时不产生任何 loudnorm", () => {
    const filter = filterOf(planOf());
    assert.ok(!filter.includes("loudnorm"), "没有音频就不该插 loudnorm filter");
});

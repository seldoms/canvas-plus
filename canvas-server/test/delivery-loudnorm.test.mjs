/**
 * 成片音频后处理测试：响度归一（逐段 + 整片两档）与 cut 档接缝淡化。
 *
 * 为什么要做（全部真机实测，非推断）：
 * - 用M3.5 真机跑出的两段产物实测：段0 RMS -44.6dB、段1 RMS -51.4dB，
 *   **段间差 6.8dB**；接缝 QC 独立量到 rmsStepDb=5.9。
 * - cut 档（默认）音轨走 concat **硬接**（acrossfade 只在转场档走），
 *   观众会听到音量跳变。
 * - 关键结论：**只在末端做一次 loudnorm 解决不了段间差**——它把整片拉到
 *   目标值，但段间相对差原样保留（实测归一后仍差 5.8dB）。必须逐段归一。
 * - 逐段归一后仍有段内突变：接缝处 50ms 窗口 RMS 从 -11.4dB 掉到 -18.7dB
 *   （落差 7.3dB，因为前段结尾有对白、后段开头是环境音），听感是「咔」一声。
 *   故再加极短（默认 30ms）接缝淡入淡出。
 *
 * 真机验证（同一对产物，ffmpeg 实跑）：段间差 6.8dB → 0.1dB，整体 I = -16.0 LUFS。
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
    // 输入数必须与 plan.clips 数一致，否则 buildConcatArgs 直接抛「输入文件数与清单片段数不一致」
    const inputPaths = (plan.clips || []).map((c) => `/x/${c.id}.mp4`);
    const opts = { inputPaths, audioPaths, outputPath: "/out.mp4" };
    if (normalizeClips !== undefined) opts.normalizeClips = normalizeClips;
    const args = buildConcatArgs(plan, opts);
    return args[args.indexOf("-filter_complex") + 1];
}

// ---------- 响度归一 ----------

test("默认开启两档，且逐段默认跟随整片（同为 -16 LUFS）", () => {
    const plan = planOf();
    assert.deepEqual(plan.loudnorm, { i: -16, lra: 11, tp: -1.5 });
    assert.deepEqual(buildLoudnormChain(plan, "master"), ["loudnorm=I=-16:LRA=11:TP=-1.5"]);
    assert.deepEqual(buildLoudnormChain(plan, "clip"), ["loudnorm=I=-16:LRA=11:TP=-1.5"]);
});

test("loudnorm=false 两档一起关闭", () => {
    const plan = planOf({ loudnorm: false });
    assert.equal(plan.loudnorm, null);
    assert.deepEqual(buildLoudnormChain(plan, "master"), []);
    assert.deepEqual(buildLoudnormChain(plan, "clip"), []);
});

test("可覆盖整片目标值（分级输出），逐段跟随", () => {
    const plan = planOf({ loudnorm: { i: -23, tp: -2 } });
    assert.deepEqual(buildLoudnormChain(plan, "master"), ["loudnorm=I=-23:LRA=11:TP=-2"]);
    assert.deepEqual(buildLoudnormChain(plan, "clip"), ["loudnorm=I=-23:LRA=11:TP=-2"]);
});

test("逐段档可独立覆盖（片段动态范围与整片不同时）", () => {
    const plan = planOf({ loudnorm: { i: -16, clipI: -20 } });
    assert.deepEqual(buildLoudnormChain(plan, "master"), ["loudnorm=I=-16:LRA=11:TP=-1.5"]);
    assert.deepEqual(buildLoudnormChain(plan, "clip"), ["loudnorm=I=-20:LRA=11:TP=-1.5"]);
});

test("每个片段在 concat 之前各自归一（解决段间跳变的关键位置）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }));
    assert.equal((filter.match(/loudnorm=/g) || []).length, 3, "应逐段 2 次 + 整片 1 次");
    assert.ok(filter.indexOf("loudnorm=I=-16") < filter.indexOf("concat="), "逐段归一应在 concat 之前");
});

test("整片归一在 apad 之后（顺序关键）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }));
    assert.ok(filter.indexOf("apad") < filter.lastIndexOf("loudnorm="), "整片归一必须在 apad 之后");
});

test("normalizeClips=false 退回旧行为（逐段不归一，只剩整片）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }), { normalizeClips: false });
    assert.equal((filter.match(/loudnorm=/g) || []).length, 1, "只应剩整片归一");
});

test("独立对白轨：amix → apad → 整片归一（逐段归一不作用于外部轨）", () => {
    const filter = filterOf(planOf({ audio: [{ shotId: "a-shot", ref: "/api/t1.wav" }, { shotId: "b-shot", ref: "/api/t2.wav" }] }), { audioPaths: ["/x/t1.wav", "/x/t2.wav"] });
    assert.ok(filter.indexOf("amix=") < filter.indexOf("apad"), "amix → apad");
    assert.ok(filter.indexOf("apad") < filter.lastIndexOf("loudnorm="), "apad → 整片归一");
});

test("无音轨时不产生任何 loudnorm", () => {
    assert.ok(!filterOf(planOf()).includes("loudnorm"));
});

// ---------- cut 档接缝淡化 ----------

test("cut 档：首段只淡出、末段只淡入（不越界、不截断）", () => {
    const filter = filterOf(planOf({ includeClipAudio: true }));
    assert.match(filter, /\[ca0\]afade=t=out:[^[]*\[cf0\]/, "首段不做淡入（避免开头凭空渐入）");
    assert.match(filter, /\[ca1\]afade=t=in:[^[]*\[cf1\]/, "末段不做淡出（避免结尾被截）");
    assert.ok(filter.indexOf("afade") < filter.indexOf("concat="), "淡化必须在 concat 之前");
});

test("中间段首尾都淡化（3 段 + 有时长时验证完整语义）", () => {
    const three = buildAssemblyPlan({ episodeId: "ep", clips: [clip("a"), clip("b"), clip("c")], order: ["a", "b", "c"], includeClipAudio: true });
    const filter = filterOf(three);
    // clip() 默认带 durationSec=2，所以中间段应有淡入 + 淡出
    assert.match(filter, /\[ca1\]afade=t=in:[^,]+,afade=t=out:[^[]*\[cf1\]/, "中间段应有淡入+淡出");
    assert.match(filter, /\[ca0\]afade=t=out:[^[]*\[cf0\]/, "首段只淡出");
    assert.match(filter, /\[ca2\]afade=t=in:[^[]*\[cf2\]/, "末段只淡入");
});

test("cut 档 plan 的 durationSec 允许为 null，此时只淡入（assembleEpisode 会用探测值回填）", () => {
    // 这是纯函数层的真实契约：buildConcatArgs 拿不到探测结果，
    // 只有 assembleEpisode 走 probeMedia 才会把真实时长回填进 plan.clips。
    const three = buildAssemblyPlan({ episodeId: "ep", clips: [{ id: "a", shotId: "as", artifactUrl: "/api/a.mp4" }, { id: "b", shotId: "bs", artifactUrl: "/api/b.mp4" }, { id: "c", shotId: "cs", artifactUrl: "/api/c.mp4" }], order: ["a", "b", "c"], includeClipAudio: true });
    assert.deepEqual(three.clips.map((c) => c.durationSec), [null, null, null], "cut 档确实允许 null");
    const filter = filterOf(three);
    assert.ok(!filter.includes("undefined"), "不能产生 undefined 参数");
    // 首段没时长→ 跳过淡出；末段只有淡入
    assert.match(filter, /\[ca2\]afade=t=in:/, "末段淡入仍在");
    assert.ok(!filter.includes("st=null"), "不能把 null 拼进 filter");
});

test("seamFadeMs=0 可关闭接缝淡化（回到硬接）", () => {
    assert.ok(!filterOf(planOf({ includeClipAudio: true, seamFadeMs: 0 })).includes("afade"));
});

test("片段时长缺失时跳过淡出且filter 串里无 undefined（宁可少一次淡出）", () => {
    const plan = planOf({ includeClipAudio: true });
    const noDuration = { ...plan, clips: plan.clips.map((c) => ({ ...c, durationSec: undefined })) };
    const filter = filterOf(noDuration);
    assert.ok(!filter.includes("undefined"), "filter 串里不能出现 undefined");
    assert.match(filter, /\[ca1\]afade=t=in:/, "淡入仍应保留");
});

test("片段过短（时长≤ 2×fade）时跳过淡出，避免 st+d 越界导致 ffmpeg 退出码 234", () => {
    const short = buildAssemblyPlan({ episodeId: "ep", clips: [clip("a", { durationSec: 0.05 }), clip("b")], order: ["a", "b"], includeClipAudio: true });
    const filter = filterOf(short);
    assert.ok(!filter.includes("undefined"));
    // 首段只有淡出，但时长不足时应被跳过
    assert.ok(!/\[ca0\]afade=t=out:st=-/.test(filter), "不能产生负的 st");
});

test("单段成片不做任何接缝淡化（两头都是片边界）", () => {
    const single = buildAssemblyPlan({ episodeId: "ep", clips: [clip("solo")], order: ["solo"], includeClipAudio: true });
    const args = buildConcatArgs(single, { inputPaths: ["/x/solo.mp4"], outputPath: "/out.mp4" });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.ok(!filter.includes("afade"), `单段不该有afade，实际：${filter}`);
});

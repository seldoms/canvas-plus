import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    assembleEpisode,
    buildAssemblyPlan, shouldIncludeClipAudio,
    buildConcatArgs,
    buildCoverArgs,
    clipStartOffsets,
    ffmpegAvailable,
    probeMedia,
    resolveMediaPath,
} from "../src/delivery.js";

const hasFfmpeg = ffmpegAvailable("ffmpeg") && ffmpegAvailable("ffprobe");
const tmp = mkdtempSync(join(tmpdir(), "delivery-test-"));
/** 真机用例的临时目录：跑完统一清掉，避免在 /tmp 留一堆测试片段。 */
const scratch = [];
const makeScratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
};
test.after(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const config = { dataDir: tmp, pipeline: { videoWidth: 64, videoHeight: 64, videoFps: 10 } };
const clip = (id, extra = {}) => ({ id, shotId: `${id}-shot`, artifactUrl: `/api/artifacts/job-${id}/${id}.mp4`, durationSec: 2, ...extra });

// ---------- 纯函数：拼接清单 ----------

test("buildAssemblyPlan 按 order 重排片段并保留追溯字段", () => {
    const plan = buildAssemblyPlan({
        episodeId: "ep_0001",
        clips: [clip("sh1-clip"), clip("sh2-clip"), clip("sh3-clip")],
        order: ["sh3-clip", "sh1-clip", "sh2-clip"],
        transition: "cut",
        now: "2026-10-03T00:00:00.000Z",
    });
    assert.equal(plan.version, 1);
    assert.equal(plan.episodeId, "ep_0001");
    assert.equal(plan.createdAt, "2026-10-03T00:00:00.000Z");
    assert.deepEqual(plan.clips.map((item) => item.id), ["sh3-clip", "sh1-clip", "sh2-clip"]);
    assert.deepEqual(plan.clips.map((item) => item.index), [0, 1, 2]);
    assert.equal(plan.clips[0].ref, "/api/artifacts/job-sh3-clip/sh3-clip.mp4");
    assert.equal(plan.clips[0].shotId, "sh3-clip-shot");
    assert.equal(plan.clips[0].durationSec, 2);
    assert.equal(plan.transitionDurationSec, 0);
});

test("buildAssemblyPlan 缺省 order 时按传入顺序，转场默认 cut", () => {
    const plan = buildAssemblyPlan({ clips: [clip("a"), clip("b")], now: "t" });
    assert.deepEqual(plan.clips.map((item) => item.id), ["a", "b"]);
    assert.equal(plan.transition, "cut");
    assert.equal(plan.width, 768);
    assert.equal(plan.height, 1344);
    assert.equal(plan.fps, 24);
});

test("buildAssemblyPlan 空列表 / 非数组都报错，不静默成功", () => {
    assert.throws(() => buildAssemblyPlan({ clips: [], now: "t" }), /拼接清单为空/);
    assert.throws(() => buildAssemblyPlan({ clips: null, now: "t" }), /拼接清单为空/);
});

test("buildAssemblyPlan 片段缺产物报错（片段没生成完不算成片）", () => {
    assert.throws(
        () => buildAssemblyPlan({ clips: [clip("a"), clip("b", { artifactUrl: null })], now: "t" }),
        /片段 b 还没有产物/,
    );
});

test("buildAssemblyPlan 顺序缺项 / 重复 / 引用不存在都报错", () => {
    const clips = [clip("a"), clip("b"), clip("c")];
    assert.throws(() => buildAssemblyPlan({ clips, order: ["a", "b"], now: "t" }), /与片段总数 3 不一致/);
    assert.throws(() => buildAssemblyPlan({ clips, order: ["a", "b", "b"], now: "t" }), /与片段总数|重复|重复片段/);
    assert.throws(() => buildAssemblyPlan({ clips, order: ["a", "b", "x"], now: "t" }), /不存在的片段：x/);
});

test("buildAssemblyPlan 片段 id 重复报错", () => {
    assert.throws(() => buildAssemblyPlan({ clips: [clip("a"), clip("a")], now: "t" }), /id 重复：a/);
});

test("buildAssemblyPlan 转场：不支持的转场、缺时长、转场时长过长都报错", () => {
    assert.throws(() => buildAssemblyPlan({ clips: [clip("a")], transition: "wipe", now: "t" }), /不支持的转场/);
    assert.throws(
        () => buildAssemblyPlan({ clips: [clip("a", { durationSec: null }), clip("b")], transition: "fade", now: "t" }),
        /缺少有效 durationSec/,
    );
    assert.throws(
        () => buildAssemblyPlan({ clips: [clip("a", { durationSec: 1 }), clip("b")], transition: "fade", transitionDurationSec: 1, now: "t" }),
        /不小于最短片段/,
    );
});

// ---------- 纯函数：ffmpeg 命令构造 ----------

test("buildConcatArgs（cut）统一规格后 concat，不依赖片段编码一致", () => {
    const plan = buildAssemblyPlan({ clips: [clip("a"), clip("b")], transition: "cut", width: 64, height: 64, fps: 10, now: "t" });
    const args = buildConcatArgs(plan, { inputPaths: ["/x/a.mp4", "/x/b.mp4"], outputPath: "/out/final.mp4" });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /\[0:v\]scale=64:64:force_original_aspect_ratio=decrease,pad=64:64/);
    assert.match(filter, /\[1:v\]scale=64:64/);
    assert.match(filter, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vcat\]/);
    assert.match(filter, /fps=10/);
    assert.deepEqual(args.slice(0, 5), ["-y", "-i", "/x/a.mp4", "-i", "/x/b.mp4"]);
    assert.ok(args.includes("-map") && args[args.indexOf("-map") + 1] === "[vcat]");
    assert.ok(args.includes("libx264"));
    assert.equal(args.at(-1), "/out/final.mp4");
});

test("buildConcatArgs（cut）单片段也走 concat，不算错", () => {
    const plan = buildAssemblyPlan({ clips: [clip("a")], now: "t" });
    const args = buildConcatArgs(plan, { inputPaths: ["/x/a.mp4"], outputPath: "/out/final.mp4" });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /concat=n=1:v=1:a=0\[vcat\]/);
});

test("buildConcatArgs（fade）用 xfade 并按累计时长算 offset", () => {
    const plan = buildAssemblyPlan({
        clips: [clip("a", { durationSec: 2 }), clip("b", { durationSec: 3 }), clip("c", { durationSec: 4 })],
        transition: "fade",
        transitionDurationSec: 0.5,
        now: "t",
    });
    const args = buildConcatArgs(plan, { inputPaths: ["/x/a.mp4", "/x/b.mp4", "/x/c.mp4"], outputPath: "/out/final.mp4" });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /\[v0\]\[v1\]xfade=transition=fade:duration=0.5:offset=1.500\[x1\]/);
    assert.match(filter, /\[x1\]\[v2\]xfade=transition=fade:duration=0.5:offset=4.000\[vcat\]/);
    assert.ok(!filter.includes("concat="));
});

test("buildConcatArgs 外部音轨走 amix，字幕烧入接在最终视频标签后", () => {
    const plan = buildAssemblyPlan({
        clips: [clip("a"), clip("b")],
        audio: ["/x/bgm.mp3", "/x/vo.mp3"],
        subtitles: "/x/sub.srt",
        now: "t",
    });
    const args = buildConcatArgs(plan, { inputPaths: ["/x/a.mp4", "/x/b.mp4"], audioPaths: ["/x/bgm.mp3", "/x/vo.mp3"], outputPath: "/out/final.mp4" });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /\[2:a\]aresample=44100\[a0\]/);
    assert.match(filter, /\[3:a\]aresample=44100\[a1\]/);
    assert.match(filter, /\[a0\]\[a1\]amix=inputs=2:duration=longest:normalize=0\[amixed\];\[amixed\]apad\[apadded\];\[apadded\]loudnorm=I=-16:LRA=11:TP=-1\.5\[aout\]/);
    assert.match(filter, /\[vcat\]subtitles=filename='\/x\/sub.srt'\[vsub\]/);
    assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 5), ["-map", "[vsub]", "-map", "[aout]", "-shortest"]);
    assert.ok(args.includes("aac"));
});

test("buildConcatArgs 输入数与片段数不一致报错", () => {
    const plan = buildAssemblyPlan({ clips: [clip("a"), clip("b")], now: "t" });
    assert.throws(() => buildConcatArgs(plan, { inputPaths: ["/x/a.mp4"], outputPath: "/out/final.mp4" }), /不一致/);
});

// ---------- 路径 B：TTS 音轨按镜头时间轴混入成片 ----------

const shotClip = (id, shotId, durationSec) => ({ id, shotId, artifactUrl: `/api/artifacts/job-${id}/${id}.mp4`, durationSec });

test("clipStartOffsets：cut 按累计时长，转场扣重叠", () => {
    const cut = clipStartOffsets({ clips: [{ durationSec: 2 }, { durationSec: 3 }, { durationSec: 4 }], transition: "cut" });
    assert.deepEqual(cut, [0, 2000, 5000]);
    const fade = clipStartOffsets({ clips: [{ durationSec: 2 }, { durationSec: 3 }, { durationSec: 4 }], transition: "fade", transitionDurationSec: 0.5 });
    assert.deepEqual(fade, [0, 1500, 4000]);
});

test("buildAssemblyPlan 把音轨按镜头时间轴落到成片绝对延迟（cut）", () => {
    const plan = buildAssemblyPlan({
        clips: [shotClip("c1", "sh1", 2), shotClip("c2", "sh2", 3), shotClip("c3", "sh3", 4)],
        transition: "cut",
        audio: [
            { ref: "/a/sh2.flac", shotId: "sh2", startSec: 0.5, cueId: "cue2" },
            { ref: "/a/sh3.flac", shotId: "sh3" },
        ],
        now: "t",
    });
    assert.equal(plan.audio.length, 2);
    assert.equal(plan.audio[0].ref, "/a/sh2.flac");
    assert.equal(plan.audio[0].cueId, "cue2");
    assert.equal(plan.audio[0].delayMs, 2500, "sh2 起点 2s + 镜头内 0.5s");
    assert.equal(plan.audio[1].delayMs, 5000, "sh3 起点 5s");
});

test("buildAssemblyPlan 转场档音轨延迟扣掉转场重叠", () => {
    const plan = buildAssemblyPlan({
        clips: [shotClip("c1", "sh1", 2), shotClip("c2", "sh2", 3)],
        transition: "fade",
        transitionDurationSec: 0.5,
        audio: [{ ref: "/a/sh2.flac", shotId: "sh2", startSec: 0.2 }],
        now: "t",
    });
    assert.equal(plan.audio[0].delayMs, 1700, "sh2 起点 = 2 - 1×0.5，再加 0.2s");
});

test("buildAssemblyPlan 无音频/空 ref 的镜头不进混音，且不因此报错", () => {
    const plan = buildAssemblyPlan({
        clips: [shotClip("c1", "sh1", 2), shotClip("c2", "sh2", 2), shotClip("c3", "sh3", 2)],
        transition: "cut",
        audio: [
            { ref: "", shotId: "sh2" },
            { shotId: "sh3" },
            "/a/sh1.flac",
        ],
        now: "t",
    });
    assert.deepEqual(plan.audio.map((item) => item.ref), ["/a/sh1.flac"]);
    assert.equal(plan.audio[0].delayMs, 0);
});

test("buildConcatArgs 每轨按 delayMs 施加 adelay，混音轨补静音到视频等长", () => {
    const plan = buildAssemblyPlan({
        clips: [shotClip("c1", "sh1", 2), shotClip("c2", "sh2", 3)],
        transition: "cut",
        audio: [
            { ref: "/a/sh1.flac", shotId: "sh1" },
            { ref: "/a/sh2.flac", shotId: "sh2", startSec: 0.25, gainDb: -3 },
        ],
        now: "t",
    });
    const args = buildConcatArgs(plan, { inputPaths: ["/x/c1.mp4", "/x/c2.mp4"], audioPaths: ["/a/sh1.flac", "/a/sh2.flac"], outputPath: "/out/final.mp4" });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /\[2:a\]aresample=44100\[a0\]/, "延迟 0 不加 adelay");
    assert.match(filter, /\[3:a\]adelay=2250\|2250,aresample=44100,volume=-3dB\[a1\]/);
    assert.match(filter, /\[a0\]\[a1\]amix=inputs=2:duration=longest:normalize=0\[amixed\];\[amixed\]apad\[apadded\];\[apadded\]loudnorm=I=-16:LRA=11:TP=-1\.5\[aout\]/);
    assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 5), ["-map", "[vcat]", "-map", "[aout]", "-shortest"]);
});

test("真机：TTS 音轨按镜头时间轴混入，短音轨不截短成片（无音频镜头不失败）", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("delivery-shot-audio-");
    const a = makeClip(join(dir, "sh1.mp4"), { color: "red", duration: 1 });
    const b = makeClip(join(dir, "sh2.mp4"), { color: "blue", duration: 2 });
    const vo = join(dir, "sh1.flac");
    const voResult = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=0.6", vo], { encoding: "utf8" });
    assert.equal(voResult.status, 0, voResult.stderr);

    const result = await assembleEpisode({
        config: { dataDir: dir, pipeline: config.pipeline },
        clips: [
            { id: "c1", shotId: "sh1", artifactUrl: a, durationSec: 1 },
            { id: "c2", shotId: "sh2", artifactUrl: b, durationSec: 2 },
        ],
        transition: "cut",
        options: { id: "shot-audio-delivery", audio: [{ ref: vo, shotId: "sh1", startSec: 0.2 }] },
    });

    assert.equal(result.status, "done");
    assert.equal(result.info.hasAudio, true, "成片应带混入的对白音轨");
    assert.ok(result.info.durationSec > 2.8, `短对白不得截短成片，实际 ${result.info.durationSec}`);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.plan.audio[0].delayMs, 200, "延迟应为镜头1起点 0 + 0.2s");
    assert.ok(manifest.commands[0].includes("adelay=200|200"), "真实 ffmpeg 命令应含 adelay");
});

test("buildCoverArgs 抽单帧", () => {
    assert.deepEqual(buildCoverArgs({ inputPath: "/out/final.mp4", outputPath: "/out/cover.jpg", atSec: 3 }), [
        "-y", "-ss", "3", "-i", "/out/final.mp4", "-frames:v", "1", "-q:v", "2", "/out/cover.jpg",
    ]);
    assert.throws(() => buildCoverArgs({ inputPath: "/out/final.mp4" }), /需要输入与输出路径/);
});

test("resolveMediaPath 解析网关产物地址，拒绝远端 URL 与空值", () => {
    assert.equal(resolveMediaPath(config, "/api/artifacts/job-1/a.mp4"), join(tmp, "artifacts", "job-1", "a.mp4"));
    assert.throws(() => resolveMediaPath(config, "https://example.com/a.mp4"), /暂不支持远端 URL/);
    assert.throws(() => resolveMediaPath(config, ""), /缺少产物地址/);
});

// ---------- 真机：用 ffmpeg 生成的极小视频做一次真实拼接 ----------

/** 用 ffmpeg 造一段纯色测试片段（不依赖任何外部素材）。 */
function makeClip(path, { size = "64x64", color = "red", duration = 1 } = {}) {
    const args = ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=10:d=${duration}`, "-pix_fmt", "yuv420p", "-c:v", "libx264", path];
    const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return path;
}

test("真机：assembleEpisode 拼接两段（含异尺寸片段）并产出可解析成片", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("delivery-real-");
    const a = makeClip(join(dir, "sh1.mp4"), { size: "64x64", color: "red", duration: 1 });
    const b = makeClip(join(dir, "sh2.mp4"), { size: "96x48", color: "blue", duration: 1 });

    const result = await assembleEpisode({
        config: { dataDir: dir, pipeline: config.pipeline },
        episodeId: "ep_0001",
        clips: [
            { id: "sh1-clip", shotId: "sh1", artifactUrl: a, durationSec: 1 },
            { id: "sh2-clip", shotId: "sh2", artifactUrl: b, durationSec: 1 },
        ],
        order: ["sh1-clip", "sh2-clip"],
        options: { id: "ep1-delivery" },
    });

    assert.equal(result.status, "done");
    assert.ok(existsSync(result.outputPath), "成片文件应存在");
    assert.ok(result.bytes > 0);
    assert.match(result.url, /^\/api\/artifacts\/ep1-delivery\//);
    assert.equal(result.info.hasVideo, true);
    assert.ok(result.info.durationSec > 1.5, `成片时长应接近 2s，实际 ${result.info.durationSec}`);
    assert.equal(result.info.width, 64, "异尺寸片段应被统一到目标尺寸");

    // 封面与清单都要落盘，且清单可复现（含顺序、参数、ffmpeg 版本）
    assert.ok(result.coverUrl, "应产出封面");
    assert.ok(existsSync(join(result.dir, decodeURIComponent(result.coverUrl.split("/").pop()))), "封面文件应存在");
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.status, "done");
    assert.deepEqual(manifest.plan.clips.map((item) => item.id), ["sh1-clip", "sh2-clip"]);
    assert.equal(manifest.plan.episodeId, "ep_0001");
    assert.ok(manifest.commands[0].includes("ffmpeg"));
    assert.ok(manifest.ffmpegVersion.startsWith("ffmpeg"));
    assert.equal(manifest.output.url, result.url);
});

test("真机：fade 转场成片时长约为各段之和减转场时长", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("delivery-fade-");
    const a = makeClip(join(dir, "a.mp4"), { color: "green", duration: 1 });
    const b = makeClip(join(dir, "b.mp4"), { color: "yellow", duration: 1 });

    const result = await assembleEpisode({
        config: { dataDir: dir, pipeline: config.pipeline },
        clips: [
            { id: "a-clip", artifactUrl: a, durationSec: 1 },
            { id: "b-clip", artifactUrl: b, durationSec: 1 },
        ],
        transition: "fade",
        options: { transitionDurationSec: 0.5, id: "fade-delivery" },
    });

    assert.equal(result.status, "done");
    assert.ok(result.info.durationSec > 1.3 && result.info.durationSec < 1.7, `fade 成片时长异常：${result.info.durationSec}`);
});

test("真机：片段文件缺失时拼接失败，但保留清单与差异日志（不报成功）", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("delivery-fail-");
    await assert.rejects(
        assembleEpisode({
            config: { dataDir: dir, pipeline: config.pipeline },
            clips: [{ id: "gone-clip", artifactUrl: join(dir, "missing.mp4"), durationSec: 1 }],
            options: { id: "fail-delivery" },
        }),
        /退出码/,
    );
    const manifest = JSON.parse(readFileSync(join(dir, "artifacts", "fail-delivery", "assembly-manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.ok(manifest.error);
    assert.ok(existsSync(join(dir, "artifacts", "fail-delivery", "ffmpeg.log")), "失败时应保留 ffmpeg 日志");
});

test("真机：probeMedia 解析成片元信息", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("delivery-probe-");
    const a = makeClip(join(dir, "only.mp4"), { size: "32x32", duration: 1 });
    const info = await probeMedia(a);
    assert.equal(info.hasVideo, true);
    assert.equal(info.width, 32);
    assert.equal(info.hasAudio, false);
});

test("真机：外部音轨混流 + 字幕烧入成片带音轨且可解析", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("delivery-audio-");
    const a = makeClip(join(dir, "a.mp4"), { color: "red", duration: 1 });
    const b = makeClip(join(dir, "b.mp4"), { color: "blue", duration: 1 });
    const bgm = join(dir, "bgm.mp3");
    const bgmResult = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", bgm], { encoding: "utf8" });
    assert.equal(bgmResult.status, 0, bgmResult.stderr);
    const srt = join(dir, "sub.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,500\n测试字幕\n", "utf8");

    const result = await assembleEpisode({
        config: { dataDir: dir, pipeline: config.pipeline },
        clips: [
            { id: "a-clip", artifactUrl: a, durationSec: 1 },
            { id: "b-clip", artifactUrl: b, durationSec: 1 },
        ],
        transition: "fade",
        options: { transitionDurationSec: 0.5, audio: [{ ref: bgm }], subtitles: srt, id: "audio-delivery" },
    });

    assert.equal(result.status, "done");
    assert.equal(result.info.hasVideo, true);
    assert.equal(result.info.hasAudio, true, "混流后的成片应带音轨");
    assert.ok(result.bytes > 0);
});

test("成片片段原声：不显式指定时自动判定（H3 片段自带音轨 → 保留，否则成片是哑的）", () => {
    // 现场事故：H3 片段 `0,h264 + 1,aac`，成片却只有 `0,h264` —— includeClipAudio 默认 false 把原声丢了。
    // 下列断言把「何时保留片段原声」的规则钉死。
    assert.equal(shouldIncludeClipAudio({ explicit: true }), true, "显式 true 以调用方为准");
    assert.equal(shouldIncludeClipAudio({ explicit: false }), false, "显式 false 以调用方为准");
    // 没显式指定：所有片段都有音轨 → 保留
    assert.equal(shouldIncludeClipAudio({ probes: [{ hasAudio: true }, { hasAudio: true }] }), true);
    // 有一段没音轨 → 不能开（开了 ffmpeg 会引用不存在的 [i:a]）
    assert.equal(shouldIncludeClipAudio({ probes: [{ hasAudio: true }, { hasAudio: false }] }), false);
    // ffprobe 失败（null）→ 不开，宁可哑也不炸
    assert.equal(shouldIncludeClipAudio({ probes: [{ hasAudio: true }, null] }), false);
    // 传了独立音轨（TTS 配音）→ 不保留片段原声，避免双重人声（`amix normalize=0` 是原始求和）
    assert.equal(shouldIncludeClipAudio({ audioCount: 2, probes: [{ hasAudio: true }] }), false);
    // ⚠️ 硬规则优先：**显式 true 也不能绕过** —— 否则双重人声
    assert.equal(shouldIncludeClipAudio({ explicit: true, audioCount: 1 }), false, "有独立音轨时显式 true 也不保留片段原声");
    // 空输入 → 不开
    assert.equal(shouldIncludeClipAudio({}), false);
});

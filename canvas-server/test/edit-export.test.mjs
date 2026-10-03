import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ffmpegAvailable, probeMedia } from "../src/delivery.js";
import {
    MissingClipsError,
    buildEdl,
    buildFcpxml,
    buildOverlayNotes,
    buildPackageReadme,
    buildSrt,
    buildTimeline,
    crc32,
    exportDeliveryPackage,
    listEpisodes,
    listZipEntries,
    pickUsableClip,
    planRoughCut,
    shotsForEpisode,
    writeZip,
} from "../src/edit-export.js";

const hasFfmpeg = ffmpegAvailable("ffmpeg") && ffmpegAvailable("ffprobe");
const hasPython = spawnSync("python3", ["-c", "import xml.etree.ElementTree"], { stdio: "ignore" }).status === 0;

const scratch = [];
const makeScratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
};
test.after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const config = { dataDir: null, pipeline: { videoWidth: 64, videoHeight: 64, videoFps: 10 } };

// ---------- 纯函数：分集 / 分镜 ----------

const SHOTS = [
    { id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, dialogue: "第一句。（低声、语速慢）", prompt: "p1", textOverlays: [{ text: "末班车", kind: "screen", position: "挡风玻璃", style: "红底黄字" }] },
    { id: "sh2", sceneId: "sc1", index: 2, durationSec: 4, dialogue: "", prompt: "p2", textOverlays: [{ text: "", kind: "none" }] },
    { id: "sh3", sceneId: "sc2", index: 3, durationSec: 3, dialogue: "第三句。", prompt: "p3", textOverlays: [] },
];

test("listEpisodes：优先用剧本 episodes，缺失时退化为全集一集", () => {
    const withEp = listEpisodes({ episodes: [{ id: "ep1", index: 1, title: "第一集", sceneIds: ["sc1"] }] });
    assert.deepEqual(withEp.map((ep) => ep.id), ["ep1"]);
    assert.equal(withEp[0].sceneIds[0], "sc1");
    const fallback = listEpisodes({});
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].id, "ep1");
});

test("shotsForEpisode：按 sceneIds 过滤并按镜号排序", () => {
    const ep1 = shotsForEpisode({ sceneIds: ["sc1"] }, SHOTS);
    assert.deepEqual(ep1.map((shot) => shot.id), ["sh1", "sh2"]);
    const ep2 = shotsForEpisode({ sceneIds: ["sc2"] }, SHOTS);
    assert.deepEqual(ep2.map((shot) => shot.id), ["sh3"]);
    // 无 sceneIds → 全集
    assert.equal(shotsForEpisode({}, SHOTS).length, 3);
});

test("pickUsableClip：只认有产物的 done，canceled/无产物不算", () => {
    assert.equal(pickUsableClip([]), null);
    assert.equal(pickUsableClip([{ id: "c", status: "canceled", artifactUrl: null }]), null);
    assert.equal(pickUsableClip([{ id: "c", status: "done", artifactUrl: null }]), null);
    const ok = { id: "c", status: "done", artifactUrl: "/api/artifacts/j/c.mp4" };
    assert.equal(pickUsableClip([{ id: "bad", status: "canceled", artifactUrl: null }, ok]), ok);
});

// ---------- 纯函数：粗剪编排 + 缺段 ----------

const CLIPS = [
    { id: "sh1-clip", shotId: "sh1", jobId: "j1", artifactUrl: "/api/artifacts/j1/sh1.mp4", durationSec: 5, status: "done", candidates: [{ params: { INPUT_IMAGE: "/api/artifacts/kf/sh1.png", PROMPT: "clip-p1" } }] },
    { id: "sh2-clip", shotId: "sh2", artifactUrl: null, durationSec: 4, status: "canceled" },
    { id: "sh3-clip", shotId: "sh3", artifactUrl: "/api/artifacts/j3/sh3.mp4", durationSec: 3, status: "done" },
];

test("planRoughCut：按分镜顺序产出 segment 并保留追溯字段", () => {
    const plan = planRoughCut({ episodeId: "ep1", shots: SHOTS, clips: CLIPS, allowPartial: true });
    assert.deepEqual(plan.segments.map((seg) => seg.shotId), ["sh1", "sh3"]);
    assert.deepEqual(plan.segments.map((seg) => seg.index), [0, 1]);
    const first = plan.segments[0];
    assert.equal(first.clipId, "sh1-clip");
    assert.equal(first.jobId, "j1");
    assert.equal(first.referenceImage, "/api/artifacts/kf/sh1.png");
    assert.equal(first.prompt, "p1");
    // missing：sh2 有记录但未产出，报出 缺第2段 + 缺多长
    assert.equal(plan.partial, true);
    assert.equal(plan.missing.length, 1);
    assert.equal(plan.missing[0].shotId, "sh2");
    assert.equal(plan.missing[0].shotIndex, 2);
    assert.equal(plan.missing[0].durationSec, 4);
    assert.equal(plan.missingDurationSec, 4);
});

test("planRoughCut：默认严格模式，缺段即抛 MissingClipsError 并列出第几段/缺多长", () => {
    assert.throws(
        () => planRoughCut({ shots: SHOTS, clips: CLIPS }),
        (error) => {
            assert.ok(error instanceof MissingClipsError);
            assert.match(error.message, /缺 1 段/);
            assert.match(error.message, /第2段\(sh2\) 缺 4s/);
            assert.equal(error.missing[0].shotId, "sh2");
            return true;
        },
    );
});

test("planRoughCut：全缺且严格模式报错；allowPartial 时返回空 segments + 全量 missing", () => {
    assert.throws(() => planRoughCut({ shots: SHOTS, clips: [] }), /缺 3 段/);
    const plan = planRoughCut({ shots: SHOTS, clips: [], allowPartial: true });
    assert.equal(plan.segments.length, 0);
    assert.equal(plan.missing.length, 3);
    assert.equal(plan.partial, true);
});

// ---------- 纯函数：时间线 ----------

const seg = (shotId, dur) => ({ shotId, shotIndex: Number(shotId.slice(2)), durationSec: dur, dialogue: "", textOverlays: [] });

test("buildTimeline：cut 顺序累加；fade 按重叠递推", () => {
    const cut = buildTimeline({ segments: [seg("sh1", 5), seg("sh2", 4)], durations: [5, 4], transition: "cut" });
    assert.deepEqual(cut.map((e) => [e.startSec, e.endSec]), [[0, 5], [5, 9]]);
    const fade = buildTimeline({ segments: [seg("sh1", 5), seg("sh2", 4)], durations: [5, 4], transition: "fade", transitionDurationSec: 1 });
    assert.deepEqual(fade.map((e) => [e.startSec, e.endSec]), [[0, 5], [4, 8]]);
});

// ---------- 纯函数：字幕 / 画面文字 ----------

const TIMELINE = [
    { shotId: "sh1", shotIndex: 1, fileStem: "ep01_sh01", startSec: 0, endSec: 5, durationSec: 5, dialogue: "姑娘，这么晚，去哪儿？（低声、语速慢）", narration: "", textOverlays: [{ text: "末班车", kind: "screen", position: "挡风玻璃", style: "红底黄字" }] },
    { shotId: "sh2", shotIndex: 2, fileStem: "ep01_sh02", startSec: 5, endSec: 9, durationSec: 4, dialogue: "", narration: "", textOverlays: [{ text: "", kind: "none" }] },
];

test("buildSrt：剥掉表演注解、按句分行、无台词不出字幕", () => {
    const srt = buildSrt({ timeline: TIMELINE });
    assert.match(srt, /1\n00:00:00,000 --> 00:00:05,000\n姑娘，这么晚，去哪儿？\n/);
    assert.ok(!srt.includes("低声"));
    assert.ok(!srt.includes("末班车"), "画面文字不得混进字幕");
    assert.equal((srt.match(/-->/g) || []).length, 1);
});

test("buildSrt：多句台词在同一段内均分时间", () => {
    const srt = buildSrt({ timeline: [{ shotId: "sh1", shotIndex: 1, fileStem: "s", startSec: 0, endSec: 4, durationSec: 4, dialogue: "甲。乙。", narration: "", textOverlays: [] }] });
    assert.match(srt, /00:00:00,000 --> 00:00:02,000\n甲。/);
    assert.match(srt, /00:00:02,000 --> 00:00:04,000\n乙。/);
});

test("buildOverlayNotes：画面文字另存为注释行，含位置/样式", () => {
    const notes = buildOverlayNotes({ timeline: TIMELINE });
    assert.match(notes, /ep01_sh01 \(sh1\) 画面文字: "末班车"（挡风玻璃；红底黄字）/);
    assert.ok(!notes.includes("(sh2)"));
});

// ---------- 纯函数：FCPXML / EDL ----------

test("buildFcpxml：每段按真实时长排片、带 ref/name/offset，可被 XML 解析器 parse", () => {
    const timeline = [
        { shotId: "sh1", fileStem: "ep01_sh01", file: "clips/ep01_sh01.mp4", startSec: 0, endSec: 5.1667, durationSec: 5.1667, hasAudio: true, sampleRate: 32000, channels: 2 },
        { shotId: "sh5", fileStem: "ep01_sh05", file: "clips/ep01_sh05.mp4", startSec: 5.1667, endSec: 8.9167, durationSec: 3.75, hasAudio: true, sampleRate: 32000, channels: 2 },
    ];
    const xml = buildFcpxml({ projectName: "ep01_测试", width: 768, height: 1376, fps: 24, timeline });
    assert.match(xml, /<fcpxml version="1\.9">/);
    assert.match(xml, /<asset id="a1" name="ep01_sh01"[^>]*duration="124\/24s"[^>]*>/);
    assert.match(xml, /<media-rep kind="original-media" src="clips\/ep01_sh01\.mp4"\/>/);
    assert.match(xml, /<asset-clip ref="a1" name="ep01_sh01" offset="0\/24s" duration="124\/24s"/);
    assert.match(xml, /<asset-clip ref="a2" name="ep01_sh05" offset="124\/24s"/);
    assert.match(xml, /frameDuration="1\/24s" width="768" height="1376"/);
    // sequence 总时长 = 末段结束
    assert.match(xml, /<sequence[^>]*duration="214\/24s"/);

    if (hasPython) {
        const dir = makeScratch("edit-fcpxml-");
        const file = join(dir, "t.fcpxml");
        writeFileSync(file, xml, "utf8");
        const parsed = spawnSync("python3", ["-c", "import sys,xml.etree.ElementTree as ET; r=ET.parse(sys.argv[1]).getroot(); print(len(r.findall('.//asset-clip')))", file], { encoding: "utf8" });
        assert.equal(parsed.status, 0, parsed.stderr);
        assert.equal(parsed.stdout.trim(), "2", "XML 解析器应能 parse 出 2 条 asset-clip");
    }
});

test("buildEdl：CMX3600 头 + 每段源/录时间码 + FROM CLIP NAME", () => {
    const timeline = [
        { shotId: "sh1", fileStem: "ep01_sh01", startSec: 0, endSec: 2.5, durationSec: 2.5 },
        { shotId: "sh5", fileStem: "ep01_sh05", startSec: 2.5, endSec: 5, durationSec: 2.5 },
    ];
    const edl = buildEdl({ title: "ep01_t", fps: 24, timeline });
    assert.match(edl, /^TITLE: ep01_t\nFCM: NON-DROP FRAME\n/);
    assert.match(edl, /001  AX       V     C        00:00:00:00 00:00:02:12 00:00:00:00 00:00:02:12/);
    assert.match(edl, /\* FROM CLIP NAME: ep01_sh01\.mp4/);
    assert.match(edl, /002  AX {7}V {5}C {8}00:00:00:00 00:00:02:12 00:00:02:12 00:00:05:00/);
});

// ---------- 纯函数：zip ----------

test("writeZip/listZipEntries：原生 store zip 往返，CRC 正确", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    const dir = makeScratch("edit-zip-");
    const a = join(dir, "a.txt");
    writeFileSync(a, "hello 世界", "utf8");
    const zipPath = join(dir, "out.zip");
    writeZip({ outputPath: zipPath, entries: [{ name: "pkg/a.txt", path: a }, { name: "pkg/data.json", data: Buffer.from('{"k":1}') }] });
    const entries = listZipEntries(zipPath);
    assert.deepEqual(entries.map((entry) => entry.name), ["pkg/a.txt", "pkg/data.json"]);
    assert.deepEqual(entries.map((entry) => entry.size), [Buffer.byteLength("hello 世界"), 7]);
    // 真 zip 命令也能读（有 unzip 时）
    if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0) {
        const listed = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
        assert.equal(listed.status, 0, listed.stderr);
        assert.deepEqual(listed.stdout.trim().split("\n"), ["pkg/a.txt", "pkg/data.json"]);
    }
});

test("buildPackageReadme：含导入剪映/达芬奇说明与 partial 提示", () => {
    const readme = buildPackageReadme({ runId: "run-x", episodes: [], allowPartial: true, createdAt: "t" });
    assert.match(readme, /剪映/);
    assert.match(readme, /达芬奇/);
    assert.match(readme, /partial/);
});

// ---------- 真机：造片段 → 粗剪 → 打 zip ----------

/** 用 ffmpeg 造一段带音轨的纯色片段（不依赖任何外部素材）。 */
function makeClip(path, { size = "64x64", color = "red", duration = 1, fps = 10 } = {}) {
    const args = [
        "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=${fps}:d=${duration}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`,
        "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-ac", "2", "-ar", "32000",
        path,
    ];
    const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return path;
}

function makeRun({ dir, shots, clips, episodes }) {
    return {
        id: "run-test",
        options: {},
        stages: {
            script: { output: { episodes: episodes || [{ id: "ep1", index: 1, title: "测试集", sceneIds: ["sc1"] }] } },
            storyboard: { output: { shots } },
            assembly: { output: { clips, assembly: { order: clips.map((clip) => clip.id), transition: "cut", status: "queued" } } },
        },
    };
}

test("真机：一段一集 → 粗剪成片 + 完整素材包 zip（成片/原片/SRT/FCPXML/EDL/清单/说明）", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("edit-e2e-");
    const localConfig = { ...config, dataDir: join(dir, "data") };
    const shots = [
        { id: "sh1", sceneId: "sc1", index: 1, durationSec: 1, dialogue: "第一句。（低声）", prompt: "p1", textOverlays: [{ text: "末班车", kind: "screen", position: "挡风玻璃", style: "红底黄字" }] },
        { id: "sh2", sceneId: "sc1", index: 2, durationSec: 1, dialogue: "", prompt: "p2", textOverlays: [] },
        { id: "sh3", sceneId: "sc1", index: 3, durationSec: 1, dialogue: "第三句。", prompt: "p3", textOverlays: [] },
    ];
    const clips = shots.map((shot, i) => ({
        id: `${shot.id}-clip`,
        shotId: shot.id,
        artifactUrl: makeClip(join(dir, `${shot.id}.mp4`), { color: ["red", "green", "blue"][i], duration: 1 }),
        durationSec: 1,
        status: "done",
        candidates: [{ params: { INPUT_IMAGE: `/api/artifacts/kf/${shot.id}.png`, PROMPT: shot.prompt } }],
    }));

    const result = await exportDeliveryPackage({
        config: localConfig,
        run: makeRun({ dir, shots, clips }),
        options: { id: "e2e-pkg" },
    });

    assert.equal(result.status, "done");
    assert.ok(existsSync(result.zipPath));
    const names = result.entries.map((entry) => entry.name).sort();
    for (const expected of [
        "e2e-pkg/README.txt",
        "e2e-pkg/manifest.json",
        "e2e-pkg/ep01.srt",
        "e2e-pkg/ep01.fcpxml",
        "e2e-pkg/ep01.edl",
        "e2e-pkg/ep01_final.mp4",
        "e2e-pkg/clips/ep01_sh01.mp4",
        "e2e-pkg/clips/ep01_sh02.mp4",
        "e2e-pkg/clips/ep01_sh03.mp4",
    ]) {
        assert.ok(names.includes(expected), `zip 应含 ${expected}，实际 ${names.join(", ")}`);
    }

    // 成片可解析、带音轨，时长≈三段之和
    const finalPath = join(result.workDir, "package", "ep01_final.mp4");
    const info = await probeMedia(finalPath);
    assert.equal(info.hasVideo, true);
    assert.equal(info.hasAudio, true, "粗剪成片应保留原声");
    assert.ok(info.durationSec > 2.5, `成片时长应≈3s，实际 ${info.durationSec}`);

    // SRT 含对白且无表演注解；画面文字进 overlays 不进 SRT
    const srt = readFileSync(join(dir, "data", "artifacts", "e2e-pkg", "package", "ep01.srt"), "utf8");
    assert.match(srt, /第一句。/);
    assert.match(srt, /第三句。/);
    assert.ok(!srt.includes("低声"));
    assert.ok(!srt.includes("末班车"));
    const overlays = readFileSync(join(dir, "data", "artifacts", "e2e-pkg", "package", "ep01_overlays.txt"), "utf8");
    assert.match(overlays, /末班车/);

    // 清单 JSON：顺序 / 时长 / 来源 jobId / 参考图 / 转场
    const manifest = JSON.parse(readFileSync(join(result.workDir, "package", "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "edit-export-package");
    assert.equal(manifest.partial, false);
    const segs = manifest.episodes[0].segments;
    assert.deepEqual(segs.map((s) => s.shotId), ["sh1", "sh2", "sh3"]);
    assert.deepEqual(segs.map((s) => s.order), [1, 2, 3]);
    assert.equal(segs[0].transition, "cut");
    assert.equal(segs[0].referenceImage, "/api/artifacts/kf/sh1.png");
    assert.ok(segs[0].durationSec > 0);

    // FCPXML 可被 XML 解析器 parse
    if (hasPython) {
        const parsed = spawnSync("python3", ["-c", "import sys,xml.etree.ElementTree as ET; print(len(ET.parse(sys.argv[1]).getroot().findall('.//asset-clip')))", join(result.workDir, "package", "ep01.fcpxml")], { encoding: "utf8" });
        assert.equal(parsed.status, 0, parsed.stderr);
        assert.equal(parsed.stdout.trim(), "3");
    }
});

test("真机：缺段严格模式拒绝出片并显式报出缺哪一段；allowPartial 才出片且标注 partial", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("edit-missing-");
    const localConfig = { ...config, dataDir: join(dir, "data") };
    const shots = [
        { id: "sh1", sceneId: "sc1", index: 1, durationSec: 1, dialogue: "甲。", prompt: "p1", textOverlays: [] },
        { id: "sh2", sceneId: "sc1", index: 2, durationSec: 1, dialogue: "", prompt: "p2", textOverlays: [] },
        { id: "sh3", sceneId: "sc1", index: 3, durationSec: 1, dialogue: "乙。", prompt: "p3", textOverlays: [] },
    ];
    const clips = [
        { id: "sh1-clip", shotId: "sh1", artifactUrl: makeClip(join(dir, "sh1.mp4"), { color: "red", duration: 1 }), durationSec: 1, status: "done" },
        { id: "sh2-clip", shotId: "sh2", artifactUrl: null, durationSec: 1, status: "canceled" },
        { id: "sh3-clip", shotId: "sh3", artifactUrl: makeClip(join(dir, "sh3.mp4"), { color: "blue", duration: 1 }), durationSec: 1, status: "done" },
    ];

    // 严格模式：拒绝出片，报出「第2段(sh2) 缺 1s」
    await assert.rejects(
        exportDeliveryPackage({ config: localConfig, run: makeRun({ dir, shots, clips }), options: { id: "missing-pkg" } }),
        (error) => {
            assert.ok(error instanceof MissingClipsError);
            assert.match(error.message, /第2段\(sh2\) 缺 1s/);
            return true;
        },
    );
    // 明确没产出成片（不静默出半条片）
    assert.ok(!existsSync(join(localConfig.dataDir, "artifacts", "missing-pkg", "package", "ep01_final.mp4")), "严格模式不得留下半条成片");

    // allowPartial：出片，但清单显式标注 partial 与缺段明细
    const result = await exportDeliveryPackage({
        config: localConfig,
        run: makeRun({ dir, shots, clips }),
        allowPartial: true,
        options: { id: "partial-pkg" },
    });
    assert.equal(result.status, "done");
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].shotId, "sh2");
    assert.equal(result.missing[0].durationSec, 1);
    const manifest = JSON.parse(readFileSync(join(result.workDir, "package", "manifest.json"), "utf8"));
    assert.equal(manifest.partial, true);
    assert.deepEqual(manifest.missing.map((m) => m.shotId), ["sh2"]);
    assert.deepEqual(manifest.episodes[0].segments.map((s) => s.shotId), ["sh1", "sh3"]);
    const readme = readFileSync(join(result.workDir, "package", "README.txt"), "utf8");
    assert.match(readme, /partial/);
});

test("真机：单步重跑 —— 先 plan+assemble，再单独 package，复用磁盘中间产物", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("edit-resume-");
    const localConfig = { ...config, dataDir: join(dir, "data") };
    const shots = [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 1, dialogue: "甲。", prompt: "p1", textOverlays: [] }];
    const clips = [{ id: "sh1-clip", shotId: "sh1", artifactUrl: makeClip(join(dir, "sh1.mp4"), { color: "red", duration: 1 }), durationSec: 1, status: "done" }];
    const run = makeRun({ dir, shots, clips });

    const first = await exportDeliveryPackage({ config: localConfig, run, options: { id: "resume-pkg" }, steps: ["plan", "assemble"] });
    assert.equal(first.status, "partial-run");
    assert.ok(existsSync(join(first.workDir, "package", "ep01_final.mp4")), "assemble 应先产出成片");
    assert.ok(!existsSync(join(first.workDir, "resume-pkg.zip")), "未跑 package 时不应有 zip");

    const second = await exportDeliveryPackage({ config: localConfig, run, options: { id: "resume-pkg" }, steps: ["package"] });
    assert.equal(second.status, "done");
    assert.ok(existsSync(second.zipPath));
    assert.ok(second.entries.some((entry) => entry.name.endsWith("ep01_final.mp4")));
    assert.ok(existsSync(second.logPath), "重跑应保留日志");
});

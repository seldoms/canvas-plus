import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ffmpegAvailable, probeMedia } from "../src/delivery.js";
import {
    MissingClipsError,
    exportDeliveryPackage,
    loadProjectForRun,
    resolveEpisodeShotAttribution,
    shotsForEpisode,
} from "../src/edit-export.js";

/**
 * #51 导出配对回归：Project 侧与 Run 侧 shotId 是两套（project sh_… vs run sh1），
 * 且集 id 也不同（project ep_0001 vs 剧本 ep1）。导出现在必须：
 *   ① 用映射归属分集（--episode ep_0001 能命中项目集，而不是「没有可导出的集」）；
 *   ② 按映射配对 clips（两侧 id 不同也能配上）；
 *   ③ 缺段按集显式报出、严格模式拒绝出半条片；--allow-partial 才出片且 manifest 标 partial。
 */

const hasFfmpeg = ffmpegAvailable("ffmpeg") && ffmpegAvailable("ffprobe");

const scratch = [];
const makeScratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
};
test.after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const config = { pipeline: { videoWidth: 64, videoHeight: 64, videoFps: 10 } };

// Project 侧：稳定 sh_ 主键 + runShotId 桥字段；剧本侧集 id ep1/ep2，项目侧 ep_0001/ep_0002。
const PROJECT_SHOTS = [
    { id: "sh_PROJ1", runShotId: "sh1", episodeId: "ep_0001", index: 1, sceneId: "sc_0001" },
    { id: "sh_PROJ2", runShotId: "sh2", episodeId: "ep_0001", index: 2, sceneId: "sc_0001" },
    { id: "sh_PROJ3", runShotId: "sh3", episodeId: "ep_0002", index: 3, sceneId: "sc_0002" },
];
const PROJECT = {
    id: "prj_test",
    episodes: [
        { id: "ep_0001", index: 1, title: "相遇", sceneIds: ["sc1"], shots: PROJECT_SHOTS.filter((shot) => shot.episodeId === "ep_0001") },
        { id: "ep_0002", index: 2, title: "承诺", sceneIds: ["sc2"], shots: PROJECT_SHOTS.filter((shot) => shot.episodeId === "ep_0002") },
    ],
};

function writeProject(dataDir, project = PROJECT) {
    const dir = join(dataDir, "projects", project.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.json"), JSON.stringify(project, null, 2));
}

function makeRun({ projectId = "prj_test", shots, clips }) {
    return {
        id: "run-map",
        options: { projectId },
        stages: {
            script: { output: { episodes: [{ id: "ep1", index: 1, title: "相遇", sceneIds: ["sc1"] }, { id: "ep2", index: 2, title: "承诺", sceneIds: ["sc2"] }] } },
            storyboard: { output: { shots } },
            assembly: { output: { clips, assembly: { order: clips.map((clip) => clip.id), transition: "cut", status: "queued" } } },
        },
    };
}

const RUN_SHOTS = [
    { id: "sh1", sceneId: "sc1", index: 1, durationSec: 1, dialogue: "甲。", prompt: "p1", textOverlays: [] },
    { id: "sh2", sceneId: "sc1", index: 2, durationSec: 1, dialogue: "", prompt: "p2", textOverlays: [] },
    { id: "sh3", sceneId: "sc2", index: 3, durationSec: 1, dialogue: "乙。", prompt: "p3", textOverlays: [] },
];

test("映射归属：Project 集 → 运行侧 shot ids（用 runShotId），未配对处显式报告", () => {
    const attribution = resolveEpisodeShotAttribution({ project: PROJECT, runShots: RUN_SHOTS });
    assert.deepEqual(attribution.episodes.map((episode) => [episode.id, episode.runShotIds]), [
        ["ep_0001", ["sh1", "sh2"]],
        ["ep_0002", ["sh3"]],
    ]);
    assert.equal(attribution.episodes[0].projectShotIds.sh1, "sh_PROJ1");
    assert.deepEqual(attribution.unmatchedRun, []);
    assert.deepEqual(attribution.unmatchedProject, []);

    // 运行侧多一镜 → 显式报告，不静默丢弃
    const extra = resolveEpisodeShotAttribution({ project: PROJECT, runShots: [...RUN_SHOTS, { id: "sh4", sceneId: "sc2", index: 4 }] });
    assert.deepEqual(extra.unmatchedRun.map((item) => item.runShotId), ["sh4"]);

    // shotsForEpisode 优先按 runShotIds
    const picked = shotsForEpisode(attribution.episodes[0], RUN_SHOTS);
    assert.deepEqual(picked.map((shot) => shot.id), ["sh1", "sh2"]);
});

test("loadProjectForRun：把 run.options.projectId 读到项目（缺失/未绑 → null）", () => {
    const dir = makeScratch("edit-map-proj-");
    const dataDir = join(dir, "data");
    writeProject(dataDir);
    assert.equal(loadProjectForRun({ dataDir }, { options: { projectId: "prj_test" } }).id, "prj_test");
    assert.equal(loadProjectForRun({ dataDir }, { options: {} }), null);
    assert.equal(loadProjectForRun({ dataDir }, { options: { projectId: "prj_none" } }), null);
});

/** 造一段带音轨的纯色片段。 */
function makeClip(path, { color = "red", duration = 1, fps = 10 } = {}) {
    const args = ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=64x64:r=${fps}:d=${duration}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-ac", "2", "-ar", "32000", path];
    const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return path;
}

test("真机 e2e：两侧 id 不同也能按映射配对出片；--episode ep_0001 命中项目集；manifest 带两侧 id", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("edit-map-e2e-");
    const dataDir = join(dir, "data");
    writeProject(dataDir);
    const clips = RUN_SHOTS.map((shot, i) => ({
        id: `${shot.id}-clip`,
        shotId: shot.id,
        artifactUrl: makeClip(join(dir, `${shot.id}.mp4`), { color: ["red", "green", "blue"][i], duration: 1 }),
        durationSec: 1,
        status: "done",
    }));
    const run = makeRun({ shots: RUN_SHOTS, clips });

    // 关键：--episode ep_0001 是 **Project 侧** 集 id；剧本侧只有 ep1，靠映射才对得上。
    const result = await exportDeliveryPackage({ config: { ...config, dataDir }, run, episodeId: "ep_0001", options: { id: "map-pkg" } });
    assert.equal(result.status, "done");
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].episodeId, "ep_0001");
    const names = result.entries.map((entry) => entry.name);
    for (const expected of ["map-pkg/ep01_final.mp4", "map-pkg/ep01.srt", "map-pkg/ep01.fcpxml", "map-pkg/ep01.edl", "map-pkg/manifest.json", "map-pkg/clips/ep01_sh01.mp4", "map-pkg/clips/ep01_sh02.mp4"]) {
        assert.ok(names.includes(expected), `zip 应含 ${expected}，实际 ${names.join(", ")}`);
    }
    assert.ok(!names.some((name) => name.includes("sh03")), "ep_0002 的 sh3 不得混进 ep_0001 包");

    const manifest = JSON.parse(readFileSync(join(result.workDir, "package", "manifest.json"), "utf8"));
    assert.equal(manifest.projectId, "prj_test");
    assert.deepEqual(manifest.episodes[0].segments.map((seg) => [seg.runShotId, seg.projectShotId]), [["sh1", "sh_PROJ1"], ["sh2", "sh_PROJ2"]]);
    assert.equal(manifest.attribution.pairs, 3, "三条映射全部配对");

    const info = await probeMedia(join(result.workDir, "package", "ep01_final.mp4"));
    assert.equal(info.hasVideo, true);
    assert.equal(info.hasAudio, true);
});

test("真机 e2e：缺段报出集上下文；严格模式拒绝出片，--allow-partial 出片且 manifest.partial=true", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async () => {
    const dir = makeScratch("edit-map-missing-");
    const dataDir = join(dir, "data");
    writeProject(dataDir);
    const clips = [
        { id: "sh1-clip", shotId: "sh1", artifactUrl: makeClip(join(dir, "sh1.mp4"), { color: "red", duration: 1 }), durationSec: 1, status: "done" },
        { id: "sh2-clip", shotId: "sh2", artifactUrl: null, durationSec: 1, status: "canceled" },
        { id: "sh3-clip", shotId: "sh3", artifactUrl: makeClip(join(dir, "sh3.mp4"), { color: "blue", duration: 1 }), durationSec: 1, status: "done" },
    ];
    const run = makeRun({ shots: RUN_SHOTS, clips });

    await assert.rejects(
        exportDeliveryPackage({ config: { ...config, dataDir }, run, episodeId: "ep_0001", options: { id: "map-missing" } }),
        (error) => {
            assert.ok(error instanceof MissingClipsError);
            assert.match(error.message, /第2段\(sh2\) 缺 1s（集 ep_0001）/);
            return true;
        },
    );
    const partial = await exportDeliveryPackage({ config: { ...config, dataDir }, run, episodeId: "ep_0001", allowPartial: true, options: { id: "map-partial" } });
    assert.equal(partial.status, "done");
    const manifest = JSON.parse(readFileSync(join(partial.workDir, "package", "manifest.json"), "utf8"));
    assert.equal(manifest.partial, true);
    assert.deepEqual(manifest.missing.map((item) => [item.shotId, item.episodeId]), [["sh2", "ep_0001"]]);
    assert.deepEqual(manifest.episodes[0].segments.map((seg) => seg.runShotId), ["sh1"]);
});

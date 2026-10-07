import assert from "node:assert/strict";
import { test } from "node:test";

import { buildQualityReport } from "../src/quality-check.js";

test("quality check 汇总阶段契约问题与对白溢出", () => {
    const run = {
        id: "run-qc",
        stages: {
            storyboard: { status: "done", output: { shots: [{ id: "sh1", durationSec: 2 }] } },
            assembly: { status: "done", output: { clips: [{ id: "clip1", shotId: "sh1", durationSec: 2, artifactUrl: "/clip.mp4" }], assembly: { status: "done", url: "/film.mp4", quality: { clips: [{ id: "clip1", shotId: "sh1", durationSec: 2 }], dialogueTiming: [{ cueId: "cue1", type: "dialogue", shotId: "sh1", startSec: 0, durationSec: 3 }] } } } },
            audio: {
                output: {
                    audio: [{ cueId: "cue1", id: "cue1", type: "dialogue", shotId: "sh1", durationSec: 3, text: "你好" }],
                },
            },
        },
    };

    const report = buildQualityReport({ run, stageUpstream: () => ({}) , now: "2026-10-07T00:00:00.000Z" });
    assert.equal(report.runId, "run-qc");
    assert.equal(report.status, "blocked");
    assert.ok(report.issues.some((issue) => issue.code === "dialogue_overflow"));
    assert.ok(report.summary.blocking >= 1);
});

test("quality check 指定已完成且无问题的剧本阶段返回 pass", () => {
    const report = buildQualityReport({
        run: { id: "run-pass", stages: { script: { status: "done", output: { scenes: [{ id: "sc1", beats: ["出场"] }], characters: [], episodes: [{ id: "ep1", sceneIds: ["sc1"] }] } } } },
        stage: "script",
        stageUpstream: () => ({}),
    });
    assert.equal(report.status, "pass");
    assert.deepEqual(report.summary, { total: 0, blocking: 0, warnings: 0 });
});

test("quality check 未产出的阶段不能误报通过", () => {
    const report = buildQualityReport({ run: { id: "run-new", stages: { assembly: { status: "pending", output: null } } }, stage: "assembly" });
    assert.equal(report.status, "blocked");
    assert.ok(report.issues.some((issue) => issue.code === "film_incomplete"));
});

test("quality check 保留实测窗口重叠且不重新串排掩盖问题", () => {
    const report = buildQualityReport({ run: { id: "run-overlap", stages: { assembly: { status: "done", output: { clips: [], assembly: { status: "done", url: "/film.mp4", quality: { clips: [{ shotId: "sh1", durationSec: 5 }], dialogueTiming: [
        { type: "dialogue", shotId: "sh1", startSec: 0, durationSec: 2 },
        { type: "dialogue", shotId: "sh1", startSec: 1, durationSec: 2 },
    ] } } } } } }, stage: "assembly" });
    assert.equal(report.status, "blocked");
    assert.ok(report.issues.some((issue) => issue.code === "dialogue_overlap"));
});

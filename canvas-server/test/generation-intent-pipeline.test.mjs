import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createJobQueue } from "../src/jobs.js";
import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";

/**
 * M1 流水线入队归属回归：keyframe 阶段经 enqueueAttempt 入队的 Job，
 * meta 必须带完整归属（契约 §3.10）：runId/stageId/itemId（既有）+
 * source/projectId/shotId/slotId/toolId/idempotencyKey（新增，有值才写）。
 * 全程假 LLM + 真实任务队列（假 runner 永不终态，避免回写级联干扰断言），不触碰网络与 GPU。
 */

const SCRIPT_OUTPUT = {
    logline: "末班车上的约定",
    synopsis: "深夜末班车上，司机与女孩的相遇。",
    characters: [{ id: "c1", name: "老周", profile: "司机", appearance: "中年", voice: "低沉" }],
    scenes: [{ id: "sc1", title: "公交车内", time: "夜", intent: "相遇", beats: ["上车"] }],
    episodes: [{ id: "ep1", index: 1, title: "相遇", durationSec: 30, synopsis: "起", sceneIds: ["sc1"] }],
};

const STORYBOARD_OUTPUT = {
    shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, shotSize: "全景", camera: "固定", action: "公交车驶入", dialogue: "", audio: "", prompt: "a bus arrives", negativePrompt: "" }],
};

const FRAMES_OUTPUT = {
    frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "夜间公交车停靠，全景", textOverlays: [] }],
};

const SKILL_MD = (title, brief) => `---
name: ${title}
description: 测试${title}
---

# ${title}

## 提示词模板

${brief}
`;

function setup(t) {
    const root = mkdtempSync(join(tmpdir(), "canvas-intent-pipeline-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const skillsDir = join(root, "skills");
    for (const [dir, content] of Object.entries({
        "01-script": SKILL_MD("剧本", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes/episodes 的 JSON。"),
        "02-storyboard": SKILL_MD("分镜", "你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。"),
        "04-keyframes": SKILL_MD("关键帧", "你是关键帧提示词工程师，返回含 frames 数组的 JSON。"),
    })) {
        mkdirSync(join(skillsDir, dir), { recursive: true });
        writeFileSync(join(skillsDir, dir, "SKILL.md"), content);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
            ],
        }),
    );
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const stages = [
        { id: "script", requires: [] },
        { id: "storyboard", requires: ["script"] },
        { id: "keyframe", requires: ["storyboard"] },
    ];
    const projects = createProjects({ dataDir, stages });
    // 真实队列 + 假 runner（永不终态）：job 停在 running，不回写投影、不触发自动重试。
    const jobs = createJobQueue({ dataDir, label: "intent-pipeline-test" });
    const runJob = () => new Promise(() => {});
    const llm = {
        async chat(options) {
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("关键帧提示词工程师") ? FRAMES_OUTPUT : content.includes("分镜师") ? STORYBOARD_OUTPUT : content.includes("分集规划师") ? { episodes: SCRIPT_OUTPUT.episodes } : SCRIPT_OUTPUT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
    const pipeline = createPipeline({
        config: { dataDir, pipeline: { imageTemplate: "img-test", videoTemplate: "video-test", videoSeconds: 5, videoFps: 24, maxNovelChunkChars: 16000 } },
        skillsDir,
        jobs,
        comfy: {},
        llm,
        runJob,
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
        applyScriptProjection: (id, output) => projects.applyScriptProjection(id, output),
        applyEpisodeProjection: (id, output) => projects.applyEpisodeProjection(id, output),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
        registerAssetRef: (id, input) => projects.assets.create(id, input),
    });
    return { projects, pipeline, jobs };
}

test("流水线入队：job.meta 归属完整（source/projectId/shotId/slotId/toolId/idempotencyKey），同 attempt 重放幂等", async (t) => {
    const { projects, pipeline, jobs } = setup(t);
    const project = projects.create({ title: "M1 归属", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    projects.assets.create(project.id, { role: "character", bindingId: "c1" });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");

    const generated = jobs.list().filter((job) => job.meta?.runId === run.id);
    assert.ok(generated.length > 0, "keyframe 阶段应产生入队任务");
    for (const job of generated) {
        const meta = job.meta;
        assert.equal(meta.source, "project");
        assert.equal(meta.stageId, "keyframe");
        assert.equal(meta.itemId, "sh1-start");
        assert.equal(meta.projectId, project.id);
        assert.equal(meta.shotId, "sh1");
        assert.equal(meta.slotId, "slot_sh1_start", "slotId 与 generationSlots id 同规则（slot_<shotId>_<role>）");
        assert.equal(meta.toolId, "img-test");
        assert.equal(meta.idempotencyKey, `${run.id}:keyframe:sh1-start:${job.id}`, "幂等键 = runId+stageId+itemId+attempt");
    }

    // 同一 attempt 的重放（同 key 再入队）命中幂等索引：返回原 Job，队列不膨胀。
    const before = jobs.list().length;
    const original = generated[0];
    const replay = jobs.enqueue({ id: "replay-should-not-stick", kind: original.kind, template: original.template, meta: { ...original.meta } }, () => new Promise(() => {}));
    assert.equal(replay.id, original.id);
    assert.equal(jobs.list().length, before);
});

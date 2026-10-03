import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    RUN_SHOT_ID_FIELD,
    backfillProjectShotRunIds,
    buildShotIdMap,
    matchProjectShotsToRunShots,
    normalizeShotEpisodeIds,
    resolveProjectShotId,
    resolveRunShotId,
} from "../src/production-contracts.js";
import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";

/**
 * #51 回归：Project 侧 shot.id 是 hash 派生的稳定主键（sh_…），Run 侧 shot id 是 sh1 一类 —— 两套 id。
 * 本文件覆盖：
 *   ① 双向解析（buildShotIdMap / resolveProjectShotId / resolveRunShotId）；
 *   ② 配对纯函数 matchProjectShotsToRunShots（stored/index/order 三条依据 + 不一致显式报告，绝不静默丢弃）；
 *   ③ backfillProjectShotRunIds 幂等（重复运行 changed=false）；
 *   ④ 编排器接线：关键帧投影把 runShotId 落到 Project 侧 shot（可回填存量项目、重复投影不改 version）；
 *   ⑤ Run 侧存量产物 episodeId 回填（由 bindJobs 重放终态 Job → recomputeStage 命中；幂等、不改产物文件）。
 * 全程假 LLM + 假任务队列 + 真实 Project 存储，绝不真跑模型、绝不触发真生成。
 */

/* ------------------------------ ① 双向解析 ------------------------------ */

test("双向解析：runShotId ⇄ project shotId，查不到返回 null", () => {
    const shots = [
        { id: "sh_AAA", runShotId: "sh1" },
        { id: "sh_BBB", runShotId: "sh2" },
    ];
    const map = buildShotIdMap(shots);
    assert.equal(map.byRunShotId.sh1, "sh_AAA");
    assert.equal(map.byProjectShotId.sh_BBB, "sh2");
    assert.equal(resolveProjectShotId(shots, "sh2"), "sh_BBB");
    assert.equal(resolveRunShotId(shots, "sh_AAA"), "sh1");
    assert.equal(resolveProjectShotId(shots, "nope"), null);
    assert.equal(resolveRunShotId(map, "sh_NOPE"), null);
    // 缺 runShotId 的 shot 不进映射（无法指回运行侧）
    const mixed = buildShotIdMap([{ id: "sh_CCC" }, { id: "sh_DDD", runShotId: "sh3" }]);
    assert.deepEqual(mixed.byRunShotId, { sh3: "sh_DDD" });
});

test("双向解析：同一 runShotId 指到多个 project shot → duplicate warning，保留先到者", () => {
    const { warnings } = buildShotIdMap([
        { id: "sh_X", runShotId: "sh1" },
        { id: "sh_Y", runShotId: "sh1" },
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "duplicate");
    assert.equal(resolveProjectShotId([{ id: "sh_X", runShotId: "sh1" }, { id: "sh_Y", runShotId: "sh1" }], "sh1"), "sh_X");
});

/* ------------------------------ ② 配对纯函数 ------------------------------ */

test("配对：Project 侧缺 index、Run 侧齐全 → 按全局 index 一一配对（存量项目现状）", () => {
    const runShots = Array.from({ length: 17 }, (_, i) => ({ id: `sh${i + 1}`, index: i + 1, sceneId: i < 9 ? "sc1" : "sc2" }));
    const projectShots = Array.from({ length: 17 }, (_, i) => ({ id: `sh_${String(i + 1).padStart(3, "0")}`, index: i + 1, episodeId: i < 9 ? "ep_0001" : "ep_0002" }));
    const match = matchProjectShotsToRunShots({ projectShots, runShots });
    assert.equal(match.pairs.length, 17);
    assert.ok(match.pairs.every((pair) => pair.via === "index"));
    assert.deepEqual(match.unmatchedProject, []);
    assert.deepEqual(match.unmatchedRun, []);
    assert.equal(match.byProjectShotId.sh_001, "sh1");
    assert.equal(match.byProjectShotId.sh_017, "sh17");
});

test("配对：已落地 runShotId（stored）优先，dangling 显式报警", () => {
    const runShots = [{ id: "sh9", index: 9 }];
    const stored = matchProjectShotsToRunShots({ projectShots: [{ id: "sh_K", index: 1, runShotId: "sh9" }], runShots });
    assert.deepEqual(stored.pairs, [{ projectShotId: "sh_K", runShotId: "sh9", via: "stored" }]);
    const dangling = matchProjectShotsToRunShots({ projectShots: [{ id: "sh_K", index: 1, runShotId: "shNOPE" }], runShots: [{ id: "sh9", index: 1 }] });
    assert.equal(dangling.pairs.length, 1, "仍按 index 兜底配对");
    assert.equal(dangling.pairs[0].via, "index");
    assert.equal(dangling.pairs[0].runShotId, "sh9");
    assert.ok(dangling.warnings.some((item) => item.code === "dangling"));
});

test("配对：无 index 时按同集顺序对位（order）", () => {
    const runShots = [
        { id: "sh1", episodeId: "ep_0001" },
        { id: "sh2", episodeId: "ep_0001" },
        { id: "sh3", episodeId: "ep_0002" },
    ];
    const projectShots = [
        { id: "sh_A", episodeId: "ep_0001" },
        { id: "sh_B", episodeId: "ep_0001" },
        { id: "sh_C", episodeId: "ep_0002" },
    ];
    const match = matchProjectShotsToRunShots({ projectShots, runShots });
    assert.deepEqual(match.pairs.map((p) => [p.projectShotId, p.runShotId, p.via]), [
        ["sh_A", "sh1", "order"],
        ["sh_B", "sh2", "order"],
        ["sh_C", "sh3", "order"],
    ]);
});

test("配对：两侧数量不一致 → 双向显式列出，绝不静默丢弃", () => {
    const runShots = [{ id: "sh1", index: 1 }, { id: "sh2", index: 2 }, { id: "sh3", index: 3 }];
    const projectShots = [{ id: "sh_A", index: 1 }, { id: "sh_B", index: 2 }];
    const match = matchProjectShotsToRunShots({ projectShots, runShots });
    assert.equal(match.pairs.length, 2);
    assert.deepEqual(match.unmatchedRun.map((item) => item.runShotId), ["sh3"]);
    assert.deepEqual(match.unmatchedProject, []);

    const match2 = matchProjectShotsToRunShots({ projectShots: [{ id: "sh_A", index: 1 }, { id: "sh_Z", index: 99 }], runShots: [{ id: "sh1", index: 1 }] });
    assert.deepEqual(match2.unmatchedProject.map((item) => item.projectShotId), ["sh_Z"]);
});

/* ------------------------------ ③ 回填纯函数幂等 ------------------------------ */

test("backfillProjectShotRunIds：首次填 runShotId、二次 changed=false（幂等）", () => {
    const runShots = [{ id: "sh1", index: 1 }, { id: "sh2", index: 2 }];
    const shots = [{ id: "sh_A", index: 1 }, { id: "sh_B", index: 2 }];
    const first = backfillProjectShotRunIds({ projectShots: shots, runShots });
    assert.equal(first.changed, true);
    assert.equal(first.shots[0][RUN_SHOT_ID_FIELD], "sh1");
    assert.equal(first.shots[1][RUN_SHOT_ID_FIELD], "sh2");
    const second = backfillProjectShotRunIds({ projectShots: first.shots, runShots });
    assert.equal(second.changed, false, "重复回填不改动");
    assert.deepEqual(second.shots, first.shots);
    // 入参未被改写
    assert.equal(shots[0][RUN_SHOT_ID_FIELD], undefined);
});

/* ------------------------------ ④⑤ 编排器接线（假 LLM + 假队列） ------------------------------ */

const SCRIPT_OUTPUT = {
    logline: "末班车的约定",
    synopsis: "深夜末班车上的相遇与承诺。",
    characters: [{ id: "c1", name: "老周", profile: "司机", appearance: "中年", voice: "低沉" }],
    scenes: [
        { id: "sc1", title: "车上", time: "夜", intent: "相遇", beats: ["上车"] },
        { id: "sc2", title: "站牌", time: "夜", intent: "承诺", beats: ["下车"] },
    ],
    episodes: [
        { id: "ep1", index: 1, title: "相遇", durationSec: 30, synopsis: "起", sceneIds: ["sc1"] },
        { id: "ep2", index: 2, title: "承诺", durationSec: 30, synopsis: "承", sceneIds: ["sc2"] },
    ],
};

const STORYBOARD_OUTPUT = {
    shots: [
        { id: "sh1", episodeId: "ep1", sceneId: "sc1", index: 1, durationSec: 5, shotSize: "全景", camera: "固定", action: "上车", dialogue: "", audio: "", prompt: "a" },
        { id: "sh2", episodeId: "ep1", sceneId: "sc1", index: 2, durationSec: 4, shotSize: "近景", camera: "推", action: "回头", dialogue: "", audio: "", prompt: "b" },
        { id: "sh3", episodeId: "ep2", sceneId: "sc2", index: 3, durationSec: 6, shotSize: "中景", camera: "固定", action: "下车", dialogue: "", audio: "", prompt: "c" },
        { id: "sh4", episodeId: "ep2", sceneId: "sc2", index: 4, durationSec: 4, shotSize: "全景", camera: "拉", action: "蹲下", dialogue: "", audio: "", prompt: "d" },
    ],
};

const FRAMES_OUTPUT = {
    frames: STORYBOARD_OUTPUT.shots.map((shot) => ({ id: `${shot.id}-start`, shotId: shot.id, role: "start", prompt: shot.prompt, textOverlays: [] })),
};

const MD = (name, desc, prompt) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}\n`;

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-shotmap-"));
    const skillsDir = join(root, "skills");
    const files = {
        "01-script": MD("novel-to-script", "测试剧本", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes/episodes 的 JSON。"),
        "02-storyboard": MD("storyboard", "测试分镜", "你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。"),
        "04-keyframes": MD("keyframes", "测试关键帧", "你是关键帧提示词工程师，返回含 frames 数组的 JSON。"),
    };
    for (const [dir, content] of Object.entries(files)) {
        mkdirSync(join(skillsDir, dir), { recursive: true });
        writeFileSync(join(skillsDir, dir, "SKILL.md"), content);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
                { id: "assembly", title: "粗剪", skill: "05-assembly", requires: ["keyframe"], produces: "assembly" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { imageTemplate: "img-test", videoTemplate: "video-test", videoSeconds: 5, videoFps: 24, maxNovelChunkChars: 16000 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function fakeLlm() {
    return {
        async chat(options) {
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("关键帧提示词工程师")
                ? FRAMES_OUTPUT
                : content.includes("分镜师")
                  ? STORYBOARD_OUTPUT
                  : content.includes("分集规划师")
                    ? { episodes: SCRIPT_OUTPUT.episodes }
                    : SCRIPT_OUTPUT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function fakeJobs() {
    const store = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        enqueue(job) {
            const created = { ...job, status: "queued", outputs: [], createdAt: new Date().toISOString() };
            store.set(created.id, created);
            emit(created);
            return created;
        },
        get: (id) => store.get(id) || null,
        list: () => [...store.values()],
        on(event, handler) {
            if (event === "change") handlers.push(handler);
            return () => {};
        },
        finish(id, status, patch = {}) {
            const job = store.get(id);
            Object.assign(job, patch, { status, finishedAt: new Date().toISOString() });
            emit(job);
            return job;
        },
    };
}

function setup(t) {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const projects = createProjects({ dataDir: env.config.dataDir });
    const jobs = fakeJobs();
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm: fakeLlm(),
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
        applyScriptProjection: (id, output) => projects.applyScriptProjection(id, output),
        applyEpisodeProjection: (id, output) => projects.applyEpisodeProjection(id, output),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
        registerAssetRef: (id, input) => projects.assets.create(id, input),
    });
    pipeline.bindJobs();
    return { env, projects, pipeline, jobs };
}

function finishFrame(env, jobs, runId, itemId) {
    const jobId = `${runId}-${itemId}`;
    const dir = join(env.config.dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.png"), "png");
    return jobs.finish(jobId, "done", { template: "img_qwen2_edit", outputs: [{ url: `/api/artifacts/${jobId}/out.png`, type: "image" }] });
}

async function seedThroughKeyframe(env, projects, pipeline, jobs) {
    const project = projects.create({ title: "shot 映射", plan: { episodeCount: 2, episodeDurationSec: 30 } });
    projects.assets.create(project.id, { role: "character", bindingId: "c1" });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    for (const frame of FRAMES_OUTPUT.frames) finishFrame(env, jobs, run.id, frame.id);
    return { project, run };
}

test("接线④：关键帧投影把 runShotId 落到 Project 侧 shot（存量项目也能回填），重复投影不改 version", async (t) => {
    const { env, projects, pipeline, jobs } = setup(t);
    const { project, run } = await seedThroughKeyframe(env, projects, pipeline, jobs);

    const stored = projects.get(project.id);
    const ep1 = stored.episodes.find((episode) => episode.id === "ep_0001");
    const ep2 = stored.episodes.find((episode) => episode.id === "ep_0002");
    assert.deepEqual(ep1.shots.map((shot) => shot.runShotId), ["sh1", "sh2"], "ep_0001 回指 sh1/sh2");
    assert.deepEqual(ep2.shots.map((shot) => shot.runShotId), ["sh3", "sh4"], "ep_0002 回指 sh3/sh4");
    for (const shot of [...ep1.shots, ...ep2.shots]) {
        assert.match(shot.id, /^sh_/, "Project 侧稳定主键保留");
        assert.ok(shot.runShotId, "同时带运行侧 id 桥字段");
        assert.equal(resolveProjectShotId([...ep1.shots, ...ep2.shots], shot.runShotId), shot.id, "双向解析可反查");
    }

    // 幂等：再投一遍同样的终态任务（等价于重启后 bindJobs 重放）→ 集结构与 version 不变。
    const versionAfterFirst = stored.version;
    const episodesAfterFirst = JSON.parse(JSON.stringify(stored.episodes));
    const detailPath = join(env.config.dataDir, "projects", project.id, "episodes", "ep_0001.json");
    const detailAfterFirst = readFileSync(detailPath, "utf8");
    for (const frame of FRAMES_OUTPUT.frames) pipeline.projectJob(jobs.get(`${run.id}-${frame.id}`));
    const afterSecond = projects.get(project.id);
    assert.deepEqual(afterSecond.episodes, episodesAfterFirst, "重复投影集结构不变");
    assert.equal(afterSecond.version, versionAfterFirst, "派生投影不改 version");
    assert.equal(readFileSync(detailPath, "utf8"), detailAfterFirst, "集详情无变化不写盘");
});

test("接线⑤：Run 侧存量产物的 episodeId 由终态 Job 重放回填（9+8 语义），幂等且不改产物文件", async (t) => {
    const { env, projects, pipeline, jobs } = setup(t);
    const { project, run } = await seedThroughKeyframe(env, projects, pipeline, jobs);
    const runFile = join(env.config.dataDir, "runs", run.id, "run.json");

    // 模拟「存量 run」：storyboard shots 与 assembly clips 的 episodeId 都是 null（归一线提交后才会有值，但当时未回填）。
    const legacyShots = STORYBOARD_OUTPUT.shots.map((shot) => ({ ...shot, episodeId: null }));
    pipeline.setStageInput(run.id, "storyboard", { output: { shots: legacyShots } });
    const legacyClips = legacyShots.map((shot) => ({ id: `${shot.id}-clip`, shotId: shot.id, episodeId: null, status: "done", artifactUrl: `/api/artifacts/${shot.id}.mp4` }));
    pipeline.setStageInput(run.id, "assembly", { output: { clips: legacyClips, assembly: { order: legacyClips.map((clip) => clip.id), transition: "cut", status: "queued" } } });
    assert.deepEqual(pipeline.get(run.id).stages.storyboard.output.shots.map((shot) => shot.episodeId), [null, null, null, null]);

    // 重放一个关键帧终态 Job（= 服务重启时 bindJobs 行为）→ recomputeStage 收口触发回填。
    pipeline.projectJob(jobs.get(`${run.id}-sh1-start`));

    const after = pipeline.get(run.id);
    assert.deepEqual(after.stages.storyboard.output.shots.map((shot) => shot.episodeId), ["ep_0001", "ep_0001", "ep_0002", "ep_0002"], "shots 集号按场次归属归一为项目集 id");
    assert.deepEqual(after.stages.assembly.output.clips.map((clip) => clip.episodeId), ["ep_0001", "ep_0001", "ep_0002", "ep_0002"], "clips 归属集同步");
    assert.deepEqual(after.stages.storyboard.output.episodes.map((episode) => [episode.id, episode.shotIds]), [["ep_0001", ["sh1", "sh2"]], ["ep_0002", ["sh3", "sh4"]]]);

    // 产物文件本身未被改动（只有 run 记录里的归属键变化）。
    assert.equal(existsSync(join(env.config.dataDir, "artifacts", `${run.id}-sh1-start`, "out.png")), true);
    assert.equal(readFileSync(join(env.config.dataDir, "artifacts", `${run.id}-sh1-start`, "out.png"), "utf8"), "png");

    // 幂等：再重放一次，storyboard/clips 的归属键一字不变（不重复写、不追加）。
    const shotsAfterFirst = JSON.stringify(after.stages.storyboard.output.shots);
    const clipsAfterFirst = JSON.stringify(after.stages.assembly.output.clips);
    pipeline.projectJob(jobs.get(`${run.id}-sh2-start`));
    const afterSecond = pipeline.get(run.id);
    assert.equal(JSON.stringify(afterSecond.stages.storyboard.output.shots), shotsAfterFirst, "第二次回填 shots 不变");
    assert.equal(JSON.stringify(afterSecond.stages.assembly.output.clips), clipsAfterFirst, "第二次回填 clips 不变");
    assert.ok(existsSync(runFile), "run.json 落盘");
});

test("归一：17 镜 2 集按场次归属切成 9+8，与项目侧 shotIds 一一对应", () => {
    const episodes = [
        { id: "ep_0001", index: 1, sceneIds: ["sc1"] },
        { id: "ep_0002", index: 2, sceneIds: ["sc2"] },
    ];
    const shots = Array.from({ length: 17 }, (_, i) => ({ id: `sh${i + 1}`, index: i + 1, sceneId: i < 9 ? "sc1" : "sc2" }));
    const { shots: out, episodes: eps } = normalizeShotEpisodeIds({ shots, episodes });
    assert.deepEqual([out.filter((s) => s.episodeId === "ep_0001").length, out.filter((s) => s.episodeId === "ep_0002").length], [9, 8]);
    assert.deepEqual(eps.map((episode) => episode.shotIds.length), [9, 8]);
});

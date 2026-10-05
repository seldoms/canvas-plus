import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";
import { loadRegistry } from "../src/skills.js";

/**
 * #48 关键帧投影回归：keyframe 阶段的 frames[] 必须幂等投影进 Project 侧
 * `episodes[].shots[].generationSlots[]`（gates.js 判 keyframe done 的唯一依据），
 * 让 assembly 门禁真正放行。覆盖：done 后放行 / 用已跑完结果回填 / 幂等不重复不改 version /
 * 未完成不误判 done / 复用既有稳定 shot id（真数据形状）。
 * 全程假 LLM + 假任务队列 + 真实 Project 存储，绝不真跑模型、绝不触发真生成。
 */

const SCRIPT_OUTPUT = {
    logline: "末班车上的约定",
    synopsis: "深夜末班车上，司机与女孩的相遇。",
    characters: [{ id: "c1", name: "老周", profile: "司机", appearance: "中年", voice: "低沉" }],
    scenes: [
        { id: "sc1", title: "公交车内", time: "夜", intent: "相遇", beats: ["上车"] },
        { id: "sc2", title: "站牌下", time: "夜", intent: "揭示", beats: ["下车"] },
    ],
    episodes: [{ id: "ep1", index: 1, title: "相遇", durationSec: 30, synopsis: "起", sceneIds: ["sc1", "sc2"] }],
};

const STORYBOARD_OUTPUT = {
    shots: [
        { id: "sh1", sceneId: "sc1", index: 1, durationSec: 5, shotSize: "全景", camera: "固定", action: "公交车驶入", dialogue: "", audio: "", prompt: "a bus arrives", negativePrompt: "" },
        { id: "sh2", sceneId: "sc1", index: 2, durationSec: 4, shotSize: "近景", camera: "固定", action: "老周问话", dialogue: "去哪儿", audio: "", prompt: "the driver asks", negativePrompt: "" },
        { id: "sh3", sceneId: "sc2", index: 3, durationSec: 6, shotSize: "中景", camera: "固定", action: "女孩下车", dialogue: "", audio: "", prompt: "the girl steps off", negativePrompt: "" },
    ],
};

const FRAMES_OUTPUT = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "夜间公交车停靠，全景", textOverlays: [] },
        { id: "sh2-start", shotId: "sh2", role: "start", prompt: "司机回头问话，近景", textOverlays: [] },
        { id: "sh3-start", shotId: "sh3", role: "start", prompt: "女孩走下台阶，中景", textOverlays: [] },
    ],
};

const SCRIPT_MD = `---
name: novel-to-script
description: 测试剧本
---

# 剧本

## 提示词模板

你是影视剧本改编，返回含 logline/synopsis/characters/scenes/episodes 的 JSON。
`;

const STORYBOARD_MD = `---
name: storyboard
description: 测试分镜
---

# 分镜

## 提示词模板

你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。
`;

const KEYFRAME_MD = `---
name: keyframes
description: 测试关键帧
---

# 关键帧

## 提示词模板

你是关键帧提示词工程师，返回含 frames 数组的 JSON。
`;

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-keyframe-proj-"));
    const skillsDir = join(root, "skills");
    const files = { "01-script": SCRIPT_MD, "02-storyboard": STORYBOARD_MD, "04-keyframes": KEYFRAME_MD };
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
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { imageTemplate: "img-test", videoTemplate: "video-test", videoSeconds: 5, videoFps: 24, maxNovelChunkChars: 16000 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

/** 按提示词里的阶段标记分流的假 LLM（script 的 analyze / outline 也各自命中）。 */
function fakeLlm() {
    return {
        calls: [],
        async chat(options) {
            this.calls.push(options);
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

/** 可控任务源：不真跑，靠 finish 手动推终态来驱动 Job→流水线的回写投影。 */
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

const gateById = (gates) => Object.fromEntries(gates.map((gate) => [gate.stageId, gate]));

function setup(t) {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    // M0：门禁阶段由调用方注入；本测试 registry 只到 keyframe，补一个 assembly 定义（requires=keyframe），
    // 与测试断言的 assembly 门禁对齐（gates.js 不再内置阶段数组）。
    const stages = [...loadRegistry(env.skillsDir).stages, { id: "assembly", title: "片段合成", requires: ["keyframe"] }];
    const projects = createProjects({ dataDir: env.config.dataDir, stages });
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

/** 为关键帧条目补一个「磁盘上真的存在」的产物文件，并把该 job 推成 done（触发回写投影）。 */
function finishFrame(env, jobs, runId, itemId) {
    const jobId = `${runId}-${itemId}`;
    const dir = join(env.config.dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.png"), "png");
    return jobs.finish(jobId, "done", { template: "img_qwen21_edit", outputs: [{ url: `/api/artifacts/${jobId}/out.png`, type: "image" }] });
}

async function seedRun(env, projects, pipeline) {
    const project = projects.create({ title: "关键帧投影", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    // design 门禁 done 依据 = 项目有 assetRefs（gates.js 独立于 registry 判上游）。
    projects.assets.create(project.id, { role: "character", bindingId: "c1" });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    return { project, run };
}

// ——— ① 关键帧 done 后投影到位：shots[].generationSlots 就位，keyframe done、assembly ready ———

test("关键帧投影：done 后 episodes[].shots[].generationSlots 就位，keyframe done=true、assembly ready=true", async (t) => {
    const { env, projects, pipeline, jobs } = setup(t);
    const { project, run } = await seedRun(env, projects, pipeline);

    // 跑关键帧：入队 3 个 start 帧，此时阶段 running，门禁不应放行。
    await pipeline.runStage(run.id, "keyframe");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running", "有任务在跑 → running");
    let gates = gateById(projects.gates(project.id));
    assert.equal(gates.keyframe.done, false, "关键帧未完成 → 不误判 done");
    assert.equal(gates.assembly.ready, false, "关键帧未 done → assembly 仍被挡");

    // 把 3 个任务推成 done（模拟「关键帧已跑完」），回写投影应把结果落进 Project 侧。
    for (const frame of FRAMES_OUTPUT.frames) finishFrame(env, jobs, run.id, frame.id);
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "done", "全部终态 → 阶段 done");

    gates = gateById(projects.gates(project.id));
    assert.equal(gates.keyframe.ready, true);
    assert.equal(gates.keyframe.done, true, "关键帧产物已投影 → 门禁判得出 done");
    assert.equal(gates.assembly.ready, true, "assembly 不再被 keyframe 挡（#48 修复点）");
    assert.deepEqual(gates.assembly.blockedBy, []);

    // Project 侧形状：集详情与 project.episodes 都有 shots[]/shotIds[]。
    const stored = projects.get(project.id);
    const episode = stored.episodes[0];
    assert.equal(episode.shots.length, 3, "episodes[].shots[] 已建起来");
    assert.equal(episode.shotIds.length, 3, "episodes[].shotIds[] 已回填");
    assert.deepEqual(episode.shotIds, episode.shots.map((shot) => shot.id));

    const byShot = new Map(episode.shots.map((shot) => [shot.id, shot]));
    for (const shot of episode.shots) {
        assert.match(shot.id, /^sh_/, "shot.id 是稳定 sh_ 主键（契约 §3.4）");
        assert.equal(shot.episodeId, episode.id);
        assert.equal(shot.generationSlots.length, 1);
        const slot = shot.generationSlots[0];
        assert.equal(slot.id, `slot_${shot.id}_start`, "slot 主键 = slot_<shotId>_<role>（契约 §3.5）");
        assert.equal(slot.shotId, shot.id);
        assert.equal(slot.role, "start");
        assert.ok(slot.selected, "selected 指向采用候选的 jobId");
        const adopted = slot.candidates.find((candidate) => candidate.jobId === slot.selected);
        assert.ok(adopted, "selected 的 jobId 能在 candidates 里找到");
        assert.equal(adopted.status, "done");
        assert.match(String(adopted.artifactUrl), /^\/api\/artifacts\//, "候选带产物 URL");
        assert.ok(adopted.template, "候选带 template");
        assert.equal(shot.status, "done");
        assert.ok(byShot.has(shot.id));
    }

    // 集详情文件同样带上 shots（gateEpisodes 优先读盘上详情）。
    const detail = JSON.parse(readFileSync(join(env.config.dataDir, "projects", project.id, "episodes", `${episode.id}.json`), "utf8"));
    assert.equal(detail.shots.length, 3);
    assert.equal(detail.shots[0].generationSlots.length, 1);

    // context（索引形状）也带上 shots。
    const context = projects.context(project.id);
    assert.equal(context.episodes[0].shots.length, 3);
});

// ——— ② 幂等：重复回写不重复、不改 version、不改产物 ———

test("关键帧投影幂等：重复回写不重复写盘、shot 不重复、project.version 不变", async (t) => {
    const { env, projects, pipeline, jobs } = setup(t);
    const { project, run } = await seedRun(env, projects, pipeline);
    await pipeline.runStage(run.id, "keyframe");
    for (const frame of FRAMES_OUTPUT.frames) finishFrame(env, jobs, run.id, frame.id);

    const afterFirst = projects.get(project.id);
    const versionAfterFirst = afterFirst.version;
    const detailPath = join(env.config.dataDir, "projects", project.id, "episodes", `${afterFirst.episodes[0].id}.json`);
    const detailAfterFirst = readFileSync(detailPath, "utf8");

    // 再投一遍同样的终态任务（等价于重启后 bindJobs 重放 / 重复事件）。
    for (const frame of FRAMES_OUTPUT.frames) pipeline.projectJob(jobs.get(`${run.id}-${frame.id}`));

    const afterSecond = projects.get(project.id);
    assert.equal(afterSecond.episodes[0].shots.length, 3, "不重复建镜");
    assert.deepEqual(afterSecond.episodes, afterFirst.episodes, "集结构一字不变");
    assert.equal(afterSecond.version, versionAfterFirst, "派生投影不改 version（D7 乐观并发不被污染）");
    assert.equal(readFileSync(detailPath, "utf8"), detailAfterFirst, "集详情文件未重写（无变化不写盘）");
});

// ——— ③ 未完成不误判：部分 done 仍不放行 ———

test("关键帧未完成不误判：部分 done 时 keyframe/assembly 仍不放行", async (t) => {
    const { env, projects, pipeline, jobs } = setup(t);
    const { project, run } = await seedRun(env, projects, pipeline);
    await pipeline.runStage(run.id, "keyframe");
    finishFrame(env, jobs, run.id, "sh1-start");
    finishFrame(env, jobs, run.id, "sh2-start");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "running", "还有任务在排队 → running");

    let gates = gateById(projects.gates(project.id));
    assert.equal(gates.keyframe.done, false, "未全完成 → 不误判 done");
    assert.equal(gates.assembly.ready, false);
    assert.deepEqual(projects.get(project.id).episodes[0].shots ?? [], [], "阶段未 done 不投影任何镜");

    // 最后一个条目落到 canceled（无 queued/running）→ partial，仍不放行。
    jobs.finish(`${run.id}-sh3-start`, "canceled");
    assert.equal(pipeline.get(run.id).stages.keyframe.status, "partial", "有终态但有失败/取消 → partial");
    gates = gateById(projects.gates(project.id));
    assert.equal(gates.keyframe.done, false, "partial 不误判 done");
    assert.equal(gates.assembly.ready, false);
    assert.deepEqual(projects.get(project.id).episodes[0].shots ?? [], [], "partial 阶段不投影任何镜");
});

// ——— ④ 复用既有稳定 shot id（真数据形状）：不新建、不覆盖、只填 generationSlots ———

test("关键帧投影复用既有稳定 shot id：保留 ULID 主键，只填 generationSlots", async (t) => {
    const { env, projects, pipeline, jobs } = setup(t);
    const project = projects.create({ title: "既有镜", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    projects.assets.create(project.id, { role: "character", bindingId: "c1" });
    // 先用真实存储建集 / 场 / 镜（模拟 UI 或 storyboard→项目 已落地的稳定 sh_ 主键）。
    const saved = projects.episodes.save(project.id, { title: "相遇" });
    const episodeId = saved.episode.id;
    const scene1 = projects.episodes.addScene(project.id, episodeId, { locationId: "内景 公交车内", time: "夜", intent: "相遇" }).scene;
    const scene2 = projects.episodes.addScene(project.id, episodeId, { locationId: "外景 站牌下", time: "夜", intent: "揭示" }).scene;
    const shot1 = projects.episodes.addShot(project.id, scene1.id, { index: 1, storyboard: { prompt: "bus arrives" } }).shot;
    const shot2 = projects.episodes.addShot(project.id, scene1.id, { index: 2, storyboard: { prompt: "driver asks" } }).shot;
    const shot3 = projects.episodes.addShot(project.id, scene2.id, { index: 3, storyboard: { prompt: "girl steps off" } }).shot;
    assert.match(shot1.id, /^sh_/);

    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    pipeline.setStageInput(run.id, "script", { output: SCRIPT_OUTPUT });
    await pipeline.runStage(run.id, "storyboard");
    await pipeline.runStage(run.id, "keyframe");
    for (const frame of FRAMES_OUTPUT.frames) finishFrame(env, jobs, run.id, frame.id);

    const episode = projects.get(project.id).episodes[0];
    assert.equal(episode.shots.length, 3, "复用既有 3 镜，不新建、不重复");
    assert.deepEqual(
        episode.shots.map((shot) => shot.id).sort(),
        [shot1.id, shot2.id, shot3.id].sort(),
        "既有稳定 sh_ 主键被保留",
    );
    for (const shot of episode.shots) {
        assert.equal(shot.generationSlots.length, 1);
        assert.ok(shot.generationSlots[0].selected, "既有镜也拿到 selected");
    }
    assert.match(episode.shots.find((shot) => shot.id === shot3.id).sceneId, /^sc_/, "新建/复用镜的 sceneId 落到集内真实场次");
    assert.equal(existsSync(join(env.config.dataDir, "projects", project.id, "episodes", `${episodeId}.json`)), true);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";
import { loadRegistry } from "../src/skills.js";

/**
 * 门禁投影缺口回归：① 脚本 episodes/scenes → Project.episodes（storyboard done）② 服化道产物 → AssetRef（design done）。
 * 全用假 LLM + 真实 Project 存储，绝不真跑模型；验证「关键帧阶段在两个上游 done 后 ready=true」。
 */

const SCRIPT_OUTPUT = {
    logline: "末班车的约定",
    synopsis: "深夜末班车上，司机与女孩的相遇。",
    characters: [
        { id: "c1", name: "老周", profile: "司机", appearance: "中年", voice: "低沉" },
        { id: "c2", name: "女孩", profile: "乘客", appearance: "青年", voice: "轻细" },
    ],
    scenes: [
        { id: "sc1", title: "末班车上的女孩", location: "内景 - 公交车内", time: "夜", intent: "悬念", beats: ["上车"] },
        { id: "sc2", title: "站牌下的旧车票", location: "外景 - 站牌下", time: "夜", intent: "揭示", beats: ["下车"] },
    ],
    episodes: [{ id: "ep1", index: 1, title: "第一集", durationSec: 30, synopsis: "起", sceneIds: ["sc1", "sc2"] }],
};

const DESIGN_OUTPUT = {
    characters: [
        { id: "c1", name: "老周", outfit: "深藏青司机制服" },
        { id: "c2", name: "女孩", outfit: "米白薄外套" },
    ],
    locations: [
        { id: "loc1", name: "公交车内", setDressing: "蓝色座椅" },
        { id: "loc2", name: "站牌下", setDressing: "金属站牌" },
    ],
};

/** 按提示词里的阶段标记分流的假 LLM：服化道 / 分集规划 / 其余（整篇剧本）。 */
function fakeLlm() {
    return {
        calls: [],
        async chat(options) {
            this.calls.push(options);
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("服化道师")
                ? DESIGN_OUTPUT
                : content.includes("分集规划师")
                  ? { episodes: SCRIPT_OUTPUT.episodes }
                  : SCRIPT_OUTPUT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-gate-proj-"));
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "测试剧本", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes/episodes 的 JSON。\n小说原文：\n{{novel}}\n"],
        "02-storyboard": ["storyboard", "测试分镜", "你是分镜师，把剧本拆成分镜，返回含 shots 数组的 JSON。\n剧本：\n{{script}}\n"],
        "03-costume-props": ["costume-props", "测试服化道", "你是服化道师，为角色写服装/妆发、为场景写置景，返回含 characters/locations 的 JSON。\n剧本：\n{{script}}\n"],
        "04-keyframes": ["keyframes", "测试关键帧", "你是关键帧提示词工程师，返回含 frames 数组的 JSON。\n分镜：\n{{storyboard}}\n"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(
            join(skillsDir, id, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}`,
        );
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "design", title: "服化道", skill: "03-costume-props", requires: ["script"], produces: "design" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design"], produces: "keyframes" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { maxNovelChunkChars: 16000, videoSeconds: 5, videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

const gateById = (gates) => Object.fromEntries(gates.map((gate) => [gate.stageId, gate]));

/** 真实 Project 存储 + 假 LLM 的编排器（注入全部派生投影钩子，与 index.js 接线一致）。 */
function build(env, projects, { llm = fakeLlm(), applyEpisodeProjection } = {}) {
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { enqueue: (job) => ({ ...job, status: "queued", outputs: [] }) },
        comfy: {},
        llm,
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
        applyScriptProjection: (id, output) => projects.applyScriptProjection(id, output),
        applyEpisodeProjection: applyEpisodeProjection || ((id, output) => projects.applyEpisodeProjection(id, output)),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
        registerAssetRef: (id, input) => projects.assets.create(id, input),
    });
    return { pipeline, llm };
}

function setup(t) {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-gate-proj-store-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    // M0：门禁阶段由调用方注入（与本测试的 registry 同源），gates.js 不再内置阶段数组。
    const projects = createProjects({ dataDir: projectsRoot, stages: loadRegistry(env.skillsDir).stages });
    return { env, projects };
}

// ——— ① 脚本投影：episodes/scenes 真正落进 Project.episodes，storyboard 门禁 done ———

test("脚本投影：episodes/scenes 落进 Project.episodes，context 返回真实集，storyboard 门禁 done=true", async (t) => {
    const { env, projects } = setup(t);
    const { pipeline } = build(env, projects);
    const project = projects.create({ title: "投影", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");

    const stored = projects.get(project.id);
    assert.equal(stored.episodes.length, 1, "episodes 已投影进 Project.episodes");
    const episode = stored.episodes[0];
    assert.equal(episode.id, "ep_0001");
    assert.equal(episode.index, 1);
    assert.equal(episode.title, "第一集");
    assert.equal(episode.scenes.length, 2, "集内嵌 scenes[]");
    assert.deepEqual(episode.scenes.map((scene) => scene.id), ["sc_0001", "sc_0002"]);
    assert.equal(episode.scenes[0].title, "末班车上的女孩", "scene 至少含 id/title");
    assert.equal(episode.scenes[0].locationId, "内景 - 公交车内");

    // context 默认形状直接返回真实集（前端「关键帧」工作区据此不再空）
    const context = projects.context(project.id);
    assert.equal(context.episodes.length, 1);

    // 门禁：storyboard 的 done 来源（episode.scenes.length>0）到位
    const gates = gateById(projects.gates(project.id));
    assert.equal(gates.script.done, true, "script 有剧本产物");
    assert.equal(gates.storyboard.ready, true, "上游 script done");
    assert.equal(gates.storyboard.done, true, "脚本投影后 storyboard 判得出 done");
    assert.equal(gates.keyframe.blockedBy.some((item) => item.type === "upstream" && item.stageId === "storyboard"), false, "关键帧不再被 storyboard 挡");
    assert.equal(gates.keyframe.ready, false, "design 未完成 → 关键帧仍被 design 挡");
});

// ——— ② 服化道登记：design 门禁 done，keyframe 两上游 done 后 ready ———

test("服化道登记：design 产出登记 character/scene AssetRef，design done、keyframe ready=true", async (t) => {
    const { env, projects } = setup(t);
    const { pipeline } = build(env, projects);
    const project = projects.create({ title: "服化道", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "design");

    const stored = projects.get(project.id);
    const refs = stored.assetRefs;
    assert.deepEqual(
        refs.map((ref) => [ref.role, ref.bindingId]),
        [
            ["character", "c1"],
            ["character", "c2"],
            ["scene", "loc1"],
            ["scene", "loc2"],
        ],
        "角色→character / 场景→scene，bindingId 取剧本 id",
    );
    assert.equal(refs.every((ref) => ref.metadata.stageId === "design" && ref.metadata.runId === run.id), true);

    const gates = gateById(projects.gates(project.id));
    assert.equal(gates.design.ready, true);
    assert.equal(gates.design.done, true, "有 assetRefs → design 判得出 done");
    assert.equal(gates.keyframe.ready, true, "storyboard + design 都 done → 关键帧放行");
    assert.deepEqual(gates.keyframe.blockedBy, []);
    assert.equal(gates.keyframe.done, false, "还没跑关键帧，无可选产物");

    // 幂等：design 阶段重跑不重复登记
    await pipeline.runStage(run.id, "design");
    assert.equal(projects.get(project.id).assetRefs.length, 4, "重复跑 design 不重复登记");
});

// ——— ③ 重复投影幂等：不重复写、不涨 version ———

test("重复投影幂等：第二次脚本投影不写盘、不重复 episodes、不涨 version", async (t) => {
    const { env, projects } = setup(t);
    let applied = 0;
    const { pipeline } = build(env, projects, {
        applyEpisodeProjection: (id, output) => {
            const result = projects.applyEpisodeProjection(id, output);
            if (result.applied) applied += 1;
            return result;
        },
    });
    const project = projects.create({ title: "幂等", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    assert.equal(applied, 1, "首次投影写盘一次");
    const afterFirst = projects.get(project.id);
    assert.equal(afterFirst.episodes.length, 1);
    const versionAfterFirst = afterFirst.version;

    await pipeline.runStage(run.id, "script");
    assert.equal(applied, 1, "重复投影不再写盘");
    const afterSecond = projects.get(project.id);
    assert.equal(afterSecond.episodes.length, 1, "集不重复追加");
    assert.deepEqual(afterSecond.episodes, afterFirst.episodes, "集结构一字不变");
    assert.equal(afterSecond.version, versionAfterFirst, "派生投影不改 version（D7 乐观并发不被污染）");
});

// ——— ④ 旧数据不动：已有真实集时投影不覆盖 ———

test("旧数据不动：项目已有真实集时脚本投影不覆盖", (t) => {
    const { projects } = setup(t);
    const project = projects.create({ title: "保护" });
    projects.episodes.save(project.id, { title: "人工建的集" });
    const before = projects.get(project.id).episodes;
    assert.equal(before.length, 1);

    const result = projects.applyEpisodeProjection(project.id, SCRIPT_OUTPUT);
    assert.equal(result.applied, false, "已有非空集 → 投影跳过");
    assert.deepEqual(projects.get(project.id).episodes, before, "人工集一字不动");
});

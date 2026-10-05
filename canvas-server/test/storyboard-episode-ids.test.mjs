import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeShotEpisodeIds } from "../src/production-contracts.js";
import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";
import { loadRegistry } from "../src/skills.js";

/**
 * 「集」成为可分区事实键（development-plan §3.1）：
 * ① 纯函数 normalizeShotEpisodeIds：shot.episodeId 归一 + episodes[].shotIds/sceneIds 回填 + 不可判定不静默丢弃；
 * ② 编排器接线：分镜阶段产出后归一，回填 project.episodes[].shotIds（gates/context 可见）、幂等、不改 version。
 */

/* ------------------------------ ① 纯函数 ------------------------------ */

const PROJECT_EPISODES = [
    { id: "ep_0001", index: 1, title: "末班车", sceneIds: ["sc_0001"] },
    { id: "ep_0002", index: 2, title: "车票", sceneIds: ["sc_0002"] },
];

test("归一：shot.episodeId 精确命中真实集 id → 原样保留，不产 warning", () => {
    const shots = [
        { id: "sh1", episodeId: "ep_0002", sceneId: "sc2", index: 1 },
        { id: "sh2", episodeId: "ep_0001", sceneId: "sc1", index: 2 },
    ];
    const { shots: out, episodes, warnings } = normalizeShotEpisodeIds({ shots, episodes: PROJECT_EPISODES });
    assert.deepEqual(
        out.map((shot) => [shot.id, shot.episodeId]),
        [
            ["sh1", "ep_0002"],
            ["sh2", "ep_0001"],
        ],
        "命中的真实 id 一字不改",
    );
    assert.deepEqual(warnings, [], "命中即无 warning");
    assert.deepEqual(episodes.map((episode) => [episode.id, episode.shotIds]), [
        ["ep_0001", ["sh2"]],
        ["ep_0002", ["sh1"]],
    ], "反向映射按顺序回填");
});

test("归一：LLM 写 ep1 / 第1集 / 空 → 映射到真实 id（序号别名 + 顺位兜底）", () => {
    const shots = [
        { id: "sh1", episodeId: "ep1", sceneId: "scX", index: 1 }, // 序号别名 → 第 1 集
        { id: "sh2", episodeId: "第2集", sceneId: "scX", index: 2 }, // 中文序号 → 第 2 集
        { id: "sh3", episodeId: "", sceneId: "scX", index: 3 }, // 空 → 顺位兜底
        { id: "sh4", episodeId: "3", sceneId: "scX", index: 4 }, // 越界序号（无第 3 集）→ 场次/顺位兜底
    ];
    const { shots: out, warnings } = normalizeShotEpisodeIds({ shots, episodes: PROJECT_EPISODES });
    assert.equal(out[0].episodeId, "ep_0001", "ep1 → ep_0001");
    assert.equal(out[1].episodeId, "ep_0002", "第2集 → ep_0002");
    assert.ok(["ep_0001", "ep_0002"].includes(out[2].episodeId), "空值被兜底归入某真实集");
    assert.ok(["ep_0001", "ep_0002"].includes(out[3].episodeId), "越界序号被兜底归入某真实集");
    assert.ok(warnings.length >= 2, "非权威 / 缺集号必须产 warning，不静默");
    assert.ok(warnings.some((item) => item.code === "remapped"), "别名归一有 remapped");
});

test("归一：shot.sceneId 判定归属（含跨命名体系 sc1 ≡ sc_0001）", () => {
    const shots = [
        { id: "sh1", sceneId: "sc1", index: 1 },
        { id: "sh2", sceneId: "sc2", index: 2 },
    ];
    const { shots: out, episodes } = normalizeShotEpisodeIds({ shots, episodes: PROJECT_EPISODES });
    assert.deepEqual(out.map((shot) => shot.episodeId), ["ep_0001", "ep_0002"], "剧本 sc1/sc2 命中项目 sc_0001/sc_0002");
    assert.deepEqual(episodes.map((episode) => episode.shotIds), [["sh1"], ["sh2"]]);
});

test("归一：顺位均分兜底无任何线索时按各集容量等比切分（17 镜 / 2 集 → 9+8）", () => {
    const shots = Array.from({ length: 17 }, (_, index) => ({ id: `sh${index + 1}`, index: index + 1 }));
    const { shots: out, episodes, warnings } = normalizeShotEpisodeIds({ shots, episodes: PROJECT_EPISODES });
    const first = out.filter((shot) => shot.episodeId === "ep_0001").length;
    const second = out.filter((shot) => shot.episodeId === "ep_0002").length;
    assert.deepEqual([first, second], [9, 8], "容量相同 → 前 9 后 8");
    assert.deepEqual(episodes.map((episode) => episode.shotIds.length), [9, 8]);
    assert.equal(warnings.length, 17, "每镜一条兜底 warning（不静默）");
});

test("归一：无权威集（episodes 为空）→ 保持原样并逐镜 warning，绝不静默丢弃", () => {
    const shots = [{ id: "sh1", episodeId: "", index: 1 }, { id: "sh2", episodeId: "ep9", index: 2 }];
    const { shots: out, episodes, warnings } = normalizeShotEpisodeIds({ shots, episodes: [] });
    assert.deepEqual(out.map((shot) => shot.episodeId), ["", "ep9"], "原样保留");
    assert.deepEqual(episodes, [], "无集可回填");
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((item) => item.code === "unresolved"));
});

test("归一：不满集列表时按 sceneIds 反补 sceneIds；不改入参对象", () => {
    const shots = [{ id: "sh1", episodeId: "e1", sceneId: "sc9", index: 1 }];
    const original = { id: "e1", index: 1, sceneIds: [] };
    const episodesInput = [original];
    const { episodes } = normalizeShotEpisodeIds({ shots, episodes: episodesInput });
    assert.deepEqual(episodes[0].sceneIds, ["sc9"], "空 sceneIds 由镜头回填");
    assert.deepEqual(original.sceneIds, [], "入参未被改写（纯函数）");
});

/* ------------------------------ ② 编排器接线 ------------------------------ */

const SCRIPT_OUTPUT = {
    logline: "末班车的约定",
    synopsis: "深夜末班车上，司机与女孩的相遇。",
    characters: [{ id: "c1", name: "老周", profile: "司机", appearance: "中年", voice: "低沉" }],
    scenes: [
        { id: "sc1", title: "车上", location: "内景 公交车内", time: "夜", intent: "相遇", beats: ["上车"] },
        { id: "sc2", title: "站牌", location: "外景 站牌下", time: "夜", intent: "承诺", beats: ["下车"] },
    ],
    episodes: [
        { id: "ep1", index: 1, title: "末班车", durationSec: 30, synopsis: "相遇", sceneIds: ["sc1"] },
        { id: "ep2", index: 2, title: "车票", durationSec: 30, synopsis: "承诺", sceneIds: ["sc2"] },
    ],
};

/** 分镜产物：LLM 故意写得参差不齐（ep1 别名 / 空 / 第2集），验证服务端归一。 */
const STORYBOARD_OUTPUT = {
    shots: [
        { id: "sh1", episodeId: "ep1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "上车", dialogue: "", audio: "", prompt: "a" },
        { id: "sh2", episodeId: "", sceneId: "sc1", index: 2, durationSec: 4, shotSize: "近景", camera: "推", action: "回头", dialogue: "", audio: "", prompt: "b" },
        { id: "sh3", episodeId: "第2集", sceneId: "sc2", index: 3, durationSec: 4, shotSize: "中景", camera: "固定", action: "下车", dialogue: "", audio: "", prompt: "c" },
        { id: "sh4", episodeId: "", sceneId: "sc2", index: 4, durationSec: 4, shotSize: "全景", camera: "拉", action: "蹲下", dialogue: "", audio: "", prompt: "d" },
    ],
};

function fakeLlm() {
    return {
        async chat(options) {
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("分镜师") ? STORYBOARD_OUTPUT : content.includes("分集规划师") ? { episodes: SCRIPT_OUTPUT.episodes } : SCRIPT_OUTPUT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-ep-id-"));
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "测试剧本", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes/episodes 的 JSON。\n小说原文：\n{{novel}}\n"],
        "02-storyboard": ["storyboard", "测试分镜", "你是分镜师，把剧本拆成分镜，返回含 episodes 与 shots 数组的 JSON。\n剧本：\n{{script}}\n"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}`);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { maxNovelChunkChars: 16000, videoSeconds: 5, videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function build(env, projects) {
    return createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { enqueue: (job) => ({ ...job, status: "queued", outputs: [] }) },
        comfy: {},
        llm: fakeLlm(),
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
        applyScriptProjection: (id, output) => projects.applyScriptProjection(id, output),
        applyEpisodeProjection: (id, output) => projects.applyEpisodeProjection(id, output),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
    });
}

function setup(t) {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    // 项目存储与流水线共用同一 dataDir —— 与 index.js 接线一致（projects.createProjects({ dataDir: config.dataDir })）。
    // M0：门禁阶段由调用方注入（与本测试 registry 同源），gates.js 不再内置阶段数组。
    const projects = createProjects({ dataDir: env.config.dataDir, stages: loadRegistry(env.skillsDir).stages });
    return { env, projects, pipeline: build(env, projects) };
}

test("接线：分镜产出归一 shots[].episodeId 到项目真实 id，并回填 project.episodes[].shotIds（gates/context 可见、不改 version）", async (t) => {
    const { projects, pipeline } = setup(t);
    const project = projects.create({ title: "分集分区", plan: { episodeCount: 2, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");

    const stored = projects.get(project.id);
    assert.deepEqual(stored.episodes.map((episode) => episode.id), ["ep_0001", "ep_0002"], "项目侧权威 id");
    assert.deepEqual(stored.episodes[0].shotIds, ["sh1", "sh2"], "第 1 集回填 shotIds（sceneId 归属）");
    assert.deepEqual(stored.episodes[1].shotIds, ["sh3", "sh4"], "第 2 集回填 shotIds");

    // context 默认形状直接可见
    const context = projects.context(project.id);
    assert.deepEqual(context.episodes[0].shotIds, ["sh1", "sh2"], "context.episodes[].shotIds 可见");
    assert.deepEqual(context.episodes[1].shotIds, ["sh3", "sh4"]);

    // gates 纯推导不报错，且 storyboard 判据仍成立
    const gates = Object.fromEntries(projects.gates(project.id).map((gate) => [gate.stageId, gate]));
    assert.equal(gates.storyboard.done, true);

    // 分镜产物自身也带上归一后的集映射（slim 形状）
    const output = pipeline.get(run.id).stages.storyboard.output;
    assert.deepEqual(output.shots.map((shot) => shot.episodeId), ["ep_0001", "ep_0001", "ep_0002", "ep_0002"]);
    assert.deepEqual(output.episodes.map((episode) => [episode.id, episode.shotIds]), [
        ["ep_0001", ["sh1", "sh2"]],
        ["ep_0002", ["sh3", "sh4"]],
    ]);
});

test("接线幂等：重复跑分镜不重复、project.episodes 结构不变、不改 version", async (t) => {
    const { projects, pipeline } = setup(t);
    const project = projects.create({ title: "分集幂等", plan: { episodeCount: 2, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");

    const afterFirst = projects.get(project.id);
    const versionAfterFirst = afterFirst.version;
    const episodesAfterFirst = JSON.parse(JSON.stringify(afterFirst.episodes));

    await pipeline.runStage(run.id, "storyboard");
    const afterSecond = projects.get(project.id);
    assert.deepEqual(afterSecond.episodes, episodesAfterFirst, "重复跑不改变 project.episodes");
    assert.equal(afterSecond.version, versionAfterFirst, "派生回填不改 version（D7 乐观并发不被污染）");
});

test("接线：未绑项目时归一仍作用于分镜产物（退回剧本侧集 id），不写任何项目", async (t) => {
    const { pipeline } = setup(t);
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇" });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    const output = pipeline.get(run.id).stages.storyboard.output;
    assert.deepEqual(output.shots.map((shot) => shot.episodeId), ["ep1", "ep1", "ep2", "ep2"], "退回剧本侧集 id（ep1/ep2）");
});

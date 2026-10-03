import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";

// —— 隔离环境：临时 data/skills + 假 LLM（绝不真跑模型）——
// 01 技能同时给出「## 提示词模板（analyze）/ ## 分集规划提示词（outline）/ ## 逐集剧本提示词（script）」
// 三个分步提示词，用来验证编排器确实抽取并填充了 plan 集数/时长。
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-script-steps-"));
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "01-script"), { recursive: true });
    writeFileSync(
        join(skillsDir, "01-script", "SKILL.md"),
        [
            "---",
            "name: novel-to-script",
            "description: 测试用多步剧本技能",
            "---",
            "",
            "# 剧本",
            "",
            "## 提示词模板",
            "",
            "你是本项目的剧本改编者。把下面小说改编成剧本，返回含 logline/synopsis/characters/scenes 的 JSON。",
            "小说原文：",
            "{{novel}}",
            "",
            "## 分集规划提示词",
            "",
            "你是本项目的分集规划师。把故事规划成 {{episodeCount}} 集，每集约 {{episodeDurationSec}} 秒。",
            "场次：{{scenes}}",
            "",
            "## 逐集剧本提示词",
            "",
            "你是本项目的剧本编剧。写第 {{episode.index}} 集，共 {{episodeCount}} 集。",
            "本集场次：{{episodeScenes}}",
            "",
            "## 内容创作红线（硬约束）",
            "",
            "- 测试红线-忠于原著：忠于原著，不为道德教化、过审改稿。",
            "",
            "## 校验规则",
            "",
            "- 只输出 JSON",
            "",
        ].join("\n"),
    );
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { maxNovelChunkChars: 16000, videoSeconds: 5, videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

const ANALYZE = {
    logline: "一句话故事线",
    synopsis: "梗概",
    characters: [
        { id: "c1", name: "甲", profile: "村民", appearance: "青年", voice: "清亮" },
        { id: "c2", name: "乙", profile: "猎户", appearance: "壮汉", voice: "低沉" },
    ],
    scenes: [
        { id: "sc1", title: "村口", location: "外景 村口", time: "日", intent: "出场", beats: ["甲走进村子"] },
        { id: "sc2", title: "老屋", location: "内景 老屋", time: "夜", intent: "冲突", beats: ["乙拦住甲"] },
        { id: "sc3", title: "山林", location: "外景 山林", time: "夜", intent: "追逐", beats: ["甲逃进林子"] },
        { id: "sc4", title: "悬崖", location: "外景 悬崖", time: "黄昏", intent: "转折", beats: ["甲回头"] },
    ],
};

/** 造一个按提示词标记分流的假 LLM，并暴露 calls 供断言。可注入某一步的失败。 */
function makeLlm(overrides = {}) {
    const calls = [];
    return {
        calls,
        async chat(options) {
            calls.push(options);
            const content = String(options.messages.at(-1)?.content ?? "");
            if (content.includes("分集规划师")) {
                if (overrides.outline) return reply(overrides.outline(content));
                return reply({
                    episodes: [
                        { id: "ep1", index: 1, title: "第一集", durationSec: 30, synopsis: "起", sceneIds: ["sc1", "sc2"] },
                        { id: "ep2", index: 2, title: "第二集", durationSec: 30, synopsis: "承", sceneIds: ["sc3", "sc4"] },
                    ],
                });
            }
            if (content.includes("剧本编剧")) {
                if (overrides.script) return reply(overrides.script(content));
                return reply({ scenes: [{ id: "sc1", beats: ["细化后的节拍"] }] });
            }
            if (overrides.analyze) return reply(overrides.analyze(content));
            return reply(ANALYZE);
        },
    };
    function reply(value) {
        if (value instanceof Error) throw value;
        return { choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] };
    }
}

const PLAN_PROJECT = () => ({ title: "多步测试", styleAnchor: "", plan: { ratio: "9:16", episodeCount: 2, episodeDurationSec: 30 } });

function build(env, llm, { projects = null, projectId = null } = {}) {
    return createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { enqueue: (job) => ({ ...job, status: "queued", outputs: [] }) },
        comfy: {},
        llm,
        getProject: projects ? (id) => projects.get(id) : undefined,
    });
}

test("多步可见：analyze→outline→script 依次推进，产物落盘且最终 episodes 对齐 plan.episodeCount", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-script-projects-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const project = projects.create(PLAN_PROJECT());
    const llm = makeLlm();
    const pipeline = build(env, llm, { projects });

    const run = pipeline.create({ novel: "很久以前有一个村子", title: "多步", options: { projectId: project.id } });
    const done = await pipeline.runStage(run.id, "script");

    assert.equal(done.stages.script.status, "done");

    // ① 三个子步骤各自状态推进 + 产物落盘（reload 后仍在）
    const stage = pipeline.get(run.id).stages.script;
    assert.deepEqual(Object.keys(stage.steps), ["analyze", "outline", "script"]);
    assert.equal(stage.steps.analyze.status, "done");
    assert.equal(stage.steps.analyze.output.logline, "一句话故事线");
    assert.equal(stage.steps.outline.status, "done");
    assert.equal(stage.steps.outline.output.episodes.length, 2);
    assert.equal(stage.steps.script.status, "done");
    assert.ok(Array.isArray(stage.steps.script.output.episodes) && stage.steps.script.output.episodes.length === 2);

    // ② 最终产物契约：logline/synopsis/characters/scenes/episodes 齐全，且 episodes 非空、集数一致
    const output = stage.output;
    assert.deepEqual(Object.keys(output).sort(), ["characters", "episodes", "logline", "scenes", "synopsis"]);
    assert.equal(output.episodes.length, 2, "episodes 与 plan.episodeCount 一致");
    assert.deepEqual(output.episodes.map((ep) => ep.index), [1, 2]);
    assert.deepEqual(output.episodes.map((ep) => ep.durationSec), [30, 30]);
    const total = output.episodes.reduce((sum, ep) => sum + ep.durationSec, 0);
    assert.equal(total, 2 * 30, "时长合计匹配 plan.episodeCount × episodeDurationSec");
    assert.ok(output.scenes.length >= 1);

    // ③ plan 硬约束真的进了分集提示词
    const outlineCall = llm.calls.find((call) => String(call.messages.at(-1).content).includes("分集规划师"));
    assert.ok(outlineCall, "存在分集规划调用");
    assert.match(outlineCall.messages.at(-1).content, /规划成 2 集/, "episodeCount 进了提示词");
    assert.match(outlineCall.messages.at(-1).content, /每集约 30 秒/, "episodeDurationSec 进了提示词");

    // ④ 逐集剧本按集各调一次模型
    const scriptCalls = llm.calls.filter((call) => String(call.messages.at(-1).content).includes("剧本编剧"));
    assert.equal(scriptCalls.length, 2, "每集单独一次逐集剧本调用");
});

test("进度可见：progress 带 steps 多步结构，且旧字段（stage/phase/done/total/label）仍在", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-script-progress-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const project = projects.create(PLAN_PROJECT());

    let pipeline;
    const seen = [];
    const llm = makeLlm({
        outline: () => {
            // 分集规划进行中：analyze 已完成、outline 正在跑、script 尚未开始
            seen.push(pipeline.stageProgress(run.id));
            return { episodes: [] };
        },
    });
    pipeline = build(env, llm, { projects });
    const run = pipeline.create({ novel: "很久以前", title: "进度", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");

    const progress = seen.at(-1);
    assert.ok(progress, "抓到了中间进度");
    // 向后兼容：现有前端只看 stage/phase/done/total/label，这些必须都在
    assert.equal(progress.stage, "script");
    assert.equal(typeof progress.phase, "string");
    assert.equal(typeof progress.label, "string");
    assert.ok("done" in progress && "total" in progress);
    // 多步结构
    assert.deepEqual(progress.steps.map((step) => step.id), ["analyze", "outline", "script"]);
    assert.equal(progress.steps.find((step) => step.id === "analyze").status, "done");
    assert.equal(progress.steps.find((step) => step.id === "outline").status, "running");
    assert.equal(progress.steps.find((step) => step.id === "script").status, "pending");

    // 结束后最后一条进度：phase 落 done，且三步都 done（不会停在「末步 running」）
    const finalProgress = pipeline.stageProgress(run.id);
    assert.equal(finalProgress.phase, "done");
    assert.deepEqual(finalProgress.steps.map((step) => step.status), ["done", "done", "done"]);
});

test("中途失败：已完成子步骤产物不丢，resume 重跑复用 analyze", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-script-resume-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const project = projects.create(PLAN_PROJECT());

    // 第一跑：outline 炸掉
    const broken = makeLlm({ outline: () => new Error("分集规划上游 500") });
    const first = build(env, broken, { projects });
    const run = first.create({ novel: "很久以前", title: "续跑", options: { projectId: project.id } });
    const failed = await first.runStage(run.id, "script");

    assert.equal(failed.stages.script.status, "error");
    assert.equal(failed.stages.script.output, null);
    // analyze 的产物已落盘、没丢；outline 落 error
    const stage = first.get(run.id).stages.script;
    assert.equal(stage.steps.analyze.status, "done");
    assert.equal(stage.steps.analyze.output.logline, "一句话故事线");
    assert.equal(stage.steps.outline.status, "error");
    // 失败的进度里：analyze 保留 done、outline 落 error（前步产物不丢）
    const failedProgress = first.stageProgress(run.id);
    assert.equal(failedProgress.phase, "failed");
    assert.deepEqual(failedProgress.steps.map((step) => step.status), ["done", "error", "pending"]);

    const analyzeCalls = broken.calls.filter((call) => !String(call.messages.at(-1).content).includes("分集规划师")).length;

    // 第二跑 resume：analyze 复用（不再打模型），outline/script 补完
    const healthy = makeLlm();
    const second = build(env, healthy, { projects });
    const resumed = await second.runStage(run.id, "script", { resume: true });

    assert.equal(resumed.stages.script.status, "done");
    assert.equal(resumed.stages.script.output.episodes.length, 2);
    const healthyAnalyzeCalls = healthy.calls.filter((call) => !String(call.messages.at(-1).content).includes("分集规划师") && !String(call.messages.at(-1).content).includes("剧本编剧")).length;
    assert.equal(healthyAnalyzeCalls, 0, "resume 复用已完成的 analyze，不再打模型");
    assert.ok(analyzeCalls >= 1, "首跑 analyze 确实调过模型");
});

test("分集数不符 plan 时按目标重排并记 warnings，不静默放过", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-script-warn-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const project = projects.create(PLAN_PROJECT());

    // 模型给 3 集，plan 要 2 集
    const llm = makeLlm({
        outline: () => ({
            episodes: [
                { id: "ep1", index: 1, title: "一", durationSec: 30, sceneIds: ["sc1"] },
                { id: "ep2", index: 2, title: "二", durationSec: 30, sceneIds: ["sc2"] },
                { id: "ep3", index: 3, title: "三", durationSec: 30, sceneIds: ["sc3"] },
            ],
        }),
    });
    const pipeline = build(env, llm, { projects });
    const run = pipeline.create({ novel: "很久以前", title: "警告", options: { projectId: project.id } });
    const done = await pipeline.runStage(run.id, "script");

    assert.equal(done.stages.script.output.episodes.length, 2, "强制对齐 plan.episodeCount");
    const warnings = done.stages.script.steps.outline.output.warnings;
    assert.ok(Array.isArray(warnings) && warnings.length >= 1, "集数不符必须记警告");
    assert.match(warnings.join("；"), /分集数不符/);
});

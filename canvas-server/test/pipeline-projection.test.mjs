import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";

/**
 * §12 第 1 优先级「P0：Project 事实链」——脚本/episodes 投影、真实阶段门禁、分镜定点 PATCH、sourceRevision 引用。
 * 全部用假 LLM + 真实 Project 存储，绝不真跑模型；HTTP 段只打本服务，不碰 ComfyUI。
 */

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
    ],
};

/** 按提示词角色标记分流的假 LLM：analyze 回整篇，outline 回一集。单集时不额外调逐集剧本。 */
function fakeLlm() {
    return {
        calls: [],
        async chat(options) {
            this.calls.push(options);
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("分集规划师")
                ? { episodes: [{ id: "ep1", index: 1, title: "第一集", durationSec: 30, synopsis: "起", sceneIds: ["sc1", "sc2"] }] }
                : ANALYZE;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

/** 两次都返回非法 JSON 的假 LLM：把剧本阶段确定性打成 error，用来验证门禁的上游失败原因。 */
function brokenLlm() {
    return { async chat() { return { choices: [{ message: { content: "这不是 JSON" } }] }; } };
}

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-projection-"));
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "01-script"), { recursive: true });
    writeFileSync(
        join(skillsDir, "01-script", "SKILL.md"),
        "---\nname: novel-to-script\ndescription: 测试剧本\n---\n\n# 剧本\n\n## 提示词模板\n\n把下面小说改编成剧本，返回含 logline/synopsis/characters/scenes 的 JSON。\n小说原文：\n{{novel}}\n",
    );
    mkdirSync(join(skillsDir, "02-storyboard"), { recursive: true });
    writeFileSync(join(skillsDir, "02-storyboard", "SKILL.md"), "---\nname: storyboard\ndescription: 测试分镜\n---\n\n# 分镜\n\n## 提示词模板\n\n把剧本拆成分镜。\n{{script}}\n");
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
    const config = { dataDir: join(root, "data"), pipeline: { maxNovelChunkChars: 16000, videoSeconds: 5, videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error("期望抛出异常，但没有");
}

/** 真实 Project 存储 + 假 LLM 的编排器；可注入脚本投影计数器验证幂等。 */
function build(env, projects, { llm = fakeLlm(), applyScriptProjection } = {}) {
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { enqueue: (job) => ({ ...job, status: "queued", outputs: [] }) },
        comfy: {},
        llm,
        getProject: (id) => projects.get(id),
        applyPlanSuggestion: (id, value) => projects.applyPlanSuggestion(id, value),
        applyScriptProjection: applyScriptProjection || ((id, output) => projects.applyScriptProjection(id, output)),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
    });
    return { pipeline, llm };
}

// ——— 1. 脚本/episodes 投影到 Project（幂等、旧数据不动） ———

test("脚本投影：剧本阶段产出后项目侧可查 characters/scenes/episodes，且重复跑不重复写", (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-projection-projects-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    let applied = 0;
    const { pipeline } = build(env, projects, {
        applyScriptProjection: (id, output) => {
            const result = projects.applyScriptProjection(id, output);
            if (result.applied) applied += 1;
            return result;
        },
    });

    const project = projects.create({ title: "事实链", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村子", title: "短篇", options: { projectId: project.id } });
    return pipeline.runStage(run.id, "script").then(() => {
        const stored = projects.get(project.id);
        assert.equal(stored.script.logline, "一句话故事线");
        assert.equal(stored.script.characters.length, 2, "character 投影");
        assert.equal(stored.script.scenes.length, 2, "scene 投影");
        assert.equal(stored.script.episodes.length, 1, "episode 投影");
        assert.equal(stored.script.episodes[0].id, "ep1");
        assert.equal(applied, 1, "首次投影写盘一次");

        // 旧数据不动：episodes 索引 / assetRefs 不因投影被碰
        assert.deepEqual(stored.episodes, []);
        assert.deepEqual(stored.assetRefs, []);

        // 幂等：同一产物重复投递不再写盘
        return pipeline.runStage(run.id, "script").then(() => {
            assert.equal(applied, 1, "重复投影不再写盘");
            assert.equal(projects.get(project.id).script.episodes.length, 1);
        });
    });
});

test("脚本投影：未注入 applyScriptProjection 时不写（保持旧行为）", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-projection-nohook-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    // 故意不注入 applyScriptProjection：走「旧调用方」路径，投影应为空操作。
    const off = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { enqueue: (job) => ({ ...job, status: "queued", outputs: [] }) },
        comfy: {},
        llm: fakeLlm(),
        getProject: (id) => projects.get(id),
        attachProjectRun: (id, runId) => projects.attachRun(id, runId),
    });
    const project = projects.create({ title: "无台账" });
    const run = off.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    await off.runStage(run.id, "script");
    assert.equal(projects.get(project.id).script, null, "未接线时不投影");
});

// ——— 2. run 与项目 runIds 的服务端幂等关联 ———

test("runIds：建 run 时服务端幂等追加，重复关联不重复、不改 version；项目缺失不抛", (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-projection-runids-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const { pipeline } = build(env, projects);

    const project = projects.create({ title: "多轮" });
    const first = pipeline.create({ novel: "第一段", options: { projectId: project.id } });
    assert.deepEqual(projects.get(project.id).runIds, [first.id], "建 run 即进 runIds");
    assert.equal(projects.get(project.id).version, 1, "派生关联不改 version（D7 乐观并发不被污染）");

    projects.attachRun(project.id, first.id);
    assert.deepEqual(projects.get(project.id).runIds, [first.id], "重复关联同一 runId 幂等");

    const second = pipeline.create({ novel: "第二段", options: { projectId: project.id } });
    assert.deepEqual(projects.get(project.id).runIds, [first.id, second.id], "第二个 run 追加在尾");

    assert.equal(projects.attachRun("prj_nope", "run-x"), null, "项目不存在返回 null，不抛");

    // 未绑项目：runIds 无关联、也不报错
    const orphan = pipeline.create({ novel: "孤立" });
    assert.equal(pipeline.get(orphan.id).id, orphan.id);
});

// ——— 3. sourceRevision 引用（建 run 时快照） ———

test("sourceRevision：建 run 时快照项目当前源版本，可追溯「用的是哪一版原文」", (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-projection-source-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const { pipeline } = build(env, projects);

    const project = projects.create({ title: "源版本" });
    const src = projects.saveSource(project.id, { kind: "novel", text: "第一章原文" });
    const run = pipeline.create({ novel: "第一章原文", options: { projectId: project.id } });
    assert.equal(run.sourceRevisionId, src.id, "建 run 即快照当前源版本");
    assert.equal(pipeline.get(run.id).sourceRevisionId, src.id, "快照落盘、可追溯");

    // 导入新源版本后，新建的 run 指向新版本；旧 run 快照不变（各条 run 各记自己那版）
    const second = projects.saveSource(project.id, { kind: "novel", text: "第二章原文" });
    const next = pipeline.create({ novel: "第二章原文", options: { projectId: project.id } });
    assert.equal(next.sourceRevisionId, second.id);
    assert.equal(pipeline.get(run.id).sourceRevisionId, src.id);

    // 未绑项目 → 无源版本引用
    assert.equal(pipeline.create({ novel: "孤立" }).sourceRevisionId, null);
});

// ——— 4. 分镜定点编辑：只改指定 shot ———

test("分镜定点 PATCH：只改指定 shot，保留 id、其它 shot 与阶段字段不动", (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-projection-shot-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });
    const { pipeline } = build(env, projects);

    const run = pipeline.create({ novel: "很久以前" });
    pipeline.setStageInput(run.id, "storyboard", {
        output: { shots: [{ id: "sh1", action: "走路", camera: "固定" }, { id: "sh2", action: "回头看", camera: "推近" }] },
    });

    const { shot } = pipeline.patchStageShot(run.id, "storyboard", "sh1", { camera: "摇镜", dialogue: "你好" });
    assert.equal(shot.id, "sh1");
    assert.equal(shot.camera, "摇镜", "指定字段被局部更新");
    assert.equal(shot.dialogue, "你好", "可追加新字段");
    assert.equal(shot.action, "走路", "未传字段保留");

    const shots = pipeline.get(run.id).stages.storyboard.output.shots;
    assert.deepEqual(shots[1], { id: "sh2", action: "回头看", camera: "推近" }, "其它 shot 一字不动");
    assert.equal(shots.length, 2, "不新增/不删除 shot");

    assert.equal(catchError(() => pipeline.patchStageShot(run.id, "storyboard", "sh9", {})).status, 404, "未知 shot 404");
    assert.throws(() => pipeline.patchStageShot(run.id, "storyboard", "sh1", { id: "hack" }), /id 稳定不可改/);
    assert.throws(() => pipeline.patchStageShot(run.id, "keyframe", "sh1", {}), /只有分镜/);
});

// ——— 5. 真实阶段门禁：可解释原因 ———

test("门禁：缺源 / 上游未产出 / 上游 error / partial 都给出可解释原因", async (t) => {
    const env = makeEnv();
    const projectsRoot = mkdtempSync(join(tmpdir(), "canvas-projection-gate-"));
    t.after(() => {
        rmSync(env.root, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
    });
    const projects = createProjects({ dataDir: projectsRoot });

    // 缺源：入口阶段（剧本）无 novel
    const { pipeline } = build(env, projects);
    const noSource = pipeline.stageGate({ novel: "", stages: { script: { id: "script", title: "剧本", status: "pending", output: null } } }, "script");
    assert.equal(noSource.ready, false);
    assert.match(noSource.reason, /缺少小说原文/);

    // 上游未产出
    const notProduced = pipeline.stageGate({ novel: "x", stages: { script: { id: "script", title: "剧本", status: "pending", output: null } } }, "storyboard");
    assert.equal(notProduced.ready, false);
    assert.match(notProduced.reason, /请先完成 剧本/);
    assert.match(notProduced.reason, /尚未产出产物/);

    // 上游 partial
    const partial = pipeline.stageGate({ novel: "x", stages: { script: { id: "script", title: "剧本", status: "partial", output: { logline: "x" } } } }, "storyboard");
    assert.match(partial.reason, /上游仅部分完成/);

    // 上游 error：真跑一次失败剧本，门禁要能说出真实失败原因
    const { pipeline: failing } = build(env, projects, { llm: brokenLlm() });
    const run = failing.create({ novel: "很久以前" });
    await failing.runStage(run.id, "script");
    assert.equal(failing.get(run.id).stages.script.status, "error");
    const err = catchError(() => failing.beginStage(run.id, "storyboard", {}));
    assert.equal(err.status, 409, "门禁拒绝带 409");
    assert.match(err.message, /请先完成 剧本/);
    assert.match(err.message, /上游运行失败/);
    assert.match(err.message, /模型未返回合法 JSON/, "带上游真实错误");

    // stageGates：全阶段视图
    const view = failing.stageGates(run.id);
    assert.deepEqual(view.map((item) => item.stageId), ["script", "storyboard", "keyframe"]);
    assert.equal(view.find((item) => item.stageId === "storyboard").ready, false);
    assert.ok(view.find((item) => item.stageId === "script").ready, "剧本阶段本身不被门禁挡住（有源）");
});

// ——— 6. HTTP：PATCH 分镜 shot 路由与 /gates 路由（any 承接 PATCH） ———

test("index 集成：PATCH/POST 分镜 shot 定点路由 + GET /gates 真实返回 JSON", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-projection-http-"));
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "01-script"), { recursive: true });
    writeFileSync(join(skillsDir, "01-script", "SKILL.md"), "---\nname: novel-to-script\ndescription: 测试\n---\n\n# 剧本\n\n## 提示词模板\n\n{{novel}}\n");
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "01-script", requires: ["script"], produces: "storyboard" },
            ],
        }),
    );
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    const mod = await import("../src/index.js");
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${mod.server.address().port}`;
    try {
        const run = mod.pipeline.create({ novel: "很久以前" });
        mod.pipeline.setStageInput(run.id, "storyboard", { output: { shots: [{ id: "sh1", camera: "固定" }, { id: "sh2", camera: "推近" }] } });

        const patched = await fetch(`${base}/api/pipeline/runs/${run.id}/steps/storyboard/shots/sh1`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ camera: "摇镜" }),
        });
        assert.equal(patched.status, 200);
        assert.match(patched.headers.get("content-type"), /application\/json/);
        const body = await patched.json();
        assert.equal(body.shot.camera, "摇镜");
        assert.equal(body.shot.id, "sh1");
        assert.equal(body.run.stages.storyboard.output.shots[1].camera, "推近", "其它 shot 不动");

        const posted = await fetch(`${base}/api/pipeline/runs/${run.id}/steps/storyboard/shots/sh2`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "回头" }),
        });
        assert.equal(posted.status, 200, "POST 同样承接");
        assert.equal((await posted.json()).shot.action, "回头");

        const gatesRes = await fetch(`${base}/api/pipeline/runs/${run.id}/gates`);
        assert.equal(gatesRes.status, 200);
        const gates = (await gatesRes.json()).gates;
        assert.deepEqual(gates.map((item) => item.stageId), ["script", "storyboard"]);
        assert.equal(gates.find((item) => item.stageId === "storyboard").ready, false, "剧本尚未运行 → 分镜门禁未就绪");

        assert.equal((await fetch(`${base}/api/pipeline/runs/run-nope/gates`)).status, 404);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

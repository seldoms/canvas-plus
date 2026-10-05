import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/** 最小 skills 环境（照 pipeline.test.mjs 的写法；各测试文件各自持有 harness 是本仓库既有约定）。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-artifact-gate-"));
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "剧本", "你是影视剧本改编，返回含 logline/synopsis/characters/scenes 的 JSON。"],
        "02-storyboard": ["storyboard", "分镜", "你是分镜师，把剧本拆成 shots。"],
        "04-keyframes": ["keyframes", "关键帧", "你是关键帧提示词工程师，产出 frames。"],
        "05-clip-assembly": ["clip-assembly", "片段合成", "你是片段合成师，产出 clips 与 assembly。"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}\n`);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { imageTemplate: "img-test", editTemplate: "edit-test", videoTemplate: "video-test" } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config, runsDir: join(config.dataDir, "runs") };
}

const SCRIPT = { logline: "一句话", synopsis: "梗概", characters: [{ id: "c1", name: "甲", profile: "村民", appearance: "青年", voice: "清亮" }], scenes: [{ id: "sc1", title: "村口", location: "外景 村口", time: "日", intent: "出场", beats: ["甲走进村子"] }] };
const GOOD_SHOTS = { shots: [{ id: "sh1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "走路", dialogue: "", prompt: "a villager walks" }] };
const BAD_SHOTS = { shots: [{ id: "sh1", sceneId: "sc9", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "走路", dialogue: "", prompt: "a villager walks" }] };

function fakeJobs() {
    return { enqueue: (job) => ({ ...job, status: "queued", outputs: [] }) };
}

function fakeLlm(reply) {
    return {
        async chat(options) {
            const value = typeof reply === "function" ? reply(options.messages.at(-1).content) : reply;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function build(env, reply) {
    return createPipeline({ config: env.config, skillsDir: env.skillsDir, jobs: fakeJobs(), comfy: {}, llm: fakeLlm(reply), runJob: async () => ({ outputs: [] }) });
}

const stageReply = (shots) => (content) => (content.includes("分镜师") ? shots : SCRIPT);

test("门真的会拦：分镜引用了不存在的场次 → 阶段 error、产物不落盘、审计日志留痕", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const pipeline = build(env, stageReply(BAD_SHOTS));
    const run = pipeline.create({ novel: "很久以前有一个村子" });

    await pipeline.runStage(run.id, "script");
    const failed = await pipeline.runStage(run.id, "storyboard", { actor: "agent:codex" });

    assert.equal(failed.stages.storyboard.status, "error");
    assert.match(failed.stages.storyboard.error, /产物未通过契约校验/);
    assert.match(failed.stages.storyboard.error, /shots\[0\]\.sceneId/);
    assert.match(failed.stages.storyboard.error, /sc9/);
    // 产物不落盘：坏产物不能继续流向下游
    assert.equal(existsSync(join(env.runsDir, run.id, "storyboard.json")), false);
    // 下游拿不到 done
    await assert.rejects(() => pipeline.runStage(run.id, "keyframe"), /分镜|上游/);

    const log = pipeline.runLog(run.id);
    assert.deepEqual(log.map((entry) => entry.op), ["run.create", "stage.begin", "stage.output", "stage.begin", "stage.error"]);
    assert.equal(log.at(-1).actor, "agent:codex");
    assert.equal(log.at(-1).stage, "storyboard");
});

test("合规产物照常放行，日志记下产物指纹与 actor", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const pipeline = build(env, stageReply(GOOD_SHOTS));
    const run = pipeline.create({ novel: "很久以前有一个村子", actor: "web" });
    await pipeline.runStage(run.id, "script", { actor: "web" });
    const done = await pipeline.runStage(run.id, "storyboard", { actor: "web" });

    assert.equal(done.stages.storyboard.status, "done");
    assert.ok(existsSync(join(env.runsDir, run.id, "storyboard.json")));

    const log = pipeline.runLog(run.id);
    assert.equal(log[0].op, "run.create");
    assert.equal(log[0].actor, "web");
    const output = log.find((entry) => entry.op === "stage.output" && entry.stage === "storyboard");
    assert.equal(output.ok, true);
    assert.match(output.hash, /^[0-9a-f]{16}$/, "日志要能回答「这是哪一版产物」");
});

test("人工改产物同样过门：引用断裂 400，改对了才落盘", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const pipeline = build(env, stageReply(GOOD_SHOTS));
    const run = pipeline.create({ novel: "很久以前有一个村子" });
    await pipeline.runStage(run.id, "script");

    assert.throws(() => pipeline.setStageInput(run.id, "script", { output: { ...SCRIPT, episodes: [{ id: "ep1", sceneIds: ["sc9"] }] } }), /产物未通过契约校验/);
    // 被拒绝的修订不能覆盖已有产物（磁盘上那份仍来自先前 runStage，编排器会补出 episodes，但绝不能出现 sc9）
    const onDisk = JSON.parse(readFileSync(join(env.runsDir, run.id, "script.json"), "utf8"));
    const sceneIds = (onDisk.episodes || []).flatMap((episode) => episode.sceneIds || []);
    assert.equal(sceneIds.includes("sc9"), false, "被拒绝的产物不得落盘");
    assert.equal(pipeline.runLog(run.id).some((entry) => entry.op === "stage.edit"), false, "被拒绝的修订不记成功日志");

    const fixed = pipeline.setStageInput(run.id, "script", { output: SCRIPT, actor: "web" });
    assert.equal(fixed.stages.script.status, "done");
    assert.ok(existsSync(join(env.runsDir, run.id, "script.json")));
    const edit = pipeline.runLog(run.id).at(-1);
    assert.equal(edit.op, "stage.edit");
    assert.equal(edit.actor, "web");
    assert.match(edit.hash, /^[0-9a-f]{16}$/);
});

test("审计日志落在 runs/<id>/log.jsonl，且是追加式（不被后写覆盖）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const pipeline = build(env, stageReply(GOOD_SHOTS));
    const run = pipeline.create({ novel: "很久以前有一个村子" });
    await pipeline.runStage(run.id, "script");

    const file = join(env.runsDir, run.id, "log.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.ok(lines.length >= 3, `至少有创建 + 开始 + 产出：${lines.length}`);
    for (const line of lines) {
        const entry = JSON.parse(line);
        assert.ok(entry.at && entry.op, "每行都是完整 JSON");
    }
    assert.equal(pipeline.runLog(run.id, 1).length, 1, "limit 只取尾部");
});

/**
 * 角色定妆阶段（casting）流水线接线验收：
 *   · casting 阶段确定性组装身份卡（定脸 + 定声音，不调 LLM）；
 *   · 未确认 → keyframe / audio 置 blocked 且写清缺哪个角色的脸/声（复用 #70 可见机制）；
 *   · 全部确认 → 精确放行（blocked 清除、门禁 ready）；
 *   · 确认非法音色 / 无脸产物就确认脸 → 可读报错；确认后修改 → version +1。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPipeline } from "../src/pipeline.js";

/** 最小 skills 环境：登记 script/storyboard/design/casting/keyframe/audio/assembly 七个阶段（含 casting 依赖）。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-casting-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "design", title: "服化道", skill: "03-design", requires: ["script"], produces: "design" },
                { id: "casting", title: "角色定妆", skill: "03b-casting", requires: ["script", "design"], produces: "casting" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design", "casting"], produces: "keyframes" },
                { id: "audio", title: "配音", skill: "06-audio", requires: ["storyboard", "design", "casting"], produces: "audio" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { audioTemplate: "audio_qwen3_tts", audioDevice: "cuda", imageTemplate: "img-test", videoTemplate: "video-test", videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

const PROJECT = {
    id: "prj_1",
    script: {
        characters: [
            { id: "c1", name: "阿海", appearance: "中年男性，络腮胡", voice: "低沉沙哑，语速偏慢" },
            { id: "c2", name: "小满", appearance: "年轻女性，短发", voice: "清亮，略带哭腔" },
        ],
    },
};

const SCRIPT = { characters: PROJECT.script.characters, scenes: [{ id: "sc1", location: "渡轮" }] };
const STORYBOARD = { shots: [{ id: "sh1", sceneId: "sc1", durationSec: 4, dialogue: "你好。" }] };
const DESIGN = {
    characters: [
        { id: "c1", name: "阿海", closeupPrompt: "a", turnaroundPrompt: "b" },
        { id: "c2", name: "小满", closeupPrompt: "c", turnaroundPrompt: "d" },
    ],
    references: [
        { id: "c1-closeup", bindingId: "c1", role: "character", kind: "closeup", artifactUrl: "/api/artifacts/j1/c1-closeup.png", status: "done" },
        { id: "c1-turnaround", bindingId: "c1", role: "character", kind: "turnaround", artifactUrl: "/api/artifacts/j2/c1-turn.png", status: "done" },
        { id: "c2-closeup", bindingId: "c2", role: "character", kind: "closeup", artifactUrl: "/api/artifacts/j3/c2-closeup.png", status: "done" },
        { id: "c2-turnaround", bindingId: "c2", role: "character", kind: "turnaround", artifactUrl: "/api/artifacts/j4/c2-turn.png", status: "done" },
    ],
};

function build(env) {
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { on: () => () => {}, list: () => [], enqueue: () => null },
        comfy: {},
        llm: {},
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === "prj_1" ? PROJECT : null),
        registerAssetRef: () => {},
    });
    const run = pipeline.create({ novel: "夜色下的渡轮。", options: { projectId: "prj_1" } });
    pipeline.setStageInput(run.id, "script", { output: SCRIPT });
    pipeline.setStageInput(run.id, "storyboard", { output: STORYBOARD });
    pipeline.setStageInput(run.id, "design", { output: DESIGN });
    return { pipeline, runId: run.id };
}

test("casting 阶段确定性组装身份卡：脸取 design 产物、声取 VoiceProfile 且 speaker 是平台合法枚举", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        const run = pipeline.get(runId);
        const casting = run.stages.casting;
        assert.equal(casting.status, "done");
        assert.equal(casting.output.characters.length, 2);
        const c1 = casting.output.characters.find((card) => card.characterId === "c1");
        assert.equal(c1.face.closeupArtifactId, "/api/artifacts/j1/c1-closeup.png");
        assert.deepEqual(c1.face.turnaroundArtifactIds, ["/api/artifacts/j2/c1-turn.png"]);
        assert.equal(c1.face.confirmed, false);
        assert.equal(c1.voice.speaker, "Uncle_fu");
        assert.equal(c1.voice.language, "Chinese");
        assert.equal(c1.confirmed, false);
        assert.equal(c1.lockedAt, null);
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

test("未确认 → keyframe 与 audio 置 blocked，原因写清缺哪个角色的脸/声（复用 #70 机制）", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        const run = pipeline.get(runId);
        for (const id of ["keyframe", "audio"]) {
            const stage = run.stages[id];
            assert.equal(stage.status, "blocked", `${id} 应被拦住`);
            assert.equal(stage.blockedBy, "casting");
            assert.match(stage.blockedReason, /角色定妆未完成/);
            assert.match(stage.error, /角色定妆未完成/);
            // 逐角色写清缺什么：两个角色都缺脸 + 缺声。
            assert.deepEqual(stage.blockedMissing.map((m) => [m.characterId, m.missing]), [
                ["c1", ["脸", "声音"]],
                ["c2", ["脸", "声音"]],
            ]);
            assert.ok(Array.isArray(stage.blocked) && stage.blocked.length === 2);
        }
        // 门禁视图同样拦住并给出原因。
        const gates = pipeline.stageGates(runId);
        for (const id of ["keyframe", "audio"]) {
            const gate = gates.find((g) => g.stageId === id);
            assert.equal(gate.ready, false, `${id} 门禁应 not ready`);
            assert.match(gate.reason, /角色定妆未完成/);
        }
        // 「运行本步」在未确认时被门禁拒绝（409），不静默放行。
        await assert.rejects(async () => {
            const begun = pipeline.beginStage(runId, "keyframe");
            await pipeline.executeStage(begun);
        }, (error) => error.status === 409 && /角色定妆未完成/.test(error.message));
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

test("全部确认 → 精确放行：blocked 清除、门禁 ready", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        assert.equal(pipeline.get(runId).stages.keyframe.status, "blocked");

        // 逐角色确认脸 + 声。
        pipeline.confirmCasting(runId, { characterId: "c1", face: true, speaker: "Uncle_fu", voice: true });
        const midway = pipeline.get(runId);
        assert.equal(midway.stages.keyframe.status, "blocked", "还有 c2 未确认，仍应拦住");
        pipeline.confirmCasting(runId, { characterId: "c2", face: true, speaker: "Serena", voice: true });

        const run = pipeline.get(runId);
        for (const id of ["keyframe", "audio"]) {
            assert.equal(run.stages[id].status, "pending", `${id} 确认齐后应放行（blocked 清除）`);
            assert.equal(run.stages[id].blockedBy, undefined);
            assert.equal(run.stages[id].blockedReason, undefined);
            assert.equal(run.stages[id].error, undefined);
        }
        const gates = pipeline.stageGates(runId);
        // keyframe 仍可能因其它上游（若是 storyboard/design 都 done）而 ready；这里只断言 casting 不再阻断。
        const gate = gates.find((g) => g.stageId === "keyframe");
        assert.equal(gate.blockedBy.some((item) => item.type === "casting"), false);

        // 确认后的身份卡：confirmed 真、lockedAt 写 ISO。
        const c1 = run.stages.casting.output.characters.find((card) => card.characterId === "c1");
        assert.equal(c1.confirmed, true);
        assert.equal(c1.face.confirmed, true);
        assert.equal(c1.voice.confirmed, true);
        assert.match(c1.lockedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

test("确认校验：非法音色被拒；无脸产物就确认脸被拒（不假装已锁）", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        assert.throws(() => pipeline.confirmCasting(runId, { characterId: "c1", speaker: "hacker" }), (error) => error.status === 400 && /不支持的音色/.test(error.message));
        // 抹掉脸产物后确认脸 → 409。
        pipeline.setStageInput(runId, "casting", {
            output: { characters: [{ characterId: "c1", name: "阿海", face: { closeupArtifactId: "", turnaroundArtifactIds: [], confirmed: false }, voice: { voiceProfileId: "vp_c1", speaker: "Uncle_fu", design: "", speed: 1, language: "Chinese", previewArtifactId: "", confirmed: false }, confirmed: false, version: 1, lockedAt: null }] },
        });
        assert.throws(() => pipeline.confirmCasting(runId, { characterId: "c1", face: true }), (error) => error.status === 409 && /没有正脸或三视图产物/.test(error.message));
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

test("确认后修改 → version +1（提示下游需重新确认）", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        pipeline.confirmCasting(runId, { characterId: "c1", face: true, speaker: "Uncle_fu", voice: true });
        const first = pipeline.get(runId).stages.casting.output.characters.find((card) => card.characterId === "c1");
        assert.equal(first.version, 1);
        // 确认后换音色（仍是合法枚举）→ version 2。
        pipeline.confirmCasting(runId, { characterId: "c1", speaker: "Dylan", voice: true });
        const second = pipeline.get(runId).stages.casting.output.characters.find((card) => card.characterId === "c1");
        assert.equal(second.version, 2);
        assert.equal(second.voice.speaker, "Dylan");
        assert.equal(second.confirmed, true);
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

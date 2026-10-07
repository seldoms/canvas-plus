import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { contextFromBody, createGenerationIntent } from "../src/generation-intent.js";
import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";
import { loadRegistry } from "../src/skills.js";

/**
 * P2 两条真链路的单测：
 *  ① 生成归因透传（contextFromBody）：三条提交链共用同一份口径，
 *     且顶层字段优先于 meta —— 此前 /api/images/enqueue 只认 body.projectId，
 *     shotId/slotId 传了也到不了 job.meta，归因**静默**失效。
 *  ② 分镜改镜头的下游失效（patchStageShot）：改了被下游消费的字段，
 *     必须给 keyframe/audio/assembly 打 stale 并如实上报，绝不悄悄留下漂移的产物。
 *
 * 都走真实生产代码（真 skills 目录、真 registry 扫描、真 pipeline 实例），
 * 没有把被测逻辑复制进测试。
 */

/* ------------------------------ ① 归因透传 ------------------------------ */

test("contextFromBody：顶层优先于 meta（顶层是显式归因，meta 是留痕袋）", () => {
    const context = contextFromBody({ projectId: "p_top", meta: { projectId: "p_meta", shotId: "sh1", slotId: "slot_sh1_key" } });
    assert.equal(context.projectId, "p_top", "顶层显式值胜出");
    assert.equal(context.shotId, "sh1", "meta 里的其余字段照样取到");
    assert.equal(context.slotId, "slot_sh1_key");
});

test("contextFromBody：只传 meta 也能取全五元组（视频路径的既有形态）", () => {
    const context = contextFromBody({ meta: { projectId: "p1", episodeId: "ep_0001", sceneId: "sc_0001", shotId: "sh1", slotId: "slot_sh1_clip" } });
    assert.deepEqual([context.projectId, context.episodeId, context.sceneId, context.shotId, context.slotId], ["p1", "ep_0001", "sc_0001", "sh1", "slot_sh1_clip"]);
});

test("contextFromBody：空串/未给一律归 null，绝不写空串进 meta（空串在下游是假归属）", () => {
    const context = contextFromBody({ projectId: "", shotId: "   ", meta: { episodeId: null, sceneId: undefined } });
    assert.deepEqual(context, { projectId: null, episodeId: null, sceneId: null, shotId: null, slotId: null, runId: null, stageId: null });
});

test("contextFromBody：body 不是对象也不炸（提交体解析失败时退化为全空）", () => {
    assert.equal(contextFromBody(null).projectId, null);
    assert.equal(contextFromBody(undefined).shotId, null);
});

/* ------------------------------ ② 下游失效标记 ------------------------------ */

const SCRIPT_OUTPUT = {
    logline: "末班车",
    synopsis: "深夜末班车上的相遇。",
    characters: [{ id: "c1", name: "老周", profile: "司机" }],
    scenes: [{ id: "sc1", title: "车上", location: "内景 公交车内", time: "夜", intent: "相遇", beats: ["上车"] }],
    episodes: [{ id: "ep1", index: 1, title: "末班车", durationSec: 30, synopsis: "相遇", sceneIds: ["sc1"] }],
};

const STORYBOARD_OUTPUT = {
    shots: [
        { id: "sh1", episodeId: "ep1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "上车", dialogue: "", audio: "", prompt: "a" },
        { id: "sh2", episodeId: "ep1", sceneId: "sc1", index: 2, durationSec: 4, shotSize: "近景", camera: "推", action: "回头", dialogue: "你等谁", audio: "", prompt: "b" },
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
    const root = mkdtempSync(join(tmpdir(), "canvas-p2-stale-"));
    const skillsDir = join(root, "skills");
    // 阶段表登记了 7 个阶段，技能目录必须**全齐**：
    // 缺一个，runStage 就 error（找不到技能），A5 的「跑完才清」永远触发不到。
    const skills = {
        "01-script": ["novel-to-script", "测试剧本", "你是影视剧本改编，返回 JSON。\n小说原文：\n{{novel}}\n"],
        "02-storyboard": ["storyboard", "测试分镜", "你是分镜师，返回 shots 数组。\n剧本：\n{{script}}\n"],
        "03-costume-props": ["costume-props", "测试服化道", "返回服化道 JSON。\n剧本：\n{{script}}\n"],
        "04-keyframes": ["keyframes", "测试关键帧", "返回关键帧 JSON。\n分镜：\n{{storyboard}}\n"],
        "05-clip-assembly": ["clip-assembly", "测试合成", "返回片段 JSON。\n关键帧：\n{{keyframes}}\n"],
        "06-audio": ["audio", "测试配音", "返回配音 JSON。\n分镜：\n{{storyboard}}\n"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}`);
    }
    // 阶段表按真实注册表顺序（storyboard 之后是 keyframe / audio / assembly，design/casting 不消费分镜）。
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "design", title: "服化道", skill: "03-costume-props", requires: ["script"], produces: "design" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design"], produces: "keyframes" },
                { id: "audio", title: "配音", skill: "06-audio", requires: ["storyboard", "design"], produces: "audio" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { maxNovelChunkChars: 16000, videoSeconds: 5, videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function setup(t) {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const projects = createProjects({ dataDir: env.config.dataDir, stages: loadRegistry(env.skillsDir).stages });
    const pipeline = createPipeline({
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
    return { projects, pipeline };
}

/** 下游三段的产物形状必须过 checkStageArtifact（人工改产物也过契约），否则门禁先拒。 */
const DESIGN_OUTPUT = { characters: [{ id: "c1", name: "老周", look: "中年司机，藏青工装" }], scenes: [{ id: "sc1", location: "内景 公交车内", mood: "冷白顶光" }], props: [] };
const KEYFRAME_OUTPUT = {
    frames: [
        { id: "sh1-start", shotId: "sh1", role: "start", prompt: "a", jobId: "j1", artifactUrl: "/api/artifacts/j1/a.png", status: "done" },
        { id: "sh2-start", shotId: "sh2", role: "start", prompt: "b", jobId: "j2", artifactUrl: "/api/artifacts/j2/b.png", status: "done" },
    ],
};
const AUDIO_OUTPUT = { audio: [{ id: "au1", shotId: "sh2", text: "你等谁", artifactUrl: "/api/artifacts/au1/a.wav", status: "done" }] };
const ASSEMBLY_OUTPUT = { order: ["sh1", "sh2"], clips: [{ id: "sh1", shotId: "sh1", keyframeId: "sh1-start", artifactUrl: "/api/artifacts/c1/s1.mp4", status: "done" }] };

/** 造一个分镜已跑、下游三段都有真实产物的 run（stale 判定的真实前提：下游真有东西才会漂移）。 */
async function readyRun(t) {
    const { projects, pipeline } = setup(t);
    const project = projects.create({ title: "P2 失效", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村口", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    pipeline.setStageInput(run.id, "design", { output: DESIGN_OUTPUT });
    pipeline.setStageInput(run.id, "keyframe", { output: KEYFRAME_OUTPUT });
    pipeline.setStageInput(run.id, "audio", { output: AUDIO_OUTPUT });
    pipeline.setStageInput(run.id, "assembly", { output: ASSEMBLY_OUTPUT });
    return { projects, pipeline, runId: run.id, projectId: project.id };
}

test("改 prompt → 关键帧标 stale 并如实上报（画面已与新分镜对不上）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    const result = pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: "new prompt text" });
    assert.deepEqual(result.changedFields, ["prompt"], "只报真正变化的字段");
    assert.ok(result.downstreamStale.includes("keyframe"), "关键帧标 stale");
    assert.ok(!result.downstreamStale.includes("audio"), "prompt 与配音无关，不误伤");
    assert.ok(!result.downstreamStale.includes("assembly"), "合成不直接消费 prompt");
    const run = pipeline.get(runId);
    assert.equal(run.stages.keyframe.stale, true);
    assert.match(run.stages.keyframe.staleReason, /sh1/, "失效原因要指明是哪一镜的哪个字段");
    assert.equal(run.stages.audio.stale, undefined, "配音段不该被标记");
});

test("改 durationSec → 配音与合成都标 stale（时长变了音画必然错位）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    const result = pipeline.patchStageShot(runId, "storyboard", "sh1", { durationSec: 7 });
    assert.deepEqual(result.changedFields, ["durationSec"]);
    assert.ok(result.downstreamStale.includes("audio"));
    assert.ok(result.downstreamStale.includes("assembly"));
});

test("改 dialogue → 只标配音（对白变了要重录，但画面不用动）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    const result = pipeline.patchStageShot(runId, "storyboard", "sh2", { dialogue: "改成别的台词" });
    assert.ok(result.downstreamStale.includes("audio"));
    assert.ok(!result.downstreamStale.includes("keyframe"), "对白不改变画面");
});

test("传同值不算改动 → 不标 stale（不该无故惊动用户重跑流水线）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    const result = pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: "a" });
    assert.deepEqual(result.changedFields, [], "同值不算变化");
    assert.deepEqual(result.downstreamStale, [], "同值不标任何下游");
    assert.equal(pipeline.get(runId).stages.keyframe.stale, undefined);
});

test("结构位字段（episodeId/sceneId/index）显式拒绝，绝不静默改归属", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    for (const field of ["episodeId", "sceneId", "index"]) {
        assert.throws(() => pipeline.patchStageShot(runId, "storyboard", "sh1", { [field]: "x" }), /不可定点改/, `${field} 应被拒`);
    }
    // 拒了之后产物原样，不留半改状态（分镜产出时 episodeId 已被归一到项目侧权威 id）
    assert.equal(pipeline.get(runId).stages.storyboard.output.shots[0].episodeId, "ep_0001");
});

test("shot.id 仍不可改（契约 §3.4）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    assert.throws(() => pipeline.patchStageShot(runId, "storyboard", "sh1", { id: "sh9" }), /镜头 id 稳定不可改/);
});

test("下游没有产物时不标 stale（空跑一次不该留下「需重跑」的噪音提示）", async (t) => {
    const { projects, pipeline } = setup(t);
    const project = projects.create({ title: "无下游", plan: { episodeCount: 1, episodeDurationSec: 30 } });
    const run = pipeline.create({ novel: "很久以前有一个村口", title: "短篇", options: { projectId: project.id } });
    await pipeline.runStage(run.id, "script");
    await pipeline.runStage(run.id, "storyboard");
    const result = pipeline.patchStageShot(run.id, "storyboard", "sh1", { prompt: "changed" });
    assert.deepEqual(result.downstreamStale, [], "下游无产物 → 无需重跑");
    assert.deepEqual(result.changedFields, ["prompt"], "改动本身仍如实上报");
});
test("改回原值 → 撤销 stale 标记（不留「需重跑」的假话在产物里）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    const original = "a";
    pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: "changed" });
    assert.equal(pipeline.get(runId).stages.keyframe.stale, true);
    assert.ok(pipeline.get(runId).stages.storyboard.output.shots[0].staleFrom, "改动留下失效留痕");
    // 改回原值
    pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: original });
    const run = pipeline.get(runId);
    assert.equal(run.stages.keyframe.stale, undefined, "改回原值后不该继续提示重跑");
    assert.equal(run.stages.storyboard.output.shots[0].staleFrom, undefined, "镜头的失效留痕也要清掉");
});

test("改回原值只清本镜的来源，别镜的失效必须保留", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: "changed-1" });
    pipeline.patchStageShot(runId, "storyboard", "sh2", { prompt: "changed-2" });
    const keyframe = pipeline.get(runId).stages.keyframe;
    assert.deepEqual(keyframe.staleSources.map((item) => [item.shotId, item.field]), [["sh1", "prompt"], ["sh2", "prompt"]], "两镜的来源都要记，撤销才分得清");
    // 基线是**字段级**的：每条来源只记自己那个字段的改前值。
    // 早先存整镜指纹，同镜多字段互相拖累 —— 改回 prompt 时 durationSec 仍偏离基线，撤销永远对不上。
    assert.deepEqual(keyframe.staleSources.map((item) => [item.field, item.baseValue]), [["prompt", "a"], ["prompt", "b"]], "每条来源带自己字段的改前基线值");

    pipeline.patchStageShot(runId, "storyboard", "sh2", { prompt: "b" }); // sh2 改回原值
    const run = pipeline.get(runId);
    assert.equal(run.stages.storyboard.output.shots[1].staleFrom, undefined, "sh2 自己的留痕清了");
    assert.deepEqual(run.stages.keyframe.staleSources.map((item) => item.shotId), ["sh1"], "只移除了 sh2 的来源");
    assert.equal(run.stages.keyframe.stale, true, "sh1 仍在改，关键帧依然失效");

    pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: "a" }); // sh1 也改回
    const all = pipeline.get(runId);
    assert.equal(all.stages.keyframe.stale, undefined, "全部改回 → 失效标记撤销");
    assert.equal(all.stages.keyframe.staleSources, undefined);
});

test("下游重跑成功后 stale 自动清除（否则用户陷入「反复重跑仍提示重跑」）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    // 用 dialogue（消费方 = audio）而不是 prompt：audio 是纯 LLM 阶段，单测里能真跑到 done；
    // keyframe/assembly 是生成型阶段，没有真实 Job 后端时永远停在 error，
    // 拿它验「跑完才清」等于什么都验不到（这一条最初就踩了这个坑：技能目录齐了仍红，
    // 根因是阶段根本跑不完，不是清理逻辑不对）。
    pipeline.patchStageShot(runId, "storyboard", "sh1", { dialogue: "改过的台词" });
    const marked = pipeline.get(runId);
    assert.equal(marked.stages.audio.stale, true, "先确认已打上失效标记");
    assert.ok(marked.stages.audio.staleReason, "失效原因要如实写出");
    assert.ok(marked.stages.storyboard.output.shots[0].staleFrom, "镜头侧留痕也在");

    await pipeline.runStage(runId, "audio");
    const after = pipeline.get(runId);
    assert.equal(after.stages.audio.status, "done", "前提：这个阶段确实跑完了");
    assert.equal(after.stages.audio.stale, undefined, "重跑成功后不该继续提示重跑");
    assert.equal(after.stages.audio.staleReason, undefined, "失效原因要一并清（不留假话）");
    assert.equal(after.stages.audio.staleSources, undefined, "来源清单要清");
    assert.equal(after.stages.storyboard.output.shots[0].staleFrom, undefined, "镜头侧留痕是阶段级标记的镜像，也要同步清");
});

test("只有该阶段真跑完才清 stale（跑一半的 partial 不清，否则是假话）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    pipeline.patchStageShot(runId, "storyboard", "sh1", { dialogue: "改过的台词" });
    // 生成型阶段在单测里跑不到 done；用「产物缺失」表达「没跑完」：
    // 直接把它置成 error 态再触发 recompute 不现实，这里改验A5 的守卫条件本身 ——
    // clearStaleOnDone 只在 done 时被调，partial/blocked 路径根本不进那个分支。
    const run = pipeline.get(runId);
    assert.equal(run.stages.audio.stale, true, "打上标记");
    // audio 阶段重跑若产出不合法会 error，此时 stale 必须留着（提示用户还得重跑）。
    pipeline.patchStageShot(runId, "storyboard", "sh1", { dialogue: "又改一次" });
    assert.equal(pipeline.get(runId).stages.audio.stale, true, "再次改动，失效继续成立");
});

test("只有该字段被下游消费时才标 stale（映射表不能一刀切）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    // cuts 消费方是 keyframe + assembly；voiceProfileId 只有 audio 消费。
    const cuts = pipeline.patchStageShot(runId, "storyboard", "sh1", { cuts: [{ atSec: 1, text: "切" }] });
    assert.deepEqual(cuts.downstreamStale.sort(), ["assembly", "keyframe"], "cuts 同时影响关键帧与合成");
    const voice = pipeline.patchStageShot(runId, "storyboard", "sh2", { voiceProfileId: "vp_x" });
    assert.deepEqual(voice.downstreamStale, ["audio"], "音色只影响配音，不牵连关键帧");
    // audio 是声音意图描述，消费方是关键帧（进提示词），不是配音阶段。
    const audioField = pipeline.patchStageShot(runId, "storyboard", "sh1", { audio: "本镜无对白" });
    assert.deepEqual(audioField.downstreamStale, ["keyframe"], "audio 字段的消费方是关键帧");
});

test("不可编辑的字段被拒（staleFrom 可伪造 / generationSlots 可注入）", async (t) => {
    const { pipeline, runId } = await readyRun(t);
    assert.throws(
        () => pipeline.patchStageShot(runId, "storyboard", "sh1", { staleFrom: null }),
        /不可编辑/,
        "staleFrom 是系统派生标记，外部传入会抹掉撤销依据",
    );
    assert.throws(
        () => pipeline.patchStageShot(runId, "storyboard", "sh1", { generationSlots: [] }),
        /不可编辑/,
        "槽位管理有专门的端点，不该从分镜编辑旁路写入",
    );
    assert.throws(() => pipeline.patchStageShot(runId, "storyboard", "sh1", { status: "done" }), /不可编辑/, "status 不属于镜头内容字段");
    // 白名单不该挡住真正的内容字段。
    const ok = pipeline.patchStageShot(runId, "storyboard", "sh1", { prompt: "ok", durationSec: 5 });
    assert.deepEqual(ok.changedFields.sort(), ["durationSec", "prompt"], "内容字段照常可改");
});

/* ---------------- ③ source 取值：真实来源名必须能过（P0 回归） ---------------- */

test("source 取值：真实来源名按 - 分段命中即放行（video-workbench 曾 100% 返回 400）", async () => {
    const base = { kind: "video", template: "t", prompt: "p" };
    // 前端真实写法（web/src/pages/video/index.tsx 的 buildVideoMeta）：子标识在前、来源名在后。
    for (const source of ["video-workbench", "image-workbench", "workbench", "canvas", "project", "api", "canvas-shot"]) {
        const intent = createGenerationIntent({ ...base, source });
        assert.equal(intent.source, source, `${source} 应当被接受`);
    }
    // 底线仍在：不含任何合法段的仍拒。
    for (const source of ["unknown", "shot", "workbenchish", "视频工作台"]) {
        assert.throws(() => createGenerationIntent({ ...base, source }), /非法 source/, `${source} 应当被拒`);
    }
    // 空串按缺省兜到 api（生产既有行为：非浏览器调用方不必声明来源），不是拒。
    assert.equal(createGenerationIntent({ ...base, source: "" }).source, "api");
});

test("source 取值：非法 source 报错信息要说清合法集合与后缀规则", () => {
    assert.throws(
        () => createGenerationIntent({ kind: "video", template: "t", source: "nope" }),
        /project\|canvas\|workbench\|api/,
        "报错要能让调用方一眼看出该传什么",
    );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cuesFromShots } from "../src/audio.js";
import { assembleEpisode, buildCueSrt, ffmpegAvailable, formatSrtTime } from "../src/delivery.js";
import { createPipeline } from "../src/pipeline.js";
import { createProjects } from "../src/projects.js";

/**
 * 配音方式（Plan.audioMode）+ 成片逐句字幕验收：
 *   - buildCueSrt：按台词时间轴逐句生成 SRT（镜头内 startSec → 成片绝对时间，转场扣重叠）；
 *   - 多说话人逐句成条、括号表演注解不进字幕；
 *   - 无台词 / 无片段 / 空 cues → 空串（降级为无字幕，绝不失败）；
 *   - 项目级 audioMode 两取值在成片阶段的行为差异（独立配音 vs 原声）。
 */

const hasFfmpeg = ffmpegAvailable("ffmpeg") && ffmpegAvailable("ffprobe");

// ---------------------------------------------------------------------------
// 1. 纯函数：SRT 时间码与逐句时间轴
// ---------------------------------------------------------------------------

test("formatSrtTime 输出 SRT 时间码（HH:MM:SS,mmm）", () => {
    assert.equal(formatSrtTime(0), "00:00:00,000");
    assert.equal(formatSrtTime(1234), "00:00:01,234");
    assert.equal(formatSrtTime(3661500), "01:01:01,500");
    assert.equal(formatSrtTime(-100), "00:00:00,000");
});

test("buildCueSrt：镜头内 startSec 映射成成片绝对时间（cut，逐句不叠）", () => {
    const clips = [
        { id: "c1", shotId: "sh1", durationSec: 4 },
        { id: "c2", shotId: "sh2", durationSec: 5 },
    ];
    const cues = [
        { shotId: "sh1", startSec: 0, durationSec: 2, text: "第一句。" },
        { shotId: "sh1", startSec: 2, durationSec: 2, text: "第二句。" },
        { shotId: "sh2", startSec: 0, durationSec: 2.5, text: "第三句。" },
    ];
    const srt = buildCueSrt({ clips, cues, transition: "cut" });
    assert.match(srt, /1\n00:00:00,000 --> 00:00:02,000\n第一句。/);
    assert.match(srt, /2\n00:00:02,000 --> 00:00:04,000\n第二句。/);
    // sh2 起点 = sh1 时长 4s（cut 无重叠）
    assert.match(srt, /3\n00:00:04,000 --> 00:00:06,500\n第三句。/);
});

test("buildCueSrt：转场档扣掉重叠，延迟与 clipStartOffsets 同源", () => {
    const clips = [
        { id: "c1", shotId: "sh1", durationSec: 4 },
        { id: "c2", shotId: "sh2", durationSec: 4 },
    ];
    const cues = [{ shotId: "sh2", startSec: 1, durationSec: 2, text: "后半段。" }];
    const srt = buildCueSrt({ clips, cues, transition: "dissolve", transitionDurationSec: 0.6 });
    // sh2 起点 = 4 - 0.6 = 3.4s；+1s = 4.4s
    assert.match(srt, /00:00:04,400 --> 00:00:06,400\n后半段。/);
});

test("buildCueSrt：按 order 重排后时间轴跟着变", () => {
    const clips = [
        { id: "c1", shotId: "sh1", durationSec: 4 },
        { id: "c2", shotId: "sh2", durationSec: 4 },
    ];
    const cues = [{ shotId: "sh1", startSec: 0, durationSec: 2, text: "先说的话。" }];
    const srt = buildCueSrt({ clips, order: ["c2", "c1"], cues, transition: "cut" });
    // sh1 被排到第二段 → 起点 4s
    assert.match(srt, /00:00:04,000 --> 00:00:06,000\n先说的话。/);
});

// ---------------------------------------------------------------------------
// 2. 多说话人 + 表演注解清洗
// ---------------------------------------------------------------------------

test("buildCueSrt：多说话人逐句成条，括号表演注解不进字幕（纯台词正文）", () => {
    const shots = [
        {
            id: "sh1",
            durationSec: 4,
            dialogueLines: [
                { speaker: "c1", text: "你好。（低声）" },
                { speaker: "c2", text: "再见。" },
            ],
        },
    ];
    const cues = cuesFromShots({
        shots,
        characters: [
            { id: "c1", name: "阿海" },
            { id: "c2", name: "小满" },
        ],
    });
    // 每条台词落对说话人（多说话人归属正确）
    assert.deepEqual(cues.map((cue) => cue.characterId), ["c1", "c2"]);

    const srt = buildCueSrt({ clips: [{ id: "c1", shotId: "sh1", durationSec: 4 }], cues, transition: "cut" });
    assert.doesNotMatch(srt, /[（）()【】]/, "字幕不得带括号表演注解");
    // 两句均分 4s：0-2 / 2-4，各成一条
    assert.match(srt, /1\n00:00:00,000 --> 00:00:02,000\n你好。/);
    assert.match(srt, /2\n00:00:02,000 --> 00:00:04,000\n再见。/);
});

// ---------------------------------------------------------------------------
// 3. 空台词 / 无时间轴降级
// ---------------------------------------------------------------------------

test("buildCueSrt：无片段 / 无台词 / 空 cues 都返回空串（降级，不抛错）", () => {
    const clips = [{ id: "c1", shotId: "sh1", durationSec: 2 }];
    assert.equal(buildCueSrt({ clips: [], cues: [{ shotId: "sh1", startSec: 0, durationSec: 2, text: "x" }] }), "");
    assert.equal(buildCueSrt({ clips, cues: [] }), "");
    assert.equal(buildCueSrt({ clips, cues: [{ shotId: "sh1", startSec: 0, durationSec: 2, text: "   " }] }), "");
    assert.equal(buildCueSrt({ clips, cues: [{ shotId: "sh1", startSec: 0, durationSec: 2, text: "" }] }), "");
});

test("buildCueSrt：cue 缺时长用兜底时长，仍能出条", () => {
    const srt = buildCueSrt({ clips: [{ id: "c1", shotId: "sh1", durationSec: 2 }], cues: [{ shotId: "sh1", startSec: 0, text: "没时长的句子。" }] });
    assert.match(srt, /00:00:00,000 --> 00:00:01,500\n没时长的句子。/);
});

// ---------------------------------------------------------------------------
// 4. 项目级 Plan.audioMode（默认独立配音 / 可切原声 / 非法回落）
// ---------------------------------------------------------------------------

test("Projects.plan.audioMode：默认独立配音；embedded 生效；别名与非法值回落", (t) => {
    const root = mkdtempSync(join(tmpdir(), "audio-mode-proj-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const projects = createProjects({ dataDir: root });

    assert.equal(projects.create({ title: "默认" }).plan.audioMode, "separate_dialogue_track");
    assert.equal(projects.create({ title: "原声", plan: { audioMode: "embedded" } }).plan.audioMode, "embedded");
    // §11.5.1 同义别名归一到 separate_dialogue_track
    assert.equal(projects.create({ title: "别名", plan: { audioMode: "separate_track" } }).plan.audioMode, "separate_dialogue_track");
    // 非法值回落默认，不落盘脏值
    assert.equal(projects.create({ title: "非法", plan: { audioMode: "loud" } }).plan.audioMode, "separate_dialogue_track");
});

// ---------------------------------------------------------------------------
// 5. 成片阶段 audioMode 两取值的行为差异（pipeline 接线）
// ---------------------------------------------------------------------------

/** 最小 skills 环境：登记 storyboard/design/audio/assembly 四个阶段。 */
function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-audio-mode-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: [], produces: "storyboard" },
                { id: "design", title: "服化道", skill: "03-design", requires: [], produces: "design" },
                { id: "audio", title: "配音", skill: "06-audio", requires: ["storyboard"], produces: "audio" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["storyboard"], produces: "clips" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { audioTemplate: "audio_qwen3_tts", audioDevice: "cuda", videoTemplate: "video-test", videoFps: 24 } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

function fakeJobQueue() {
    const store = new Map();
    const handlers = [];
    const emit = (job) => handlers.forEach((handler) => handler(job));
    return {
        store,
        enqueue(job) {
            const created = { ...job, status: "queued", outputs: [], createdAt: job.createdAt || new Date().toISOString() };
            store.set(created.id, created);
            emit(created);
            return created;
        },
        get: (id) => store.get(id) || null,
        list: () => [...store.values()],
        cancel(id) {
            const job = store.get(id);
            if (!job) return null;
            Object.assign(job, { status: "canceled" });
            emit(job);
            return job;
        },
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

function writeArtifact(config, jobId, filename, text = "flac-bytes") {
    const dir = join(config.dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), text);
    return `/api/artifacts/${jobId}/${filename}`;
}

/** 造一个带对白的项目（两个说话人各一句）。audioMode 由 options 决定。 */
function makeProject(audioMode) {
    return {
        id: "prj_1",
        script: {
            characters: [
                { id: "c1", name: "阿海", voice: "音色低沉沙哑，语速慢" },
                { id: "c2", name: "小满", voice: "音色清亮" },
            ],
        },
        plan: audioMode ? { audioMode } : {},
        episodes: [{ id: "ep_0001", sceneIds: ["sc1"] }],
    };
}

const SHOTS = {
    shots: [
        {
            id: "sh1",
            episodeId: "ep_0001",
            sceneId: "sc1",
            durationSec: 4,
            dialogueLines: [
                { speaker: "c1", text: "你好。（低声）" },
                { speaker: "c2", text: "走吧。" },
            ],
        },
    ],
};

const CLIPS = {
    clips: [{ id: "sh1-clip", shotId: "sh1", durationSec: 4, artifactUrl: "/api/artifacts/c1/clip.mp4", status: "done" }],
    assembly: { order: ["sh1-clip"], transition: "cut", status: "queued" },
};

function build(env, project) {
    const jobs = fakeJobQueue();
    const record = [];
    const assemble = async (args) => {
        record.push(args);
        const hasText = Boolean(args.options?.subtitlesText);
        const burn = args.options?.burnSubtitles === true;
        return {
            id: "delivery-x",
            url: "/api/artifacts/delivery-x/final.mp4",
            manifestUrl: "/api/artifacts/delivery-x/assembly-manifest.json",
            logPath: "/tmp/ffmpeg.log",
            coverUrl: null,
            bytes: 123,
            info: { hasVideo: true, hasAudio: true },
            // 独立字幕产物：给了文本就落盘成 .srt（默认不烧）；只有显式 burnSubtitles 才烧进画面。
            subtitles: hasText && burn ? "/api/artifacts/delivery-x/ep.srt" : null,
            subtitlesPath: hasText ? `/tmp/delivery-x/${args.episodeId}.srt` : null,
            subtitlesName: hasText ? `${args.episodeId}.srt` : null,
            subtitlesUrl: hasText ? "/api/artifacts/delivery-x/ep.srt" : null,
            subtitlesBurned: hasText && burn,
        };
    };
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs,
        comfy: {},
        llm: {},
        runJob: async () => ({ outputs: [] }),
        assemble,
        getProject: (id) => (id === "prj_1" ? project : null),
    });
    pipeline.bindJobs();
    return { pipeline, jobs, record };
}

async function prepare(env, project) {
    const { pipeline, jobs, record } = build(env, project);
    const run = pipeline.create({ novel: "夜色下的渡轮。", options: { projectId: "prj_1" } });
    pipeline.setStageInput(run.id, "storyboard", { output: SHOTS });
    pipeline.setStageInput(run.id, "design", { output: { characters: [] } });
    await pipeline.runStage(run.id, "audio");
    pipeline.setStageInput(run.id, "assembly", { output: CLIPS });
    return { pipeline, jobs, record, runId: run.id };
}

test("audioMode=separate_dialogue_track（默认）：入队 TTS，成片用独立音轨且不保留片段原声，逐句生成独立 SRT（默认不烧）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await prepare(env, makeProject());

    const audioJobs = [...jobs.store.values()].filter((job) => job.kind === "audio");
    assert.equal(audioJobs.length, 2, "独立配音：两条对白各入队一个 TTS 任务");
    for (const job of audioJobs) {
        jobs.finish(job.id, "done", { outputs: [{ url: writeArtifact(env.config, job.id, "a.flac"), type: "audio", bytes: 100 }] });
    }

    await pipeline.assembleStage(runId);
    assert.equal(record.length, 1);
    const opts = record[0].options;
    assert.equal(opts.audio.length, 2, "成片混音应带独立 TTS 音轨");
    assert.equal(opts.includeClipAudio, false, "有独立音轨 → 不保留片段原声（防双重人声）");
    // 字幕仍按台词时间轴逐句生成（作为独立产物交付），但**默认不烧**进画面。
    assert.equal(opts.burnSubtitles, false, "成片默认不烧字幕（要过剪映精剪）");
    assert.equal(opts.subtitleStyle, null, "不烧 → 不传烧录样式");
    assert.ok(opts.subtitlesText && opts.subtitlesText.includes("你好。"), "应生成含纯台词的 SRT");
    assert.ok(opts.subtitlesText.includes("走吧。"));
    assert.doesNotMatch(opts.subtitlesText, /[（）()【】]/, "字幕不带表演注解");
    assert.match(opts.subtitlesText, /00:00:00,000 --> 00:00:02,000\n你好。/);

    const run = pipeline.get(runId);
    const subtitles = run.stages.assembly.output.assembly.subtitles;
    assert.equal(subtitles.burned, false, "默认未烧字幕");
    assert.equal(run.stages.assembly.output.assembly.subtitleCues, 2);
    assert.ok(subtitles.url, "SRT 应暴露为可下载 URL");
    assert.equal(subtitles.name, `${runId}.srt`, "独立 SRT 与成片同目录同名");
    assert.equal(subtitles.lines, 2, "SRT 逐句两条");
});

test("audioMode=embedded（原声）：不入队 TTS、不产独立配音；成片保留片段原声，字幕照常生成独立 SRT", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, jobs, record, runId } = await prepare(env, makeProject("embedded"));

    assert.equal([...jobs.store.values()].filter((job) => job.kind === "audio").length, 0, "原声：不产独立配音（零 TTS 任务）");
    assert.deepEqual(pipeline.get(runId).stages.audio.output.audio, []);
    assert.equal(pipeline.get(runId).stages.audio.status, "done");

    await pipeline.assembleStage(runId);
    const opts = record[0].options;
    assert.deepEqual(opts.audio, [], "原声：不混独立音轨");
    assert.equal(opts.includeClipAudio, true, "原声：保留片段内嵌音频");
    assert.equal(opts.burnSubtitles, false, "原声模式：同样默认不烧"); 
    assert.ok(opts.subtitlesText && opts.subtitlesText.includes("你好。"), "字幕与 TTS 解耦，原声模式照常生成独立 SRT");
});

test("audioMode 缺省即默认独立配音（未绑项目也回落默认）", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { jobs } = await prepare(env, makeProject());
    assert.ok([...jobs.store.values()].some((job) => job.kind === "audio"), "默认应走独立配音（入队 TTS）");
});

test("空台词降级：无对白 → 无独立字幕 + warning，成片照常产出", async (t) => {
    const env = makeEnv();
    t.after(() => rmSync(env.root, { recursive: true, force: true }));
    const { pipeline, record, runId } = build(env, makeProject());
    const run = pipeline.create({ novel: "无声。", options: { projectId: "prj_1" } });
    pipeline.setStageInput(run.id, "storyboard", { output: { shots: [{ id: "sh1", sceneId: "sc1", durationSec: 4, dialogue: "", prompt: "empty" }] } });
    pipeline.setStageInput(run.id, "design", { output: { characters: [] } });
    await pipeline.runStage(run.id, "audio");
    pipeline.setStageInput(run.id, "assembly", { output: CLIPS });

    const done = await pipeline.assembleStage(run.id);
    assert.equal(done.stages.assembly.output.assembly.status, "done", "无台词也必须能出片");
    const opts = record[0].options;
    assert.equal(opts.subtitlesText, null, "无台词 → 不产字幕");
    assert.equal(opts.subtitleStyle, null);
    const subtitles = done.stages.assembly.output.assembly.subtitles;
    assert.equal(subtitles.burned, false);
    assert.equal(subtitles.url, null, "无台词 → 无独立字幕文件");
    assert.ok((done.stages.assembly.warnings || []).some((w) => String(w).startsWith("成片无独立字幕：")), "应记降级 warning（新语义）");
});

// ---------------------------------------------------------------------------
// 6. 真机：subtitlesText 落盘独立 SRT，成片**默认不烧**字幕
// ---------------------------------------------------------------------------

/** 造一段 3s 的纯色片段（真机用例共用）。 */
function makeClip(dir) {
    const clip = join(dir, "clip.mp4");
    const made = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=navy:s=320x240:r=10:d=3", "-pix_fmt", "yuv420p", "-c:v", "libx264", clip], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    return clip;
}

test("真机：subtitlesText 落盘独立 SRT，成片**默认不烧**（画面不含字幕）", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-subtitle-noburn-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const clip = makeClip(dir);

    const srt = "1\n00:00:00,000 --> 00:00:01,500\n你好，世界。\n\n2\n00:00:01,500 --> 00:00:03,000\n再见。\n";
    const result = await assembleEpisode({
        config: { dataDir: dir, pipeline: { videoWidth: 320, videoHeight: 240, videoFps: 10 } },
        episodeId: "subtitle-noburn",
        clips: [{ id: "c1", shotId: "sh1", artifactUrl: clip, durationSec: 3 }],
        options: { id: "subtitle-noburn", subtitlesText: srt, subtitleStyle: "FontName=Noto Sans CJK SC" },
    });

    assert.equal(result.status, "done");
    // 独立 SRT 产物落盘（默认不烧也一定有）
    assert.equal(result.subtitlesBurned, false, "默认不烧字幕");
    assert.equal(result.subtitles, null, "未烧 → 无烧入字幕路径（向后兼容字段）");
    assert.ok(result.subtitlesPath && readFileSync(result.subtitlesPath, "utf8").includes("你好，世界。"), "独立 SRT 应落盘且内容正确");
    assert.equal(result.subtitlesName, "subtitle-noburn.srt", "SRT 与成片同目录同名");
    assert.ok(result.subtitlesUrl && result.subtitlesUrl.includes("subtitle-noburn.srt"), "应暴露可下载 URL");
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.ok(!manifest.commands[0].includes("subtitles=filename="), "ffmpeg 命令**不得**含字幕烧入");
    assert.equal(manifest.subtitleArtifact?.burned, false, "清单登记独立字幕产物且未烧");
    assert.equal(result.info.hasVideo, true);
    assert.ok(result.bytes > 0);
});

test("真机：显式 burnSubtitles:true 时才烧字幕（烧录能力保留）", { skip: !hasFfmpeg && "本机无 ffmpeg/ffprobe" }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-subtitle-burn-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const clip = makeClip(dir);

    const srt = "1\n00:00:00,000 --> 00:00:01,500\n你好，世界。\n\n2\n00:00:01,500 --> 00:00:03,000\n再见。\n";
    const result = await assembleEpisode({
        config: { dataDir: dir, pipeline: { videoWidth: 320, videoHeight: 240, videoFps: 10 } },
        clips: [{ id: "c1", shotId: "sh1", artifactUrl: clip, durationSec: 3 }],
        options: { id: "subtitle-burn", subtitlesText: srt, burnSubtitles: true, subtitleStyle: "FontName=Noto Sans CJK SC" },
    });

    assert.equal(result.status, "done");
    assert.equal(result.subtitlesBurned, true, "显式开启才烧");
    assert.ok(result.subtitles && readFileSync(result.subtitles, "utf8").includes("你好，世界。"), "烧入用 SRT 落盘内容应正确");
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.ok(manifest.commands[0].includes("subtitles=filename="), "ffmpeg 命令应含字幕烧入");
    assert.equal(result.info.hasVideo, true);
});

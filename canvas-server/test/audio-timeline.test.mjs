import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAudioTimeline } from "../src/audio-timeline.js";
import { projectVoiceProfiles } from "../src/audio-track.js";
import { assembleEpisode, ffmpegAvailable } from "../src/delivery.js";
import { h3DialogueSentence } from "../src/prompt-compiler.js";
import { compileH3VideoPrompt } from "../src/prompt-compiler.js";

test("电话事故回归：三句实际配音能放入镜头，不因均分窗口造成跨镜抢词", () => {
    const durations = [1.096875, 2.056875, 5.176875];
    const result = buildAudioTimeline({
        clips: [{ shotId: "sh1", durationSec: 10.125 }],
        audio: [0, 3.333, 6.667].map((startSec, index) => ({ cueId: `cue${index}`, shotId: "sh1", type: "dialogue", startSec })),
        durations, sequential: true,
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.audio[2].startSec, durations[0] + durations[1]);
    assert.ok(result.audio[2].endSec < 10.125);
});

test("对白实际超长和显式重叠不能靠截词或混音掩盖", () => {
    const clips = [{ shotId: "sh1", durationSec: 4 }];
    const audio = [{ shotId: "sh1", cueId: "a", type: "dialogue", startSec: 0 }, { shotId: "sh1", cueId: "b", type: "dialogue", startSec: 1 }];
    const result = buildAudioTimeline({ clips, audio, durations: [3, 3], sequential: true });
    assert.equal(result.audio[1].durationSec, 3);
    assert.equal(result.issues[0].code, "dialogue_overflow");
    const explicit = buildAudioTimeline({ clips, audio, durations: [2, 2] });
    assert.ok(explicit.issues.some((issue) => issue.code === "dialogue_overlap"));
});

test("定妆确认的声音覆盖剧本推导；确认版本随实际配音使用", () => {
    const { profiles } = projectVoiceProfiles({
        characters: [{ id: "c1", name: "陈默", voice: "旧音色" }],
        casting: { characters: [{ characterId: "c1", version: 3, voice: { confirmed: true, voiceProfileId: "vp_c1", speaker: "Ryan", design: "厚道真诚的男声", language: "Chinese", speed: 1 } }] },
    });
    assert.equal(profiles[0].speaker, "Ryan");
    assert.equal(profiles[0].design, "厚道真诚的男声");
    assert.equal(profiles[0].timbre, profiles[0].design);
    assert.equal(profiles[0].version, 3);
});

test("电话与当面回应逐句区分；只有电话那一轮要求听者闭嘴", () => {
    const prompt = h3DialogueSentence({
        audio: "电话里的画外音与当面回应",
        dialogueLines: [{ speaker: "c1", text: "明天来吗？", performance: "电话里" }, { speaker: "c2", text: "来！" }],
    }, [{ id: "c1", name: "甲" }, { id: "c2", name: "乙" }]);
    assert.match(prompt, /甲 \(S1\) says in an off-screen voiceover/);
    assert.match(prompt, /乙 \(S2\) says:/);
    assert.equal((prompt.match(/off-screen voiceover/g) || []).length, 1);
    assert.match(prompt, /each finishing before the next begins/);
    const visible = h3DialogueSentence({ action: "甲拿着电话开口。", dialogueLines: [{ speaker: "c1", text: "明天来吗？", performance: "电话里" }] }, [{ id: "c1", name: "甲" }]);
    assert.doesNotMatch(visible, /off-screen voiceover/);
});

test("独立对白模式不把另一条 H3 原生人声送进视频提示词", () => {
    const prompt = compileH3VideoPrompt({ template: "video_h3_i2v", audioMode: "separate_dialogue_track", shot: { dialogue: "这句不能由 H3 朗读。" }, characters: [{ id: "c1", name: "甲" }] });
    assert.doesNotMatch(prompt, /<d>/);
    assert.match(prompt, /overall_soundscape:/);
});

test("真媒体：实测视频长度、配音轮次、字幕与混音清单共用时间轴，关闭响度归一可执行", { skip: !ffmpegAvailable() || !ffmpegAvailable("ffprobe") }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "audio-timeline-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const video = join(root, "video.mp4");
    const speech = join(root, "speech.wav");
    // 用**异步** spawn 造媒体，不能用 spawnSync（2026-10-08 修的偶发红根因）：
    // spawnSync 会**阻塞事件循环**，而 assembleEpisode 内部的 ffmpeg 是异步 spawn。
    // `node --test` 默认并发跑文件，于是本测试的同步 ffmpeg 与别的文件的异步 ffmpeg 抢 CPU，
    // 后者超时退出（实测退出码 228，3 次全量里红 1 次、单跑必绿）。
    // 偶发红的测试比没有测试更糟 —— 它会让人开始不信整条测试链，所以这里改异步让出事件循环。
    const create = (args) =>
        new Promise((resolve, reject) => {
            const child = spawn("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(0, 300)}`));
            });
        });
    await create(["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=2.125", "-c:v", "libx264", video]);
    await create(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", speech]);
    const clips = ["s1", "s2"].map((shotId) => ({ id: shotId, shotId, artifactUrl: video, durationSec: 2 }));
    const audio = ["s1", "s1", "s2"].map((shotId, index) => ({ ref: speech, cueId: `cue${index}`, shotId, type: "dialogue", startSec: index === 1 ? 1 : 0 }));
    const result = await assembleEpisode({
        config: { dataDir: root }, clips,
        options: { audio, scheduleDialogue: true, width: 64, height: 64, cover: false, loudnorm: false, subtitleCues: audio.map((item) => ({ ...item, id: item.cueId, text: item.cueId, durationSec: 1 })) },
    });
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.plan.clips[0].durationSec, 2.125);
    assert.equal(manifest.plan.audio[1].delayMs, 600);
    assert.equal(manifest.plan.audio[2].delayMs, 2125);
    assert.match(readFileSync(result.subtitlesPath, "utf8"), /00:00:02,125 --> 00:00:02,725\ncue2/);
    assert.equal(result.quality.status, "needs_review", "媒体时序通过不能代替人物与口型的感知验收");
    assert.ok(result.info.hasAudio);
    await assert.rejects(assembleEpisode({
        config: { dataDir: root }, clips,
        options: { id: "overlap", audio: [audio[0], { ...audio[1], startSec: 0.2 }], width: 64, height: 64, cover: false },
    }), (error) => error.quality?.status === "blocked" && error.quality.issues.some((issue) => issue.code === "dialogue_overlap"));
    assert.equal(JSON.parse(readFileSync(join(root, "artifacts/overlap/assembly-manifest.json"), "utf8")).status, "failed");
});

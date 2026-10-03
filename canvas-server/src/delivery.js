import { spawn, spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { artifactUrl, ensureDir, safeJoin, sanitizeName } from "./files.js";

/**
 * CPU 侧后期执行器：把 assembly 阶段规划好的片段按顺序拼成成片，并留下可复现的拼接清单。
 * 只负责「片段 → 成片」这一件事，不接路由、不入队列；由后续的后期 Tool/Workflow 调用。
 * 片段本身不会被修改或删除；失败时保留 ffmpeg 日志与清单，绝不把「片段生成完」当成「成片完成」。
 */

/** 转场名 → ffmpeg xfade 的 transition 值；cut 走 concat，其余走 xfade。 */
export const TRANSITION_MAP = { cut: null, fade: "fade", dissolve: "dissolve", slide: "slideleft" };

export const DEFAULT_TRANSITION_SEC = 0.6;

/**
 * 成片质量档 → ffmpeg 编码参数。ffmpeg 参数只在这里拼装，编排器只传档名（standard/draft/high）。
 * standard 与本模块此前的硬编码值一致，保证默认行为不变。
 */
export const QUALITY_PRESETS = {
    draft: { preset: "veryfast", crf: 30 },
    standard: { preset: "veryfast", crf: 20 },
    high: { preset: "slow", crf: 18 },
};

/** 本机是否装有 ffmpeg（测试与非 Linux 环境用来决定是否跳过真机用例）。 */
export function ffmpegAvailable(bin = "ffmpeg") {
    const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
    return !result.error;
}

/** 跑一个外部命令，把 stdout/stderr 合并落到 logPath；非 0 退出码抛错并带上日志路径。 */
function run(bin, args, { logPath } = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
            const output = Buffer.concat(chunks).toString("utf8");
            if (logPath) writeFileSync(logPath, `$ ${bin} ${args.join(" ")}\n\n${output}`, "utf8");
            if (code === 0) resolvePromise({ code, output });
            else reject(Object.assign(new Error(`${basename(bin)} 退出码 ${code}${logPath ? `，日志：${logPath}` : ""}`), { code, output, logPath }));
        });
    });
}

/**
 * 把片段引用解析成本机可读文件路径。
 * 流水线回填的 artifactUrl 是网关自己的相对地址（/api/artifacts/...），直接读本地产物，不依赖 publicUrl。
 * 远端 http(s) 片段不在这里下载（下载与校验属上游），明确报错而不是静默失败。
 */
export function resolveMediaPath(config, ref) {
    const text = String(ref ?? "").trim();
    if (!text) throw new Error("片段缺少产物地址");
    if (text.startsWith("/api/artifacts/")) {
        const segments = text.slice("/api/artifacts/".length).split("/").filter(Boolean).map(decodeURIComponent);
        const file = safeJoin(config.dataDir, "artifacts", ...segments);
        if (!file) throw new Error(`非法产物地址：${text}`);
        return file;
    }
    if (text.startsWith("file://")) return fileURLToPath(text);
    if (/^https?:\/\//i.test(text)) throw new Error(`暂不支持远端 URL 片段（${text}），请先把片段落盘为 /api/artifacts 或本机路径`);
    return resolve(text);
}

/**
 * 纯函数：校验片段与顺序，产出可复现的拼接清单（供事后追溯，不含任何时间戳以外的环境信息）。
 * 顺序缺项、重复、引用不存在的片段、片段没有产物、转场时长不小于最短片段，都直接抛错。
 */
export function buildAssemblyPlan({
    episodeId = null,
    clips,
    order,
    transition = "cut",
    transitionDurationSec = DEFAULT_TRANSITION_SEC,
    width = 768,
    height = 1344,
    fps = 24,
    quality = "standard",
    audio = [],
    subtitles = null,
    cover = true,
    now,
} = {}) {
    if (!Array.isArray(clips) || clips.length === 0) throw new Error("拼接清单为空：没有任何片段可拼接");
    if (!(transition in TRANSITION_MAP)) throw new Error(`不支持的转场：${transition}（可选 ${Object.keys(TRANSITION_MAP).join(" / ")}）`);
    if (!(quality in QUALITY_PRESETS)) throw new Error(`不支持的成片质量：${quality}（可选 ${Object.keys(QUALITY_PRESETS).join(" / ")}）`);

    const byId = new Map();
    for (const clip of clips) {
        if (!clip?.id) throw new Error("片段缺少 id");
        if (byId.has(clip.id)) throw new Error(`片段 id 重复：${clip.id}`);
        byId.set(clip.id, clip);
    }

    const ids = Array.isArray(order) && order.length ? order : clips.map((clip) => clip.id);
    if (ids.length !== clips.length) throw new Error(`拼接顺序含 ${ids.length} 个片段，与片段总数 ${clips.length} 不一致`);
    const seen = new Set();
    for (const id of ids) {
        if (!byId.has(id)) throw new Error(`拼接顺序引用了不存在的片段：${id}`);
        if (seen.has(id)) throw new Error(`拼接顺序存在重复片段：${id}`);
        seen.add(id);
    }

    const duration = transition === "cut" ? 0 : Number(transitionDurationSec);
    const ordered = ids.map((id, index) => {
        const clip = byId.get(id);
        const ref = clip.artifactUrl || clip.path;
        if (!ref) throw new Error(`片段 ${id} 还没有产物（artifactUrl 为空），不能拼接成片`);
        const durationSec = Number(clip.durationSec) > 0 ? Number(clip.durationSec) : null;
        if (transition !== "cut" && durationSec === null) throw new Error(`片段 ${id} 缺少有效 durationSec，无法计算转场偏移`);
        return { index, id, shotId: clip.shotId ?? null, ref, durationSec, status: clip.status ?? null };
    });

    if (transition !== "cut") {
        if (!(duration > 0)) throw new Error(`转场时长必须大于 0，当前为 ${transitionDurationSec}`);
        const shortest = Math.min(...ordered.map((clip) => clip.durationSec));
        if (duration >= shortest) throw new Error(`转场时长 ${duration}s 不小于最短片段 ${shortest}s，会拼不出成片`);
    }

    return {
        version: 1,
        episodeId,
        createdAt: now || new Date().toISOString(),
        transition,
        transitionDurationSec: duration,
        width: Number(width) || 768,
        height: Number(height) || 1344,
        fps: Number(fps) || 24,
        quality,
        clips: ordered,
        audio: Array.isArray(audio) ? audio : [],
        subtitles: subtitles || null,
        cover: cover !== false,
    };
}

const escapeFilterPath = (value) => String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/**
 * 纯函数：清单 → ffmpeg 参数数组（不含 ffmpeg 可执行文件本身）。
 * 所有片段先统一到目标尺寸/帧率/pix_fmt 再拼接：cut 用 concat，转场用 xfade；
 * 外部音轨混流用 amix，字幕烧入接在最终视频标签后。
 */
export function buildConcatArgs(plan, { inputPaths, audioPaths = [], outputPath } = {}) {
    if (!outputPath) throw new Error("缺少输出路径");
    if (!Array.isArray(inputPaths) || inputPaths.length !== plan.clips.length) throw new Error("输入文件数与清单片段数不一致");

    const { width: W, height: H, fps } = plan;
    const { preset, crf } = QUALITY_PRESETS[plan.quality] || QUALITY_PRESETS.standard;
    const normalize = (index) =>
        `[${index}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`;

    const parts = inputPaths.map((_, index) => normalize(index));
    const n = inputPaths.length;

    if (plan.transition === "cut" || n === 1) {
        const inputs = inputPaths.map((_, index) => `[v${index}]`).join("");
        parts.push(`${inputs}concat=n=${n}:v=1:a=0[vcat]`);
    } else {
        const xfade = TRANSITION_MAP[plan.transition];
        const D = plan.transitionDurationSec;
        let current = "v0";
        let sum = 0;
        for (let index = 1; index < n; index++) {
            sum += plan.clips[index - 1].durationSec;
            const offset = sum - index * D;
            const out = index === n - 1 ? "vcat" : `x${index}`;
            parts.push(`[${current}][v${index}]xfade=transition=${xfade}:duration=${D}:offset=${offset.toFixed(3)}[${out}]`);
            current = out;
        }
    }

    let videoLabel = "vcat";
    if (plan.subtitles) {
        parts.push(`[vcat]subtitles=filename='${escapeFilterPath(plan.subtitles)}'[vsub]`);
        videoLabel = "vsub";
    }

    const args = ["-y"];
    for (const path of inputPaths) args.push("-i", path);
    for (const path of audioPaths) args.push("-i", path);

    const maps = [`-map`, `[${videoLabel}]`];
    if (audioPaths.length) {
        const base = inputPaths.length;
        const audioLabels = [];
        audioPaths.forEach((_, index) => {
            const label = `a${index}`;
            parts.push(`[${base + index}:a]aresample=44100[${label}]`);
            audioLabels.push(`[${label}]`);
        });
        if (audioLabels.length === 1) parts.push(`${audioLabels[0]}anull[aout]`);
        else parts.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
        maps.push("-map", "[aout]", "-shortest");
    }

    args.push("-filter_complex", parts.join(";"));
    args.push(...maps, "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (audioPaths.length) args.push("-c:a", "aac", "-b:a", "192k");
    args.push(outputPath);
    return args;
}

/** 纯函数：从成片里抽一帧当封面。 */
export function buildCoverArgs({ inputPath, outputPath, atSec = 0 } = {}) {
    if (!inputPath || !outputPath) throw new Error("抽帧需要输入与输出路径");
    return ["-y", "-ss", String(atSec), "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath];
}

/** 读媒体流的客观信息（分辨率/时长/是否有音轨），用来判定「成片」真的能被解析。任意 ffprobe 失败都返回 null 由调用方决定。 */
export async function probeMedia(filePath, ffprobePath = "ffprobe") {
    let output;
    try {
        ({ output } = await run(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath]));
    } catch {
        return null;
    }
    let data;
    try {
        data = JSON.parse(output);
    } catch {
        return null;
    }
    const streams = data.streams || [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    return {
        durationSec: Number(data.format?.duration) || Number(video?.duration) || null,
        width: video ? Number(video.width) : null,
        height: video ? Number(video.height) : null,
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
    };
}

const fileBytes = (filePath) => {
    try {
        return statSync(filePath).size;
    } catch {
        return 0;
    }
};

/**
 * 后期主入口：校验 → 生成清单 → 执行 ffmpeg → 校验成片 → （可选）抽封面 → 写清单。
 * 返回真实产物地址与清单路径；任何一步失败都抛错，绝不返回「已拼接」的假成功。
 * 失败时中间产物、ffmpeg 日志和清单都会原地保留（都在同一个交付目录下）。
 */
export async function assembleEpisode({
    config,
    episodeId = null,
    clips,
    order,
    transition,
    options = {},
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
    now,
} = {}) {
    if (!config?.dataDir) throw new Error("缺少 config.dataDir");

    const plan = buildAssemblyPlan({
        episodeId,
        clips,
        order,
        transition,
        transitionDurationSec: options.transitionDurationSec,
        width: options.width ?? config.pipeline?.videoWidth,
        height: options.height ?? config.pipeline?.videoHeight,
        fps: options.fps ?? config.pipeline?.videoFps,
        quality: options.quality,
        audio: options.audio,
        subtitles: options.subtitles,
        cover: options.cover,
        now,
    });

    const id = sanitizeName(options.id || `delivery-${episodeId || "ep"}-${Date.now().toString(36)}`, "delivery");
    const dir = ensureDir(safeJoin(config.dataDir, "artifacts", id));
    const manifestPath = resolve(dir, "assembly-manifest.json");
    const logPath = resolve(dir, "ffmpeg.log");
    const filename = sanitizeName(options.filename || `${episodeId || "episode"}-final.mp4`, "final.mp4");
    const outputPath = resolve(dir, filename);

    const inputPaths = plan.clips.map((clip) => resolveMediaPath(config, clip.ref));
    const audioPaths = plan.audio.map((item) => resolveMediaPath(config, typeof item === "string" ? item : item.ref));
    const args = buildConcatArgs(plan, { inputPaths, audioPaths, outputPath });

    const [ffmpegVersion] = await run(ffmpegPath, ["-version"]).then(({ output }) => output.split("\n"));
    const manifest = {
        plan,
        inputs: inputPaths,
        audioInputs: audioPaths,
        commands: [`${ffmpegPath} ${args.join(" ")}`],
        ffmpegVersion,
        status: "running",
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    let info;
    let coverUrl = null;
    try {
        await run(ffmpegPath, args, { logPath });
        info = await probeMedia(outputPath, ffprobePath);
        if (!info?.hasVideo || fileBytes(outputPath) <= 0) throw new Error(`成片校验失败：${outputPath} 不是可解析的视频`);

        if (plan.cover) {
            const coverName = `${basename(filename, extname(filename))}-cover.jpg`;
            const coverPath = resolve(dir, coverName);
            await run(ffmpegPath, buildCoverArgs({ inputPath: outputPath, outputPath: coverPath, atSec: 0 }), { logPath: resolve(dir, "ffmpeg-cover.log") });
            manifest.commands.push(`${ffmpegPath} ${buildCoverArgs({ inputPath: outputPath, outputPath: coverPath, atSec: 0 }).join(" ")}`);
            if (fileBytes(coverPath) > 0) coverUrl = artifactUrl(config, id, coverName);
        }
    } catch (error) {
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, status: "failed", error: error.message }, null, 2), "utf8");
        throw error;
    }

    manifest.status = "done";
    manifest.output = { filename, path: outputPath, url: artifactUrl(config, id, filename), bytes: fileBytes(outputPath), ...info };
    manifest.coverUrl = coverUrl;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
        id,
        dir,
        status: "done",
        outputPath,
        url: manifest.output.url,
        bytes: manifest.output.bytes,
        info,
        coverUrl,
        manifestPath,
        manifestUrl: artifactUrl(config, id, basename(manifestPath)),
        logPath,
    };
}

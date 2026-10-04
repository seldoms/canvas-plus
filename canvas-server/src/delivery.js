import { spawn, spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { splitDialogue } from "./audio.js";
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
 * 成片字幕的默认样式（ffmpeg subtitles 滤镜 force_style 串）。
 * 只定字体与描边，让 libass 的其余默认（字号/居中/底部留白）生效：中文台词用系统中文字体，
 * 白字描黑边保证任意画面上可读。调用方可用 options.subtitleStyle 覆盖（原样透传）。
 */
export const DEFAULT_SUBTITLE_STYLE = "FontName=Noto Sans CJK SC,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0";

/** 两位补零（SRT 时间码格式化用）。 */
const pad2 = (value) => String(value).padStart(2, "0");

/**
 * 成片质量档 → ffmpeg 编码参数。ffmpeg 参数只在这里拼装，编排器只传档名（standard/draft/high）。
 * standard 与本模块此前的硬编码值一致，保证默认行为不变。
 */
export const QUALITY_PRESETS = {
    draft: { preset: "veryfast", crf: 30 },
    standard: { preset: "veryfast", crf: 20 },
    high: { preset: "slow", crf: 18 },
};

/** 数值归一：非有限值（含空串/null/NaN）返回 null，便于跨层（audio.js → delivery）对账。 */
const num = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
 * 计算每个片段在成片时间轴上的绝对起点（毫秒）。
 * cut 档无重叠；转场档每个片段起点前移 index×转场时长（与 buildConcatArgs 的 xfade offset 公式同源）。
 * 供「按镜头时间轴混音」（路径 B）把镜头内的 Cue 偏移映射到成片时间轴。
 */
export function clipStartOffsets(plan) {
    const clips = Array.isArray(plan?.clips) ? plan.clips : [];
    const overlap = plan?.transition === "cut" ? 0 : num(plan?.transitionDurationSec) || 0;
    const offsets = [];
    let acc = 0;
    clips.forEach((clip, index) => {
        offsets.push(Math.max(0, Math.round((acc - index * overlap) * 1000)));
        const durationSec = num(clip?.durationSec);
        acc += durationSec !== null && durationSec > 0 ? durationSec : 0;
    });
    return offsets;
}

/**
 * 归一外部音轨清单，产出「成片时间轴」上的绝对落点（毫秒）。
 *
 * 契约（喂给 buildConcatArgs / assembleEpisode）：
 *   - `ref` 为空的条目**直接跳过**（镜头没音频 / TTS 产物未就绪 → 不进混音，绝不让合成失败）；
 *   - 条目 `shotId` 能在片段清单里对上镜头时：`delayMs = 该镜头成片起点 + startSec×1000`
 *     （`startSec` 是镜头内相对偏移，与 audio.js cuesFromShots 语义一致）；转场重叠已自动扣除；
 *   - 对不上镜头时：用条目自带的绝对 `delayMs`；没有就用 `startSec×1000`；再没有就 0；
 *   - 保留 `gainDb` 供 buildConcatArgs 施加音量。
 */
function normalizeAudioItems(audio, offsetByShot) {
    const items = [];
    for (const raw of Array.isArray(audio) ? audio : []) {
        if (raw === null || raw === undefined) continue;
        const source = typeof raw === "string" ? { ref: raw } : raw;
        const ref = typeof source.ref === "string" ? source.ref.trim() : "";
        if (!ref) continue;
        const shotId = source.shotId === null || source.shotId === undefined ? null : String(source.shotId);
        const withinSec = num(source.startSec);
        const explicitMs = num(source.delayMs);
        const shotStart = shotId !== null && offsetByShot.has(shotId) ? offsetByShot.get(shotId) : null;
        let delayMs;
        if (shotStart !== null) {
            delayMs = shotStart + Math.max(0, Math.round((withinSec ?? 0) * 1000));
        } else if (explicitMs !== null) {
            delayMs = Math.max(0, Math.round(explicitMs));
        } else {
            delayMs = Math.max(0, Math.round((withinSec ?? 0) * 1000));
        }
        items.push({
            ref,
            cueId: source.cueId ?? null,
            shotId: source.shotId ?? null,
            type: source.type ?? null,
            startSec: withinSec,
            gainDb: num(source.gainDb),
            delayMs,
        });
    }
    return items;
}

/** 毫秒 → SRT 时间码（HH:MM:SS,mmm）。 */
export function formatSrtTime(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const sec = Math.floor((total % 60000) / 1000);
    const rest = total % 1000;
    return `${pad2(h)}:${pad2(m)}:${pad2(sec)},${String(rest).padStart(3, "0")}`;
}

/**
 * 纯函数：从「台词 Cue + 镜头时间轴」生成**逐句 SRT**（成片阶段烧入用）。
 *
 * 与 `audio.js` 的 Cue 契约同源：cue 带 `shotId + startSec`（镜头内相对偏移）与 `durationSec`；
 * 本函数用 `clipStartOffsets` 把镜头内偏移映射到成片绝对时间轴（与 `normalizeAudioItems` 同一口径，
 * 转场重叠自动扣除），再逐句落时间码。字幕文本取 `splitDialogue` 清洗后的**纯台词正文**
 * （剥掉括号表演注解；不做任何翻译），因此与 TTS 送读文本逐字一致。
 *
 * 降级契约（绝不失败）：
 *   - 没有片段、没有 Cue、或所有 Cue 文本为空 → 返回空串（调用方据此不烧字幕）；
 *   - cue 缺 `durationSec` 时用 1.5s 兜底；同起点相邻句重叠时前一句收在下一句起点，保证不叠字。
 *
 * @param {{ clips?: Array, order?: Array, transition?: string, transitionDurationSec?: number, cues?: Array }} input
 * @returns {string} SRT 文本；无可烧内容时为空串。
 */
export function buildCueSrt({ clips = [], order = null, transition = "cut", transitionDurationSec = 0, cues = [] } = {}) {
    const list = Array.isArray(clips) ? clips : [];
    if (!list.length) return "";
    const byId = new Map();
    for (const clip of list) if (clip?.id !== undefined && clip?.id !== null) byId.set(String(clip.id), clip);
    const ids = Array.isArray(order) && order.length ? order.map(String) : list.map((clip) => String(clip?.id));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!ordered.length) return "";

    const overlap = transition === "cut" ? 0 : num(transitionDurationSec) || 0;
    const offsets = clipStartOffsets({ clips: ordered, transition, transitionDurationSec: overlap });
    const offsetByShot = new Map();
    ordered.forEach((clip, index) => {
        if (clip.shotId === null || clip.shotId === undefined) return;
        const key = String(clip.shotId);
        if (!offsetByShot.has(key)) offsetByShot.set(key, offsets[index]);
    });

    const rows = [];
    for (const cue of Array.isArray(cues) ? cues : []) {
        const { text } = splitDialogue(typeof cue?.text === "string" ? cue.text : "");
        if (!text) continue;
        const key = cue?.shotId === null || cue?.shotId === undefined ? null : String(cue.shotId);
        const shotStart = key !== null && offsetByShot.has(key) ? offsetByShot.get(key) : 0;
        const startMs = shotStart + Math.max(0, Math.round((num(cue?.startSec) ?? 0) * 1000));
        const explicitDur = num(cue?.durationSec);
        const start = num(cue?.startSec);
        const end = num(cue?.endSec);
        const durMs = explicitDur !== null && explicitDur > 0
            ? Math.round(explicitDur * 1000)
            : start !== null && end !== null && end > start
                ? Math.round((end - start) * 1000)
                : 1500;
        rows.push({ startMs, endMs: startMs + Math.max(200, durMs), text });
    }
    if (!rows.length) return "";

    rows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (let i = 0; i < rows.length - 1; i += 1) {
        if (rows[i].endMs > rows[i + 1].startMs) {
            rows[i].endMs = Math.max(rows[i].startMs + 200, rows[i + 1].startMs);
        }
    }
    return rows
        .map((row, index) => `${index + 1}\n${formatSrtTime(row.startMs)} --> ${formatSrtTime(row.endMs)}\n${row.text}\n`)
        .join("\n");
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
    subtitleStyle = null,
    includeClipAudio = false,
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

    // 外部音轨（TTS 对白等）按镜头时间轴落点：把镜头内偏移映射到成片时间轴（路径 B）。
    const offsets = clipStartOffsets({ clips: ordered, transition, transitionDurationSec: duration });
    const offsetByShot = new Map();
    ordered.forEach((clip, index) => {
        if (clip.shotId === null || clip.shotId === undefined) return;
        const key = String(clip.shotId);
        if (!offsetByShot.has(key)) offsetByShot.set(key, offsets[index]);
    });

    // ── 硬规则：一个镜头只能有一个「人声事实源」（会诊结论）──────────────────────────────
    // 片段原声（H3 native 自合成台词）与独立对白音轨（TTS）若同时进混音，`amix normalize=0` 是
    // **原始求和** → 两把人声叠一起（音效也翻倍）。
    // 优先级：**独立对白轨 > 片段内嵌对白**（`development-plan.md` 已定「成片以独立对白轨为事实源」）。
    // 这里做防御性收敛（记 warning 而不抛错，避免打挂既有调用方），不再依赖两个调用方各自自觉。
    const normalizedAudio = normalizeAudioItems(audio, offsetByShot);
    let clipAudio = includeClipAudio === true;
    const warnings = [];
    if (clipAudio && normalizedAudio.length > 0) {
        clipAudio = false;
        warnings.push({
            code: "clip_audio_overridden",
            message: `已提供 ${normalizedAudio.length} 条独立对白音轨，片段原声不再混入（避免双重人声）`,
        });
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
        audio: normalizedAudio,
        subtitles: subtitles || null,
        subtitleStyle: subtitleStyle || null,
        includeClipAudio: clipAudio,
        warnings,
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
    const wantClipAudio = plan.includeClipAudio === true;

    // 片段自带音轨（H3 是音画联合模型）：先统一采样率/声道再随视频一起 concat/xfade，成片不丢原声。
    const clipAudio = (index) => {
        parts.push(`[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[ca${index}]`);
        return `ca${index}`;
    };

    if (plan.transition === "cut" || n === 1) {
        if (wantClipAudio) {
            const pairs = inputPaths.map((_, index) => `[v${index}][${clipAudio(index)}]`).join("");
            parts.push(`${pairs}concat=n=${n}:v=1:a=1[vcat][acat]`);
        } else {
            const inputs = inputPaths.map((_, index) => `[v${index}]`).join("");
            parts.push(`${inputs}concat=n=${n}:v=1:a=0[vcat]`);
        }
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
        // 音轨用 acrossfade 与 xfade 同步（同样的重叠时长），避免声画错位。
        if (wantClipAudio) {
            let currentAudio = clipAudio(0);
            for (let index = 1; index < n; index++) {
                const out = index === n - 1 ? "acat" : `af${index}`;
                parts.push(`[${currentAudio}][${clipAudio(index)}]acrossfade=d=${D}:c1=tri:c2=tri[${out}]`);
                currentAudio = out;
            }
        }
    }

    let videoLabel = "vcat";
    if (plan.subtitles) {
        const style = plan.subtitleStyle ? `:force_style='${String(plan.subtitleStyle).replace(/'/g, "\\'")}'` : "";
        parts.push(`[vcat]subtitles=filename='${escapeFilterPath(plan.subtitles)}'${style}[vsub]`);
        videoLabel = "vsub";
    }

    const args = ["-y"];
    for (const path of inputPaths) args.push("-i", path);
    for (const path of audioPaths) args.push("-i", path);

    const maps = [`-map`, `[${videoLabel}]`];
    const audioLabels = [];
    if (wantClipAudio) audioLabels.push("[acat]");
    if (audioPaths.length) {
        const base = inputPaths.length;
        audioPaths.forEach((_, index) => {
            const item = Array.isArray(plan.audio) ? plan.audio[index] : null;
            const label = `a${index}`;
            const chain = [];
            const delayMs = num(item?.delayMs);
            if (delayMs !== null && delayMs > 0) chain.push(`adelay=${Math.round(delayMs)}|${Math.round(delayMs)}`);
            chain.push("aresample=44100");
            const gainDb = num(item?.gainDb);
            if (gainDb !== null && gainDb !== 0) chain.push(`volume=${gainDb}dB`);
            parts.push(`[${base + index}:a]${chain.join(",")}[${label}]`);
            audioLabels.push(`[${label}]`);
        });
    }
    if (audioLabels.length === 1) {
        // apad：把音轨补静音到与视频等长，否则 -shortest 会把「音频比视频短」的成片截短。
        parts.push(`${audioLabels[0]}apad[aout]`);
        maps.push("-map", "[aout]", "-shortest");
    } else if (audioLabels.length > 1) {
        parts.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixed]`);
        parts.push("[amixed]apad[aout]");
        maps.push("-map", "[aout]", "-shortest");
    }

    args.push("-filter_complex", parts.join(";"));
    args.push(...maps, "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (audioLabels.length) args.push("-c:a", "aac", "-b:a", "192k");
    args.push(outputPath);
    return args;
}

/** 纯函数：从成片里抽一帧当封面。 */
export function buildCoverArgs({ inputPath, outputPath, atSec = 0 } = {}) {
    if (!inputPath || !outputPath) throw new Error("抽帧需要输入与输出路径");
    return ["-y", "-ss", String(atSec), "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath];
}

/**
 * 决定成片是否保留**片段原声**（纯函数，便于测试）。
 *
 * H3 是**音画联合**模型 —— 台词/音效/配乐随片段**一次出**（每段自带 aac）。成片若不带上这些音轨，
 * 产物就是**哑的**（实测事故：片段 `0,h264 + 1,aac`，成片只剩 `0,h264`）。对齐 `edit-export.js` 的
 * `allHaveAudio` 判定。
 *
 * 规则：① 调用方显式指定则以调用方为准；② 传了独立音轨（TTS 配音）时**不保留**片段原声
 * （否则双重人声）；③ 否则所有片段都带音轨就保留。
 * ⚠️ ②③ 是最保守取舍 —— 「H3 全包」与「独立 TTS」两条路线如何共存见会诊结论。
 *
 * @param {{ explicit?: unknown, audioCount?: number, probes?: Array<{hasAudio?: boolean}|null> }} input
 */
export function shouldIncludeClipAudio({ explicit, audioCount = 0, probes = [] } = {}) {
    // 硬规则优先：只要提供了独立对白音轨，片段原声一律不保留（会诊结论：一个镜头一个人声事实源，
    // 两者同时进 `amix normalize=0` 会双重人声）。**这一条不能被显式参数绕过**。
    if (audioCount > 0) return false;
    if (typeof explicit === "boolean") return explicit;
    return probes.length > 0 && probes.every((media) => media?.hasAudio === true);
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
        sampleRate: audio ? Number(audio.sample_rate) || null : null,
        channels: audio ? Number(audio.channels) || null : null,
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
        subtitleStyle: options.subtitleStyle,
        includeClipAudio: options.includeClipAudio,
        cover: options.cover,
        now,
    });

    const id = sanitizeName(options.id || `delivery-${episodeId || "ep"}-${Date.now().toString(36)}`, "delivery");
    const dir = ensureDir(safeJoin(config.dataDir, "artifacts", id));
    const manifestPath = resolve(dir, "assembly-manifest.json");
    const logPath = resolve(dir, "ffmpeg.log");
    const filename = sanitizeName(options.filename || `${episodeId || "episode"}-final.mp4`, "final.mp4");
    const outputPath = resolve(dir, filename);

    // 字幕：调用方给「纯文本 SRT」（如按台词时间轴逐句生成）时落盘成 .srt 并交 ffmpeg 烧入。
    // 无文本 / 已有显式 subtitles 路径时不动 —— 无字幕也照样出片，绝不因此失败。
    if (!plan.subtitles && typeof options.subtitlesText === "string" && options.subtitlesText.trim()) {
        const srtName = sanitizeName(options.subtitlesFilename || `${episodeId || "episode"}.srt`, "subtitles.srt");
        const srtPath = resolve(dir, srtName);
        writeFileSync(srtPath, options.subtitlesText.endsWith("\n") ? options.subtitlesText : `${options.subtitlesText}\n`, "utf8");
        plan.subtitles = srtPath;
    }

    const inputPaths = plan.clips.map((clip) => resolveMediaPath(config, clip.ref));
    const audioPaths = plan.audio.map((item) => resolveMediaPath(config, typeof item === "string" ? item : item.ref));

    // ── 片段原声：不显式指定时**自动判定**（规则见 shouldIncludeClipAudio）──────────────────
    // H3 是**音画联合**模型 —— 台词/音效/配乐随片段**一次出**（每段自带 aac）。成片拼接若不带上
    // 这些音轨，产物就是**哑的**（实测事故：片段 `0,h264 + 1,aac`，成片只剩 `0,h264`）。
    {
        const probes = typeof options.includeClipAudio === "boolean" || audioPaths.length || !inputPaths.length
            ? []
            : await Promise.all(inputPaths.map((file) => probeMedia(file, ffprobePath).catch(() => null)));
        // probes 为空时 shouldIncludeClipAudio 会退回调用方的显式值，不会误开
        plan.includeClipAudio = shouldIncludeClipAudio({
            explicit: options.includeClipAudio,
            audioCount: audioPaths.length,
            probes,
        });
    }

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
        subtitles: plan.subtitles || null,
        url: manifest.output.url,
        bytes: manifest.output.bytes,
        info,
        coverUrl,
        manifestPath,
        manifestUrl: artifactUrl(config, id, basename(manifestPath)),
        logPath,
    };
}

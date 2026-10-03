/**
 * 自动粗剪 + 导出「剪映/达芬奇素材包」。
 *
 * 定位（见 docs/content/docs/progress/libtv-product-analysis.md §11）：
 * 网页短剧工具做到「粗剪 + 自动装配 + 导出交换格式」就到位，精剪（卡点/调色/多轨）交剪映或达芬奇。
 * 本模块正是补齐「把东西做到能被剪映接手」那一段：把一集的片段按分镜顺序拼成成片，
 * 并导出一个 zip（分集成片 + 分片原片按序命名 + SRT 字幕 + FCPXML/EDL 时间线 + 清单 JSON + 导入说明）。
 *
 * 职责边界：
 *   - 复用 delivery.js 的 concat/xfade + 字幕烧录 + 音轨混流能力（不重写 ffmpeg 拼接）；
 *   - 只做「分镜顺序 → 成片 + 交换文件」的规划与打包，不接路由、不入队列；
 *   - 缺片段的镜头**显式报出**（缺第几段、缺多长），默认拒绝静默产出半条片（allowPartial 需显式打开）；
 *   - 纯函数尽量与磁盘/ffmpeg 解耦，便于单测；真实落盘与执行走 exportDeliveryPackage。
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { splitDialogue } from "./audio.js";
import { DEFAULT_TRANSITION_SEC, assembleEpisode, probeMedia } from "./delivery.js";
import { artifactUrl, ensureDir, safeJoin, sanitizeName } from "./files.js";
import { RUN_SHOT_ID_FIELD, matchProjectShotsToRunShots } from "./production-contracts.js";

/** 缺片段时抛出的错误：带 .missing 明细，调用方可据此原样把「缺哪几段、缺多长」报给用户。 */
export class MissingClipsError extends Error {
    constructor(missing, message) {
        super(message || formatMissingClips(missing));
        this.name = "MissingClipsError";
        this.code = "MISSING_CLIPS";
        this.missing = missing;
    }
}

/** 人读的缺段提示：第 N 段(shotId)[（集 episodeId）] 缺 Xs。 */
export function formatMissingClips(missing = []) {
    const items = missing.map((item) => {
        const episode = item?.episodeId ? `（集 ${item.episodeId}）` : "";
        return `第${item.shotIndex}段(${item.shotId}) 缺 ${item.durationSec ?? "?"}s${episode}`;
    });
    return `成片缺 ${missing.length} 段，不能静默出半条片：${items.join("、")}`;
}

const num = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
const pad2 = (value) => String(value).padStart(2, "0");
const round3 = (value) => Math.round(value * 1000) / 1000;

/** 从 shotId（如 "sh12"）里取镜号；取不到则回退到传入的次序。 */
export function shotNumber(shotId, fallbackIndex = 1) {
    const match = String(shotId ?? "").match(/(\d+)\s*$/);
    if (match) return Number(match[1]);
    return Number(fallbackIndex) || 1;
}

// ---------------------------------------------------------------------------
// A. 分镜顺序 → 粗剪编排
// ---------------------------------------------------------------------------

/** 列出要导出的集：显式传入优先，否则取剧本产物 episodes，再退化为「全集」一集。 */
export function listEpisodes({ episodes, shots = [] } = {}) {
    if (Array.isArray(episodes) && episodes.length) {
        return episodes.map((episode, index) => ({
            id: episode.id || `ep${index + 1}`,
            index: Number(episode.index) || index + 1,
            title: episode.title || episode.id || `第${index + 1}集`,
            sceneIds: Array.isArray(episode.sceneIds) ? episode.sceneIds : null,
            durationSec: num(episode.durationSec),
        }));
    }
    return [
        {
            id: "ep1",
            index: 1,
            title: "全集",
            sceneIds: null,
            durationSec: null,
        },
    ];
}

/**
 * 取某集的分镜：**优先按映射归属**（episode.runShotIds 是 Project 侧经映射指回的运行侧 shot id），
 * 其次按 episode.sceneIds 过滤（无 sceneIds 则全集），最后按镜号/次序排序。
 * 这样不再假定 Project 侧与 Run 侧 shotId 相同（#51）。
 */
export function shotsForEpisode(episode, shots = []) {
    const list = Array.isArray(shots) ? shots.slice() : [];
    const runShotIds = Array.isArray(episode?.runShotIds) ? episode.runShotIds.map(String) : null;
    let filtered;
    if (runShotIds && runShotIds.length) {
        const set = new Set(runShotIds);
        filtered = list.filter((shot) => set.has(String(shot?.id ?? "")));
    } else {
        const sceneIds = episode?.sceneIds;
        filtered = Array.isArray(sceneIds) && sceneIds.length ? list.filter((shot) => sceneIds.includes(shot?.sceneId)) : list;
    }
    return filtered.sort((a, b) => {
        const ai = Number(a?.index) || 0;
        const bi = Number(b?.index) || 0;
        return ai - bi;
    });
}

/**
 * 纯函数：把「Project 侧集」与「Run 侧 shots」建立归属（#51 的核心：两侧 shotId 是两套）。
 *
 * Project 侧 shot.id 是 hash 派生的稳定主键（`sh_…`），Run 侧 shot.id 是 `sh1` 一类；
 * 这里用 `shot.runShotId`（已落地的桥字段）或就地配对（matchProjectShotsToRunShots 按
 * index→同集顺序对位）把每个 Project 集映射成一组运行侧 shot id（`runShotIds`）。
 *
 * 返回：
 *   - `episodes[]`：`{ id, index, title, sceneIds, runShotIds[], projectShotIds{runShotId:projectShotId}, missingProjectShots[] }`；
 *   - `unmatchedRun[]` / `unmatchedProject[]` / `warnings[]`：不匹配处**显式报告**，绝不静默丢弃；
 *   - `pairs[]`：全部配对明细（含 via: stored|index|order）。
 */
export function resolveEpisodeShotAttribution({ project = null, runShots = [] } = {}) {
    const warnings = [];
    const episodes = Array.isArray(project?.episodes) ? project.episodes : [];
    if (!episodes.length) return { episodes: [], pairs: [], unmatchedProject: [], unmatchedRun: [], warnings };

    const projectShots = [];
    for (const episode of episodes) {
        for (const shot of Array.isArray(episode?.shots) ? episode.shots : []) {
            if (!shot || typeof shot !== "object") continue;
            projectShots.push({ ...shot, episodeId: shot.episodeId ?? episode?.id });
        }
    }
    const match = matchProjectShotsToRunShots({ projectShots, runShots });
    warnings.push(...match.warnings);

    const list = episodes.map((episode) => {
        const id = String(episode?.id ?? "");
        const runShotIds = [];
        const projectShotIds = {};
        const missingProjectShots = [];
        for (const shot of Array.isArray(episode?.shots) ? episode.shots : []) {
            const projectShotId = String(shot?.id ?? "").trim();
            if (!projectShotId) continue;
            const runShotId = match.byProjectShotId[projectShotId];
            if (runShotId) {
                runShotIds.push(runShotId);
                projectShotIds[runShotId] = projectShotId;
            } else {
                missingProjectShots.push(projectShotId);
                warnings.push({ field: RUN_SHOT_ID_FIELD, code: "unmapped", projectShotId, episodeId: id, message: `Project shot ${projectShotId} 未映射到运行侧 shot（导出按映射归属时会跳过）` });
            }
        }
        return {
            id,
            index: Number(episode?.index) > 0 ? Number(episode.index) : null,
            title: episode?.title || id,
            sceneIds: Array.isArray(episode?.sceneIds) ? episode.sceneIds : null,
            runShotIds,
            projectShotIds,
            missingProjectShots,
        };
    });

    return { episodes: list, pairs: match.pairs, unmatchedProject: match.unmatchedProject, unmatchedRun: match.unmatchedRun, warnings };
}

/** 只读加载 run 绑定的 Project（未绑 / 文件缺失 / 损坏 → null，永不抛）。 */
export function loadProjectForRun(config, run) {
    const projectId = run?.options?.projectId;
    if (!config?.dataDir || !projectId) return null;
    const file = safeJoin(config.dataDir, "projects", String(projectId), "project.json");
    if (!file || !existsSync(file)) return null;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** 从某镜的候选片段里挑一条「已产出」的（status=done 且有产物），优先 selected。 */
export function pickUsableClip(clipsForShot = []) {
    const usable = clipsForShot.filter((clip) => {
        const status = clip?.status;
        const produced = Boolean(clip?.artifactUrl || clip?.path);
        const done = status === undefined || status === null || status === "done" || status === "succeeded";
        return produced && done;
    });
    if (!usable.length) return null;
    return usable[0];
}

/** 片段里挑参考图/提示词等追溯信息（候选 params 里带 INPUT_IMAGE / PROMPT）。 */
function clipTrace(clip) {
    const candidate = Array.isArray(clip?.candidates) ? clip.candidates.find((item) => item?.params) : null;
    const params = candidate?.params || {};
    return {
        jobId: clip?.jobId || candidate?.jobId || null,
        template: clip?.template || candidate?.template || null,
        referenceImage: params.INPUT_IMAGE || clip?.referenceImage || null,
        promptFromClip: params.PROMPT || null,
    };
}

/**
 * 纯函数：把一集的分镜与片段规划成「按分镜顺序的粗剪清单」。
 * - 有可用片段的镜头 → segment；没有的 → missing（含缺第几段、缺多长）。
 * - 默认（allowPartial=false）只要缺段就抛 MissingClipsError，绝不静默出半条片。
 * - allowPartial=true 时仍返回 missing 明细，由调用方在清单/说明里显式标注 partial。
 */
export function planRoughCut({ episodeId = null, shots = [], clips = [], allowPartial = false, transition = "cut" } = {}) {
    const orderedShots = Array.isArray(shots) ? shots.slice() : [];
    const byShot = new Map();
    for (const clip of Array.isArray(clips) ? clips : []) {
        const shotId = clip?.shotId ?? clip?.shot_id;
        if (!shotId) continue;
        if (!byShot.has(shotId)) byShot.set(shotId, []);
        byShot.get(shotId).push(clip);
    }

    const segments = [];
    const missing = [];
    orderedShots.forEach((shot, position) => {
        const shotId = shot?.id ?? shot?.shotId;
        if (!shotId) return;
        const shotIndex = shotNumber(shotId, Number(shot?.index) || position + 1);
        const expectedSec = num(shot?.durationSec);
        const candidates = byShot.get(shotId) || [];
        const clip = pickUsableClip(candidates);
        if (!clip) {
            const hasRecord = candidates.length > 0;
            missing.push({
                shotId,
                shotIndex,
                durationSec: expectedSec,
                reason: hasRecord ? `有片段记录但未产出（status=${candidates[0]?.status}）` : "没有片段记录",
            });
            return;
        }
        const trace = clipTrace(clip);
        segments.push({
            index: segments.length,
            shotId,
            // #51：同时记下两侧 id——shotId 是运行侧（配对 clips 用），projectShotId 是 Project 侧稳定主键（追溯用）。
            runShotId: shot?.runShotId ?? shotId,
            projectShotId: shot?.projectShotId ?? null,
            shotIndex,
            clipId: clip.id || null,
            jobId: trace.jobId,
            template: trace.template,
            ref: clip.artifactUrl || clip.path,
            durationSec: num(clip.durationSec) ?? expectedSec,
            expectedDurationSec: expectedSec,
            dialogue: typeof shot?.dialogue === "string" ? shot.dialogue : "",
            narration: typeof shot?.narration === "string" ? shot.narration : "",
            textOverlays: Array.isArray(shot?.textOverlays) ? shot.textOverlays : [],
            prompt: shot?.prompt || trace.promptFromClip || null,
            negativePrompt: shot?.negativePrompt || null,
            referenceImage: trace.referenceImage,
            shotSize: shot?.shotSize || null,
            transition,
        });
    });

    if (missing.length && !allowPartial) throw new MissingClipsError(missing);

    const presentSec = segments.reduce((sum, seg) => sum + (num(seg.durationSec) || 0), 0);
    const missingSec = missing.reduce((sum, item) => sum + (num(item.durationSec) || 0), 0);
    return {
        episodeId,
        allowPartial: allowPartial === true,
        partial: missing.length > 0,
        segments,
        missing,
        presentCount: segments.length,
        expectedCount: orderedShots.length,
        presentDurationSec: round3(presentSec),
        missingDurationSec: round3(missingSec),
    };
}

/**
 * 纯函数：按真实（或元数据）时长排布时间线，给出每段的起止时间。
 * cut 顺序排列；xfade/其它转场按重叠 transitionDurationSec 递推（与 ffmpeg 的 offset 口径一致）。
 */
export function buildTimeline({ segments = [], durations = [], transition = "cut", transitionDurationSec = DEFAULT_TRANSITION_SEC } = {}) {
    const D = transition === "cut" ? 0 : Number(transitionDurationSec) || 0;
    let end = 0;
    return segments.map((seg, index) => {
        const durationSec = num(durations[index]) ?? num(seg.durationSec) ?? 0;
        const startSec = index === 0 ? 0 : round3(end - D);
        end = round3(startSec + durationSec);
        return { ...seg, index, startSec, endSec: end, durationSec: round3(durationSec) };
    });
}

// ---------------------------------------------------------------------------
// 字幕 / 画面文字 / 时间码
// ---------------------------------------------------------------------------

export function srtTime(sec) {
    const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rest = ms % 1000;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(rest).padStart(3, "0")}`;
}

export function timecode(sec, fps = 24) {
    const totalFrames = Math.max(0, Math.round((Number(sec) || 0) * fps));
    const rate = Math.max(1, Math.round(fps));
    const ff = totalFrames % rate;
    const totalSec = Math.floor(totalFrames / rate);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(ff)}`;
}

/** 台词按句号/问号/叹号/分号切开，便于字幕分行（保留标点）。 */
export function splitSentences(text) {
    return String(text ?? "")
        .split(/(?<=[。！？!?；;])/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * 纯函数：从时间线生成 SRT。
 * 只放「对白/旁白」正文（表演注解已被 splitDialogue 剥掉），画面文字不混进字幕。
 */
export function buildSrt({ timeline = [] } = {}) {
    const cues = [];
    for (const entry of timeline) {
        const span = Math.max(0, entry.endSec - entry.startSec);
        const cleaned = splitDialogue(entry.dialogue || "");
        const narration = splitDialogue(entry.narration || "");
        const lines = [...splitSentences(cleaned.text), ...splitSentences(narration.text)];
        if (!lines.length) continue;
        const step = span / lines.length;
        lines.forEach((text, i) => {
            cues.push({
                startSec: round3(entry.startSec + i * step),
                endSec: round3(entry.startSec + (i + 1) * step),
                text,
            });
        });
    }
    return cues
        .map((cue, index) => `${index + 1}\n${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}\n${cue.text}\n`)
        .join("\n");
}

/** 纯函数：把画面文字（textOverlays）作为注释行另存，格式 [起-止] ep01_sh01 (sh1) 画面文字: ... */
export function buildOverlayNotes({ timeline = [], episodeLabel = "" } = {}) {
    const lines = [];
    for (const entry of timeline) {
        const overlays = (entry.textOverlays || []).filter((item) => item && String(item.text || "").trim() && item.kind !== "none");
        for (const overlay of overlays) {
            const where = overlay.position ? `（${overlay.position}${overlay.style ? "；" + overlay.style : ""}）` : "";
            const label = entry.fileStem || [episodeLabel, entry.shotId].filter(Boolean).join("_");
            lines.push(`[${srtTime(entry.startSec)} - ${srtTime(entry.endSec)}] ${label} (${entry.shotId}) 画面文字: "${overlay.text}"${where}`);
        }
    }
    return lines.length ? `# 画面文字/字幕型元素（不进入 .srt，仅供后期参考）\n${lines.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// FCPXML / EDL 时间线交换文件
// ---------------------------------------------------------------------------

const xmlEscape = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/** 秒 → FCPXML 有理数时间（以帧为分子，保证精确）。 */
export function fcpxmlTime(sec, fps = 24) {
    const rate = Math.max(1, Math.round(fps));
    const frames = Math.max(0, Math.round((Number(sec) || 0) * rate));
    return `${frames}/${rate}s`;
}

/**
 * 纯函数：生成 FCPXML（1.9，达芬奇/剪映专业版可导入的时间线交换文件）。
 * 每段按真实时长排片、带片段名与起始偏移；asset 的 src 用包内相对路径，解压后可整体重链接。
 */
export function buildFcpxml({
    projectName = "rough-cut",
    eventName = "canvas-plus 自动粗剪",
    width = 768,
    height = 1376,
    fps = 24,
    timeline = [],
} = {}) {
    const formatName = `FFVideoFormat_${width}x${height}_${Math.round(fps)}p`;
    const assets = [];
    const clips = [];
    let index = 0;
    for (const entry of timeline) {
        index += 1;
        const assetId = `a${index}`;
        const duration = fcpxmlTime(entry.durationSec, fps);
        const hasAudio = entry.hasAudio === false ? "0" : "1";
        const audioAttrs = entry.hasAudio === false
            ? ""
            : ` audioSources="1" audioChannels="${entry.channels || 2}"${entry.sampleRate ? ` audioRate="${entry.sampleRate}"` : ""}`;
        assets.push(
            `    <asset id="${assetId}" name="${xmlEscape(entry.fileStem)}" start="0s" duration="${duration}" hasVideo="1" hasAudio="${hasAudio}"${audioAttrs} format="r1">\n` +
                `      <media-rep kind="original-media" src="${xmlEscape(entry.file)}"/>\n` +
                `    </asset>`,
        );
        clips.push(
            `            <asset-clip ref="${assetId}" name="${xmlEscape(entry.fileStem)}" offset="${fcpxmlTime(entry.startSec, fps)}" duration="${duration}" start="0s"${entry.hasAudio === false ? "" : ' audioRole="dialogue"'}/>`,
        );
    }
    const totalSec = timeline.length ? timeline[timeline.length - 1].endSec : 0;
    const stream = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE fcpxml>",
        '<fcpxml version="1.9">',
        "  <resources>",
        `    <format id="r1" name="${xmlEscape(formatName)}" frameDuration="1/${Math.round(fps)}s" width="${Math.round(width)}" height="${Math.round(height)}" colorSpace="1-1-1 (Rec. 709)"/>`,
        ...assets,
        "  </resources>",
        "  <library>",
        `    <event name="${xmlEscape(eventName)}">`,
        `      <project name="${xmlEscape(projectName)}">`,
        `        <sequence format="r1" duration="${fcpxmlTime(totalSec, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="${timeline.find((e) => e.sampleRate)?.sampleRate || 44100}">`,
        "          <spine>",
        ...clips,
        "          </spine>",
        "        </sequence>",
        "      </project>",
        "    </event>",
        "  </library>",
        "</fcpxml>",
        "",
    ];
    return stream.join("\n");
}

/**
 * 纯函数：生成 CMX3600 EDL（兜底交换格式，剪映/达芬奇均可导入）。
 * 每段带源/录时间码与 `* FROM CLIP NAME:` 注释，便于重链接到包内 clips/ 原片。
 */
export function buildEdl({ title = "rough-cut", fps = 24, timeline = [] } = {}) {
    const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
    timeline.forEach((entry, index) => {
        const number = String(index + 1).padStart(3, "0");
        const srcIn = timecode(0, fps);
        const srcOut = timecode(entry.durationSec, fps);
        const recIn = timecode(entry.startSec, fps);
        const recOut = timecode(entry.endSec, fps);
        lines.push(`${number}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
        lines.push(`* FROM CLIP NAME: ${entry.fileStem}.mp4`);
        lines.push("");
    });
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 原生 zip 打包（store 模式，零依赖）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
    const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { time, date: day };
}

/**
 * 写一个 store 模式（不压缩）的 zip。entries: [{ name, data?:Buffer, path?:string }]。
 * mp4/jpg 本身已压缩，store 既省 CPU 又不引入外部依赖；中文文件名按 UTF-8 标记。
 */
export function writeZip({ outputPath, entries = [], now = new Date() } = {}) {
    if (!outputPath) throw new Error("writeZip 缺少输出路径");
    if (!entries.length) throw new Error("writeZip 没有任何条目");
    const { time, date } = dosDateTime(now);
    const local = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = String(entry.name || "").replace(/\\/g, "/");
        if (!name) throw new Error("zip 条目缺少 name");
        const data = entry.data ? Buffer.from(entry.data) : readFileSync(entry.path);
        const nameBuf = Buffer.from(name, "utf8");
        const crc = crc32(data);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4); // version needed
        localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
        localHeader.writeUInt16LE(0, 8); // method: store
        localHeader.writeUInt16LE(time, 10);
        localHeader.writeUInt16LE(date, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);
        local.push(localHeader, nameBuf, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4); // version made by
        centralHeader.writeUInt16LE(20, 6); // version needed
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(time, 12);
        centralHeader.writeUInt16LE(date, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(0, 30); // extra len
        centralHeader.writeUInt16LE(0, 32); // comment len
        centralHeader.writeUInt16LE(0, 34); // disk
        centralHeader.writeUInt16LE(0, 36); // internal attrs
        centralHeader.writeUInt32LE(0, 38); // external attrs
        centralHeader.writeUInt32LE(offset, 42); // local header offset
        central.push(centralHeader, nameBuf);

        offset += localHeader.length + nameBuf.length + data.length;
    }

    const localBuf = Buffer.concat(local);
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    eocd.writeUInt16LE(0, 20);

    const zipBuffer = Buffer.concat([localBuf, centralBuf, eocd]);
    writeFileSync(outputPath, zipBuffer);
    return { path: outputPath, bytes: zipBuffer.length, count: entries.length };
}

/** 读 zip 的中央目录，返回条目名列表（用于自检/测试，不依赖外部 unzip）。 */
export function listZipEntries(zipPath) {
    const buffer = readFileSync(zipPath);
    // 找 EOCD（可能带注释，从尾部往前扫）
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("不是有效的 zip：找不到 EOCD");
    const total = buffer.readUInt16LE(eocd + 10);
    let pointer = buffer.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < total; i += 1) {
        if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("zip 中央目录损坏");
        const nameLen = buffer.readUInt16LE(pointer + 28);
        const extraLen = buffer.readUInt16LE(pointer + 30);
        const commentLen = buffer.readUInt16LE(pointer + 32);
        const compSize = buffer.readUInt32LE(pointer + 20);
        const rawSize = buffer.readUInt32LE(pointer + 24);
        const name = buffer.slice(pointer + 46, pointer + 46 + nameLen).toString("utf8");
        entries.push({ name, size: rawSize, compressedSize: compSize });
        pointer += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// ---------------------------------------------------------------------------
// 清单 / 导入说明
// ---------------------------------------------------------------------------

export function buildPackageReadme({ runId = null, packageRoot = "", episodes = [], allowPartial = false, createdAt = "" } = {}) {
    const lines = [
        "canvas-plus 自动粗剪素材包 / Edit-ready package",
        "================================================",
        "",
        `来源 run：${runId || "-"}`,
        `生成时间：${createdAt}`,
        `导出模式：${allowPartial ? "允许缺段（partial，见 manifest.missing）" : "严格（缺段即拒绝出片）"}`,
        "",
        "一、包内容",
        "  1. 分集成片 mp4：粗剪结果（已按分镜顺序拼接、烧入字幕、保留原声）。",
        "  2. clips/ ：分片原片，按顺序命名（如 ep01_sh01.mp4）。",
        "  3. 每集 SRT 字幕（.srt）与画面文字注释（_overlays.txt，画面文字不混进字幕）。",
        "  4. 每集时间线交换文件：.fcpxml（首选）与 .edl（兜底）。",
        "  5. manifest.json：顺序、每段时长、jobId/shotId、提示词、参考图、转场、缺段明细。",
        "",
        "二、导入剪映专业版",
        "  - 直接成片：把 <集名>_final.mp4 拖进时间线即可精剪。",
        "  - 想要分层精剪：新建草稿 → 导入 clips/ 下的原片（已按顺序命名），再导入同名 .srt 字幕。",
        "  - 若剪映能识别交换文件：导入 .edl 或 .fcpxml 得到一个排好序的时间线。",
        "",
        "三、导入达芬奇 DaVinci Resolve",
        "  1. 打开工程 → File > Import > Timeline > 选择 <集名>.fcpxml（失败则退回 .edl）。",
        "  2. 若提示媒体脱机：媒体池右键 Relink，指向解压目录下的 clips/ 即可。",
        "  3. 时间线按分镜顺序排好，每段时长与起始时间码见 manifest.json。",
        "",
        "四、注意",
        "  - 转场按 manifest.transition 生成；cut 为硬切，fade/dissolve/slide 会用对应转场。",
        "  - 若本包为 partial：manifest.json 的 missing 字段列出了缺失镜头与缺口时长。",
    ];
    return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// C. 编排：可单步重跑（plan → assemble → package）
// ---------------------------------------------------------------------------

/** 递归列出目录下所有文件，返回相对 root 的 posix 风格路径。 */
export function walkFiles(root, base = root) {
    const files = [];
    if (!existsSync(root)) return files;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) files.push(...walkFiles(full, base));
        else if (entry.isFile()) files.push({ name: relative(base, full).split(/[\\/]/).join("/"), path: full, bytes: fileBytes(full) });
    }
    return files;
}

const fileBytes = (filePath) => {
    try {
        return statSync(filePath).size;
    } catch {
        return 0;
    }
};

/**
 * 自动粗剪 + 导出素材包主入口。
 * 复用 delivery.assembleEpisode 做真实拼接（concat/xfade + 字幕烧录 + 原声），本函数负责：
 * 规划分镜顺序 → 缺段校验 → SRT/FCPXML/EDL/清单 → 打包 zip。
 * steps 支持 ["plan","assemble","package"] 的子集，便于后期失败后单步重跑（前序结果从磁盘读回）。
 */
export async function exportDeliveryPackage({
    config,
    run = {},
    episodes: episodesInput = null,
    episodeId = null,
    shots: shotsInput = null,
    clips: clipsInput = null,
    allowPartial = false,
    transition = null,
    transitionDurationSec = DEFAULT_TRANSITION_SEC,
    options = {},
    steps = ["plan", "assemble", "package"],
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
    now = null,
} = {}) {
    if (!config?.dataDir) throw new Error("缺少 config.dataDir");
    const createdAt = now || new Date().toISOString();
    const runId = run?.id || options.runId || null;
    const pkgId = sanitizeName(options.id || `edit-export-${runId || "run"}`, "edit-export");
    const workDir = ensureDir(safeJoin(config.dataDir, "artifacts", pkgId));
    const pkgDir = ensureDir(safeJoin(workDir, "package"));
    const zipRoot = sanitizeName(options.zipRoot || pkgId, "package");
    const zipPath = safeJoin(workDir, `${pkgId}.zip`);
    const planPath = safeJoin(workDir, "plan.json");
    const logPath = safeJoin(workDir, "export.log");
    const manifestPath = safeJoin(workDir, "export-manifest.json");

    const logLines = [];
    const writeLog = (message) => {
        logLines.push(`[${new Date().toISOString()}] ${message}`);
        writeFileSync(logPath, logLines.join("\n") + "\n", "utf8");
    };

    const scriptOutput = run?.stages?.script?.output || {};
    const assemblyStage = run?.stages?.assembly?.output || {};
    const allShots = shotsInput || run?.stages?.storyboard?.output?.shots || [];
    const allClips = clipsInput || assemblyStage.clips || [];
    const resolvedTransition = transition || assemblyStage.assembly?.transition || run?.options?.transition || "cut";

    // #51：Project 侧与 Run 侧 shotId 是两套。若 run 绑定了项目，改用「项目侧集 + 映射归属」来分集与配对，
    // 而不是假定两侧 shotId 相同（project sh_… vs run sh1）或集 id 相同（project ep_0001 vs 剧本 ep1）。
    // 映射优先读 Project shot 上已落地的 runShotId；存量项目未回填时用 matchProjectShotsToRunShots 就地配对（按 index/同集顺序）。
    const project = loadProjectForRun(config, run);
    const attribution = project ? resolveEpisodeShotAttribution({ project, runShots: allShots }) : null;

    const episodeList = (() => {
        if (attribution && attribution.episodes.length) {
            return episodeId ? attribution.episodes.filter((episode) => episode.id === episodeId) : attribution.episodes;
        }
        const list = listEpisodes({ episodes: episodesInput || scriptOutput.episodes, shots: allShots });
        return episodeId ? list.filter((episode) => episode.id === episodeId) : list;
    })();
    if (!episodeList.length) {
        const projectIds = project && Array.isArray(project.episodes) ? project.episodes.map((episode) => episode.id).join("、") : "";
        const hint = episodeId && projectIds ? `（Project 侧集 id 形如 ep_0001，本项目有：${projectIds}）` : "";
        throw new Error(`没有可导出的集（episodeId=${episodeId}）${hint}`);
    }

    const runSteps = new Set(steps);
    let plan = null;

    // ---- step: plan ----
    if (runSteps.has("plan") || !existsSync(planPath)) {
        writeLog(`[plan] 开始：run=${runId} 集数=${episodeList.length} 转场=${resolvedTransition}`);
        const episodes = [];
        let firstProbe = null;
        for (const episode of episodeList) {
            // 按映射归属取本集运行侧分镜，并把两侧 id 一并挂上（runShotId 用于配对 clips；projectShotId 用于追溯）。
            const episodeShots = shotsForEpisode(episode, allShots).map((shot) => ({
                ...shot,
                runShotId: String(shot?.id ?? ""),
                projectShotId: episode.projectShotIds?.[String(shot?.id ?? "")] ?? null,
            }));
            // 始终以 allowPartial=true 规划，好把**全部集**的缺段一次算齐；最终是否拒绝出片由下方统一判定。
            const planResult = planRoughCut({
                episodeId: episode.id,
                shots: episodeShots,
                clips: allClips,
                allowPartial: true,
                transition: resolvedTransition,
            });
            const segments = [];
            for (const segment of planResult.segments) {
                const mediaPath = resolveMediaPathSafe(config, segment.ref);
                let probe = null;
                if (mediaPath && existsSync(mediaPath)) {
                    probe = await probeMedia(mediaPath, ffprobePath);
                } else if (/^https?:\/\//i.test(String(segment.ref))) {
                    throw new Error(`暂不支持远端 URL 片段（${segment.ref}）`);
                }
                if (probe && !firstProbe) firstProbe = probe;
                const realDuration = probe?.durationSec ?? num(segment.durationSec);
                segments.push({
                    ...segment,
                    mediaPath,
                    durationSec: realDuration,
                    durationSource: probe?.durationSec ? "probe" : "metadata",
                    hasAudio: probe ? probe.hasAudio : null,
                    sampleRate: probe?.sampleRate ?? null,
                    channels: probe?.channels ?? null,
                });
            }
            episodes.push({
                episodeId: episode.id,
                episodeIndex: episode.index,
                title: episode.title,
                sceneIds: episode.sceneIds,
                partial: planResult.partial,
                segments,
                missing: planResult.missing,
                presentCount: planResult.presentCount,
                expectedCount: planResult.expectedCount,
                presentDurationSec: planResult.presentDurationSec,
                missingDurationSec: planResult.missingDurationSec,
            });
        }

        const missingAll = episodes.flatMap((ep) => ep.missing.map((item) => ({ ...item, episodeId: ep.episodeId })));
        plan = {
            version: 1,
            kind: "edit-export-plan",
            pkgId,
            runId,
            projectId: run?.options?.projectId || null,
            createdAt,
            transition: resolvedTransition,
            transitionDurationSec: resolvedTransition === "cut" ? 0 : transitionDurationSec,
            width: options.width || firstProbe?.width || config.pipeline?.videoWidth || 768,
            height: options.height || firstProbe?.height || config.pipeline?.videoHeight || 1344,
            fps: options.fps || config.pipeline?.videoFps || 24,
            quality: options.quality || "standard",
            allowPartial: allowPartial === true,
            // #51：映射归属明细（两侧配对 / 不一致处）——显式落盘，不静默。
            attribution: attribution
                ? {
                      pairs: attribution.pairs.length,
                      unmatchedRun: attribution.unmatchedRun,
                      unmatchedProject: attribution.unmatchedProject,
                      warnings: attribution.warnings,
                  }
                : null,
            episodes,
            missing: missingAll,
        };
        writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
        writeLog(`[plan] 完成：有片段 ${episodes.reduce((n, ep) => n + ep.segments.length, 0)} 段，缺 ${missingAll.length} 段`);
        // 严格模式：把**全部集**的缺段一次性报出（不再是抛在某一集上），并拒绝出片（plan.json 已落盘可复现）。
        if (missingAll.length && !allowPartial) throw new MissingClipsError(missingAll);
    } else {
        plan = JSON.parse(readFileSync(planPath, "utf8"));
        writeLog(`[plan] 复用磁盘 plan.json（单步重跑）`);
    }

    const { width, height, fps } = plan;

    // ---- step: assemble ----
    if (runSteps.has("assemble")) {
        // 重跑前清空包目录，避免上一次的陈旧文件混进 zip（中间产物/日志在 workDir 根，不受影响）。
        rmSync(pkgDir, { recursive: true, force: true });
        ensureDir(pkgDir);
        for (const episode of plan.episodes) {
            const epPad = pad2(episode.episodeIndex || 1);
            const epLabel = `ep${epPad}`;
            if (!episode.segments.length) {
                writeLog(`[assemble] ${epLabel} 无可用片段，跳过出片（缺 ${episode.missing.length} 段）`);
                continue;
            }
            const durations = episode.segments.map((seg) => num(seg.durationSec));
            if (durations.some((value) => value === null)) {
                throw new Error(`${epLabel} 有片段缺少时长，无法排时间线`);
            }
            const timeline = buildTimeline({
                segments: episode.segments.map((seg) => ({ ...seg, fileStem: `${epLabel}_sh${pad2(seg.shotIndex)}` })),
                durations,
                transition: plan.transition,
                transitionDurationSec: plan.transitionDurationSec,
            });

            // 1) 分片原片按序复制进包
            for (const entry of timeline) {
                const target = safeJoin(pkgDir, "clips", `${entry.fileStem}.mp4`);
                ensureDir(resolve(target, ".."));
                copyFileSync(entry.mediaPath, target);
            }

            // 2) SRT 字幕 + 画面文字注释
            const srt = buildSrt({ timeline });
            const srtPath = safeJoin(pkgDir, `${epLabel}.srt`);
            writeFileSync(srtPath, srt, "utf8");

            const overlays = buildOverlayNotes({ timeline, episodeLabel: epLabel });
            if (overlays) {
                const overlayPath = safeJoin(pkgDir, `${epLabel}_overlays.txt`);
                writeFileSync(overlayPath, overlays, "utf8");
            }

            // 3) FCPXML + EDL
            for (const entry of timeline) entry.file = `clips/${entry.fileStem}.mp4`;
            const fcpxml = buildFcpxml({ projectName: `${epLabel}_${episode.title}`, width, height, fps, timeline });
            const fcpxmlPath = safeJoin(pkgDir, `${epLabel}.fcpxml`);
            writeFileSync(fcpxmlPath, fcpxml, "utf8");

            const edl = buildEdl({ title: `${epLabel}_${episode.title}`, fps, timeline });
            const edlPath = safeJoin(pkgDir, `${epLabel}.edl`);
            writeFileSync(edlPath, edl, "utf8");

            // 4) 真实拼接成片（复用 delivery：concat/xfade + 字幕烧录 + 原声）
            if (runSteps.has("plan")) writeLog(`[assemble] ${epLabel} 调用 ffmpeg 拼接 ${timeline.length} 段`);
            const allHaveAudio = timeline.every((entry) => entry.hasAudio === true);
            const result = await assembleEpisode({
                config,
                episodeId: episode.episodeId,
                clips: timeline.map((entry) => ({
                    id: entry.clipId || entry.shotId,
                    shotId: entry.shotId,
                    artifactUrl: entry.ref,
                    durationSec: entry.durationSec,
                    status: "done",
                })),
                order: timeline.map((entry) => entry.clipId || entry.shotId),
                transition: plan.transition,
                options: {
                    id: `${pkgId}-${epLabel}`,
                    filename: `${epLabel}_final.mp4`,
                    width,
                    height,
                    fps,
                    quality: plan.quality,
                    transitionDurationSec: plan.transitionDurationSec,
                    subtitles: options.burnSubtitles !== false && srt.trim() ? srtPath : null,
                    subtitleStyle: options.subtitleStyle || null,
                    includeClipAudio: allHaveAudio,
                    cover: options.cover !== false,
                },
                ffmpegPath,
                ffprobePath,
            });
            const finalTarget = safeJoin(pkgDir, `${epLabel}_final.mp4`);
            copyFileSync(result.outputPath, finalTarget);
            episode.finalFile = `${epLabel}_final.mp4`;
            episode.finalInfo = result.info;
            episode.durationSec = result.info?.durationSec ?? timeline[timeline.length - 1].endSec;
            episode.assembled = true;
            episode.audioIncluded = allHaveAudio;
            if (result.coverUrl) {
                const coverSource = join(result.dir, basename(decodeURIComponent(result.coverUrl.split("/").pop())));
                if (existsSync(coverSource)) {
                    const coverTarget = safeJoin(pkgDir, `${epLabel}_final-cover.jpg`);
                    copyFileSync(coverSource, coverTarget);
                    episode.coverFile = `${epLabel}_final-cover.jpg`;
                }
            }
        }
        // 把组装结果回写 plan，便于 package 单步重跑
        writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
    }

    // ---- step: package ----
    if (runSteps.has("package")) {
        const manifest = {
            version: 1,
            kind: "edit-export-package",
            pkgId,
            runId,
            projectId: plan.projectId || run?.options?.projectId || null,
            createdAt,
            transition: plan.transition,
            transitionDurationSec: plan.transitionDurationSec,
            width,
            height,
            fps,
            allowPartial: plan.allowPartial,
            partial: plan.missing.length > 0,
            missing: plan.missing,
            attribution: plan.attribution || null,
            episodes: plan.episodes.map((episode) => ({
                episodeId: episode.episodeId,
                index: episode.episodeIndex,
                title: episode.title,
                partial: episode.partial,
                durationSec: episode.durationSec ?? null,
                finalFile: episode.finalFile || null,
                assembled: episode.assembled === true,
                audioIncluded: episode.audioIncluded ?? null,
                missing: episode.missing,
                segments: episode.segments.map((seg, index) => ({
                    index,
                    order: index + 1,
                    shotId: seg.shotId,
                    runShotId: seg.runShotId ?? seg.shotId,
                    projectShotId: seg.projectShotId ?? null,
                    shotIndex: seg.shotIndex,
                    clipId: seg.clipId,
                    jobId: seg.jobId,
                    template: seg.template,
                    file: `clips/${`ep${pad2(episode.episodeIndex || 1)}_sh${pad2(seg.shotIndex)}`}.mp4`,
                    durationSec: seg.durationSec,
                    durationSource: seg.durationSource,
                    hasAudio: seg.hasAudio,
                    transition: plan.transition,
                    prompt: seg.prompt,
                    negativePrompt: seg.negativePrompt,
                    referenceImage: seg.referenceImage,
                    dialogue: seg.dialogue,
                    textOverlays: seg.textOverlays,
                })),
            })),
        };
        const manifestInPkg = safeJoin(pkgDir, "manifest.json");
        writeFileSync(manifestInPkg, JSON.stringify(manifest, null, 2), "utf8");

        const readmeInPkg = safeJoin(pkgDir, "README.txt");
        writeFileSync(
            readmeInPkg,
            buildPackageReadme({ runId, packageRoot: zipRoot, episodes: plan.episodes, allowPartial: plan.allowPartial, createdAt }),
            "utf8",
        );

        // 从磁盘扫描包目录（assemble 与 package 分步重跑都能拿到同一份文件全集）。
        const packageFiles = walkFiles(pkgDir);
        const zipEntries = packageFiles.map((file) => ({ name: `${zipRoot}/${file.name}`, path: file.path }));
        const zip = writeZip({ outputPath: zipPath, entries: zipEntries, now: new Date(createdAt) });
        const listed = listZipEntries(zipPath);
        const exportManifest = {
            version: 1,
            kind: "edit-export-manifest",
            pkgId,
            runId,
            status: "done",
            createdAt,
            zip: { path: zipPath, url: artifactUrl(config, pkgId, basename(zipPath)), bytes: zip.bytes, entries: listed.length },
            planPath,
            logPath,
            missing: plan.missing,
            episodes: plan.episodes.map((episode) => ({
                episodeId: episode.episodeId,
                finalFile: episode.finalFile || null,
                segments: episode.segments.length,
                missing: episode.missing.length,
                durationSec: episode.durationSec ?? null,
            })),
        };
        writeFileSync(manifestPath, JSON.stringify(exportManifest, null, 2), "utf8");
        writeLog(`[package] 完成：zip ${zip.bytes} 字节，${listed.length} 个条目`);

        return {
            status: "done",
            pkgId,
            workDir,
            zipPath,
            zipUrl: exportManifest.zip.url,
            zipBytes: zip.bytes,
            entries: listed,
            manifest,
            manifestPath,
            planPath,
            logPath,
            missing: plan.missing,
            episodes: plan.episodes,
        };
    }

    return { status: "partial-run", pkgId, workDir, zipPath, plan, planPath, logPath, missing: plan.missing, episodes: plan.episodes };
}

/** 把片段引用解析成本机路径；非法引用返回 null（由 plan 报错而不是静默）。 */
function resolveMediaPathSafe(config, ref) {
    const text = String(ref ?? "").trim();
    if (!text) return null;
    if (text.startsWith("/api/artifacts/")) {
        const segments = text.slice("/api/artifacts/".length).split("/").filter(Boolean).map(decodeURIComponent);
        return safeJoin(config.dataDir, "artifacts", ...segments);
    }
    return resolve(text);
}

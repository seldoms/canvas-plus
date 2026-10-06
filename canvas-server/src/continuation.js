/**
 * continuation.js —— H3 多段续接（M3.5，m35-implementation-plan §2/§3）。
 *
 * 纯业务模块：不 import http.js、不自己起 server；Job 队列、提交链、存储、ffmpeg 与
 * 探测能力全部由调用方经 deps 注入（测试可全量替换成假实现，绝不真打 GPU）。
 *
 * 设计要点（与计划决策一一对应）：
 * - D35-1 不建链注册表：链状态从 clip 槽位（slot_<shotId>_clip）候选派生，takeId == continuationChainId。
 * - D35-3 段 Job 自描述：meta.continuation 带 chainId/takeId/segmentIndex/totalSegments/prompt/seed/parentCandidateId；
 *   幂等键 continuation:<chainId>:seg<N>（重试段追加 :r<K>），编排器无状态。
 * - D35-4 编排：段 N done →（N≥1 时先做接缝 QC，只标记不阻断）→ preflight → 抽尾帧 → 组 I2VA 参数 → 提交段 N+1；
 *   failed/canceled → 链停，等 resume 或下次启动的 stalled 扫描。
 * - D35-5 接缝 QC：CPU 直接 spawn ffmpeg（不进 GPU 队列），失败只记 warning；
 *   门槛 SSIM<0.85 或 freeze 或 ΔdB>12 → seam.needsReview=true。
 * - D35-6 分叉：父候选必须 done；新链首段 segmentIndex = 父段+1，first_frame 取父段产物尾帧，原链一律不写。
 *
 * 提示词编译走 M1 链（deps.submitIntent → submitGenerationIntent 内部编译），本模块不拼编译结果；
 * 尾帧抽取/上传是内部步骤，用户无感。
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { ensureDir, sanitizeName } from "./files.js";
import { createGenerationIntent } from "./generation-intent.js";
import { resolveMediaPath } from "./delivery.js";
import { presetForTemplate } from "./prompt-compiler.js";
import { scanTemplateDir } from "./tool-adapter.js";

/** 段模板默认：seg0 用 T2VA，seg≥1 用 I2VA（first_frame 续接），与 POC 验证的配方一致。 */
const DEFAULT_TEMPLATES = { t2v: "video_minimax_h3_t2v", i2v: "video_h3_i2v" };

/** 段规格默认（POC 稳档）：480×832 竖屏、73 帧（17n+5 网格）。调用方 params 可覆盖。 */
const DEFAULT_SEGMENT_PARAMS = { WIDTH: 480, HEIGHT: 832, LENGTH: 73 };

/** 接缝门槛（POC §七.2 基于 4 接缝样本）：命中任一 → needsReview（只标记，不阻断）。 */
export const SEAM_THRESHOLDS = Object.freeze({ ssimMin: 0.85, audioStepMaxDb: 12 });

/** preflight 边界值（POC §六：ram_free<4GB 时单段 90s→698s；他人任务插排实测等 6~11 分钟）。 */
const PREFLIGHT_DEFAULTS = { minRamFreeBytes: 4 * 1024 ** 3, maxWaitMs: 30 * 60_000, pollMs: 15_000 };

const MAX_SEGMENTS = 8;

/**
 * 采样参数回填：**不硬编码** steps/cfg/sampler，与 pipeline.js的 `applyPresetParams` 同语义——
 * 仅当模板真的声明了对应 token 且调用方未显式给值时才用规则表参数档回填。
 * 续接链的段模板（seg0=T2VA、seg≥1=I2VA）各自需要的 token 不同，缺项会在渲染阶段报「缺少参数」。
 */
const PRESET_TOKEN_KEYS = Object.freeze({ STEPS: "steps", CFG: "cfg", SAMPLER: "sampler", SCHEDULER: "scheduler", SHIFT: "shift" });

function applyPresetParams(params, template, tokens) {
    const preset = presetForTemplate(template, "speed");
    if (!preset || !Array.isArray(tokens)) return params;
    for (const [token, key] of Object.entries(PRESET_TOKEN_KEYS)) {
        if (tokens.includes(token) && params[token] === undefined && preset[key] !== undefined) params[token] = preset[key];
    }
    return params;
}

/** 契约错误：与 generation-intent.js / slot-candidates.js 同形（status + code + field）。 */
function contractError(status, code, message, field) {
    return Object.assign(new Error(message), { status, code, field });
}

const asId = (value) => (value === undefined || value === null || String(value).trim() === "" ? null : String(value));

function newChainId() {
    return `chain_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Job 状态 → 候选状态（契约 §5.3）：error → failed，其余直通。 */
function candidateStatusOf(jobStatus) {
    if (jobStatus === "error") return "failed";
    return ["pending", "queued", "running", "done", "canceled"].includes(jobStatus) ? jobStatus : "pending";
}

/** 跑一个外部命令，stdout/stderr 合并收集；非 0 退出码抛错带输出尾部（惯例同 delivery.js）。 */
function runCommand(bin, args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
            const output = Buffer.concat(chunks).toString("utf8");
            if (code === 0) resolvePromise({ code, output });
            else reject(Object.assign(new Error(`${bin} 退出码 ${code}：${output.slice(-300)}`), { code, output }));
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ffprobe 取容器/流信息（时长、宽、高、fps、音频采样率）；缺流/解析失败一律 null，不臆造。 */
async function probeMedia(ffprobePath, filePath) {
    try {
        const { output } = await runCommand(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath]);
        const info = JSON.parse(output);
        const video = (info.streams || []).find((stream) => stream.codec_type === "video");
        const audio = (info.streams || []).find((stream) => stream.codec_type === "audio");
        const fpsParts = String(video?.avg_frame_rate || "").split("/").map(Number);
        return {
            durationSec: Number(info.format?.duration) || null,
            width: video?.width ?? null,
            height: video?.height ?? null,
            fps: fpsParts.length === 2 && fpsParts[1] > 0 ? fpsParts[0] / fpsParts[1] : null,
            audioSampleRate: Number(audio?.sample_rate) || null,
            hasAudio: Boolean(audio),
        };
    } catch {
        return { durationSec: null, width: null, height: null, fps: null, audioSampleRate: null, hasAudio: false };
    }
}

/** 从视频抽最后一帧 PNG（POC §七.5：-sseof 抽帧，无需 ComfyUI 内解码）。 */
export async function extractTailFrame({ ffmpegPath = "ffmpeg", videoPath, outputPath }) {
    ensureDir(dirname(outputPath));
    await runCommand(ffmpegPath, ["-y", "-v", "error", "-sseof", "-0.042", "-i", videoPath, "-frames:v", "1", outputPath]);
    return outputPath;
}

/**
 * 接缝 QC（POC seam_qc 方法的 JS + ffmpeg CLI 移植）：边界帧 SSIM/PSNR、接缝窗 freezedetect、
 * 父尾/子首 0.5s RMS 落差、接缝 ebur128 积分响度与真峰值，外加子段容器探测（宽高/fps/采样率）。
 * 单项失败只让该指标为 null；ffmpeg 整体不可用才抛错（调用方降级为 warning，绝不阻断链）。
 */
export async function runSeamQc({ ffmpegPath = "ffmpeg", ffprobePath = "ffprobe", parentPath, childPath, workDir }) {
    ensureDir(workDir);
    const metrics = {
        boundarySsim: null,
        boundaryPsnrDb: null,
        freezeDetected: false,
        parentTailRmsDb: null,
        childHeadRmsDb: null,
        audioSeamDeltaDb: null,
        seamIntegratedLufs: null,
        seamTruePeakDbfs: null,
    };
    const [parent, child] = await Promise.all([probeMedia(ffprobePath, parentPath), probeMedia(ffprobePath, childPath)]);
    const number = (pattern, text) => {
        const match = text.match(pattern);
        const value = match ? Number(match[1]) : NaN;
        return Number.isFinite(value) ? value : null;
    };
    const step = async (fn) => {
        try {
            await fn();
        } catch {
            // 单项指标失败不拖垮整体 QC（其余指标照常产出）。
        }
    };

    const parentTail = join(workDir, "seam_parent_tail.png");
    const childHead = join(workDir, "seam_child_head.png");
    await runCommand(ffmpegPath, ["-y", "-v", "error", "-sseof", "-0.042", "-i", parentPath, "-frames:v", "1", parentTail]);
    await runCommand(ffmpegPath, ["-y", "-v", "error", "-i", childPath, "-frames:v", "1", childHead]);

    await step(async () => {
        const { output } = await runCommand(ffmpegPath, ["-i", parentTail, "-i", childHead, "-lavfi", "ssim", "-f", "null", "-"]);
        metrics.boundarySsim = number(/All:([\d.]+)/, output);
    });
    await step(async () => {
        const { output } = await runCommand(ffmpegPath, ["-i", parentTail, "-i", childHead, "-lavfi", "psnr", "-f", "null", "-"]);
        metrics.boundaryPsnrDb = number(/average:([\d.]+)/, output);
    });
    // 接缝窗（父末 1s + 子首 1s）冻结帧检测：段首重复帧会报 freeze_start。
    await step(async () => {
        const start = Math.max(0, (parent.durationSec || 1) - 1).toFixed(3);
        const { output } = await runCommand(ffmpegPath, [
            "-ss", start, "-i", parentPath, "-t", "1.0", "-i", childPath,
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,freezedetect=n=-55dB:d=0.25[v]",
            "-map", "[v]", "-f", "null", "-",
        ]);
        metrics.freezeDetected = /freeze_start/.test(output);
    });
    const rmsOf = async (path, seekArgs) => {
        const { output } = await runCommand(ffmpegPath, [
            ...seekArgs, "-i", path, "-vn",
            "-af", "astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level",
            "-f", "null", "-",
        ]);
        return number(/RMS_level[= ](-?[\d.]+)/, output);
    };
    if (parent.hasAudio && child.hasAudio) {
        await step(async () => {
            const start = Math.max(0, (parent.durationSec || 0.5) - 0.5).toFixed(3);
            metrics.parentTailRmsDb = await rmsOf(parentPath, ["-ss", start, "-t", "0.5"]);
        });
        await step(async () => {
            metrics.childHeadRmsDb = await rmsOf(childPath, ["-t", "0.5"]);
        });
        if (metrics.parentTailRmsDb !== null && metrics.childHeadRmsDb !== null) {
            metrics.audioSeamDeltaDb = Math.round(Math.abs(metrics.childHeadRmsDb - metrics.parentTailRmsDb) * 10) / 10;
        }
        await step(async () => {
            const start = Math.max(0, (parent.durationSec || 1) - 1).toFixed(3);
            const { output } = await runCommand(ffmpegPath, [
                "-ss", start, "-i", parentPath, "-t", "1.0", "-i", childPath,
                "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1,ebur128=peak=true[a]",
                "-map", "[a]", "-f", "null", "-",
            ]);
            const lufs = [...output.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
            metrics.seamIntegratedLufs = lufs.length ? Number(lufs.at(-1)[1]) : null;
            metrics.seamTruePeakDbfs = number(/Peak:\s+(-?[\d.]+) dBFS/, output);
        });
    }
    return { ...metrics, width: child.width, height: child.height, fps: child.fps, audioSampleRate: child.audioSampleRate };
}

/** needsReview 判定（D35-5）：SSIM<0.85 或冻结帧或音频落差>12dB。 */
export function seamNeedsReview(metrics) {
    if (!metrics || typeof metrics !== "object") return false;
    if (metrics.boundarySsim !== null && Number(metrics.boundarySsim) < SEAM_THRESHOLDS.ssimMin) return true;
    if (metrics.freezeDetected === true) return true;
    if (metrics.audioSeamDeltaDb !== null && Number(metrics.audioSeamDeltaDb) > SEAM_THRESHOLDS.audioStepMaxDb) return true;
    return false;
}

/**
 * 147 preflight（POC §六/§七.4）：提交段前等 ComfyUI 队列空（他人任务插排时排队等）→ POST /free →
 * 确认 ram_free≥4GB；不足则等待重试，带上限与日志。探测不可达按放行处理（本地无卡环境不至于把链卡死），
 * 等待超上限也放行并记 warning——preflight 是优化不是门禁，绝不把链永久锁死。
 */
export function createComfyPreflight({ comfy, minRamFreeBytes, maxWaitMs, pollMs, log = console } = {}) {
    const limits = { ...PREFLIGHT_DEFAULTS, ...(minRamFreeBytes > 0 ? { minRamFreeBytes } : {}), ...(maxWaitMs > 0 ? { maxWaitMs } : {}), ...(pollMs > 0 ? { pollMs } : {}) };
    return async function preflight() {
        const deadline = Date.now() + limits.maxWaitMs;
        for (;;) {
            let snapshot;
            try {
                const [stats, counts] = await Promise.all([comfy.systemStats(), comfy.queueCounts()]);
                snapshot = { ramFree: Number(stats?.system?.ram_free), busy: (counts?.running || 0) + (counts?.pending || 0) };
            } catch (error) {
                log.warn(`[continuation] preflight 探测失败（按放行处理）：${error.message}`);
                return;
            }
            if (!snapshot.busy) {
                try {
                    if (typeof comfy.free === "function") await comfy.free({ unloadModels: false, freeMemory: true });
                    snapshot.ramFree = Number((await comfy.systemStats())?.system?.ram_free);
                } catch (error) {
                    log.warn(`[continuation] preflight 释放内存失败（按当前读数继续）：${error.message}`);
                }
                if (!Number.isFinite(snapshot.ramFree) || snapshot.ramFree >= limits.minRamFreeBytes) return;
            }
            if (Date.now() > deadline) {
                log.warn(`[continuation] preflight 等待超上限 ${Math.round(limits.maxWaitMs / 60000)} 分钟，按当前状态放行（busy=${snapshot.busy} ramFree=${snapshot.ramFree}）`);
                return;
            }
            log.log(`[continuation] preflight 等待：队列任务=${snapshot.busy}，ram_free=${Number.isFinite(snapshot.ramFree) ? `${Math.round(snapshot.ramFree / 1024 ** 3)}GB` : "未知"}（要求≥${Math.round(limits.minRamFreeBytes / 1024 ** 3)}GB）`);
            await sleep(limits.pollMs);
        }
    };
}

export function createContinuation(deps = {}) {
    const { episodes, jobs, config } = deps;
    if (typeof episodes?.appendSlotCandidate !== "function" || typeof episodes?.updateSlotCandidate !== "function" || typeof episodes?.findShot !== "function") {
        throw new Error("createContinuation 需要注入 episodes 的槽位存储函数（appendSlotCandidate/updateSlotCandidate/findShot）");
    }
    if (typeof jobs?.get !== "function" || typeof jobs?.list !== "function") throw new Error("createContinuation 需要注入 jobs.get / jobs.list");
    if (typeof deps.submitIntent !== "function") throw new Error("createContinuation 需要注入 submitIntent（M1 提交链：能力校验+编译+入队）");
    const templates = { ...DEFAULT_TEMPLATES, ...(deps.templates || {}) };
    // 模板 → 声明的 token（只认模板真实声明的，不猜）；缺项参数由参数档回填，避免「缺少参数」渲染失败。
    const templateCatalog = scanTemplateDir(config?.workflowsDir);
    const segmentDefaults = { ...DEFAULT_SEGMENT_PARAMS, ...(deps.segmentDefaults || {}) };
    const preflight = typeof deps.preflight === "function" ? deps.preflight : async () => {};
    const seamQc = typeof deps.runSeamQc === "function" ? deps.runSeamQc : (input) => runSeamQc({ ffmpegPath: deps.ffmpegPath, ffprobePath: deps.ffprobePath, ...input });
    const tailFrame = typeof deps.extractTailFrame === "function" ? deps.extractTailFrame : (input) => extractTailFrame({ ffmpegPath: deps.ffmpegPath, ...input });
    // 候选状态回写去重：progress 事件刷屏时同一状态只落一次盘。
    const lastWrittenStatus = new Map();

    const clipSlotId = (shotId) => `slot_${String(shotId)}_clip`;

    function requireShot(projectId, shotId) {
        const found = episodes.findShot(projectId, shotId);
        if (!found) throw contractError(404, "SHOT_NOT_FOUND", `镜头不存在：${shotId}`, "shotId");
        return found;
    }

    function clipSlot(found) {
        return (found.shot.generationSlots || []).find((slot) => slot.id === clipSlotId(found.shot.id)) || null;
    }

    /** 同链候选（clip 槽位内 continuationChainId 匹配），按 segmentIndex → createdAt 排序。 */
    function chainCandidates(projectId, shotId, chainId) {
        const found = episodes.findShot(projectId, shotId);
        if (!found) return [];
        const slot = clipSlot(found);
        return (slot?.candidates || [])
            .filter((candidate) => candidate.continuationChainId === chainId)
            .sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
    }

    /** 每个 segmentIndex 的最新一次 attempt（数组尾部的为最新）。 */
    function latestBySegment(candidates) {
        const latest = new Map();
        for (const candidate of candidates) {
            if (!Number.isInteger(candidate.segmentIndex)) continue;
            latest.set(candidate.segmentIndex, candidate);
        }
        return latest;
    }

    const chainJobs = (chainId) => (jobs.list() || []).filter((job) => job?.meta?.continuation?.chainId === chainId);

    function validateChainInput({ prompt, segments }) {
        if (typeof prompt !== "string" || !prompt.trim()) throw contractError(400, "CONTRACT_INVALID", "缺少 prompt（续接链不允许空 prompt）", "prompt");
        const count = Number(segments);
        if (!Number.isInteger(count) || count < 1 || count > MAX_SEGMENTS) {
            throw contractError(400, "CONTRACT_INVALID", `segments 必须是 1..${MAX_SEGMENTS} 的整数`, "segments");
        }
        return count;
    }

    /** seed 可选；给了必须是有限数（段 seed = 入参 seed，后续段由编排器 +1 派生）。 */
    function validateSeed(seed) {
        if (seed === undefined || seed === null || seed === "") return null;
        const value = Number(seed);
        if (!Number.isFinite(value)) throw contractError(400, "CONTRACT_INVALID", "seed 必须是数字", "seed");
        return value;
    }

    /**
     * 提交链的一段（内部）：preflight →（N≥1）抽父段尾帧 → 组参 → M1 提交链入队 → 候选写入 clip 槽位。
     * attempt>0 是失败段的重试（幂等键追加 :r<K>，避免命中已终态的原 Job）。
     */
    async function submitSegment({ projectId, shotId, chainId, takeId, segmentIndex, totalSegments, prompt, seed = null, parentCandidateId = null, template = null, params = {}, attempt = 0 }) {
        const found = requireShot(projectId, shotId);
        const slotId = clipSlotId(found.shot.id);
        const jobId = `video-cont-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const idempotencyKey = `continuation:${chainId}:seg${segmentIndex}${attempt > 0 ? `:r${attempt}` : ""}`;
        const workflow = segmentIndex === 0 ? templates.t2v : template || templates.i2v;

        await preflight();

        // 续接段：父段候选必须 done 且有产物；尾帧抽到新 Job 的产物目录，作为 contextArtifactId 留痕。
        // 状态以 Job 为准（候选可能因重启滞后），产物地址候选优先、Job outputs 兜底。
        let parentArtifactId = null;
        let contextArtifactId = null;
        const segmentParams = { ...params };
        if (segmentIndex >= 1) {
            const slot = clipSlot(found);
            const parent = parentCandidateId
                ? (slot?.candidates || []).find((candidate) => candidate.jobId === parentCandidateId)
                : latestBySegment((slot?.candidates || []).filter((candidate) => candidate.continuationChainId === chainId)).get(segmentIndex - 1);
            const parentJob = parent ? jobs.get(parent.jobId) : null;
            const parentStatus = parentJob ? candidateStatusOf(parentJob.status) : parent?.status;
            const parentArtifactUrl = parent?.artifactUrl ?? (Array.isArray(parentJob?.outputs) ? parentJob.outputs.find((output) => output?.url)?.url : null) ?? null;
            if (!parent || parentStatus !== "done" || !parentArtifactUrl) {
                throw contractError(409, "PARENT_NOT_DONE", `上一段候选未完成，无法续接段 ${segmentIndex}`, "parentCandidateId");
            }
            const parentVideoPath = resolveMediaPath(config, parentArtifactUrl);
            const framePath = join(ensureDir(join(config.dataDir, "artifacts", jobId)), "context_frame.png");
            await tailFrame({ videoPath: parentVideoPath, outputPath: framePath });
            segmentParams.INPUT_IMAGE = framePath;
            contextArtifactId = `/api/artifacts/${jobId}/context_frame.png`;
            parentArtifactId = `${parent.continuationChainId ?? chainId}/seg${parent.segmentIndex ?? segmentIndex - 1}#${parent.jobId}`;
        }

        const intent = createGenerationIntent({
            source: "project",
            kind: "video",
            context: { projectId, episodeId: found.episode.id, sceneId: found.shot.sceneId, shotId: found.shot.id, slotId },
            toolId: workflow,
            template: workflow,
            facts: { prompt },
            params: applyPresetParams({
                ...segmentDefaults,
                ...segmentParams,
                ...(seed !== null ? { SEED: seed } : {}),
                OUTPUT_PREFIX: `continuation/${sanitizeName(chainId)}_seg${segmentIndex}`,
                // ComfyUI 执行缓存命中时 history 无 outputs：允许按 OUTPUT_PREFIX 回落取回产物（同一段重跑语义=同一份产物）。
                RECOVER_BY_PREFIX: true,
            }, workflow, templateCatalog[workflow]?.tokens),
            options: {
                jobId,
                idempotencyKey,
                name: `续接 ${chainId} 段${segmentIndex}`,
                meta: {
                    continuation: { chainId, takeId, segmentIndex, totalSegments, prompt, seed, parentCandidateId },
                },
            },
        });
        const job = await deps.submitIntent(intent);

        // 候选写入（契约 §3.6：续接字段完整）；幂等由存储层保证（同 jobId 不重复）。
        episodes.appendSlotCandidate(projectId, shotId, slotId, {
            template: workflow,
            jobId: job.id,
            artifactUrl: (Array.isArray(job.outputs) ? job.outputs : []).find((output) => output?.url)?.url ?? null,
            status: candidateStatusOf(job.status),
            source: "project",
            takeId,
            parentCandidateId,
            approvalStatus: "pending",
            continuationChainId: chainId,
            segmentIndex,
            parentArtifactId,
            contextArtifactId,
            latentArtifactId: null,
            continuation: null,
        });
        lastWrittenStatus.set(job.id, candidateStatusOf(job.status));
        return job;
    }

    /** 段 N done 后的接缝 QC：指标写入子段候选 continuation.seam（含 reviewed:"pending" 与 needsReview），失败只记 warning。 */
    async function runSegmentSeamQc(job, cont) {
        const { projectId, shotId, slotId } = job.meta || {};
        const found = episodes.findShot(projectId, shotId);
        if (!found) return;
        const slot = clipSlot(found);
        const parent = cont.parentCandidateId
            ? (slot?.candidates || []).find((candidate) => candidate.jobId === cont.parentCandidateId)
            : latestBySegment(chainCandidates(projectId, shotId, cont.chainId)).get(cont.segmentIndex - 1);
        const childUrl = (Array.isArray(job.outputs) ? job.outputs : []).find((output) => output?.url)?.url;
        if (!parent?.artifactUrl || !childUrl) {
            console.warn(`[continuation] 段 ${cont.chainId}/seg${cont.segmentIndex} 接缝 QC 跳过：父段或子段产物缺失`);
            return;
        }
        const metrics = await seamQc({
            parentPath: resolveMediaPath(config, parent.artifactUrl),
            childPath: resolveMediaPath(config, childUrl),
            workDir: join(config.dataDir, "artifacts", job.id, "seam"),
        });
        const length = Number(job.params?.LENGTH);
        episodes.updateSlotCandidate(projectId, shotId, slotId, job.id, {
            continuation: {
                overlapFrames: 1,
                addedFrames: Number.isFinite(length) && length > 1 ? length - 1 : null,
                width: metrics.width,
                height: metrics.height,
                fps: metrics.fps,
                audioSampleRate: metrics.audioSampleRate,
                seam: {
                    // 契约最小形态子字段；暂无对应量化手段的填 null，多出的量化值放 seam.metrics。
                    audioCorrelation: null,
                    rmsStepDb: metrics.audioSeamDeltaDb,
                    freezeDetected: metrics.freezeDetected === true,
                    motionDrift: null,
                    reviewed: "pending",
                    needsReview: seamNeedsReview(metrics),
                    metrics: {
                        boundarySsim: metrics.boundarySsim,
                        boundaryPsnrDb: metrics.boundaryPsnrDb,
                        parentTailRmsDb: metrics.parentTailRmsDb,
                        childHeadRmsDb: metrics.childHeadRmsDb,
                        audioSeamDeltaDb: metrics.audioSeamDeltaDb,
                        seamIntegratedLufs: metrics.seamIntegratedLufs,
                        seamTruePeakDbfs: metrics.seamTruePeakDbfs,
                    },
                },
            },
        });
    }

    /** 段 done 后的编排：先接缝 QC（N≥1），再按 totalSegments 自动提交下一段；任何失败只记 warning（链交给 resume/stalled 扫描恢复）。 */
    async function afterSegmentDone(job, cont) {
        if (cont.segmentIndex >= 1) {
            try {
                await runSegmentSeamQc(job, cont);
            } catch (error) {
                console.warn(`[continuation] 接缝 QC 失败（不阻断链）${cont.chainId}/seg${cont.segmentIndex}：${error.message}`);
            }
        }
        if (cont.segmentIndex + 1 < cont.totalSegments) {
            const { projectId, shotId } = job.meta || {};
            await submitSegment({
                projectId,
                shotId,
                chainId: cont.chainId,
                takeId: cont.takeId,
                segmentIndex: cont.segmentIndex + 1,
                totalSegments: cont.totalSegments,
                prompt: cont.prompt,
                seed: cont.seed !== null && cont.seed !== undefined ? cont.seed + 1 : null,
            });
        }
    }

    /** 开新链：seg0 用 T2VA（无 first_frame）；chainId == takeId（D35-1）。 */
    async function startChain({ projectId, shotId, prompt, segments, seed, template, params } = {}) {
        const totalSegments = validateChainInput({ prompt, segments });
        const found = requireShot(projectId, shotId);
        const chainId = newChainId();
        const takeId = chainId;
        const firstJob = await submitSegment({
            projectId,
            shotId,
            chainId,
            takeId,
            segmentIndex: 0,
            totalSegments,
            prompt: prompt.trim(),
            seed: validateSeed(seed),
            template: asId(template),
            params: params && typeof params === "object" ? params : {},
        });
        return { chainId, takeId, slotId: clipSlotId(found.shot.id), firstJob };
    }

    /** 分叉（D35-6）：父候选必须 done；新链首段 = 父段 index+1，尾帧续接；原链候选/产物一律不写。 */
    async function startBranch({ projectId, shotId, parentCandidateId, prompt, segments, seed } = {}) {
        const totalSegments = validateChainInput({ prompt, segments });
        const found = requireShot(projectId, shotId);
        const slot = clipSlot(found);
        const parentId = asId(parentCandidateId);
        const parent = (slot?.candidates || []).find((candidate) => candidate.jobId === parentId);
        if (!parent) throw contractError(404, "CANDIDATE_NOT_FOUND", `候选不存在：${parentId ?? "(空)"}`, "parentCandidateId");
        const parentJob = jobs.get(parent.jobId);
        const parentStatus = parentJob ? candidateStatusOf(parentJob.status) : parent.status;
        const parentArtifactUrl = parent.artifactUrl ?? (Array.isArray(parentJob?.outputs) ? parentJob.outputs.find((output) => output?.url)?.url : null) ?? null;
        if (parentStatus !== "done" || !parentArtifactUrl) throw contractError(409, "PARENT_NOT_DONE", `父候选未完成（${parentStatus}），不能分叉`, "parentCandidateId");
        const chainId = newChainId();
        const takeId = chainId;
        const firstIndex = Number.isInteger(parent.segmentIndex) ? parent.segmentIndex + 1 : 0;
        const firstJob = await submitSegment({
            projectId,
            shotId,
            chainId,
            takeId,
            segmentIndex: firstIndex,
            totalSegments: firstIndex + totalSegments,
            prompt: prompt.trim(),
            seed: validateSeed(seed),
            parentCandidateId: parent.jobId,
        });
        return { chainId, takeId, slotId: clipSlotId(found.shot.id), firstJob };
    }

    /**
     * 恢复链：已完成段靠幂等键跳过（只补缺失段）；失败/取消段用新 attempt（:r<K>）重跑；
     * 有段在跑就返回该段；链已完成返回 job:null。
     */
    async function resumeChain({ projectId, shotId, chainId } = {}) {
        const found = requireShot(projectId, shotId);
        const candidates = chainCandidates(projectId, shotId, chainId);
        if (!candidates.length) throw contractError(404, "CHAIN_NOT_FOUND", `续接链不存在：${chainId}`, "chainId");
        const existing = chainJobs(chainId);
        const totalSegments = existing.map((job) => job.meta?.continuation?.totalSegments).find(Number.isInteger) ?? Math.max(...candidates.map((c) => c.segmentIndex ?? 0)) + 1;
        const latest = latestBySegment(candidates);
        const first = candidates[0];
        for (let index = 0; index < totalSegments; index += 1) {
            const candidate = latest.get(index);
            const job = candidate ? jobs.get(candidate.jobId) : null;
            const status = job ? candidateStatusOf(job.status) : candidate?.status;
            if (status === "done") continue;
            if (job && (status === "queued" || status === "running")) return { chainId, resumedFromSegment: index, job };
            const priorAttempts = existing.filter((item) => item.meta?.continuation?.segmentIndex === index).length;
            const prior = existing.find((item) => item.meta?.continuation?.segmentIndex === index)?.meta?.continuation || {};
            const chainPrompt = existing.map((item) => item.meta?.continuation?.prompt).find((text) => typeof text === "string" && text.trim()) ?? "";
            const resumed = await submitSegment({
                projectId,
                shotId,
                chainId,
                takeId: first.takeId ?? chainId,
                segmentIndex: index,
                totalSegments,
                prompt: prior.prompt ?? chainPrompt,
                seed: prior.seed ?? null,
                parentCandidateId: prior.parentCandidateId ?? null,
                attempt: priorAttempts,
            });
            return { chainId, resumedFromSegment: index, job: resumed };
        }
        return { chainId, resumedFromSegment: null, job: null };
    }

    /** 派生链视图（D35-1/D35-2）：从 clip 槽位候选按 chainId 分组，段状态以 Job 为准（候选兜底）。 */
    function listChains({ projectId, shotId } = {}) {
        const found = requireShot(projectId, shotId);
        const slot = clipSlot(found);
        const groups = new Map();
        for (const candidate of slot?.candidates || []) {
            if (!candidate.continuationChainId) continue;
            if (!groups.has(candidate.continuationChainId)) groups.set(candidate.continuationChainId, []);
            groups.get(candidate.continuationChainId).push(candidate);
        }
        const chains = [];
        for (const [chainId, members] of groups) {
            members.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
            const latest = latestBySegment(members);
            const totalSegments = members.map((c) => jobs.get(c.jobId)?.meta?.continuation?.totalSegments).find(Number.isInteger) ?? null;
            const segments = [...latest.entries()].sort((a, b) => a[0] - b[0]).map(([segmentIndex, candidate]) => {
                const job = jobs.get(candidate.jobId);
                return {
                    segmentIndex,
                    jobId: candidate.jobId,
                    status: job ? candidateStatusOf(job.status) : candidate.status,
                    artifactUrl: candidate.artifactUrl ?? null,
                    seam: candidate.continuation?.seam ?? null,
                    approvalStatus: candidate.approvalStatus ?? "pending",
                    needsReview: candidate.continuation?.seam?.needsReview === true,
                };
            });
            let status = "in_progress";
            if (segments.some((segment) => segment.status === "queued" || segment.status === "running")) status = "running";
            else if (segments.some((segment) => segment.status === "failed" || segment.status === "canceled")) status = "failed";
            else if (totalSegments !== null && segments.length === totalSegments && segments.every((segment) => segment.status === "done")) status = "done";
            const first = members[0];
            chains.push({
                chainId,
                takeId: first.takeId ?? chainId,
                parentCandidateId: first.parentCandidateId ?? null,
                status,
                segments,
            });
        }
        chains.sort((a, b) => String(a.chainId).localeCompare(String(b.chainId)));
        return { chains };
    }

    /** 接缝人工复核（D35-7）：写 continuation.seam.reviewed + reviewNote；候选/缝不存在按 404/409。 */
    function reviewSeam({ projectId, shotId, jobId, reviewed, note } = {}) {
        if (!["approved", "rejected"].includes(reviewed)) throw contractError(400, "CONTRACT_INVALID", 'reviewed 必须是 "approved" 或 "rejected"', "reviewed");
        const found = requireShot(projectId, shotId);
        const slotId = clipSlotId(found.shot.id);
        const slot = clipSlot(found);
        const id = asId(jobId);
        const candidate = (slot?.candidates || []).find((item) => item.jobId === id);
        if (!candidate) throw contractError(404, "CANDIDATE_NOT_FOUND", `候选不存在：${id ?? "(空)"}`, "jobId");
        if (!candidate.continuation?.seam) throw contractError(409, "SEAM_MISSING", `候选 ${id} 没有接缝指标（非续接段或 QC 未产出）`, "jobId");
        const { candidate: updated } = episodes.updateSlotCandidate(projectId, shotId, slotId, id, {
            continuation: {
                ...candidate.continuation,
                seam: { ...candidate.continuation.seam, reviewed, ...(note !== undefined && note !== null ? { reviewNote: String(note) } : {}) },
            },
        });
        return { candidate: updated };
    }

    /**
     * Job 终态消费（D35-4，与 M2 自动投影同一 change 事件流）：回写候选状态/产物；
     * done → 异步接续（QC + 下一段）；failed/canceled → 链停。返回接续 Promise 供测试 await（生产侧忽略）。
     */
    function handleTerminalJob(job) {
        const cont = job?.meta?.continuation;
        if (!cont || !job?.meta?.projectId || !job?.meta?.shotId || !job?.meta?.slotId) return null;
        const status = candidateStatusOf(job.status);
        if (lastWrittenStatus.get(job.id) !== status || status === "done") {
            try {
                episodes.updateSlotCandidate(job.meta.projectId, job.meta.shotId, job.meta.slotId, job.id, {
                    status,
                    ...(job.status === "done" ? { artifactUrl: (Array.isArray(job.outputs) ? job.outputs : []).find((output) => output?.url)?.url ?? null } : {}),
                });
                lastWrittenStatus.set(job.id, status);
            } catch (error) {
                // CANDIDATE_NOT_FOUND = 提交还在半路上（enqueue 的 change 事件先于候选写入），属正常时序，不告警。
                if (error.code !== "CANDIDATE_NOT_FOUND") console.warn(`[continuation] 候选回写失败 ${job.id}：${error.message}`);
            }
        }
        if (job.status !== "done") return null; // failed/canceled → 链停，等 resume / stalled 扫描
        return afterSegmentDone(job, cont).catch((error) => {
            console.warn(`[continuation] 段后处理失败 ${job.id}（链停在 seg${cont.segmentIndex}，可 resume 恢复）：${error.message}`);
        });
    }

    /**
     * stalled 链启动扫描（D35-3 重启可恢复）：最后一段 done、链未完成、没有 queued/running 段 → 续提交下一段。
     * 幂等键保证不重复：下一段已入队过（含失败）会命中原 Job，不新增。
     */
    async function scanStalledChains() {
        const byChain = new Map();
        for (const job of jobs.list() || []) {
            const cont = job?.meta?.continuation;
            if (!cont?.chainId || !job.meta?.projectId || !job.meta?.shotId) continue;
            if (!byChain.has(cont.chainId)) byChain.set(cont.chainId, []);
            byChain.get(cont.chainId).push(job);
        }
        let scanned = 0;
        let resumed = 0;
        for (const [chainId, members] of byChain) {
            scanned += 1;
            const active = members.some((job) => job.status === "queued" || job.status === "running");
            if (active) continue;
            const done = members.filter((job) => job.status === "done");
            if (!done.length) continue;
            const lastDone = done.reduce((a, b) => (a.meta.continuation.segmentIndex > b.meta.continuation.segmentIndex ? a : b));
            const cont = lastDone.meta.continuation;
            if (!Number.isInteger(cont.totalSegments) || cont.segmentIndex + 1 >= cont.totalSegments) continue;
            try {
                await submitSegment({
                    projectId: lastDone.meta.projectId,
                    shotId: lastDone.meta.shotId,
                    chainId,
                    takeId: cont.takeId,
                    segmentIndex: cont.segmentIndex + 1,
                    totalSegments: cont.totalSegments,
                    prompt: cont.prompt,
                    seed: cont.seed !== null && cont.seed !== undefined ? cont.seed + 1 : null,
                });
                resumed += 1;
            } catch (error) {
                console.warn(`[continuation] stalled 链续提交失败 ${chainId}/seg${cont.segmentIndex + 1}：${error.message}`);
            }
        }
        return { scanned, resumed };
    }

    return { startChain, startBranch, resumeChain, listChains, reviewSeam, submitSegment, handleTerminalJob, scanStalledChains };
}

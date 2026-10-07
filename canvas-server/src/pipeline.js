import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { splitNovelIntoChunks } from "./chunk-novel.js";
import { buildMixInput, resolveDialogueLines } from "./audio.js";
import { buildAudioTimeline } from "./audio-timeline.js";
import { projectAudioCues, projectVoiceProfiles } from "./audio-track.js";
import { ASSET_ROLE, AUDIO_MODE } from "./contracts.js";
import { assembleEpisode, buildCueSrt, DEFAULT_SUBTITLE_STYLE, probeMedia } from "./delivery.js";
// D1：模型时长档位（与「模型清单」同源）。骨架对齐、plan 时长校验都从这里取口径。
import { durationsForTemplate, durationMetaForTemplate, frameCountForDuration, skeletonAlignment } from "./durations.js";
import { artifactUrl, ensureDir, safeJoin } from "./files.js";
import { listTemplates } from "./providers/comfy.js";
import { buildShotBinding, missingRefsReport, resolveSelectedArtifacts, stableSeed } from "./reference-lock.js";
// 运行审计日志（追加式 log.jsonl）：谁、何时、对哪个阶段做了什么、产物指纹是什么。
import { appendRunLog, readRunLog } from "./run-log.js";
// 阶段产物契约校验（P0-g）：结构 + 引用完整性，纯函数。
import { checkStageArtifact, formatArtifactErrors } from "./stage-artifact-check.js";
import { buildQualityReport } from "./quality-check.js";
import { buildH3TalkParams } from "./h3-talk.js";
// 分辨率/画幅：片段 / 关键帧 / 成片尺寸一律经 sizeForRatio 从「模型官方规格登记表」取（不再实时按比例推导）。
import { sizeForRatio } from "./sizes.js";
// 平台音色库（唯一事实源）：命名音色 + 语种枚举 + 音色适配（原 pipeline 内的 qwen3Language/qwen3Speaker 已搬到这里）。
import { QWEN3_TTS_SPEAKERS, isLanguageAllowed, isSpeakerAllowed, qwen3Language, qwen3Speaker } from "./voices.js";
// 角色定妆身份卡契约层（锁脸锁声音）：纯逻辑归一 + design 脸产物读取 + 就绪度判定。
import { buildCastingOutput, castingReadiness, normalizeCasting } from "./casting.js";

// 提示词编译器：按所选模型把「模型无关的内容事实」编译成该模型要的提示词（图片/视频一视同仁）。
import { compilePromptForTemplate, compilePromptForTemplateAsync, presetForTemplate, stripUntranslatedMarker } from "./prompt-compiler.js";
// 台词归属口径跟着模型走：模型能力元数据（H3=(S1)+<d>；TTS=SPEAKER+INSTRUCT；纯视频/生图=无）。
import { templateCarriesDialogue } from "./dialogue-roles.js";
import { normalizeShotEpisodeIds, RUN_SHOT_ID_FIELD } from "./production-contracts.js";
import { loadRegistry, readSkill } from "./skills.js";
import { listReferenceCapableTemplates, resolveToolForShot, scanTemplateDir } from "./tool-adapter.js";

/** 生成型阶段：只构造生成任务参数并交给任务队列，不等真实产物。 */
const GENERATIVE_STAGES = new Set(["keyframe", "assembly"]);

/**
 * 阶段 → 入队 `job.kind`（= 模板 family）的**唯一来源**：正常入队与自动重试共用同一处取值，
 * 覆盖所有会（或曾经会）入队的阶段：design 出图、keyframe 出图、assembly/lipsync 出视频、audio 出音频、
 * casting 的遗留脸产物是图。自动重试不再从 `jobs` 映射倒推 kind（那条链可被污染：原 job 缺失 /
 * kind=undefined / jobId 被复用成别的 family），映射只当最后兜底。
 */
const STAGE_KIND = Object.freeze({ keyframe: "image", assembly: "video", audio: "audio", design: "image", casting: "image", lipsync: "video" });

/** 生成型阶段 → 可用模板 family：关键帧出图、片段出视频、配音出音频。仅用于 beginRegenerate 的门禁口径。 */
const STAGE_TEMPLATE_FAMILY = Object.freeze({ keyframe: STAGE_KIND.keyframe, assembly: STAGE_KIND.assembly, audio: STAGE_KIND.audio });

/** 需要绑定音色的声音类型（对白 / 旁白）——与 audio.js 的 DIALOGUE_TYPES 同语义。 */
const DIALOGUE_TYPES = new Set(["dialogue", "narration"]);

/** 生成型阶段 → 自动登记的 AssetRef.role（取值见 contracts.js 的 ASSET_ROLE，不自造枚举）：关键帧出图给 keyframe，片段/成片给 clip。 */
const GENERATIVE_STAGE_ASSET_ROLE = Object.freeze({ keyframe: ASSET_ROLE.KEYFRAME, assembly: ASSET_ROLE.CLIP });

/**
 * 因「角色定妆未完成 / 存在未确认角色」而阻断的下游阶段（E：未确认就拦住）。
 * 判据由 casting.js 的 castingReadiness 给出；拦住机制复用 #70 的 blocked 可见机制
 * （status=blocked + blockedReason/blockedMissing + 「运行本步」解禁），不另造一套。
 */
const CASTING_GATED_STAGES = new Set(["keyframe", "audio"]);

/** 阶段被 casting 门禁拦住时打的标记，用于「确认后精确解除」而不误清其它来源的 blocked。 */
const CASTING_BLOCK_FLAG = "casting";

/**
 * 为一条对白 Cue 解析说话角色的 VoiceProfile。
 * 分镜的 shot 常**没有** characterId，且台词里也不出现角色名 → 按「cue.voiceProfileId → cue.characterId →
 * 镜头台词/动作里出现的角色名」逐级回落；仍无法确定时用第一个 VoiceProfile 兜底（`fallback:true` 供上层告警），
 * 绝不静默丢失音频（硬约束：TTS 失败/归属不明不阻塞出片）。
 */
function resolveAudioProfile(cue, shot, { profileById, profileByCharacter, characters, profiles }) {
    let profile = cue.voiceProfileId ? profileById.get(String(cue.voiceProfileId)) : null;
    if (!profile && cue.characterId && profileByCharacter.has(String(cue.characterId))) profile = profileByCharacter.get(String(cue.characterId));
    if (!profile) {
        const text = [shot?.dialogue, shot?.action, shot?.prompt].filter(Boolean).join(" ");
        const hit = (Array.isArray(characters) ? characters : []).find((character) => character?.name && text.includes(String(character.name)));
        if (hit && profileByCharacter.has(String(hit.id))) profile = profileByCharacter.get(String(hit.id));
    }
    if (!profile && profiles.length) return { profile: profiles[0], fallback: true };
    return { profile: profile || null, fallback: false };
}

/** Job 终态：只有落到这里才回写流水线。 */
const TERMINAL_JOB = new Set(["done", "error", "canceled"]);

/** 01 剧本阶段的三个显式子步骤：读原文 → 分集规划 → 逐集剧本。进度与产物都按这三个 id 组织。 */
const SCRIPT_STEPS = Object.freeze([
    { id: "analyze", title: "读原文" },
    { id: "outline", title: "分集规划" },
    { id: "script", title: "逐集剧本" },
]);

/** 阶段技能里分步提示词所在的小节名；缺失时用编排器内置兜底提示词。 */
const SCRIPT_STEP_SECTIONS = Object.freeze({ outline: "分集规划提示词", script: "逐集剧本提示词" });

/** 带 HTTP 状态码的业务错误：路由层据此回 400/409，不再一律 400（门禁拒绝路径需要区分）。 */
function gateError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/**
 * 胶片 / 写实介质类关键词：只有最终风格锚点命中它们，才允许叠加 Luster 冻结胶片层。
 * 「二维动画」这类锚点一律不命中 → 胶片层默认关闭，杜绝「二维动画 + 35mm 胶片」自相矛盾。
 */
const FILM_ANCHOR_PATTERN = /胶片|菲林|写实|实拍|film|photographic|photoreal|analog|kodak|35mm|grain|颗粒|live[-\s]?action/i;

/** Luster 冻结胶片层（风格层 + 焦点层 + 色彩公式），作为「条件叠加层」由本模块按锚点判定后追加。 */
const LUSTER_FILM_LAYER =
    "overexposure melting contours golden rim on hair, grey-blue shadows, fine grain, light leak upper right, 1/100s shutter, tack-sharp";

/** 缺项目/run 锚点时的中性兜底锚点：只声明画面方向，不写死任何介质，避免非胶片项目被套上胶片词。 */
const NEUTRAL_STYLE_ANCHOR = "统一视觉方向，自然光，干净画面";

/**
 * 生成提示词的风格出口（唯一）：首句锚点只在这里保证在场。
 * - `style.anchor` 已由 LLM 写在正文首句（buildContext 注入了 styleAnchor）时不再重复前置，去掉「两头写」；
 * - `style.filmLayer` 为空（锚点非胶片类）时绝不叠加胶片层，只有锚点命中胶片类关键词才追加；
 * - 传空 style（未绑项目且 run.options 无锚点）时原样返回，保证旧行为逐字不变。
 */
function withPromptHead(style, text) {
    const body = String(text ?? "").trim();
    const anchor = String(style?.anchor ?? "").trim();
    const context = String(style?.context ?? "").trim();
    let head;
    if (!context) head = body;
    else if (anchor && body.startsWith(anchor)) head = body; // 锚点已在首句 → 不重复前置
    else head = body ? `${context}。${body}` : context;
    const layer = String(style?.filmLayer ?? "").trim();
    return layer ? `${head} ${layer}`.trim() : head;
}

/**
 * 采样参数交给「规则表参数档」(prompt-compiler.presetForTemplate → model-rules.presetFor)，
 * **不硬编码** steps/cfg/sampler：仅当模板真的声明了对应 token 且调用方未显式给值时才回填。
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

function nowIso() {
    return new Date().toISOString();
}

/** Crockford Base32（去掉易混的 I/L/O/U），用于从哈希派生稳定 id 片段。 */
const ID_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 由 (projectId, 分镜 shot id) 派生稳定的 `sh_` 主键（契约 §3.4：手写 `sh_<创建时生成>`）。
 * 同输入恒同值：关键帧投影重复执行也只会拿到同一个 id，绝不重复建镜（幂等前提）。
 */
function derivedShotId(projectId, storyboardShotId) {
    const digest = createHash("sha256").update(`${projectId}:${storyboardShotId}`).digest();
    let text = "";
    for (let index = 0; text.length < 26; index += 1) text += ID_BASE32[digest[index % digest.length] % 32];
    return `sh_${text}`;
}

/** 取结尾阿拉伯数字（sc1 / sc_0001 / scene-3 → 1/1/3）；抽不出返回 null。仅用于场次跨命名体系比对。 */
function trailingNumber(value) {
    const match = String(value ?? "").trim().match(/(\d{1,6})\s*$/);
    return match ? Number(match[1]) : null;
}

/**
 * textOverlays 的 kind → 画面里该类文字的语义前缀。
 * 只描述「这是什么文字」，文字内容（text）逐字照抄不改写、不翻译（04-keyframes「图上文字必须逐字指定」）。
 * kind 取值见 04-keyframes 契约：sign | ticket | screen | logo | subtitle | none。
 */
const TEXT_OVERLAY_KIND_LABEL = Object.freeze({
    sign: "sign reading",
    ticket: "ticket text",
    screen: "screen text",
    logo: "logo text",
    subtitle: "subtitle text",
});

/**
 * 把本帧的 textOverlays 逐字拼成一段英文画面描述子句，供关键帧 PROMPT 使用（修 #39：不写文字 → 出伪文字）。
 * - 只取 text 非空且 kind !== "none" 的条目；全为 none / 缺字段时返回空串（绝不拼空串、绝不报错）；
 * - 文字内容原样照抄（中文不翻译）；
 * - 契约缺字段（kind 非法 / 缺 position / 缺 style）只由调用方记 QC warning，这里只负责拼。
 */
function textOverlayClause(overlays) {
    if (!Array.isArray(overlays)) return "";
    const parts = [];
    for (const raw of overlays) {
        if (!raw || typeof raw !== "object") continue;
        const text = raw.text === undefined || raw.text === null ? "" : String(raw.text);
        if (!text.trim()) continue;
        const kind = String(raw.kind ?? "").trim().toLowerCase();
        if (!kind || kind === "none") continue;
        const label = TEXT_OVERLAY_KIND_LABEL[kind] || "text";
        const position = String(raw.position ?? "").trim();
        const style = String(raw.style ?? "").trim();
        parts.push(`${label} "${text}"${position ? ` at ${position}` : ""}${style ? ` in ${style}` : ""}`);
    }
    if (!parts.length) return "";
    return `on-screen text rendered verbatim: ${parts.join(", ")}`;
}

/** /api/artifacts/<jobId>/<filename> → 磁盘路径（逐段解码，保证与写入时的文件名一致）。非本网关产物地址返回 null。 */
function artifactFilePath(config, url) {
    const text = String(url ?? "");
    const marker = "/api/artifacts/";
    const at = text.indexOf(marker);
    if (at < 0) return null;
    const segments = text.slice(at + marker.length).split("/").filter(Boolean);
    if (segments.length < 2) return null;
    let decoded;
    try {
        decoded = segments.map((segment) => decodeURIComponent(segment));
    } catch {
        return null;
    }
    return safeJoin(config?.dataDir || "data", "artifacts", ...decoded);
}

/** 该产物 URL 在本网关磁盘上是否真的存在（回写时断言，杜绝 #40 那样「索引指向不存在的文件」）。 */
function artifactUrlResolves(config, url) {
    const file = artifactFilePath(config, url);
    return Boolean(file && existsSync(file));
}

/**
 * 回写时选一个「真的存在」的产物 URL：优先 ComfyUI 回报的首个产物，其次本 job 自己的其它产物。
 * 只在本 job 声明的 outputs 里挑，绝不反向「扫描目录取最新」——保证写进索引的 URL 指向本 job 写下的文件。
 */
function resolvingOutputUrl(config, job) {
    const urls = (Array.isArray(job?.outputs) ? job.outputs : []).map((output) => output?.url).filter((url) => typeof url === "string" && url);
    if (!urls.length) return null;
    return urls.find((url) => artifactUrlResolves(config, url)) || urls[0];
}

/**
 * ComfyUI 的 OUTPUT_PREFIX：按「run + 条目」生成，让文件名序号只在同一条目内递增。
 * 根因（#40）：此前 OUTPUT_PREFIX 缺省由 job.name（条目 id，跨 run 复用）派生，序号是 ComfyUI 输出目录里的
 * 全局计数器 → 不同 run 的同一 item 共用前缀，索引里的文件名不受本 run 掌控。按 run+条目隔离后，
 * 该 job 产出/下载的文件名确定且唯一，写入索引的 URL 必然指向本 job 写下的文件。
 */
function outputPrefixFor(runId, itemId) {
    const clean = (value) => String(value ?? "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    return `canvas/${clean(runId) || "run"}_${clean(itemId) || "item"}`;
}

/** 对口型（lipsync）条目 id：由源片段 id 派生，稳定可幂等（同一片段只对应一条对口型条目）。 */
function lipsyncItemId(sourceClipId) {
    return `${String(sourceClipId ?? "clip")}-lipsync`;
}

/**
 * 每次 attempt 换一个新的 seed：既是 LatentSync 的生成参数，也作为「同输入命中 ComfyUI 执行缓存 →
 * `/history` 返回空 outputs」的**缓存击穿**手段（任务不得假定提交后一定拿得到产物路径）。
 * 对口型是「改一句台词才重跑」的后处理，换 seed 的重跑成本可接受且换来确定可得的产物。
 */
function freshSeed() {
    return Math.floor(Math.random() * 2147483647);
}

/** 阶段产物条目：关键帧用 frames、片段合成用 clips、服化道参考图用 references、配音用 audio（顺序即优先级）。 */
function stageOutputItems(stage) {
    return stage?.output?.frames || stage?.output?.clips || stage?.output?.references || stage?.output?.audio || [];
}

/** 从模型输出里抠出 JSON 对象，容忍 Markdown 代码块与前后解释文字。 */
function parseJsonLoose(text) {
    let value = String(text ?? "").trim();
    if (!value) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
    if (fenced) value = fenced[1].trim();
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(value.slice(start, end + 1));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** 取 SKILL.md 里某个二级章节的正文，用于抽出「提示词模板」。 */
function extractSection(markdown, title) {
    const lines = String(markdown ?? "").split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `## ${title}`);
    if (start < 0) return "";
    const body = [];
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^##\s/.test(lines[index])) break;
        body.push(lines[index]);
    }
    return body.join("\n").trim();
}

/** 填充 {{key}} / {{a.b}} 占位；未知占位原样保留，便于用户发现写错的 key。 */
function fillTemplate(text, context) {
    return String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
        const value = key.split(".").reduce((acc, part) => (acc === undefined || acc === null ? acc : acc[part]), context);
        if (value === undefined) return match;
        return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    });
}

/**
 * 五段式流水线编排器。
 * comfy 只作为能力依赖传入，真实生图/生视频执行体通过 runJob 注入（index.js 传 runGenerationJob）；
 * 没有 runJob 时生成型阶段只构造任务参数并标记 queued，不伪造产物。
 * assemble 是「片段 → 成片」的后期执行体，默认用 delivery.js 的 assembleEpisode；
 * 编排器只负责判定何时拼接、把清单与参数交给它，ffmpeg 命令构造与执行都留在 delivery.js。
 */
export function createPipeline({ config, skillsDir, jobs, comfy, llm, llmCall, runJob, assemble = assembleEpisode, getProject, applyPlanSuggestion, applyScriptProjection, applyEpisodeProjection, attachProjectRun, registerAssetRef, updateAssetRef, projectCanvasJob } = {}) {
    const pipelineConfig = config?.pipeline || {};
    // 半自动总开关：注入 getProject（项目化模式）时才启用「单镜失败自动重试」。
    // 未注入时一律保持旧的「失败即止」行为；plan 驱动参数靠 projectOf 返回 null 自然回落，不需要额外开关。
    const autoRetryEnabled = typeof getProject === "function";
    // 单镜失败自动重试次数：pipeline.maxItemRetries 可配，默认 2；用尽后阶段自然落到 error/partial。
    const maxItemRetries =
        Number.isFinite(Number(pipelineConfig.maxItemRetries)) && Number(pipelineConfig.maxItemRetries) >= 0 ? Math.floor(Number(pipelineConfig.maxItemRetries)) : 2;
    // D3：单镜一次入队的候选数（≥4）。maxKeyframesPerShot 既是 04-keyframes 提示词里的单镜帧数上限，
    // 也是关键帧阶段每条目一次入队的候选数 —— 产品拍板「一次生产 4 张以上，不达标就重新生成」。
    // 未配置时按 1（旧行为）保底；仓库 config.json / config.example.json / config.js 默认均为 4；上限 8。
    const maxKeyframesPerShot = (() => {
        const raw = Number(pipelineConfig.maxKeyframesPerShot);
        const value = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
        return Math.min(Math.max(value, 1), 8);
    })();
    // 关键帧阶段每条目「一次入队」的候选数；视频阶段仍是 1。
    const candidatesPerEnqueue = (stageId) => (stageId === "keyframe" ? maxKeyframesPerShot : 1);
    const runsDir = ensureDir(join(config?.dataDir || "data", "runs"));
    const registry = loadRegistry(skillsDir);
    const stageDefs = new Map(registry.stages.map((item) => [item.id, item]));
    // 模板名 → family（image/video/edit/upscale）。regenerate 用它校验「换的模型属于该阶段该出图还是出视频」。
    const templateFamilies = new Map(listTemplates(config?.workflowsDir).map((template) => [template.name, template.family]));
    // 模板 → 真实输入能力（有无 LoadImage / 最多几张参考图）。tool-adapter 只看节点，不认文件名，换模板也自动识别。
    const templateCatalog = scanTemplateDir(config?.workflowsDir);

    // 语言适配（按模型改写提示词）出口：由 index.js 注入 llm-client 的 llmCall；未注入时保持同步行为（测试/离线）。
    const rewriteLlmCall = typeof llmCall === "function" ? llmCall : null;
    // 编译快照随 stage.output 的 item 持久化，不放进进程内 Map：重启、重跑和多进程回写都必须有同一份可追溯输入。
    // 快照只服务于本次 attempt 的入队；显式重跑会强制重新编译并生成新 job，旧 job 的 params 永不改写。

    const runFile = (runId) => safeJoin(runsDir, String(runId), "run.json");
    const stageFile = (runId, stageId) => safeJoin(runsDir, String(runId), `${stageId}.json`);
    const progressFile = (runId) => safeJoin(runsDir, String(runId), "progress.json");
    const chunksDir = (runId) => safeJoin(runsDir, String(runId), "chunks");
    const chunkFile = (runId, index) => safeJoin(chunksDir(runId), `${Number(index)}.json`);
    const qcFile = (runId, reportId) => safeJoin(runsDir, String(runId), "qc", `${String(reportId)}.json`);

    function readJsonFile(file) {
        if (!file || !existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            console.warn(`[pipeline] 文件损坏，按空处理：${file}（${error.message}）`);
            return null;
        }
    }

    /** 临时文件 + 同目录 rename：run.json / 阶段产物是全量重写的大文件，写窗口内被杀不能留下截断 JSON（照 projects.js 写法）。 */
    function writeJsonAtomic(file, value) {
        ensureDir(dirname(file));
        const temp = `${file}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(temp, JSON.stringify(value, null, 2));
        renameSync(temp, file);
    }

    function saveRun(run) {
        run.updatedAt = nowIso();
        ensureDir(join(runsDir, run.id));
        writeJsonAtomic(runFile(run.id), run);
        return run;
    }

    function saveOutput(runId, stageId, output) {
        writeJsonAtomic(stageFile(runId, stageId), output);
    }

    /**
     * 阶段进度写在独立的小文件里，**不写 run.json**：run.json 内嵌整本小说，
     * 222 万字的书有 6.4MB，逐块 saveRun 会产生上百次全量重写，前端每 3 秒轮询
     * 也要每次拖 6.4MB。progress.json 只有几十字节。
     */
    function writeProgress(runId, progress) {
        const file = progressFile(runId);
        if (!file) return;
        ensureDir(join(runsDir, String(runId)));
        try {
            writeFileSync(file, JSON.stringify({ ...progress, updatedAt: nowIso() }));
        } catch (error) {
            console.warn(`[pipeline] 进度写入失败（不影响生成）：${error.message}`);
        }
    }

    const readProgress = (runId) => readJsonFile(progressFile(runId));

    function saveQcReport(runId, report) {
        const file = qcFile(runId, report.id);
        ensureDir(dirname(file));
        writeJsonAtomic(file, report);
        writeJsonAtomic(safeJoin(runsDir, String(runId), "qc", "latest.json"), report);
        return report;
    }

    function qualityCheck(runId, { stage = null } = {}) {
        const run = requireRun(runId);
        if (stage && !stageDefs.has(String(stage))) throw gateError(`未知质检阶段：${stage}`);
        const report = buildQualityReport({ run, stageUpstream: () => stageUpstreamOf(run), stage });
        report.inputHash = outputHash(run.stages);
        return saveQcReport(runId, report);
    }

    function latestQualityCheck(runId) {
        const run = requireRun(runId);
        const report = readJsonFile(safeJoin(runsDir, String(runId), "qc", "latest.json"));
        return report ? { ...report, stale: report.inputHash !== outputHash(run.stages) } : null;
    }

    function clearProgress(runId) {
        try {
            rmSync(progressFile(runId), { force: true });
        } catch {
            /* 不存在即可 */
        }
    }

    /**
     * 每块的 map 结果单独落盘，重跑时跳过已完成的块。
     * 163 块 / 83 分钟的任务，中途崩溃或重启不该从头再来一遍。
     */
    function saveChunkPartial(runId, index, partial) {
        const dir = chunksDir(runId);
        const file = chunkFile(runId, index);
        if (!dir || !file) return;
        ensureDir(dir);
        writeFileSync(file, JSON.stringify(partial));
    }

    const readChunkPartial = (runId, index) => readJsonFile(chunkFile(runId, index));

    function clearChunks(runId) {
        try {
            rmSync(chunksDir(runId), { recursive: true, force: true });
        } catch {
            /* 不存在即可 */
        }
    }

    /** 已落盘的块结果数，用于 resume 时告诉用户能省下多少。 */
    function countChunks(runId) {
        const dir = chunksDir(runId);
        if (!dir || !existsSync(dir)) return 0;
        try {
            return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
        } catch {
            return 0;
        }
    }

    function get(id) {
        const run = readJsonFile(runFile(id));
        return run && typeof run === "object" ? run : null;
    }

    function list() {
        const runs = [];
        for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const run = get(entry.name);
            if (run) runs.push(run);
        }
        return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    function requireRun(id) {
        const run = get(id);
        if (!run) throw new Error(`流水线不存在：${id}`);
        return run;
    }

    function requireStageDef(stageId) {
        const def = stageDefs.get(String(stageId));
        if (!def) throw new Error(`未知阶段：${stageId}`);
        return def;
    }

    function requireStage(run, def) {
        const stage = run.stages?.[def.id];
        if (!stage) throw new Error(`流水线缺少阶段：${def.id}`);
        return stage;
    }

    function stages() {
        return registry.stages;
    }

    /**
     * 上游阻断判定：基于上游阶段的**真实产物与状态**给出可解释原因（不再只看一个状态码）。
     * 覆盖：缺上游阶段 / 未产出 / error / partial / running / canceled；产物齐且状态 done 才通过。
     */
    function upstreamBlock(depId, dep) {
        const title = dep?.title || depId;
        if (!dep) return { type: "missing", stageId: depId, message: `请先完成 ${title}（流水线里没有这个阶段）` };
        const prefix = `请先完成 ${title}`;
        if (dep.status === "done" && dep.output !== undefined && dep.output !== null) return null;
        if (dep.status === "error") return { type: "upstream", stageId: depId, message: `${prefix}（上游运行失败：${dep.error || "原因未知"}；请先修复或重跑）` };
        if (dep.status === "partial") return { type: "upstream", stageId: depId, message: `${prefix}（上游仅部分完成，存在失败条目；请先处理）` };
        if (dep.status === "running") return { type: "upstream", stageId: depId, message: `${prefix}（上游仍在运行中，请等它结束）` };
        if (dep.status === "canceled") return { type: "upstream", stageId: depId, message: `${prefix}（上游已取消）` };
        if (dep.output === undefined || dep.output === null) return { type: "upstream", stageId: depId, message: `${prefix}（上游尚未产出产物，当前状态：${dep.status || "pending"}）` };
        return { type: "upstream", stageId: depId, message: `${prefix}（上游状态异常：${dep.status}）` };
    }

    /**
     * 阶段门禁：基于真实产物判定某阶段能否进入，返回 `{ stageId, title, ready, reason, blockedBy }`。
     * - 缺源：入口阶段（requires 为空，即剧本）必须有小说原文 novel；
     * - 上游未产出 / error / partial / running / canceled 一律阻断，并给出可读原因。
     */
    function stageGate(run, stageId) {
        const def = stageDefs.get(String(stageId));
        if (!def) return { stageId: String(stageId), title: String(stageId), ready: false, reason: `未知阶段：${stageId}`, blockedBy: [{ type: "unknown", message: `未知阶段：${stageId}` }] };
        const blockedBy = [];
        if (!def.requires.length && !String(run?.novel ?? "").trim()) blockedBy.push({ type: "source", message: "缺少小说原文（novel），无法开始剧本阶段" });
        for (const depId of def.requires) {
            const block = upstreamBlock(depId, run?.stages?.[depId]);
            if (block) blockedBy.push(block);
        }
        // E：角色定妆门禁 —— casting 阶段已产出（done）但存在未确认角色时，keyframe / audio 也要拦住，
        // 并逐角色写清缺脸还是缺声（复用 #70 的 blocked 可见机制，不静默降级）。
        // 仅在「注册表里有 casting 阶段 且 本 run 里有 casting 阶段」时生效（旧注册表 / 存量 run 行为不变）。
        if (stageDefs.has("casting") && CASTING_GATED_STAGES.has(def.id)) {
            const castingStage = run?.stages?.casting;
            if (castingStage && castingStage.status === "done") {
                const readiness = castingReadiness(castingStage.output);
                if (!readiness.ready) blockedBy.push({ type: "casting", stageId: "casting", message: readiness.reason });
            }
        }
        const ready = blockedBy.length === 0;
        return { stageId: def.id, title: def.title, ready, reason: ready ? "可运行（上游已就绪）" : blockedBy.map((item) => item.message).join("；"), blockedBy };
    }

    /** 流水线全阶段门禁视图（纯推导，不落盘）：供 GET /runs/:id/gates，项目页据此不必再靠 runIds[0] 猜。 */
    function stageGates(runId) {
        const run = requireRun(runId);
        return registry.stages.map((def) => stageGate(run, def.id));
    }

    /**
     * 分镜定点编辑：按 shotId 局部更新 storyboard 阶段产物里的单个 shot，而不是整段 setStageInput 替换 JSON。
     * 只合并传入字段、保留 shot.id（契约 §3.4：Shot.id 稳定不可改）；其它 shot 与阶段其余字段一律不动。
     */
    function patchStageShot(runId, stageId, shotId, patch = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        if (def.id !== "storyboard") throw gateError(`只有分镜（storyboard）阶段支持按镜头定点编辑，当前阶段：${def.title}`);
        const stage = requireStage(run, def);
        const shots = stage.output?.shots;
        if (!Array.isArray(shots) || !shots.length) throw gateError("分镜阶段还没有产物，无法定点编辑");
        const id = String(shotId ?? "");
        const index = shots.findIndex((shot) => shot && shot.id === id);
        if (index < 0) throw gateError(`分镜里没有镜头：${id}`, 404);
        const body = patch && typeof patch === "object" ? patch : {};
        if (body.id !== undefined && String(body.id) !== id) throw gateError("镜头 id 稳定不可改");
        const merged = { ...shots[index], ...body, id };
        shots[index] = merged;
        saveOutput(run.id, def.id, stage.output);
        saveRun(run);
        return { run, shot: merged };
    }

    /**
     * 开跑前就能给出的成本预估。口径必须与 composeWithLlm 的分块判定完全一致 ——
     * 那边比的是**填充后的 prompt 长度**（含 SKILL.md 模板），不是小说字数。
     * estSecondsPerChunk 默认 31：实测 222 万字 / 163 块 / 83 分钟 ≈ 30.5s/块（deepseek-flash）。
     */
    function estimateFor(run) {
        const def = stageDefs.get("script");
        const maxChunkChars = Number(pipelineConfig.maxNovelChunkChars) || 16000;
        const perChunkSeconds = Number(pipelineConfig.estSecondsPerChunk) > 0 ? Number(pipelineConfig.estSecondsPerChunk) : 31;
        const novel = String(run?.novel || "");
        let promptChars = novel.length;
        if (def) {
            try {
                promptChars = fillTemplate(readPromptTemplate(def), buildContext(run, def)).length;
            } catch {
                /* SKILL.md 读不到时退回按正文字数估 */
            }
        }
        const chunked = promptChars > maxChunkChars;
        const chunks = chunked ? splitNovelIntoChunks(novel, maxChunkChars).length : 1;
        const llmCalls = chunked ? chunks + 1 : 1; // N 次 map + 1 次 reduce
        return {
            novelChars: novel.length,
            promptChars,
            maxChunkChars,
            chunked,
            chunks,
            llmCalls,
            perChunkSeconds,
            estSeconds: llmCalls * perChunkSeconds,
            resumableChunks: countChunks(run?.id),
        };
    }

    function create({ novel, title, options, actor } = {}) {
        const text = String(novel ?? "").trim();
        if (!text) throw new Error("缺少小说正文 novel");
        const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const now = nowIso();
        const opts = options && typeof options === "object" ? options : {};
        const projectId = String(opts.projectId ?? "").trim();
        // 建 run 时快照项目当前源版本（sourceRevisionId）：任何时候都能追溯「这条 run 用的是哪一版原文」。
        const project = projectId ? projectById(projectId) : null;
        const run = {
            id,
            title: String(title ?? "").trim() || "未命名流水线",
            novel: text,
            options: opts,
            sourceRevisionId: project?.sourceRevisionId ?? null,
            createdAt: now,
            updatedAt: now,
            stages: {},
        };
        for (const def of registry.stages) {
            run.stages[def.id] = { id: def.id, title: def.title, status: "pending", inputs: {}, output: null, artifacts: [] };
        }
        // 创建时就算好成本预估：163 块 / 83 分钟这种量级必须让用户在点「开始」之前看到
        run.estimate = estimateFor(run);
        const saved = saveRun(run);
        // 服务端幂等把 run 追加进项目 runIds（未注入/未绑项目时为空操作）：修掉「从流水线页建的 run 不进 runIds」的缺口。
        if (projectId) attachRunToProject(projectId, saved.id);
        appendRunLog(runsDir, saved.id, {
            op: "run.create",
            actor: actorOf({ actor }),
            message: `创建流水线「${saved.title}」${projectId ? `（项目 ${projectId}）` : ""}`,
        });
        return saved;
    }

    /**
     * 从已有流水线创建可逆分支。分支共享上游只读产物引用，从指定阶段开始清空状态，
     * 后续重跑只会产生新的 Job/Artifact，不会覆盖父 run 的任何候选。
     */
    function fork(runId, { fromStage = "script", title, options, actor } = {}) {
        const parent = requireRun(runId);
        const start = stageDefs.get(String(fromStage));
        if (!start) throw gateError(`未知分支起始阶段：${fromStage}`);
        const startIndex = registry.stages.findIndex((stage) => stage.id === start.id);
        if (registry.stages.slice(0, startIndex).some((def) => parent.stages[def.id]?.status === "running")) {
            throw gateError("上游阶段正在运行，请等待完成后再创建分支", 409);
        }
        const now = nowIso();
        const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const inherited = JSON.parse(JSON.stringify(parent));
        const opts = options && typeof options === "object" ? options : {};
        const run = {
            ...inherited,
            id,
            title: String(title ?? "").trim() || `${parent.title} · 分支 ${start.title}`,
            createdAt: now,
            updatedAt: now,
            options: { ...(parent.options || {}), ...opts, branchOf: parent.id, branchFrom: start.id },
            branchOf: parent.id,
            branchFrom: start.id,
        };
        for (let index = startIndex; index < registry.stages.length; index += 1) {
            const def = registry.stages[index];
            run.stages[def.id] = { id: def.id, title: def.title, status: "pending", inputs: {}, output: null, artifacts: [] };
        }
        run.estimate = estimateFor(run);
        const saved = saveRun(run);
        for (const def of registry.stages.slice(0, startIndex)) {
            if (run.stages[def.id]?.output) saveOutput(saved.id, def.id, run.stages[def.id].output);
        }
        const projectId = String(run.options?.projectId ?? "").trim();
        if (projectId) attachRunToProject(projectId, saved.id);
        appendRunLog(runsDir, saved.id, {
            op: "run.fork",
            actor: actorOf({ actor }),
            message: `从 ${parent.id} 的 ${start.title} 创建分支`,
            parentRunId: parent.id,
            fromStage: start.id,
        });
        return saved;
    }

    /** 人工修订产物：body `{ output: <该阶段产物 JSON> }` 时置为 done 并落盘，下游立即可用；其余键合并进 inputs。 */
    function setStageInput(runId, stageId, patch = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        const body = patch && typeof patch === "object" ? patch : {};
        if (body.output !== undefined) {
            // 人工改产物同样要过契约校验：引用断裂的产物放进流水线，下游只会更晚炸。
            const artifactCheck = checkStageArtifact(def.id, body.output, stageUpstreamOf(run));
            if (!artifactCheck.ok) throw gateError(formatArtifactErrors(artifactCheck.errors), 400);
            stage.output = body.output;
            stage.status = "done";
            stage.error = undefined;
            stage.finishedAt = stage.finishedAt || nowIso();
            // 人工修订 casting 产物（含确认）后立即重算 casting 门禁：确认齐 → 解除 keyframe/audio 的阻断。
            if (def.id === "casting") enforceCastingGate(run);
            saveOutput(run.id, def.id, body.output);
            appendRunLog(runsDir, run.id, {
                op: "stage.edit",
                actor: actorOf(body),
                stage: def.id,
                hash: outputHash(body.output),
                ok: true,
                message: `人工修订 ${def.title} 产物`,
            });
        } else {
            stage.inputs = { ...stage.inputs, ...body };
        }
        return saveRun(run);
    }

    /**
     * 把 novel、流水线配置与全部已产出的上游产物组装成模板上下文，上游 key 用该阶段 produces 的名字。
     * 风格维度只在这里注入事实源：项目级 styleAnchor（其次 run.options.styleAnchor）写进 options.styleAnchor，
     * 使技能里的 {{options.styleAnchor}} 一定能被替换；缺锚点时给中性兜底，绝不让占位符原样漏给模型。
     * 时长维度同理：**推荐档与单集目标时长都在这里注入 options**，技能直接用
     * {{options.videoDurationTiers}} / {{options.videoDurationMeta}} / {{options.episodeDurationSec}} / {{options.episodeCount}}，
     * 不再让模型自己猜「单镜该多长」（这是分镜产出失控的根因）。不改 context 顶层键，避免影响其它阶段模板。
     */
    function buildContext(run, def) {
        const project = projectOf(run);
        const plan = project?.plan && typeof project.plan === "object" ? project.plan : {};
        const constraints = planConstraints(run);
        const videoTemplate = String(pipelineConfig.videoTemplate ?? "").trim();
        const context = {
            novel: run.novel,
            title: run.title,
            options: {
                ...(run.options || {}),
                styleAnchor: resolveStyleAnchor(run) || NEUTRAL_STYLE_ANCHOR,
                plan,
                videoDurationTiers: durationsForTemplate(videoTemplate),
                videoDurationMeta: durationMetaForTemplate(videoTemplate),
                episodeDurationSec: constraints.episodeDurationSec,
                episodeCount: constraints.episodeCount,
            },
            pipeline: pipelineConfig,
        };
        for (const item of registry.stages) {
            if (item.id === def.id) continue;
            const output = run.stages?.[item.id]?.output;
            if (output !== undefined && output !== null) context[item.produces[0] || item.id] = output;
        }
        return context;
    }

    function readPromptTemplate(def) {
        const template = extractSection(readSkill(skillsDir, def.skill), "提示词模板");
        if (!template) throw new Error(`技能 ${def.skill} 缺少「## 提示词模板」章节`);
        return template;
    }

    function resolveModel(run, stageId) {
        // 按阶段绑定的模型优先，其次整条流水线的 llmModel，最后网关默认
        const selected = String(run.options?.stageModels?.[stageId] ?? "").trim();
        // 设计/关键帧/配音/合成阶段的选择值可能是 Comfy 模板；它们不能被误传给 LLM 的 chat。
        const textModel = selected && !templateCatalog[selected] ? selected : "";
        return textModel || run.options?.llmModel || pipelineConfig.llmModel || "";
    }

    function configuredTemplateForStage(run, stageId, family) {
        const selected = String(run?.options?.stageModels?.[stageId] ?? "").trim();
        const info = templateCatalog[selected];
        if (!info) {
            const fallback = family === "video" ? pipelineConfig.videoTemplate : family === "audio" ? pipelineConfig.audioTemplate : pipelineConfig.imageTemplate;
            return String(fallback ?? "").trim();
        }
        if (family === "image" && ["image", "edit", "upscale"].includes(info.family)) return selected;
        if (info.family === family || (family === "audio" && (selected.startsWith("audio_") || info.tokens?.includes("TTS_TEXT")))) return selected;
        const fallback = family === "video" ? pipelineConfig.videoTemplate : family === "audio" ? pipelineConfig.audioTemplate : pipelineConfig.imageTemplate;
        return String(fallback ?? "").trim();
    }

    async function chat(messages, run, temperature, stageId, provider, signal) {
        if (typeof llm?.chat !== "function") throw new Error("未配置 LLM 提供方");
        if (signal?.aborted) throw new Error("已取消");
        const options = { messages, temperature, response_format: { type: "json_object" } };
        const model = resolveModel(run, stageId);
        if (model) options.model = model;
        // 浏览器渠道透传的外部 API（仅本次调用生效，不落盘）
        if (provider) options.provider = provider;
        if (signal) options.signal = signal;
        const result = await llm.chat(options);
        return result?.choices?.[0]?.message?.content ?? "";
    }

    /** 调一次模型并解析 JSON，失败带原文重试一次；再失败抛出带 raw 的错误。signal 为阶段取消信号。 */
    async function askJson(messages, run, stageId, provider, temperature = 0.6, signal) {
        const first = await chat(messages, run, temperature, stageId, provider, signal);
        const parsed = parseJsonLoose(first);
        if (parsed) return parsed;
        // 已取消就别再补一次重试调用，否则用户点了停止还要多等一次完整的模型往返
        if (signal?.aborted) throw new Error("已取消");
        const retry = await chat(
            [...messages, { role: "assistant", content: String(first ?? "") }, { role: "user", content: "你上一次的输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块、不要任何解释。" }],
            run,
            0,
            stageId,
            provider,
            signal,
        );
        const retried = parseJsonLoose(retry);
        if (retried) return retried;
        const error = new Error("模型未返回合法 JSON");
        error.raw = String(retry ?? first ?? "");
        throw error;
    }

    /**
     * 01 剧本分块路径与阶段技能共用同一份「内容创作红线（硬约束）」：直接抽取 SKILL.md 的
     * `## 内容创作红线（硬约束）` 正文供 map（逐块提取）与 reduce（合并成篇）两个提示词复用，
     * 不再在两处各写一遍逐字重复的硬编码字符串。技能缺该节时返回空串，退回无红线的旧形态。
     */
    function scriptRedlines(def) {
        try {
            return extractSection(readSkill(skillsDir, def.skill), "内容创作红线（硬约束）").trim();
        } catch {
            return "";
        }
    }

    /** 抽出阶段技能里的分步提示词正文（如「## 分集规划提示词」）；缺失返回空串，调用方用内置兜底。 */
    function readStepTemplate(def, section) {
        try {
            return extractSection(readSkill(skillsDir, def.skill), section).trim();
        } catch {
            return "";
        }
    }

    /** 分集硬约束来源：绑定项目的 plan 优先，其次 run.options（未绑项目时的过渡位）。 */
    function planConstraints(run) {
        const project = projectOf(run);
        const plan = project?.plan && typeof project.plan === "object" ? project.plan : {};
        const options = run?.options || {};
        const count = Number(plan.episodeCount) || Number(options.episodeCount) || 0;
        const durationSec = Number(plan.episodeDurationSec) || Number(options.episodeDurationSec) || 0;
        return { episodeCount: count > 0 ? Math.floor(count) : 0, episodeDurationSec: durationSec > 0 ? durationSec : 0 };
    }

    /**
     * 初始化 stage.steps：reset=true 时全部重置为 pending；否则沿用已有状态与产物（resume 重跑不丢前步）。
     * 结构固定为 { <stepId>: { id, title, status, output, detail, startedAt, finishedAt } }。
     */
    function initializeScriptSteps(stage, reset = false) {
        const previous = !reset && stage.steps && typeof stage.steps === "object" ? stage.steps : {};
        const steps = {};
        for (const item of SCRIPT_STEPS) {
            steps[item.id] = previous[item.id] ? { ...previous[item.id], id: item.id, title: item.title } : { id: item.id, title: item.title, status: "pending", output: null };
        }
        stage.steps = steps;
        return steps;
    }

    /** 标记某个子步骤的状态；running 记开始时间，done/error 记结束时间。 */
    function markScriptStep(stage, id, status, extra = {}) {
        const step = stage.steps?.[id];
        if (!step) return;
        Object.assign(step, { status }, extra);
        if (status === "running") step.startedAt = step.startedAt || nowIso();
        if (status === "done" || status === "error") step.finishedAt = nowIso();
    }

    /** 进度里的步骤视图：只带状态与细节，不带产物，保证 progress.json 仍是几十字节量级。 */
    function scriptStepsView(stage) {
        return SCRIPT_STEPS.map((item) => {
            const step = stage.steps?.[item.id] || { status: "pending" };
            return { id: item.id, title: item.title, status: step.status || "pending", ...(step.detail ? { detail: step.detail } : {}) };
        });
    }

    /** 写一条带 steps 的进度：保留全部旧字段（向后兼容），额外附上多步状态。 */
    function writeScriptProgress(run, def, stage, extra = {}) {
        writeProgress(run.id, { runId: run.id, stage: def.id, ...extra, steps: scriptStepsView(stage) });
    }

    /** 按 plan 把场次均分成目标集数：分集缺失或不符时的确定性兜底，保证 episodes 非空且集数一致。 */
    function synthesizeEpisodes(scenes, plan) {
        const ids = (Array.isArray(scenes) ? scenes : []).map((scene) => scene?.id).filter(Boolean);
        const count = plan.episodeCount > 0 ? plan.episodeCount : 1;
        const episodes = [];
        for (let index = 0; index < count; index += 1) {
            episodes.push({
                id: `ep${index + 1}`,
                index: index + 1,
                title: `第${index + 1}集`,
                durationSec: plan.episodeDurationSec > 0 ? plan.episodeDurationSec : null,
                synopsis: "",
                sceneIds: ids.slice(Math.floor((index * ids.length) / count), Math.floor(((index + 1) * ids.length) / count)),
            });
        }
        return episodes;
    }

    /**
     * 规整模型分集：清洗 sceneIds、把集数强制对齐 plan.episodeCount、校验时长合计并给出差距。
     * 不一致一律记进 warnings（不静默放过）；集数不符时按目标重排，保证 episodes 非空且集数一致。
     */
    function normalizeEpisodes(rawEpisodes, scenes, plan) {
        const sceneIds = new Set((Array.isArray(scenes) ? scenes : []).map((scene) => scene?.id).filter(Boolean));
        const warnings = [];
        let episodes = (Array.isArray(rawEpisodes) ? rawEpisodes : [])
            .filter((item) => item && typeof item === "object")
            .map((item, index) => ({
                id: String(item.id || `ep${index + 1}`),
                title: String(item.title || `第${index + 1}集`),
                durationSec: Number(item.durationSec) > 0 ? Number(item.durationSec) : null,
                synopsis: String(item.synopsis ?? ""),
                sceneIds: (Array.isArray(item.sceneIds) ? item.sceneIds : []).map((id) => String(id)).filter((id) => sceneIds.has(id)),
            }));
        const targetCount = plan.episodeCount > 0 ? plan.episodeCount : episodes.length || 1;
        if (episodes.length !== targetCount) {
            warnings.push(`分集数不符：模型给出 ${episodes.length} 集，目标 ${targetCount} 集，已按目标重排`);
            episodes = synthesizeEpisodes(scenes, { ...plan, episodeCount: targetCount });
        }
        // 未被任何集引用的场次按顺序补进各集，避免分集后场次丢失（只补 sceneIds，不动集数）。
        const used = new Set(episodes.flatMap((episode) => episode.sceneIds));
        const orphans = [...sceneIds].filter((id) => !used.has(id));
        if (orphans.length) {
            warnings.push(`有 ${orphans.length} 个场次未被分集引用，已按顺序补入`);
            orphans.forEach((id, index) => episodes[index % episodes.length].sceneIds.push(id));
        }
        if (plan.episodeDurationSec > 0) {
            const targetTotal = targetCount * plan.episodeDurationSec;
            const total = episodes.reduce((sum, episode) => sum + (Number(episode.durationSec) || 0), 0);
            const diff = Math.abs(total - targetTotal);
            if (diff > plan.episodeDurationSec) warnings.push(`时长合计 ${total}s 与目标 ${targetTotal}s（${targetCount}×${plan.episodeDurationSec}s）相差 ${diff}s`);
        }
        return { episodes: episodes.map((episode, index) => ({ ...episode, index: index + 1 })), warnings };
    }

    /**
     * 01 剧本分块改编（map-reduce）：整本长篇超过阈值时切成 N 块，逐块提取局部人物/场次，
     * 再把全部局部结果与项目标题喂给模型合并成符合 01 SKILL.md 契约的完整剧本。
     * stage.output 与单次调用完全同构，分块信息记在 stage.chunked。
     */
    async function composeScriptChunked(run, def, stage, provider, maxChunkChars, ctx = {}) {
        const { signal, resume = false, estSecondsPerChunk = 31 } = ctx;
        const chunks = splitNovelIntoChunks(run.novel, maxChunkChars);
        // 阶段技能的内容创作红线（忠于原著 / 不注入教化结构 / 风险只提示不改稿 / 质量校验照做），
        // map 与 reduce 两处复用同一份文案；技能没写该节时留空，退回旧的 \n\n 分隔。
        const redlines = scriptRedlines(def);
        const redlineBlock = redlines ? `\n\n改编必须遵守阶段技能的内容创作红线（硬约束）：\n${redlines}\n` : "\n\n";
        const system = { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` };
        const partials = [];
        const startedAt = Date.now();
        let reused = 0;
        for (const chunk of chunks) {
            if (signal?.aborted) throw new Error(`已取消（第 ${partials.length}/${chunks.length} 块完成后中止）`);
            const mapPrompt = `你是影视剧本改编。长篇小说《${run.title}》太长，已分成 ${chunks.length} 块，这是第 ${chunk.index}/${chunks.length} 块（来源：${chunk.label}）。

<novel-part>
${chunk.text}
</novel-part>${redlineBlock}要求：

1. 只提取本块出现的 characters 与 scenes，不要写 logline / synopsis / episodes。
2. characters 覆盖本块所有有台词或推动剧情的角色：profile 写身份、性格、人物关系；appearance 写成能直接喂给生图模型的外观描述（年龄、体态、五官、发型、服装基调），不要抽象形容词；voice 写音色、语速、口音等可复现的声音特征。
3. scenes 按本块时间顺序排列；beats 用 3~8 条原文里的可拍摄动作/台词节拍，不要文学抒情和心理描写。
4. location 统一写成「内景/外景 + 地点」，time 只用 日 / 夜 / 黄昏 / 清晨 这类可布光的词。
5. 只输出下面结构的 JSON 本体，只输出契约允许的字段、不得增删或改名，id 在本块内唯一即可（合并时会统一重排），不要 Markdown 代码块、不要解释文字：

{"characters":[{"id":"c1","name":"","profile":"","appearance":"","voice":""}],"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}]}`;
            // resume 时优先复用上次已落盘的块结果：163 块 / 83 分钟的任务崩了不该从头再来
            let partial = resume ? readChunkPartial(run.id, chunk.index) : null;
            if (partial && typeof partial === "object") {
                reused += 1;
            } else {
                partial = await askJson([system, { role: "user", content: mapPrompt }], run, def.id, provider, 0.6, signal);
                saveChunkPartial(run.id, chunk.index, partial);
            }
            partials.push({ index: chunk.index, label: chunk.label, ...partial });
            const done = partials.length;
            const called = done - reused;
            // 有真实调用样本就用实测均速，否则退回配置的估值（实测 163 块 / 83 分钟 ≈ 30.5s/块）
            const avgMs = called > 0 ? Math.round((Date.now() - startedAt) / called) : Math.round(Number(estSecondsPerChunk) * 1000);
            writeProgress(run.id, {
                runId: run.id,
                stage: def.id,
                phase: "map",
                done,
                total: chunks.length,
                label: chunk.label,
                reused,
                avgMsPerChunk: avgMs,
                etaMs: avgMs * (chunks.length - done),
                startedAt: new Date(startedAt).toISOString(),
                steps: scriptStepsView(stage),
            });
        }
        const reducePrompt = `你是影视剧本改编。长篇小说《${run.title}》已分 ${chunks.length} 块逐块提取出局部人物与场次（JSON 如下，label 是该块在原文里的来源标记）。把它们合并成一份完整剧本。

<partials>
${JSON.stringify(partials, null, 2)}
</partials>${redlineBlock}要求：

1. 生成 logline（一句话故事线）与 synopsis（不超过 300 字的故事梗概）。
2. characters 按姓名合并去重，profile 合并各块信息；appearance 与 voice 必须每条非空，缺失时依据原文细节合理推断补齐。
3. scenes 按时间顺序合并，跨块重复的场次合并且不丢 beats；beats 保留可拍摄的动作/台词细节。
4. characters[].id 与 scenes[].id 全部重排为连续稳定的 c1、c2… 与 sc1、sc2…，只允许 [A-Za-z0-9_-]。
5. 短篇可省略 episodes；若给出，sceneIds 必须都能在 scenes 里找到。
6. 只输出下面结构的 JSON 本体，只输出契约允许的字段、字段名不得增删或改名，不要 Markdown 代码块、不要解释文字：

{"logline":"","synopsis":"","characters":[{"id":"c1","name":"","profile":"","appearance":"","voice":""}],"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}],"episodes":[]}`;
        if (signal?.aborted) throw new Error(`已取消（${chunks.length} 块已全部提取，合并前中止）`);
        writeProgress(run.id, {
            runId: run.id,
            stage: def.id,
            phase: "reduce",
            done: chunks.length,
            total: chunks.length,
            label: `合并 ${chunks.length} 块局部结果`,
            reused,
            startedAt: new Date(startedAt).toISOString(),
            steps: scriptStepsView(stage),
        });
        const merged = await askJson([system, { role: "user", content: reducePrompt }], run, def.id, provider, 0.3, signal);
        stage.chunked = { chunks: chunks.length, labels: chunks.map((chunk) => chunk.label), mergeModel: resolveModel(run, def.id), reused };
        return merged;
    }

    /**
     * 01 剧本的 analyze 子步骤：短篇单次调用（沿用既有「## 提示词模板」），长篇走分块 map-reduce。
     * 只负责产出原文分析结果（logline/synopsis/characters/scenes，可能带 planSuggestion），不落 stage.output。
     */
    async function composeScriptAnalyze(run, def, stage, provider, ctx = {}) {
        const prompt = fillTemplate(readPromptTemplate(def), buildContext(run, def));
        const maxChunkChars = Number(pipelineConfig.maxNovelChunkChars) || 16000;
        if (prompt.length > maxChunkChars) {
            return composeScriptChunked(run, def, stage, provider, maxChunkChars, ctx);
        }
        // 单次调用也写一条同形状的进度，前端不必为「有没有分块」写两套渲染
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: "single", done: 0, total: 1, label: "模型生成中", steps: scriptStepsView(stage) });
        const messages = [
            { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
            { role: "user", content: prompt },
        ];
        stage.chunked = undefined;
        return askJson(messages, run, def.id, provider, 0.6, ctx.signal);
    }

    /** 分集规划的内置兜底提示词：阶段技能缺「## 分集规划提示词」时使用，plan 集数/时长是硬输入。 */
    const OUTLINE_FALLBACK_PROMPT = [
        "你是本项目的分集规划师。依据下面的原文分析结果，把整部故事规划成 {{episodeCount}} 集，每集时长约 {{episodeDurationSec}} 秒。",
        "项目标题：{{title}}",
        "一句话故事线：{{logline}}",
        "故事梗概：{{synopsis}}",
        "人物：{{characters}}",
        "场次：{{scenes}}",
        '要求：只输出 JSON：{"episodes":[{"id":"ep1","index":1,"title":"","durationSec":0,"synopsis":"","sceneIds":["sc1"]}]}；集数必须等于 {{episodeCount}}，sceneIds 只能引用给定场次 id，各集时长合计应接近 {{episodeCount}}×{{episodeDurationSec}} 秒；不要 Markdown 代码块、不要解释文字。',
    ].join("\n\n");

    /** 逐集剧本的内置兜底提示词：阶段技能缺「## 逐集剧本提示词」时使用。 */
    const SCRIPT_EPISODE_FALLBACK_PROMPT = [
        "你是本项目的剧本编剧。这是第 {{episode.index}} 集，请依据下列场次写出可直接拍摄的镜头级动作节拍（beats）。",
        "项目标题：{{title}}",
        "本集信息：{{episode}}",
        "人物：{{characters}}",
        "本集场次：{{episodeScenes}}",
        '要求：只输出 JSON：{"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}]}；场次 id 必须沿用给定值，beats 写 3~8 条可拍摄动作/台词；不要 Markdown 代码块、不要解释文字。',
    ].join("\n\n");

    /** 分集规划子步骤：以 plan.episodeCount/episodeDurationSec 为硬输入，产出 episodes[]。 */
    async function composeScriptOutline(run, def, stage, provider, ctx, { scenes, characters, analyze, plan }) {
        const template = readStepTemplate(def, SCRIPT_STEP_SECTIONS.outline) || OUTLINE_FALLBACK_PROMPT;
        const redlines = scriptRedlines(def);
        const context = {
            ...buildContext(run, def),
            title: run.title,
            episodeCount: plan.episodeCount > 0 ? plan.episodeCount : 1,
            episodeDurationSec: plan.episodeDurationSec > 0 ? plan.episodeDurationSec : "",
            logline: analyze?.logline ?? "",
            synopsis: analyze?.synopsis ?? "",
            characters,
            scenes,
        };
        let prompt = fillTemplate(template, context);
        if (redlines) prompt += `\n\n分集必须遵守阶段技能的内容创作红线（硬约束）：\n${redlines}\n`;
        const messages = [
            { role: "system", content: `你是「${def.title}」阶段的分集规划者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
            { role: "user", content: prompt },
        ];
        return askJson(messages, run, def.id, provider, 0.3, ctx.signal);
    }

    /** 逐集剧本子步骤：逐集生成镜头级场次内容；单集（未请求分集）时不额外调模型，整篇即这一集。 */
    async function composeScriptPerEpisode(run, def, stage, provider, ctx, { episodes, scenes, characters, plan }) {
        const sceneById = new Map((Array.isArray(scenes) ? scenes : []).map((scene) => [scene?.id, scene]));
        const results = [];
        const total = episodes.length;
        for (let index = 0; index < episodes.length; index += 1) {
            const episode = episodes[index];
            const slice = episode.sceneIds.map((id) => sceneById.get(id)).filter(Boolean);
            if (total > 1) {
                if (ctx.signal?.aborted) throw new Error("已取消");
                const template = readStepTemplate(def, SCRIPT_STEP_SECTIONS.script) || SCRIPT_EPISODE_FALLBACK_PROMPT;
                const redlines = scriptRedlines(def);
                let prompt = fillTemplate(template, {
                    ...buildContext(run, def),
                    title: run.title,
                    episode,
                    episodeIndex: episode.index,
                    episodeCount: total,
                    episodeDurationSec: plan.episodeDurationSec > 0 ? plan.episodeDurationSec : "",
                    episodeScenes: slice,
                    characters,
                    scenes,
                });
                if (redlines) prompt += `\n\n剧本必须遵守阶段技能的内容创作红线（硬约束）：\n${redlines}\n`;
                const messages = [
                    { role: "system", content: `你是「${def.title}」阶段第 ${episode.index} 集的编剧。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
                    { role: "user", content: prompt },
                ];
                const parsed = await askJson(messages, run, def.id, provider, 0.5, ctx.signal);
                results.push({ episodeId: episode.id, index: episode.index, scenes: Array.isArray(parsed?.scenes) && parsed.scenes.length ? parsed.scenes : slice });
                stage.steps.script.detail = `第 ${index + 1}/${total} 集`;
                writeScriptProgress(run, def, stage, { phase: "running", done: index + 1, total, label: `逐集剧本：第 ${index + 1}/${total} 集` });
            } else {
                results.push({ episodeId: episode.id, index: episode.index, scenes: slice });
            }
        }
        return results;
    }

    /** 场次可被逐集剧本覆盖的内容字段（不动 id，供下游 02 稳定引用）。 */
    const SCRIPT_SCENE_FIELDS = Object.freeze(["title", "location", "time", "intent", "beats"]);

    /** 合并最终剧本产物：以 analyze 为骨架，用逐集剧本结果按 id 细化场次，episodes 原样带上。 */
    function mergeScriptOutput(analyze, episodes, stepResults, scenes) {
        const byId = new Map();
        for (const scene of Array.isArray(scenes) ? scenes : []) {
            if (scene?.id) byId.set(scene.id, { ...scene });
        }
        for (const result of stepResults) {
            for (const scene of result.scenes || []) {
                if (!scene?.id) continue;
                const merged = { ...(byId.get(scene.id) || { id: scene.id }) };
                for (const field of SCRIPT_SCENE_FIELDS) if (scene[field] !== undefined) merged[field] = scene[field];
                byId.set(scene.id, merged);
            }
        }
        let finalScenes = [...byId.values()];
        if (!finalScenes.length) finalScenes = stepResults.flatMap((result) => result.scenes || []);
        const output = {
            logline: String(analyze?.logline ?? ""),
            synopsis: String(analyze?.synopsis ?? ""),
            characters: Array.isArray(analyze?.characters) ? analyze.characters : [],
            scenes: finalScenes,
            episodes: Array.isArray(episodes) ? episodes.map((episode) => ({ ...episode })) : [],
        };
        if (analyze?.planSuggestion && typeof analyze.planSuggestion === "object") output.planSuggestion = analyze.planSuggestion;
        return output;
    }

    /**
     * 01 剧本多步编排：analyze（读原文）→ outline（分集规划）→ script（逐集剧本）。
     * 每步都有独立状态与产物；产物落进 stage.steps.<id>.output（随 run 落盘、可重载、支持 resume 复用前步），
     * 最终合并成下游 02/03 依赖的 stage.output（logline/synopsis/characters/scenes/episodes）。
     */
    async function composeScriptSteps(run, def, stage, provider, ctx = {}) {
        const reuseDone = Boolean(ctx.resume);
        initializeScriptSteps(stage, !reuseDone);
        const plan = planConstraints(run);
        const stepDone = (id) => reuseDone && stage.steps[id]?.status === "done" && stage.steps[id]?.output != null;
        try {
            // —— 1. analyze：读原文，产出主线/人物/场次 ——
            let analyze;
            if (stepDone("analyze")) {
                analyze = stage.steps.analyze.output;
            } else {
                markScriptStep(stage, "analyze", "running");
                writeScriptProgress(run, def, stage, { phase: "single", done: 0, total: 1, label: "读原文：提取主线、人物与场次" });
                analyze = await composeScriptAnalyze(run, def, stage, provider, ctx);
                if (!analyze || typeof analyze !== "object") throw new Error("原文分析未产出有效结果");
                stage.steps.analyze.output = analyze;
                stage.steps.analyze.detail = `${Array.isArray(analyze.characters) ? analyze.characters.length : 0} 个角色 / ${Array.isArray(analyze.scenes) ? analyze.scenes.length : 0} 个场次`;
                markScriptStep(stage, "analyze", "done");
                saveRun(run);
            }
            const scenes = Array.isArray(analyze.scenes) ? analyze.scenes : [];
            const characters = Array.isArray(analyze.characters) ? analyze.characters : [];

            // —— 2. outline：分集规划（plan 为硬输入，产出后校验集数与时长）——
            let episodes;
            if (stepDone("outline")) {
                episodes = stage.steps.outline.output.episodes;
            } else {
                markScriptStep(stage, "outline", "running");
                writeScriptProgress(run, def, stage, { phase: "running", done: 0, total: 1, label: `分集规划：目标 ${plan.episodeCount > 0 ? plan.episodeCount : 1} 集` });
                const raw = await composeScriptOutline(run, def, stage, provider, ctx, { scenes, characters, analyze, plan });
                const normalized = normalizeEpisodes(raw?.episodes, scenes, plan);
                episodes = normalized.episodes;
                stage.steps.outline.output = { episodes, warnings: normalized.warnings, target: plan };
                stage.steps.outline.detail = `${episodes.length} 集${normalized.warnings.length ? `（${normalized.warnings.length} 条提醒）` : ""}`;
                markScriptStep(stage, "outline", "done");
                stage.warnings = normalized.warnings.length ? normalized.warnings : undefined;
                saveRun(run);
            }

            // —— 3. script：逐集剧本 ——
            let stepResults;
            if (stepDone("script")) {
                stepResults = stage.steps.script.output.episodes;
            } else {
                markScriptStep(stage, "script", "running");
                writeScriptProgress(run, def, stage, { phase: "running", done: 0, total: episodes.length, label: `逐集剧本：共 ${episodes.length} 集` });
                stepResults = await composeScriptPerEpisode(run, def, stage, provider, ctx, { episodes, scenes, characters, plan });
                stage.steps.script.output = { episodes: stepResults };
                stage.steps.script.detail = `${episodes.length} 集完成`;
                markScriptStep(stage, "script", "done");
                saveRun(run);
            }
            // 收尾写一条带最终 steps 的进度：否则 executeStage 合并的是「script 仍在 running」的旧快照，前端会看到阶段 done 但末步未完成。
            writeScriptProgress(run, def, stage, { phase: "running", done: episodes.length, total: episodes.length, label: `逐集剧本：${episodes.length} 集完成` });
            return mergeScriptOutput(analyze, episodes, stepResults, scenes);
        } catch (error) {
            // 已完成的前步产物保留在 stage.steps 里（不丢），失败的那一步落 error，后端可据 resume 复用前步重试。
            const current = SCRIPT_STEPS.find((item) => stage.steps[item.id]?.status === "running");
            if (current) markScriptStep(stage, current.id, "error", { error: error.message });
            writeScriptProgress(run, def, stage, { phase: "running", label: error.message });
            saveRun(run);
            throw error;
        }
    }

    /** 文本型阶段：填模板 → 要求严格 JSON → 失败重试一次 → 再失败置 error。provider 为浏览器透传的外部渠道（仅本次调用）。 */
    async function composeWithLlm(run, def, stage, provider, ctx = {}) {
        // 01 剧本走 analyze→outline→script 多步编排（进度可见、中间结果落盘、plan 作硬约束）；其余阶段仍是单次调用。
        if (def.id === "script") {
            try {
                stage.output = await composeScriptSteps(run, def, stage, provider, ctx);
            } catch (error) {
                stage.output = null;
                throw error;
            }
            return;
        }
        const prompt = fillTemplate(readPromptTemplate(def), buildContext(run, def));
        try {
            // 单次调用也写一条同形状的进度，前端不必为「有没有分块」写两套渲染
            writeProgress(run.id, { runId: run.id, stage: def.id, phase: "single", done: 0, total: 1, label: "模型生成中" });
            const messages = [
                { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
                { role: "user", content: prompt },
            ];
            stage.output = await askJson(messages, run, def.id, provider, 0.6, ctx.signal);
            stage.chunked = undefined;
        } catch (error) {
            stage.output = null;
            throw error;
        }
    }

    /**
     * 候选达标判据（D3「不达标就重新生成」）。没有像素级 QC 字段（无全黑检测），因此用可得元数据判定：
     *   任务成功 + 有可访问产物 + 产物非空文件 + 尺寸（若上报）为正；任何一项不满足即判不达标。
     * 尺寸/字节数缺省时不惩罚（ComfyUI 未回报就按通过），只对「明确非法」的值判负。
     */
    function candidateQcFor(job) {
        if (job?.status === "error") return { pass: false, reason: "任务失败" };
        if (job?.status === "canceled") return { pass: false, reason: "任务已取消" };
        if (job?.status !== "done") return { pass: false, reason: "未完成" };
        const outputs = (Array.isArray(job.outputs) ? job.outputs : []).filter((output) => output && output.url);
        if (!outputs.length) return { pass: false, reason: "任务没有产物" };
        const want = job.kind === "video" ? "video" : "image";
        const hit = outputs.find((output) => output.type === want) || outputs[0];
        if (Number.isFinite(Number(hit.bytes)) && Number(hit.bytes) <= 0) return { pass: false, reason: "产物为空文件" };
        if (Number.isFinite(Number(hit.width)) && Number(hit.width) <= 0) return { pass: false, reason: `产物宽度非法（${hit.width}）` };
        if (Number.isFinite(Number(hit.height)) && Number(hit.height) <= 0) return { pass: false, reason: `产物高度非法（${hit.height}）` };
        return { pass: true, reason: "" };
    }

    /** 候选是否已达标：成功且 QC 未判负（qc 缺省的历史候选视为达标，避免重放旧 run 触发误重试）。 */
    function candidatePassed(candidate) {
        return Boolean(candidate) && candidate.status === "done" && candidate.qc?.pass !== false;
    }

    /** item 的派生别名（jobId/artifactUrl/status）由候选列表算出，selected 指向当前采用的候选；绝不删除旧候选。 */
    function syncItem(item) {
        const candidates = Array.isArray(item.candidates) ? item.candidates : [];
        if (!candidates.length) return;
        const latest = candidates[candidates.length - 1];
        // 用户取消新 attempt 不应夺走上一版已成功的选中产物；取消是用户意图，不是阶段失败。
        // 这样撤销一批排队候选后，已有成功帧仍可让下游继续，而没有任何成功候选的条目仍保持 canceled。
        const selected = latest.status === "canceled" ? [...candidates].reverse().find(candidatePassed) || latest : latest;
        item.selected = selected.jobId;
        item.jobId = selected.jobId;
        item.status = selected.status;
        // 产物取「当前候选，其次最近一次成功」，重跑进行中也不会丢掉上一次的结果。
        const lastUrl = [...candidates].reverse().find((candidate) => candidate.artifactUrl)?.artifactUrl;
        item.artifactUrl = selected.artifactUrl || lastUrl || null;
        item.media = selected.artifactUrl ? selected.media || null : [...candidates].reverse().find((candidate) => candidate.artifactUrl)?.media || null;
        item.actualDurationSec = item.media?.durationSec || null;
    }

    /** 幂等 upsert 一个候选：同一个 jobId 只更新状态与产物，不重复追加。 */
    function upsertCandidate(item, job) {
        item.candidates = Array.isArray(item.candidates) ? item.candidates : [];
        // 回写即断言：只落「磁盘上真的存在」的产物 URL（#40：索引指向不存在文件 → 按 URL 取图 404）。
        // 选择范围限定在本 job 自己的 outputs 内，绝不「扫描目录取最新」。
        const artifactUrl = job.status === "done" ? resolvingOutputUrl(config, job) : null;
        const media = (job.outputs || []).find((output) => output.url === artifactUrl)?.media || null;
        const qc = candidateQcFor(job);
        const existing = item.candidates.find((candidate) => candidate.jobId === job.id);
        if (existing) {
            existing.status = job.status;
            existing.artifactUrl = artifactUrl;
            existing.qc = qc;
            existing.media = media;
            return;
        }
        item.candidates.push({ template: job.template, jobId: job.id, artifactUrl, status: job.status, params: job.params, qc, media, createdAt: job.createdAt || nowIso() });
    }

    /**
     * 成片是否已由 delivery 产出：只有拿到可访问地址才算，绝不把「片段生成完」当「成片完成」。
     * 返回登记进 stage.artifacts 的成片条目（成片本体 + 可复现清单 + 日志 + 封面）。
     */
    function filmArtifacts(stage) {
        const assembly = stage.output?.assembly;
        if (!assembly || assembly.status !== "done" || !assembly.url) return [];
        const list = [{ id: assembly.deliverableId, kind: "film", role: "output", url: assembly.url }];
        if (assembly.manifestUrl) list.push({ id: assembly.deliverableId, kind: "film", role: "manifest", url: assembly.manifestUrl });
        if (assembly.logUrl) list.push({ id: assembly.deliverableId, kind: "film", role: "log", url: assembly.logUrl });
        if (assembly.coverUrl) list.push({ id: assembly.deliverableId, kind: "film", role: "cover", url: assembly.coverUrl });
        return list;
    }

    /**
     * 阶段状态以任务终态为准：必需 Job 全部成功才 done；
     * 全部进行中 running、部分成功 partial、全失败 error、有取消 canceled、参考图能力/素材缺失 blocked。重算 artifacts。
     * artifacts 会重建为「条目产物 + 成片条目」，成片信息由 filmArtifacts 从 assembly 派生，天然幂等。
     * blocked：条目被 tool-adapter/reference-lock 判定无法锁定角色（无参考图能力或参考图缺失）时显式标记，
     * 不静默降级、也不假装已锁定。
     */
    function recomputeStage(stage, run) {
        const items = stageOutputItems(stage);
        const blockedItems = items.filter((item) => item.status === "blocked" && !(item.candidates || []).length);
        const latest = items.map((item) => (item.candidates || []).at(-1)).filter(Boolean);
        stage.artifacts = [...items.filter((item) => item.artifactUrl).map((item) => ({ jobId: item.jobId, url: item.artifactUrl })), ...filmArtifacts(stage)];
        registerArtifacts(run, stage);
        if (blockedItems.length) stage.blocked = blockedItems.map((item) => ({ itemId: item.id, reason: item.blockedReason || "缺少参考图" }));
        else delete stage.blocked;
        if (!latest.length) {
            if (blockedItems.length) {
                stage.status = "blocked";
                stage.error = blockedItems.map((item) => `${item.id}：${item.blockedReason || "缺少参考图"}`).join("；");
            }
            return;
        }
        // 以 item.selected 指向的候选为准；syncItem 已把用户取消的新 attempt 回退到旧成功候选。
        const statuses = items.map((item) => (item.candidates || []).find((candidate) => candidate.jobId === item.selected) || (item.candidates || []).at(-1)).filter(Boolean).map((candidate) => candidate.status);
        // 只要有任务还在排队/运行就是 running —— 部分已完成既不代表阶段可审阅、也不代表可续跑；
        // 前端也靠 stage.status === "running" 决定要不要继续轮询阶段进度。
        if (statuses.some((status) => status === "queued" || status === "running")) stage.status = "running";
        else if (blockedItems.length) stage.status = "partial";
        else if (statuses.every((status) => status === "done")) stage.status = "done";
        else if (statuses.some((status) => status === "done")) stage.status = "partial";
        else if (statuses.includes("canceled")) stage.status = "canceled";
        else stage.status = "error";
        if (TERMINAL_JOB.has(stage.status)) stage.finishedAt = stage.finishedAt || nowIso();
        // 关键帧终态：把 frames[] 产物投影进 Project 侧 shots[].generationSlots[]（#48 门禁依据）。
        // 放在 recomputeStage 收口 = 全部回写路径（projectJob / attachGeneration / executeRegenerate）都覆盖；
        // 对「已跑完的历史 run」由 bindJobs() 启动重放终态 Job 时同样命中。
        // 同时回填 Run 侧存量产物的 episodeId（#51 附带问题）：storyboard shots / assembly clips 的归属集。
        if (stage.id === "keyframe") {
            projectKeyframeFacts(run, stage);
            backfillRunEpisodeIds(run);
        }
    }

    /** 按 id 取项目（未注入 getProject / 查不到 / 抛错一律 null，永不抛）。 */
    function projectById(projectId) {
        if (typeof getProject !== "function") return null;
        if (!projectId) return null;
        try {
            const project = getProject(projectId);
            return project && typeof project === "object" ? project : null;
        } catch {
            return null;
        }
    }

    /** 取 run 绑定的项目（run.options.projectId 是契约认可的过渡位）；未注入 getProject 或查不到时返回 null。 */
    function projectOf(run) {
        return projectById(run?.options?.projectId);
    }

    /** 建 run 时把 runId 幂等追加进项目 runIds；未注入 / 未绑项目为空操作，失败只告警，绝不让建 run 失败。 */
    function attachRunToProject(projectId, runId) {
        if (typeof attachProjectRun !== "function") return;
        try {
            attachProjectRun(projectId, runId);
        } catch (error) {
            console.warn(`[pipeline] run 关联项目失败（不影响流水线）：${error.message}`);
        }
    }

    /**
     * 风格维度的唯一事实源：项目级 styleAnchor 最优先，其次 run.options.styleAnchor（未绑项目时的过渡位）。
     * 两处都没有时返回空串，由调用方决定兜底（buildContext 用中性锚点、生成层不叠加任何风格层）。
     */
    function resolveStyleAnchor(run) {
        const project = projectOf(run);
        const projectAnchor = String(project?.styleAnchor ?? "").trim();
        if (projectAnchor) return projectAnchor;
        return String(run?.options?.styleAnchor ?? "").trim();
    }

    /**
     * 剧本阶段完成后，把 01 产出的 planSuggestion 回填项目 plan。
     * 只填空字段的判定与写入交给注入的 applyPlanSuggestion（projects.applyPlanSuggestion，依 PLAN_DEFAULTS 判定 + 原子写 + version 自增），
     * 这里只负责「何时调用」：仅 script 阶段、run 绑了项目、且有 planSuggestion 时才调。
     * 未注入 / 未绑项目 / 无建议时是空操作；回填失败只告警，绝不把已成功的剧本阶段拖成 error。
     */
    function backfillPlanSuggestion(run, output) {
        if (typeof applyPlanSuggestion !== "function") return;
        const projectId = run?.options?.projectId;
        if (!projectId) return;
        const suggestion = output?.planSuggestion;
        if (!suggestion || typeof suggestion !== "object") return;
        try {
            applyPlanSuggestion(projectId, suggestion);
        } catch (error) {
            console.warn(`[pipeline] planSuggestion 回填失败（不影响剧本阶段）：${error.message}`);
        }
    }

    /**
     * 脚本事实链（§12 第 1 优先级）：剧本阶段产出后，把 logline/synopsis/characters/scenes/episodes
     * 投影进 Project.script（只填空/幂等判定都在注入的 applyScriptProjection 里，本模块不 import projects.js）。
     * 未注入 / 未绑项目 / 无产物时为空操作；失败只告警，绝不把已成功的剧本阶段拖成 error。
     */
    function projectScriptFacts(run, output) {
        if (typeof applyScriptProjection !== "function") return;
        const projectId = run?.options?.projectId;
        if (!projectId || !output || typeof output !== "object") return;
        try {
            applyScriptProjection(projectId, output);
        } catch (error) {
            console.warn(`[pipeline] 剧本事实投影失败（不影响剧本阶段）：${error.message}`);
        }
    }

    /**
     * 分集事实链（§12 第 1 优先级）：剧本阶段产出后，把 episodes[]/scenes[] 投影进 Project.episodes
     * （幂等 / 不改 version 的判定与写入都在注入的 applyEpisodeProjection 里，本模块不 import projects.js）。
     * 未注入 / 未绑项目 / 无产物时为空操作；失败只告警，绝不把已成功的剧本阶段拖成 error。
     * 这条投影是 storyboard 门禁 done 判据（episode.scenes.length>0）能拿到场景的唯一来源。
     */
    function projectEpisodeFacts(run, output) {
        if (typeof applyEpisodeProjection !== "function") return;
        const projectId = run?.options?.projectId;
        if (!projectId || !output || typeof output !== "object") return;
        try {
            applyEpisodeProjection(projectId, output);
        } catch (error) {
            console.warn(`[pipeline] 分集事实投影失败（不影响剧本阶段）：${error.message}`);
        }
    }

    /**
     * 分集归一的权威集列表：绑项目且项目已有集时用**项目侧 id（ep_0001）**；否则退回剧本侧 episodes（ep1）。
     * 项目集若没带 sceneIds（旧投影）按序借剧本集的 sceneIds 补桥，让 shot.sceneId（剧本 sc1）能定位到项目集。
     */
    function storyboardEpisodeAuthority(run) {
        const projectId = run?.options?.projectId;
        const project = projectId && typeof getProject === "function" ? getProject(projectId) : null;
        const projectEpisodes = project && Array.isArray(project.episodes) ? project.episodes.filter((episode) => episode && typeof episode === "object") : [];
        const scriptEpisodes = Array.isArray(run?.stages?.script?.output?.episodes) ? run.stages.script.output.episodes : [];
        if (!projectEpisodes.length) return scriptEpisodes;
        return projectEpisodes.map((episode, index) => {
            const sceneIds = Array.isArray(episode.sceneIds) && episode.sceneIds.length ? episode.sceneIds : (Array.isArray(scriptEpisodes[index]?.sceneIds) ? scriptEpisodes[index].sceneIds : []);
            return { ...episode, sceneIds };
        });
    }

    /** 项目目录（活动优先、其次归档）；找不到 project.json 返回 null（测试用内存假项目 → 空操作）。 */
    function projectDataDir(projectId) {
        const dataDir = config?.dataDir || "data";
        for (const bucket of ["projects", "projects-archive"]) {
            const dir = safeJoin(join(dataDir, bucket), String(projectId));
            if (dir && existsSync(safeJoin(dir, "project.json"))) return dir;
        }
        return null;
    }

    /**
     * 让 `project.episodes[].shotIds`（及缺失时的 sceneIds）对 gates / context 可见。
     *
     * 背景：project.episodes 由脚本阶段的 applyEpisodeProjection 落盘，只含 scenes、没有 shotIds；
     * 「哪一镜属于哪一集」的权威来源在**分镜阶段**。这里把分集归一回填进 project.episodes。
     * 写入语义对齐 projects.js 的 persistDerived：原子写（temp+rename）、更新 updatedAt、**不改 version**、
     * 幂等（无变化不写盘）。未绑项目 / project.json 不存在 → 空操作；写入失败只告警，绝不拖垮分镜阶段。
     */
    function persistProjectEpisodeShotIds(run, episodes) {
        const projectId = run?.options?.projectId;
        if (!projectId || !Array.isArray(episodes) || !episodes.length) return;
        const project = typeof getProject === "function" ? getProject(projectId) : null;
        const current = project && Array.isArray(project.episodes) ? project.episodes : null;
        if (!current || !current.length) return;
        const byId = new Map(episodes.map((episode) => [String(episode.id), episode]));
        const sameIds = (a, b) => Array.isArray(a) && a.length === b.length && a.every((id, index) => String(id) === b[index]);
        let changed = false;
        const next = current.map((episode) => {
            const hit = byId.get(String(episode?.id));
            if (!hit) return episode;
            const shotIds = Array.isArray(hit.shotIds) ? hit.shotIds.map(String) : [];
            const sceneIds = Array.isArray(episode.sceneIds) && episode.sceneIds.length ? episode.sceneIds.map(String) : (Array.isArray(hit.sceneIds) ? hit.sceneIds.map(String) : []);
            if (sameIds(episode.shotIds, shotIds) && sameIds(episode.sceneIds, sceneIds)) return episode;
            changed = true;
            return { ...episode, shotIds, sceneIds };
        });
        if (!changed) return;
        const dir = projectDataDir(projectId);
        if (!dir) return;
        try {
            const file = safeJoin(dir, "project.json");
            const temp = `${file}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
            writeFileSync(temp, JSON.stringify({ ...project, episodes: next, updatedAt: nowIso() }, null, 2));
            renameSync(temp, file);
        } catch (error) {
            console.warn(`[pipeline] 分集 shotIds 回填失败（不影响分镜阶段）：${error.message}`);
        }
    }

    /**
     * 分镜阶段产出后：把 shots[].episodeId 归一到真实集 id，反向映射（shotIds/sceneIds）回填进 storyboard 产物，
     * 并让 project.episodes[].shotIds 对 gates / context 可见（幂等、不改 version）。
     * 未绑项目且剧本无 episodes 时无可判定依据：只把警告记进 stage.warnings，产物逐镜原样保留（不静默丢弃）。
     */
    function normalizeStoryboardEpisodes(run, stage) {
        const shots = stage?.output?.shots;
        if (!Array.isArray(shots) || !shots.length) return;
        const normalized = normalizeShotEpisodeIds({ shots, episodes: storyboardEpisodeAuthority(run) });
        stage.output.shots = normalized.shots;
        if (normalized.episodes.length) {
            // 只落 slim 形状（id/index/title/sceneIds/shotIds），不把项目集的 scenes/status 等内嵌对象带进分镜产物。
            stage.output.episodes = normalized.episodes.map((episode) => ({
                id: episode.id,
                index: episode.index,
                title: String(episode.title ?? ""),
                sceneIds: episode.sceneIds.map(String),
                shotIds: episode.shotIds.map(String),
            }));
        }
        if (normalized.warnings.length) stage.warnings = [...(Array.isArray(stage.warnings) ? stage.warnings : []), ...normalized.warnings];
        persistProjectEpisodeShotIds(run, normalized.episodes);
    }

    /**
     * 每集时长对齐（「先定单集目标时长，再往槽位里填内容」）：
     * 每集骨架 = **单集目标时长**（项目集 durationSec 优先，其次 plan.episodeDurationSec）——
     * 这是作品规格（分钟级）、内容层约束，与「单镜时长」不是一回事（单镜时长跟所选视频模型档位走，不进项目参数）。
     * 逐集校验 Σ(shots[].durationSec) 是否等于该集目标时长，并把每条不一致（缺多少 / 超多少 /
     * 单镜时长不在模型档位内）显式追加进 stage.warnings，同时把逐集对齐结果落到 stage.skeleton —— 绝不静默放过。
     * 档位未查证的模型（durations:null）不做单镜档位强制，但仍校验 Σ段时长 == 单集目标时长。
     */
    function validateSkeleton(run, stage) {
        const plan = planConstraints(run);
        const project = projectOf(run);
        const videoTemplate = String(pipelineConfig.videoTemplate ?? "").trim();
        const tiers = durationsForTemplate(videoTemplate);
        const output = stage?.output && typeof stage.output === "object" ? stage.output : {};
        const shots = (Array.isArray(output.shots) ? output.shots : []).filter((shot) => shot && typeof shot === "object");
        const planSkeleton = plan.episodeDurationSec;
        const projectEpisodes = Array.isArray(project?.episodes) ? project.episodes : [];
        const durationOfEpisode = (episodeId) => {
            const hit = projectEpisodes.find((episode) => String(episode?.id) === String(episodeId));
            const value = Number(hit?.durationSec);
            return Number.isFinite(value) && value > 0 ? value : 0;
        };
        // 按集分组（无 episodeId 时全部归入单集）
        const groups = new Map();
        for (const shot of shots) {
            const key = String(shot.episodeId ?? "").trim() || "ep1";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(shot);
        }
        const hasSkeleton = planSkeleton > 0 || [...groups.keys()].some((id) => durationOfEpisode(id) > 0);
        if (!shots.length || !hasSkeleton) {
            // 没有可比基准（未设每集时长 / 无镜头）时跳过对齐，不制造假告警。
            stage.skeleton = {
                videoTemplate,
                durations: tiers,
                planSkeletonSeconds: planSkeleton || null,
                episodes: [],
                ok: true,
                skipped: true,
                reason: shots.length ? "未设置单集目标时长" : "分镜无镜头",
            };
            return stage.skeleton;
        }
        // ⚠️ 「单集目标时长」是作品规格，**不要求落在模型单镜档位内**（那是两个概念）：
        // 单镜档位只约束每个镜头的 durationSec（见 skeletonAlignment 的 tiers 逐段校验），不约束整集时长。
        const warnings = [];
        const slimEpisodes = Array.isArray(output.episodes) ? output.episodes : [];
        const episodes = [];
        for (const [episodeId, epShots] of groups) {
            const meta = slimEpisodes.find((episode) => String(episode?.id) === String(episodeId));
            const skeletonSeconds = durationOfEpisode(episodeId) || planSkeleton;
            const alignment = skeletonAlignment({ skeletonSeconds, segments: epShots, tiers });
            episodes.push({ episodeId, index: Number(meta?.index) > 0 ? Number(meta.index) : null, shotCount: epShots.length, ...alignment });
            if (!alignment.ok) {
                const label = Number(meta?.index) > 0 ? `第${meta.index}集` : `集 ${episodeId}`;
                warnings.push(`${label}分镜时长未对齐骨架：${alignment.message}`);
            }
        }
        stage.skeleton = { videoTemplate, durations: tiers, planSkeletonSeconds: planSkeleton || null, episodes, ok: episodes.every((episode) => episode.ok) };
        if (warnings.length) stage.warnings = [...new Set([...(Array.isArray(stage.warnings) ? stage.warnings : []), ...warnings])];
        return stage.skeleton;
    }

    /**
     * 单镜档位策略（D1「单镜时长跟着模型走」）：报告所选视频模型的**单镜**可选档位 + 帧数映射。
     * ⚠️ 单镜时长由分镜阶段 + 模型档位决定，**不进项目参数**；故这里绝不拿「单集时长」去比单镜档位
     * （单集时长是作品规格、分钟级，与单镜档位无关 —— 2026-10-04 产品口径）。durations 为 null = 档位待查证。
     * 供流水线自检复用；HTTP 出口是 GET /api/durations。
     */
    function durationPolicy() {
        const videoTemplate = String(pipelineConfig.videoTemplate ?? "").trim();
        const meta = durationMetaForTemplate(videoTemplate);
        return {
            videoTemplate,
            durations: meta.durations,
            verified: meta.verified,
            frameRate: meta.frameRate,
            frameCounts: meta.frameCounts,
            note: meta.note,
        };
    }

    /** 原子写 JSON（临时文件 + 同目录 rename，与 projects.js 的写盘约定一致）。 */
    function persistJsonAtomic(file, value) {
        ensureDir(dirname(file));
        const temp = `${file}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(temp, JSON.stringify(value, null, 2));
        renameSync(temp, file);
    }

    /**
     * 分镜 shot 内嵌的分镜数据（契约 §3.4 的 `storyboard`）：取分镜产物里除稳定 id / 归属键 /
     * index 外的全部字段（含 prompt/action/durationSec/cameraSpec/textOverlays…），保证新建镜
     * 也带完整分镜事实，供前端与下游消费。
     */
    function storyboardPayloadOf(shot) {
        const payload = {};
        for (const key of Object.keys(shot || {})) {
            if (key === "id" || key === "episodeId" || key === "sceneId" || key === "index" || key === "generationSlots" || key === "status" || key === "runShotId") continue;
            payload[key] = shot[key];
        }
        return payload;
    }

    /** 分镜场次 id（sc1）→ 集内真实场次 id（sc_0001）：精确命中优先，其次结尾序号宽松匹配，最后回落原值。 */
    function resolveEpisodeSceneId(currentSceneId, storyboardSceneId, episodeSceneIds) {
        const ids = Array.isArray(episodeSceneIds) ? episodeSceneIds : [];
        const wanted = String(storyboardSceneId ?? "").trim();
        if (wanted && ids.includes(wanted)) return wanted;
        if (ids.includes(String(currentSceneId ?? "").trim())) return String(currentSceneId).trim();
        const ordinal = trailingNumber(wanted);
        if (ordinal) {
            const hit = ids.find((id) => trailingNumber(id) === ordinal);
            if (hit) return hit;
        }
        if (ids.length) return ids[0];
        return String(currentSceneId ?? wanted ?? "").trim();
    }

    /** 关键帧帧 → 契约 §3.5 GenerationSlot[]：一帧一槽，selected 指向采用候选的 jobId，candidates 全量保留。 */
    function generationSlotsFor(frames, shotId) {
        return (Array.isArray(frames) ? frames : []).map((frame) => {
            const role = String(frame?.role ?? "key");
            return {
                id: `slot_${shotId}_${role}`,
                shotId,
                role,
                selected: frame?.selected ?? null,
                candidates: (Array.isArray(frame?.candidates) ? frame.candidates : []).map((candidate) => ({
                    template: String(candidate?.template ?? ""),
                    jobId: String(candidate?.jobId ?? ""),
                    artifactUrl: candidate?.artifactUrl ?? null,
                    status: String(candidate?.status ?? ""),
                    ...(candidate?.params !== undefined ? { params: candidate.params } : {}),
                    ...(candidate?.createdAt !== undefined ? { createdAt: candidate.createdAt } : {}),
                })),
            };
        });
    }

    /**
     * 槽位合并（M2-D5）：run 投影重写 slot 时，保留 jobId 不在本 run 候选集合内的既有候选
     * （画布 / 导入来源），selected 指向被保留候选时保留原值；本 run 没有的既有槽位原样保留，
     * 绝不因重跑关键帧冲掉画布候选与采用结果。
     */
    function mergeGenerationSlots(nextSlots, prevSlots) {
        const prevById = new Map((Array.isArray(prevSlots) ? prevSlots : []).filter((slot) => slot && slot.id).map((slot) => [String(slot.id), slot]));
        const merged = (Array.isArray(nextSlots) ? nextSlots : []).map((slot) => {
            const prev = prevById.get(String(slot.id));
            prevById.delete(String(slot.id));
            if (!prev) return slot;
            const runJobIds = new Set((slot.candidates || []).map((candidate) => String(candidate.jobId)));
            const kept = (Array.isArray(prev.candidates) ? prev.candidates : []).filter((candidate) => candidate && !runJobIds.has(String(candidate.jobId)));
            const next = { ...slot, candidates: [...(slot.candidates || []), ...kept] };
            if (prev.selected && kept.some((candidate) => String(candidate.jobId) === String(prev.selected))) next.selected = prev.selected;
            return next;
        });
        for (const rest of prevById.values()) merged.push(rest);
        return merged;
    }

    /**
     * 一集的关键帧镜：把归一后的分镜 shot 逐个落到 Project 侧 Shot（契约 §3.4），并挂上 frames 派生的
     * `generationSlots`（§3.5）。已存在的镜**按 id / 分镜顺序**复用（保留其稳定 `sh_` 主键与人工编辑），
     * 缺镜才新建（id 用 derivedShotId，稳定幂等）。绝不为分镜没覆盖的旧镜删数据。
     */
    function buildKeyframeShots({ projectId, episodeId, epShots, existing, framesByShot, scenes }) {
        const ordered = existing.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
        const byShotId = new Map(ordered.map((shot) => [String(shot.id), shot]));
        const episodeSceneIds = (Array.isArray(scenes) ? scenes : []).map((scene) => String(scene?.id ?? "")).filter(Boolean);
        const consumed = new Set();
        const next = [];
        epShots.forEach((source, position) => {
            const storyboardShotId = String(source.id ?? "").trim() || `${episodeId}-${position + 1}`;
            const known = byShotId.get(storyboardShotId);
            const match = known && !consumed.has(known) ? known : ordered[position] && !consumed.has(ordered[position]) ? ordered[position] : null;
            if (match) consumed.add(match);
            const shotId = match?.id ? String(match.id) : derivedShotId(projectId, storyboardShotId);
            const shot = match ? { ...match } : { id: shotId, episodeId, sceneId: "", index: 0, storyboard: {}, generationSlots: [], status: "pending" };
            shot.id = shotId;
            shot.episodeId = episodeId;
            // #51：落一个指回运行侧的桥字段。Project 侧 id 是为「增删镜头后旧引用不失效」派生的稳定主键，
            // 与运行侧（storyboard.shots[].id / assembly.clips[].shotId）是两套 id；runShotId 记录本镜回指运行侧的 id，
            // 供导出剪映素材包按映射配对、以及双向解析。幂等：同一 storyboardShotId 重复投影得到同一值。
            shot[RUN_SHOT_ID_FIELD] = storyboardShotId;
            const sceneId = resolveEpisodeSceneId(shot.sceneId, source.sceneId, episodeSceneIds);
            if (sceneId) shot.sceneId = sceneId;
            const storyboardPayload = storyboardPayloadOf(source);
            if (!shot.storyboard || (typeof shot.storyboard === "object" && !Array.isArray(shot.storyboard) && Object.keys(shot.storyboard).length === 0)) shot.storyboard = storyboardPayload;
            if (!(Number(shot.index) > 0)) shot.index = Number(source.index) > 0 ? Number(source.index) : position + 1;
            shot.generationSlots = mergeGenerationSlots(generationSlotsFor(framesByShot.get(storyboardShotId), shotId), match?.generationSlots);
            if (shot.status !== "done" && shot.generationSlots.some((slot) => (slot.candidates || []).some((candidate) => candidate.status === "done"))) shot.status = "done";
            next.push(shot);
        });
        for (const shot of existing) if (!consumed.has(shot)) next.push(shot);
        return next;
    }

    /**
     * 关键帧事实链（修 #48）：把 keyframe 阶段 `frames[]` 的产物幂等投影进 Project 侧
     * `episodes[].shots[].generationSlots[]`（gates.js 判 keyframe done 的唯一依据），并补齐
     * shots[] 本体与 episodes[].shotIds（复用上一波交付的 normalizeShotEpisodeIds 与同语义原子回填）。
     *
     * 触发点 = keyframe 阶段终态（recomputeStage 收口），因此对「关键帧已跑完、当时尚无投影代码」的
     * 历史 run 同样生效：服务重启时 bindJobs() 重放 jobs.json 里已终态的 Job → projectJob → recomputeStage。
     * 仅当阶段 status === "done" 才投影；运行中 / 未完成绝不写，避免「关键帧未完成却误判 done」。
     * 幂等：集详情与 project.json 都做深比较，无变化不写盘；两者都不 bump version（走 persistDerived 语义）。
     * 未绑项目 / project.json 缺失 / 无可判定依据 → 空操作；写入失败只告警，绝不拖垮生成阶段。
     */
    function projectKeyframeFacts(run, stage) {
        if (!run || stage?.id !== "keyframe" || stage.status !== "done") return;
        const projectId = run?.options?.projectId;
        if (!projectId) return;
        const frames = (Array.isArray(stage.output?.frames) ? stage.output.frames : []).filter((frame) => frame && typeof frame === "object");
        if (!frames.length) return;
        const project = projectById(projectId);
        if (!project || !Array.isArray(project.episodes) || !project.episodes.length) return;
        const storyboard = run.stages?.storyboard?.output && typeof run.stages.storyboard.output === "object" ? run.stages.storyboard.output : {};
        const storyboardShots = (Array.isArray(storyboard.shots) ? storyboard.shots : []).filter((shot) => shot && typeof shot === "object");
        if (!storyboardShots.length) return;
        const dir = projectDataDir(projectId);
        if (!dir) return;

        // 复用归一：把分镜 shot 落到真实集 id（项目侧 ep_0001 优先，否则剧本 ep1）。
        const normalized = normalizeShotEpisodeIds({ shots: storyboardShots, episodes: storyboardEpisodeAuthority(run) });
        const framesByShot = new Map();
        for (const frame of frames) {
            const key = String(frame.shotId ?? "").trim();
            if (!key) continue;
            if (!framesByShot.has(key)) framesByShot.set(key, []);
            framesByShot.get(key).push(frame);
        }

        const projected = new Map();
        for (const episode of normalized.episodes) {
            const episodeId = String(episode.id);
            const epShots = normalized.shots.filter((shot) => String(shot.episodeId) === episodeId);
            if (!epShots.length) continue;
            const indexEntry = project.episodes.find((row) => String(row?.id) === episodeId);
            const detailFile = safeJoin(dir, "episodes", `${episodeId}.json`);
            const stored = readJsonFile(detailFile);
            const detail = stored && typeof stored === "object" ? stored : null;
            const existing = detail && Array.isArray(detail.shots) ? detail.shots.filter((shot) => shot && typeof shot === "object") : [];
            // 集内场次：优先盘上详情，其次索引条目内嵌的 scenes（脚本投影把 scenes 落在索引里，别用空数组覆盖、否则 storyboard 门禁会被遮断）。
            const scenes = Array.isArray(detail?.scenes) && detail.scenes.length ? detail.scenes : Array.isArray(indexEntry?.scenes) ? indexEntry.scenes : Array.isArray(episode.scenes) ? episode.scenes : [];
            const nextShots = buildKeyframeShots({ projectId, episodeId, epShots, existing, framesByShot, scenes });
            if (!detail || JSON.stringify(detail.shots) !== JSON.stringify(nextShots)) {
                const nextDetail = {
                    ...(detail || {}),
                    id: episodeId,
                    projectId,
                    index: detail?.index ?? indexEntry?.index ?? episode.index ?? 1,
                    title: String(detail?.title ?? indexEntry?.title ?? episode.title ?? ""),
                    scenes,
                    shots: nextShots,
                };
                try {
                    persistJsonAtomic(detailFile, nextDetail);
                } catch (error) {
                    console.warn(`[pipeline] 关键帧集详情投影失败（不影响生成）：${error.message}`);
                    continue;
                }
            }
            projected.set(episodeId, {
                sceneIds: (Array.isArray(episode.sceneIds) && episode.sceneIds.length ? episode.sceneIds : []).map(String),
                shotIds: nextShots.map((shot) => String(shot.id)),
                shots: nextShots,
            });
        }
        if (!projected.size) return;

        // 把 shots/shotIds/sceneIds 回写 project.episodes（保持 persistDerived 语义：更新 updatedAt、不改 version、无变化不写）。
        let changed = false;
        const nextEpisodes = project.episodes.map((row) => {
            const hit = projected.get(String(row?.id));
            if (!hit) return row;
            const sceneIds = Array.isArray(row.sceneIds) && row.sceneIds.length ? row.sceneIds.map(String) : hit.sceneIds;
            changed = true;
            return { ...row, shots: hit.shots, shotIds: hit.shotIds, sceneIds };
        });
        if (!changed) return;
        if (JSON.stringify(nextEpisodes) === JSON.stringify(project.episodes)) return;
        try {
            persistJsonAtomic(safeJoin(dir, "project.json"), { ...project, episodes: nextEpisodes, updatedAt: nowIso() });
        } catch (error) {
            console.warn(`[pipeline] 关键帧产物投影失败（不影响生成）：${error.message}`);
        }
    }

    /**
     * 回填 Run 侧存量产物的 episodeId（#51 附带问题二）。
     *
     * 背景：`normalizeShotEpisodeIds` 的归一线早已提交，但提交当时服务未重启、且**运行侧的存量产物没有被回填**，
     * 于是 `run.stages.storyboard.output.shots[].episodeId` 与 `assembly.output.clips[].episodeId` 一直是 null，
     * 即便 shotId 能配上、按集分组也做不了。
     *
     * 本函数把存量 run 的 shot 集号归一到真实集 id（项目侧 `ep_0001` 优先，未绑项目回落剧本侧 `ep1`），
     * 并按 runShotId 把 clips 的 episodeId 同步为所属集。**幂等**（值一致不改动 → 调用方 saveRun 不写盘）；
     * 只改 run 记录里的归属键，**绝不改任何产物文件本身**。触发点与 projectKeyframeFacts 相同（recomputeStage
     * 收口）：历史 run 由服务重启时 bindJobs() 重放终态 Job → projectJob → recomputeStage 命中。
     */
    function backfillRunEpisodeIds(run) {
        const storyboard = run?.stages?.storyboard?.output;
        const shots = storyboard?.shots;
        if (!Array.isArray(shots) || !shots.length) return false;
        const normalized = normalizeShotEpisodeIds({ shots, episodes: storyboardEpisodeAuthority(run) });
        let changed = false;
        normalized.shots.forEach((shot, position) => {
            const current = shots[position];
            if (!current) return;
            if (current.episodeId !== shot.episodeId) {
                current.episodeId = shot.episodeId;
                changed = true;
            }
        });
        // clips 的归属集跟着 shot 走（按 shotId 找 owner，不重复读故事）。
        const ownerByShotId = new Map(normalized.shots.map((shot) => [String(shot.id ?? ""), shot.episodeId]));
        for (const clip of Array.isArray(run?.stages?.assembly?.output?.clips) ? run.stages.assembly.output.clips : []) {
            const owner = ownerByShotId.get(String(clip?.shotId ?? ""));
            if (owner !== undefined && clip.episodeId !== owner) {
                clip.episodeId = owner;
                changed = true;
            }
        }
        // 分镜产物里的 slim episodes 同步（幂等）：与 normalizeStoryboardEpisodes 落盘形状一致，不把项目集内嵌对象带进来。
        if (normalized.episodes.length) {
            const slim = normalized.episodes.map((episode) => ({
                id: episode.id,
                index: episode.index,
                title: String(episode.title ?? ""),
                sceneIds: episode.sceneIds.map(String),
                shotIds: episode.shotIds.map(String),
            }));
            if (JSON.stringify(storyboard.episodes) !== JSON.stringify(slim)) {
                storyboard.episodes = slim;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * 参考图条目按 kind 的优先级：角色优先正脸特写（锁面部识别点），其次三视图；场景母版独立一眼。
     * 决定 `selectedArtifactId` 取哪张、以及注入关键帧时的 REF_IMAGE 顺序。
     */
    const REFERENCE_KIND_RANK = Object.freeze({ closeup: 0, master: 0, turnaround: 1 });
    const referenceKindRank = (kind) => (REFERENCE_KIND_RANK[String(kind ?? "").trim()] ?? 5);

    /** 生成执行是否已接线（没接 runJob / jobs.enqueue 时参考图不会真产出，必须回落旧行为）。 */
    const generationWired = () => typeof runJob === "function" && typeof jobs?.enqueue === "function";

    /**
     * 从 03 服化道产物里抽出「参考图生成规格」：角色的正脸特写 / 三视图、场景的空场母版。
     * 只认技能契约里新增的独立生图提示词字段（closeupPrompt / turnaroundPrompt / sceneMasterPrompt）；
     * 缺字段（旧产物）→ 不产条目、不报错（旧行为逐字不变）。
     */
    function designReferenceSpecs(output) {
        const specs = [];
        for (const character of Array.isArray(output?.characters) ? output.characters : []) {
            const id = String(character?.id ?? "").trim();
            if (!id) continue;
            const name = String(character?.name ?? "");
            const closeup = String(character?.closeupPrompt ?? "").trim();
            const turnaround = String(character?.turnaroundPrompt ?? "").trim();
            if (closeup) specs.push({ id: `${id}-closeup`, bindingId: id, role: ASSET_ROLE.CHARACTER, kind: "closeup", name, prompt: closeup });
            if (turnaround) specs.push({ id: `${id}-turnaround`, bindingId: id, role: ASSET_ROLE.CHARACTER, kind: "turnaround", name, prompt: turnaround });
        }
        for (const location of Array.isArray(output?.locations) ? output.locations : []) {
            const id = String(location?.id ?? "").trim();
            if (!id) continue;
            const master = String(location?.sceneMasterPrompt ?? "").trim();
            if (master) specs.push({ id: `${id}-master`, bindingId: id, role: ASSET_ROLE.SCENE, kind: "master", name: String(location?.name ?? ""), prompt: master });
        }
        return specs;
    }

    /**
     * 流水线生图尺寸：默认走**模型官方画质档**（sizeForRatio，按画幅匹配登记表）。
     * `pipelineConfig.imageDraft === true` 时改用 config 里的 imageWidth/imageHeight（草稿档）。
     *
     * 为什么需要草稿档（2026-10-06 实测）：Qwen-Image-2.1 在 5060 Ti 上
     * 768×1344 与官方 1536×2752 **耗时相同（约 21.5s）**——像素量差 4 倍、时间不变。
     * 批量生产（70 镜 × N 候选）用草稿档，存储与上传成本降一个量级，画质换来的收益却接近 0。
     * 交付成片时用 `imageDraft: false`（默认）走官方档。
     */
    function imageDimsFor(style, extra = {}, templateOverride = null) {
        const template = String(templateOverride || pipelineConfig.imageTemplate || "").trim();
        const baseW = Number(pipelineConfig.imageWidth) || 768;
        const baseH = Number(pipelineConfig.imageHeight) || 1344;
        if (pipelineConfig.imageDraft === true) {
            return { width: baseW, height: baseH, size: baseW + "x" + baseH, ratio: style.ratio, source: "draft", matched: true, template, model: null, warning: null, ...extra };
        }
        return sizeForRatio(template, style.ratio, { base: Math.min(baseW, baseH), ...extra });
    }

    /** 单条参考图条目的生图计划（纯文生图；参考图本身不需要参考图输入）。 */
    function designReferencePlan(run, item) {
        const style = productionDefaults(run);
        const template = configuredTemplateForStage(run, "design", "image");
        // 尺寸从「该生图模板的官方规格登记表」取（画幅匹配优先，否则回落默认 + warning），不再实时按比例推导。
        const imageDims = imageDimsFor(style, {}, template);
        const projectId = run?.options?.projectId;
        const params = {
            WIDTH: imageDims.width ?? (Number(pipelineConfig.imageWidth) || 768),
            HEIGHT: imageDims.height ?? (Number(pipelineConfig.imageHeight) || 1344),
            BATCH: Number(pipelineConfig.imageBatch) || 1,
            PROMPT: withPromptHead(style, item.prompt),
        };
        // 绑项目时给稳定 seed + 按 run+条目隔离的 OUTPUT_PREFIX（参考图可复现、文件名不与其它 run 串号）。
        if (projectId) {
            params.SEED = stableSeed(projectId, item.id, 0);
            params.OUTPUT_PREFIX = outputPrefixFor(run.id, item.id);
        }
        return { kind: STAGE_KIND.design, template, ready: true, params };
    }

    /**
     * design 阶段真正产出参考图（§12 第 2 优先级「角色/场景参考锁」）：把 closeupPrompt / turnaroundPrompt /
     * sceneMasterPrompt 变成生图任务入队，产物登记进 stage.artifacts，并在全部终态后绑定到 AssetRef.selectedArtifactId。
     * 幂等：继承 prev 的候选与产物，已有候选的条目不再重复入队；重复跑不重复登记（binding 侧有 (runId,stageId,bindingId) 去重）。
     * 返回是否仍有未终态的参考图任务（决定阶段停在 running 还是 done）。
     */
    function attachDesignReferences(run, def, stage, prev) {
        const output = stage.output && typeof stage.output === "object" ? (stage.output) : (stage.output = {});
        const specs = designReferenceSpecs(output);
        const prevById = new Map((Array.isArray(prev?.references) ? prev.references : []).map((item) => [item.id, item]));
        const items = specs.map((spec) => {
            const old = prevById.get(spec.id);
            return {
                id: spec.id,
                bindingId: spec.bindingId,
                role: spec.role,
                kind: spec.kind,
                name: spec.name,
                prompt: spec.prompt,
                template: old?.template ?? null,
                jobId: null,
                artifactUrl: old?.artifactUrl ?? null,
                status: "queued",
                candidates: old?.candidates ? old.candidates.map((candidate) => ({ ...candidate })) : [],
                selected: old?.selected ?? null,
            };
        });
        output.references = items;
        for (const item of items) {
            const plan = designReferencePlan(run, item);
            item.template = plan.template;
            if ((item.candidates || []).length || !plan.ready) continue;
            enqueueAttempt(run, def, item, plan);
        }
        for (const item of items) syncItem(item);
        return items.some((item) => {
            const latest = (item.candidates || []).at(-1);
            return latest && (latest.status === "queued" || latest.status === "running");
        });
    }

    /**
     * 参考图条目落地后把产物绑定到对应 AssetRef：artifactIds 收全部已产出参考图、selectedArtifactId 取最高优先级那张
     * （角色优先正脸特写、场景取空场母版；referenceKindRank 语义不变）。等同一绑定的参考图全部终态才登记——一次写入即最终结果。
     * 幂等判据 = 「同 (runId, stageId, bindingId) 且**已绑定产物**」：命中即跳过，绝不复写已有 selectedArtifactId（不覆盖既有选择）。
     * 关键修复：历史遗留的**空引用**（artifactIds 空且无 selectedArtifactId）不再算「已有」而 continue——那样会让参考图永远绑不上去；
     * 改为就地 update 该引用填入本轮产物（自愈存量空占位），否则才 create（同 bindingId 不产生重复引用）。
     */
    function bindDesignReferenceArtifacts(run, stage) {
        if (typeof registerAssetRef !== "function") return;
        const projectId = run?.options?.projectId;
        if (!projectId || stage?.id !== "design") return;
        const project = projectOf(run);
        if (!project) return;
        const items = Array.isArray(stage.output?.references) ? stage.output.references : [];
        if (!items.length) return;
        const refs = Array.isArray(project.assetRefs) ? project.assetRefs : [];
        // 已有「同 (runId, stageId)」引用按 bindingId 索引，并区分「已绑定产物」/「空引用」两种语义：
        //  - 已绑定（artifactIds 非空 或 selectedArtifactId 存在）→ 幂等锚点，跳过；
        //  - 空引用（上一版 registerDesignAssets 预建的占位）→ 待 update 填充，不能跳过。
        const existingByBinding = new Map();
        for (const ref of refs) {
            if (ref?.metadata?.runId !== run.id || ref?.metadata?.stageId !== "design") continue;
            const key = String(ref.bindingId ?? "").trim();
            if (!key) continue;
            const bound = (Array.isArray(ref.artifactIds) && ref.artifactIds.length > 0) || Boolean(ref.selectedArtifactId);
            const prev = existingByBinding.get(key);
            // 同 bindingId 多条（历史重复）：已绑定的那条优先作幂等锚点；否则保留第一条空引用用于就地填充。
            if (!prev) existingByBinding.set(key, { ref, bound });
            else if (bound && !prev.bound) existingByBinding.set(key, { ref, bound });
        }
        const byBinding = new Map();
        for (const item of items) {
            const key = String(item?.bindingId ?? "").trim();
            if (!key) continue;
            if (!byBinding.has(key)) byBinding.set(key, []);
            byBinding.get(key).push(item);
        }
        for (const [bindingId, group] of byBinding) {
            const existing = existingByBinding.get(bindingId);
            if (existing?.bound) continue; // 已绑定产物 → 幂等跳过，不覆盖已有 selectedArtifactId
            const terminal = group.every((item) => item.status === "done" || item.status === "error" || item.status === "canceled");
            if (!terminal) continue;
            const role = String(group[0]?.role ?? "").trim();
            if (role !== ASSET_ROLE.CHARACTER && role !== ASSET_ROLE.SCENE) continue;
            const ordered = group.slice().sort((a, b) => referenceKindRank(a.kind) - referenceKindRank(b.kind));
            const artifactIds = ordered.map((item) => item.artifactUrl).filter(Boolean);
            if (!artifactIds.length) continue; // 全失败/无产物：不登记空引用（避免污染项目引用表）
            const preferred = ordered.find((item) => item.artifactUrl);
            const selectedArtifactId = preferred?.artifactUrl ?? null;
            const metadata = {
                source: "pipeline",
                runId: run.id,
                stageId: stage.id,
                kind: "reference",
                name: String(group[0]?.name ?? ""),
                artifactUrl: preferred?.artifactUrl ?? null,
                jobId: preferred?.jobId ?? null,
                views: Array.isArray(group[0]?.views) ? group[0].views : [],
                confirmed: false,
            };
            try {
                if (existing?.ref && typeof updateAssetRef === "function") {
                    // 空引用就地填充（自愈存量空引用的关键路径）：不新增引用、不产生重复。
                    updateAssetRef(projectId, existing.ref.id, { role, artifactIds, selectedArtifactId, metadata });
                    existing.bound = true;
                } else {
                    // 无引用 → create；有引用但未注入 updateAssetRef → 仍 create（下游 mergedAssetRefs 会合并重复），
                    // 绝不静默漏绑（绑定成功优先于「不留占位」）。
                    if (existing?.ref) console.warn(`[pipeline] 未注入 updateAssetRef，参考图绑定将新增引用而非就地填充（bindingId=${bindingId}）`);
                    registerAssetRef(projectId, { role, bindingId, artifactIds, selectedArtifactId, metadata });
                    existingByBinding.set(bindingId, { ref: existing?.ref ?? null, bound: true });
                }
            } catch (error) {
                console.warn(`[pipeline] 参考图资产绑定失败（不影响阶段）：${error.message}`);
            }
        }
    }

    /**
     * 服化道（design）阶段产物自动登记为项目 AssetRef，补上「design 无产物 → 项目门禁永远判不出 done」的缺口。
     * 角色 → role=character、场景 → role=scene，bindingId 取剧本里的角色/场景 id（契约 §3.8：一致性锚点）。
     * 走 registerArtifacts 同一套注入的 registerAssetRef + 幂等去重：按 (runId, stageId, bindingId) 命中即跳过，
     * 重启重放读到旧引用同样不重复；登记失败只告警，绝不拖垮阶段。
     * 若某绑定将由参考图生成（有 closeupPrompt 等且生成已接线），这里**不**预建空引用——改由
     * bindDesignReferenceArtifacts 在参考图落地后带 artifactIds/selectedArtifactId 一次登记（避免空引用先占位、后无法 update）。
     * 不直接 import assets.js：真正写盘走注入的 registerAssetRef（index.js 接 projects.assets.create），保持解耦。
     */
    function registerDesignAssets(run, stage) {
        if (typeof registerAssetRef !== "function") return;
        const projectId = run?.options?.projectId;
        if (!projectId || stage?.id !== "design") return;
        const project = projectOf(run);
        if (!project) return;
        const output = stage.output && typeof stage.output === "object" ? stage.output : {};
        const refs = Array.isArray(project.assetRefs) ? project.assetRefs : [];
        // bindingId 是引用自身字段（不是 metadata），按 (runId, stageId, bindingId) 去重。
        const seen = new Set(
            refs.filter((ref) => ref?.metadata?.runId === run.id && ref?.metadata?.stageId === "design").map((ref) => ref.bindingId),
        );
        const groups = [
            ["characters", ASSET_ROLE.CHARACTER],
            ["locations", ASSET_ROLE.SCENE],
        ];
        // 由参考图生成负责的绑定（有 closeupPrompt 等且生成已接线）延后到 bindDesignReferenceArtifacts 登记，不预建空引用。
        const deferred = generationWired()
            ? new Set((Array.isArray(output.references) ? output.references : []).map((item) => String(item?.bindingId ?? "").trim()).filter(Boolean))
            : new Set();
        for (const [key, role] of groups) {
            for (const item of Array.isArray(output[key]) ? output[key] : []) {
                const bindingId = String(item?.id ?? "").trim();
                if (!bindingId || seen.has(bindingId) || deferred.has(bindingId)) continue;
                try {
                    registerAssetRef(projectId, {
                        role,
                        bindingId,
                        artifactIds: [],
                        selectedArtifactId: null,
                        metadata: { source: "pipeline", runId: run.id, stageId: stage.id, kind: key, name: String(item?.name ?? "") },
                    });
                    seen.add(bindingId);
                } catch (error) {
                    console.warn(`[pipeline] 服化道产物自动登记资产失败（不影响阶段）：${error.message}`);
                }
            }
        }
    }

    /**
     * 生成型阶段产物自动登记为项目 AssetRef（补上「跑完图/视频还得手动逐个登记引用」的半自动缺口）。
     * 只做「何时登记」：只在应注入 registerAssetRef、run 绑了项目、且阶段是生成型阶段时登记；
     * 一条产物一条引用（role 见 GENERATIVE_STAGE_ASSET_ROLE），幂等依据 (projectId, runId, artifactUrl)——
     * 先读项目现有 assetRefs 命中即跳过，重启重放读到旧引用同样不重复；登记失败只告警，绝不拖垮生成阶段。
     * 不直接 import assets.js：真正写盘走注入的 registerAssetRef（index.js 接 projects.assets.create），保持解耦。
     */
    function registerArtifacts(run, stage) {
        if (typeof registerAssetRef !== "function") return;
        const projectId = run?.options?.projectId;
        if (!projectId) return;
        const role = GENERATIVE_STAGE_ASSET_ROLE[stage?.id];
        if (!role) return;
        const project = projectOf(run);
        if (!project) return;
        const refs = Array.isArray(project.assetRefs) ? project.assetRefs : [];
        // 已登记过的 (runId, artifactUrl) 集合：重建 run / 重启重放时同样命中，不重复登记。
        const seen = new Set(refs.filter((ref) => ref?.metadata?.runId === run.id).map((ref) => ref.metadata.artifactUrl));
        const items = stage.output?.frames || stage.output?.clips || [];
        const itemByJob = new Map(items.filter((item) => item.jobId).map((item) => [item.jobId, item]));
        const itemByUrl = new Map(items.filter((item) => item.artifactUrl).map((item) => [item.artifactUrl, item]));
        for (const artifact of Array.isArray(stage.artifacts) ? stage.artifacts : []) {
            const url = artifact?.url;
            if (!url || seen.has(url)) continue;
            // manifest/log/cover 等成片附属文件不是媒体资产，只登记片段本体与成片本体（role 为 output）。
            if (artifact.role && artifact.role !== "output") continue;
            const item = itemByUrl.get(url) || (artifact.jobId ? itemByJob.get(artifact.jobId) : null);
            const bindingId = String(item?.id || item?.shotId || artifact.id || artifact.jobId || "").trim();
            if (!bindingId) continue;
            try {
                registerAssetRef(projectId, {
                    role,
                    bindingId,
                    artifactIds: [url],
                    selectedArtifactId: url,
                    metadata: { source: "pipeline", runId: run.id, stageId: stage.id, jobId: artifact.jobId ?? null, artifactUrl: url },
                });
                seen.add(url);
            } catch (error) {
                console.warn(`[pipeline] 产物自动登记资产失败（不影响生成）：${error.message}`);
            }
        }
    }

    /**
     * 项目级制作参数：plan.ratio / episodeDurationSec 与 styleAnchor + visualStyle/genre/tone 组成创作上下文。
     * 风格锚点走 resolveStyleAnchor（项目优先，其次 run.options）；未绑项目且无锚点时全部为空 → 生成参数与旧版逐字一致。
     * filmLayer 是「条件叠加」的判定结果：只有锚点命中胶片/写实类关键词才给 Luster 冻结胶片层，否则为空（默认关闭）。
     */
    function productionDefaults(run) {
        const project = projectOf(run);
        const plan = project?.plan && typeof project.plan === "object" ? project.plan : null;
        const anchor = resolveStyleAnchor(run);
        // 创作上下文首句固定是 styleAnchor（一字不差），其后才是视觉形式/题材/基调。
        const flavor = [plan?.visualStyle, plan?.tone, plan?.genre]
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
            .join("，");
        return {
            ratio: String(plan?.ratio ?? "").trim(),
            episodeDurationSec: Number(plan?.episodeDurationSec) > 0 ? Number(plan.episodeDurationSec) : null,
            // 项目已明确选择时才启用独立对白；未绑定项目/旧 run 没有制作计划时沿用片段原声。
            audioMode: plan && String(plan.audioMode ?? "").trim() !== ""
                ? (String(plan.audioMode).trim() === AUDIO_MODE.EMBEDDED ? AUDIO_MODE.EMBEDDED : AUDIO_MODE.SEPARATE_DIALOGUE_TRACK)
                : AUDIO_MODE.SEPARATE_DIALOGUE_TRACK,
            anchor,
            context: [anchor, flavor].filter(Boolean).join("。"),
            filmLayer: anchor && FILM_ANCHOR_PATTERN.test(anchor) ? LUSTER_FILM_LAYER : "",
        };
    }

    /**
     * 把项目 assetRefs 归并成「每个 (role, bindingId) 一条」的视图后再交给 reference-lock。
     * 同一绑定可能出现多条引用（如服化道空引用 + 参考图绑定 / 多次登记），合并后取并集 artifactIds、
     * 选第一个非空 selectedArtifactId，保证 resolveSelectedArtifacts / missingRefsReport 命中真正锁定的那张。
     */
    function mergedAssetRefs(assetRefs) {
        const order = [];
        const merged = new Map();
        for (const ref of Array.isArray(assetRefs) ? assetRefs : []) {
            if (!ref || typeof ref !== "object") continue;
            const bindingId = String(ref.bindingId ?? "").trim();
            if (!bindingId) continue;
            const key = `${String(ref.role ?? "").trim()}::${bindingId}`;
            if (!merged.has(key)) {
                order.push(key);
                merged.set(key, { ...ref, artifactIds: [], selectedArtifactId: null });
            }
            const target = merged.get(key);
            const artifacts = Array.isArray(ref.artifactIds) ? ref.artifactIds : [];
            for (const artifact of artifacts) if (artifact && !target.artifactIds.includes(artifact)) target.artifactIds.push(artifact);
            if (!target.selectedArtifactId && ref.selectedArtifactId) target.selectedArtifactId = String(ref.selectedArtifactId);
        }
        return order.map((key) => merged.get(key));
    }

    /** 产物 URL 兜底：selectedArtifactId 在本项目里就是产物 URL；兼容 reference-lock 返回 url 或 artifactId。 */
    /**
     * 取参考图的可用地址。
     *
     * 2026-10-06 修的场景母版丢失问题：assetRef 里存的 `artifactId` 是**产物相对路径**
     * （形如 `image-muv4viaa-lony6/img_qwen21_t2i_00001_.png`，jobId/文件名），
     * 既不是 http(s) 也不以 `/` 开头，于是旧实现 `return ""` 把它判成「没有参考图」。
     * 后果不是聚合视图少一组，而是**关键帧只注入角色定妆照、场景母版一张都没进参考图** ——
     * 每镜的地点其实没锁住，21 张场景母版白跑。已跑的任务里只有 INPUT_IMAGE/REF_IMAGE_1，
     * 且都指向角色定妆照。
     *
     * 补上裸相对路径这一形态：`<非空段>/<非空段>` 视为 `jobId/文件名`，补成 `/api/artifacts/...`。
     * 该形态与 resolveMediaPath 认的 `/api/artifacts/<jobId>/<file>` 一致。
     */
    const referenceUrlOf = (entry) => {
        const url = String(entry?.url ?? "").trim();
        if (url) return url;
        const artifactId = String(entry?.artifactId ?? "").trim();
        if (/^(https?:|\/)/.test(artifactId)) return artifactId;
        // 裸相对路径 `jobId/文件名` → 补成网关产物地址（与 delivery.resolveMediaPath 同规则）
        const segments = artifactId.split("/").filter(Boolean);
        if (segments.length >= 2) return `/api/artifacts/${segments.join("/")}`;
        return "";
    };

    /**
     * 为 ShotBinding 组装 scenes 上下文。分镜 shot 只有 sceneId、没有 locationId，locationId 必须靠
     * sceneId → scene → design.locations 名称锚点推；而分镜产物常常只含 shots（无 scenes），此时
     * reference-lock 的 collectScenes 拿不到任何 scene，locationId 永远推不出来 → 场景母版进不了 REF_IMAGE。
     * 这里按 storyboard → 剧本阶段顺序补齐 scenes（按 id 去重，storyboard 优先），让 shot.sceneId 能命中
     * 剧本场景、再由 scene.location 名称映射到 design 地点锚点。推不出时交回 reference-lock 判缺（不编造）。
     */
    function sceneContextForBinding(run, storyboard) {
        const scenes = [];
        const seen = new Set();
        const push = (list) => {
            for (const scene of Array.isArray(list) ? list : []) {
                if (!scene || typeof scene !== "object") continue;
                const id = String(scene.id ?? "").trim();
                if (id && seen.has(id)) continue;
                if (id) seen.add(id);
                scenes.push(scene);
            }
        };
        push(storyboard?.scenes);
        push(storyboard?.output?.scenes);
        for (const episode of Array.isArray(storyboard?.episodes) ? storyboard.episodes : []) push(episode?.scenes);
        // 分镜缺 scenes 时回落剧本阶段：剧本 scenes 带 location 名称，可映射到 design.locations 锚点。
        push(run?.stages?.script?.output?.scenes);
        return scenes;
    }

    /**
     * 按 ShotBinding 解析该镜的角色/场景/道具参考图（§11.5.4）。返回原始 binding、需要的绑定数、
     * reference-lock 的缺参考图报告，以及可注入的 REF_IMAGE URL（角色在前、场景/道具在后）。
     */
    function shotReferenceContext(run, item, shots) {
        const storyboard = run.stages?.storyboard?.output && typeof run.stages.storyboard.output === "object" ? run.stages.storyboard.output : {};
        const design = run.stages?.design?.output && typeof run.stages.design.output === "object" ? run.stages.design.output : {};
        const project = projectOf(run);
        const assetRefs = mergedAssetRefs(project?.assetRefs);
        const shot = shots.find((entry) => String(entry?.id) === String(item?.shotId)) || {};
        // 关键帧条目自身没有 sceneId，用分镜 shot 提供 sceneId/action；并把本帧 prompt 一并纳入名字匹配。
        const shotForBinding = {
            ...shot,
            id: String(shot?.id ?? item?.shotId ?? ""),
            prompt: [shot?.prompt, item?.prompt].filter(Boolean).join("\n"),
        };
        // 补齐 scenes 上下文（分镜常无 scenes），否则 shot→locationId 推导断链、场景母版丢失。
        const scenes = sceneContextForBinding(run, storyboard);
        const shotBinding = buildShotBinding({ shot: shotForBinding, storyboard: { ...storyboard, scenes }, design, assetRefs });
        const resolved = resolveSelectedArtifacts({ shotBinding, assetRefs });
        const report = missingRefsReport({ shotBinding, assetRefs });
        const needCount = shotBinding.characterIds.length + (shotBinding.locationId ? 1 : 0) + shotBinding.propIds.length;
        // 参考图「注入顺序」事实源：角色在前、场景/道具在后，附上角色/场景名（供编译器写素材说明，编号不写死在内容层）。
        const nameById = new Map();
        for (const character of Array.isArray(design.characters) ? design.characters : []) nameById.set(`character::${String(character?.id ?? "")}`, String(character?.name ?? ""));
        for (const location of Array.isArray(design.locations) ? design.locations : []) nameById.set(`scene::${String(location?.id ?? "")}`, String(location?.name ?? ""));
        for (const prop of Array.isArray(design.props) ? design.props : []) nameById.set(`prop::${String(prop?.id ?? "")}`, String(prop?.name ?? ""));
        const infos = [];
        for (const [role, list] of [
            ["character", resolved.character],
            ["scene", resolved.scene],
            ["prop", resolved.prop],
        ]) {
            for (const entry of list) {
                const url = referenceUrlOf(entry);
                if (!url) continue;
                infos.push({ url, role, bindingId: entry.bindingId, name: nameById.get(`${role}::${entry.bindingId}`) || "" });
            }
        }
        const urls = infos.map((entry) => entry.url);
        return { shotBinding, report, needCount, urls, infos };
    }

    /**
     * 按角色 / 场景 / 道具聚合关键帧条目（2026-10-06）。
     *
     * ## 为什么按「引用关系」而不是「提示词里出现名字」
     *
     * 最早我以为聚合 = 把提示词里出现「陈默」的镜头归到一起。但那是**字符串猜测**：
     * 提示词可能被改、可能只写「他」，而真正决定画面一致性的，
     * **是这一镜实际引用了哪张定妆照**。所以这里直接用 shotReferenceContext 算出的
     * infos（role / bindingId / name / url）—— 那才是锁住身份的事实源。
     *
     * 用途：一眼看出「陈默在 68 镜里的定妆照引用是否始终一致」。
     * 若某镜没引用定妆照，它会单独落在 groups.unbound 里 —— 这本身就是质量信号：
     * 没锁脸的镜头，出图时角色长相会漂。
     *
     * 纯读，不改任何状态。
     */
    function groupFramesByReference(runId, stageId = "keyframe") {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        const frames = def.id === "keyframe" ? stage.output?.frames : stage.output?.clips;
        const list = Array.isArray(frames) ? frames : [];
        const shots = run.stages?.storyboard?.output?.shots || [];
        const groups = new Map();
        const unbound = [];

        for (const frame of list) {
            let infos = [];
            try {
                infos = shotReferenceContext(run, frame, shots).infos || [];
            } catch {
                // 上下文不全时按「未绑定」处理，不静默丢条目 —— 那会让人以为聚合是完整的。
                infos = [];
            }
            if (!infos.length) {
                unbound.push({ itemId: frame.id, shotId: frame.shotId ?? null, role: frame.role ?? null, status: frame.status ?? null });
                continue;
            }
            for (const info of infos) {
                const key = `${info.role}::${info.bindingId}`;
                const bucket = groups.get(key) ?? { role: info.role, bindingId: info.bindingId, name: info.name || info.bindingId, referenceUrl: info.url, items: [] };
                bucket.items.push({ itemId: frame.id, shotId: frame.shotId ?? null, role: frame.role ?? null, status: frame.status ?? null, artifactUrl: frame.artifactUrl ?? null, selected: frame.selected ?? null });
                groups.set(key, bucket);
            }
        }

        const grouped = [...groups.values()]
            .map((bucket) => ({ ...bucket, count: bucket.items.length }))
            .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
        return { groups: grouped, unbound, total: list.length };
    }

    /** 取本镜的场景对象（分镜既有 scenes + 剧本回落），供编译器写「地点」。 */
    function sceneForShot(run, shot) {
        const id = String(shot?.sceneId ?? "").trim();
        if (!id) return {};
        const storyboard = run.stages?.storyboard?.output && typeof run.stages.storyboard.output === "object" ? run.stages.storyboard.output : {};
        const scenes = sceneContextForBinding(run, storyboard);
        return scenes.find((scene) => String(scene?.id ?? "") === id) || { id };
    }

    /** 由 shotBinding.characterIds 取本镜绑定的角色对象（design.characters 是事实源），供编译器写主体。 */
    function charactersForShot(run, shotBinding) {
        const design = run.stages?.design?.output && typeof run.stages.design.output === "object" ? run.stages.design.output : {};
        const byId = new Map((Array.isArray(design.characters) ? design.characters : []).map((character) => [String(character?.id ?? ""), character]));
        return (Array.isArray(shotBinding?.characterIds) ? shotBinding.characterIds : []).map((id) => byId.get(String(id))).filter(Boolean);
    }

    /**
     * 取本 run 的**全局角色表**（台词说话人 (Sx) 稳定编号的事实源）：design.characters 优先，回落剧本 characters。
     * 同一角色跨镜拿到同一个 (S1)/(S2) —— H3 官方要求同一说话人跨镜保持同 ID。
     */
    function castForRun(run) {
        const design = run.stages?.design?.output && typeof run.stages.design.output === "object" ? run.stages.design.output : {};
        if (Array.isArray(design.characters) && design.characters.length) return design.characters;
        const project = projectOf(run);
        return Array.isArray(project?.script?.characters) ? project.script.characters : [];
    }

    /**
     * 台词说话人归属的 warning（逐级回落的可解释结果，**不阻塞**）：仅当该视频模型承载台词（H3）时才产出。
     * 旧字符串 dialogue 在多角色镜头里无法确定归属 → 由 resolveDialogueLines 记 warning，供 plan.warning 留痕。
     */
    function dialogueAttributionWarnings(template, shot, characters, cast) {
        if (!templateCarriesDialogue(template)) return [];
        const { warnings } = resolveDialogueLines(shot, characters, cast);
        return warnings.map((entry) => entry?.reason).filter(Boolean);
    }

    /** 优先参考图模板：显式 configured 优先，否则含 edit 的参考图模板，最后字典序第一个。 */
    function preferredReferenceTemplate() {
        const configured = String(pipelineConfig.referenceImageTemplate ?? "").trim();
        if (configured && templateCatalog[configured]?.supportsReference) return configured;
        const capable = listReferenceCapableTemplates(templateCatalog, "image");
        return capable.find((name) => /edit/i.test(name)) || capable[0] || "";
    }

    /**
     * 为需要锁角色的镜头选模板（按 tool-adapter 的真实能力判定，不硬编码名单）：
     * - 不需要参考图 → 沿用 config.imageTemplate（纯文生图即可）；
     * - 需要参考图且当前模板吃得下 → 用它；
     * - 否则改用参考图模板（同为 Qwen-Image 2.1 血统、带 REF_IMAGE 槽的 img_qwen21_edit 一类）。
     * - 没有任何能吃参考图的模板 / 参考图数超上限 → ok:false，附可解释原因（调用方据此标 blocked，绝不假装已锁角色）。
     */
    function decideKeyframeTemplate(needCount, refCount, preferredTemplate = "") {
        const imageTemplate = String(preferredTemplate || (pipelineConfig.imageTemplate ?? "")).trim();
        if (needCount <= 0) return { ok: true, template: imageTemplate, reason: "" };
        const need = Math.max(1, refCount);
        const primary = templateCatalog[imageTemplate];
        if (primary?.supportsReference && primary.maxReferenceImages >= need) {
            return { ok: true, template: imageTemplate, reason: `模板 ${imageTemplate} 支持 ${primary.maxReferenceImages} 张参考图，可锁定角色` };
        }
        const referenceTemplate = preferredReferenceTemplate();
        if (referenceTemplate) {
            const decision = resolveToolForShot({ template: referenceTemplate, needReferenceImages: need, catalog: templateCatalog });
            if (decision.ok) return { ok: true, template: referenceTemplate, reason: decision.reason };
        }
        const blockedDecision = resolveToolForShot({ template: imageTemplate, needReferenceImages: need, catalog: templateCatalog });
        return { ok: false, template: imageTemplate, reason: blockedDecision.reason };
    }

    /**
     * 模板是否要求必填的主输入底图 INPUT_IMAGE。由 tool-adapter 扫真实节点/占位符得出（不硬编码模板名）：
     * slots.INPUT_IMAGE 来自真实 LoadImage 节点；tokens 兜底覆盖占位符存在但非 LoadImage 的少见写法。
     * generate.js 里只有 REF_IMAGE_* 是 optional，INPUT_IMAGE 缺一个就会在参数校验阶段被拒。
     */
    function templateRequiresInputImage(template) {
        const info = templateCatalog[String(template ?? "").trim()];
        if (!info) return false;
        return Boolean(info.slots?.INPUT_IMAGE) || (Array.isArray(info.tokens) && info.tokens.includes("INPUT_IMAGE"));
    }

    /** PROMPT 带 [untranslated] 标记 → 一条 warning（该模型官方口径未生效），否则 null。 */
    function untranslatedWarning(prompt) {
        return typeof prompt === "string" && prompt.includes("[untranslated")
            ? { reason: "提示词未英文化：语言适配 LLM 不可用/未生效，已按同步结构产出并显式标记 [untranslated]" }
            : null;
    }

    /**
     * 条目上「改写失败/画幅冲突」那几段 warning（由 compilePromptItem 的 onWarning 写入）。
     * 单独取出来是为了让它跟着 job meta 一起留痕 —— 排查时看 job 就够，不必翻 run item。
     * ⚠️ 只能在**读**的方向用（拼进 job meta）；绝不能回灌进 plan.warning，否则 enqueueReady 会把它
     *    再追加回 item.warning，bindJobs 每次启动重放都自我放大（曾因此撑爆字符串长度、启动崩溃）。
     */
    function rewriteWarningOf(item) {
        const raw = typeof item?.warning === "string" ? item.warning : "";
        return raw
            .split("；")
            .filter((part) => part.includes("提示词改写失败"))
            .join("；");
    }

    /** 追加一条 warning（按「；」分段去重）：投影会在启动重放时反复执行，不去重就会无限增长。 */
    function appendWarning(item, reason) {
        const text = String(reason ?? "").trim();
        if (!text || !item) return;
        const parts = String(item.warning ?? "")
            .split("；")
            .map((part) => part.trim())
            .filter(Boolean);
        if (parts.includes(text)) return;
        item.warning = [...parts, text].join("；");
    }

    /** 追加一条**阶段级** warning（去重，供前端/交付读取；与 appendWarning 同语义，只是挂在 stage 上）。 */
    function appendStageWarning(stage, reason) {
        const text = String(reason ?? "").trim();
        if (!text || !stage) return;
        const parts = Array.isArray(stage.warnings) ? stage.warnings.map((part) => String(part).trim()).filter(Boolean) : [];
        if (parts.includes(text)) return;
        stage.warnings = [...parts, text];
    }

    /** 编译事实指纹：排除 item 的派生字段，内容/槽位/模板变化就会得到新指纹。 */
    function promptCompileFingerprint(compileInput) {
        const { item: _item, ...facts } = compileInput || {};
        return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    }

    /** 产物内容指纹：阶段本身没有 revision，日志里用它对账"这一版产物到底是哪一版"。 */
    function outputHash(value) {
        try {
            return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
        } catch {
            return null;
        }
    }

    /** 审计日志的 actor：HTTP 层可带 actor，缺省记 local（本工具是单机自用，不假装有账号体系）。 */
    const actorOf = (source) => String(source?.actor ?? "local").trim() || "local";

    /** 上游产物按阶段 id 暴露给产物契约校验（只给真正产出的那几段）。 */
    function stageUpstreamOf(run) {
        const upstream = {};
        for (const def of registry.stages) {
            const output = run.stages?.[def.id]?.output;
            if (output !== undefined && output !== null) upstream[def.id] = output;
        }
        return upstream;
    }

    /**
     * 提示词快照版本：编译器产物语义变化时（例如 H3 追加 [untranslated] 标记并开始消费结构化 rewrite）
     * 必须 +1。否则旧 run 已落盘的快照会因 template 与事实指纹都没变而永远命中，新编译器刷新不出来。
     */
    const PROMPT_COMPILATION_VERSION = 2;

    /** 把最终稿与排查元数据落在 item 上；候选 params 另存一份，旧 job 因而保持不可变。 */
    function savePromptSnapshot(item, compileInput, raw) {
        const prompt = stripUntranslatedMarker(raw);
        item.promptCompilation = {
            version: PROMPT_COMPILATION_VERSION,
            template: compileInput.template,
            fingerprint: promptCompileFingerprint(compileInput),
            prompt,
            rawPrompt: String(raw ?? ""),
            compiledAt: nowIso(),
        };
        return { raw: String(raw ?? ""), prompt };
    }

    /** 取条目的 PROMPT：只复用与当前事实指纹一致的持久化快照；过期/缺失则同步编译。 */
    function promptFor(run, item, template, compileInput) {
        const snapshot = item?.promptCompilation;
        const fingerprint = promptCompileFingerprint(compileInput);
        if (snapshot?.version === PROMPT_COMPILATION_VERSION && snapshot?.template === template && snapshot?.fingerprint === fingerprint && typeof snapshot.prompt === "string") {
            return { raw: typeof snapshot.rawPrompt === "string" ? snapshot.rawPrompt : snapshot.prompt, prompt: snapshot.prompt };
        }
        const raw = compilePromptForTemplate(compileInput);
        return { raw, prompt: stripUntranslatedMarker(raw) };
    }

    /**
     * 编译单个条目并持久化快照。显式重跑传 force=true：即使输入指纹未变，也重新请求语言适配，
     * 通过新候选记录新的编译结果；旧 job 的 params 保持原样。LLM 失败时保留结构稿并记 warning。
     */
    async function compilePromptItem(run, def, item, plan, { force = false } = {}) {
        if (plan?.blocked || !plan?.compileInput) return;
        const input = plan.compileInput;
        const snapshot = item?.promptCompilation;
        const fingerprint = promptCompileFingerprint(input);
        if (!force && snapshot?.version === PROMPT_COMPILATION_VERSION && snapshot?.template === plan.template && snapshot?.fingerprint === fingerprint && typeof snapshot.prompt === "string") return;
        const syncPrompt = compilePromptForTemplate(input);
        let raw = syncPrompt;
        const warning = untranslatedWarning(syncPrompt);
        if (warning && rewriteLlmCall) {
            raw = await compilePromptForTemplateAsync({
                ...input,
                llmCall: rewriteLlmCall,
                onWarning: (error) => {
                    appendWarning(item, `提示词改写失败：${error?.message || String(error)}`);
                },
            });
            if (typeof raw !== "string" || !raw.trim() || raw.includes("[untranslated")) raw = syncPrompt;
        }
        const result = savePromptSnapshot(item, input, raw);
        if (warning && (!rewriteLlmCall || raw.includes("[untranslated"))) {
            appendWarning(item, warning.reason);
        }
        return result;
    }

    /** 入队前预编译：模型无关事实先落快照，英文模型再异步改写；失败只降级，不阻塞任务。 */
    async function precompilePrompts(run, def, items, frames, shots) {
        for (const item of items) {
            const plan = generativePlan(run, def, item, frames, shots);
            if (plan?.blocked || !plan?.compileInput) continue;
            await compilePromptItem(run, def, item, plan);
        }
    }

    /** 单个条目的生成参数与就绪判定：模板要求的 token 必须全给，尺寸取 config.pipeline 默认值。 */
    function generativePlan(run, def, item, frames, shots, chosenTemplate = null) {
        const extraParams = (def.id === "keyframe" ? run.options?.image : run.options?.video) || {};
        const style = productionDefaults(run);
        const start = frames.find((frame) => frame.shotId === item.shotId && frame.role === "start");
        if (def.id === "keyframe") {
            // 尺寸在选定模板（decision.template）后从「该模型官方规格登记表」取（见下方 sizeDims），不再实时按比例推导。
            const projectId = run?.options?.projectId;
            // ③ 图上文字逐字拼进 PROMPT（修 #39）：textOverlays 原样照抄，确无文字（kind 全 none / 缺字段）不拼空串。
            const overlayClause = textOverlayClause(item.textOverlays);
            const promptBody = [String(item.prompt ?? "").trim(), overlayClause].filter(Boolean).join("。");
            // ② 按 ShotBinding 注入参考图 + 稳定 seed（§11.5.4）：先解析本镜该锁哪些角色/场景，再判模板能力。
            const refContext = shotReferenceContext(run, item, shots);
            const configuredImageTemplate = configuredTemplateForStage(run, "keyframe", "image");
            const decision = refContext.needCount > 0
                ? decideKeyframeTemplate(refContext.needCount, refContext.urls.length, configuredImageTemplate)
                : { ok: true, template: configuredImageTemplate, reason: "" };
            let blocked = null;
            if (refContext.needCount > 0 && !decision.ok) {
                blocked = { reason: decision.reason, missing: refContext.report.blocked };
            } else if (refContext.needCount > 0 && refContext.report.blocked.length) {
                const detail = refContext.report.blocked.map((entry) => `${entry.role}:${entry.bindingId}（${entry.reason}）`).join("、");
                blocked = { reason: `缺少角色/场景参考图，无法锁定身份：${detail}`, missing: refContext.report.blocked };
            }
            const warning = !Array.isArray(item.textOverlays)
                ? { reason: "缺少 textOverlays 契约字段（画面若有文字将无法逐字渲染）" }
                : refContext.report.warning.length
                  ? { reason: `参考图已生成但未选定：${refContext.report.warning.map((entry) => `${entry.role}:${entry.bindingId}`).join("、")}` }
                  : null;
            // 关键帧尺寸按「实际选定的生图模板」的官方规格取；画幅无对应档 → 回落默认 + warning（不臆造官方档位）。
            const sizeDims = sizeForRatio(decision.template, style.ratio, { base: Math.min(Number(pipelineConfig.imageWidth) || 768, Number(pipelineConfig.imageHeight) || 1344) });
            const sizeWarning = sizeDims.warning ? { reason: sizeDims.warning } : null;
            const params = {
                WIDTH: sizeDims.width ?? (Number(pipelineConfig.imageWidth) || 768),
                HEIGHT: sizeDims.height ?? (Number(pipelineConfig.imageHeight) || 1344),
                BATCH: Number(pipelineConfig.imageBatch) || 1,
                ...(item.role === "end" ? { INPUT_IMAGE: start?.artifactUrl } : {}),
                ...extraParams,
            };
            // 参考图 URL 角色在前、场景/道具在后；最多 REF_IMAGE_1..9（generate.js ASSET_TOKENS 上限）。
            let refUrls = blocked ? [] : refContext.urls.slice(0, 9);
            let refInfos = blocked ? [] : refContext.infos.slice(0, 9);
            let inputInfo = null;
            // start 帧语义是「生成该镜第一帧」，没有前一帧可作底图；而 img_qwen21_edit 一类模板的
            // INPUT_IMAGE 是必填槽（generate.js 只有 REF_IMAGE_* 是 optional）。若模板要求底图，就从
            // 本镜解析出的参考图里取**第一张**充当 INPUT_IMAGE（让模型真正「看见」角色，锁身份），
            // 其余参考图再顺序填 REF_IMAGE_1..N —— 已用作 INPUT_IMAGE 的那张不重复占 REF 槽。
            // 连参考图也没有 → 显式 blocked（不静默失败、不假装锁了角色）。
            if (!blocked && item.role !== "end" && params.INPUT_IMAGE === undefined && templateRequiresInputImage(decision.template)) {
                if (refUrls.length) {
                    params.INPUT_IMAGE = refUrls[0];
                    inputInfo = refInfos[0] || null;
                    refUrls = refUrls.slice(1);
                    refInfos = refInfos.slice(1);
                } else {
                    blocked = {
                        reason: `模板 ${decision.template} 要求必填底图 INPUT_IMAGE，但镜头没有可回退的角色/场景参考图`,
                        missing: refContext.report.blocked,
                    };
                }
            }
            // 「本次实际注入的槽位」事实源：严格按 params 的注入顺序组装，交给编译器生成素材编号（不写死在内容层）。
            const slotImages = [];
            if (params.INPUT_IMAGE !== undefined) {
                slotImages.push({
                    url: params.INPUT_IMAGE,
                    kind: item.role === "end" ? "first_frame" : "input_image",
                    role: inputInfo?.role,
                    name: inputInfo?.name,
                });
            }
            refUrls.forEach((url, index) => {
                params[`REF_IMAGE_${index + 1}`] = url;
                slotImages.push({ url, kind: "reference", role: refInfos[index]?.role, name: refInfos[index]?.name });
            });
            // 采样参数按规则表参数档回填（仅模板声明的 token；不硬编码）。
            applyPresetParams(params, decision.template, templateCatalog[decision.template]?.tokens);
            // 「发起生成请求」那一刻按所选模型编译提示词：内容层给模型无关事实，编译器按模型标准产出 PROMPT。
            const keyframeShot = shots.find((entry) => String(entry?.id) === String(item?.shotId)) || {};
            const compileInput = {
                template: decision.template,
                family: "image",
                shot: keyframeShot,
                scene: sceneForShot(run, keyframeShot),
                characters: charactersForShot(run, refContext.shotBinding),
                style,
                slots: { images: slotImages },
                overlays: item.textOverlays,
                legacyBody: promptBody,
                basePrompt: item.prompt,
                item,
            };
            const renderedPrompt = promptFor(run, item, decision.template, compileInput);
            params.PROMPT = renderedPrompt.prompt;
            // 稳定 seed + 按 run+条目隔离的 OUTPUT_PREFIX（同项目/同镜/同资产 revision → 同 seed，换台设备也不换脸）。
            if (projectId) {
                if (params.SEED === undefined) params.SEED = stableSeed(projectId, item.shotId, refContext.shotBinding?.assetRevision ?? null);
                if (params.OUTPUT_PREFIX === undefined) params.OUTPUT_PREFIX = outputPrefixFor(run.id, item.id);
            }
            const promptWarning = untranslatedWarning(renderedPrompt.raw);
            const warningReason = [warning?.reason, sizeWarning?.reason, promptWarning?.reason].filter(Boolean).join("；");
            return {
                kind: STAGE_KIND.keyframe,
                template: decision.template,
                ready: item.role !== "end" || Boolean(start?.artifactUrl),
                params,
                compileInput,
                ...(blocked ? { blocked } : {}),
                ...(warningReason ? { warning: { reason: warningReason } } : {}),
            };
        }
        // 单镜（片段）时长跟**所选视频模型的档位**走，**不从项目参数取**（单集时长 ≠ 单镜时长，2026-10-04 产品口径）。
        // 条目自带 durationSec 时优先用它；否则用模型档位默认（durations.js 唯一事实源），再回落 config.videoSeconds。
        const videoTemplate = chosenTemplate || configuredTemplateForStage(run, "assembly", "video");
        const modelTierSeconds = durationsForTemplate(videoTemplate)?.[0] ?? null;
        const videoDefaultSeconds = modelTierSeconds ?? (Number(pipelineConfig.videoSeconds) || 5);
        item.durationSec = Number(item.durationSec) > 0 ? Number(item.durationSec) : videoDefaultSeconds;
        if (!item.keyframeId) item.keyframeId = start?.id ?? null;
        const shot = shots.find((entry) => entry.id === item.shotId);
        // 片段尺寸从「该视频模型的官方规格登记表」取（画幅匹配优先，否则回落默认 + warning），不再实时按比例推导。
        const videoDims = sizeForRatio(videoTemplate, style.ratio, { base: Math.min(Number(pipelineConfig.videoWidth) || 768, Number(pipelineConfig.videoHeight) || 1344) });
        // 片段侧同样在「发起生成请求」那一刻按所选模型编译提示词：把分镜的模型无关事实（动作/机位/台词/文字）
        // 交给编译器，而不是把「英文静态生图描述 + 中文动作流水句」硬拼后甩给模型。
        // 实际注入的槽位以模板声明的 token 为准：FL 模板走 FIRST_FRAME/LAST_FRAME，i2v 走 INPUT_IMAGE；
        // 素材编号由编译器按注入顺序生成（不写死在内容层）。
        const videoShotBinding = shotReferenceContext(run, item, shots).shotBinding;
        const videoTokens = Array.isArray(templateCatalog[videoTemplate]?.tokens) ? templateCatalog[videoTemplate].tokens : [];
        const endFrame = frames.find((frame) => frame.shotId === item.shotId && frame.role === "end");
        const slotImages = [];
        const videoParams = {
            WIDTH: videoDims.width ?? (Number(pipelineConfig.videoWidth) || 768),
            HEIGHT: videoDims.height ?? (Number(pipelineConfig.videoHeight) || 1344),
            LENGTH: frameCountForDuration(item.durationSec, Number(pipelineConfig.videoFps) || 24),
        };
        if (start?.artifactUrl) {
            if (videoTokens.includes("FIRST_FRAME")) videoParams.FIRST_FRAME = start.artifactUrl;
            else videoParams.INPUT_IMAGE = start.artifactUrl;
            slotImages.push({ url: start.artifactUrl, kind: "first_frame" });
        }
        if (endFrame?.artifactUrl && videoTokens.includes("LAST_FRAME")) {
            videoParams.LAST_FRAME = endFrame.artifactUrl;
            slotImages.push({ url: endFrame.artifactUrl, kind: "last_frame" });
        }
        // 采样参数按规则表参数档回填（仅模板声明的 token；不硬编码）。
        applyPresetParams(videoParams, videoTemplate, videoTokens);
        const legacyBody = [shot?.prompt, shot?.action].filter(Boolean).join(", ");
        const shotCharacters = charactersForShot(run, videoShotBinding);
        // 全局角色表：说话人 (Sx) 跨镜稳定编号的事实源（H3 官方要求同一说话人跨镜同 ID）。
        const cast = castForRun(run);
        let blocked = null;
        if (videoTokens.includes("TTS_TEXT")) {
            try {
                if (audioModeOf(run) !== AUDIO_MODE.EMBEDDED) throw new Error("H3 Talk 使用驱动音频生成口型，请先将项目配音方式设为原声，避免再次替换对白导致音画错位");
                const project = projectOf(run) || { script: { characters: cast } };
                const { profiles } = projectVoiceProfiles({ project, characters: cast, design: run.stages?.design?.output, casting: run.stages?.casting?.output });
                Object.assign(videoParams, buildH3TalkParams({ shot, characters: shotCharacters, cast, profiles }));
            } catch (error) {
                blocked = { reason: error.message, missing: [] };
            }
        }
        const compileInput = {
            template: videoTemplate,
            family: "video",
            shot: shot || {},
            scene: sceneForShot(run, shot),
            characters: shotCharacters,
            cast,
            audioMode: audioModeOf(run),
            style,
            slots: { images: slotImages },
            overlays: shot?.textOverlays,
            legacyBody,
            durationSec: item.durationSec,
            item,
        };
        const renderedPrompt = promptFor(run, item, videoTemplate, compileInput);
        videoParams.PROMPT = renderedPrompt.prompt;
        const promptWarning = untranslatedWarning(renderedPrompt.raw);
        // 台词说话人归属逐级回落 → 记 warning（不阻塞）；多角色镜头里旧字符串 dialogue 无法确定归属时尤其重要。
        const dialogueWarnings = dialogueAttributionWarnings(videoTemplate, shot || {}, shotCharacters, cast);
        // 画幅无官方对应档 → 回落默认 + warning（不臆造官方档位）。
        const sizeWarning = videoDims.warning ? { reason: videoDims.warning } : null;
        const warningReason = [sizeWarning?.reason, promptWarning?.reason, ...dialogueWarnings].filter(Boolean).join("；");
        return {
            kind: STAGE_KIND.assembly,
            template: videoTemplate,
            // 图生视频必须有起始帧；没拿到就保持 queued + jobId:null，等关键帧产物就绪后由回写代理入队（契约见 05 SKILL.md）。
            ready: Boolean(start?.artifactUrl),
            params: { ...videoParams, ...extraParams },
            compileInput,
            ...(blocked ? { blocked } : {}),
            ...(warningReason ? { warning: { reason: warningReason } } : {}),
        };
    }

    /**
     * 入队一次生成尝试并追加候选。重跑用带时间戳的新 id，绝不覆盖旧 jobId/artifactUrl。
     * variant>0 用于同一镜一次入队多个候选（D3）：给每个候选换一版 seed，保证 4 张不是同一张。
     */
    function enqueueAttempt(run, def, item, plan, { variant = 0 } = {}) {
        if (typeof runJob !== "function" || typeof jobs?.enqueue !== "function") return null;
        const base = `${run.id}-${item.id}`;
        // 重跑必然带时间戳 + 随机后缀：同一毫秒内连点两次也不能撞出同一个 jobId，否则候选会被 upsert 合并。
        const id = item.candidates?.length || variant > 0 ? `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : base;
        // 同一镜的多个候选换 seed（同一个 seed 会出同一张图，失去「多候选挑一张」的意义）。
        const params =
            variant > 0 && plan.params?.SEED !== undefined && Number.isFinite(Number(plan.params.SEED))
                ? { ...plan.params, SEED: (Number(plan.params.SEED) + variant * 7919) % 2147483647 }
                : plan.params;
        const promptWarning = [plan.warning?.reason, rewriteWarningOf(item)].filter(Boolean).join("；");
        // M1 归属字段（契约 §3.10，有值才写）：projectId 取 run.options 过渡位，episodeId/sceneId/shotId 取 item 自有值，
        // slotId 与关键帧投影的 generationSlots id 同规则（slot_<shotId>_<role>）。
        // 幂等键 = runId+stageId+itemId+attempt（attempt 即本次唯一 jobId）：重跑必然是新 attempt → 新 key；
        // 同一 attempt 的重复入队（重放）命中队列幂等索引，直接返回原 Job，不重复执行。
        const shotId = item.shotId === undefined || item.shotId === null || item.shotId === "" ? null : String(item.shotId);
        const job = jobs.enqueue({
            id,
            kind: plan.kind,
            template: plan.template,
            name: item.id,
            params,
            meta: {
                runId: run.id,
                stageId: def.id,
                itemId: item.id,
                source: "project",
                ...(run.options?.projectId ? { projectId: String(run.options.projectId) } : {}),
                ...(item.episodeId ? { episodeId: String(item.episodeId) } : {}),
                ...(item.sceneId ? { sceneId: String(item.sceneId) } : {}),
                ...(shotId ? { shotId } : {}),
                ...(shotId && item.role ? { slotId: `slot_${shotId}_${item.role}` } : {}),
                ...(plan.template ? { toolId: String(plan.template) } : {}),
                idempotencyKey: `${run.id}:${def.id}:${item.id}:${id}`,
                ...(promptWarning ? { promptWarning } : {}),
            },
        }, runJob);
        if (!job) return null;
        item.candidates = [
            ...(item.candidates || []),
            { template: plan.template, jobId: job.id, artifactUrl: null, status: "queued", params, ...(promptWarning ? { warning: promptWarning } : {}), createdAt: nowIso() },
        ];
        item.jobId = job.id;
        item.selected = job.id;
        item.status = "queued";
        return job.id;
    }

    /** 同一镜一次入队 count 个候选（D3「一次生产 4 张以上」）；count<=1 时退化为单次入队。 */
    function enqueueAttemptBatch(run, def, item, plan, count) {
        const total = Math.max(1, Math.floor(Number(count) || 1));
        const ids = [];
        for (let index = 0; index < total; index += 1) {
            const id = enqueueAttempt(run, def, item, plan, { variant: index });
            if (!id) break;
            ids.push(id);
        }
        return ids;
    }

    /**
     * 让尚未入队且前置已就绪的条目补入队；幂等：已有本次 jobId 的跳过。
     * 首次编排与回写后都走这里；被门禁判 blocked（参考图能力不足 / 参考图缺失）的条目不入队，
     * 而是显式标 status=blocked + blockedReason，避免静默降级、也避免假装已锁定角色。
     */
    function enqueueReady(run, def, stage, items, frames, shots) {
        for (const item of items) {
            const plan = generativePlan(run, def, item, frames, shots);
            item.template = plan.template;
            if (plan.blocked) {
                item.status = "blocked";
                item.blockedReason = plan.blocked.reason;
                item.blockedMissing = plan.blocked.missing || [];
                continue;
            }
            if (plan.warning) appendWarning(item, plan.warning.reason);
            else if (item.warning && !item.warning.includes("提示词改写失败")) delete item.warning;
            if (item.jobId || !plan.ready) continue;
            // D3：关键帧每条目一次入队 ≥4 个候选；视频阶段仍单次入队。
            enqueueAttemptBatch(run, def, item, plan, candidatesPerEnqueue(def.id));
        }
    }

    /**
     * 单镜失败自动重试（D3：不达标自动重新生成）：最新候选落终态且整条 item 无任何达标候选时，
     * 用**同一份 template/params**追加一个新候选，预算由 maxItemRetries 封顶（绝不无限重试）。
     * 触发条件覆盖两类「不达标」：error（任务失败）与 done-但-QC-判负（产物缺失/空文件/尺寸非法）。
     * 幂等：预算由候选列表里 autoRetry 候选的数量导出（不依赖内存计数器），
     * 且新候选入队后 latest 立刻变 queued（非终态），重放同一失败事件不会再触发一次；
     * 未注入 getProject（autoRetryEnabled=false）时不启用，保持旧的「失败即止」。
     */
    function retryFailedItem(run, def, item) {
        if (!autoRetryEnabled) return false;
        // 配音失败不自动重试：TTS 失败多为系统性原因（显存/模型不可达），重试只会堆占 GPU 队列；
        // 硬约束是「TTS 失败不阻塞出片 + 降级记 warning」，由 attachAudio 的 item.warning 承担。
        if (def.id === "audio") return false;
        const candidates = Array.isArray(item.candidates) ? item.candidates : [];
        const latest = candidates.at(-1);
        // 只在终态上判定：queued/running（含刚入队的重试）不处理。
        if (!latest || !TERMINAL_JOB.has(latest.status)) return false;
        // 取消是用户意图，不自动重试。
        if (latest.status === "canceled") return false;
        // 有任一候选达标 → 该镜已达标，不必再折腾（D3「一次出 ≥4 张，够用就不重生成」）。
        if (candidates.some(candidatePassed)) return false;
        if (latest.status !== "error" && latest.status !== "done") return false;
        const used = candidates.filter((candidate) => candidate.autoRetry).length;
        if (used >= maxItemRetries) return false;
        // done 但 QC 判负 → 换一版 seed 再试（同一 seed 只会再出一张同样不达标的图）。
        const qcRetry = latest.status === "done";
        const params = { ...(latest.params || {}) };
        if (qcRetry && def.id === "keyframe" && params.SEED !== undefined && Number.isFinite(Number(params.SEED))) {
            params.SEED = (Number(params.SEED) + 104729) % 2147483647;
        }
        // kind 由**阶段**确定性推导（与各阶段正常入队共用 STAGE_KIND 这一处来源），不查 jobs 映射：
        // 那条链可被污染（原 job 缺失 / kind=undefined / jobId 被复用成别的 family），一旦照抄就会把重试
        // 交给错误的资源类别与队列（视频 kind 配图模板）。原 job 的 kind 只作最后兜底，绝不推翻阶段推导。
        const plan = { kind: STAGE_KIND[def.id] || jobs?.get?.(latest.jobId)?.kind, template: latest.template, params, ready: true };
        if (!enqueueAttempt(run, def, item, plan)) return false;
        // 只在自动生成的候选上打标，作为下次「已重试几次」的唯一依据；旧候选一律保留。
        item.candidates.at(-1).autoRetry = true;
        item.template = latest.template;
        return true;
    }

    /**
     * 逐条重跑（regenerate）同步部分：只做门禁与本次 attempt 的生成计划，**不产生任何副作用**。
     * 语义：给一个 item 换模板再追加一个候选，不动其它 item、不删旧候选；慢的真实生成由任务队列后台跑。
     * 门禁失败抛 gateError：参数/引用非法 400，阶段或条目正忙（防并发重复入队）409。
     */
    function beginRegenerate(runId, stageId, { itemId, template, params, promptOverride, allowPartialStage = false } = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        // 只有生成型阶段有候选活扣；文本阶段（script/storyboard 等）明确拒绝。
        const family = STAGE_TEMPLATE_FAMILY[def.id];
        if (!family) throw gateError(`阶段「${def.title}」不是生成型阶段，不支持逐条重跑`);
        // 阶段整体在跑（LLM 编排中，或已有条目在排队/生成）→ 拒绝并发重复入队。
        //
        // allowPartialStage 只给批量重试用（retryFailedItems）：批量入口自己已经按
        // **条目级**判据（有没有未完成候选）做过检查，那比阶段状态精确得多 ——
        // 阶段 running 可能只是「别的条目还在排队」，而批量重试的正是那些已失败的条目。
        // 单条入口保持原样：用户手动点重试时，阶段在跑就该被拒。
        if (stage.status === "running" && !allowPartialStage) throw gateError(`阶段「${def.title}」正在运行中，请先取消或等它结束再逐条重跑`, 409);
        const items = def.id === "keyframe" ? stage.output?.frames : stage.output?.clips;
        const item = Array.isArray(items) ? items.find((entry) => entry.id === itemId) : null;
        if (!item) throw gateError(`阶段「${def.title}」里没有条目：${itemId ?? "(空)"}`);
        // 该条目自己已有未完成候选 → 拒绝（即便阶段状态因人为修订不是 running，也不能撞 jobId）。
        const unfinished = (item.candidates || []).find((candidate) => candidate.status === "queued" || candidate.status === "running");
        if (unfinished) throw gateError(`条目「${item.id}」已有未完成候选（${unfinished.jobId}），请等它结束或先取消`, 409);
        if (typeof runJob !== "function" || typeof jobs?.enqueue !== "function") throw gateError("未接入生成执行体，无法逐条重跑");
        // template 必须存在且属于该阶段 family（图/视频），杜绝把视频模板塞进关键帧阶段。
        const chosen = String(template ?? "").trim();
        if (chosen) {
            const known = templateFamilies.get(chosen);
            if (!known) throw gateError(`模板不存在：${chosen}`);
            if (known !== family) throw gateError(`模板「${chosen}」属于 ${known} family，不能用于「${def.title}」（需要 ${family}）`);
        }
        const shots = run.stages?.storyboard?.output?.shots || [];
        const frames = def.id === "keyframe" ? items : run.stages?.keyframe?.output?.frames || [];
        const plan = generativePlan(run, def, item, frames, shots, def.id === "assembly" ? chosen : null);
        if (plan.blocked) throw gateError(plan.blocked.reason, 409);
        if (!plan.ready) throw gateError(`条目「${item.id}」的前置产物还没就绪，不能重跑`);
        plan.template = chosen || plan.template;
        if (params && typeof params === "object") plan.params = { ...plan.params, ...params };
        // 人工修正的提示词（2026-10-06）：非空字符串则优先于编译器产物，供界面「改词重跑」。
        // 空串/空白视为「不改」，走原编译路径——避免用户清空输入框就静默丢掉整条提示词。
        if (promptOverride !== undefined && promptOverride !== null) {
            const text = String(promptOverride).trim();
            if (!text) throw gateError("提示词不能为空：想保留原提示词就别传 promptOverride，或传undefined");
            if (text.length > 4000) throw gateError(`提示词过长（${text.length} 字，上限 4000）`);
            plan.promptOverride = text;
        }
        return { run, def, stage, item, plan };
    }

    /**
     * 逐条重跑（regenerate）异步部分：把本次 attempt 入队并追加候选，新候选成为 selected。
     * 入队非阻塞（真实执行在任务队列后台），job 终态由 projectJob 幂等回写。
     */
    async function executeRegenerate(begun) {
        const { run, def, stage, item, plan } = begun;
        // 重跑永远重新编译；即使输入事实没有变化，也不复用旧快照或旧 job 参数。
        if (plan.compileInput) {
            plan.compileInput = { ...plan.compileInput, template: plan.template };
            await compilePromptItem(run, def, item, plan, { force: true });
            const refreshed = generativePlan(run, def, item, def.id === "keyframe" ? stage.output?.frames || [] : run.stages?.keyframe?.output?.frames || [], run.stages?.storyboard?.output?.shots || [], def.id === "assembly" ? plan.template : null);
            if (refreshed.blocked) throw gateError(refreshed.blocked.reason, 409);
            refreshed.template = plan.template;
            refreshed.compileInput = { ...(refreshed.compileInput || plan.compileInput), template: plan.template };
            if (plan.params && typeof plan.params === "object") refreshed.params = { ...refreshed.params, ...plan.params };
            Object.assign(plan, refreshed);
            // 重新生成的模板可能未触发语言改写，确保最终 params 取本次快照而非旧快照。
            const compiled = promptFor(run, item, plan.template, plan.compileInput);
            // promptOverride：人工修正的提示词**优先于编译器产物**（2026-10-06）。
            //
            // 为什么需要这条口子：界面上能看到提示词、能改，是人工质量兜底的基础。
            // 但原实现无条件用 compiled.prompt 覆盖 params.PROMPT，人工写的词会被静默丢掉
            // —— 界面显示改成功了，实际跑的还是旧词，这种「假成功」比没有功能更糟。
            //
            // 只覆盖 PROMPT 一个 token：尺寸、参考图槽位、采样参数仍走编译器/规则表，
            // 避免人工改词时顺带破坏引用锁定。
            plan.params = plan.promptOverride
                ? { ...(plan.params || {}), PROMPT: String(plan.promptOverride) }
                : { ...(plan.params || {}), PROMPT: compiled.prompt };
            if (!plan.promptOverride) plan.warning = untranslatedWarning(compiled.raw);
            else plan.warning = null;
        }
        const jobId = enqueueAttempt(run, def, item, plan);
        if (!jobId) throw gateError("生成任务入队失败");
        item.template = plan.template;
        recomputeStage(stage, run);
        // 写一条 running 进度：阶段此前多半是 done，不刷新的话轻量进度轮询会一直读到旧的 phase:"done"。
        writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: "running", label: `重跑条目 ${item.id}（${plan.template}）` });
        saveRun(run);
        return { run, jobId };
    }

    /**
     * 批量重试：把阶段里**失败**的条目一次性重排队（2026-10-06）。
     *
     * ## 为什么需要它
     *
     * 逐条 regenerate 在「服务重启导致大面积中断」这种场景下不可用：
     * jobs.js 启动回放会把所有悬挂的中间态收敛成 `error`（这是**有意设计**，
     * 否则前端会永远轮询），实测一次重启就让 70 镜的关键帧里273 条变成 error。
     * 逐条点重跑要点273 次，不现实。
     *
     * ## 范围严格限定
     *
     * 只重试 **error** 的条目，且逐条走 beginRegenerate —— 于是门禁全部生效：
     *   - blocked（有未完成候选 / 缺参考图）不会被误重试；
     *   - 正在 running 的阶段直接拒绝，避免并发重复入队；
     *   - 成功/已取消的条目**不动**，历史候选一条不少。
     *
     * 不自动重试的原因很实际：失败可能是**真失败**（提示词违规、模板缺参数），
     * 无脑重跑只是白烧GPU。默认 limit 保守（20），且如实返回剩余计数，
     * 让调用方决定要不要再来一轮。
     *
     * **不拦 partial**：partial 是「一部分成功一部分失败」的常态，
     * 而这正是本能力要处理的场景。
     */
    async function retryFailedItems(runId, stageId, { limit = 20 } = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        // 只在**还有条目在排队/生成**时拒绝（避免并发重复入队、撞 jobId）。
        //
        // 刻意**不拦 partial**：partial 正是「一部分成功一部分失败」的常态，
        // 而批量重试失败项就是为它准备的。若把 partial 也拦掉，这个能力在最需要的时候反而用不了。
        const items = def.id === "keyframe" ? stage.output?.frames : stage.output?.clips;
        const pool = Array.isArray(items) ? items : [];
        const busy = pool.find((item) => (item.candidates || []).some((candidate) => candidate.status === "queued" || candidate.status === "running"));
        if (busy) throw gateError(`阶段「${def.title}」还有条目在排队或生成中（${busy.id}），请等它们结束再批量重试`, 409);
        const failed = pool.filter((item) => {
            const selected = (item.candidates || []).find((candidate) => candidate.jobId === item.selected) || (item.candidates || []).at(-1);
            return selected?.status === "error";
        });
        const capped = Math.max(0, Math.min(Number(limit) || 0, failed.length));
        const retried = [];
        const skipped = [];
        for (const item of failed.slice(0, capped)) {
            try {
                // allowPartialStage：阶段状态由本函数上方的**条目级** busy 检查把关，
                // 不能再用阶段级 running 判断——否则「别的条目在排队」会把整批误杀
                // （2026-10-06 真实项目实测：273 条待重试，阶段 running 导致 14/15 被跳过）。
                const begun = beginRegenerate(runId, stageId, { itemId: item.id, allowPartialStage: true });
                await executeRegenerate(begun);
                retried.push(item.id);
            } catch (error) {
                // 单条失败不中断整批：记下来如实返回，让调用方看到哪条没救回来、为什么。
                skipped.push({ itemId: item.id, reason: error.message });
            }
        }
        saveRun(run);
        return {
            run,
            retried,
            skipped,
            failedTotal: failed.length,
            remaining: Math.max(0, failed.length - retried.length),
        };
    }

    /**
     * 生成型阶段：模型只负责写提示词与清单，template/jobId/artifactUrl/status 全部由编排器回填。
     * 关键帧先入队 start 帧，end 帧等 start 帧产物回写后由投影补入队；片段等关键帧就绪后入队。
     * prev 是重排前的产物，用于继承旧候选与产物（重跑只追加候选）。
     */
    function attachGeneration(run, def, stage, prev) {
        const output = stage.output && typeof stage.output === "object" ? stage.output : {};
        const items = def.id === "keyframe" ? output.frames : output.clips;
        if (!Array.isArray(items) || !items.length) throw new Error(`模型未返回 ${def.id === "keyframe" ? "frames" : "clips"} 数组`);
        const shots = run.stages?.storyboard?.output?.shots || [];
        const frames = def.id === "keyframe" ? items : run.stages?.keyframe?.output?.frames || [];
        const prevItems = def.id === "keyframe" ? prev?.frames : prev?.clips;
        for (const item of items) {
            const old = prevItems?.find((entry) => entry.id === item.id);
            item.candidates = old?.candidates ? old.candidates.map((candidate) => ({ ...candidate })) : [];
            item.artifactUrl = old?.artifactUrl ?? null;
            item.selected = old?.selected ?? null;
            item.jobId = null;
            item.status = "queued";
        }
        enqueueReady(run, def, stage, items, frames, shots);
        for (const item of items) syncItem(item);
        const assembly = output.assembly && typeof output.assembly === "object" ? output.assembly : {};
        stage.output =
            def.id === "keyframe"
                ? { frames: items }
                : {
                      clips: items,
                      assembly: {
                          order: Array.isArray(assembly.order) && assembly.order.length ? assembly.order : items.map((clip) => clip.id),
                          transition: assembly.transition || run.options?.transition || "cut",
                          status: "queued",
                      },
                  };
        recomputeStage(stage, run);
    }

    /**
     * 配音阶段：为**有对白的镜头**逐条入队 TTS，产物登记成带 `shotId + startSec` 的 audio item。
     *
     * 复用与关键帧/片段同一套「候选活扣 + Job 终态回写」机制（enqueueAttempt / projectJob / recomputeStage）：
     *   - Cue 由分镜台词 + 角色音色**确定性派生**（audio.js / audio-track.js），本阶段不调 LLM；
     *   - 无对白镜头不产 Cue（cuesFromShots 本就不产出）→ 硬约束「没有台词的镜头不产音频」；
     *   - TTS 任务失败只让本阶段落 partial/error；assembly 的 requires 里**不含 audio**，
     *     成片按「有产物才混、没产物跳过」处理 → 硬约束「TTS 失败不阻塞出片」；
     *   - 音色描述 → 具体模型音色枚举的适配发生在入队这一刻（qwen3Speaker），内容层只给模型无关事实。
     * prev 是重排前的产物，用于继承旧候选（重跑只追加候选，不清空旧 jobId/artifactUrl）。
     */
    function attachAudio(run, def, stage, prev) {
        const shots = run.stages?.storyboard?.output?.shots || [];
        const project = projectOf(run);
        const design = run.stages?.design?.output || null;
        const scriptCharacters = Array.isArray(project?.script?.characters) ? project.script.characters : [];
        const characters = scriptCharacters.length ? scriptCharacters : undefined;
        const { profiles } = projectVoiceProfiles({ project, design, characters, casting: run.stages?.casting?.output });
        const charList = Array.isArray(characters) ? characters : [];
        const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]));
        const profileByCharacter = new Map(profiles.filter((profile) => profile.characterId).map((profile) => [String(profile.characterId), profile]));
        const charById = new Map(charList.filter((character) => character?.id).map((character) => [String(character.id), character]));
        // 只保留真正要朗读的对白/旁白（sfx/ambience/music 不是 TTS 文本；空文本不产音频）。
        const cues = projectAudioCues({ project, storyboard: shots, voiceProfiles: profiles })
            .filter((cue) => DIALOGUE_TYPES.has(cue.type) && String(cue.text ?? "").trim() !== "");
        const shotById = new Map(shots.map((shot) => [String(shot?.id ?? shot?.shotId), shot]));
        const prevItems = Array.isArray(prev?.audio) ? prev.audio : [];
        const template = configuredTemplateForStage(run, "audio", "audio") || "audio_qwen3_tts";
        const device = String(pipelineConfig.audioDevice || "cuda");

        const items = [];
        for (const cue of cues) {
            const old = prevItems.find((entry) => entry.id === cue.id);
            const item = {
                id: cue.id,
                shotId: cue.shotId,
                startSec: cue.startSec,
                endSec: cue.endSec,
                durationSec: cue.durationSec,
                type: cue.type,
                text: cue.text,
                performance: cue.performance ?? "",
                speed: cue.speed ?? null,
                characterId: cue.characterId ?? null,
                voiceProfileId: cue.voiceProfileId ?? null,
                candidates: old?.candidates ? old.candidates.map((candidate) => ({ ...candidate })) : [],
                artifactUrl: old?.artifactUrl ?? null,
                selected: old?.selected ?? null,
                jobId: null,
                status: "queued",
            };
            const { profile, fallback } = resolveAudioProfile(cue, shotById.get(String(cue.shotId)), { profileById, profileByCharacter, characters: charList, profiles });
            if (fallback) appendWarning(item, `对白「${cue.text}」未能从分镜确定说话角色，已回落使用音色「${profile?.name || profile?.id}」`);
            if (!profile) {
                item.status = "blocked";
                item.blockedReason = "没有可用的角色音色（VoiceProfile），无法合成该对白";
                items.push(item);
                continue;
            }
            item.voiceProfileId = profile.id;
            item.characterId = item.characterId || profile.characterId;
            // design 与 timbre 常常是同一段描述（无显式 design 时 projectVoiceProfiles 会回落到 timbre），去重避免重复。
            const instruct = [...new Set([profile.design, profile.timbre].filter(Boolean))].join("，");
            const params = {
                TEXT: cue.text,
                SPEAKER: qwen3Speaker(profile, charById.get(String(profile.characterId))),
                INSTRUCT: instruct,
                LANGUAGE: qwen3Language(profile.language),
                DEVICE: device,
                SEED: stableSeed(project?.id || run.id, profile.characterId, profile.version),
                OUTPUT_PREFIX: outputPrefixFor(run.id, cue.id),
            };
            // 定妆音色或台词变化必须生成新候选，不能继续复用旧声音。
            const matching = item.candidates.at(-1);
            if (matching?.template === template && JSON.stringify(matching.params) === JSON.stringify(params)) {
                syncItem(item);
                items.push(item);
                continue;
            }
            enqueueAttempt(run, def, item, { kind: STAGE_KIND.audio, template, params, ready: true });
            if (item.candidates.length) syncItem(item);
            items.push(item);
        }
        stage.output = { audio: items };
        recomputeStage(stage, run);
        // 没有可跑任务（无对白 / 未接 runJob）→ 阶段完成；有任务则停在 running 等 Job 终态回写。
        if (!items.some((item) => (item.candidates || []).length)) {
            stage.status = items.some((item) => item.status === "blocked") ? "blocked" : "done";
            stage.finishedAt = nowIso();
        }
    }

    /**
     * 对口型阶段（lipsync）：**生成型后处理**，插在「片段产出之后、成片之前」。
     *
     * 位置选择：**新增可选阶段**（而非塞进 `assembly` 子步骤）—— 理由：
     *   - `assembly.requires` 仍只有 `keyframe`：对口型**不阻塞、不延迟**成片；成片永远能按原片段出；
     *   - 与 `audio` 阶段同构，天然复用既有「候选活扣 + Job 终态回写 + 逐条重跑」机制，
     *     「改一句台词只重跑该镜口型」可按条目精准重跑，不与 ffmpeg 拼片耦合；
     *   - 不污染 `assembly` 的「计划片段 + 拼成片」语义。
     *
     * 触发条件（逐镜判定，二者同时满足才做；否则跳过）：
     *   ① 该镜**片段存在**（assembly 产物里有该 shotId 且有 artifactUrl）；
     *   ② 该镜**有台词音频产物**（audio 产物里有同 shotId 且有 artifactUrl 的 AudioCue）。
     *   —— 无台词镜（无 AudioCue 或音频失败）**直接跳过**：它的环境音/音效来自片段原声，不该动。
     *
     * 输入：源片段（`INPUT_VIDEO`）+ 该镜 TTS 音频（`INPUT_AUDIO`）；产物**另存**为新条目（`output.clips[]`），
     * **绝不覆盖原片段**（原片段仍留在 `assembly.output.clips` 里，可回滚、可对比）。
     * 模型/参数取自**服务端注册表**：模板名来自 `config.pipeline.lipsyncTemplate`，模型专属参数写在模板 JSON 里，
     * 本层只下发模型无关的素材槽与兜底开关。失败/超时由 Job 终态投影落 warning，成片回落原片段，绝不阻塞。
     */
    function attachLipsync(run, def, stage, prev) {
        const clips = Array.isArray(run.stages?.assembly?.output?.clips) ? run.stages.assembly.output.clips : [];
        const audioItems = Array.isArray(run.stages?.audio?.output?.audio) ? run.stages.audio.output.audio : [];
        const template = String(pipelineConfig.lipsyncTemplate || "").trim();
        const prevItems = Array.isArray(prev?.clips) ? prev.clips : [];
        // 台词音频产物索引：只认**已有产物**的 AudioCue（TTS 失败/未跑配音 → 该镜跳过）。
        const audioByShot = new Map();
        for (const entry of audioItems) {
            if (!entry?.artifactUrl || entry.shotId === undefined || entry.shotId === null) continue;
            audioByShot.set(String(entry.shotId), entry);
        }
        const items = [];
        // 本次调用的 attempt 标记：拼进 OUTPUT_PREFIX，让输出节点**每次 attempt 都 cache-miss** →
        // 产物文件名确定唯一（`<prefix>_00001-audio.mp4`），同时消除「同输入命中缓存 → history outputs 为空」。
        const attemptTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        for (const clip of clips) {
            // 触发条件①：该镜片段存在。
            if (!clip?.artifactUrl || clip.shotId === undefined || clip.shotId === null) continue;
            // 触发条件②：该镜有台词音频产物；无台词/无音频镜跳过（不动片段原声）。
            const audio = audioByShot.get(String(clip.shotId));
            if (!audio) continue;
            const id = lipsyncItemId(clip.id);
            const old = prevItems.find((entry) => entry.id === id);
            const item = {
                id,
                shotId: clip.shotId,
                sourceClipId: clip.id,
                sourceClipUrl: clip.artifactUrl,
                sourceAudioUrl: audio.artifactUrl,
                text: audio.text ?? "",
                characterId: audio.characterId ?? null,
                startSec: Number.isFinite(Number(audio.startSec)) ? Number(audio.startSec) : 0,
                durationSec: Number.isFinite(Number(clip.durationSec)) ? Number(clip.durationSec) : null,
                candidates: old?.candidates ? old.candidates.map((candidate) => ({ ...candidate })) : [],
                artifactUrl: old?.artifactUrl ?? null,
                selected: old?.selected ?? null,
                jobId: old?.jobId ?? null,
                status: old?.status ?? "queued",
            };
            if (!template) {
                item.status = "blocked";
                item.blockedReason = "未配置对口型工作流模板（config.pipeline.lipsyncTemplate），无法对口型（成片仍按原片段产出）";
                items.push(item);
                continue;
            }
            // 幂等 + 变更检测：输入（片段/音频）未变且已有候选/产物 → 跳过；输入变了（如换了台词重跑 audio）
            // → 追加新候选，只重跑对口型这一步，绝不重回 H3 视频。
            const unchanged = old && old.sourceClipUrl === clip.artifactUrl && old.sourceAudioUrl === audio.artifactUrl && (item.candidates.length > 0 || item.artifactUrl);
            if (unchanged) {
                syncItem(item);
                items.push(item);
                continue;
            }
            const params = {
                INPUT_VIDEO: item.sourceClipUrl,
                INPUT_AUDIO: item.sourceAudioUrl,
                SEED: freshSeed(),
                OUTPUT_PREFIX: `${outputPrefixFor(run.id, item.id)}-${attemptTag}`,
                RECOVER_BY_PREFIX: true,
            };
            enqueueAttempt(run, def, item, { kind: STAGE_KIND.lipsync, template, params, ready: true });
            if (item.candidates.length) syncItem(item);
            items.push(item);
        }
        stage.output = { clips: items };
        recomputeStage(stage, run);
        if (!items.length) {
            appendStageWarning(stage, "没有需要对口型的镜头（需同时满足：该镜有片段产物 + 该镜有台词音频产物）；无台词镜跳过");
            stage.status = stage.blocked?.length ? "blocked" : "done";
            stage.finishedAt = nowIso();
        } else if (!items.some((item) => (item.candidates || []).length)) {
            // 无可跑任务（模板缺失 / 未接 runJob）：blocked 优先，否则 done。
            stage.status = items.some((item) => item.status === "blocked") ? "blocked" : "done";
            stage.finishedAt = nowIso();
        }
    }

    /**
     * 角色定妆阶段（casting）：**确定性组装**身份卡，不调 LLM。
     *
     * 只做两件事 —— 定脸 + 定声音：
     *   - 脸：**复用** design 阶段产出的参考图（closeupPrompt / turnaroundPrompt → design.output.references →
     *     artifactUrl），经 casting.js 的 faceArtifactsFor 读取并写进 face.closeupArtifactId / turnaroundArtifactIds
     *     （不重写生成与绑定，绑定仍由 bindDesignReferenceArtifacts 负责）；
     *   - 声音：从剧本角色音色事实经 projectVoiceProfiles 归一成 VoiceProfile，再把 speaker 适配成**平台音色库**
     *     （voices.js）里的合法命名音色；language 归一为枚举；design/speed 取内容层事实。
     *
     * prev 用于**继承已确认状态**：重跑只刷新脸/声字段，不把人确认过的 face.confirmed / voice.confirmed 抹掉。
     * 产出后立即执行 casting 门禁：未确认 → keyframe / audio 置 blocked（复用 #70 机制，绝不静默降级）。
     */
    function attachCasting(run, def, stage, prev) {
        const project = projectOf(run);
        const scriptOutput = run.stages?.script?.output || {};
        const design = run.stages?.design?.output || null;
        const projectChars = Array.isArray(project?.script?.characters) ? project.script.characters : [];
        const scriptChars = Array.isArray(scriptOutput.characters) ? scriptOutput.characters : [];
        const designChars = Array.isArray(design?.characters) ? design.characters : [];
        const characters = projectChars.length ? projectChars : scriptChars.length ? scriptChars : designChars;
        const { profiles } = projectVoiceProfiles({ project, design, characters });
        const output = buildCastingOutput({ characters, design, voiceProfiles: profiles, prev });
        stage.output = output;
        stage.status = "done";
        stage.error = undefined;
        stage.finishedAt = nowIso();
        enforceCastingGate(run);
    }

    /**
     * 取某 run 的角色定妆就绪度。run 里没有 casting 阶段（历史 run / 旧注册表）时返回 null —— 
     * 此时不做 casting 门禁（保持旧行为，绝不给存量 run 平白加阻断）。
     */
    function castingReadinessOf(run) {
        const stage = run?.stages?.casting;
        if (!stage) return null;
        return castingReadiness(stage.output);
    }

    /**
     * 角色定妆门禁投影（E：未确认就拦住下游）。
     *
     * - casting 未完成 / 存在未确认角色 → 把 keyframe 与 audio 置 `status=blocked`，并写
     *   `blockedReason` / `blockedMissing`（逐角色列出缺脸还是缺声）/ `blocked`（复用 #70 的可见形状）；
     * - 全部确认 → 精确解除：仅清掉**本门禁**打的 blocked（`blockedBy === "casting"`），不误清其它来源的阻断；
     * - run 里没有 casting 阶段 → 空操作（旧行为逐字不变）；
     * - 正在 running 的下游阶段不打断（等它自己结束）。
     * @returns {boolean} 是否改动了 run（调用方据此决定是否 saveRun）
     */
    function enforceCastingGate(run) {
        const castingStage = run?.stages?.casting;
        if (!castingStage) return false;
        const readiness = castingReadiness(castingStage.output);
        let changed = false;
        for (const id of CASTING_GATED_STAGES) {
            const stage = run.stages?.[id];
            if (!stage) continue;
            if (readiness.ready) {
                if (stage.blockedBy !== CASTING_BLOCK_FLAG) continue;
                delete stage.blocked;
                delete stage.blockedReason;
                delete stage.blockedMissing;
                delete stage.blockedBy;
                delete stage.error;
                if (stage.status === "blocked") stage.status = "pending";
                changed = true;
                continue;
            }
            if (stage.status === "running") continue;
            stage.status = "blocked";
            stage.blockedBy = CASTING_BLOCK_FLAG;
            stage.blockedReason = readiness.reason;
            stage.error = readiness.reason;
            stage.blockedMissing = readiness.blocked.map((card) => ({ characterId: card.characterId, name: card.name, missing: card.missing }));
            stage.blocked = readiness.blocked.map((card) => ({ itemId: card.characterId, reason: `角色「${card.name}」缺 ${card.missing.join("、")}` }));
            changed = true;
        }
        return changed;
    }

    /**
     * 确认角色定妆（人工动作）：设置 face.confirmed / voice.confirmed / 角色 confirmed。
     *
     * - face 确认为真前必须有产物（正脸特写或三视图），否则可读报错（不假装已锁脸）；
     * - voice 的 speaker / language **只能**取平台音色库枚举，非法值 400；
     * - 角色 confirmed = 脸与声都真；确认时写 `lockedAt`（ISO）；**确认后修改**则 `version + 1`。
     */
    function confirmCasting(runId, patch = {}) {
        const run = requireRun(runId);
        const def = requireStageDef("casting");
        const stage = requireStage(run, def);
        const output = normalizeCasting(stage.output);
        if (!output.characters.length) throw gateError("角色定妆还没有角色身份卡，请先运行「角色定妆」", 409);
        const body = patch && typeof patch === "object" ? patch : {};
        const wanted = String(body.characterId ?? body.id ?? "").trim();
        const card = wanted
            ? output.characters.find((item) => item.characterId === wanted)
            : output.characters.length === 1
              ? output.characters[0]
              : null;
        if (!card) throw gateError(wanted ? `角色定妆里没有角色：${wanted}` : "有多个角色，请指定要确认的 characterId", 400);

        const before = JSON.stringify(card);
        const wasConfirmed = card.confirmed === true;

        if (body.closeupArtifactId !== undefined) card.face.closeupArtifactId = String(body.closeupArtifactId ?? "").trim();
        if (Array.isArray(body.turnaroundArtifactIds)) card.face.turnaroundArtifactIds = body.turnaroundArtifactIds.map((item) => String(item)).filter(Boolean);
        if (body.face !== undefined) {
            if (body.face === true) {
                if (!(card.face.closeupArtifactId || card.face.turnaroundArtifactIds.length)) {
                    throw gateError(`角色「${card.name || card.characterId}」还没有正脸或三视图产物，不能确认脸`, 409);
                }
                card.face.confirmed = true;
            } else if (body.face === false) {
                card.face.confirmed = false;
            }
        }

        if (body.speaker !== undefined) {
            const speaker = String(body.speaker ?? "").trim();
            if (!isSpeakerAllowed(speaker)) throw gateError(`不支持的音色「${speaker}」；可选：${QWEN3_TTS_SPEAKERS.join(" / ")}`, 400);
            card.voice.speaker = speaker;
        }
        if (body.design !== undefined) card.voice.design = String(body.design ?? "");
        if (body.language !== undefined) {
            const language = String(body.language ?? "").trim();
            if (language && !isLanguageAllowed(language)) throw gateError(`不支持的语种「${language}」`, 400);
            card.voice.language = language || card.voice.language;
        }
        if (body.speed !== undefined) {
            const speed = Number(body.speed);
            if (!Number.isFinite(speed) || speed <= 0) throw gateError("speed 必须是正数", 400);
            card.voice.speed = speed;
        }
        if (body.previewArtifactId !== undefined) card.voice.previewArtifactId = String(body.previewArtifactId ?? "").trim();
        if (body.voice !== undefined) {
            if (body.voice === true) {
                if (!isSpeakerAllowed(card.voice.speaker)) throw gateError(`角色「${card.name || card.characterId}」还没有选定合法音色，不能确认声音`, 409);
                card.voice.confirmed = true;
            } else if (body.voice === false) {
                card.voice.confirmed = false;
            }
        }

        card.confirmed = card.face.confirmed === true && card.voice.confirmed === true;
        const after = JSON.stringify(card);
        if (card.confirmed) {
            // 确认后再次修改 → version + 1；首次确认不涨版本。两种情况都刷新 lockedAt。
            if (wasConfirmed && before !== after) card.version = (Number(card.version) || 1) + 1;
            card.lockedAt = nowIso();
        } else {
            card.lockedAt = null;
        }

        stage.output = output;
        stage.status = "done";
        stage.error = undefined;
        stage.finishedAt = stage.finishedAt || nowIso();
        enforceCastingGate(run);
        saveOutput(run.id, def.id, stage.output);
        const saved = saveRun(run);
        return { run: saved, character: card, readiness: castingReadiness(output) };
    }

    /** 音频全部落地后以实测时长回写镜头内说话轮次。 */
    function refreshAudioTiming(run, stage, items) {
        if (!items.length || !items.every((entry) => entry.status === "done" && entry.actualDurationSec > 0)) return;
        const timing = buildAudioTimeline({ clips: run.stages?.storyboard?.output?.shots || [], audio: items.map((entry) => ({ ...entry, cueId: entry.id })), durations: items.map((entry) => entry.actualDurationSec), sequential: true });
        const byId = new Map(items.map((entry) => [entry.id, entry]));
        for (const cue of timing.audio) Object.assign(byId.get(cue.id), { startSec: cue.startSec, endSec: cue.endSec, durationSec: cue.durationSec });
        stage.output.timingIssues = timing.issues;
    }

    /** Job 终态投影：按 meta 反查 run/stage/item，幂等回写候选与派生字段，并让前置刚就绪的下游条目入队。 */
    function projectJob(job) {
        if (!job || !TERMINAL_JOB.has(job.status)) return null;
        const { runId, stageId, itemId } = job.meta || {};
        if (!runId || !stageId || !itemId) {
            // 画布来源 Job（无 run 三元组）：终态投影为项目槽位候选（M2-D6，只追加候选、不动 selected）。
            if (typeof projectCanvasJob === "function") projectCanvasJob(job);
            return null;
        }
        const run = get(runId);
        const def = stageDefs.get(String(stageId));
        const stage = run?.stages?.[stageId];
        const items = stageOutputItems(stage);
        const item = Array.isArray(items) ? items.find((entry) => entry.id === itemId) : null;
        if (!def || !item) return null;
        upsertCandidate(item, job);
        syncItem(item);
        if (def.id === "audio") refreshAudioTiming(run, stage, items);
        // 配音失败只降级记 warning（该对白不进成片音轨），绝不影响成片能否产出。
        if (def.id === "audio" && job.status === "error") appendWarning(item, `配音失败（${job.error || "TTS 任务失败"}），该对白不进成片音轨`);
        // 对口型失败/超时只降级记 warning（该镜成片**回落原片段**），绝不因此让成片失败。
        if (def.id === "lipsync" && job.status === "error") appendWarning(item, `对口型失败（${job.error || "lip-sync 任务失败"}），该镜成片回落原片段`);
        const shots = run.stages?.storyboard?.output?.shots || [];
        if (def.id === "keyframe") enqueueReady(run, def, stage, items, items, shots);
        else if (def.id === "assembly") enqueueReady(run, def, stage, items, run.stages?.keyframe?.output?.frames || [], shots);
        // 服化道参考图落地 → 绑定到 AssetRef.selectedArtifactId（幂等）。
        else if (def.id === "design") bindDesignReferenceArtifacts(run, stage);
        // 回写后若该条目最新候选落为 error，按预算自动重试（canceled 不在此列；未注入 getProject 时为空操作）。
        retryFailedItem(run, def, item);
        recomputeStage(stage, run);
        return saveRun(run);
    }

    /**
     * 订阅任务队列终态事件并重放历史任务，建立 Job→Artifact→Item 投影。index.js 启动时调用一次。
     * 重放让服务重启后能从 jobs.json 的终态任务重建流水线状态（幂等）。
     */
    function bindJobs() {
        if (typeof jobs?.on !== "function") return;
        jobs.on("change", (job) => {
            try {
                projectJob(job);
            } catch (error) {
                console.error(`[pipeline] 任务回写失败 ${job?.id}：${error.message}`);
            }
        });
        for (const job of jobs.list?.() || []) projectJob(job);
    }

    /** 取消阶段：连带取消该阶段已入队的图像/视频 Job，并把阶段落成 canceled。 */
    function cancelStage(runId, stageId) {
        requireRun(runId);
        const def = requireStageDef(stageId);
        let canceled = 0;
        for (const job of jobs?.list?.() || []) {
            const meta = job.meta || {};
            if (meta.runId !== runId || meta.stageId !== def.id || TERMINAL_JOB.has(job.status)) continue;
            jobs.cancel(job.id);
            // 取消一次就投影一次：即便队列没有订阅者，也能把终态写回流水线。
            projectJob(jobs.get(job.id) || job);
            canceled += 1;
        }
        return { canceled, run: get(runId) };
    }

    /**
     * 同步部分：校验依赖、绑定模型、标记 running 并落盘，返回执行所需上下文。
     * 拆出来是为了让 HTTP 路由能立刻返回 202 —— 一个 163 块 / 83 分钟的阶段不能用一个
     * 阻塞式 POST 扛：隧道、反向代理、浏览器都会在几分钟内掐断连接，前端 await 抛错后
     * 按钮复位、页面「毫无反应」，而后端仍在继续跑并消耗 LLM 额度。
     */
    function beginStage(runId, stageId, runOptions = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        if (stage.status === "running") throw new Error(`阶段「${def.title}」正在运行中，请先取消或等它结束`);
        // 调用方可按阶段绑定模型：body.model 持久化到 run.options.stageModels，重跑沿用
        if (typeof runOptions.model === "string" && runOptions.model.trim()) {
            run.options = { ...(run.options || {}), stageModels: { ...(run.options?.stageModels || {}), [def.id]: runOptions.model.trim() } };
        }
        // 浏览器渠道透传的外部 API：仅校验形状，仅本次调用生效，绝不写入 run/options
        let provider = null;
        if (runOptions.provider && typeof runOptions.provider === "object") {
            const baseUrl = String(runOptions.provider.baseUrl || "").trim();
            if (!/^https?:\/\//i.test(baseUrl)) throw new Error("provider.baseUrl 必须是 http(s) 地址");
            provider = { baseUrl, apiKey: String(runOptions.provider.apiKey || "") };
        }
        // 真实产物门禁：基于上游产物与状态给可解释原因（缺源 / 未产出 / error / partial / running / canceled），
        // 不再用一个笼统的「请先完成 X」盖掉失败原因。通过后才标记 running。
        const gate = stageGate(run, def.id);
        if (!gate.ready) throw gateError(gate.reason, 409);
        stage.status = "running";
        stage.error = undefined;
        stage.startedAt = nowIso();
        stage.finishedAt = undefined;
        // resume 为真时保留上次的分块结果以便断点续跑；否则清空，避免小说改过之后复用陈旧块
        if (runOptions.resume) {
            const cached = countChunks(runId);
            writeProgress(runId, { runId, stage: def.id, phase: "map", done: cached, total: 0, reused: cached, resumed: true, label: cached ? `复用已完成的 ${cached} 块` : "准备分块" });
        } else {
            clearChunks(runId);
            clearProgress(runId);
        }
        saveRun(run);
        appendRunLog(runsDir, run.id, { op: "stage.begin", actor: actorOf(runOptions), stage: def.id, message: `开始 ${def.title}` });
        return { run, def, stage, provider };
    }

    /** 异步部分：真正跑 LLM 与入队，并把终态与进度落盘。 */
    async function executeStage(begun, runOptions = {}) {
        const { run, def, stage, provider } = begun;
        const actor = actorOf(runOptions);
        const estSecondsPerChunk = Number(pipelineConfig.estSecondsPerChunk) > 0 ? Number(pipelineConfig.estSecondsPerChunk) : 31;
        try {
            // 生成型阶段重排前的产物，用于继承旧候选（重跑只追加候选，不清空旧 jobId/artifactUrl）。
            // design 也保留 prev：它现在会真正产出参考图（与基类生成型阶段相同的候选继承语义）。
            // casting 保留 prev：重跑时继承已确认的 face/voice 确认状态（不抹掉人确认过的结果）。
            const prevOutput = GENERATIVE_STAGES.has(def.id) || def.id === "design" || def.id === "audio" || def.id === "casting" || def.id === "lipsync" ? stage.output : null;
            // 配音 / 角色定妆 / 对口型阶段不调 LLM：Cue 由分镜台词与角色音色确定性派生（见 attachAudio），
            // 身份卡由剧本角色 + design 脸产物 + VoiceProfile 确定性组装（见 attachCasting），
            // 对口型由「源片段 + TTS 音频」确定性派生任务（见 attachLipsync）。
            if (def.id !== "audio" && def.id !== "casting" && def.id !== "lipsync") {
                await composeWithLlm(run, def, stage, provider, { signal: runOptions.signal, resume: Boolean(runOptions.resume), estSecondsPerChunk });
            }
            if (def.id === "audio") {
                if (audioModeOf(run) === AUDIO_MODE.EMBEDDED) {
                    // 项目级「原声」模式：不产独立配音（不入队 TTS），成片保留片段原声并逐句烧字幕。
                    stage.output = { audio: [] };
                    stage.status = "done";
                    stage.finishedAt = nowIso();
                } else {
                    attachAudio(run, def, stage, prevOutput);
                }
            } else if (def.id === "casting") {
                // 角色定妆：定脸 + 定声音 → 身份卡；未确认则立即把 keyframe / audio 置 blocked。
                attachCasting(run, def, stage, prevOutput);
            } else if (def.id === "lipsync") {
                // 对口型：片段产出后、成片前的生成型后处理；逐镜判定触发条件，产物另存，失败回落原片段。
                attachLipsync(run, def, stage, prevOutput);
            } else if (GENERATIVE_STAGES.has(def.id)) {
                // 语言适配预编译：入队前用注入的 llmCall 把「仅英文有官方依据」的模型提示词英文化（异步、失败只降级不阻塞）。
                const genItems = def.id === "keyframe" ? stage.output?.frames : stage.output?.clips;
                const genFrames = def.id === "keyframe" ? genItems : run.stages?.keyframe?.output?.frames || [];
                const genShots = run.stages?.storyboard?.output?.shots || [];
                await precompilePrompts(run, def, Array.isArray(genItems) ? genItems : [], genFrames, genShots);
                attachGeneration(run, def, stage, prevOutput);
                // 不再「入队即 done」：有任务就等任务终态（回写投影会重算），没有可跑任务（未接 runJob）才算完成。
                const enqueued = (stage.output.frames || stage.output.clips || []).some((item) => (item.candidates || []).length);
                if (!enqueued) {
                    stage.status = "done";
                    stage.finishedAt = nowIso();
                }
                // 重算一次把 blocked（参考图能力不足/参考图缺失）摊到阶段层，让门禁与前端都看得到，不静默当 done。
                recomputeStage(stage, run);
            } else if (def.id === "design") {
                // ① design 真正产出参考图（角色正脸特写/三视图、场景空场母版）：入队后阶段停在 running 等任务终态。
                const pending = attachDesignReferences(run, def, stage, prevOutput);
                if (!pending) {
                    stage.status = "done";
                    stage.finishedAt = nowIso();
                }
                recomputeStage(stage, run);
            } else {
                stage.status = "done";
                stage.finishedAt = nowIso();
            }
            // 分镜阶段产出即把「集」变成可分区事实键：归一 shots[].episodeId，并回填 project.episodes[].shotIds（幂等、不改 version）。
            if (def.id === "storyboard") {
                normalizeStoryboardEpisodes(run, stage);
                // D1：Σ段时长必须等于骨架，缺一段显式报出（写进 stage.warnings 与 stage.skeleton）。
                validateSkeleton(run, stage);
            }
            // P0-g 产物契约校验（结构 + 引用完整性）：未过即抛 → 阶段置 error、产物不落盘，
            // 不让坏产物继续流向下游并污染 Project 事实（development-plan.md §4.1「契约校验通过才 done」）。
            // 放在 storyboard 归一之后，避免拿归一前的 episodeId 产生噪声告警。
            const artifactCheck = checkStageArtifact(def.id, stage.output, stageUpstreamOf(run));
            if (!artifactCheck.ok) throw gateError(formatArtifactErrors(artifactCheck.errors), 409);
            for (const problem of artifactCheck.warnings) appendStageWarning(stage, `${problem.code}：${problem.message}`);
            // 剧本阶段产出即回填 01 的设定建议，并把剧本事实（script + episodes/scenes）投影进 Project（都幂等；未绑项目时为空操作）。
            if (def.id === "script") {
                backfillPlanSuggestion(run, stage.output);
                projectScriptFacts(run, stage.output);
                projectEpisodeFacts(run, stage.output);
            }
            // 服化道阶段产出即把角色/场景登记为项目 AssetRef（幂等；未接线时为旧行为），供 design 门禁判 done。
            if (def.id === "design") registerDesignAssets(run, stage);
            if (stage.output !== undefined && stage.output !== null) {
                saveOutput(run.id, def.id, stage.output);
                appendRunLog(runsDir, run.id, {
                    op: "stage.output",
                    actor,
                    stage: def.id,
                    hash: outputHash(stage.output),
                    ok: stage.status !== "error",
                    message: `${def.title}产物已落盘（${stage.status}）`,
                });
            }
            // 成功也保留一条进度：只有真正 done 才写 phase:"done"，生成型阶段等 Job 终态时写 running，
            // 否则前端会误判「跑完了」而停止轮询一个还在生成的任务。
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: stage.status === "done" ? "done" : "running", finishedAt: stage.finishedAt });
        } catch (error) {
            stage.status = "error";
            stage.error = error.raw ? `${error.message}：${String(error.raw).slice(0, 4000)}` : error.message;
            stage.finishedAt = nowIso();
            // 失败/取消时保留进度：前端才能显示「跑到第几块停的」，用户也才知道 resume 能省下多少
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: "failed", error: stage.error });
            appendRunLog(runsDir, run.id, { op: "stage.error", actor, stage: def.id, ok: false, message: stage.error });
        }
        return saveRun(run);
    }

    /** 同步等整段跑完（测试与内部调用用）；HTTP 路由走 beginStage + executeStage 以便立刻返回 202。 */
    async function runStage(runId, stageId, runOptions = {}) {
        return executeStage(beginStage(runId, stageId, runOptions), runOptions);
    }

    /**
     * 项目级「配音方式」（Plan.audioMode）：独立配音（默认）走 TTS 音轨，原声则保留片段内嵌音频。
     * 未绑项目 / 未填时回落默认「独立配音」。
     */
    function audioModeOf(run) {
        return productionDefaults(run).audioMode === AUDIO_MODE.EMBEDDED ? AUDIO_MODE.EMBEDDED : AUDIO_MODE.SEPARATE_DIALOGUE_TRACK;
    }

    /**
     * 成片字幕的逐句 Cue：从分镜台词的 AudioCue（audio.js 纯派生，带 shotId + startSec + durationSec）
     * 取对白/旁白正文，与 TTS 产物解耦 —— TTS 失败或原声模式下字幕照常有。
     * 无台词时返回空数组（成片降级为无字幕，绝不失败）。
     */
    function subtitleCuesFor(run) {
        const shots = run.stages?.storyboard?.output?.shots || [];
        if (!Array.isArray(shots) || !shots.length) return [];
        return projectAudioCues({ project: projectOf(run), storyboard: shots })
            .filter((cue) => (cue.type === "dialogue" || cue.type === "narration") && String(cue.text ?? "").trim() !== "");
    }

    /**
     * 成片混音入参：调用方未显式给 audio 时，从配音阶段产物派生。
     * 只把**已有产物**的 audio item 交给 delivery（带 `shotId + startSec`）；无产物（TTS 失败/未跑配音）
     * 自动跳过 —— delivery 的 normalizeAudioItems 也会丢弃空 ref，因此配音失败绝不阻塞出片。
     */
    /**
     * 给成片准备独立配音音轨。
     *
     * ⚠️ **只喂磁盘上真实存在的音频产物**：此前只判 `item.artifactUrl` 是否存在（登记了就算数），
     * 于是「音频产物登记了 URL 但文件不在磁盘上」会一路喂进混音 → **ffmpeg 直接退码非 0，整部成片失败**。
     * 这不是理论问题：实测构造该场景时成片 `status=error`、ffmpeg 退出码 254。
     * 现在改为**跳过缺失项 + 写可读 warning**，让成片照出（宁愿少一句台词，也不要整片挂掉）。
     */
    function audioForAssemble(run, config) {
        const stage = run?.stages?.audio;
        const items = stage?.output?.audio;
        if (!Array.isArray(items) || !items.length) return [];
        const cues = [];
        const missing = [];
        for (const item of items) {
            if (!item || !item.artifactUrl) continue;
            // 只在「能解析成本网关的磁盘路径、但文件确实不在」时才跳过。
            // 非本网关地址（外部 URL / 测试夹具）解析不出路径 → 交给下游处理，别自作主张丢弃。
            const localPath = artifactFilePath(config, item.artifactUrl);
            if (localPath && !existsSync(localPath)) {
                missing.push(item);
                continue;
            }
            cues.push({ id: item.id, ref: item.artifactUrl, shotId: item.shotId, startSec: item.startSec, type: item.type, gainDb: item.gainDb });
        }
        if (missing.length) {
            appendStageWarning(
                stage,
                `有 ${missing.length} 条配音产物在磁盘上不存在（${missing.map((item) => item.id).join("、")}），已跳过这些音轨 —— 成片会缺这几句台词，请重跑这些条目的配音`,
            );
        }
        if (!cues.length) return [];
        const clips = run?.stages?.assembly?.output?.clips || [];
        return buildMixInput({ clips, cues }).audio;
    }

    /** 片段就绪判定：任一未成功的片段都会阻止合成，并给出人能看懂的原因。 */
    function clipsReadiness(clips) {
        if (!Array.isArray(clips) || !clips.length) return { ready: false, reason: "assembly 阶段还没有片段清单，请先运行「片段合成」规划片段" };
        const unfinished = clips.filter((clip) => clip.status !== "done");
        if (unfinished.length) {
            const detail = unfinished.map((clip) => `${clip.id}（${clip.status || "未知"}）`).join("、");
            return { ready: false, reason: `还有 ${unfinished.length}/${clips.length} 个片段未成功，不能合成成片：${detail}` };
        }
        const missing = clips.filter((clip) => !clip.artifactUrl);
        if (missing.length) return { ready: false, reason: `片段 ${missing.map((clip) => clip.id).join("、")} 没有产物地址，不能合成成片` };
        return { ready: true };
    }

    /**
     * 合成成片（同步部分）：独立于阶段 LLM 编排的用户触发动作 —— D11 定了保留逐阶段人工审核门禁，
     * 用户要先看过片段才决定拼，所以不因 clips 齐了就自动拼。
     * 这里只做门禁与幂等判定：片段未全部成功直接抛错（不能把「片段生成完」报成「成片完成」）；
     * 已有成片且未显式要求重拼时直接复用，不重复调 ffmpeg。慢的 ffmpeg 执行留给 executeAssemble。
     */
    function beginAssemble(runId, options = {}) {
        const run = requireRun(runId);
        const def = requireStageDef("assembly");
        const stage = requireStage(run, def);
        const output = stage.output;
        if (!output || !Array.isArray(output.clips)) throw new Error("assembly 阶段还没有产物，请先运行「片段合成」规划片段");
        const readiness = clipsReadiness(output.clips);
        if (!readiness.ready) throw new Error(readiness.reason);

        const assembly = output.assembly && typeof output.assembly === "object" ? output.assembly : (output.assembly = {});
        const force = options.force === true || options.rerun === true;
        if (assembly.status === "assembling" && !force) throw new Error("成片正在合成中，请等它结束（要重拼请带 force:true）");
        if (assembly.status === "done" && assembly.url && !force) return { run, def, stage, reused: true, assembly };

        // 重拼用新的产物目录，绝不覆盖上一次已成功的成片（即使这次拼失败，旧成片仍在）
        const attempt = (Number(assembly.attempt) || 0) + 1;
        const id = attempt > 1 ? `assembly-${run.id}-r${attempt}` : `assembly-${run.id}`;
        assembly.attempt = attempt;
        assembly.status = "assembling";
        assembly.startedAt = nowIso();
        assembly.finishedAt = undefined;
        assembly.error = undefined;
        assembly.quality = undefined;
        // 本次调用可覆盖拼接顺序/转场；未给则沿用规划值
        if (Array.isArray(options.order) && options.order.length) assembly.order = options.order;
        if (typeof options.transition === "string" && options.transition) assembly.transition = options.transition;
        saveOutput(run.id, def.id, stage.output);
        saveRun(run);
        return { run, def, stage, reused: false, assembly, id };
    }

    /**
     * 合成成片（异步部分）：把片段清单与参数交给 delivery 的 assembleEpisode，产物地址与成片信息回写 assembly。
     * 成功才写 url 并登记 artifacts；失败保留 delivery 已落盘的清单与 ffmpeg 日志地址，错误信息带原因，方便排查。
     */
    async function executeAssemble(begun, options = {}) {
        const { run, def, stage, id } = begun;
        const assembly = stage.output.assembly;
        const clips = stage.output.clips;
        // ── 对口型（lipsync）产物优先：只用**另存**的新片段替换进片用清单，**绝不改写** assembly.output.clips ──────
        // ① 有对口型产物（且成功）的镜 → 成片用新片段；② 失败/取消/未跑 → 回落原片段（绝不阻塞成片）。
        // 原片段清单保持不动，因此可回滚、可对比；替换只发生在交 delivery 的这份「派生副本」上。
        const lipsyncItems = Array.isArray(run.stages?.lipsync?.output?.clips) ? run.stages.lipsync.output.clips : [];
        const lipSyncByShot = new Map();
        for (const item of lipsyncItems) {
            if (item?.status === "done" && item.artifactUrl && item.shotId !== undefined && item.shotId !== null) lipSyncByShot.set(String(item.shotId), item);
        }
        const clipsForFilm = [];
        for (const clip of clips) {
            const key = clip?.shotId !== undefined && clip?.shotId !== null ? String(clip.shotId) : null;
            const lip = key ? lipSyncByShot.get(key) : null;
            if (!lip) {
                clipsForFilm.push(clip);
                continue;
            }
            // 对口型产物长度随音频对齐（可能短于原片段）：探**真实时长**，保证成片时间轴（后续片段/音轨偏移）正确。
            // 探不到就沿用原 durationSec（不臆造、不阻塞）。
            let durationSec = clip.durationSec;
            const lipFile = artifactFilePath(config, lip.artifactUrl);
            if (lipFile) {
                const media = await probeMedia(lipFile, pipelineConfig.ffprobePath).catch(() => null);
                if (Number.isFinite(Number(media?.durationSec)) && Number(media.durationSec) > 0) durationSec = Number(media.durationSec);
            }
            clipsForFilm.push({ ...clip, artifactUrl: lip.artifactUrl, durationSec, lipSyncArtifactUrl: lip.artifactUrl, lipSyncJobId: lip.jobId ?? null });
        }
        // 失败/取消/未配置模板的镜：写可读 warning（成片照常出，只是该镜用原片段）。
        for (const item of lipsyncItems) {
            if (item?.artifactUrl) continue;
            const reason = item?.warning || item?.blockedReason || (item?.status === "canceled" ? "对口型已取消" : "对口型未产出");
            appendStageWarning(stage, `镜头「${item?.shotId ?? item?.id}」${reason}，成片已回落原片段`);
        }
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: "assembling", label: `正在把 ${clips.length} 个片段合成成片` });
        // 成片尺寸与片段同一口径：都从「该视频模型的官方规格登记表」取（H3 竖屏 = 768x1344），避免片段与成片不一致被二次重采样。
        const assembleDims = sizeForRatio(pipelineConfig.videoTemplate, productionDefaults(run).ratio, { base: Math.min(Number(pipelineConfig.videoWidth) || 768, Number(pipelineConfig.videoHeight) || 1344) });
        // ── 配音方式（项目级 Plan.audioMode）+ 逐句字幕（按台词时间轴）────────────────────────────
        const audioMode = audioModeOf(run);
        const separate = audioMode !== AUDIO_MODE.EMBEDDED;
        assembly.audioMode = audioMode;
        // 独立配音：用现有 audio 阶段产物（TTS 音轨）；原声：不混独立音轨，片段原声即人声事实源。
        const assembleAudio = separate
            ? (Array.isArray(options.audio) && options.audio.length ? options.audio : audioForAssemble(run, config))
            : [];
        // 独立配音缺失时也不切换为另一套人物声音；保留草稿，并明确标记缺台词。
        const includeClipAudio = !separate;
        // 字幕与 TTS 产物解耦：从分镜台词的 Cue（shotId + startSec）逐句生成 SRT；无台词/无时间轴 → 空串（不产、不失败）。
        // 独立交付：SRT 作为**独立产物**落盘（供剪映精剪/下载），成片 mp4 **默认不烧字幕**（烧死了剪映改不了）；
        // 烧录能力保留 —— 仅当调用方显式 `options.burnSubtitles === true` 时才交 delivery 烧入。
        const burnSubtitles = options.burnSubtitles === true;
        const subtitleCues = subtitleCuesFor(run);
        const srt = buildCueSrt({
            clips: clipsForFilm,
            order: assembly.order,
            transition: assembly.transition,
            transitionDurationSec: options.transitionDurationSec ?? assembly.transitionDurationSec,
            cues: subtitleCues,
        });
        const srtLines = srt ? srt.trim().split(/\n\s*\n/).filter(Boolean).length : 0;
        try {
            const result = await assemble({
                config,
                episodeId: run.id,
                clips: clipsForFilm,
                order: assembly.order,
                transition: assembly.transition,
                options: {
                    id,
                    width: assembleDims.width ?? config.pipeline?.videoWidth,
                    height: assembleDims.height ?? config.pipeline?.videoHeight,
                    quality: options.quality,
                    transitionDurationSec: options.transitionDurationSec,
                    audio: assembleAudio,
                    scheduleDialogue: separate && !(Array.isArray(options.audio) && options.audio.length),
                    subtitleCues,
                    qualityIssues: separate && subtitleCues.some((cue) => !assembleAudio.some((item) => item.cueId === cue.id))
                        ? [{ code: "dialogue_missing", message: "部分台词缺少独立配音，请补齐后重新合成" }]
                        : [],
                    includeClipAudio,
                    subtitles: options.subtitles,
                    subtitlesText: options.subtitlesText || null,
                    burnSubtitles,
                    subtitleStyle: burnSubtitles && (options.subtitles || options.subtitlesText || srt) ? (options.subtitleStyle || DEFAULT_SUBTITLE_STYLE) : null,
                    cover: options.cover,
                },
                now: nowIso(),
            });
            // 字幕产物登记：独立 SRT 落盘 + 可下载 URL；默认未烧（burned:false）。无台词/无时间轴 → 无字幕 + warning，绝不让出片失败。
            const generated = Boolean(result.subtitlesUrl);
            assembly.subtitleCues = subtitleCues.length;
            assembly.subtitles = {
                burned: Boolean(result.subtitlesBurned),
                cueCount: subtitleCues.length,
                lines: generated ? srtLines : 0,
                url: result.subtitlesUrl || null,
                name: result.subtitlesName || null,
            };
            if (generated) {
                // 新语义：字幕是**独立文件**（不是失败），成片照常干净出片。
                assembly.subtitles.reason = "已生成独立字幕文件（未烧入画面，供剪映精剪）";
            } else {
                const reason = subtitleCues.length === 0 ? "没有台词，未生成字幕文件" : "缺少可对齐的片段时间轴，未生成字幕文件";
                assembly.subtitles.reason = reason;
                const prior = Array.isArray(stage.warnings)
                    ? stage.warnings.filter((w) => !String(w).startsWith("成片无独立字幕：") && !String(w).startsWith("成片未烧字幕："))
                    : [];
                stage.warnings = [...prior, `成片无独立字幕：${reason}（成片照常产出）`];
            }
            assembly.status = "done";
            assembly.deliverableId = result.id;
            assembly.url = result.url;
            assembly.manifestUrl = result.manifestUrl;
            assembly.logUrl = result.logPath ? artifactUrl(config, result.id, "ffmpeg.log") : null;
            assembly.coverUrl = result.coverUrl || null;
            assembly.bytes = result.bytes;
            assembly.info = result.info || null;
            assembly.audioMode = audioMode;
            assembly.quality = result.quality || { status: "needs_review", issues: [] };
            // 对口型落地情况：本片用了几条对口型片段（其余回落原片段）——可验证、可追溯。
            assembly.lipSync = {
                used: clipsForFilm.filter((clip) => clip.lipSyncArtifactUrl).length,
                total: clips.length,
            };
            assembly.finishedAt = nowIso();
            assembly.error = undefined;
        } catch (error) {
            assembly.status = "error";
            assembly.quality = error.quality || { status: "blocked", issues: [{ code: "assembly_failed", message: error.message }] };
            assembly.error = `合成成片失败：${error.message}`;
            assembly.finishedAt = nowIso();
            // 保留 delivery 落盘的清单与日志（都在同一个交付目录下），失败也要能复现
            const dir = safeJoin(config.dataDir, "artifacts", id);
            assembly.manifestUrl = dir && existsSync(safeJoin(dir, "assembly-manifest.json")) ? artifactUrl(config, id, "assembly-manifest.json") : null;
            assembly.logUrl = dir && existsSync(safeJoin(dir, "ffmpeg.log")) ? artifactUrl(config, id, "ffmpeg.log") : null;
        }
        recomputeStage(stage, run);
        if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
        // 成片已经落盘，不因结构问题作废（那会把用户等出来的几分钟 ffmpeg 白扔）；有问题记 warn 供排查。
        const filmCheck = checkStageArtifact("assembly", stage.output, stageUpstreamOf(run));
        for (const problem of filmCheck.warnings) appendStageWarning(stage, `${problem.code}：${problem.message}`);
        if (!filmCheck.ok) appendStageWarning(stage, `成片已产出，但产物契约有 ${filmCheck.errors.length} 处问题：${filmCheck.errors.map((item) => item.code).join("、")}`);
        appendRunLog(runsDir, run.id, {
            op: "assemble.done",
            actor: actorOf(options),
            stage: def.id,
            hash: outputHash(stage.output),
            ok: assembly.status === "done",
            message: assembly.status === "done" ? `成片已生成：${assembly.url || ""}` : String(assembly.error || "成片合成失败"),
        });
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: assembly.status === "done" ? "done" : "failed", label: assembly.status === "done" ? "成片已生成" : assembly.error, finishedAt: assembly.finishedAt });
        return saveRun(run);
    }

    /** 同步等合成结束（测试与内部调用用）；HTTP 路由走 beginAssemble + executeAssemble 以便立刻返回 202。 */
    async function assembleStage(runId, options = {}) {
        const begun = beginAssemble(runId, options);
        if (begun.reused) return begun.run;
        return executeAssemble(begun, options);
    }

    /** 轻量进度：只读 progress.json（几十字节），不返回内嵌整本小说的 run.json（可达数 MB）。 */
    const stageProgress = (runId) => readProgress(runId);

    /** 审计日志读取（追加式 log.jsonl 的尾部）：前端与 Agent 用它回答"这一步是谁、什么时候、改了哪一版"。 */
    const runLog = (runId, limit) => readRunLog(runsDir, String(runId), limit);

    /** 分镜阶段的骨架对齐结果（D1）；未跑过分镜返回 null。 */
    const skeletonOf = (runId) => get(runId)?.stages?.storyboard?.skeleton || null;

    /**
     * 启动收敛：把上次进程遗留的 running 阶段落成明确 error。
     * 必须做 —— beginStage 会拒绝在 running 阶段上重跑，不收敛的话重启一次就把那个阶段永久锁死。
     * 分块结果仍在 chunks/ 里，带 resume:true 重跑即可续上，不必从头再来。
     */
    function reconcileRunning() {
        const fixed = [];
        for (const run of list()) {
            let touched = false;
            for (const stage of Object.values(run.stages || {})) {
                if (stage.status !== "running") continue;
                stage.status = "error";
                stage.error = "服务重启导致中断；已完成的分块结果已保留，可用 resume 续跑";
                stage.finishedAt = nowIso();
                writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: stage.id, phase: "failed", error: stage.error });
                touched = true;
            }
            // beginAssemble 只写 assembly.status = "assembling"，**从不改 stage.status**，上面的 running 收敛因此漏掉它：
            // ffmpeg 合成中途进程被杀时，该 run 会永久卡在「正在合成中」（前端没有 force 入口，beginAssemble 只认 force）。
            // 按同一风格落成明确终态 error + 可读原因，让用户能重新发起合成。
            const assembly = run.stages?.assembly?.output?.assembly;
            if (assembly && typeof assembly === "object" && assembly.status === "assembling") {
                assembly.status = "error";
                assembly.error = "服务重启导致合成中断；可重新发起「生成成片」";
                assembly.finishedAt = nowIso();
                writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: "assembly", phase: "failed", error: assembly.error });
                touched = true;
            }
            if (touched) {
                saveRun(run);
                fixed.push(run.id);
            }
        }
        return fixed;
    }

    return { stages, list, get, create, fork, estimate: estimateFor, runStage, beginStage, executeStage, stageProgress, runLog, qualityCheck, latestQualityCheck, reconcileRunning, setStageInput, projectJob, bindJobs, cancelStage, beginAssemble, executeAssemble, assembleStage, beginRegenerate, executeRegenerate, retryFailedItems, groupFramesByReference, stageGate, stageGates, patchStageShot, durationPolicy, skeletonOf, castingReadinessOf, enforceCastingGate, confirmCasting };
}

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitNovelIntoChunks } from "./chunk-novel.js";
import { ASSET_ROLE } from "./contracts.js";
import { assembleEpisode } from "./delivery.js";
import { artifactUrl, ensureDir, safeJoin } from "./files.js";
import { listTemplates } from "./providers/comfy.js";
import { loadRegistry, readSkill } from "./skills.js";

/** 生成型阶段：只构造生成任务参数并交给任务队列，不等真实产物。 */
const GENERATIVE_STAGES = new Set(["keyframe", "assembly"]);

/** 生成型阶段 → 可用模板 family：关键帧出图、片段出视频。 */
const STAGE_TEMPLATE_FAMILY = Object.freeze({ keyframe: "image", assembly: "video" });

/** 生成型阶段 → 自动登记的 AssetRef.role（取值见 contracts.js 的 ASSET_ROLE，不自造枚举）：关键帧出图给 keyframe，片段/成片给 clip。 */
const GENERATIVE_STAGE_ASSET_ROLE = Object.freeze({ keyframe: ASSET_ROLE.KEYFRAME, assembly: ASSET_ROLE.CLIP });

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
 * H3 系列模板的 LENGTH 走 17n+5 帧网格（5s≈123 帧、10s≈243 帧）。
 * 取不小于目标时长的最小网格点，避免把非网格帧数喂给模型。
 */
function frameCountFor(seconds, fps) {
    const desired = Math.max(1, Math.round(Number(seconds) * Number(fps)));
    const steps = Math.max(0, Math.round((desired - 5) / 17));
    return 17 * steps + 5;
}

/** 把像素值吸附到最近的 32 倍数：H3 节点硬性要求宽高可被 32 整除（与 generate.js 的兜底吸附同一口径）。 */
function snap32(value) {
    return Math.max(32, Math.round(Number(value) / 32) * 32);
}

/**
 * 把「宽:高」比例换算成像素尺寸，两边都吸附到 32 的倍数。
 * base 是短边基准（取 config 默认宽高的短边），保证同一画幅不同项目产出一致尺寸。
 * 解析失败返回 null，调用方回落到 config.pipeline 的默认宽高。
 */
function dimensionsForRatio(ratio, base) {
    const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(ratio ?? "").trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0) || !(height > 0)) return null;
    const short = Math.max(32, Number(base) || 768);
    return {
        WIDTH: snap32(width >= height ? (short * width) / height : short),
        HEIGHT: snap32(height >= width ? (short * height) / width : short),
    };
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

function nowIso() {
    return new Date().toISOString();
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
export function createPipeline({ config, skillsDir, jobs, comfy, llm, runJob, assemble = assembleEpisode, getProject, applyPlanSuggestion, applyScriptProjection, applyEpisodeProjection, attachProjectRun, registerAssetRef } = {}) {
    const pipelineConfig = config?.pipeline || {};
    // 半自动总开关：注入 getProject（项目化模式）时才启用「单镜失败自动重试」。
    // 未注入时一律保持旧的「失败即止」行为；plan 驱动参数靠 projectOf 返回 null 自然回落，不需要额外开关。
    const autoRetryEnabled = typeof getProject === "function";
    // 单镜失败自动重试次数：pipeline.maxItemRetries 可配，默认 2；用尽后阶段自然落到 error/partial。
    const maxItemRetries =
        Number.isFinite(Number(pipelineConfig.maxItemRetries)) && Number(pipelineConfig.maxItemRetries) >= 0 ? Math.floor(Number(pipelineConfig.maxItemRetries)) : 2;
    const runsDir = ensureDir(join(config?.dataDir || "data", "runs"));
    const registry = loadRegistry(skillsDir);
    const stageDefs = new Map(registry.stages.map((item) => [item.id, item]));
    // 模板名 → family（image/video/edit/upscale）。regenerate 用它校验「换的模型属于该阶段该出图还是出视频」。
    const templateFamilies = new Map(listTemplates(config?.workflowsDir).map((template) => [template.name, template.family]));

    const runFile = (runId) => safeJoin(runsDir, String(runId), "run.json");
    const stageFile = (runId, stageId) => safeJoin(runsDir, String(runId), `${stageId}.json`);
    const progressFile = (runId) => safeJoin(runsDir, String(runId), "progress.json");
    const chunksDir = (runId) => safeJoin(runsDir, String(runId), "chunks");
    const chunkFile = (runId, index) => safeJoin(chunksDir(runId), `${Number(index)}.json`);

    function readJsonFile(file) {
        if (!file || !existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            console.warn(`[pipeline] 文件损坏，按空处理：${file}（${error.message}）`);
            return null;
        }
    }

    function saveRun(run) {
        run.updatedAt = nowIso();
        ensureDir(join(runsDir, run.id));
        writeFileSync(runFile(run.id), JSON.stringify(run, null, 2));
        return run;
    }

    function saveOutput(runId, stageId, output) {
        writeFileSync(stageFile(runId, stageId), JSON.stringify(output, null, 2));
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

    function create({ novel, title, options } = {}) {
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
        return saved;
    }

    /** 人工修订产物：body `{ output: <该阶段产物 JSON> }` 时置为 done 并落盘，下游立即可用；其余键合并进 inputs。 */
    function setStageInput(runId, stageId, patch = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        const body = patch && typeof patch === "object" ? patch : {};
        if (body.output !== undefined) {
            stage.output = body.output;
            stage.status = "done";
            stage.error = undefined;
            stage.finishedAt = stage.finishedAt || nowIso();
            saveOutput(run.id, def.id, body.output);
        } else {
            stage.inputs = { ...stage.inputs, ...body };
        }
        return saveRun(run);
    }

    /**
     * 把 novel、流水线配置与全部已产出的上游产物组装成模板上下文，上游 key 用该阶段 produces 的名字。
     * 风格维度只在这里注入事实源：项目级 styleAnchor（其次 run.options.styleAnchor）写进 options.styleAnchor，
     * 使技能里的 {{options.styleAnchor}} 一定能被替换；缺锚点时给中性兜底，绝不让占位符原样漏给模型。
     */
    function buildContext(run, def) {
        const project = projectOf(run);
        const plan = project?.plan && typeof project.plan === "object" ? project.plan : {};
        const context = {
            novel: run.novel,
            title: run.title,
            options: { ...(run.options || {}), styleAnchor: resolveStyleAnchor(run) || NEUTRAL_STYLE_ANCHOR, plan },
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
        return run.options?.stageModels?.[stageId] || run.options?.llmModel || pipelineConfig.llmModel || "";
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
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: "single", done: 0, total: 1, label: `模型生成中（提示词 ${prompt.length} 字）`, steps: scriptStepsView(stage) });
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
            writeProgress(run.id, { runId: run.id, stage: def.id, phase: "single", done: 0, total: 1, label: `模型生成中（提示词 ${prompt.length} 字）` });
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

    /** item 的派生别名（jobId/artifactUrl/status）由候选列表算出，selected 指向当前采用的候选；绝不删除旧候选。 */
    function syncItem(item) {
        const candidates = Array.isArray(item.candidates) ? item.candidates : [];
        if (!candidates.length) return;
        const selected = candidates[candidates.length - 1];
        item.selected = selected.jobId;
        item.jobId = selected.jobId;
        item.status = selected.status;
        // 产物取「当前候选，其次最近一次成功」，重跑进行中也不会丢掉上一次的结果。
        const lastUrl = [...candidates].reverse().find((candidate) => candidate.artifactUrl)?.artifactUrl;
        item.artifactUrl = selected.artifactUrl || lastUrl || null;
    }

    /** 幂等 upsert 一个候选：同一个 jobId 只更新状态与产物，不重复追加。 */
    function upsertCandidate(item, job) {
        item.candidates = Array.isArray(item.candidates) ? item.candidates : [];
        const artifactUrl = job.status === "done" ? job.outputs?.[0]?.url ?? null : null;
        const existing = item.candidates.find((candidate) => candidate.jobId === job.id);
        if (existing) {
            existing.status = job.status;
            existing.artifactUrl = artifactUrl;
            return;
        }
        item.candidates.push({ template: job.template, jobId: job.id, artifactUrl, status: job.status, params: job.params, createdAt: job.createdAt || nowIso() });
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
     * 全部进行中 running、部分成功 partial、全失败 error、有取消 canceled。重算 artifacts。
     * artifacts 会重建为「片段条目 + 成片条目」，成片信息由 filmArtifacts 从 assembly 派生，天然幂等。
     */
    function recomputeStage(stage, run) {
        const items = stage.output?.frames || stage.output?.clips || [];
        const latest = items.map((item) => (item.candidates || []).at(-1)).filter(Boolean);
        stage.artifacts = [...items.filter((item) => item.artifactUrl).map((item) => ({ jobId: item.jobId, url: item.artifactUrl })), ...filmArtifacts(stage)];
        registerArtifacts(run, stage);
        if (!latest.length) return;
        const statuses = latest.map((candidate) => candidate.status);
        // 只要有任务还在排队/运行就是 running —— 部分已完成既不代表阶段可审阅、也不代表可续跑；
        // 前端也靠 stage.status === "running" 决定要不要继续轮询阶段进度。
        if (statuses.some((status) => status === "queued" || status === "running")) stage.status = "running";
        else if (statuses.every((status) => status === "done")) stage.status = "done";
        else if (statuses.some((status) => status === "done")) stage.status = "partial";
        else if (statuses.includes("canceled")) stage.status = "canceled";
        else stage.status = "error";
        if (TERMINAL_JOB.has(stage.status)) stage.finishedAt = stage.finishedAt || nowIso();
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
     * 服化道（design）阶段产物自动登记为项目 AssetRef，补上「design 无产物 → 项目门禁永远判不出 done」的缺口。
     * 角色 → role=character、场景 → role=scene，bindingId 取剧本里的角色/场景 id（契约 §3.8：一致性锚点）。
     * 走 registerArtifacts 同一套注入的 registerAssetRef + 幂等去重：按 (runId, stageId, bindingId) 命中即跳过，
     * 重启重放读到旧引用同样不重复；登记失败只告警，绝不拖垮阶段。
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
        for (const [key, role] of groups) {
            for (const item of Array.isArray(output[key]) ? output[key] : []) {
                const bindingId = String(item?.id ?? "").trim();
                if (!bindingId || seen.has(bindingId)) continue;
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
            anchor,
            context: [anchor, flavor].filter(Boolean).join("。"),
            filmLayer: anchor && FILM_ANCHOR_PATTERN.test(anchor) ? LUSTER_FILM_LAYER : "",
        };
    }

    /** 单个条目的生成参数与就绪判定：模板要求的 token 必须全给，尺寸取 config.pipeline 默认值。 */
    function generativePlan(run, def, item, frames, shots) {
        const extraParams = (def.id === "keyframe" ? run.options?.image : run.options?.video) || {};
        const style = productionDefaults(run);
        const start = frames.find((frame) => frame.shotId === item.shotId && frame.role === "start");
        if (def.id === "keyframe") {
            // ratio 有值时按项目画幅推导尺寸（32 倍数），无值时沿用 config 默认宽高。
            const imageDims = dimensionsForRatio(style.ratio, Math.min(Number(pipelineConfig.imageWidth) || 768, Number(pipelineConfig.imageHeight) || 1344));
            // start / key / end 都用同一个文生图模板；end 帧要等同镜 start 帧产出后才能带参考图入队。
            return {
                kind: "image",
                template: pipelineConfig.imageTemplate,
                ready: item.role !== "end" || Boolean(start?.artifactUrl),
                params: {
                    WIDTH: imageDims ? imageDims.WIDTH : Number(pipelineConfig.imageWidth) || 768,
                    HEIGHT: imageDims ? imageDims.HEIGHT : Number(pipelineConfig.imageHeight) || 1344,
                    BATCH: Number(pipelineConfig.imageBatch) || 1,
                    PROMPT: withPromptHead(style, item.prompt),
                    ...(item.role === "end" ? { INPUT_IMAGE: start?.artifactUrl } : {}),
                    ...extraParams,
                },
            };
        }
        // 单集时长作片段默认时长：条目自带 durationSec 时优先用它，否则用 plan.episodeDurationSec，再回落 config.videoSeconds。
        const videoDefaultSeconds = style.episodeDurationSec ?? (Number(pipelineConfig.videoSeconds) || 5);
        item.durationSec = Number(item.durationSec) > 0 ? Number(item.durationSec) : videoDefaultSeconds;
        if (!item.keyframeId) item.keyframeId = start?.id ?? null;
        const shot = shots.find((entry) => entry.id === item.shotId);
        const videoDims = dimensionsForRatio(style.ratio, Math.min(Number(pipelineConfig.videoWidth) || 768, Number(pipelineConfig.videoHeight) || 1344));
        return {
            kind: "video",
            template: pipelineConfig.videoTemplate,
            // 图生视频必须有起始帧；没拿到就保持 queued + jobId:null，等关键帧产物就绪后由回写代理入队（契约见 05 SKILL.md）。
            ready: Boolean(start?.artifactUrl),
            params: {
                WIDTH: videoDims ? videoDims.WIDTH : Number(pipelineConfig.videoWidth) || 768,
                HEIGHT: videoDims ? videoDims.HEIGHT : Number(pipelineConfig.videoHeight) || 1344,
                PROMPT: withPromptHead(style, [shot?.prompt, shot?.action].filter(Boolean).join(", ")),
                LENGTH: frameCountFor(item.durationSec, Number(pipelineConfig.videoFps) || 24),
                ...(start?.artifactUrl ? { INPUT_IMAGE: start.artifactUrl } : {}),
                ...extraParams,
            },
        };
    }

    /** 入队一次生成尝试并追加候选。重跑用带时间戳的新 id，绝不覆盖旧 jobId/artifactUrl。 */
    function enqueueAttempt(run, def, item, plan) {
        if (typeof runJob !== "function" || typeof jobs?.enqueue !== "function") return null;
        const base = `${run.id}-${item.id}`;
        // 重跑必然带时间戳 + 随机后缀：同一毫秒内连点两次也不能撞出同一个 jobId，否则候选会被 upsert 合并。
        const id = item.candidates?.length ? `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : base;
        const job = jobs.enqueue({ id, kind: plan.kind, template: plan.template, name: item.id, params: plan.params, meta: { runId: run.id, stageId: def.id, itemId: item.id } }, runJob);
        if (!job) return null;
        item.candidates = [...(item.candidates || []), { template: plan.template, jobId: job.id, artifactUrl: null, status: "queued", params: plan.params, createdAt: nowIso() }];
        item.jobId = job.id;
        item.selected = job.id;
        item.status = "queued";
        return job.id;
    }

    /** 让尚未入队且前置已就绪的条目补入队；幂等：已有本次 jobId 的跳过。首次编排与回写后都走这里。 */
    function enqueueReady(run, def, stage, items, frames, shots) {
        for (const item of items) {
            const plan = generativePlan(run, def, item, frames, shots);
            item.template = plan.template;
            if (item.jobId || !plan.ready) continue;
            enqueueAttempt(run, def, item, plan);
        }
    }

    /**
     * 单镜失败自动重试：最新候选为 error 且自动重试预算未用尽时，用**同一份 template/params** 追加一个新候选。
     * 幂等：预算由候选列表里 autoRetry 候选的数量导出（不依赖内存计数器），
     * 且新候选入队后 latest 立刻变 queued，重放同一失败事件不会再触发一次；
     * 未注入 getProject（autoRetryEnabled=false）时不启用，保持旧的「失败即止」。
     */
    function retryFailedItem(run, def, item) {
        if (!autoRetryEnabled) return false;
        const candidates = Array.isArray(item.candidates) ? item.candidates : [];
        const latest = candidates.at(-1);
        if (!latest || latest.status !== "error") return false;
        const used = candidates.filter((candidate) => candidate.autoRetry).length;
        if (used >= maxItemRetries) return false;
        const plan = { kind: STAGE_TEMPLATE_FAMILY[def.id], template: latest.template, params: latest.params || {}, ready: true };
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
    function beginRegenerate(runId, stageId, { itemId, template, params } = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        // 只有生成型阶段有候选活扣；文本阶段（script/storyboard 等）明确拒绝。
        const family = STAGE_TEMPLATE_FAMILY[def.id];
        if (!family) throw gateError(`阶段「${def.title}」不是生成型阶段，不支持逐条重跑`);
        // 阶段整体在跑（LLM 编排中，或已有条目在排队/生成）→ 拒绝并发重复入队。
        if (stage.status === "running") throw gateError(`阶段「${def.title}」正在运行中，请先取消或等它结束再逐条重跑`, 409);
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
        const plan = generativePlan(run, def, item, frames, shots);
        if (!plan.ready) throw gateError(`条目「${item.id}」的前置产物还没就绪，不能重跑`);
        plan.template = chosen || plan.template;
        if (params && typeof params === "object") plan.params = { ...plan.params, ...params };
        return { run, def, stage, item, plan };
    }

    /**
     * 逐条重跑（regenerate）异步部分：把本次 attempt 入队并追加候选，新候选成为 selected。
     * 入队非阻塞（真实执行在任务队列后台），job 终态由 projectJob 幂等回写。
     */
    function executeRegenerate(begun) {
        const { run, def, stage, item, plan } = begun;
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

    /** Job 终态投影：按 meta 反查 run/stage/item，幂等回写候选与派生字段，并让前置刚就绪的下游条目入队。 */
    function projectJob(job) {
        if (!job || !TERMINAL_JOB.has(job.status)) return null;
        const { runId, stageId, itemId } = job.meta || {};
        if (!runId || !stageId || !itemId) return null;
        const run = get(runId);
        const def = stageDefs.get(String(stageId));
        const stage = run?.stages?.[stageId];
        const items = stage?.output?.frames || stage?.output?.clips;
        const item = Array.isArray(items) ? items.find((entry) => entry.id === itemId) : null;
        if (!def || !item) return null;
        upsertCandidate(item, job);
        syncItem(item);
        const shots = run.stages?.storyboard?.output?.shots || [];
        if (def.id === "keyframe") enqueueReady(run, def, stage, items, items, shots);
        else if (def.id === "assembly") enqueueReady(run, def, stage, items, run.stages?.keyframe?.output?.frames || [], shots);
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
        return { run, def, stage, provider };
    }

    /** 异步部分：真正跑 LLM 与入队，并把终态与进度落盘。 */
    async function executeStage(begun, runOptions = {}) {
        const { run, def, stage, provider } = begun;
        const estSecondsPerChunk = Number(pipelineConfig.estSecondsPerChunk) > 0 ? Number(pipelineConfig.estSecondsPerChunk) : 31;
        try {
            // 生成型阶段重排前的产物，用于继承旧候选（重跑只追加候选，不清空旧 jobId/artifactUrl）。
            const prevOutput = GENERATIVE_STAGES.has(def.id) ? stage.output : null;
            // 五个阶段都先由 LLM 按「输出契约」产出 JSON；生成型阶段再回填生成参数并入队。
            await composeWithLlm(run, def, stage, provider, { signal: runOptions.signal, resume: Boolean(runOptions.resume), estSecondsPerChunk });
            if (GENERATIVE_STAGES.has(def.id)) {
                attachGeneration(run, def, stage, prevOutput);
                // 不再「入队即 done」：有任务就等任务终态（回写投影会重算），没有可跑任务（未接 runJob）才算完成。
                const enqueued = (stage.output.frames || stage.output.clips || []).some((item) => (item.candidates || []).length);
                if (!enqueued) {
                    stage.status = "done";
                    stage.finishedAt = nowIso();
                }
            } else {
                stage.status = "done";
                stage.finishedAt = nowIso();
            }
            // 剧本阶段产出即回填 01 的设定建议，并把剧本事实（script + episodes/scenes）投影进 Project（都幂等；未绑项目时为空操作）。
            if (def.id === "script") {
                backfillPlanSuggestion(run, stage.output);
                projectScriptFacts(run, stage.output);
                projectEpisodeFacts(run, stage.output);
            }
            // 服化道阶段产出即把角色/场景登记为项目 AssetRef（幂等；未接线时为旧行为），供 design 门禁判 done。
            if (def.id === "design") registerDesignAssets(run, stage);
            if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
            // 成功也保留一条进度：只有真正 done 才写 phase:"done"，生成型阶段等 Job 终态时写 running，
            // 否则前端会误判「跑完了」而停止轮询一个还在生成的任务。
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: stage.status === "done" ? "done" : "running", finishedAt: stage.finishedAt });
        } catch (error) {
            stage.status = "error";
            stage.error = error.raw ? `${error.message}：${String(error.raw).slice(0, 4000)}` : error.message;
            stage.finishedAt = nowIso();
            // 失败/取消时保留进度：前端才能显示「跑到第几块停的」，用户也才知道 resume 能省下多少
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: "failed", error: stage.error });
        }
        return saveRun(run);
    }

    /** 同步等整段跑完（测试与内部调用用）；HTTP 路由走 beginStage + executeStage 以便立刻返回 202。 */
    async function runStage(runId, stageId, runOptions = {}) {
        return executeStage(beginStage(runId, stageId, runOptions), runOptions);
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
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: "assembling", label: `正在把 ${clips.length} 个片段合成成片` });
        try {
            const result = await assemble({
                config,
                episodeId: run.id,
                clips,
                order: assembly.order,
                transition: assembly.transition,
                options: {
                    id,
                    quality: options.quality,
                    transitionDurationSec: options.transitionDurationSec,
                    audio: options.audio,
                    subtitles: options.subtitles,
                    cover: options.cover,
                },
                now: nowIso(),
            });
            assembly.status = "done";
            assembly.deliverableId = result.id;
            assembly.url = result.url;
            assembly.manifestUrl = result.manifestUrl;
            assembly.logUrl = result.logPath ? artifactUrl(config, result.id, "ffmpeg.log") : null;
            assembly.coverUrl = result.coverUrl || null;
            assembly.bytes = result.bytes;
            assembly.info = result.info || null;
            assembly.finishedAt = nowIso();
            assembly.error = undefined;
        } catch (error) {
            assembly.status = "error";
            assembly.error = `合成成片失败：${error.message}`;
            assembly.finishedAt = nowIso();
            // 保留 delivery 落盘的清单与日志（都在同一个交付目录下），失败也要能复现
            const dir = safeJoin(config.dataDir, "artifacts", id);
            assembly.manifestUrl = dir && existsSync(safeJoin(dir, "assembly-manifest.json")) ? artifactUrl(config, id, "assembly-manifest.json") : null;
            assembly.logUrl = dir && existsSync(safeJoin(dir, "ffmpeg.log")) ? artifactUrl(config, id, "ffmpeg.log") : null;
        }
        recomputeStage(stage, run);
        if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
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
            if (touched) {
                saveRun(run);
                fixed.push(run.id);
            }
        }
        return fixed;
    }

    return { stages, list, get, create, estimate: estimateFor, runStage, beginStage, executeStage, stageProgress, reconcileRunning, setStageInput, projectJob, bindJobs, cancelStage, beginAssemble, executeAssemble, assembleStage, beginRegenerate, executeRegenerate, stageGate, stageGates, patchStageShot };
}

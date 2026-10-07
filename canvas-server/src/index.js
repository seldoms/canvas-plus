import { createServer } from "node:http";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

import { loadConfig, serverRoot } from "./config.js";
import { RESOURCE_CLASS } from "./contracts.js";
import { createRegistry } from "./registry.js";
import { artifactUrl, ensureDir, safeJoin, saveBuffer, sanitizeName, extensionFor, fileSize } from "./files.js";
import { createRouter, readJson, readBody, sendError, sendJson, serveFile, applyCors } from "./http.js";
import { createJobQueue, waitForJob } from "./jobs.js";
import { createPipeline } from "./pipeline.js";
import { createProjects } from "./projects.js";
// 自动粗剪 + 素材包导出（成片/原片/SRT/FCPXML/EDL/清单/说明 + zip）：
// 此前只有 CLI 入口，Agent 与前端都拿不到；这里挂薄路由，业务全在 edit-export.js。
import { exportDeliveryPackage } from "./edit-export.js";
import { createBibleStore } from "./bible.js";
import { deriveGates } from "./gates.js";
import { loadRegistry } from "./skills.js";
import { createComfyClient, probeComfy, listComfyCapabilities, listTemplates, extractTokens } from "./providers/comfy.js";
// 时长档位（D1）与模板清单同源；/api/durations 供前端按「当前视频模型」取可选档位。
import { durationMetaForTemplate } from "./durations.js";
// 生成参数能力校验 + 自适应（像素上限 / 宽高在档 / 时长帧数）：发起请求那一刻按模型元数据
// 把超限尺寸/时长**自动吸附到合法档**（不报错拒绝），调整结果写进该次任务留痕（meta.sizeAdjust/durationAdjust）。
import { adaptGenerationParams } from "./capability-limits.js";
// 该次任务**实际输入图**的真实像素宽高（从资产/产物读，不信前端传的尺寸）：尺寸自适应以图比例为基准。
import { resolveInputImageSize } from "./input-image.js";
// 平台音色库（声音从平台音色库中选）的唯一事实源：/api/tts/voices 与 /api/providers 同源下发。
import { QWEN3_TTS_TEMPLATE, isLanguageAllowed, isSpeakerAllowed, listVoices, qwen3Language, qwen3Speaker } from "./voices.js";
import { forwardToLlm, chat as llmChat, externalProviders } from "./providers/llm.js";
// 提示词策略层的语言适配出口（DeepSeek）：流水线入队前用它把「仅英文有官方依据」的模型提示词英文化。
import { llmCall as promptLlmCall } from "./llm-client.js";
import { createPromptApi } from "./prompt-api.js";
import { compileWorkbenchPrompt, createImageEnqueue, filterJobs } from "./workbench-jobs.js";
import { createGenerationIntent, submitGenerationIntent } from "./generation-intent.js";
import { createContinuation, createComfyPreflight } from "./continuation.js";
// M2 画布接入事实链：槽位候选业务（追加/采用/终态自动投影）与外部文件导入登记。
import { createSlotCandidates } from "./slot-candidates.js";
import { createArtifactImport } from "./artifact-import.js";
import { sanitizePrompt } from "./prompt-sanitize.js";
import { createLocalRunner } from "./generate.js";
import { probeRunningHub, listRunningHubModels, runRunningHubJob } from "./providers/runninghub.js";
import { createProbeCache } from "./probe-cache.js";
import { plan as impactPlan } from "./impact.js";
import { createModelRegistry } from "./model-registry.js";
import { checkAssetConsistency, summarizeConsistency } from "./asset-consistency.js";
// 产物归档 / 彻底删除内核（索引落 data/artifacts-index.json，从 jobs.outputs[] 懒构建）。
import { createArtifacts } from "./artifacts.js";
// 产物**真缩略图**：列表/卡片用的小图（按需 ffmpeg 生成 + 落盘缓存），复用平台已有的外部 ffmpeg，不引新依赖。
import { createThumbnails, isFresh, isThumbnailable, normalizeThumbWidth } from "./thumbnails.js";
import { scanTemplateDir } from "./tool-adapter.js";

// 启动耗时探针：把「进程起来到监听端口」拆成各阶段计时，直接回答「这 100 秒花在哪」。
// 仅在被直接执行时打印，被 import（测试/冒烟）时静默，避免污染测试输出。
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
const startupT0 = process.hrtime.bigint();
function startupMark(label, extra = "") {
    if (!isMain) return;
    const ms = Number(process.hrtime.bigint() - startupT0) / 1e6;
    console.log(`[startup] ${label}: +${ms.toFixed(0)}ms${extra ? ` ${extra}` : ""}`);
}

const config = loadConfig();
startupMark("config 加载");

// 外部 LLM 渠道注册表：独立存 data/llm-providers.json，启动时并入 config.llm.providers，支持热更新。
const llmProvidersFile = safeJoin(config.dataDir, "llm-providers.json");

/**
 * 注册表里存的是明文 API Key，收紧成仅属主可读写。
 * writeFileSync 的 mode 只在「新建文件」时生效，已存在的文件会保留原权限，所以每次都补一次 chmod；
 * 启动时也调一次，把此前用默认 0644 写出的文件纠正过来。
 */
function lockProvidersFile() {
    try {
        chmodSync(llmProvidersFile, 0o600);
    } catch {
        // 文件还不存在（首次启动）或文件系统不支持 chmod，都不该阻断启动。
    }
}

function readLlmProviders() {
    try {
        const raw = JSON.parse(readFileSync(llmProvidersFile, "utf8"));
        return Array.isArray(raw?.providers) ? raw.providers : [];
    } catch {
        return [];
    }
}
config.llm.providers = readLlmProviders();
lockProvidersFile();

const comfy = createComfyClient(config);
const llm = {
    // 流水线不一定指定模型，这里兜底到 pipeline.llmModel / llm.defaultModel，避免把空 model 发给上游。
    chat: (options = {}) => llmChat(config, { ...options, model: options.model || config.pipeline.llmModel || config.llm.defaultModel }),
};
const uploads = ensureDir(safeJoin(config.dataDir, "uploads"));

// Project 服务端内核：data/projects/<id>/ 落盘，路由见下方 /api/projects 系列。
const projects = createProjects({ dataDir: config.dataDir, stages: loadRegistry(config.skillsDir).stages || [] });

// P0-f 制作圣经与确认锁：实体落 data/projects/<id>/bibles/（独立于 projects.js 内核，仅复用其 ULID）。
const bibles = createBibleStore({ dataDir: config.dataDir, ulid: projects.ulid });

// Device/Provider/Tool Registry（D6 按资源调度）：把现有真实资源登记进来，
// 供提交前能力校验、设备归属与按类别分队列使用。注册表不探活，健康状态由本层按需写回。
const registry = createRegistry();
const gpuDeviceId = "comfy-local-gpu";

// 本地 ComfyUI：一张 16GB 卡同时承担生图与生视频，共用一条本地 GPU 队列（并发取自 config，默认 1）。
registry.registerDevice({
    id: gpuDeviceId,
    label: config.comfy.deviceLabel || "本地 ComfyUI",
    resourceClasses: [RESOURCE_CLASS.GPU_IMAGE, RESOURCE_CLASS.GPU_VIDEO],
    maxConcurrency: Number(config.comfy.maxConcurrency) > 0 ? Number(config.comfy.maxConcurrency) : 1,
});
registry.registerProvider({
    id: "comfy-local",
    kind: "comfy",
    label: "本地 ComfyUI",
    resourceClasses: [RESOURCE_CLASS.GPU_IMAGE, RESOURCE_CLASS.GPU_VIDEO],
    baseUrl: config.comfy.baseUrl,
    deviceId: gpuDeviceId,
});
// 本地 LLM 与 RunningHub 云端不绑本地设备（LLM / API 类）。
registry.registerProvider({ id: "llm-local", kind: "llm", label: "本地 LLM", resourceClasses: [RESOURCE_CLASS.LLM], baseUrl: config.llm.baseUrl });
registry.registerProvider({ id: "runninghub", kind: "api", label: "RunningHub 云端", resourceClasses: [RESOURCE_CLASS.API], baseUrl: config.runninghub.baseUrl });

// ComfyUI 模板登记为 Tool：按族推断能力与资源类别（video_* → GPU_VIDEO，其余 → GPU_IMAGE）。
for (const template of listTemplates(config.workflowsDir)) {
    const video = template.family === "video";
    registry.registerTool({
        id: template.name,
        capability: video ? "video.generate" : "image.generate",
        paramsSchema: {},
        resourceClass: video ? RESOURCE_CLASS.GPU_VIDEO : RESOURCE_CLASS.GPU_IMAGE,
        providers: ["comfy-local"],
        cancelable: true,
        retryable: true,
    });
}
// RunningHub 云端模型同样登记为 API Tool，提交时按 endpoint 校验能力与可用性。
const runninghubModels = listRunningHubModels(config);
for (const model of [...runninghubModels.image, ...runninghubModels.video]) {
    registry.registerTool({
        id: model.id,
        capability: model.outputType === "video" ? "video.generate" : "image.generate",
        paramsSchema: {},
        resourceClass: RESOURCE_CLASS.API,
        providers: ["runninghub"],
        cancelable: true,
        retryable: true,
    });
}
startupMark("registry 登记");

const jobs = createJobQueue({
    dataDir: config.dataDir,
    concurrency: 1,
    label: "canvas-server",
    // Job 落哪台设备由注册表决定（D6）；API / LLM 无本地设备时返回 null。
    resolveDevice: (resourceClass) => registry.listDevices({ resourceClass })[0]?.id || null,
});
const local = createLocalRunner({ config, comfy, jobs });
startupMark("jobs 队列加载");

// M2：槽位候选（画布/导入产物 → generationSlots）与外部文件导入登记。
// 纯业务编排，存储走 projects.episodes / jobs.recordImport。
const slotCandidates = createSlotCandidates({ jobs, episodes: projects.episodes });
const artifactImport = createArtifactImport({ jobs, getProject: (id) => projects.get(id) });

/**
 * M3.5：H3 多段续接编排器（纯业务，见 continuation.js）。
 * 段提交走 M1 链（能力校验+编译+入队+幂等键全在 submitGenerationIntent 内）；
 * preflight 用 147 /free + ram_free 读数（POC 配方），ffmpeg 接缝 QC 与抽尾帧是 CPU 活，直接 spawn 不进 GPU 队列。
 * compileIntentPrompt / runJob 是函数声明（提升），此处引用安全。
 */
const continuation = createContinuation({
    config,
    episodes: projects.episodes,
    jobs,
    submitIntent: (intent) => submitGenerationIntent(intent, { jobs, runner: runJob, getProject: (id) => projects.get(id), registry, promptCompiler: compileIntentPrompt }),
    preflight: createComfyPreflight({ comfy }),
});
/** 后端分派：默认走本地 ComfyUI；只有显式指定 runninghub 且配置允许时才走云端。 */
function backendOf(job) {
    return job.backend === "runninghub" ? "runninghub" : "local";
}

async function runJob(job, ctx) {
    if (backendOf(job) === "runninghub") {
        if (!config.generation.allowRunningHub) throw new Error("RunningHub 后端已被配置禁用");
        return runRunningHubJob(job, ctx, config);
    }
    return local.runJob(job, ctx);
}

// 生图工作台入队入口：复用同一条本地 GPU 队列与同一执行体（不另起并行），入队前由后端编译提示词。
const imageEnqueue = createImageEnqueue({ config, jobs, runJob, registry, llmCall: promptLlmCall, getProject: (id) => projects.get(id) });

const pipeline = createPipeline({
    config,
    skillsDir: config.skillsDir,
    jobs,
    comfy,
    llm,
    llmCall: promptLlmCall,
    runJob,
    // 项目化模式：run.options.projectId → Project 读取器，供 plan 驱动生成参数与单镜失败自动重试。
    getProject: (projectId) => projects.get(projectId),
    // 剧本阶段完成后把 01 的 planSuggestion 回填到项目 plan（只填未填写字段、幂等）。
    applyPlanSuggestion: (projectId, suggestion) => projects.applyPlanSuggestion(projectId, suggestion),
    // 剧本阶段完成后把 logline/synopsis/characters/scenes/episodes 投影进 Project.script（幂等、不改 version）。
    applyScriptProjection: (projectId, output) => projects.applyScriptProjection(projectId, output),
    // 剧本阶段完成后把 episodes[]/scenes[] 投影进 Project.episodes（幂等、不改 version），供 storyboard 门禁判 done。
    applyEpisodeProjection: (projectId, output) => projects.applyEpisodeProjection(projectId, output),
    // 建 run 时按 options.projectId 幂等把 runId 追加进项目 runIds（覆盖「从流水线页建的 run」）。
    attachProjectRun: (projectId, runId) => projects.attachRun(projectId, runId),
    // 生成型阶段（关键帧/片段合成）产物自动登记为项目 AssetRef：幂等、解耦、失败不拖垮阶段。
    registerAssetRef: (projectId, input) => projects.assets.create(projectId, input),
    // 就地更新已存在的资产引用（参考图绑定走这条路：空引用自愈为已绑定，不产生重复引用）。
    updateAssetRef: (projectId, refId, patch) => projects.assets.update(projectId, refId, patch),
    // M2-D6：画布来源 Job 终态自动投影为槽位候选（只追加候选、不动 selected）。
    projectCanvasJob: (job) => slotCandidates.projectCanvasTerminalJob(job),
});
startupMark("pipeline 创建");
/**
 * Job 终态投影接线：订阅 change 事件（廉价，模块加载即挂上；测试与生产都需要）。
 *
 * ⚠️ #68：历史重放（把 jobs.json 里全部终态 Job 重放一遍）**不再走启动关键路径**。
 * 之前这里直接 `pipeline.bindJobs()`，它同步重放全部 535 个 Job；其中 350 个命中同一个巨型 run.json，
 * 逐条 readFileSync+writeFileSync = 实测 104 秒纯 CPU，把「进程起来 → listen」拖到 100 秒开外
 * （端口还没 LISTEN，前端/运维极易误判成服务崩了）。重放已改为 listen 之后的后台分批任务，见 replayHistoricalJobs()。
 */
function wireJobProjection() {
    if (typeof jobs?.on !== "function") return;
    jobs.on("change", (job) => {
        try {
            pipeline.projectJob(job);
        } catch (error) {
            console.error(`[pipeline] 任务回写失败 ${job?.id}：${error.message}`);
        }
        // M3.5：续接段编排的终态消费点，与 M2 自动投影同处（同一 change 事件流，互不回归）。
        // 注意：历史重放（replayHistoricalJobs）刻意**不**喂给编排器——批量回放会重复触发接续；
        // 重启恢复走 listen 后的 scanStalledChains（幂等键保证不重复入队）。
        try {
            continuation.handleTerminalJob(job);
        } catch (error) {
            console.error(`[continuation] 终态处理失败 ${job?.id}：${error.message}`);
        }
    });
}
wireJobProjection();
startupMark("pipeline 订阅");

/**
 * 历史任务重放：从 jobs.json 的终态 Job 重建流水线投影（= 旧 bindJobs 的「重放」那一步）。
 * 在 listen 之后执行，且每条之间让出事件循环（setImmediate）→ 重放期间 /api/health、/api/jobs 仍随时应答。
 * 幂等：projectJob 只做投影回写，重复执行结果不变（与旧 bindJobs 的重放语义一致）。
 */
async function replayHistoricalJobs() {
    const all = jobs.list?.() || [];
    if (!all.length) return;
    let done = 0;
    let failed = 0;
    for (const job of all) {
        try {
            pipeline.projectJob(job);
        } catch (error) {
            failed += 1;
            console.error(`[pipeline] 历史任务重放失败 ${job?.id}：${error.message}`);
        }
        done += 1;
        // 让出事件循环：单条 projectJob 可能读/写数 MB 的 run.json（~0.3s），
        // 每条之间让一次可把最长停顿压到「单条」量级，避免把存活接口卡住。
        await new Promise((resolve) => setImmediate(resolve));
    }
    startupMark("历史任务重放完成", `${done}/${all.length}${failed ? `，失败 ${failed}` : ""}`);
}

// 模型注册表（契约 v1）：服务端唯一持有的模型清单，落 data/model-registry.json。
const modelRegistry = createModelRegistry({ dataDir: config.dataDir });

/** 汇总「服务端实际可用」的模型源：本地 ComfyUI 模板 + 外部 LLM 渠道（含渠道**声明**的模型 id）。sync / available 共用。 */
function modelRegistrySources() {
    return {
        templates: listTemplates(config.workflowsDir),
        catalog: scanTemplateDir(config.workflowsDir),
        llmProviders: externalProviders(config).map(({ name, baseUrl, models }) => ({ name, baseUrl, models })),
    };
}

// 启动即同步一次：注册表是模型清单的唯一读源（`/v1/models`、`/api/providers`、`/api/health` 都读它），
// 若只在用户点「同步」时才补齐，静态清单会一直是空的。sync 幂等、只读本地模板目录与渠道表，不发任何网络请求。
modelRegistry.sync(modelRegistrySources());
startupMark("model-registry.sync");

/**
 * 产物归档 / 彻底删除内核（素材生命周期）。
 * 索引从 jobs.outputs[] 懒构建；引用反查用「流水线 run 的候选」+「项目 AssetRef」两条来源，
 * 查不到就空数组（宁空不误拦，避免把可删的素材误判为被引用）。
 */
const artifacts = createArtifacts({
    dataDir: config.dataDir,
    listJobs: () => jobs.list({}),
    listRuns: () => pipeline.list(),
    // 活动 + 归档项目都算（归档项目的引用仍应阻断删除，避免删掉后引用悬空）。
    listAssetRefs: () => {
        const rows = [];
        for (const summary of projects.list({ includeArchived: true })) {
            const project = projects.get(summary.id);
            if (!project) continue;
            for (const ref of Array.isArray(project.assetRefs) ? project.assetRefs : []) {
                rows.push({ ...ref, projectId: project.id, projectName: project.title });
            }
        }
        return rows;
    },
    resolveProjectName: (projectId) => projects.get(projectId)?.title || null,
});
startupMark("artifacts 内核");

// 缩略图内核：列表/卡片用的小图。落 data/thumbnails/<jobId>/<原名>.<宽>.webp，
// 按需生成 + 落盘缓存（源文件更新才重跑）；同时最多 3 个 ffmpeg，防止一页上百张打满机器。
const thumbnails = createThumbnails({ dataDir: config.dataDir });
startupMark("thumbnails 内核");

/**
 * 解析该次提交的**实际输入图**真实宽高（只对**视频模板**做：图生/参考生视频才会被 first_frame 拉伸）。
 * 从模板 JSON 扫出实际声明的 token（不硬编码模板名），再按主驱动图优先从资产/产物读真实像素。
 * 任何异常 / 读不到 / 未知格式 → null（回落「按提交尺寸自适应」），**绝不阻塞提交、绝不臆造尺寸**。
 */
async function resolveInputImageForSubmit(template, params) {
    if (!/^video[_-]/i.test(template)) return null;
    const templatePath = safeJoin(config.workflowsDir, `${template}.json`);
    if (!templatePath || !existsSync(templatePath)) return null;
    try {
        const tokens = extractTokens(templatePath);
        return await resolveInputImageSize(params, tokens, { dataDir: config.dataDir });
    } catch (error) {
        console.warn(`[submit] 解析输入图尺寸失败（回落按提交尺寸自适应）：${template} — ${error.message}`);
        return null;
    }
}

/**
 * submit 路径的提示词编译出口（决策 C 折中：调用方已编译则 PROMPT 直接进 params，不经过这里）。
 * 原始提示词由调用方放进 intent.facts.prompt；编译失败的降级与 warning 语义沿用 compileWorkbenchPrompt。
 */
async function compileIntentPrompt(intent) {
    const raw = typeof intent.facts?.prompt === "string" ? intent.facts.prompt : "";
    if (!raw) return { prompt: null, warnings: [] };
    const slotImages = [];
    if (intent.params.INPUT_IMAGE) slotImages.push({ url: String(intent.params.INPUT_IMAGE), kind: "input_image" });
    for (let i = 1; i <= 9; i += 1) {
        const url = intent.params[`REF_IMAGE_${i}`];
        if (url) slotImages.push({ url: String(url), kind: "reference" });
    }
    const warnings = [];
    const compiled = await compileWorkbenchPrompt({
        template: intent.template,
        prompt: raw,
        slotImages,
        llmCall: promptLlmCall,
        onWarning: (reason) => warnings.push(String(reason)),
    });
    warnings.push(...(compiled.warnings || []));
    return { prompt: compiled.prompt || raw, warnings };
}

/** 入队入口：默认本地 ComfyUI，显式传 backend:"runninghub" 时才走云端。提交前按资源类别做 canRun 校验。 */
async function submitGeneration(kind, body) {
    const backend = String(body.backend || config.generation.defaultBackend || "local").trim();
    if (backend === "local") {
        const template = String(body.template || "").trim();
        if (!template) throw new Error("缺少 template");
        // 能力不匹配 / 设备不可用时直接拒绝并给出可读原因，绝不静默改走别的设备。
        const verdict = registry.canRun(template);
        if (!verdict.ok) throw new Error(`无法提交${kind === "video" ? "生视频" : "生图"}任务：${verdict.reason}`);
        // 取该次**实际输入图**的真实像素（从资产/产物读；别信前端传的尺寸）——
        // 尺寸自适应**以图的比例为基准**：图比例 ≠ 提交比例时以图为准（否则 first_frame 必被拉伸）。
        const inputImage = await resolveInputImageForSubmit(template, body.params || {});
        // 发起生成那一刻按所选模型的能力元数据**自适应**像素上限 / 宽高 / 时长帧数：
        // 超限不再报错拒绝，而是把尺寸吸附到「同比例、上限内像素最大」的合法档、时长吸附到 17k+5 网格；
        // 有输入图时基准是**图的比例**（basis:"input-image"），无输入图时才是 params.WIDTH/HEIGHT（basis:"requested"）。
        // 调整结果写进该次任务留痕（meta.sizeAdjust / meta.durationAdjust），绝不静默偷改。
        // 连自适应都找不到合法档时（模板无规格 / 上限缺失）→ 回落既有可读拒绝，不静默放过。
        const adapted = adaptGenerationParams(template, body.params || {}, inputImage ? { image: inputImage } : {});
        if (!adapted.ok) throw new Error(`无法提交${kind === "video" ? "生视频" : "生图"}任务：${adapted.error}`);
        const meta = { ...(body.meta && typeof body.meta === "object" ? body.meta : {}) };
        if (adapted.sizeAdjust) meta.sizeAdjust = adapted.sizeAdjust;
        if (adapted.durationAdjust) meta.durationAdjust = adapted.durationAdjust;
        const params = { ...adapted.params };
        if (typeof params.PROMPT === "string") params.PROMPT = sanitizePrompt(params.PROMPT);
        // 画布/API 直连路径此前**完全不做提示词编译**（只有生图工作台 /api/images/enqueue 与影视流水线做），
        // 于是「按所选模型重写 + 英文化 + negativeClause 的『不要 X 改写进正向』」全部缺失：
        // 实测「不要出现任何文字、字幕、logo」原样进了正向提示词，模型反而在招牌上画出一堆伪字。
        // 这里补齐**同一条编译链**（prompt-compiler.js 的逐模型编译器：qwen-image-2.1 / krea2 / flux，generic 兜底），
        // 编译统一走 submit 路径：原始提示词进 facts.PROMPT 由 deps.promptCompiler 编译，已编译调用方不经过这里。
        const facts = {};
        if (kind === "image" && params.PROMPT) {
            facts.prompt = params.PROMPT;
            delete params.PROMPT;
        }
        const intent = createGenerationIntent({
            source: body.source,
            kind,
            context: {
                projectId: body.projectId ?? meta.projectId,
                episodeId: meta.episodeId,
                sceneId: meta.sceneId,
                shotId: meta.shotId,
                slotId: meta.slotId,
                runId: meta.runId,
                stageId: meta.stageId,
            },
            toolId: template,
            template,
            facts,
            params,
            options: { name: body.name, idempotencyKey: meta.idempotencyKey, meta },
        });
        return submitGenerationIntent(intent, { jobs, runner: runJob, getProject: (id) => projects.get(id), promptCompiler: compileIntentPrompt });
    }

    if (backend !== "runninghub") throw new Error(`未知生成后端：${backend}`);
    if (!config.generation.allowRunningHub) throw new Error("RunningHub 后端已被配置禁用");
    const endpoint = String(body.params?.endpoint || body.endpoint || "").trim();
    if (!endpoint) throw new Error("RunningHub 任务缺少 params.endpoint");
    const verdict = registry.canRun(endpoint);
    if (!verdict.ok) throw new Error(`无法提交云端任务：${verdict.reason}`);
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return jobs.enqueue(
        { id, kind, backend, template: endpoint, name: body.name || endpoint, params: { ...(body.params || {}) }, meta: body.meta },
        runJob,
    );
}

/** 前端与运维用的后端清单：本地永远可用，RunningHub 取决于是否配置了 Key。 */
function backends() {
    const runninghub = { id: "runninghub", label: "RunningHub 云端", available: false, reason: "未配置 API Key" };
    if (!config.generation.allowRunningHub) runninghub.reason = "配置已禁用";
    else if (config.runninghub.apiKey) {
        runninghub.available = true;
        delete runninghub.reason;
    }
    return [
        { id: "local", label: "本地 ComfyUI", available: true, baseUrl: config.comfy.baseUrl, default: config.generation.defaultBackend === "local" },
        { ...runninghub, baseUrl: config.runninghub.baseUrl, default: config.generation.defaultBackend === "runninghub" },
    ];
}

const router = createRouter();

const serviceInfo = {
    name: "canvas-server",
    description: "无限画布本地网关：内网 LLM 与 ComfyUI 生图/生视频统一出口",
    version: "0.1.0",
    endpoints: ["/api/health", "/api/backends", "/api/providers", "/api/jobs", "/api/images/enqueue", "/api/runninghub/models", "/api/pipeline/runs", "/api/projects", "/api/model-registry", "/api/prompt/compile", "/v1/models", "/v1/chat/completions"],
};

router.get("/api", (req, res) => sendJson(res, 200, serviceInfo));

// 构建了前端就把它当作页面入口，否则退化成服务信息，方便直接 curl 探测。
router.get("/", (req, res) => {
    const index = webDist && safeJoin(webDist, "index.html");
    if (index && existsSync(index)) return serveFile(req, res, index);
    sendJson(res, 200, serviceInfo);
});

// 外部依赖探测缓存（#68）：ComfyUI / RunningHub 在后台并发探测、短超时（3s）、TTL 缓存（30s）。
// /api/health 只读快照 → 立即可答；就绪后自动反映。上游挂死最多按短超时降级，绝不拖住存活接口。
const HEALTH_PROBE_TIMEOUT_MS = 3000;
const HEALTH_PROBE_TTL_MS = 30000;
const healthProbe = createProbeCache({ ttlMs: HEALTH_PROBE_TTL_MS, timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
healthProbe.define("comfy", {
    baseUrl: config.comfy.baseUrl,
    probe: () => probeComfy({ ...config, comfy: { ...config.comfy, timeoutMs: HEALTH_PROBE_TIMEOUT_MS } }),
    // 未就绪快照必须保留 devices 字段（前端依赖 comfy.devices），给空数组 + pending:true 明确状态。
    pending: () => ({ ok: false, baseUrl: config.comfy.baseUrl, devices: [], error: "探测中", pending: true }),
});
healthProbe.define("runninghub", {
    baseUrl: config.runninghub.baseUrl,
    probe: () => probeRunningHub({ ...config, runninghub: { ...config.runninghub, timeoutMs: HEALTH_PROBE_TIMEOUT_MS } }),
    pending: () => ({ ok: false, baseUrl: config.runninghub.baseUrl, error: "探测中", pending: true }),
});

/**
 * 存活 + 依赖状态。三类信息严格分开，不再用一个 `ok` 冒充「生产就绪」：
 *   - `ok` / `service`：**本进程能应答**（存活语义），不等任何上游网络请求；
 *   - `llm`：静态注册表事实（`probed:false`）—— 清单只读注册表，网关不探测上游，`ok` 只表示「已登记启用的文本模型」；
 *   - `comfy` / `runninghub`：**后台探测的缓存快照**（#68）—— 首次未就绪给 `pending:true`，就绪后按 TTL 复用/后台刷新，
 *     字段形状（`ok`/`baseUrl`/`devices`/`error`）与真实探测结果一致，前端无需改动。
 * 由此死渠道、上游慢、Comfy 挂掉都不会再把存活接口拖住（旧实现每次都要同步 await 上游，且 comfy 探测会吃到任务级 2h 超时）。
 */
router.get("/api/health", (req, res) => {
    const llmModels = modelRegistry.textModels();
    const llmResult = {
        ok: llmModels.length > 0,
        baseUrl: config.llm.baseUrl,
        source: "registry",
        probed: false,
        models: llmModels,
        ...(llmModels.length ? {} : { error: "注册表里没有已启用的文本模型：请在渠道表声明 models 后同步模型注册表" }),
    };
    sendJson(res, 200, {
        ok: true,
        service: { ok: true, name: serviceInfo.name, version: serviceInfo.version, uptimeSec: Math.round(process.uptime()) },
        llm: llmResult,
        comfy: healthProbe.get("comfy"),
        runninghub: healthProbe.get("runninghub"),
        queue: jobs.counts(),
    });
});

/** 生图/生视频后端清单。本地是默认且必须可用的那条链路。 */
router.get("/api/backends", (req, res) => {
    sendJson(res, 200, { backends: backends(), defaultBackend: config.generation.defaultBackend, allowRunningHub: config.generation.allowRunningHub });
});

/** RunningHub 可选模型目录（本地内置，不请求上游，避免未配置 Key 时也打网络）。 */
router.get("/api/runninghub/models", (req, res) => {
    sendJson(res, 200, listRunningHubModels(config));
});

router.get("/api/providers", async (req, res) => {
    const capabilities = await listComfyCapabilities(config).catch((error) => ({ templates: listTemplates(config.workflowsDir), models: {}, error: error.message }));
    sendJson(res, 200, { llm: { baseUrl: config.llm.baseUrl, models: modelRegistry.textModels() }, comfy: capabilities, backends: backends() });
});

// ——— 模型注册表（契约 v1：docs/content/docs/progress/model-registry-contract.md） ———
// 注意：/sync、/available 必须注册在 /:id 之前，否则会被 `:id` 当成 id 吃掉。
router.get("/api/model-registry", (req, res, { url }) => {
    sendJson(
        res,
        200,
        modelRegistry.list({ category: url?.searchParams?.get("category") || "", enabled: url?.searchParams?.get("enabled") }),
    );
});

router.post("/api/model-registry", async (req, res) => {
    try {
        sendJson(res, 201, { model: modelRegistry.create(await readJson(req)) });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

router.post("/api/model-registry/sync", (req, res) => {
    try {
        sendJson(res, 200, modelRegistry.sync(modelRegistrySources()));
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

router.get("/api/model-registry/available", (req, res) => {
    try {
        sendJson(res, 200, modelRegistry.available(modelRegistrySources()));
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

// createRouter 只支持 get/post/any —— PATCH / DELETE 用 any 承接，其它方法 405。
router.any("/api/model-registry/:id", async (req, res, { params }) => {
    try {
        if (req.method === "PATCH") {
            sendJson(res, 200, { model: modelRegistry.update(params.id, await readJson(req)) });
            return;
        }
        if (req.method === "DELETE") {
            sendJson(res, 200, modelRegistry.remove(params.id));
            return;
        }
        sendError(res, 405, `不支持的方法：${req.method}`);
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

/**
 * 时长档位（D1「时长锚点跟着模型走」）：选定视频模板 → 可选时长集合 + 帧数映射（与模板清单同源）。
 * ?template=<name> 显式指定；缺省用 config.pipeline.videoTemplate。durations:null = 该模型档位待查证。
 */
router.get("/api/durations", (req, res, { url }) => {
    const template = String(url?.searchParams?.get("template") || config.pipeline?.videoTemplate || "").trim();
    sendJson(res, 200, { template, ...durationMetaForTemplate(template) });
});

/**
 * 平台音色库（声音从平台音色库中选）：命名音色 + 语种枚举的唯一读出口。
 * 数据源是 147 `TDQwen3TTSCustomVoice`（只读探测），前端据此渲染音色下拉，**绝不硬编码**。
 * 形状：`{ template, voices: string[], speakers: string[], languages: string[], defaultSpeaker, defaultLanguage, source }`。
 */
router.get("/api/tts/voices", (req, res, { url }) => {
    const template = String(url?.searchParams?.get("template") || config.pipeline?.audioTemplate || QWEN3_TTS_TEMPLATE).trim();
    const voices = listVoices();
    sendJson(res, 200, { ...voices, template: template || voices.template });
});

/** 试听默认样句（一句中文短句），调用方未给 text 时用它。 */
const TTS_PREVIEW_TEXT = "你好，这是角色音色试听。";

/**
 * 试听：按所选平台音色合成一句样句，产物落成 artifact（音频）并返回 `{ url, artifactId, speaker, ms }`。
 *
 * **复用**现有 147 ComfyUI 提交 / 轮询 / 产物登记链路（local.submit → jobs 队列 → runJob → collectOutputs），
 * 不新开 HTTP 客户端。音色 / 语种只接受平台音色库枚举（非法值 400）；147 忙或失败一律回**可读错误**，不 500 沉默。
 */
router.post("/api/tts/preview", async (req, res) => {
    let job = null;
    const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
    try {
        const body = await readJson(req).catch(() => ({}));
        const speaker = String(body?.speaker ?? "").trim();
        if (!isSpeakerAllowed(speaker)) throw badRequest(`不支持的音色「${speaker || "(空)"}」；可选：${listVoices().voices.join(" / ")}`);
        const languageRaw = String(body?.language ?? "").trim();
        if (languageRaw && !isLanguageAllowed(languageRaw)) throw badRequest(`不支持的语种「${languageRaw}」`);
        const language = languageRaw || qwen3Language(body?.language) || "Auto";
        const design = String(body?.design ?? "").trim();
        const speedRaw = body?.speed;
        if (speedRaw !== undefined && speedRaw !== null && speedRaw !== "") {
            const speed = Number(speedRaw);
            if (!Number.isFinite(speed) || speed <= 0) throw badRequest("speed 必须是正数");
        }
        const text = String(body?.text ?? "").trim() || TTS_PREVIEW_TEXT;
        const template = String(config.pipeline?.audioTemplate || QWEN3_TTS_TEMPLATE).trim();
        const verdict = registry.canRun(template);
        if (!verdict.ok) throw new Error(`无法提交试听任务：${verdict.reason}`);
        // 与 audio 阶段同口径的参数：音色描述进 INSTRUCT，命名音色进 SPEAKER，语种进 LANGUAGE。
        const params = {
            TEXT: text,
            SPEAKER: speaker,
            INSTRUCT: design,
            LANGUAGE: language,
            DEVICE: String(config.pipeline?.audioDevice || "cuda"),
            SEED: Math.floor(Math.random() * 2 ** 31),
            OUTPUT_PREFIX: `canvas/tts-preview-${speaker}`,
        };
        job = local.submit({ kind: "audio", template, name: `tts-preview-${speaker}`, params });
        const done = await waitForJob(jobs, job.id, { timeoutMs: Number(config.pipeline?.ttsPreviewTimeoutMs) > 0 ? Number(config.pipeline.ttsPreviewTimeoutMs) : 300000, intervalMs: 1500 });
        const output = Array.isArray(done.outputs) ? done.outputs.find((item) => item?.url) : null;
        if (!output?.url) throw new Error("合成完成但没有音频产物");
        sendJson(res, 200, { url: output.url, artifactId: output.url, jobId: done.id, speaker, language, text, ms: Number(done.runMs) || 0 });
    } catch (error) {
        // 147 忙 / 失败 / 超时：回可读错误（502），并尽力取消排队中的试听任务，不静默。
        if (job?.id) jobs.cancel(job.id);
        sendError(res, error.status || 502, `试听失败：${error.message}`);
    }
});

router.get("/api/skills", (req, res) => {
    let stages = [];
    try {
        stages = loadRegistry(config.skillsDir).stages || [];
    } catch (error) {
        console.warn(`[skills] 读取失败：${error.message}`);
    }
    sendJson(res, 200, { skills: stages });
});

// 文本模型清单：静态读注册表（不探测上游），与 /v1/models、/api/providers.llm.models 同源。
router.get("/api/llm/models", (req, res) => {
    sendJson(res, 200, { models: modelRegistry.textModels() });
});

// 外部 LLM 渠道注册表：GET 返回脱敏清单（不吐 SK）。`models` 是该渠道声明的模型 id（静态清单的来源）。
// 写路径按 name **增量 upsert**：不再整车替换，双方（服务端恢复的渠道 / 浏览器自带的渠道）不再互相冲掉对方。
const serializeProviders = () => externalProviders(config).map(({ name, baseUrl, apiKey, models }) => ({ name, baseUrl, hasKey: Boolean(apiKey), models }));

/** 落盘 + 热更新内存里的渠道表（服务端是注册表的唯一写者）。 */
function persistProviders(providers) {
    writeFileSync(llmProvidersFile, JSON.stringify({ providers }, null, 2), { mode: 0o600 });
    lockProvidersFile();
    config.llm.providers = providers;
}

router.get("/api/llm/providers", (req, res) => {
    sendJson(res, 200, { providers: serializeProviders() });
});

/**
 * 按 name upsert 合并（绝不整车替换）：
 * - 请求里出现的 name → 更新其 baseUrl；apiKey 为空/未提供则**保留原 key**（脱敏回传不会清空 key）；
 * - 不在请求里的渠道一律原样保留（绝不删除）；
 * - 返回合并后的完整（脱敏）列表。
 */
router.post("/api/llm/providers", async (req, res) => {
    try {
        const body = await readJson(req);
        const list = Array.isArray(body?.providers) ? body.providers : [];
        const existing = Array.isArray(config.llm.providers) ? config.llm.providers : [];
        // Map 保留既有渠道的插入顺序：老渠道在前，新渠道追加在后。
        const byName = new Map(existing.map((item) => [String(item?.name || "").trim(), { ...item }]));
        for (const item of list) {
            const name = String(item?.name || "").trim();
            if (!name) continue;
            if (name.includes("::")) throw new Error(`渠道名不能包含「::」：${name}`);
            const incomingBase = String(item?.baseUrl || "").trim().replace(/\/+$/, "");
            const prev = byName.get(name);
            if (incomingBase && !/^https?:\/\//i.test(incomingBase)) throw new Error(`渠道 ${name} 的 baseUrl 必须是 http(s) 地址`);
            if (!incomingBase && !prev) throw new Error(`渠道 ${name} 的 baseUrl 必须是 http(s) 地址`);
            const incomingKey = String(item?.apiKey || "").trim();
            // 已存 key 的渠道换地址时必须同时给新 key：否则旧 key 会在下次调用时被发到**新地址**，
            // 等于任何能调这个接口的人都能把服务端已存的密钥静默外带。
            const prevBase = String(prev?.baseUrl || "").trim().replace(/\/+$/, "");
            if (prev?.apiKey && incomingBase && incomingBase !== prevBase && !incomingKey) {
                throw new Error(`渠道 ${name} 更换地址时必须同时提供新的 API Key，防止已存密钥被转发到其它地址`);
            }
            const next = {
                ...(prev || {}),
                name,
                baseUrl: incomingBase || (prev?.baseUrl || ""),
                apiKey: incomingKey || (prev?.apiKey || ""),
            };
            // 声明的模型 id 是静态清单的唯一来源：给了就整体替换，没给则沿用原值（脱敏回传不会清空）。
            if (Array.isArray(item?.models)) next.models = item.models.map((model) => String(model ?? "").trim()).filter(Boolean);
            byName.set(name, next);
        }
        persistProviders([...byName.values()]);
        // 渠道表变了 → 注册表的 meta.baseUrl / meta.models 立刻跟上，静态清单不必等重启或手动点「同步」。
        modelRegistry.sync(modelRegistrySources());
        sendJson(res, 200, { providers: serializeProviders() });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

/**
 * 显式删除某个渠道：仅在明确要求时删除（POST 的 upsert 语义永远不会删渠道）。
 * createRouter 只支持 get/post/any，没有 delete 方法 —— 用 any 承接 DELETE，其它方法 405。
 */
router.any("/api/llm/providers/:name", (req, res, { params }) => {
    if (req.method !== "DELETE") return sendError(res, 405, `不支持的方法：${req.method}`);
    const name = String(params.name || "").trim();
    const existing = Array.isArray(config.llm.providers) ? config.llm.providers : [];
    const next = existing.filter((item) => String(item?.name || "").trim() !== name);
    if (next.length === existing.length) return sendError(res, 404, `渠道不存在：${name}`);
    persistProviders(next);
    modelRegistry.sync(modelRegistrySources());
    sendJson(res, 200, { providers: serializeProviders(), removed: name });
});

// 提示词编译入口：把「模型无关的内容事实」按所选模型标准编译成该模型要的提示词（图片/视频一视同仁）。
// 返回的 untranslated / finishReason 等元数据仅供排查运维，前端不得渲染（见 AGENTS.md 内容创作规范）。
const promptApi = createPromptApi();
router.post("/api/prompt/compile", promptApi.handle);

// 生图工作台入队：一次提交拆成 count 个 kind=image 任务进本地 GPU 队列，提示词由后端编译。
router.post("/api/images/enqueue", imageEnqueue.handle);

/**
 * OpenAI 兼容的模型清单。**静态**：与 /api/providers 的 llm.models、/api/llm/models 同源，
 * 都读模型注册表里已启用的 text 条目（渠道声明的模型 id → 「渠道名::模型名」，chat 按此前缀路由）。
 * 网关不向上游探测 /v1/models、/api/tags —— 清单不会因为死渠道而变慢或挂住，也不会「上游没应答就少列」。
 * 要增减模型：改渠道表的 `models` 声明（POST /api/llm/providers）或直接在注册表登记，随后自动同步。
 */
router.get("/v1/models", (req, res) => {
    const models = modelRegistry.textModels();
    sendJson(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "canvas-gateway" })) });
});

// 前端把渠道 baseUrl 指向本服务即可复用既有 OpenAI 兼容调用链。
router.any("/v1/*path", async (req, res, { url }) => {
    try {
        await forwardToLlm(req, res, config, `${url.pathname.replace(/^\/v1/, "") || "/"}${url.search}`);
    } catch (error) {
        // forwardToLlm 自己会在上游全不可达时回 502，这里要避免重复写响应头。
        if (res.writableEnded) return;
        if (!res.headersSent) sendError(res, 502, `转发到内网 LLM 失败：${error.message}`);
        else res.end();
    }
});

for (const [kind, route] of [["image", "/api/generate/image"], ["video", "/api/generate/video"]]) {
    router.post(route, async (req, res) => {
        try {
            const body = await readJson(req);
            sendJson(res, 201, { job: await submitGeneration(kind, body) });
        } catch (error) {
            sendError(res, 400, error.message);
        }
    });
}

router.post("/api/uploads", async (req, res) => {
    try {
        const contentType = req.headers["content-type"] || "";
        if (contentType.includes("multipart/form-data")) {
            const form = await new Request("http://localhost/", {
                method: "POST",
                headers: req.headers,
                body: Readable.toWeb(req),
                duplex: "half",
            }).formData();
            const file = [...form.values()].find((value) => typeof value === "object" && value?.arrayBuffer);
            if (!file) throw new Error("未找到上传文件");
            const name = sanitizeName(file.name || "upload");
            await saveBuffer(safeJoin(uploads, name), Buffer.from(await file.arrayBuffer()));
            const comfyName = await comfy.uploadFile(Buffer.from(await file.arrayBuffer()), name);
            sendJson(res, 201, { name, comfyName });
            return;
        }
        const buffer = await readBody(req);
        const name = sanitizeName(req.headers["x-filename"] || `upload${extensionFor("", contentType)}`);
        await saveBuffer(safeJoin(uploads, name), buffer);
        sendJson(res, 201, { name, comfyName: await comfy.uploadFile(buffer, name) });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

router.get("/api/jobs", (req, res, { url }) => {
    // 可选过滤：?kind=&status=(逗号分隔)&limit=&since=。不传参数时行为与旧版完全一致（向前兼容）。
    const jobsList = filterJobs(jobs.list({}), {
        kind: url.searchParams.get("kind") || undefined,
        status: url.searchParams.get("status") || undefined,
        limit: url.searchParams.get("limit") || undefined,
        since: url.searchParams.get("since") || undefined,
    });
    sendJson(res, 200, { jobs: jobsList });
});

router.get("/api/jobs/:id", (req, res, { params }) => {
    const job = jobs.get(params.id);
    if (!job) return sendError(res, 404, "任务不存在");
    sendJson(res, 200, { job });
});

router.post("/api/jobs/:id/cancel", async (req, res, { params }) => {
    // jobs.cancel 内部已把 status 改成 canceled，而且 jobs.get 返回的是**同一个对象引用**（就地 Object.assign），
    // 所以必须在取消前把 status **取成值**再判断；否则 running 分支永远不成立，
    // 「已出队、还没拿到 promptId」的任务会被漏掉，取消后照样提交并在 GPU 上跑。
    const beforeStatus = jobs.get(params.id)?.status;
    const job = jobs.cancel(params.id);
    if (!job) return sendError(res, 404, "任务不存在");
    if (beforeStatus === "running" || job.promptId) await comfy.interrupt().catch(() => {});
    sendJson(res, 200, { job: jobs.get(params.id) });
});

// ——— 产物归档 / 彻底删除（素材生命周期） ———
// 归档是可逆的生产动线入口；彻底删除只在「我的资产」页，必须 confirm:true，被引用默认拒删。
router.get("/api/artifacts", (req, res, { url }) => {
    sendJson(
        res,
        200,
        artifacts.list({
            state: url.searchParams.get("state") || "active",
            kind: url.searchParams.get("kind") || undefined,
            origin: url.searchParams.get("origin") || undefined,
            projectId: url.searchParams.get("projectId") || undefined,
            limit: url.searchParams.get("limit") || undefined,
            cursor: url.searchParams.get("cursor") || undefined,
        }),
    );
});

// createRouter 只支持 get/post/any —— 写路由用 any 承接（同时接受 POST 与 DELETE），其它方法 405。
const artifactsWrite = (run) => async (req, res) => {
    if (req.method !== "POST" && req.method !== "DELETE") return sendError(res, 405, `不支持的方法：${req.method}`);
    try {
        const body = await readJson(req).catch(() => ({}));
        sendJson(res, 200, run(body && typeof body === "object" ? body : {}));
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
};

router.any("/api/artifacts/archive", artifactsWrite((body) => artifacts.archive(body)));
router.any("/api/artifacts/restore", artifactsWrite((body) => artifacts.restore(body)));
router.any("/api/artifacts/delete", artifactsWrite((body) => artifacts.remove(body)));

/**
 * M2-D4：登记外部文件为 Artifact（multipart：file + fields）。
 * 合成 status="done"、kind="import" 的 Job，字节落 data/artifacts/<jobId>/<filename>，
 * 产物复用 jobs→artifacts 懒索引；同 idempotencyKey 重放返回同一 job + artifact。
 * fields 带 projectId+shotId+slotId 时，终态投影会自动把它追加为槽位候选。
 */
router.post("/api/artifacts/import", async (req, res) => {
    try {
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) throw Object.assign(new Error("只接受 multipart/form-data（file + fields）"), { status: 400 });
        const form = await new Request("http://localhost/", {
            method: "POST",
            headers: req.headers,
            body: Readable.toWeb(req),
            duplex: "half",
        }).formData();
        const file = [...form.values()].find((value) => typeof value === "object" && value?.arrayBuffer);
        if (!file) throw Object.assign(new Error("未找到导入文件"), { status: 400 });
        const fields = {};
        for (const key of ["source", "projectId", "episodeId", "sceneId", "shotId", "slotId", "idempotencyKey"]) {
            const value = form.get(key);
            if (typeof value === "string" && value.trim()) fields[key] = value.trim();
        }
        const result = await artifactImport.importArtifact({ filename: file.name, contentType: file.type, buffer: Buffer.from(await file.arrayBuffer()), fields });
        sendJson(res, 200, result);
    } catch (error) {
        sendError(res, error.status || 400, error.message, error.code);
    }
});

// 产物文件。`?variant=thumb[&w=320]` 走**真缩略图**（按需生成 + 缓存，列表/卡片用）：
// 生成不了就回退原图（宁可退回大图，也绝不裂图）；下载仍取原图（download=1）。
router.get("/api/artifacts/:jobId/:filename", async (req, res, { params, url }) => {
    const dir = safeJoin(config.dataDir, "artifacts", params.jobId);
    const file = dir && safeJoin(dir, params.filename);
    if (!file) return sendError(res, 400, "非法路径");
    if (url.searchParams.get("variant") === "thumb" && isThumbnailable(params.filename)) {
        const width = normalizeThumbWidth(url.searchParams.get("w"));
        // ⚠️ 有意为之的 HEAD 例外：HEAD 必须安全幂等，**不得触发按需生成**（未鉴权的 HEAD 就能让 ffmpeg 白跑、
        // 往磁盘落缩略图）。已缓存的缩略图照常发头；未缓存时与「没有缩略图」一致，回退原图头 —— 只有 GET 才生成。
        if (req.method === "HEAD") {
            const cached = thumbnails.pathFor(params.jobId, params.filename, width);
            if (cached && isFresh(cached, file)) return serveFile(req, res, cached);
        } else {
            const thumb = await thumbnails
                .generate({ jobId: params.jobId, filename: params.filename, sourcePath: file, width })
                .catch(() => null);
            if (thumb?.path) return serveFile(req, res, thumb.path);
        }
    }
    serveFile(req, res, file, { download: req.url.includes("download=1") });
});

router.get("/api/pipeline/stages", (req, res) => {
    sendJson(res, 200, { stages: pipeline.stages() });
});

router.get("/api/pipeline/runs", (req, res) => {
    sendJson(res, 200, { runs: pipeline.list() });
});

router.post("/api/pipeline/runs", async (req, res) => {
    try {
        const body = await readJson(req);
        if (!String(body.novel || "").trim()) throw new Error("缺少小说正文 novel");
        sendJson(res, 201, { run: pipeline.create(body) });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

/**
 * 创建可逆分支：从父流水线指定阶段开始重跑，父 run 与其产物保持只读。
 * body `{ fromStage, title?, options? }`；上游阶段直接复用，分支阶段及下游清空。
 */
router.post("/api/pipeline/runs/:id/fork", async (req, res, { params }) => {
    try {
        if (!pipeline.get(params.id)) return sendError(res, 404, "流水线不存在");
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("分支请求必须是 JSON 对象");
        sendJson(res, 201, { run: pipeline.fork(params.id, body || {}) });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

// 正在执行的阶段：`${runId}:${stageId}` → { controller, startedAt }。既用于取消，也用于防重复触发。
const inflightStages = new Map();
const inflightKey = (runId, stageId) => `${runId}:${stageId}`;

router.get("/api/pipeline/runs/:id", (req, res, { params }) => {
    const run = pipeline.get(params.id);
    if (!run) return sendError(res, 404, "流水线不存在");
    sendJson(res, 200, { run });
});

/**
 * 轻量进度：只回 progress.json（几十字节）。
 * 不要用 GET /api/pipeline/runs/:id 轮询进度 —— 那个响应内嵌整本小说，222 万字的书有 6.4MB，
 * 每 3 秒轮询一次就是每分钟 128MB 传输。
 */
router.get("/api/pipeline/runs/:id/progress", (req, res, { params }) => {
    const progress = pipeline.stageProgress(params.id);
    const inflight = progress?.stage ? inflightStages.has(inflightKey(params.id, progress.stage)) : false;
    sendJson(res, 200, { progress: progress || null, inflight });
});

/**
 * 审计日志（追加式 `runs/<id>/log.jsonl` 的尾部）：回答「这一步是谁、什么时候、写了哪一版产物」。
 * 与 run.json 分开存放，读取不必拖着内嵌整本小说的 run.json（同 progress 的理由）。
 */
router.get("/api/pipeline/runs/:id/log", (req, res, { params, url }) => {
    sendJson(res, 200, { log: pipeline.runLog(params.id, url.searchParams.get("limit")) });
});

/** 可重放跨阶段 QC：报告落 runs/<id>/qc/，不修改正文或候选。POST 可带 `{ stage?: "assembly" }`。 */
router.get("/api/pipeline/runs/:id/qc", (req, res, { params }) => {
    try {
        const report = pipeline.latestQualityCheck(params.id);
        sendJson(res, 200, { report });
    } catch (error) {
        sendError(res, error.status || 404, error.message);
    }
});

router.post("/api/pipeline/runs/:id/qc", async (req, res, { params }) => {
    try {
        if (!pipeline.get(params.id)) return sendError(res, 404, "流水线不存在");
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("质检请求必须是 JSON 对象");
        sendJson(res, 201, { report: pipeline.qualityCheck(params.id, { stage: body?.stage || null }) });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

/**
 * 运行单步。**立刻返回 202**，工作在后台跑。
 * 此前是 `await pipeline.runStage(...)` 的阻塞式 POST：一个 163 块 / 83 分钟的阶段用一个 HTTP
 * 请求扛，隧道、反向代理、浏览器都会在几分钟内掐断连接，前端 await 抛错后按钮复位、页面
 * 「毫无反应」，而后端仍在继续跑并消耗 LLM 额度 —— 用户既看不到进度也停不下来。
 */
router.post("/api/pipeline/runs/:id/steps/:stage/run", async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        const runOptions = body && typeof body === "object" ? body : {};
        // 同步部分先跑：依赖校验、模型绑定、标记 running 都在这一步，参数不合法仍能返回 400
        const begun = pipeline.beginStage(params.id, params.stage, runOptions);
        const key = inflightKey(params.id, params.stage);
        const controller = new AbortController();
        inflightStages.set(key, { controller, startedAt: Date.now() });
        void pipeline
            .executeStage(begun, { ...runOptions, signal: controller.signal })
            .catch((error) => console.error(`[pipeline] 阶段 ${params.stage} 执行失败：${error.message}`))
            .finally(() => inflightStages.delete(key));
        sendJson(res, 202, { run: begun.run, inflight: true });
    } catch (error) {
        // 门禁失败带状态码（如上游正在运行/部分完成 → 409）；其余参数错误仍是 400。
        sendError(res, error.status || 400, error.message);
    }
});

/**
 * 阶段门禁视图：基于真实产物推导每个阶段能否进入（缺源 / 上游未产出 / error / partial 都有可读原因）。
 * 项目工作区据此不再只靠 runIds[0] 猜某一版 run 的阶段状态。
 */
router.get("/api/pipeline/runs/:id/gates", (req, res, { params }) => {
    const run = pipeline.get(params.id);
    if (!run) return sendError(res, 404, "流水线不存在");
    sendJson(res, 200, { gates: pipeline.stageGates(params.id) });
});

/**
 * 分镜定点编辑：按 shotId 局部更新 storyboard 阶段产物里的单个 shot，不必整段 setStageInput 替换 JSON。
 * 承接 PATCH/POST（createRouter 无 put/patch，用 any 承接 PATCH）；其它方法 405。
 */
router.any("/api/pipeline/runs/:id/steps/:stage/shots/:shotId", async (req, res, { params }) => {
    if (req.method !== "PATCH" && req.method !== "POST") return sendError(res, 405, `不支持的方法：${req.method}`);
    try {
        const { run, shot } = pipeline.patchStageShot(params.id, params.stage, params.shotId, await readJson(req).catch(() => ({})));
        sendJson(res, 200, { run, shot });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

/**
 * 取消正在执行的阶段。abort 后由 executeStage 的 catch 落终态；
 * 同时把该阶段已入队的图像/视频 Job 一并取消（取消要沿 阶段→Job 传播），生成型阶段靠回写投影落成 canceled。
 * 这里**不回传 run** —— 那一刻 run 还没写完，回传会是过期的 running 态；让前端轮询 progress 拿终态。
 */
router.post("/api/pipeline/runs/:id/steps/:stage/cancel", (req, res, { params }) => {
    const key = inflightKey(params.id, params.stage);
    const entry = inflightStages.get(key);
    let result;
    try {
        result = pipeline.cancelStage(params.id, params.stage);
    } catch (error) {
        return sendError(res, 404, error.message);
    }
    if (entry) {
        entry.controller.abort();
        inflightStages.delete(key);
    } else if (!result.canceled) {
        return sendError(res, 409, `阶段「${params.stage}」当前没有正在执行的任务`);
    }
    sendJson(res, 200, { canceled: true, stage: params.stage, jobs: result.canceled, ranMs: entry ? Date.now() - entry.startedAt : undefined });
});

router.post("/api/pipeline/runs/:id/steps/:stage/input", async (req, res, { params }) => {
    try {
        sendJson(res, 200, { run: pipeline.setStageInput(params.id, params.stage, await readJson(req)) });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

/**
 * 角色定妆确认（锁脸锁声音的人工动作）：body `{ characterId, face?, voice?, speaker?, design?, language?, speed?, previewArtifactId? }`。
 * face/voice 各一个确认位；角色 confirmed = 脸与声都真；确认时写 lockedAt，确认后修改 version+1。
 * speaker/language 只接受平台音色库枚举，非法值 400；face 未出产物就确认脸 → 409（拒绝假装已锁）。
 * 确认齐后自动解除 keyframe / audio 的 casting 阻断（复用 #70 blocked 机制）。
 */
router.post("/api/pipeline/runs/:id/steps/casting/confirm", async (req, res, { params }) => {
    try {
        const patch = await readJson(req).catch(() => ({}));
        sendJson(res, 200, pipeline.confirmCasting(params.id, patch));
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

/**
 * 合成成片：独立于阶段 LLM 编排的用户触发动作（D11 保留逐阶段人工审核门禁——用户看过片段才决定拼）。
 * body 可带 `{ order?, transition?, quality?, force? }`；同步部分做门禁与幂等判定：
 * 片段未全部成功 → 400 并给出明确原因；已有成片 → 200 直接回原结果，不重复拼；否则 202 后台跑 ffmpeg。
 * ffmpeg 命令构造与执行都在 delivery.js，这里只挂路由与转交参数。
 */
router.post("/api/pipeline/runs/:id/steps/assembly/assemble", async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        const options = body && typeof body === "object" ? body : {};
        const begun = pipeline.beginAssemble(params.id, options);
        if (begun.reused) return sendJson(res, 200, { run: begun.run, reused: true, assembly: begun.assembly });

        const key = `${params.id}:assembly:assemble`;
        const controller = new AbortController();
        inflightStages.set(key, { controller, startedAt: Date.now() });
        void pipeline
            .executeAssemble(begun, options)
            .catch((error) => console.error(`[pipeline] 合成成片失败：${error.message}`))
            .finally(() => inflightStages.delete(key));
        sendJson(res, 202, { run: begun.run, inflight: true, assembly: begun.assembly });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

/**
 * 自动粗剪 + 素材包导出（M4 补齐：此前只有 CLI 入口，前端与 Agent 都拿不到包）。
 * body `{ episodeId?, allowPartial?, transition?, transitionDurationSec?, steps?, options? }`：
 *   - `episodeId` 缺省导出 run 下全部集；
 *   - `allowPartial=true` 允许缺段出片（清单标 partial=true 并列出缺哪几段）；
 *   - `steps` 支持 ["plan","assemble","package"] 子集，便于失败后单步重跑（前序结果从磁盘读回）。
 *
 * **202 立刻返回**：真实ffmpeg 拼接与打包是分钟级操作，不能让一个 HTTP 请求扛着
 * （与 `/steps/:stage/run` 同理）。进度看 `GET /api/pipeline/runs/:id/progress`。
 */
router.post("/api/pipeline/runs/:id/steps/assembly/export", async (req, res, { params }) => {
    const key = `${params.id}:assembly:export`;
    try {
        const body = await readJson(req).catch(() => ({}));
        const options = body && typeof body === "object" ? body : {};
        const run = pipeline.get(params.id);
        if (!run) return sendError(res, 404, "流水线不存在");
        if (inflightStages.has(key)) return sendError(res, 409, "该run 的导出已在进行中");

        const controller = new AbortController();
        inflightStages.set(key, { controller, startedAt: Date.now() });
        sendJson(res, 202, { runId: params.id, inflight: true, episodeId: options.episodeId ?? null });
        void exportDeliveryPackage({
            config,
            run,
            episodeId: options.episodeId ?? null,
            allowPartial: options.allowPartial === true,
            transition: options.transition ?? null,
            transitionDurationSec: options.transitionDurationSec,
            options: options.options ?? {},
            steps: Array.isArray(options.steps) && options.steps.length ? options.steps : ["plan", "assemble", "package"],
        })
            .then((result) => {
                // 导出结果落在 run 的产物目录里，前端按 runId 读manifest 即可，不回传大对象。
                console.log(`[export] ${params.id} 导出完成：${result?.package?.zipPath ?? "(无 zip)"}`);
            })
            .catch((error) => console.error(`[export] ${params.id} 导出失败：${error.message}`))
            .finally(() => inflightStages.delete(key));
    } catch (error) {
        inflightStages.delete(key);
        sendError(res, 400, error.message);
    }
});

/**
 * 查导出结果（manifest 摘要 + 素材包文件清单）。
 * GET `/api/pipeline/runs/:id/steps/assembly/export[?packageId=xxx]`
 *   - 带 `packageId`：读该包的 manifest；
 *   - 不带：列出该 run 名下所有已导出的包（`edit-export-<runId>*`），并回传最近一次的 manifest 摘要。
 *
 * 落盘位置是 `data/artifacts/<packageId>/export-manifest.json`（**不在 runs 下**——
 * 素材包是产物不是运行日志）。packageId 规则与 edit-export.js 一致：
 * `options.id || edit-export-<runId>`。
 */
router.get("/api/pipeline/runs/:id/steps/assembly/export", (req, res, { params, url }) => {
    try {
        const artifactsDir = safeJoin(config.dataDir, "artifacts");
        const requested = url.searchParams.get("packageId");
        const defaultId = `edit-export-${params.id}`;
        const pkgId = requested ? safeJoin(artifactsDir, sanitizeName(requested, "edit-export")) : safeJoin(artifactsDir, defaultId);
        const manifestPath = safeJoin(pkgId, "export-manifest.json");
        const response = {};
        if (existsSync(manifestPath)) {
            response.manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            response.packageId = basename(pkgId);
        } else {
            // 没给 packageId 且默认包不存在时，列出该 run 名下所有已导出的包，供前端选择。
            response.packageId = null;
            response.packages = existsSync(artifactsDir)
                ? readdirSync(artifactsDir)
                      .filter((name) => name.startsWith("edit-export-") && name.includes(params.id))
                      .filter((name) => existsSync(safeJoin(artifactsDir, name, "export-manifest.json")))
                : [];
            return sendJson(res, 200, response);
        }
        sendJson(res, 200, response);
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

/**
 * 逐条重跑（活扣）：只给指定 item 换模型再追加一个候选，不动其它 item、不删旧候选。
 * body `{ itemId, template?, params? }`；模板必须是该阶段同 family 的已有模板。
 * 同步部分做门禁：参数/引用非法（item 不存在、文本阶段、模板非法）→ 400；
 * 阶段或条目正忙（防并发重复入队）→ 409。通过后入队（非阻塞）→ 202，真实生成在任务队列后台跑。
 */
/**
 * 按角色 / 场景 / 道具聚合关键帧条目（只读）。
 *
 * 用途：一眼看出「陈默在 68 镜里的定妆照引用是否始终一致」。
 * 聚合依据是**实际引用关系**（这一镜引用了哪张定妆照），不是提示词里有没有出现名字 ——
 * 后者是字符串猜测，提示词会被改、也可能只写「他」。
 *
 * `unbound` 是没引用任何参考图的条目，单列出来：这本身就是质量信号，
 * 没锁脸的镜头出图时角色长相会漂。
 */
router.get("/api/pipeline/runs/:id/frames/by-reference", (req, res, { params, url }) => {
    try {
        sendJson(res, 200, pipeline.groupFramesByReference(params.id, url.searchParams.get("stage") || "keyframe"));
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

router.post("/api/pipeline/runs/:id/steps/:stage/retry-failed", async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        const options = body && typeof body === "object" ? body : {};
        // 逐条 beginRegenerate 串行执行：真实入队非阻塞，这里只做入队本身。
        const result = await pipeline.retryFailedItems(params.id, params.stage, { limit: options.limit });
        sendJson(res, 202, {
            runId: params.id,
            stage: params.stage,
            inflight: true,
            retried: result.retried,
            skipped: result.skipped,
            failedTotal: result.failedTotal,
            remaining: result.remaining,
        });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

router.post("/api/pipeline/runs/:id/steps/:stage/regenerate", async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        const options = body && typeof body === "object" ? body : {};
        const begun = pipeline.beginRegenerate(params.id, params.stage, options);
        const result = await pipeline.executeRegenerate(begun);
        sendJson(res, 202, { run: result.run, inflight: true, jobId: result.jobId, itemId: options.itemId });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

// ——— P0-a Project 内核：/api/projects 系列 ———
// 错误码约定：不存在 404、非法引用/参数 400、版本冲突 409。PATCH 冲突时回当前 version（D7 识别写入归属）。
router.get("/api/projects", (req, res, { url }) => {
    sendJson(res, 200, { projects: projects.list({ includeArchived: url.searchParams.get("includeArchived") === "1" }) });
});

router.post("/api/projects", async (req, res) => {
    try {
        sendJson(res, 201, { project: projects.create(await readJson(req)) });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

/**
 * 门禁推导（P0-f 接线）：与 projects.gates 同样的项目+集视图，但把**该项目的圣经实体**一并喂给 deriveGates，
 * 使「存在但未 approved/locked」的圣经能阻断对应阶段；项目无该实体时行为与旧版逐字相同（向后兼容）。
 * M0：run 阶段集合由 `skills/registry.json` 注入（单一来源，pilot-issues #96）；registry 读失败按空处理，
 * 输出只剩 plan / post 两项，绝不因门禁读盘失败而 500。
 */
function projectGates(id) {
    const project = projects.get(id);
    if (!project) return null;
    const details = projects.episodes.listDetails(id);
    const episodes = details.length ? details : Array.isArray(project.episodes) ? project.episodes : [];
    let bibleRows = [];
    try {
        bibleRows = bibles.list(id);
    } catch {
        bibleRows = []; // 项目刚建、bibles 目录尚未生成时按空处理，绝不因门禁读盘失败而 500。
    }
    let stages = [];
    try {
        stages = loadRegistry(config.skillsDir).stages || [];
    } catch {
        stages = [];
    }
    return deriveGates({ project, episodes, bibles: bibleRows, stages });
}

router.get("/api/projects/:id/context", (req, res, { params, url }) => {
    // 默认轻量形状（保持既有契约）；?include=refs 追加 assetRefs 与 gates（阶段门禁，含圣经放行判据）。
    const project = projects.get(params.id);
    if (!project) return sendError(res, 404, "项目不存在");
    const base = { project, episodes: project.episodes || [], runIds: project.runIds || [], canvasIds: project.canvasIds || [] };
    if (url.searchParams.get("include") !== "refs") return sendJson(res, 200, base);
    sendJson(res, 200, { ...base, assetRefs: project.assetRefs || [], gates: projectGates(params.id) });
});

router.get("/api/projects/:id", (req, res, { params }) => {
    const project = projects.get(params.id);
    if (!project) return sendError(res, 404, "项目不存在");
    sendJson(res, 200, { project });
});

/**
 * 素材口径体检（只读）：把「资产引用 ↔ 剧本场次 ↔ 设计锚点 ↔ 镜头」四层的一致性问题一次摆出来。
 *
 * 为什么要它（2026-10-06 实测）：关键帧门禁报 `scene:内景（no-ref）` 时，
 * 追下去发现四处数据源口径不一致 —— 而这类不一致**不会报错、不告警**，
 * 每条数据单看都合法，系统自己发现不了，只能靠人看出来。
 * 同一项目里还实测到「同一角色两条引用（名字/ id 两种key）」，选参考图会随机命中。
 *
 * 刻意**只读、只报、不改**：诊断与处置必须分开。若这个端点顺手改数据，
 * 它自己就成了新的写入源，下次别的 Agent 照样会乱，且失去可追溯性。
 * 修复走各阶段正规入口（asset-refs/:refId/select、steps/:stage/input 等）。
 *
 * 数据取自项目最新一个 run 的各阶段产物；没 run 时只查项目内的 assetRefs。
 */
router.get("/api/projects/:id/asset-consistency", (req, res, { params, url }) => {
    try {
        const project = projects.get(params.id);
        if (!project) return sendError(res, 404, "项目不存在");
        const runIds = Array.isArray(project.runIds) ? project.runIds : [];
        const runId = url.searchParams.get("runId") || runIds.at(-1) || null;
        const run = runId ? pipeline.get(runId) : null;
        const stageOutput = (stageId) => (run?.stages?.[stageId]?.output ?? null);
        const scriptOut = stageOutput("script");
        const designOut = stageOutput("design");
        const storyboardOut = stageOutput("storyboard");
        const issues = checkAssetConsistency({
            assetRefs: Array.isArray(project.assetRefs) ? project.assetRefs : [],
            scenes: Array.isArray(scriptOut?.scenes) ? scriptOut.scenes : [],
            locations: Array.isArray(designOut?.locations) ? designOut.locations : [],
            shots: Array.isArray(storyboardOut?.shots) ? storyboardOut.shots : [],
            characters: Array.isArray(scriptOut?.characters) ? scriptOut.characters : [],
        });
        sendJson(res, 200, { runId, ...summarizeConsistency(issues), issues });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

router.add("PATCH", "/api/projects/:id", async (req, res, { params }) => {
    try {
        sendJson(res, 200, { project: projects.update(params.id, await readJson(req)) });
    } catch (error) {
        if (error.status === 409) return sendJson(res, 409, { error: { message: error.message, code: "version_conflict" }, version: error.currentVersion });
        sendError(res, error.status || 400, error.message);
    }
});

router.post("/api/projects/:id/archive", (req, res, { params }) => {
    try {
        sendJson(res, 200, { project: projects.archive(params.id) });
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
});

// ——— P0-a 深水区：集/场/镜、源版本、资产引用、阶段门禁 ———
// 存储层不碰 HTTP、路由层不写业务：这里只解析请求、调 projects 下的实体存储、回响应。
// 错误码沿用：不存在 404、非法引用/参数 400、版本冲突 409；错误对象带 status，由 routeHandler 统一映射。
const routeHandler = (handler) => async (req, res, ctx) => {
    try {
        await handler(req, res, ctx);
    } catch (error) {
        sendError(res, error.status || 400, error.message);
    }
};

// 集 / 场 / 镜
router.get("/api/projects/:id/episodes", routeHandler((req, res, { params }) => {
    sendJson(res, 200, { episodes: projects.episodes.list(params.id) });
}));

router.post("/api/projects/:id/episodes", routeHandler(async (req, res, { params }) => {
    const { episode } = projects.episodes.save(params.id, await readJson(req));
    sendJson(res, 201, { episode });
}));

router.get("/api/projects/:id/episodes/:episodeId", routeHandler((req, res, { params }) => {
    const episode = projects.episodes.get(params.id, params.episodeId);
    if (!episode) return sendError(res, 404, "集不存在");
    sendJson(res, 200, { episode });
}));

router.post("/api/projects/:id/episodes/:episodeId", routeHandler(async (req, res, { params }) => {
    const { episode } = projects.episodes.update(params.id, params.episodeId, await readJson(req));
    sendJson(res, 200, { episode });
}));

router.post("/api/projects/:id/episodes/:episodeId/scenes", routeHandler(async (req, res, { params }) => {
    const { scene } = projects.episodes.addScene(params.id, params.episodeId, await readJson(req));
    sendJson(res, 201, { scene });
}));

router.post("/api/projects/:id/episodes/:episodeId/reorder", routeHandler(async (req, res, { params }) => {
    const { episode } = projects.episodes.reorder(params.id, params.episodeId, await readJson(req));
    sendJson(res, 200, { episode });
}));

router.post("/api/projects/:id/scenes/:sceneId", routeHandler(async (req, res, { params }) => {
    const { scene } = projects.episodes.updateScene(params.id, params.sceneId, await readJson(req));
    sendJson(res, 200, { scene });
}));

router.post("/api/projects/:id/scenes/:sceneId/shots", routeHandler(async (req, res, { params }) => {
    const { shot } = projects.episodes.addShot(params.id, params.sceneId, await readJson(req));
    sendJson(res, 201, { shot });
}));

// 改镜头：前端走 PATCH，契约同时保留 POST；同一条路径共用同一个处理器。
const updateShot = routeHandler(async (req, res, { params }) => {
    const { shot } = projects.episodes.updateShot(params.id, params.shotId, await readJson(req));
    sendJson(res, 200, { shot });
});
router.add("PATCH", "/api/projects/:id/shots/:shotId", updateShot);
router.post("/api/projects/:id/shots/:shotId", updateShot);

// ——— M2 槽位候选：追加 / 采用（契约 §3，薄路由：解析请求、调业务、回响应） ———
// 错误形状沿用 generation-intent.js（status + code + field），body 里一并回 code 供前端分支。
const slotRoute = (run) => async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        sendJson(res, 200, run(params, body && typeof body === "object" ? body : {}));
    } catch (error) {
        sendError(res, error.status || 400, error.message, error.code);
    }
};

// 画布绑定（M2）：幂等 attach/detach 项目 canvasIds，派生写入不 bump version。
router.post("/api/projects/:id/canvas-refs", routeHandler(async (req, res, { params }) => {
    const body = await readJson(req).catch(() => ({}));
    sendJson(res, 200, { project: projects.attachCanvas(params.id, body?.canvasId) });
}));

router.add("DELETE", "/api/projects/:id/canvas-refs/:canvasId", routeHandler((req, res, { params }) => {
    sendJson(res, 200, { project: projects.detachCanvas(params.id, params.canvasId) });
}));

// 追加候选：body { jobId } → { slot }；404 JOB_NOT_FOUND / NO_ARTIFACT_OUTPUT，409 PROJECT_MISMATCH；同 jobId 幂等。
router.post("/api/projects/:id/shots/:shotId/slots/:slotId/candidates", slotRoute((params, body) =>
    slotCandidates.appendCandidate({ projectId: params.id, shotId: params.shotId, slotId: params.slotId, jobId: body.jobId })));

// 采用候选：body { jobId } → { slot }；404 CANDIDATE_NOT_FOUND。
// 采用 take（jobId = take 末段候选）时整链段 approved、其它 take 段 superseded（M3.5，扩展在 slot-candidates.js）。
router.post("/api/projects/:id/shots/:shotId/slots/:slotId/select", slotRoute((params, body) =>
    slotCandidates.selectCandidate({ projectId: params.id, shotId: params.shotId, slotId: params.slotId, jobId: body.jobId })));

// ——— M3.5 H3 续接链（契约 m35-implementation-plan §3，薄路由：业务全在 continuation.js） ———
const continuationRoute = (status, run) => async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        sendJson(res, status, await run(params, body && typeof body === "object" ? body : {}));
    } catch (error) {
        sendError(res, error.status || 400, error.message, error.code);
    }
};

// 开新链：body { prompt, segments:1..8, seed?, template?, params? } → 201 { chainId, takeId, slotId, firstJob }。
router.post("/api/projects/:id/shots/:shotId/continuation-chains", continuationRoute(201, (params, body) =>
    continuation.startChain({ projectId: params.id, shotId: params.shotId, ...body })));

// 分叉：body { parentCandidateId, prompt, segments, seed? } → 201；404 CANDIDATE_NOT_FOUND；409 PARENT_NOT_DONE。
router.post("/api/projects/:id/shots/:shotId/continuation-branches", continuationRoute(201, (params, body) =>
    continuation.startBranch({ projectId: params.id, shotId: params.shotId, ...body })));

// 恢复：幂等（已完成段靠幂等键跳过；链已完成 job:null）→ 200 { chainId, resumedFromSegment, job }。
router.post("/api/projects/:id/shots/:shotId/continuation-chains/:chainId/resume", continuationRoute(200, (params) =>
    continuation.resumeChain({ projectId: params.id, shotId: params.shotId, chainId: params.chainId })));

// 派生链视图（从 clip 槽位候选分组，链 → 段 → parent 可回溯）。
router.get("/api/projects/:id/shots/:shotId/continuation-chains", continuationRoute(200, (params) =>
    continuation.listChains({ projectId: params.id, shotId: params.shotId })));

// 接缝人工复核：body { jobId, reviewed:"approved"|"rejected", note? } → 200 { candidate }。
router.post("/api/projects/:id/shots/:shotId/continuation-reviews", continuationRoute(200, (params, body) =>
    continuation.reviewSeam({ projectId: params.id, shotId: params.shotId, jobId: body.jobId, reviewed: body.reviewed, note: body.note })));

// 源版本（不可变）
router.get("/api/projects/:id/sources", routeHandler((req, res, { params }) => {
    sendJson(res, 200, { sources: projects.sources.list(params.id) });
}));

router.post("/api/projects/:id/sources", routeHandler(async (req, res, { params }) => {
    sendJson(res, 201, { source: projects.sources.save(params.id, await readJson(req)) });
}));

router.get("/api/projects/:id/sources/:revisionId", routeHandler((req, res, { params }) => {
    const source = projects.sources.get(params.id, params.revisionId);
    if (!source) return sendError(res, 404, "源版本不存在");
    sendJson(res, 200, { source });
}));

// 资产引用（AssetRef）：路径与契约/前端一致，统一 /asset-refs（不再保留旧的 /assets 别名）。
router.get("/api/projects/:id/asset-refs", routeHandler((req, res, { params, url }) => {
    sendJson(res, 200, { assetRefs: projects.assets.list(params.id, { role: url.searchParams.get("role") ?? undefined }) });
}));

router.post("/api/projects/:id/asset-refs", routeHandler(async (req, res, { params }) => {
    sendJson(res, 201, { assetRef: projects.assets.create(params.id, await readJson(req)) });
}));

// 归入资料包（upsert）：生图/生视频工作台、Agent、画布把产物挂到项目实体上的统一入口。
// 与上面 POST 的区别是**幂等**：同 role+bindingId 命中已有引用就追加候选，而不是新增一条重复引用。
router.post("/api/projects/:id/asset-refs/attach", routeHandler(async (req, res, { params }) => {
    sendJson(res, 200, projects.assets.attach(params.id, await readJson(req)));
}));

// 改引用：前端走 PATCH，契约同时保留 POST；同一条路径共用同一个处理器。
const updateAssetRef = routeHandler(async (req, res, { params }) => {
    sendJson(res, 200, { assetRef: projects.assets.update(params.id, params.refId, await readJson(req)) });
});
router.add("PATCH", "/api/projects/:id/asset-refs/:refId", updateAssetRef);
router.post("/api/projects/:id/asset-refs/:refId", updateAssetRef);

router.post("/api/projects/:id/asset-refs/:refId/select", routeHandler(async (req, res, { params }) => {
    sendJson(res, 200, { assetRef: projects.assets.select(params.id, params.refId, await readJson(req)) });
}));

router.post("/api/projects/:id/asset-refs/:refId/unlink", routeHandler(async (req, res, { params }) => {
    sendJson(res, 200, { assetRef: projects.assets.unlink(params.id, params.refId, await readJson(req)) });
}));

// 跨项目资产总览（只读聚合）：汇总全部项目的 AssetRef，供顶部「我的资产」页跨项目筛选、站内预览与跳转。
router.get("/api/asset-refs", routeHandler((req, res) => {
    sendJson(res, 200, projects.assets.overview());
}));

// ——— P0-f 制作圣经与确认锁：/bibles 系列（实体持久化 + 状态机 + revision 语义）———
// 错误码沿用：不存在 404、非法类别/非法迁移 400、重复 id 409。改已批准/已锁对象→派生新 revision（不静默覆盖）。
router.get("/api/projects/:id/bibles", routeHandler((req, res, { params }) => {
    sendJson(res, 200, { bibles: bibles.list(params.id) });
}));

router.post("/api/projects/:id/bibles", routeHandler(async (req, res, { params }) => {
    const { bible, warnings } = bibles.create(params.id, await readJson(req));
    sendJson(res, 201, { bible, warnings });
}));

router.get("/api/projects/:id/bibles/:bibleId", routeHandler((req, res, { params }) => {
    const bible = bibles.get(params.id, params.bibleId);
    if (!bible) return sendError(res, 404, "圣经实体不存在");
    sendJson(res, 200, { bible });
}));

// 改实体：前端走 PATCH、契约保留 POST；status 不走这里（只能经 /transition）。
const updateBible = routeHandler(async (req, res, { params }) => {
    const body = (await readJson(req)) || {};
    const result = bibles.update(params.id, params.bibleId, body, { actor: body?.actor });
    sendJson(res, 200, { bible: result.bible, changed: result.changed, requiresNewRevision: result.requiresNewRevision });
});
router.add("PATCH", "/api/projects/:id/bibles/:bibleId", updateBible);
router.post("/api/projects/:id/bibles/:bibleId", updateBible);

// 推进状态机：body 形如 { action: "submit_review" | "approve" | "reject" | "lock" | "reopen" | "revise", actor? }
router.post("/api/projects/:id/bibles/:bibleId/transition", routeHandler(async (req, res, { params }) => {
    const body = (await readJson(req)) || {};
    const result = bibles.transition(params.id, params.bibleId, body?.action, body?.actor);
    sendJson(res, 200, { bible: result.bible, action: result.action, from: result.from, to: result.to, bumped: result.bumped });
}));

// 阶段门禁（纯推导；P0-f：把项目圣经实体并入判据，存在未批准实体则对应阶段被阻）
router.get("/api/projects/:id/gates", routeHandler((req, res, { params }) => {
    const gates = projectGates(params.id);
    if (!gates) return sendError(res, 404, "项目不存在");
    sendJson(res, 200, { gates });
}));

// ——— P0-e 回马枪·影响分析查询（影响分析只算不跑；分支 run 走 pipeline.fork）———
// 把已交付的 impact.js 纯逻辑接到 HTTP：POST 只返回「改这个会连累哪些东西」的分析结果，
// 影响分析接口本身不建分支、不入队、不改项目；需要执行时由调用方把起始阶段交给 pipeline.fork；GET .../options 供前端下拉选变更对象。
const IMPACT_CHANGE_TYPES = new Set(["assetRef", "shot", "scene", "script"]);
/** 用户可读 type → impact.plan 内部 type：shot/scene 复用 plan 的 shotCamera/storyboard 级联分支。 */
const IMPACT_PLAN_TYPE = Object.freeze({ assetRef: "assetRef", script: "script", shot: "shotCamera", scene: "storyboard" });
const ASSET_ROLE_LABEL = Object.freeze({ character: "角色", scene: "场景", prop: "道具", keyframe: "关键帧", clip: "片段" });

const impactBadRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** changed[] 逐项校验：类型必须在白名单内、id 必填；非法即 400 且信息可读（可直接展示给用户）。 */
function normalizeImpactChanged(body) {
    const list = body && typeof body === "object" ? body.changed : undefined;
    if (list === undefined || list === null) throw impactBadRequest('缺少 changed：请求体形如 { changed: [{ type: "assetRef", id: "c1" }] }');
    if (!Array.isArray(list)) throw impactBadRequest("changed 必须是数组");
    if (!list.length) throw impactBadRequest("changed 不能为空：至少指定一个变更对象");
    return list.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw impactBadRequest(`changed 项必须是对象：${JSON.stringify(raw)}`);
        const type = String(raw.type ?? "").trim();
        if (!IMPACT_CHANGE_TYPES.has(type)) throw impactBadRequest(`变更类型非法：${type || "(空)"}（允许 assetRef / shot / scene / script）`);
        const id = String(raw.id ?? "").trim();
        if (!id) throw impactBadRequest(`changed 项缺少 id：${JSON.stringify(raw)}`);
        return { type, id, revision: raw.revision === undefined ? null : raw.revision };
    });
}

/**
 * 组装喂给 impact.plan 的「项目视图」：plan 需要 episodes[].scenes[]/shots[]，
 * 而 project.json 的 episodes 只是索引（shots 在 episodes/<id>.json 详情里），这里把详情并回。
 * 同时把存储上的 audioCues 映射成 plan 认识的 cues；deliverables 尚未落盘，缺失即空数组。
 */
function impactView(id) {
    const project = projects.get(id);
    if (!project) return null;
    const details = projects.episodes.listDetails(id);
    const byId = new Map(details.map((episode) => [String(episode.id), episode]));
    const episodes = (Array.isArray(project.episodes) ? project.episodes : []).map((entry) => byId.get(String(entry.id)) || entry);
    for (const episode of details) if (!episodes.some((entry) => String(entry.id) === String(episode.id))) episodes.push(episode);
    return {
        ...project,
        episodes,
        assetRefs: Array.isArray(project.assetRefs) ? project.assetRefs : [],
        cues: Array.isArray(project.audioCues) ? project.audioCues : [],
        deliverables: Array.isArray(project.deliverables) ? project.deliverables : [],
    };
}

/** changed 项 → 可读中文主语短语（用于 reasons.text）。 */
function impactChangedPhrase(item, assetRefs) {
    if (item.type === "assetRef") {
        const bare = item.id.startsWith("aref_") ? item.id.slice(5) : item.id;
        const ref = assetRefs.find((row) => row && typeof row === "object" && [row.id, row.bindingId].some((value) => value !== undefined && value !== null && (String(value) === item.id || String(value) === bare)));
        const role = ref?.role || "";
        const name = ref?.metadata?.name || ref?.metadata?.title || ref?.metadata?.label || ref?.bindingId || item.id;
        return `${ASSET_ROLE_LABEL[role] || "资产"}「${name}」的${role === "character" ? "三视图" : "素材"}已变`;
    }
    if (item.type === "script") return "剧本已变更";
    if (item.type === "shot") return `镜头「${item.id}」已变更`;
    return `场「${item.id}」已变更`;
}

/** 单条 changed 项 → 可读中文 reason（含它单独造成的受影响集合）。 */
function impactReason(item, one, assetRefs) {
    const shots = one.staleShots.length;
    const phrase = impactChangedPhrase(item, assetRefs);
    let text;
    if (item.type === "assetRef") text = shots > 0 ? `${phrase}，引用其的 ${shots} 个镜头需要重跑` : `${phrase}，当前没有镜头引用它`;
    else if (item.type === "script") text = shots > 0 ? `${phrase}，下游 ${shots} 个镜头需要整体重跑` : `${phrase}，当前没有需要重跑的镜头`;
    else if (item.type === "shot") text = shots > 0 ? `${phrase}，本镜及下游共 ${shots} 个镜头需要重跑` : `${phrase}，没有需要重跑的下游`;
    else text = shots > 0 ? `${phrase}，该场及镜头共 ${shots} 个镜头需要重跑` : `${phrase}，没有需要重跑的下游`;
    return {
        changed: { type: item.type, id: item.id, revision: item.revision },
        text,
        affected: {
            shots: one.staleShots,
            scenes: one.staleScenes,
            episodes: one.staleEpisodes,
            cues: one.staleCues,
            deliverables: one.staleDeliverables,
        },
    };
}

/**
 * 影响分析查询：返回 stale / keep / reasons / summary。纯分析：不建 run、不入队 job、不改任何存储（只读 project）。
 * 项目不存在 → 404；changed 缺失/为空/格式非法 → 400 且错误可解释。
 */
router.post("/api/projects/:id/impact", routeHandler(async (req, res, { params }) => {
    const view = impactView(params.id);
    if (!view) return sendError(res, 404, "项目不存在");
    let body;
    try {
        body = await readJson(req);
    } catch (error) {
        throw impactBadRequest(`请求体不是合法 JSON：${error.message}`);
    }
    const changed = normalizeImpactChanged(body);
    const planChanged = changed.map((item) => ({ type: IMPACT_PLAN_TYPE[item.type], id: item.id, revision: item.revision }));
    const merged = impactPlan({ project: view, sourceRevisionId: view.sourceRevisionId ?? null, changed: planChanged });
    // 逐项再算一次，让每条 reason 只讲「这一个变更」造成的影响（plan 的 reasons 是多项并集归属）。
    const reasons = changed.map((item) => impactReason(item, impactPlan({ project: view, sourceRevisionId: view.sourceRevisionId ?? null, changed: [{ type: IMPACT_PLAN_TYPE[item.type], id: item.id, revision: item.revision }] }), view.assetRefs));
    sendJson(res, 200, {
        projectId: view.id,
        sourceRevisionId: merged.sourceRevisionId,
        changed,
        stale: merged.stale,
        keep: merged.keep,
        reasons,
        summary: {
            total: merged.stale.length,
            affectedShots: merged.staleShots.length,
            affectedScenes: merged.staleScenes.length,
            affectedEpisodes: merged.staleEpisodes.length,
            affectedCues: merged.staleCues.length,
            affectedDeliverables: merged.staleDeliverables.length,
        },
        staleShots: merged.staleShots,
        staleScenes: merged.staleScenes,
        staleEpisodes: merged.staleEpisodes,
        staleCues: merged.staleCues,
        staleDeliverables: merged.staleDeliverables,
        warnings: merged.warnings,
    });
}));

/** 可选变更对象清单（前端下拉）：当前项目的 assetRefs / shots / scenes，带名字与 revision。 */
router.get("/api/projects/:id/impact/options", routeHandler((req, res, { params }) => {
    const view = impactView(params.id);
    if (!view) return sendError(res, 404, "项目不存在");
    const revision = view.version ?? null;
    const assetRefs = view.assetRefs.map((ref) => ({
        type: "assetRef",
        id: ref.id,
        role: ref.role || "",
        bindingId: ref.bindingId || null,
        name: ref.metadata?.name || ref.metadata?.title || ref.metadata?.label || ref.bindingId || ref.id,
        revision: ref.revision ?? revision,
        selectedArtifactId: ref.selectedArtifactId ?? null,
    }));
    const shots = [];
    const scenes = [];
    for (const episode of view.episodes) {
        const episodeId = episode.id ?? null;
        for (const scene of episode.scenes ?? []) {
            if (!scene || scene.id === undefined || scene.id === null) continue;
            scenes.push({ type: "scene", id: String(scene.id), episodeId: scene.episodeId ?? episodeId, index: scene.index ?? null, name: scene.title || scene.locationId || String(scene.id), revision: scene.revision ?? revision });
        }
        for (const shot of episode.shots ?? []) {
            if (!shot || shot.id === undefined || shot.id === null) continue;
            shots.push({ type: "shot", id: String(shot.id), episodeId: shot.episodeId ?? episodeId, sceneId: shot.sceneId ?? null, index: shot.index ?? null, name: shot.storyboard?.summary || shot.storyboard?.description || String(shot.id), revision: shot.revision ?? revision });
        }
    }
    const optionLabel = (row) => (row.type === "assetRef" ? `${ASSET_ROLE_LABEL[row.role] || "资产"}：${row.name}` : row.type === "shot" ? `镜头：${row.name}` : `场：${row.name}`);
    const options = [...assetRefs, ...shots, ...scenes].map((row) => ({ type: row.type, id: row.id, label: optionLabel(row), revision: row.revision }));
    sendJson(res, 200, { projectId: view.id, sourceRevisionId: view.sourceRevisionId ?? null, assetRefs, shots, scenes, options });
}));

startupMark("路由注册完成");

const server = createServer(async (req, res) => {
    applyCors(res);
    try {
        const handled = await router.dispatch(req, res);
        if (handled) return;
        if (await serveWebApp(req, res)) return;
        sendError(res, 404, `未找到路由：${req.method} ${req.url}`);
    } catch (error) {
        console.error(`[canvas-server] ${req.method} ${req.url} 失败：${error.stack || error.message}`);
        if (!res.headersSent) sendError(res, 500, error.message);
        else res.end();
    }
});

/**
 * 可选托管前端构建产物：web/dist 存在时，网关同时是画布页面入口，部署只需一个服务。
 * 找不到实体文件时回退 index.html，交给 React Router 处理前端路由。
 */
async function serveWebApp(req, res) {
    if (!webDist || (req.method !== "GET" && req.method !== "HEAD")) return false;
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    // 未命中的 /api/* 绝不能回退 index.html：否则 200 + text/html 会把「路由不存在」伪装成存活
    // （HEAD 探活、反代健康检查恒通过）。交给 server 兜底返回 404 JSON。
    if (pathname === "/api" || pathname.startsWith("/api/")) return false;
    const target = safeJoin(webDist, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (target && existsSync(target) && statSync(target).isFile()) {
        serveFile(req, res, target);
        return true;
    }
    const indexFile = safeJoin(webDist, "index.html");
    // ⚠️ **看起来像静态资源的路径缺失时，必须 404，不能回退 index.html**：
    // 否则一个已被删除的 /assets/index-xxxx.js 会拿到 200 + text/html（浏览器把 HTML 当 JS 执行 → 白屏/卡死），
    // 而且错误被完全掩盖（实测踩到过）。只有"不像是资源"的路径才交给 React Router。
    const looksLikeAsset = /\.[A-Za-z0-9]{2,5}$/.test(pathname) || pathname.startsWith("/assets/");
    if (looksLikeAsset) return false;
    if (indexFile && existsSync(indexFile)) {
        serveFile(req, res, indexFile);
        return true;
    }
    return false;
}

const webDist = (() => {
    const dir = config.webDir ? (config.webDir.startsWith("/") ? config.webDir : resolve(serverRoot, config.webDir)) : resolve(serverRoot, "..", "web", "dist");
    return existsSync(dir) ? dir : null;
})();

if (isMain) {
    // 上次进程被杀时正在跑的阶段会永远停在 running，而 beginStage 拒绝在 running 阶段上重跑，
    // 不收敛就会把那个阶段永久锁死。分块结果仍在 chunks/ 里，可用 resume 续跑。
    startupMark("router 就绪");
    const stale = pipeline.reconcileRunning();
    startupMark("reconcileRunning", stale.length ? `收敛 ${stale.length} 条` : "");
    if (stale.length) console.warn(`[pipeline] 收敛了 ${stale.length} 条上次中断的运行：${stale.join("、")}（阶段标记为 error，分块结果已保留，可 resume 续跑）`);
    server.listen(config.port, config.host, () => {
        startupMark("listen");
        console.log(`canvas-server 已启动：http://${config.host}:${config.port}`);
        console.log(`  LLM  : ${config.llm.baseUrl}`);
        console.log(`  Comfy: ${config.comfy.baseUrl}`);
        console.log(`  配置 : ${config.configPath}`);
        console.log(`  模板 : ${listTemplates(config.workflowsDir).length} 个`);
        console.log(`  前端 : ${webDist || "未构建（web/dist 不存在），仅提供 API"}`);
        // 网关自身没有鉴权，绑定非回环地址等于把「调用你的 LLM 渠道额度与 GPU 产能」开放给整个网段。
        const host = String(config.host || "");
        const loopback = host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
        if (!loopback) {
            console.warn(`  ⚠ 监听 ${host}:${config.port} 不是回环地址，而网关没有鉴权：同网段任何人都能提交生成任务、消耗已注册 LLM 渠道的额度。`);
            console.warn(`    要公网访问请在前置反向代理上加鉴权，或把 host 改回 127.0.0.1 只经本机/隧道访问。`);
        }
        // #68：端口就绪后才做「外部探测预热」与「历史任务重放」——listen 不再等任何上游/重放。
        // 探测预热：并发发起 comfy/runninghub 探测写入缓存，后续 /api/health 读到就绪快照。
        healthProbe.warmAll();
        // 历史重放：后台分批执行（每条 setImmediate 让出事件循环），期间服务全程可应答。
        void replayHistoricalJobs().catch((error) => console.error(`[pipeline] 历史任务重放异常：${error?.message || error}`));
        // M3.5：stalled 续接链启动扫描——「最后一段 done 但链未完成且无在跑段」的链自动续提交（幂等键保证不重复）。
        void continuation.scanStalledChains().then(({ scanned, resumed }) => {
            if (resumed) console.log(`[continuation] stalled 链扫描：${scanned} 条链，续提交 ${resumed} 条`);
        }).catch((error) => console.error(`[continuation] stalled 链扫描异常：${error?.message || error}`));
    });
}

export { server, config, jobs, registry, pipeline, projects, bibles, comfy, llm, local, runJob, submitGeneration, backends, waitForJob, fileSize, artifactUrl, artifacts, healthProbe };

import { createServer } from "node:http";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { loadRegistry } from "./skills.js";
import { createComfyClient, probeComfy, listComfyCapabilities, listTemplates } from "./providers/comfy.js";
import { probeLlm, listLlmModels, forwardToLlm, chat as llmChat, externalProviders } from "./providers/llm.js";
import { createLocalRunner } from "./generate.js";
import { probeRunningHub, listRunningHubModels, runRunningHubJob } from "./providers/runninghub.js";

const config = loadConfig();

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
    listModels: () => listLlmModels(config),
};
const uploads = ensureDir(safeJoin(config.dataDir, "uploads"));

// Project 服务端内核：data/projects/<id>/ 落盘，路由见下方 /api/projects 系列。
const projects = createProjects({ dataDir: config.dataDir });

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

const jobs = createJobQueue({
    dataDir: config.dataDir,
    concurrency: 1,
    label: "canvas-server",
    // Job 落哪台设备由注册表决定（D6）；API / LLM 无本地设备时返回 null。
    resolveDevice: (resourceClass) => registry.listDevices({ resourceClass })[0]?.id || null,
});
const local = createLocalRunner({ config, comfy, jobs });
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

const pipeline = createPipeline({
    config,
    skillsDir: config.skillsDir,
    jobs,
    comfy,
    llm,
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
});
// 订阅一次任务队列的 change 事件：Job 落终态时把产物回写流水线条目；并重放 jobs.json 里的终态任务，
// 让服务重启后能从任务队列重建流水线状态（幂等）。
pipeline.bindJobs();

/** 入队入口：默认本地 ComfyUI，显式传 backend:"runninghub" 时才走云端。提交前按资源类别做 canRun 校验。 */
function submitGeneration(kind, body) {
    const backend = String(body.backend || config.generation.defaultBackend || "local").trim();
    if (backend === "local") {
        const template = String(body.template || "").trim();
        if (!template) throw new Error("缺少 template");
        // 能力不匹配 / 设备不可用时直接拒绝并给出可读原因，绝不静默改走别的设备。
        const verdict = registry.canRun(template);
        if (!verdict.ok) throw new Error(`无法提交${kind === "video" ? "生视频" : "生图"}任务：${verdict.reason}`);
        return local.submit({ ...body, kind });
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
    endpoints: ["/api/health", "/api/backends", "/api/providers", "/api/jobs", "/api/runninghub/models", "/api/pipeline/runs", "/api/projects", "/v1/models", "/v1/chat/completions"],
};

router.get("/api", (req, res) => sendJson(res, 200, serviceInfo));

// 构建了前端就把它当作页面入口，否则退化成服务信息，方便直接 curl 探测。
router.get("/", (req, res) => {
    const index = webDist && safeJoin(webDist, "index.html");
    if (index && existsSync(index)) return serveFile(req, res, index);
    sendJson(res, 200, serviceInfo);
});

router.get("/api/health", async (req, res) => {
    const [llmResult, comfyResult, runninghubResult] = await Promise.all([
        probeLlm(config).catch((error) => ({ ok: false, baseUrl: config.llm.baseUrl, error: error.message })),
        probeComfy(config).catch((error) => ({ ok: false, baseUrl: config.comfy.baseUrl, error: error.message })),
        probeRunningHub({ ...config, runninghub: { ...config.runninghub, timeoutMs: config.runninghub.probeTimeoutMs } }).catch((error) => ({ ok: false, baseUrl: config.runninghub.baseUrl, error: error.message })),
    ]);
    sendJson(res, 200, { ok: llmResult.ok || comfyResult.ok, llm: llmResult, comfy: comfyResult, runninghub: runninghubResult, queue: jobs.counts() });
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
    const [models, capabilities] = await Promise.all([
        listLlmModels(config).catch(() => []),
        listComfyCapabilities(config).catch((error) => ({ templates: listTemplates(config.workflowsDir), models: {}, error: error.message })),
    ]);
    sendJson(res, 200, { llm: { baseUrl: config.llm.baseUrl, models }, comfy: capabilities, backends: backends() });
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

router.get("/api/llm/models", async (req, res) => {
    sendJson(res, 200, { models: await listLlmModels(config).catch(() => []) });
});

// 外部 LLM 渠道注册表：GET 返回脱敏清单（不吐 SK）。
// 写路径按 name **增量 upsert**：不再整车替换，双方（服务端恢复的渠道 / 浏览器自带的渠道）不再互相冲掉对方。
const serializeProviders = () => externalProviders(config).map(({ name, baseUrl, apiKey }) => ({ name, baseUrl, hasKey: Boolean(apiKey) }));

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
            byName.set(name, {
                ...(prev || {}),
                name,
                baseUrl: incomingBase || (prev?.baseUrl || ""),
                apiKey: incomingKey || (prev?.apiKey || ""),
            });
        }
        persistProviders([...byName.values()]);
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
    sendJson(res, 200, { providers: serializeProviders(), removed: name });
});

/**
 * OpenAI 兼容的模型清单。与 /api/providers 的 llm.models 同源（都走 listLlmModels），
 * 因此本地 Ollama 模型与外部渠道模型（「渠道名::模型名」）都会列出；外部模型带前缀即 id。
 * 探测失败（本机不可达、渠道无 Key 或连不上）时宁可少列，也不让列表接口报错或挂住——故兜底为空数组。
 */
router.get("/v1/models", async (req, res) => {
    const models = await listLlmModels(config).catch(() => []);
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
            sendJson(res, 201, { job: submitGeneration(kind, body) });
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
    sendJson(res, 200, {
        jobs: jobs.list({ status: url.searchParams.get("status") || undefined, limit: url.searchParams.get("limit") || undefined }),
    });
});

router.get("/api/jobs/:id", (req, res, { params }) => {
    const job = jobs.get(params.id);
    if (!job) return sendError(res, 404, "任务不存在");
    sendJson(res, 200, { job });
});

router.post("/api/jobs/:id/cancel", async (req, res, { params }) => {
    const job = jobs.cancel(params.id);
    if (!job) return sendError(res, 404, "任务不存在");
    if (job.status === "running" || job.promptId) await comfy.interrupt().catch(() => {});
    sendJson(res, 200, { job: jobs.get(params.id) });
});

router.get("/api/artifacts/:jobId/:filename", (req, res, { params }) => {
    const dir = safeJoin(config.dataDir, "artifacts", params.jobId);
    const file = dir && safeJoin(dir, params.filename);
    if (!file) return sendError(res, 400, "非法路径");
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
 * 逐条重跑（活扣）：只给指定 item 换模型再追加一个候选，不动其它 item、不删旧候选。
 * body `{ itemId, template?, params? }`；模板必须是该阶段同 family 的已有模板。
 * 同步部分做门禁：参数/引用非法（item 不存在、文本阶段、模板非法）→ 400；
 * 阶段或条目正忙（防并发重复入队）→ 409。通过后入队（非阻塞）→ 202，真实生成在任务队列后台跑。
 */
router.post("/api/pipeline/runs/:id/steps/:stage/regenerate", async (req, res, { params }) => {
    try {
        const body = await readJson(req).catch(() => ({}));
        const options = body && typeof body === "object" ? body : {};
        const begun = pipeline.beginRegenerate(params.id, params.stage, options);
        const result = pipeline.executeRegenerate(begun);
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

router.get("/api/projects/:id/context", (req, res, { params, url }) => {
    // 默认轻量形状（保持既有契约）；?include=refs 追加 assetRefs 与 gates（阶段门禁）。
    const context = projects.context(params.id, { includeRefs: url.searchParams.get("include") === "refs" });
    if (!context) return sendError(res, 404, "项目不存在");
    sendJson(res, 200, context);
});

router.get("/api/projects/:id", (req, res, { params }) => {
    const project = projects.get(params.id);
    if (!project) return sendError(res, 404, "项目不存在");
    sendJson(res, 200, { project });
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

router.post("/api/projects/:id/shots/:shotId", routeHandler(async (req, res, { params }) => {
    const { shot } = projects.episodes.updateShot(params.id, params.shotId, await readJson(req));
    sendJson(res, 200, { shot });
}));

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

// 阶段门禁（纯推导）
router.get("/api/projects/:id/gates", routeHandler((req, res, { params }) => {
    const gates = projects.gates(params.id);
    if (!gates) return sendError(res, 404, "项目不存在");
    sendJson(res, 200, { gates });
}));

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
    const target = safeJoin(webDist, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (target && existsSync(target) && statSync(target).isFile()) {
        serveFile(req, res, target);
        return true;
    }
    const indexFile = safeJoin(webDist, "index.html");
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

// 只有被直接执行时才监听端口；被 import（冒烟脚本、测试）时不产生副作用。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    // 上次进程被杀时正在跑的阶段会永远停在 running，而 beginStage 拒绝在 running 阶段上重跑，
    // 不收敛就会把那个阶段永久锁死。分块结果仍在 chunks/ 里，可用 resume 续跑。
    const stale = pipeline.reconcileRunning();
    if (stale.length) console.warn(`[pipeline] 收敛了 ${stale.length} 条上次中断的运行：${stale.join("、")}（阶段标记为 error，分块结果已保留，可 resume 续跑）`);
    server.listen(config.port, config.host, () => {
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
    });
}

export { server, config, jobs, registry, pipeline, projects, comfy, llm, local, runJob, submitGeneration, backends, waitForJob, fileSize, artifactUrl };

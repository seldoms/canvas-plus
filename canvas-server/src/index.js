import { createServer } from "node:http";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

import { loadConfig, serverRoot } from "./config.js";
import { artifactUrl, ensureDir, safeJoin, saveBuffer, sanitizeName, extensionFor, fileSize } from "./files.js";
import { createRouter, readJson, readBody, sendError, sendJson, serveFile, applyCors } from "./http.js";
import { createJobQueue, waitForJob } from "./jobs.js";
import { createPipeline } from "./pipeline.js";
import { loadRegistry } from "./skills.js";
import { createComfyClient, probeComfy, listComfyCapabilities, listTemplates } from "./providers/comfy.js";
import { probeLlm, listLlmModels, forwardToLlm, chat as llmChat } from "./providers/llm.js";
import { createLocalRunner } from "./generate.js";
import { probeRunningHub, listRunningHubModels, runRunningHubJob } from "./providers/runninghub.js";

const config = loadConfig();

const comfy = createComfyClient(config);
const llm = {
    // 流水线不一定指定模型，这里兜底到 pipeline.llmModel / llm.defaultModel，避免把空 model 发给上游。
    chat: (options = {}) => llmChat(config, { ...options, model: options.model || config.pipeline.llmModel || config.llm.defaultModel }),
    listModels: () => listLlmModels(config),
};
const uploads = ensureDir(safeJoin(config.dataDir, "uploads"));

const jobs = createJobQueue({ dataDir: config.dataDir, concurrency: 1, label: "canvas-server" });
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

const pipeline = createPipeline({ config, skillsDir: config.skillsDir, jobs, comfy, llm, runJob });

/** 入队入口：默认本地 ComfyUI，显式传 backend:"runninghub" 时才走云端。 */
function submitGeneration(kind, body) {
    const backend = String(body.backend || config.generation.defaultBackend || "local").trim();
    if (backend === "local") return local.submit({ ...body, kind });

    if (backend !== "runninghub") throw new Error(`未知生成后端：${backend}`);
    if (!config.generation.allowRunningHub) throw new Error("RunningHub 后端已被配置禁用");
    const endpoint = String(body.params?.endpoint || body.endpoint || "").trim();
    if (!endpoint) throw new Error("RunningHub 任务缺少 params.endpoint");
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
    endpoints: ["/api/health", "/api/backends", "/api/providers", "/api/jobs", "/api/runninghub/models", "/api/pipeline/runs", "/v1/models", "/v1/chat/completions"],
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

router.get("/api/pipeline/runs/:id", (req, res, { params }) => {
    const run = pipeline.get(params.id);
    if (!run) return sendError(res, 404, "流水线不存在");
    sendJson(res, 200, { run });
});

router.post("/api/pipeline/runs/:id/steps/:stage/run", async (req, res, { params }) => {
    try {
        sendJson(res, 200, { run: await pipeline.runStage(params.id, params.stage) });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

router.post("/api/pipeline/runs/:id/steps/:stage/input", async (req, res, { params }) => {
    try {
        sendJson(res, 200, { run: pipeline.setStageInput(params.id, params.stage, await readJson(req)) });
    } catch (error) {
        sendError(res, 400, error.message);
    }
});

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
    server.listen(config.port, config.host, () => {
        console.log(`canvas-server 已启动：http://${config.host}:${config.port}`);
        console.log(`  LLM  : ${config.llm.baseUrl}`);
        console.log(`  Comfy: ${config.comfy.baseUrl}`);
        console.log(`  配置 : ${config.configPath}`);
        console.log(`  模板 : ${listTemplates(config.workflowsDir).length} 个`);
        console.log(`  前端 : ${webDist || "未构建（web/dist 不存在），仅提供 API"}`);
    });
}

export { server, config, jobs, pipeline, comfy, llm, local, runJob, submitGeneration, backends, waitForJob, fileSize, artifactUrl };

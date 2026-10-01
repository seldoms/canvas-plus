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
import { createComfyClient, probeComfy, listComfyCapabilities, listTemplates, renderTemplate, extractTokens, disableEmptyLoras, collectOutputs } from "./providers/comfy.js";
import { probeLlm, listLlmModels, forwardToLlm, chat as llmChat } from "./providers/llm.js";

const config = loadConfig();

const comfy = createComfyClient(config);
const llm = {
    // 流水线不一定指定模型，这里兜底到 pipeline.llmModel / llm.defaultModel，避免把空 model 发给上游。
    chat: (options = {}) => llmChat(config, { ...options, model: options.model || config.pipeline.llmModel || config.llm.defaultModel }),
    listModels: () => listLlmModels(config),
};
const uploads = ensureDir(safeJoin(config.dataDir, "uploads"));

const IMAGE_TOKENS = new Set(["PROMPT", "WIDTH", "HEIGHT", "BATCH", "SEED", "OUTPUT_PREFIX", "LORA_FILE", "LORA_STRENGTH", "INPUT_IMAGE", "STEPS", "REALISM_STRENGTH"]);

/** 生图/生视频任务的真实执行体：渲染模板 → 提交 ComfyUI → 轮询 → 回收产物。 */
async function runGenerationJob(job, ctx) {
    const templatePath = safeJoin(config.workflowsDir, `${job.template}.json`);
    if (!templatePath) throw new Error(`非法模板名：${job.template}`);

    const params = { ...job.params };
    params.SEED ??= Math.floor(Math.random() * 2 ** 31);
    params.OUTPUT_PREFIX ??= `canvas/${sanitizeName(job.name || job.id)}`;

    // 模板要求的 token 全部补齐：LoRA 允许缺省，缺省时由 disableEmptyLoras 把 LoRA 节点摘掉，
    // 这样调用方（画布前端）不需要知道该用哪个 lora 文件名。
    for (const token of extractTokens(templatePath)) {
        if (params[token] !== undefined) continue;
        if (token === "LORA_FILE") params[token] = "";
        else if (token === "LORA_STRENGTH") params[token] = 1;
        else throw new Error(`模板 ${job.template} 缺少参数：${token}`);
    }

    // 参考图/参考视频允许传本机绝对路径，统一上传到 ComfyUI 后再写回参数。
    for (const token of ["INPUT_IMAGE", "REF_VIDEO", "PERSON_IMAGE", "CLOTHING_IMAGE", "REF_IMAGE_1", "REF_IMAGE_2", "REF_IMAGE_3"]) {
        if (params[token]) params[token] = await resolveAsset(params[token]);
    }

    const graph = renderTemplate(templatePath, params);
    const removed = disableEmptyLoras(graph);
    if (removed.length) console.log(`[job ${job.id}] 未指定 LoRA，已摘除节点 ${removed.join(", ")}`);
    const promptId = await comfy.queuePrompt(graph);
    ctx.patch({ promptId });
    ctx.progress(0, 0, "已提交");

    const deadline = Date.now() + config.comfy.timeoutMs;
    let entry = null;
    while (Date.now() < deadline) {
        if (ctx.signal.aborted) throw new Error("已取消");
        entry = await comfy.history(promptId);
        if (entry) break;
        const counts = await comfy.queueCounts().catch(() => ({ running: 0, pending: 0 }));
        ctx.progress(0, 0, counts.running ? "生成中" : "排队中");
        await sleep(config.comfy.pollIntervalMs, ctx.signal);
    }
    if (!entry) {
        await comfy.interrupt().catch(() => {});
        throw new Error(`生成超时（${Math.round(config.comfy.timeoutMs / 1000)}s）`);
    }

    const status = entry.status || {};
    if (status.status_str === "error") {
        const detail = (status.messages || []).filter((item) => item[0] === "execution_error");
        throw new Error(detail.length ? JSON.stringify(detail, null, 2) : "ComfyUI 执行失败");
    }

    const outputs = await collectOutputs(entry, job.id, config, comfy);
    if (!outputs.length) throw new Error("ComfyUI 未返回任何产物，请检查模板的输出节点");
    ctx.progress(outputs.length, outputs.length, "已完成");
    return { outputs };
}

async function resolveAsset(value) {
    const text = String(value);
    if (/^https?:\/\//i.test(text)) {
        const response = await fetch(text);
        if (!response.ok) throw new Error(`下载参考素材失败：${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        return comfy.uploadFile(buffer, sanitizeName(text.split("/").pop() || "asset"));
    }
    // 上游阶段回填的产物地址是网关自己的相对路径，直接读本地产物文件，避免依赖 publicUrl 配绝对地址。
    if (text.startsWith("/api/artifacts/")) {
        const segments = text.slice("/api/artifacts/".length).split("/").filter(Boolean);
        const file = safeJoin(config.dataDir, "artifacts", ...segments);
        if (!file) throw new Error(`非法产物地址：${text}`);
        const { readFile } = await import("node:fs/promises");
        const buffer = await readFile(file);
        return comfy.uploadFile(buffer, sanitizeName(segments.pop()));
    }
    if (text.startsWith("comfy:") || !text.includes("/")) return text;
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(text);
    return comfy.uploadFile(buffer, sanitizeName(text.split(/[\\/]/).pop()));
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("已取消"));
        }, { once: true });
    });
}

const jobs = createJobQueue({ dataDir: config.dataDir, concurrency: 1, label: "canvas-server" });
const pipeline = createPipeline({ config, skillsDir: config.skillsDir, jobs, comfy, llm, runJob: runGenerationJob });

function submitGeneration(kind, body) {
    const template = String(body.template || "").trim();
    if (!template) throw new Error("缺少 template");
    const templatePath = safeJoin(config.workflowsDir, `${template}.json`);
    if (!templatePath) throw new Error(`非法模板名：${template}`);
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const params = { ...(body.params || {}) };
    return jobs.enqueue({ id, kind, template, name: body.name || template, params, meta: body.meta }, runGenerationJob);
}

const router = createRouter();

const serviceInfo = {
    name: "canvas-server",
    description: "无限画布本地网关：内网 LLM 与 ComfyUI 生图/生视频统一出口",
    version: "0.1.0",
    endpoints: ["/api/health", "/api/providers", "/api/jobs", "/api/pipeline/runs", "/v1/models", "/v1/chat/completions"],
};

router.get("/api", (req, res) => sendJson(res, 200, serviceInfo));

// 构建了前端就把它当作页面入口，否则退化成服务信息，方便直接 curl 探测。
router.get("/", (req, res) => {
    const index = webDist && safeJoin(webDist, "index.html");
    if (index && existsSync(index)) return serveFile(req, res, index);
    sendJson(res, 200, serviceInfo);
});

router.get("/api/health", async (req, res) => {
    const [llmResult, comfyResult] = await Promise.all([
        probeLlm(config).catch((error) => ({ ok: false, baseUrl: config.llm.baseUrl, error: error.message })),
        probeComfy(config).catch((error) => ({ ok: false, baseUrl: config.comfy.baseUrl, error: error.message })),
    ]);
    sendJson(res, 200, { ok: llmResult.ok || comfyResult.ok, llm: llmResult, comfy: comfyResult, queue: jobs.counts() });
});

router.get("/api/providers", async (req, res) => {
    const [models, capabilities] = await Promise.all([
        listLlmModels(config).catch(() => []),
        listComfyCapabilities(config).catch((error) => ({ templates: listTemplates(config.workflowsDir), models: {}, error: error.message })),
    ]);
    sendJson(res, 200, { llm: { baseUrl: config.llm.baseUrl, models }, comfy: capabilities });
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

export { server, config, jobs, pipeline, comfy, llm, runGenerationJob, submitGeneration, resolveAsset, IMAGE_TOKENS, waitForJob, fileSize, artifactUrl };

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

import { artifactUrl, ensureDir, extensionFor, safeJoin, sanitizeName, saveBuffer } from "../files.js";
import { RUNNINGHUB_MODELS } from "../runninghub-models.js";

const DEFAULT_BASE_URL = "https://www.runninghub.ai/openapi/v2";
/** 官方契约里的非终态与失败终态。 */
const PENDING_STATUS = new Set(["CREATE", "QUEUED", "RUNNING"]);
const FAILED_STATUS = new Set(["FAILED", "CANCEL"]);
/** 提交/上传的瞬态重试：指数退避，最多 3 次。 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
/** Artifact.type 只按任务要求的扩展名判定。 */
const MEDIA_TYPES = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video",
    ".mp3": "audio", ".wav": "audio",
};

function settings(config) {
    const raw = config?.runninghub || {};
    return {
        baseUrl: String(raw.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
        apiKey: String(raw.apiKey || "").trim(),
        pollIntervalMs: Number(raw.pollIntervalMs) > 0 ? Number(raw.pollIntervalMs) : 5000,
        timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 1800000,
    };
}

function apiError(message, errorCode) {
    const error = new Error(message);
    if (errorCode !== undefined && errorCode !== null && String(errorCode) !== "") error.errorCode = String(errorCode);
    return error;
}

/** 上游把业务错误放在 errorCode / code 里；0 与空串都算成功。 */
function businessError(payload) {
    const code = payload?.errorCode ?? payload?.code;
    if (code === undefined || code === null || String(code) === "" || Number(code) === 0) return null;
    const message = payload?.errorMessage || payload?.msg || payload?.message || `错误码 ${code}`;
    return apiError(`RunningHub 返回错误：${message}`, code);
}

/**
 * taskId 直接拼数字字面量：上游按数值解析，而真实 id 会超过 JS 安全整数范围，
 * 走 Number 会丢精度导致查错任务。
 */
function taskIdBody(taskId) {
    const value = String(taskId);
    return /^\d+$/.test(value) ? `{"taskId":${value}}` : JSON.stringify({ taskId: value });
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("已取消"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("已取消"));
        }, { once: true });
    });
}

/**
 * RunningHub OpenAPI v2 客户端。未配置 apiKey 时 `configured` 为 false，
 * 除 probe 外的方法都会直接抛「未配置 RunningHub API Key」，不会发请求。
 */
export function createRunningHubClient(config) {
    const { baseUrl, apiKey, pollIntervalMs, timeoutMs } = settings(config);
    const configured = Boolean(apiKey);

    async function request(path, { method = "POST", body, headers = {}, signal } = {}) {
        if (!configured) throw apiError("未配置 RunningHub API Key");
        let response;
        try {
            response = await fetch(`${baseUrl}${path}`, {
                method,
                headers: { authorization: `Bearer ${apiKey}`, ...headers },
                body,
                signal: signal ?? AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            // 主动取消/超时不重试：submit 超时时任务可能已经创建，重试会重复下单。
            if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
            const wrapped = apiError(`RunningHub 请求失败：${error.message}`);
            wrapped.transient = true;
            throw wrapped;
        }
        const text = await response.text().catch(() => "");
        let payload = null;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = null;
        }
        if (!response.ok) {
            const detail = payload?.errorMessage || payload?.msg || text.slice(0, 200);
            const error = apiError(`RunningHub ${path} 失败：HTTP ${response.status}${detail ? ` ${detail}` : ""}`, payload?.errorCode ?? payload?.code);
            error.status = response.status;
            error.transient = response.status === 429 || response.status >= 500;
            throw error;
        }
        if (payload === null) {
            const error = apiError(`RunningHub ${path} 返回的不是 JSON：${text.slice(0, 200)}`);
            error.transient = true;
            throw error;
        }
        return payload;
    }

    const postJson = (path, body, options = {}) =>
        request(path, { ...options, headers: { "content-type": "application/json", ...options.headers }, body: JSON.stringify(body) });

    /** 瞬态错误（网络 / 429 / 5xx）指数退避重试；确定性错误原样抛出。 */
    async function withRetry(run) {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await run();
            } catch (error) {
                if (!error.transient || attempt >= MAX_ATTEMPTS) throw error;
                await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
            }
        }
    }

    /** 提交生成任务，返回 taskId 字符串。 */
    async function submit(endpoint, payload = {}) {
        if (!endpoint) throw apiError("RunningHub 任务缺少 endpoint");
        const path = `/${String(endpoint).replace(/^\/+/, "")}`;
        const result = await withRetry(() => postJson(path, payload));
        const failure = businessError(result);
        if (failure) throw failure;
        const taskId = result?.taskId ?? result?.task_id;
        if (taskId === undefined || taskId === null || String(taskId) === "") {
            throw apiError(`RunningHub 未返回 taskId：${JSON.stringify(result).slice(0, 200)}`);
        }
        return String(taskId);
    }

    /** 查询任务；errorCode 非空或状态未知都直接抛错，避免死循环。 */
    async function query(taskId) {
        const result = await request("/query", { headers: { "content-type": "application/json" }, body: taskIdBody(taskId) });
        const failure = businessError(result);
        if (failure) throw failure;
        const status = String(result?.status || "").toUpperCase();
        if (FAILED_STATUS.has(status)) {
            const reason = result?.failedReason?.message || result?.failedReason?.reason || result?.errorMessage;
            const detail = reason ? `：${typeof reason === "string" ? reason : JSON.stringify(reason)}` : "";
            throw apiError(`RunningHub 任务${status === "CANCEL" ? "已取消" : "失败"}${detail}`, result?.errorCode);
        }
        if (status && status !== "SUCCESS" && !PENDING_STATUS.has(status)) {
            throw apiError(`RunningHub 未知任务状态：${status}`, result?.errorCode);
        }
        return result;
    }

    /**
     * 取消任务。官方 v2 契约没有列出取消接口，这里按 RunningHub 控制台惯例用 /task/cancel；
     * 取消是尽力而为，调用方应自行 catch。
     */
    function cancel(taskId) {
        return request("/task/cancel", { headers: { "content-type": "application/json" }, body: taskIdBody(taskId) });
    }

    /** 上传本地素材，返回可直接写进 payload 的 download_url。 */
    async function uploadFile(buffer, filename = "upload.bin") {
        const form = new FormData();
        form.append("file", new Blob([buffer]), basename(filename) || "upload.bin");
        const result = await withRetry(() => request("/media/upload/binary", { body: form }));
        const failure = businessError(result);
        if (failure) throw failure;
        const url = result?.data?.download_url;
        if (!url) throw apiError(`RunningHub 上传未返回 download_url：${JSON.stringify(result).slice(0, 200)}`);
        return url;
    }

    async function probe() {
        if (!configured) return { ok: false, baseUrl, error: "未配置 RunningHub API Key" };
        try {
            // 用一个不存在的数值 taskId 探测：能返回 status 字段就说明鉴权与连通性正常。
            const result = await request("/query", { headers: { "content-type": "application/json" }, body: taskIdBody(999999999999999999) });
            const code = String(result?.errorCode ?? result?.code ?? "");
            if (code === "806") return { ok: false, baseUrl, error: "RunningHub API Key 无效", errorCode: code };
            if (code === "1602") return { ok: false, baseUrl, error: "RunningHub 请求缺少 API Key", errorCode: code };
            if (!Object.hasOwn(result, "status")) {
                return { ok: false, baseUrl, error: `RunningHub 探测响应异常：${JSON.stringify(result).slice(0, 200)}`, errorCode: code || undefined };
            }
            return { ok: true, baseUrl, status: String(result.status || "") };
        } catch (error) {
            return { ok: false, baseUrl, error: error.message, errorCode: error.errorCode };
        }
    }

    /** 本地模型目录，不请求上游（RunningHub 未提供稳定的模型列表接口）。 */
    const listModels = () => listRunningHubModels();

    return { configured, probe, listModels, uploadFile, submit, query, cancel };
}

export async function probeRunningHub(config) {
    return createRunningHubClient(config).probe();
}

/** RunningHub 可选模型目录，与 README 的 `{ image, video }` 契约一致。 */
export function listRunningHubModels() {
    return { image: RUNNINGHUB_MODELS.image, video: RUNNINGHUB_MODELS.video };
}

/**
 * 把 results 里的远端结果下载并落盘到 data/artifacts/<jobId>/，返回与本地链路一致的 Artifact[]。
 * 取值顺序：URL 结果 url / outputUrl，文本结果 text / content / output。
 */
export async function collectRunningHubOutputs(results, jobId, config) {
    const dir = ensureDir(join(config.dataDir, "artifacts", jobId));
    const artifacts = [];

    const uniqueName = (filename) => {
        if (!artifacts.some((item) => item.filename === filename)) return filename;
        const ext = extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        let index = 2;
        while (artifacts.some((item) => item.filename === `${stem}-${index}${ext}`)) index += 1;
        return `${stem}-${index}${ext}`;
    };

    for (const item of results || []) {
        const url = item?.url || item?.outputUrl;
        if (url) {
            const response = await fetch(String(url));
            if (!response.ok) throw new Error(`下载 RunningHub 产物失败：HTTP ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const fromUrl = sanitizeName(basename(new URL(String(url), "http://localhost").pathname), jobId);
            const filename = uniqueName(extname(fromUrl) ? fromUrl : `${fromUrl}${extensionFor("", response.headers.get("content-type"))}`);
            await saveBuffer(join(dir, filename), buffer);
            artifacts.push({
                filename,
                url: artifactUrl(config, jobId, filename),
                type: MEDIA_TYPES[extname(filename).toLowerCase()] || "file",
                bytes: buffer.length,
            });
            continue;
        }
        const text = [item?.text, item?.content, item?.output].find((value) => typeof value === "string" && value);
        if (text !== undefined) {
            const filename = uniqueName(`${jobId}.txt`);
            await saveBuffer(join(dir, filename), Buffer.from(text, "utf8"));
            artifacts.push({ filename, url: artifactUrl(config, jobId, filename), type: "file", bytes: Buffer.byteLength(text) });
        }
    }
    return artifacts;
}

/** 与 runGenerationJob 同签名；config 省略时按当前环境加载配置。 */
export async function runRunningHubJob(job, ctx = {}, config = null) {
    const params = { ...(job.params || {}) };
    const endpoint = String(params.endpoint || "").trim();
    if (!endpoint) throw new Error("RunningHub 任务缺少 endpoint");
    delete params.endpoint;
    config ??= (await import("../config.js")).loadConfig();

    const client = createRunningHubClient(config);
    const { pollIntervalMs, timeoutMs } = settings(config);

    /** 本机绝对路径或网关托管产物先上传，其余值原样返回。 */
    const uploadLocalAsset = async (value) => {
        if (value.startsWith("/api/artifacts/")) {
            const segments = value.slice("/api/artifacts/".length).split("/").filter(Boolean);
            const file = safeJoin(config.dataDir, "artifacts", ...segments);
            if (!file) throw new Error(`非法产物地址：${value}`);
            return client.uploadFile(await readFile(file), sanitizeName(segments[segments.length - 1]));
        }
        if (!isAbsolute(value) || !existsSync(value)) return value;
        return client.uploadFile(await readFile(value), sanitizeName(basename(value)));
    };

    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
            const uploaded = [];
            for (const item of value) uploaded.push(typeof item === "string" ? await uploadLocalAsset(item) : item);
            params[key] = uploaded;
        } else if (typeof value === "string") {
            params[key] = await uploadLocalAsset(value);
        }
    }

    const taskId = await client.submit(endpoint, params);
    ctx.patch?.({ promptId: taskId });
    ctx.progress?.(0, 0, "已提交");

    const deadline = Date.now() + timeoutMs;
    let result = null;
    try {
        for (;;) {
            if (ctx.signal?.aborted) throw new Error("已取消");
            const current = await client.query(taskId);
            const status = String(current?.status || "").toUpperCase();
            if (status === "SUCCESS") {
                result = current;
                break;
            }
            ctx.progress?.(0, 0, status === "RUNNING" ? "生成中" : "排队中");
            if (Date.now() > deadline) throw new Error(`RunningHub 生成超时（${Math.round(timeoutMs / 1000)}s），taskId=${taskId}`);
            await sleep(pollIntervalMs, ctx.signal);
        }
    } catch (error) {
        if (ctx.signal?.aborted) {
            await client.cancel(taskId).catch(() => {});
            throw new Error("已取消");
        }
        throw error;
    }

    const outputs = await collectRunningHubOutputs(result?.results || [], job.id, config);
    if (!outputs.length) throw new Error("RunningHub 未返回任何产物");
    ctx.progress?.(outputs.length, outputs.length, "已完成");
    return { outputs };
}

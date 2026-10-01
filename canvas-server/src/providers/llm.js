import { applyCors, readBody, sendError } from "../http.js";

/** 实际生效的 LLM 地址，probe 结果对外暴露它。 */
let lastGood = "";

function trimBase(baseUrl) {
    return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/** 与前端 buildApiUrl 一致：结尾不是 /v1 就补上 /v1。 */
function apiBase(baseUrl) {
    const base = trimBase(baseUrl);
    return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

/** Ollama 原生的 /api/tags 挂在站点根下，需要去掉尾部 /v1。 */
function rootBase(baseUrl) {
    return trimBase(baseUrl).replace(/\/v1$/i, "");
}

/** 主地址优先，其后按配置顺序是 fallbacks。 */
function candidates(config) {
    const list = [config?.llm?.baseUrl, ...(config?.llm?.fallbacks || [])];
    return [...new Set(list.map(trimBase).filter(Boolean))];
}

function timeoutMs(config) {
    return Number(config?.llm?.timeoutMs) > 0 ? Number(config.llm.timeoutMs) : 600000;
}

/** 有 API Key 才带鉴权头；任何日志都不要输出它。 */
function headers(config, contentType = "application/json") {
    const apiKey = String(config?.llm?.apiKey || "").trim();
    return { "content-type": contentType, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

/** 探测失败一律返回 null，由调用方决定换地址还是报错。 */
async function getJson(url, config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs(config));
    try {
        const response = await fetch(url, { headers: headers(config), signal: controller.signal });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function pickNames(payload, listKeys) {
    const names = [];
    for (const key of listKeys) {
        for (const item of payload?.[key] || []) names.push(item?.id || item?.name || item?.model);
    }
    return names.filter(Boolean).map(String);
}

/** 同一地址同时探测 OpenAI `/v1/models` 与 Ollama 原生 `/api/tags`，合并去重。 */
async function modelsAt(baseUrl, config) {
    const openai = await getJson(`${apiBase(baseUrl)}/models`, config);
    const ollama = await getJson(`${rootBase(baseUrl)}/api/tags`, config);
    return [...new Set([...pickNames(openai, ["data", "models"]), ...pickNames(ollama, ["models"])])];
}

export async function listLlmModels(config) {
    const bases = candidates(config);
    for (const baseUrl of bases) {
        const models = await modelsAt(baseUrl, config);
        if (models.length) {
            lastGood = baseUrl;
            return models;
        }
    }
    throw new Error(`LLM 服务不可达或没有模型，已尝试：${bases.join("、") || "（未配置 baseUrl）"}`);
}

export async function probeLlm(config) {
    try {
        const models = await listLlmModels(config);
        return { ok: true, baseUrl: lastGood, models };
    } catch (error) {
        return { ok: false, baseUrl: trimBase(config?.llm?.baseUrl), error: error.message };
    }
}

/** `/v1/chat/completions?x=1` → `/chat/completions?x=1`，避免拼出 /v1/v1。 */
function normalizePath(pathWithQuery) {
    const raw = String(pathWithQuery || "");
    const withQuery = raw.startsWith("/") ? raw : `/${raw}`;
    return withQuery.replace(/^\/v1(?=\/|\?|$)/i, "") || "/";
}

/**
 * 原样转发到上游并逐块透传响应体（SSE 不缓冲），保持前端可边收边渲染。
 * 只有「连接都没建立」时才换下一个 fallback；已开始回包后不再重试。
 */
export async function forwardToLlm(incomingReq, outgoingRes, config, pathWithQuery) {
    const method = String(incomingReq.method || "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(incomingReq);
    const contentType = incomingReq.headers?.["content-type"] || "application/json";
    let started = false;
    let lastError;

    for (const baseUrl of candidates(config)) {
        const url = `${apiBase(baseUrl)}${normalizePath(pathWithQuery)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs(config));
        try {
            const upstream = await fetch(url, {
                method,
                headers: { ...headers(config, contentType), ...(body ? { "content-length": String(body.length) } : {}) },
                body,
                signal: controller.signal,
            });
            lastGood = baseUrl;
            started = true;
            applyCors(outgoingRes);
            outgoingRes.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8" });
            if (!upstream.body) {
                outgoingRes.end();
                return;
            }
            for await (const chunk of upstream.body) outgoingRes.write(chunk);
            outgoingRes.end();
            return;
        } catch (error) {
            if (started) {
                outgoingRes.end();
                return;
            }
            lastError = error;
        } finally {
            clearTimeout(timer);
        }
    }
    sendError(outgoingRes, 502, `LLM 服务不可达，已尝试：${candidates(config).join("、")}（${lastError?.message || "未知错误"}）`);
}

/**
 * 流水线编排用的非流式便捷调用。stream 参数保留以兼容调用方签名，
 * 这里固定走非流式；需要流式请走 forwardToLlm。
 */
export async function chat(config, { messages, model, stream, temperature, ...rest } = {}) {
    const target = model || config?.llm?.defaultModel || "";
    if (!target) throw new Error("LLM 调用缺少 model：请在参数或 config.llm.defaultModel 中指定模型");
    const payload = JSON.stringify({ messages, model: target, temperature, ...rest, stream: false });
    const bases = candidates(config);
    let lastError;

    for (const baseUrl of bases) {
        const url = `${apiBase(baseUrl)}/chat/completions`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs(config));
        try {
            const response = await fetch(url, { method: "POST", headers: headers(config), body: payload, signal: controller.signal });
            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                const error = new Error(`LLM 请求失败：${url} 返回 ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
                error.httpStatus = response.status;
                throw error;
            }
            lastGood = baseUrl;
            return await response.json();
        } catch (error) {
            if (error.httpStatus) throw error;
            // 连接层失败没有状态码，带上 cause.code（如 ECONNREFUSED）更有助排查。
            lastError = error.cause?.code ? `${error.message}（${error.cause.code}）` : error.message;
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`LLM 服务不可达，已尝试：${bases.join("、")}（${lastError || "未知错误"}）`);
}

/** 给服务端注入用：把 config 绑好后可直接挂到路由。 */
export function createLlmProvider(config) {
    return {
        config,
        probe: () => probeLlm(config),
        listModels: () => listLlmModels(config),
        forward: (req, res, pathWithQuery) => forwardToLlm(req, res, config, pathWithQuery),
        chat: (options) => chat(config, options),
    };
}

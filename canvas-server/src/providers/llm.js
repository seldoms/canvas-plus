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

/** 网关侧注册的外部 LLM 渠道（config.llm.providers 或由 /api/llm/providers 热更新）。 */
export function externalProviders(config) {
    const list = Array.isArray(config?.llm?.providers) ? config.llm.providers : [];
    return list
        .map((item) => ({ name: String(item?.name || "").trim(), baseUrl: trimBase(item?.baseUrl), apiKey: String(item?.apiKey || "") }))
        .filter((item) => item.name && item.baseUrl);
}

/** 主地址优先，其后按配置顺序是 fallbacks。 */
function candidates(config) {
    const list = [config?.llm?.baseUrl, ...(config?.llm?.fallbacks || [])];
    return [...new Set(list.map(trimBase).filter(Boolean))];
}

function timeoutMs(config) {
    return Number(config?.llm?.timeoutMs) > 0 ? Number(config.llm.timeoutMs) : 600000;
}

/** 列模型探测的超时，默认 8 秒。与 timeoutMs 分开：后者是给长思考 chat 的，不能用来卡住探活接口。 */
function probeTimeoutMs(config) {
    return Number(config?.llm?.probeTimeoutMs) > 0 ? Number(config.llm.probeTimeoutMs) : 8000;
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

/** 同一地址并行探测 OpenAI `/v1/models` 与 Ollama 原生 `/api/tags`，合并去重。用短超时，任一端点失败只当作没有模型。 */
async function modelsAt(baseUrl, config) {
    const scoped = { ...config, llm: { ...config?.llm, timeoutMs: probeTimeoutMs(config) } };
    const [openai, ollama] = await Promise.all([
        getJson(`${apiBase(baseUrl)}/models`, scoped),
        getJson(`${rootBase(baseUrl)}/api/tags`, scoped),
    ]);
    return [...new Set([...pickNames(openai, ["data", "models"]), ...pickNames(ollama, ["models"])])];
}

export async function listLlmModels(config) {
    const bases = candidates(config);
    let models = [];
    for (const baseUrl of bases) {
        models = await modelsAt(baseUrl, config);
        if (models.length) {
            lastGood = baseUrl;
            break;
        }
    }
    if (!models.length && !externalProviders(config).length) {
        throw new Error(`LLM 服务不可达或没有模型，已尝试：${bases.join("、") || "（未配置 baseUrl）"}`);
    }
    // 外部渠道的模型以「渠道名::模型名」命名空间列出，chat 按此前缀路由。
    // 必须并行探测：串行时一个连不上的渠道会把 /api/health 和前端模型下拉一起拖住几十分钟。
    const providers = externalProviders(config);
    const remotes = await Promise.all(
        providers.map((provider) =>
            modelsAt(provider.baseUrl, { ...config, llm: { ...config.llm, baseUrl: provider.baseUrl, apiKey: provider.apiKey } }),
        ),
    );
    providers.forEach((provider, index) => {
        const remote = remotes[index];
        if (!remote.length) {
            console.warn(`[llm] 外部渠道「${provider.name}」(${provider.baseUrl}) 在 ${Math.round(probeTimeoutMs(config) / 1000)}s 内未返回模型，本次跳过`);
        }
        for (const name of remote) models.push(`${provider.name}::${name}`);
    });
    return [...new Set(models)];
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
 * 模型名带「渠道名::模型名」前缀时路由到 config.llm.providers 里的外部渠道；
 * options.provider = { baseUrl, apiKey } 也可临时指定渠道（仅本次调用，不落盘）。
 * options.signal 是外部取消信号（流水线阶段取消用），与内部超时共用一个 AbortController。
 */
export async function chat(config, { messages, model, stream, temperature, provider, signal, ...rest } = {}) {
    if (signal?.aborted) throw new Error("已取消");
    let effective = config;
    let target = model || "";
    if (provider?.baseUrl) {
        effective = { ...config, llm: { baseUrl: provider.baseUrl, apiKey: String(provider.apiKey || ""), timeoutMs: config?.llm?.timeoutMs } };
    } else if (target.includes("::")) {
        const sep = target.indexOf("::");
        const name = target.slice(0, sep);
        const found = externalProviders(config).find((item) => item.name === name);
        if (!found) throw new Error(`未注册的外部 LLM 渠道：${name}（请先在 /api/llm/providers 注册）`);
        effective = { ...config, llm: { baseUrl: found.baseUrl, apiKey: found.apiKey, timeoutMs: config?.llm?.timeoutMs } };
        target = target.slice(sep + 2);
    }
    if (!target) target = effective?.llm?.defaultModel || "";
    if (!target) throw new Error("LLM 调用缺少 model：请在参数或 config.llm.defaultModel 中指定模型");
    const payload = JSON.stringify({ messages, model: target, temperature, ...rest, stream: false });
    const bases = candidates(effective);
    let lastError;

    for (const baseUrl of bases) {
        const url = `${apiBase(baseUrl)}/chat/completions`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs(effective));
        // 外部取消与内部超时共用一个 controller，取消能立刻打断在途请求而不用等超时
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const response = await fetch(url, { method: "POST", headers: headers(effective), body: payload, signal: controller.signal });
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
            // 用户取消必须立刻终止，不能当成连接失败去试下一个 fallback，
            // 否则一次取消会把 bases 里每个地址都打一遍。
            if (signal?.aborted) throw new Error("已取消");
            // 连接层失败没有状态码，带上 cause.code（如 ECONNREFUSED）更有助排查。
            lastError = error.cause?.code ? `${error.message}（${error.cause.code}）` : error.message;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
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

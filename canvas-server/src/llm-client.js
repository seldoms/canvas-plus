/**
 * llm-client.js —— 服务端 LLM 客户端（提示词策略层的「语言适配」真实出口）。
 *
 * 为什么单独成模块：提示词编译器（prompt-compiler.js / prompt-rewriter.js）只产出「改写计划」，
 * 真正发请求的那一步由调用方**注入 `llmCall`** 完成，模块内绝不发网络请求。这里就是那条出口。
 *
 * 零依赖；**用 node:https / node:http，不用 fetch**。Node 内置 fetch 跑在 undici 上，硬编码
 * `headersTimeout = 300s`：非流式长生成时上游必须把整段回复生成完才发响应头，一旦超过 5 分钟，
 * undici 先报 `UND_ERR_HEADERS_TIMEOUT`，业务层 timeoutMs 根本轮不到生效。原生 http 没有这个默认值，
 * 超时完全交给 AbortController（`http.request` 原生支持 `signal` 取消）。
 *
 * 渠道路由：默认读服务端渠道表 `data/llm-providers.json` 里 `name === 'deepseek'` 的 baseUrl + apiKey，
 * 模型默认 `deepseek-flash`（可用参数 `model` 或环境变量 `CANVAS_LLM_MODEL` 覆盖成 `deepseek-v4-pro`）。
 *
 * 出口契约（冻结）：
 *   callLlm({ system, user, maxTokens = 8192, timeoutMs = 120000, temperature = 0.3, model?, provider? })
 *     → { text, model, finishReason, chars, usage? }
 *   失败保底抛带 `code` 的错误：
 *     'llm_unavailable' | 'llm_timeout' | 'llm_canceled' | 'llm_http_<status>' | 'llm_empty'
 *   llmCall({ system, user })  —— 适配 prompt-rewriter 的注入签名，返回 string。
 *     拿不到可用内容（空 / finish_reason=length 截断）时**抛错**，绝不静默回退（截断 bug 会被掩盖）。
 *
 * ⚠️ 推理模型的输出预算 = 隐藏推理 tokens + 正文，都算在 max_tokens 里（实测 reasoning 占 50~85%）：
 *    默认给足 8192，4096 会把正文挤成 243 字甚至空字符串（finish_reason=length）。
 */

import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 服务端渠道表默认路径（canvas-server/data/llm-providers.json）。 */
export const DEFAULT_PROVIDERS_FILE = fileURLToPath(new URL("../data/llm-providers.json", import.meta.url));

/** 默认渠道名与默认模型（语言适配统一走 DeepSeek）。 */
export const DEFAULT_PROVIDER = "deepseek";
export const DEFAULT_MODEL = process.env.CANVAS_LLM_MODEL || "deepseek-flash";

/** 云端长内容默认超时：给足 120s；此前踩过「以为模型慢、其实是客户端 transport 超时」的坑。 */
export const DEFAULT_TIMEOUT_MS = 120000;

/** 带错误码的客户端错误，便于调用方按 code 分支（取消 / 超时 / 上游状态码 / 空返回）。 */
export class LlmError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.name = "LlmError";
        this.code = code;
        Object.assign(this, extra);
    }
}

/** 渠道表路径：优先显式 file，其次 CANVAS_SERVER_DATA_DIR/llm-providers.json（临时实例隔离用），最后默认。 */
export function providersFilePath({ file, dataDir } = {}) {
    if (file) return file;
    const dir = dataDir || process.env.CANVAS_SERVER_DATA_DIR;
    if (dir) {
        const candidate = join(dir, "llm-providers.json");
        if (existsSync(candidate)) return candidate;
    }
    return DEFAULT_PROVIDERS_FILE;
}

/** 读渠道表 → providers 数组；文件缺失/损坏一律返回空数组（不抛，由调用方报「渠道缺失」）。 */
export function loadProviders({ file, dataDir } = {}) {
    try {
        const raw = JSON.parse(readFileSync(providersFilePath({ file, dataDir }), "utf8"));
        return Array.isArray(raw?.providers) ? raw.providers : [];
    } catch {
        return [];
    }
}

/** 按 name 精确查渠道（返回规整后的 { name, baseUrl, apiKey }）；查不到返回 null。 */
export function findProvider(name = DEFAULT_PROVIDER, { file, dataDir } = {}) {
    const target = String(name || "").trim();
    const found = loadProviders({ file, dataDir }).find((item) => String(item?.name || "").trim() === target);
    if (!found || !String(found.baseUrl || "").trim()) return null;
    return { name: target, baseUrl: String(found.baseUrl).trim().replace(/\/+$/, ""), apiKey: String(found.apiKey || "") };
}

/** baseUrl 规整：结尾不是 /v1 就补上（与 providers/llm.js 同口径；DeepSeek 走 OpenAI 兼容的 /v1）。 */
function apiBase(baseUrl) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

/** 有 apiKey 才带鉴权头；任何日志都不要输出它。 */
function authHeaders(apiKey) {
    const key = String(apiKey || "").trim();
    return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

/** 超时文案：>=1000ms 用秒，否则用毫秒。 */
function limitText(ms) {
    return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/**
 * 用 node:http(s) 发 POST 并读回完整响应体（对齐 fetch Response 子集：status/ok/text）。
 * 原生 http 没有默认 header/socket 超时，`signal` 由 http 原生支持——取消即 `request.destroy()`。
 */
function postJson(url, { headers, body, signal }) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (error) {
            reject(error);
            return;
        }
        const request = (target.protocol === "https:" ? https : http).request(
            target,
            { method: "POST", headers, signal },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, text });
                });
            },
        );
        request.on("error", reject);
        request.end(body);
    });
}

/** 解析渠道：provider 优先对象（临时渠道，不落盘），其次字符串名（查渠道表），都不给走默认渠道参数。 */
function resolveChannel({ provider, baseUrl, apiKey, file, dataDir } = {}) {
    if (provider && typeof provider === "object") {
        const url = String(provider.baseUrl || "").trim();
        if (!url) return null;
        return { name: String(provider.name || "provider"), baseUrl: url.replace(/\/+$/, ""), apiKey: String(provider.apiKey || ""), model: provider.model };
    }
    if (baseUrl) return { name: String(provider || "provider"), baseUrl: String(baseUrl).trim().replace(/\/+$/, ""), apiKey: String(apiKey || ""), model: undefined };
    const name = typeof provider === "string" && provider.trim() ? provider.trim() : DEFAULT_PROVIDER;
    return findProvider(name, { file, dataDir });
}

/** system/user 或 messages 归一成 OpenAI messages 数组。 */
function buildMessages({ system, user, messages }) {
    if (Array.isArray(messages) && messages.length) return messages;
    const out = [];
    if (typeof system === "string" && system.trim()) out.push({ role: "system", content: system });
    out.push({ role: "user", content: typeof user === "string" ? user : String(user ?? "") });
    return out;
}

/**
 * 调用 OpenAI 兼容 `/chat/completions`（非流式）。
 * @returns {Promise<{text:string, model:string, finishReason:string|null, chars:number, usage:object|null}>}
 */
export async function callLlm({
    system,
    user,
    messages,
    maxTokens = 8192,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = 0.3,
    model,
    provider,
    baseUrl,
    apiKey,
    file,
    dataDir,
    signal,
} = {}) {
    if (signal?.aborted) throw new LlmError("llm_canceled", "LLM 调用已取消");

    const channel = resolveChannel({ provider, baseUrl, apiKey, file, dataDir });
    if (!channel?.baseUrl) {
        const name = typeof provider === "string" && provider.trim() ? provider.trim() : DEFAULT_PROVIDER;
        throw new LlmError("llm_unavailable", `LLM 渠道不可用：渠道表里找不到「${name}」（或缺少 baseUrl）`);
    }

    const targetModel = String(model || channel.model || DEFAULT_MODEL).trim();
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const url = `${apiBase(channel.baseUrl)}/chat/completions`;
    const body = JSON.stringify({
        model: targetModel,
        messages: buildMessages({ system, user, messages }),
        stream: false,
        temperature,
        max_tokens: Math.max(1, Number(maxTokens) || 8192),
    });

    // 内部超时与外部取消共用一个 controller：先置 timedOut 再 abort，catch 里据此区分「超时」与「取消」。
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, limit);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let response;
    try {
        response = await postJson(url, { headers: authHeaders(channel.apiKey), body, signal: controller.signal });
    } catch (error) {
        // 顺序：先判「用户取消」，再判「内部超时」，最后才是连接层失败（错误码 fetch 藏在 cause.code、node:http 直接是 code）。
        if (signal?.aborted) throw new LlmError("llm_canceled", "LLM 调用已取消");
        if (timedOut) throw new LlmError("llm_timeout", `LLM 超过 ${limitText(limit)} 未响应`, { timeoutMs: limit });
        const code = error?.cause?.code || error?.code;
        throw new LlmError("llm_unavailable", `LLM 请求失败：${url}（${code || error?.message || "未知错误"}）`, { cause: error });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok) {
        const detail = String(response.text || "").slice(0, 300);
        throw new LlmError(`llm_http_${response.status}`, `LLM 请求失败：${url} 返回 ${response.status}${detail ? ` ${detail}` : ""}`, {
            httpStatus: response.status,
        });
    }

    let payload;
    try {
        payload = JSON.parse(response.text);
    } catch {
        throw new LlmError("llm_empty", `LLM 返回不是合法 JSON：${url}`, { raw: String(response.text || "").slice(0, 300) });
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const content = choice?.message?.content;
    if (typeof content !== "string") {
        throw new LlmError("llm_empty", `LLM 返回缺少 message.content：${url}`, { finishReason: choice?.finish_reason ?? null });
    }

    return { text: content, model: targetModel, finishReason: choice?.finish_reason ?? null, chars: content.length, usage: payload.usage ?? null };
}

/**
 * 适配 prompt-rewriter 注入签名的便捷出口：返回 string。
 * **拿不到可用内容时抛错**（空内容 / finish_reason=length 截断）——绝不静默回退原稿，否则截断 bug 会被掩盖。
 */
export async function llmCall(options = {}) {
    const result = await callLlm(options);
    if (!result.text || !result.text.trim()) {
        throw new LlmError("llm_empty", `LLM 返回空内容（finish_reason=${result.finishReason}, chars=${result.chars}）`, {
            finishReason: result.finishReason,
            chars: result.chars,
        });
    }
    if (result.finishReason === "length") {
        throw new LlmError("llm_truncated", `LLM 输出被截断（finish_reason=length, chars=${result.chars}）——预算不足，拒绝使用残缺稿`, {
            finishReason: result.finishReason,
            chars: result.chars,
        });
    }
    return result.text;
}

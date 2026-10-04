import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { buildApiUrl, withLocalProxy, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };

export type PluginHttpOptions = {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    responseType?: "json" | "blob" | "text" | "arraybuffer";
};

export type PluginHttp = {
    url: (path: string) => string;
    post: (path: string, body?: unknown, options?: PluginHttpOptions) => Promise<unknown>;
    get: (path: string, options?: PluginHttpOptions) => Promise<unknown>;
};

export type PluginPollOptions = { intervalMs?: number; timeoutMs?: number };

export type RunPluginArgs = {
    capability: ModelCapability;
    script: string;
    config: AiConfig;
    prompt?: string;
    images?: string[];
    videos?: File[];
    audios?: File[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

function pluginHeaders(extra?: Record<string, string>, hasJsonBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasJsonBody) headers["Content-Type"] = "application/json";
    return { ...headers, ...extra };
}

function pluginUrl(config: AiConfig, path: string) {
    if (/^https?:/i.test(path)) return withLocalProxy(path);
    return buildApiUrl(config.baseUrl, path.startsWith("/") ? path : `/${path}`);
}

function createPluginHttp(config: AiConfig, options?: RequestOptions): PluginHttp {
    const run = async (method: "get" | "post", path: string, body: unknown, opts?: PluginHttpOptions) => {
        const isForm = typeof FormData !== "undefined" && body instanceof FormData;
        const response = await axios.request({
            method,
            url: pluginUrl(config, path),
            data: method === "post" ? body : undefined,
            params: opts?.params,
            headers: pluginHeaders({ Authorization: `Bearer ${config.apiKey}`, ...opts?.headers }, method === "post" && !isForm && body !== undefined),
            responseType: opts?.responseType || "json",
            signal: options?.signal,
        });
        return response.data;
    };
    return {
        url: (path) => pluginUrl(config, path),
        post: (path, body, opts) => run("post", path, body, opts),
        get: (path, opts) => run("get", path, undefined, opts),
    };
}

/** Raw request with no automatic auth header — the script controls method, url, headers, body entirely. */
function createPluginRequest(config: AiConfig, options?: RequestOptions) {
    return async (requestConfig: AxiosRequestConfig & { url: string }) => {
        const response = await axios.request({ ...requestConfig, url: pluginUrl(config, requestConfig.url), signal: options?.signal });
        return response.data;
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function createPoll(signal?: AbortSignal) {
    return async function poll<T, R>(request: () => Promise<T>, extract: (value: T) => R | null | undefined | false, options?: PluginPollOptions): Promise<R> {
        const intervalMs = options?.intervalMs ?? 2500;
        const timeoutMs = options?.timeoutMs ?? 300000;
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const result = extract(await request());
            if (result !== null && result !== undefined && result !== false) return result;
            if (performance.now() >= deadline) throw new Error(i18n.t("modelPlugin.pollTimeout"));
            await sleep(intervalMs, signal);
        }
    };
}

/**
 * Run a user-authored model call script. Locals are injected (see PLUGIN_VARIABLES); templates wrap them in an async function.
 * The script still runs as an async function body and must `return` the result.
 */
export async function runModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    const { config } = args;
    const http = createPluginHttp(config, { signal: args.signal });
    const request = createPluginRequest(config, { signal: args.signal });
    const poll = createPoll(args.signal);
    const runner = new Function(
        "prompt",
        "images",
        "videos",
        "audios",
        "messages",
        "params",
        "model",
        "baseUrl",
        "apiKey",
        "systemPrompt",
        "reasoningEffort",
        "http",
        "request",
        "poll",
        "sleep",
        "signal",
        "onDelta",
        `"use strict"; return (async () => {\n${args.script}\n})();`,
    ) as (...fnArgs: unknown[]) => Promise<T>;
    try {
        return await runner(
            args.prompt || "",
            args.images || [],
            args.videos || [],
            args.audios || [],
            args.messages || [],
            args.params || {},
            config.model,
            config.baseUrl,
            config.apiKey,
            config.systemPrompt || "",
            config.reasoningEffort,
            http,
            request,
            poll,
            (ms: number) => sleep(ms, args.signal),
            args.signal,
            args.onDelta,
        );
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isCancel(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(i18n.t("modelPlugin.executionFailed", { message }));
    }
}

export type PluginVariable = { name: string; type: string; desc: string; capabilities?: ModelCapability[] };

/** Documentation surface shown in the script editor. */
export function getPluginVariables(): PluginVariable[] {
    return [
        { name: "prompt", type: "string", desc: i18n.t("modelPlugin.variables.prompt"), capabilities: ["image", "video", "audio"] },
        { name: "images", type: "string[]", desc: i18n.t("modelPlugin.variables.images"), capabilities: ["image", "video"] },
        { name: "videos", type: "File[]", desc: i18n.t("modelPlugin.variables.videos"), capabilities: ["video"] },
        { name: "audios", type: "File[]", desc: i18n.t("modelPlugin.variables.audios"), capabilities: ["video"] },
        { name: "messages", type: "{ role, content }[]", desc: i18n.t("modelPlugin.variables.messages"), capabilities: ["text"] },
        { name: "params", type: "object", desc: i18n.t("modelPlugin.variables.params") },
        { name: "model", type: "string", desc: i18n.t("modelPlugin.variables.model") },
        { name: "baseUrl", type: "string", desc: i18n.t("modelPlugin.variables.baseUrl") },
        { name: "apiKey", type: "string", desc: i18n.t("modelPlugin.variables.apiKey") },
        { name: "systemPrompt", type: "string", desc: i18n.t("modelPlugin.variables.systemPrompt") },
        { name: "reasoningEffort", type: '"auto" | "low" | "medium" | "high" | "xhigh"', desc: i18n.t("modelPlugin.variables.reasoningEffort"), capabilities: ["text"] },
        { name: "http", type: "object", desc: i18n.t("modelPlugin.variables.http") },
        { name: "request", type: "function", desc: i18n.t("modelPlugin.variables.request") },
        { name: "poll", type: "function", desc: i18n.t("modelPlugin.variables.poll") },
        { name: "sleep", type: "function", desc: i18n.t("modelPlugin.variables.sleep") },
        { name: "signal", type: "AbortSignal", desc: i18n.t("modelPlugin.variables.signal") },
        { name: "onDelta", type: "function", desc: i18n.t("modelPlugin.variables.onDelta"), capabilities: ["text"] },
    ];
}

export function getPluginReturn(capability: ModelCapability) {
    return i18n.t(`modelPlugin.returns.${capability}`);
}

export function getPluginAuthoringPrompt(capability: ModelCapability, modelName: string, draft = "") {
    const variables = getPluginVariables().filter((variable) => !variable.capabilities || variable.capabilities.includes(capability));
    const lines = [
        i18n.t("modelPlugin.authoring.intro", { capability: i18n.t(`config.channelEditor.capabilities.${capability}`), model: modelName || i18n.t("modelPlugin.authoring.anyModel") }),
        ...(capability === "image" || capability === "video" ? ["", i18n.t("modelPlugin.authoring.gatewayHint")] : []),
        "",
        i18n.t("modelPlugin.authoring.shape"),
        "",
        i18n.t("modelPlugin.authoring.returnTitle"),
        getPluginReturn(capability),
        "",
        i18n.t("modelPlugin.authoring.variablesTitle"),
        ...variables.map((variable) => `- ${variable.name} (${variable.type}): ${variable.desc}`),
        "",
        i18n.t("modelPlugin.authoring.rulesTitle"),
        i18n.t("modelPlugin.authoring.rules"),
    ];
    const templates = getPluginTemplates()[capability];
    if (templates.length) {
        lines.push("", i18n.t("modelPlugin.authoring.examplesTitle"));
        for (const template of templates) {
            lines.push("", `${template.label}`, template.script);
        }
    }
    if (draft.trim()) {
        lines.push("", i18n.t("modelPlugin.authoring.draftTitle"), draft.trim());
    }
    return lines.join("\n");
}

export type PluginTemplate = { label: string; script: string };

export function getPluginTemplates(): Record<ModelCapability, PluginTemplate[]> {
    return {
        image: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI image generation and editing.
 * Text-to-image uses POST /v1/images/generations (JSON) when images is empty.
 * Image editing uses POST /v1/images/edits (multipart) when images has data URLs.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs; empty for text-to-image
 * @param {object} params
 * @param {string} params.size - output size, e.g. "1024x1024" or "auto"
 * @param {string} params.quality - "low" | "medium" | "high"
 * @param {number} params.count - number of images
 * @param {string} [params.background] - "transparent" when requested
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request - raw HTTP helper; relative urls join baseUrl without /v1
 * @returns {Promise<string[]>} image URLs or data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    quality,
    count,
    background,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  if (images.length === 0) {
    const data = await request({
      method: "post",
      url: \`\${baseUrl}/v1/images/generations\`,
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${apiKey}\`,
      },
      data: {
        model: model,
        prompt: prompt,
        n: count,
        size: size,
        quality: quality,
        background: background,
        response_format: "b64_json",
      },
    });
    const urls = [];
    for (const item of data.data || []) {
      urls.push(item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
    }
    return urls;
  }

  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("n", String(count));
  form.set("size", size);
  form.set("quality", quality);
  form.set("background", background);
  form.set("response_format", "b64_json");
  const imageField = images.length > 1 ? "image[]" : "image";
  for (const dataUrl of images) {
    form.append(imageField, await (await fetch(dataUrl)).blob(), "ref.png");
  }
  const edited = await request({
    method: "post",
    url: \`\${baseUrl}/v1/images/edits\`,
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: form,
  });
  const urls = [];
  for (const item of edited.data || []) {
    urls.push(item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini image generation via models/{model}:generateContent.
 * Reference images go into parts.inline_data. size maps to aspectRatio; quality maps to imageSize.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {object} params
 * @param {string} params.size - "1024x1024", "16:9", "auto", etc.; sent as aspectRatio
 * @param {string} params.quality - "low" | "medium" | "high"; sent as imageSize 1K/2K/4K
 * @param {number} params.count - number of generateContent calls
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<string[]>} image data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    quality,
    count,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  const parts = [{ text: prompt }];
  for (const dataUrl of images) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      parts.push({
        inline_data: {
          mime_type: match[1],
          data: match[2],
        },
      });
    }
  }

  const aspectRatioMap = {
    "1024x1024": "1:1",
    "1280x720": "16:9",
    "720x1280": "9:16",
    "1536x1024": "3:2",
    "1024x1536": "2:3",
  };
  const imageSizeMap = {
    low: "1K",
    medium: "2K",
    high: "4K",
  };
  let aspectRatio = "1:1";
  if (size && size !== "auto") {
    aspectRatio = aspectRatioMap[size] || size;
  }
  let imageSize = "1K";
  if (imageSizeMap[quality]) {
    imageSize = imageSizeMap[quality];
  }
  const n = Number(count) || 1;
  const urls = [];

  for (let i = 0; i < n; i++) {
    const data = await request({
      method: "post",
      url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      data: {
        contents: [
          {
            role: "user",
            parts: parts,
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: aspectRatio,
            imageSize: imageSize,
          },
        },
      },
    });
    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        const img = part.inlineData || part.inline_data;
        if (img && img.data) {
          urls.push(\`data:\${img.mimeType || img.mime_type || "image/png"};base64,\${img.data}\`);
        }
      }
    }
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.zimage"),
                script: `/**
 * 本地网关生图：ComfyUI 模板 img_zimage_artistic（Z-Image 快出）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * 同一渠道可同时承担文本、生图、生视频：文本走 /v1/*，生图生视频走 /api/*。
 * @param {string} prompt
 * @param {object} params
 * @param {string} params.size - "1:1"、"9:16"、"1024x1024"、"auto"
 * @param {number} params.count - 生成张数
 * @param {number} [params.seed] - 随机种子，不传则随机
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<string[]>} 图片 URL 数组
 */
function resolveSize(size, fallback) {
  const preset = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "3:2": [1216, 832], "2:3": [832, 1216] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function generateImage({ prompt, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  const [width, height] = resolveSize(params.size, [1024, 1024]);
  const total = Math.max(1, Math.min(8, Number(params.count) || 1));
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  const lora = params.lora ? { LORA_FILE: params.lora, LORA_STRENGTH: Number(params.loraStrength) || 1 } : {};
  const urls = [];
  for (let index = 0; index < total; index++) {
    const created = await http.post(gateway + "/api/generate/image", {
      template: "img_zimage_artistic",
      name: "canvas_zimage_" + Date.now() + "_" + index,
      params: { PROMPT: prompt, WIDTH: width, HEIGHT: height, BATCH: 1, SEED: baseSeed + index, ...lora },
    });
    urls.push(await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 2000, timeoutMs: 900000 }));
  }
  return urls;
}

return await generateImage({ prompt, params, baseUrl, http, poll });`,
            },
            {
                label: i18n.t("modelPlugin.templates.flux"),
                script: `/**
 * 本地网关生图：ComfyUI 模板 img_flux_artistic（FLUX 氛围感）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * 同一渠道可同时承担文本、生图、生视频：文本走 /v1/*，生图生视频走 /api/*。
 * @param {string} prompt
 * @param {object} params
 * @param {string} params.size - "1:1"、"9:16"、"1024x1024"、"auto"
 * @param {number} params.count - 生成张数
 * @param {number} [params.seed] - 随机种子，不传则随机
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<string[]>} 图片 URL 数组
 */
function resolveSize(size, fallback) {
  const preset = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "3:2": [1216, 832], "2:3": [832, 1216] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function generateImage({ prompt, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  const [width, height] = resolveSize(params.size, [1024, 1024]);
  const total = Math.max(1, Math.min(8, Number(params.count) || 1));
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  const lora = params.lora ? { LORA_FILE: params.lora, LORA_STRENGTH: Number(params.loraStrength) || 1 } : {};
  const urls = [];
  for (let index = 0; index < total; index++) {
    const created = await http.post(gateway + "/api/generate/image", {
      template: "img_flux_artistic",
      name: "canvas_flux_" + Date.now() + "_" + index,
      params: { PROMPT: prompt, WIDTH: width, HEIGHT: height, BATCH: 1, SEED: baseSeed + index, ...lora },
    });
    urls.push(await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 2000, timeoutMs: 900000 }));
  }
  return urls;
}

return await generateImage({ prompt, params, baseUrl, http, poll });`,
            },
            {
                label: i18n.t("modelPlugin.templates.krea2"),
                script: `/**
 * 本地网关生图：ComfyUI 模板 img_krea2_artistic（Krea2 质感，无 LoRA 依赖）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * 同一渠道可同时承担文本、生图、生视频：文本走 /v1/*，生图生视频走 /api/*。
 * @param {string} prompt
 * @param {object} params
 * @param {string} params.size - "1:1"、"9:16"、"1024x1024"、"auto"
 * @param {number} params.count - 生成张数
 * @param {number} [params.seed] - 随机种子，不传则随机
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<string[]>} 图片 URL 数组
 */
function resolveSize(size, fallback) {
  const preset = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "3:2": [1216, 832], "2:3": [832, 1216] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function generateImage({ prompt, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  const [width, height] = resolveSize(params.size, [1024, 1024]);
  const total = Math.max(1, Math.min(8, Number(params.count) || 1));
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  const urls = [];
  for (let index = 0; index < total; index++) {
    const created = await http.post(gateway + "/api/generate/image", {
      template: "img_krea2_artistic",
      name: "canvas_krea2_" + Date.now() + "_" + index,
      params: { PROMPT: prompt, WIDTH: width, HEIGHT: height, BATCH: 1, SEED: baseSeed + index },
    });
    urls.push(await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 2000, timeoutMs: 900000 }));
  }
  return urls;
}

return await generateImage({ prompt, params, baseUrl, http, poll });`,
            },
            {
                label: i18n.t("modelPlugin.templates.qwen21T2i"),
                script: `/**
 * 本地网关生图：ComfyUI 模板 img_qwen21_t2i（Qwen-Image 2.1 文生图）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * 同一渠道可同时承担文本、生图、生视频：文本走 /v1/*，生图生视频走 /api/*。
 * @param {string} prompt
 * @param {object} params
 * @param {string} params.size - "1:1"、"9:16"、"1024x1024"、"auto"
 * @param {number} params.count - 生成张数
 * @param {number} [params.seed] - 随机种子，不传则随机
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<string[]>} 图片 URL 数组
 */
function resolveSize(size, fallback) {
  const preset = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "3:2": [1216, 832], "2:3": [832, 1216] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function generateImage({ prompt, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  const [width, height] = resolveSize(params.size, [1024, 1024]);
  const total = Math.max(1, Math.min(8, Number(params.count) || 1));
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  const urls = [];
  for (let index = 0; index < total; index++) {
    const created = await http.post(gateway + "/api/generate/image", {
      template: "img_qwen21_t2i",
      name: "canvas_qwen21_t2i_" + Date.now() + "_" + index,
      params: { PROMPT: prompt, WIDTH: width, HEIGHT: height, BATCH: 1, SEED: baseSeed + index },
    });
    urls.push(await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 2000, timeoutMs: 900000 }));
  }
  return urls;
}

return await generateImage({ prompt, params, baseUrl, http, poll });`,
            },
            {
                label: i18n.t("modelPlugin.templates.qwen21Edit"),
                script: `/**
 * 本地网关改图：ComfyUI 模板 img_qwen21_edit（Qwen-Image 2.1 指令改图）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * 参考图先 multipart 上传到 /api/uploads，再把返回的 comfyName 作为 INPUT_IMAGE / REF_IMAGE_N 提交。
 * images[0] 作主图 INPUT_IMAGE，images[1..9] 依次作 REF_IMAGE_1..REF_IMAGE_9（多图参考槽，可选）。
 * @param {string} prompt - 编辑指令
 * @param {string[]} images - 参考图 dataURL；第一张是主图，其余为多图参考
 * @param {object} params
 * @param {number} [params.seed] - 随机种子，不传则随机
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<string[]>} 图片 URL 数组
 */
function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function uploadImage(gateway, http, source, filename) {
  const form = new FormData();
  form.append("file", await (await fetch(source)).blob(), filename);
  const uploaded = await http.post(gateway + "/api/uploads", form);
  return uploaded.comfyName || uploaded.name;
}

async function editImage({ prompt, images, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  if (!images || !images.length) throw new Error("Qwen-Image 2.1 指令改图需要一张输入图，请先接入参考图");
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  // images[0] -> INPUT_IMAGE；其余按顺序落到 REF_IMAGE_1..9 多图参考槽，槽位可选，不用的由网关摘除。
  const jobParams = { PROMPT: prompt, SEED: baseSeed };
  const total = Math.min(images.length, 10);
  for (let index = 0; index < total; index++) {
    const token = index === 0 ? "INPUT_IMAGE" : "REF_IMAGE_" + index;
    jobParams[token] = await uploadImage(gateway, http, images[index], "input_" + index + ".png");
  }
  const created = await http.post(gateway + "/api/generate/image", {
    template: "img_qwen21_edit",
    name: "canvas_qwen21_edit_" + Date.now(),
    params: jobParams,
  });
  return [await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 2000, timeoutMs: 900000 })];
}

return await editImage({ prompt, images, params, baseUrl, http, poll });`,
            },
        ],
        video: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI-compatible video: POST /v1/videos (multipart), then poll GET /v1/videos/{id}.
 * Do not set Content-Type on FormData; the browser adds the boundary.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {File[]} videos - reference videos; empty when none
 * @param {File[]} audios - reference audio; empty when none
 * @param {object} params
 * @param {string} params.mode - "frames" uses first/last frame fields; "reference" sends all images as references. More than 2 images become "reference".
 * @param {string|number} params.seconds - duration
 * @param {string} params.size - output size, e.g. "1280x720"
 * @param {string} params.resolution - e.g. "720p"
 * @param {boolean} params.generateAudio
 * @param {boolean} params.watermark
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}|Blob>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    size,
    resolution,
    generateAudio,
    watermark,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("seconds", String(seconds || 8));
  form.set("size", String(size || "1280x720"));
  form.set("resolution_name", String(resolution || "720p"));
  form.set("generate_audio", String(generateAudio !== false));
  form.set("watermark", String(watermark === true));
  form.set("mode", mode);
  if (mode === "frames") {
    if (images[0]) {
      form.append("first_frame", await (await fetch(images[0])).blob(), "first.png");
    }
    if (images[1]) {
      form.append("last_frame", await (await fetch(images[1])).blob(), "last.png");
    }
  } else {
    for (const dataUrl of images) {
      form.append("image[]", await (await fetch(dataUrl)).blob(), "ref.png");
    }
  }
  for (const file of videos) {
    form.append("video[]", file);
  }
  for (const file of audios) {
    form.append("audio[]", file);
  }

  const headers = {
    Authorization: \`Bearer \${apiKey}\`,
  };
  const task = await request({
    method: "post",
    url: \`\${baseUrl}/v1/videos\`,
    headers,
    data: form,
  });

  return await poll(
    async () => {
      const state = await request({
        method: "get",
        url: \`\${baseUrl}/v1/videos/\${task.id}\`,
        headers,
      });
      if (state.status === "failed" || state.status === "cancelled") {
        throw new Error(state.error && state.error.message ? state.error.message : "video generation failed");
      }
      if (state.video_url || state.url) {
        return { url: state.video_url || state.url };
      }
      if (state.status === "completed") {
        return await request({
          method: "get",
          url: \`\${baseUrl}/v1/videos/\${task.id}/content\`,
          headers,
          responseType: "blob",
        });
      }
      return null;
    },
    (result) => result,
    { intervalMs: 2500, timeoutMs: 300000 },
  );
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini Veo video: POST models/{model}:predictLongRunning, then poll the operation.
 * First/last-frame mode: images[0] -> image, images[1] -> lastFrame.
 * Reference mode: all images -> referenceImages.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {File[]} videos - reference videos; empty when none
 * @param {File[]} audios - reference audio; empty when none
 * @param {object} params
 * @param {string} params.mode - "frames" or "reference"
 * @param {string|number} params.seconds - sent as durationSeconds
 * @param {string} params.size - pixel size; mapped to aspectRatio when needed
 * @param {string} params.ratio - aspect ratio, e.g. "16:9"
 * @param {string} params.resolution - e.g. "720p"
 * @param {boolean} params.generateAudio
 * @param {boolean} params.watermark - sent as addWatermark
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    size,
    resolution,
    ratio,
    generateAudio,
    watermark,
  },
  model,
  baseUrl,
  apiKey,
  request,
  poll,
}) {
  async function toInline(source) {
    if (typeof source === "string") {
      const match = source.match(/^data:([^;]+);base64,(.*)$/);
      return {
        bytesBase64Encoded: match ? match[2] : "",
        mimeType: match ? match[1] : "image/png",
      };
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(source);
    });
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    return {
      bytesBase64Encoded: match ? match[2] : "",
      mimeType: match ? match[1] : (source.type || "application/octet-stream"),
    };
  }

  const aspectRatioMap = {
    "1280x720": "16:9",
    "1920x1080": "16:9",
    "720x1280": "9:16",
    "1080x1920": "9:16",
  };
  let aspectRatio = ratio || size || "16:9";
  if (aspectRatio === "auto") {
    aspectRatio = "16:9";
  }
  if (aspectRatioMap[aspectRatio]) {
    aspectRatio = aspectRatioMap[aspectRatio];
  }

  const instance = {
    prompt: prompt,
  };
  if (mode === "frames") {
    if (images[0]) {
      instance.image = await toInline(images[0]);
    }
    if (images[1]) {
      instance.lastFrame = await toInline(images[1]);
    }
  } else {
    instance.referenceImages = [];
    for (const dataUrl of images) {
      instance.referenceImages.push({
        image: await toInline(dataUrl),
        referenceType: "asset",
      });
    }
  }
  if (videos[0]) {
    instance.video = await toInline(videos[0]);
  }
  if (audios[0]) {
    instance.audio = await toInline(audios[0]);
  }

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
  const op = await request({
    method: "post",
    url: \`\${baseUrl}/v1beta/models/\${model}:predictLongRunning\`,
    headers,
    data: {
      instances: [instance],
      parameters: {
        aspectRatio: aspectRatio,
        durationSeconds: Number(seconds) || 8,
        resolution: resolution || "720p",
        generateAudio: generateAudio !== false,
        addWatermark: watermark === true,
      },
    },
  });

  return await poll(
    () => request({
      method: "get",
      url: \`\${baseUrl}/v1beta/\${op.name}\`,
      headers,
    }),
    (state) => {
      if (state.error) {
        throw new Error(state.error.message || "video generation failed");
      }
      if (!state.done) return null;
      const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error("Gemini did not return a video URI");
      if (uri.includes("key=")) return { url: uri };
      const separator = uri.includes("?") ? "&" : "?";
      return { url: uri + separator + "key=" + apiKey };
    },
    { intervalMs: 5000, timeoutMs: 300000 },
  );
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  request,
  poll,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.h3ImageToVideo"),
                script: `/**
 * 本地网关生视频：ComfyUI 模板 video_h3_i2v（H3 图生视频）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * 参考图先 multipart 上传到 /api/uploads，再把返回的 comfyName 作为 INPUT_IMAGE 提交。
 * @param {string} prompt
 * @param {string[]} images - 参考图 dataURL；第一张作为首帧
 * @param {object} params
 * @param {string} params.size - "1280x720" 之类的像素尺寸
 * @param {string} params.ratio - 宽高比，size 不是像素时用它兜底
 * @param {number|string} params.seconds - 时长（秒）
 * @param {number} [params.seed]
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<{url: string}>}
 */
function resolveSize(size, fallback) {
  // 档位取 H3 官方规格（与后端 sizes.js 的 minimax_h3 同源）；"auto"/取不到时回落官方 16:9 1344x768。
  const preset = { "1:1": [768, 768], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1024, 768], "3:4": [768, 1024], "21:9": [1792, 768] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function generateVideo({ prompt, images, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  if (!images || !images.length) throw new Error("H3 图生视频需要一张参考图，请先接入参考图");
  const [width, height] = resolveSize(params.size || params.ratio, [1344, 768]);
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  // H3 的 LENGTH 是帧数（fps=24）且必须落在 17n+5 网格（5s≈124 帧、2.3s≈56 帧），不能把秒数直接当帧数。
  const frames = Math.max(1, Math.round((Number(params.seconds) || 5) * 24));
  const length = 17 * Math.max(0, Math.round((frames - 5) / 17)) + 5;
  const form = new FormData();
  form.append("file", await (await fetch(images[0])).blob(), "input.png");
  const uploaded = await http.post(gateway + "/api/uploads", form);
  const created = await http.post(gateway + "/api/generate/video", {
    template: "video_h3_i2v",
    name: "canvas_h3_i2v_" + Date.now(),
    params: { PROMPT: prompt, INPUT_IMAGE: uploaded.comfyName || uploaded.name, WIDTH: width, HEIGHT: height, LENGTH: length, SEED: baseSeed },
  });
  return { url: await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 3000, timeoutMs: 7200000 }) };
}

return await generateVideo({ prompt, images, params, baseUrl, http, poll });`,
            },
            {
                label: i18n.t("modelPlugin.templates.h3TextToVideo"),
                script: `/**
 * 本地网关生视频：ComfyUI 模板 video_minimax_h3_t2v（MiniMax H3 文生视频）。
 * 使用前先在「配置 → 本地网关」填好网关地址，并把本渠道 baseUrl 指向同一网关（例：http://127.0.0.1:8788）。
 * @param {string} prompt
 * @param {object} params
 * @param {string} params.size - "1280x720" 之类的像素尺寸
 * @param {string} params.ratio - 宽高比，size 不是像素时用它兜底
 * @param {number|string} params.seconds - 时长（秒）
 * @param {number} [params.steps] - 采样步数，默认 6
 * @param {number} [params.seed]
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 * @returns {Promise<{url: string}>}
 */
function resolveSize(size, fallback) {
  // 档位取 H3 官方规格（与后端 sizes.js 的 minimax_h3 同源）；"auto"/取不到时回落官方 16:9 1344x768。
  const preset = { "1:1": [768, 768], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1024, 768], "3:4": [768, 1024], "21:9": [1792, 768] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForJobUrl(gateway, jobId, http, poll, options) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    options,
  );
  const output = (job.outputs || [])[0];
  if (!output || !output.url) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return absoluteUrl(gateway, output.url);
}

async function generateVideo({ prompt, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  const [width, height] = resolveSize(params.size || params.ratio, [1344, 768]);
  const baseSeed = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  // H3 的 LENGTH 是帧数（fps=24）且必须落在 17n+5 网格（5s≈124 帧、2.3s≈56 帧），不能把秒数直接当帧数。
  const frames = Math.max(1, Math.round((Number(params.seconds) || 5) * 24));
  const length = 17 * Math.max(0, Math.round((frames - 5) / 17)) + 5;
  const created = await http.post(gateway + "/api/generate/video", {
    template: "video_minimax_h3_t2v",
    name: "canvas_h3_t2v_" + Date.now(),
    params: { PROMPT: prompt, WIDTH: width, HEIGHT: height, LENGTH: length, STEPS: Number(params.steps) || 6, SEED: baseSeed },
  });
  return { url: await waitForJobUrl(gateway, created.job.id, http, poll, { intervalMs: 3000, timeoutMs: 7200000 }) };
}

return await generateVideo({ prompt, params, baseUrl, http, poll });`,
            },
        ],
        audio: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI speech: POST /v1/audio/speech.
 * @param {string} prompt - text to speak
 * @param {object} params
 * @param {string} params.voice
 * @param {string} params.format - response_format, e.g. "mp3"
 * @param {string|number} params.speed
 * @param {string} [params.instructions] - voice style instructions
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<Blob>}
 */
async function generateAudio({
  prompt,
  params: {
    voice,
    format,
    speed,
    instructions,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  return await request({
    method: "post",
    url: \`\${baseUrl}/v1/audio/speech\`,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    responseType: "blob",
    data: {
      model: model,
      input: prompt,
      voice: voice,
      response_format: format,
      speed: Number(speed),
      instructions: instructions,
    },
  });
}

return await generateAudio({
  prompt,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini TTS: POST models/{model}:generateContent with AUDIO modality.
 * Audio bytes are returned in inlineData.data (base64 PCM).
 * @param {string} prompt - text to speak
 * @param {object} params
 * @param {string} params.voice - prebuilt voice name
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<{data: string}>}
 */
async function generateAudio({
  prompt,
  params: {
    voice,
  },
  model,
  baseUrl,
  apiKey,
  request,
}) {
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    data: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    },
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  let audio = null;
  for (const part of parts) {
    audio = part.inlineData || part.inline_data;
    if (audio && audio.data) break;
  }
  if (!audio || !audio.data) throw new Error("Gemini did not return audio");
  return { data: audio.data };
}

return await generateAudio({
  prompt,
  params,
  model,
  baseUrl,
  apiKey,
  request,
});`,
            },
        ],
        text: [
            {
                label: i18n.t("modelPlugin.templates.openai"),
                script: `/**
 * OpenAI text: POST /v1/responses.
 * @param {{role: string, content: string}[]} messages - includes the system message when present
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} reasoningEffort - "auto" | "low" | "medium" | "high" | "xhigh"; omit reasoning when "auto"
 * @param {function} request
 * @param {function} onDelta - push streaming text
 * @returns {Promise<string>}
 */
async function generateText({
  messages,
  model,
  baseUrl,
  apiKey,
  reasoningEffort,
  request,
  onDelta,
}) {
  const body = {
    model: model,
    input: messages,
  };
  if (reasoningEffort && reasoningEffort !== "auto") {
    body.reasoning = {
      effort: reasoningEffort,
    };
  }
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1/responses\`,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: body,
  });
  const text = data.output_text
    || (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || "").join("")
    || "";
  onDelta(text);
  return text;
}

return await generateText({
  messages,
  model,
  baseUrl,
  apiKey,
  reasoningEffort,
  request,
  onDelta,
});`,
            },
            {
                label: i18n.t("modelPlugin.templates.gemini"),
                script: `/**
 * Gemini text: POST models/{model}:generateContent.
 * System messages are skipped in contents; systemPrompt goes to systemInstruction.
 * @param {{role: string, content: string}[]} messages
 * @param {string} systemPrompt
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {function} request
 * @param {function} onDelta - push streaming text
 * @returns {Promise<string>}
 */
async function generateText({
  messages,
  systemPrompt,
  model,
  baseUrl,
  apiKey,
  request,
  onDelta,
}) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }
  const body = {
    contents: contents,
  };
  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }
  const data = await request({
    method: "post",
    url: \`\${baseUrl}/v1beta/models/\${model}:generateContent\`,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    data: body,
  });
  let text = "";
  for (const part of data.candidates?.[0]?.content?.parts || []) {
    text += part.text || "";
  }
  onDelta(text);
  return text;
}

return await generateText({
  messages,
  systemPrompt,
  model,
  baseUrl,
  apiKey,
  request,
  onDelta,
});`,
            },
        ],
    };
}

/** Normalize whatever an image script returns into the app's generated-image shape. */
export function normalizePluginImages(result: unknown): string[] {
    const items = Array.isArray(result) ? result : [result];
    const urls = items
        .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
                const record = item as Record<string, unknown>;
                if (typeof record.dataUrl === "string") return record.dataUrl;
                if (typeof record.url === "string") return record.url;
                if (typeof record.b64_json === "string") return `data:image/png;base64,${record.b64_json}`;
            }
            return "";
        })
        .filter(Boolean);
    if (!urls.length) throw new Error(i18n.t("modelPlugin.noImages"));
    return urls;
}

import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { createModelChannel, defaultGatewayUrl, normalizeGatewayUrl, useConfigStore, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";
import { getPluginTemplates } from "./model-plugin";

export { defaultGatewayUrl };

export type GatewayArtifact = {
    filename: string;
    url: string;
    type: "image" | "video" | "audio" | "file";
    width?: number;
    height?: number;
    bytes?: number;
};

export type GatewayJobKind = "image" | "video" | "upscale" | "edit";
export type GatewayJobStatus = "queued" | "running" | "done" | "error" | "canceled";

export type GatewayJob = {
    id: string;
    kind: GatewayJobKind;
    template: string;
    name: string;
    params: Record<string, unknown>;
    status: GatewayJobStatus;
    promptId?: string;
    progress?: { value: number; max: number; node?: string };
    outputs: GatewayArtifact[];
    error?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
};

export type GatewayHealth = {
    ok: boolean;
    llm: { ok: boolean; baseUrl: string; error?: string };
    comfy: { ok: boolean; baseUrl: string; error?: string };
    queue: { running: number; pending: number };
};

export type GatewayTemplateInfo = { name: string; family: string; title: string; tokens: string[] };

export type GatewayProviders = {
    llm: { models: string[] };
    comfy: { templates: GatewayTemplateInfo[]; models: { checkpoints: string[]; loras: string[]; vae: string[] } };
};

/** `/api/skills` 目前返回 skills 目录信息或流水线阶段信息，两种形状都兼容。 */
export type GatewaySkillInfo = { id: string; name?: string; title?: string; description?: string; path?: string; skill?: string; requires?: string[]; produces?: string[] };
export type GatewayStageInfo = { id: string; title: string; skill: string; requires: string[]; produces: string[] };

export type GatewayStageStatus = "pending" | "running" | "partial" | "done" | "error" | "canceled";

export type GatewayRunStage = {
    id: string;
    title: string;
    status: GatewayStageStatus;
    inputs: Record<string, unknown>;
    output: unknown;
    artifacts: GatewayArtifact[];
    error?: string;
    startedAt?: string;
    finishedAt?: string;
};

/** 创建 run 时就算好的成本预估。口径与后端分块判定一致：比的是填充后的 prompt 长度，不是小说字数。 */
export type GatewayRunEstimate = {
    novelChars: number;
    promptChars: number;
    maxChunkChars: number;
    chunked: boolean;
    chunks: number;
    llmCalls: number;
    perChunkSeconds: number;
    estSeconds: number;
    resumableChunks: number;
};

/**
 * 阶段进度，来自独立的 progress.json（几十字节）。
 * 不要用 GET /api/pipeline/runs/:id 轮询进度 —— 那个响应内嵌整本小说，222 万字的书有 6.4MB。
 */
export type GatewayStageProgress = {
    runId: string;
    stage: string;
    phase: "map" | "reduce" | "single" | "done" | "failed";
    done?: number;
    total?: number;
    label?: string;
    reused?: number;
    resumed?: boolean;
    avgMsPerChunk?: number;
    etaMs?: number;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt?: string;
};

export type GatewayPipelineRun = {
    id: string;
    title: string;
    novel: string;
    createdAt: string;
    updatedAt: string;
    estimate?: GatewayRunEstimate;
    stages: Record<string, GatewayRunStage>;
};

export type GatewayGenerateBody = { template: string; params: Record<string, unknown>; name?: string };
export type GatewayStageInputPatch = { inputs?: Record<string, unknown>; output?: unknown };

/** 网关地址以配置里的「本地网关地址」为准，显式传参时优先。 */
export function gatewayBaseUrl(baseUrl?: string) {
    return normalizeGatewayUrl(baseUrl || useConfigStore.getState().config.gatewayUrl) || defaultGatewayUrl();
}

/** 网关产物 URL 默认是相对路径（`/api/artifacts/...`），补全后才能直接喂给 <img> / <video>。 */
export function resolveGatewayUrl(url: string, baseUrl?: string) {
    if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
    return `${gatewayBaseUrl(baseUrl)}${url.startsWith("/") ? url : `/${url}`}`;
}

async function gatewayRequest<T>(config: AxiosRequestConfig, baseUrl?: string): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl(baseUrl) });
        return response.data;
    } catch (error) {
        if (axios.isCancel(error)) throw error;
        throw new Error(gatewayErrorMessage(error));
    }
}

function gatewayErrorMessage(error: unknown) {
    if (axios.isAxiosError(error)) {
        const payload = error.response?.data as { error?: { message?: string } } | undefined;
        if (payload?.error?.message) return i18n.t("gateway.failed", { message: payload.error.message });
        if (error.response) return i18n.t("gateway.httpFailed", { status: error.response.status });
        return i18n.t("gateway.unreachable");
    }
    return error instanceof Error ? error.message : i18n.t("gateway.unreachable");
}

export async function fetchGatewayHealth(baseUrl?: string) {
    return gatewayRequest<GatewayHealth>({ method: "get", url: "/api/health", timeout: 8000 }, baseUrl);
}

/**
 * 依次探测候选网关地址（已配置的 → 按当前访问主机推导的 → 本机回环），返回第一个 /api/health 应答的地址。
 * 用于「浏览器所在网络与服务器不一致」时自动找到可达网关；全部不通时回退到已配置地址。
 */
export async function probeGatewayBaseUrl(): Promise<string> {
    const configured = gatewayBaseUrl();
    const candidates = [configured, defaultGatewayUrl(), "http://127.0.0.1:8788"].filter((url, index, list) => list.indexOf(url) === index);
    for (const url of candidates) {
        try {
            await fetchGatewayHealth(url);
            return url;
        } catch {
            /* 尝试下一个候选 */
        }
    }
    return configured;
}

export async function fetchGatewayProviders(baseUrl?: string) {
    return gatewayRequest<GatewayProviders>({ method: "get", url: "/api/providers" }, baseUrl);
}

export async function fetchGatewaySkills(baseUrl?: string) {
    const data = await gatewayRequest<{ skills: GatewaySkillInfo[] }>({ method: "get", url: "/api/skills" }, baseUrl);
    return data.skills;
}

export async function fetchGatewayStages(baseUrl?: string) {
    const data = await gatewayRequest<{ stages: GatewayStageInfo[] }>({ method: "get", url: "/api/pipeline/stages" }, baseUrl);
    return data.stages;
}

export async function submitGatewayImage(body: GatewayGenerateBody, baseUrl?: string) {
    return submitGatewayJob("image", body, baseUrl);
}

export async function submitGatewayVideo(body: GatewayGenerateBody, baseUrl?: string) {
    return submitGatewayJob("video", body, baseUrl);
}

async function submitGatewayJob(kind: "image" | "video", body: GatewayGenerateBody, baseUrl?: string) {
    const data = await gatewayRequest<{ job: GatewayJob }>({ method: "post", url: `/api/generate/${kind}`, data: body }, baseUrl);
    return data.job;
}

export async function fetchGatewayJob(id: string, baseUrl?: string) {
    const data = await gatewayRequest<{ job: GatewayJob }>({ method: "get", url: `/api/jobs/${encodeURIComponent(id)}` }, baseUrl);
    return data.job;
}

export async function listGatewayJobs(options?: { status?: GatewayJobStatus; limit?: number }, baseUrl?: string) {
    const data = await gatewayRequest<{ jobs: GatewayJob[] }>({ method: "get", url: "/api/jobs", params: options }, baseUrl);
    return data.jobs;
}

export async function cancelGatewayJob(id: string, baseUrl?: string) {
    const data = await gatewayRequest<{ job: GatewayJob }>({ method: "post", url: `/api/jobs/${encodeURIComponent(id)}/cancel` }, baseUrl);
    return data.job;
}

export async function uploadGatewayAsset(file: File | Blob, baseUrl?: string) {
    const form = new FormData();
    form.append("file", file, file instanceof File ? file.name : "upload.bin");
    return gatewayRequest<{ name: string; comfyName: string }>({ method: "post", url: "/api/uploads", data: form }, baseUrl);
}

export async function createPipelineRun(input: { novel: string; title?: string; options?: Record<string, unknown> }, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "post", url: "/api/pipeline/runs", data: input }, baseUrl);
    return data.run;
}

export async function getPipelineRun(id: string, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "get", url: `/api/pipeline/runs/${encodeURIComponent(id)}` }, baseUrl);
    return data.run;
}

/** 历史列表里每个阶段的摘要，够渲染「标题 + 状态」即可，不拖阶段产物。 */
export type GatewayPipelineRunStageSummary = { title: string; status: GatewayStageStatus };

/** 历史 run 摘要：后端列表接口回的是完整 run，这里只留列表需要的字段。 */
export type GatewayPipelineRunSummary = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    stages: Record<string, GatewayPipelineRunStageSummary>;
};

/** 把某个 run 的阶段压成历史列表要的「标题 + 状态」摘要。 */
export function summarizeRunStages(stages?: Record<string, GatewayRunStage>) {
    return Object.fromEntries(Object.entries(stages || {}).map(([stageId, stage]) => [stageId, { title: stage.title || stageId, status: stage.status }]));
}

/**
 * 历史流水线列表。后端 GET /api/pipeline/runs 返回的是**完整 run 对象数组**（每个内嵌整本小说，
 * 222 万字约 6.4MB），所以这里立即收敛成只含标题、时间、阶段状态的摘要，避免大对象在内存与本地持久化里堆积。
 */
export async function listPipelineRuns(baseUrl?: string) {
    const data = await gatewayRequest<{ runs: GatewayPipelineRun[] }>({ method: "get", url: "/api/pipeline/runs" }, baseUrl);
    return data.runs.map(
        (run): GatewayPipelineRunSummary => ({
            id: run.id,
            title: run.title || run.id,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            stages: summarizeRunStages(run.stages),
        }),
    );
}

/**
 * 触发单步运行。后端**立刻返回 202**，工作在后台跑 —— 不要指望这个 Promise 解析时阶段已完成。
 * 返回的 run 里该阶段是 `running`，终态要靠 fetchPipelineProgress 轮询到 phase done/failed 后再 getPipelineRun 取。
 * `resume: true` 表示复用上次已落盘的分块结果续跑（长篇崩了不必从头再来）；缺省为 false，会清空缓存重跑。
 */
export async function runPipelineStage(runId: string, stageId: string, body?: { model?: string; provider?: { baseUrl: string; apiKey: string }; resume?: boolean }, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun; inflight?: boolean }>({ method: "post", url: `/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stageId)}/run`, data: body || {} }, baseUrl);
    return data.run;
}

/** 轻量进度轮询：只回 progress.json，不拖内嵌整本小说的 run.json。 */
export async function fetchPipelineProgress(runId: string, baseUrl?: string) {
    return gatewayRequest<{ progress: GatewayStageProgress | null; inflight: boolean }>({ method: "get", url: `/api/pipeline/runs/${encodeURIComponent(runId)}/progress` }, baseUrl);
}

/** 取消正在执行的阶段。后端 abort 后由 executeStage 落终态，所以这里不回传 run，终态靠轮询拿。 */
export async function cancelPipelineStage(runId: string, stageId: string, baseUrl?: string) {
    return gatewayRequest<{ canceled: boolean; stage: string; ranMs: number }>({ method: "post", url: `/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stageId)}/cancel` }, baseUrl);
}

export async function fetchGatewayLlmModels(baseUrl?: string) {
    const data = await gatewayRequest<{ models: Array<string | { id?: string; name?: string }> }>({ method: "get", url: "/api/llm/models" }, baseUrl);
    return data.models.map((m) => (typeof m === "string" ? m : m.id || m.name || "")).filter(Boolean);
}

/** 把浏览器渠道（OpenAI 兼容）全量同步为网关侧外部 LLM 注册表，之后流水线运行只传模型名、由网关路由。 */
export async function syncGatewayLlmProviders(providers: Array<{ name: string; baseUrl: string; apiKey: string }>, baseUrl?: string) {
    const data = await gatewayRequest<{ providers: Array<{ name: string; baseUrl: string; hasKey: boolean }> }>({ method: "post", url: "/api/llm/providers", data: { providers } }, baseUrl);
    return data.providers;
}

export async function updatePipelineStageInput(runId: string, stageId: string, patch: GatewayStageInputPatch, baseUrl?: string) {
    const data = await gatewayRequest<{ run: GatewayPipelineRun }>({ method: "post", url: `/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stageId)}/input`, data: patch }, baseUrl);
    return data.run;
}

/** 有内置脚本模板的网关模板：键为模板名，对应 model-plugin 里的模板 label 文案 key。 */
const BUILTIN_GATEWAY_SCRIPTS: Record<string, { capability: "image" | "video"; labelKey: string }> = {
    img_zimage_artistic: { capability: "image", labelKey: "zimage" },
    img_flux_artistic: { capability: "image", labelKey: "flux" },
    img_krea2_artistic: { capability: "image", labelKey: "krea2" },
    video_h3_i2v: { capability: "video", labelKey: "h3ImageToVideo" },
    video_minimax_h3_t2v: { capability: "video", labelKey: "h3TextToVideo" },
};

function builtinGatewayScript(name: string, capability: "image" | "video") {
    const builtin = BUILTIN_GATEWAY_SCRIPTS[name];
    if (!builtin || builtin.capability !== capability) return "";
    const label = i18n.t(`modelPlugin.templates.${builtin.labelKey}`);
    return getPluginTemplates()[capability].find((template) => template.label === label)?.script || "";
}

export type GatewayOnboardPlan = {
    models: ChannelModel[];
    counts: { text: number; image: number; video: number };
};

/**
 * 把 /api/providers 的探测结果转成渠道模型清单：LLM 走 /v1 无需脚本，其余模板挂调用脚本。
 * 网关的 family 有 image / video / edit / upscale 四种，但执行器只有 image 与 video 两个
 * （edit 与 upscale 都是图像类），所以这里统一归一，不再有「暂不支持而跳过」的模板。
 */
export function planGatewayChannel(providers: GatewayProviders): GatewayOnboardPlan {
    const models: ChannelModel[] = [];
    for (const name of providers.llm?.models || []) {
        const trimmed = String(name).trim();
        if (trimmed) models.push({ name: trimmed, capability: "text" });
    }
    const counts = { text: models.length, image: 0, video: 0 };
    for (const template of providers.comfy?.templates || []) {
        const capability = template.family === "video" ? "video" : "image";
        counts[capability] += 1;
        models.push({ name: template.name, capability, script: builtinGatewayScript(template.name, capability) || buildGatewayTemplateScript(template) });
    }
    return { models, counts };
}

/** 幂等接入：同 baseUrl 或同名的渠道直接更新（合并模型、刷新脚本），否则新建「本地网关」渠道。 */
export function upsertGatewayChannel(channels: ModelChannel[], baseUrl: string, models: ChannelModel[]): { channels: ModelChannel[]; channel: ModelChannel } {
    const gateway = normalizeGatewayUrl(baseUrl) || defaultGatewayUrl();
    const channelName = i18n.t("config.gateway.channelName");
    const keyOf = (value: string) => normalizeGatewayUrl(value).replace(/\/v1$/i, "").toLowerCase();
    const existing = channels.find((channel) => (channel.baseUrl && keyOf(channel.baseUrl) === keyOf(gateway)) || channel.name === channelName);
    if (!existing) {
        const channel = createModelChannel({ name: channelName, baseUrl: gateway, apiKey: "local-gateway", apiFormat: "openai", models });
        return { channels: [...channels, channel], channel };
    }
    const merged = [...existing.models];
    for (const model of models) {
        const index = merged.findIndex((item) => item.name === model.name);
        if (index >= 0) merged[index] = model;
        else merged.push(model);
    }
    const channel = { ...existing, baseUrl: gateway, models: merged };
    return { channels: channels.map((item) => (item.id === existing.id ? channel : item)), channel };
}

/** 一键接入后的默认模型：文本优先 qwen，生图优先 Krea2 其次 Z-Image，视频优先 H3 图生视频，都没有则取该能力第一个。 */
export function gatewayDefaultModels(models: ChannelModel[]) {
    const pick = (capability: "text" | "image" | "video", preferred: Array<(name: string) => boolean>) => {
        const candidates = models.filter((model) => model.capability === capability);
        for (const match of preferred) {
            const hit = candidates.find((model) => match(model.name));
            if (hit) return hit.name;
        }
        return candidates[0]?.name || "";
    };
    return {
        text: pick("text", [(name) => /qwen/i.test(name)]),
        image: pick("image", [(name) => name === "img_krea2_artistic", (name) => name === "img_zimage_artistic"]),
        video: pick("video", [(name) => name === "video_h3_i2v"]),
    };
}

/**
 * 无内置脚本的模板按网关统一模式生成通用脚本：提交 /api/generate/<image|video> → 轮询 /api/jobs/:id → 返回产物绝对地址。
 * 只填充模板声明过的 token；参考图/参考视频先传 /api/uploads 再回填 comfyName；模板专有参数（如 STEPS、TTS_TEXT）由 params 同名透传。
 */
export function buildGatewayTemplateScript(template: GatewayTemplateInfo) {
    const capability = template.family === "video" ? "video" : "image";
    return `/**
 * 本地网关模板：${template.title}（${template.name}）。
 * 提交 /api/generate/${capability} 后轮询任务，返回产物绝对地址；参考图/参考视频先上传到 /api/uploads 再回填。
 * 模板专有参数（如 STEPS、TTS_TEXT）可通过 params 同名透传。
 * @param {string} prompt
 * @param {string[]} images - 参考图 dataURL
 * @param {File[]} videos - 参考视频 File
 * @param {object} params
 * @param {string} baseUrl - 渠道地址；网关模式下就是本地网关地址
 * @param {function} http - 便捷请求；绝对 URL 原样使用，不会拼 /v1
 * @param {function} poll - poll(request, extract, { intervalMs, timeoutMs })
 */
const TEMPLATE = { name: ${JSON.stringify(template.name)}, family: ${JSON.stringify(capability)}, tokens: ${JSON.stringify(template.tokens || [])} };

function resolveSize(size, fallback) {
  const preset = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "3:2": [1216, 832], "2:3": [832, 1216] };
  if (preset[size]) return preset[size];
  const matched = String(size || "").match(/^(\\d+)\\s*[x×]\\s*(\\d+)$/i);
  return matched ? [Number(matched[1]), Number(matched[2])] : fallback;
}

function absoluteUrl(gateway, url) {
  return /^https?:/i.test(url) ? url : gateway + (url.charAt(0) === "/" ? url : "/" + url);
}

async function waitForOutputs(gateway, jobId, http, poll) {
  const job = await poll(
    () => http.get(gateway + "/api/jobs/" + jobId),
    (value) => {
      const task = value && value.job;
      if (!task) return null;
      if (task.status === "error" || task.status === "canceled") throw new Error("本地网关任务失败：" + (task.error || task.status));
      return task.status === "done" ? task : null;
    },
    { intervalMs: 3000, timeoutMs: 7200000 },
  );
  const outputs = (job.outputs || []).filter((output) => output && output.url);
  if (!outputs.length) throw new Error("本地网关任务已完成，但没有返回产物地址");
  return outputs.map((output) => absoluteUrl(gateway, output.url));
}

async function uploadAsset(gateway, http, source, filename) {
  const blob = typeof source === "string" ? await (await fetch(source)).blob() : source;
  const form = new FormData();
  form.append("file", blob, filename);
  const uploaded = await http.post(gateway + "/api/uploads", form);
  return uploaded.comfyName || uploaded.name;
}

async function generate({ prompt, images, videos, params, baseUrl, http, poll }) {
  const gateway = baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/i, "");
  const has = (token) => TEMPLATE.tokens.includes(token);
  const jobParams = {};
  if (has("PROMPT")) jobParams.PROMPT = prompt;
  const [width, height] = resolveSize(params.size || params.ratio, TEMPLATE.family === "video" ? [1280, 720] : [1024, 1024]);
  if (has("WIDTH")) jobParams.WIDTH = width;
  if (has("HEIGHT")) jobParams.HEIGHT = height;
  if (has("BATCH")) jobParams.BATCH = 1;
  if (has("LENGTH")) {
    // H3 的 LENGTH 是帧数（fps=24）且必须落在 17n+5 网格（5s≈124 帧、2.3s≈56 帧），不能把秒数直接当帧数。
    const frames = Math.max(1, Math.round((Number(params.seconds) || 5) * 24));
    jobParams.LENGTH = 17 * Math.max(0, Math.round((frames - 5) / 17)) + 5;
  }
  if (has("SEED")) jobParams.SEED = params.seed === undefined || params.seed === null || params.seed === "" ? Math.floor(Math.random() * 2147483647) : Number(params.seed);
  // REF_IMAGE_N 用正则派生而不是枚举：后端模板可以给到 REF_IMAGE_9（Qwen-Image 2.1 支持多张参考图），
  // 枚举列表每加一个槽位都要改一次前端，正是「拷个模板就该自动可用」不成立的原因。
  const imageTokens = TEMPLATE.tokens.filter(
    (token) => token === "INPUT_IMAGE" || token === "PERSON_IMAGE" || token === "CLOTHING_IMAGE" || /^REF_IMAGE_\d+$/.test(token),
  );
  if (imageTokens.length && !images.length) throw new Error("模板 " + TEMPLATE.name + " 需要参考图，请先接入参考图");
  for (let index = 0; index < imageTokens.length; index++) {
    if (images[index]) jobParams[imageTokens[index]] = await uploadAsset(gateway, http, images[index], "input_" + index + ".png");
  }
  if (has("REF_VIDEO")) {
    if (!videos.length) throw new Error("模板 " + TEMPLATE.name + " 需要参考视频，请先接入参考视频");
    jobParams.REF_VIDEO = await uploadAsset(gateway, http, videos[0], videos[0].name || "input.mp4");
  }
  for (const token of TEMPLATE.tokens) {
    if (jobParams[token] === undefined && params[token] !== undefined) jobParams[token] = params[token];
  }
  // 网关只注册了 /api/generate/{image,video}（见 canvas-server/README.md 的冻结契约），
  // 而 family 还会取 edit / upscale（img_*_edit、upscale_*）。直接把 family 拼进 URL 会 404，
  // 所以这里归一成 kind：只有 video 走视频执行器，其余都是图像类。
  const kind = TEMPLATE.family === "video" ? "video" : "image";
  const created = await http.post(gateway + "/api/generate/" + kind, {
    template: TEMPLATE.name,
    name: "canvas_" + TEMPLATE.name + "_" + Date.now(),
    params: jobParams,
  });
  const urls = await waitForOutputs(gateway, created.job.id, http, poll);
  return kind === "video" ? { url: urls[0] } : urls;
}

return await generate({ prompt, images, videos, params, baseUrl, http, poll });`;
}

/**
 * 模型注册表（Model Registry）—— 服务端唯一持有的模型清单。
 *
 * 契约：docs/content/docs/progress/model-registry-contract.md（v1 冻结）。
 *
 * 职责：
 *   1. 存储 `data/model-registry.json`（原子写；文件缺失/损坏 → 空表 + warning，绝不 500）；
 *   2. CRUD：POST 建档（name 唯一 409）/ PATCH 改 alias·enabled·category（name 不可改）/ DELETE 删登记；
 *   3. sync：从服务端「实际可用的模板 + LLM 渠道」补缺、标记 stale；**不覆盖用户改过的 alias/enabled**；
 *   4. 分类映射（唯一事实源）与 runtime 判定；
 *   5. script：把前端 `web/src/services/api/gateway.ts` 的 `buildGatewayTemplateScript`
 *      生成逻辑在服务端等价复刻一份，前端拿到条目后不再自己拼脚本。
 *
 * 纯存储层：不碰 HTTP（错误对象带 `status`，由 index.js 的路由统一映射）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ensureDir, safeJoin } from "./files.js";
import { ulid } from "./projects.js";

/** 四类（契约 §2）：text | image | video | audio —— UI 按四组分栏呈现。 */
export const CATEGORIES = Object.freeze(["text", "image", "video", "audio"]);
export const RUNTIMES = Object.freeze(["local", "cloud"]);
export const SOURCES = Object.freeze(["template", "channel", "manual"]);

/**
 * 契约 §2.5 默认 base / task 表 —— 19 条：18 个本机模板 + 1 条 LLM 渠道模型。
 *
 * | 字段 | 含义 | 用途 |
 * | `base` | 基座 / 模型名（`千问2.1` / `H3` / `Flux` / `Wan` / `DeepSeek`）| **分组键** |
 * | `task` | 能力 / 用途名（`文生图` / `改图` / `首尾帧生视频`）| 组内那一行的标题 |
 *
 * 规则（§2.4）：base/task 一律中文、禁缩写（沿用 §2.1）；同级变体（快慢 / 显存档）
 * 不另开一组，用 `·` 分隔表达（如 `参考图生视频 · 快速版`）。
 * 表的**插入顺序即组内默认排序**（§2.4 规则 5）。
 */
export const DEFAULT_BASE_TASK = Object.freeze({
    img_qwen21_t2i: { base: "千问2.1", task: "文生图" },
    img_qwen21_edit: { base: "千问2.1", task: "改图" },
    img_flux_artistic: { base: "Flux", task: "艺术生图" },
    img_krea2_artistic: { base: "Krea2", task: "艺术生图" },
    img_zimage_artistic: { base: "ZImage", task: "艺术生图" },
    img_boogu_outfit_edit: { base: "Boogu", task: "换装" },
    scail2_action_transfer: { base: "Scail2", task: "动作迁移" },
    upscale_4x: { base: "放大", task: "4 倍" },
    video_h3_i2v: { base: "H3", task: "图生视频" },
    video_h3_i2v_fl: { base: "H3", task: "首尾帧生视频" },
    video_h3_talk: { base: "H3", task: "台词对口型" },
    video_h3_ref2v_image: { base: "H3", task: "参考图生视频" },
    video_h3_ref2v_image_turbo: { base: "H3", task: "参考图生视频 · 快速版" },
    video_h3_quantfunc_ref2v: { base: "H3", task: "参考图生视频 · 省显存版" },
    video_h3_ref2v: { base: "H3", task: "参考视频生视频" },
    video_minimax_h3_t2v: { base: "H3", task: "文生视频" },
    video_wan_animate: { base: "Wan", task: "动作驱动" },
    audio_qwen3_tts: { base: "千问3", task: "语音合成" },
    deepseek: { base: "DeepSeek", task: "对话" },
});

/** 组合视图：`alias = base + 空格 + task`（task 为空时只留 base，不留尾空格）。 */
export function composeAlias(base, task) {
    const b = String(base ?? "").trim();
    const t = String(task ?? "").trim();
    return t ? `${b} ${t}` : b;
}

/**
 * 契约 §2.2 默认别名表 —— 由 §2.5 的 base/task 派生（**单一事实源**），仍是 19 条。
 * 规则（§2.1）：一律中文、禁止 i2v/t2i 这类缩写；厂商名可保留通用写法；
 * 「云端」不写进别名（由 runtime + UI 的 ☁️ 图标表达）。
 */
export const DEFAULT_ALIASES = Object.freeze(
    Object.fromEntries(Object.entries(DEFAULT_BASE_TASK).map(([name, { base, task }]) => [name, composeAlias(base, task)])),
);

/** base 首次出现顺序（组间排序：默认表优先）；name → 表内下标（组内排序）。 */
const BASE_ORDER = new Map();
const NAME_ORDER = new Map();
Object.entries(DEFAULT_BASE_TASK).forEach(([name, { base }], index) => {
    NAME_ORDER.set(name, index);
    if (!BASE_ORDER.has(base)) BASE_ORDER.set(base, index);
});

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function nowIso() {
    return new Date().toISOString();
}

/** 未命中默认别名表时返回空串（UI 回落 meta.title → name），不做任何猜测。 */
export function defaultAliasFor(name) {
    return DEFAULT_ALIASES[String(name ?? "").trim()] || "";
}

/** 命中 §2.5 默认表则返回 `{ base, task }`，否则 null。 */
export function defaultBaseTaskFor(name) {
    const hit = DEFAULT_BASE_TASK[String(name ?? "").trim()];
    return hit ? { base: hit.base, task: hit.task } : null;
}

/**
 * base/task 回落链（§2.5 回填规则）：
 *   1. 默认表按 `name` 命中 → 取之；
 *   2. 否则按 `alias` 拆分（`base` = 第一个空格前，`task` = 其余）；
 *   3. 再否则 `base = alias || name`、`task = ""`。
 * 纯函数，不写别名（回填**绝不覆盖用户改过的 alias**）。
 */
export function fallbackBaseTask(name, alias) {
    const hit = defaultBaseTaskFor(name);
    if (hit) return hit;
    const a = String(alias ?? "").trim();
    if (a) {
        const index = a.indexOf(" ");
        if (index > 0) return { base: a.slice(0, index).trim(), task: a.slice(index + 1).trim() };
        return { base: a, task: "" };
    }
    return { base: String(name ?? "").trim(), task: "" };
}

/**
 * 幂等补齐：仅当 `base`/`task` 缺失时填入（命中/拆分/回落），**已具备则不动**。
 * 不触碰 `alias`/`enabled` —— 保证存量回填不丢用户改动。返回是否发生了补齐。
 */
export function ensureBaseTask(model) {
    if (!model || typeof model !== "object") return false;
    const hasBase = model.base != null && String(model.base).trim() !== "";
    const hasTask = model.task != null;
    if (hasBase && hasTask) return false;
    const fallback = fallbackBaseTask(model.name, model.alias);
    if (!hasBase) model.base = fallback.base;
    if (!hasTask) model.task = fallback.task;
    return true;
}

/**
 * 分类映射（契约 §2，唯一事实源在服务端）。
 * - 模板 family = video → video；
 * - 模板 family = image | edit | upscale → image；
 * - family = audio **或模板名以 `audio_`/`audio-` 开头** → audio。
 *   特例说明：`providers/comfy.js` 的 `familyOf()` 对 `audio_qwen3_tts` 会返回 `edit`
 *   （它只认 upscale/video/img 前缀），若只看 family 会把它错分进生图下拉 —— 所以按名字前缀兜底。
 * - LLM 渠道 → text（走 `categoryForChannel`）。
 */
export function categoryForTemplate(template = {}) {
    const name = String(template?.name || "").trim();
    const family = String(template?.family || "").trim().toLowerCase();
    if (/^audio[_-]/i.test(name) || family === "audio") return "audio";
    if (family === "video" || /^video/i.test(name)) return "video";
    return "image";
}

export function categoryForChannel() {
    return "text";
}

const PRIVATE_HOST_RE = /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost([:/]|$)|0\.0\.0\.0|[[]::1[]]|::1([:/]|$))/i;

/**
 * runtime 判定（契约 §2.3）：本地 ComfyUI 模板 / 本地 LLM（ollama 等）→ local；
 * LLM 云端渠道 / 云端 ComfyUI（RunningHub 等）→ cloud。
 * 只按「实际 provider 指向的地址」判断，不看渠道名：回环、私有网段、.local/.internal、
 * ollama/lmstudio 字样一律视为本地；其余视为云端。
 */
export function runtimeForProvider(provider = {}) {
    const name = String(provider?.name || "").trim();
    const baseUrl = String(provider?.baseUrl || "").trim();
    if (!baseUrl) return /ollama|lm ?studio|本地|内网|局域网/i.test(name) ? "local" : "cloud";
    if (PRIVATE_HOST_RE.test(baseUrl)) return "local";
    if (/^https?:\/\/[^/]*\.(local|internal)([:/]|$)/i.test(baseUrl)) return "local";
    if (/ollama|lm-?studio/i.test(baseUrl)) return "local";
    return "cloud";
}

/**
 * 前端 `buildGatewayTemplateScript(template)` 的服务端等价实现。
 * 目标：前端拿到注册表条目的 `script` 后不必再自己拼脚本。
 * 输出与该前端函数生成的一致（网关统一模式：提交 /api/generate/<kind> → 轮询 /api/jobs/:id → 返回产物地址）。
 */
export function buildTemplateScript(template = {}) {
    const capability = String(template?.family) === "video" ? "video" : "image";
    const name = String(template?.name || "");
    const title = String(template?.title || name);
    const tokens = Array.isArray(template?.tokens) ? template.tokens : [];
    return `/**
 * 本地网关模板：${title}（${name}）。
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
const TEMPLATE = { name: ${JSON.stringify(name)}, family: ${JSON.stringify(capability)}, tokens: ${JSON.stringify(tokens)} };

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
    (token) => token === "INPUT_IMAGE" || token === "PERSON_IMAGE" || token === "CLOTHING_IMAGE" || /^REF_IMAGE_\\d+$/.test(token),
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

/**
 * 服务端「实际可用」清单（sync 与 available 共用）。
 * @param {{ templates?: object[], llmProviders?: object[], catalog?: Record<string, object> }} sources
 *   templates：`listTemplates()` 的输出；llmProviders：外部渠道路由表；catalog：`scanTemplateDir()` 的能力表。
 * @returns {object[]} 可用项描述（含 name/category/runtime/provider/source/alias/meta）
 */
export function computeAvailable({ templates = [], llmProviders = [], catalog = {} } = {}) {
    const items = [];
    for (const template of Array.isArray(templates) ? templates : []) {
        const name = String(template?.name || "").trim();
        if (!name) continue;
        const category = categoryForTemplate(template);
        const info = catalog?.[name] || null;
        const meta = {
            family: template?.family ?? null,
            title: template?.title || name,
            supportsReference: Boolean(info?.supportsReference),
            referenceLimit: Number(info?.maxReferenceImages) || 0,
        };
        const { base, task } = fallbackBaseTask(name, defaultAliasFor(name));
        if (category === "video") {
            meta.durations = template?.durations ?? template?.durationMeta?.durations ?? null;
            meta.durationMeta = template?.durationMeta ?? null;
        }
        items.push({
            name,
            base,
            task,
            category,
            runtime: "local",
            provider: "comfy",
            source: "template",
            template: name,
            channelId: null,
            channelName: "",
            alias: defaultAliasFor(name),
            tokens: Array.isArray(template?.tokens) ? template.tokens : [],
            meta,
        });
    }
    for (const provider of Array.isArray(llmProviders) ? llmProviders : []) {
        const name = String(provider?.name || "").trim();
        if (!name) continue;
        const { base, task } = fallbackBaseTask(name, defaultAliasFor(name));
        items.push({
            name,
            base,
            task,
            category: categoryForChannel(provider),
            runtime: runtimeForProvider(provider),
            provider: "llm",
            source: "channel",
            template: null,
            channelId: name,
            channelName: name,
            alias: defaultAliasFor(name),
            meta: { baseUrl: String(provider?.baseUrl || ""), title: name },
        });
    }
    return items;
}

/** 由可用项描述构造一条 ModelEntry（缺省 enabled=true、alias 取默认别名表）。 */
function entryFromAvailable(item, now) {
    const base = String(item.base ?? "").trim();
    const task = String(item.task ?? "").trim();
    return {
        id: `mdl_${ulid()}`,
        name: String(item.name),
        alias: item.alias || composeAlias(base, task),
        base,
        task,
        category: item.category,
        enabled: true,
        runtime: item.runtime,
        provider: item.provider,
        source: item.source,
        template: item.template ?? null,
        channelId: item.channelId ?? null,
        channelName: item.channelName ?? "",
        script: item.source === "template" ? buildTemplateScript({ name: item.name, family: item.meta?.family, title: item.meta?.title, tokens: item.tokens || [] }) : "",
        meta: item.meta ? { ...item.meta } : {},
        stale: false,
        createdAt: now,
        updatedAt: now,
    };
}

function computeCounts(models) {
    const counts = { text: 0, image: 0, video: 0, audio: 0, total: models.length, enabled: 0 };
    for (const model of models) {
        if (CATEGORIES.includes(model?.category)) counts[model.category] += 1;
        if (model?.enabled) counts.enabled += 1;
    }
    return counts;
}

/** 组间/组内比较器：默认表顺序优先，表外排最后、按 `name` 字典序（§2.4 规则 5）。 */
function byDefaultOrder(keyOf) {
    return (a, b) => {
        const ao = keyOf(a);
        const bo = keyOf(b);
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return 0;
    };
}
const compareName = (a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);

/**
 * 按 `category → base` 聚合（§2.4）：组间 base 顺序 = 默认表首次出现顺序，表外按 `base` 字典序；
 * 组内按默认表顺序，表外按 `name` 字典序。前端可直接渲染成「组头（base）+ 组内行（task）」。
 */
export function buildGroups(models = []) {
    const byBase = new Map();
    for (const model of Array.isArray(models) ? models : []) {
        const base = String(model?.base ?? "").trim() || String(model?.name ?? "").trim();
        if (!base) continue;
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(model);
    }
    const baseNames = [...byBase.keys()].sort((a, b) => {
        const ao = BASE_ORDER.has(a) ? BASE_ORDER.get(a) : null;
        const bo = BASE_ORDER.has(b) ? BASE_ORDER.get(b) : null;
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
    });
    const byCategory = new Map();
    for (const base of baseNames) {
        const group = byBase.get(base).slice().sort(byDefaultOrder((m) => (NAME_ORDER.has(String(m.name)) ? NAME_ORDER.get(String(m.name)) : null)) || compareName);
        const category = String(group[0]?.category || "");
        if (!CATEGORIES.includes(category)) continue;
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push({ base, models: group });
    }
    return CATEGORIES.filter((category) => byCategory.has(category)).map((category) => ({ category, bases: byCategory.get(category) }));
}

/** base/task 入参校验：必须是字符串；base 非空，task 可为空串（表示未命名能力）。 */
function normalizeBaseField(value, field) {
    if (typeof value !== "string") throw httpError(400, `${field} 必须是字符串`);
    const trimmed = value.trim();
    if (field === "base" && !trimmed) throw httpError(400, "base 不能为空");
    return trimmed;
}

/**
 * 注册表存储内核。dataDir 与项目存储同源（config.dataDir）。
 * @param {{ dataDir?: string }} options
 */
export function createModelRegistry({ dataDir } = {}) {
    const file = safeJoin(String(dataDir || "data"), "model-registry.json");

    /** 读整表；缺失/损坏 → 空表（可带 warning），绝不抛 500。 */
    function readDoc() {
        const empty = { version: 1, models: [], updatedAt: null };
        if (!file || !existsSync(file)) return empty;
        try {
            const raw = JSON.parse(readFileSync(file, "utf8"));
            const models = Array.isArray(raw?.models) ? raw.models.filter((m) => m && typeof m === "object") : [];
            return { version: 1, models, updatedAt: raw?.updatedAt || null };
        } catch (error) {
            console.warn(`[model-registry] 文件损坏，按空表处理：${file}（${error.message}）`);
            return { ...empty, warning: `model-registry.json 损坏，按空表处理：${error.message}` };
        }
    }

    /** 临时文件 + 同目录 rename：避免读到写了一半的注册表。 */
    function writeDoc(doc) {
        if (!file) throw httpError(500, "model-registry 存储路径不可用");
        ensureDir(dirname(file));
        const next = { version: 1, models: doc.models, updatedAt: nowIso() };
        const temp = `${file}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(temp, JSON.stringify(next, null, 2));
        renameSync(temp, file);
        return next;
    }

    function get(id) {
        const model = readDoc().models.find((item) => String(item.id) === String(id)) || null;
        // 读取时就地补齐 base/task（不落盘）：老数据在 sync 之前也能被前端正确分组。
        if (model) ensureBaseTask(model);
        return model;
    }

    /** 列出登记项，支持 ?category= / ?enabled= 过滤；counts 恒为「全部登记」的汇总。 */
    function list({ category, enabled } = {}) {
        const doc = readDoc();
        doc.models.forEach(ensureBaseTask);
        let models = doc.models;
        const wantedCategory = String(category || "").trim();
        if (wantedCategory) models = models.filter((model) => model.category === wantedCategory);
        if (enabled !== undefined && enabled !== null && String(enabled) !== "") {
            const want = enabled === true || String(enabled).toLowerCase() === "true";
            models = models.filter((model) => Boolean(model.enabled) === want);
        }
        return { models, counts: computeCounts(doc.models), groups: buildGroups(models), warning: doc.warning };
    }

    function create(input = {}) {
        const name = String(input.name || "").trim();
        if (!name) throw httpError(400, "缺少 name");
        const category = String(input.category || "").trim();
        if (!CATEGORIES.includes(category)) throw httpError(400, `category 必须是 ${CATEGORIES.join(" / ")} 之一`);
        const doc = readDoc();
        if (doc.models.some((model) => String(model.name) === name)) throw httpError(409, `模型已登记：${name}`);

        const source = SOURCES.includes(input.source) ? input.source : "manual";
        const runtime = RUNTIMES.includes(input.runtime) ? input.runtime : source === "channel" ? "cloud" : "local";
        const template = input.template != null ? String(input.template) : source === "template" ? name : null;
        const channelId = input.channelId != null ? String(input.channelId) : source === "channel" ? name : null;
        const channelName = input.channelName != null ? String(input.channelName) : source === "channel" ? name : "";
        const provider = input.provider != null ? String(input.provider) : source === "template" ? "comfy" : source === "channel" ? "llm" : "manual";
        const script = input.script != null ? String(input.script) : template && source === "template" ? buildTemplateScript({ name: template, family: input.meta?.family }) : "";

        // base/task：显式传入优先，缺则按 §2.5 默认表 / alias 拆分 / name 回落；alias 为组合视图。
        const fallback = fallbackBaseTask(name, input.alias);
        const base = input.base != null ? normalizeBaseField(input.base, "base") : fallback.base;
        let task;
        if (input.task != null) task = normalizeBaseField(input.task, "task");
        else if (input.base != null) task = base === fallback.base ? fallback.task : "";
        else task = fallback.task;
        const alias = input.alias != null ? String(input.alias) : composeAlias(base, task);

        const now = nowIso();
        const model = {
            id: `mdl_${ulid()}`,
            name,
            alias,
            base,
            task,
            category,
            enabled: input.enabled === undefined ? true : Boolean(input.enabled),
            runtime,
            provider,
            source,
            template,
            channelId,
            channelName,
            script,
            meta: input.meta && typeof input.meta === "object" ? { ...input.meta } : {},
            stale: false,
            createdAt: now,
            updatedAt: now,
        };
        doc.models.push(model);
        writeDoc(doc);
        return model;
    }

    /** 局部更新：alias / enabled / category / base / task 生效；name 不可改。改 base 或 task 会重算 alias。 */
    function update(id, patch = {}) {
        const doc = readDoc();
        const model = doc.models.find((item) => String(item.id) === String(id));
        if (!model) throw httpError(404, `模型不存在：${id}`);
        if (patch?.name !== undefined && String(patch.name) !== String(model.name)) {
            throw httpError(400, "name 不可修改（真实标识不可变，要改只能删了重建）");
        }
        if (patch?.alias !== undefined) model.alias = patch.alias == null ? "" : String(patch.alias);
        if (patch?.enabled !== undefined) model.enabled = Boolean(patch.enabled);
        if (patch?.category !== undefined) {
            const category = String(patch.category).trim();
            if (!CATEGORIES.includes(category)) throw httpError(400, `category 必须是 ${CATEGORIES.join(" / ")} 之一`);
            model.category = category;
        }
        // 老条目可能还没有 base/task：改它们之前先补齐另一半，避免 composeAlias 丢字段。
        if (patch?.base !== undefined || patch?.task !== undefined) ensureBaseTask(model);
        if (patch?.base !== undefined) model.base = normalizeBaseField(patch.base, "base");
        if (patch?.task !== undefined) model.task = normalizeBaseField(patch.task, "task");
        // alias 是 base + 空格 + task 的组合视图：base/task 任一改动都重算（显式改 alias 会被覆盖）。
        if (patch?.base !== undefined || patch?.task !== undefined) model.alias = composeAlias(model.base, model.task);
        model.updatedAt = nowIso();
        writeDoc(doc);
        return model;
    }

    function remove(id) {
        const doc = readDoc();
        const index = doc.models.findIndex((item) => String(item.id) === String(id));
        if (index < 0) throw httpError(404, `模型不存在：${id}`);
        const [removed] = doc.models.splice(index, 1);
        writeDoc(doc);
        return { removed };
    }

    /**
     * 从服务端「实际可用」同步：缺失的补登记（enabled 默认 true、base/task/alias 取默认表）；
     * 已消失的置 stale:true（**不删**）；回归的清除 stale。
     * 同时**幂等回填**存量条目缺失的 base/task（只补字段，绝不覆盖用户改过的 alias/enabled）。
     * 手工登记项不由 sync 判定 stale。
     */
    function sync(sources = {}) {
        const available = computeAvailable(sources);
        const doc = readDoc();
        // 存量回填：仅补缺失的 base/task（命中默认表 / 拆 alias / 回落 name），不碰 alias/enabled。
        let backfilled = 0;
        for (const model of doc.models) {
            if (ensureBaseTask(model)) backfilled += 1;
        }
        const byName = new Map(doc.models.map((model) => [String(model.name), model]));
        const now = nowIso();
        const added = [];
        for (const item of available) {
            if (byName.has(item.name)) continue;
            const model = entryFromAvailable(item, now);
            doc.models.push(model);
            byName.set(item.name, model);
            added.push(item.name);
        }
        const availableNames = new Set(available.map((item) => item.name));
        const staled = [];
        for (const model of doc.models) {
            if (model.source === "manual") continue;
            const present = availableNames.has(String(model.name));
            if (!present) {
                if (!model.stale) {
                    model.stale = true;
                    model.updatedAt = now;
                    staled.push(model.name);
                }
            } else if (model.stale) {
                model.stale = false;
                model.updatedAt = now;
            }
        }
        writeDoc(doc);
        return { added, staled, kept: doc.models.length - added.length, backfilled };
    }

    /** 服务端发现的可用模型（未登记项也含），供配置页显示「可补」差异。 */
    function available(sources = {}) {
        const items = computeAvailable(sources);
        const doc = readDoc();
        const names = new Set(doc.models.map((model) => String(model.name)));
        const missing = items.filter((item) => !names.has(item.name));
        return { available: items, registered: doc.models.length, missing };
    }

    return { file, readDoc, writeDoc, get, list, create, update, remove, sync, available };
}

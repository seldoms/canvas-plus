import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";

import { artifactUrl, ensureDir, saveBuffer } from "../files.js";
// 时长档位（模型能力元数据）的唯一事实源：与「模型清单」同源挂到每个模板上，随 /api/providers 输出。
import { durationMetaForTemplate } from "../durations.js";

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/** Artifact.type 按扩展名判定。 */
const MEDIA_TYPES = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".bmp": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
    ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio",
};

/** history 条目里可能出现产物的字段。 */
const OUTPUT_KEYS = ["images", "gifs", "videos", "audio"];

const TITLES = {
    img_zimage_artistic: "ZImage 艺术生图",
    img_flux_artistic: "Flux 艺术生图",
    img_krea2_artistic: "Krea2 艺术生图",
    img_boogu_outfit_edit: "Boogu 换装编辑",
    img_qwen21_t2i: "Qwen-Image 2.1 文生图",
    img_qwen21_edit: "Qwen-Image 2.1 指令改图",
    upscale_4x: "4 倍放大",
    video_h3_i2v: "H3 图生视频",
    video_h3_i2v_fl: "H3 首尾帧多参考图生视频",
    video_h3_ref2v: "H3 参考视频生视频",
    video_h3_ref2v_image: "H3 参考图生视频",
    video_h3_ref2v_image_turbo: "H3 参考图生视频（Turbo 8 步）",
    video_h3_quantfunc_ref2v: "H3 参考图生视频（QuantFunc INT4）",
    video_minimax_h3_t2v: "MiniMax H3 文生视频",
    video_h3_talk: "H3 台词对口型",
    video_wan_animate: "Wan 动画驱动",
    scail2_action_transfer: "Scail2 动作迁移",
    audio_qwen3_tts: "Qwen3-TTS 语音合成",
};

function tokensIn(text) {
    const tokens = [];
    for (const match of text.matchAll(TOKEN_RE)) {
        if (!tokens.includes(match[1])) tokens.push(match[1]);
    }
    return tokens;
}

/** JSON.stringify 后去掉字符串的首尾引号，让值安全嵌进模板里已有的 "{{TOKEN}}" 引号内；数字/布尔原样嵌入。 */
function escapeValue(value) {
    const text = JSON.stringify(value);
    if (text === undefined) return "";
    return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/** 模板里的值都写在引号内，替换完成后把纯数字字符串还原成 number。 */
/**
 * 把「dict 的直接字符串值」里的纯数字转成 number，与 Python 执行器 run_pipeline.py 的 fixnum 语义保持一致。
 * 关键：**不要**转换数组里的字符串。节点引用 `["10", 0]` 必须保持字符串，ComfyUI 校验时会用它当
 * prompt 字典的键（`prompt[o_id]`），数字化后会抛 KeyError: prompt_outputs_failed_validation。
 */
function toNumberTree(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
            const item = value[key];
            value[key] = typeof item === "string" && /^-?\d+(\.\d+)?$/.test(item) ? Number(item) : toNumberTree(item);
        }
        return value;
    }
    return value;
}

export function extractTokens(templatePath) {
    return tokensIn(readFileSync(templatePath, "utf8"));
}

export function renderTemplate(templatePath, params = {}) {
    const text = readFileSync(templatePath, "utf8");
    const missing = tokensIn(text).filter((name) => params[name] === undefined || params[name] === null);
    if (missing.length) throw new Error(`模板缺少参数：${missing.join("、")}`);
    return toNumberTree(JSON.parse(text.replace(TOKEN_RE, (_, name) => escapeValue(params[name]))));
}

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

/**
 * 把 lora_name 为空的 LoRA 节点从图中摘除，并把它的下游重连到它的上游。返回被摘除的节点 id 数组。
 * LoraLoader（双输出 MODEL+CLIP）无法安全重连，仍抛错要求显式传 LORA_FILE 或在模板里固定。
 */
export function disableEmptyLoras(graph) {
    const nodes = graph || {};
    for (const [id, node] of Object.entries(nodes)) {
        if (node?.class_type === "LoraLoader" && isBlank(node.inputs?.lora_name)) {
            throw new Error(`LoRA 节点 ${id} 缺少 lora_name，且该节点类型不支持自动摘除，请在模板里固定 LoRA 或调用时显式传入 LORA_FILE`);
        }
    }

    const removed = [];
    for (const [id, node] of Object.entries(nodes)) {
        if (node?.class_type !== "LoraLoaderModelOnly" || !isBlank(node.inputs?.lora_name)) continue;
        const upstream = node.inputs?.model;
        if (!Array.isArray(upstream)) {
            console.warn(`LoRA 节点 ${id} 缺少 inputs.model，无法自动摘除，已跳过`);
            continue;
        }
        delete nodes[id];
        removed.push(id);
        for (const target of Object.values(nodes)) {
            for (const [key, value] of Object.entries(target?.inputs || {})) {
                // renderTemplate 会把纯数字字符串（含节点 id 引用）转成 number，这里必须按字符串比较，
                // 否则 "3".inputs.model = [2, 0] 这种引用匹配不上被摘除的节点 "2"。
                if (Array.isArray(value) && String(value[0]) === String(id)) target.inputs[key] = upstream;
            }
        }
    }
    return removed;
}

/**
 * 把 image 为空的 LoadImage 节点摘除，并删掉所有引用它的输入键。返回被摘除的节点 id 数组。
 * 用于 Qwen-Image 2.1 这类「多张参考图、每张都可选（Autogrow min=0）」的节点：调用方对不用的槽位传空串即可，
 * 不必为每种参考图数量各做一个模板。与 disableEmptyLoras 的区别是这里直接删引用键，不需要重连下游。
 */
export function disableEmptyImageRefs(graph) {
    const nodes = graph || {};
    const removed = [];
    for (const [id, node] of Object.entries(nodes)) {
        if (node?.class_type !== "LoadImage" || !isBlank(node.inputs?.image)) continue;
        delete nodes[id];
        removed.push(id);
        for (const target of Object.values(nodes)) {
            for (const [key, value] of Object.entries(target?.inputs || {})) {
                // 同 disableEmptyLoras：节点引用被 toNumberTree 保持为字符串，必须按字符串比较。
                if (Array.isArray(value) && String(value[0]) === String(id)) delete target.inputs[key];
            }
        }
    }
    return removed;
}

function familyOf(name) {
    if (name.startsWith("upscale")) return "upscale";
    if (name.startsWith("video")) return "video";
    if (name.startsWith("img")) return name.includes("edit") ? "edit" : "image";
    return "edit";
}

/** 扫描 workflows 目录，返回 TemplateInfo[]（name/family/title/tokens/durations）。 */
export function listTemplates(workflowsDir) {
    if (!workflowsDir || !existsSync(workflowsDir)) return [];
    return readdirSync(workflowsDir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => {
            const name = file.slice(0, -5);
            // 档位随清单同源下发：D1「时长档位跟着模型走」，前端从该字段读，不硬编码。
            const durationMeta = durationMetaForTemplate(name);
            return {
                name,
                family: familyOf(name),
                title: TITLES[name] || name,
                tokens: extractTokens(join(workflowsDir, file)),
                durations: durationMeta.durations,
                durationMeta,
            };
        });
}

export function createComfyClient(config) {
    const settings = config?.comfy || {};
    const root = String(settings.baseUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
    const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : 7200;
    const auth = settings.username
        ? `Basic ${Buffer.from(`${settings.username}:${settings.password || ""}`).toString("base64")}`
        : null;

    /** 统一出口：超时、Basic Auth、错误信息都收敛在这里。 */
    async function request(path, init = {}) {
        const response = await fetch(`${root}${path}`, {
            ...init,
            headers: { ...(auth ? { authorization: auth } : {}), ...init.headers },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`ComfyUI ${init.method || "GET"} ${path} 失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
        }
        return response;
    }

    const json = async (path, init) => (await request(path, init)).json();

    async function probe() {
        try {
            const stats = await json("/system_stats");
            return {
                ok: true,
                baseUrl: root,
                version: stats?.system?.comfyui_version,
                devices: (stats?.devices || []).map((device) => ({ name: device.name, vramTotal: device.vram_total, vramFree: device.vram_free })),
            };
        } catch (error) {
            // 失败也保留 devices:[] —— /api/health 的 comfy 段字段结构（ok/baseUrl/devices）是前端契约，失败时不能缺字段。
            return { ok: false, baseUrl: root, devices: [], error: error.message };
        }
    }

    const objectInfo = (node) => json(node ? `/object_info/${encodeURIComponent(node)}` : "/object_info");
    const systemStats = () => json("/system_stats");

    async function queueCounts() {
        const queue = await json("/queue");
        return { running: (queue?.queue_running || []).length, pending: (queue?.queue_pending || []).length };
    }

    async function uploadFile(buffer, filename = "upload.png", type = "input") {
        const name = basename(filename) || "upload.png";
        const form = new FormData();
        form.append("image", new Blob([buffer]), name);
        form.append("type", type);
        form.append("overwrite", "true");
        const result = await json("/upload/image", { method: "POST", body: form });
        const stored = result?.name || name;
        return result?.subfolder ? `${result.subfolder}/${stored}` : stored;
    }

    async function queuePrompt(graph, clientId = randomUUID()) {
        const result = await json("/prompt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: graph, client_id: clientId }),
        });
        if (!result?.prompt_id) throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(result).slice(0, 300)}`);
        return result.prompt_id;
    }

    async function history(promptId) {
        const result = await json(`/history/${encodeURIComponent(promptId)}`);
        return result?.[promptId] || null;
    }

    async function view({ filename, subfolder = "", type = "output" }) {
        const query = new URLSearchParams({ filename, subfolder, type });
        return Buffer.from(await (await request(`/view?${query}`)).arrayBuffer());
    }

    async function interrupt() {
        await request("/interrupt", { method: "POST" });
    }

    return { probe, objectInfo, systemStats, queueCounts, uploadFile, queuePrompt, history, view, interrupt };
}

export async function probeComfy(config) {
    return createComfyClient(config).probe();
}

export async function listComfyCapabilities(config) {
    const client = createComfyClient(config);
    // 整张 /object_info 体积很大且慢，只取用得到的三个加载器节点。
    const [checkpointInfo, loraInfo, vaeInfo] = await Promise.all([
        client.objectInfo("CheckpointLoaderSimple"),
        client.objectInfo("LoraLoader"),
        client.objectInfo("VAELoader"),
    ]);
    // ComfyUI 不同版本/节点的枚举写法有两种：[[可选值], {...}] 与 ["COMBO", { options: [...] }]。
    const names = (info, node, field) => {
        const spec = info?.[node]?.input?.required?.[field];
        if (!Array.isArray(spec)) return [];
        return Array.isArray(spec[0]) ? spec[0] : spec[1]?.options || [];
    };
    return {
        templates: listTemplates(config.workflowsDir),
        models: {
            checkpoints: names(checkpointInfo, "CheckpointLoaderSimple", "ckpt_name"),
            loras: names(loraInfo, "LoraLoader", "lora_name"),
            vae: names(vaeInfo, "VAELoader", "vae_name"),
        },
    };
}

/** 把 history 条目里的产物逐项下载到 data/artifacts/<jobId>/，返回 Artifact[]。 */
export async function collectOutputs(entry, jobId, config, client) {
    const dir = ensureDir(join(config.dataDir, "artifacts", jobId));
    const artifacts = [];
    for (const output of Object.values(entry?.outputs || {})) {
        for (const key of OUTPUT_KEYS) {
            for (const item of output?.[key] || []) {
                if (!item?.filename) continue;
                const filename = basename(item.filename);
                const buffer = await client.view({ filename: item.filename, subfolder: item.subfolder, type: item.type });
                await saveBuffer(join(dir, filename), buffer);
                artifacts.push({
                    filename,
                    url: artifactUrl(config, jobId, filename),
                    type: MEDIA_TYPES[extname(filename).toLowerCase()] || "file",
                    bytes: buffer.length,
                    ...(Number.isFinite(item.width) ? { width: item.width } : {}),
                    ...(Number.isFinite(item.height) ? { height: item.height } : {}),
                });
            }
        }
    }
    return artifacts;
}

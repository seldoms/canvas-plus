import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { artifactUrl, ensureDir, safeJoin, sanitizeName, saveBuffer } from "./files.js";
import { MEDIA_TYPES, collectOutputs, disableEmptyImageRefs, disableEmptyLoras, extractTokens, renderTemplate } from "./providers/comfy.js";

/** 这些 token 的值是素材（本机路径 / 远端 URL / 网关产物地址），提交前要先上传到 ComfyUI。 */
export const ASSET_TOKENS = [
    "INPUT_IMAGE",
    // 首尾帧视频模板（video_h3_i2v_fl）用 FIRST_FRAME/LAST_FRAME 命名首帧与尾帧，语义上与 INPUT_IMAGE 同源，
    // 也必须先上传到 ComfyUI 再接线；LAST_FRAME 是可选槽（见 isOptionalRef）。
    "FIRST_FRAME",
    "LAST_FRAME",
    "REF_VIDEO",
    "PERSON_IMAGE",
    "CLOTHING_IMAGE",
    // 对口型（video_lipsync）：输入是「已有片段 + 该镜 TTS 音频」，二者都必须先上传到 ComfyUI 输入目录再接线。
    "INPUT_VIDEO",
    "INPUT_AUDIO",
    // REF_IMAGE_1..9 是「额外参考图」槽位，Qwen-Image 2.1 最多支持 10 张（INPUT_IMAGE 占第 1 张）。
    ...Array.from({ length: 9 }, (_, index) => `REF_IMAGE_${index + 1}`),
];

/**
 * 音频类素材槽：上传后需带 `input/` 前缀才能被 VHS_LoadAudio 之类按「输入目录相对路径」读取的节点找到
 * （图像槽走 LoadImage，只认裸文件名，绝不加前缀，否则会破坏既有生图/生视频模板）。
 */
const AUDIO_ASSET_TOKENS = new Set(["INPUT_AUDIO"]);

/**
 * 可选图像素材 token：缺省填空串，渲染后由 disableEmptyImageRefs 把对应的 LoadImage 节点摘掉（而不是报错）。
 * - REF_IMAGE_n：多参考图槽位，Qwen-Image 2.1 / H3 ref_images(autogrow) 都按「用几张给几张」调用；
 * - LAST_FRAME：首尾帧模板的尾帧，未给时摘掉 last_frame 的 LoadImage 即可退回单首帧（节点 last_frame 本就是 optional）。
 */
const isOptionalRef = (token) => /^REF_IMAGE_\d+$/.test(token) || token === "LAST_FRAME";

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new Error("已取消"));
            },
            { once: true },
        );
    });
}

/**
 * 本地 ComfyUI 执行器。生图/生视频默认且必须走这里。
 */
export function createLocalRunner({ config, comfy, jobs }) {
    /** 把本机路径 / 网关产物地址 / 远端 URL 统一转成 ComfyUI 侧的素材引用名。 */
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
            const buffer = await readFile(file);
            return comfy.uploadFile(buffer, sanitizeName(segments.pop()));
        }
        if (text.startsWith("comfy:") || !text.includes("/")) return text;
        const buffer = await readFile(text);
        return comfy.uploadFile(buffer, sanitizeName(text.split(/[\\/]/).pop()));
    }

    /**
     * 缓存命中兜底：ComfyUI 执行缓存命中时 `/history` 的 `outputs` 为空，本函数按 `OUTPUT_PREFIX`
     * 从输出目录**按文件名**回落取回产物（下载后仍落 `data/artifacts/<jobId>/`，与正常产物同一登记链路）。
     * 仅对显式声明 `RECOVER_BY_PREFIX` 的任务生效（对口型），不改变其它模板「无产物即失败」的语义。
     * 命名约定来自视频合成节点：`<prefix>_00001-audio.mp4`（首次写入序号 00001），并兼容无 `-audio` 后缀的保存节点。
     */
    async function recoverByOutputPrefix(job, config, comfy) {
        if (job?.params?.RECOVER_BY_PREFIX !== true) return [];
        const prefix = String(job?.params?.OUTPUT_PREFIX || "").replace(/\\/g, "/").trim();
        if (!prefix) return [];
        const dir = dirname(prefix);
        const subfolder = dir && dir !== "." ? dir : "";
        const base = basename(prefix);
        const candidates = [`${base}_00001-audio.mp4`, `${base}_00001.mp4`];
        const outDir = ensureDir(join(config.dataDir, "artifacts", job.id));
        for (const filename of candidates) {
            let buffer;
            try {
                buffer = await comfy.view({ filename, subfolder, type: "output" });
            } catch {
                continue;
            }
            if (!buffer || !buffer.length) continue;
            await saveBuffer(join(outDir, filename), buffer);
            return [{ filename, url: artifactUrl(config, job.id, filename), type: MEDIA_TYPES[extname(filename).toLowerCase()] || "file", bytes: buffer.length, recovered: true }];
        }
        return [];
    }

    /** 生图/生视频任务的真实执行体：渲染模板 → 提交 ComfyUI → 轮询 → 回收产物。 */
    async function runJob(job, ctx) {
        const templatePath = safeJoin(config.workflowsDir, `${job.template}.json`);
        if (!templatePath) throw new Error(`非法模板名：${job.template}`);

        const params = { ...job.params };
        delete params.endpoint;
        params.SEED ??= Math.floor(Math.random() * 2 ** 31);
        params.OUTPUT_PREFIX ??= `canvas/${sanitizeName(job.name || job.id)}`;

        // 模板要求的 token 全部补齐：LoRA 与额外参考图允许缺省，缺省时分别由 disableEmptyLoras /
        // disableEmptyImageRefs 把对应节点摘掉，这样调用方（画布前端）不需要知道该用哪个文件名、
        // 也不需要为「用了几张参考图」挑不同模板。
        for (const token of extractTokens(templatePath)) {
            if (params[token] !== undefined) continue;
            if (token === "LORA_FILE") params[token] = "";
            else if (token === "LORA_STRENGTH") params[token] = 1;
            else if (isOptionalRef(token)) params[token] = "";
            else throw new Error(`模板 ${job.template} 缺少参数：${token}`);
        }

        for (const token of ASSET_TOKENS) {
            if (params[token]) {
                const uploaded = await resolveAsset(params[token]);
                // 音频槽节点（VHS_LoadAudio）按「输入目录相对路径」找文件；图像槽只认裸文件名，绝不加前缀。
                params[token] = AUDIO_ASSET_TOKENS.has(token) && !uploaded.startsWith("input/") ? `input/${uploaded}` : uploaded;
            }
        }

        // H3 视频节点硬性要求宽高可被 32 整除（conditioning.py 直接抛 ValueError），
        // 画布侧传 auto/任意尺寸时在网关吸附到最近的 32 倍数，保护所有调用方。
        if (job.template.startsWith("video_")) {
            for (const key of ["WIDTH", "HEIGHT"]) {
                const value = Number(params[key]);
                if (Number.isFinite(value) && value > 0) {
                    const snapped = Math.max(32, Math.round(value / 32) * 32);
                    if (snapped !== value) {
                        console.log(`[job ${job.id}] ${key} ${value} 不可被 32 整除，吸附为 ${snapped}`);
                        params[key] = snapped;
                    }
                }
            }
        }

        const graph = renderTemplate(templatePath, params);
        const removed = disableEmptyLoras(graph);
        if (removed.length) console.log(`[job ${job.id}] 未指定 LoRA，已摘除节点 ${removed.join(", ")}`);
        const removedRefs = disableEmptyImageRefs(graph);
        if (removedRefs.length) console.log(`[job ${job.id}] 未指定的参考图槽位，已摘除节点 ${removedRefs.join(", ")}`);

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

        let outputs = await collectOutputs(entry, job.id, config, comfy);
        // 前置坑（必处理）：ComfyUI 命中**执行缓存**时，同一输入的 /history 会返回空 `outputs: {}` ——
        // 提交成功却拿不到产物路径，若直接判失败就是误判。带 RECOVER_BY_PREFIX 的任务（对口型）在
        // outputs 为空时按 OUTPUT_PREFIX 从输出目录按文件名回落兜底取回产物，绝不假定「提交后一定有路径」。
        if (!outputs.length) {
            const recovered = await recoverByOutputPrefix(job, config, comfy);
            if (recovered.length) {
                console.warn(`[job ${job.id}] history 无 outputs（疑似缓存命中），已按 OUTPUT_PREFIX 从输出目录回落取回 ${recovered.length} 个产物`);
                outputs = recovered;
            }
        }
        if (!outputs.length) throw new Error("ComfyUI 未返回任何产物，请检查模板的输出节点");
        ctx.progress(outputs.length, outputs.length, "已完成");
        return { outputs };
    }

    /** 统一的入队入口：本地后端只认工作流模板名。 */
    function submit(body) {
        const kind = body.kind;
        const template = String(body.template || "").trim();
        if (!template) throw new Error("缺少 template");
        if (!safeJoin(config.workflowsDir, `${template}.json`)) throw new Error(`非法模板名：${template}`);
        const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        return jobs.enqueue({ id, kind, backend: "local", template, name: body.name || template, params: { ...(body.params || {}) }, meta: body.meta }, runJob);
    }

    return { runJob, resolveAsset, submit };
}

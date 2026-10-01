import { readFile } from "node:fs/promises";

import { safeJoin, sanitizeName } from "./files.js";
import { collectOutputs, disableEmptyLoras, extractTokens, renderTemplate } from "./providers/comfy.js";

/** 这些 token 的值是素材（本机路径 / 远端 URL / 网关产物地址），提交前要先上传到 ComfyUI。 */
export const ASSET_TOKENS = ["INPUT_IMAGE", "REF_VIDEO", "PERSON_IMAGE", "CLOTHING_IMAGE", "REF_IMAGE_1", "REF_IMAGE_2", "REF_IMAGE_3"];

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

    /** 生图/生视频任务的真实执行体：渲染模板 → 提交 ComfyUI → 轮询 → 回收产物。 */
    async function runJob(job, ctx) {
        const templatePath = safeJoin(config.workflowsDir, `${job.template}.json`);
        if (!templatePath) throw new Error(`非法模板名：${job.template}`);

        const params = { ...job.params };
        delete params.endpoint;
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

        for (const token of ASSET_TOKENS) {
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

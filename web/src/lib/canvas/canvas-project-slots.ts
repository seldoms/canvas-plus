/**
 * 画布 → 项目槽位的生成 / 登记流程（M2）。
 *
 * 只覆盖绑定画布（M2-D1）的两条路径：
 * - 生成新候选：取节点提示词与参考图，经服务端 POST /api/generate/image 入队（source="canvas" + 归属 + 幂等键），轮询终态取 artifact URL。
 * - 加入项目候选：把存量画布图片 Blob 经 POST /api/artifacts/import 登记；传了 slotId 服务端自动投影为候选，不再重复调 candidates 追加。
 */
import i18n from "@/i18n";
import { importArtifact, type ArtifactImportResult } from "@/services/api/artifacts";
import { fetchGatewayJob, submitGatewayImage, uploadGatewayAsset, type GatewayJob } from "@/services/api/gateway";
import { listModelRegistry } from "@/services/api/model-registry";
import { defaultSizeFor, findTemplate, loadTemplateCatalog, type GatewayTemplateInfo } from "@/services/api/template-sizes";
import { getImageBlob } from "@/services/image-storage";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { resolveMetadataReferences, sourceNodeReferenceImages } from "@/lib/canvas/canvas-generation-helpers";
import type { ReferenceImage } from "@/types/image";
import type { CanvasNodeData } from "@/types/canvas";

/** 槽位归属（生成 / 登记的 meta 与 import 字段共用）。 */
export type SlotTarget = {
    projectId: string;
    episodeId: string;
    sceneId: string;
    shotId: string;
    slotId: string;
};

export type SlotGeneratedImage = {
    /** 服务端 artifact 相对路径（/api/artifacts/...），直接作为节点 metadata.content。 */
    artifactUrl: string;
    width: number;
    height: number;
    jobId: string;
    template: string;
};

/** 取节点用于生成的提示词；为空由调用方挡下。 */
export function nodeGenerationPrompt(node: CanvasNodeData) {
    return (node.metadata?.prompt || node.metadata?.composerContent || "").trim();
}

/**
 * 服务端注册表的默认生图工具：优先启用登记项里指向本地模板的条目，否则取模板清单第一个。
 * 模板信息（tokens / 官方规格）与模板名同源返回；清单不可达时返回 null，由调用方提示。
 */
export async function resolveDefaultImageTemplate(): Promise<{ name: string; info: GatewayTemplateInfo | null } | null> {
    const catalog = await loadTemplateCatalog("image").catch(() => [] as GatewayTemplateInfo[]);
    const registered = await listModelRegistry({ category: "image", enabled: true }).catch(() => []);
    const entry = registered.find((model) => model.template && catalog.some((template) => template.name === model.template)) || registered.find((model) => model.template);
    const name = entry?.template || catalog[0]?.name || "";
    if (!name) return null;
    return { name, info: findTemplate(catalog, name) };
}

/** 节点的参考图：自身图片（若有内容）+ metadata.references 解析结果。 */
async function nodeReferenceImages(node: CanvasNodeData): Promise<ReferenceImage[]> {
    const own = sourceNodeReferenceImages(node);
    const referenced = (await resolveMetadataReferences(node.metadata || {})) || [];
    return [...own, ...referenced];
}

function parseSize(size?: string | null): [number, number] {
    const matched = String(size || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    return matched ? [Number(matched[1]), Number(matched[2])] : [1024, 1024];
}

/** 轮询单 Job 到终态（沿用工作台「GET /api/jobs/:id 轮询」的做法）。 */
async function waitForJob(jobId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<GatewayJob> {
    const intervalMs = options?.intervalMs ?? 2000;
    const deadline = Date.now() + (options?.timeoutMs ?? 15 * 60 * 1000);
    for (;;) {
        const job = await fetchGatewayJob(jobId);
        if (job.status === "done") return job;
        if (job.status === "error" || job.status === "canceled") throw new Error(job.error || i18n.t("workbench.generationFailed"));
        if (Date.now() > deadline) throw new Error(i18n.t("workbench.generationFailed"));
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

/**
 * 生成新候选：按默认生图工具提交 POST /api/generate/image（source="canvas"，meta 带槽位归属与幂等键），
 * 轮询到终态后返回 artifact 相对路径。幂等键按「节点 + 槽位 + 提交时刻」生成。
 */
export async function generateSlotCandidateImage(node: CanvasNodeData, target: SlotTarget): Promise<SlotGeneratedImage> {
    const prompt = nodeGenerationPrompt(node);
    if (!prompt) throw new Error(i18n.t("canvas.slotDialog.noPrompt"));
    const resolved = await resolveDefaultImageTemplate();
    if (!resolved) throw new Error(i18n.t("canvas.slotDialog.noTemplate"));
    const tokens = resolved.info?.tokens || ["PROMPT", "WIDTH", "HEIGHT", "BATCH", "SEED"];
    const has = (token: string) => tokens.includes(token);
    const params: Record<string, unknown> = {};
    if (has("PROMPT")) params.PROMPT = prompt;
    const [width, height] = parseSize(defaultSizeFor(resolved.info) || node.metadata?.size);
    if (has("WIDTH")) params.WIDTH = width;
    if (has("HEIGHT")) params.HEIGHT = height;
    if (has("BATCH")) params.BATCH = 1;
    if (has("SEED")) params.SEED = Math.floor(Math.random() * 2147483647);
    const imageTokens = tokens.filter((token) => token === "INPUT_IMAGE" || token === "PERSON_IMAGE" || token === "CLOTHING_IMAGE" || /^REF_IMAGE_\d+$/.test(token));
    if (imageTokens.length) {
        const references = await nodeReferenceImages(node);
        if (!references.length) throw new Error(i18n.t("canvas.slotDialog.noReference"));
        for (let index = 0; index < imageTokens.length && index < references.length; index++) {
            const reference = references[index];
            const blob = reference.storageKey ? await getImageBlob(reference.storageKey) : reference.dataUrl ? await (await fetch(resolveGatewayUrl(reference.dataUrl))).blob() : null;
            if (!blob) throw new Error(i18n.t("canvas.slotDialog.noReference"));
            const { comfyName } = await uploadGatewayAsset(blob);
            params[imageTokens[index]] = comfyName;
        }
    }
    const idempotencyKey = `canvas_${node.id}_${target.slotId}_${Date.now()}`;
    const job = await submitGatewayImage({
        template: resolved.name,
        name: `canvas_slot_${Date.now()}`,
        params,
        source: "canvas",
        meta: { source: "canvas", ...target, idempotencyKey },
    });
    const done = await waitForJob(job.id);
    const output = (done.outputs || []).find((item) => item?.url && (!item.type || item.type === "image"));
    if (!output) throw new Error(i18n.t("workbench.generationFailed"));
    return { artifactUrl: output.url, width: output.width || width, height: output.height || height, jobId: done.id, template: resolved.name };
}

async function nodeImageBlob(node: CanvasNodeData): Promise<Blob | null> {
    const storageKey = node.metadata?.storageKey;
    if (storageKey) {
        const blob = await getImageBlob(storageKey);
        if (blob) return blob;
    }
    const content = node.metadata?.content || node.metadata?.artifactUrl;
    if (!content || content.startsWith("blob:")) return null;
    try {
        return await (await fetch(resolveGatewayUrl(content))).blob();
    } catch {
        return null;
    }
}

/** 节点内容指纹：图片字节 sha256 hex，作为 import 幂等键。 */
async function contentFingerprint(blob: Blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 加入项目候选：登记存量画布图片为 Artifact；传了 slotId，服务端自动投影为候选，不要重复调 candidates 追加。 */
export async function importNodeImageCandidate(node: CanvasNodeData, target: SlotTarget): Promise<ArtifactImportResult> {
    const blob = await nodeImageBlob(node);
    if (!blob) throw new Error(i18n.t("canvas.slotDialog.noImage"));
    const idempotencyKey = `canvas_import_${await contentFingerprint(blob)}`;
    return importArtifact(blob, { source: "canvas", ...target, idempotencyKey }, `${node.title || node.id}.png`);
}

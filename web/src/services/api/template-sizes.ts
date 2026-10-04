/**
 * 模板规格（画幅）目录 —— 「画幅口径跟模型建议尺寸走」的前端取数层。
 *
 * 规格（官方建议分辨率）由后端 `GET /api/providers` 的 `comfy.templates[].sizes` 下发
 * （唯一事实源 `canvas-server/src/sizes.js` → `research/win147-comfyui/registry.json`）。
 * 前端**不硬编码任何模型/规格清单**，只读取、展示、把选中的 WxH 交给提交层
 * （`enqueueImages({ size })` → 后端 `parseSize` → `params.WIDTH/HEIGHT`）。
 */
import { fetchGatewayProviders, probeGatewayBaseUrl, type GatewayTemplateInfo, type GatewayTemplateSize } from "./gateway";

export type { GatewayTemplateInfo, GatewayTemplateSize };

/** 规格下拉选项：value=WxH（提交口径），label=像素 · 画幅。 */
export type TemplateSizeOption = { value: string; label: string; ratio: string; source: string; official: boolean };

/** 从后端模板清单取某 family 的模板（含 sizes）；网关不可达时返回 []。 */
export async function loadTemplateCatalog(family?: "image" | "video"): Promise<GatewayTemplateInfo[]> {
    const base = await probeGatewayBaseUrl();
    const providers = await fetchGatewayProviders(base);
    const templates = providers.comfy?.templates ?? [];
    return family ? templates.filter((template) => template.family === family) : templates;
}

/** 按后端模板名取模板信息。 */
export function findTemplate(templates: GatewayTemplateInfo[], name: string): GatewayTemplateInfo | null {
    return templates.find((template) => template.name === name) || null;
}

/** 模板官方规格 → 下拉选项；规格未查证 / 无独立规格返回 null（前端只展示「待查证」，不许自由填）。 */
export function sizeOptionsFor(template?: GatewayTemplateInfo | null): TemplateSizeOption[] | null {
    const sizes = template?.sizes;
    if (!Array.isArray(sizes) || !sizes.length) return null;
    return sizes.map((size) => ({
        value: size.value,
        label: `${size.value} · ${size.ratio}`,
        ratio: size.ratio,
        source: size.source,
        official: size.source === "official",
    }));
}

/** 该模型的默认规格（画幅匹配不到时后端回落的目标）。 */
export function defaultSizeFor(template?: GatewayTemplateInfo | null): string | null {
    return template?.sizeMeta?.default ?? null;
}

/** 规格说明（接口 notes；仅用于「无规格 / 待查证」提示，不渲染解释性小字）。 */
export function sizeNoteFor(template?: GatewayTemplateInfo | null): string {
    return template?.sizeMeta?.note ?? "";
}

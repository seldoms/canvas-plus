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

/** 尺寸自适应结果（原值 → 合法档 + 画幅比例），界面只用来「表现最终值」，不堆解释字。 */
export type TemplateSizeAdjustment = { from: string; to: string; ratio: string };

const gcd = (a: number, b: number): number => {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y) [x, y] = [y, x % y];
    return x || 1;
};

const aspectOfRatio = (size: GatewayTemplateSize): number => {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(size.ratio ?? "").trim());
    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) return Number(match[1]) / Number(match[2]);
    return size.height > 0 ? size.width / size.height : Number.POSITIVE_INFINITY;
};

/**
 * 后端 `capability-limits.adaptSizeParams` 的**前端镜像**（同口径）：把不在官方档内的 WxH
 * 按「同比例、上限内像素最大」吸附到合法档（能放大就放大）；无严格同比例 → 挑比例最接近的。
 * 返回 null = 无需调整（已是合法档 / 无法解析 / 该模型无规格）。**后端仍是权威**（会在任务里留痕）。
 */
export function adaptSizeForTemplate(template?: GatewayTemplateInfo | null, size?: string): TemplateSizeAdjustment | null {
    const match = /^(\d+)x(\d+)$/.exec(String(size ?? "").trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0) || !(height > 0)) return null;
    const sizes = template?.sizes;
    if (!Array.isArray(sizes) || !sizes.length) return null;
    const value = `${width}x${height}`;
    if (sizes.some((item) => item.value === value)) return null; // 已是合法档 → 不动
    const maxPixels = Number(template?.sizeMeta?.maxPixels) > 0 ? Number(template?.sizeMeta?.maxPixels) : null;
    const candidates = maxPixels ? sizes.filter((item) => item.width * item.height <= maxPixels) : sizes.slice();
    if (!candidates.length) return null;
    const unit = gcd(width, height);
    const ratio = `${width / unit}:${height / unit}`;
    const wanted = width / height;
    const same = candidates.filter((item) => item.ratio === ratio || Math.abs(aspectOfRatio(item) - wanted) <= 1e-6 * Math.max(1, Math.abs(aspectOfRatio(item))));
    const closest = [...candidates].sort((a, b) => {
        const da = Math.abs(aspectOfRatio(a) - wanted);
        const db = Math.abs(aspectOfRatio(b) - wanted);
        if (Math.abs(da - db) > 1e-9) return da - db;
        return b.width * b.height - a.width * a.height;
    });
    const chosen = (same.length ? [...same].sort((a, b) => b.width * b.height - a.width * a.height) : closest)[0];
    return { from: value, to: chosen.value, ratio };
}

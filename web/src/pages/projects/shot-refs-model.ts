/**
 * 单镜参考清单的前端视图模型：把后端 refs 摊成可渲染的分组行。
 *
 * 视图模型与渲染分开，是为了让「编号能不能当对应关系显示」这条判断**可测**——
 * 它是本轮修掉的真bug（音色曾占编号，导致 @image#N 与模型实收的 <imageN> 错位）。
 * 判断放在这里、组件只渲染，是为了让回退法能验证：改坏这里，测试必须变红。
 */
import type { ShotRef, ShotRefs } from "@/services/api/projects";

export type RefRow = {
    /** React key：与顺序无关的稳定键。 */
    key: string;
    ref: ShotRef;
    label: string;
    role: string;
    /** 展示编号（`@image#N`）。非图类（音色）为 null。 */
    tag: string | null;
    /** 缩略图地址；null 时组件不渲染 img（不拿占位图冒充）。 */
    thumbUrl: string | null;
    /** 这一项缺参考图时的原因（来自 missingRefs）。 */
    missingReason: string | null;
};

/** 缺参考原因的中文说法。未知原因回落到原文——不编一个听起来更确定的说法。 */
const MISSING_REASON_TEXT: Record<string, string> = {
    "no-ref": "资料包无对应引用",
    "no-candidate": "引用下没有任何产物",
    "not-selected": "有候选但未选定",
    "no-selected": "未选定参考图",
    "artifact-not-found": "选定的产物不存在",
    "artifact-without-url": "产物没有可访问地址",
};

/** 缩略图地址 → 展示用相对路径。认不出来（空/临时地址）返回 null。 */
function thumbOf(ref: ShotRef): string | null {
    const url = (ref.url ?? "").trim();
    if (!url || /^(data:|blob:)/i.test(url)) return null;
    const marker = "/api/artifacts/";
    const at = url.indexOf(marker);
    return at >= 0 ? url.slice(at) : url;
}

/**
 * refs → 可渲染行。
 *
 * @param refs 后端返回的 refs（已带编号、artifactId、url）
 * @param missingRefs 缺参考项，用于在行上标出「为什么没图」
 */
export function buildRefRows(refs: ShotRef[], missingRefs: ShotRefs["missingRefs"] = []): RefRow[] {
    const reasonByKey = new Map<string, string>();
    for (const item of missingRefs ?? []) {
        const key = `${item.role}:${item.bindingId}`;
        if (!reasonByKey.has(key)) reasonByKey.set(key, item.reason);
    }
    return (refs ?? []).map((ref) => ({
        key: ref.stableKey || `${ref.kind}:${ref.bindingId}`,
        ref,
        label: ref.label || ref.bindingId,
        role: ref.role,
        tag: ref.tag ?? null,
        thumbUrl: thumbOf(ref),
        missingReason: reasonByKey.get(`${ref.kind}:${ref.bindingId}`) ?? null,
    }));
}

/** 缺参考原因 → 人话。 */
export function missingReasonText(reason: string | null): string {
    if (!reason) return "";
    return MISSING_REASON_TEXT[reason] ?? reason;
}

/**
 * 编号能不能当作「与模型实收图的对应关系」来显示。
 *
 * 这是本轮的核心判据：`alignment` 缺失（后端没得核对）或 `aligned=false`（核对出不一致）时，
 * **只显示清单本身，不显示编号** —— 宁可少给信息，也不能给一个指向另一张图的编号。
 * 用户拿着错位的编号去核对提示词，会核对到别人的图，而且没有任何报错提示他。
 */
export function canShowNumbering(alignment: ShotRefs["alignment"] | null | undefined): boolean {
    return Boolean(alignment?.aligned);
}

/** 供组件显示的一句警示；编号不可显示时才需要。 */
export function numberingWarning(alignment: ShotRefs["alignment"] | null | undefined): string {
    if (canShowNumbering(alignment)) return "";
    if (!alignment) return "编号未与实际发送的图核对过，此处只列参考清单。";
    return `编号与实际发送的 ${alignment.mismatches.length} 张图对不上，请以生成记录为准。`;
}

/**
 * 清单的一句人话摘要（后端已给 summary；这里只做空值回落）。
 * 不用前端拼字符串——角色名里带顿号时拼接结果没法读。
 */
export function refSummary(refs: ShotRefs | null | undefined): string {
    return String(refs?.summary ?? "").trim();
}

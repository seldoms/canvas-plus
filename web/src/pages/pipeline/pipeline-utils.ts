import type { GatewayArtifact, GatewayGenerationItem, GatewayJobStatus, GatewayRunStage, GatewayTemplateInfo } from "@/services/api/gateway";

/** 递归收集产物里的 jobId：关键帧 / 片段阶段用 jobId 指向真实的生成任务。 */
export function collectJobIds(value: unknown, into = new Set<string>()) {
    if (Array.isArray(value)) {
        for (const item of value) collectJobIds(item, into);
    } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (key === "jobId" && typeof item === "string" && item) into.add(item);
            else collectJobIds(item, into);
        }
    }
    return into;
}

export function uniqueArtifacts(items: GatewayArtifact[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (!item?.url || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
}

export function isVideoArtifact(artifact: GatewayArtifact) {
    return artifact.type === "video" || /\.(mp4|webm|mov|mkv)$/i.test(artifact.filename || "");
}

/** 只有关键帧（图）与片段合成（视频）阶段是「每条目多候选」的生成型阶段。 */
export function isGenerativeStage(stageId: string) {
    return stageId === "keyframe" || stageId === "assembly";
}

/** 生成型阶段的 family：关键帧同图片 family，片段合成同视频 family（与后端 STAGE_TEMPLATE_FAMILY 一致）。 */
export function stageMediaKind(stageId: string): "image" | "video" {
    return stageId === "assembly" ? "video" : "image";
}

/** 生成型阶段的条目列表：关键帧在 output.frames，片段合成在 output.clips。 */
export function stageItems(stage: GatewayRunStage | null, stageId: string): GatewayGenerationItem[] {
    const output = (stage?.output || {}) as { frames?: unknown; clips?: unknown };
    const items = stageId === "keyframe" ? output.frames : output.clips;
    return Array.isArray(items) ? (items as GatewayGenerationItem[]) : [];
}

export type CandidateView = {
    jobId: string;
    template: string;
    artifactUrl: string | null;
    status: GatewayJobStatus;
    createdAt: string;
    selected: boolean;
};

/** 候选视图：按 createdAt 升序（最早的排前），标记当前采用的那个，渲染层不用再碰原始结构。 */
export function candidateViews(item: GatewayGenerationItem): CandidateView[] {
    const selected = item.selected ?? null;
    return [...(item.candidates || [])]
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
        .map((candidate) => ({
            jobId: candidate.jobId,
            template: candidate.template,
            artifactUrl: candidate.artifactUrl,
            status: candidate.status,
            createdAt: candidate.createdAt,
            selected: candidate.jobId === selected,
        }));
}

/** 已经被候选缩略图展示过的产物：避免同一张图在候选条与扁平产物行里重复出现（成片等非条目产物不受影响）。 */
export function orphanArtifacts(artifacts: GatewayArtifact[], items: GatewayGenerationItem[]) {
    const shown = new Set<string>();
    for (const item of items) for (const candidate of item.candidates || []) if (candidate.artifactUrl) shown.add(candidate.artifactUrl);
    if (!shown.size) return artifacts;
    return artifacts.filter((artifact) => !shown.has(artifact.url));
}

/**
 * 「换个模型再出一张」下拉要列的模板：只取与阶段同 family 的（关键帧 image、片段合成 video）。
 * 后端 beginRegenerate 严格要求 family 精确相等，归一成 image 会把 edit / upscale 模板也列出来而被 400 拒绝。
 */
export function templatesForStage(templates: GatewayTemplateInfo[], stageId: string) {
    const want = stageMediaKind(stageId);
    return templates.filter((template) => template.family === want);
}

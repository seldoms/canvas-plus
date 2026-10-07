import type { GatewayArtifact, GatewayPipelineRun, GatewayRunStage, GatewayStageStatus } from "@/services/api/gateway";

// 复用流水线页既有的产物归类，不另写一套。
import { isGenerativeStage, isVideoArtifact, stageMediaKind, uniqueArtifacts } from "@/pages/pipeline/pipeline-utils";

/** 正式七段：定妆与配音同样展示服务端的状态和产物。 */
export const STAGE_ORDER = ["script", "storyboard", "design", "casting", "keyframe", "audio", "assembly"];

/** pipeline 落盘的产物只有 {jobId,url}，成片条目另有 role/kind；这里补上角色字段供时间线分类。 */
export type TimelineArtifact = GatewayArtifact & { role?: string; kind?: string };

export type TimelineStage = {
    id: string;
    status: GatewayStageStatus;
    artifacts: TimelineArtifact[];
    media: TimelineArtifact[];
    files: TimelineArtifact[];
    stage: GatewayRunStage;
};

/**
 * 产物媒体类别：复用 pipeline-utils 的 isVideoArtifact —— 落盘产物无 filename，这里用 url 兜底后再判定；
 * 成片的 manifest/log 是清单与日志文件、cover 是封面图，单独归类；其余按阶段的媒体族（stageMediaKind）归类。
 */
export function artifactKind(artifact: TimelineArtifact, stageId: string): "image" | "video" | "file" {
    if (stageId === "audio") return "file";
    if (artifact.role === "manifest" || artifact.role === "log") return "file";
    if (artifact.role === "cover") return "image";
    const normalized: GatewayArtifact = { ...artifact, filename: artifact.filename || artifact.url };
    if (isVideoArtifact(normalized)) return "video";
    return stageMediaKind(stageId);
}

/** 把 run 的阶段摊成线性时间线：只保留已跑的阶段（有产物/文本输出，或正在跑），未跑的 pending 阶段不占位。 */
export function buildStages(run: GatewayPipelineRun | null): TimelineStage[] {
    if (!run) return [];
    const list: TimelineStage[] = [];
    for (const id of STAGE_ORDER) {
        const stage = run.stages?.[id];
        if (!stage) continue;
        const artifacts = uniqueArtifacts(stage.artifacts || []) as TimelineArtifact[];
        const hasText = !isGenerativeStage(id) && stage.output != null;
        if (stage.status === "pending" && !artifacts.length && !hasText) continue;
        list.push({
            id,
            status: stage.status,
            artifacts,
            media: artifacts.filter((artifact) => artifactKind(artifact, id) !== "file"),
            files: artifacts.filter((artifact) => artifactKind(artifact, id) === "file"),
            stage,
        });
    }
    return list;
}

/** 文本阶段的只读摘要（缺字段就跳过，绝不臆造）；图片/视频阶段不产出摘要。 */
export function textSummary(stageId: string, output: unknown, t: (key: string, options?: Record<string, unknown>) => string): string[] {
    const data = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
    if (!data) return [];
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    if (stageId === "script") {
        const lines: string[] = [];
        const logline = typeof data.logline === "string" ? data.logline.trim() : "";
        if (logline) lines.push(t("projects.timeline.summary.logline", { value: logline }));
        if (count(data.characters)) lines.push(t("projects.timeline.summary.characters", { count: count(data.characters) }));
        if (count(data.scenes)) lines.push(t("projects.timeline.summary.scenes", { count: count(data.scenes) }));
        return lines;
    }
    if (stageId === "storyboard") {
        const shots = count(data.shots);
        return shots ? [t("projects.timeline.summary.shots", { count: shots })] : [];
    }
    if (stageId === "design") {
        const lines: string[] = [];
        if (count(data.characters)) lines.push(t("projects.timeline.summary.characters", { count: count(data.characters) }));
        if (count(data.locations)) lines.push(t("projects.timeline.summary.locations", { count: count(data.locations) }));
        return lines;
    }
    return [];
}

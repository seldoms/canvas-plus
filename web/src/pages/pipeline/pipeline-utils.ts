import type { GatewayArtifact } from "@/services/api/gateway";

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

import { useEffect, useState } from "react";

import { fetchGatewayJob, getPipelineRun, type GatewayPipelineRun } from "@/services/api/gateway";

import { readableJobError } from "../keyframes-model";

/**
 * 关键帧工作区的 run 数据源（页面私有 hook）。
 *
 * run 详情内嵌整本小说（长篇可达数 MB），所以不常轮询：只在 runId 变化或该阶段状态变化
 * （跑完 / 重跑会经由工作区的 refresh 更新 stageStatus）时各拉一次。实时进度由同页的
 * WorkspaceRunPanel / ProcessTimeline 负责，这里只保证「阶段状态一变就取回最新产物」。
 */
export function useKeyframeRun({ runId, stageStatus }: { runId: string; stageStatus: string }) {
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!runId) {
            setRun(null);
            setError("");
            return;
        }
        let alive = true;
        setLoading(true);
        getPipelineRun(runId)
            .then((data) => {
                if (!alive) return;
                setRun(data);
                setError("");
            })
            .catch((caught) => {
                if (alive) setError(caught instanceof Error ? caught.message : String(caught));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [runId, stageStatus]);

    return { run: runId ? run : null, loading, error };
}

/** 一次最多查这么多失败 job 的 error，避免候选很多时打爆接口。 */
const MAX_JOB_LOOKUPS = 16;

/**
 * 失败候选的可读原因：按 jobId 批量拉 job 详情，把 job.error 解析成一行。
 * 只读、best-effort：单个 job 拉不到就留空，由渲染层回退到状态文案。
 */
export function useKeyframeJobErrors(jobIds: string[]): Record<string, string> {
    const [errors, setErrors] = useState<Record<string, string>>({});
    const key = jobIds.join(",");

    useEffect(() => {
        const ids = key ? key.split(",") : [];
        if (!ids.length) {
            setErrors({});
            return;
        }
        let alive = true;
        void Promise.all(
            ids.slice(0, MAX_JOB_LOOKUPS).map(async (id) => {
                try {
                    const job = await fetchGatewayJob(id);
                    return [id, readableJobError(job?.error) || ""] as const;
                } catch {
                    return [id, ""] as const;
                }
            }),
        ).then((entries) => {
            if (!alive) return;
            const next: Record<string, string> = {};
            for (const [id, reason] of entries) if (reason) next[id] = reason;
            setErrors(next);
        });
        return () => {
            alive = false;
        };
    }, [key]);

    return errors;
}

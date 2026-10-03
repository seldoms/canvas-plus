import { useCallback, useEffect, useRef, useState } from "react";

import i18n from "@/i18n";
import { assemblePipelineRun, readRunAssembly, type GatewayAssembly } from "@/services/api/delivery";
import { fetchPipelineProgress, getPipelineRun } from "@/services/api/gateway";

/** 合成中轮询间隔：打的是轻量 progress.json（几十字节），与工作区其它进度轮询一致。 */
const PROGRESS_POLL_MS = 3000;

/**
 * 项目「导出成片」私有 hook：触发 `POST .../steps/assembly/assemble` 并跟踪真实进度。
 *
 * 不造假进度：进行中读服务端 progress.json 的 phase/label（后端写「正在把 N 个片段合成成片」）；
 * 落终态后再拉一次全量 run 取成片地址（url / 时长 / 错误）。进度轮询用 `updatedAt` 与本次开始的
 * `startedAt` 比较，避开片段阶段残留在同一个 progress.json 里的 done 被误判成本次合成完成。
 */
export function useAssemblyExport({ runId, refresh }: { runId: string; refresh: () => void | Promise<void> }) {
    const [assembly, setAssembly] = useState<GatewayAssembly | null>(null);
    const [loading, setLoading] = useState(false);
    const [assembling, setAssembling] = useState(false);
    const [progressLabel, setProgressLabel] = useState("");
    const [error, setError] = useState("");
    /** 本次合成的服务端开始时间（ISO）；只有晚于它的进度才算本次合成的。 */
    const sinceRef = useRef("");
    /** 落终态只处理一次，避免两个并发轮询都触发收尾。 */
    const settledRef = useRef(false);

    // 打开/切换 run 时读一次成片现状（全量 run；含 stages.assembly.output.assembly）。
    useEffect(() => {
        setAssembly(null);
        setError("");
        setProgressLabel("");
        setAssembling(false);
        settledRef.current = false;
        if (!runId) return;
        let alive = true;
        setLoading(true);
        void getPipelineRun(runId)
            .then((run) => {
                if (alive) setAssembly(readRunAssembly(run));
            })
            .catch((caught) => {
                if (alive) setError(messageOf(caught));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [runId]);

    /** 合成落终态：拉一次全量 run 取成片结果，并让上层刷新阶段状态/门禁。 */
    const settle = useCallback(async () => {
        if (!runId || settledRef.current) return;
        settledRef.current = true;
        try {
            setAssembly(readRunAssembly(await getPipelineRun(runId)));
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setAssembling(false);
            setProgressLabel("");
            void refresh();
        }
    }, [runId, refresh]);

    // 合成中：轮询轻量 progress.json，等 assembly 阶段落终态。
    useEffect(() => {
        if (!assembling || !runId) return;
        let alive = true;
        const tick = () => {
            void fetchPipelineProgress(runId)
                .then(({ progress }) => {
                    if (!alive || !progress || progress.stage !== "assembly") return;
                    // 早于本次开始的进度（片段阶段的残留 done）不算数。
                    if (progress.updatedAt && sinceRef.current && progress.updatedAt < sinceRef.current) return;
                    if (progress.label) setProgressLabel(progress.label);
                    if (progress.phase === "done" || progress.phase === "failed") void settle();
                })
                .catch(() => {
                    /* 网关短暂不可达不该清掉已有进度，下一轮再试 */
                });
        };
        tick();
        const timer = window.setInterval(tick, PROGRESS_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [assembling, runId, settle]);

    /** 合成成片；`force` 用于对已完成成片重拼。失败回可读原因，可再次调用重试。 */
    const assemble = useCallback(
        async (options?: { force?: boolean }) => {
            if (!runId || assembling) return;
            setError("");
            setProgressLabel("");
            settledRef.current = false;
            setAssembling(true);
            try {
                const result = await assemblePipelineRun(runId, options?.force ? { force: true } : {});
                setAssembly(result.assembly);
                if (result.reused) {
                    setAssembling(false);
                    void refresh();
                    return;
                }
                // 记录服务端开始时间，之后只有晚于它的进度才算本次合成。
                sinceRef.current = result.assembly?.startedAt || new Date().toISOString();
                setProgressLabel(i18n.t("projects.assembly.assembling"));
            } catch (caught) {
                setError(messageOf(caught));
                setAssembling(false);
            }
        },
        [runId, assembling, refresh],
    );

    const clearError = useCallback(() => setError(""), []);

    return { assembly, loading, assembling, progressLabel, error, assemble, clearError };
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

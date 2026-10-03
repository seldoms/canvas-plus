import { useEffect, useState } from "react";

import { fetchPipelineProgress, getPipelineRun, type GatewayPipelineRun, type GatewayStageProgress } from "@/services/api/gateway";

/**
 * 过程时间线数据源（项目工作区页面私有 hook）。
 *
 * 两个数据源，节流分开：
 * - 轻量进度 progress.json（几十字节）常轮询，负责「当前阶段 / 进度 / 是否在跑」；
 * - 完整 run 内嵌整本小说（长篇可达数 MB），只在阶段运行中拉，且 RUN_POLL_MS 一次；
 *   进入 / 退出运行态各补拉一次，空闲即停 —— 后台每多一张产物，下一次拉取就带回时间线。
 *
 * runId 取项目关联 run 的第一个（与 useProjectRun 一致）；无关联 run 时不请求。
 */
const PROGRESS_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;
const RUN_POLL_MS = 8000;

export function useProjectTimeline({ runIds }: { runIds: string[] }) {
    const runId = runIds[0] || "";
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [progress, setProgress] = useState<GatewayStageProgress | null>(null);
    const [inflight, setInflight] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // 是否在跑以服务端为准：progress.phase=running 或 /progress 返回 inflight；据此决定完整 run 的轮询节流。
    const active = inflight || progress?.phase === "running";

    useEffect(() => {
        if (!runId) {
            setProgress(null);
            setInflight(false);
            return;
        }
        let alive = true;
        const tick = () =>
            fetchPipelineProgress(runId)
                .then((data) => {
                    if (!alive) return;
                    setProgress(data.progress);
                    setInflight(Boolean(data.inflight));
                })
                .catch(() => {
                    /* 网关短暂不可达不该清掉已有进度，下一轮再试 */
                });
        tick();
        const timer = window.setInterval(tick, active ? PROGRESS_POLL_MS : IDLE_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [runId, active]);

    useEffect(() => {
        if (!runId) {
            setRun(null);
            setError("");
            return;
        }
        let alive = true;
        setLoading(true);
        const load = () =>
            getPipelineRun(runId)
                .then((data) => {
                    if (!alive) return;
                    setRun(data);
                    setError("");
                })
                .catch((caught) => {
                    if (!alive) return;
                    setError(caught instanceof Error ? caught.message : String(caught));
                })
                .finally(() => {
                    if (alive) setLoading(false);
                });
        void load();
        if (!active) return () => { alive = false; };
        const timer = window.setInterval(load, RUN_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [runId, active]);

    return { runId, run, progress, active, loading, error };
}

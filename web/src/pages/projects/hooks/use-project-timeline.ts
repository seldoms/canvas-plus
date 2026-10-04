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
 * runId 取项目关联 run 的「当前选中项」（多 run 时由工作区选择器切换，默认第一个）；无关联 run 时不请求。
 */
const PROGRESS_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;
const RUN_POLL_MS = 8000;

export function useProjectTimeline({ runId }: { runId: string }) {
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [progress, setProgress] = useState<GatewayStageProgress | null>(null);
    const [inflight, setInflight] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // 是否在跑以服务端为准：以 /progress 返回的 inflight 为权威（后端正在执行哪个阶段就为 true）。
    // 不能再用 `progress.phase === "running"` 兜底当「在跑」：后端 recomputeStage 落终态时不 writeProgress，
    // progress.json 会冻在 phase:"running"，只看 phase 会让时间线永远显示「生成中」并持续轮询（#73，同 #71 判据）。
    const active = inflight;
    // 只有当「服务端仍在执行」且 phase 显示 running 时，才是真正在跑的阶段；inflight=false 即已落终态，不再铺进度行。
    const runningStage = progress && progress.phase === "running" && inflight ? progress.stage : "";

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

    return { runId, run, progress, active, runningStage, loading, error };
}

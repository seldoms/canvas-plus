import { useCallback, useEffect, useState } from "react";
import { App } from "antd";

import {
    listContinuationChains,
    resumeContinuationChain,
    reviewContinuationSeam,
    startContinuationBranch,
    startContinuationChain,
    type ContinuationChain,
} from "@/services/api/projects";

import { isChainActive } from "../continuation-model";

/** 有活动段时的轮询间隔；闲时完全不轮询（链状态只会被本页动作改变）。 */
const ACTIVE_POLL_MS = 5000;

type StartChainInput = { prompt: string; segments: number; seed?: number | null; params?: Record<string, unknown> };
type StartBranchInput = { parentCandidateId: string; prompt: string; segments: number; seed?: number | null };

/**
 * 视频工作区续接链数据源（页面私有 hook）：按镜头拉派生链视图，段在跑时轮询。
 *
 * 四种写入动作（开链/分叉/续跑/复核）都走这里，**成功后统一 refresh** —— 服务端是异步编排
 * （段 done 会自动接下一段），本地不做乐观更新，界面只反映服务端的派生事实。
 * busy 是动作键（`start` / `branch:<jobId>` / `resume:<chainId>` / `review:<jobId>:<verdict>`），
 * 供按钮各自显示 loading，不互相锁死。
 */
export function useContinuationChains({ projectId, shotId }: { projectId: string; shotId: string }) {
    const { message } = App.useApp();
    const [chains, setChains] = useState<ContinuationChain[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState("");

    const load = useCallback(
        async (silent = false) => {
            if (!projectId || !shotId) {
                setChains([]);
                setError("");
                return;
            }
            if (!silent) setLoading(true);
            try {
                setChains(await listContinuationChains(projectId, shotId));
                setError("");
            } catch (caught) {
                // 轮询失败不覆盖已有视图（避免一次抖动把链清空），只在首次加载时暴露错误。
                if (!silent) setError(caught instanceof Error ? caught.message : String(caught));
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [projectId, shotId],
    );

    useEffect(() => {
        void load();
    }, [load]);

    // 段在跑（含服务端自动接续的下一段）时轮询；全部落定后自动停。
    const active = chains.some(isChainActive);
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => void load(true), ACTIVE_POLL_MS);
        return () => window.clearInterval(timer);
    }, [active, load]);

    /** 统一动作壳：置 busy → 执行 → 成功 refresh + 提示 → 失败提示 → 清 busy。 */
    const run = useCallback(
        async (key: string, action: () => Promise<string>) => {
            setBusy(key);
            try {
                const notice = await action();
                await load();
                if (notice) message.success(notice);
                return true;
            } catch (caught) {
                message.error(caught instanceof Error ? caught.message : String(caught));
                return false;
            } finally {
                setBusy("");
            }
        },
        [load, message],
    );

    const startChain = useCallback(
        (input: StartChainInput) =>
            run("start", async () => {
                const result = await startContinuationChain(projectId, shotId, input);
                return `${result.chainId} · ${result.firstJobId}`;
            }),
        [projectId, shotId, run],
    );

    const startBranch = useCallback(
        (input: StartBranchInput) =>
            run(`branch:${input.parentCandidateId}`, async () => {
                const result = await startContinuationBranch(projectId, shotId, input);
                return `${result.chainId} · ${result.firstJobId}`;
            }),
        [projectId, shotId, run],
    );

    const resumeChain = useCallback(
        (chainId: string) =>
            run(`resume:${chainId}`, async () => {
                const result = await resumeContinuationChain(projectId, shotId, chainId);
                return result.jobId ?? "";
            }),
        [projectId, shotId, run],
    );

    const reviewSeam = useCallback(
        (jobId: string, reviewed: "approved" | "rejected", note?: string) =>
            run(`review:${jobId}:${reviewed}`, async () => {
                await reviewContinuationSeam(projectId, shotId, { jobId, reviewed, ...(note ? { note } : {}) });
                return "";
            }),
        [projectId, shotId, run],
    );

    return { chains, loading, error, busy, refresh: load, startChain, startBranch, resumeChain, reviewSeam };
}

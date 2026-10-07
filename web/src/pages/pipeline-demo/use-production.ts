import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    cancelPipelineStage,
    createPipelineRun,
    fetchGatewayLlmModels,
    fetchGatewayStages,
    fetchPipelineProgress,
    getPipelineRun,
    listPipelineRuns,
    probeGatewayBaseUrl,
    retryPipelineStageFailed,
    runPipelineStage,
    type GatewayPipelineRun,
    type GatewayPipelineRunSummary,
    type GatewayStageInfo,
    type GatewayStageProgress,
    type GatewayStageStatus,
} from "@/services/api/gateway";
import { getProjectContext, getSourceRevision, listEpisodes, listProjects, type ProjectSummary } from "@/services/api/projects";
import type { Episode } from "@/types/domain";

/**
 * 流水线页面的真实数据层（接线第一刀：骨架通真数据，面板内容逐阶段替换）。
 *
 * 数据流：项目列表 → 项目上下文（runIds 归属）→ 集列表 → 执行记录（按项目过滤）。
 * 已知缺口（清单 #1）：run 与集的关联后端未存，执行记录目前按**项目**过滤，
 * 自动建 run 时把集名写进标题（`第 N 集 · 标题`）保证可读。
 *
 * 轮询策略沿用旧 use-pipeline-run 的教训：阶段后台执行（202），只轮询轻量 progress.json，
 * inflight 由 true 翻 false 或 phase 落终态时才补拉完整 run（可能数 MB）。
 */

export type ProductionStageStatus = "pending" | "running" | "partial" | "done" | "error";

/** 网关状态 → 页面五态。canceled 归 error（有失败原因可示），blocked 归 pending（门禁锁另算）。 */
export function toProductionStatus(status: GatewayStageStatus | undefined): ProductionStageStatus {
    switch (status) {
        case "running":
            return "running";
        case "partial":
            return "partial";
        case "done":
            return "done";
        case "error":
        case "canceled":
            return "error";
        default:
            return "pending";
    }
}

export type RunListItem = { id: string; title: string; createdAt: string };

const PROJECT_KEY = "pipeline.projectId";
const episodeKey = (projectId: string) => `pipeline.episodeId.${projectId}`;
const RUN_KEY = "pipeline.runId";
const PROGRESS_POLL_MS = 3000;

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function useProduction() {
    const [gwBase, setGwBase] = useState("");
    const [stages, setStages] = useState<GatewayStageInfo[]>([]);
    const [projects, setProjects] = useState<ProjectSummary[]>([]);
    const [projectId, setProjectId] = useState<string>(() => localStorage.getItem(PROJECT_KEY) || "");
    const [episodes, setEpisodes] = useState<Episode[]>([]);
    const [episodeId, setEpisodeId] = useState<string>("");
    const [projectRunIds, setProjectRunIds] = useState<string[]>([]);
    const [runs, setRuns] = useState<RunListItem[]>([]);
    const [runId, setRunId] = useState<string>(() => localStorage.getItem(RUN_KEY) || "");
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [progress, setProgress] = useState<GatewayStageProgress | null>(null);
    const [error, setError] = useState("");
    const [busyStage, setBusyStage] = useState("");
    const [llmModels, setLlmModels] = useState<string[]>([]);
    /** 自动建 run 流程里 createPipelineRun 与 runPipelineStage 同轮调用，state 来不及落地，用 ref 兜底（旧 hook #72 教训）。 */
    const runIdRef = useRef(runId);
    runIdRef.current = runId;
    const progressInflight = useRef<boolean | null>(null);

    /* 网关探测 + 阶段 registry + 项目列表 + LLM 清单（阶段与状态只认服务端 registry，不臆造）。 */
    useEffect(() => {
        let alive = true;
        void probeGatewayBaseUrl().then((base) => {
            if (!alive) return;
            setGwBase(base);
            void fetchGatewayStages(base).then((list) => alive && setStages(list)).catch(() => alive && setStages([]));
            void fetchGatewayLlmModels(base).then((models) => alive && setLlmModels(models)).catch(() => undefined);
            void listProjects()
                .then((list) => {
                    if (!alive) return;
                    setProjects(list);
                    const remembered = localStorage.getItem(PROJECT_KEY) || "";
                    const valid = list.some((item) => item.id === remembered) ? remembered : list[0]?.id || "";
                    setProjectId(valid);
                })
                .catch((caught) => alive && setError(messageOf(caught)));
        });
        return () => {
            alive = false;
        };
    }, []);

    /* 切项目：拉集索引 + 项目上下文（runIds 归属），重置集与 run。 */
    useEffect(() => {
        if (!projectId) {
            setEpisodes([]);
            setProjectRunIds([]);
            return;
        }
        localStorage.setItem(PROJECT_KEY, projectId);
        let alive = true;
        void listEpisodes(projectId)
            .then((list) => {
                if (!alive) return;
                setEpisodes(list);
                const remembered = localStorage.getItem(episodeKey(projectId)) || "";
                setEpisodeId(list.some((item) => item.id === remembered) ? remembered : list[0]?.id || "");
            })
            .catch((caught) => alive && setError(messageOf(caught)));
        void getProjectContext(projectId)
            .then((context) => {
                if (!alive) return;
                setProjectRunIds(context?.runIds ?? []);
            })
            .catch(() => alive && setProjectRunIds([]));
        return () => {
            alive = false;
        };
    }, [projectId]);

    /* 集选择记忆（按项目分键）。 */
    useEffect(() => {
        if (projectId && episodeId) localStorage.setItem(episodeKey(projectId), episodeId);
    }, [projectId, episodeId]);

    /* 执行记录：全量列表按项目 runIds 过滤（关联的唯一真实来源是项目上下文）。 */
    useEffect(() => {
        if (!gwBase || !projectId) return;
        let alive = true;
        void listPipelineRuns(gwBase)
            .then((all) => {
                if (!alive) return;
                const owned = new Set(projectRunIds);
                const filtered = all.filter((item: GatewayPipelineRunSummary) => owned.has(item.id));
                setRuns(filtered.map((item) => ({ id: item.id, title: item.title, createdAt: item.createdAt })));
                //  remembered run 不属于本项目时清掉，避免「展示一个项目、操作另一个 run」（清单 #1）。
                const remembered = runIdRef.current;
                if (remembered && !filtered.some((item) => item.id === remembered)) {
                    runIdRef.current = "";
                    setRunId("");
                    setRun(null);
                    localStorage.removeItem(RUN_KEY);
                }
            })
            .catch(() => alive && setRuns([]));
        return () => {
            alive = false;
        };
    }, [gwBase, projectId, projectRunIds]);

    const openRun = useCallback(
        async (id: string) => {
            if (!id || !gwBase) return;
            setError("");
            setProgress(null);
            progressInflight.current = null;
            try {
                const loaded = await getPipelineRun(id, gwBase);
                setRun(loaded);
                setRunId(id);
                runIdRef.current = id;
                localStorage.setItem(RUN_KEY, id);
            } catch (caught) {
                setError(messageOf(caught));
            }
        },
        [gwBase],
    );

    /* 刷新恢复：网关就绪且本地记着 runId 时自动打开。 */
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current || !gwBase || !runId || run) return;
        restoredRef.current = true;
        void openRun(runId);
    }, [gwBase, runId, run, openRun]);

    const refreshRun = useCallback(async () => {
        const id = runIdRef.current;
        if (!id || !gwBase) return;
        try {
            setRun(await getPipelineRun(id, gwBase));
        } catch {
            /* 网关短暂不可达不清态，下一轮再试 */
        }
    }, [gwBase]);

    const runningStage = useMemo(() => Object.values(run?.stages || {}).find((stage) => stage.status === "running")?.id || "", [run]);

    /* 进度轮询：只打轻量 progress.json；inflight 翻 false 或 phase 终态才补拉完整 run。 */
    useEffect(() => {
        const id = runIdRef.current;
        if (!id || !gwBase || !runningStage) return;
        progressInflight.current = null;
        let alive = true;
        const load = () => {
            void fetchPipelineProgress(id, gwBase)
                .then((data) => {
                    if (!alive) return;
                    const latest = data.progress;
                    setProgress(latest);
                    const phaseTerminal = latest?.phase === "done" || latest?.phase === "failed";
                    const stoppedExecuting = data.inflight === false && progressInflight.current !== false;
                    if (phaseTerminal || stoppedExecuting) {
                        progressInflight.current = false;
                        void refreshRun();
                    } else {
                        progressInflight.current = data.inflight;
                    }
                })
                .catch(() => undefined);
        };
        load();
        const timer = window.setInterval(load, PROGRESS_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [gwBase, runningStage, runId, refreshRun]);

    const stageStatus = useCallback(
        (stageId: string): ProductionStageStatus => toProductionStatus(run?.stages?.[stageId]?.status),
        [run],
    );

    /**
     * 运行/继续生成/重跑统一入口。
     * - 无 run：按项目当前源版本自动建 run（标题带集名），建完同轮直接开跑（ref 兜底时序）；
     * - resume=true 即「继续生成」：复用已落盘分块续跑，只补未完项；false 即重跑（清缓存）。
     */
    const startStage = useCallback(
        async (stageId: string, options?: { resume?: boolean; model?: string }) => {
            if (!gwBase || busyStage) return;
            setBusyStage(stageId);
            setError("");
            try {
                let id = runIdRef.current;
                if (!id) {
                    if (!projectId) throw new Error("请先选择项目");
                    const context = await getProjectContext(projectId);
                    const revisionId = (context?.project as { sourceRevisionId?: string } | undefined)?.sourceRevisionId;
                    if (!revisionId) throw new Error("项目还没有原文版本：请先在项目里导入原文");
                    const source = await getSourceRevision(projectId, revisionId);
                    const text = source?.text?.trim() || "";
                    if (!text) throw new Error("项目原文为空：请先在项目里导入原文");
                    const episode = episodes.find((item) => item.id === episodeId);
                    const title = episode ? `第 ${episode.index} 集 · ${episode.title}` : undefined;
                    const created = await createPipelineRun({ novel: text, title, options: { projectId, episodeId: episodeId || undefined } }, gwBase);
                    id = created.id;
                    runIdRef.current = id;
                    setRunId(id);
                    localStorage.setItem(RUN_KEY, id);
                    setRun(created);
                    // 新 run 立即进列表（上下文 runIds 要等下次拉项目才含它，这里本地补）。
                    setRuns((current) => (current.some((item) => item.id === id) ? current : [{ id, title: created.title || id, createdAt: created.createdAt }, ...current]));
                    setProjectRunIds((current) => (current.includes(id) ? current : [...current, id]));
                }
                const updated = await runPipelineStage(id, stageId, { model: options?.model || undefined, resume: options?.resume }, gwBase);
                setRun(updated);
            } catch (caught) {
                setError(messageOf(caught));
            } finally {
                setBusyStage("");
            }
        },
        [gwBase, busyStage, projectId, episodeId, episodes],
    );

    const cancelStage = useCallback(
        async (stageId: string) => {
            const id = runIdRef.current;
            if (!id || !gwBase) return;
            setError("");
            try {
                await cancelPipelineStage(id, stageId, gwBase);
            } catch (caught) {
                setError(messageOf(caught));
            }
        },
        [gwBase],
    );

    /** 重试阶段内失败条目（后端 202 后台补跑；阶段落成 running，终态由轮询接回）。 */
    const retryFailed = useCallback(
        async (stageId: string) => {
            const id = runIdRef.current;
            if (!id || !gwBase) return;
            setError("");
            try {
                await retryPipelineStageFailed(id, stageId, gwBase);
                void refreshRun();
            } catch (caught) {
                setError(messageOf(caught));
            }
        },
        [gwBase, refreshRun],
    );

    /** 文本阶段的默认模型：优先 qwen3.8，不让用户面对「网关默认」黑盒（沿用旧 hook 策略）。 */
    const defaultTextModel = useMemo(
        () => llmModels.find((name) => /qwen3\.8/i.test(name)) || llmModels.find((name) => /qwen/i.test(name)) || llmModels[0] || "",
        [llmModels],
    );

    return {
        gwBase,
        stages,
        projects,
        projectId,
        setProjectId,
        episodes,
        episodeId,
        setEpisodeId,
        runs,
        runId,
        run,
        openRun,
        progress,
        error,
        busyStage,
        runningStage,
        stageStatus,
        startStage,
        cancelStage,
        retryFailed,
        defaultTextModel,
    };
}

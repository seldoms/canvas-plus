import { useCallback, useEffect, useMemo, useState } from "react";

import i18n from "@/i18n";
import {
    cancelPipelineStage,
    createPipelineRun,
    fetchGatewayJob,
    fetchGatewayLlmModels,
    fetchGatewayProviders,
    fetchGatewayStages,
    fetchPipelineProgress,
    getPipelineRun,
    listPipelineRuns,
    probeGatewayBaseUrl,
    regeneratePipelineItem,
    runPipelineStage as requestStageRun,
    summarizeRunStages,
    syncGatewayLlmProviders,
    updatePipelineStageInput,
    type GatewayArtifact,
    type GatewayJob,
    type GatewayPipelineRun,
    type GatewayRunStage,
    type GatewayStageInfo,
    type GatewayStageProgress,
    type GatewayStageStatus,
    type GatewayTemplateInfo,
} from "@/services/api/gateway";
import { useConfigStore } from "@/stores/use-config-store";
import { usePipelineStore, type PipelineRunRecord } from "@/stores/use-pipeline-store";
import { collectJobIds, uniqueArtifacts } from "./pipeline-utils";

export type PipelineStageView = {
    id: string;
    title: string;
    requires: string[];
    status: GatewayStageStatus;
    stage: GatewayRunStage | null;
    artifacts: GatewayArtifact[];
    generating: boolean;
};

const FALLBACK_STAGES: Array<{ id: string; requires: string[] }> = [
    { id: "script", requires: [] },
    { id: "storyboard", requires: ["script"] },
    { id: "design", requires: ["storyboard"] },
    { id: "keyframe", requires: ["design"] },
    { id: "assembly", requires: ["keyframe"] },
];

const POLL_INTERVAL_MS = 5000;
/** 阶段进度轮询：打的是轻量 progress.json（几十字节），不是内嵌整本小说、可达数 MB 的 run.json。 */
const PROGRESS_POLL_MS = 3000;
/** 超过这个块数就在开跑前弹确认：按实测约 31 秒/块，50 块≈26 分钟，值得让用户先看一眼预估。 */
export const CONFIRM_CHUNKS = 50;
const STAGE_MODELS_KEY = "pipeline-stage-models";

function loadStageModels(): Record<string, string> {
    try {
        const raw = localStorage.getItem(STAGE_MODELS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** 从正文首个非空行截取标题（最长 30 字）；截不到就留空，由后端落「未命名流水线」。 */
function deriveTitle(text: string) {
    return (text.split(/\r?\n/).find((line) => line.trim())?.trim() || "").slice(0, 30);
}

export function usePipelineRun() {
    const [novel, setNovel] = useState("");
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [stages, setStages] = useState<GatewayStageInfo[]>([]);
    const [jobs, setJobs] = useState<Record<string, GatewayJob>>({});
    const [starting, setStarting] = useState(false);
    const [busyStage, setBusyStage] = useState("");
    /** 正在「换个模型再出一张」的条目，键为 `${stageId}:${itemId}`，用于候选条局部 loading。 */
    const [regeneratingItem, setRegeneratingItem] = useState("");
    const [error, setError] = useState("");
    const [llmModels, setLlmModels] = useState<string[]>([]);
    /** 网关 ComfyUI 模板清单：候选条「换个模型再出一张」按 family 过滤出同族模板。 */
    const [templates, setTemplates] = useState<GatewayTemplateInfo[]>([]);
    const [stageModels, setStageModels] = useState<Record<string, string>>(loadStageModels);
    const [gwBase, setGwBase] = useState("");
    /** 当前阶段的细粒度进度（第几块/共几块/预计还需多久），来自轻量 progress.json。 */
    const [progress, setProgress] = useState<GatewayStageProgress | null>(null);
    const [historyLoading, setHistoryLoading] = useState(false);
    /** 恢复只做一次，之后不再被本地恢复逻辑覆盖当前 run。 */
    const [restored, setRestored] = useState(false);
    const hydrated = usePipelineStore((state) => state.hydrated);
    const storedActiveRunId = usePipelineStore((state) => state.activeRunId);
    // 当前 run 的 id：内存里的 run 优先，刷新后 run 尚未拉回时用本地记住的 activeRunId，轮询据此重建。
    const runId = run?.id || storedActiveRunId;
    const channels = useConfigStore((state) => state.config.channels);

    // 后端 202 之后阶段在后台跑，「有没有在跑」只能从 run 的状态看，不能再靠 await 那个 POST
    const runningStage = useMemo(
        () => Object.values(run?.stages || {}).find((stage) => stage.status === "running")?.id || "",
        [run],
    );

    // 同一个下拉混合列出：💻 本地（网关 LLM）+ ☁️ 外部 API（渠道管理里配置的 OpenAI 兼容渠道）。
    // 外部模型的 value 用「渠道名::模型名」，渠道已同步进网关注册表，由网关按前缀路由到对应 API。
    const modelOptions = useMemo(() => {
        const groups: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [];
        if (llmModels.length) groups.push({ label: "💻 本地模型", options: llmModels.map((name) => ({ value: name, label: `💻 ${name}` })) });
        const remote = channels
            .filter((channel) => !channel.apiFormat || channel.apiFormat === "openai")
            .flatMap((channel) =>
                channel.models
                    .filter((model) => model.capability === "text")
                    .map((model) => ({ value: `${channel.name}::${model.name}`, label: `☁️ ${channel.name} / ${model.name}` })),
            );
        if (remote.length) groups.push({ label: "☁️ 外部 API", options: remote });
        return groups;
    }, [llmModels, channels]);

    // 先探测可达网关地址（已配置 → 按主机推导 → 本机回环），再拉阶段与模型清单；
    // 探测到与配置不同的可用地址时回写配置，产物 URL 等其它消费方也一并修正。
    useEffect(() => {
        let alive = true;
        void probeGatewayBaseUrl().then((base) => {
            if (!alive) return;
            setGwBase(base);
            const store = useConfigStore.getState();
            if (base && base !== store.config.gatewayUrl) store.updateConfig("gatewayUrl", base);
            void fetchGatewayStages(base)
                .then(setStages)
                .catch(() => setStages([]));
            // ComfyUI 模板清单（含 family）：候选条换模型下拉只从中过滤本阶段同族模板，不另建一套清单
            void fetchGatewayProviders(base)
                .then((available) => setTemplates(available.comfy?.templates || []))
                .catch(() => setTemplates([]));
            // 把浏览器渠道（OpenAI 兼容且含文本模型）同步进网关 LLM 注册表，之后运行只传模型名、网关按「渠道名::模型」路由
            const providers = store.config.channels
                .filter((channel) => (!channel.apiFormat || channel.apiFormat === "openai") && channel.baseUrl && !channel.name.includes("::") && channel.models.some((model) => model.capability === "text"))
                .map((channel) => ({ name: channel.name, baseUrl: channel.baseUrl, apiKey: channel.apiKey }));
            const sync = providers.length ? syncGatewayLlmProviders(providers, base).catch(() => []) : Promise.resolve([]);
            void sync.then(() =>
                fetchGatewayLlmModels(base)
                    .then((models) => {
                        if (!alive) return;
                        setLlmModels(models);
                        // 没绑过模型的阶段自动选中一个具体模型（优先 qwen3.8），不让用户面对"默认（网关）"这种黑盒
                        const preferred = models.find((name) => /qwen3\.8/i.test(name)) || models.find((name) => /qwen/i.test(name)) || models[0];
                        if (!preferred) return;
                        setStageModels((current) => {
                            const missing = FALLBACK_STAGES.map((s) => s.id).filter((id) => !current[id]);
                            if (!missing.length) return current;
                            const next = { ...current };
                            for (const id of missing) next[id] = preferred;
                            try {
                                localStorage.setItem(STAGE_MODELS_KEY, JSON.stringify(next));
                            } catch {
                                /* 忽略持久化失败 */
                            }
                            return next;
                        });
                    })
                    .catch(() => setLlmModels([])),
            );
        });
        return () => {
            alive = false;
        };
    }, []);

    const setStageModel = useCallback((stageId: string, model: string) => {
        setStageModels((current) => {
            const next = { ...current, [stageId]: model };
            try {
                localStorage.setItem(STAGE_MODELS_KEY, JSON.stringify(next));
            } catch {
                /* 忽略持久化失败 */
            }
            return next;
        });
    }, []);

    const refresh = useCallback(async () => {
        if (!runId) return;
        try {
            setRun(await getPipelineRun(runId, gwBase || undefined));
        } catch (caught) {
            setError(messageOf(caught));
        }
    }, [runId, gwBase]);

    /** 切到某个历史 run：先清掉上一个 run 的运行态，再拉全量并由上面的轮询 useEffect 重建。 */
    const openRun = useCallback(
        async (id: string) => {
            if (!id) return;
            setRun(null);
            setJobs({});
            setError("");
            usePipelineStore.getState().setActiveRun(id);
            try {
                const loaded = await getPipelineRun(id, gwBase || undefined);
                setRun(loaded);
                usePipelineStore.getState().upsertRun({ id: loaded.id, title: loaded.title, createdAt: loaded.createdAt, stages: summarizeRunStages(loaded.stages) });
            } catch (caught) {
                setError(messageOf(caught));
            }
        },
        [gwBase],
    );

    /** 回到「新建」：清掉当前 run（历史记录保留，之后可切回）。 */
    const resetRun = useCallback(() => {
        setRun(null);
        setJobs({});
        setProgress(null);
        setError("");
        usePipelineStore.getState().setActiveRun("");
        setRestored(true);
    }, []);

    /** 拉后端历史列表并合并进本地记录（本地改过的标题保留）。 */
    const loadHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const runs = await listPipelineRuns(gwBase || undefined);
            usePipelineStore.getState().syncRuns(
                runs.map((item): PipelineRunRecord => ({ id: item.id, title: item.title, createdAt: item.createdAt, stages: item.stages })),
            );
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setHistoryLoading(false);
        }
    }, [gwBase]);

    /** 重命名只改本地记录（后端没有重命名端点）；顺手同步内存里的 run，让页头标题立刻更新。 */
    const renameRun = useCallback((id: string, title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        usePipelineStore.getState().renameRun(id, trimmed);
        setRun((current) => (current && current.id === id ? { ...current, title: trimmed } : current));
    }, []);

    const pendingJobIds = useMemo(() => {
        if (!run) return [];
        return [...collectJobIds(run.stages)].filter((id) => isPending(jobs[id]));
    }, [run, jobs]);
    const pendingJobKey = pendingJobIds.join(",");

    useEffect(() => {
        if (!runId || !pendingJobKey) return;
        const ids = pendingJobKey.split(",");
        const load = () => {
            void Promise.all(ids.map((id) => fetchGatewayJob(id, gwBase || undefined).catch(() => null))).then((results) => {
                const finished = results.filter((job): job is GatewayJob => Boolean(job));
                if (!finished.length) return;
                setJobs((current) => ({ ...current, ...Object.fromEntries(finished.map((job) => [job.id, job])) }));
                if (finished.some((job) => isSettled(job))) void refresh();
            });
        };
        load();
        const timer = window.setInterval(load, POLL_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [runId, pendingJobKey, refresh]);

    // 换 run 才清进度；阶段跑完/失败后保留最后一条，卡片要靠 phase:"failed" + done 判断能不能续跑
    useEffect(() => {
        setProgress(null);
    }, [runId]);

    // 文本阶段（尤其 01 剧本的分块改编）可能跑一个多小时，而后端是 202 后台执行，
    // 所以这里独立轮询轻量进度端点；阶段落终态后再拉一次完整 run 取产物。
    useEffect(() => {
        if (!runId || !runningStage) return;
        let alive = true;
        const load = () => {
            void fetchPipelineProgress(runId, gwBase || undefined)
                .then((data) => {
                    if (!alive) return;
                    setProgress(data.progress);
                    const phase = data.progress?.phase;
                    if (phase === "done" || phase === "failed") void refresh();
                })
                .catch(() => {
                    /* 网关短暂不可达不该清掉已有进度，下一轮再试 */
                });
        };
        load();
        const timer = window.setInterval(load, PROGRESS_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [runId, runningStage, gwBase, refresh]);

    // 刷新恢复：localforage 水合完成后，用本地记住的 activeRunId 打开最近一次 run，接回阶段/job 轮询。
    // 只做一次；本页已创建或手动切换过 run 后不再干预。
    useEffect(() => {
        if (restored || run || !hydrated || !storedActiveRunId || !gwBase) return;
        setRestored(true);
        void openRun(storedActiveRunId);
    }, [restored, run, hydrated, storedActiveRunId, gwBase, openRun]);

    // 有阶段在跑时拦一下刷新/关闭，避免误关丢掉可能要跑很久的 run；阶段落终态后自动解除。
    useEffect(() => {
        if (!runningStage) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [runningStage]);

    const stageList = useMemo<GatewayStageInfo[]>(() => {
        if (stages.length) return stages;
        return FALLBACK_STAGES.map((item) => ({ id: item.id, title: i18n.t(`pipeline.stages.${item.id}`), skill: item.id, requires: [...item.requires], produces: [] }));
    }, [stages]);

    const views = useMemo<PipelineStageView[]>(
        () =>
            stageList.map((meta) => {
                const stage = run?.stages?.[meta.id] ?? null;
                const jobIds = [...collectJobIds(stage?.output)];
                const stageJobs = jobIds.map((id) => jobs[id]).filter((job): job is GatewayJob => Boolean(job));
                return {
                    id: meta.id,
                    title: meta.title || i18n.t(`pipeline.stages.${meta.id}`),
                    requires: meta.requires || [],
                    status: stage?.status || "pending",
                    stage,
                    artifacts: uniqueArtifacts([...(stage?.artifacts || []), ...stageJobs.flatMap((job) => job.outputs || [])]),
                    generating: jobIds.some((id) => isPending(jobs[id])),
                };
            }),
        [jobs, run, stageList],
    );

    /**
     * 只创建 run、不触发执行，好让页面先拿到 estimate 再决定要不要弹确认。
     * 222 万字的书会切成 163 块、按实测约 31 秒/块要跑 83 分钟，这种量级必须让用户在点「开始」之前看到。
     */
    const createRunOnly = useCallback(async (): Promise<GatewayPipelineRun | null> => {
        const text = novel.trim();
        if (!text || starting || run) return null;
        setStarting(true);
        setError("");
        try {
            const created = await createPipelineRun({ novel: text, title: deriveTitle(text) || undefined }, gwBase || undefined);
            usePipelineStore.getState().setActiveRun(created.id);
            usePipelineStore.getState().upsertRun({ id: created.id, title: created.title, createdAt: created.createdAt, stages: summarizeRunStages(created.stages) });
            setRun(created);
            return created;
        } catch (caught) {
            setError(messageOf(caught));
            return null;
        } finally {
            setStarting(false);
        }
    }, [novel, starting, run, gwBase]);

    /**
     * 触发单步。后端立刻返回 202，阶段在后台跑；这里把返回的 run（该阶段已是 running）设进状态，
     * 由 runningStage 驱动进度轮询。**不要 await 到阶段完成** —— 那正是一个多小时里前端毫无反应的根因。
     */
    const runStage = useCallback(
        async (stageId: string, options?: { resume?: boolean }) => {
            if (!runId || busyStage || runningStage) return;
            setBusyStage(stageId);
            setError("");
            try {
                setRun(await requestStageRun(runId, stageId, { model: stageModels[stageId] || undefined, resume: options?.resume }, gwBase || undefined));
            } catch (caught) {
                setError(messageOf(caught));
            } finally {
                setBusyStage("");
            }
        },
        [busyStage, runningStage, runId, stageModels, gwBase],
    );

    /** 取消正在跑的阶段。终态由进度轮询带回（后端 abort 后会把阶段落成 error +「已取消（第 N/M 块完成后中止）」）。 */
    const cancelStage = useCallback(
        async (stageId: string) => {
            if (!runId) return;
            setError("");
            try {
                await cancelPipelineStage(runId, stageId, gwBase || undefined);
            } catch (caught) {
                setError(messageOf(caught));
            }
        },
        [runId, gwBase],
    );

    const saveStageOutput = useCallback(
        async (stageId: string, output: unknown) => {
            if (!runId) return false;
            setBusyStage(stageId);
            setError("");
            try {
                setRun(await updatePipelineStageInput(runId, stageId, { output }, gwBase || undefined));
                return true;
            } catch (caught) {
                setError(messageOf(caught));
                return false;
            } finally {
                setBusyStage("");
            }
        },
        [runId, gwBase],
    );

    /**
     * 给单个条目追加一个候选（换模型再出一张）。后端 202 返回整个 run（该阶段已 running），这里只回错误文案，
     * 好让候选条就近提示 400/409 的拒绝；成功返回空串，终态由现有轮询接回。
     */
    const regenerateItem = useCallback(
        async (stageId: string, itemId: string, template?: string): Promise<string> => {
            if (!runId) return i18n.t("pipeline.candidates.noRun");
            const key = `${stageId}:${itemId}`;
            setRegeneratingItem(key);
            try {
                setRun(await regeneratePipelineItem(runId, stageId, { itemId, template }, gwBase || undefined));
                return "";
            } catch (caught) {
                return messageOf(caught);
            } finally {
                setRegeneratingItem("");
            }
        },
        [runId, gwBase],
    );

    return {
        novel,
        setNovel,
        run,
        views,
        starting,
        busyStage,
        runningStage,
        progress,
        error,
        createRunOnly,
        runStage,
        cancelStage,
        saveStageOutput,
        refresh,
        openRun,
        resetRun,
        loadHistory,
        historyLoading,
        renameRun,
        modelOptions,
        stageModels,
        setStageModel,
        templates,
        regeneratingItem,
        regenerateItem,
    };
}

/** 还没有任务信息、或任务仍在排队/运行，都需要继续轮询。 */
export function isPending(job: GatewayJob | undefined) {
    return !job || job.status === "queued" || job.status === "running";
}

export function isSettled(job: GatewayJob) {
    return job.status === "done" || job.status === "error" || job.status === "canceled";
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

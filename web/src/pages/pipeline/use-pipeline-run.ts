import { useCallback, useEffect, useMemo, useState } from "react";

import i18n from "@/i18n";
import {
    cancelPipelineStage,
    createPipelineRun,
    fetchGatewayJob,
    fetchGatewayLlmModels,
    fetchGatewayStages,
    fetchPipelineProgress,
    getPipelineRun,
    probeGatewayBaseUrl,
    runPipelineStage as requestStageRun,
    syncGatewayLlmProviders,
    updatePipelineStageInput,
    type GatewayArtifact,
    type GatewayJob,
    type GatewayPipelineRun,
    type GatewayRunStage,
    type GatewayStageInfo,
    type GatewayStageProgress,
    type GatewayStageStatus,
} from "@/services/api/gateway";
import { useConfigStore } from "@/stores/use-config-store";
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

export function usePipelineRun() {
    const [novel, setNovel] = useState("");
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [stages, setStages] = useState<GatewayStageInfo[]>([]);
    const [jobs, setJobs] = useState<Record<string, GatewayJob>>({});
    const [starting, setStarting] = useState(false);
    const [busyStage, setBusyStage] = useState("");
    const [error, setError] = useState("");
    const [llmModels, setLlmModels] = useState<string[]>([]);
    const [stageModels, setStageModels] = useState<Record<string, string>>(loadStageModels);
    const [gwBase, setGwBase] = useState("");
    /** 当前阶段的细粒度进度（第几块/共几块/预计还需多久），来自轻量 progress.json。 */
    const [progress, setProgress] = useState<GatewayStageProgress | null>(null);
    const runId = run?.id || "";
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
            const created = await createPipelineRun({ novel: text }, gwBase || undefined);
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
        modelOptions,
        stageModels,
        setStageModel,
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

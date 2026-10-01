import { useCallback, useEffect, useMemo, useState } from "react";

import i18n from "@/i18n";
import {
    createPipelineRun,
    fetchGatewayJob,
    fetchGatewayStages,
    getPipelineRun,
    runPipelineStage as requestStageRun,
    updatePipelineStageInput,
    type GatewayArtifact,
    type GatewayJob,
    type GatewayPipelineRun,
    type GatewayRunStage,
    type GatewayStageInfo,
    type GatewayStageStatus,
} from "@/services/api/gateway";
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

export function usePipelineRun() {
    const [novel, setNovel] = useState("");
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [stages, setStages] = useState<GatewayStageInfo[]>([]);
    const [jobs, setJobs] = useState<Record<string, GatewayJob>>({});
    const [starting, setStarting] = useState(false);
    const [busyStage, setBusyStage] = useState("");
    const [error, setError] = useState("");
    const runId = run?.id || "";

    useEffect(() => {
        void fetchGatewayStages()
            .then(setStages)
            .catch(() => setStages([]));
    }, []);

    const refresh = useCallback(async () => {
        if (!runId) return;
        try {
            setRun(await getPipelineRun(runId));
        } catch (caught) {
            setError(messageOf(caught));
        }
    }, [runId]);

    const pendingJobIds = useMemo(() => {
        if (!run) return [];
        return [...collectJobIds(run.stages)].filter((id) => isPending(jobs[id]));
    }, [run, jobs]);
    const pendingJobKey = pendingJobIds.join(",");

    useEffect(() => {
        if (!runId || !pendingJobKey) return;
        const ids = pendingJobKey.split(",");
        const load = () => {
            void Promise.all(ids.map((id) => fetchGatewayJob(id).catch(() => null))).then((results) => {
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

    const startScript = async () => {
        const text = novel.trim();
        if (!text || starting || run) return;
        setStarting(true);
        setError("");
        try {
            const created = await createPipelineRun({ novel: text });
            setRun(created);
            setRun(await requestStageRun(created.id, "script"));
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setStarting(false);
        }
    };

    const runStage = useCallback(
        async (stageId: string) => {
            if (!runId || busyStage) return;
            setBusyStage(stageId);
            setError("");
            try {
                setRun(await requestStageRun(runId, stageId));
            } catch (caught) {
                setError(messageOf(caught));
            } finally {
                setBusyStage("");
            }
        },
        [busyStage, runId],
    );

    const saveStageOutput = useCallback(
        async (stageId: string, output: unknown) => {
            if (!runId) return false;
            setBusyStage(stageId);
            setError("");
            try {
                setRun(await updatePipelineStageInput(runId, stageId, { output }));
                return true;
            } catch (caught) {
                setError(messageOf(caught));
                return false;
            } finally {
                setBusyStage("");
            }
        },
        [runId],
    );

    return { novel, setNovel, run, views, starting, busyStage, error, startScript, runStage, saveStageOutput, refresh };
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

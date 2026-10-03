import { Button, Card, Image, Modal, Typography } from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl, type GatewayStageProgress, type GatewayStageStatus } from "@/services/api/gateway";
import type { ProjectGate } from "@/services/api/projects";
import type { AssetRef } from "@/types/domain";
import { usePipelineStore } from "@/stores/use-pipeline-store";

// 复用流水线页既有的产物归类与步骤条，不另写一套。
import { StageSteps, stepsFromRunStage } from "@/pages/pipeline/components/stage-steps";
import { isGenerativeStage } from "@/pages/pipeline/pipeline-utils";

import { artifactKind, buildStages, textSummary, type TimelineArtifact, type TimelineStage } from "../process-timeline-model";
import { useProjectTimeline } from "../hooks/use-project-timeline";
import type { StageStatusMap } from "../workspace-gates";
import { NextStepPanel } from "./next-step-panel";

const DOT_CLASS: Record<GatewayStageStatus, string> = {
    pending: "bg-stone-300 dark:bg-stone-600",
    running: "bg-amber-500 animate-pulse",
    partial: "bg-orange-500",
    done: "bg-emerald-500",
    error: "bg-red-500",
    blocked: "bg-violet-500",
    canceled: "bg-stone-400 dark:bg-stone-500",
};

const TEXT_CLASS: Record<GatewayStageStatus, string> = {
    pending: "text-stone-400 dark:text-stone-500",
    running: "text-amber-600 dark:text-amber-400",
    partial: "text-orange-600 dark:text-orange-400",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    blocked: "text-violet-600 dark:text-violet-400",
    canceled: "text-stone-500 dark:text-stone-400",
};

function formatDuration(ms: number) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function lastSegment(url: string) {
    return decodeURIComponent(url.split("/").pop() || url);
}

/**
 * 项目工作区「过程时间线」：按流水线阶段线性铺开所有产物，运行中实时新增（后台出一张前台长一张）。
 *
 * 数据源以 run 的 artifacts 为准（assetRefs 重启后才生效，不作为唯一来源）；轮询与节流在 useProjectTimeline，
 * 产物归类复用 pipeline-utils、步骤条复用 stage-steps。空态复用 NextStepPanel 指路「下一步」。
 */
export function ProcessTimeline({
    projectId,
    runId,
    assetRefs,
    gates,
    gatesLoading,
    stageStatus,
}: {
    projectId: string;
    /** 当前选中的 run（多 run 时由工作区选择器切换，默认第一个）；时间线只铺这一个 run 的产物。 */
    runId: string;
    /** 项目侧已登记资产（重启后才生效，可能为空）；仅用于给产物打「已登记」标记，不作为时间线数据源。 */
    assetRefs: AssetRef[];
    gates: ProjectGate[];
    gatesLoading: boolean;
    stageStatus: StageStatusMap;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { run, progress, active, error } = useProjectTimeline({ runId });
    const stages = useMemo(() => buildStages(run), [run]);
    const registered = useMemo(() => {
        const urls = new Set<string>();
        for (const ref of assetRefs) {
            for (const id of ref.artifactIds || []) if (id) urls.add(id);
            if (ref.selectedArtifactId) urls.add(ref.selectedArtifactId);
        }
        return urls;
    }, [assetRefs]);
    const runningStage = progress && progress.phase === "running" ? progress.stage : "";

    const openRun = () => {
        if (!run) return;
        usePipelineStore.getState().setActiveRun(run.id);
        navigate("/pipeline");
    };

    return (
        <section>
            <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.timeline.title")}
                </Typography.Title>
                {active ? (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                        {t("projects.timeline.live")}
                    </span>
                ) : null}
            </div>

            {!stages.length ? (
                <NextStepPanel projectId={projectId} gates={gates} gatesLoading={gatesLoading} stageStatus={stageStatus} />
            ) : (
                <Card size="small">
                    {error ? (
                        <div className="mb-2 text-xs text-red-600 dark:text-red-400">
                            {t("projects.timeline.loadFailed")}：{error}
                        </div>
                    ) : null}
                    <div className="max-h-[440px] divide-y divide-stone-200/70 overflow-y-auto dark:divide-stone-700/70">
                        {stages.map((stage, index) => (
                            <StageRow
                                key={stage.id}
                                index={index}
                                stage={stage}
                                progress={runningStage === stage.id ? progress : null}
                                registered={registered}
                                onOpenRun={openRun}
                            />
                        ))}
                    </div>
                </Card>
            )}
        </section>
    );
}

function StageRow({
    index,
    stage,
    progress,
    registered,
    onOpenRun,
}: {
    index: number;
    stage: TimelineStage;
    progress: GatewayStageProgress | null;
    registered: Set<string>;
    onOpenRun: () => void;
}) {
    const { t } = useTranslation();
    const stageName = t(`pipeline.stages.${stage.id}`);
    const total = Number(progress?.total) || 0;
    const done = Number(progress?.done) || 0;
    const liveSteps = progress && Array.isArray(progress.steps) ? progress.steps : [];
    const stepView = liveSteps.length ? liveSteps : stepsFromRunStage(stage.stage.steps);
    const summary = textSummary(stage.id, stage.stage.output, t);

    return (
        <div className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[stage.status])} />
                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">
                    {index + 1}. {stageName}
                </span>
                <span className={cn("text-xs", TEXT_CLASS[stage.status])}>{t(`pipeline.status.${stage.status}`)}</span>
                {stage.artifacts.length ? (
                    <span className="text-xs text-stone-400 dark:text-stone-500">{t("projects.timeline.count", { count: stage.artifacts.length })}</span>
                ) : null}
                {!isGenerativeStage(stage.id) && stage.stage.output != null ? (
                    <Button type="link" size="small" className="!h-auto !px-0 !text-xs" onClick={onOpenRun}>
                        {t("projects.timeline.viewRun")}
                    </Button>
                ) : null}
            </div>

            {progress ? (
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-stone-600 dark:text-stone-300">
                    <span className="font-medium">{t(`pipeline.progress.${progress.phase}`)}</span>
                    {progress.label ? <span className="text-stone-500 dark:text-stone-400">{progress.label}</span> : null}
                    {total > 1 ? (
                        <span>
                            {t("pipeline.progress.chunks", { done, total })}
                        </span>
                    ) : null}
                    {Number(progress.etaMs) > 0 ? <span>{t("pipeline.progress.eta", { time: formatDuration(Number(progress.etaMs)) })}</span> : null}
                </div>
            ) : null}

            {stepView.length ? <StageSteps steps={stepView} outputs={stage.stage.steps} /> : null}

            {stage.stage.blocked?.length ? (
                <div className="mt-1 space-y-0.5 text-xs text-violet-600 dark:text-violet-400">
                    {stage.stage.blocked.map((entry) => (
                        <div key={entry.itemId} className="break-words">
                            {t("pipeline.blockedItem", { itemId: entry.itemId, reason: entry.reason })}
                        </div>
                    ))}
                </div>
            ) : null}

            {summary.length ? (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-600 dark:text-stone-300">
                    {summary.map((line) => (
                        <span key={line} className="break-words">
                            {line}
                        </span>
                    ))}
                </div>
            ) : null}

            {stage.media.length ? (
                // 同阶段图片共用一个预览组，弹窗里可左右切换看多张；视频走独立弹窗，不进预览组。
                <Image.PreviewGroup preview={{ closeIcon: false }}>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {stage.media.map((artifact) => (
                            <Thumb key={artifact.url} artifact={artifact} kind={artifactKind(artifact, stage.id)} registered={registered.has(artifact.url)} />
                        ))}
                    </div>
                </Image.PreviewGroup>
            ) : null}

            {stage.files.length ? (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                    {stage.files.map((artifact) => (
                        <a key={artifact.url} href={resolveGatewayUrl(artifact.url)} target="_blank" rel="noreferrer" className="text-stone-500 underline dark:text-stone-400">
                            {lastSegment(artifact.url)}
                        </a>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

/** 产物缩略图：图片/视频统一尺寸，点开在站内弹窗预览或播放；已登记为资产者右上角带绿点。 */
function Thumb({ artifact, kind, registered }: { artifact: TimelineArtifact; kind: "image" | "video" | "file"; registered: boolean }) {
    const { t } = useTranslation();
    const [videoOpen, setVideoOpen] = useState(false);
    const src = resolveGatewayUrl(artifact.url);
    const label = lastSegment(artifact.url);
    const box =
        "relative h-16 w-16 shrink-0 overflow-hidden rounded border border-stone-200/80 bg-black/5 transition hover:border-amber-400 dark:border-stone-700/80 dark:bg-white/5";
    const badge = registered ? (
        <span
            className="absolute right-0.5 top-0.5 size-2 rounded-full bg-emerald-500 ring-1 ring-white dark:ring-stone-900"
            title={t("projects.timeline.registered")}
        />
    ) : null;
    if (kind === "video") {
        return (
            <>
                <button
                    type="button"
                    className={cn(box, "block cursor-pointer")}
                    title={label}
                    aria-label={t("projects.timeline.previewVideo")}
                    onClick={() => setVideoOpen(true)}
                >
                    <video src={src} muted preload="metadata" className="h-full w-full object-cover" />
                    {badge}
                </button>
                {/* 不留 × 按钮：点遮罩或按 Esc 关闭（maskClosable / keyboard 均为 antd 默认 true）。 */}
                <Modal open={videoOpen} footer={null} centered closable={false} destroyOnHidden onCancel={() => setVideoOpen(false)}>
                    <video src={src} controls autoPlay className="max-h-[76vh] w-auto" />
                </Modal>
            </>
        );
    }
    return (
        <span className={cn(box, "block")}>
            <Image
                src={src}
                alt={label}
                title={label}
                loading="lazy"
                rootClassName="block h-full w-full cursor-pointer"
                className="h-full w-full object-cover"
                preview={{ cover: false, closeIcon: false }}
            />
            {badge}
        </span>
    );
}

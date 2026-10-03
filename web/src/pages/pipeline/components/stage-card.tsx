import { Button, Select } from "antd";
import { ChevronDown, ChevronUp, Pencil, Play, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl, type GatewayArtifact, type GatewayStageProgress, type GatewayStageStatus, type GatewayTemplateInfo } from "@/services/api/gateway";
import { isGenerativeStage, isVideoArtifact, orphanArtifacts, stageItems, stageMediaKind, templatesForStage } from "../pipeline-utils";
import type { PipelineStageView } from "../use-pipeline-run";
import { CandidateStrip } from "./candidate-strip";
import { StageSteps, stepsFromRunStage } from "./stage-steps";

const STATUS_CLASS: Record<GatewayStageStatus, string> = {
    pending: "text-stone-500 dark:text-stone-400",
    running: "text-amber-600 dark:text-amber-400",
    partial: "text-orange-600 dark:text-orange-400",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    blocked: "text-violet-600 dark:text-violet-400",
    canceled: "text-stone-500 dark:text-stone-400",
};

function formatDuration(ms: number) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return `${hours}h${minutes}m`;
    if (minutes) return `${minutes}m${seconds}s`;
    return `${seconds}s`;
}

/** 阶段进度条：分块改编时显示「第 N/M 块 + 来源 + 预计剩余」，单次调用只显示一行状态。 */
function StageProgress({ progress }: { progress: GatewayStageProgress }) {
    const { t } = useTranslation();
    const total = Number(progress.total) || 0;
    const done = Number(progress.done) || 0;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
        <div className="mt-2 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-stone-600 dark:text-stone-300">
                <span className="font-medium">{t(`pipeline.progress.${progress.phase}`)}</span>
                {total > 1 ? <span>{t("pipeline.progress.chunks", { done, total })}</span> : null}
                {progress.label ? <span className="text-stone-500 dark:text-stone-400">{progress.label}</span> : null}
                {Number(progress.reused) > 0 ? <span className="text-emerald-600 dark:text-emerald-400">{t("pipeline.progress.reused", { count: progress.reused })}</span> : null}
                {Number(progress.etaMs) > 0 ? <span className="text-stone-500 dark:text-stone-400">{t("pipeline.progress.eta", { time: formatDuration(Number(progress.etaMs)) })}</span> : null}
                {Number(progress.avgMsPerChunk) > 0 ? <span className="text-stone-400 dark:text-stone-500">{t("pipeline.progress.speed", { seconds: (Number(progress.avgMsPerChunk) / 1000).toFixed(1) })}</span> : null}
            </div>
            {total > 1 ? (
                <div className="h-1 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                    <div className="h-full rounded-full bg-amber-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
                </div>
            ) : null}
        </div>
    );
}

export function StageCard({ index, view, busy, progress, resumeChunks, disabledReason, modelOptions, model, templates, regeneratingItem, onModelChange, onRun, onRerun, onCancel, onEdit, onRegenerate }: { index: number; view: PipelineStageView; busy: boolean; progress: GatewayStageProgress | null; resumeChunks: number; disabledReason: string; modelOptions: Array<{ label: string; options: Array<{ value: string; label: string }> }>; model: string; templates: GatewayTemplateInfo[]; regeneratingItem: string; onModelChange: (model: string) => void; onRun: () => void; onRerun: () => void; onCancel: () => void; onEdit: () => void; onRegenerate: (stageId: string, itemId: string, template: string) => Promise<string> }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const output = view.stage?.output;
    const running = view.status === "running";
    // 进度只在属于本阶段时显示：progress.json 是 run 级单文件，别的阶段跑时不该串到这张卡上
    const ownProgress = progress && progress.stage === view.id ? progress : null;
    // 01 剧本多步：优先用轮询到的 progress.steps（实时状态），阶段跑完后回落到 run 里落盘的 stage.steps。
    // 两者都没有（旧 run / 其余阶段）则空数组，卡片渲染与从前完全一致。
    const liveSteps = ownProgress && Array.isArray(ownProgress.steps) ? ownProgress.steps : [];
    const stepView = liveSteps.length ? liveSteps : stepsFromRunStage(view.stage?.steps);
    // 生成型阶段（关键帧 / 片段合成）按条目铺候选缩略图；扁平产物行只保留候选条之外的东西（如成片）
    const generative = isGenerativeStage(view.id);
    const items = generative ? stageItems(view.stage, view.id) : [];
    const itemKind = stageMediaKind(view.id);
    const stageTemplates = generative ? templatesForStage(templates, view.id) : [];
    const itemsWithCandidates = items.filter((item) => (item.candidates || []).length);
    const looseArtifacts = orphanArtifacts(view.artifacts, items);

    return (
        <section className="px-1 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">
                    {index + 1}. {view.title}
                </span>
                <span className={cn("inline-flex items-center gap-1 text-xs", STATUS_CLASS[view.status])}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {t(`pipeline.status.${view.status}`)}
                </span>
                {view.generating ? <span className="text-xs text-stone-500 dark:text-stone-400">{t("pipeline.generating")}</span> : null}
                <div className="ml-auto flex items-center gap-1">
                    <Select
                        size="small"
                        value={model}
                        onChange={onModelChange}
                        style={{ minWidth: 200 }}
                        placeholder={t("pipeline.modelLoadFailed")}
                        options={modelOptions}
                        disabled={running}
                    />
                    {running ? (
                        <Button type="text" size="small" danger icon={<XCircle className="size-3.5" />} onClick={onCancel}>
                            {t("pipeline.cancel")}
                        </Button>
                    ) : (
                        <Button type="text" size="small" icon={<Play className="size-3.5" />} loading={busy} disabled={Boolean(disabledReason)} onClick={onRun}>
                            {t("pipeline.runStage")}
                        </Button>
                    )}
                    <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} disabled={running || Boolean(disabledReason) || view.status === "pending"} onClick={onRerun}>
                        {resumeChunks > 0 ? t("pipeline.resume", { count: resumeChunks }) : t("pipeline.rerun")}
                    </Button>
                    <Button type="text" size="small" icon={<Pencil className="size-3.5" />} disabled={running || !view.stage || output === undefined} onClick={onEdit}>
                        {t("pipeline.editOutput")}
                    </Button>
                    <Button type="text" size="small" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((current) => !current)}>
                        {t(expanded ? "pipeline.hideJson" : "pipeline.viewJson")}
                    </Button>
                </div>
            </div>
            {running && ownProgress ? <StageProgress progress={ownProgress} /> : null}
            {stepView.length ? <StageSteps steps={stepView} outputs={view.stage?.steps} /> : null}
            {disabledReason ? <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{disabledReason}</div> : null}
            {view.stage?.blocked?.length ? (
                <div className="mt-1 space-y-0.5 text-xs text-violet-600 dark:text-violet-400">
                    {view.stage.blocked.map((entry) => (
                        <div key={entry.itemId} className="break-words">
                            {t("pipeline.blockedItem", { itemId: entry.itemId, reason: entry.reason })}
                        </div>
                    ))}
                </div>
            ) : null}
            {/* 纯 blocked 阶段后端会把同样的原因同时写进 stage.error，这里去重，只留上面的阻断行。 */}
            {view.stage?.error && view.status !== "blocked" ? <div className="mt-1 text-xs text-red-600 dark:text-red-400">{view.stage.error}</div> : null}
            {expanded ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600 dark:text-stone-300">{output === undefined ? t("pipeline.noOutput") : JSON.stringify(output, null, 2)}</pre> : null}
            {itemsWithCandidates.length ? (
                <div className="mt-2 space-y-1">
                    {itemsWithCandidates.map((item) => (
                        <CandidateStrip
                            key={item.id}
                            item={item}
                            index={items.indexOf(item)}
                            kind={itemKind}
                            templates={stageTemplates}
                            busy={regeneratingItem === `${view.id}:${item.id}`}
                            stageRunning={running}
                            onRegenerate={(itemId, template) => onRegenerate(view.id, itemId, template)}
                        />
                    ))}
                </div>
            ) : null}
            {looseArtifacts.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                    {looseArtifacts.map((artifact) => (
                        <StageArtifact key={artifact.url} artifact={artifact} />
                    ))}
                </div>
            ) : null}
        </section>
    );
}

function StageArtifact({ artifact }: { artifact: GatewayArtifact }) {
    const src = resolveGatewayUrl(artifact.url);
    if (isVideoArtifact(artifact)) return <video src={src} controls preload="metadata" className="h-28 max-w-52 rounded-md" />;
    if (artifact.type === "image") return <img src={src} alt={artifact.filename} className="h-28 max-w-52 rounded-md object-cover" />;
    return (
        <a href={src} target="_blank" rel="noreferrer" className="self-center text-xs text-stone-500 underline dark:text-stone-400">
            {artifact.filename}
        </a>
    );
}

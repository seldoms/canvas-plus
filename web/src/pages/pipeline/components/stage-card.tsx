import { Button, Select } from "antd";
import { FolderOpen, Play, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { displayProgressLabel } from "@/lib/progress-label";
import { resolveGatewayUrl, type GatewayArtifact, type GatewayStageProgress, type GatewayStageStatus, type GatewayTemplateInfo } from "@/services/api/gateway";
import { MediaPreviewGroup, PreviewableMedia } from "@/components/workbench";
import type { SelectModelItem } from "@/lib/model-grouping";
import { isGenerativeStage, isVideoArtifact, orphanArtifacts, stageItems, stageMediaKind, templatesForStage } from "../pipeline-utils";
import type { PipelineStageView } from "../use-pipeline-run";
import { CandidateStrip } from "./candidate-strip";
import { StageSteps, stepsFromRunStage } from "./stage-steps";
import { artifactThumbSrc } from "@/lib/artifact-thumb";

const STATUS_CLASS: Record<GatewayStageStatus, string> = {
    pending: "text-stone-500 dark:text-stone-400",
    running: "text-amber-600 dark:text-amber-400",
    partial: "text-orange-600 dark:text-orange-400",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    blocked: "text-violet-600 dark:text-violet-400",
    canceled: "text-stone-500 dark:text-stone-400",
};

function hasModelOption(options: SelectModelItem[], value: string) {
    return options.some((option) => "value" in option ? option.value === value : option.options.some((child) => child.value === value));
}

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
                {progress.label ? <span className="text-stone-500 dark:text-stone-400">{displayProgressLabel(progress.label)}</span> : null}
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

export function StageCard({ index, view, busy, progress, resumeChunks, disabledReason, modelOptions, model, templates, regeneratingItem, onModelChange, onRun, onRerun, onCancel, onRegenerate, onRefresh, onOpenProjects }: { index: number; view: PipelineStageView; busy: boolean; progress: GatewayStageProgress | null; resumeChunks: number; disabledReason: string; modelOptions: SelectModelItem[]; model: string; templates: GatewayTemplateInfo[]; regeneratingItem: string; onModelChange: (model: string) => void; onRun: () => void; onRerun: () => void; onCancel: () => void; onRegenerate: (stageId: string, itemId: string, template: string) => Promise<string>; onRefresh: () => void; onOpenProjects: () => void }) {
    const { t } = useTranslation();
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
    const looseArtifacts = orphanArtifacts(view.artifacts, items).filter((artifact) => !/\.json$/i.test(artifact.filename || ""));
    /** blocked 阶段：前端必须显示服务端给的原因并解锁操作，不能显示成「运行中/生成中」（#70）。 */
    const blocked = view.status === "blocked";
    // 逐镜缺哪些参考素材（角色/场景/道具）——去重后列表，复用项目关键帧工作区同一套文案，不另造一套。
    const missingRefs = (() => {
        const seen = new Set<string>();
        const out: Array<{ role: string; bindingId: string; reason: string }> = [];
        for (const item of items) {
            for (const entry of item.blockedMissing || []) {
                const key = `${entry.role}:${entry.bindingId}:${entry.reason}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(entry);
            }
        }
        return out;
    })();

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
                    {modelOptions.length ? <Select
                        size="small"
                        value={hasModelOption(modelOptions, model) ? model : undefined}
                        onChange={onModelChange}
                        style={{ minWidth: 220 }}
                        placeholder={t("pipeline.stageModelDefault")}
                        options={modelOptions}
                        optionLabelProp="title"
                        disabled={running}
                    /> : null}
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
                </div>
            </div>
            {running && ownProgress ? <StageProgress progress={ownProgress} /> : null}
            {stepView.length ? <StageSteps steps={stepView} outputs={view.stage?.steps} /> : null}
            {disabledReason ? <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{disabledReason}</div> : null}
            {blocked ? (
                <div className="mt-2 rounded-md border border-violet-200 bg-violet-50/70 p-2 text-xs dark:border-violet-900/60 dark:bg-violet-950/30">
                    <div className="font-medium text-violet-700 dark:text-violet-300">{t("pipeline.blocked.title")}</div>
                    <div className="mt-0.5 text-violet-700/90 dark:text-violet-300/90">{t("pipeline.blocked.hint")}</div>
                    {missingRefs.length ? (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-violet-700 dark:text-violet-300">
                            {missingRefs.map((entry) => (
                                <li key={`${entry.role}:${entry.bindingId}:${entry.reason}`} className="break-words">
                                    {t("projects.keyframes.blockedMissing", {
                                        role: t(`projects.keyframes.roles.${entry.role}`, { defaultValue: entry.role }),
                                        bindingId: entry.bindingId,
                                        reason: t(`projects.keyframes.blockedReasons.${entry.reason}`, { defaultValue: t("projects.keyframes.blockedReasons.other") }),
                                    })}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {view.stage?.blocked?.length ? (
                        <div className="mt-1 space-y-0.5 text-violet-700/90 dark:text-violet-300/90">
                            {view.stage.blocked.map((entry) => (
                                <div key={entry.itemId} className="break-words">
                                    {t("pipeline.blockedItem", { itemId: entry.itemId, reason: entry.reason })}
                                </div>
                            ))}
                        </div>
                    ) : view.stage?.error ? (
                        <div className="mt-1 break-words text-violet-700/90 dark:text-violet-300/90">{view.stage.error}</div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>
                            {t("pipeline.blocked.refresh")}
                        </Button>
                        <Button size="small" icon={<FolderOpen className="size-3.5" />} onClick={onOpenProjects}>
                            {t("pipeline.blocked.openProjects")}
                        </Button>
                    </div>
                </div>
            ) : null}
            {/* 非 blocked 阶段：服务端 error 直接展示；blocked 的原因已在上面面板里，避免重复。 */}
            {view.stage?.error && !blocked ? <div className="mt-1 text-xs text-red-600 dark:text-red-400">{view.stage.error}</div> : null}
            {view.stage?.output ? <StageOutputSummary stageId={view.id} output={view.stage.output} /> : null}
            {view.id === "casting" && view.stage?.output ? <CastingCards output={view.stage.output} /> : null}
            {itemsWithCandidates.length ? (
                <MediaPreviewGroup>
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
                </MediaPreviewGroup>
            ) : null}
            {looseArtifacts.length ? (
                <MediaPreviewGroup>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {looseArtifacts.map((artifact) => (
                            <StageArtifact key={artifact.url} artifact={artifact} />
                        ))}
                    </div>
                </MediaPreviewGroup>
            ) : null}
        </section>
    );
}

function StageArtifact({ artifact }: { artifact: GatewayArtifact }) {
    const src = resolveGatewayUrl(artifact.url);
    // 列表用小图：原图交给预览弹窗（图片）/ 播放时再取（视频）。
    const thumbSrc = artifactThumbSrc(src);
    // 视频自带控件即可播放；图片本身没有可点暗示 → 走共享可预览组件，站内弹窗看大图。
    if (isVideoArtifact(artifact)) return <video src={src} poster={thumbSrc} controls preload="none" className="h-28 max-w-52 rounded-md" />;
    if (artifact.type === "audio") return <audio src={src} controls preload="none" className="h-9 max-w-72" />;
    if (artifact.type === "image") {
        return (
            <PreviewableMedia id={`artifact:${artifact.url}`} kind="image" src={src} thumbSrc={thumbSrc} title={artifact.filename} className="h-28 max-w-52 cursor-zoom-in overflow-hidden rounded-md">
                <img src={thumbSrc} alt={artifact.filename} className="h-28 max-w-52 rounded-md object-cover" />
            </PreviewableMedia>
        );
    }
    return (
        <a href={src} target="_blank" rel="noreferrer" className="self-center text-xs text-stone-500 underline dark:text-stone-400">
            {artifact.filename}
        </a>
    );
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
}

/** 产物只展示用户要做决定的事实；原始 JSON 留在调试接口，不占据生产页面。 */
function StageOutputSummary({ stageId, output }: { stageId: string; output: unknown }) {
    const { t } = useTranslation();
    const data = asRecord(output);
    const values: string[] = [];
    if (stageId === "script") {
        if (asArray(data.characters).length) values.push(`${asArray(data.characters).length} 个角色`);
        if (asArray(data.scenes).length) values.push(`${asArray(data.scenes).length} 个场景`);
        if (asArray(data.episodes).length) values.push(`${asArray(data.episodes).length} 集`);
    } else if (stageId === "storyboard") {
        const shots = asArray(data.shots);
        if (shots.length) values.push(`${shots.length} 个镜头`);
        const dialogues = shots.reduce((count, shot) => count + (asArray(shot.dialogueLines).length || (String(shot.dialogue || "").trim() ? 1 : 0)), 0);
        if (dialogues) values.push(`${dialogues} 条台词`);
    } else if (stageId === "design" || stageId === "casting") {
        const characters = asArray(data.characters);
        const locations = asArray(data.locations);
        if (characters.length) values.push(`${characters.length} 个角色设定`);
        if (locations.length) values.push(`${locations.length} 个场景设定`);
    } else if (stageId === "audio") {
        const audio = asArray(data.audio);
        if (audio.length) values.push(`${audio.length} 条声音`);
    } else if (stageId === "assembly") {
        const clips = asArray(data.clips);
        if (clips.length) values.push(`${clips.length} 个片段`);
        const film = asRecord(data.assembly);
        if (String(film.status || "") === "done") values.push("成片已完成");
    }
    if (!values.length) return null;
    return <div className="mt-3 flex flex-wrap gap-2 text-xs text-stone-600 dark:text-stone-300">{values.map((value) => <span key={value} className="rounded-full bg-stone-100 px-2.5 py-1 dark:bg-white/10">{value}</span>)}{stageId === "assembly" ? <span className="text-stone-400">{t("pipeline.outputPreviewHint")}</span> : null}</div>;
}

function CastingCards({ output }: { output: unknown }) {
    const cards = asArray(asRecord(output).characters);
    if (!cards.length) return null;
    return (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {cards.map((card, index) => {
                const face = asRecord(card.face);
                const voice = asRecord(card.voice);
                const url = String(face.closeupArtifactId || "").trim();
                const src = url && /^(https?:|\/api\/)/i.test(url) ? resolveGatewayUrl(url) : "";
                return (
                    <div key={String(card.characterId || index)} className="flex items-center gap-3 rounded-lg border border-stone-200/80 px-3 py-2 dark:border-stone-800">
                        {src ? <img src={artifactThumbSrc(src)} alt={String(card.name || "角色")} className="size-12 rounded-md object-cover" /> : <div className="flex size-12 items-center justify-center rounded-md bg-stone-100 text-xs text-stone-400 dark:bg-white/10">脸</div>}
                        <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{String(card.name || card.characterId || "未命名角色")}</div>
                            <div className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">{String(voice.speaker || "声音待确认")} · {String(voice.language || "语言待确认")}</div>
                            <div className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">{card.confirmed === true ? "已确认" : "待确认"}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

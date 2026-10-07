import { Alert, Button, Empty, InputNumber, Tag, Tooltip } from "antd";
import { Download, FileArchive, FileText, Film, Mic, Play, Scissors, Volume2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { readRunAssembly } from "@/services/api/delivery";

import { StageShell } from "./stage-shell";
import type {
    AssemblyOutput,
    AudioLine,
    AudioOutput,
    CastingStageOutput,
    StoryboardOutput,
} from "./stage-types";
import { stageOutput } from "./stage-types";
import type { Production } from "./use-production";

function StageEmpty({ production, stageId, hint }: { production: Production; stageId: string; hint: string }) {
    if (!production.run) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先在左侧选择一条执行记录；没有的话点上方「运行」按项目原文新建" />;
    }
    if (production.stageStatus(stageId) === "running") {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本阶段正在生成，产物落盘后自动出现在这里" />;
    }
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hint} />;
}

/* ------------------------------------------------------------------ */
/* 06 配音 —— 逐句生产表：读 audio[]（清单 §4.8 已按此修）。              */
/*    试听播真实产物；单句重录走 regenerate，语速随 params 进 TTS（§4.9）。*/
/* ------------------------------------------------------------------ */

function AudioLineRow({
    production,
    line,
    shotLabel,
    characterName,
}: {
    production: Production;
    line: AudioLine;
    shotLabel: string;
    characterName: string;
}) {
    const [speed, setSpeed] = useState(line.speed ?? 1);
    const [redoing, setRedoing] = useState(false);
    const overtime = line.actualDurationSec != null && line.durationSec != null && line.actualDurationSec > line.durationSec;
    const audioUrl = production.artifactUrl(line.artifactUrl);
    const redo = async () => {
        setRedoing(true);
        /** 语速写进 TTS params（清单 §4.9）：重录时覆盖 speed，其余参数后端沿用身份卡。 */
        await production.regenerateItem("audio", line.id, { params: { SPEED: speed } });
        setRedoing(false);
    };
    return (
        <div className={cn(
            "grid items-center gap-3 rounded-lg border border-stone-200/70 px-3.5 py-2.5 md:grid-cols-[4rem_5rem_1fr_5.5rem_6.5rem_9rem] dark:border-stone-800",
            (line.status === "error" || overtime) && "border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-950/20",
        )}>
            <div className="text-xs tabular-nums text-stone-500 dark:text-stone-400">{shotLabel}</div>
            <Tag className="mr-0 w-fit">{characterName}</Tag>
            <div className="min-w-0">
                <div className="truncate text-sm text-stone-800 dark:text-stone-200">{line.text || "（无台词）"}</div>
                <div className="truncate text-xs italic text-stone-400">{line.performance}</div>
                {overtime ? (
                    <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                        实测 {line.actualDurationSec}s 超出计划 {line.durationSec}s —— 放慢语速重录，或回分镜调整该镜时长
                    </div>
                ) : null}
            </div>
            <div className="flex items-center gap-1 text-xs text-stone-500">
                <span>×</span>
                <InputNumber size="small" min={0.5} max={1.5} step={0.05} value={speed} onChange={(v) => setSpeed(v ?? 1)} className="w-16" />
            </div>
            <div className={cn("text-xs tabular-nums", overtime ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400")}>
                {line.actualDurationSec != null ? `${line.actualDurationSec}s` : "—"} / {line.durationSec ?? "—"}s
            </div>
            <div className="flex items-center justify-end gap-1">
                <Tag color={line.status === "done" ? "success" : line.status === "running" || line.status === "queued" ? "processing" : line.status === "error" ? "error" : "default"} className="mr-0">
                    {line.status === "done" ? "完成" : line.status === "running" ? "生成中" : line.status === "queued" ? "排队" : line.status === "error" ? "失败" : "待生成"}
                </Tag>
                <Tooltip title={audioUrl ? "试听当前采用的一版" : "还没有产物"}>
                    <Button
                        size="small"
                        type="text"
                        icon={<Volume2 className="size-3.5" />}
                        disabled={!audioUrl}
                        onClick={() => void new Audio(audioUrl).play().catch(() => undefined)}
                    />
                </Tooltip>
                <Tooltip title="单句重录（按当前语速追加一个新候选，新候选自动采用）">
                    <Button size="small" type="text" loading={redoing} icon={<Mic className="size-3.5" />} onClick={() => void redo()} />
                </Tooltip>
            </div>
        </div>
    );
}

export function AudioPanel({ production }: { production: Production }) {
    const audio = stageOutput<AudioOutput>(production.run, "audio");
    const board = stageOutput<StoryboardOutput>(production.run, "storyboard");
    const casting = stageOutput<CastingStageOutput>(production.run, "casting");
    if (!production.run || !audio) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="audio" hint="本执行记录还没有配音产物：关键帧完成后运行本阶段" />
            </StageShell>
        );
    }
    const lines = audio.audio ?? [];
    const shotIndexOf = new Map((board?.shots ?? []).map((s) => [s.id, s.index]));
    const characterNameOf = new Map((casting?.characters ?? []).map((c) => [c.characterId, c.name || c.characterId]));
    const dialogue = lines.filter((line) => line.type !== "ambience");
    const overtimeCount = dialogue.filter((line) => line.actualDurationSec != null && line.durationSec != null && line.actualDurationSec > line.durationSec).length;
    return (
        <StageShell
            alerts={
                overtimeCount ? (
                    <Alert
                        type="warning"
                        showIcon
                        message={`${overtimeCount} 句对白实测时长超出镜头计划时长`}
                        description="可放慢语速后单句重录，或回到分镜调整该镜计划时长。"
                    />
                ) : undefined
            }
        >
            <div className="mb-2 hidden gap-3 px-3.5 text-[11px] uppercase tracking-wider text-stone-400 md:grid md:grid-cols-[4rem_5rem_1fr_5.5rem_6.5rem_9rem]">
                <span>镜头</span><span>角色</span><span>台词 / 表演</span><span>语速</span><span>实测/计划</span><span className="text-right">状态 / 操作</span>
            </div>
            <div className="space-y-2">
                {dialogue.map((line) => (
                    <AudioLineRow
                        key={line.id}
                        production={production}
                        line={line}
                        shotLabel={shotIndexOf.has(line.shotId || "") ? `镜 ${shotIndexOf.get(line.shotId || "")}` : line.shotId || "—"}
                        characterName={characterNameOf.get(line.characterId || "") || line.characterId || "旁白"}
                    />
                ))}
            </div>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 07 成片交付 —— 真实片段时间线 + 独立拼接 + 真实成片预览 + 导出包。      */
/* ------------------------------------------------------------------ */

export function AssemblyPanel({ production }: { production: Production }) {
    const assemblyOut = stageOutput<AssemblyOutput>(production.run, "assembly");
    const board = stageOutput<StoryboardOutput>(production.run, "storyboard");
    const [assembling, setAssembling] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exported, setExported] = useState(false);
    if (!production.run || !assemblyOut) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="assembly" hint="本执行记录还没有片段产物：配音完成后运行本阶段" />
            </StageShell>
        );
    }
    const clips = assemblyOut.clips ?? [];
    const assembly = readRunAssembly(production.run);
    const shotIndexOf = new Map((board?.shots ?? []).map((s) => [s.id, s.index]));
    const order = Array.isArray(assembly?.order) ? (assembly.order as string[]) : [];
    const ordered = order.length
        ? (order.map((id) => clips.find((c) => c.id === id)).filter(Boolean) as typeof clips)
        : clips;
    const finalUrl = production.artifactUrl(assembly?.url);
    const subtitleUrl = production.artifactUrl(assembly?.subtitles?.url);
    const doAssemble = async () => {
        setAssembling(true);
        await production.assemble();
        setAssembling(false);
    };
    const doExport = async () => {
        setExporting(true);
        const result = await production.exportPackage();
        setExporting(false);
        if (result) setExported(true);
    };
    return (
        <StageShell>
            <div className="mb-2 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                <Film className="size-3.5" />
                片段时间线（转场：{assembly?.transition || "cut"}）
                <Tooltip title="片段全部完成后，显式触发 ffmpeg 拼接（已有成片未变更时后端直接复用）">
                    <Button size="small" type="text" className="ml-auto" loading={assembling} icon={<Scissors className="size-3.5" />} onClick={() => void doAssemble()}>
                        {assembly?.status === "done" ? "重新拼接" : "拼接成片"}
                    </Button>
                </Tooltip>
            </div>
            <div className="flex gap-1 overflow-x-auto rounded-lg bg-stone-50 p-2 dark:bg-white/5">
                {ordered.map((clip) => {
                    const index = shotIndexOf.get(clip.shotId || "");
                    const done = clip.status === "done";
                    return (
                        <Tooltip key={clip.id} title={`镜 ${index ?? "?"} · ${clip.durationSec ?? "?"}s · ${clip.status || ""}`}>
                            <div
                                className={cn(
                                    "flex h-14 shrink-0 flex-col justify-between rounded-md border px-2 py-1 text-[10px]",
                                    done
                                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                                        : "border-dashed border-stone-300 text-stone-400 dark:border-stone-700",
                                )}
                                style={{ width: `${Math.max(56, (clip.durationSec || 3) * 26)}px` }}
                            >
                                <span className="font-medium">镜 {index ?? "?"}</span>
                                <span className="tabular-nums">{clip.durationSec ?? "?"}s</span>
                                <span>{done ? "已采用" : clip.status || "未生成"}</span>
                            </div>
                        </Tooltip>
                    );
                })}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[16rem_1fr]">
                <div>
                    {finalUrl ? (
                        <>
                            <video controls preload="metadata" src={finalUrl} className="aspect-[9/16] max-h-80 w-auto rounded-xl bg-black" />
                            <div className="mt-1.5 text-center text-[11px] text-stone-400">
                                成片 · {assembly?.info?.durationSec != null ? `${Math.round(assembly.info.durationSec)}s` : ""}
                                {assembly?.audioMode === "separate_dialogue_track" ? " · 逐段响度归一" : ""}
                            </div>
                        </>
                    ) : (
                        <div className="flex aspect-[9/16] max-h-80 w-52 flex-col items-center justify-center gap-2 rounded-xl bg-stone-100 text-xs text-stone-400 dark:bg-white/5">
                            <Play className="size-6" />
                            {assembly?.status === "assembling" ? "ffmpeg 拼接中…" : "片段齐了之后点「拼接成片」"}
                        </div>
                    )}
                </div>
                <div>
                    <div className="text-xs font-medium uppercase tracking-wider text-stone-500 dark:text-stone-400">导出与交付</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button icon={<Download className="size-3.5" />} href={finalUrl || undefined} download disabled={!finalUrl}>成片 MP4</Button>
                        <Button icon={<FileText className="size-3.5" />} href={subtitleUrl || undefined} download disabled={!subtitleUrl}>字幕 SRT</Button>
                        <Button icon={<FileArchive className="size-3.5" />} loading={exporting} onClick={() => void doExport()}>导出交付包</Button>
                    </div>
                    {exported ? (
                        <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
                            交付包导出已在后台开始（分钟级），完成后可在任务管理里跟踪进度。
                        </div>
                    ) : null}
                    <div className="mt-3 space-y-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                        <div>· 拼接是独立动作：片段全部完成 ≠ 成片已生成。</div>
                        <div>· 响度策略：逐段归一后整体 -16 LUFS，段间差 ≤ 0.1dB（接缝 30ms 淡化）。</div>
                        {assembly?.quality ? <div>· 质检：{assembly.quality.status === "blocked" ? "有阻断项" : "需人工复核"}（{assembly.quality.issues?.length ?? 0} 条）。</div> : null}
                    </div>
                </div>
            </div>
        </StageShell>
    );
}

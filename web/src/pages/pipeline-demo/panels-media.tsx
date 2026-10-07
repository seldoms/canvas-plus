import { Alert, Button, InputNumber, Tag, Tooltip } from "antd";
import { Download, FileArchive, FileText, Film, Mic, Scissors, Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { DemoModelPicker } from "./demo-model-picker";
import { AUDIO_LINES, SHOTS, type MockAudioLine, type StageStatus } from "./mock-data";
import { InlineError, RunningDot, StageShell, StatusBadge } from "./stage-shell";

/* ------------------------------------------------------------------ */
/* 06 配音 —— 逐句生产表：角色/台词/表演/语速/实测时长/轮次/状态。        */
/*    单句重录读 audio[]（修复清单 §4.8）；语速写入 TTS params（§4.9）。 */
/* ------------------------------------------------------------------ */

function shotLabel(shotId: string) {
    const shot = SHOTS.find((item) => item.id === shotId);
    return shot ? `镜 ${shot.index}` : shotId;
}

function AudioLineRow({ line }: { line: MockAudioLine }) {
    const overtime = line.measuredSec != null && line.plannedSec != null && line.measuredSec > line.plannedSec;
    return (
        <div className={cn(
            "grid items-center gap-3 rounded-lg border border-stone-200/70 px-3.5 py-2.5 md:grid-cols-[4rem_4.5rem_1fr_5.5rem_6.5rem_4rem_8.5rem] dark:border-stone-800",
            line.status === "error" && "border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-950/20",
        )}>
            <div className="text-xs tabular-nums text-stone-500 dark:text-stone-400">{shotLabel(line.shotId)}</div>
            <Tag className="mr-0 w-fit">{line.character}</Tag>
            <div className="min-w-0">
                <div className="truncate text-sm text-stone-800 dark:text-stone-200">{line.text}</div>
                <div className="truncate text-xs italic text-stone-400">{line.design}</div>
                {line.status === "error" ? <div className="mt-0.5"><InlineError>实测 {line.measuredSec}s 超出计划 {line.plannedSec}s，已重录 {line.round} 轮仍超时</InlineError></div> : null}
            </div>
            <div className="flex items-center gap-1 text-xs text-stone-500">
                <span>×</span>
                <InputNumber size="small" min={0.5} max={1.5} step={0.05} defaultValue={line.speed} className="w-16" />
            </div>
            <div className={cn("text-xs tabular-nums", overtime ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400")}>
                {line.measuredSec != null ? `${line.measuredSec}s / ${line.plannedSec}s` : "— / " + (line.plannedSec ?? "—") + "s"}
            </div>
            <div className="text-xs tabular-nums text-stone-400">{line.round > 0 ? `第 ${line.round} 轮` : "未生成"}</div>
            <div className="flex items-center justify-end gap-1">
                <StatusBadge status={line.status} />
                {line.status === "running" ? <RunningDot /> : null}
                <Tooltip title="试听最新一轮">
                    <Button size="small" type="text" icon={<Volume2 className="size-3.5" />} disabled={line.status === "pending"} />
                </Tooltip>
                <Tooltip title="单句重录（追加新一轮，保留历史）">
                    <Button size="small" type="text" icon={<Mic className="size-3.5" />} />
                </Tooltip>
            </div>
        </div>
    );
}

export function AudioPanel({ status }: { status: StageStatus }) {
    const failed = AUDIO_LINES.filter((line) => line.status === "error").length;
    return (
        <StageShell
            index={5}
            title="配音"
            status={status}
            modelSlot={
                <span className="text-xs text-stone-500 dark:text-stone-400">音色已在「角色定妆」逐角色配置；此处按句生产</span>
            }
            alerts={
                failed ? (
                    <Alert
                        type="warning"
                        showIcon
                        message={`${failed} 句对白实测时长超出镜头计划时长`}
                        description="可放慢语速、精简台词重录，或回到分镜调整该镜计划时长 —— 修改后影响分析会标出受牵连的片段。"
                    />
                ) : undefined
            }
        >
            <div className="mb-2 hidden gap-3 px-3.5 text-[11px] uppercase tracking-wider text-stone-400 md:grid md:grid-cols-[4rem_4.5rem_1fr_5.5rem_6.5rem_4rem_8.5rem]">
                <span>镜头</span><span>角色</span><span>台词 / 表演</span><span>语速</span><span>实测/计划</span><span>轮次</span><span className="text-right">状态 / 操作</span>
            </div>
            <div className="space-y-2">
                {AUDIO_LINES.map((line) => <AudioLineRow key={line.id} line={line} />)}
            </div>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 07 成片交付 —— 片段时间线（按采用候选）+ 成片预览 + 导出包。           */
/*    clips 全 done ≠ 成片完成：assemble 是独立动作（清单 §2 成片行）。   */
/* ------------------------------------------------------------------ */

export function AssemblyPanel({ status }: { status: StageStatus }) {
    const clips = SHOTS.map((shot, i) => ({ shot, sec: shot.storyboard.durationSec || 3, done: i < 4 }));
    return (
        <StageShell
            index={6}
            title="成片交付"
            status={status}
            modelSlot={<DemoModelPicker domain="video" value="vid_wan22_i2v" />}
        >
            <div className="mb-2 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                <Film className="size-3.5" />
                片段时间线（按采用候选拼接，顺序可在分镜调整）
                <Button size="small" type="text" className="ml-auto" icon={<Scissors className="size-3.5" />}>重新拼接</Button>
            </div>
            <div className="flex gap-1 overflow-x-auto rounded-lg bg-stone-50 p-2 dark:bg-white/5">
                {clips.map(({ shot, sec, done }, i) => (
                    <Tooltip key={shot.id} title={`镜 ${shot.index} · ${sec}s${done ? "" : " · 片段未生成"}`}>
                        <div
                            className={cn(
                                "flex h-14 shrink-0 flex-col justify-between rounded-md border px-2 py-1 text-[10px]",
                                done
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                                    : "border-dashed border-stone-300 text-stone-400 dark:border-stone-700",
                            )}
                            style={{ width: `${Math.max(56, sec * 26)}px` }}
                        >
                            <span className="font-medium">镜 {shot.index}</span>
                            <span className="tabular-nums">{sec}s</span>
                            <span>{done ? "已采用" : `缺片段 ${i + 1}`}</span>
                        </div>
                    </Tooltip>
                ))}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[16rem_1fr]">
                <div>
                    <video
                        controls
                        preload="metadata"
                        poster={`/demo-assets/${encodeURIComponent("喜宴之外_封面.jpg")}`}
                        src={`/demo-assets/${encodeURIComponent("喜宴之外_第1集_试片_v1.mp4")}`}
                        className="aspect-[9/16] max-h-80 w-auto rounded-xl bg-black"
                    />
                    <div className="mt-1.5 text-center text-[11px] text-stone-400">第 1 集成片 · 20.3s · 768×1344 · -16.2 LUFS</div>
                </div>
                <div>
                    <div className="text-xs font-medium uppercase tracking-wider text-stone-500 dark:text-stone-400">导出与交付（按集或全部集）</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button icon={<Download className="size-3.5" />} href={`/demo-assets/${encodeURIComponent("喜宴之外_第1集_试片_v1.mp4")}`} download>成片 MP4</Button>
                        <Button icon={<FileText className="size-3.5" />} href={`/demo-assets/${encodeURIComponent("喜宴之外_第1集_字幕.srt")}`} download>字幕 SRT</Button>
                        <Button icon={<Scissors className="size-3.5" />}>FCPXML / EDL</Button>
                        <Button icon={<FileArchive className="size-3.5" />}>素材包 ZIP</Button>
                    </div>
                    <div className="mt-3 space-y-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                        <div>· 拼接与导出是独立动作：片段全部完成 ≠ 成片已生成，需显式「重新拼接」。</div>
                        <div>· 导出包内含 manifest，逐文件可通过 artifacts 路径单独读取。</div>
                        <div>· 响度：逐段归一化后整体 -16 LUFS，段间差 ≤ 0.1dB（接缝 30ms 淡化）。</div>
                    </div>
                </div>
            </div>
        </StageShell>
    );
}

import { Button, Empty, Tabs, Tag, Tooltip } from "antd";
import { Check, Play, RefreshCw, Volume2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { previewTtsVoice } from "@/services/api/tts";

import { StageShell } from "./stage-shell";
import type {
    CastingStageOutput,
    DesignOutput,
    KeyframeFrame,
    KeyframeOutput,
    ScriptOutput,
    StoryboardOutput,
} from "./stage-types";
import { itemStatusTone, stageOutput } from "./stage-types";
import { toneDot } from "./panels-story";
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

/** 真实产物缩略图（定妆照 / 关键帧候选）。 */
function ArtifactThumb({ url, label, selected, small, tall }: { url?: string; label?: string; selected?: boolean; small?: boolean; tall?: boolean }) {
    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg bg-stone-100 dark:bg-white/5",
                tall ? "aspect-[9/16] w-full" : small ? "h-24 w-16" : "h-32 w-24",
                selected ? "ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-stone-950" : "ring-1 ring-black/10 dark:ring-white/15",
            )}
        >
            {url ? (
                <img src={url} alt={label || ""} className="size-full object-cover object-top" loading="lazy" />
            ) : (
                <div className="flex size-full items-center justify-center text-[10px] text-stone-400">未产出</div>
            )}
            {label ? <span className="absolute bottom-0 left-0 bg-black/45 px-1.5 py-0.5 text-[10px] leading-tight text-white/90">{label}</span> : null}
            {selected ? (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="size-2.5" />
                </span>
            ) : null}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 03 服化道 —— 真实文字设定（角色/场景）+ 参考图提示词；                  */
/*    设定与参考图分属文本/图像两类能力，重生成走阶段级续跑。              */
/* ------------------------------------------------------------------ */

export function DesignPanel({ production }: { production: Production }) {
    const design = stageOutput<DesignOutput>(production.run, "design");
    if (!production.run || !design) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="design" hint="本执行记录还没有服化道产物：分镜完成后运行本阶段" />
            </StageShell>
        );
    }
    const characters = design.characters ?? [];
    const locations = design.locations ?? [];
    const references = design.references ?? [];
    const propsOf = (id: string) => characters.find((c) => c.id === id)?.props ?? [];
    const allProps = [...new Set(characters.flatMap((c) => c.props ?? []))];
    void propsOf;
    return (
        <StageShell>
            <Tabs
                size="small"
                items={[
                    {
                        key: "characters",
                        label: `角色（${characters.length}）`,
                        children: (
                            <div className="grid gap-3 lg:grid-cols-2">
                                {characters.map((c) => (
                                    <div key={c.id} className="rounded-lg border border-stone-200/80 p-3.5 dark:border-stone-800">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{c.name || c.id}</span>
                                            {c.palette ? (
                                                <span className="ml-auto flex gap-1">
                                                    {c.palette.split(",").map((color) => (
                                                        <span key={color} className="size-3.5 rounded-full ring-1 ring-black/10 dark:ring-white/20" style={{ background: color.trim() }} title={color.trim()} />
                                                    ))}
                                                </span>
                                            ) : null}
                                        </div>
                                        <dl className="mt-2 space-y-1.5 text-xs leading-5">
                                            {c.outfit ? <div><dt className="inline font-medium text-stone-500 dark:text-stone-400">服装：</dt><dd className="inline text-stone-700 dark:text-stone-300">{c.outfit}</dd></div> : null}
                                            {c.hair ? <div><dt className="inline font-medium text-stone-500 dark:text-stone-400">发型：</dt><dd className="inline text-stone-700 dark:text-stone-300">{c.hair}</dd></div> : null}
                                            {c.makeup ? <div><dt className="inline font-medium text-stone-500 dark:text-stone-400">妆容：</dt><dd className="inline text-stone-700 dark:text-stone-300">{c.makeup}</dd></div> : null}
                                            {c.props?.length ? (
                                                <div>
                                                    <dt className="inline font-medium text-stone-500 dark:text-stone-400">道具：</dt>
                                                    <dd className="inline">{c.props.map((p) => <Tag key={p} className="mr-1 text-[10px]">{p}</Tag>)}</dd>
                                                </div>
                                            ) : null}
                                        </dl>
                                    </div>
                                ))}
                            </div>
                        ),
                    },
                    {
                        key: "locations",
                        label: `场景（${locations.length}）`,
                        children: (
                            <div className="grid gap-3 lg:grid-cols-2">
                                {locations.map((loc) => (
                                    <div key={loc.id} className="rounded-lg border border-stone-200/80 p-3.5 dark:border-stone-800">
                                        <div className="text-sm font-medium text-stone-800 dark:text-stone-200">{loc.name || loc.id}</div>
                                        {loc.setDressing ? <p className="mt-1.5 text-xs leading-5 text-stone-600 dark:text-stone-300">{loc.setDressing}</p> : null}
                                        {loc.lighting ? <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">灯光：{loc.lighting}</p> : null}
                                    </div>
                                ))}
                            </div>
                        ),
                    },
                    {
                        key: "references",
                        label: `参考图提示词（${references.length}）`,
                        children: (
                            <div className="space-y-2">
                                {references.map((ref) => (
                                    <div key={ref.id} className="rounded-lg border border-stone-200/70 px-3.5 py-2.5 dark:border-stone-800">
                                        <div className="flex items-center gap-2 text-xs">
                                            <Tag className="mr-0">{ref.role === "character" ? "角色" : ref.role === "location" ? "场景" : ref.role || "参考"}</Tag>
                                            <span className="font-medium text-stone-700 dark:text-stone-300">{ref.name || ref.bindingId || ref.id}</span>
                                            <span className="text-stone-400">{ref.kind}</span>
                                        </div>
                                        {ref.prompt ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-stone-500 dark:text-stone-400">{ref.prompt}</p> : null}
                                    </div>
                                ))}
                            </div>
                        ),
                    },
                ]}
            />
            <p className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">
                文字设定由本阶段文本模型生成，参考图由图像模板生成；要更新设定用上方「重跑」，要补单项参考图在「角色定妆」里逐项处理。
            </p>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 04 角色定妆 —— 真实定妆照 / 音色 / 试听 / 脸声双确认（确认即解下游阻断） */
/* ------------------------------------------------------------------ */

function CastingCard({ production, character }: { production: Production; character: NonNullable<CastingStageOutput["characters"]>[number] }) {
    const [auditioning, setAuditioning] = useState(false);
    const [confirming, setConfirming] = useState<"" | "face" | "voice">("");
    const face = character.face ?? {};
    const voice = character.voice ?? {};
    const faceUrl = production.artifactUrl(face.closeupArtifactId);

    const audition = async () => {
        if (!voice.speaker) return;
        setAuditioning(true);
        try {
            const result = await previewTtsVoice({
                speaker: voice.speaker,
                design: voice.design,
                language: voice.language,
                speed: voice.speed,
                text: "你好，我们终于见面了。",
            });
            const url = production.artifactUrl(result.url);
            if (url) void new Audio(url).play().catch(() => undefined);
        } catch {
            /* 试听失败不阻断页面；错误已在面板顶部 error 条之外静默 */
        } finally {
            setAuditioning(false);
        }
    };

    const confirm = async (scope: "face" | "voice") => {
        setConfirming(scope);
        await production.confirmCasting({ characterId: character.characterId, [scope]: true });
        setConfirming("");
    };

    return (
        <div className="rounded-lg border border-stone-200/80 p-3.5 dark:border-stone-800">
            <div className="flex gap-3">
                <ArtifactThumb url={faceUrl} label={face.confirmed ? "定妆照" : "候选"} selected={Boolean(face.confirmed)} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{character.name || character.characterId}</span>
                        <Tag color={face.confirmed ? "success" : "default"} className="mr-0">脸{face.confirmed ? "已确认" : "待确认"}</Tag>
                    </div>
                    {face.turnaroundArtifactIds?.length ? (
                        <div className="mt-2 flex gap-1.5">
                            {face.turnaroundArtifactIds.slice(0, 3).map((id, i) => (
                                <ArtifactThumb key={id} small url={production.artifactUrl(id)} label={`三视图 ${i + 1}`} />
                            ))}
                        </div>
                    ) : null}
                    {!face.confirmed ? (
                        <Button size="small" className="mt-2" loading={confirming === "face"} disabled={!faceUrl} onClick={() => void confirm("face")}>
                            确认这张脸
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="mt-3 space-y-2 rounded-lg bg-stone-50 p-2.5 dark:bg-white/5">
                <div className="flex items-center gap-2">
                    <Tag className="mr-0">{voice.speaker || "未选音色"}</Tag>
                    {voice.language ? <Tag className="mr-0">{voice.language}</Tag> : null}
                    {voice.speed && voice.speed !== 1 ? <Tag className="mr-0">×{voice.speed}</Tag> : null}
                    <Tooltip title={voice.previewArtifactId ? "播放定妆时的试听样本" : "用当前音色现场生成一句试听"}>
                        <Button
                            size="small"
                            type="text"
                            loading={auditioning}
                            icon={voice.previewArtifactId ? <Play className="size-3.5" /> : <Volume2 className="size-3.5" />}
                            onClick={() => {
                                if (voice.previewArtifactId) {
                                    void new Audio(production.artifactUrl(voice.previewArtifactId)).play().catch(() => undefined);
                                } else {
                                    void audition();
                                }
                            }}
                        >
                            试听
                        </Button>
                    </Tooltip>
                    <Tag color={voice.confirmed ? "success" : "warning"} className="ml-auto mr-0">声{voice.confirmed ? "已确认" : "待确认"}</Tag>
                </div>
                {voice.design ? <div className="text-xs italic text-stone-500 dark:text-stone-400">“{voice.design}”</div> : null}
                {!voice.confirmed && voice.speaker ? (
                    <Button size="small" loading={confirming === "voice"} onClick={() => void confirm("voice")}>
                        确认这个声音
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

export function CastingPanel({ production }: { production: Production }) {
    const casting = stageOutput<CastingStageOutput>(production.run, "casting");
    if (!production.run || !casting) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="casting" hint="本执行记录还没有定妆产物：服化道完成后运行本阶段" />
            </StageShell>
        );
    }
    const characters = casting.characters ?? [];
    const unconfirmed = characters.filter((c) => !c.face?.confirmed || !c.voice?.confirmed);
    return (
        <StageShell
            alerts={
                unconfirmed.length ? (
                    <div className="rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-300">
                        {unconfirmed.map((c) => c.name || c.characterId).join("、")} 尚未完成脸/声确认 —— 确认后关键帧与配音的定妆阻断自动解除。
                    </div>
                ) : undefined
            }
        >
            <div className="mb-3 text-xs text-stone-500 dark:text-stone-400">
                音色来自平台音色库，试听即调即播；确认写入定妆身份卡（确认后再修改会升版本号）。
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {characters.map((c) => <CastingCard key={c.characterId} production={production} character={c} />)}
            </div>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 05 关键帧 —— 真实候选图（起/尾帧），逐项重跑接 regenerate；            */
/*    采用新候选由后端自动生成即选中（selected 指向最新）。               */
/* ------------------------------------------------------------------ */

const ROLE_LABEL: Record<string, string> = { start: "起始帧", mid: "关键帧", end: "尾帧" };

function FrameCell({ production, frame }: { production: Production; frame?: KeyframeFrame }) {
    const [redoing, setRedoing] = useState(false);
    if (!frame) {
        return (
            <div className="rounded-lg bg-stone-50 p-2 dark:bg-white/5">
                <div className="mx-auto max-w-36">
                    <ArtifactThumb tall label="无此帧" />
                </div>
            </div>
        );
    }
    const redo = async () => {
        setRedoing(true);
        await production.regenerateItem("keyframe", frame.id);
        setRedoing(false);
    };
    return (
        <div className="rounded-lg bg-stone-50 p-2 dark:bg-white/5">
            <div className="mb-1.5 flex items-center text-[11px] text-stone-500 dark:text-stone-400">
                <span className={cn("mr-1 inline-block size-1.5 rounded-full", toneDot(itemStatusTone(frame.status)))} />
                {ROLE_LABEL[frame.role || ""] || frame.role || "帧"}
                <span className="ml-1 text-stone-400">{frame.status === "done" ? "" : frame.status || ""}</span>
                <Tooltip title="换模型再出一张（新候选自动成为当前选中）">
                    <Button size="small" type="text" className="ml-auto -mr-1 h-5 px-1" loading={redoing} icon={<RefreshCw className="size-3" />} onClick={() => void redo()}>
                        <span className="text-[11px]">重跑</span>
                    </Button>
                </Tooltip>
            </div>
            <Tooltip title={frame.prompt ? `${frame.prompt.slice(0, 220)}…` : ""} placement="bottom">
                <div className="mx-auto max-w-36">
                    <ArtifactThumb tall url={production.artifactUrl(frame.artifactUrl)} selected={frame.status === "done"} label={frame.status === "done" ? "已采用" : frame.status} />
                </div>
            </Tooltip>
            {frame.candidates && frame.candidates.length > 1 ? (
                <div className="mt-1.5 flex gap-1">
                    {frame.candidates.slice(0, 4).map((cand, i) => (
                        <Tooltip key={cand.jobId || i} title={`${cand.template || "候选"} · ${cand.status || ""}`}>
                            <img
                                src={production.artifactUrl(cand.artifactUrl)}
                                alt=""
                                className={cn("h-10 w-7 rounded object-cover ring-1", cand.artifactUrl === frame.artifactUrl ? "ring-2 ring-emerald-500" : "ring-black/10 dark:ring-white/15")}
                                loading="lazy"
                            />
                        </Tooltip>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function KeyframePanel({ production }: { production: Production }) {
    const keyframes = stageOutput<KeyframeOutput>(production.run, "keyframe");
    const board = stageOutput<StoryboardOutput>(production.run, "storyboard");
    const script = stageOutput<ScriptOutput>(production.run, "script");
    if (!production.run || !keyframes) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="keyframe" hint="本执行记录还没有关键帧产物：定妆确认后运行本阶段" />
            </StageShell>
        );
    }
    const frames = keyframes.frames ?? [];
    const shotById = new Map((board?.shots ?? []).map((s) => [s.id, s]));
    const characterNameOf = new Map((script?.characters ?? []).map((c) => [c.id, c.name]));
    void characterNameOf;
    /** 按镜头分组：shotId → { start?, mid?, end? } */
    const byShot = new Map<string, Map<string, KeyframeFrame>>();
    for (const frame of frames) {
        const shotId = frame.shotId || "_";
        if (!byShot.has(shotId)) byShot.set(shotId, new Map());
        byShot.get(shotId)!.set(frame.role || "start", frame);
    }
    const shotIds = [...byShot.keys()].sort((a, b) => (shotById.get(a)?.index ?? 0) - (shotById.get(b)?.index ?? 0));
    return (
        <StageShell>
            <div className="space-y-3">
                {shotIds.map((shotId) => {
                    const shot = shotById.get(shotId);
                    const slots = byShot.get(shotId)!;
                    return (
                        <div key={shotId} className="grid gap-3 rounded-lg border border-stone-200/70 px-3.5 py-3 lg:grid-cols-[11rem_1fr] dark:border-stone-800">
                            <div className="text-xs">
                                <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">镜 {shot?.index ?? "?"} · {shot?.shotSize || ""}</div>
                                <div className="mt-1 line-clamp-3 leading-5 text-stone-500 dark:text-stone-400">{shot?.action}</div>
                                {shot?.dialogue ? <div className="mt-1 line-clamp-2 border-l-2 border-amber-300 pl-2 italic leading-5 text-stone-500 dark:text-stone-400">{shot.dialogue}</div> : null}
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3">
                                {(["start", "mid", "end"] as const).map((role) => (
                                    <div key={role}>
                                        <FrameCell production={production} frame={slots.get(role)} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </StageShell>
    );
}

import { Button, Input, Select, Slider, Tabs, Tag, Tooltip } from "antd";
import { Check, ImagePlus, RefreshCw, Volume2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { CHARACTERS, SHOTS, type MockCharacter } from "./mock-data";
import { InlineError, StageShell } from "./stage-shell";

/** 真实定妆照缩略图（demo 用，真实环境是 artifact 缩略图） */
function PhotoThumb({ name, label, selected, small }: { name: string; label?: string; selected?: boolean; small?: boolean }) {
    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg bg-stone-100 dark:bg-white/5",
                small ? "h-24 w-16" : "h-32 w-24",
                selected ? "ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-stone-950" : "ring-1 ring-black/10 dark:ring-white/15",
            )}
        >
            <img src={`/demo-assets/cast/${encodeURIComponent(name)}.png`} alt={name} className="size-full object-cover object-top" loading="lazy" />
            {label ? <span className="absolute bottom-0 left-0 bg-black/45 px-1.5 py-0.5 text-[10px] leading-tight text-white/90">{label}</span> : null}
            {selected ? (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="size-2.5" />
                </span>
            ) : null}
        </div>
    );
}

/** 渐变占位图（demo 用，真实环境是 artifact 缩略图） */
function Thumb({ label, gradient, selected, small }: { label: string; gradient: string; selected?: boolean; small?: boolean }) {
    return (
        <div
            className={cn(
                "relative flex items-end justify-start overflow-hidden rounded-lg bg-gradient-to-br",
                gradient,
                small ? "h-24 w-16" : "h-32 w-24",
                selected ? "ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-stone-950" : "ring-1 ring-black/10 dark:ring-white/15",
            )}
        >
            <span className="p-1.5 text-[10px] leading-tight text-white/90">{label}</span>
            {selected ? (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="size-2.5" />
                </span>
            ) : null}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* 03 服化道 —— 两类能力配对：文字设定(LLM) + 参考图(图像模板)，          */
/*    各自绑定模型与生成入口（清单 §2 服化道行 / §4.6）。                 */
/* ------------------------------------------------------------------ */

function DesignCharacterCard({ character }: { character: MockCharacter }) {
    return (
        <div className="rounded-lg border border-stone-200/80 p-3.5 dark:border-stone-800">
            <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{character.name}</span>
                <span className="text-xs text-stone-500 dark:text-stone-400">{character.tagline}</span>
                <Button size="small" type="text" className="ml-auto" icon={<RefreshCw className="size-3.5" />}>重生成设定</Button>
            </div>
            <Input.TextArea
                size="small"
                autoSize={{ minRows: 2, maxRows: 4 }}
                defaultValue={`${character.name}，${character.tagline}。电影感写实，中国现代都市家庭伦理短剧，竖屏 9:16，中性灰摄影棚背景，画面只出现一个人物。`}
                className="mt-2 text-xs leading-5 text-stone-600"
            />
            <div className="mt-3 flex items-start gap-2">
                <PhotoThumb small name={character.name} label="候选 1 · 已采用" selected />
                {[1, 2].map((i) => (
                    <Thumb key={i} small label={`候选 ${i + 1}`} gradient={character.gradient} />
                ))}
                <div className="flex flex-col gap-1.5 self-center">
                    <Button size="small" icon={<ImagePlus className="size-3.5" />}>再出一张</Button>
                </div>
            </div>
        </div>
    );
}

export function DesignPanel() {
    return (
        <StageShell>
            <Tabs
                size="small"
                items={[
                    {
                        key: "characters",
                        label: `角色（${CHARACTERS.length}）`,
                        children: (
                            <div className="grid gap-3 lg:grid-cols-2">
                                {CHARACTERS.slice(0, 4).map((c) => <DesignCharacterCard key={c.id} character={c} />)}
                            </div>
                        ),
                    },
                    {
                        key: "locations",
                        label: "场景（5）",
                        children: (
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {["酒店宴会厅·外廊", "宴会厅·主桌区", "酒店后厨通道", "新娘化妆间", "酒店大堂"].map((name, i) => (
                                    <div key={name} className="rounded-lg border border-stone-200/80 p-3 dark:border-stone-800">
                                        <div className="text-sm font-medium text-stone-800 dark:text-stone-200">{name}</div>
                                        <div className="mt-2 flex gap-2">
                                            <Thumb small label="母版" gradient={["from-red-900 to-amber-700", "from-stone-700 to-stone-500", "from-slate-800 to-slate-600", "from-rose-800 to-rose-500", "from-amber-800 to-amber-600"][i]} selected />
                                            <Thumb small label="候选 2" gradient="from-stone-600 to-stone-400" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ),
                    },
                    {
                        key: "props",
                        label: "道具（3）",
                        children: (
                            <div className="flex flex-wrap gap-2">
                                {["旧围裙", "桌牌", "红包"].map((name) => <Tag key={name} className="mr-0 px-2.5 py-1">{name} · 已建档</Tag>)}
                            </div>
                        ),
                    },
                ]}
            />
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 04 角色定妆 —— 不选 LLM（清单 §2 定妆行）。音色来自音色库，           */
/*    脸/声分别确认；未确认的角色在关键帧阶段构成门禁。                   */
/* ------------------------------------------------------------------ */

function CastingCard({ character }: { character: MockCharacter }) {
    const [speed, setSpeed] = useState(character.voice.speed);
    return (
        <div className="rounded-lg border border-stone-200/80 p-3.5 dark:border-stone-800">
            <div className="flex gap-3">
                <PhotoThumb name={character.name} label={character.faceConfirmed ? "定妆照" : "候选"} selected={character.faceConfirmed} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{character.name}</span>
                        <Tooltip title={character.faceConfirmed ? "脸已确认" : "脸待确认"}>
                            <Tag color={character.faceConfirmed ? "success" : "default"} className="mr-0">
                                脸{character.faceConfirmed ? "已确认" : "待确认"}
                            </Tag>
                        </Tooltip>
                    </div>
                    <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{character.tagline}</div>
                    {!character.faceConfirmed ? <div className="mt-1"><InlineError>定妆照未采用，关键帧将被阻断</InlineError></div> : null}
                </div>
            </div>
            <div className="mt-3 space-y-2 rounded-lg bg-stone-50 p-2.5 dark:bg-white/5">
                <div className="flex items-center gap-2">
                    <Select
                        size="small"
                        defaultValue={character.voice.speaker}
                        className="min-w-32"
                        options={["云野", "晓萱", "祖母", "铁军", "桂枝", "童声·糖糖", "晓雪", "阿灿"].map((v) => ({ value: v, label: v }))}
                    />
                    <Tag className="mr-0">{character.voice.language}</Tag>
                    <Button size="small" type="text" icon={<Volume2 className="size-3.5" />}>试听</Button>
                    <Tooltip title={character.voiceConfirmed ? "声音已确认" : "声音待确认"}>
                        <Tag color={character.voiceConfirmed ? "success" : "warning"} className="ml-auto mr-0">
                            声{character.voiceConfirmed ? "已确认" : "待确认"}
                        </Tag>
                    </Tooltip>
                </div>
                <div className="text-xs italic text-stone-500 dark:text-stone-400">“{character.voice.design}”</div>
                <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                    <span>语速</span>
                    <Slider className="flex-1" min={0.5} max={1.5} step={0.05} value={speed} onChange={setSpeed} />
                    <span className="w-9 tabular-nums">×{speed.toFixed(2)}</span>
                </div>
            </div>
        </div>
    );
}

export function CastingPanel() {
    const unconfirmed = CHARACTERS.filter((c) => !c.faceConfirmed || !c.voiceConfirmed);
    return (
        <StageShell
            alerts={
                unconfirmed.length ? (
                    <div className="rounded-lg border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-300">
                        {unconfirmed.map((c) => c.name).join("、")} 尚未完成脸/声确认 —— 确认写入定妆身份卡后，关键帧与配音才能引用。
                    </div>
                ) : undefined
            }
        >
            <div className="mb-3 text-xs text-stone-500 dark:text-stone-400">
                音色来自音色库（GET /api/tts/voices），试听走 POST /api/tts/preview；本阶段不消费文本模型，不提供模型选择。
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {CHARACTERS.slice(0, 6).map((c) => <CastingCard key={c.id} character={c} />)}
            </div>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 05 关键帧 —— 每镜起/关键/尾帧候选条，逐项重跑、采用；                  */
/*    采用写项目槽位，与 run 条目采用保持一致（清单 §4.11）。             */
/* ------------------------------------------------------------------ */

const SLOT_LABELS = ["起始帧", "关键帧", "尾帧"] as const;

export function KeyframePanel() {
    return (
        <StageShell>
            <div className="space-y-3">
                {SHOTS.slice(0, 4).map((shot) => (
                    <div key={shot.id} className="grid gap-3 rounded-lg border border-stone-200/70 px-3.5 py-3 lg:grid-cols-[11rem_1fr] dark:border-stone-800">
                        <div className="text-xs">
                            <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">镜 {shot.index} · {shot.storyboard.shotSize}</div>
                            <div className="mt-1 line-clamp-3 leading-5 text-stone-500 dark:text-stone-400">{shot.storyboard.action}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {(shot.storyboard.characters || []).map((name) => <Tag key={name} className="mr-0 text-[10px]">{name}</Tag>)}
                            </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-3">
                            {SLOT_LABELS.map((slot, slotIndex) => (
                                <div key={slot} className="rounded-lg bg-stone-50 p-2 dark:bg-white/5">
                                    <div className="mb-1.5 flex items-center text-[11px] text-stone-500 dark:text-stone-400">
                                        {slot}
                                        <Button size="small" type="text" className="ml-auto -mr-1 h-5 px-1" icon={<RefreshCw className="size-3" />}>
                                            <span className="text-[11px]">重跑</span>
                                        </Button>
                                    </div>
                                    <div className="flex gap-1.5">
                                        {[0, 1].map((i) => (
                                            <Thumb key={i} small label={`${slotIndex + 1}-${i + 1}`} gradient={["from-stone-700 to-stone-500", "from-amber-800 to-amber-600", "from-slate-700 to-slate-500"][slotIndex]} selected={i === 0} />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </StageShell>
    );
}

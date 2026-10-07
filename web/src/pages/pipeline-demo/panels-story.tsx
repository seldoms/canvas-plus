import { Button, Input, Select, Tabs, Tag, Tooltip } from "antd";
import { ChevronDown, ChevronUp, MapPin, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { CHARACTERS, EPISODES, MODEL_GROUPS, SCENES, SHOTS, type MockShot } from "./mock-data";
import { PanelSection, StageShell } from "./stage-shell";
import type { StageStatus } from "./mock-data";

/* ------------------------------------------------------------------ */
/* 01 剧本                                                             */
/* ------------------------------------------------------------------ */

const SCRIPT_EP1 = `陈默的婚礼在一家老牌酒店举行。宾客盈门，红色喜字映在玻璃门上。

林慧的母亲林娟坚持把亲戚都安排在靠主桌的位置，外婆的桌牌被挪到了宴会厅最远的角落。陈默发现后没有声张，先扶着外婆穿过人群。

"慢点走，不着急，让他们先忙。"外婆说。

仪式开始前，陈默走到林慧身边，压低声音问："外婆的座位怎么在那边？"`;

export function ScriptPanel({ status }: { status: StageStatus }) {
    const [editing, setEditing] = useState(false);
    return (
        <StageShell
            index={0}
            title="剧本"
            status={status}
            modelSlot={
                <Select size="small" className="min-w-52" defaultValue={MODEL_GROUPS.text[0]} options={MODEL_GROUPS.text.map((m) => ({ value: m, label: m }))} />
            }
        >
            <PanelSection title="主线">
                <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700 dark:bg-white/5 dark:text-stone-300">
                    一场婚礼上，新郎陈默发现外婆被安排在角落。他没有当场争执，而是在喧嚣中做了一个安静的决定。
                </p>
            </PanelSection>
            <PanelSection title={`人物（${CHARACTERS.length}）`} extra={<Users className="size-3.5 text-stone-400" />}>
                <div className="flex flex-wrap gap-1.5">
                    {CHARACTERS.map((c) => (
                        <Tag key={c.id} className="mr-0">{c.name} · {c.tagline}</Tag>
                    ))}
                </div>
            </PanelSection>
            <PanelSection
                title="分集剧本"
                extra={
                    <Button size="small" type="text" className="ml-auto" onClick={() => setEditing(!editing)}>
                        {editing ? "完成" : "编辑"}
                    </Button>
                }
            >
                <Tabs
                    size="small"
                    items={EPISODES.map((ep, i) => ({
                        key: ep.id,
                        label: `第 ${ep.index} 集 · ${ep.title}`,
                        children: (
                            <div>
                                <div className="mb-2 text-xs text-stone-500 dark:text-stone-400">{ep.logline}</div>
                                {editing && i === 0 ? (
                                    <Input.TextArea rows={8} defaultValue={SCRIPT_EP1} className="text-sm leading-6" />
                                ) : (
                                    <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200/70 px-4 py-3 text-sm leading-7 text-stone-700 dark:border-stone-800 dark:text-stone-300">
                                        {i === 0 ? SCRIPT_EP1 : "（本集剧本待生成）"}
                                    </div>
                                )}
                            </div>
                        ),
                    }))}
                />
            </PanelSection>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 02 分镜 —— 镜头按后端现行「集级扁平 shots[]」存储，前端按 sceneId    */
/*    归位到场（复用 useStoryboard 的归位逻辑，修复清单 §4.4）。         */
/* ------------------------------------------------------------------ */

function shotsByScene(sceneId: string): MockShot[] {
    // 真实实现：优先 scene.shots，为空时把 episode.shots 按 sceneId 分组归位 —— demo 数据直接模拟归位结果
    return SHOTS.filter((shot) => shot.sceneId === sceneId).sort((a, b) => a.index - b.index);
}

/** 镜头行：片场镜头表排版 —— 大字镜号 + 状态点起行，景别/运镜是淡 chips，
 *  动作一行、对白作引用块，时长与调序收在右侧，不放成堆的输入框。 */
function ShotRow({ shot, first, last }: { shot: MockShot; first: boolean; last: boolean }) {
    const board = shot.storyboard;
    const statusDot =
        shot.status === "done" ? "bg-emerald-400" : shot.status === "partial" ? "bg-orange-400" : "bg-stone-300 dark:bg-stone-600";
    return (
        <div className="group rounded-lg border border-stone-200/70 px-4 py-3 transition hover:bg-stone-50/60 dark:border-stone-800 dark:hover:bg-white/[0.03]">
            {/* 第一行：镜号 / 景别·运镜 / 动作 / 时长 / 调序 */}
            <div className="flex items-center gap-3">
                <span className="flex w-10 shrink-0 items-baseline gap-1">
                    <span className={cn("size-1.5 rounded-full", statusDot)} />
                    <span className="text-lg font-semibold tabular-nums text-stone-300 dark:text-stone-600">{String(shot.index).padStart(2, "0")}</span>
                </span>
                <Select
                    size="small"
                    variant="borderless"
                    defaultValue={board.shotSize}
                    className="-ml-2 w-20 font-medium"
                    options={["远景", "全景", "中景", "近景", "特写"].map((v) => ({ value: v, label: v }))}
                />
                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500 dark:bg-white/10 dark:text-stone-400">{board.camera || "固定"}</span>
                <Input
                    size="small"
                    variant="borderless"
                    defaultValue={board.action}
                    placeholder="动作描述"
                    className="min-w-0 flex-1 px-1 text-[13px]"
                />
                <span className="flex shrink-0 items-center text-xs tabular-nums text-stone-400">
                    <Input size="small" variant="borderless" defaultValue={board.durationSec} className="w-9 px-0 text-right text-xs" />
                    s
                </span>
                <span className="flex shrink-0 flex-col opacity-0 transition group-hover:opacity-100">
                    <Button size="small" type="text" disabled={first} icon={<ChevronUp className="size-3" />} className="h-4" />
                    <Button size="small" type="text" disabled={last} icon={<ChevronDown className="size-3" />} className="h-4" />
                </span>
            </div>
            {/* 第二行：背景 + 对白引用块（无对白则不占行） */}
            <div className="mt-1.5 flex items-start gap-3 pl-11">
                <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[11px] text-stone-400">
                    <MapPin className="size-3" />
                    {board.background || "背景待定"}
                </span>
                <Input.TextArea
                    size="small"
                    variant="borderless"
                    autoSize
                    defaultValue={board.dialogue}
                    placeholder="对白（可空）"
                    className="min-w-0 flex-1 border-l-2 border-stone-200 px-2.5 text-xs italic leading-5 text-stone-500 dark:border-stone-700 dark:text-stone-400"
                />
            </div>
        </div>
    );
}

export function StoryboardPanel({ status }: { status: StageStatus }) {
    const [episodeId, setEpisodeId] = useState(EPISODES[0].id);
    const episode = EPISODES.find((ep) => ep.id === episodeId)!;
    const totalShots = useMemo(() => SCENES.reduce((n, sc) => n + shotsByScene(sc.id).length, 0), []);
    return (
        <StageShell
            index={1}
            title="分镜"
            status={status}
            modelSlot={
                <Select size="small" className="min-w-52" defaultValue={MODEL_GROUPS.text[0]} options={MODEL_GROUPS.text.map((m) => ({ value: m, label: m }))} />
            }
        >
            <div className="grid gap-4 lg:grid-cols-[180px_1fr]">
                {/* 左列：集导航（与项目分镜工作区同一语言） */}
                <aside className="max-h-[68vh] space-y-1 overflow-y-auto lg:border-r lg:border-stone-200/60 lg:pr-3 dark:lg:border-stone-800/60">
                    {EPISODES.map((ep) => (
                        <button
                            key={ep.id}
                            type="button"
                            onClick={() => setEpisodeId(ep.id)}
                            className={cn(
                                "w-full rounded-lg px-3 py-2 text-left text-sm transition hover:bg-black/5 dark:hover:bg-white/10",
                                ep.id === episodeId && "bg-black/5 font-medium dark:bg-white/10",
                            )}
                        >
                            <span className="tabular-nums text-stone-400">第 {ep.index} 集</span>
                            <span className="ml-1.5 text-stone-800 dark:text-stone-200">{ep.title}</span>
                        </button>
                    ))}
                    <Button size="small" type="dashed" block icon={<Plus className="size-3.5" />} className="mt-2">新建集</Button>
                </aside>

                {/* 右列：场 sticky 头 + 镜头行 */}
                <div className="min-w-0">
                    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 text-sm">
                        <span className="font-medium text-stone-900 dark:text-stone-100">第 {episode.index} 集 · {episode.title}</span>
                        <span className="text-xs text-stone-500 dark:text-stone-400">{episode.logline}</span>
                        <span className="ml-auto text-xs tabular-nums text-stone-400">{SCENES.length} 场 · {totalShots} 镜</span>
                    </div>
                    <div className="space-y-4">
                        {SCENES.map((scene) => {
                            const shots = shotsByScene(scene.id);
                            return (
                                <div key={scene.id}>
                                    <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200/70 bg-stone-50/95 px-3 py-2 backdrop-blur dark:border-stone-800 dark:bg-stone-900/90">
                                        <Tag color="default" className="mr-0">场 {scene.index}</Tag>
                                        <span className="text-xs font-medium text-stone-700 dark:text-stone-300">{scene.locationId} · {scene.time}</span>
                                        <span className="truncate text-xs text-stone-400">{scene.intent}</span>
                                        <span className="ml-auto text-xs tabular-nums text-stone-400">{shots.length} 镜</span>
                                    </div>
                                    <div className="space-y-2">
                                        {shots.map((shot, i) => (
                                            <ShotRow key={shot.id} shot={shot} first={i === 0} last={i === shots.length - 1} />
                                        ))}
                                        <Button size="small" type="dashed" icon={<Plus className="size-3.5" />}>新增镜头</Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="mt-3 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-xs leading-5 text-stone-500 dark:border-stone-700 dark:text-stone-400">
                        编辑语义：此处修改写入<b>项目镜头</b>（PATCH /api/projects/:id/shots/:shotId），保存后「影响分析」标出需重做的关键帧/配音/片段；run 内分镜定点编辑仍可用，两处修改以影响分析对齐（清单 §4.10）。
                    </div>
                </div>
            </div>
        </StageShell>
    );
}

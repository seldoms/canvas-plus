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

function ShotRow({ shot, first, last }: { shot: MockShot; first: boolean; last: boolean }) {
    const board = shot.storyboard;
    const statusColor =
        shot.status === "done" ? "border-l-emerald-400" : shot.status === "partial" ? "border-l-orange-400" : "border-l-stone-200 dark:border-l-stone-700";
    return (
        <div className={cn("grid gap-3 rounded-lg border border-stone-200/70 border-l-4 bg-white px-3.5 py-3 md:grid-cols-[3.5rem_9rem_1fr_1.2fr_4.5rem_2rem]", statusColor, "dark:border-stone-800 dark:bg-transparent")}>
            <div className="text-sm font-semibold tabular-nums text-stone-800 dark:text-stone-200">镜 {shot.index}</div>
            <div>
                <Select
                    size="small"
                    variant="borderless"
                    defaultValue={board.shotSize}
                    className="-ml-2 w-full"
                    options={["远景", "全景", "中景", "近景", "特写"].map((v) => ({ value: v, label: v }))}
                />
                <div className="text-xs text-stone-400">{board.camera}</div>
            </div>
            <div className="space-y-1">
                <Input size="small" variant="borderless" defaultValue={board.action} placeholder="动作描述" className="px-0 text-xs" />
                <div className="flex items-center gap-1 text-xs text-stone-400">
                    <MapPin className="size-3" />
                    {board.background || "背景待定"}
                </div>
            </div>
            <Input.TextArea
                size="small"
                variant="borderless"
                autoSize
                defaultValue={board.dialogue}
                placeholder="对白（可空）"
                className="px-0 text-xs leading-5 text-stone-600"
            />
            <div className="flex items-center gap-1 text-xs tabular-nums text-stone-500 dark:text-stone-400">
                <Input size="small" defaultValue={board.durationSec} className="w-12 text-center" suffix="s" />
            </div>
            <div className="flex flex-col items-center justify-center">
                <Button size="small" type="text" disabled={first} icon={<ChevronUp className="size-3.5" />} />
                <Button size="small" type="text" disabled={last} icon={<ChevronDown className="size-3.5" />} />
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

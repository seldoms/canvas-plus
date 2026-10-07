import { Avatar, Button, Drawer, Input, InputNumber, Select, Tabs, Tag, Tooltip } from "antd";
import { ChevronDown, ChevronUp, Clock, Lock, Plus, Users } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { CHARACTERS, EPISODES, PROJECT, RUNS, SCENES, SHOTS, type MockEpisode, type MockScene, type MockShot } from "./mock-data";
import { PanelSection, StageShell } from "./stage-shell";
import { StoryboardSketch } from "./storyboard-sketch";

/* ------------------------------------------------------------------ */
/* 01 剧本                                                             */
/* ------------------------------------------------------------------ */

const SCRIPT_EP1 = `陈默的婚礼在一家老牌酒店举行。宾客盈门，红色喜字映在玻璃门上。

林慧的母亲林娟坚持把亲戚都安排在靠主桌的位置，外婆的桌牌被挪到了宴会厅最远的角落。陈默发现后没有声张，先扶着外婆穿过人群。

"慢点走，不着急，让他们先忙。"外婆说。

仪式开始前，陈默走到林慧身边，压低声音问："外婆的座位怎么在那边？"`;

export function ScriptPanel() {
    const [editing, setEditing] = useState(false);
    return (
        <StageShell>
            {/* 制作设定：事实快照在此展示（原上下文条第二行迁入） */}
            <PanelSection title="制作设定">
                <div className="rounded-lg bg-stone-50 px-4 py-3 text-xs leading-6 text-stone-600 dark:bg-white/5 dark:text-stone-300">
                    <div className="flex flex-wrap items-center gap-x-2">
                        <Lock className="size-3.5 text-stone-400" />
                        <span>事实快照 <b className="text-stone-800 dark:text-stone-100">v{RUNS[1].snapshotVersion}</b> 已冻结 —— 本 run 读取快照，项目后续改动不影响本次生产</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-stone-500 dark:text-stone-400">
                        <span>画幅 {PROJECT.ratio}</span>
                        <span>单集 {PROJECT.episodeMinutes} 分钟 · 共 {PROJECT.episodeCount} 集</span>
                        <span>声音路线：{PROJECT.audioMode}</span>
                        <span className="basis-full">风格锚点：{PROJECT.styleAnchor}</span>
                    </div>
                </div>
            </PanelSection>
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
/* 02 分镜 —— 胶片条布局：每场一行，分镜卡横向排列（小图、整页少滚动）；  */
/*    点击卡片进抽屉改文字。镜头按 sceneId 归位到场（清单 §4.4）。       */
/* ------------------------------------------------------------------ */

function shotsByScene(sceneId: string): MockShot[] {
    // 真实实现：优先 scene.shots，为空时把 episode.shots 按 sceneId 分组归位 —— demo 数据直接模拟归位结果
    return SHOTS.filter((shot) => shot.sceneId === sceneId).sort((a, b) => a.index - b.index);
}

function CastAvatars({ names, size = 18 }: { names?: string[]; size?: number }) {
    if (!names?.length) return null;
    return (
        <span className="flex -space-x-1">
            {names.map((name) => (
                <Tooltip key={name} title={name}>
                    <Avatar size={size} src={`/demo-assets/cast/${encodeURIComponent(name)}.png`} className="ring-1 ring-white/80 dark:ring-stone-900">
                        {name[0]}
                    </Avatar>
                </Tooltip>
            ))}
        </span>
    );
}

/** 分镜卡：紧凑竖幅，信息全部叠在画格上（镜号/景别/时长/人物/动作），不另占文字区 */
function ShotCard({ shot, scene, onOpen }: { shot: MockShot; scene?: MockScene; onOpen: () => void }) {
    const board = shot.storyboard;
    const statusDot = shot.status === "done" ? "bg-emerald-400" : shot.status === "partial" ? "bg-orange-400" : "bg-stone-300 dark:bg-stone-600";
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group relative w-28 shrink-0 overflow-hidden rounded-lg border border-stone-200/80 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-stone-800"
        >
            <StoryboardSketch scene={scene} shot={shot} className="block aspect-[9/16] w-full" />
            <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium tabular-nums text-white">
                <span className={cn("size-1.5 rounded-full", statusDot)} />
                {String(shot.index).padStart(2, "0")}
            </span>
            <span className="absolute right-1 top-1 rounded bg-black/45 px-1 py-0.5 text-[9px] text-white/85">
                {board.shotSize}·{board.camera || "固定"}
            </span>
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-1.5 pb-1 pt-5">
                <span className="line-clamp-2 text-[10px] leading-3 text-white/95">{board.action || "（动作待补）"}</span>
                <span className="mt-1 flex items-center justify-between">
                    <CastAvatars names={board.characters} size={16} />
                    <span className="flex items-center gap-0.5 text-[9px] tabular-nums text-white/75">
                        <Clock className="size-2" />
                        {board.durationSec ?? "?"}s
                    </span>
                </span>
            </span>
            {board.dialogue ? (
                <span className="absolute bottom-0 left-0 h-0.5 w-full bg-amber-400/80" title={board.dialogue} />
            ) : null}
        </button>
    );
}

/** 镜头详情抽屉：大示意稿 + 全部可编辑字段 + 调序（对白在此编辑） */
function ShotDrawer({ shot, scene, first, last, onClose }: { shot: MockShot | null; scene?: MockScene; first: boolean; last: boolean; onClose: () => void }) {
    if (!shot) return null;
    const board = shot.storyboard;
    return (
        <Drawer
            open
            onClose={onClose}
            width={420}
            title={
                <span className="flex items-center gap-2 text-sm">
                    镜 {String(shot.index).padStart(2, "0")}
                    <span className="text-xs font-normal text-stone-400">{scene ? `场 ${scene.index} · ${scene.locationId}` : ""}</span>
                </span>
            }
            footer={
                <div className="flex items-center justify-between">
                    <span className="flex gap-1">
                        <Button size="small" disabled={first} icon={<ChevronUp className="size-3.5" />}>上移</Button>
                        <Button size="small" disabled={last} icon={<ChevronDown className="size-3.5" />}>下移</Button>
                    </span>
                    <span className="flex gap-2">
                        <Button size="small" onClick={onClose}>取消</Button>
                        <Button size="small" type="primary" onClick={onClose}>保存到项目镜头</Button>
                    </span>
                </div>
            }
        >
            <div className="space-y-4">
                <StoryboardSketch scene={scene} shot={shot} className="mx-auto block w-44 rounded-lg shadow-sm" />
                <p className="-mt-2 text-center text-[11px] text-stone-400">示意稿由分镜文字生成 · 关键帧产出后替换为真实画面</p>
                <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                        <span className="mb-1 block text-xs text-stone-500">景别</span>
                        <Select size="small" className="w-full" defaultValue={board.shotSize} options={["远景", "全景", "中景", "近景", "特写"].map((v) => ({ value: v, label: v }))} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs text-stone-500">运镜</span>
                        <Input size="small" defaultValue={board.camera} placeholder="固定" />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs text-stone-500">时长（秒）</span>
                        <InputNumber size="small" className="w-full" min={1} max={30} defaultValue={board.durationSec} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs text-stone-500">背景 / 场景</span>
                        <Input size="small" defaultValue={board.background || scene?.locationId} />
                    </label>
                </div>
                <label className="block">
                    <span className="mb-1 block text-xs text-stone-500">动作描述</span>
                    <Input.TextArea rows={2} defaultValue={board.action} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs text-stone-500">对白（可空）</span>
                    <Input.TextArea rows={3} defaultValue={board.dialogue} />
                </label>
                <div>
                    <span className="mb-1.5 block text-xs text-stone-500">出场人物</span>
                    <div className="flex flex-wrap gap-2">
                        {(board.characters || []).map((name) => (
                            <span key={name} className="flex items-center gap-1.5 rounded-full border border-stone-200 py-0.5 pl-0.5 pr-2 text-xs dark:border-stone-700">
                                <Avatar size={20} src={`/demo-assets/cast/${encodeURIComponent(name)}.png`}>{name[0]}</Avatar>
                                {name}
                            </span>
                        ))}
                        <Button size="small" type="dashed" icon={<Plus className="size-3" />} className="rounded-full">添加</Button>
                    </div>
                </div>
                <p className="rounded-lg border border-dashed border-stone-300 px-3 py-2 text-[11px] leading-5 text-stone-500 dark:border-stone-700 dark:text-stone-400">
                    保存写入项目镜头（PATCH /api/projects/:id/shots/:shotId），「影响分析」会标出需重做的关键帧 / 配音 / 片段（清单 §4.10）。
                </p>
            </div>
        </Drawer>
    );
}

export function StoryboardPanel({ episode }: { episode: MockEpisode }) {
    const [openShotId, setOpenShotId] = useState<string | null>(null);
    const totalShots = SCENES.reduce((n, sc) => n + shotsByScene(sc.id).length, 0);
    const openShot = SHOTS.find((shot) => shot.id === openShotId) || null;
    const openScene = openShot ? SCENES.find((sc) => sc.id === openShot.sceneId) : undefined;
    const openSiblings = openShot ? shotsByScene(openShot.sceneId) : [];
    const openIndex = openShot ? openSiblings.findIndex((shot) => shot.id === openShot.id) : -1;

    return (
        <StageShell>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="text-xs text-stone-500 dark:text-stone-400">{episode.logline}</span>
                <span className="ml-auto text-xs tabular-nums text-stone-400">{SCENES.length} 场 · {totalShots} 镜</span>
            </div>
            <div className="space-y-3">
                {SCENES.map((scene) => {
                    const shots = shotsByScene(scene.id);
                    return (
                        <div key={scene.id}>
                            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs">
                                <span className="font-medium text-stone-700 dark:text-stone-300">场 {scene.index} · {scene.locationId} · {scene.time}</span>
                                <span className="truncate text-stone-400">{scene.intent}</span>
                                <span className="ml-auto tabular-nums text-stone-400">{shots.length} 镜</span>
                            </div>
                            <div className="flex gap-2 overflow-x-auto pb-1">
                                {shots.map((shot) => (
                                    <ShotCard key={shot.id} shot={shot} scene={scene} onOpen={() => setOpenShotId(shot.id)} />
                                ))}
                                <button
                                    type="button"
                                    className="flex w-28 shrink-0 flex-col items-center justify-center gap-1 self-stretch rounded-lg border border-dashed border-stone-300 text-[11px] text-stone-400 transition hover:border-stone-400 hover:text-stone-500 dark:border-stone-700"
                                >
                                    <Plus className="size-3.5" />
                                    新增镜头
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-3 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-[11px] leading-5 text-stone-500 dark:border-stone-700 dark:text-stone-400">
                画格目前是「分镜示意稿」——由动作/景别/人物文字生成的铅笔构图；底部黄线标记该镜有对白。进入关键帧阶段后画格替换为真实候选图。
            </div>
            <ShotDrawer
                shot={openShot}
                scene={openScene}
                first={openIndex <= 0}
                last={openIndex >= 0 && openIndex === openSiblings.length - 1}
                onClose={() => setOpenShotId(null)}
            />
        </StageShell>
    );
}

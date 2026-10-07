import { Avatar, Button, Drawer, Empty, Input, InputNumber, Select, Tabs, Tag, Tooltip } from "antd";
import { ChevronDown, ChevronUp, Clock, Lock, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import type { MockScene, MockShot } from "./mock-data";
import { PanelSection, StageShell } from "./stage-shell";
import type {
    BoardEpisode,
    BoardShot,
    KeyframeOutput,
    ScriptOutput,
    StoryboardOutput,
} from "./stage-types";
import { itemStatusTone, stageOutput } from "./stage-types";
import { StoryboardSketch } from "./storyboard-sketch";
import type { Production } from "./use-production";

/* ------------------------------------------------------------------ */
/* 共用：空态 —— 没有执行记录 / 阶段未产出时的诚实提示                     */
/* ------------------------------------------------------------------ */

function StageEmpty({ production, stageId, hint }: { production: Production; stageId: string; hint: string }) {
    if (!production.run) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先在左侧选择一条执行记录；没有的话点上方「运行」按项目原文新建" />;
    }
    const status = production.stageStatus(stageId);
    if (status === "running") {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本阶段正在生成，产物落盘后自动出现在这里" />;
    }
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hint} />;
}

/* ------------------------------------------------------------------ */
/* 01 剧本 —— 真实产物：制作设定（快照）/ 原文 / 主线 / 人物 / 场次 / 分集  */
/* ------------------------------------------------------------------ */

export function ScriptPanel({ production }: { production: Production }) {
    const { run } = production;
    const script = stageOutput<ScriptOutput>(run, "script");
    if (!run || !script) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="script" hint="本执行记录还没有剧本产物：点上方「运行」生成" />
            </StageShell>
        );
    }
    const characters = script.characters ?? [];
    const scenes = script.scenes ?? [];
    const episodes = script.episodes ?? [];
    const estimate = run.estimate;
    return (
        <StageShell>
            <PanelSection title="制作设定">
                <div className="rounded-lg bg-stone-50 px-4 py-3 text-xs leading-6 text-stone-600 dark:bg-white/5 dark:text-stone-300">
                    <div className="flex flex-wrap items-center gap-x-2">
                        <Lock className="size-3.5 text-stone-400" />
                        <span>
                            本执行记录 <b className="text-stone-800 dark:text-stone-100">「{run.title}」</b> 的输入已冻结 —— 各阶段读取这份快照，项目后续改动不影响本次生产
                        </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-stone-500 dark:text-stone-400">
                        <span>创建于 {new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                        {estimate ? (
                            <span>
                                剧本规模：{estimate.chunked ? `${estimate.chunks} 块续跑` : "整块生成"} · 约 {estimate.llmCalls} 次模型调用
                            </span>
                        ) : null}
                        {run.options?.stageModels ? (
                            <span className="basis-full">
                                阶段模型：{Object.entries(run.options.stageModels as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(" · ")}
                            </span>
                        ) : null}
                    </div>
                </div>
            </PanelSection>
            <PanelSection title="原文">
                <div className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200/70 px-4 py-3 text-xs leading-6 text-stone-600 dark:border-stone-800 dark:text-stone-400">
                    {run.novel}
                </div>
            </PanelSection>
            {script.logline || script.synopsis ? (
                <PanelSection title="主线">
                    {script.logline ? <p className="mb-2 text-sm font-medium text-stone-800 dark:text-stone-200">{script.logline}</p> : null}
                    {script.synopsis ? (
                        <p className="rounded-lg bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700 dark:bg-white/5 dark:text-stone-300">{script.synopsis}</p>
                    ) : null}
                </PanelSection>
            ) : null}
            <PanelSection title={`人物（${characters.length}）`} extra={<Users className="size-3.5 text-stone-400" />}>
                <div className="flex flex-wrap gap-1.5">
                    {characters.map((c) => (
                        <Tooltip key={c.id} title={c.profile || c.appearance || ""}>
                            <Tag className="mr-0 cursor-default">{c.name}{c.appearance ? ` · ${c.appearance.slice(0, 18)}…` : ""}</Tag>
                        </Tooltip>
                    ))}
                </div>
            </PanelSection>
            {scenes.length ? (
                <PanelSection title={`场次（${scenes.length}）`}>
                    <div className="space-y-2">
                        {scenes.map((scene, i) => (
                            <div key={scene.id} className="rounded-lg border border-stone-200/70 px-4 py-2.5 dark:border-stone-800">
                                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                                    <span className="font-medium text-stone-800 dark:text-stone-200">场 {i + 1} · {scene.title || scene.id}</span>
                                    <span className="text-xs text-stone-400">{[scene.location, scene.time].filter(Boolean).join(" · ")}</span>
                                </div>
                                {scene.intent ? <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{scene.intent}</p> : null}
                                {scene.beats?.length ? (
                                    <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-xs leading-5 text-stone-600 dark:text-stone-300">
                                        {scene.beats.map((beat, j) => <li key={j}>{beat}</li>)}
                                    </ol>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </PanelSection>
            ) : null}
            {episodes.length ? (
                <PanelSection title="分集">
                    <Tabs
                        size="small"
                        items={episodes.map((ep) => ({
                            key: ep.id,
                            label: `第 ${ep.index ?? "?"} 集 · ${ep.title || ""}`,
                            children: (
                                <div className="text-sm leading-6 text-stone-700 dark:text-stone-300">
                                    {ep.durationSec ? <span className="mr-2 text-xs tabular-nums text-stone-400">{ep.durationSec}s</span> : null}
                                    {ep.synopsis || "（本集梗概待生成）"}
                                </div>
                            ),
                        }))}
                    />
                </PanelSection>
            ) : null}
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
                逐集改稿接口是已知缺口（清单）：改剧本目前回项目原文或重跑本阶段，专用改稿接口补齐后这里开放就地编辑。
            </p>
        </StageShell>
    );
}

/* ------------------------------------------------------------------ */
/* 02 分镜 —— 胶片条：真实镜头按 集→场 归位；关键帧产出后画格自动换成真图 */
/* ------------------------------------------------------------------ */

/** 给示意图组件喂最小形状（它只读 locationId / storyboard 四字段 / index）。 */
function sketchScene(sceneTitle: string): MockScene {
    return { locationId: sceneTitle } as unknown as MockScene;
}
function sketchShot(shot: BoardShot, people: number): MockShot {
    return {
        index: shot.index ?? 0,
        storyboard: { background: "", action: shot.action || "", shotSize: shot.shotSize || "中景", characters: Array.from({ length: people }, (_, i) => `p${i}`) },
    } as unknown as MockShot;
}

function ShotCard({
    shot,
    sceneTitle,
    imageUrl,
    imageStatus,
    onOpen,
}: {
    shot: BoardShot;
    sceneTitle: string;
    imageUrl?: string;
    imageStatus?: string;
    onOpen: () => void;
}) {
    const people = Math.max(1, Math.min(3, (shot.action?.match(/[，。；]/) ? 2 : 1) || 1));
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group relative w-28 shrink-0 overflow-hidden rounded-lg border border-stone-200/80 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-stone-800"
        >
            {imageUrl ? (
                <img src={imageUrl} alt={`镜 ${shot.index}`} className="block aspect-[9/16] w-full object-cover" loading="lazy" />
            ) : (
                <StoryboardSketch scene={sketchScene(sceneTitle)} shot={sketchShot(shot, people)} className="block aspect-[9/16] w-full" />
            )}
            <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium tabular-nums text-white">
                {imageStatus ? <span className={cn("size-1.5 rounded-full", imageStatus === "done" ? "bg-emerald-400" : imageStatus === "running" || imageStatus === "queued" ? "bg-sky-400 animate-pulse" : "bg-orange-400")} /> : null}
                {String(shot.index ?? 0).padStart(2, "0")}
            </span>
            <span className="absolute right-1 top-1 rounded bg-black/45 px-1 py-0.5 text-[9px] text-white/85">{shot.shotSize || "中景"}</span>
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-1.5 pb-1 pt-5">
                <span className="line-clamp-2 text-[10px] leading-3 text-white/95">{shot.action || "（动作待补）"}</span>
                <span className="mt-1 flex items-center justify-end gap-0.5 text-[9px] tabular-nums text-white/75">
                    <Clock className="size-2" />
                    {shot.durationSec ?? "?"}s
                </span>
            </span>
            {shot.dialogue ? <span className="absolute bottom-0 left-0 h-0.5 w-full bg-amber-400/80" title={shot.dialogue} /> : null}
        </button>
    );
}

function ShotDrawer({
    production,
    shot,
    sceneTitle,
    imageUrl,
    first,
    last,
    onClose,
}: {
    production: Production;
    shot: BoardShot | null;
    sceneTitle: string;
    imageUrl?: string;
    first: boolean;
    last: boolean;
    onClose: () => void;
}) {
    const [form, setForm] = useState<Record<string, unknown>>({});
    const [saving, setSaving] = useState(false);
    if (!shot) return null;
    const value = <T,>(key: string, fallback: T): T => (key in form ? (form[key] as T) : fallback);
    const dirty = Object.keys(form).length > 0;
    const save = async () => {
        if (!dirty) return onClose();
        setSaving(true);
        const ok = await production.patchShot("storyboard", shot.id, form);
        setSaving(false);
        if (ok) onClose();
    };
    return (
        <Drawer
            open
            onClose={onClose}
            width={420}
            title={
                <span className="flex items-center gap-2 text-sm">
                    镜 {String(shot.index ?? 0).padStart(2, "0")}
                    <span className="text-xs font-normal text-stone-400">{sceneTitle}</span>
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
                        <Button size="small" type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>保存</Button>
                    </span>
                </div>
            }
        >
            <div className="space-y-4">
                {imageUrl ? (
                    <img src={imageUrl} alt="" className="mx-auto block w-44 rounded-lg shadow-sm" />
                ) : (
                    <>
                        <StoryboardSketch scene={sketchScene(sceneTitle)} shot={sketchShot(shot, 2)} className="mx-auto block w-44 rounded-lg shadow-sm" />
                        <p className="-mt-2 text-center text-[11px] text-stone-400">示意稿 · 关键帧产出后替换为真实画面</p>
                    </>
                )}
                <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                        <span className="mb-1 block text-xs text-stone-500">景别</span>
                        <Select
                            size="small"
                            className="w-full"
                            value={value("shotSize", shot.shotSize || "中景")}
                            onChange={(v) => setForm((f) => ({ ...f, shotSize: v }))}
                            options={["远景", "全景", "中景", "近景", "特写"].map((v) => ({ value: v, label: v }))}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs text-stone-500">时长（秒）</span>
                        <InputNumber
                            size="small"
                            className="w-full"
                            min={1}
                            max={60}
                            value={value("durationSec", shot.durationSec ?? 5)}
                            onChange={(v) => setForm((f) => ({ ...f, durationSec: v ?? 5 }))}
                        />
                    </label>
                </div>
                <label className="block">
                    <span className="mb-1 block text-xs text-stone-500">运镜</span>
                    <Input.TextArea rows={2} value={value("camera", shot.camera || "")} onChange={(e) => setForm((f) => ({ ...f, camera: e.target.value }))} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs text-stone-500">动作描述</span>
                    <Input.TextArea rows={3} value={value("action", shot.action || "")} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs text-stone-500">对白（可空）</span>
                    <Input.TextArea rows={3} value={value("dialogue", shot.dialogue || "")} onChange={(e) => setForm((f) => ({ ...f, dialogue: e.target.value }))} />
                </label>
                <p className="rounded-lg border border-dashed border-stone-300 px-3 py-2 text-[11px] leading-5 text-stone-500 dark:border-stone-700 dark:text-stone-400">
                    保存写入本执行记录的分镜产物；改动后需要重做的关键帧 / 配音 / 片段，用各阶段里的「单项重做」完成。调序接口待接（清单）。
                </p>
            </div>
        </Drawer>
    );
}

export function StoryboardPanel({ production }: { production: Production }) {
    const { run } = production;
    const board = stageOutput<StoryboardOutput>(run, "storyboard");
    const script = stageOutput<ScriptOutput>(run, "script");
    const keyframes = stageOutput<KeyframeOutput>(run, "keyframe");
    const [openShotId, setOpenShotId] = useState<string | null>(null);

    /** shotId → 关键帧起始帧的选中图与状态（有真图就替换示意稿）。 */
    const frameByShot = useMemo(() => {
        const map = new Map<string, { url?: string; status?: string }>();
        for (const frame of keyframes?.frames ?? []) {
            if (!frame.shotId || frame.role !== "start") continue;
            map.set(frame.shotId, { url: frame.artifactUrl ? production.artifactUrl(frame.artifactUrl) : undefined, status: frame.status });
        }
        return map;
    }, [keyframes, production]);

    const sceneTitleOf = useMemo(() => {
        const scenes = new Map((script?.scenes ?? []).map((s) => [s.id, s]));
        return (sceneId?: string) => {
            const scene = sceneId ? scenes.get(sceneId) : undefined;
            return scene ? [scene.location, scene.time].filter(Boolean).join(" · ") || scene.title || sceneId || "" : sceneId || "";
        };
    }, [script]);

    if (!run || !board) {
        return (
            <StageShell>
                <StageEmpty production={production} stageId="storyboard" hint="本执行记录还没有分镜产物：剧本完成后运行本阶段" />
            </StageShell>
        );
    }

    const shots = board.shots ?? [];
    const episodes: BoardEpisode[] = board.episodes?.length
        ? board.episodes
        : [{ id: "all", index: 1, title: run.title, shotIds: shots.map((s) => s.id) }];
    const shotById = new Map(shots.map((s) => [s.id, s]));
    const openShot = openShotId ? shotById.get(openShotId) ?? null : null;

    return (
        <StageShell>
            <div className="space-y-4">
                {episodes.map((ep) => {
                    const epShots = (ep.shotIds?.length ? ep.shotIds.map((id) => shotById.get(id)).filter(Boolean) : shots.filter((s) => s.episodeId === ep.id)) as BoardShot[];
                    /** 集内按场分组（sceneId 归位，清单 §4.4），场序按镜头首次出现。 */
                    const groups: { sceneId: string; shots: BoardShot[] }[] = [];
                    for (const shot of epShots) {
                        const key = shot.sceneId || "_";
                        const group = groups.find((g) => g.sceneId === key);
                        if (group) group.shots.push(shot);
                        else groups.push({ sceneId: key, shots: [shot] });
                    }
                    return (
                        <div key={ep.id}>
                            {episodes.length > 1 ? (
                                <div className="mb-1.5 text-sm font-medium text-stone-800 dark:text-stone-200">第 {ep.index ?? "?"} 集 · {ep.title}</div>
                            ) : null}
                            <div className="space-y-3">
                                {groups.map((group, gi) => (
                                    <div key={group.sceneId}>
                                        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs">
                                            <span className="font-medium text-stone-700 dark:text-stone-300">场 {gi + 1}{sceneTitleOf(group.sceneId) ? ` · ${sceneTitleOf(group.sceneId)}` : ""}</span>
                                            <span className="ml-auto tabular-nums text-stone-400">{group.shots.length} 镜</span>
                                        </div>
                                        <div className="flex gap-2 overflow-x-auto pb-1">
                                            {group.shots.map((shot) => {
                                                const frame = frameByShot.get(shot.id);
                                                return (
                                                    <ShotCard
                                                        key={shot.id}
                                                        shot={shot}
                                                        sceneTitle={sceneTitleOf(group.sceneId)}
                                                        imageUrl={frame?.url}
                                                        imageStatus={frame?.status}
                                                        onOpen={() => setOpenShotId(shot.id)}
                                                    />
                                                );
                                            })}
                                            <Tooltip title="新增镜头接口待接（清单：项目镜头新增已有，run 内新增待补）">
                                                <span>
                                                    <button
                                                        type="button"
                                                        disabled
                                                        className="flex w-28 shrink-0 cursor-not-allowed flex-col items-center justify-center gap-1 self-stretch rounded-lg border border-dashed border-stone-300 text-[11px] text-stone-300 dark:border-stone-700 dark:text-stone-600"
                                                    >
                                                        <Plus className="size-3.5" />
                                                        新增镜头
                                                    </button>
                                                </span>
                                            </Tooltip>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-3 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-[11px] leading-5 text-stone-500 dark:border-stone-700 dark:text-stone-400">
                画格在关键帧产出前是铅笔示意稿；底部黄线标记该镜有对白。点卡片进抽屉改景别 / 运镜 / 动作 / 对白 / 时长，保存即写回本执行记录。
            </div>
            <ShotDrawer
                production={production}
                shot={openShot}
                sceneTitle={openShot ? sceneTitleOf(openShot.sceneId) : ""}
                imageUrl={openShot ? frameByShot.get(openShot.id)?.url : undefined}
                first={false}
                last={false}
                onClose={() => setOpenShotId(null)}
            />
        </StageShell>
    );
}

/** 状态点颜色（供后续面板复用）。 */
export function toneDot(tone: ReturnType<typeof itemStatusTone>) {
    return tone === "success" ? "bg-emerald-400" : tone === "processing" ? "bg-sky-400 animate-pulse" : tone === "error" ? "bg-orange-400" : "bg-stone-300 dark:bg-stone-600";
}

/** 人物头像（真实定妆照优先，无图用首字）。 */
export function CharacterAvatar({ name, url, size = 18 }: { name?: string; url?: string; size?: number }) {
    return (
        <Tooltip title={name}>
            <Avatar size={size} src={url || undefined} className="ring-1 ring-white/80 dark:ring-stone-900">
                {name?.[0] || "?"}
            </Avatar>
        </Tooltip>
    );
}

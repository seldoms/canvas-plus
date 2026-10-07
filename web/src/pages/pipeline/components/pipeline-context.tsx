import { Card, Empty, Select, Spin, Tag } from "antd";
import { BookOpen, Film, MapPin, MessageSquare, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getEpisode, getProjectContext, listProjects, type EpisodeDetail, type ProjectContext, type ProjectSummary } from "@/services/api/projects";

type PipelineContextValue = {
    projectId: string;
    episodeId: string;
    title: string;
    sourceText?: string;
    context: ProjectContext | null;
    episode: EpisodeDetail | null;
};

function shotBoard(shot: { storyboard: unknown }) {
    return shot.storyboard && typeof shot.storyboard === "object" ? shot.storyboard as Record<string, unknown> : {};
}

function shotText(shot: { storyboard: unknown }, key: string) {
    const value = shotBoard(shot)[key];
    return typeof value === "string" ? value.trim() : "";
}

export function PipelineContext({ onChange, locked = false }: { onChange: (value: PipelineContextValue) => void; locked?: boolean }) {
    const [projects, setProjects] = useState<ProjectSummary[]>([]);
    const [projectId, setProjectId] = useState("");
    const [episodeId, setEpisodeId] = useState("");
    const [context, setContext] = useState<ProjectContext | null>(null);
    const [episode, setEpisode] = useState<EpisodeDetail | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        void listProjects().then((items) => {
            setProjects(items);
            if (items[0]) setProjectId(items[0].id);
        }).finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!projectId) {
            setContext(null);
            setEpisode(null);
            setEpisodeId("");
            return;
        }
        void getProjectContext(projectId).then((value) => {
            setContext(value);
            const first = value?.episodes?.slice().sort((a, b) => a.index - b.index)[0];
            setEpisodeId(first?.id || "");
        }).catch(() => {
            setContext(null);
            setEpisodeId("");
        });
    }, [projectId]);

    useEffect(() => {
        if (!projectId || !episodeId) {
            setEpisode(null);
            return;
        }
        void getEpisode(projectId, episodeId).then(setEpisode).catch(() => setEpisode(null));
    }, [projectId, episodeId]);

    const scenes = useMemo(() => episode?.scenes?.slice().sort((a, b) => a.index - b.index) || [], [episode]);
    const shots = useMemo(() => scenes.flatMap((scene) => scene.shots || []), [scenes]);
    const dialogueCount = shots.reduce((count, shot) => count + (Array.isArray((shot.storyboard as { dialogueLines?: unknown[] } | null)?.dialogueLines) ? ((shot.storyboard as { dialogueLines: unknown[] }).dialogueLines.length) : String((shot.storyboard as { dialogue?: string } | null)?.dialogue || "").trim() ? 1 : 0), 0);
    const selectedProject = projects.find((project) => project.id === projectId);

    useEffect(() => {
        onChange({ projectId, episodeId, title: selectedProject?.title || "", sourceText: typeof context?.project.script === "string" ? context.project.script : "", context, episode });
    }, [projectId, episodeId, selectedProject?.title, context, episode, onChange]);

    if (loading) return <Card className="mb-5"><Spin size="small" /></Card>;
    if (!projects.length) return <Card className="mb-5"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先在项目中创建一部剧" /></Card>;

    return (
        <Card className="mb-5 overflow-hidden border-0 bg-[#171714] text-white shadow-[0_18px_60px_rgba(24,24,20,.18)]" styles={{ body: { padding: 0 } }}>
            <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-5 py-4">
                <BookOpen className="size-4 text-amber-300" />
                <Select value={projectId} onChange={setProjectId} disabled={locked} variant="borderless" className="min-w-56 text-white" popupClassName="pipeline-context-popup" options={projects.map((project) => ({ value: project.id, label: project.title }))} />
                <span className="text-white/30">/</span>
                <Select value={episodeId || undefined} onChange={setEpisodeId} disabled={locked} variant="borderless" className="min-w-44 text-white" placeholder="选择集数" popupClassName="pipeline-context-popup" options={(context?.episodes || []).slice().sort((a, b) => a.index - b.index).map((item) => ({ value: item.id, label: `第 ${item.index} 集 · ${item.title || "未命名"}` }))} />
                <Tag className="ml-auto border-white/20 bg-white/10 text-white">{context?.project.plan.ratio || "—"}</Tag>
                <Tag className="border-white/20 bg-white/10 text-white">{context?.project.plan.audioMode === "embedded" ? "原声" : "独立配音"}</Tag>
            </div>
            <div className="grid gap-4 px-5 py-4 md:grid-cols-[1.1fr_1fr_1fr]">
                <div className="space-y-2">
                    <div className="text-xs uppercase tracking-[.18em] text-white/45">{context?.project.styleAnchor || "未设置风格锚点"}</div>
                    <div className="text-lg font-medium">{episode?.title || "当前集尚未建立分镜"}</div>
                    <div className="text-sm text-white/55">{episode?.logline || "选择一集后，镜头和台词会在这里展开。"}</div>
                </div>
                <div className="flex flex-wrap content-start gap-2 text-sm text-white/75">
                    <span className="flex items-center gap-1.5"><Film className="size-4 text-amber-300" />{scenes.length} 场</span>
                    <span className="flex items-center gap-1.5"><MapPin className="size-4 text-amber-300" />{shots.length} 镜</span>
                    <span className="flex items-center gap-1.5"><MessageSquare className="size-4 text-amber-300" />{dialogueCount} 条台词</span>
                    <span className="flex items-center gap-1.5"><Users className="size-4 text-amber-300" />{Array.isArray((context?.project.script as { characters?: unknown[] } | null)?.characters) ? (context?.project.script as { characters: unknown[] }).characters.length : "—"} 个角色</span>
                </div>
                <div className="flex flex-wrap content-start gap-1.5">
                    {scenes.slice(0, 6).map((scene) => <Tag key={scene.id} className="border-white/15 bg-white/5 text-white/70">{scene.index}. {scene.locationId || scene.time || "场景"}</Tag>)}
                    {scenes.length > 6 ? <span className="self-center text-xs text-white/40">+{scenes.length - 6}</span> : null}
                </div>
            </div>
            <div className="border-t border-white/10 px-5 py-4">
                <div className="mb-3 text-sm text-white/80">本集镜头</div>
                <div className="max-h-[30rem] space-y-3 overflow-y-auto pr-1">
                    {scenes.map((scene) => (
                        <div key={scene.id} className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-white/55">
                                <span className="font-medium text-amber-200">场 {scene.index}</span>
                                <span>{scene.locationId || "未设场景"}</span>
                                <span>{scene.time || "时间待定"}</span>
                                {scene.intent ? <span className="truncate text-white/40">{scene.intent}</span> : null}
                            </div>
                            <div className="space-y-2">
                                {(scene.shots || []).map((shot) => {
                                    const board = shotBoard(shot);
                                    const dialogue = shotText(shot, "dialogue") || (Array.isArray(board.dialogueLines) ? board.dialogueLines.map((line) => typeof line === "string" ? line : String((line as { text?: unknown })?.text || "")).filter(Boolean).join(" · ") : "");
                                    const background = shotText(shot, "background") || shotText(shot, "setting") || scene.locationId || "背景待定";
                                    return (
                                        <div key={shot.id} className="grid gap-2 rounded-lg bg-black/15 px-3 py-2 text-xs text-white/70 md:grid-cols-[4rem_1fr_1fr]">
                                            <div className="font-medium text-white/90">镜 {shot.index}</div>
                                            <div className="space-y-1">
                                                <div className="text-white/85">{shotText(shot, "shotSize") || shotText(shot, "camera") || "镜头待定"}</div>
                                                <div className="text-white/45">{background}</div>
                                            </div>
                                            <div className="line-clamp-3 text-white/60">{dialogue || shotText(shot, "action") || shotText(shot, "prompt") || "动作与台词待补"}</div>
                                        </div>
                                    );
                                })}
                                {!scene.shots?.length ? <div className="text-xs text-white/35">暂无镜头</div> : null}
                            </div>
                        </div>
                    ))}
                    {!scenes.length ? <div className="py-4 text-center text-xs text-white/40">本集还没有场景与镜头</div> : null}
                </div>
            </div>
        </Card>
    );
}

export type { PipelineContextValue };

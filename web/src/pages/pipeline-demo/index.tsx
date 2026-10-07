import { Button, Tooltip } from "antd";
import { Ban, Lock, Play, RotateCcw, Wrench } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { DemoModelPicker } from "./demo-model-picker";
import { FeedbackLayer } from "./feedback-layer";
import { EPISODES, RUNS, STAGES, type StageId, type StageStatus } from "./mock-data";
import { ScriptPanel, StoryboardPanel } from "./panels-story";
import { CastingPanel, DesignPanel, KeyframePanel } from "./panels-assets";
import { AssemblyPanel, AudioPanel } from "./panels-media";
import { PipelineSidebar } from "./pipeline-sidebar";
import { STATUS_META } from "./stage-shell";

/** 七段真实依赖（skills/registry.json）：design/storyboard 依赖 script；audio/keyframe 依赖上游就绪后可分别生产。 */
const REQUIRES: Record<StageId, StageId[]> = {
    script: [],
    storyboard: ["script"],
    design: ["script"],
    casting: ["design"],
    keyframe: ["storyboard", "casting"],
    audio: ["storyboard", "casting"],
    assembly: ["keyframe", "audio"],
};

const PANELS: Record<Exclude<StageId, "storyboard">, () => JSX.Element> = {
    script: ScriptPanel,
    design: DesignPanel,
    casting: CastingPanel,
    keyframe: KeyframePanel,
    audio: AudioPanel,
    assembly: AssemblyPanel,
};

/** 各阶段的模型选择（按能力域配对；定妆不选 LLM，配音音色在定妆配置） */
const MODEL_SLOTS: Partial<Record<StageId, ReactNode>> = {
    script: <DemoModelPicker domain="text" />,
    storyboard: <DemoModelPicker domain="text" />,
    design: (
        <>
            <span className="flex items-center gap-1"><span className="text-[11px] text-stone-400">设定</span><DemoModelPicker domain="text" className="min-w-40" /></span>
            <span className="flex items-center gap-1"><span className="text-[11px] text-stone-400">参考图</span><DemoModelPicker domain="image" className="min-w-40" /></span>
        </>
    ),
    keyframe: <DemoModelPicker domain="image" value="img_qwen21_t2i_1080" />,
    assembly: <DemoModelPicker domain="video" value="vid_wan22_i2v" />,
};

/** 阶段操作（运行/续跑/取消/重试失败/重跑），并入步骤条行 */
function StageActions({ status }: { status: StageStatus }) {
    const running = status === "running";
    return (
        <>
            {running ? (
                <Button size="small" danger icon={<Ban className="size-3.5" />}>取消</Button>
            ) : (
                <Tooltip title={status === "pending" ? "从头运行本阶段" : "接着上次进度继续：只生成还没做完的项，已完成的不重做"}>
                    <Button size="small" type="primary" icon={<Play className="size-3.5" />}>
                        {status === "pending" ? "运行" : "继续生成"}
                    </Button>
                </Tooltip>
            )}
            {status === "error" || status === "partial" ? (
                <Button size="small" icon={<Wrench className="size-3.5" />}>重试失败项</Button>
            ) : null}
            {status !== "pending" && !running ? (
                <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />}>重跑</Button>
            ) : null}
        </>
    );
}

export default function PipelineDemoPage() {
    const [episodeId, setEpisodeId] = useState(EPISODES[0].id);
    const [runId, setRunId] = useState<string | null>(RUNS[1].id);
    const [activeStage, setActiveStage] = useState<StageId>("storyboard");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("pipeline-demo.sidebar-collapsed") === "1");

    useEffect(() => {
        localStorage.setItem("pipeline-demo.sidebar-collapsed", sidebarCollapsed ? "1" : "0");
    }, [sidebarCollapsed]);

    const run = useMemo(() => RUNS.find((item) => item.id === runId) || null, [runId]);
    const episode = useMemo(() => EPISODES.find((item) => item.id === episodeId) || EPISODES[0], [episodeId]);

    const selectEpisode = (id: string) => {
        setEpisodeId(id);
        const latest = RUNS.filter((item) => item.episodeId === id).at(-1);
        setRunId(latest?.id ?? null);
    };

    const stageStatus = (id: StageId) => run?.stages[id] ?? "pending";
    const missingRequires = (id: StageId) => REQUIRES[id].filter((dep) => stageStatus(dep) !== "done");

    const ActivePanel = activeStage === "storyboard" ? null : PANELS[activeStage];

    return (
        <div className="flex h-full gap-2.5 overflow-hidden bg-background p-2.5 text-stone-800 dark:text-stone-100">
            <PipelineSidebar
                episodeId={episodeId}
                runId={runId}
                collapsed={sidebarCollapsed}
                onSelectEpisode={selectEpisode}
                onSelectRun={setRunId}
                onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
            />

            <div className="flex min-w-0 flex-1 flex-col gap-2">
                {/* 步骤条行：阶段切换 + 当前阶段模型与操作，一行收完（原阶段卡头并入）。
                    激活态颜色走原生 <style>，不叠 Tailwind base/dark 双类 —— 级联顺序曾把白底上的文字也染白。 */}
                <style>{`
                    .demo-stage-pill[data-active="true"] { background: #1c1917; color: #fafaf9; }
                    .dark .demo-stage-pill[data-active="true"] { background: #fafaf9; color: #1c1917; }
                    .demo-stage-pill[data-active="true"] .demo-stage-num { color: rgba(250,250,249,.55); }
                    .dark .demo-stage-pill[data-active="true"] .demo-stage-num { color: rgba(28,25,23,.5); }
                    .demo-stage-nav { scrollbar-width: none; }
                    .demo-stage-nav::-webkit-scrollbar { display: none; }
                `}</style>
                <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-stone-200 bg-white px-2.5 py-1.5 dark:border-stone-800 dark:bg-transparent">
                    <nav className="demo-stage-nav min-w-0 flex-1 overflow-x-auto">
                        <div className="flex min-w-max items-center gap-1">
                            {STAGES.map((stage, index) => {
                                const status = stageStatus(stage.id);
                                const missing = missingRequires(stage.id);
                                const active = activeStage === stage.id;
                                return (
                                    <div key={stage.id} className="flex items-center">
                                        {index > 0 ? <span className="mx-1 h-px w-3 bg-stone-200 dark:bg-stone-700" /> : null}
                                        <button
                                            type="button"
                                            data-active={active}
                                            onClick={() => setActiveStage(stage.id)}
                                            className={cn(
                                                "demo-stage-pill flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] transition",
                                                !active && "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10",
                                            )}
                                        >
                                            <span className={cn("demo-stage-num text-[10px] tabular-nums", !active && "text-stone-400")}>
                                                {String(index + 1).padStart(2, "0")}
                                            </span>
                                            <span>{stage.title}</span>
                                            {missing.length && status === "pending" ? (
                                                <Lock className="size-3 opacity-50" />
                                            ) : (
                                                <span className={cn("size-1.5 rounded-full", STATUS_META[status].dot)} />
                                            )}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </nav>
                    <span className="hidden h-5 w-px bg-stone-200 sm:block dark:bg-stone-700" />
                    {MODEL_SLOTS[activeStage]}
                    <StageActions status={stageStatus(activeStage)} />
                </div>

                {/* 工作区：阶段面板吃满剩余高度 */}
                <main className="min-h-0 flex-1 overflow-y-auto">
                    {activeStage === "storyboard" ? <StoryboardPanel episode={episode} /> : ActivePanel ? <ActivePanel /> : null}
                </main>
            </div>
            <FeedbackLayer />
        </div>
    );
}

import { Lock } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { ContextBar } from "./context-bar";
import { RUNS, STAGES, type StageId, type StageStatus } from "./mock-data";
import { ScriptPanel, StoryboardPanel } from "./panels-story";
import { CastingPanel, DesignPanel, KeyframePanel } from "./panels-assets";
import { AssemblyPanel, AudioPanel } from "./panels-media";
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

const PANELS: Record<StageId, (props: { status: StageStatus }) => JSX.Element> = {
    script: ScriptPanel,
    storyboard: StoryboardPanel,
    design: DesignPanel,
    casting: CastingPanel,
    keyframe: KeyframePanel,
    audio: AudioPanel,
    assembly: AssemblyPanel,
};

export default function PipelineDemoPage() {
    const [runId, setRunId] = useState<string>(RUNS[1].id);
    const run = useMemo(() => RUNS.find((item) => item.id === runId) || null, [runId]);
    const [activeStage, setActiveStage] = useState<StageId>("storyboard");

    const stageStatus = (id: StageId) => run?.stages[id] ?? "pending";
    const missingRequires = (id: StageId) => REQUIRES[id].filter((dep) => stageStatus(dep) !== "done");

    const ActivePanel = PANELS[activeStage];

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
                <div className="mx-auto max-w-6xl space-y-4">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                        <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">影视流水线</h1>
                        <span className="text-xs text-stone-400">项目 → 集 → 场景 → 镜头 → 素材与候选 → 成片；run 只是执行记录</span>
                        <span className="ml-auto rounded-full bg-amber-100 px-2.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">设计 Demo · 演示数据</span>
                    </div>

                    <ContextBar run={run} onSelectRun={setRunId} />

                    {/* 阶段导航：横向步骤条，状态点 + 依赖锁，点击切换工作台 */}
                    <nav className="overflow-x-auto rounded-xl border border-stone-200 bg-white px-3 py-2.5 dark:border-stone-800 dark:bg-transparent">
                        <div className="flex min-w-max items-center gap-1">
                            {STAGES.map((stage, index) => {
                                const status = stageStatus(stage.id);
                                const missing = missingRequires(stage.id);
                                const active = activeStage === stage.id;
                                return (
                                    <div key={stage.id} className="flex items-center">
                                        {index > 0 ? <span className="mx-1 h-px w-4 bg-stone-200 dark:bg-stone-700" /> : null}
                                        <button
                                            type="button"
                                            onClick={() => setActiveStage(stage.id)}
                                            className={cn(
                                                "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition",
                                                active
                                                    ? "bg-stone-950 text-white dark:bg-white dark:text-stone-900"
                                                    : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10",
                                            )}
                                        >
                                            <span className={cn("text-[11px] tabular-nums", active ? "opacity-60" : "text-stone-400")}>
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

                    <ActivePanel status={stageStatus(activeStage)} />

                    <p className="pb-4 text-center text-xs text-stone-400 dark:text-stone-500">
                        本页为改版设计稿（演示数据）：确认布局与交互后，再替换 /pipeline 真实接线。
                    </p>
                </div>
            </main>
        </div>
    );
}

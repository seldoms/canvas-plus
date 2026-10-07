import { Alert, Button, Tooltip } from "antd";
import { Ban, Lock, Play, RotateCcw, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import type { ModelCapability } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

import { PipelineModelPicker } from "./pipeline-model-picker";
import type { StageId, StageStatus } from "./mock-data";
import { ScriptPanel, StoryboardPanel } from "./panels-story";
import { CastingPanel, DesignPanel, KeyframePanel } from "./panels-assets";
import { AssemblyPanel, AudioPanel } from "./panels-media";
import { PipelineSidebar } from "./pipeline-sidebar";
import { STATUS_META } from "./stage-shell";
import { useProduction, type Production, type ProductionStageStatus } from "./use-production";

/**
 * 各阶段要选的能力域（真实模型注册表的 category）。
 * - script/storyboard/design 走文本 LLM；
 * - keyframe 走图像；assembly 走视频；
 * - casting 不选 LLM（定妆靠身份卡），audio 选的是音色不是模型 → 无模型槽位。
 */
const STAGE_CAPABILITY: Partial<Record<StageId, ModelCapability>> = {
    script: "text",
    storyboard: "text",
    design: "text",
    keyframe: "image",
    assembly: "video",
};

/** 阶段额外可配的能力域：服化道同时要一张参考图。 */
const EXTRA_IMAGE_STAGES = new Set<StageId>(["design"]);

function ActiveStagePanel({ stage, production }: { stage: StageId; production: Production }) {
    switch (stage) {
        case "script":
            return <ScriptPanel production={production} />;
        case "storyboard":
            return <StoryboardPanel production={production} />;
        case "design":
            return <DesignPanel production={production} />;
        case "casting":
            return <CastingPanel production={production} />;
        case "keyframe":
            return <KeyframePanel production={production} />;
        case "audio":
            return <AudioPanel production={production} />;
        case "assembly":
            return <AssemblyPanel production={production} />;
        default:
            return null;
    }
}

/** 阶段操作（真实接口）：运行/继续生成/取消/重试失败项/重跑，并入步骤条行。 */
function StageActions({
    status,
    busy,
    onStart,
    onCancel,
    onRetry,
}: {
    status: ProductionStageStatus;
    busy: boolean;
    onStart: (resume: boolean) => void;
    onCancel: () => void;
    onRetry: () => void;
}) {
    const running = status === "running";
    return (
        <>
            {running ? (
                <Button size="small" danger icon={<Ban className="size-3.5" />} onClick={onCancel}>取消</Button>
            ) : (
                <Tooltip title={status === "pending" ? "从头运行本阶段" : "接着上次进度继续：只生成还没做完的项，已完成的不重做"}>
                    <Button size="small" type="primary" loading={busy} icon={<Play className="size-3.5" />} onClick={() => onStart(status !== "pending")}>
                        {status === "pending" ? "运行" : "继续生成"}
                    </Button>
                </Tooltip>
            )}
            {status === "error" || status === "partial" ? (
                <Button size="small" icon={<Wrench className="size-3.5" />} onClick={onRetry}>重试失败项</Button>
            ) : null}
            {status !== "pending" && !running ? (
                <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} onClick={() => onStart(false)}>重跑</Button>
            ) : null}
        </>
    );
}

export default function PipelineDemoPage() {
    const production = useProduction();
    const {
        stages, projects, projectId, setProjectId,
        episodes, episodeId, setEpisodeId,
        runs, runId, openRun,
        error, busyStage, stageStatus, startStage, cancelStage, retryFailed,
    } = production;

    const [activeStage, setActiveStage] = useState<StageId>("storyboard");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("pipeline-demo.sidebar-collapsed") === "1");

    /**
     * 各阶段的模型选择（真实值 = 注册表 entry.name，请求侧直接用它）。
     * 跨阶段记忆：切回上次的阶段时保留上次选的那个模型，不每次回落到默认值。
     * 持久化到 localStorage：刷新页面不该把用户刚选好的模型重置掉。
     */
    const [stageModels, setStageModels] = useState<Record<string, string>>(() => {
        try {
            const raw = localStorage.getItem("pipeline-demo.stage-models");
            return raw ? (JSON.parse(raw) as Record<string, string>) : {};
        } catch {
            return {};
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem("pipeline-demo.stage-models", JSON.stringify(stageModels));
        } catch {
            // 隐私模式等场景写不进去就算了，不影响本次会话内的选择。
        }
    }, [stageModels]);

    const setStageModel = (stage: string, capability: ModelCapability, value: string) =>
        setStageModels((prev) => ({ ...prev, [`${stage}:${capability}`]: value }));

    useEffect(() => {
        localStorage.setItem("pipeline-demo.sidebar-collapsed", sidebarCollapsed ? "1" : "0");
    }, [sidebarCollapsed]);

    const missingRequires = (stageId: string) => {
        const meta = stages.find((item) => item.id === stageId);
        return (meta?.requires || []).filter((dep) => stageStatus(dep) !== "done");
    };

    const activeStatus: StageStatus = stageStatus(activeStage);

    /**
     * 跑阶段时把用户真选的模型传下去（只传 `model` 一个字段即可）：
     * 服务端 `resolveModel` 会把 Comfy 模板名从 LLM 调用里排除，`configuredTemplateForStage`
     * 再按 family 校验模板是否属于该阶段 —— 同一份 `stageModels[stageId]` 同时管文本模型与媒体模板。
     * 没选就不传，让后端走自己的默认 —— 不代替用户猜一个。
     */
    const handleStart = (resume: boolean) => {
        const capability = STAGE_CAPABILITY[activeStage];
        const model = capability ? stageModels[`${activeStage}:${capability}`] : undefined;
        void startStage(activeStage, { resume, model: model || undefined });
    };

    return (
        <div className="flex h-full gap-2.5 overflow-hidden bg-background p-2.5 text-stone-800 dark:text-stone-100">
            <PipelineSidebar
                projects={projects.map((item) => ({ id: item.id, title: item.title }))}
                projectId={projectId}
                episodes={episodes.map((item) => ({ id: item.id, index: item.index, title: item.title }))}
                episodeId={episodeId}
                runs={runs}
                runId={runId}
                collapsed={sidebarCollapsed}
                onSelectProject={setProjectId}
                onSelectEpisode={setEpisodeId}
                onSelectRun={(id) => void openRun(id)}
                onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
            />

            <div className="flex min-w-0 flex-1 flex-col gap-2">
                {/* 步骤条行：阶段切换 + 当前阶段模型与操作。阶段与依赖只认服务端 registry（不臆造放行）。
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
                            {stages.map((stage, index) => {
                                const status = stageStatus(stage.id);
                                const missing = missingRequires(stage.id);
                                const active = activeStage === stage.id;
                                return (
                                    <div key={stage.id} className="flex items-center">
                                        {index > 0 ? <span className="mx-1 h-px w-3 bg-stone-200 dark:bg-stone-700" /> : null}
                                        <button
                                            type="button"
                                            data-active={active}
                                            onClick={() => setActiveStage(stage.id as StageId)}
                                            className={cn(
                                                "demo-stage-pill flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] transition",
                                                !active && "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10",
                                            )}
                                        >
                                            <span className={cn("demo-stage-num text-[10px] tabular-nums", !active && "text-stone-400")}>
                                                {String(index + 1).padStart(2, "0")}
                                            </span>
                                            <span>{stage.title || stage.id}</span>
                                            {missing.length && status === "pending" ? (
                                                <Lock className="size-3 opacity-50" />
                                            ) : (
                                                <span className={cn("size-1.5 rounded-full", STATUS_META[status].dot)} />
                                            )}
                                        </button>
                                    </div>
                                );
                            })}
                            {!stages.length ? <span className="px-2 text-xs text-stone-400">阶段清单加载中 / 网关不可达</span> : null}
                        </div>
                    </nav>
                    <span className="hidden h-5 w-px bg-stone-200 sm:block dark:bg-stone-700" />
                    {/* 模型槽位：真实读模型注册表；定妆/配音阶段没有模型槽位（配音选音色，定妆选身份卡）。 */}
                    {(() => {
                        const capability = STAGE_CAPABILITY[activeStage];
                        if (!capability) return null;
                        const extraImage = EXTRA_IMAGE_STAGES.has(activeStage);
                        return (
                            <>
                                <PipelineModelPicker
                                    capability={capability}
                                    value={stageModels[`${activeStage}:${capability}`]}
                                    onChange={(value) => setStageModel(activeStage, capability, value)}
                                />
                                {extraImage ? (
                                    <>
                                        <span className="text-[11px] text-stone-400">参考图</span>
                                        <PipelineModelPicker
                                            capability="image"
                                            value={stageModels[`${activeStage}:image`]}
                                            onChange={(value) => setStageModel(activeStage, "image", value)}
                                        />
                                    </>
                                ) : null}
                            </>
                        );
                    })()}
                    <StageActions
                        status={activeStatus}
                        busy={busyStage === activeStage}
                        onStart={handleStart}
                        onCancel={() => void cancelStage(activeStage)}
                        onRetry={() => void retryFailed(activeStage)}
                    />
                </div>

                {error ? <Alert type="error" showIcon message={error} closable className="shrink-0" /> : null}

                {/* 工作区：阶段面板吃满剩余高度，全部读当前执行记录的真实产物 */}
                <main className="min-h-0 flex-1 overflow-y-auto">
                    <ActiveStagePanel stage={activeStage} production={production} />
                </main>
            </div>
        </div>
    );
}

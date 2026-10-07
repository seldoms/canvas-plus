import { Alert, Button, Input, Modal, Select } from "antd";
import { FileText, History, Pencil, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { StageCard } from "./components/stage-card";
import { PipelineHistory } from "./components/pipeline-history";
import { PipelineContext, type PipelineContextValue } from "./components/pipeline-context";
import { CONFIRM_CHUNKS, usePipelineRun, type PipelineStageView } from "./use-pipeline-run";
import { resolveProjectSourceText } from "@/services/api/gateway";

const TEXT_FILE_RE = /\.(txt|md|markdown|srt|ass|csv|json|text)$/i;

async function readNovelFiles(files: File[]) {
    const accepted = files.filter((file) => TEXT_FILE_RE.test(file.name) || file.type.startsWith("text/"));
    const sorted = [...accepted].sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const parts = await Promise.all(sorted.map(async (file) => `【${file.name}】\n${(await file.text()).trim()}`));
    return { names: sorted.map((file) => file.name), text: parts.join("\n\n"), rejected: files.length - accepted.length };
}

export default function PipelinePage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { novel, setNovel, run, views, starting, busyStage, runningStage, progress, error, createRunOnly, runStage, cancelStage, refresh, openRun, resetRun, loadHistory, historyLoading, renameRun, modelOptions, stageModelOptions, stageModels, setStageModel, templates, regeneratingItem, regenerateItem } = usePipelineRun();
    const [pipelineContext, setPipelineContext] = useState<PipelineContextValue>({ projectId: "", episodeId: "", title: "", context: null, episode: null });
    const [activeStageId, setActiveStageId] = useState("");
    const [imported, setImported] = useState<{ names: string[]; rejected: number } | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const sourceRequestRef = useRef(0);
    const statusById = useMemo(() => new Map(views.map((view) => [view.id, view.status])), [views]);
    const titleById = useMemo(() => new Map(views.map((view) => [view.id, view.title])), [views]);

    useEffect(() => {
        if (!views.length) return;
        setActiveStageId((current) => current && views.some((view) => view.id === current) ? current : views.find((view) => view.status !== "done")?.id || views[0].id);
    }, [views]);

    const handlePipelineContext = useCallback(async (value: PipelineContextValue) => {
        setPipelineContext(value);
        if (!value.projectId) return;
        const requestId = ++sourceRequestRef.current;
        const revisionId = (value.context?.project as { sourceRevisionId?: string | null } | undefined)?.sourceRevisionId;
        try {
            const source = await resolveProjectSourceText(value.projectId, revisionId);
            if (requestId !== sourceRequestRef.current) return;
            setNovel(source?.text || value.sourceText || "");
        } catch {
            if (requestId === sourceRequestRef.current) setNovel(value.sourceText || "");
        }
    }, [setNovel]);

    const importFiles = async (files: File[]) => {
        if (!files.length) return;
        const result = await readNovelFiles(files);
        if (!result.names.length) {
            setImported({ names: [], rejected: result.rejected });
            return;
        }
        setNovel(result.text);
        setImported({ names: result.names, rejected: result.rejected });
    };

    /**
     * 先创建 run 拿到成本预估，块数超过阈值就弹确认再跑。
     * 222 万字的书会切成 163 块、按实测约 31 秒/块要跑 83 分钟 —— 这种量级不该在用户毫不知情时直接开跑。
     */
    const startWithEstimate = async () => {
        const created = await createRunOnly({
            novel,
            title: pipelineContext.title || undefined,
            options: pipelineContext.projectId ? { projectId: pipelineContext.projectId, episodeId: pipelineContext.episodeId } : undefined,
        });
        if (!created) return;
        const estimate = created.estimate;
        if (estimate?.chunked && estimate.chunks > CONFIRM_CHUNKS) {
            Modal.confirm({
                title: t("pipeline.estimateTitle"),
                content: t("pipeline.estimateBody", {
                    chars: estimate.novelChars.toLocaleString(),
                    chunks: estimate.chunks,
                    calls: estimate.llmCalls,
                    minutes: Math.max(1, Math.round(estimate.estSeconds / 60)),
                }),
                okText: t("pipeline.estimateOk"),
                cancelText: t("common.cancel"),
                onOk: () => void runStage("script"),
            });
            return;
        }
        await runStage("script");
    };

    const disabledReason = (view: PipelineStageView) => {
        if (!run) return t("pipeline.needRun");
        if (busyStage || runningStage) return t("pipeline.busy");
        const missing = view.requires.filter((id) => statusById.get(id) !== "done");
        if (missing.length) return t("pipeline.needPrevious", { stages: missing.map((id) => titleById.get(id) || id).join("、") });
        return "";
    };

    /**
     * 上次失败/取消前已完成的块数。大于 0 时「重跑」变成「续跑」并带 resume:true，
     * 后端会复用已落盘的 chunks/*.json —— 163 块跑到第 120 块崩了不必从头再来。
     */
    const resumableChunks = (view: PipelineStageView) =>
        progress && progress.stage === view.id && progress.phase === "failed" ? Number(progress.done) || 0 : 0;

    const toggleHistory = () => {
        if (!showHistory) void loadHistory();
        setShowHistory(!showHistory);
    };

    /** 从历史直接开跑新的：清掉当前 run，回到空白输入。 */
    const createNewRun = () => {
        resetRun();
        setNovel("");
        setImported(null);
        setShowHistory(false);
    };

    const openHistoryRun = (id: string) => {
        setShowHistory(false);
        void openRun(id);
    };

    const saveRenaming = () => {
        if (!renaming) return;
        const title = renaming.title.trim();
        if (title) renameRun(renaming.id, title);
        setRenaming(null);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
                <div className="mx-auto max-w-5xl">
                    <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("pipeline.title")}</h1>
                    {/* 独立入口建的是不绑项目的 run，走到关键帧必然因缺参考图被阻断；项目流水线不显示这条误导性提示。 */}
                    {!run?.options?.projectId && !pipelineContext.projectId ? (
                        <Alert
                            className="mt-4"
                            type="info"
                            showIcon
                            message={t("pipeline.guide.title")}
                            description={t("pipeline.guide.body")}
                            action={
                                <Button size="small" onClick={() => navigate("/projects")}>
                                    {t("pipeline.guide.open")}
                                </Button>
                            }
                        />
                    ) : null}

                    <div className="mt-5">
                        <PipelineContext onChange={handlePipelineContext} locked={Boolean(run)} />
                        {!pipelineContext.projectId ? <div
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                                event.preventDefault();
                                if (!run) void importFiles(Array.from(event.dataTransfer.files));
                            }}
                        >
                            <Input.TextArea rows={5} value={novel} disabled={Boolean(run)} placeholder={t("pipeline.novelPlaceholder")} onChange={(event) => setNovel(event.target.value)} />
                        </div> : null}
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept=".txt,.md,.markdown,.srt,.ass,.csv,.json,.text,text/*"
                            className="hidden"
                            onChange={(event) => {
                                void importFiles(Array.from(event.target.files || []));
                                event.target.value = "";
                            }}
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Button type="primary" icon={<Sparkles className="size-4" />} loading={starting} disabled={!novel.trim() || Boolean(run)} onClick={() => void startWithEstimate()}>
                                {t("pipeline.start")}
                            </Button>
                            {!run && !pipelineContext.projectId ? (
                                <Select
                                    size="middle"
                                    value={stageModels.script || ""}
                                    onChange={(value) => setStageModel("script", value)}
                                    style={{ minWidth: 220 }}
                                    placeholder={t("pipeline.modelLoadFailed")}
                                    options={modelOptions}
                                    optionLabelProp="title"
                                />
                            ) : null}
                            {!pipelineContext.projectId ? <Button icon={<FileText className="size-4" />} disabled={Boolean(run)} onClick={() => fileInputRef.current?.click()}>
                                {t("pipeline.importFiles")}
                            </Button> : null}
                            {run ? (
                                <Button type="text" icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>
                                    {t("pipeline.refresh")}
                                </Button>
                            ) : null}
                            {run ? (
                                <span className="flex items-center gap-0.5 text-xs text-stone-500 dark:text-stone-400">
                                    {run.title || run.id}
                                    <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setRenaming({ id: run.id, title: run.title })} />
                                </span>
                            ) : null}
                            <Button className="ml-auto" type={showHistory ? "primary" : "text"} icon={<History className="size-4" />} onClick={toggleHistory}>
                                {showHistory ? "返回当前" : "历史记录"}
                            </Button>
                        </div>
                        {imported?.names.length ? <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">📄 {t("pipeline.filesImported", { count: imported.names.length, names: imported.names.join("、") })}</div> : null}
                        {imported?.rejected ? <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("pipeline.filesRejected", { count: imported.rejected })}</div> : null}
                        {error ? <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
                    </div>

                    {showHistory ? (
                        <PipelineHistory loading={historyLoading} onOpen={openHistoryRun} onRename={(id, title) => setRenaming({ id, title })} onCreate={createNewRun} onRefresh={() => void loadHistory()} />
                    ) : (
                        <div className="mt-6">
                            <div className="overflow-x-auto border-b border-stone-200/80 pb-3 dark:border-stone-800/80">
                                <div className="flex min-w-max items-center gap-2">
                                    {views.map((view, index) => <button key={view.id} type="button" onClick={() => setActiveStageId(view.id)} className={`flex items-center gap-2 rounded-full px-3 py-2 text-sm transition ${activeStageId === view.id ? "bg-[#171714] text-white shadow-lg dark:bg-white dark:text-stone-900" : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-white/10"}`}><span className="text-[11px] opacity-55">{String(index + 1).padStart(2, "0")}</span><span>{view.title}</span><span className={`size-1.5 rounded-full ${view.status === "done" ? "bg-emerald-400" : view.status === "running" ? "animate-pulse bg-amber-400" : view.status === "error" || view.status === "blocked" ? "bg-red-400" : "bg-stone-300 dark:bg-stone-600"}`} /></button>)}
                                </div>
                            </div>
                            {views.filter((view) => view.id === activeStageId).map((view) => (
                                <StageCard
                                    key={view.id}
                                    index={views.findIndex((item) => item.id === view.id)}
                                    view={view}
                                    busy={busyStage === view.id}
                                    progress={progress}
                                    resumeChunks={resumableChunks(view)}
                                    disabledReason={disabledReason(view)}
                                    modelOptions={stageModelOptions[view.id] || modelOptions}
                                    model={stageModels[view.id] || ""}
                                    templates={templates}
                                    regeneratingItem={regeneratingItem}
                                    onModelChange={(value) => setStageModel(view.id, value)}
                                    onRun={() => void runStage(view.id)}
                                    onRerun={() => void runStage(view.id, { resume: resumableChunks(view) > 0 })}
                                    onCancel={() => void cancelStage(view.id)}
                                    onRegenerate={regenerateItem}
                                    onRefresh={() => void refresh()}
                                    onOpenProjects={() => navigate("/projects")}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </main>

            <Modal
                open={Boolean(renaming)}
                title="重命名流水线"
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                onOk={saveRenaming}
                onCancel={() => setRenaming(null)}
            >
                <Input value={renaming?.title || ""} maxLength={30} placeholder="输入流水线名称" onChange={(event) => renaming && setRenaming({ ...renaming, title: event.target.value })} onPressEnter={saveRenaming} />
                <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">仅修改本地历史记录中的名称，不会同步到后端。</div>
            </Modal>
        </div>
    );
}

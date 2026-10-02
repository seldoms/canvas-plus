import { Button, Input, Modal, Select } from "antd";
import { FileText, RefreshCw, Sparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { StageCard } from "./components/stage-card";
import { usePipelineRun, type PipelineStageView } from "./use-pipeline-run";

const TEXT_FILE_RE = /\.(txt|md|markdown|srt|ass|csv|json|text)$/i;

async function readNovelFiles(files: File[]) {
    const accepted = files.filter((file) => TEXT_FILE_RE.test(file.name) || file.type.startsWith("text/"));
    const sorted = [...accepted].sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const parts = await Promise.all(sorted.map(async (file) => `【${file.name}】\n${(await file.text()).trim()}`));
    return { names: sorted.map((file) => file.name), text: parts.join("\n\n"), rejected: files.length - accepted.length };
}

export default function PipelinePage() {
    const { t } = useTranslation();
    const { novel, setNovel, run, views, starting, busyStage, error, startScript, runStage, saveStageOutput, refresh, modelOptions, stageModels, setStageModel } = usePipelineRun();
    const [editing, setEditing] = useState<{ id: string; title: string; text: string; error: string } | null>(null);
    const [imported, setImported] = useState<{ names: string[]; rejected: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const statusById = useMemo(() => new Map(views.map((view) => [view.id, view.status])), [views]);
    const titleById = useMemo(() => new Map(views.map((view) => [view.id, view.title])), [views]);

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

    const disabledReason = (view: PipelineStageView) => {
        if (!run) return t("pipeline.needRun");
        if (busyStage) return t("pipeline.busy");
        const missing = view.requires.filter((id) => statusById.get(id) !== "done");
        if (missing.length) return t("pipeline.needPrevious", { stages: missing.map((id) => titleById.get(id) || id).join("、") });
        return "";
    };

    const openEditor = (view: PipelineStageView) => setEditing({ id: view.id, title: view.title, text: JSON.stringify(view.stage?.output ?? null, null, 2), error: "" });

    const saveEditing = async () => {
        if (!editing) return;
        let output: unknown;
        try {
            output = JSON.parse(editing.text);
        } catch {
            setEditing({ ...editing, error: t("pipeline.invalidJson") });
            return;
        }
        if (await saveStageOutput(editing.id, output)) setEditing(null);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
                <div className="mx-auto max-w-5xl">
                    <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("pipeline.title")}</h1>
                    <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("pipeline.description")}</p>

                    <div className="mt-5">
                        <div
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                                event.preventDefault();
                                if (!run) void importFiles(Array.from(event.dataTransfer.files));
                            }}
                        >
                            <Input.TextArea rows={5} value={novel} disabled={Boolean(run)} placeholder={t("pipeline.novelPlaceholder")} onChange={(event) => setNovel(event.target.value)} />
                        </div>
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
                            <Button type="primary" icon={<Sparkles className="size-4" />} loading={starting} disabled={!novel.trim() || Boolean(run)} onClick={() => void startScript()}>
                                {t("pipeline.start")}
                            </Button>
                            {!run ? (
                                <Select
                                    size="middle"
                                    value={stageModels.script || ""}
                                    onChange={(value) => setStageModel("script", value)}
                                    style={{ minWidth: 220 }}
                                    placeholder={t("pipeline.modelLoadFailed")}
                                    options={modelOptions}
                                />
                            ) : null}
                            <Button icon={<FileText className="size-4" />} disabled={Boolean(run)} onClick={() => fileInputRef.current?.click()}>
                                {t("pipeline.importFiles")}
                            </Button>
                            {run ? (
                                <Button type="text" icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>
                                    {t("pipeline.refresh")}
                                </Button>
                            ) : null}
                            {run ? <span className="text-xs text-stone-500 dark:text-stone-400">{run.title || run.id}</span> : null}
                        </div>
                        {imported?.names.length ? <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">📄 {t("pipeline.filesImported", { count: imported.names.length, names: imported.names.join("、") })}</div> : null}
                        {imported?.rejected ? <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("pipeline.filesRejected", { count: imported.rejected })}</div> : null}
                        {error ? <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
                    </div>

                    <div className="mt-6 divide-y divide-stone-200/70 dark:divide-stone-800/70">
                        {views.map((view, index) => (
                            <StageCard
                                key={view.id}
                                index={index}
                                view={view}
                                busy={busyStage === view.id}
                                disabledReason={disabledReason(view)}
                                modelOptions={modelOptions}
                                model={stageModels[view.id] || ""}
                                onModelChange={(value) => setStageModel(view.id, value)}
                                onRun={() => void runStage(view.id)}
                                onRerun={() => void runStage(view.id)}
                                onEdit={() => openEditor(view)}
                            />
                        ))}
                    </div>
                </div>
            </main>

            <Modal
                open={Boolean(editing)}
                title={editing ? t("pipeline.editTitle", { stage: editing.title }) : ""}
                width={760}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                confirmLoading={busyStage === editing?.id}
                onOk={() => void saveEditing()}
                onCancel={() => setEditing(null)}
            >
                <Input.TextArea rows={18} value={editing?.text || ""} className="font-mono text-xs" onChange={(event) => editing && setEditing({ ...editing, text: event.target.value, error: "" })} />
                {editing?.error ? <div className="mt-2 text-xs text-red-600 dark:text-red-400">{editing.error}</div> : null}
            </Modal>
        </div>
    );
}

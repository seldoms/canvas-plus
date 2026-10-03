import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Alert, App, Button, Empty, Modal, Spin, Switch } from "antd";
import { useTranslation } from "react-i18next";

import type { ProjectCreateInput, ProjectSummary } from "@/services/api/projects";

import { CreateProjectModal } from "./components/create-project-modal";
import { ProjectCard } from "./components/project-card";
import type { ProjectSourceSubmit } from "./components/source-input";
import { useProjectList } from "./hooks/use-project-list";

/** 项目列表页：只做编排（工具栏 + 列表区块），数据与动作来自 useProjectList。 */
export default function ProjectsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const { projects, includeArchived, setIncludeArchived, loading, error, refresh, create, archive, importSource } = useProjectList();
    const [createOpen, setCreateOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [archiving, setArchiving] = useState<ProjectSummary | null>(null);

    /** 先建项目，再（可选）把原文落成源版本；导入失败不回滚项目，单独提示。 */
    const handleCreate = async (input: ProjectCreateInput, source: ProjectSourceSubmit | null) => {
        setSubmitting(true);
        try {
            const project = await create(input);
            if (source) {
                try {
                    await importSource(project.id, source);
                    message.success(t("projects.source.createdWith"));
                } catch (sourceError) {
                    message.warning(t("projects.source.saveFailedAfterCreate", { message: sourceError instanceof Error ? sourceError.message : String(sourceError) }));
                }
            } else {
                message.success(t("projects.created"));
            }
            setCreateOpen(false);
        } catch (createError) {
            message.error(createError instanceof Error ? createError.message : t("projects.createFailed"));
        } finally {
            setSubmitting(false);
        }
    };

    const handleArchive = async () => {
        if (!archiving) return;
        try {
            await archive(archiving.id);
            message.success(t("projects.archived"));
            setArchiving(null);
        } catch (archiveError) {
            message.error(archiveError instanceof Error ? archiveError.message : t("projects.archiveFailed"));
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="mx-auto max-w-5xl text-center">
                    <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("projects.title")}</h1>
                    <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("projects.description")}</p>
                </div>

                <div className="mx-auto mt-8 flex max-w-7xl flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                            {t("projects.create")}
                        </Button>
                        <span className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
                            <Switch size="small" checked={includeArchived} onChange={setIncludeArchived} />
                            {t("projects.showArchived")}
                        </span>
                    </div>
                    <Button type="text" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                        {t("projects.refresh")}
                    </Button>
                </div>

                <div className="mx-auto mt-6 max-w-7xl">
                    {error ? (
                        <Alert
                            type="error"
                            showIcon
                            className="mb-5"
                            message={t("projects.loadFailed")}
                            description={error}
                            action={
                                <Button size="small" onClick={() => void refresh()}>
                                    {t("projects.retry")}
                                </Button>
                            }
                        />
                    ) : null}

                    {loading && !projects.length ? (
                        <div className="flex justify-center py-24">
                            <Spin />
                        </div>
                    ) : null}

                    {!loading && !error && !projects.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.empty")} className="py-24" /> : null}

                    {projects.length ? (
                        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {projects.map((project) => (
                                <ProjectCard key={project.id} project={project} onArchive={setArchiving} />
                            ))}
                        </div>
                    ) : null}
                </div>
            </main>

            <CreateProjectModal open={createOpen} submitting={submitting} onCancel={() => setCreateOpen(false)} onSubmit={(input, source) => void handleCreate(input, source)} />

            <Modal
                title={t("projects.archiveConfirmTitle")}
                open={Boolean(archiving)}
                okText={t("projects.archive")}
                okButtonProps={{ danger: true }}
                cancelText={t("common.cancel")}
                onCancel={() => setArchiving(null)}
                onOk={() => void handleArchive()}
            >
                {t("projects.archiveConfirm", { name: archiving?.title })}
            </Modal>
        </div>
    );
}

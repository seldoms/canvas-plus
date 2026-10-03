import { ArrowLeft, RefreshCw } from "lucide-react";
import { Alert, Button, Card, Descriptions, Empty, List, Spin, Tag, Typography } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { usePipelineStore } from "@/stores/use-pipeline-store";

import { WorkspaceEntries } from "./components/workspace-entries";
import { useProjectDetail } from "./hooks/use-project-detail";

/** 项目总览页骨架：一个 projectId 走 GET /context，汇总规划、集、运行、画布与检查表。 */
export default function ProjectOverviewPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { projectId = "" } = useParams();
    const { context, loading, error, refresh } = useProjectDetail(projectId);
    const project = context?.project;

    const openRun = (runId: string) => {
        usePipelineStore.getState().setActiveRun(runId);
        navigate("/pipeline");
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                <div className="mx-auto max-w-6xl">
                    <Button type="text" icon={<ArrowLeft className="size-4" />} className="!px-0" onClick={() => navigate("/projects")}>
                        {t("projects.detail.back")}
                    </Button>

                    {loading && !project ? (
                        <div className="flex justify-center py-24">
                            <Spin />
                        </div>
                    ) : null}

                    {error ? (
                        <Alert
                            type="error"
                            showIcon
                            className="mt-4"
                            message={t("projects.detail.loadFailed")}
                            description={error}
                            action={
                                <Button size="small" onClick={() => void refresh()}>
                                    {t("projects.retry")}
                                </Button>
                            }
                        />
                    ) : null}

                    {!loading && !error && !project ? <Empty className="py-24" description={t("projects.detail.notFound")} /> : null}

                    {project ? (
                        <div className="mt-4 space-y-6">
                            <div className="flex flex-wrap items-end justify-between gap-3">
                                <div>
                                    <h1 className="text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{project.title}</h1>
                                    <Typography.Text type="secondary" className="mt-2 block">
                                        {t("projects.detail.styleAnchor")}：{project.styleAnchor || t("projects.detail.styleAnchorEmpty")}
                                    </Typography.Text>
                                </div>
                                <Button type="text" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                                    {t("projects.refresh")}
                                </Button>
                            </div>

                            <section>
                                <Typography.Title level={5} className="!mb-3">
                                    {t("projects.detail.workspaces")}
                                </Typography.Title>
                                <WorkspaceEntries projectId={projectId} />
                            </section>

                            <section>
                                <Typography.Title level={5} className="!mb-3">
                                    {t("projects.detail.plan")}
                                </Typography.Title>
                                <Card size="small">
                                    <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} items={planItems(project.plan, t)} />
                                </Card>
                            </section>

                            <section>
                                <Typography.Title level={5} className="!mb-3">
                                    {t("projects.detail.episodes")}
                                </Typography.Title>
                                <Card size="small">
                                    {context?.episodes.length ? (
                                        <List
                                            size="small"
                                            dataSource={context.episodes}
                                            renderItem={(episode) => (
                                                <List.Item extra={<Tag>{episode.status}</Tag>}>
                                                    <span>
                                                        {episode.index}. {episode.title}
                                                    </span>
                                                </List.Item>
                                            )}
                                        />
                                    ) : (
                                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.detail.episodesEmpty")} />
                                    )}
                                </Card>
                            </section>

                            <div className="grid gap-6 lg:grid-cols-2">
                                <section>
                                    <Typography.Title level={5} className="!mb-3">
                                        {t("projects.detail.runs")}
                                    </Typography.Title>
                                    <Card size="small">
                                        {context?.runIds.length ? (
                                            <List
                                                size="small"
                                                dataSource={context.runIds}
                                                renderItem={(runId) => (
                                                    <List.Item
                                                        actions={[
                                                            <Button key="open" type="link" size="small" className="!px-0" onClick={() => openRun(runId)}>
                                                                {t("projects.detail.openRun")}
                                                            </Button>,
                                                        ]}
                                                    >
                                                        <span className="break-all">{runId}</span>
                                                    </List.Item>
                                                )}
                                            />
                                        ) : (
                                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.detail.runsEmpty")} />
                                        )}
                                    </Card>
                                </section>

                                <section>
                                    <Typography.Title level={5} className="!mb-3">
                                        {t("projects.detail.canvases")}
                                    </Typography.Title>
                                    <Card size="small">
                                        {context?.canvasIds.length ? (
                                            <List
                                                size="small"
                                                dataSource={context.canvasIds}
                                                renderItem={(canvasId) => (
                                                    <List.Item
                                                        actions={[
                                                            <Button key="open" type="link" size="small" className="!px-0" onClick={() => navigate(`/canvas/${canvasId}`)}>
                                                                {t("projects.detail.openCanvas")}
                                                            </Button>,
                                                        ]}
                                                    >
                                                        <span className="break-all">{canvasId}</span>
                                                    </List.Item>
                                                )}
                                            />
                                        ) : (
                                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.detail.canvasesEmpty")} />
                                        )}
                                    </Card>
                                </section>
                            </div>

                            <section>
                                <Typography.Title level={5} className="!mb-3">
                                    {t("projects.detail.checklist")}
                                </Typography.Title>
                                <Card size="small">
                                    {project.checklist.length ? (
                                        <List size="small" dataSource={project.checklist} renderItem={(item) => <List.Item>{item.done ? "☑" : "☐"} {item.label}</List.Item>} />
                                    ) : (
                                        <Typography.Text type="secondary">{t("projects.detail.checklistEmpty")}</Typography.Text>
                                    )}
                                </Card>
                            </section>

                            <section>
                                <Typography.Title level={5} className="!mb-3">
                                    {t("projects.detail.reviewNotes")}
                                </Typography.Title>
                                <Card size="small">
                                    {project.reviewNotes.length ? (
                                        <List size="small" dataSource={project.reviewNotes} renderItem={(note) => <List.Item>{note.message}</List.Item>} />
                                    ) : (
                                        <Typography.Text type="secondary">{t("projects.detail.reviewNotesEmpty")}</Typography.Text>
                                    )}
                                </Card>
                            </section>
                        </div>
                    ) : null}
                </div>
            </main>
        </div>
    );
}

/** 把规划参数摊成 Descriptions items；空值显示「未设置」。 */
function planItems(plan: { genre: string; tone: string; ratio: string; episodeDurationSec: number; dramaMode: string; audience: string; episodeCount: number }, t: (key: string) => string) {
    const value = (input: string | number) => (input === "" || input === undefined || input === null ? t("projects.detail.styleAnchorEmpty") : String(input));
    return [
        { key: "genre", label: t("projects.form.genre"), children: value(plan.genre) },
        { key: "tone", label: t("projects.form.tone"), children: value(plan.tone) },
        { key: "ratio", label: t("projects.form.ratio"), children: value(plan.ratio) },
        { key: "dramaMode", label: t("projects.form.dramaMode"), children: value(plan.dramaMode) },
        { key: "episodeDurationSec", label: t("projects.form.episodeDurationSec"), children: value(plan.episodeDurationSec) },
        { key: "episodeCount", label: t("projects.form.episodeCount"), children: value(plan.episodeCount) },
        { key: "audience", label: t("projects.form.audience"), children: value(plan.audience) },
    ];
}

import { Button, Card, Empty, List, Tag, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { ProjectContext } from "@/services/api/projects";
import { usePipelineStore } from "@/stores/use-pipeline-store";

/**
 * 「关联资源」面板：把 context 里的集列表、关联 run、画布入口原样列出。
 * run / 画布只跳转到既有 `/pipeline`、`/canvas/:id`，不在这里重做编辑能力。
 */
export function WorkspaceResources({ context, activeRunId }: { context: ProjectContext; activeRunId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const openRun = (runId: string) => {
        usePipelineStore.getState().setActiveRun(runId);
        navigate("/pipeline");
    };

    return (
        <section>
            <Typography.Title level={5} className="!mb-2">
                {t("projects.workspace.resourcesTitle")}
            </Typography.Title>
            <div className="grid gap-6 lg:grid-cols-3">
                <Card size="small" title={t("projects.workspace.facts.episodes")}>
                    {context.episodes.length ? (
                        <List
                            size="small"
                            dataSource={context.episodes}
                            renderItem={(episode) => (
                                <List.Item extra={<Tag>{episode.status}</Tag>}>
                                    {episode.index}. {episode.title}
                                </List.Item>
                            )}
                        />
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.detail.episodesEmpty")} />
                    )}
                </Card>

                <Card size="small" title={t("projects.workspace.facts.runs")}>
                    {context.runIds.length ? (
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
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className={`break-all ${runId === activeRunId ? "font-medium text-stone-950 dark:text-stone-100" : ""}`}>{runId}</span>
                                        {runId === activeRunId ? (
                                            <Tag color="blue" className="!mr-0 shrink-0">
                                                {t("projects.workspace.runSelector.current")}
                                            </Tag>
                                        ) : null}
                                    </div>
                                </List.Item>
                            )}
                        />
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("projects.detail.runsEmpty")} />
                    )}
                </Card>

                <Card size="small" title={t("projects.workspace.facts.canvases")}>
                    {context.canvasIds.length ? (
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
            </div>
        </section>
    );
}

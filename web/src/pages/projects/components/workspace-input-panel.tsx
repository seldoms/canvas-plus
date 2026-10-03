import { Card, Descriptions, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { ProjectContext } from "@/services/api/projects";

import type { StageStatusMap } from "../workspace-gates";
import type { WorkspaceDef } from "../workspaces";
import { StageStatusTag } from "./stage-status-tag";

/**
 * 「当前输入」面板：把 `GET /context` 里的项目事实原样摊开展示，不推算、不补默认值。
 * 上游阶段状态来自 workspace-gates 的临时推导（见该文件说明）。
 */
export function WorkspaceInputPanel({ context, workspace, stageStatus }: { context: ProjectContext; workspace: WorkspaceDef; stageStatus: StageStatusMap }) {
    const { t } = useTranslation();
    const { project, episodes } = context;
    const { plan } = project;
    const planText = [plan.genre, plan.tone, plan.ratio, plan.episodeDurationSec ? t("common.durationSeconds", { seconds: plan.episodeDurationSec }) : ""].filter(Boolean).join(" · ");
    const checklistDone = project.checklist.filter((item) => item.done).length;

    return (
        <section>
            <Typography.Title level={5} className="!mb-3">
                {t("projects.workspace.inputTitle")}
            </Typography.Title>
            <Card size="small">
                <Typography.Paragraph type="secondary" className="!mb-4">
                    {t(`projects.workspace.input.${workspace.key}`)}
                </Typography.Paragraph>
                <Descriptions
                    size="small"
                    column={{ xs: 1, sm: 2 }}
                    items={[
                        { key: "styleAnchor", label: t("projects.workspace.facts.styleAnchor"), children: project.styleAnchor || t("projects.detail.styleAnchorEmpty") },
                        { key: "plan", label: t("projects.workspace.facts.plan"), children: planText || t("projects.detail.styleAnchorEmpty") },
                        { key: "episodes", label: t("projects.workspace.facts.episodes"), children: t("projects.workspace.facts.episodeCount", { count: episodes.length }) },
                        { key: "script", label: t("projects.workspace.facts.script"), children: project.script ? t("projects.workspace.facts.scriptReady") : t("projects.workspace.facts.scriptMissing") },
                        { key: "checklist", label: t("projects.workspace.facts.checklist"), children: t("projects.card.checklist", { done: checklistDone, total: project.checklist.length }) },
                    ]}
                />
                {workspace.requires.length ? (
                    <div className="mt-4">
                        <Typography.Text type="secondary" className="text-xs">
                            {t("projects.workspace.facts.upstream")}
                        </Typography.Text>
                        <Space wrap className="mt-1">
                            {workspace.requires.map((stage) => (
                                <span key={stage} className="inline-flex items-center gap-1 text-sm">
                                    {t(`pipeline.stages.${stage}`)}
                                    {stageStatus[stage] ? <StageStatusTag status={stageStatus[stage]} /> : <Tag>{t("projects.workspace.gate.notRun")}</Tag>}
                                </span>
                            ))}
                        </Space>
                    </div>
                ) : null}
            </Card>
        </section>
    );
}

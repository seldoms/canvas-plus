import { Alert, Button, Card, Space, Spin, Typography } from "antd";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { ProjectGate } from "@/services/api/projects";

import { resolveNextStep, type StageStatusMap } from "../workspace-gates";
import { WORKSPACES, type WorkspaceKey, workspacePath } from "../workspaces";

/**
 * 总览页「下一步」引导：按服务端 /gates 的结果指出当前该做什么、为什么还不能做下一步。
 * 判定逻辑在 workspace-gates.resolveNextStep（纯函数）；本组件只渲染 + 提供跳转入口。
 */
export function NextStepPanel({ projectId, gates, gatesLoading, stageStatus }: { projectId: string; gates: ProjectGate[]; gatesLoading: boolean; stageStatus: StageStatusMap }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const next = resolveNextStep(gates, stageStatus);
    const stageName = (stage: string) => t(`pipeline.stages.${stage}`);
    const workspaceKey = next ? WORKSPACES.find((item) => item.stage === next.stage)?.key : undefined;

    const reason = () => {
        if (!next) return "";
        if (next.reason) return next.reason;
        if (next.blockedStages.length) return next.blockedStages.map((stage) => t("projects.workspace.gate.blockedStage", { stage: stageName(stage) })).join(" ");
        return t("projects.nextStep.unknown");
    };

    return (
        <section>
            <Typography.Title level={5} className="!mb-3">
                {t("projects.nextStep.title")}
            </Typography.Title>
            <Card size="small">
                {gatesLoading && !next ? (
                    <Spin />
                ) : !next ? (
                    <Alert type="success" showIcon message={t("projects.nextStep.allDone")} />
                ) : (
                    <Space direction="vertical" size={10} className="w-full">
                        <Alert
                            type={next.runnable ? "success" : "warning"}
                            showIcon
                            message={t("projects.nextStep.action", { stage: stageName(next.stage) })}
                            description={next.runnable ? t("projects.nextStep.runnable") : reason()}
                        />
                        <Typography.Text type="secondary" className="!text-xs">
                            {t(next.source === "server" ? "projects.workspace.gate.sourceServer" : "projects.workspace.gate.sourceFallback")}
                        </Typography.Text>
                        {workspaceKey ? (
                            <Button type="primary" size="small" icon={<ArrowRight className="size-4" />} onClick={() => navigate(workspacePath(projectId, workspaceKey as WorkspaceKey))}>
                                {t("projects.nextStep.open", { stage: stageName(next.stage) })}
                            </Button>
                        ) : null}
                    </Space>
                )}
            </Card>
        </section>
    );
}

import { Alert, Button, Card, Space, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { usePipelineStore } from "@/stores/use-pipeline-store";
import type { ReviewNote } from "@/types/domain";

import { evaluateGate, stagesWithStatus, type StageStatusMap } from "../workspace-gates";
import type { WorkspaceDef } from "../workspaces";

/**
 * 「待确认」面板：显式呈现门禁结果 —— 上游未 done 时写明「请先完成 XX 阶段」，
 * 有阻断级风险提示时列出，读不到阶段状态时如实说明并标注临时性（等待服务端 stageGates）。
 */
export function WorkspaceGatePanel({
    workspace,
    stageStatus,
    hasRunInfo,
    blockingNotes,
    runsLoading,
    runsError,
    runIds,
}: {
    workspace: WorkspaceDef;
    stageStatus: StageStatusMap;
    hasRunInfo: boolean;
    blockingNotes: ReviewNote[];
    runsLoading: boolean;
    runsError: string;
    runIds: string[];
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const gate = evaluateGate(workspace.requires, stageStatus, hasRunInfo, blockingNotes.length);
    const running = stagesWithStatus(stageStatus, ["running", "partial"]);
    const failed = stagesWithStatus(stageStatus, ["error", "canceled"]);
    const stageName = (stage: string) => t(`pipeline.stages.${stage}`);

    const openPipeline = () => {
        if (runIds.length) usePipelineStore.getState().setActiveRun(runIds[0]);
        navigate("/pipeline");
    };

    return (
        <section>
            <Typography.Title level={5} className="!mb-3">
                {t("projects.workspace.gateTitle")}
            </Typography.Title>
            <Card size="small">
                <Space direction="vertical" size={12} className="w-full">
                    {gate.state === "blocked" ? (
                        <Alert
                            type="warning"
                            showIcon
                            message={t("projects.workspace.gate.blocked")}
                            description={
                                <ul className="list-disc pl-4">
                                    {gate.blockedStages.map((stage) => (
                                        <li key={stage}>{t("projects.workspace.gate.blockedStage", { stage: stageName(stage) })}</li>
                                    ))}
                                    {gate.blockedByNotes ? <li>{t("projects.workspace.gate.blockedNotes", { count: blockingNotes.length })}</li> : null}
                                </ul>
                            }
                        />
                    ) : null}
                    {gate.state === "ready" ? <Alert type="success" showIcon message={t("projects.workspace.gate.ready")} /> : null}
                    {gate.state === "unknown" ? <Alert type="info" showIcon message={t("projects.workspace.gate.unknown")} /> : null}
                    {runsError ? <Alert type="warning" showIcon message={t("projects.workspace.gate.runsError")} description={runsError} /> : null}
                    {running.length ? <Typography.Text type="secondary">{t("projects.workspace.gate.running", { stages: running.map(stageName).join("、") })}</Typography.Text> : null}
                    {failed.length ? <Typography.Text type="warning">{t("projects.workspace.gate.failed", { stages: failed.map(stageName).join("、") })}</Typography.Text> : null}
                    <Space wrap align="center">
                        <Button type="primary" onClick={openPipeline} loading={runsLoading}>
                            {t("projects.workspace.actions.openPipeline")}
                        </Button>
                        <Typography.Text type="secondary" className="text-xs">
                            {t("projects.workspace.actions.pending")}
                        </Typography.Text>
                    </Space>
                </Space>
            </Card>
        </section>
    );
}

import { Alert, Button, Card, Space, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { usePipelineStore } from "@/stores/use-pipeline-store";
import type { ReviewNote } from "@/types/domain";

import { stagesWithStatus, type StageStatusMap, type WorkspaceGate } from "../workspace-gates";
import type { WorkspaceDef } from "../workspaces";

/**
 * 「待确认」面板：显式呈现门禁结果。
 * 门禁结论由 workspace-gates.resolveWorkspaceGate 得出（服务端 /gates 优先，回退前端推导），
 * 本面板只负责渲染 + 标注来源。阻断时写明被阻断的上游阶段与服务端原因。
 */
export function WorkspaceGatePanel({
    workspace,
    gate,
    stageStatus,
    blockingNotes,
    runsLoading,
    runsError,
    activeRunId,
}: {
    workspace: WorkspaceDef;
    gate: WorkspaceGate;
    stageStatus: StageStatusMap;
    blockingNotes: ReviewNote[];
    runsLoading: boolean;
    runsError: string;
    /** 当前选中的 run（多 run 时由工作区选择器切换，默认第一个）；打开流水线时定位到它。 */
    activeRunId: string;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const running = stagesWithStatus(stageStatus, ["running", "partial"]);
    const failed = stagesWithStatus(stageStatus, ["error", "canceled"]);
    const stageBlocked = stagesWithStatus(stageStatus, ["blocked"]);
    const stageName = (stage: string) => t(`pipeline.stages.${stage}`);

    const openPipeline = () => {
        if (activeRunId) usePipelineStore.getState().setActiveRun(activeRunId);
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
                                    {gate.reason ? <li>{t("projects.workspace.gate.serverReason", { reason: gate.reason })}</li> : null}
                                </ul>
                            }
                        />
                    ) : null}
                    {gate.state === "ready" ? <Alert type="success" showIcon message={t(workspace.editable ? "projects.workspace.gate.readyEditable" : "projects.workspace.gate.ready")} /> : null}
                    {gate.state === "unknown" ? <Alert type="info" showIcon message={t("projects.workspace.gate.unknown")} /> : null}
                    {runsError ? <Alert type="warning" showIcon message={t("projects.workspace.gate.runsError")} description={runsError} /> : null}
                    {running.length ? <Typography.Text type="secondary">{t("projects.workspace.gate.running", { stages: running.map(stageName).join("、") })}</Typography.Text> : null}
                    {failed.length ? <Typography.Text type="warning">{t("projects.workspace.gate.failed", { stages: failed.map(stageName).join("、") })}</Typography.Text> : null}
                    {stageBlocked.length ? <Typography.Text type="warning">{t("projects.workspace.gate.blockedStages", { stages: stageBlocked.map(stageName).join("、") })}</Typography.Text> : null}
                    <Space wrap align="center">
                        <Button type="primary" onClick={openPipeline} loading={runsLoading}>
                            {t("projects.workspace.actions.openPipeline")}
                        </Button>
                    </Space>
                </Space>
            </Card>
        </section>
    );
}

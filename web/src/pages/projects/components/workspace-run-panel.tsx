import { Alert, Button, Card, Space, Typography } from "antd";
import { GitBranch, Play, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { GatewayStageProgress } from "@/services/api/gateway";

import { StageSteps } from "@/pages/pipeline/components/stage-steps";

import { canRunStage, type WorkspaceGate } from "../workspace-gates";
import type { WorkspaceDef } from "../workspaces";

function formatDuration(ms: number) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/**
 * 「运行本阶段」面板：在每个可跑的工作区提供项目内直接跑对应阶段的入口。
 * 门禁由 workspace-gates.canRunStage 判定（上游未就绪 / 状态未确认一律置灰，不绕过门禁）；
 * 运行中复用进度轮询，可取消；文案全部走 i18n，页面只编排。
 */
export function WorkspaceRunPanel({
    workspace,
    gate,
    hasRun,
    starting,
    running,
    progress,
    error,
    notice,
    onRun,
    onCancel,
    onBranch,
}: {
    workspace: WorkspaceDef;
    gate: WorkspaceGate;
    hasRun: boolean;
    starting: boolean;
    running: boolean;
    progress: GatewayStageProgress | null;
    error: string;
    notice: string;
    onRun: () => void;
    onCancel: () => void;
    onBranch: () => void;
}) {
    const { t } = useTranslation();
    if (!workspace.stage) return null;
    const stageName = (stage: string) => t(`pipeline.stages.${stage}`);
    const allowed = canRunStage(workspace, gate);
    const ownProgress = progress && progress.stage === workspace.stage ? progress : null;
    const total = Number(ownProgress?.total) || 0;
    const done = Number(ownProgress?.done) || 0;
    // 01 剧本多步：步骤条来自轻量 progress.steps（项目工作区不拉全量 run，故只展示步骤状态/细节）。
    const steps = ownProgress && Array.isArray(ownProgress.steps) ? ownProgress.steps : [];

    const blockedReason = () => {
        if (gate.state !== "blocked") return t("projects.workspace.run.gateUnknown");
        const parts = gate.blockedStages.map((stage) => t("projects.workspace.gate.blockedStage", { stage: stageName(stage) }));
        if (gate.reason) parts.push(t("projects.workspace.gate.serverReason", { reason: gate.reason }));
        return parts.join(" ") || t("projects.workspace.gate.blocked");
    };

    return (
        <section>
            <Typography.Title level={5} className="!mb-2">
                {t("projects.workspace.run.title")}
            </Typography.Title>
            <Card size="small">
                <Space direction="vertical" size={12} className="w-full">
                    {!allowed ? <Alert type="warning" showIcon message={t("projects.workspace.run.gateBlocked")} description={blockedReason()} /> : null}

                    {ownProgress && running ? (
                        <div className="space-y-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-stone-600 dark:text-stone-300">
                                <span className="font-medium">{t(`pipeline.progress.${ownProgress.phase}`)}</span>
                                {total > 1 ? <span>{t("pipeline.progress.chunks", { done, total })}</span> : null}
                                {Number(ownProgress.etaMs) > 0 ? <span>{t("pipeline.progress.eta", { time: formatDuration(Number(ownProgress.etaMs)) })}</span> : null}
                            </div>
                            {total > 1 ? (
                                <div className="h-1 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                                    <div className="h-full rounded-full bg-amber-500 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.round((done / total) * 100))}%` }} />
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {steps.length ? <StageSteps steps={steps} /> : null}

                    {notice ? <Alert type="warning" showIcon message={notice} /> : null}
                    {error ? <Alert type="error" showIcon message={t("projects.workspace.run.failed")} description={error} /> : null}

                    <Space wrap align="center">
                        {running ? (
                            <Button danger icon={<XCircle className="size-4" />} onClick={onCancel}>
                                {t("projects.workspace.run.cancel")}
                            </Button>
                        ) : (
                            <Button type="primary" icon={<Play className="size-4" />} loading={starting} disabled={!allowed || starting} onClick={onRun}>
                                {hasRun ? t("projects.workspace.run.run", { stage: stageName(workspace.stage) }) : t("projects.workspace.run.startNew")}
                            </Button>
                        )}
                        {hasRun && !running ? (
                            <Button icon={<GitBranch className="size-4" />} disabled={!allowed || starting} onClick={onBranch}>
                                {t("projects.workspace.run.branch", { stage: stageName(workspace.stage) })}
                            </Button>
                        ) : null}
                        {hasRun ? null : <Typography.Text type="secondary" className="text-xs">{t("projects.workspace.run.noRun")}</Typography.Text>}
                    </Space>
                </Space>
            </Card>
        </section>
    );
}

import { Card, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { ProjectContext } from "@/services/api/projects";
import type { GatewayStageStatus } from "@/services/api/gateway";

import type { StageStatusMap } from "../workspace-gates";
import type { WorkspaceDef } from "../workspaces";

/**
 * 状态点颜色：与 stage-status-tag.tsx 的 COLORS 语义一一对应（blocked 同样沿用紫色）。
 * 只把「彩色小圆点 + 值」塞进紧凑信息条，阶段级 blocked 的原因/条目展示仍在
 * process-timeline / workspace-gate-panel / keyframe-board 里，本文件不碰。
 */
const DOT_COLORS: Record<GatewayStageStatus, string> = {
    pending: "bg-stone-400 dark:bg-stone-500",
    running: "bg-blue-500",
    partial: "bg-amber-500",
    done: "bg-emerald-500",
    error: "bg-red-500",
    blocked: "bg-violet-500",
    canceled: "bg-stone-400 dark:bg-stone-500",
};

/** 信息条里的一个「小写标签 + 值」组；标签与值同排，不再左右分开拉空。 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <span className="inline-flex items-baseline gap-1.5">
            <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">{label}</span>
            <span className="text-sm text-stone-800 dark:text-stone-200">{children}</span>
        </span>
    );
}

/** 状态点：完整文字走 title / aria-label，画面上只占一个小圆点。 */
function StatusDot({ tone, text }: { tone: GatewayStageStatus | "confirmed" | "empty"; text: string }) {
    const color = tone === "confirmed" ? "bg-emerald-500" : tone === "empty" ? "bg-stone-400 dark:bg-stone-500" : DOT_COLORS[tone];
    return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} role="img" aria-label={text} title={text} />;
}

/**
 * 「当前输入」信息条：把 `GET /context` 里的项目事实压成一行多组「标签 值」，
 * 用 flex-wrap 在窄屏自然折行。状态一律「圆点 + 值」，完整文字走 title / aria-label。
 */
export function WorkspaceInputPanel({ context, workspace, stageStatus }: { context: ProjectContext; workspace: WorkspaceDef; stageStatus: StageStatusMap }) {
    const { t } = useTranslation();
    const { project, episodes } = context;
    const { plan } = project;
    const planText = [plan.genre, plan.tone, plan.visualStyle, plan.ratio, plan.episodeDurationSec ? t("common.durationSeconds", { seconds: plan.episodeDurationSec }) : ""].filter(Boolean).join(" · ");
    const checklistDone = project.checklist.filter((item) => item.done).length;
    const checklistTotal = project.checklist.length;
    const checklistTone: GatewayStageStatus | "confirmed" | "empty" = checklistTotal > 0 && checklistDone === checklistTotal ? "confirmed" : checklistDone > 0 ? "partial" : "empty";
    const scriptText = project.script ? t("projects.workspace.facts.scriptReady") : t("projects.workspace.facts.scriptMissing");

    return (
        <section>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.workspace.inputTitle")}
                </Typography.Title>
                <Typography.Text type="secondary" className="!text-xs">
                    {t(`projects.workspace.input.${workspace.key}`)}
                </Typography.Text>
            </div>
            <Card size="small" className="mt-2 [&_.ant-card-body]:!p-3">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                    <Fact label={t("projects.workspace.facts.styleAnchor")}>
                        <span className="break-words">{project.styleAnchor || t("projects.detail.styleAnchorEmpty")}</span>
                    </Fact>
                    <Fact label={t("projects.workspace.facts.plan")}>{planText || t("projects.detail.styleAnchorEmpty")}</Fact>
                    <Fact label={t("projects.workspace.facts.episodes")}>{episodes.length}</Fact>
                    <Fact label={t("projects.workspace.facts.script")}>
                        <span className="inline-flex items-center gap-1.5">
                            <StatusDot tone={project.script ? "confirmed" : "empty"} text={scriptText} />
                            {scriptText}
                        </span>
                    </Fact>
                    <Fact label={t("projects.workspace.facts.checklist")}>
                        <span className="inline-flex items-center gap-1.5">
                            <StatusDot tone={checklistTone} text={`${t("projects.workspace.facts.checklist")} ${checklistDone}/${checklistTotal}`} />
                            {checklistDone}/{checklistTotal}
                        </span>
                    </Fact>
                    {workspace.requires.length ? (
                        <Fact label={t("projects.workspace.facts.upstream")}>
                            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                                {workspace.requires.map((stage) => {
                                    const status = stageStatus[stage];
                                    const text = status ? t(`pipeline.status.${status}`) : t("projects.workspace.gate.notRun");
                                    return (
                                        <span key={stage} className="inline-flex items-center gap-1.5">
                                            <StatusDot tone={status ?? "pending"} text={text} />
                                            {t(`pipeline.stages.${stage}`)}
                                        </span>
                                    );
                                })}
                            </span>
                        </Fact>
                    ) : null}
                </div>
            </Card>
        </section>
    );
}

import { ArrowLeft, RefreshCw } from "lucide-react";
import { Alert, Button, Empty, Select, Spin, Typography } from "antd";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import type { ProjectContext, ProjectGate } from "@/services/api/projects";
import type { ReviewNote } from "@/types/domain";

import { resolveWorkspaceGate, type StageStatusMap } from "../workspace-gates";
import { WORKSPACES, workspacePath, type WorkspaceDef } from "../workspaces";
import { useProjectRun } from "../hooks/use-project-run";
import { WorkspaceGatePanel } from "./workspace-gate-panel";
import { WorkspaceInputPanel } from "./workspace-input-panel";
import { WorkspaceResources } from "./workspace-resources";
import { WorkspaceRunPanel } from "./workspace-run-panel";
import { ProcessTimeline } from "./process-timeline";

/**
 * run id 截断成短标签用于选择器（完整 id 走 option 的 title 悬浮提示）。
 */
function shortRunId(id: string) {
    const bare = id.replace(/^run-/, "");
    return bare.length > 12 ? `${bare.slice(0, 12)}…` : bare;
}

/**
 * 工作区外壳：项目内工作区导航 + 加载/错误态 + 「当前输入 / 待确认 / 关联资源」三块标准面板。
 * 各工作区页面只传自身 key 与（可选的）额外正文，编排逻辑集中在这里；
 * 门禁在此由 resolveWorkspaceGate 统一判定（服务端 /gates 优先，回退前端推导）。
 */
export function WorkspaceLayout({
    projectId,
    workspace,
    context,
    loading,
    error,
    refresh,
    stageStatus,
    hasRunInfo,
    blockingNotes,
    runsLoading,
    runsError,
    gates,
    gatesLoading,
    runIds,
    activeRunId,
    selectRun,
    children,
}: {
    projectId: string;
    workspace: WorkspaceDef;
    context: ProjectContext | null;
    loading: boolean;
    error: string;
    refresh: () => void;
    stageStatus: StageStatusMap;
    hasRunInfo: boolean;
    blockingNotes: ReviewNote[];
    runsLoading: boolean;
    runsError: string;
    gates: ProjectGate[];
    gatesLoading: boolean;
    /** 项目关联 run 清单（多 run 时供选择器列出）。 */
    runIds: string[];
    /** 当前选中的 run（默认第一个）；门禁、过程时间线、资源面板都跟随它。 */
    activeRunId: string;
    /** 会话内切换当前 run；刷新后回落第一个。 */
    selectRun: (id: string) => void;
    children?: ReactNode;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const project = context?.project;
    const gate = resolveWorkspaceGate(workspace, stageStatus, hasRunInfo, blockingNotes.length, gates);
    const run = useProjectRun({ projectId, stage: workspace.stage, context, stageStatus, refresh });

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                <div className="mx-auto max-w-6xl">
                    <Button type="text" icon={<ArrowLeft className="size-4" />} className="!px-0" onClick={() => navigate(`/projects/${projectId}`)}>
                        {t("projects.workspace.back")}
                    </Button>

                    <nav className="mt-4 flex flex-wrap gap-1 border-b border-stone-200 pb-2 dark:border-stone-800">
                        {WORKSPACES.map(({ key, icon: Icon }) => (
                            <Link
                                key={key}
                                to={workspacePath(projectId, key)}
                                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                                    key === workspace.key
                                        ? "bg-black/5 font-medium text-stone-950 dark:bg-white/10 dark:text-stone-100"
                                        : "text-stone-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
                                }`}
                            >
                                <Icon className="size-4" />
                                {t(`projects.workspace.${key}`)}
                            </Link>
                        ))}
                    </nav>

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
                                <Button size="small" onClick={refresh}>
                                    {t("projects.retry")}
                                </Button>
                            }
                        />
                    ) : null}

                    {!loading && !error && !project ? <Empty className="py-24" description={t("projects.detail.notFound")} /> : null}

                    {project && context ? (
                        <div className="mt-4 space-y-6">
                            <div className="flex flex-wrap items-end justify-between gap-3">
                                <div>
                                    <Typography.Text type="secondary">{project.title}</Typography.Text>
                                    <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t(`projects.workspace.${workspace.key}`)}</h1>
                                </div>
                                <div className="flex items-center gap-3">
                                    {runIds.length > 1 ? (
                                        <div className="flex items-center gap-2 whitespace-nowrap">
                                            <Typography.Text type="secondary" className="!text-xs">
                                                {t("projects.workspace.runSelector.label")}
                                            </Typography.Text>
                                            <Select
                                                size="small"
                                                value={activeRunId}
                                                onChange={selectRun}
                                                popupMatchSelectWidth={false}
                                                className="min-w-36"
                                                aria-label={t("projects.workspace.runSelector.label")}
                                                options={runIds.map((id, index) => ({
                                                    value: id,
                                                    title: id,
                                                    label: t("projects.workspace.runSelector.option", { index: index + 1, id: shortRunId(id) }),
                                                }))}
                                            />
                                        </div>
                                    ) : null}
                                    <Button type="text" icon={<RefreshCw className="size-4" />} loading={loading || runsLoading || gatesLoading} onClick={refresh}>
                                        {t("projects.refresh")}
                                    </Button>
                                </div>
                            </div>
                            <WorkspaceInputPanel context={context} workspace={workspace} stageStatus={stageStatus} />
                            <WorkspaceGatePanel
                                workspace={workspace}
                                gate={gate}
                                stageStatus={stageStatus}
                                blockingNotes={blockingNotes}
                                runsLoading={runsLoading}
                                runsError={runsError}
                                activeRunId={activeRunId}
                            />
                            <WorkspaceRunPanel
                                workspace={workspace}
                                gate={gate}
                                hasRun={run.hasRun}
                                starting={run.starting}
                                running={run.running}
                                progress={run.progress}
                                error={run.error}
                                notice={run.notice}
                                onRun={() => void run.start()}
                                onCancel={() => void run.cancel()}
                            />
                            <ProcessTimeline
                                projectId={projectId}
                                runId={activeRunId}
                                assetRefs={context.project.assetRefs ?? []}
                                gates={gates}
                                gatesLoading={gatesLoading}
                                stageStatus={stageStatus}
                            />
                            <WorkspaceResources context={context} activeRunId={activeRunId} />
                            {children}
                        </div>
                    ) : null}
                </div>
            </main>
        </div>
    );
}

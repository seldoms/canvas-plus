import { useCallback, useMemo, useState } from "react";
import { App, Button, Space, Spin, Steps, Typography } from "antd";
import { ArrowRight, Check, FolderPlus, LayoutList, Maximize2, Sparkles } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { attachCanvasRef } from "@/services/api/projects";
import { usePipelineStore } from "@/stores/use-pipeline-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

import { resolveJourney, type JourneyInput, type JourneyStep } from "../project-journey";
import { WORKSPACES, type WorkspaceKey, workspacePath } from "../workspaces";

/**
 * 项目主线引导卡（P0 串联引导，skeleton §6 P0）。
 *
 * 五步主线：原文/剧本 → 拆解画布 → 开启流水线 → 逐阶段生产 → 导出交付。
 * 判定来自 `project-journey.resolveJourney`（纯函数，有单测），本组件只负责渲染与接真实动作：
 * 「创建拆解画布」会真的在本地画布存储里建一张、绑定到本项目、并在服务端登记 canvasIds，
 * 然后跳进画布页——不是占位按钮。
 */
export function ProjectJourneyPanel({ input }: { input: JourneyInput }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { projectId = "" } = useParams();
    const { message } = App.useApp();
    const [creating, setCreating] = useState(false);

    const steps = useMemo(() => resolveJourney(input), [input]);
    const current = steps.find((step) => step.active);
    const doneCount = steps.filter((step) => step.done).length;

    const openRun = useCallback(
        (runId: string) => {
            usePipelineStore.getState().setActiveRun(runId);
            navigate("/pipeline");
        },
        [navigate],
    );

    /** 第一跳：建一张本地画布 → 绑定本项目（本地 + 服务端两处）→ 进画布页。 */
    const createCanvas = useCallback(async () => {
        setCreating(true);
        try {
            const title = t("projects.journey.canvasTitle");
            const canvasId = useCanvasStore.getState().createProject(title);
            useCanvasStore.getState().updateProject(canvasId, { serverProjectId: projectId });
            await attachCanvasRef(projectId, canvasId);
            message.success(t("projects.journey.canvasCreated"));
            navigate(`/canvas/${encodeURIComponent(canvasId)}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setCreating(false);
        }
    }, [message, navigate, projectId, t]);

    const runAction = useCallback(
        (step: JourneyStep) => {
            switch (step.action) {
                case "openPlan":
                case "openWorkspace":
                case "openDelivery": {
                    const key = (step.actionTarget || "plan") as WorkspaceKey;
                    // stages 步骤的目标是流水线阶段 id，先映射回工作区；映射不到就直接去流水线页。
                    const workspace = WORKSPACES.find((item) => item.stage === step.actionTarget || item.key === key);
                    if (workspace) navigate(workspacePath(projectId, workspace.key));
                    else navigate("/pipeline");
                    return;
                }
                case "openCanvas": {
                    if (step.actionTarget) navigate(`/canvas/${encodeURIComponent(step.actionTarget)}`);
                    return;
                }
                case "createCanvas":
                    void createCanvas();
                    return;
                case "openPipeline": {
                    const firstRun = input.runIds[0];
                    if (firstRun) openRun(firstRun);
                    else navigate("/pipeline");
                    return;
                }
                default:
                    navigate("/pipeline");
            }
        },
        [createCanvas, input.runIds, navigate, openRun, projectId],
    );

    const actionLabel = (step: JourneyStep) => {
        if (step.action === "createCanvas") return t("projects.journey.createCanvas");
        if (step.action === "openCanvas") return t("projects.journey.openCanvas");
        if (step.action === "openPipeline") return t("projects.journey.openPipeline");
        if (step.action === "openDelivery") return t("projects.journey.openDelivery");
        return t("projects.journey.openStep", { step: t(`projects.journey.steps.${step.key}.title`) });
    };

    return (
        <section>
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <Typography.Title level={5} className="!mb-1">
                        {t("projects.journey.title")}
                    </Typography.Title>
                    <Typography.Text type="secondary" className="text-sm">
                        {t("projects.journey.hint")}
                    </Typography.Text>
                </div>
                <Typography.Text type="secondary" className="text-sm">
                    {t("projects.journey.progress", { done: doneCount, total: steps.length })}
                </Typography.Text>
            </div>

            <div className="mt-3">
                <Steps
                    size="small"
                    current={current ? doneCount : steps.length}
                    items={steps.map((step) => ({
                        title: t(`projects.journey.steps.${step.key}.title`),
                        description: t(`projects.journey.steps.${step.key}.desc`),
                        status: step.done ? "finish" : step.active ? "process" : "wait",
                        icon: step.done ? <Check className="size-3.5" /> : stepIcon(step.key),
                    }))}
                />
            </div>

            {creating ? (
                <div className="mt-4 flex justify-center py-2">
                    <Spin />
                </div>
            ) : current ? (
                <Space direction="vertical" size={8} className="mt-4 w-full">
                    {current.blockedReason ? (
                        <Typography.Text type="warning" className="!text-sm">
                            {current.blockedReason}
                        </Typography.Text>
                    ) : null}
                    <Button
                        type="primary"
                        icon={<ArrowRight className="size-4" />}
                        onClick={() => runAction(current)}
                        className="!w-fit"
                        data-testid="journey-primary-action"
                    >
                        {actionLabel(current)}
                    </Button>
                </Space>
            ) : (
                <Typography.Text type="secondary" className="mt-4 block text-sm">
                    {t("projects.journey.allDone")}
                </Typography.Text>
            )}
        </section>
    );
}

/** 未完成步骤的图标：只做辨识度，不引新图标库。 */
function stepIcon(key: JourneyStep["key"]) {
    const cls = "size-3.5";
    if (key === "canvas") return <FolderPlus className={cls} />;
    if (key === "pipeline") return <LayoutList className={cls} />;
    if (key === "delivery") return <Maximize2 className={cls} />;
    return <Sparkles className={cls} />;
}

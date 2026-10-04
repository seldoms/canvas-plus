import { useCallback, useEffect, useRef, useState } from "react";

import i18n from "@/i18n";
import { attachProjectRun, cancelPipelineStage, createPipelineRun, fetchPipelineProgress, listPipelineGates, resolveProjectSourceText, runPipelineStage, type GatewayStageProgress } from "@/services/api/gateway";
import type { ProjectContext } from "@/services/api/projects";

import type { StageStatusMap } from "../workspace-gates";

/** 阶段进度轮询间隔：打的是轻量 progress.json（几十字节），与 /pipeline 页一致。 */
const PROGRESS_POLL_MS = 3000;

/**
 * 工作区页面私有 hook：在项目内直接跑当前阶段（P0-a「跑起来」入口）。
 *
 * 职责边界：请求复用 services/api/gateway.ts 的既有函数（仅补了源文本读取与 run 回填项目两个）；
 * 进度轮询与状态推导集中在这里；渲染在 components/workspace-run-panel.tsx；页面只编排。
 * 建 run 的时机：仅当项目还没有关联 run 时才建，建时把 projectId 写进 options.projectId（契约认可的过渡位），
 * 并把 runId 回填进 project.runIds；已有 run 则直接跑本阶段。
 */
export function useProjectRun({
    projectId,
    stage,
    context,
    activeRunId,
    stageStatus,
    refresh,
}: {
    projectId: string;
    stage: string | null;
    context: ProjectContext | null;
    /** 工作区当前选择的 run；运行请求必须与展示的 /gates 使用同一个 run。 */
    activeRunId: string;
    stageStatus: StageStatusMap;
    refresh: () => void | Promise<void>;
}) {
    /** 本会话内新建的 run；刷新后回落到 context.runIds 的第一个。 */
    const [createdRunId, setCreatedRunId] = useState("");
    const [starting, setStarting] = useState(false);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<GatewayStageProgress | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const runId = createdRunId || activeRunId || "";
    /**
     * 上一轮 progress 轮询看到的 inflight 标志（null=本轮还没打过）。
     * 与流水线页 use-pipeline-run.ts 的 #71 判据同源：后端 recomputeStage 落终态（done/blocked 等）时不写
     * progress.json，phase 会停在 "running"；只看 phase 会让面板永远「生成中」、按钮永久禁用（#70/#71/#73）。
     * inflight 由 true 翻成 false 即表示服务端已不再执行本阶段，据此补拉一次完整 run 取真实终态。
     */
    const progressInflight = useRef<boolean | null>(null);

    // 刷新恢复：项目里该阶段已在跑时接回进度轮询（stageStatus 由关联 run 合并而来）。
    // 反向同理：任一来源（run 阶段摘要）落到终态就解除运行态，不再显示「生成中」（#73）。
    useEffect(() => {
        if (!stage) return;
        const status = stageStatus[stage];
        if (status === "running") setRunning(true);
        else if (status === "done" || status === "error" || status === "canceled" || status === "blocked") setRunning(false);
    }, [stage, stageStatus]);

    // 切项目 / 切工作区时清掉运行态，避免上一阶段的进度串到本工作区。
    useEffect(() => {
        setCreatedRunId("");
        setRunning(false);
        setProgress(null);
        setError("");
        setNotice("");
    }, [projectId, stage, activeRunId]);

    // 阶段跑完/中止后拉一次完整 run（页面据此刷新上下文与门禁）。
    // 判据与流水线页 use-pipeline-run.ts 的 #71 完全一致：progress.phase 到终态，**或** inflight 由 true 翻成
    // false（服务端已不再执行，但 recomputeStage 未 writeProgress、phase 仍停在 running）任一命中即补拉完整 run。
    useEffect(() => {
        if (!running || !runId || !stage) return;
        // 每轮轮询（开始/换 run/换阶段）重置基线：第一次打点只建立 inflight 基线。
        progressInflight.current = null;
        let alive = true;
        const tick = () => {
            void fetchPipelineProgress(runId)
                .then(({ progress: latest, inflight }) => {
                    if (!alive) return;
                    if (latest && latest.stage === stage) setProgress(latest);
                    const phaseTerminal = latest?.phase === "done" || latest?.phase === "failed";
                    const stoppedExecuting = inflight === false && progressInflight.current !== false;
                    if (phaseTerminal || stoppedExecuting) {
                        progressInflight.current = false;
                        setRunning(false);
                        void refresh();
                    } else {
                        progressInflight.current = inflight;
                    }
                })
                .catch(() => {
                    /* 网关短暂不可达不该清掉已有进度，下一轮再试 */
                });
        };
        tick();
        const timer = window.setInterval(tick, PROGRESS_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [running, runId, stage, refresh]);

    /** 跑本阶段：没有 run 就先建（带 projectId、项目名、项目源文本）并回填 runIds，再触发阶段。 */
    const start = useCallback(async () => {
        if (!stage || starting || running) return;
        setError("");
        setNotice("");
        setStarting(true);
        try {
            let id = runId;
            if (!id) {
                const project = context?.project;
                if (!project) {
                    setError(i18n.t("projects.workspace.run.noProject"));
                    return;
                }
                const source = await resolveProjectSourceText(projectId, (project as { sourceRevisionId?: string | null }).sourceRevisionId);
                const novel = source?.text || (typeof project.script === "string" ? project.script : "");
                if (!novel.trim()) {
                    setError(i18n.t("projects.workspace.run.needSource"));
                    return;
                }
                const created = await createPipelineRun({ novel, title: project.title, options: { projectId } });
                id = created.id;
                setCreatedRunId(id);
                try {
                    await attachProjectRun(projectId, [...new Set([...(context?.runIds ?? []), id])]);
                } catch (linkError) {
                    setNotice(i18n.t("projects.workspace.run.linkFailed", { message: messageOf(linkError) }));
                }
                await refresh();
            }
            setStarting(false);
            // 运行前重新读取同一个 run 的服务端门禁，避免页面首次加载时的阶段摘要过期。
            // POST /steps/:stage/run 仍是最终权威校验；这里仅让 UI 在点击前与它使用同一口径。
            const currentGate = (await listPipelineGates(id)).find((item) => item.stageId === stage);
            if (!currentGate) throw new Error("当前阶段门禁不可用，请刷新后重试");
            if (!currentGate.ready) throw new Error(currentGate.reason || "当前阶段尚未满足运行条件");
            await runPipelineStage(id, stage);
            setProgress(null);
            setRunning(true);
        } catch (caught) {
            setError(messageOf(caught));
        } finally {
            setStarting(false);
        }
    }, [stage, starting, running, runId, context, activeRunId, projectId, refresh]);

    /** 取消正在跑的阶段；终态由进度轮询接回。 */
    const cancel = useCallback(async () => {
        if (!runId || !stage) return;
        setError("");
        try {
            await cancelPipelineStage(runId, stage);
        } catch (caught) {
            setError(messageOf(caught));
        }
    }, [runId, stage]);

    return { stage, runId, hasRun: Boolean(runId), starting, running, progress, error, notice, start, cancel };
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

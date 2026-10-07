import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Modal, Select, Tooltip } from "antd";
import { Send } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useShotDropStore } from "@/stores/use-shot-drop-store";
import type { StoryboardShot } from "@/lib/canvas/shot-bridge";
import { attachCanvasRef } from "@/services/api/projects";
import type { Shot } from "@/types/domain";

/**
 * 「发到画布」入口（P2-B5）：把选中的分镜镜头排布到某张画布上。
 *
 * 断点 B5 的另一半。画布此前只能自己画，流水线产物进不去；这里给出**明确的投递动作**，
 * 而不是让用户自己去画布里手抄提示词（抄错的代价是整条流水线重跑）。
 *
 * 三个刻意的取舍：
 *  - **可多选、批量投递**：一次发一集的分镜很常见，单选按钮会逼人点几十次。
 *  - **目标画布从已绑项目的画布里选**，并顺手把未绑定的绑上（canvasIds 幂等），
 *    不额外建新画布 —— 画布是自由表面，但既然从这里来，绑上才有后续「回写」。
 *  - **投递后跳到画布**：用户能立刻看到结果，而不是「已发送」然后自己找。
 */
export function SendShotsToCanvas({
    projectId,
    shots,
    size = "small",
    label,
}: {
    projectId: string;
    projectTitle?: string;
    shots: Shot[];
    size?: "small" | "middle";
    label?: React.ReactNode;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const projects = useCanvasStore((state) => state.projects);
    const drop = useShotDropStore((state) => state.drop);

    /** 只列已绑本项目的画布（绑过项目的画布才是「项目的空间视图」）。 */
    const candidates = projects.filter((item) => item.serverProjectId === projectId);
    const [canvasId, setCanvasId] = useState("");
    const target = canvasId || candidates[0]?.id || "";

    const submit = useCallback(async () => {
        const canvas = candidates.find((item) => item.id === target);
        if (!canvas) {
            message.warning(t("shotBridge.noCanvasHint"));
            return;
        }
        // 集/场标签不在这里算：同批镜头未必同集同场，消费侧（画布页）拿得到全量 episodes/scenes，
        // 按每个 shot 自己的 episodeId/sceneId 解析才对。
        const payload: StoryboardShot[] = shots.map((shot) => ({ ...shot }));
        drop({
            canvasId: canvas.id,
            shots: payload,
            // 项目侧镜头（ep_0001 风格 id），回写走 PATCH /api/projects/:id/shots/:shotId。
            ref: { projectId, source: "project" },
        });
        try {
            await attachCanvasRef(projectId, canvas.id);
        } catch {
            /* 已绑过或绑定失败不阻断：投递本身是本地动作，用户能在画布里看到节点 */
        }
        setOpen(false);
        message.success(t("shotBridge.dropped", { count: payload.length }));
        navigate(`/canvas/${encodeURIComponent(canvas.id)}`);
    }, [candidates, drop, message, navigate, projectId, shots, t, target]);

    if (!shots.length) return null;

    /*
     * 没有可用画布时**不装死按钮**：disabled 的按钮点不动，任何解释都只能塞进 Tooltip，
     * 而 Tooltip 要hover 才发现 —— 这就是「假按钮」（点了没反应，也不告诉你要先做什么）。
     * 改成：按钮可点，点了直接说明缺前置条件，并给出可执行的下一步（去画布列表新建/绑定）。
     */
    const noCanvas = candidates.length === 0;

    return (
        <>
            <Tooltip title={noCanvas ? t("shotBridge.noCanvasHint") : t("shotBridge.tooltip")}>
                <Button size={size} icon={<Send className="size-3.5" />} onClick={() => (noCanvas ? message.info(t("shotBridge.noCanvasHint")) : setOpen(true))}>
                    {label ?? t("shotBridge.button", { count: shots.length })}
                </Button>
            </Tooltip>
            <Modal title={t("shotBridge.title")} open={open} onCancel={() => setOpen(false)} onOk={() => void submit()} okText={t("shotBridge.confirm")} cancelText={t("common.cancel")} destroyOnHidden>
                <div className="space-y-3">
                    <p className="text-xs opacity-70">{t("shotBridge.hint", { count: shots.length })}</p>
                    <label className="block">
                        <span className="mb-1 block text-xs opacity-60">{t("shotBridge.targetCanvas")}</span>
                        <Select
                            className="w-full"
                            value={target || undefined}
                            placeholder={t("shotBridge.pickCanvas")}
                            options={candidates.map((item) => ({ value: item.id, label: item.title || item.id }))}
                            onChange={setCanvasId}
                        />
                    </label>
                </div>
            </Modal>
        </>
    );
}
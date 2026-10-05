import { useState } from "react";
import { App, Button, Empty, Image, Modal, Tag } from "antd";
import { FolderInput, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveGatewayUrl } from "@/services/api/gateway";
import { selectSlotCandidate } from "@/services/api/projects";
import { ProjectSlotCascadeSelects, useProjectSlotCascade } from "@/components/project-slot-cascade";
import { generateSlotCandidateImage, importNodeImageCandidate, nodeGenerationPrompt, type SlotGeneratedImage } from "@/lib/canvas/canvas-project-slots";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 槽位选择对话框（M2-D8）：级联选择核心复用 project-slot-cascade（项目已绑定固定）；
 * 画布特有动作留在这里——候选列表带缩略图 / 状态 / 采用 / 撤销采用，
 * 「生成新候选」走服务端队列，「把当前图片加入候选」走 artifacts/import 登记。
 */
export function CanvasSlotDialog({
    open,
    node,
    projectId,
    projectTitle,
    onGenerated,
    onClose,
}: {
    open: boolean;
    node: CanvasNodeData | null;
    projectId: string;
    projectTitle?: string | null;
    /** 生成新候选成功后回调：父级据此在画布上建 artifact 图片节点。 */
    onGenerated: (image: SlotGeneratedImage, sourceNode: CanvasNodeData) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const cascade = useProjectSlotCascade({ active: open, projectId });
    const [busy, setBusy] = useState<"generate" | "import" | "select" | null>(null);
    const { slot, slotId, target } = cascade;

    const run = async (kind: "generate" | "import" | "select", action: () => Promise<void>) => {
        setBusy(kind);
        try {
            await action();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(null);
        }
    };

    const handleGenerate = () => {
        if (!node || !target) return;
        void run("generate", async () => {
            const image = await generateSlotCandidateImage(node, target);
            onGenerated(image, node);
            message.success(t("canvas.slotDialog.generateSuccess"));
            await cascade.refresh();
        });
    };

    const handleImport = () => {
        if (!node || !target) return;
        void run("import", async () => {
            await importNodeImageCandidate(node, target);
            message.success(t("canvas.slotDialog.importSuccess"));
            await cascade.refresh();
        });
    };

    /** 采用 / 撤销采用（M3：jobId 传 null 清空 selected）。 */
    const handleSelect = (jobId: string | null) => {
        if (!target) return;
        void run("select", async () => {
            const next = await selectSlotCandidate(target.projectId, target.shotId, target.slotId, jobId);
            cascade.setSlot(next);
        });
    };

    const candidates = slot?.candidates || [];
    const canGenerate = Boolean(node && target && nodeGenerationPrompt(node));
    const hasNodeImage = Boolean(node?.metadata?.content || node?.metadata?.storageKey);

    return (
        <Modal title={t("canvas.slotDialog.title")} open={open} onCancel={onClose} footer={null} centered width={640}>
            <div className="space-y-4 pt-2">
                <ProjectSlotCascadeSelects cascade={cascade} projectTitle={projectTitle} />

                <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{t("canvas.slotDialog.candidates")}</span>
                        <Tag className="m-0">{slotId || t("canvas.slotDialog.keySlot")}</Tag>
                    </div>
                    {!cascade.shotId ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.slotDialog.noShots")} />
                    ) : candidates.length ? (
                        <div className="thin-scrollbar grid max-h-72 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
                            {candidates.map((candidate) => {
                                const selected = slot?.selected === candidate.jobId;
                                return (
                                    <div key={candidate.jobId} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700" style={selected ? { background: theme.toolbar.activeBg } : undefined}>
                                        {candidate.artifactUrl ? (
                                            <Image src={resolveGatewayUrl(candidate.artifactUrl)} alt={candidate.jobId} className="aspect-square w-full object-cover" />
                                        ) : (
                                            <div className="grid aspect-square w-full place-items-center text-xs opacity-50">{candidate.status || "—"}</div>
                                        )}
                                        <div className="space-y-1.5 px-2 py-2">
                                            <div className="flex items-center justify-between gap-2 text-xs">
                                                <span className="truncate opacity-70" title={candidate.jobId}>
                                                    {candidate.jobId}
                                                </span>
                                                {candidate.status ? <Tag className="m-0 shrink-0">{candidate.status}</Tag> : null}
                                            </div>
                                            {selected ? (
                                                <div className="flex items-center justify-between gap-1 text-xs">
                                                    <span className="font-medium">{t("canvas.slotDialog.adopted")}</span>
                                                    <Button size="small" type="text" loading={busy === "select"} onClick={() => handleSelect(null)}>
                                                        {t("canvas.slotDialog.revoke")}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <Button size="small" block loading={busy === "select"} onClick={() => handleSelect(candidate.jobId)}>
                                                    {t("canvas.slotDialog.adopt")}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.slotDialog.empty")} />
                    )}
                </div>

                {node ? (
                    <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
                        <Button icon={<Sparkles className="size-4" />} loading={busy === "generate"} disabled={!canGenerate || (busy !== null && busy !== "generate")} onClick={handleGenerate}>
                            {t("canvas.slotDialog.generate")}
                        </Button>
                        <Button icon={<FolderInput className="size-4" />} loading={busy === "import"} disabled={!hasNodeImage || !target || (busy !== null && busy !== "import")} onClick={handleImport}>
                            {t("canvas.slotDialog.importImage")}
                        </Button>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

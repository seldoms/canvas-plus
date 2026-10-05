import { useState } from "react";
import { App, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { ProjectSlotCascadeSelects, useProjectSlotCascade } from "@/components/project-slot-cascade";
import { appendSlotCandidate } from "@/services/api/projects";

/**
 * 生图工作台「加入项目候选」轻量壳（M3-D2）：选项目 → 集 → 镜头 → 关键帧槽位，确认后把
 * 已完成 Job 直接追加为槽位候选（复用 M2 端点，Job 已 done、artifact 已存在，不走 import）；
 * 成功后提示并展示该槽位候选数与选中态。级联选择核心复用 project-slot-cascade。
 */
export function SlotCandidateDialog({ open, jobId, onClose }: { open: boolean; jobId: string | null; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const cascade = useProjectSlotCascade({ active: open });
    const [busy, setBusy] = useState(false);
    const { slot, target } = cascade;

    const handleConfirm = async () => {
        if (!target || !jobId) return;
        setBusy(true);
        try {
            const next = await appendSlotCandidate(target.projectId, target.shotId, target.slotId, jobId);
            cascade.setSlot(next);
            message.success(t("imageWorkbench.addCandidateSuccess"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title={t("imageWorkbench.slotDialogTitle")}
            open={open}
            onCancel={onClose}
            onOk={() => void handleConfirm()}
            okText={t("imageWorkbench.addCandidate")}
            cancelText={t("common.cancel")}
            okButtonProps={{ loading: busy, disabled: !target || !jobId }}
            centered
            width={560}
        >
            <div className="space-y-4 pt-2">
                <ProjectSlotCascadeSelects cascade={cascade} />
                {cascade.projects && cascade.projects.length === 0 ? (
                    <div className="text-xs opacity-60">{t("imageWorkbench.noProjects")}</div>
                ) : slot ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-70">
                        <span>{t("imageWorkbench.candidateCount", { count: slot.candidates.length })}</span>
                        <span>{slot.selected ? t("imageWorkbench.adoptedJob", { jobId: slot.selected }) : t("imageWorkbench.notAdopted")}</span>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

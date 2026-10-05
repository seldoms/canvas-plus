import { useEffect, useState } from "react";
import { App, Button, Empty, List, Modal, Spin, Tag } from "antd";
import { Link2, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { attachCanvasRef, detachCanvasRef, listProjects, type ProjectSummary } from "@/services/api/projects";

/**
 * 绑定项目弹窗（M2-D1）：列出服务端项目供选择；绑定 = 本地存 serverProjectId + 服务端 canvas-refs attach；
 * 解绑 = detach + 清本地字段。绑定状态只登记，不改画布任何生成链路。
 */
export function CanvasBindProjectModal({
    open,
    canvasId,
    boundProjectId,
    boundProjectTitle,
    onBound,
    onClose,
}: {
    open: boolean;
    canvasId: string;
    boundProjectId?: string | null;
    boundProjectTitle?: string | null;
    onBound: (projectId: string | null, title?: string) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setProjects(null);
        let alive = true;
        listProjects()
            .then((list) => {
                if (alive) setProjects(list);
            })
            .catch((error) => {
                if (!alive) return;
                setProjects([]);
                message.error(error instanceof Error ? error.message : String(error));
            });
        return () => {
            alive = false;
        };
    }, [open, message]);

    const bind = async (project: ProjectSummary) => {
        setBusyId(project.id);
        try {
            await attachCanvasRef(project.id, canvasId);
            onBound(project.id, project.title);
            message.success(t("canvas.projectBinding.bindSuccess", { title: project.title }));
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusyId(null);
        }
    };

    const unbind = async () => {
        if (!boundProjectId) return;
        setBusyId(boundProjectId);
        try {
            await detachCanvasRef(boundProjectId, canvasId);
            onBound(null);
            message.success(t("canvas.projectBinding.unbindSuccess"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusyId(null);
        }
    };

    return (
        <Modal title={t("canvas.projectBinding.modalTitle")} open={open} onCancel={onClose} footer={null} centered width={480}>
            {boundProjectId ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 text-sm dark:border-stone-700">
                    <span className="min-w-0 truncate">
                        {t("canvas.projectBinding.currentBound")}
                        <Tag className="ml-2 mr-0" color="blue">
                            {boundProjectTitle || boundProjectId}
                        </Tag>
                    </span>
                    <Button size="small" icon={<Unlink className="size-3.5" />} loading={busyId === boundProjectId} onClick={() => void unbind()}>
                        {t("canvas.projectBinding.unbind")}
                    </Button>
                </div>
            ) : null}
            {projects === null ? (
                <div className="flex justify-center py-10">
                    <Spin />
                </div>
            ) : projects.length ? (
                <List
                    size="small"
                    dataSource={projects}
                    renderItem={(project) => (
                        <List.Item
                            actions={[
                                <Button key="bind" type="text" icon={<Link2 className="size-4" />} loading={busyId === project.id} disabled={project.id === boundProjectId} onClick={() => void bind(project)}>
                                    {project.id === boundProjectId ? t("canvas.projectBinding.bound") : t("canvas.projectBinding.bind")}
                                </Button>,
                            ]}
                        >
                            <List.Item.Meta title={project.title} description={project.id} />
                        </List.Item>
                    )}
                />
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.projectBinding.empty")} />
            )}
        </Modal>
    );
}

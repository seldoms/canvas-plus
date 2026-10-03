import { App, Modal } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { EMPTY_SOURCE_DRAFT, SourceInput, type ProjectSourceDraft, type ProjectSourceSubmit } from "./source-input";

/**
 * 「导入/替换原文」弹窗：只包 SourceInput 与一个提交按钮，负责空内容校验与载荷组装。
 * 落源请求交给外层面板的 save，接口失败提示由面板统一处理。
 */
export function SourceImportModal({
    open,
    submitting,
    onCancel,
    onSubmit,
}: {
    open: boolean;
    submitting: boolean;
    onCancel: () => void;
    onSubmit: (input: ProjectSourceSubmit) => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ProjectSourceDraft>(EMPTY_SOURCE_DRAFT);

    // 每次打开都重置，避免上次选择的文件内容残留到下一次导入。
    useEffect(() => {
        if (open) setDraft(EMPTY_SOURCE_DRAFT);
    }, [open]);

    const submit = () => {
        if (draft.reading || !draft.text.trim()) {
            message.error(draft.reading ? t("projects.source.reading") : t("projects.source.needText"));
            return;
        }
        onSubmit({ text: draft.text, title: draft.title.trim() || undefined, kind: "novel", from: draft.mode === "file" ? "upload" : "paste" });
    };

    return (
        <Modal
            title={t("projects.source.modalTitle")}
            open={open}
            width={560}
            confirmLoading={submitting}
            okText={t("projects.source.submit")}
            cancelText={t("common.cancel")}
            onCancel={onCancel}
            onOk={submit}
            destroyOnHidden
        >
            <SourceInput draft={draft} onChange={setDraft} disabled={submitting} />
        </Modal>
    );
}

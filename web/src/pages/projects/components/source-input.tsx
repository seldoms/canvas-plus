import { App, Button, Input, Segmented, Typography } from "antd";
import { Upload as UploadIcon } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

/** 导入原文的草稿：文件 / 粘贴两种取文方式都归一到 text，text 是唯一源文本。 */
export type ProjectSourceDraft = {
    mode: "file" | "paste";
    text: string;
    title: string;
    fileName: string;
    reading: boolean;
};

export const EMPTY_SOURCE_DRAFT: ProjectSourceDraft = { mode: "file", text: "", title: "", fileName: "", reading: false };

/** 提交给 POST /api/projects/:id/sources 的载荷；from 记录取文方式（upload / paste）。 */
export type ProjectSourceSubmit = { text: string; title?: string; kind: string; from: string };

/** 去掉扩展名的文件名，作为默认标题。 */
function baseName(name: string) {
    return name.replace(/\.[^.]+$/, "");
}

/**
 * 原文取入控件（新建与替换共用）：文件与粘贴二选一，最终都落到 text。
 * 只负责取文与展示字数，不分块、不发请求；提交与接口失败提示由外层弹窗处理。
 */
export function SourceInput({ draft, onChange, disabled }: { draft: ProjectSourceDraft; onChange: (next: ProjectSourceDraft) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);

    const pickFile = async (file: File) => {
        onChange({ ...draft, reading: true });
        try {
            const text = await file.text();
            if (!text.trim()) {
                message.error(t("projects.source.empty"));
                onChange({ ...draft, reading: false, text: "", fileName: file.name });
                return;
            }
            onChange({ ...draft, text, fileName: file.name, title: draft.title || baseName(file.name), reading: false });
        } catch {
            message.error(t("projects.source.readFailed"));
            onChange({ ...draft, reading: false });
        }
    };

    return (
        <div className="space-y-3">
            <Segmented
                block
                disabled={disabled}
                value={draft.mode}
                onChange={(value) => onChange({ ...draft, mode: value as ProjectSourceDraft["mode"] })}
                options={[
                    { label: t("projects.source.modeFile"), value: "file" },
                    { label: t("projects.source.modePaste"), value: "paste" },
                ]}
            />
            {draft.mode === "file" ? (
                <div className="flex items-center gap-2">
                    <Button size="small" icon={<UploadIcon className="size-4" />} loading={draft.reading} disabled={disabled} onClick={() => inputRef.current?.click()}>
                        {t("projects.source.chooseFile")}
                    </Button>
                    <Typography.Text type="secondary" className="truncate text-xs">
                        {draft.fileName || t("projects.source.noFile")}
                    </Typography.Text>
                    <input
                        ref={inputRef}
                        type="file"
                        accept=".txt,.md,.markdown,text/plain,text/markdown"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void pickFile(file);
                        }}
                    />
                </div>
            ) : (
                <Input.TextArea rows={4} disabled={disabled} value={draft.text} placeholder={t("projects.source.pastePlaceholder")} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
            )}
            <div className="flex items-center gap-2">
                <Input
                    size="small"
                    className="!w-56"
                    disabled={disabled}
                    value={draft.title}
                    placeholder={t("projects.source.titlePlaceholder")}
                    onChange={(event) => onChange({ ...draft, title: event.target.value })}
                />
                {/* 用 length（UTF-16 单元）算字数，避免每次渲染 Array.from 整篇造成卡顿；CJK 与码点一致。 */}
                <Typography.Text type="secondary" className="whitespace-nowrap text-xs">
                    {t("projects.source.chars", { count: draft.text.length })}
                </Typography.Text>
            </div>
        </div>
    );
}

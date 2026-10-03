import { Upload as UploadIcon } from "lucide-react";
import { useState } from "react";
import { Alert, App, Button, Card, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { useProjectSource } from "../hooks/use-project-source";
import { SourceImportModal } from "./source-import-modal";
import type { ProjectSourceSubmit } from "./source-input";

/**
 * 「原文」面板：展示项目当前源版本（标题 / 字数 / 版本），提供唯一入口「导入原文 / 替换原文」。
 * 换源即落一个新的不可变源版本并更新 project.sourceRevisionId，不做平行页面。
 */
export function ProjectSourcePanel({ projectId, sourceRevisionId, refresh }: { projectId: string; sourceRevisionId?: string | null; refresh: () => void | Promise<void> }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { sources, loading, error, saving, save } = useProjectSource(projectId);
    const [open, setOpen] = useState(false);

    // 当前采用版本以 project.sourceRevisionId 为准，回落到最新一条。
    const current = sources.find((source) => source.id === sourceRevisionId) || sources[0] || null;

    const submit = async (input: ProjectSourceSubmit) => {
        try {
            await save(input);
            message.success(t("projects.source.imported"));
            setOpen(false);
            await refresh();
        } catch (saveError) {
            message.error(t("projects.source.saveFailed", { message: saveError instanceof Error ? saveError.message : String(saveError) }));
        }
    };

    return (
        <section>
            <Typography.Title level={5} className="!mb-3">
                {t("projects.source.title")}
            </Typography.Title>
            <Card size="small">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        {current ? (
                            <Typography.Text className="block truncate">
                                {current.title || t("projects.source.untitled")} · {t("projects.source.chars", { count: current.chars ?? 0 })} · {t("projects.source.version", { id: current.id })}
                            </Typography.Text>
                        ) : (
                            <Typography.Text type="secondary">{loading ? t("projects.source.loading") : t("projects.source.none")}</Typography.Text>
                        )}
                    </div>
                    <Button size="small" icon={<UploadIcon className="size-4" />} onClick={() => setOpen(true)}>
                        {current ? t("projects.source.replace") : t("projects.source.import")}
                    </Button>
                </div>
                {error ? <Alert type="error" showIcon className="mt-3" message={t("projects.source.loadFailed")} description={error} /> : null}
            </Card>
            <SourceImportModal open={open} submitting={saving} onCancel={() => setOpen(false)} onSubmit={(input) => void submit(input)} />
        </section>
    );
}

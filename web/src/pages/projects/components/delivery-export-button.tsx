import { Download } from "lucide-react";
import { Alert, Button, Progress } from "antd";
import { useTranslation } from "react-i18next";

import { displayProgressLabel } from "@/lib/progress-label";
import { useProjectDelivery } from "../hooks/use-project-delivery";

/**
 * 「导出交付包」入口：把成片、封面、字幕与交付清单打成 zip 下载。
 * 导出中显示进度与当前步骤，失败/成功给出结果提示；逻辑在 useProjectDelivery。
 */
export function DeliveryExportButton({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const { exportPackage, exporting, progress, error, result } = useProjectDelivery(projectId);
    const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    return (
        <div className="flex flex-col items-end gap-2">
            <Button type="text" icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportPackage()}>
                {exporting ? t("projects.delivery.exporting") : t("projects.delivery.export")}
            </Button>
            {exporting && progress ? (
                <div className="w-64">
                    <Progress percent={percent} size="small" status="active" />
                    <span className="text-xs text-stone-500 dark:text-stone-400">{displayProgressLabel(progress.label)}</span>
                </div>
            ) : null}
            {error ? <Alert type="error" showIcon className="max-w-md" message={t("projects.delivery.failed", { message: error })} /> : null}
            {result && !exporting ? (
                <Alert
                    type="success"
                    showIcon
                    className="max-w-md"
                    message={t("projects.delivery.done")}
                    description={t("projects.delivery.doneSummary", { episodes: result.episodes, files: result.files, missing: result.missing })}
                />
            ) : null}
        </div>
    );
}

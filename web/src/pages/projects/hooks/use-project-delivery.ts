import { useCallback, useState } from "react";

import i18n from "@/i18n";
import { exportProjectDelivery, type DeliveryExportResult, type DeliveryProgress } from "@/lib/project-delivery-export";
import { loadProjectDeliverySource } from "@/services/api/delivery";

/**
 * 项目总览页私有 hook：交付包导出的状态与动作。
 * 取数据（loadProjectDeliverySource）与导出编排（exportProjectDelivery）分别落在 services 与 lib，
 * 这里只做「发起 → 进度 → 结果/失败」的状态编排，页面与组件不直接碰请求。
 */
export function useProjectDelivery(projectId: string) {
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState<DeliveryProgress | null>(null);
    const [error, setError] = useState("");
    const [result, setResult] = useState<DeliveryExportResult | null>(null);

    const exportPackage = useCallback(async () => {
        if (!projectId || exporting) return;
        setExporting(true);
        setError("");
        setResult(null);
        setProgress({ phase: "build", label: i18n.t("projects.delivery.phaseLoad"), done: 0, total: 0 });
        try {
            const source = await loadProjectDeliverySource(projectId);
            setProgress({ phase: "build", label: i18n.t("projects.delivery.phaseBuild"), done: 0, total: 0 });
            setResult(await exportProjectDelivery(source, { onProgress: setProgress }));
        } catch (exportError) {
            setError(exportError instanceof Error ? exportError.message : String(exportError));
        } finally {
            setExporting(false);
            setProgress(null);
        }
    }, [projectId, exporting]);

    return { exportPackage, exporting, progress, error, result };
}

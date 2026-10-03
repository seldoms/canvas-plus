import { Tag } from "antd";
import { useTranslation } from "react-i18next";

import type { GatewayStageStatus } from "@/services/api/gateway";

/** 阶段状态 → AntD Tag 颜色；文案统一走 pipeline.status.*。 */
const COLORS: Record<GatewayStageStatus, string> = {
    pending: "default",
    running: "processing",
    partial: "warning",
    done: "success",
    error: "error",
    canceled: "default",
};

/** 阶段状态标签：工作区各面板共用，避免每处各拼一遍颜色与文案。 */
export function StageStatusTag({ status }: { status: GatewayStageStatus }) {
    const { t } = useTranslation();
    return <Tag color={COLORS[status]}>{t(`pipeline.status.${status}`)}</Tag>;
}

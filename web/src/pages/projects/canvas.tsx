import { Card, Typography } from "antd";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { WorkspaceLayout } from "./components/workspace-layout";
import { useProjectWorkspace } from "./hooks/use-project-workspace";
import { getWorkspace } from "./workspaces";

/** 项目内画布工作区骨架（P0-a M4）：只做项目画布入口与引用，沿用现有画布引擎 /canvas/:id。 */
export default function CanvasWorkspacePage() {
    const { t } = useTranslation();
    const { projectId = "" } = useParams();
    const workspace = useProjectWorkspace(projectId);
    return (
        <WorkspaceLayout projectId={projectId} workspace={getWorkspace("canvas")} {...workspace}>
            <Card size="small">
                <Typography.Text type="secondary">{t("projects.workspace.actions.canvasHint")}</Typography.Text>
            </Card>
        </WorkspaceLayout>
    );
}

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { WORKSPACES, workspacePath } from "../workspaces";

/**
 * 项目总览页的工作区入口：直接跳到 `/projects/:projectId/*` 各工作区骨架。
 * 工作区清单与门禁定义以 workspaces.ts 为唯一来源。
 */
export function WorkspaceEntries({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();

    return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WORKSPACES.map(({ key, icon: Icon }) => (
                <button
                    key={key}
                    type="button"
                    className="flex cursor-pointer flex-col items-start gap-3 rounded-2xl border border-dashed border-stone-300 p-5 text-left transition hover:border-stone-400 hover:bg-black/5 dark:border-stone-700 dark:hover:border-stone-500 dark:hover:bg-white/10"
                    onClick={() => navigate(workspacePath(projectId, key))}
                >
                    <Icon className="size-5 text-stone-500 dark:text-stone-400" />
                    <span className="text-sm font-medium">{t(`projects.workspace.${key}`)}</span>
                </button>
            ))}
        </div>
    );
}

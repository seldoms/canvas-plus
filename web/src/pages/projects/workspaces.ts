import { BookOpen, Clapperboard, Images, LayoutList, Maximize2, Sparkles } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

/**
 * 项目内工作区定义（P0-a M4）。
 *
 * `stage` 是该工作区在流水线里产出的阶段；`requires` 是进入该工作区前必须先 `done` 的上游阶段。
 * 门禁优先取服务端 `GET /api/projects/:id/gates` 中本工作区阶段的判定，服务端不可用时回退
 * 前端根据关联 run 的阶段状态推导（见 workspace-gates.ts）。
 */
export type WorkspaceKey = "plan" | "storyboard" | "assets" | "keyframes" | "video" | "canvas";

export type WorkspaceDef = {
    key: WorkspaceKey;
    /** 本工作区产出的流水线阶段 id；canvas 沿用现有画布引擎，不产出阶段。 */
    stage: string | null;
    /** 上游阶段门禁；全部 done 才放行。 */
    requires: string[];
    /** 本波是否已开放就地写入（分镜 / 资产）。未开放者仍是只读骨架。 */
    editable: boolean;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export const WORKSPACES: WorkspaceDef[] = [
    { key: "plan", stage: "script", requires: [], editable: false, icon: BookOpen },
    { key: "storyboard", stage: "storyboard", requires: ["script"], editable: true, icon: LayoutList },
    { key: "assets", stage: "design", requires: ["storyboard"], editable: true, icon: Images },
    { key: "keyframes", stage: "keyframe", requires: ["design"], editable: false, icon: Sparkles },
    { key: "video", stage: "assembly", requires: ["keyframe"], editable: false, icon: Clapperboard },
    { key: "canvas", stage: null, requires: [], editable: false, icon: Maximize2 },
];

export function workspacePath(projectId: string, key: WorkspaceKey) {
    return `/projects/${encodeURIComponent(projectId)}/${key}`;
}

export function getWorkspace(key: WorkspaceKey): WorkspaceDef {
    const found = WORKSPACES.find((item) => item.key === key);
    if (!found) throw new Error(`未知工作区：${key}`);
    return found;
}

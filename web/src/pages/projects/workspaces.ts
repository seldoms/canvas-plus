import { BookOpen, Clapperboard, Images, LayoutList, Maximize2, Sparkles } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

/**
 * 项目内工作区定义（P0-a M4）。
 *
 * `stage` 是该工作区在流水线里产出的阶段；`requires` 是进入该工作区前必须先 `done` 的上游阶段。
 * 门禁目前是**前端根据关联 run 的阶段状态推导**的临时实现：p0a 方案 §3.2 建议的
 * 服务端 `context.stageGates[]` 尚未落地（见 workspace-gates.ts 顶部说明）。
 */
export type WorkspaceKey = "plan" | "storyboard" | "assets" | "keyframes" | "video" | "canvas";

export type WorkspaceDef = {
    key: WorkspaceKey;
    /** 本工作区产出的流水线阶段 id；canvas 沿用现有画布引擎，不产出阶段。 */
    stage: string | null;
    /** 上游阶段门禁；全部 done 才放行。 */
    requires: string[];
    icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export const WORKSPACES: WorkspaceDef[] = [
    { key: "plan", stage: "script", requires: [], icon: BookOpen },
    { key: "storyboard", stage: "storyboard", requires: ["script"], icon: LayoutList },
    { key: "assets", stage: "design", requires: ["storyboard"], icon: Images },
    { key: "keyframes", stage: "keyframe", requires: ["design"], icon: Sparkles },
    { key: "video", stage: "assembly", requires: ["keyframe"], icon: Clapperboard },
    { key: "canvas", stage: null, requires: [], icon: Maximize2 },
];

export function workspacePath(projectId: string, key: WorkspaceKey) {
    return `/projects/${encodeURIComponent(projectId)}/${key}`;
}

export function getWorkspace(key: WorkspaceKey): WorkspaceDef {
    const found = WORKSPACES.find((item) => item.key === key);
    if (!found) throw new Error(`未知工作区：${key}`);
    return found;
}

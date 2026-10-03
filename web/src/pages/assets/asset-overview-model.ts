import { ASSET_ROLES } from "@/pages/projects/asset-ref-model";
import type { AssetOverviewRef } from "@/services/api/projects";

/**
 * 「我的资产」跨项目总览的纯函数：媒体类型判定、筛选项生成、筛选与下载文件名。
 * 只做数据整形，不发请求。
 */

/** 视频产物后缀（clip 角色一律视频，其余按后缀兜底）。 */
const VIDEO_URL = /\.(mp4|webm|mov|mkv|m4v|avi)(?:[?#].*)?$/i;

/** 产物是图片还是视频。 */
export function mediaKindOf(ref: AssetOverviewRef): "image" | "video" {
    if (ref.role === "clip") return "video";
    return VIDEO_URL.test(ref.url) ? "video" : "image";
}

/**
 * 角色筛选项：只保留数据里真实出现过的 role，顺序按契约枚举 ASSET_ROLES；
 * 枚举外的未知 role 追加在后，避免数据里出现的类别被筛掉。
 */
export function roleFilterOptions(byRole: Record<string, number>): { role: string; count: number }[] {
    const known = ASSET_ROLES.filter((role) => Number(byRole[role]) > 0).map((role) => ({ role, count: Number(byRole[role]) }));
    const extra = Object.keys(byRole)
        .filter((role) => Number(byRole[role]) > 0 && !(ASSET_ROLES as string[]).includes(role))
        .map((role) => ({ role, count: Number(byRole[role]) }));
    return [...known, ...extra];
}

export type AssetFilter = {
    keyword: string;
    /** "all" 或具体 role。 */
    role: string;
    /** "all" 或具体 projectId。 */
    projectId: string;
};

/** 按名称/绑定/项目标题搜索 + 角色 + 项目筛选。 */
export function filterAssetRefs(refs: AssetOverviewRef[], { keyword, role, projectId }: AssetFilter): AssetOverviewRef[] {
    const query = keyword.trim().toLowerCase();
    return refs.filter((ref) => {
        if (role !== "all" && ref.role !== role) return false;
        if (projectId !== "all" && ref.projectId !== projectId) return false;
        if (!query) return true;
        return `${ref.name} ${ref.bindingId} ${ref.projectTitle}`.toLowerCase().includes(query);
    });
}

/** 下载文件名：人读名称 + 原产物后缀（去掉非法字符）。 */
export function artifactFileName(ref: AssetOverviewRef): string {
    const clean = ref.url.split(/[?#]/)[0];
    const ext = clean.includes(".") ? clean.split(".").pop() ?? "" : "";
    const base = (ref.name || ref.bindingId || ref.id || "asset").replace(/[\\/:*?"<>|]+/g, "_").trim() || "asset";
    return ext ? `${base}.${ext}` : base;
}

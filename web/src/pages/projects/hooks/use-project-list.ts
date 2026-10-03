import { useCallback, useEffect, useState } from "react";

import { saveProjectSource, type GatewayProjectSourceInput } from "@/services/api/gateway";
import { archiveProject, createProject, listProjects, type ProjectCreateInput, type ProjectSummary } from "@/services/api/projects";

/**
 * 项目列表页私有数据加载：列表 / 新建 / 归档。
 * 页面只消费这里返回的状态与动作，不直接碰请求。
 */
export function useProjectList() {
    const [projects, setProjects] = useState<ProjectSummary[]>([]);
    const [includeArchived, setIncludeArchived] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setProjects(await listProjects({ includeArchived }));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, [includeArchived]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const create = useCallback(
        async (input: ProjectCreateInput) => {
            const project = await createProject(input);
            await refresh();
            return project;
        },
        [refresh],
    );

    const archive = useCallback(
        async (id: string) => {
            await archiveProject(id);
            await refresh();
        },
        [refresh],
    );

    /** 新建项目后把原文落成源版本；失败原样抛出，由页面区分「项目已建但导入失败」。 */
    const importSource = useCallback(async (projectId: string, input: GatewayProjectSourceInput) => saveProjectSource(projectId, input), []);

    return { projects, includeArchived, setIncludeArchived, loading, error, refresh, create, archive, importSource };
}

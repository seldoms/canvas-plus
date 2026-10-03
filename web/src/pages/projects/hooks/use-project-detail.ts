import { useCallback, useEffect, useState } from "react";

import { getProjectContext, type ProjectContext } from "@/services/api/projects";

/**
 * 项目总览页私有数据加载：一个 projectId 走 GET /context 拿回项目 + 集索引 + run/画布引用。
 * 各工作区（M4）后续复用同一接口，页面不自行拼上下文。
 */
export function useProjectDetail(projectId: string) {
    const [context, setContext] = useState<ProjectContext | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        if (!projectId) return;
        setLoading(true);
        setError("");
        try {
            setContext(await getProjectContext(projectId));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return { context, loading, error, refresh };
}

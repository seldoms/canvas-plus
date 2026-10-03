import { useCallback, useEffect, useState } from "react";

import { listProjectSources, saveProjectSource, type GatewayProjectSourceInput, type GatewayProjectSourceSummary } from "@/services/api/gateway";

/**
 * 工作区「原文」面板私有数据：读源版本列表 + 落新源版本。
 * 只做取数据与写数据，展示与提示在 project-source-panel.tsx。
 */
export function useProjectSource(projectId: string) {
    const [sources, setSources] = useState<GatewayProjectSourceSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const refresh = useCallback(async () => {
        if (!projectId) return;
        setLoading(true);
        setError("");
        try {
            setSources(await listProjectSources(projectId));
        } catch (loadError) {
            setSources([]);
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    /** 落一个不可变源版本并刷新列表；失败原样抛出，由面板提示。 */
    const save = useCallback(
        async (input: GatewayProjectSourceInput) => {
            setSaving(true);
            try {
                const source = await saveProjectSource(projectId, input);
                await refresh();
                return source;
            } finally {
                setSaving(false);
            }
        },
        [projectId, refresh],
    );

    return { sources, loading, error, saving, refresh, save };
}

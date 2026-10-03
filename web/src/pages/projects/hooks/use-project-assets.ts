import { useCallback, useEffect, useState } from "react";

import { createAssetRef, listAssetRefs, updateAssetRef, type AssetRefCreateInput, type AssetRefPatchInput } from "@/services/api/projects";
import type { AssetRef } from "@/types/domain";

/**
 * 资产工作区私有 hook：加载 AssetRef 列表，封装登记与（绑定 / 采用产物的）写回。
 * 只负责取数 / 写回 / 本地落位；分组与 patch 组装在 asset-ref-model.ts，渲染在组件里。
 */
export function useProjectAssets(projectId: string) {
    const [refs, setRefs] = useState<AssetRef[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [savingRefId, setSavingRefId] = useState("");
    const [creating, setCreating] = useState(false);

    const refresh = useCallback(async () => {
        if (!projectId) return;
        setLoading(true);
        setError("");
        try {
            setRefs(await listAssetRefs(projectId));
        } catch (loadError) {
            setRefs([]);
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    /** 登记新引用：成功并入本地；失败抛出，弹窗提示且保留已填写内容。 */
    const addRef = useCallback(
        async (input: AssetRefCreateInput) => {
            setCreating(true);
            try {
                const ref = await createAssetRef(projectId, input);
                setRefs((current) => [...current, ref]);
                return ref;
            } finally {
                setCreating(false);
            }
        },
        [projectId],
    );

    /** 改绑定 / 切换采用产物：成功用返回结果替换本地。 */
    const patchRef = useCallback(
        async (refId: string, patch: AssetRefPatchInput) => {
            setSavingRefId(refId);
            try {
                const ref = await updateAssetRef(projectId, refId, patch);
                setRefs((current) => current.map((item) => (item.id === ref.id ? ref : item)));
                return ref;
            } finally {
                setSavingRefId("");
            }
        },
        [projectId],
    );

    return { refs, loading, error, refresh, addRef, patchRef, savingRefId, creating };
}

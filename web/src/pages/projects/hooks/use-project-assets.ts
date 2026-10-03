import { useCallback, useEffect, useMemo, useState } from "react";

import { createAssetRef, updateAssetRef, type AssetRefCreateInput, type AssetRefPatchInput } from "@/services/api/projects";
import type { AssetRef } from "@/types/domain";

/** 无项目上下文时的稳定空数组，避免每次渲染都换引用而反复同步。 */
const NO_REFS: AssetRef[] = [];

/**
 * 资产工作区私有 hook：以**项目上下文（服务端）**的 AssetRef 为唯一数据源，
 * 在其上封装登记与（改绑定 / 采用产物）的写回。
 *
 * 数据源：`context.project.assetRefs`（来自 GET /api/projects/:id/context）；本 hook 不另开列表请求，
 * 也不再读前端本地素材 store。本地只缓存服务端返回，写回成功后按服务端结果替换对应条目。
 * 分组与 patch 组装在 asset-ref-model.ts，渲染在组件里。
 */
export function useProjectAssets(projectId: string, contextRefs: AssetRef[] | undefined) {
    const source = useMemo(() => contextRefs ?? NO_REFS, [contextRefs]);
    const [refs, setRefs] = useState<AssetRef[]>(source);
    const [savingRefId, setSavingRefId] = useState("");
    const [creating, setCreating] = useState(false);

    // 服务端上下文刷新（初始加载 / 手动刷新）后，本地列表随之对齐。
    useEffect(() => setRefs(source), [source]);

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

    /** 改绑定 / 切换采用产物：成功用服务端返回结果替换本地。 */
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

    return { refs, addRef, patchRef, savingRefId, creating };
}

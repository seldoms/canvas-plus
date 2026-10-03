import { useCallback, useEffect, useMemo, useState } from "react";

import { getEpisode, updateShot, type EpisodeDetail, type SceneWithShots, type ShotPatchInput } from "@/services/api/projects";
import type { Episode, Shot } from "@/types/domain";

import { applyIndexesInScenes, planShotMove, replaceShotInScenes, sortByIndex } from "../storyboard-model";

/**
 * 分镜工作区私有 hook：按选中的集拉取「场 + 镜」详情，封装镜级写回与调序。
 * 只负责取数 / 写回 / 本地落位；形状校验与排序在 storyboard-model.ts，渲染在组件里。
 */
export function useStoryboard(projectId: string, episodes: Episode[]) {
    const [episodeId, setEpisodeId] = useState("");
    const [detail, setDetail] = useState<EpisodeDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [savingShotId, setSavingShotId] = useState("");
    const [reordering, setReordering] = useState(false);

    /** 默认选中第一集；集列表变化时纠正越界选择。 */
    useEffect(() => {
        if (!episodes.length) {
            setEpisodeId("");
            return;
        }
        setEpisodeId((current) => (episodes.some((episode) => episode.id === current) ? current : episodes[0].id));
    }, [episodes]);

    const loadEpisode = useCallback(
        async (id: string) => {
            if (!projectId || !id) {
                setDetail(null);
                return;
            }
            setLoading(true);
            setError("");
            try {
                setDetail(await getEpisode(projectId, id));
            } catch (loadError) {
                setDetail(null);
                setError(loadError instanceof Error ? loadError.message : String(loadError));
            } finally {
                setLoading(false);
            }
        },
        [projectId],
    );

    useEffect(() => {
        void loadEpisode(episodeId);
    }, [episodeId, loadEpisode]);

    const sortedEpisodes = useMemo(() => sortByIndex(episodes), [episodes]);
    const scenes = useMemo<SceneWithShots[]>(
        () => (detail?.scenes ?? []).map((scene) => ({ ...scene, shots: sortByIndex(scene.shots ?? []) })).sort((a, b) => a.index - b.index),
        [detail],
    );

    /** 保存单镜：成功把服务端返回的镜写回本地；失败原样抛出，调用方提示且不回退已输入内容。 */
    const saveShot = useCallback(
        async (shotId: string, patch: ShotPatchInput) => {
            setSavingShotId(shotId);
            try {
                const shot = await updateShot(projectId, shotId, patch);
                setDetail((current) => (current ? { ...current, scenes: replaceShotInScenes(current.scenes, shot) } : current));
                return shot;
            } finally {
                setSavingShotId("");
            }
        },
        [projectId],
    );

    /** 调序：planShotMove 只产出 index 变更（不动 id），逐个 PATCH 后按新 index 落位。 */
    const moveShot = useCallback(
        async (shots: Shot[], shotId: string, delta: -1 | 1) => {
            const patches = planShotMove(shots, shotId, delta);
            if (!patches.length) return;
            setReordering(true);
            try {
                for (const patch of patches) await updateShot(projectId, patch.shotId, { index: patch.index });
                setDetail((current) => (current ? { ...current, scenes: applyIndexesInScenes(current.scenes, patches) } : current));
            } finally {
                setReordering(false);
            }
        },
        [projectId],
    );

    const refresh = useCallback(async () => {
        await loadEpisode(episodeId);
    }, [loadEpisode, episodeId]);

    return { episodeId, setEpisodeId, episodes: sortedEpisodes, scenes, loading, error, refresh, saveShot, moveShot, savingShotId, reordering };
}

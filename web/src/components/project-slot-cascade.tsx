import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Select, Spin } from "antd";
import { useTranslation } from "react-i18next";

import { getEpisode, listEpisodes, listProjects, type EpisodeDetail, type GenerationSlotView, type ProjectSummary } from "@/services/api/projects";
import type { Episode, Scene, Shot } from "@/types/domain";

/** 槽位 id 规则（与服务端 pipeline.js generationSlotsFor 一致）：slot_<shotId>_<role>，本轮只有关键帧 key。 */
export function keyframeSlotId(shotId: string) {
    return `slot_${shotId}_key`;
}

/** 级联选中的目标槽位（与画布 SlotTarget 同形，结构兼容）。 */
export type SlotCascadeTarget = {
    projectId: string;
    episodeId: string;
    sceneId: string;
    shotId: string;
    slotId: string;
};

type ShotRow = { scene: Scene; shot: Shot };

/**
 * 「项目 → 集 → 镜头 → 关键帧槽位」级联选择核心（M3-D4）：数据加载与选中态都收在这里，
 * 画布槽位对话框与生图工作台「加入项目候选」各自包壳复用，不复制粘贴。
 * 传 projectId 表示项目已固定（画布绑定）；不传则加载项目列表供选择（工作台）。
 */
export function useProjectSlotCascade({ active, projectId: fixedProjectId }: { active: boolean; projectId?: string }) {
    const { message } = App.useApp();
    const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
    const [projectId, setProjectId] = useState(fixedProjectId || "");
    const [episodes, setEpisodes] = useState<Episode[] | null>(null);
    const [episodeId, setEpisodeId] = useState<string>("");
    const [detail, setDetail] = useState<EpisodeDetail | null>(null);
    const [shotId, setShotId] = useState<string>("");
    const [slotOverride, setSlotOverride] = useState<GenerationSlotView | null>(null);

    const shotRows = useMemo<ShotRow[]>(() => (detail?.scenes || []).flatMap((scene) => (scene.shots || []).map((shot) => ({ scene, shot }))), [detail]);
    const currentRow = shotRows.find((row) => row.shot.id === shotId) || null;
    const slotId = shotId ? keyframeSlotId(shotId) : "";
    const slot = useMemo<GenerationSlotView | null>(() => {
        if (slotOverride && slotOverride.id === slotId) return slotOverride;
        const raw = currentRow?.shot.generationSlots?.find((item) => item.id === slotId || item.role === "key");
        if (!raw) return null;
        return { id: raw.id || slotId, shotId: raw.shotId, role: raw.role, selected: raw.selected ?? null, candidates: raw.candidates || [] };
    }, [currentRow, slotId, slotOverride]);
    const target = useMemo<SlotCascadeTarget | null>(() => (currentRow && episodeId && projectId ? { projectId, episodeId, sceneId: currentRow.scene.id, shotId, slotId } : null), [currentRow, episodeId, projectId, shotId, slotId]);

    const loadDetail = useCallback(
        async (nextEpisodeId: string) => {
            if (!projectId) return;
            const next = await getEpisode(projectId, nextEpisodeId);
            setDetail(next);
            const rows = (next?.scenes || []).flatMap((scene) => scene.shots || []);
            setShotId((current) => (rows.some((shot) => shot.id === current) ? current : rows[0]?.id || ""));
        },
        [projectId],
    );

    // 项目就绪（固定或已选）后加载集列表；active 翻回 true / 切换项目都会重置并重载。
    useEffect(() => {
        if (!active || !projectId) return;
        setEpisodes(null);
        setDetail(null);
        setShotId("");
        setSlotOverride(null);
        let alive = true;
        listEpisodes(projectId)
            .then(async (list) => {
                if (!alive) return;
                setEpisodes(list);
                const first = list[0]?.id || "";
                setEpisodeId(first);
                if (first) await loadDetail(first);
            })
            .catch((error) => {
                if (!alive) return;
                setEpisodes([]);
                message.error(error instanceof Error ? error.message : String(error));
            });
        return () => {
            alive = false;
        };
    }, [active, projectId, loadDetail, message]);

    // 未固定项目（工作台）时加载项目列表，默认选中第一个。
    useEffect(() => {
        if (!active || fixedProjectId) return;
        let alive = true;
        setProjects(null);
        listProjects()
            .then((list) => {
                if (!alive) return;
                setProjects(list);
                setProjectId((current) => current || list[0]?.id || "");
            })
            .catch((error) => {
                if (!alive) return;
                setProjects([]);
                message.error(error instanceof Error ? error.message : String(error));
            });
        return () => {
            alive = false;
        };
    }, [active, fixedProjectId, message]);

    useEffect(() => {
        setSlotOverride(null);
    }, [slotId]);

    const selectEpisode = useCallback(
        (nextEpisodeId: string) => {
            setEpisodeId(nextEpisodeId);
            void loadDetail(nextEpisodeId);
        },
        [loadDetail],
    );

    const refresh = useCallback(async () => {
        if (!episodeId) return;
        try {
            await loadDetail(episodeId);
        } catch {
            /* 刷新失败只影响候选列表时效，不打扰操作结果 */
        }
    }, [episodeId, loadDetail]);

    return { fixedProject: Boolean(fixedProjectId), projects, projectId, setProjectId, episodes, episodeId, selectEpisode, detail, shotRows, shotId, setShotId, slotId, slot, setSlot: setSlotOverride, target, refresh };
}

export type ProjectSlotCascade = ReturnType<typeof useProjectSlotCascade>;

/** 级联选择行：项目（固定时只读）→ 集 → 镜头；样式沿用画布槽位对话框的扁平网格。 */
export function ProjectSlotCascadeSelects({ cascade, projectTitle }: { cascade: ProjectSlotCascade; projectTitle?: string | null }) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
                <span className="mb-1 block text-xs opacity-60">{t("canvas.slotDialog.project")}</span>
                {cascade.fixedProject ? (
                    <div className="truncate rounded-md border border-stone-200 px-3 py-1.5 text-sm dark:border-stone-700">{projectTitle || cascade.projectId}</div>
                ) : (
                    <Select
                        className="w-full"
                        value={cascade.projectId || undefined}
                        loading={cascade.projects === null}
                        placeholder={t("canvas.slotDialog.project")}
                        options={(cascade.projects || []).map((project) => ({ value: project.id, label: project.title || project.id }))}
                        onChange={cascade.setProjectId}
                    />
                )}
            </label>
            <label className="block">
                <span className="mb-1 block text-xs opacity-60">{t("canvas.slotDialog.episode")}</span>
                <Select
                    className="w-full"
                    value={cascade.episodeId || undefined}
                    loading={cascade.episodes === null}
                    placeholder={t("canvas.slotDialog.episode")}
                    options={(cascade.episodes || []).map((episode) => ({ value: episode.id, label: `${episode.index}. ${episode.title || episode.id}` }))}
                    onChange={cascade.selectEpisode}
                />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs opacity-60">{t("canvas.slotDialog.shot")}</span>
                <Select
                    className="w-full"
                    value={cascade.shotId || undefined}
                    placeholder={t("canvas.slotDialog.shot")}
                    notFoundContent={cascade.detail ? t("canvas.slotDialog.noShots") : <Spin size="small" />}
                    options={cascade.shotRows.map((row) => ({ value: row.shot.id, label: `${t("canvas.slotDialog.shot")} ${row.shot.index}（${row.shot.id}）` }))}
                    onChange={cascade.setShotId}
                />
            </label>
        </div>
    );
}

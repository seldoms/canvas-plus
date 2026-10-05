import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Image, Modal, Select, Spin, Tag } from "antd";
import { FolderInput, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveGatewayUrl } from "@/services/api/gateway";
import { getEpisode, listEpisodes, selectSlotCandidate, type EpisodeDetail, type GenerationSlotView } from "@/services/api/projects";
import { generateSlotCandidateImage, importNodeImageCandidate, nodeGenerationPrompt, type SlotGeneratedImage, type SlotTarget } from "@/lib/canvas/canvas-project-slots";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { Episode, Scene, Shot } from "@/types/domain";
import type { CanvasNodeData } from "@/types/canvas";

type ShotRow = { scene: Scene; shot: Shot };

/** 槽位 id 规则（与服务端 pipeline.js generationSlotsFor 一致）：slot_<shotId>_<role>，本轮只有关键帧 key。 */
export function keyframeSlotId(shotId: string) {
    return `slot_${shotId}_key`;
}

/**
 * 槽位选择对话框（M2-D8）：项目（已绑定固定）→ 集 → 镜头 → 关键帧槽位，级联展示；
 * 候选列表带缩略图 / 状态 / 采用；「生成新候选」走服务端队列，「把当前图片加入候选」走 artifacts/import 登记。
 */
export function CanvasSlotDialog({
    open,
    node,
    projectId,
    projectTitle,
    onGenerated,
    onClose,
}: {
    open: boolean;
    node: CanvasNodeData | null;
    projectId: string;
    projectTitle?: string | null;
    /** 生成新候选成功后回调：父级据此在画布上建 artifact 图片节点。 */
    onGenerated: (image: SlotGeneratedImage, sourceNode: CanvasNodeData) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [episodes, setEpisodes] = useState<Episode[] | null>(null);
    const [episodeId, setEpisodeId] = useState<string>("");
    const [detail, setDetail] = useState<EpisodeDetail | null>(null);
    const [shotId, setShotId] = useState<string>("");
    const [slotOverride, setSlotOverride] = useState<GenerationSlotView | null>(null);
    const [busy, setBusy] = useState<"generate" | "import" | "select" | null>(null);

    const shotRows = useMemo<ShotRow[]>(() => (detail?.scenes || []).flatMap((scene) => (scene.shots || []).map((shot) => ({ scene, shot }))), [detail]);
    const currentRow = shotRows.find((row) => row.shot.id === shotId) || null;
    const slotId = shotId ? keyframeSlotId(shotId) : "";
    const slot = useMemo<GenerationSlotView | null>(() => {
        if (slotOverride && slotOverride.id === slotId) return slotOverride;
        const raw = currentRow?.shot.generationSlots?.find((item) => item.id === slotId || item.role === "key");
        if (!raw) return null;
        return { id: raw.id || slotId, shotId: raw.shotId, role: raw.role, selected: raw.selected ?? null, candidates: raw.candidates || [] };
    }, [currentRow, slotId, slotOverride]);
    const target = useMemo<SlotTarget | null>(() => (currentRow && episodeId ? { projectId, episodeId, sceneId: currentRow.scene.id, shotId, slotId } : null), [currentRow, episodeId, projectId, shotId, slotId]);

    const loadDetail = useCallback(
        async (nextEpisodeId: string) => {
            const next = await getEpisode(projectId, nextEpisodeId);
            setDetail(next);
            const rows = (next?.scenes || []).flatMap((scene) => scene.shots || []);
            setShotId((current) => (rows.some((shot) => shot.id === current) ? current : rows[0]?.id || ""));
        },
        [projectId],
    );

    useEffect(() => {
        if (!open) return;
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
    }, [open, projectId, loadDetail, message]);

    useEffect(() => {
        setSlotOverride(null);
    }, [slotId]);

    const refresh = useCallback(async () => {
        if (!episodeId) return;
        try {
            await loadDetail(episodeId);
        } catch {
            /* 刷新失败只影响候选列表时效，不打扰操作结果 */
        }
    }, [episodeId, loadDetail]);

    const run = async (kind: "generate" | "import" | "select", action: () => Promise<void>) => {
        setBusy(kind);
        try {
            await action();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(null);
        }
    };

    const handleGenerate = () => {
        if (!node || !target) return;
        void run("generate", async () => {
            const image = await generateSlotCandidateImage(node, target);
            onGenerated(image, node);
            message.success(t("canvas.slotDialog.generateSuccess"));
            await refresh();
        });
    };

    const handleImport = () => {
        if (!node || !target) return;
        void run("import", async () => {
            await importNodeImageCandidate(node, target);
            message.success(t("canvas.slotDialog.importSuccess"));
            await refresh();
        });
    };

    const handleSelect = (jobId: string) => {
        if (!target) return;
        void run("select", async () => {
            const next = await selectSlotCandidate(target.projectId, target.shotId, target.slotId, jobId);
            setSlotOverride(next);
        });
    };

    const candidates = slot?.candidates || [];
    const canGenerate = Boolean(node && target && nodeGenerationPrompt(node));
    const hasNodeImage = Boolean(node?.metadata?.content || node?.metadata?.storageKey);

    return (
        <Modal title={t("canvas.slotDialog.title")} open={open} onCancel={onClose} footer={null} centered width={640}>
            <div className="space-y-4 pt-2">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="block">
                        <span className="mb-1 block text-xs opacity-60">{t("canvas.slotDialog.project")}</span>
                        <div className="truncate rounded-md border border-stone-200 px-3 py-1.5 text-sm dark:border-stone-700">{projectTitle || projectId}</div>
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs opacity-60">{t("canvas.slotDialog.episode")}</span>
                        <Select
                            className="w-full"
                            value={episodeId || undefined}
                            loading={episodes === null}
                            placeholder={t("canvas.slotDialog.episode")}
                            options={(episodes || []).map((episode) => ({ value: episode.id, label: `${episode.index}. ${episode.title || episode.id}` }))}
                            onChange={(value) => {
                                setEpisodeId(value);
                                void loadDetail(value);
                            }}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs opacity-60">{t("canvas.slotDialog.shot")}</span>
                        <Select
                            className="w-full"
                            value={shotId || undefined}
                            placeholder={t("canvas.slotDialog.shot")}
                            notFoundContent={detail ? t("canvas.slotDialog.noShots") : <Spin size="small" />}
                            options={shotRows.map((row) => ({ value: row.shot.id, label: `${t("canvas.slotDialog.shot")} ${row.shot.index}（${row.shot.id}）` }))}
                            onChange={setShotId}
                        />
                    </label>
                </div>

                <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{t("canvas.slotDialog.candidates")}</span>
                        <Tag className="m-0">{slotId || t("canvas.slotDialog.keySlot")}</Tag>
                    </div>
                    {!shotId ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.slotDialog.noShots")} />
                    ) : candidates.length ? (
                        <div className="thin-scrollbar grid max-h-72 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
                            {candidates.map((candidate) => {
                                const selected = slot?.selected === candidate.jobId;
                                return (
                                    <div key={candidate.jobId} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700" style={selected ? { background: theme.toolbar.activeBg } : undefined}>
                                        {candidate.artifactUrl ? (
                                            <Image src={resolveGatewayUrl(candidate.artifactUrl)} alt={candidate.jobId} className="aspect-square w-full object-cover" />
                                        ) : (
                                            <div className="grid aspect-square w-full place-items-center text-xs opacity-50">{candidate.status || "—"}</div>
                                        )}
                                        <div className="space-y-1.5 px-2 py-2">
                                            <div className="flex items-center justify-between gap-2 text-xs">
                                                <span className="truncate opacity-70" title={candidate.jobId}>
                                                    {candidate.jobId}
                                                </span>
                                                {candidate.status ? <Tag className="m-0 shrink-0">{candidate.status}</Tag> : null}
                                            </div>
                                            {selected ? (
                                                <div className="text-center text-xs font-medium">{t("canvas.slotDialog.adopted")}</div>
                                            ) : (
                                                <Button size="small" block loading={busy === "select"} onClick={() => handleSelect(candidate.jobId)}>
                                                    {t("canvas.slotDialog.adopt")}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.slotDialog.empty")} />
                    )}
                </div>

                {node ? (
                    <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
                        <Button icon={<Sparkles className="size-4" />} loading={busy === "generate"} disabled={!canGenerate || (busy !== null && busy !== "generate")} onClick={handleGenerate}>
                            {t("canvas.slotDialog.generate")}
                        </Button>
                        <Button icon={<FolderInput className="size-4" />} loading={busy === "import"} disabled={!hasNodeImage || !target || (busy !== null && busy !== "import")} onClick={handleImport}>
                            {t("canvas.slotDialog.importImage")}
                        </Button>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

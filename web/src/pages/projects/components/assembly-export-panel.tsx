import { useState } from "react";
import { Alert, Button, Card, Space, Spin, Typography } from "antd";
import { saveAs } from "file-saver";
import { Clapperboard, Download, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { downloadArtifactBlob } from "@/services/api/delivery";

import { useAssemblyExport } from "../hooks/use-assembly-export";
import { usePipelineQualityCheck } from "../hooks/use-pipeline-quality-check";
import type { StageStatusMap, WorkspaceGate } from "../workspace-gates";
import { DeliveryExportButton } from "./delivery-export-button";
import { FilmPreviewModal } from "./film-preview-modal";

/** 单文件下载上限；超过不读进内存（与交付包导出同一口径）。 */
const MAX_FILM_BYTES = 512 * 1024 * 1024;

/**
 * 「导出成片」入口：片段合成完成之后，把片段拼成成片并给站内下载。
 *
 * 前置判定全部来自服务端：门禁读 `/gates`（gate），片段是否全部完成读 run 的阶段状态（stageStatus）；
 * 前端不自己算片段就绪。点击调 `POST .../steps/assembly/assemble`，进行中读服务端进度，
 * 完成给站内「下载成片 / 导出交付包」，失败给可读原因与重试。
 */
export function AssemblyExportPanel({
    projectId,
    runId,
    gate,
    stageStatus,
    refresh,
}: {
    projectId: string;
    runId: string;
    gate: WorkspaceGate;
    stageStatus: StageStatusMap;
    refresh: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const { assembly, assembling, progressLabel, error, assemble } = useAssemblyExport({ runId, refresh });
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState("");
    const [previewOpen, setPreviewOpen] = useState(false);
    const { report: qualityReport, checking: checkingQuality, error: qualityError, check: checkQuality } = usePipelineQualityCheck(runId, assembly?.status === "done" ? assembly.url : undefined);

    // 前置：门禁（服务端 /gates）就绪 + 片段阶段已完成（服务端 run 阶段状态）。
    const stageDone = stageStatus["assembly"] === "done";
    const done = assembly?.status === "done" && Boolean(assembly.url);
    const canAssemble = Boolean(runId) && gate.state === "ready" && stageDone && !assembling;
    const durationSec = Math.round(Number(assembly?.info?.durationSec) || 0);


    /** 不可点原因：优先服务端门禁原因，其次「片段未全部完成」。 */
    const blockedReason = () => {
        if (!runId || gate.state === "unknown") return t("projects.assembly.gateUnknown");
        if (gate.state === "blocked") {
            const parts = gate.blockedStages.map((stage) => t("projects.workspace.gate.blockedStage", { stage: t(`pipeline.stages.${stage}`) }));
            if (gate.reason) parts.push(t("projects.workspace.gate.serverReason", { reason: gate.reason }));
            return parts.join(" ") || t("projects.assembly.gateBlocked");
        }
        if (!stageDone) return t("projects.assembly.clipsPending");
        return "";
    };

    /** 站内下载成片（拉字节 → saveAs）；不跳新页。 */
    const downloadFilm = async () => {
        if (!assembly?.url || downloading) return;
        setDownloadError("");
        setDownloading(true);
        try {
            const result = await downloadArtifactBlob(assembly.url, MAX_FILM_BYTES);
            if (!result.ok) {
                setDownloadError(result.reason);
                return;
            }
            saveAs(result.blob, `${assembly.deliverableId || runId}.mp4`);
        } finally {
            setDownloading(false);
        }
    };


    return (
        <section>
            <Typography.Title level={5} className="!mb-2">
                {t("projects.assembly.title")}
            </Typography.Title>
            <Card size="small">
                <Space direction="vertical" size={12} className="w-full">
                    {!canAssemble && !done && !assembling ? <Alert type="warning" showIcon message={t("projects.assembly.blocked")} description={blockedReason()} /> : null}

                    {assembling ? (
                        <div className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-300">
                            <Spin size="small" />
                            <span className="font-medium">{progressLabel || t("projects.assembly.assembling")}</span>
                        </div>
                    ) : null}

                    {done ? (
                        <Alert
                            type={assembly?.quality?.status === "blocked" ? "warning" : "info"}
                            showIcon
                            message={t("projects.assembly.done")}
                            description={durationSec > 0 ? t("projects.assembly.duration", { seconds: durationSec }) : undefined}
                        />
                    ) : null}

                    {done || assembly?.quality ? (
                        <Alert
                            type={assembly?.quality?.status === "blocked" ? "error" : "warning"}
                            showIcon
                            message={t(assembly?.quality?.status === "blocked" ? "projects.assembly.qualityBlocked" : "projects.assembly.qualityPending")}
                            description={
                                <Space direction="vertical" size={4}>
                                    <span>{t("projects.assembly.qualityReview")}</span>
                                    {assembly?.audioMode ? <span>{t(assembly.audioMode === "embedded" ? "projects.assembly.nativeAudio" : "projects.assembly.separateAudio")}</span> : null}
                                    {assembly?.audioMode === "separate_dialogue_track" && assembly.lipSync ? <span>{t("projects.assembly.lipSyncCoverage", assembly.lipSync)}</span> : null}
                                    {assembly?.quality?.dialogueTiming?.map((cue) => <span key={cue.cueId}>{t("projects.assembly.cueTiming", { shot: cue.shotId, start: cue.startSec.toFixed(2), duration: cue.durationSec.toFixed(2) })}</span>)}
                                    {assembly?.quality?.issues.map((issue, index) => <span key={`${issue.code}-${issue.cueId || issue.shotId || index}`}>{issue.message}</span>)}
                                </Space>
                            }
                        />
                    ) : null}

                    {qualityReport ? (
                        <Alert
                            type={qualityReport.stale ? "warning" : qualityReport.status === "blocked" ? "error" : qualityReport.status === "needs_review" ? "warning" : "success"}
                            showIcon
                            message={qualityReport.stale ? t("projects.assembly.qcStale") : t("projects.assembly.qcResult", { count: qualityReport.summary.total })}
                            description={qualityReport.issues.length ? qualityReport.issues.map((issue, index) => <div key={`${issue.code}-${index}`}>{issue.message}</div>) : t("projects.assembly.qcPassed")}
                        />
                    ) : null}
                    {qualityError ? <Alert type="error" showIcon message={t("projects.assembly.qcFailed")} description={qualityError} /> : null}

                    {error ? <Alert type="error" showIcon message={t("projects.assembly.failed")} description={error} /> : null}
                    {downloadError ? <Alert type="error" showIcon message={t("projects.assembly.downloadFailedTitle")} description={downloadError} /> : null}

                    <Space wrap align="center">
                        {assembling ? (
                            <Button type="primary" loading disabled>
                                {t("projects.assembly.assembling")}
                            </Button>
                        ) : (
                            <Button
                                type="primary"
                                icon={<Clapperboard className="size-4" />}
                                disabled={!canAssemble}
                                onClick={() => void assemble(done ? { force: true } : undefined)}
                            >
                                {done ? t("projects.assembly.reassemble") : t("projects.assembly.assemble")}
                            </Button>
                        )}

                        {done ? (
                            <Button icon={<Play className="size-4" />} onClick={() => setPreviewOpen(true)}>
                                {t("projects.assembly.previewFilm")}
                            </Button>
                        ) : null}

                        {done ? (
                            <Button icon={<Download className="size-4" />} loading={downloading} onClick={() => void downloadFilm()}>
                                {t("projects.assembly.downloadFilm")}
                            </Button>
                        ) : null}

                        {done ? <DeliveryExportButton projectId={projectId} /> : null}

                        {done ? (
                            <Button icon={<RefreshCw className="size-4" />} loading={checkingQuality} onClick={() => void checkQuality()}>
                                {t("projects.assembly.runQc")}
                            </Button>
                        ) : null}

                        {error && !assembling ? <Button onClick={() => void assemble()}>{t("projects.retry")}</Button> : null}
                    </Space>
                </Space>
            </Card>
            <FilmPreviewModal
                open={previewOpen}
                filmUrl={assembly?.url}
                subtitlesUrl={assembly?.subtitles?.url}
                onClose={() => setPreviewOpen(false)}
            />
        </section>
    );
}

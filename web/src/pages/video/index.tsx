import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Drawer, Empty, Input, Modal, Tag } from "antd";
import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Download, FolderPlus, History, ListPlus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { ArtifactActions, type ArtifactTarget } from "@/components/artifact-actions";
import { AttachAssetModal } from "@/components/attach-asset-modal";
import { AttributionPicker, attributionFields } from "@/components/attribution-picker";
import { type SlotCascadeTarget } from "@/components/project-slot-cascade";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoModeLabel, videoSizeLabel } from "@/components/video-settings-panel";
// 工作台共享件：任务队列 / 参数快照 / 取消·归档 卡片 —— 与生图工作台同一套。
import { QueuePanel, SnapshotPanel, FailedMediaCard, PendingMediaCard, archiveTargetsFromJobs, buildQueueEntries, cancelWorkbenchJobs, countTaskJobs, deriveTaskStatus, isActiveJobStatus, jobDurationMs, jobIdsForItemIds, taskStatusColor, taskStatusLabelKey, useMonotonicPercent, usePreviewVerticalArrows, type WorkbenchJob, type WorkbenchLogView, type WorkbenchQueueEntry, type WorkbenchSnapshotTag, type WorkbenchTask, type WorkbenchThumb } from "@/components/workbench";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { clampVideoSeconds, inferVideoRatio, readVideoDimensions } from "@/lib/media-size";
import { findTemplate, loadTemplateCatalog, type GatewayTemplateInfo } from "@/services/api/template-sizes";
import { gatewayArtifactPath, resolveGatewayUrl, uploadGatewayAsset } from "@/services/api/gateway";
import { cancelVideoJob, enqueueVideoJob, getVideoJob, listVideoJobs } from "@/services/api/video-jobs";
import { ensureImagePreview, getImageBlob, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { boolConfig, modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type VideoResult = { url: string };

type VideoLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">;

/** 提交那一刻的参数快照（历史事实，绝不随后续表单编辑而变）。 */
type VideoSnapshot = {
    config: VideoLogConfig;
    references: ReferenceImage[];
    /** 提交时表单里显示的模型名（人读）；config 里存裸模板名。 */
    modelLabel?: string;
    /** 提交那一刻冻结的归因（P2-B4）。从 job.meta 重建历史记录时据此还原。 */
    attribution?: SlotCascadeTarget;
};

/** 视频任务组：一次提交 = 一个服务端 job；状态/进度全部读后端。 */
type VideoTask = WorkbenchTask & {
    snapshot: VideoSnapshot;
    agentTaskId?: string;
};

/** 历史记录：服务端 job 重建，带该次快照与结果地址。 */
type VideoLog = WorkbenchLogView & {
    prompt: string;
    snapshot: VideoSnapshot;
    url?: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

/**
 * 少数视频模板声明了采样步数 STEPS 且模板本身无默认值（如 H3 文生视频）。
 * 编排器从「规则表参数档」取；工作台没有那张表，这里按官方 speed 档给最小可用值 ——
 * 不给就整条模板跑不起来（runJob 会报「缺少参数：STEPS」）。
 */
const TEMPLATE_STEPS: Record<string, number> = { video_minimax_h3_t2v: 8 };

/** H3 的 LENGTH 是帧数（fps=24）且必须落在 17n+5 网格（不能把秒数直接当帧数）。 */
function frameCountForSeconds(value: string): number {
    const seconds = Number(normalizeVideoSeconds(value)) || 5;
    const frames = Math.max(1, Math.round(seconds * 24));
    return 17 * Math.max(0, Math.round((frames - 5) / 17)) + 5;
}

function normalizeVideoSeconds(value: string) {
    if (String(value).trim() === "-1") return "-1";
    return clampVideoSeconds(value);
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function buildVideoLogConfig(config: AiConfig, templateName: string): VideoLogConfig {
    return {
        model: config.model,
        videoModel: templateName,
        size: normalizeVideoSize(config.size),
        vquality: normalizeResolution(config.vquality),
        videoSeconds: normalizeVideoSeconds(config.videoSeconds),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
}

/** 视频标签：模型 / 规格 / 分辨率 / 时长（值直接展示，不做解释性小字）。 */
function videoSnapshotTags(snapshot: VideoSnapshot): WorkbenchSnapshotTag[] {
    const { config } = snapshot;
    const modelName = snapshot.modelLabel || config.videoModel || config.model;
    return [
        ...(modelName ? [{ label: modelName, color: "blue" }] : []),
        ...(config.size ? [{ label: config.size }] : []),
        ...(config.vquality ? [{ label: `${config.vquality}p` }] : []),
        ...(config.videoSeconds ? [{ label: `${config.videoSeconds}s` }] : []),
    ];
}

/** 提交参数（按模板声明的 token 填充）；缺必需素材时抛错，绝不半成品入队。 */
function buildVideoParams({ template, prompt, config, comfyRefs }: { template: GatewayTemplateInfo | null; prompt: string; config: AiConfig; comfyRefs: string[] }): Record<string, unknown> {
    const known = Boolean(template);
    const tokens = template?.tokens ?? [];
    const has = (token: string) => (known ? tokens.includes(token) : ["PROMPT", "WIDTH", "HEIGHT", "LENGTH", "SEED", "INPUT_IMAGE"].includes(token));
    const params: Record<string, unknown> = {};
    const dims = readVideoDimensions(config.size, normalizeResolution(config.vquality), inferVideoRatio(config.size));
    if (has("PROMPT")) params.PROMPT = prompt;
    if (has("WIDTH") && dims.width) params.WIDTH = dims.width;
    if (has("HEIGHT") && dims.height) params.HEIGHT = dims.height;
    if (has("LENGTH")) params.LENGTH = frameCountForSeconds(config.videoSeconds);
    if (has("STEPS") && template && TEMPLATE_STEPS[template.name] !== undefined) params.STEPS = TEMPLATE_STEPS[template.name];
    if (has("SEED")) params.SEED = Math.floor(Math.random() * 2147483647);

    const imageTokens = known ? tokens.filter((token) => token === "INPUT_IMAGE" || token === "PERSON_IMAGE" || token === "CLOTHING_IMAGE" || /^REF_IMAGE_\d+$/.test(token)) : ["INPUT_IMAGE"];
    if (imageTokens.length && !comfyRefs.length) throw new Error(i18n.t("videoWorkbench.referenceRequired", { model: template?.name || "" }));
    imageTokens.forEach((token, index) => {
        if (comfyRefs[index]) params[token] = comfyRefs[index];
    });
    if (has("REF_VIDEO") && !has("INPUT_IMAGE") && !comfyRefs.length) throw new Error(i18n.t("videoWorkbench.referenceRequired", { model: template?.name || "" }));
    return params;
}

/** 写进 job.meta 的提交事实 —— 服务端持久化的快照，刷新/换设备后据此重建队列与记录。 */
function buildVideoMeta({
    prompt,
    snapshot,
    template,
    attribution,
}: {
    prompt: string;
    snapshot: VideoSnapshot;
    template: string;
    /** 提交那一刻冻结的归因（P2-B4）；null = 不归因。 */
    attribution?: SlotCascadeTarget | null;
}): Record<string, unknown> {
    return {
        // source 也提到请求体顶层由服务端读（index.js 的 intent.source）；这里留在 meta 里
        // 是因为「哪些 job 属于创作台」靠 meta.runId 判（isWorkbenchVideoJob），保持可自证。
        source: "video-workbench",
        prompt,
        model: template,
        ...(snapshot.modelLabel ? { modelLabel: snapshot.modelLabel } : {}),
        size: snapshot.config.size,
        resolution: snapshot.config.vquality,
        seconds: snapshot.config.videoSeconds,
        mode: snapshot.config.videoMode,
        generateAudio: snapshot.config.videoGenerateAudio,
        watermark: snapshot.config.videoWatermark,
        references: snapshot.references.map((item) => ({ id: item.id, name: item.name, storageKey: item.storageKey || "" })),
        // 归因五元组（服务端 /api/generate/* 从 meta 提进 context）。不写 runId/stageId ——
        // 写了会被服务端跳过画布投影，也会让 isWorkbenchVideoJob 把这条当成流水线产物。
        ...(attribution ? attributionFields(attribution) : {}),
    };
}

/** 只有「工作台视频」（无流水线 meta）才算创作台的记录，排除流水线阶段产出的视频任务。 */
function isWorkbenchVideoJob(job: WorkbenchJob): boolean {
    const meta = job.meta || {};
    return !meta.runId && !meta.stageId;
}

function snapshotFromJob(job: WorkbenchJob): VideoSnapshot {
    const meta = (job.meta || {}) as Record<string, unknown>;
    const params = (job.params || {}) as Record<string, unknown>;
    const width = params.WIDTH;
    const height = params.HEIGHT;
    const config: VideoLogConfig = {
        model: String(meta.model ?? job.template ?? ""),
        videoModel: String(meta.model ?? job.template ?? ""),
        size: String(meta.size ?? (width && height ? `${width}x${height}` : "")),
        vquality: String(meta.resolution ?? ""),
        videoSeconds: String(meta.seconds ?? ""),
        videoGenerateAudio: String(meta.generateAudio ?? "true"),
        videoWatermark: String(meta.watermark ?? "false"),
        videoMode: meta.mode === "reference" ? "reference" : "frames",
    };
    const rawRefs = Array.isArray(meta.references) ? (meta.references as Array<Record<string, unknown>>) : [];
    // 归因从 job.meta 还原：刷新/换设备后历史记录仍能显示「这段属于哪一镜」。
    // slotId 缺失就**留空**，不按规则补 —— 补出来的是一个服务端从未创建过的槽位 id，
    // 界面上看着「已归因到 clip 槽位」，用户重试时却会拿着假 slotId 去提交，
    // 服务端 `slotRoleOf` 对不上就是 400，或者更糟：静默落到一个错槽位上。
    const attrProject = String(meta.projectId ?? "");
    const attrShot = String(meta.shotId ?? "");
    const attrSlot = String(meta.slotId ?? "");
    const attribution: SlotCascadeTarget | undefined = attrProject && attrShot
        ? {
              projectId: attrProject,
              episodeId: String(meta.episodeId ?? ""),
              sceneId: String(meta.sceneId ?? ""),
              shotId: attrShot,
              slotId: attrSlot,
          }
        : undefined;
    return {
        config,
        references: rawRefs.map((item) => ({ id: String(item.id ?? item.storageKey ?? ""), name: String(item.name ?? ""), type: "", dataUrl: "", storageKey: String(item.storageKey ?? "") })),
        ...(typeof meta.modelLabel === "string" ? { modelLabel: meta.modelLabel } : {}),
        ...(attribution ? { attribution } : {}),
    };
}

function taskFromJob(job: WorkbenchJob): VideoTask {
    const meta = (job.meta || {}) as Record<string, unknown>;
    const params = (job.params || {}) as Record<string, unknown>;
    const createdAt = job.createdAt || new Date().toISOString();
    return {
        id: job.id,
        prompt: String(meta.prompt ?? params.PROMPT ?? ""),
        count: 1,
        template: job.template || "",
        jobIds: [job.id],
        startedAt: Date.parse(createdAt) || Date.now(),
        createdAt,
        snapshot: snapshotFromJob(job),
    };
}

function logFromTask(task: VideoTask, job: WorkbenchJob): VideoLog {
    const url = (job.outputs || []).find((output) => output.url)?.url;
    return {
        id: task.id,
        createdAt: task.startedAt,
        title: task.prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        status: job.status === "done" ? "success" : job.status === "canceled" ? "canceled" : "failed",
        durationMs: jobDurationMs(job),
        successCount: job.status === "done" ? 1 : 0,
        failCount: job.status === "error" ? 1 : 0,
        itemCount: 1,
        thumbnails: [],
        prompt: task.prompt,
        snapshot: task.snapshot,
        ...(url ? { url: resolveGatewayUrl(url) } : {}),
    };
}

function logFromJob(job: WorkbenchJob): VideoLog {
    return logFromTask(taskFromJob(job), job);
}

/** 提交进队列时左栏只需要「结果缩略图」，视频没有可用的静态缩略图 → 空数组（走图标占位）。 */
const videoTaskThumbnails = (): WorkbenchThumb[] => [];

export default function VideoPage() {
    usePreviewVerticalArrows();
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [tasks, setTasks] = useState<VideoTask[]>([]);
    const [jobs, setJobs] = useState<Record<string, WorkbenchJob>>({});
    const [logs, setLogs] = useState<VideoLog[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    /** 「归入项目资料包」弹窗当前携带的产物（null = 关闭）；与「存入我的素材」是**两条独立动线**。 */
    const [attachTarget, setAttachTarget] = useState<{ url: string; jobId?: string; name?: string } | null>(null);
    // 生成归因（P2-B4）：视频落片段槽位（slotRole=clip，与项目页续接链同一槽位）。
    const [attribution, setAttribution] = useState<SlotCascadeTarget | null>(null);
    const [attributionOpen, setAttributionOpen] = useState(false);
    const [nowTick, setNowTick] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const [videoTemplates, setVideoTemplates] = useState<GatewayTemplateInfo[]>([]);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const tasksRef = useRef<VideoTask[]>([]);
    const jobsRef = useRef<Record<string, WorkbenchJob>>({});
    const restoredRef = useRef(false);
    const finalizedRef = useRef<Set<string>>(new Set());
    const bubbledErrorsRef = useRef<Set<string>>(new Set());

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const hasRunningTask = tasks.some((task) => task.jobIds.some((id) => isActiveJobStatus(jobs[id]?.status)));
    const tasksSignature = tasks.map((task) => task.jobIds.join(",")).join("|");

    useEffect(() => {
        tasksRef.current = tasks;
    }, [tasks]);
    useEffect(() => {
        jobsRef.current = jobs;
    }, [jobs]);

    useEffect(() => {
        if (!hasRunningTask) return;
        setNowTick(performance.now());
        const timer = window.setInterval(() => setNowTick(performance.now()), 1000);
        return () => window.clearInterval(timer);
    }, [hasRunningTask]);

    // 视频模板清单（含 token / 档位）：提交时按模板声明的槽位填参数；网关不可达时退回通用槽位。
    useEffect(() => {
        let alive = true;
        void loadTemplateCatalog("video")
            .then((templates) => {
                if (alive) setVideoTemplates(templates);
            })
            .catch(() => {
                if (alive) setVideoTemplates([]);
            });
        return () => {
            alive = false;
        };
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, 7 - references.length);
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, 7));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setIsReferenceDragActive(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setIsReferenceDragActive(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.slice(0, 7 - references.length).map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, 7));
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("videoWorkbench.clipboardEmpty"));
        }
    };

    /** 参考图上传到网关，拿回可被后端 resolve 的素材名。 */
    const resolveReferenceUrls = async (list: ReferenceImage[]): Promise<string[]> => {
        const urls: string[] = [];
        for (const item of list) {
            const blob = item.storageKey ? await getImageBlob(item.storageKey) : item.dataUrl ? await (await fetch(item.dataUrl)).blob() : null;
            if (!blob) throw new Error(t("videoWorkbench.referenceUploadFailed", { name: item.name }));
            const { comfyName } = await uploadGatewayAsset(blob);
            urls.push(comfyName);
        }
        return urls;
    };

    /** 提交 → 当帧落一条队列记录 → 服务端入队 → 原地补齐 jobId；状态/进度此后从 GET /api/jobs 读。 */
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }

        const templateName = modelOptionName(model);
        const snapshot: VideoSnapshot = {
            config: buildVideoLogConfig(effectiveConfig, templateName),
            references: [...references],
            modelLabel: modelOptionLabel(effectiveConfig, model),
            ...(attribution ? { attribution } : {}),
        };
        const localId = nanoid();
        // 提交即落记录：当帧就在左栏出现（状态=排队中），不等上传/入队返回。
        setTasks((value) => [
            {
                id: localId,
                prompt: text,
                count: 1,
                template: templateName,
                jobIds: [],
                startedAt: performance.now(),
                createdAt: new Date().toISOString(),
                snapshot,
                pending: true,
                ...(agentTaskId ? { agentTaskId } : {}),
            },
            ...value,
        ]);
        setSelectedId(localId);
        setSubmitting(true);
        try {
            const comfyRefs = await resolveReferenceUrls(references);
            const template = findTemplate(videoTemplates, templateName);
            const params = buildVideoParams({ template, prompt: text, config: effectiveConfig, comfyRefs });
            const job = await enqueueVideoJob({ template: templateName, name: `canvas_video_${Date.now()}`, params, meta: buildVideoMeta({ prompt: text, snapshot, template: templateName, attribution }) });
            setJobs((value) => ({ ...value, [job.id]: job }));
            // 原地补齐 jobId / 真实模板（记录 id 不变，选中态不跳）。
            setTasks((value) => value.map((item) => (item.id === localId ? { ...item, jobIds: [job.id], pending: false, template: job.template || templateName } : item)));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // 提交失败 → 撤掉占位记录，不留误导性条目。
            setTasks((value) => value.filter((item) => item.id !== localId));
            setSelectedId((current) => (current === localId ? null : current));
            message.error(t("videoWorkbench.submitFailed", { message: reason }));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: reason });
        } finally {
            setSubmitting(false);
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && hasRunningTask) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, hasRunningTask, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadVideo = (url: string) => {
        window.open(url, "_blank");
    };

    const saveResultToAssets = async (url: string) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url, storageKey: "", width: 0, height: 0, bytes: 0, mimeType: "video/mp4" },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    /**
     * 打开「归入项目资料包」：先校验产物是不是网关产物（本地临时地址存进AssetRef 后无法回看），
     * 不合格就直接提示，不让用户填完表才发现白填。
     */
    const startAttachPack = (url: string, jobId?: string) => {
        const path = gatewayArtifactPath(url);
        if (!path) {
            message.warning(t("attachAsset.localOnly"));
            return;
        }
        setAttachTarget({ url: path, jobId, name: t("videoWorkbench.resultTitle") });
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), type: stored.mimeType, name: payload.title, dataUrl: stored.url, storageKey: stored.storageKey }].slice(0, 7));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setTasks([]);
        setNowTick(0);
        setSelectedId(null);
    };

    /**
     * 取消一组 job：**与生图工作台走同一个 `cancelWorkbenchJobs`**（共享件，口径不再各写一套）。
     * 先筛掉已结束的，再逐个调服务端 cancel，回来后以服务端状态/产物为准；失败只提示、不抛。
     */
    const cancelJobs = async (jobIds: string[]) => {
        const active = jobIds.filter((id) => isActiveJobStatus(jobs[id]?.status));
        if (!active.length) return;
        const { failed } = await cancelWorkbenchJobs(active, async (id) => {
            const job = await cancelVideoJob(id);
            setJobs((value) => ({ ...value, [job.id]: job }));
        });
        if (failed) message.error(t("tasks.cancelFailed"));
    };

    /** 取消单个 job。 */
    const cancelJob = (jobId: string) => cancelJobs([jobId]);

    /** 重试：按同一快照再入队一个 job，替换掉失败那条（记录 id 不变）。 */
    const retryTask = async (task: VideoTask) => {
        try {
            const comfyRefs = await resolveReferenceUrls(task.snapshot.references);
            const template = findTemplate(videoTemplates, task.snapshot.config.videoModel || task.template);
            const params = buildVideoParams({ template, prompt: task.prompt, config: { ...effectiveConfig, ...task.snapshot.config }, comfyRefs });
            const job = await enqueueVideoJob({ template: task.snapshot.config.videoModel || task.template, name: `canvas_video_${Date.now()}`, params, meta: buildVideoMeta({ prompt: task.prompt, snapshot: task.snapshot, template: task.snapshot.config.videoModel || task.template, attribution: task.snapshot.attribution || null }) });
            finalizedRef.current.delete(task.id);
            setLogs((value) => value.filter((log) => log.id !== task.id));
            setJobs((value) => ({ ...value, [job.id]: job }));
            setTasks((value) => [{ ...task, jobIds: [job.id], pending: false, startedAt: performance.now(), createdAt: new Date().toISOString() }, ...value.filter((item) => item.id !== task.id)]);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            message.error(t("videoWorkbench.submitFailed", { message: reason }));
        }
    };

    const retryJob = async (jobId: string) => {
        const task = tasks.find((item) => item.jobIds.includes(jobId));
        if (task) await retryTask(task);
    };

    // 进页先按服务端 job 恢复：刷新/切页/换设备后队列与记录仍在（记录持久化在 jobs.json，不是浏览器）。
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const list = await listVideoJobs({ limit: 200 });
                if (!alive) return;
                const workbench = list.filter(isWorkbenchVideoJob);
                const jobMap: Record<string, WorkbenchJob> = {};
                for (const job of workbench) jobMap[job.id] = job;
                const restoredTasks: VideoTask[] = [];
                const restoredLogs: VideoLog[] = [];
                for (const job of workbench) {
                    if (isActiveJobStatus(job.status)) restoredTasks.push(taskFromJob(job));
                    else restoredLogs.push(logFromJob(job));
                }
                restoredLogs.sort((a, b) => b.createdAt - a.createdAt);
                setJobs((value) => ({ ...jobMap, ...value }));
                setTasks((value) => {
                    const existing = new Set(value.map((task) => task.id));
                    return [...restoredTasks.filter((task) => !existing.has(task.id)), ...value];
                });
                setLogs((value) => {
                    const existing = new Set(value.map((log) => log.id));
                    return [...restoredLogs.filter((log) => !existing.has(log.id)).slice(0, 60), ...value];
                });
            } catch {
                // 拉取失败：不恢复、也不阻塞工作台。
            } finally {
                if (alive) restoredRef.current = true;
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    // 活动任务每 3s 轮询单条 job；全部结束即停。
    useEffect(() => {
        const ids = tasksRef.current.flatMap((task) => task.jobIds);
        if (!ids.length) return;
        let cancelled = false;
        let timer: number | undefined;
        const stop = () => {
            if (timer) {
                window.clearInterval(timer);
                timer = undefined;
            }
        };
        const tick = async () => {
            const active = tasksRef.current.flatMap((task) => task.jobIds).filter((id) => isActiveJobStatus(jobsRef.current[id]?.status));
            if (!active.length) {
                stop();
                return;
            }
            const fetched = await Promise.all(active.map((id) => getVideoJob(id).catch(() => null)));
            if (cancelled) return;
            const updates: Record<string, WorkbenchJob> = {};
            for (const job of fetched) if (job) updates[job.id] = job;
            if (Object.keys(updates).length) setJobs((value) => ({ ...value, ...updates }));
            for (const job of fetched) {
                if (job && job.status === "error" && !bubbledErrorsRef.current.has(job.id)) {
                    bubbledErrorsRef.current.add(job.id);
                    message.error(t("videoWorkbench.jobFailed", { message: job.error || t("workbench.generationFailed") }));
                }
            }
        };
        void tick();
        timer = window.setInterval(() => void tick(), 3000);
        return () => {
            cancelled = true;
            stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tasksSignature]);

    // 任务到终态 → 落一条历史记录（正常完成 / 失败 / 取消都覆盖）；记录 id 与 job 一致，队列按 id 去重。
    useEffect(() => {
        for (const task of tasks) {
            const jobId = task.jobIds[0];
            if (!jobId) continue;
            const job = jobs[jobId];
            if (!job || isActiveJobStatus(job.status)) continue;
            if (finalizedRef.current.has(task.id)) continue;
            finalizedRef.current.add(task.id);
            const log = logFromTask(task, job);
            setLogs((value) => [log, ...value.filter((item) => item.id !== log.id)]);
            setTasks((value) => value.filter((item) => item.id !== task.id));
            if (task.agentTaskId) {
                updateAgentTask(task.agentTaskId, { status: job.status === "done" ? "succeeded" : "failed", successCount: job.status === "done" ? 1 : 0, failCount: job.status === "done" ? 0 : 1, error: job.status === "done" ? undefined : job.error || t("workbench.generationFailed") });
            }
        }
    }, [tasks, jobs, updateAgentTask, t]);

    // 恢复的参数快照里参考图只有 storageKey（dataUrl 已瘦身）→ 触发缩略图重建。
    useEffect(() => {
        if (!restoredRef.current) return;
        for (const log of logs) for (const reference of log.snapshot.references) if (reference.storageKey) void ensureImagePreview(reference.storageKey);
    }, [logs]);

    const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;
    const selectedLog = selectedTask ? null : (logs.find((log) => log.id === selectedId) ?? null);
    const detailTask = selectedTask ?? (selectedLog ? null : (tasks[0] ?? null));
    const detailLog = selectedLog ?? (detailTask ? null : (logs[0] ?? null));
    // 归档目标（规范 §2.5）：**从该次任务的产物清单现算**（与生图工作台同一个 `archiveTargetsFromJobs`），
    // 记录里即使没存 artifactUrl / jobIds 也出得来归档入口。
    const logArchiveTargets = detailLog
        ? archiveTargetsFromJobs(jobIdsForItemIds([detailLog.id], jobs).map((id) => jobs[id]), [detailLog.url])
        : [];
    // 队列时间线：本次任务 ∪ 历史记录（按 id 去重 + 时间倒序），交给共享队列面板渲染。
    const queueEntries: WorkbenchQueueEntry[] = buildQueueEntries({ tasks, logs, jobs, taskThumbnails: videoTaskThumbnails });

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <QueuePanel entries={queueEntries} jobs={jobs} now={nowTick} selectedId={detailTask?.id ?? detailLog?.id ?? null} onSelect={setSelectedId} selectedLogIds={[]} onCreateSession={createSession} />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("videoWorkbench.title")}</h1>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    {t("workbench.logs")}
                                </Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.settings")}
                                </Button>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("workbench.prompt")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("videoWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("videoWorkbench.references")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={handleReferenceDragEnter}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label={t("videoWorkbench.removeImage")}>
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {normalizeResolution(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s · {videoModeLabel(effectiveConfig.videoMode)}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            {/* 归因可选：不选照旧生成；已归因则显示可点的归属标签。 */}
                            <div className="mb-2">
                                {attribution ? (
                                    <Tag className="m-0 cursor-pointer" color="blue" onClick={() => setAttributionOpen(true)} title={t("attribution.change")}>
                                        {t("attribution.current", { shot: attribution.shotId })}
                                    </Tag>
                                ) : (
                                    <Button size="small" type="text" icon={<ListPlus className="size-4" />} onClick={() => setAttributionOpen(true)}>
                                        {t("attribution.entry")}
                                    </Button>
                                )}
                            </div>
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={submitting} disabled={!canGenerate || submitting} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                                <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                                {tasks.length ? <Tag className="m-0">{t("workbench.tasksSubmitted", { count: tasks.length })}</Tag> : null}
                            </div>
                        </div>
                        {detailTask ? (
                            <div className="space-y-4">
                                <SnapshotPanel prompt={detailTask.prompt} tags={videoSnapshotTags(detailTask.snapshot)} references={detailTask.snapshot.references} />
                                <VideoTaskGroup task={detailTask} jobs={detailTask.jobIds.map((id) => jobs[id]).filter((job): job is WorkbenchJob => Boolean(job))} now={nowTick} onCancelJob={(jobId) => void cancelJob(jobId)} onCancelJobs={(ids) => void cancelJobs(ids)} onRetryJob={(jobId) => void retryJob(jobId)} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} onAttachPack={startAttachPack} />
                            </div>
                        ) : detailLog ? (
                            <div className="space-y-4">
                                <SnapshotPanel prompt={detailLog.prompt} tags={videoSnapshotTags(detailLog.snapshot)} references={detailLog.snapshot.references} />
                                {detailLog.url ? (
                                    <VideoResultCard url={detailLog.url} archiveTargets={logArchiveTargets} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} onAttachPack={gatewayArtifactPath(detailLog.url) ? startAttachPack : undefined} />
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detailLog.status === "canceled" ? t("workbench.canceled") : t("videoWorkbench.empty")} className="!my-16" />
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <VideoIcon className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("videoWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <QueuePanel entries={queueEntries} jobs={jobs} now={nowTick} selectedId={detailTask?.id ?? detailLog?.id ?? null} onSelect={setSelectedId} selectedLogIds={[]} onCreateSession={createSession} />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" height="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <AttachAssetModal open={attachTarget !== null} artifact={attachTarget} onClose={() => setAttachTarget(null)} />
            <Modal title={t("attribution.title")} open={attributionOpen} onCancel={() => setAttributionOpen(false)} onOk={() => setAttributionOpen(false)} okText={t("common.confirm")} cancelText={t("common.cancel")} destroyOnHidden>
                {/* 视频落片段槽位：与服务端 episodes.js 的 clip role、续接链同一个槽位。 */}
                <AttributionPicker active={attributionOpen} value={attribution} onChange={setAttribution} slotRole="clip" />
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth registry onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

/** 生视频结果卡片（视频播放 + 存入我的素材 / 归入资料包 / 下载 / 归档）。 */
function VideoResultCard({
    url,
    archiveTargets,
    onDownload,
    onSaveAsset,
    onAttachPack,
    jobId,
}: {
    url: string;
    archiveTargets?: ArtifactTarget[];
    onDownload: (url: string) => void;
    onSaveAsset: (url: string) => void;
    /** 只有父级确认产物是网关产物（本地临时地址存进资料包后无法回看）时才传；不传则不显示该动作。 */
    onAttachPack?: (url: string, jobId?: string) => void;
    jobId?: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(url)}>
                        {t("common.addToAssets")}
                    </Button>
                    {/* 归入项目资料包 ≠ 存入我的素材：前者进项目事实层并被定妆/关键帧取用，后者只是本地素材库。 */}
                    {onAttachPack ? (
                        <Button size="small" icon={<ListPlus className="size-3.5" />} onClick={() => onAttachPack(url, jobId)}>
                            {t("common.attachAssetPack")}
                        </Button>
                    ) : null}
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(url)}>
                        {t("common.download")}
                    </Button>
                </div>
                {/* 生产动线只给「归档」（可逆）；彻底删除只在「我的资产」页。
                    归档目标优先取**该任务的产物清单**（规范 §2.5），记录里缺字段时退回单个 url。 */}
                <ArtifactActions targets={archiveTargets?.length ? archiveTargets : [{ url }]} />
            </div>
        </div>
    );
}

/** 进行中任务的详情：状态 / 进度 / 取消 + 结果卡片（视频）。 */
function VideoTaskGroup({ task, jobs, now, onCancelJob, onCancelJobs, onRetryJob, onDownload, onSaveAsset, onAttachPack }: { task: VideoTask; jobs: WorkbenchJob[]; now: number; onCancelJob: (jobId: string) => void; onCancelJobs: (jobIds: string[]) => void; onRetryJob: (jobId: string) => void; onDownload: (url: string) => void; onSaveAsset: (url: string) => void; onAttachPack: (url: string, jobId?: string) => void }) {
    const { t } = useTranslation();
    const jobById = new Map(jobs.map((job) => [job.id, job] as const));
    const total = task.jobIds.length;
    const pendingSubmit = total === 0;
    const list = task.jobIds.map((id) => jobById.get(id));
    const stats = countTaskJobs(list);
    const { finished, anyRunning, hasActive } = stats;
    const percent = useMonotonicPercent(list, finished, total);
    const status = deriveTaskStatus({ pendingSubmit, ...stats });
    const elapsedMs = Math.max(0, (now || task.startedAt) - task.startedAt);
    const statusLabel = pendingSubmit ? t("workbench.taskQueued") : t(taskStatusLabelKey(status, anyRunning));

    return (
        <div className="rounded-lg border border-stone-200 bg-background p-3 dark:border-stone-800">
            <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{task.prompt}</div>
                    <div className="mt-1.5 flex items-center gap-2">
                        {pendingSubmit ? (
                            <span className="text-xs text-stone-500 dark:text-stone-400">{t("workbench.taskQueued")}</span>
                        ) : (
                            <>
                                <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">{`${Math.round(percent)}%`}</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Tag className="m-0" color={taskStatusColor(status)}>
                        {statusLabel}
                    </Tag>
                    {status === "running" ? <span className="text-xs text-stone-500 dark:text-stone-400">{formatDuration(elapsedMs)}</span> : null}
                    {hasActive ? (
                        /* 整条任务取消：**一次性交给共享的 cancelWorkbenchJobs**（不再自己 forEach）。 */
                        <Button size="small" danger onClick={() => onCancelJobs(task.jobIds)}>
                            {t("workbench.cancel")}
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="grid gap-4">
                {pendingSubmit ? (
                    <PendingMediaCard aspectClassName="aspect-video" />
                ) : (
                    task.jobIds.map((id) => {
                        const job = jobById.get(id);
                        if (job?.status === "done" && job.outputs?.length) {
                            const output = job.outputs.find((item) => item.url);
                            return output ? <VideoResultCard key={id} url={resolveGatewayUrl(output.url)} archiveTargets={archiveTargetsFromJobs([job])} onDownload={onDownload} onSaveAsset={onSaveAsset} jobId={id} onAttachPack={gatewayArtifactPath(output.url) ? onAttachPack : undefined} /> : null;
                        }
                        if (job?.status === "canceled") return <FailedMediaCard key={id} canceled error={t("workbench.canceled")} aspectClassName="aspect-video" />;
                        if (job?.status === "error") return <FailedMediaCard key={id} error={job.error || t("workbench.generationFailed")} onRetry={() => onRetryJob(id)} aspectClassName="aspect-video" />;
                        return <PendingMediaCard key={id} progress={job?.progress} onCancel={() => onCancelJob(id)} aspectClassName="aspect-video" />;
                    })
                )}
            </div>
        </div>
    );
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Download, FolderPlus, History, ImagePlus, ListPlus, PackagePlus, PenLine, SlidersHorizontal, Sparkles, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Drawer, Empty, Image, Input, Modal, Progress, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ArtifactActions, type ArtifactTarget } from "@/components/artifact-actions";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { SlotCandidateDialog } from "./slot-candidate-dialog";
import { AttachAssetModal } from "@/components/attach-asset-modal";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatTaskTime } from "@/lib/task-time";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { cancelImageJob, enqueueImages, getImageJob, isActiveJobStatus, listImageJobs, type ImageJob, type ImageJobOutput, type ImageJobProgress } from "@/services/api/image-jobs";
import { defaultSizeFor, findTemplate, loadTemplateCatalog, sizeNoteFor, sizeOptionsFor, type GatewayTemplateInfo } from "@/services/api/template-sizes";
import { gatewayArtifactPath, resolveGatewayUrl, uploadGatewayAsset } from "@/services/api/gateway";
import { deleteStoredImages, ensureImagePreview, getImageBlob, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
// 工作台共享件：任务队列 / 参数快照 / 取消·归档 卡片 —— 与视频创作台同一套（抽出来复用，不各写一份）。
import { QueuePanel, SnapshotPanel, FailedMediaCard, PendingMediaCard, ImageThumb, UnavailableImage, archiveTargetsFromJobs, buildQueueEntries, cancelWorkbenchJobs, countTaskJobs, deriveTaskStatus, jobDurationMs, jobIdsForItemIds, taskPercent, taskStatusColor, taskStatusLabelKey, usePreviewVerticalArrows, type WorkbenchJob, type WorkbenchLogView, type WorkbenchQueueEntry, type WorkbenchTask, type WorkbenchThumb } from "@/components/workbench";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    /** 网关产物原始地址（/api/artifacts/<jobId>/<file>）——归档只认它；本地副本仅作缩略。 */
    artifactUrl?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

/** 提交那一刻的参数快照（历史事实，绝不随后续表单编辑而变）。 */
type TaskSnapshot = {
    config: GenerationLogConfig;
    references: ReferenceImage[];
    seed?: number;
    /** 提交时表单里显示的模型名（人读）；config 里存裸模板名。 */
    modelLabel?: string;
};

/**
 * 工作台任务组：一次提交拆成 count 个服务端 job。jobIds 是唯一事实源 ——
 * 状态/进度全部从 GET /api/jobs 读后端，前端不再自己算槽位。
 */
type Task = {
    id: string;
    prompt: string;
    count: number;
    template: string;
    jobIds: string[];
    startedAt: number;
    createdAt: string;
    /** 提交时上传到 ComfyUI 的参考图名（重试/编辑沿用）。 */
    referenceUrls?: string[];
    /** 本次实际提交的参数快照（点开记录时的「本次参数」，与当前表单隔离）。 */
    snapshot: TaskSnapshot;
    /** 提交中占位：已落记录但还没拿到 jobIds（上传参考图/后端编译入队期间）。 */
    pending?: boolean;
    /** Agent 面板发起的任务，完成时回写状态。 */
    agentTaskId?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "success" | "failed" | "canceled";
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
/** 工作台「未结束任务」的本地索引：只存 jobIds 与提交事实，状态/进度一律回后端读。 */
const WORKBENCH_TASKS_KEY = "infinite-canvas:image_workbench_tasks";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

/** 把一个后端产物直接映射成结果卡片用的图片（网关绝对地址；加入参考图/资产时再按需落本地）。 */
function jobOutputToImage(job: ImageJob, output: ImageJobOutput): GeneratedImage {
    return {
        id: `${job.id}-${output.filename || output.url}`,
        dataUrl: resolveGatewayUrl(output.url),
        artifactUrl: resolveGatewayUrl(output.url),
        durationMs: jobDurationMs(job),
        width: output.width || 0,
        height: output.height || 0,
        bytes: output.bytes || 0,
        ...(output.type === "image" ? { mimeType: "image/png" } : {}),
    };
}

/** 历史记录图片反查已完成的后端 Job（条目 id 形如`<jobId>-<文件名>`）；仅 done 且有产物地址才可加入项目候选。 */
function candidateJobIdFor(image: GeneratedImage, jobs: Record<string, ImageJob>): string | null {
    if (!image.artifactUrl) return null;
    const jobId = jobIdsForItemIds([image.id], jobs)[0];
    return jobId && jobs[jobId]?.status === "done" ? jobId : null;
}

/** 队列里一条任务的缩略图（从后端 job 产物取，最多 4 张）；生图专有，交给共享队列面板渲染。 */
function imageTaskThumbnails(task: WorkbenchTask, jobs: Record<string, WorkbenchJob>): WorkbenchThumb[] {
    return task.jobIds
        .map((id) => jobs[id])
        .filter((job): job is ImageJob => Boolean(job?.status === "done" && job.outputs?.length))
        .flatMap((job) => (job.outputs || []).filter((output) => !output.type || output.type === "image").map((output) => jobOutputToImage(job, output)))
        .slice(0, 4)
        .map((image) => ({ id: image.id, src: previewUrlFor(image.storageKey) || image.dataUrl }));
}

/** 历史记录 → 共享队列面板认的记录视图（时间渲染时按 createdAt 现算，不用老记录里存的 time 串）。 */
function imageLogView(log: GenerationLog): WorkbenchLogView {
    return {
        id: log.id,
        createdAt: log.createdAt,
        title: log.title,
        status: log.status,
        durationMs: log.durationMs,
        successCount: log.successCount,
        failCount: log.failCount,
        itemCount: log.imageCount,
        thumbnails: log.images
            .filter((image) => image.dataUrl || image.storageKey)
            .slice(0, 4)
            .map((image) => ({ id: image.id, src: previewUrlFor(image.storageKey) || image.dataUrl })),
    };
}

/** 读本地保存的未结束任务（损坏/结构不符一律丢弃，不阻塞工作台）。 */
function readStoredTasks(): Task[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(window.localStorage.getItem(WORKBENCH_TASKS_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item): item is Task => Boolean(item && typeof item.id === "string" && typeof item.prompt === "string" && Array.isArray(item.jobIds)))
            .map((item) => ({
                ...item,
                count: Number(item.count) || item.jobIds.length,
                template: typeof item.template === "string" ? item.template : "",
                jobIds: item.jobIds.map(String),
                startedAt: Number(item.startedAt) || Date.now(),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                snapshot: {
                    config: item.snapshot?.config ?? { model: item.template || "", imageModel: item.template || "", quality: "", size: "", count: String(item.count || item.jobIds.length) },
                    references: Array.isArray(item.snapshot?.references) ? item.snapshot.references : [],
                    ...(Number.isFinite(item.snapshot?.seed) ? { seed: item.snapshot?.seed } : {}),
                    ...(typeof item.snapshot?.modelLabel === "string" ? { modelLabel: item.snapshot.modelLabel } : {}),
                },
            }));
    } catch {
        return [];
    }
}

/** 只持久化未结束的任务（jobIds + 提交事实 + 参数快照），刷新后据此恢复；参考图 dataUrl 落盘前瘦身。 */
function persistTasks(tasks: Task[]): void {
    if (typeof window === "undefined") return;
    try {
        const slim = tasks.map((task) => ({
            ...task,
            snapshot: {
                ...task.snapshot,
                references: task.snapshot.references.map((reference) => ({ ...reference, dataUrl: reference.storageKey ? "" : reference.dataUrl })),
            },
        }));
        window.localStorage.setItem(WORKBENCH_TASKS_KEY, JSON.stringify(slim));
    } catch {
        // 私密模式 / 配额不足：持久化失败不影响当前会话。
    }
}

export default function ImagePage() {
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
    const [tasks, setTasks] = useState<Task[]>([]);
    const [jobs, setJobs] = useState<Record<string, ImageJob>>({});
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [nowTick, setNowTick] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    // 左栏「任务队列」里当前点开的那条记录（任务或已落库记录），中/右区据此展示该次的参数快照与结果。
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    // 「加入项目候选…」对话框当前携带的后端 jobId（M3）；null = 关闭。
    const [candidateJobId, setCandidateJobId] = useState<string | null>(null);
    // 「归入项目资料包」当前携带的产物（null = 关闭）。产物地址必须是本网关的 /api/artifacts/…，
    // 本地副本地址归档不了，跨进程也取不到。
    const [attachTarget, setAttachTarget] = useState<{ url: string; jobId?: string | null; name?: string } | null>(null);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    // 生图模型的官方规格清单（后端 /api/providers 下发，前端不硬编码）——「选模型 → 再选规格」。
    const [imageTemplates, setImageTemplates] = useState<GatewayTemplateInfo[]>([]);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    // 轮询读的是「最新一次渲染」的 tasks/jobs：用 ref 拿，避免把定时器不停重建。
    const tasksRef = useRef<Task[]>([]);
    const jobsRef = useRef<Record<string, ImageJob>>({});
    const restoredRef = useRef(false);
    const loggedTaskIdsRef = useRef<Set<string>>(new Set());
    const bubbledJobErrorsRef = useRef<Set<string>>(new Set());

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    // 进度口径全部读后端：未结束 = 后端 status 为 queued/running（或该 job 还没取到）；提交中的占位记录算 1 条未结束。
    const pendingSlotCount = tasks.reduce((sum, task) => sum + (task.jobIds.length ? task.jobIds.filter((id) => isActiveJobStatus(jobs[id]?.status)).length : 1), 0);
    const hasRunningTask = pendingSlotCount > 0;
    const overallTotal = tasks.reduce((sum, task) => sum + task.count, 0);
    const overallDone = tasks.reduce((sum, task) => sum + task.jobIds.filter((id) => jobs[id] && !isActiveJobStatus(jobs[id].status)).length, 0);
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

    useEffect(() => {
        void refreshLogs();
    }, []);

    // 拉一次生图模板清单（含官方规格 sizes）；网关不可达时保持空 → 规格选择退回旧控件，不阻塞工作台。
    useEffect(() => {
        let alive = true;
        void loadTemplateCatalog("image")
            .then((templates) => {
                if (alive) setImageTemplates(templates);
            })
            .catch(() => {
                if (alive) setImageTemplates([]);
            });
        return () => {
            alive = false;
        };
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        const results = await Promise.allSettled(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        // 读不出来的（空壳/损坏）直接不上屏，并给可读原因 —— 绝不让它混进参考图。
        const added = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
        if (added.length) setReferences((value) => [...value, ...added]);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) message.error(t("imageWorkbench.referenceReadFailed", { message: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason) }));
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const results = await Promise.allSettled(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            const added = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
            if (added.length) setReferences((value) => [...value, ...added]);
            const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (rejected) {
                message.error(t("imageWorkbench.referenceReadFailed", { message: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason) }));
                return;
            }
            message.success(t("imageWorkbench.clipboardAdded", { count: added.length }));
        } catch {
            message.error(t("imageWorkbench.clipboardEmpty"));
        }
    };

    /** 把工作台参考图上传到 ComfyUI，拿回可被后端 resolve 的素材名（失败 → 抛出，弹气泡让用户介入）。 */
    const resolveReferenceUrls = async (list: ReferenceImage[]): Promise<string[]> => {
        const urls: string[] = [];
        for (const item of list) {
            const blob = item.storageKey ? await getImageBlob(item.storageKey) : item.dataUrl ? await (await fetch(item.dataUrl)).blob() : null;
            if (!blob) throw new Error(t("imageWorkbench.referenceUploadFailed", { name: item.name }));
            const { comfyName } = await uploadGatewayAsset(blob);
            urls.push(comfyName);
        }
        return urls;
    };

    /** 提交 → 服务端入队 → 拿 jobIds；状态/进度此后全部由 GET /api/jobs 轮询。 */
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        // 提交即落一条队列记录：当帧就在左栏出现（状态=排队中），不等上传/编译/入队返回；返回后原地补齐 jobIds。
        const snapshot: TaskSnapshot = {
            config: {
                model: modelOptionName(model),
                imageModel: modelOptionName(model),
                quality: effectiveConfig.quality,
                size: effectiveConfig.size,
                count: String(generationCount),
            },
            references: [...references],
            modelLabel: modelOptionLabel(effectiveConfig, model),
        };
        const localId = nanoid();
        setTasks((value) => [
            {
                id: localId,
                prompt: text,
                count: generationCount,
                template: modelOptionName(model),
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
        // submitting 只在「上传参考图 + 入队」这段短暂窗口内挡住重复点击；编辑区与输入框任何情况下都不锁。
        setSubmitting(true);
        try {
            const referenceUrls = await resolveReferenceUrls(references);
            const result = await enqueueImages({
                // 配置里的模型值可能是「渠道id::模型名」（渠道模型的标准形态），
                // 但后端要的是**裸模板名**（用来找 workflows/<name>.json）。
                // 剥前缀统一走 modelOptionName —— 与门禁判断同一口径，别再散落第二套解析。
                template: modelOptionName(model),
                prompt: text,
                count: generationCount,
                size: effectiveConfig.size,
                ...(referenceUrls.length ? { references: referenceUrls.map((url) => ({ url })) } : {}),
            });
            const jobIds = result.jobs.map((job) => job.id);
            if (!jobIds.length) throw new Error(t("workbench.generationFailed"));
            // 原地补齐 jobIds / 真实模板 / 参考图名（记录 id 不变，选中态不跳）。
            setTasks((value) =>
                value.map((item) =>
                    item.id === localId
                        ? {
                              ...item,
                              count: jobIds.length,
                              template: result.jobs[0]?.template || item.template,
                              jobIds,
                              pending: false,
                              snapshot: { ...item.snapshot, config: { ...item.snapshot.config, count: String(jobIds.length) } },
                              ...(referenceUrls.length ? { referenceUrls } : {}),
                          }
                        : item,
                ),
            );
            setJobs((value) => {
                const next = { ...value };
                for (const job of result.jobs) next[job.id] = { id: job.id, status: job.status, template: job.template };
                return next;
            });
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // 提交失败 → 撤掉占位记录，不留误导性条目。
            setTasks((value) => value.filter((item) => item.id !== localId));
            setSelectedId((current) => (current === localId ? null : current));
            message.error(t("imageWorkbench.submitFailed", { message: reason }));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: reason });
        } finally {
            setSubmitting(false);
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && hasRunningTask) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, hasRunningTask, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: t("imageWorkbench.resultTitle", { count: index + 1 }),
            coverUrl: stored.url,
            tags: [],
            source: t("imageWorkbench.source"),
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    /**
     * 打开「归入项目资料包」：先校验产物是不是网关产物（本地临时地址存进AssetRef 后无法回看），
     * 不合格就直接提示，不让用户填完表才发现白填。
     */
    const startAttachPack = (image: GeneratedImage, index: number) => {
        const path = gatewayArtifactPath(image.artifactUrl);
        if (!path) {
            message.warning(t("attachAsset.localOnly"));
            return;
        }
        setAttachTarget({ url: path, jobId: candidateJobIdFor(image, jobs), name: t("imageWorkbench.resultTitle", { count: index + 1 }) });
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setTasks([]);
        setJobs({});
        loggedTaskIdsRef.current.clear();
        bubbledJobErrorsRef.current.clear();
        persistTasks([]);
        setNowTick(0);
        setSelectedLogIds([]);
        setSelectedId(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (selectedId && selectedLogIds.includes(selectedId)) setSelectedId(null);
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(refreshLogs);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    /** 点开左栏一条记录：只切换「在看哪一次」，绝不回填表单 —— 参数快照与当前表单互相隔离，才能无脑连发。 */
    const selectLog = (log: GenerationLog) => {
        setSelectedId(log.id);
        setLogsOpen(false);
    };

    // 提示词编译已移到后端（POST /api/images/enqueue 入队前用 DeepSeek 编译，失败降级不阻塞）。
    // 前端不再调用 /api/prompt/compile。

    /** 任务全终态后落一条生成记录（id 与任务一致 → 队列按 id 去重）；参数一律取提交时的快照，绝不读当前表单。 */
    const finalizeTask = async (task: Task, list: ImageJob[]) => {
        if (loggedTaskIdsRef.current.has(task.id)) return;
        loggedTaskIdsRef.current.add(task.id);
        const doneJobs = list.filter((job) => job.status === "done");
        const images: GeneratedImage[] = [];
        for (const job of doneJobs) {
            for (const output of job.outputs || []) {
                if (output.type && output.type !== "image") continue;
                const fallback = jobOutputToImage(job, output);
                try {
                    const stored = await uploadImage(resolveGatewayUrl(output.url));
                    images.push({ ...fallback, dataUrl: stored.url, artifactUrl: fallback.artifactUrl, ...(stored.storageKey ? { storageKey: stored.storageKey } : {}), width: output.width || stored.width, height: output.height || stored.height, bytes: output.bytes || stored.bytes, mimeType: stored.mimeType });
                } catch {
                    images.push(fallback);
                }
            }
        }
        const successCount = doneJobs.length;
        const failCount = list.filter((job) => job.status === "error").length;
        const canceledCount = list.filter((job) => job.status === "canceled").length;
        const status: GenerationLog["status"] = successCount ? "success" : failCount ? "failed" : canceledCount ? "canceled" : "failed";
        const log = buildLog({
            prompt: task.prompt,
            model: task.snapshot.config.imageModel || task.template,
            config: task.snapshot.config,
            references: task.snapshot.references,
            durationMs: Math.max(0, performance.now() - task.startedAt),
            successCount,
            failCount,
            status,
            images,
        });
        saveLog({ ...log, id: task.id });
        if (task.agentTaskId) {
            updateAgentTask(task.agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : t("workbench.generationFailed") });
        }
    };

    /** 重试单个失败任务：按同一模板/提示词/参考图再入队一个 job，替换掉失败的那条。 */
    const retryJob = async (taskId: string, jobId: string) => {
        const task = tasks.find((item) => item.id === taskId);
        if (!task) return;
        try {
            const result = await enqueueImages({
                template: task.template,
                prompt: task.prompt,
                count: 1,
                size: effectiveConfig.size,
                ...(task.referenceUrls?.length ? { references: task.referenceUrls.map((url) => ({ url })) } : {}),
            });
            const created = result.jobs[0];
            if (!created) throw new Error(t("workbench.generationFailed"));
            setJobs((value) => ({ ...value, [created.id]: { id: created.id, status: created.status, template: created.template } }));
            setTasks((value) => value.map((item) => (item.id === taskId ? { ...item, jobIds: item.jobIds.map((id) => (id === jobId ? created.id : id)) } : item)));
            // 重试让任务重新回到未结束，允许完成后再落一条生成记录。
            loggedTaskIdsRef.current.delete(taskId);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            message.error(t("imageWorkbench.submitFailed", { message: reason }));
        }
    };

    /**
     * 取消一组 job：**走共享的 `cancelWorkbenchJobs`**（生图 / 视频工作台同一套，口径不再各写一遍）。
     * 先筛掉已结束的，再逐个调服务端 cancel；回来后以服务端状态/产物为准（取消不留半成品）；失败只提示。
     */
    const cancelJobs = async (jobIds: string[]) => {
        const active = jobIds.filter((id) => isActiveJobStatus(jobs[id]?.status));
        if (!active.length) return;
        const { failed } = await cancelWorkbenchJobs(active, async (id) => {
            const job = await cancelImageJob(id);
            setJobs((value) => ({ ...value, [job.id]: job }));
        });
        if (failed) message.error(t("tasks.cancelFailed"));
    };

    /** 取消单个 job。 */
    const cancelJob = (jobId: string) => cancelJobs([jobId]);

    /** 取消整条任务里所有未结束的 job。 */
    const cancelTask = (task: Task) => cancelJobs(task.jobIds);

    // 进页先拉一次：把未结束的任务恢复出来（刷新 / 切页 / 重开浏览器后任务与进度不丢）。
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const stored = readStoredTasks();
            if (!stored.length) {
                restoredRef.current = true;
                return;
            }
            try {
                const all = await listImageJobs({ kind: "image", limit: 300 });
                const known = new Set(all.map((job) => job.id));
                const missing = [...new Set(stored.flatMap((task) => task.jobIds))].filter((id) => !known.has(id));
                const fetched = await Promise.all(missing.map((id) => getImageJob(id).catch(() => null)));
                if (cancelled) return;
                const map: Record<string, ImageJob> = {};
                for (const job of all) map[job.id] = job;
                for (const job of fetched) if (job) map[job.id] = job;
                setJobs((value) => ({ ...value, ...map }));
                // 恢复的参数快照里参考图只有 storageKey（dataUrl 已瘦身）→ 触发缩略图重建。
                for (const task of stored) for (const reference of task.snapshot.references) if (reference.storageKey) void ensureImagePreview(reference.storageKey);
                setTasks((value) => {
                    const existing = new Set(value.map((task) => task.id));
                    return [...stored.filter((task) => !existing.has(task.id)), ...value];
                });
                // 恢复时发现「离线期间已失败」的任务 → 同样弹一次气泡让用户介入。
                for (const id of new Set(stored.flatMap((task) => task.jobIds))) {
                    const job = map[id];
                    if (job?.status === "error" && !bubbledJobErrorsRef.current.has(id)) {
                        bubbledJobErrorsRef.current.add(id);
                        message.error(t("imageWorkbench.jobFailed", { message: job.error || t("workbench.generationFailed") }));
                    }
                }
            } catch {
                // 拉取失败：不恢复、也不阻塞工作台。
            } finally {
                if (!cancelled) restoredRef.current = true;
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // 活动任务每 3s 轮询 GET /api/jobs；掉出活动列表的按 id 补齐终态产物；全部结束即停。
    useEffect(() => {
        const knownIds = tasksRef.current.flatMap((task) => task.jobIds);
        if (!knownIds.length) return;
        let cancelled = false;
        let timer: number | undefined;
        const stop = () => {
            if (timer) {
                window.clearInterval(timer);
                timer = undefined;
            }
        };
        const tick = async () => {
            let active: ImageJob[];
            try {
                active = await listImageJobs({ kind: "image", status: "queued,running", limit: 200 });
            } catch {
                return;
            }
            if (cancelled) return;
            const activeById = new Map(active.map((job) => [job.id, job] as const));
            const before = jobsRef.current;
            const toFetch = [...new Set(knownIds)].filter((id) => !activeById.has(id) && isActiveJobStatus(before[id]?.status));
            const fetched = await Promise.all(toFetch.map((id) => getImageJob(id).catch(() => null)));
            if (cancelled) return;
            const updates: Record<string, ImageJob> = {};
            for (const job of active) if (knownIds.includes(job.id)) updates[job.id] = job;
            for (const job of fetched) if (job) updates[job.id] = job;
            if (Object.keys(updates).length) setJobs((value) => ({ ...value, ...updates }));
            // 失败 / 超时 → 弹气泡让用户介入（同一 job 只弹一次，reason 取后端 error）。
            for (const job of fetched) {
                if (job && job.status === "error" && !bubbledJobErrorsRef.current.has(job.id)) {
                    bubbledJobErrorsRef.current.add(job.id);
                    message.error(t("imageWorkbench.jobFailed", { message: job.error || t("workbench.generationFailed") }));
                }
            }
            const stillActive = knownIds.some((id) => isActiveJobStatus((updates[id] || activeById.get(id) || before[id])?.status));
            if (!stillActive) stop();
        };
        void tick();
        timer = window.setInterval(() => void tick(), 3000);
        return () => {
            cancelled = true;
            stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tasksSignature]);

    // 任务全终态 → 落生成记录（正常完成 / 恢复完成 / 取消都覆盖）；记录 id 与任务一致，队列按 id 去重。
    useEffect(() => {
        for (const task of tasks) {
            if (!task.jobIds.length) continue; // 提交中的占位记录还没 jobIds，等补齐后再判终态。
            const list = task.jobIds.map((id) => jobs[id]).filter((job): job is ImageJob => Boolean(job));
            if (list.length < task.jobIds.length) continue;
            if (list.some((job) => isActiveJobStatus(job.status))) continue;
            void finalizeTask(task, list);
        }
    }, [tasks, jobs]);

    // 只持久化「未结束」的任务：刷新后要恢复的就是它们；已完成的进生成记录，不再占存储。
    useEffect(() => {
        if (!restoredRef.current) return;
        const active = tasks.filter((task) => task.jobIds.some((id) => isActiveJobStatus(jobs[id]?.status)));
        persistTasks(active);
    }, [tasks, jobs]);

    // 中/右区展示的那一条：优先取选中的任务，其次选中的记录；都没选中时回退到最新一条。
    const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;
    const selectedLog = selectedTask ? null : (logs.find((log) => log.id === selectedId) ?? null);
    const detailTask = selectedTask ?? (selectedLog ? null : (tasks[0] ?? null));
    const detailLog = selectedLog ?? (detailTask ? null : (logs[0] ?? null));
    // 归档目标（规范 §2.5）：从该次任务的**产物清单**现算，而不是记录里可能缺失的 artifactUrl / jobIds。
    // 记录条目 id 形如 `<jobId>-<文件名>`，据此反查后端 job 再取 outputs；老记录即使没存 artifactUrl 也能出归档入口。
    const logArchiveTargets = detailLog
        ? archiveTargetsFromJobs(
              jobIdsForItemIds(detailLog.images.map((image) => image.id), jobs).map((id) => jobs[id]),
              detailLog.images.map((image) => image.artifactUrl),
          )
        : [];
    // 队列时间线：本次任务 ∪ 历史记录（按 id 去重 + 时间倒序），交给共享队列面板渲染。
    const queueEntries: WorkbenchQueueEntry[] = buildQueueEntries({ tasks, logs: logs.map(imageLogView), jobs, taskThumbnails: imageTaskThumbnails });

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <QueuePanel
                        entries={queueEntries}
                        jobs={jobs}
                        now={nowTick}
                        selectedId={detailTask?.id ?? detailLog?.id ?? null}
                        onSelect={setSelectedId}
                        selectedLogIds={selectedLogIds}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        {t("workbench.logs")}
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        {t("workbench.settings")}
                                    </Button>
                                </div>
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
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("imageWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("imageWorkbench.references")}</span>
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
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <ImageThumb src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} imageTemplates={imageTemplates} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
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
                                {tasks.length ? (
                                    <Tag className="m-0" color={overallDone >= overallTotal ? "green" : "blue"}>
                                        {t("workbench.overallProgress", { done: overallDone, total: overallTotal })}
                                    </Tag>
                                ) : null}
                            </div>
                        </div>
                        {detailTask ? (
                            <div className="space-y-4">
                                <SnapshotPanel
                                    prompt={detailTask.prompt}
                                    tags={[
                                        ...(detailTask.snapshot.modelLabel || detailTask.snapshot.config.imageModel || detailTask.snapshot.config.model ? [{ label: detailTask.snapshot.modelLabel || detailTask.snapshot.config.imageModel || detailTask.snapshot.config.model, color: "blue" }] : []),
                                        ...(detailTask.snapshot.config.size ? [{ label: detailTask.snapshot.config.size }] : []),
                                        { label: t("workbench.itemCount", { count: Number(detailTask.snapshot.config.count) || 1 }) },
                                        ...(detailTask.snapshot.seed !== undefined ? [{ label: `seed ${detailTask.snapshot.seed}` }] : []),
                                    ]}
                                    references={detailTask.snapshot.references}
                                />
                                <TaskGroup
                                    task={detailTask}
                                    jobs={detailTask.jobIds.map((id) => jobs[id]).filter((job): job is ImageJob => Boolean(job))}
                                    now={nowTick}
                                    onCancelJob={(jobId) => void cancelJob(jobId)}
                                    onCancelTask={() => void cancelTask(detailTask)}
                                    onRetryJob={(jobId) => void retryJob(detailTask.id, jobId)}
                                    onEdit={addResultToReferences}
                                    onDownload={downloadImage}
                                    onSaveAsset={saveResultToAssets}
                                    onAddCandidate={setCandidateJobId}
                                    onAttachPack={startAttachPack}
                                />
                            </div>
                        ) : detailLog ? (
                            <div className="space-y-4">
                                <SnapshotPanel
                                    prompt={detailLog.prompt}
                                    tags={[
                                        ...(detailLog.config.imageModel || detailLog.config.model ? [{ label: detailLog.config.imageModel || detailLog.config.model, color: "blue" }] : []),
                                        ...(detailLog.config.size ? [{ label: detailLog.config.size }] : []),
                                        { label: t("workbench.itemCount", { count: Number(detailLog.config.count) || 1 }) },
                                    ]}
                                    references={detailLog.references}
                                />
                                {detailLog.images.length ? (
                                    // PreviewGroup：同一次任务的素材成一组 → 预览里 ←/→ 直接切换它们（antd 原生键盘导航）
                                    <Image.PreviewGroup>
                                        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                            {detailLog.images.map((image, index) => (
                                                <ResultImageCard key={image.id} image={image} index={index} candidateJobId={candidateJobIdFor(image, jobs)} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} onAddCandidate={setCandidateJobId} onAttachPack={startAttachPack} />
                                            ))}
                                        </div>
                                    </Image.PreviewGroup>
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detailLog.status === "canceled" ? t("workbench.canceled") : t("imageWorkbench.empty")} className="!my-16" />
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
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
                <QueuePanel
                    entries={queueEntries}
                    jobs={jobs}
                    now={nowTick}
                    selectedId={detailTask?.id ?? detailLog?.id ?? null}
                    onSelect={setSelectedId}
                    selectedLogIds={selectedLogIds}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} imageTemplates={imageTemplates} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <SlotCandidateDialog open={candidateJobId !== null} jobId={candidateJobId} onClose={() => setCandidateJobId(null)} />
            <AttachAssetModal open={attachTarget !== null} artifact={attachTarget} onClose={() => setAttachTarget(null)} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog, imageTemplates }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void; imageTemplates: GatewayTemplateInfo[] }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    // 当前生图模型（裸模板名）对应的后端模板信息；只有本地 comfy 模板才有官方规格。
    const template = findTemplate(imageTemplates, modelOptionName(model));
    const sizeOptions = sizeOptionsFor(template);
    // 换模型 → 规格跟着变：当前 size 不在新模型官方清单里就落到该模型默认规格。
    useEffect(() => {
        if (!template) return;
        const values = (sizeOptions ?? []).map((option) => option.value);
        if (!values.length) return;
        if (!values.includes(config.size)) updateConfig("size", defaultSizeFor(template) ?? values[0]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [template, config.size]);
    // 传了 sizePicker 才进入「规格只读下拉」模式（该模型官方规格，后端下发）；云端模型无模板 → 保持旧控件。
    const sizePicker = template ? { options: sizeOptions ?? [], value: config.size, pending: !sizeOptions, note: sizeNoteFor(template) } : undefined;

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth registry onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} sizePicker={sizePicker} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    archiveTargets,
    candidateJobId,
    onEdit,
    onDownload,
    onSaveAsset,
    onAddCandidate,
    onAttachPack,
}: {
    image: GeneratedImage;
    index: number;
    /** 归档目标：**由父级从该次任务的产物（job.outputs）现算**（规范 §2.5）；缺省时退回记录里存的产物地址。 */
    archiveTargets?: ArtifactTarget[];
    /** 可加入项目候选的后端 jobId（仅 done 且有产物的结果由父级传入）；空则禁用该动作。 */
    candidateJobId?: string | null;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onAddCandidate: (jobId: string) => void;
    /** 归入项目资料包（挂到项目的角色/场景/道具上，成为后续生成的参考图）。 */
    onAttachPack?: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    // 加载失败、或渲染出来的就是 1×1 空壳 → 一律降级，绝不装作有图。
    const [broken, setBroken] = useState(false);
    const thumbnail = previewUrlFor(image.storageKey) || image.dataUrl;
    const fullSrc = image.dataUrl || thumbnail;
    const unavailable = broken || !thumbnail;
    const unavailableReason = image.storageKey ? t("imageWorkbench.imageUnavailableLocal") : t("imageWorkbench.imageUnavailableRemote");
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            {unavailable ? (
                <UnavailableImage reason={unavailableReason} className="aspect-square w-full" />
            ) : (
                <Image
                    src={thumbnail}
                    preview={{ src: fullSrc }}
                    alt={t("imageWorkbench.resultAlt", { count: index + 1 })}
                    className="aspect-square object-cover"
                    onError={() => setBroken(true)}
                    onLoad={(event) => {
                        const target = event.currentTarget;
                        if (target.naturalWidth <= 1 || target.naturalHeight <= 1) setBroken(true);
                    }}
                />
            )}
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2">
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" disabled={unavailable} icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" disabled={unavailable} icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" disabled={unavailable} icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addCandidateTitle")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" disabled={unavailable || !candidateJobId} icon={<ListPlus className="size-3.5" />} onClick={() => candidateJobId && onAddCandidate(candidateJobId)}>
                            {t("imageWorkbench.addCandidate")}
                        </Button>
                    </Tooltip>
                    {onAttachPack ? (
                        // 「归入资料包」与「加入资产」是两件事：后者进本地素材库，前者进项目事实层，
                        // 会成为后续关键帧/合成的参考图。分开给按钮，避免用户以为存了素材就等于锁了角色。
                        <Tooltip title={t("attachAsset.buttonHint")}>
                            <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" disabled={unavailable} icon={<PackagePlus className="size-3.5" />} onClick={() => onAttachPack(image, index)}>
                                {t("attachAsset.button")}
                            </Button>
                        </Tooltip>
                    ) : null}
                </div>
                {/* 生产动线只给「归档」（可逆）；彻底删除只在「我的资产」页。归档优先认该次任务的产物地址。 */}
                {unavailable ? null : (
                    <ArtifactActions targets={archiveTargets?.length ? archiveTargets : [{ url: image.artifactUrl || image.dataUrl }]} />
                )}
            </div>
        </div>
    );
}

function TaskGroup({
    task,
    jobs,
    now,
    onCancelJob,
    onCancelTask,
    onRetryJob,
    onEdit,
    onDownload,
    onSaveAsset,
    onAddCandidate,
    onAttachPack,
}: {
    task: Task;
    jobs: ImageJob[];
    now: number;
    onCancelJob: (jobId: string) => void;
    onCancelTask: () => void;
    onRetryJob: (jobId: string) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onAddCandidate: (jobId: string) => void;
    /** 透传给每张结果卡；不传则该入口不渲染（视频页复用同一张卡）。 */
    onAttachPack?: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    const jobById = new Map(jobs.map((job) => [job.id, job] as const));
    const total = task.jobIds.length;
    const pendingSubmit = total === 0;
    // 组进度 / 状态推导全部走共享件（与视频创作台同一口径），只认后端 job.status / job.progress。
    const list = task.jobIds.map((id) => jobById.get(id));
    const stats = countTaskJobs(list);
    const { finished, anyRunning, hasActive } = stats;
    const percent = taskPercent(list, finished, total);
    const status = deriveTaskStatus({ pendingSubmit, ...stats });
    const elapsedMs = Math.max(0, (now || task.startedAt) - task.startedAt);
    const statusLabel = pendingSubmit ? t("workbench.taskQueued") : t(taskStatusLabelKey(status, anyRunning));
    const statusColor = taskStatusColor(status);

    const cards = pendingSubmit
        ? [<PendingMediaCard key="pending" />]
        : task.jobIds.flatMap((id, jobIndex) => {
        const job = jobById.get(id);
        if (job?.status === "done" && job.outputs?.length) {
            return job.outputs
                .filter((output) => !output.type || output.type === "image")
                .map((output, outputIndex) => (
                    <ResultImageCard key={`${id}-${output.filename || outputIndex}`} image={jobOutputToImage(job, output)} index={jobIndex} archiveTargets={archiveTargetsFromJobs([job])} candidateJobId={job.id} onEdit={onEdit} onDownload={onDownload} onSaveAsset={onSaveAsset} onAddCandidate={onAddCandidate} onAttachPack={onAttachPack} />
                ));
        }
        if (job?.status === "canceled") {
            return [<FailedMediaCard key={id} canceled error={t("workbench.canceled")} onRetry={() => onRetryJob(id)} />];
        }
        if (job?.status === "error") {
            return [<FailedMediaCard key={id} error={job.error || t("workbench.generationFailed")} onRetry={() => onRetryJob(id)} />];
        }
        return [<PendingMediaCard key={id} progress={job?.progress} onCancel={() => onCancelJob(id)} />];
    });

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
                                <Progress percent={percent} size="small" showInfo={false} className="!mb-0 !w-32 min-w-24" />
                                <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                                    {finished}/{total}
                                </span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Tag className="m-0" color={statusColor}>
                        {statusLabel}
                    </Tag>
                    {status === "running" ? <span className="text-xs text-stone-500 dark:text-stone-400">{formatDuration(elapsedMs)}</span> : null}
                    {hasActive ? (
                        <Button size="small" danger icon={<XCircle className="size-3.5" />} onClick={onCancelTask}>
                            {t("workbench.cancel")}
                        </Button>
                    ) : null}
                </div>
            </div>
            {/* 同一次任务的素材成一组 → 预览里 ←/→ 切换它们（配合 usePreviewVerticalArrows 的 ↑/↓ 映射） */}
            <Image.PreviewGroup>
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">{cards}</div>
            </Image.PreviewGroup>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || formatTaskTime(new Date()),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
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

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: formatTaskTime(new Date()),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: images.length || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}

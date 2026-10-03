import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Progress, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { enqueueImages, getImageJob, isActiveJobStatus, listImageJobs, type ImageJob, type ImageJobOutput, type ImageJobProgress } from "@/services/api/image-jobs";
import { resolveGatewayUrl, uploadGatewayAsset } from "@/services/api/gateway";
import { deleteStoredImages, ensureImagePreview, getImageBlob, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type TaskStatus = "running" | "done" | "partial" | "failed";

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
    status: "success" | "failed";
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type GenerationSnapshot = { text: string; config: AiConfig; references: ReferenceImage[] };

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
/** 工作台「未结束任务」的本地索引：只存 jobIds 与提交事实，状态/进度一律回后端读。 */
const WORKBENCH_TASKS_KEY = "infinite-canvas:image_workbench_tasks";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

/** 单个 job 的耗时（后端 startedAt→finishedAt）；拿不到时间返回 0。 */
function jobDurationMs(job: ImageJob): number {
    const start = job.startedAt ? Date.parse(job.startedAt) : NaN;
    const end = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
}

/** 把一个后端产物直接映射成结果卡片用的图片（网关绝对地址；加入参考图/资产时再按需落本地）。 */
function jobOutputToImage(job: ImageJob, output: ImageJobOutput): GeneratedImage {
    return {
        id: `${job.id}-${output.filename || output.url}`,
        dataUrl: resolveGatewayUrl(output.url),
        durationMs: jobDurationMs(job),
        width: output.width || 0,
        height: output.height || 0,
        bytes: output.bytes || 0,
        ...(output.type === "image" ? { mimeType: "image/png" } : {}),
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
            }));
    } catch {
        return [];
    }
}

/** 只持久化未结束的任务（jobIds + 提交事实），刷新后据此恢复。 */
function persistTasks(tasks: Task[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(WORKBENCH_TASKS_KEY, JSON.stringify(tasks));
    } catch {
        // 私密模式 / 配额不足：持久化失败不影响当前会话。
    }
}

export default function ImagePage() {
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
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const [viewingHistoryWhileRunning, setViewingHistoryWhileRunning] = useState(false);
    const activeSnapshotRef = useRef<GenerationSnapshot | null>(null);
    const viewingHistoryRef = useRef(false);
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
    // 进度口径全部读后端：未结束 = 后端 status 为 queued/running（或该 job 还没取到）。
    const pendingSlotCount = tasks.reduce((sum, task) => sum + task.jobIds.filter((id) => isActiveJobStatus(jobs[id]?.status)).length, 0);
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

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
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

        // submitting 只在「上传参考图 + 入队」这段短暂窗口内挡住重复点击；编辑区与输入框任何情况下都不锁。
        setSubmitting(true);
        try {
            const referenceUrls = await resolveReferenceUrls(references);
            const result = await enqueueImages({
                template: model,
                prompt: text,
                count: generationCount,
                size: effectiveConfig.size,
                ...(referenceUrls.length ? { references: referenceUrls.map((url) => ({ url })) } : {}),
            });
            const jobIds = result.jobs.map((job) => job.id);
            if (!jobIds.length) throw new Error(t("workbench.generationFailed"));

            const task: Task = {
                id: nanoid(),
                prompt: text,
                count: jobIds.length,
                template: result.jobs[0]?.template || model,
                jobIds,
                startedAt: performance.now(),
                createdAt: new Date().toISOString(),
                ...(referenceUrls.length ? { referenceUrls } : {}),
                ...(agentTaskId ? { agentTaskId } : {}),
            };
            activeSnapshotRef.current = { text, config: effectiveConfig, references: [...references] };
            viewingHistoryRef.current = false;
            setViewingHistoryWhileRunning(false);
            setPreviewLog(null);
            setTasks((value) => [task, ...value]);
            setJobs((value) => {
                const next = { ...value };
                for (const job of result.jobs) next[job.id] = { id: job.id, status: job.status, template: job.template };
                return next;
            });
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
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
        viewingHistoryRef.current = false;
        setViewingHistoryWhileRunning(false);
        setPrompt("");
        setReferences([]);
        setTasks([]);
        setJobs({});
        loggedTaskIdsRef.current.clear();
        bubbledJobErrorsRef.current.clear();
        persistTasks([]);
        setNowTick(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(refreshLogs);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const previewGenerationLog = async (log: GenerationLog) => {
        const viewingActive = hasRunningTask;
        viewingHistoryRef.current = viewingActive;
        setViewingHistoryWhileRunning(viewingActive);
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
    };

    const returnToActiveGeneration = () => {
        const snapshot = activeSnapshotRef.current;
        if (!snapshot) return;
        viewingHistoryRef.current = false;
        setViewingHistoryWhileRunning(false);
        setPreviewLog(null);
        setPrompt(snapshot.text);
        setReferences(snapshot.references);
    };

    // 提示词编译已移到后端（POST /api/images/enqueue 入队前用 DeepSeek 编译，失败降级不阻塞）。
    // 前端不再调用 /api/prompt/compile。

    /** 任务全终态后落一条生成记录（后台跑完 / 刷新后恢复完成都走这条），并回写 Agent 任务状态。 */
    const recordTaskLog = async (task: Task, list: ImageJob[]) => {
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
                    images.push({ ...fallback, dataUrl: stored.url, ...(stored.storageKey ? { storageKey: stored.storageKey } : {}), width: output.width || stored.width, height: output.height || stored.height, bytes: output.bytes || stored.bytes, mimeType: stored.mimeType });
                } catch {
                    images.push(fallback);
                }
            }
        }
        const successCount = doneJobs.length;
        const failCount = Math.max(0, task.jobIds.length - successCount);
        saveLog(
            buildLog({
                prompt: task.prompt,
                model: task.template,
                config: { ...effectiveConfig, model: task.template, imageModel: task.template, count: String(task.count) },
                references: [],
                durationMs: Math.max(0, performance.now() - task.startedAt),
                successCount,
                failCount,
                status: successCount ? "success" : "failed",
                images,
            }),
        );
        if (task.agentTaskId) {
            updateAgentTask(task.agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : t("workbench.generationFailed") });
        }
    };

    /** 重试单个失败任务：按同一模板/提示词/参考图再入队一个 job，替换掉失败的那条。 */
    const retryJob = async (taskId: string, jobId: string) => {
        const task = tasks.find((item) => item.id === taskId);
        if (!task) return;
        setPreviewLog(null);
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

    // 任务全终态 → 落生成记录（正常完成 / 恢复完成都覆盖）。
    useEffect(() => {
        for (const task of tasks) {
            const list = task.jobIds.map((id) => jobs[id]).filter((job): job is ImageJob => Boolean(job));
            if (list.length < task.jobIds.length) continue;
            if (list.some((job) => isActiveJobStatus(job.status))) continue;
            void recordTaskLog(task, list);
        }
    }, [tasks, jobs]);

    // 只持久化「未结束」的任务：刷新后要恢复的就是它们；已完成的进生成记录，不再占存储。
    useEffect(() => {
        if (!restoredRef.current) return;
        const active = tasks.filter((task) => task.jobIds.some((id) => isActiveJobStatus(jobs[id]?.status)));
        persistTasks(active);
    }, [tasks, jobs]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
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
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
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
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
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
                            <div className="flex items-center gap-2">
                                {viewingHistoryWhileRunning ? (
                                    <Button size="small" type="primary" onClick={returnToActiveGeneration}>
                                        {t("workbench.returnToRunning", { count: pendingSlotCount })}
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        {previewLog ? (
                            previewLog.images.length ? (
                                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                    {previewLog.images.map((image, index) => (
                                        <ResultImageCard key={image.id} image={image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ))}
                                </div>
                            ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} className="!my-16" />
                            )
                        ) : tasks.length ? (
                            <div className="space-y-6">
                                {tasks.map((task) => (
                                    <TaskGroup
                                        key={task.id}
                                        task={task}
                                        jobs={task.jobIds.map((id) => jobs[id]).filter((job): job is ImageJob => Boolean(job))}
                                        now={nowTick}
                                        onRetryJob={(jobId) => void retryJob(task.id, jobId)}
                                        onEdit={addResultToReferences}
                                        onDownload={downloadImage}
                                        onSaveAsset={saveResultToAssets}
                                    />
                                ))}
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
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
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
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth registry onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ progress }: { progress?: ImageJobProgress }) {
    const { t } = useTranslation();
    const max = Number(progress?.max) || 0;
    const value = Number(progress?.value) || 0;
    // 进度/节点名全部来自后端 progress{value,max,node}；没有 max 时至少显示后端节点状态（排队中/生成中/已提交）。
    const detail = max > 0 ? `${value}/${max}` : progress?.node || t("workbench.generating");
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{detail}</span>
                {max > 0 ? <Progress percent={Math.round((value / max) * 100)} size="small" showInfo={false} className="!mb-0 !w-24" /> : null}
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function TaskGroup({
    task,
    jobs,
    now,
    onRetryJob,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    task: Task;
    jobs: ImageJob[];
    now: number;
    onRetryJob: (jobId: string) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    const jobById = new Map(jobs.map((job) => [job.id, job] as const));
    const total = task.jobIds.length;
    // 组进度 = 已完成条数 / 总条数；完成与否只认后端 status。
    const finished = task.jobIds.filter((id) => {
        const job = jobById.get(id);
        return Boolean(job) && !isActiveJobStatus(job!.status);
    }).length;
    const percent = total ? Math.round((finished / total) * 100) : 0;
    const hasActive = task.jobIds.some((id) => isActiveJobStatus(jobById.get(id)?.status));
    const hasError = task.jobIds.some((id) => jobById.get(id)?.status === "error");
    const status: TaskStatus = hasActive ? "running" : hasError ? (finished > 0 ? "partial" : "failed") : "done";
    const elapsedMs = Math.max(0, (now || task.startedAt) - task.startedAt);
    const statusLabel = status === "running" ? t("workbench.taskRunning") : status === "done" ? t("workbench.taskDone") : status === "partial" ? t("workbench.taskPartial") : t("workbench.taskFailed");
    const statusColor = status === "running" ? "blue" : status === "done" ? "green" : status === "partial" ? "orange" : "red";

    const cards = task.jobIds.flatMap((id, jobIndex) => {
        const job = jobById.get(id);
        if (job?.status === "done" && job.outputs?.length) {
            return job.outputs
                .filter((output) => !output.type || output.type === "image")
                .map((output, outputIndex) => (
                    <ResultImageCard key={`${id}-${output.filename || outputIndex}`} image={jobOutputToImage(job, output)} index={jobIndex} onEdit={onEdit} onDownload={onDownload} onSaveAsset={onSaveAsset} />
                ));
        }
        if (job && (job.status === "error" || job.status === "canceled")) {
            return [<FailedImageCard key={id} error={job.error || t("workbench.generationFailed")} onRetry={() => onRetryJob(id)} />];
        }
        return [<PendingImageCard key={id} progress={job?.progress} />];
    });

    return (
        <div className="rounded-lg border border-stone-200 bg-background p-3 dark:border-stone-800">
            <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{task.prompt}</div>
                    <div className="mt-1.5 flex items-center gap-2">
                        <Progress percent={percent} size="small" showInfo={false} className="!mb-0 !w-32 min-w-24" />
                        <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                            {finished}/{total}
                        </span>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Tag className="m-0" color={statusColor}>
                        {statusLabel}
                    </Tag>
                    {status === "running" ? <span className="text-xs text-stone-500 dark:text-stone-400">{formatDuration(elapsedMs)}</span> : null}
                </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">{cards}</div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image) => (
                                    <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {t("workbench.failCount", { count: log.failCount })}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
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
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
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
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}

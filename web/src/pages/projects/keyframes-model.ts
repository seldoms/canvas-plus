import type { GatewayCandidate, GatewayGenerationItem, GatewayJobStatus, GatewayPipelineRun } from "@/services/api/gateway";

/**
 * 「关键帧」工作区纯逻辑：把 run 的 `stages.keyframe.output.frames`（生成型条目，含 candidates[]）
 * 按镜头（shotId）分组，摊成渲染层直接可用的视图对象。
 *
 * 零 IO、零 React：只读传入的数据、只产出结构，便于单测与复用。
 * 数据形状见 canvas-server/src/pipeline.js：frames[] 每项 {id,shotId,role,prompt,template,candidates[]}，
 * candidate = {template,jobId,artifactUrl,status,params,createdAt}；params 里 INPUT_IMAGE 即参考图。
 */

/** 一次生成尝试（一个候选）：缩略图 / 模板 / 种子 / 参考图 / 失败原因都取自它。 */
export type KeyframeCandidate = {
    jobId: string;
    template: string;
    artifactUrl: string | null;
    status: GatewayJobStatus;
    /** 生成种子；params 里没有就是空串。 */
    seed: string;
    /** 生成时喂进去的参考图 URL（当前只有 end 帧的起始帧 INPUT_IMAGE）。 */
    references: string[];
    createdAt: string;
    selected: boolean;
    /** 可读失败原因（来自 job.error，已解析成一行）；成功或未知时为空串。 */
    reason: string;
};

/** 一个帧（一镜的 start / end / key）：同一镜可以有多个角色帧。 */
export type KeyframeFrame = {
    id: string;
    role: string;
    status: GatewayJobStatus;
    template: string;
    seed: string;
    references: string[];
    candidates: KeyframeCandidate[];
};

export type KeyframeFailure = { jobId: string; status: GatewayJobStatus; reason: string };

/** 一个镜头：该镜全部帧的候选聚合，供缩略图网格与镜头元信息行消费。 */
export type KeyframeShot = {
    id: string;
    index: number;
    prompt: string;
    durationSec: number;
    frames: KeyframeFrame[];
    /** 该镜已出图的候选（按 createdAt 升序），预览组按此顺序左右切换。 */
    images: KeyframeCandidate[];
    /** 该镜用到的模板（多帧不同时以 / 连接）；空串表示未知。 */
    template: string;
    /** 该镜用到的种子（多个以 / 连接）；空串表示未给。 */
    seed: string;
    /** 该镜用到的参考图数量（去重后的输入图）。 */
    referenceCount: number;
    status: GatewayJobStatus;
    failures: KeyframeFailure[];
};

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

/** params 里取种子：键名含 seed（不分大小写）。 */
function seedOf(params: Record<string, unknown>): string {
    for (const [key, value] of Object.entries(params)) {
        if (/seed/i.test(key) && (typeof value === "string" || typeof value === "number")) return String(value);
    }
    return "";
}

/** params 里取参考图：键名含 IMAGE 且值是路径/URL（INPUT_IMAGE 等）。 */
function referencesOf(params: Record<string, unknown>): string[] {
    const urls: string[] = [];
    for (const [key, value] of Object.entries(params)) {
        if (!/image/i.test(key)) continue;
        const url = typeof value === "string" ? value : "";
        if (url && !/^https?:/i.test(url)) urls.push(url);
        else if (/^https?:/i.test(url)) urls.push(url);
    }
    return unique(urls);
}

/**
 * 镜头状态聚合（候选是 job 级状态，没有 partial）：有排队/运行就是运行中；
 * 有失败就是失败；有取消就是已取消；全成功才是完成。
 */
function aggregateStatus(statuses: GatewayJobStatus[]): GatewayJobStatus {
    if (!statuses.length) return "queued";
    if (statuses.some((status) => status === "queued" || status === "running")) return "running";
    if (statuses.some((status) => status === "error")) return "error";
    if (statuses.some((status) => status === "canceled")) return "canceled";
    return "done";
}

/**
 * 把 job.error 解析成一行可读原因。comfy 的 error 是 JSON 字符串
 * （`[["execution_error",{exception_message:"..."}]]`），优先取其中的 exception_message / message；
 * 纯文本则原样截断。取不到返回空串。
 */
export function readableJobError(raw: unknown): string {
    if (raw == null) return "";
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return "";
        try {
            const parsed: unknown = JSON.parse(trimmed);
            const nested = readableJobError(parsed);
            if (nested) return nested;
        } catch {
            /* 不是 JSON，按纯文本处理 */
        }
        return shorten(trimmed);
    }
    if (Array.isArray(raw)) {
        // 结构化元素优先（[tag, payload] 里的 payload 才是正文），纯字符串兜底。
        for (const item of raw) if (item && typeof item === "object" && readableJobError(item)) return readableJobError(item);
        for (const item of raw) if (typeof item === "string" && readableJobError(item)) return readableJobError(item);
        return "";
    }
    const object = record(raw);
    if (object) {
        for (const key of ["exception_message", "message", "detail", "msg", "error"]) {
            const value = object[key];
            if (typeof value === "string" && value.trim()) return shorten(value.trim());
        }
        for (const value of Object.values(object)) {
            const found = readableJobError(value);
            if (found) return found;
        }
    }
    return "";
}

function shorten(value: string): string {
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** run 的 keyframe 条目（frames[]）；缺阶段或形状不对时返回空数组。 */
export function keyframeItems(run: GatewayPipelineRun | null): GatewayGenerationItem[] {
    const output = record(run?.stages?.keyframe?.output);
    const frames = output?.frames;
    return Array.isArray(frames) ? (frames as GatewayGenerationItem[]) : [];
}

/** 收集需要查 job.error 的候选（失败/已取消），供调用方批量拉取可读原因。 */
export function failedJobIds(run: GatewayPipelineRun | null): string[] {
    const ids: string[] = [];
    for (const item of keyframeItems(run)) {
        for (const candidate of item.candidates ?? []) {
            if ((candidate.status === "error" || candidate.status === "canceled") && candidate.jobId) ids.push(candidate.jobId);
        }
    }
    return unique(ids);
}

/** 分镜阶段镜头表：id → 序号/提示词/时长（缺分镜阶段时按 frames 顺序兜底）。 */
function storyboardShots(run: GatewayPipelineRun | null) {
    const output = record(run?.stages?.storyboard?.output);
    const shots = output?.shots;
    return Array.isArray(shots) ? shots.map(record).filter((shot): shot is Record<string, unknown> => Boolean(shot)) : [];
}

function buildCandidate(item: GatewayGenerationItem, candidate: GatewayCandidate, jobErrors: Record<string, string>): KeyframeCandidate {
    const params = record(candidate.params) ?? {};
    return {
        jobId: text(candidate.jobId),
        template: text(candidate.template),
        artifactUrl: text(candidate.artifactUrl) || null,
        status: candidate.status,
        seed: seedOf(params),
        references: referencesOf(params),
        createdAt: text(candidate.createdAt),
        selected: Boolean(item.selected) && candidate.jobId === item.selected,
        reason: jobErrors[text(candidate.jobId)] || "",
    };
}

function buildFrame(item: GatewayGenerationItem, jobErrors: Record<string, string>): KeyframeFrame {
    const candidates = (item.candidates ?? []).map((candidate) => buildCandidate(item, candidate, jobErrors));
    const latest = candidates.at(-1);
    return {
        id: text(item.id),
        role: text(item.role),
        status: item.status ?? latest?.status ?? "queued",
        template: text(item.template) || latest?.template || "",
        seed: candidates.map((candidate) => candidate.seed).find(Boolean) ?? "",
        references: unique(candidates.flatMap((candidate) => candidate.references)),
        candidates,
    };
}

/**
 * 按镜头分组关键帧候选。顺序取分镜阶段的镜头序号；不在分镜里的镜排在其后。
 * jobErrors 是 jobId → 可读失败原因（可选；缺省则失败条目只显示状态）。
 */
export function buildKeyframeShots(run: GatewayPipelineRun | null, jobErrors: Record<string, string> = {}): KeyframeShot[] {
    const items = keyframeItems(run);
    if (!items.length) return [];
    const shotMeta = storyboardShots(run);
    const orderById = new Map<string, number>();
    shotMeta.forEach((shot, position) => orderById.set(text(shot.id), number(shot.index, position + 1)));

    const grouped = new Map<string, GatewayGenerationItem[]>();
    for (const item of items) {
        const shotId = text(item.shotId) || text(item.id).replace(/-(start|end|key)$/, "") || "shot";
        grouped.set(shotId, [...(grouped.get(shotId) ?? []), item]);
    }

    const shots: KeyframeShot[] = [];
    for (const [shotId, shotItems] of grouped) {
        const meta = shotMeta.find((shot) => text(shot.id) === shotId);
        const frames = shotItems.map((item) => buildFrame(item, jobErrors));
        const images = frames
            .flatMap((frame) => frame.candidates)
            .filter((candidate) => candidate.artifactUrl)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const failures: KeyframeFailure[] = [];
        for (const frame of frames) {
            for (const candidate of frame.candidates) {
                if (candidate.status === "error" || candidate.status === "canceled") {
                    failures.push({ jobId: candidate.jobId, status: candidate.status, reason: candidate.reason });
                }
            }
        }
        shots.push({
            id: shotId,
            index: orderById.get(shotId) ?? shots.length + 1,
            prompt: text(meta?.prompt),
            durationSec: number(meta?.durationSec),
            frames,
            images,
            template: unique(frames.map((frame) => frame.template)).join(" / "),
            seed: unique(frames.map((frame) => frame.seed)).join(" / "),
            referenceCount: unique(frames.flatMap((frame) => frame.references)).length,
            status: aggregateStatus(frames.map((frame) => frame.status)),
            failures,
        });
    }
    return shots.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
}

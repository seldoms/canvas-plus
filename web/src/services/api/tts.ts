import axios from "axios";

import i18n from "@/i18n";

import { gatewayBaseUrl } from "./gateway";

/**
 * 平台音色库 + 试听（角色定妆「定声音」用）。
 *
 * 契约（以后端 `canvas-server/src/voices.js` / `casting.js` 为准，前端禁硬编码音色）：
 *   GET  /api/tts/voices  → 音色榜（`voices.js` listVoices 形状）：
 *          { template, speakers[], speakersDetailed[{id,value,label}], speakerLabels{}, languages[],
 *            defaultSpeaker, defaultLanguage, source, verified, note }
 *        —— 兼容任务书口径的 `{ voices:[...], languages:[...] }`（两键都读）。
 *   POST /api/tts/preview → { speaker, design?, language?, speed?, text? } → { url, artifactId, speaker, ms }
 *
 * ⚠️ 后端路由未注册时，SPA 静态托管会以 HTTP 200 + text/html 返回 index.html；
 * 客户端必须断言载荷形状，非 JSON / 非契约形状即 reject，绝不能把空对象当成空音色榜。
 */

export type TtsVoices = {
    /** 命名音色枚举（唯一合法取值域），顺序照后端。 */
    voices: string[];
    /** 音色 → 展示说明（纯展示，不影响取值；用 Tooltip 呈现，不做解释性小字）。 */
    labels: Record<string, string>;
    languages: string[];
    defaultSpeaker: string;
    defaultLanguage: string;
};

export type TtsPreviewRequest = { speaker: string; design?: string; language?: string; speed?: number; text?: string };
export type TtsPreviewResult = { url: string; artifactId: string; speaker: string; ms: number };

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** 从多种兼容形状里取命名音色枚举：voices / speakers / speakersDetailed[].id。 */
function readVoices(record: Record<string, unknown>): string[] {
    const direct = stringList(record.voices).length ? stringList(record.voices) : stringList(record.speakers);
    if (direct.length) return direct;
    const detailed = Array.isArray(record.speakersDetailed) ? record.speakersDetailed : [];
    return detailed.map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? "") : "")).filter(Boolean);
}

/** 音色展示说明：speakerLabels 优先，其次 speakersDetailed[].label。 */
function readLabels(record: Record<string, unknown>): Record<string, string> {
    const labels: Record<string, string> = {};
    const map = asRecord(record.speakerLabels);
    if (map) for (const [key, value] of Object.entries(map)) if (typeof value === "string" && value) labels[key] = value;
    const detailed = Array.isArray(record.speakersDetailed) ? record.speakersDetailed : [];
    for (const item of detailed) {
        const entry = asRecord(item);
        const id = entry ? String(entry.id ?? "") : "";
        const label = entry ? String(entry.label ?? "") : "";
        if (id && label && !labels[id]) labels[id] = label;
    }
    return labels;
}

async function request<T>(config: { method: "get" | "post"; url: string; data?: unknown; timeout?: number }): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl() });
        return response.data;
    } catch (error) {
        if (axios.isCancel(error)) throw error;
        throw new Error(readableError(error));
    }
}

function readableError(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const payload = error.response?.data as { error?: { message?: string } } | undefined;
        if (payload?.error?.message) return i18n.t("gateway.failed", { message: payload.error.message });
        if (error.response) return i18n.t("gateway.httpFailed", { status: error.response.status });
        return i18n.t("gateway.unreachable");
    }
    return error instanceof Error ? error.message : i18n.t("gateway.unreachable");
}

/** 平台音色榜：选项唯一来源。形状不对（含 SPA 回落 HTML）一律抛错，不返回空榜。 */
export async function listTtsVoices(): Promise<TtsVoices> {
    const data = await request<unknown>({ method: "get", url: "/api/tts/voices", timeout: 12000 });
    const record = asRecord(data);
    const voices = record ? readVoices(record) : [];
    if (!record || !voices.length) throw new Error(i18n.t("projects.casting.voicesFailed"));
    return {
        voices,
        labels: readLabels(record),
        languages: stringList(record.languages),
        defaultSpeaker: typeof record.defaultSpeaker === "string" ? record.defaultSpeaker : "",
        defaultLanguage: typeof record.defaultLanguage === "string" ? record.defaultLanguage : "",
    };
}

/** 试听：合成一句样句，返回可直接喂给 <audio> 的产物 URL。 */
export async function previewTtsVoice(body: TtsPreviewRequest): Promise<TtsPreviewResult> {
    const data = await request<unknown>({ method: "post", url: "/api/tts/preview", data: body, timeout: 60000 });
    const record = asRecord(data);
    const url = typeof record?.url === "string" ? record.url : "";
    if (!url) throw new Error(i18n.t("projects.casting.previewFailed"));
    return {
        url,
        artifactId: typeof record?.artifactId === "string" ? record.artifactId : "",
        speaker: typeof record?.speaker === "string" ? record.speaker : body.speaker,
        ms: typeof record?.ms === "number" ? record.ms : 0,
    };
}

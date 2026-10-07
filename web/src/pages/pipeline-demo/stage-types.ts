import type { GatewayPipelineRun } from "@/services/api/gateway";

/**
 * 各阶段 output 的真实形状 —— 以 2026-10-07 实测 run（run-muwj5llv-y15o6）为准。
 * 全部字段后端按契约产出，但旧 run 可能缺新字段，访问处一律可选链。
 */

export type ScriptCharacter = { id: string; name: string; profile?: string; appearance?: string; voice?: string };
export type ScriptScene = { id: string; title?: string; location?: string; time?: string; intent?: string; beats?: string[] };
export type ScriptEpisode = { id: string; index?: number; title?: string; durationSec?: number; synopsis?: string; sceneIds?: string[] };
export type ScriptOutput = {
    logline?: string;
    synopsis?: string;
    characters?: ScriptCharacter[];
    scenes?: ScriptScene[];
    episodes?: ScriptEpisode[];
    planSuggestion?: unknown;
};

export type BoardShot = {
    id: string;
    episodeId?: string;
    sceneId?: string;
    index?: number;
    durationSec?: number;
    shotSize?: string;
    camera?: string;
    action?: string;
    dialogue?: string;
    prompt?: string;
};
export type BoardEpisode = { id: string; index?: number; title?: string; sceneIds?: string[]; shotIds?: string[] };
export type StoryboardOutput = { episodes?: BoardEpisode[]; shots?: BoardShot[] };

export type DesignCharacter = { id: string; name?: string; outfit?: string; makeup?: string; hair?: string; props?: string[]; palette?: string; prompt?: string };
export type DesignLocation = { id: string; name?: string; setDressing?: string; lighting?: string };
export type DesignReference = { id: string; bindingId?: string; role?: string; kind?: string; name?: string; prompt?: string };
export type DesignOutput = { characters?: DesignCharacter[]; locations?: DesignLocation[]; references?: DesignReference[] };

export type CastingCharacterOut = {
    characterId: string;
    name?: string;
    face?: { closeupArtifactId?: string; turnaroundArtifactIds?: string[]; confirmed?: boolean };
    voice?: { voiceProfileId?: string; speaker?: string; design?: string; speed?: number; language?: string; previewArtifactId?: string; confirmed?: boolean };
    confirmed?: boolean;
};
export type CastingStageOutput = { characters?: CastingCharacterOut[] };

export type FrameCandidate = { template?: string; jobId?: string; artifactUrl?: string; status?: string };
export type KeyframeFrame = {
    id: string;
    shotId?: string;
    role?: string;
    prompt?: string;
    artifactUrl?: string;
    status?: string;
    candidates?: FrameCandidate[];
    selected?: number | string;
};
export type KeyframeOutput = { frames?: KeyframeFrame[] };

export type AudioLine = {
    id: string;
    shotId?: string;
    startSec?: number;
    endSec?: number;
    durationSec?: number;
    actualDurationSec?: number;
    type?: string;
    text?: string;
    performance?: string;
    speed?: number;
    characterId?: string;
    /** 该句实际使用的 VoiceProfile；跨镜音色是否一致就看这里（声音质量审计的核心字段）。 */
    voiceProfileId?: string;
    artifactUrl?: string;
    status?: string;
    candidates?: FrameCandidate[];
};
export type AudioOutput = { audio?: AudioLine[] };

export type AssemblyClip = { id: string; shotId?: string; keyframeId?: string; artifactUrl?: string; durationSec?: number; status?: string };
export type AssemblyOutput = { clips?: AssemblyClip[]; assembly?: { order?: string[]; transition?: string; status?: string; url?: string } };

/** 从 run 读某阶段 output；没有返回 null。 */
export function stageOutput<T>(run: GatewayPipelineRun | null | undefined, stageId: string): T | null {
    const output = run?.stages?.[stageId]?.output;
    return output && typeof output === "object" ? (output as T) : null;
}

/** 条目状态 → 展示色。 */
export function itemStatusTone(status?: string): "success" | "processing" | "error" | "default" {
    if (status === "done") return "success";
    if (status === "running" || status === "queued") return "processing";
    if (status === "error" || status === "failed" || status === "canceled") return "error";
    return "default";
}

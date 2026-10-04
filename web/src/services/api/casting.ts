import { updatePipelineStageInput, type GatewayPipelineRun } from "./gateway";

/**
 * 角色定妆（`casting`）阶段产物契约（见 progress/pilot-issues.md 冻结身份卡）。
 *
 * 一个角色一张身份卡 = 定脸（正脸特写 + 三视图）+ 定声音（平台音色库选音色）。
 * 脸 / 声 / 角色各有一个 `confirmed` 门禁；确认后修改则 `version+1` 需重新确认。
 * 产物落在 `run.stages.casting.output.characters[]`。
 */

export type CastingScope = "face" | "voice" | "all";

export type CastingFace = {
    /** 正脸特写产物 id（可空 = 未生成）。 */
    closeupArtifactId: string;
    /** 三视图产物 id 列表。 */
    turnaroundArtifactIds: string[];
    confirmed: boolean;
};

export type CastingVoice = {
    voiceProfileId: string;
    /** 平台音色库枚举名（如 `Uncle_fu`）；只能取 `GET /api/tts/voices` 的值。 */
    speaker: string;
    /** 音色描述（内容层中文，可选可编辑）。 */
    design: string;
    speed: number;
    language: string;
    /** 试听产物 id（可空）。 */
    previewArtifactId: string;
    confirmed: boolean;
};

export type CastingCharacter = {
    characterId: string;
    name: string;
    face: CastingFace;
    voice: CastingVoice;
    /** 角色总确认：脸与声都确认后才置真。 */
    confirmed: boolean;
    version: number;
    lockedAt: string | null;
};

export type CastingOutput = { characters: CastingCharacter[] };

/** 写回 casting 阶段产物（复用既有阶段 input 端点，不新造后端接口）。 */
export async function saveCastingOutput(runId: string, output: CastingOutput): Promise<GatewayPipelineRun> {
    return updatePipelineStageInput(runId, "casting", { output });
}

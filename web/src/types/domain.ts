/**
 * 领域契约类型 —— P0-0 冻结领域词汇（机器可读部分）。
 *
 * 纯类型定义：零运行时、零 import、无函数、无常量对象、无 enum（enum 会产生运行时代码）。
 * 字段名与 `docs/content/docs/progress/domain-contract.md`、`canvas-server/src/contracts.js` 逐字一致。
 * 本文件不接线任何现有模块；仅供 P0-a / P0-b / P0-d 引用。
 */

/* ------------------------------------------------------------------ *
 * 稳定 ID（见契约 §4）
 * ------------------------------------------------------------------ */

export type ProjectId = `prj_${string}`;
export type EpisodeId = `ep_${string}`;
export type SceneId = `sc_${string}`;
export type ShotId = `sh_${string}`;
export type SlotId = `slot_${string}`;

/** 未冻结前缀的标识：run / canvas / artifact / assetRef / workflow / stage / tool / job / provider / device。 */
export type RunId = string;
export type CanvasId = string;
export type ArtifactId = string;
export type AssetRefId = string;
export type WorkflowId = string;
export type StageId = string;
export type ToolId = string;
export type JobId = string;
export type DeliverableId = string;

/* ------------------------------------------------------------------ *
 * 状态机（见契约 §5）
 * ------------------------------------------------------------------ */

/** Stage：pending | running | partial | done | error | canceled | blocked（blocked = 被门禁挡住、尚未运行；2026-10-06 追加，见契约 §5.1 末尾登记） */
export type StageStatus = "pending" | "running" | "partial" | "done" | "error" | "canceled" | "blocked";

/** Job：queued | running | done | error | canceled */
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

/** Candidate / Slot：pending | queued | running | done | failed | canceled */
export type CandidateStatus = "pending" | "queued" | "running" | "done" | "failed" | "canceled";

/** Slot 与 Candidate 同集合。 */
export type SlotStatus = CandidateStatus;

/* ------------------------------------------------------------------ *
 * 冻结枚举值（见契约 §3.8 / §3.9）
 * ------------------------------------------------------------------ */

/** AssetRef.role */
export type AssetRole = "character" | "scene" | "prop" | "keyframe" | "clip";

/** Tool.resourceClass */
export type ResourceClass = "GPU_IMAGE" | "GPU_VIDEO" | "CPU" | "LLM" | "API";

/** Stage.gate；具体取值属 P0-a。 */
export type StageGate = string;

/* ------------------------------------------------------------------ *
 * Project（服务端，一部剧） 见契约 §3.1
 * ------------------------------------------------------------------ */

export type Plan = {
    genre: string;
    tone: string;
    /** 视觉呈现形式（写实真人/二维动画/像素风…），可直接进提示词的短语。 */
    visualStyle: string;
    ratio: string;
    episodeDurationSec: number;
    dramaMode: string;
    audience: string;
    episodeCount: number;
    /** 配音方式（项目级）：separate_dialogue_track = 独立配音（默认），embedded = 原声。 */
    audioMode: AudioMode;
};

/** 完成度检查表条目；内部形态待 P0-a。开放容器。 */
export type ChecklistItem = {
    id: string;
    label: string;
    done: boolean;
    [key: string]: unknown;
};

/** 审核风险提示（只提示、不改稿）；粒度待定，见契约 §8。开放容器。 */
/** 审核风险提示（D9：任何环节都可产生，按 scope 就近展示；只提示、不改稿）。 */
export type ReviewNoteScope = "project" | "episode" | "scene" | "shot";
export type ReviewNoteSource = "llm" | "human";
export type ReviewNoteLevel = "info" | "warn" | "block";
export type ReviewNote = {
    id: string;
    scope: ReviewNoteScope;
    /** scope 对应层级的实体 id；scope=project 时省略。 */
    targetId?: string;
    stage: string;
    source: ReviewNoteSource;
    level: ReviewNoteLevel;
    message: string;
    createdAt: string;
    resolvedAt?: string;
};

export type Project = {
    id: ProjectId;
    title: string;
    createdAt: string;
    updatedAt: string;
    styleAnchor: string;
    plan: Plan;
    /** 剧本正文/结构；内部形态待 P0-a（见契约 §8）。 */
    script: unknown;
    episodes: Episode[];
    assetRefs: AssetRef[];
    runIds: RunId[];
    canvasIds: CanvasId[];
    checklist: ChecklistItem[];
    reviewNotes: ReviewNote[];
    /** 跟进人标识（D7 单写者约定：一条线只有一个人跟）。 */
    ownerUserId?: string;
    version: number;
};

/* ------------------------------------------------------------------ *
 * Episode / Scene / Shot 见契约 §3.2 – §3.4
 * ------------------------------------------------------------------ */

export type Episode = {
    id: EpisodeId;
    projectId: ProjectId;
    index: number;
    title: string;
    logline?: string;
    /** 逐集覆盖（D8）：只写要覆盖的字段，未写的继承 Project.plan。 */
    plan?: Partial<Plan>;
    sceneIds: SceneId[];
    canvasIds: CanvasId[];
    /** 集状态；枚举值属 P0-a。 */
    status: string;
    deliverableIds: DeliverableId[];
};

export type Scene = {
    id: SceneId;
    episodeId: EpisodeId;
    index: number;
    locationId: string;
    time: string;
    intent: string;
    beatIds: string[];
};

export type Shot = {
    id: ShotId;
    episodeId: EpisodeId;
    sceneId: SceneId;
    index: number;
    /** 分镜数据；内部形态待 P0-a。 */
    storyboard: unknown;
    generationSlots: GenerationSlot[];
    /** 镜状态；枚举值属 P0-a。 */
    status: string;
};

/* ------------------------------------------------------------------ *
 * GenerationSlot / Candidate 见契约 §3.5 – §3.6
 * ------------------------------------------------------------------ */

export type GenerationSlot = {
    id: SlotId;
    shotId: ShotId;
    /** 槽角色（如关键帧 start/key/end、片段 clip）；枚举值属 P0-a。 */
    role: string;
    /** 当前采用的候选 jobId；未采用为 null。 */
    selected: JobId | null;
    /** 全部历史候选；不设数量上限、不自动清理（D10）。 */
    candidates: Candidate[];
};

export type Candidate = {
    template: string;
    jobId: JobId;
    artifactUrl: string | null;
    status: CandidateStatus;
    params: Record<string, unknown>;
    createdAt: string;
};

/* ------------------------------------------------------------------ *
 * Artifact 见契约 §3.7
 * ------------------------------------------------------------------ */

export type Artifact = {
    id: ArtifactId;
    jobId: JobId;
    url: string;
    /** 产物类型（image/video/audio/…）；枚举值属 P0-a。 */
    type: string;
    checksum: string;
    createdAt: string;
    nodeId?: string;
    outputName?: string;
};

/* ------------------------------------------------------------------ *
 * AssetRef 见契约 §3.8
 * ------------------------------------------------------------------ */

export type AssetRef = {
    id: AssetRefId;
    projectId: ProjectId;
    role: AssetRole;
    bindingId: string;
    episodeId?: EpisodeId;
    sceneId?: SceneId;
    shotId?: ShotId;
    artifactIds: ArtifactId[];
    selectedArtifactId: ArtifactId | null;
    metadata: Record<string, unknown>;
};

/* ------------------------------------------------------------------ *
 * Workflow / Stage / Tool 见契约 §3.9（D4 分层）
 * ------------------------------------------------------------------ */

export type Workflow = {
    id: WorkflowId;
    version: string;
    stages: Stage[];
};

export type Stage = {
    id: StageId;
    title: string;
    requires: string[];
    produces: string[];
    gate: StageGate;
    tools: ToolId[];
};

export type Tool = {
    id: ToolId;
    capability: string;
    paramsSchema: Record<string, unknown>;
    resourceClass: ResourceClass;
    providers: string[];
    cancelable: boolean;
    retryable: boolean;
};

/* ------------------------------------------------------------------ *
 * Job.meta 见契约 §3.10（现有 { runId, stageId, itemId } + 可选语义归属）
 * ------------------------------------------------------------------ */

export type JobMeta = {
    runId: RunId;
    stageId: StageId;
    itemId: string;
    projectId?: ProjectId;
    episodeId?: EpisodeId;
    sceneId?: SceneId;
    shotId?: ShotId;
    workflowRunId?: string;
    toolId?: ToolId;
};

/* ------------------------------------------------------------------ *
 * Canvas（浏览器编辑表面，D1：原 CanvasProject 更名）
 * 字段沿用现有 CanvasProject，仅语义纠正为「画布」。
 * ------------------------------------------------------------------ */

export type CanvasPosition = {
    x: number;
    y: number;
};

export type CanvasViewport = {
    x: number;
    y: number;
    k: number;
};

/** 画布节点/连线/助手会话沿用现有结构；此处留开放容器，避免本波复制既有实现。 */
export type Canvas = {
    id: CanvasId;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** 跟进人（D7 单写者约定）；同一画布同一时间只由一个人跟进。 */
    ownerUserId?: string;
    /** 最近写入者；与 ownerUserId 不一致时只提示，不自动覆盖。 */
    lastEditorId?: string;
    /** 版本号，用于识别写入归属（D7；不做自动冲突解决）。 */
    version: number;
    nodes: unknown[];
    connections: unknown[];
    chatSessions: unknown[];
    activeChatId: string | null;
    backgroundMode: string;
    showImageInfo: boolean;
    viewport: CanvasViewport;
};

/* ------------------------------------------------------------------ *
 * 生产对象契约（2026-10-03 追加冻结，见契约 §10）
 * 声音 / 资产 / 机位 / 溯源 / 可逆链新增实体；纯类型。
 * 字段名与 `canvas-server/src/contracts.js`、`canvas-server/src/production-contracts.js` 逐字一致。
 * ------------------------------------------------------------------ */

/** 新实体稳定 ID 前缀（见契约 §10.4）。 */
export type VoiceProfileId = `vp_${string}`;
export type AudioCueId = `cue_${string}`;
export type ProductionRefId = `aref_${string}`;
/** 输入指纹：稳定序列化后的 sha256 hex（§11.5.3）。 */
export type InputFingerprint = string;

/** ProjectBrief.visualMode（§13.1 / §13.4 Profile 表）。 */
export type VisualMode = "local_short" | "external_drama" | "hybrid";
/** ProjectBrief.audioMode（§13.1；separate_track 为 §11.5.1 同义别名，规整后归一）。 */
export type AudioMode = "separate_dialogue_track" | "embedded";
/** AudioCue.type（§13.5）。 */
export type AudioCueType = "dialogue" | "narration" | "sfx" | "ambience" | "music";
/** AudioCue.status（§13.5，最小已证集）。 */
export type AudioCueStatus = "draft" | "approved";
/** 生产引用角色（§11.5.2）。 */
export type ProductionRefRole = "character" | "scene";
/** StaleStatus（§11.5.3）：派生状态，不等于删除或失败。 */
export type StaleStatus = "fresh" | "stale";

export type DeliverySpec = {
    /** 交付容器 / 编码，如 h264-aac-mp4。 */
    video: string;
    subtitles: string[];
    cover: boolean;
};

export type BudgetSpec = {
    maxJobs: number;
    maxExternalCredits: number;
};

export type RightsEntry = {
    scope: string;
    status: string;
};

/** 全项目制作规格（§13.1）：Project 创建时保存，后续 WorkflowRun 只引用并快照。 */
export type ProjectBrief = {
    market: string;
    languages: string[];
    platformProfiles: string[];
    episodeCount: number;
    episodeDurationSec: number;
    visualMode: VisualMode;
    audioMode: AudioMode;
    delivery: DeliverySpec;
    budget: BudgetSpec;
    rights: RightsEntry[];
    version: number;
};

/** 角色音色锚点（§11.5.1）。 */
export type VoiceProfile = {
    id: VoiceProfileId;
    characterId: string;
    language: string;
    speaker: string;
    design: string;
    referenceArtifactId: ArtifactId | null;
    version: number;
};

/** 声音 Cue（§13.5）。 */
export type AudioCue = {
    id: AudioCueId;
    /** 镜头归属；非镜头级 Cue（如 BGM）为空串。 */
    shotId: ShotId | "";
    type: AudioCueType;
    startSec: number;
    endSec: number;
    text: string;
    characterId: string | null;
    voiceProfileId: VoiceProfileId | null;
    artifactId: ArtifactId | null;
    status: AudioCueStatus;
};

/** 生产引用元数据（§11.5.2）：views = 三视图 / 视角，confirmed = 人工确认门禁；其余字段开放。 */
export type ProductionRefMetadata = {
    views: string[];
    confirmed: boolean;
    [key: string]: unknown;
};

/** 角色生产引用（§11.5.2）。 */
export type CharacterRef = {
    id: ProductionRefId;
    role: "character";
    bindingId: string;
    artifactIds: ArtifactId[];
    selectedArtifactId: ArtifactId | null;
    metadata: ProductionRefMetadata;
};

/** 场景生产引用（§11.5.2）。 */
export type SceneRef = {
    id: ProductionRefId;
    role: "scene";
    bindingId: string;
    artifactIds: ArtifactId[];
    selectedArtifactId: ArtifactId | null;
    metadata: ProductionRefMetadata;
};

/** 焦点（§11.5.2）。 */
export type ShotCameraFocus = {
    from: string;
    to: string;
    atSec: number | null;
};

/** 运镜（§11.5.2）。 */
export type ShotCameraMovement = {
    type: string;
    direction: string;
    speed: string;
    stabilization: string;
};

/** 结构化机位（§11.5.2）；旧 `storyboard.camera` 长字符串可解析为该结构。 */
export type ShotCamera = {
    position: string;
    height: string;
    angle: string;
    lens: string;
    aperture: string;
    focus: ShotCameraFocus | null;
    movement: ShotCameraMovement | null;
};

/** 全链路运行记录（§13.9）。 */
export type Provenance = {
    projectId: ProjectId | "";
    workflowRunId: string;
    inputRevisions: Record<string, string>;
    toolSnapshot: {
        toolId: string;
        providerId: string;
        model: string;
    };
    deviceId: string | null;
    costEstimate: {
        localGpuSec: number;
        externalCredits: number;
    };
    startedAt: string | null;
};

/** 输入 revision 引用（§11.5.3）。 */
export type RevisionRef = {
    type: string;
    id: string;
    revision: number;
};

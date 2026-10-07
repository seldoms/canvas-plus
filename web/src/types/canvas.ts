export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    /** 服务端产物（M2）：content 直接存 artifact URL 时同步登记产物身份；有 artifactUrl 时 hydrate 直接用，不走 IndexedDB 重建。 */
    artifactId?: string;
    artifactUrl?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    /**
     * 镜头归因（P2-B5）：节点指向流水线里某个镜头的可写事实。
     *
     * 此前画布节点的归属只有「画布级 serverProjectId」这一个弱引用，节点自身说不出
     * 「我是哪一镜」，于是画布上的调整无法回写分镜（patchShot 一直只有 API、没有入口）。
     * 有了它，「分镜发到画布」和「画布回写分镜」才有落脚点。
     *
     * 注意这是**画布侧可编辑副本**：改了会经 patchStageShot 回写到 run 的 storyboard 产物，
     * 不是直接改 run。runId 为空表示未归到某次运行（纯项目侧镜头）。
     */
    shotRef?: CanvasShotRef;
    /**
     * 镜头内容字段（P2-B5）：从分镜镜头搬过来的可编辑副本。
     *
     * 用嵌套块而不是把 action/dialogue/shotSize 平铺进 metadata：这些是**分镜的字段**，
     * 与节点自身的画布语义（size/quality/count…）是两套东西，平铺会互相污染
     * （metadata.size 已被画布规格占用，分镜没有 size 却有 durationSec/shotSize）。
     */
    shot?: CanvasShotContent;
};

/** 分镜镜头的可写内容字段（P2-B5；与服务端可回写白名单一致）。 */
export type CanvasShotContent = {
    prompt?: string;
    negativePrompt?: string;
    action?: string;
    dialogue?: string;
    dialogueLines?: Array<{ speaker?: string; text?: string; performance?: string }>;
    durationSec?: number;
    shotSize?: string;
    camera?: string;
    cameraSpec?: Record<string, unknown>;
    textOverlays?: Array<Record<string, unknown>>;
    audio?: string;
};

/**
 * 画布节点上的镜头归因（P2-B5）。
 * shotId 落在 run 产物命名空间（如 sh1）或项目侧命名空间（如 ep_0001），
 * 由 source 区分——两套 id 不能混用（回写端点不同）。
 */
export type CanvasShotRef = {
    projectId?: string;
    runId?: string;
    /** 分镜所在 stage id；目前只支持 storyboard。 */
    stageId?: string;
    episodeId?: string;
    sceneId?: string;
    shotId: string;
    /** shotId 属于哪套命名空间："run"（流水线产物）| "project"（项目侧镜头）。 */
    source?: "run" | "project";
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };

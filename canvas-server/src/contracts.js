/**
 * 领域契约常量 —— P0-0 冻结领域词汇（机器可读部分）。
 *
 * 纯常量模块：零依赖、无副作用、不读写文件、不定义任何业务函数。
 * 本波只落地契约，不被任何现有模块 import（不接线）。
 * 人读契约：docs/content/docs/progress/domain-contract.md
 * 类型定义：web/src/types/domain.ts
 */

/** 稳定 ID 前缀（见契约 §4）。 */
export const ID_PREFIX = Object.freeze({
    project: "prj_",
    episode: "ep_",
    scene: "sc_",
    shot: "sh_",
    slot: "slot_",
});

/** Stage 状态机：pending | running | partial | done | error | canceled（终态 done/error/canceled；partial 非终态）。 */
export const STAGE_STATUS = Object.freeze({
    PENDING: "pending",
    RUNNING: "running",
    PARTIAL: "partial",
    DONE: "done",
    ERROR: "error",
    CANCELED: "canceled",
});

/** Job 状态机：queued | running | done | error | canceled（语义不变）。 */
export const JOB_STATUS = Object.freeze({
    QUEUED: "queued",
    RUNNING: "running",
    DONE: "done",
    ERROR: "error",
    CANCELED: "canceled",
});

/** Candidate / Slot 状态机：pending | queued | running | done | failed | canceled。 */
export const CANDIDATE_STATUS = Object.freeze({
    PENDING: "pending",
    QUEUED: "queued",
    RUNNING: "running",
    DONE: "done",
    FAILED: "failed",
    CANCELED: "canceled",
});

/** Tool.resourceClass（D6 按资源调度）。 */
export const RESOURCE_CLASS = Object.freeze({
    GPU_IMAGE: "GPU_IMAGE",
    GPU_VIDEO: "GPU_VIDEO",
    CPU: "CPU",
    LLM: "LLM",
    API: "API",
});

/** AssetRef.role。 */
export const ASSET_ROLE = Object.freeze({
    CHARACTER: "character",
    SCENE: "scene",
    PROP: "prop",
    KEYFRAME: "keyframe",
    CLIP: "clip",
});

/** ReviewNote.scope / level（D9）。 */
export const REVIEW_NOTE_SCOPE = Object.freeze({
    PROJECT: "project",
    EPISODE: "episode",
    SCENE: "scene",
    SHOT: "shot",
});
export const REVIEW_NOTE_LEVEL = Object.freeze({
    INFO: "info",
    WARN: "warn",
    BLOCK: "block",
});

/**
 * 兼容别名清单（见契约 §6）：现有代码字段 → 新契约字段。
 * §6.1 别名必须保留读取；下游与前端不因引入 candidates[] 而改动。
 * item.jobId / item.artifactUrl / item.status 是 GenerationSlot.selected 候选的派生别名。
 */
export const LEGACY_ALIASES = Object.freeze([
    Object.freeze({
        legacy: "item.jobId",
        contract: "GenerationSlot.selected",
        kind: "alias",
        note: "选中候选的 jobId；派生别名，保留读取。",
    }),
    Object.freeze({
        legacy: "item.artifactUrl",
        contract: "GenerationSlot.selected.artifactUrl",
        kind: "alias",
        note: "选中候选的产物 URL；回写断链修复后由投影器写入，保留读取。",
    }),
    Object.freeze({
        legacy: "item.status",
        contract: "GenerationSlot.selected.status",
        kind: "alias",
        note: "选中候选的状态；派生别名，保留读取。",
    }),
    Object.freeze({
        legacy: "item.template",
        contract: "Candidate.template",
        kind: "migrate",
        note: "原为全局单值 pipelineConfig.imageTemplate，改为每次 attempt 独立。",
    }),
    Object.freeze({
        legacy: "CanvasProject",
        contract: "Canvas",
        kind: "rename",
        note: "D1 纯改名；CanvasAgentSnapshot.projectId 语义纠正为 Canvas.id。",
    }),
    Object.freeze({
        legacy: "Asset.projectId",
        contract: "AssetRef.projectId",
        kind: "add",
        note: "当前缺失；空 = 全局素材库，有值 = 项目私有。",
    }),
    Object.freeze({
        legacy: "Asset.bindingId",
        contract: "AssetRef.bindingId",
        kind: "add",
        note: "当前缺失；绑定到剧本里的角色/场景/道具 → 一致性锚点落点。",
    }),
    Object.freeze({
        legacy: "run.options.projectId",
        contract: "Project.id",
        kind: "transitional",
        note: "过渡位：可先塞 run.options（零服务端改动），Project 内核建立后转正。",
    }),
    Object.freeze({
        legacy: "job.meta",
        contract: "JobMeta",
        kind: "extend",
        note: "在 { runId, stageId, itemId } 基础上扩展可选 { projectId, episodeId, sceneId, shotId, workflowRunId, toolId }。",
    }),
    Object.freeze({
        legacy: "reindex() sh1..shN",
        contract: "Shot.id",
        kind: "constraint",
        note: "Shot.id 稳定不可重排；reindex 只改 index。",
    }),
]);

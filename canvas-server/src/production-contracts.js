/**
 * 生产对象契约（§13 / §11.5 追加冻结）——纯函数：规整 + 校验。
 *
 * 零依赖（只用 node: 内置）、零 IO、零副作用；只定义新实体的规整/校验与旧 `camera`
 * 长字符串解析，**不被任何流水线模块 import**（本波只落地契约，不接线）。
 *
 * 契约文本：docs/content/docs/progress/domain-contract.md §10
 * 类型定义：web/src/types/domain.ts
 * 冻结枚举：canvas-server/src/contracts.js（VISUAL_MODE / AUDIO_MODE / AUDIO_CUE_TYPE /
 *           AUDIO_CUE_STATUS / PRODUCTION_REF_ROLE / STALE_STATUS / PRODUCTION_ID_PREFIX）
 *
 * 规整函数统一签名：`normalizeX(input) -> { value, warnings }`
 *   - 缺字段 → 安全默认，并记一条 `{ field, code: "defaulted" }`；
 *   - 非法值 → 降级到安全默认，并记一条 `{ field, code: "degraded", got }`；
 *   - 结构性非法（缺稳定身份、枚举无安全默认、时间区间倒挂等）→ 抛带 `.status=400` 的错。
 *
 * @typedef {Object} ProjectBrief 全项目制作规格（§13.1）
 * @typedef {Object} VoiceProfile 角色音色锚点（§11.5.1）
 * @typedef {Object} AudioCue 声音 Cue（§13.5）
 * @typedef {Object} ProductionRef CharacterRef / SceneRef：角色/场景生产引用（§11.5.2）
 * @typedef {Object} ShotCamera 结构化机位（§11.5.2）
 * @typedef {Object} Provenance 全链路运行记录（§13.9）
 * @typedef {Object} RevisionRef 输入 revision 引用（§11.5.3）
 * @typedef {string} InputFingerprint 输入指纹（sha256 hex，§11.5.3）
 */

import { createHash } from "node:crypto";

import { AUDIO_CUE_STATUS, AUDIO_CUE_TYPE, AUDIO_MODE, PRODUCTION_REF_ROLE, STALE_STATUS, VISUAL_MODE } from "./contracts.js";

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 契约错误：路由层可直接用 `.status` / `.field` 回 400。 */
class ContractError extends Error {
    constructor(message, field) {
        super(message);
        this.name = "ContractError";
        this.status = 400;
        this.code = "CONTRACT_INVALID";
        this.field = field;
    }
}

const reject = (message, field) => {
    throw new ContractError(message, field);
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asObject = (value) => (isPlainObject(value) ? value : {});
const asTrimmedString = (value) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim());

/** 收集规整过程中的 defaulted / degraded 警告，返回 `{ value, warnings }` 的公共载体。 */
function collector() {
    const warnings = [];
    return {
        warnings,
        defaulted(field, fallback) {
            warnings.push({ field, code: "defaulted", message: `缺少 ${field}，已用安全默认` });
            return fallback;
        },
        degraded(field, got, fallback) {
            warnings.push({ field, code: "degraded", got, message: `${field} 非法值已降级` });
            return fallback;
        },
    };
}

function normalizeStringArray(input, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, []);
    if (!Array.isArray(input)) return c.degraded(field, input, []);
    return input.map((item) => String(item)).filter((item) => item.trim() !== "");
}

function normalizePositiveNumber(input, fallback, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, fallback);
    const num = Number(input);
    if (!Number.isFinite(num) || num <= 0) return c.degraded(field, input, fallback);
    return num;
}

function normalizePositiveInt(input, fallback, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, fallback);
    const num = Number(input);
    if (!Number.isFinite(num) || num <= 0) return c.degraded(field, input, fallback);
    return Math.floor(num);
}

function normalizeNonNegativeNumber(input, fallback, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, fallback);
    const num = Number(input);
    if (!Number.isFinite(num) || num < 0) return c.degraded(field, input, fallback);
    return num;
}

function normalizeVersion(input, c, field = "version") {
    if (input === undefined || input === null) return c.defaulted(field, 1);
    const num = Number(input);
    if (!Number.isInteger(num) || num < 1) return c.degraded(field, input, 1);
    return num;
}

/** null 语义的字符串字段：undefined → 默认 null 并告警；显式 null/"" → null（不告警）。 */
function normalizeNullableString(input, c, field) {
    if (input === undefined) return c.defaulted(field, null);
    if (input === null || input === "") return null;
    return String(input);
}

const VALID_VISUAL_MODE = new Set(Object.values(VISUAL_MODE));
const VALID_AUDIO_MODE = new Set(Object.values(AUDIO_MODE));
const VALID_CUE_TYPE = new Set(Object.values(AUDIO_CUE_TYPE));
const VALID_CUE_STATUS = new Set(Object.values(AUDIO_CUE_STATUS));

/* ------------------------------------------------------------------ *
 * 1. ProjectBrief（§13.1）
 * ------------------------------------------------------------------ */

/** 规整全项目制作规格；缺字段回落安全默认，非法枚举降级并告警。 */
export function normalizeProjectBrief(input) {
    if (input !== undefined && input !== null && !isPlainObject(input)) reject("ProjectBrief 必须是对象", "ProjectBrief");
    const body = asObject(input);
    const c = collector();

    const value = {
        market: typeof body.market === "string" && body.market.trim() ? body.market.trim() : c.defaulted("market", "global"),
        languages: normalizeStringArray(body.languages, "languages", c),
        platformProfiles: normalizeStringArray(body.platformProfiles, "platformProfiles", c),
        episodeCount: normalizePositiveInt(body.episodeCount, 1, "episodeCount", c),
        episodeDurationSec: normalizePositiveNumber(body.episodeDurationSec, 120, "episodeDurationSec", c),
        visualMode: normalizeVisualMode(body.visualMode, c),
        audioMode: normalizeAudioMode(body.audioMode, c),
        delivery: normalizeDelivery(body.delivery, c),
        budget: normalizeBudget(body.budget, c),
        rights: normalizeRights(body.rights, c),
        version: normalizeVersion(body.version, c),
    };

    return { value, warnings: c.warnings };
}

/**
 * visualMode：§13.1 注释与 §13.4 Profile 表给出 local_short | external_drama | hybrid。
 * §13.1 样例写的 external_video_api 不在该取值域内（文档分歧，见契约 §10.5）→ 降级到 local_short。
 */
function normalizeVisualMode(input, c) {
    if (input === undefined || input === null || input === "") return c.defaulted("visualMode", VISUAL_MODE.LOCAL_SHORT);
    const raw = String(input);
    return VALID_VISUAL_MODE.has(raw) ? raw : c.degraded("visualMode", raw, VISUAL_MODE.LOCAL_SHORT);
}

/** audioMode：§13.1 只给 separate_dialogue_track；§11.5.1 的 separate_track 指同一概念，归一到前者。 */
function normalizeAudioMode(input, c) {
    if (input === undefined || input === null || input === "") return c.defaulted("audioMode", AUDIO_MODE.SEPARATE_DIALOGUE_TRACK);
    const raw = String(input).trim();
    if (VALID_AUDIO_MODE.has(raw)) return raw;
    if (raw === "separate_track") return c.degraded("audioMode", raw, AUDIO_MODE.SEPARATE_DIALOGUE_TRACK);
    return c.degraded("audioMode", raw, AUDIO_MODE.SEPARATE_DIALOGUE_TRACK);
}

function normalizeDelivery(input, c) {
    const fallback = { video: "h264-aac-mp4", subtitles: [], cover: false };
    if (input === undefined || input === null) return c.defaulted("delivery", fallback);
    if (!isPlainObject(input)) return c.degraded("delivery", input, fallback);
    return {
        video: typeof input.video === "string" && input.video.trim() ? input.video.trim() : "h264-aac-mp4",
        subtitles: normalizeStringArray(input.subtitles, "delivery.subtitles", c),
        cover: typeof input.cover === "boolean" ? input.cover : false,
    };
}

function normalizeBudget(input, c) {
    const fallback = { maxJobs: 0, maxExternalCredits: 0 };
    if (input === undefined || input === null) return c.defaulted("budget", fallback);
    if (!isPlainObject(input)) return c.degraded("budget", input, fallback);
    return {
        maxJobs: normalizeNonNegativeNumber(input.maxJobs, 0, "budget.maxJobs", c),
        maxExternalCredits: normalizeNonNegativeNumber(input.maxExternalCredits, 0, "budget.maxExternalCredits", c),
    };
}

function normalizeRights(input, c) {
    if (input === undefined || input === null) return c.defaulted("rights", []);
    if (!Array.isArray(input)) return c.degraded("rights", input, []);
    return input.map((entry) => {
        const row = asObject(entry);
        return {
            scope: typeof row.scope === "string" ? row.scope.trim() : "",
            status: typeof row.status === "string" && row.status.trim() ? row.status.trim() : "to_review",
        };
    });
}

/* ------------------------------------------------------------------ *
 * 2. VoiceProfile（§11.5.1）
 * ------------------------------------------------------------------ */

/** 规整角色音色锚点：id / characterId 为稳定身份，缺失即拒；其余字段回落安全默认。 */
export function normalizeVoiceProfile(input) {
    if (!isPlainObject(input)) reject("VoiceProfile 必须是对象", "VoiceProfile");
    const id = asTrimmedString(input.id);
    if (!id) reject("VoiceProfile 缺少 id", "id");
    const characterId = asTrimmedString(input.characterId);
    if (!characterId) reject("VoiceProfile 缺少 characterId", "characterId");

    const c = collector();
    const value = {
        id,
        characterId,
        language: normalizeLanguage(input.language, c),
        speaker: input.speaker === undefined || input.speaker === null ? c.defaulted("speaker", "") : String(input.speaker),
        design: input.design === undefined || input.design === null ? c.defaulted("design", "") : String(input.design),
        referenceArtifactId: normalizeNullableString(input.referenceArtifactId, c, "referenceArtifactId"),
        version: normalizeVersion(input.version, c),
    };
    return { value, warnings: c.warnings };
}

function normalizeLanguage(input, c) {
    if (input === undefined || input === null || input === "") return c.defaulted("language", "zh-CN");
    const raw = String(input).trim();
    return raw || c.degraded("language", input, "zh-CN");
}

/* ------------------------------------------------------------------ *
 * 3. AudioCue（§13.5）
 * ------------------------------------------------------------------ */

/** 规整声音 Cue：id / type 缺失或 type 非法即拒；时间区间倒挂即拒；其余回落安全默认。 */
export function normalizeAudioCue(input) {
    if (!isPlainObject(input)) reject("AudioCue 必须是对象", "AudioCue");
    const id = asTrimmedString(input.id);
    if (!id) reject("AudioCue 缺少 id", "id");

    const rawType = input.type === undefined || input.type === null ? "" : String(input.type);
    if (!VALID_CUE_TYPE.has(rawType)) reject(`AudioCue.type 非法：${rawType || "(空)"}`, "type");

    const c = collector();
    const shotId = input.shotId === undefined || input.shotId === null || input.shotId === "" ? c.defaulted("shotId", "") : String(input.shotId);
    const startSec = normalizeNonNegativeNumber(input.startSec, 0, "startSec", c);
    const endSec = input.endSec === undefined || input.endSec === null ? startSec : normalizeNonNegativeNumber(input.endSec, startSec, "endSec", c);
    if (endSec < startSec) reject(`AudioCue 时间区间非法：endSec(${endSec}) < startSec(${startSec})`, "endSec");

    const value = {
        id,
        shotId,
        type: rawType,
        startSec,
        endSec,
        text: input.text === undefined || input.text === null ? c.defaulted("text", "") : String(input.text),
        characterId: normalizeNullableString(input.characterId, c, "characterId"),
        voiceProfileId: normalizeNullableString(input.voiceProfileId, c, "voiceProfileId"),
        artifactId: normalizeNullableString(input.artifactId, c, "artifactId"),
        status: normalizeCueStatus(input.status, c),
    };
    return { value, warnings: c.warnings };
}

function normalizeCueStatus(input, c) {
    if (input === undefined || input === null || input === "") return c.defaulted("status", AUDIO_CUE_STATUS.DRAFT);
    const raw = String(input);
    return VALID_CUE_STATUS.has(raw) ? raw : c.degraded("status", raw, AUDIO_CUE_STATUS.DRAFT);
}

/* ------------------------------------------------------------------ *
 * 4. CharacterRef / SceneRef（§11.5.2）
 * ------------------------------------------------------------------ */

/** 规整场景生产引用（role 固定 scene）。 */
export function normalizeSceneRef(input) {
    return normalizeProductionRef(input, PRODUCTION_REF_ROLE.SCENE);
}

/** 规整角色生产引用（role 固定 character）。 */
export function normalizeCharacterRef(input) {
    return normalizeProductionRef(input, PRODUCTION_REF_ROLE.CHARACTER);
}

/** 角色/场景生产引用：id / bindingId 是稳定身份，缺失即拒；selectedArtifactId 必须落在 artifactIds 内。 */
function normalizeProductionRef(input, role) {
    if (!isPlainObject(input)) reject("生产引用必须是对象", role);
    const id = asTrimmedString(input.id);
    if (!id) reject(`${role} 引用缺少 id`, "id");
    if (input.role !== undefined && input.role !== null && String(input.role) !== role) reject(`引用 role 非法：${input.role}（应为 ${role}）`, "role");
    const bindingId = asTrimmedString(input.bindingId);
    if (!bindingId) reject("生产引用缺少绑定锚点 bindingId", "bindingId");

    const c = collector();
    let artifactIds;
    if (input.artifactIds === undefined || input.artifactIds === null) artifactIds = c.defaulted("artifactIds", []);
    else if (Array.isArray(input.artifactIds)) artifactIds = input.artifactIds.map((item) => String(item)).filter((item) => item !== "");
    else artifactIds = c.degraded("artifactIds", input.artifactIds, []);

    const selectedArtifactId = input.selectedArtifactId === undefined || input.selectedArtifactId === null || input.selectedArtifactId === "" ? null : String(input.selectedArtifactId);
    if (selectedArtifactId && !artifactIds.includes(selectedArtifactId)) reject(`selectedArtifactId 不在 artifactIds 内：${selectedArtifactId}`, "selectedArtifactId");

    let metadata;
    if (input.metadata === undefined || input.metadata === null) metadata = c.defaulted("metadata", {});
    else if (isPlainObject(input.metadata)) metadata = input.metadata;
    else metadata = c.degraded("metadata", input.metadata, {});

    const value = {
        id,
        role,
        bindingId,
        artifactIds,
        selectedArtifactId,
        metadata: {
            ...metadata,
            views: Array.isArray(metadata.views) ? metadata.views.map((item) => String(item)) : [],
            confirmed: typeof metadata.confirmed === "boolean" ? metadata.confirmed : false,
        },
    };
    return { value, warnings: c.warnings };
}

/* ------------------------------------------------------------------ *
 * 5. ShotCamera（§11.5.2）+ 旧 camera 长字符串解析
 * ------------------------------------------------------------------ */

const SHOT_CAMERA_STRING_FIELDS = ["position", "height", "angle", "lens", "aperture"];

/** 规整结构化机位；结构缺失回落空串 / null（不告警，空即「未声明」）。 */
export function normalizeShotCamera(input) {
    if (input !== undefined && input !== null && !isPlainObject(input)) reject("ShotCamera 必须是对象", "ShotCamera");
    const body = asObject(input);
    const c = collector();
    const value = {};
    for (const key of SHOT_CAMERA_STRING_FIELDS) value[key] = asTrimmedString(body[key]);
    value.focus = normalizeFocus(body.focus, c);
    value.movement = normalizeMovement(body.movement, c);
    return { value, warnings: c.warnings };
}

function normalizeFocus(input, c) {
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return c.degraded("focus", input, null);
    const rawAtSec = input.atSec === undefined || input.atSec === null ? null : Number(input.atSec);
    return {
        from: typeof input.from === "string" ? input.from : "",
        to: typeof input.to === "string" ? input.to : "",
        atSec: Number.isFinite(rawAtSec) ? rawAtSec : null,
    };
}

function normalizeMovement(input, c) {
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return c.degraded("movement", input, null);
    return {
        type: typeof input.type === "string" ? input.type : "",
        direction: typeof input.direction === "string" ? input.direction : "",
        speed: typeof input.speed === "string" ? input.speed : "",
        stabilization: typeof input.stabilization === "string" ? input.stabilization : "",
    };
}

/** 旧 `storyboard.camera` 长字符串 → ShotCamera 的关键词表（§11.5.2，兼容读取，不抛异常）。 */
const LEGACY_POSITION = [
    [/斜侧|前右|前左|三分之四/, "subject-front-right"],
    [/正面|正拍|正机位/, "subject-front"],
    [/侧面|侧拍|侧机位/, "subject-side"],
    [/背面|背拍|背机位/, "subject-back"],
];
const LEGACY_ANGLE = [
    [/仰拍|仰视|低角度/, "low-angle"],
    [/俯拍|俯视|高角度|俯瞰/, "high-angle"],
    [/平视|平拍|平角度/, "eye-level"],
];
const LEGACY_HEIGHT = [
    [/大特写|特写/, "close"],
    [/近景/, "chest"],
    [/中景/, "waist"],
    [/全景|大远景|远景/, "wide"],
];
const LEGACY_MOVEMENT = [
    [/推镜|推近|推进/, { type: "dolly", direction: "forward", speed: "", stabilization: "" }],
    [/拉镜|拉远|后退/, { type: "dolly", direction: "backward", speed: "", stabilization: "" }],
    [/摇镜|横摇|摇移/, { type: "pan", direction: "", speed: "", stabilization: "" }],
    [/跟拍|跟随|跟镜/, { type: "track", direction: "", speed: "", stabilization: "" }],
    [/固定|静止|锁死/, { type: "static", direction: "", speed: "", stabilization: "" }],
];

function firstMatch(text, table) {
    for (const [pattern, mapped] of table) if (pattern.test(text)) return mapped;
    return null;
}

/**
 * 解析旧 `camera` 长字符串（§11.5.2）：能识别出任意机位/焦段/运镜字段即返回 ShotCamera；
 * 否则返回 `{ camera: null, reason }`——**不抛异常**。
 */
export function parseLegacyCamera(raw) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return { camera: null, reason: "camera 为空" };

    const camera = { position: "", height: "", angle: "", lens: "", aperture: "", focus: null, movement: null };
    let matched = 0;

    const lens = text.match(/(\d{1,3})\s*mm/i);
    if (lens) {
        camera.lens = `${lens[1]}mm`;
        matched += 1;
    }
    const aperture = text.match(/f\s*\/?\s*(\d+(?:\.\d+)?)/i);
    if (aperture) {
        camera.aperture = `f${aperture[1]}`;
        matched += 1;
    }
    for (const [key, table] of [
        ["position", LEGACY_POSITION],
        ["angle", LEGACY_ANGLE],
        ["height", LEGACY_HEIGHT],
    ]) {
        const hit = firstMatch(text, table);
        if (hit) {
            camera[key] = hit;
            matched += 1;
        }
    }
    const movement = firstMatch(text, LEGACY_MOVEMENT);
    if (movement) {
        camera.movement = { ...movement };
        matched += 1;
    }

    if (matched === 0) return { camera: null, reason: "未识别出任何机位/焦段/运镜字段" };
    return { camera, reason: null };
}

/* ------------------------------------------------------------------ *
 * 6. Provenance（§13.9）
 * ------------------------------------------------------------------ */

/** 规整全链路运行记录；数值/映射/快照缺失回落安全默认。 */
export function normalizeProvenance(input) {
    if (!isPlainObject(input)) reject("Provenance 必须是对象", "Provenance");
    const c = collector();
    const value = {
        projectId: input.projectId === undefined || input.projectId === null ? c.defaulted("projectId", "") : String(input.projectId),
        workflowRunId: input.workflowRunId === undefined || input.workflowRunId === null ? c.defaulted("workflowRunId", "") : String(input.workflowRunId),
        inputRevisions: normalizeRevisionsMap(input.inputRevisions, c),
        toolSnapshot: normalizeToolSnapshot(input.toolSnapshot, c),
        deviceId: normalizeNullableString(input.deviceId, c, "deviceId"),
        costEstimate: normalizeCostEstimate(input.costEstimate, c),
        startedAt: normalizeNullableString(input.startedAt, c, "startedAt"),
    };
    return { value, warnings: c.warnings };
}

function normalizeRevisionsMap(input, c) {
    if (input === undefined || input === null) return c.defaulted("inputRevisions", {});
    if (!isPlainObject(input)) return c.degraded("inputRevisions", input, {});
    const out = {};
    for (const [key, entry] of Object.entries(input)) if (entry !== undefined && entry !== null && entry !== "") out[key] = String(entry);
    return out;
}

function normalizeToolSnapshot(input, c) {
    const fallback = { toolId: "", providerId: "", model: "" };
    if (input === undefined || input === null) return c.defaulted("toolSnapshot", fallback);
    if (!isPlainObject(input)) return c.degraded("toolSnapshot", input, fallback);
    return {
        toolId: typeof input.toolId === "string" ? input.toolId : "",
        providerId: typeof input.providerId === "string" ? input.providerId : "",
        model: typeof input.model === "string" ? input.model : "",
    };
}

function normalizeCostEstimate(input, c) {
    const fallback = { localGpuSec: 0, externalCredits: 0 };
    if (input === undefined || input === null) return c.defaulted("costEstimate", fallback);
    if (!isPlainObject(input)) return c.degraded("costEstimate", input, fallback);
    return {
        localGpuSec: normalizeNonNegativeNumber(input.localGpuSec, 0, "costEstimate.localGpuSec", c),
        externalCredits: normalizeNonNegativeNumber(input.externalCredits, 0, "costEstimate.externalCredits", c),
    };
}

/* ------------------------------------------------------------------ *
 * 7. RevisionRef / InputFingerprint / StaleStatus（§11.5.3）
 * ------------------------------------------------------------------ */

/** 规整输入 revision 引用；id 缺失即拒；type 缺省为空串。 */
export function normalizeRevisionRef(input) {
    if (!isPlainObject(input)) reject("RevisionRef 必须是对象", "RevisionRef");
    const id = asTrimmedString(input.id);
    if (!id) reject("RevisionRef 缺少 id", "id");
    const c = collector();
    const value = {
        type: input.type === undefined || input.type === null || input.type === "" ? c.defaulted("type", "") : String(input.type),
        id,
        revision: normalizeVersion(input.revision, c, "revision"),
    };
    return { value, warnings: c.warnings };
}

/** 稳定序列化：对象 key 排序、数组保序，保证同输入得同串。 */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (isPlainObject(value)) {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

/** 输入指纹（§11.5.3）：稳定序列化后取 sha256 hex；与 key 书写顺序无关。 */
export function computeInputFingerprint(input) {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/** 复用判定（§11.5.3）：指纹一致 + 产物 done + 已选产物，三者同时满足才可复用。 */
export function isReusable(output, input) {
    if (!isPlainObject(output)) return false;
    return output.inputFingerprint === computeInputFingerprint(input) && output.status === "done" && Boolean(output.selectedArtifactId);
}

/** 规整 stale 状态：未知值降级为 fresh 并告警（stale 只认字面 "stale"）。 */
export function normalizeStaleStatus(input) {
    const c = collector();
    if (input === undefined || input === null || input === "") return { value: c.defaulted("status", STALE_STATUS.FRESH), warnings: c.warnings };
    const raw = String(input);
    if (raw === STALE_STATUS.STALE || raw === STALE_STATUS.FRESH) return { value: raw, warnings: c.warnings };
    return { value: c.degraded("status", raw, STALE_STATUS.FRESH), warnings: c.warnings };
}


/* ------------------------------------------------------------------ *
 * 8. Shot 分集键归一（§3.1「episode 提为分区键」的接线段）
 * ------------------------------------------------------------------ */

/**
 * 从 id / 序数别名抽出 1-based 集号：ep_0001 / ep1 / EP-2 / 第1集 / "3" → 1/1/2/1/3；
 * 抽不出返回 null。**只认序号、不认标题**——避免把任意字符串误当集号，判不出就走别的手段。
 */
function episodeOrdinal(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    const cn = /第\s*(\d{1,4})\s*集/.exec(text);
    if (cn) return Number(cn[1]);
    const ep = /^ep[_\-\s]*(\d{1,4})$/i.exec(text);
    if (ep) return Number(ep[1]);
    if (/^\d{1,4}$/.test(text)) return Number(text);
    return null;
}

/** 宽松序号：只取**结尾的阿拉伯数字**，前缀任意（sc1 / sc_0001 / scene-3 / sh12 → 1/1/3/12）。
 *  仅用于「场次 id 的跨命名体系比对」（剧本 sc1 ≡ 项目 sc_0001）；抽不出返回 null。 */
function trailingOrdinal(value) {
    if (value === undefined || value === null) return null;
    const match = String(value).trim().match(/(\d{1,6})\s*$/);
    return match ? Number(match[1]) : null;
}

/**
 * 把 shots[].episodeId 归一到「真实集 id」，并把反向映射 episodes[].shotIds（sceneIds 缺失时补）回填。
 *
 * `episodes` 是**权威集列表**：调用方应传项目侧（ep_0001 这类）；未绑项目时传剧本侧（ep1）。
 * 返回 `{ shots, episodes, warnings }`，三者在内存里都是新对象（不改入参，符合本模块纯函数约定）。
 *
 * 逐镜归一优先级（兜底依据 = shot 在整段分镜里的**顺序 / index**）：
 *   ① shot.episodeId 精确命中权威集 id → 原样保留；
 *   ② shot.episodeId 是可识别的序号别名（ep1 / 第1集 / 1）→ 映射到该序号位的权威集（code:"remapped"）；
 *   ③ shot.sceneId 命中某集 sceneIds（精确，或按场次序号宽松匹配：sc1 ≡ sc_0001）→ 该集（code:"remapped"）；
 *   ④ 仍判不出 → 按 shot 顺位在集间**等比均分**兜底（code:"assigned"）：
 *        边界 = 各集容量（episode.shotCount 优先，否则 sceneIds.length，再否则 1）等比切分总镜头数。
 *        例：2 集、容量相同、17 镜 → 前 9 镜归第 1 集、后 8 镜归第 2 集（四舍五入到整镜）。
 *   ⑤ 没有任何权威集（episodes 为空）→ 保持 shot.episodeId 原样并逐镜产 warning（code:"unresolved"），
 *      **绝不静默丢弃**。
 */
export function normalizeShotEpisodeIds({ shots, episodes } = {}) {
    const shotList = Array.isArray(shots) ? shots : [];
    const warnings = [];
    const cleanShots = shotList.map((shot) => ({ ...asObject(shot) }));

    const epRows = (Array.isArray(episodes) ? episodes : []).filter(isPlainObject);
    if (!epRows.length) {
        for (const shot of cleanShots) {
            warnings.push({ field: "shots[].episodeId", code: "unresolved", shotId: String(shot.id ?? ""), got: shot.episodeId ?? null, message: "没有可用的集列表，shot.episodeId 无法判定，已保持原样（不静默丢弃）" });
        }
        return { shots: cleanShots, episodes: [], warnings };
    }

    const normalized = epRows.map((ep, position) => ({
        ...ep,
        id: asTrimmedString(ep.id) || `ep${position + 1}`,
        index: Number(ep.index) > 0 ? Math.floor(Number(ep.index)) : position + 1,
        sceneIds: (Array.isArray(ep.sceneIds) ? ep.sceneIds : []).map((item) => String(item)).filter((item) => item.trim() !== ""),
        shotIds: [],
    }));

    const byId = new Map(normalized.map((ep) => [ep.id, ep]));
    const byOrdinal = new Map();
    for (const ep of normalized) {
        const ordinal = episodeOrdinal(ep.id) ?? ep.index;
        if (Number.isInteger(ordinal) && ordinal > 0 && !byOrdinal.has(ordinal)) byOrdinal.set(ordinal, ep);
    }
    const sceneOwner = new Map();
    const sceneOrdinalOwners = new Map();
    for (const ep of normalized) {
        for (const sceneId of ep.sceneIds) {
            if (!sceneOwner.has(sceneId)) sceneOwner.set(sceneId, ep);
            const ordinal = trailingOrdinal(sceneId);
            if (!ordinal) continue;
            if (!sceneOrdinalOwners.has(ordinal)) sceneOrdinalOwners.set(ordinal, new Set());
            sceneOrdinalOwners.get(ordinal).add(ep.id);
        }
    }

    const resolveShot = (shot) => {
        const rawText = shot?.episodeId === undefined || shot?.episodeId === null ? "" : String(shot.episodeId).trim();
        if (rawText && byId.has(rawText)) return { id: rawText, via: "id" };
        if (rawText) {
            const ordinal = episodeOrdinal(rawText);
            if (ordinal && byOrdinal.has(ordinal)) return { id: byOrdinal.get(ordinal).id, via: "ordinal" };
        }
        const sceneId = shot?.sceneId === undefined || shot?.sceneId === null ? "" : String(shot.sceneId).trim();
        if (sceneId) {
            if (sceneOwner.has(sceneId)) return { id: sceneOwner.get(sceneId).id, via: "scene" };
            const owners = trailingOrdinal(sceneId) ? sceneOrdinalOwners.get(trailingOrdinal(sceneId)) : null;
            if (owners && owners.size === 1) return { id: [...owners][0], via: "scene-ordinal" };
        }
        return null;
    };

    const unresolvedPositions = [];
    cleanShots.forEach((shot, position) => {
        const hit = resolveShot(shot);
        if (!hit) {
            unresolvedPositions.push(position);
            return;
        }
        const rawText = shotList[position]?.episodeId === undefined || shotList[position]?.episodeId === null ? "" : String(shotList[position].episodeId).trim();
        shot.episodeId = hit.id;
        if (hit.via === "id") return;
        warnings.push({
            field: "shots[].episodeId",
            code: rawText ? "remapped" : "assigned",
            shotId: String(shot.id ?? ""),
            got: rawText || null,
            message: rawText ? `非权威集号 ${rawText} 已按序号归一为 ${hit.id}` : `缺集号，已按${hit.via === "scene" || hit.via === "scene-ordinal" ? "场次归属" : "序号"}补为 ${hit.id}`,
        });
    });

    if (unresolvedPositions.length) {
        const total = cleanShots.length;
        const capacities = normalized.map((ep) => (Number(ep.shotCount) > 0 ? Math.floor(Number(ep.shotCount)) : ep.sceneIds.length || 1));
        const totalCapacity = capacities.reduce((sum, value) => sum + value, 0) || normalized.length;
        let acc = 0;
        const bounds = capacities.map((capacity) => {
            acc += capacity;
            return Math.round((acc / totalCapacity) * total);
        });
        bounds[bounds.length - 1] = total;
        const episodeAt = (position) => {
            for (let index = 0; index < bounds.length; index += 1) if (position < bounds[index]) return normalized[index];
            return normalized[normalized.length - 1];
        };
        for (const position of unresolvedPositions) {
            const target = episodeAt(position);
            cleanShots[position].episodeId = target.id;
            warnings.push({ field: "shots[].episodeId", code: "assigned", shotId: String(cleanShots[position].id ?? ""), got: shotList[position]?.episodeId ?? null, message: `集号无法判定，已按镜头顺位均分兜底为 ${target.id}` });
        }
    }

    for (const shot of cleanShots) {
        const target = byId.get(String(shot.episodeId ?? ""));
        if (target && shot.id !== undefined && shot.id !== null && String(shot.id) !== "") target.shotIds.push(String(shot.id));
    }
    for (const ep of normalized) {
        if (ep.sceneIds.length) continue;
        const seen = [];
        for (const shot of cleanShots) {
            if (String(shot.episodeId) !== ep.id) continue;
            const sceneId = shot.sceneId === undefined || shot.sceneId === null ? "" : String(shot.sceneId).trim();
            if (sceneId && !seen.includes(sceneId)) seen.push(sceneId);
        }
        ep.sceneIds = seen;
    }

    return { shots: cleanShots, episodes: normalized, warnings };
}


/* ------------------------------------------------------------------ *
 * 9. Project 侧 ↔ Run 侧 shotId 映射（修 #51）
 *
 * 背景：Project 侧 Shot.id 是为「增删镜头后旧引用不失效」而由 (projectId, 分镜 shot id)
 * hash 派生的**稳定主键**（`sh_…`），诉求正确、不推翻；但它与运行侧一直在用的 shot id
 * （`sh1`/`sh2`…：storyboard.shots[].id、assembly.clips[].shotId）是两套完全不同的 id。
 * 投影层当初只造了稳定 id、没留下任何指回运行侧的东西 —— 断链由此产生，导出剪映素材包
 * 按 shotId 配对必然配不上。
 *
 * 本节只做**新增**：给 Project 侧 shot 落一个指回运行侧的字段 `runShotId`，并提供
 * 可查询的双向解析（projectShotId ⇄ runShotId）与存量回填所需的配对纯函数。
 * 命名冻结：`runShotId`（见 domain-contract.md §3.4 / §10.10）。
 * ------------------------------------------------------------------ */

/**
 * Project 侧 Shot 上「指回运行侧 shot id」的字段名（契约冻结）。
 * 运行侧 shot id = storyboard.shots[].id 与 assembly.clips[].shotId 所用的那套（如 `sh1`）。
 */
export const RUN_SHOT_ID_FIELD = "runShotId";

/** Project 侧 shot 的稳定主键（非空字符串化；缺则 ""）。 */
function projectShotIdOf(shot) {
    const id = shot?.id;
    return id === undefined || id === null || String(id).trim() === "" ? "" : String(id).trim();
}

/**
 * Project 侧 shot 上「指回运行侧」的值：优先冻结字段 `runShotId`，兼容别名 `sourceShotId`
 * （历史/外部导入可能用别的名字，但都以 `runShotId` 为准）。缺则 ""。
 */
function projectRunShotIdOf(shot) {
    const raw = shot?.[RUN_SHOT_ID_FIELD] ?? shot?.sourceShotId;
    return raw === undefined || raw === null || String(raw).trim() === "" ? "" : String(raw).trim();
}

const asMapKey = (value) => (value === undefined || value === null ? "" : String(value).trim());

/**
 * 纯函数：从 Project 侧 shots（带 `id` 与 `runShotId`）建立**双向**索引。
 * 返回 `{ byRunShotId, byProjectShotId, warnings }`（两个普通对象）：
 *   - `byRunShotId`: runShotId → projectShotId
 *   - `byProjectShotId`: projectShotId → runShotId
 * 缺 `runShotId` 的 shot 不进映射（无法指回运行侧）；同一 runShotId 指到多个 project shot
 * → 记一条 `{ code:"duplicate" }` warning 并保留先到者（不静默覆盖）。纯函数：不改入参。
 */
export function buildShotIdMap(shots = []) {
    const warnings = [];
    const byRunShotId = {};
    const byProjectShotId = {};
    for (const shot of Array.isArray(shots) ? shots : []) {
        if (!isPlainObject(shot)) continue;
        const projectShotId = projectShotIdOf(shot);
        const runShotId = projectRunShotIdOf(shot);
        if (!projectShotId || !runShotId) continue;
        if (byRunShotId[runShotId] && byRunShotId[runShotId] !== projectShotId) {
            warnings.push({ field: RUN_SHOT_ID_FIELD, code: "duplicate", runShotId, got: projectShotId, message: `runShotId ${runShotId} 同时指向 ${byRunShotId[runShotId]} 与 ${projectShotId}，保留先到者（不静默覆盖）` });
            continue;
        }
        byRunShotId[runShotId] = projectShotId;
        byProjectShotId[projectShotId] = runShotId;
    }
    return { byRunShotId, byProjectShotId, warnings };
}

const asShotIdMap = (mapOrShots) => (isPlainObject(mapOrShots) && mapOrShots.byRunShotId ? mapOrShots : buildShotIdMap(Array.isArray(mapOrShots) ? mapOrShots : mapOrShots?.shots));

/** 纯函数：runShotId → Project 侧稳定 shotId；查不到返回 null。`mapOrShots` 可传 buildShotIdMap 结果或 shots 列表。 */
export function resolveProjectShotId(mapOrShots, runShotId) {
    const map = asShotIdMap(mapOrShots);
    return map.byRunShotId[asMapKey(runShotId)] ?? null;
}

/** 纯函数：Project 侧 shotId → runShotId；查不到返回 null。`mapOrShots` 可传 buildShotIdMap 结果或 shots 列表。 */
export function resolveRunShotId(mapOrShots, projectShotId) {
    const map = asShotIdMap(mapOrShots);
    return map.byProjectShotId[asMapKey(projectShotId)] ?? null;
}

/** 把 shots 列表按 episodeId 分组（保留出现顺序）；无集号的归到 "" 组。 */
function groupShotsByEpisode(shots) {
    const groups = new Map();
    for (const shot of shots) {
        const key = String(shot?.episodeId ?? "").trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(shot);
    }
    return groups;
}

/**
 * 纯函数：把 Project 侧 shot 与 Run 侧 shot 配对（**存量回填 runShotId 与导出按映射归属的唯一依据**）。
 *
 * 配对依据（按优先级，先到先得；同一个 run shot / 同一个 project shot 只配一次）：
 *   ① `stored`：Project shot 已带 runShotId，且该 runShotId 在 run shots 里存在；
 *   ② `index`：两侧全局 `index` 相同（且该 index 在运行侧唯一）；
 *   ③ `order`：同一 `episodeId` 内按出现顺序对位（第 k 个 ↔ 第 k 个）。
 * 配不上的**两侧都显式列出**（`unmatchedProject` / `unmatchedRun`），绝不静默丢弃。
 * 纯函数：不改入参，返回新对象。
 *
 * @returns {{pairs: Array, byProjectShotId: Object, byRunShotId: Object, unmatchedProject: Array, unmatchedRun: Array, warnings: Array}}
 */
export function matchProjectShotsToRunShots({ projectShots = [], runShots = [] } = {}) {
    const pShots = (Array.isArray(projectShots) ? projectShots : []).filter(isPlainObject);
    const rShots = (Array.isArray(runShots) ? runShots : []).filter(isPlainObject);
    const warnings = [];
    const pairs = [];
    const usedProject = new Set();
    const usedRun = new Set();

    const runIdSet = new Set();
    for (const shot of rShots) {
        const id = projectShotIdOf(shot);
        if (id) runIdSet.add(id);
    }

    const pair = (projectShot, runShotId, via) => {
        const projectShotId = projectShotIdOf(projectShot);
        if (!projectShotId || !runShotId || usedProject.has(projectShotId) || usedRun.has(runShotId)) return false;
        usedProject.add(projectShotId);
        usedRun.add(runShotId);
        pairs.push({ projectShotId, runShotId, via });
        return true;
    };

    // ① stored：已落地的 runShotId 优先（幂等前提：再次运行结果不变）
    for (const shot of pShots) {
        const runShotId = projectRunShotIdOf(shot);
        if (!runShotId) continue;
        if (runIdSet.has(runShotId)) pair(shot, runShotId, "stored");
        else warnings.push({ field: RUN_SHOT_ID_FIELD, code: "dangling", projectShotId: projectShotIdOf(shot), got: runShotId, message: `Project shot ${projectShotIdOf(shot)} 的 runShotId ${runShotId} 在运行侧不存在` });
    }

    // ② index：全局镜序相同（运行侧该 index 唯一时才算数）
    const runByIndex = new Map();
    const duplicateIndex = new Set();
    for (const shot of rShots) {
        const index = Number(shot?.index);
        if (!Number.isFinite(index) || index <= 0) continue;
        if (runByIndex.has(index)) duplicateIndex.add(index);
        else runByIndex.set(index, shot);
    }
    for (const shot of pShots) {
        if (usedProject.has(projectShotIdOf(shot))) continue;
        const index = Number(shot?.index);
        if (!Number.isFinite(index) || index <= 0 || duplicateIndex.has(index)) continue;
        const candidate = runByIndex.get(index);
        if (!candidate) continue;
        pair(shot, projectShotIdOf(candidate), "index");
    }

    // ③ order：同集内按出现顺序对位
    const runGroups = groupShotsByEpisode(rShots);
    const projectGroups = groupShotsByEpisode(pShots);
    for (const [episodeId, projectList] of projectGroups) {
        if (!episodeId) continue;
        const candidates = (runGroups.get(episodeId) || []).filter((shot) => !usedRun.has(projectShotIdOf(shot)));
        const targets = projectList.filter((shot) => !usedProject.has(projectShotIdOf(shot)));
        targets.forEach((shot, position) => {
            const candidate = candidates[position];
            if (candidate) pair(shot, projectShotIdOf(candidate), "order");
        });
    }

    const unmatchedProject = pShots
        .filter((shot) => !usedProject.has(projectShotIdOf(shot)))
        .map((shot) => ({ projectShotId: projectShotIdOf(shot), episodeId: String(shot?.episodeId ?? "").trim(), index: Number(shot?.index) > 0 ? Number(shot.index) : null, reason: "运行侧无对应 shot" }));
    const unmatchedRun = rShots
        .filter((shot) => !usedRun.has(projectShotIdOf(shot)))
        .map((shot) => ({ runShotId: projectShotIdOf(shot), episodeId: String(shot?.episodeId ?? "").trim(), index: Number(shot?.index) > 0 ? Number(shot.index) : null, reason: "Project 侧无对应 shot" }));

    const byProjectShotId = {};
    const byRunShotId = {};
    for (const item of pairs) {
        byProjectShotId[item.projectShotId] = item.runShotId;
        byRunShotId[item.runShotId] = item.projectShotId;
    }

    return { pairs, byProjectShotId, byRunShotId, unmatchedProject, unmatchedRun, warnings };
}

/**
 * 纯函数：把 `runShotId` 回填进 Project 侧 shots（幂等；用 matchProjectShotsToRunShots 得配对）。
 * 返回 `{ shots, changed, mapping, unmatchedProject, unmatchedRun, warnings }`；`shots` 是新数组、
 * 每个被改动的 shot 是新对象（不改入参）。已带正确 runShotId 的 shot 逐字保留（重复运行结果不变）。
 *
 * @param {{episodes?: Array, runShots?: Array, projectShots?: Array}} [input]
 */
export function backfillProjectShotRunIds({ episodes = [], projectShots = null, runShots = [] } = {}) {
    const sourceShots = Array.isArray(projectShots)
        ? projectShots
        : (Array.isArray(episodes) ? episodes : []).flatMap((episode) => (Array.isArray(episode?.shots) ? episode.shots.map((shot) => ({ ...asObject(shot), episodeId: asObject(shot).episodeId ?? episode?.id })) : []));
    const matching = matchProjectShotsToRunShots({ projectShots: sourceShots, runShots });
    let changed = false;
    const shots = sourceShots.map((shot) => {
        const projectShotId = projectShotIdOf(shot);
        const runShotId = projectShotId ? matching.byProjectShotId[projectShotId] : null;
        if (!runShotId || projectRunShotIdOf(shot) === runShotId) return shot;
        changed = true;
        return { ...shot, [RUN_SHOT_ID_FIELD]: runShotId };
    });
    return { shots, changed, mapping: { byProjectShotId: matching.byProjectShotId, byRunShotId: matching.byRunShotId }, unmatchedProject: matching.unmatchedProject, unmatchedRun: matching.unmatchedRun, warnings: matching.warnings };
}


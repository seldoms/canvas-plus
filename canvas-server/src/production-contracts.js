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
        episodeDurationSec: normalizePositiveNumber(body.episodeDurationSec, 60, "episodeDurationSec", c),
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

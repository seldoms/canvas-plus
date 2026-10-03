/**
 * 制作圣经与确认锁（P0-f）——纯函数：五类实体规整/校验 + `draft → review → approved → locked`
 * 确认锁状态机 + revision 语义。
 *
 * 零依赖（仅复用同目录 `contracts.js` 的冻结枚举与 `production-contracts.js` 的 ProjectBrief 内核规整）、
 * 零 IO、零副作用；本波只落地契约，不被任何流水线模块 import（不接线）。
 *
 * 契约文本：docs/content/docs/progress/development-plan.md §13.1（立项与制作规格）、§13.2（内容开发与“圣经”）、
 *           §11.5.2（角色三视图/场景资产）、§11.5.4（关键帧一致性）、§8 P0-f「制作圣经与确认锁」。
 * 冻结枚举：canvas-server/src/contracts.js（VISUAL_MODE / AUDIO_MODE / PRODUCTION_ID_PREFIX）。
 *
 * 与 `production-contracts.js` 的差别（重要）：
 *   - 那一层的规整函数在**结构性非法**（缺稳定身份、枚举无安全默认）时**抛错**（`.status=400`），供路由层直接回 400；
 *   - 本层是「圣经」持久化实体，规整函数**永不抛异常**：非法值一律被拒（丢弃/置空）或降级（回落安全默认），
 *     并以 `warnings[]` 逐条登记，调用方自行决定是否阻断。
 *
 * 规整函数统一签名：`normalizeX(input) -> { value, warnings }`
 *   - 缺字段 → 安全默认，记 `{ field, code: "defaulted" }`；
 *   - 非法值 → 降级到安全默认，记 `{ field, code: "degraded", got }`；
 *   - 非法值且无安全默认 → 丢弃该值，记 `{ field, code: "rejected", got }`；
 *   - 必填身份缺失 → 置空并记 `{ field, code: "required" }`（实体仍返回，由门禁判定不可消费）。
 *
 * revision 语义：任何对**已锁定**对象的修改都必须产生**新 revision**，绝不静默覆盖旧结果
 * （`bumpRevision` / `mergeBiblePatch`）。
 *
 * @typedef {Object} ProjectBrief 立项与制作规格（§13.1）
 * @typedef {Object} SeriesBible 剧级主线（§13.2）
 * @typedef {Object} CharacterBible 角色圣经（§13.2 / §11.5.2）
 * @typedef {Object} WorldBible 场景/世界圣经（§13.2）
 * @typedef {Object} AudioBible 声音圣经（§13.2 / §11.5.1）
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeProjectBrief as normalizeBriefSpec } from "./production-contracts.js";
import { ensureDir, safeJoin } from "./files.js";

/* ------------------------------------------------------------------ *
 * 本地冻结枚举（contracts.js 冻结后不再追加，此处为本模块私有取值域）
 * ------------------------------------------------------------------ */

/** 确认锁状态机（P0-f）。 */
export const BIBLE_STATE = Object.freeze({
    DRAFT: "draft",
    REVIEW: "review",
    APPROVED: "approved",
    LOCKED: "locked",
});

/** 状态机顺序（仅用于文档/提示，迁移合法性以 TRANSITIONS 为准）。 */
export const BIBLE_STATES = Object.freeze([BIBLE_STATE.DRAFT, BIBLE_STATE.REVIEW, BIBLE_STATE.APPROVED, BIBLE_STATE.LOCKED]);

/** WorldBible.dayNightVersions 取值域（§13.2：昼夜版本）。 */
export const DAY_NIGHT = Object.freeze({
    DAY: "day",
    NIGHT: "night",
    DAWN: "dawn",
    DUSK: "dusk",
});

/** WorldBible.weatherVersions 取值域（§13.2：天气版本）。 */
export const WEATHER = Object.freeze({
    CLEAR: "clear",
    RAIN: "rain",
    SNOW: "snow",
    FOG: "fog",
    OVERCAST: "overcast",
    WIND: "wind",
});

const VALID_DAY_NIGHT = new Set(Object.values(DAY_NIGHT));
const VALID_WEATHER = new Set(Object.values(WEATHER));

/* ------------------------------------------------------------------ *
 * 基础工具（风格对齐 production-contracts.js，但本层不抛异常）
 * ------------------------------------------------------------------ */

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asObject = (value) => (isPlainObject(value) ? value : {});
const asTrimmedString = (value) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim());

/** 收集规整过程中 defaulted / degraded / rejected / required 警告，返回 `{ value, warnings }` 的公共载体。 */
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
        rejected(field, got, fallback = undefined) {
            warnings.push({ field, code: "rejected", got, message: `${field} 非法值已丢弃` });
            return fallback;
        },
        required(field, fallback = "") {
            warnings.push({ field, code: "required", message: `缺少必填身份 ${field}` });
            return fallback;
        },
    };
}

/** 整份输入非对象时的统一处理：降级为 `{}` 并告警（不抛异常）。 */
function requireObject(input, name, c) {
    if (input === undefined || input === null) return c.defaulted(name, {});
    if (!isPlainObject(input)) return c.degraded(name, input, {});
    return input;
}

function normalizeString(input, fallback, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, fallback);
    if (typeof input !== "string") return c.degraded(field, input, fallback);
    const text = input.trim();
    return text === "" ? c.defaulted(field, fallback) : text;
}

/** null 语义字符串：缺省 → null + 告警；显式 null/"" → null（不告警）；非字符串 → 降级 null。 */
function normalizeNullableString(input, c, field) {
    if (input === undefined) return c.defaulted(field, null);
    if (input === null || input === "") return null;
    if (typeof input !== "string") return c.degraded(field, input, null);
    return input;
}

function normalizeStringArray(input, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, []);
    if (!Array.isArray(input)) return c.degraded(field, input, []);
    const out = [];
    for (const item of input) {
        const text = typeof item === "string" ? item.trim() : String(item).trim();
        if (text !== "") out.push(text);
    }
    return out;
}

/** 枚举数组：合法项保留，非法项**被拒**（丢弃）并逐条告警——用于昼夜/天气等有限取值域。 */
function normalizeEnumArray(input, allowed, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, []);
    if (!Array.isArray(input)) return c.degraded(field, input, []);
    const out = [];
    for (const item of input) {
        const raw = typeof item === "string" ? item.trim() : String(item).trim();
        if (allowed.has(raw)) out.push(raw);
        else c.rejected(`${field}[]`, item, undefined);
    }
    return out;
}

function normalizeRevision(input, c, field = "revision") {
    if (input === undefined || input === null) return c.defaulted(field, 1);
    const num = Number(input);
    if (!Number.isInteger(num) || num < 1) return c.degraded(field, input, 1);
    return num;
}

/** 确认锁状态字段：未知值降级为 draft（`rejected` 无意义，draft 是安全默认）。 */
function normalizeStateField(input, c, field = "status") {
    if (input === undefined || input === null || input === "") return c.defaulted(field, BIBLE_STATE.DRAFT);
    const raw = String(input).trim();
    return BIBLE_STATES.includes(raw) ? raw : c.degraded(field, input, BIBLE_STATE.DRAFT);
}

function normalizePositiveInt(input, fallback, field, c) {
    if (input === undefined || input === null) return c.defaulted(field, fallback);
    const num = Number(input);
    if (!Number.isFinite(num) || num <= 0) return c.degraded(field, input, fallback);
    return Math.floor(num);
}

/* ------------------------------------------------------------------ *
 * 1. ProjectBrief（§13.1）——复用 production-contracts 的内核规整，再叠加圣经级字段
 * ------------------------------------------------------------------ */

/**
 * 规整立项与制作规格。共享字段（市场/语言/平台/集数时长/画幅音频模式/交付/预算/授权/版本）
 * 直接复用 `production-contracts.js` 的内核规整，避免重复实现；本层额外补 题材/基调/受众。
 * 永不抛异常：整份输入非对象时降级为 `{}`。
 */
export function normalizeProjectBrief(input) {
    const c = collector();
    if (input !== undefined && input !== null && !isPlainObject(input)) c.degraded("ProjectBrief", input, {});
    const body = asObject(input);

    const genre = normalizeStringArray(body.genre, "genre", c);
    const tone = normalizeStringArray(body.tone, "tone", c);
    const audience = normalizeStringArray(body.audience, "audience", c);

    const core = normalizeBriefSpec(body);
    const value = { genre, tone, audience, ...core.value };
    return { value, warnings: [...c.warnings, ...core.warnings] };
}

/* ------------------------------------------------------------------ *
 * 2. SeriesBible（§13.2：剧级主线）
 * ------------------------------------------------------------------ */

/** 集数骨架条目：index 默认按出现顺序、title/logline 缺省为空串。 */
function normalizeEpisodeSkeleton(input, c, field) {
    if (input === undefined || input === null) return c.defaulted(field, []);
    if (!Array.isArray(input)) return c.degraded(field, input, []);
    return input.map((entry, i) => {
        const row = isPlainObject(entry) ? entry : {};
        if (!isPlainObject(entry)) c.degraded(`${field}[${i}]`, entry, {});
        return {
            index: normalizePositiveInt(row.index, i + 1, `${field}[${i}].index`, c),
            title: typeof row.title === "string" ? row.title.trim() : "",
            logline: typeof row.logline === "string" ? row.logline.trim() : "",
        };
    });
}

/** 人物关系条目：from/to 缺失置空，kind 缺省为空串。 */
function normalizeRelationships(input, c, field) {
    if (input === undefined || input === null) return c.defaulted(field, []);
    if (!Array.isArray(input)) return c.degraded(field, input, []);
    return input.map((entry, i) => {
        const row = isPlainObject(entry) ? entry : {};
        if (!isPlainObject(entry)) c.degraded(`${field}[${i}]`, entry, {});
        return {
            from: asTrimmedString(row.from),
            to: asTrimmedString(row.to),
            kind: typeof row.kind === "string" ? row.kind.trim() : "",
        };
    });
}

/** 规整剧级主线圣经：世界观/主线/主题/集数骨架/风格锚点/不可改变事实/人物关系 + revision。 */
export function normalizeSeriesBible(input) {
    const c = collector();
    const body = requireObject(input, "SeriesBible", c);

    const id = asTrimmedString(body.id);
    const value = {
        id: id || c.required("id", ""),
        logline: normalizeString(body.logline, "", "logline", c),
        theme: normalizeString(body.theme, "", "theme", c),
        worldview: normalizeString(body.worldview, "", "worldview", c),
        timeline: normalizeStringArray(body.timeline, "timeline", c),
        narrativeRules: normalizeStringArray(body.narrativeRules, "narrativeRules", c),
        immutableFacts: normalizeStringArray(body.immutableFacts, "immutableFacts", c),
        styleAnchors: normalizeStringArray(body.styleAnchors, "styleAnchors", c),
        characterIds: normalizeStringArray(body.characterIds, "characterIds", c),
        locationIds: normalizeStringArray(body.locationIds, "locationIds", c),
        episodeSkeleton: normalizeEpisodeSkeleton(body.episodeSkeleton, c, "episodeSkeleton"),
        relationships: normalizeRelationships(body.relationships, c, "relationships"),
        status: normalizeStateField(body.status, c),
        revision: normalizeRevision(body.revision, c),
    };
    return { value, warnings: c.warnings };
}

/* ------------------------------------------------------------------ *
 * 3. CharacterBible（§13.2 / §11.5.2：角色）
 * ------------------------------------------------------------------ */

/** 服装版本条目（§13.2：服装版本；§11.5.2：同角色多套服装各自的 revision）。 */
function normalizeCostumes(input, c, field) {
    if (input === undefined || input === null) return c.defaulted(field, []);
    if (!Array.isArray(input)) return c.degraded(field, input, []);
    return input.map((entry, i) => {
        const row = isPlainObject(entry) ? entry : {};
        if (!isPlainObject(entry)) c.degraded(`${field}[${i}]`, entry, {});
        return {
            name: typeof row.name === "string" ? row.name.trim() : "",
            revision: normalizeRevision(row.revision, c, `${field}[${i}].revision`),
            artifactIds: normalizeStringArray(row.artifactIds, `${field}[${i}].artifactIds`, c),
        };
    });
}

/** 表演边界：allowed / forbidden 两组约束（§13.2：表演边界）。 */
function normalizePerformanceBounds(input, c, field) {
    const fallback = { allowed: [], forbidden: [] };
    if (input === undefined || input === null) return c.defaulted(field, fallback);
    if (!isPlainObject(input)) return c.degraded(field, input, fallback);
    return {
        allowed: normalizeStringArray(input.allowed, `${field}.allowed`, c),
        forbidden: normalizeStringArray(input.forbidden, `${field}.forbidden`, c),
    };
}

/**
 * 规整角色圣经：身份/外观/三视图与特写引用/服装版本/表演边界/音色与语言习惯 + revision。
 * `voiceProfileId` 引用 §11.5.1 的 VoiceProfile，本层只存引用 id。
 */
export function normalizeCharacterBible(input) {
    const c = collector();
    const body = requireObject(input, "CharacterBible", c);

    const id = asTrimmedString(body.id);
    const value = {
        id: id || c.required("id", ""),
        name: normalizeString(body.name, "", "name", c),
        identity: normalizeString(body.identity, "", "identity", c),
        appearance: normalizeString(body.appearance, "", "appearance", c),
        turnaroundArtifactIds: normalizeStringArray(body.turnaroundArtifactIds, "turnaroundArtifactIds", c),
        closeupArtifactIds: normalizeStringArray(body.closeupArtifactIds, "closeupArtifactIds", c),
        costumes: normalizeCostumes(body.costumes, c, "costumes"),
        performanceBounds: normalizePerformanceBounds(body.performanceBounds, c, "performanceBounds"),
        voiceProfileId: normalizeNullableString(body.voiceProfileId, c, "voiceProfileId"),
        language: normalizeString(body.language, "zh-CN", "language", c),
        speechHabits: normalizeStringArray(body.speechHabits, "speechHabits", c),
        status: normalizeStateField(body.status, c),
        revision: normalizeRevision(body.revision, c),
    };
    return { value, warnings: c.warnings };
}

/* ------------------------------------------------------------------ *
 * 4. WorldBible（§13.2：场景/世界）
 * ------------------------------------------------------------------ */

/**
 * 规整场景/世界圣经：空场母版引用/平面关系/关键视角/昼夜与天气版本/固定光源方向 + revision。
 * 昼夜与天气为受限取值域：非法项**被拒**（丢弃），合法项保留。
 */
export function normalizeWorldBible(input) {
    const c = collector();
    const body = requireObject(input, "WorldBible", c);

    const id = asTrimmedString(body.id);
    const value = {
        id: id || c.required("id", ""),
        name: normalizeString(body.name, "", "name", c),
        era: normalizeString(body.era, "", "era", c),
        sceneMasterArtifactId: normalizeNullableString(body.sceneMasterArtifactId, c, "sceneMasterArtifactId"),
        floorPlanArtifactId: normalizeNullableString(body.floorPlanArtifactId, c, "floorPlanArtifactId"),
        keyViewArtifactIds: normalizeStringArray(body.keyViewArtifactIds, "keyViewArtifactIds", c),
        dayNightVersions: normalizeEnumArray(body.dayNightVersions, VALID_DAY_NIGHT, "dayNightVersions", c),
        weatherVersions: normalizeEnumArray(body.weatherVersions, VALID_WEATHER, "weatherVersions", c),
        lightDirection: normalizeString(body.lightDirection, "", "lightDirection", c),
        allowedProps: normalizeStringArray(body.allowedProps, "allowedProps", c),
        forbiddenProps: normalizeStringArray(body.forbiddenProps, "forbiddenProps", c),
        status: normalizeStateField(body.status, c),
        revision: normalizeRevision(body.revision, c),
    };
    return { value, warnings: c.warnings };
}

/* ------------------------------------------------------------------ *
 * 5. AudioBible（§13.2 / §11.5.1：声音）
 * ------------------------------------------------------------------ */

/**
 * 规整声音圣经：角色 VoiceProfile 引用/语言/发音/情绪范围/BGM 方向/环境声/禁用声音 + revision。
 * 只存 VoiceProfile 的 id 引用，不复制音色定义。
 */
export function normalizeAudioBible(input) {
    const c = collector();
    const body = requireObject(input, "AudioBible", c);

    const id = asTrimmedString(body.id);
    const value = {
        id: id || c.required("id", ""),
        voiceProfileIds: normalizeStringArray(body.voiceProfileIds, "voiceProfileIds", c),
        language: normalizeString(body.language, "zh-CN", "language", c),
        pronunciationNotes: normalizeStringArray(body.pronunciationNotes, "pronunciationNotes", c),
        emotionRange: normalizeStringArray(body.emotionRange, "emotionRange", c),
        bgmDirection: normalizeString(body.bgmDirection, "", "bgmDirection", c),
        ambience: normalizeStringArray(body.ambience, "ambience", c),
        forbiddenSounds: normalizeStringArray(body.forbiddenSounds, "forbiddenSounds", c),
        status: normalizeStateField(body.status, c),
        revision: normalizeRevision(body.revision, c),
    };
    return { value, warnings: c.warnings };
}

/* ------------------------------------------------------------------ *
 * 6. 确认锁状态机：draft → review → approved → locked
 * ------------------------------------------------------------------ */

/**
 * 迁移表（P0-f）：`state → action → { next, revisionBump }`。
 * - 回退（approved.reopen、locked.revise）**必须产生新 revision**，不静默覆盖旧结果。
 * - draft 直达 locked、review 直达 locked、locked 再 submit_review 等均为非法。
 */
const TRANSITIONS = Object.freeze({
    [BIBLE_STATE.DRAFT]: Object.freeze({
        submit_review: Object.freeze({ next: BIBLE_STATE.REVIEW, revisionBump: false }),
    }),
    [BIBLE_STATE.REVIEW]: Object.freeze({
        approve: Object.freeze({ next: BIBLE_STATE.APPROVED, revisionBump: false }),
        reject: Object.freeze({ next: BIBLE_STATE.DRAFT, revisionBump: false }),
    }),
    [BIBLE_STATE.APPROVED]: Object.freeze({
        lock: Object.freeze({ next: BIBLE_STATE.LOCKED, revisionBump: false }),
        reopen: Object.freeze({ next: BIBLE_STATE.DRAFT, revisionBump: true }),
    }),
    [BIBLE_STATE.LOCKED]: Object.freeze({
        revise: Object.freeze({ next: BIBLE_STATE.DRAFT, revisionBump: true }),
    }),
});

/** 常见非法迁移的可读补充说明。 */
const REJECT_HINTS = Object.freeze({
    "draft:lock": "须先 submit_review 到 review，再 approve 到 approved",
    "draft:approve": "须先 submit_review 到 review",
    "draft:reject": "draft 无待审内容，无需 reject",
    "draft:reopen": "draft 已是编辑态，无需 reopen",
    "draft:revise": "draft 未锁定，直接编辑即可",
    "review:lock": "须先 approve 到 approved",
    "review:submit_review": "review 已提交，待 approve 或 reject",
    "review:reopen": "review 尚未批准，用 reject 回退",
    "approved:submit_review": "approved 已批准，用 lock 锁定或 reopen 回退",
    "approved:approve": "approved 已批准，无需重复审批",
    "approved:revise": "approved 未锁定，用 reopen 回退",
    "locked:submit_review": "已锁定对象须用 revise 产生新 revision，不能直接改状态",
    "locked:approve": "已锁定对象不可再审批",
    "locked:lock": "已锁定，无需重复锁定",
    "locked:reopen": "已锁定对象须用 revise 产生新 revision",
});

const stateOf = (value) => (isPlainObject(value) ? value.status : value);

/**
 * 执行一次确认锁迁移，纯函数。
 * @param {string|Object} current 当前状态（字符串，或带 `.status` 的对象）
 * @param {string} action 动作（submit_review / approve / reject / lock / reopen / revise）
 * @param {string} [actor] 操作人（记录用；缺省归一为 "system"）
 * @returns {{ ok: boolean, next: string|null, reason: string|null, revisionBump: boolean, actor: string }}
 *   成功时 `next` 为目标状态、`reason` 为 null；失败时 `next` 为 null、`reason` 为可读原因。
 */
export function transition(current, action, actor) {
    const from = stateOf(current);
    const who = asTrimmedString(actor) || "system";

    if (typeof from !== "string" || !Object.prototype.hasOwnProperty.call(TRANSITIONS, from)) {
        return { ok: false, next: null, reason: `未知确认锁状态：${from === undefined || from === null || from === "" ? "(空)" : from}（可选：${BIBLE_STATES.join(" / ")}）`, revisionBump: false, actor: who };
    }

    const table = TRANSITIONS[from];
    const rule = typeof action === "string" ? table[action] : undefined;
    if (!rule) {
        const allowed = Object.keys(table);
        const hint = REJECT_HINTS[`${from}:${action}`];
        const reason = `非法迁移：${from} 不允许动作「${action}」；${from} 可用动作：${allowed.join(", ") || "(无)"}${hint ? `（${hint}）` : ""}`;
        return { ok: false, next: null, reason, revisionBump: false, actor: who };
    }

    return { ok: true, next: rule.next, reason: null, revisionBump: rule.revisionBump, actor: who };
}

/** 下游可消费判定：只有 `approved` / `locked` 才算已批准版本。 */
export function isConsumable(state) {
    const value = stateOf(state);
    return value === BIBLE_STATE.APPROVED || value === BIBLE_STATE.LOCKED;
}

/**
 * 产生新 revision 的**新对象**（不改原对象）：revision+1、状态回到 `draft`（任何修改都需重新审批）。
 * @param {Object} state 至少含 `{ revision, status }` 的实体（或任意带 revision 的对象）
 * @param {string} [changedBy] 修改人；缺省归一为 "system"
 * @returns {Object} 新对象，携带 `previousRevision` / `changedBy`，原对象保持不变。
 */
export function bumpRevision(state, changedBy) {
    const src = asObject(state);
    const c = collector();
    const current = normalizeRevision(src.revision, c, "revision");
    return {
        ...src,
        revision: current + 1,
        status: BIBLE_STATE.DRAFT,
        previousRevision: current,
        changedBy: asTrimmedString(changedBy) || "system",
    };
}

/* ------------------------------------------------------------------ *
 * 7. 幂等合并：mergeBiblePatch
 * ------------------------------------------------------------------ */

function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => deepEqual(item, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) return false;
        return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
    }
    return false;
}

/** 深度合并：仅当值实际变化才替换；数组整体替换（不拼接），保证幂等；不修改入参。 */
function deepMergeInto(target, patch) {
    const out = Array.isArray(target) ? target.slice() : { ...asObject(target) };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const current = isPlainObject(target) ? target[key] : undefined;
        if (isPlainObject(current) && isPlainObject(value)) {
            const nested = deepMergeInto(current, value);
            if (nested.changed) {
                out[key] = nested.value;
                changed = true;
            }
        } else if (!deepEqual(current, value)) {
            out[key] = value;
            changed = true;
        }
    }
    return { value: out, changed };
}

/**
 * 幂等合并 patch 到 bible。
 * - 未变字段不动；重复应用同一 patch 不再产生变化（幂等）。
 * - **已锁对象**（`status === "locked"`）发生实际改动时**不直接覆盖**：原对象原样返回，
 *   返回 `{ requiresNewRevision: true, revision: current + 1 }`，由调用方显式派生新 revision。
 * - 非锁定对象：返回合并结果，`requiresNewRevision: false`。
 * @returns {{ bible: Object, requiresNewRevision: boolean, revision: number, changed: boolean }}
 */
export function mergeBiblePatch(bible, patch) {
    const base = asObject(bible);
    const incoming = asObject(patch);
    const currentRevision = normalizeRevision(base.revision, collector(), "revision");
    const locked = base.status === BIBLE_STATE.LOCKED;

    const { value: merged, changed } = deepMergeInto(base, incoming);

    if (!changed) return { bible: base, requiresNewRevision: false, revision: currentRevision, changed: false };
    if (locked) return { bible: base, requiresNewRevision: true, revision: currentRevision + 1, changed: true };
    return { bible: merged, requiresNewRevision: false, revision: normalizeRevision(merged.revision, collector(), "revision"), changed: true };
}

/* ------------------------------------------------------------------ *
 * 8. 接线（P0-f）：圣经实体的项目级持久化 + 门禁映射
 * ------------------------------------------------------------------ *
 * 本段为**新增**（不改上面既有导出/语义）：把已交付的纯函数圣经落成项目里的持久化实体，
 * 供 index.js 路由与 gates.js 门禁消费，兑现验收句「下游只消费已批准版本；改已锁对象产生新 revision」。
 *
 * 存储布局（与 sources.js 同风格「一实体一目录」，但独立于 projects.js，不改其内核）：
 *   data/projects/<pid>/bibles/<bibleId>.json          活动项目
 *   data/projects-archive/<pid>/bibles/<bibleId>.json  归档项目
 *
 * revision 语义（比 mergeBiblePatch 更严的落地口径，验收要求）：
 *   - draft / review 就地在当前 revision 上合并；
 *   - **approved / locked（下游可消费版本）发生实际改动 → 派生新 revision**（status 回 draft），
 *     旧版本快照进 `history[]`，绝不静默覆盖旧结果。
 * - 幂等：patch 归一后与现状逐字相同则跳过（不写盘）。
 * ------------------------------------------------------------------ */

/** 圣经实体类别（domain-contract.md §10.9）。 */
export const BIBLE_KIND = Object.freeze({
    PROJECT_BRIEF: "project_brief",
    SERIES: "series",
    CHARACTER: "character",
    WORLD: "world",
    AUDIO: "audio",
});

/**
 * 类别 → 门禁阶段：项目**存在**该类别实体时，对应阶段必须等实体 `approved`/`locked` 才 ready。
 * 阶段 ID 取自 gates.js 的权威命名（plan / script / design / post）。
 * ⚠️ 项目**没有**该实体时不产生任何约束（向后兼容：旧项目门禁行为逐字不变）。
 */
export const BIBLE_KIND_STAGE = Object.freeze({
    [BIBLE_KIND.PROJECT_BRIEF]: "plan",
    [BIBLE_KIND.SERIES]: "script",
    [BIBLE_KIND.CHARACTER]: "design",
    [BIBLE_KIND.WORLD]: "design",
    [BIBLE_KIND.AUDIO]: "post",
});

/** 类别可读名（门禁原因 / 错误信息用）。 */
export const BIBLE_KIND_LABEL = Object.freeze({
    [BIBLE_KIND.PROJECT_BRIEF]: "立项规格（ProjectBrief）",
    [BIBLE_KIND.SERIES]: "剧级主线（SeriesBible）",
    [BIBLE_KIND.CHARACTER]: "角色圣经（CharacterBible）",
    [BIBLE_KIND.WORLD]: "场景/世界圣经（WorldBible）",
    [BIBLE_KIND.AUDIO]: "声音圣经（AudioBible）",
});

const BIBLE_NORMALIZERS = Object.freeze({
    [BIBLE_KIND.PROJECT_BRIEF]: normalizeProjectBrief,
    [BIBLE_KIND.SERIES]: normalizeSeriesBible,
    [BIBLE_KIND.CHARACTER]: normalizeCharacterBible,
    [BIBLE_KIND.WORLD]: normalizeWorldBible,
    [BIBLE_KIND.AUDIO]: normalizeAudioBible,
});

/** 合法类别判定（路由层回 400 用）。 */
export function isBibleKind(kind) {
    return Object.prototype.hasOwnProperty.call(BIBLE_NORMALIZERS, String(kind ?? "").trim());
}

/**
 * 按类别分派规整；`kind` 并入 value。未知类别返回 `{ value: null, warnings:[...] }`（不抛）。
 * @returns {{ value: Object|null, warnings: Array }}
 */
export function normalizeBible(kind, input) {
    const key = String(kind ?? "").trim();
    const fn = BIBLE_NORMALIZERS[key];
    if (!fn) return { value: null, warnings: [{ field: "kind", code: "rejected", got: kind, message: `未知圣经类别：${kind || "(空)"}` }] };
    const { value, warnings } = fn(input);
    return { value: { kind: key, ...value }, warnings };
}

/**
 * 圣经实体项目级持久化内核（P0-f 接线）。
 * 自带最小 IO（零外部依赖），不去碰 projects.js 内核 —— 路由在 index.js 层组合。
 * @param {{ dataDir: string, ulid: () => string, nowIso?: () => string }} deps
 * @returns {{ list, get, create, update, transition }}
 */
export function createBibleStore({ dataDir, ulid, nowIso = () => new Date().toISOString() } = {}) {
    const activeProjects = join(String(dataDir ?? ""), "projects");
    const archiveProjects = join(String(dataDir ?? ""), "projects-archive");
    const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

    const httpError = (status, message) => Object.assign(new Error(message), { status });
    const badRequest = (message) => httpError(400, message);

    /** 活动目录优先、其次归档目录（与 projects.js `locate` 同语义）；都没有返回 null。 */
    function locate(projectId) {
        const id = String(projectId ?? "");
        if (!id || !ID_PATTERN.test(id)) return null;
        for (const base of [activeProjects, archiveProjects]) {
            const dir = safeJoin(base, id);
            if (dir && existsSync(join(dir, "project.json"))) return dir;
        }
        return null;
    }

    function requireDir(projectId) {
        const dir = locate(projectId);
        if (!dir) throw httpError(404, `项目不存在：${projectId}`);
        return dir;
    }

    const bibleDir = (dir) => safeJoin(dir, "bibles");
    const bibleFile = (dir, id) => (ID_PATTERN.test(String(id ?? "")) ? safeJoin(dir, "bibles", `${id}.json`) : null);

    function readJson(file) {
        if (!file || !existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            // 与 projects.js 一致：坏文件按空处理并告警，不让服务崩。
            console.warn(`[bible] 文件损坏，按空处理：${file}（${error.message}）`);
            return null;
        }
    }

    /** 临时文件 + 同目录 rename，避免读到写了一半的实体。 */
    function writeJsonAtomic(file, value) {
        ensureDir(join(file, ".."));
        const temp = `${file}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(temp, JSON.stringify(value, null, 2));
        renameSync(temp, file);
    }

    /** 旧版本快照（去掉 history 自身，避免自嵌套）。 */
    const snapshot = (record, at) => {
        const { history, ...rest } = record;
        return { ...rest, changedAt: at, changedBy: record.changedBy ?? "system" };
    };

    /** 归一当前内容：只保留该类别认可的字段 + id/status/revision，作为「变化」比较与落盘口径。 */
    const contentOf = (record) => normalizeBible(record?.kind, record).value;

    function list(projectId) {
        const dir = requireDir(projectId);
        const folder = bibleDir(dir);
        if (!folder || !existsSync(folder)) return [];
        return readdirSync(folder)
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJson(join(folder, name)))
            .filter(Boolean)
            .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
    }

    function get(projectId, bibleId) {
        const dir = requireDir(projectId);
        return readJson(bibleFile(dir, bibleId));
    }

    function requireBible(projectId, bibleId) {
        const dir = requireDir(projectId);
        const record = readJson(bibleFile(dir, bibleId));
        if (!record) throw httpError(404, `圣经实体不存在：${bibleId}`);
        return { dir, record };
    }

    /** 创建：kind 必填；id 可省（自动 `bib_` + ULID）；状态一律从 `draft` / `revision=1` 起。 */
    function create(projectId, input = {}) {
        const dir = requireDir(projectId);
        const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
        const kind = String(body.kind ?? "").trim();
        if (!isBibleKind(kind)) throw badRequest(`缺少或非法圣经类别 kind：${kind || "(空)"}（可选：${Object.values(BIBLE_KIND).join(" / ")}）`);
        const explicit = String(body.id ?? "").trim();
        const id = explicit && ID_PATTERN.test(explicit) ? explicit : `bib_${ulid()}`;
        const file = bibleFile(dir, id);
        if (!file) throw badRequest(`圣经实体 id 非法：${id}`);
        if (existsSync(file)) throw httpError(409, `圣经实体已存在：${id}`);

        const { value, warnings } = normalizeBible(kind, body);
        const now = nowIso();
        const record = {
            ...value,
            id,
            projectId: String(projectId),
            kind,
            revision: 1,
            status: BIBLE_STATE.DRAFT,
            createdAt: now,
            updatedAt: now,
            previousRevision: null,
            changedBy: "system",
            history: [],
        };
        writeJsonAtomic(file, record);
        // 自动生成 id 时，抹掉规整函数对缺省 id 的 required 告警（不是用户输入的缺失）。
        return { bible: record, warnings: warnings.filter((item) => !(item.field === "id" && item.code === "required")) };
    }

    /**
     * 更新（幂等）。已 approved / locked（可消费）发生实际改动 → 派生新 revision，旧版本进 history[]。
     * @returns {{ bible: Object, changed: boolean, requiresNewRevision: boolean }}
     */
    function update(projectId, bibleId, patch = {}, { actor } = {}) {
        const { dir, record } = requireBible(projectId, bibleId);
        const body = { ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) };
        // 身份与账面字段不可经 patch 覆盖（status 只能走 transition）。
        for (const key of ["id", "kind", "projectId", "status", "revision", "history", "createdAt", "updatedAt", "previousRevision", "changedBy", "actor"]) delete body[key];

        // 变化检测：始终按「非锁定」探针做深合并，否则 mergeBiblePatch 对已锁对象会短路（返回原对象）。
        const current = contentOf(record);
        const { bible: merged } = mergeBiblePatch({ ...record, status: BIBLE_STATE.DRAFT }, body);
        const candidate = normalizeBible(record.kind, merged).value;
        // status/revision 由本层决定，不参与「内容是否变化」比较（否则 review→draft 会被误判为有变化）。
        const stripState = ({ status, revision, ...rest }) => rest;
        if (JSON.stringify(stripState(candidate)) === JSON.stringify(stripState(current))) return { bible: record, changed: false, requiresNewRevision: false };

        const now = nowIso();
        const consumable = isConsumable(record.status);
        const priorRevision = normalizeRevision(record.revision, collector(), "revision");
        const history = Array.isArray(record.history) ? record.history.slice() : [];
        if (consumable) history.push(snapshot(record, now));
        const next = {
            ...candidate,
            id: record.id,
            projectId: record.projectId,
            kind: record.kind,
            revision: consumable ? priorRevision + 1 : priorRevision,
            status: BIBLE_STATE.DRAFT, // 任何改动都需重新审批
            createdAt: record.createdAt ?? now,
            updatedAt: now,
            previousRevision: consumable ? priorRevision : record.previousRevision ?? null,
            changedBy: asTrimmedString(actor) || "system",
            history,
        };
        writeJsonAtomic(bibleFile(dir, bibleId), next);
        return { bible: next, changed: true, requiresNewRevision: consumable };
    }

    /**
     * 推进确认锁状态机（submit_review / approve / reject / lock / reopen / revise）。
     * 非法迁移 → 抛 400 且原因可读（直接取自纯函数 transition 的 reason）。
     * 回退型迁移（approved.reopen / locked.revise）产生新 revision，旧版本进 history[]。
     */
    function transitionState(projectId, bibleId, action, actor) {
        const { dir, record } = requireBible(projectId, bibleId);
        const outcome = transition(record, action, actor);
        if (!outcome.ok) throw badRequest(outcome.reason);
        const now = nowIso();
        const from = record.status;
        if (outcome.revisionBump) {
            const priorRevision = normalizeRevision(record.revision, collector(), "revision");
            const history = Array.isArray(record.history) ? record.history.slice() : [];
            history.push(snapshot(record, now));
            const next = {
                ...record,
                status: outcome.next,
                revision: priorRevision + 1,
                previousRevision: priorRevision,
                changedBy: outcome.actor,
                updatedAt: now,
                history,
            };
            writeJsonAtomic(bibleFile(dir, bibleId), next);
            return { bible: next, action, from, to: outcome.next, bumped: true };
        }
        const next = { ...record, status: outcome.next, changedBy: outcome.actor, updatedAt: now };
        writeJsonAtomic(bibleFile(dir, bibleId), next);
        return { bible: next, action, from, to: outcome.next, bumped: false };
    }

    return { list, get, create, update, transition: transitionState };
}

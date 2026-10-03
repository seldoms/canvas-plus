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

import { normalizeProjectBrief as normalizeBriefSpec } from "./production-contracts.js";

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

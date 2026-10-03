import { createHash } from "node:crypto";

/**
 * 参考图锁定纯逻辑模块（development-plan §11.5.4 「关键帧角色一致性的阻断诊断」/ §12 第 2 优先级「角色/场景参考锁」）。
 *
 * 要修的致命问题：关键帧每一镜都是独立文生图，从不给模型看角色参考图，导致同一角色跨镜头长相不一致。
 * 本模块只做**纯逻辑**（零 IO、零网络、零外部依赖），把这条链路的前两步做成可单测的纯函数：
 *
 *   1. ShotBinding   —— 把「镜头内容」稳定地投影成「本镜涉及哪些角色 / 地点 / 道具」的绑定对象
 *                       （shots[] 里只有 sceneId + 自由文本，没有 characterIds 字段，所以必须**按名字映射**，
 *                        不能依赖 LLM 自由文本里其实不存在的结构化字段）。
 *   2. 参考图解析     —— 按 ShotBinding 的 characterIds / locationId / propIds，从项目 AssetRef 里
 *                       取 selectedArtifactId（**AssetRef.bindingId 是引用自身字段，不是 metadata.bindingId**
 *                       —— 本项目已踩过这个坑），再落到真实 artifact（url）。
 *   3. 稳定 seed      —— 同项目 / 同镜头 / 同资产 revision → 同 seed，任一变化即变，避免「换台设备跑出不同脸」。
 *   4. 缺参考图报告   —— 显式列出哪些绑定还没有可选参考图，供门禁判 blocked / warning，绝不静默返回空。
 *
 * 数据约定（与 distillery 现状一致，本模块不 import 任何其它 src 模块）：
 *   - design（03 服化道产物）：{ characters: [{ id, name, props[]? }], locations: [{ id, name }] }
 *       characters[].id 沿用剧本人物 id（c1…），locations[].id 是场景锚点（loc1…）；
 *       AssetRef.bindingId 即取这两个 id（见 pipeline.js registerDesignAssets）。
 *   - storyboard（02 分镜产物）：{ shots: [{ id, sceneId, action, dialogue, prompt, ... }] }；
 *       镜头文本字段才有角色信息，shots[] **没有** characterIds / locationId 字段。
 *   - storyboard 上下文：为解析 locationId 还需 sceneId → 地点 的映射，故 storyboard 可再带
 *       { scenes | episodes[].scenes }，scene 形如 { id, locationId, location }。
 *   - AssetRef：{ id, role, bindingId, artifactIds[], selectedArtifactId, revision?, metadata? }
 *       role ∈ { character, scene, prop }（contracts.js ASSET_ROLE）。
 *   - artifacts：已产出的产物目录，数组 [{ id, url }] 或按 id 索引的对象；url 允许别名 artifactUrl/path/src。
 *
 * 明确边界：本模块只**算**「该取哪些参考图 / 缺什么」，不生成图、不写盘、不改 selected 指针、
 * 不 import pipeline.js / projects.js —— 真正接线与门禁判定由调用方完成。
 */

/** 参考图涉及的资产类别（与 contracts.js ASSET_ROLE 的子集对齐）。 */
export const REF_ROLE = Object.freeze({
    CHARACTER: "character",
    SCENE: "scene",
    PROP: "prop",
});

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const trimStr = (value) => (value === undefined || value === null ? "" : String(value).trim());
const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const addUnique = (list, value) => {
    if (!list.includes(value)) list.push(value);
};

/* ------------------------------------------------------------------ *
 * 1. 稳定指纹 / seed
 * ------------------------------------------------------------------ */

/**
 * 稳定序列化：对象字段顺序无关、数组顺序敏感、同输入同串。
 * 与 impact.js 的指纹语义保持一致（但本模块零依赖、自包含），额外覆盖 JSON 无法表达的
 * undefined / NaN / BigInt，避免「字段顺序不同 → seed 不同」和「NaN→null 撞车」。
 */
function stableSerialize(value, ancestors) {
    if (value === null) return "null";
    const kind = typeof value;
    if (kind === "undefined") return "undefined";
    if (kind === "number") return Object.is(value, -0) ? "0" : String(value);
    if (kind === "boolean") return value ? "true" : "false";
    if (kind === "bigint") return `bigint:${value.toString()}`;
    if (kind === "string") return JSON.stringify(value);
    if (kind === "function" || kind === "symbol") return kind;

    if (ancestors.has(value)) return '"[Circular]"';
    ancestors.add(value);
    let out;
    if (Array.isArray(value)) {
        out = `[${value.map((item) => stableSerialize(item, ancestors)).join(",")}]`;
    } else {
        const keys = Object.keys(value).sort();
        out = `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], ancestors)}`).join(",")}}`;
    }
    ancestors.delete(value);
    return out;
}

/**
 * 稳定整数 seed（§11.5.4 的 stableSeed）。同 projectId / shotId / assetRevision → 同值；
 * 任一变化即变。返回 0 .. 2^32-1 的整数，可直接喂给生图 tool 的 SEED 参数。
 *
 * @param {string}        projectId
 * @param {string}        shotId
 * @param {object|number} assetRevision 资产 revision（通常传 shotBinding.assetRevision 映射）。
 * @returns {number}
 */
export function stableSeed(projectId, shotId, assetRevision) {
    const payload = [
        projectId === undefined ? null : projectId,
        shotId === undefined ? null : shotId,
        assetRevision === undefined ? null : assetRevision,
    ];
    const hex = createHash("sha256").update(stableSerialize(payload, new WeakSet()), "utf8").digest("hex");
    return parseInt(hex.slice(0, 8), 16);
}

/* ------------------------------------------------------------------ *
 * 2. 投影：把镜头内容摊平成「本镜涉及哪些角色 / 地点 / 道具」
 * ------------------------------------------------------------------ */

/** 从 storyboard / output 里取一个数组字段（容忍多级包裹）。 */
function firstArray(...values) {
    for (const value of values) {
        if (Array.isArray(value)) return value;
    }
    return [];
}

function collectDesignList(design, key) {
    if (!isObj(design)) return [];
    return firstArray(design[key], design.output?.[key]).filter(isObj);
}

/** 取 storyboard 里的 shots（容忍数组 / {shots} / {output:{shots}}）。 */
function collectShots(storyboard) {
    if (Array.isArray(storyboard)) return storyboard.filter(isObj);
    if (!isObj(storyboard)) return [];
    return firstArray(storyboard.shots, storyboard.output?.shots).filter(isObj);
}

/** 取 storyboard 上下文里的 scenes（容忍 scenes / output.scenes / episodes[].scenes）。 */
function collectScenes(storyboard) {
    if (!isObj(storyboard)) return [];
    const out = [];
    const seen = new Set();
    const pushAll = (list) => {
        for (const scene of asArray(list)) {
            if (!isObj(scene)) continue;
            const id = trimStr(scene.id);
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            out.push(scene);
        }
    };
    pushAll(storyboard.scenes);
    pushAll(storyboard.output?.scenes);
    for (const episode of asArray(storyboard.episodes)) pushAll(episode?.scenes);
    for (const episode of asArray(storyboard.output?.episodes)) pushAll(episode?.scenes);
    return out;
}

/** shot 允许传对象；传字符串时按 id 在 storyboard.shots 里回查。 */
function resolveShot(shot, storyboard) {
    if (isObj(shot)) return shot;
    const id = trimStr(shot);
    if (!id) return {};
    const hit = collectShots(storyboard).find((item) => trimStr(item.id) === id || trimStr(item.shotId) === id);
    return hit || { id };
}

/** 把一个 token 值（字符串 / 数字 / {id,name} / 数组）展开成字符串列表。 */
function pushTokens(out, value) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
        for (const item of value) pushTokens(out, item);
        return;
    }
    if (typeof value === "string" || typeof value === "number") {
        const text = trimStr(value);
        if (text) out.push(text);
        return;
    }
    if (isObj(value)) {
        for (const key of ["id", "name", "bindingId", "characterId", "locationId", "propId"]) {
            const text = trimStr(value[key]);
            if (text) out.push(text);
        }
    }
}

/** 收集 shot（含 shot.storyboard）上显式的引用 token（兼容显式 id 与角色名两种写法）。 */
function explicitTokens(shot, fields) {
    const out = [];
    for (const field of fields) {
        pushTokens(out, shot?.[field]);
        pushTokens(out, shot?.storyboard?.[field]);
    }
    return out;
}

/** 建立 name/id → 规范 bindingId 的索引；assetRefs 的 bindingId / metadata.name 也登记，便于无 design 时兜底。 */
function buildBindingIndex(role, kinds, assetRefs) {
    const index = new Map();
    const register = (token, id) => {
        const key = trimStr(token);
        if (key && id) index.set(key, id);
    };
    for (const item of kinds) {
        const id = trimStr(item.id);
        if (!id) continue;
        register(id, id);
        register(item.name, id);
        register(item.title, id);
    }
    for (const ref of asArray(assetRefs)) {
        if (!isObj(ref) || trimStr(ref.role) !== role) continue;
        const id = trimStr(ref.bindingId);
        if (!id) continue;
        register(id, id);
        register(ref.metadata?.name, id);
    }
    return index;
}

/** 名字 → id 的记录（用于在镜头自由文本里按名字回填角色）。 */
function characterNameEntries(design, assetRefs) {
    const entries = [];
    const seen = new Set();
    const add = (id, name) => {
        const key = trimStr(id);
        const label = trimStr(name);
        if (!key || !label || seen.has(`${key}|${label}`)) return;
        seen.add(`${key}|${label}`);
        entries.push({ id: key, name: label });
    };
    for (const item of collectDesignList(design, "characters")) add(item.id, item.name);
    for (const ref of asArray(assetRefs)) {
        if (!isObj(ref) || trimStr(ref.role) !== REF_ROLE.CHARACTER) continue;
        add(ref.bindingId, ref.metadata?.name);
    }
    return entries;
}

/** 镜头里出现的文本（只扫真实存在的字段，不编造字段）。 */
function shotText(shot) {
    return [shot?.action, shot?.dialogue, shot?.prompt, shot?.audio, shot?.summary, shot?.description]
        .filter((value) => nonEmpty(value))
        .map((value) => String(value))
        .join("\n");
}

const CHARACTER_FIELDS = ["characterIds", "characters", "character", "characterId", "cast"];
const PROP_FIELDS = ["propIds", "props", "prop"];

/**
 * 从镜头内容推导角色 id（稳定、按名字映射、不依赖不存在的字段）：
 *   1. 先取显式 token（characterIds / characters / character / cast），能映射则映射，否则原样保留；
 *   2. 再扫镜头自由文本（action / dialogue / prompt …），按 design 角色名命中回填。
 * 顺序稳定：显式字段顺序 → design 角色顺序。
 */
function resolveCharacterIds(shot, index, nameEntries) {
    const ids = [];
    for (const token of explicitTokens(shot, CHARACTER_FIELDS)) {
        const mapped = index.has(token) ? index.get(token) : token;
        addUnique(ids, mapped);
    }
    const text = shotText(shot);
    if (text) {
        for (const entry of nameEntries) {
            if (text.includes(entry.name)) addUnique(ids, entry.id);
        }
    }
    return ids;
}

/** 解析本镜地点：shot > 命中 scene；优先取能映射到 design 地点锚点的候选。 */
function resolveLocationId(shot, scenes, index) {
    const scene = scenes.find((item) => {
        const sid = trimStr(shot?.sceneId);
        return sid !== "" && (trimStr(item.id) === sid || trimStr(item.sceneId) === sid);
    });
    const candidates = [
        shot?.locationId,
        shot?.location,
        scene?.locationId,
        scene?.location,
        shot?.scene?.locationId,
        shot?.scene?.location,
    ];
    let fallback = null;
    for (const candidate of candidates) {
        const key = trimStr(candidate);
        if (!key) continue;
        if (index.has(key)) return index.get(key);
        if (fallback === null) fallback = key;
    }
    return fallback;
}

/** 解析本镜道具：显式 propIds / props，能映射则映射，否则原样保留。 */
function resolvePropIds(shot, index) {
    const ids = [];
    for (const token of explicitTokens(shot, PROP_FIELDS)) {
        const mapped = index.has(token) ? index.get(token) : token;
        addUnique(ids, mapped);
    }
    return ids;
}

/** 从 assetRefs 上取每个绑定锚点的 revision（改了三视图 revision → seed 变）。 */
function buildAssetRevision(bindingIds, assetRefs) {
    const map = {};
    const refs = asArray(assetRefs).filter(isObj);
    for (const rawId of bindingIds) {
        const key = trimStr(rawId);
        if (!key || Object.prototype.hasOwnProperty.call(map, key)) continue;
        const ref = refs.find((item) => trimStr(item.bindingId) === key);
        const raw = ref ? (ref.revision ?? ref.metadata?.revision) : null;
        if (raw === undefined || raw === null || raw === "") map[key] = 0;
        else map[key] = Number.isFinite(Number(raw)) ? Number(raw) : String(raw);
    }
    return map;
}

/**
 * 把镜头稳定投影成 ShotBinding（§11.5.4 的 shotBinding 结构）。
 *
 * @param {object}        args
 * @param {object|string} args.shot       镜头对象（或镜头 id，会用 storyboard.shots 回查）。
 * @param {object}        [args.storyboard] 分镜产物 / 含 scenes 的上下文。
 * @param {object}        [args.design]    03 服化道产物（characters / locations）。
 * @param {Array}         [args.assetRefs] 项目资产引用，用于取 revision 与兜底 name→id。
 * @returns {{ shotId: string, characterIds: string[], locationId: string|null, propIds: string[], assetRevision: object }}
 */
export function buildShotBinding({ shot, storyboard, design, assetRefs } = {}) {
    const shotObj = resolveShot(shot, storyboard);
    const scenes = collectScenes(storyboard);
    const characterIndex = buildBindingIndex(REF_ROLE.CHARACTER, collectDesignList(design, "characters"), assetRefs);
    const locationIndex = buildBindingIndex(REF_ROLE.SCENE, collectDesignList(design, "locations"), assetRefs);
    const propIndex = buildBindingIndex(REF_ROLE.PROP, collectDesignList(design, "props"), assetRefs);

    const shotId = trimStr(shotObj.id ?? shotObj.shotId ?? (typeof shot === "string" ? shot : ""));
    const characterIds = resolveCharacterIds(shotObj, characterIndex, characterNameEntries(design, assetRefs));
    const locationId = resolveLocationId(shotObj, scenes, locationIndex);
    const propIds = resolvePropIds(shotObj, propIndex);
    const assetRevision = buildAssetRevision([...characterIds, locationId, ...propIds].filter(Boolean), assetRefs);

    return { shotId, characterIds, locationId: locationId || null, propIds, assetRevision };
}

/* ------------------------------------------------------------------ *
 * 3. 参考图解析：ShotBinding → selected artifact（url）
 * ------------------------------------------------------------------ */

/** 把 artifacts 归一到 id → artifact 的索引（支持数组或按 id 索引的对象）。 */
function indexArtifacts(artifacts) {
    const index = new Map();
    if (Array.isArray(artifacts)) {
        for (const item of artifacts) {
            if (isObj(item)) index.set(trimStr(item.id), item);
        }
    } else if (isObj(artifacts)) {
        for (const [key, item] of Object.entries(artifacts)) {
            if (isObj(item)) index.set(trimStr(item.id ?? key), item);
        }
    }
    return index;
}

/** 从 artifact 上取可访问 url（容忍若干别名）。 */
function artifactUrl(artifact) {
    for (const key of ["url", "artifactUrl", "path", "src", "file"]) {
        const text = trimStr(artifact?.[key]);
        if (text) return text;
    }
    return null;
}

/** 按 bindingId 命中 AssetRef：优先 role 匹配，找不到再退化为仅按 bindingId 命中。 */
function findAssetRef(refs, role, bindingId) {
    return (
        refs.find((ref) => trimStr(ref.role) === role && trimStr(ref.bindingId) === bindingId) ||
        refs.find((ref) => trimStr(ref.bindingId) === bindingId) ||
        null
    );
}

/**
 * 按 ShotBinding 解析出战 / 角色 / 道具的可选参考图（§11.5.4 的 resolveSelectedArtifacts）。
 *
 * 规则：只取 AssetRef.bindingId 命中且 selectedArtifactId 存在的引用，再落到 artifacts 里的真实 url。
 * **缺什么必须显式报告**（返回 missing[]，且 complete=false），绝不静默返回空数组；调用方据此判 blocked/warning。
 *
 * @param {object} args
 * @param {object} args.shotBinding  buildShotBinding 的产物。
 * @param {Array}  [args.assetRefs]  项目资产引用（bindingId 是引用自身字段，不是 metadata.bindingId）。
 * @param {Array|object} [args.artifacts] 已产出产物；未传时不做「artifact 不存在」判定，url 记 null。
 * @returns {{ character: object[], scene: object[], prop: object[], missing: object[], complete: boolean }}
 */
export function resolveSelectedArtifacts({ shotBinding, assetRefs, artifacts } = {}) {
    const binding = isObj(shotBinding) ? shotBinding : {};
    const refs = asArray(assetRefs).filter(isObj);
    const catalog = indexArtifacts(artifacts);
    const hasCatalog = artifacts !== undefined && artifacts !== null;

    const result = { character: [], scene: [], prop: [], missing: [], complete: true };
    const groups = [
        [REF_ROLE.CHARACTER, "character", asArray(binding.characterIds)],
        [REF_ROLE.SCENE, "scene", binding.locationId ? [binding.locationId] : []],
        [REF_ROLE.PROP, "prop", asArray(binding.propIds)],
    ];

    for (const [role, bucket, ids] of groups) {
        for (const rawId of asArray(ids)) {
            const bindingId = trimStr(rawId);
            if (!bindingId) continue;
            const ref = findAssetRef(refs, role, bindingId);
            if (!ref) {
                result.missing.push({ role, bindingId, reason: "no-ref" });
                continue;
            }
            const selectedArtifactId = trimStr(ref.selectedArtifactId);
            if (!selectedArtifactId) {
                result.missing.push({ role, bindingId, assetRefId: trimStr(ref.id) || null, reason: "no-selected" });
                continue;
            }
            const entry = {
                role,
                bindingId,
                assetRefId: trimStr(ref.id) || null,
                artifactId: selectedArtifactId,
                url: null,
            };
            if (hasCatalog) {
                const artifact = catalog.get(selectedArtifactId);
                if (!artifact) {
                    result.missing.push({ role, bindingId, assetRefId: entry.assetRefId, artifactId: selectedArtifactId, reason: "artifact-not-found" });
                    continue;
                }
                entry.url = artifactUrl(artifact);
                if (!entry.url) {
                    result.missing.push({ role, bindingId, assetRefId: entry.assetRefId, artifactId: selectedArtifactId, reason: "artifact-without-url" });
                    continue;
                }
            }
            result[bucket].push(entry);
        }
    }

    result.complete = result.missing.length === 0;
    return result;
}

/* ------------------------------------------------------------------ *
 * 4. 缺失参考图报告：供门禁判 blocked / warning
 * ------------------------------------------------------------------ */

/** 单个绑定锚点的参考图状态：no-ref / no-candidate → blocked；not-selected → warning。 */
function inspectBinding(refs, role, rawId, blocked, warning) {
    const bindingId = trimStr(rawId);
    if (!bindingId) return;
    const ref = findAssetRef(refs, role, bindingId);
    if (!ref) {
        blocked.push({ role, bindingId, reason: "no-ref" });
        return;
    }
    if (trimStr(ref.selectedArtifactId)) return; // 已选定可用参考图
    const candidates = asArray(ref.artifactIds).filter((item) => nonEmpty(item));
    if (candidates.length === 0) blocked.push({ role, bindingId, assetRefId: trimStr(ref.id) || null, reason: "no-candidate" });
    else warning.push({ role, bindingId, assetRefId: trimStr(ref.id) || null, reason: "not-selected" });
}

/**
 * 报告 ShotBinding 里还没有可选参考图的角色 / 场景 / 道具（供门禁判定）。
 *   - blocked：无 AssetRef，或 AssetRef 没有任何候选 artifact —— 硬缺，不得宣称已锁定角色；
 *   - warning：有候选 artifact 但还没选定 selectedArtifactId —— 需人工确认；
 *   - complete：blocked 与 warning 均为空。
 *
 * @param {object} args
 * @param {object} args.shotBinding buildShotBinding 的产物。
 * @param {Array}  [args.assetRefs]  项目资产引用。
 * @returns {{ complete: boolean, blocked: object[], warning: object[], missing: object[] }}
 */
export function missingRefsReport({ shotBinding, assetRefs } = {}) {
    const binding = isObj(shotBinding) ? shotBinding : {};
    const refs = asArray(assetRefs).filter(isObj);
    const blocked = [];
    const warning = [];
    for (const rawId of asArray(binding.characterIds)) inspectBinding(refs, REF_ROLE.CHARACTER, rawId, blocked, warning);
    if (binding.locationId) inspectBinding(refs, REF_ROLE.SCENE, binding.locationId, blocked, warning);
    for (const rawId of asArray(binding.propIds)) inspectBinding(refs, REF_ROLE.PROP, rawId, blocked, warning);
    return { complete: blocked.length === 0 && warning.length === 0, blocked, warning, missing: [...blocked, ...warning] };
}

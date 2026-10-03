import { createHash } from "node:crypto";

/**
 * 回马枪（可逆生产链）纯逻辑模块（development-plan §11.5.3 / §12 最低验收场景）。
 *
 * 只做纯计算：输入指纹、依赖影响分析（stale 计算）、分支重跑计划、不可变 markStale。
 * 零 IO、零 HTTP、零依赖注入耦合：project / episodes / scenes / shots / cues / deliverables
 * 一律以普通对象传入，本模块不 import projects.js、不读盘、不知道存储布局。
 *
 * 依赖模型（可被后续接线/扩展的约定）：
 *   - AssetRef.project.assetRefs[]：{ id, role, bindingId, episodeId?, sceneId?, shotId?,
 *     artifactIds, selectedArtifactId }。bindingId 是角色/场景/道具的一致性锚点。
 *   - Shot 对资产的引用来源（任一命中即视为依赖）：
 *       shot.characterIds / shot.characters / shot.character / shot.characterId /
 *       shot.assetRefIds / shot.assetRefId、
 *       shot.storyboard 下的同名同义字段、
 *       以及 assetRefs 中用 shotId 限定到该镜的引用。
 *   - Scene：locationId / characterIds / characters / assetRefIds + assetRefs 按 sceneId 限定。
 *   - AudioCue：{ id, shotId?, episodeId?, characterId?, ... }，来源 project.cues / ep.cues / shot.cues。
 *   - Deliverable：{ id, shotIds?, clips?[{shotId}], episodeId? }，来源 project.deliverables / ep.deliverables。
 *
 * 四条规则（§11.5.3）：
 *   1. 旧结果永不覆盖 —— 本模块只算「哪些该重跑」，不删不改历史。
 *   2. 先算影响范围再入队 —— plan() 返回 stale/keep/reasons，reasons 指向具体 changed 项。
 *   3. 下游按输入指纹失效 —— isReusable() 校验 inputFingerprint + status + selectedArtifactId。
 *   4. 新旧链可比较回退 —— stale 是派生状态，不等于删除/失败。
 */

/* ------------------------------------------------------------------ *
 * 1. 稳定指纹
 * ------------------------------------------------------------------ */

/**
 * 稳定序列化：对象字段顺序无关、数组顺序敏感、同输入同串。
 * 只用 node 内置能力自己实现（不引依赖），覆盖 JSON 无法表达的 undefined / NaN / BigInt。
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

    // 循环引用按路径判定：只对当前祖先链去重，兄弟节点的相同引用仍会各自展开（确定性不受遍历顺序影响）。
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

/** 计算输入的稳定指纹（sha256 hex）。同输入同值、对象字段顺序无关、数组顺序敏感。 */
export function fingerprint(input) {
    return createHash("sha256").update(stableSerialize(input, new WeakSet()), "utf8").digest("hex");
}

/* ------------------------------------------------------------------ *
 * 2. 依赖解析原语
 * ------------------------------------------------------------------ */

/** 把 changed 项 / id / id[] 统一成字符串 id 列表（支持直接传 changed[] 形状）。 */
function toIdList(value) {
    if (value === undefined || value === null) return [];
    const rows = Array.isArray(value) ? value : [value];
    const out = [];
    for (const row of rows) {
        if (row === undefined || row === null) continue;
        if (typeof row === "object") {
            if (row.id !== undefined && row.id !== null) out.push(String(row.id));
            else if (row.bindingId !== undefined && row.bindingId !== null) out.push(String(row.bindingId));
        } else {
            out.push(String(row));
        }
    }
    return out;
}

/**
 * 把一批 id 解析成「可比对键集合」：原值、去 aref_ 前缀的裸 id、以及命中 AssetRef 时的
 * ref.id / ref.bindingId。这样 `aref_c1`、`c1`、`as_ULID` 三种写法都能命中同一条依赖。
 */
function resolveKeys(ids, assetRefs) {
    const keys = new Set();
    for (const id of ids) {
        const raw = String(id);
        const bare = raw.startsWith("aref_") ? raw.slice("aref_".length) : raw;
        keys.add(raw);
        keys.add(bare);
        for (const ref of assetRefs) {
            if (!ref || typeof ref !== "object") continue;
            const refId = ref.id === undefined || ref.id === null ? null : String(ref.id);
            const binding = ref.bindingId === undefined || ref.bindingId === null ? null : String(ref.bindingId);
            if (refId === raw || refId === bare || binding === raw || binding === bare) {
                if (refId) keys.add(refId);
                if (binding) keys.add(binding);
            }
        }
    }
    return keys;
}

/** 两个集合是否有交集。 */
function overlaps(a, b) {
    if (!a || !b || a.size === 0 || b.size === 0) return false;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const value of small) if (large.has(value)) return true;
    return false;
}

/** 从一个容器（shot / scene / storyboard / cue）里收集对资产锚点的引用 token。 */
function collectRefTokens(container) {
    if (!container || typeof container !== "object") return [];
    const tokens = [];
    const push = (value) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            for (const item of value) push(item);
            return;
        }
        if (typeof value === "string" || typeof value === "number") {
            tokens.push(String(value));
            return;
        }
        if (typeof value === "object") {
            for (const key of ["bindingId", "characterId", "assetRefId", "id", "locationId"]) {
                if (value[key] !== undefined && value[key] !== null) tokens.push(String(value[key]));
            }
            if (value.storyboard && typeof value.storyboard === "object") push(value.storyboard);
        }
    };
    for (const key of ["characterIds", "characters", "character", "characterId", "assetRefIds", "assetRefId", "locationId"]) {
        push(container[key]);
    }
    if (container.storyboard && typeof container.storyboard === "object") {
        for (const key of ["characterIds", "characters", "character", "characterId", "assetRefIds", "assetRefId"]) {
            push(container.storyboard[key]);
        }
    }
    return tokens;
}

/** 把 assetRef id 折叠成其 binding 锚点，让「按 assetRef id 改」与「按 binding 引用」可对上。 */
function foldAssetRefTokens(tokens, assetRefs) {
    const keys = new Set(tokens);
    for (const ref of assetRefs) {
        if (!ref || typeof ref !== "object") continue;
        const refId = ref.id === undefined || ref.id === null ? null : String(ref.id);
        const binding = ref.bindingId === undefined || ref.bindingId === null ? null : String(ref.bindingId);
        if (!refId) continue;
        if (keys.has(refId) && binding) keys.add(binding);
        if (binding && keys.has(binding)) keys.add(refId);
    }
    return keys;
}

/** 镜头依赖的键集合（含按 shotId 限定的 AssetRef）。 */
function shotRefKeys(shot, assetRefs) {
    const keys = foldAssetRefTokens(collectRefTokens(shot), assetRefs);
    if (shot && shot.id !== undefined && shot.id !== null) {
        for (const ref of assetRefs) {
            if (ref && ref.shotId !== undefined && ref.shotId !== null && String(ref.shotId) === String(shot.id)) {
                if (ref.bindingId) keys.add(String(ref.bindingId));
                if (ref.id) keys.add(String(ref.id));
            }
        }
    }
    return keys;
}

/** 场依赖的键集合（含按 sceneId 限定的 AssetRef）。 */
function sceneRefKeys(scene, assetRefs) {
    const keys = foldAssetRefTokens(collectRefTokens(scene), assetRefs);
    if (scene && scene.id !== undefined && scene.id !== null) {
        for (const ref of assetRefs) {
            if (ref && ref.sceneId !== undefined && ref.sceneId !== null && String(ref.sceneId) === String(scene.id)) {
                if (ref.bindingId) keys.add(String(ref.bindingId));
                if (ref.id) keys.add(String(ref.id));
            }
        }
    }
    return keys;
}

/** 镜头是否依赖给定的 changed 集合（doc §11.5.3 的 shotDependsOn）。 */
export function shotDependsOn(shot, changedIds, assetRefs = []) {
    if (!shot || typeof shot !== "object") return false;
    const keys = resolveKeys(toIdList(changedIds), Array.isArray(assetRefs) ? assetRefs : []);
    if (shot.id !== undefined && shot.id !== null && keys.has(String(shot.id))) return true;
    return overlaps(shotRefKeys(shot, Array.isArray(assetRefs) ? assetRefs : []), keys);
}

function shotDependsOnKeys(shot, keys, assetRefs) {
    if (!shot || typeof shot !== "object") return false;
    if (shot.id !== undefined && shot.id !== null && keys.has(String(shot.id))) return true;
    return overlaps(shotRefKeys(shot, assetRefs), keys);
}

/* ------------------------------------------------------------------ *
 * 3. 投影：把 project 摊平成带归属的集合
 * ------------------------------------------------------------------ */

function* shotsOfEpisode(episode) {
    if (!episode || typeof episode !== "object") return;
    const emitted = new Set();
    const emit = (shot, sceneId) => {
        if (!shot || typeof shot !== "object" || shot.id === undefined || shot.id === null) return;
        if (emitted.has(String(shot.id))) return;
        emitted.add(String(shot.id));
        return { shot, sceneId: sceneId ?? (shot.sceneId ?? null) };
    };
    for (const shot of episode.shots ?? []) {
        const row = emit(shot, shot.sceneId);
        if (row) yield row;
    }
    for (const scene of episode.scenes ?? []) {
        for (const shot of scene?.shots ?? []) {
            const row = emit(shot, scene.id);
            if (row) yield row;
        }
    }
}

function flattenShots(project) {
    const rows = [];
    for (const episode of project.episodes ?? []) {
        if (!episode || typeof episode !== "object") continue;
        for (const { shot, sceneId } of shotsOfEpisode(episode)) {
            rows.push({ shot, episodeId: shot.episodeId ?? episode.id ?? null, sceneId });
        }
    }
    return rows;
}

function flattenScenes(project) {
    const rows = [];
    for (const episode of project.episodes ?? []) {
        if (!episode || typeof episode !== "object") continue;
        for (const scene of episode.scenes ?? []) {
            if (!scene || typeof scene !== "object" || scene.id === undefined || scene.id === null) continue;
            rows.push({ scene, episodeId: scene.episodeId ?? episode.id ?? null });
        }
    }
    return rows;
}

function flattenEpisodes(project) {
    return (project.episodes ?? []).filter((episode) => episode && typeof episode === "object" && episode.id !== undefined && episode.id !== null);
}

function flattenCues(project, shots) {
    const rows = [];
    const add = (cue, fallbackShotId, fallbackEpisodeId) => {
        if (!cue || typeof cue !== "object" || cue.id === undefined || cue.id === null) return;
        rows.push({
            cue,
            id: String(cue.id),
            shotId: cue.shotId !== undefined && cue.shotId !== null ? String(cue.shotId) : fallbackShotId,
            episodeId: cue.episodeId !== undefined && cue.episodeId !== null ? String(cue.episodeId) : fallbackEpisodeId,
            characterId: cue.characterId !== undefined && cue.characterId !== null ? String(cue.characterId) : null,
        });
    };
    for (const cue of project.cues ?? []) add(cue, null, null);
    for (const episode of project.episodes ?? []) {
        if (!episode || typeof episode !== "object") continue;
        for (const cue of episode.cues ?? []) add(cue, null, episode.id ?? null);
    }
    for (const { shot, episodeId } of shots) {
        for (const cue of shot.cues ?? []) add(cue, String(shot.id), episodeId);
        for (const cue of shot.audioCues ?? []) add(cue, String(shot.id), episodeId);
    }
    return rows;
}

function deliverableShotIds(deliverable) {
    const ids = new Set();
    const push = (value) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            for (const item of value) push(item);
            return;
        }
        ids.add(String(value));
    };
    push(deliverable.shotIds);
    push(deliverable.shots);
    for (const clip of deliverable.clips ?? []) {
        if (clip && typeof clip === "object" && clip.shotId !== undefined && clip.shotId !== null) ids.add(String(clip.shotId));
    }
    return [...ids];
}

function flattenDeliverables(project) {
    const byId = new Map();
    const add = (deliverable, fallbackEpisodeId) => {
        if (!deliverable || typeof deliverable !== "object" || deliverable.id === undefined || deliverable.id === null) return;
        const id = String(deliverable.id);
        if (byId.has(id)) return;
        byId.set(id, {
            deliverable,
            id,
            episodeId: deliverable.episodeId !== undefined && deliverable.episodeId !== null ? String(deliverable.episodeId) : fallbackEpisodeId ?? null,
            shotIds: deliverableShotIds(deliverable),
        });
    };
    for (const deliverable of project.deliverables ?? []) add(deliverable, null);
    for (const episode of project.episodes ?? []) {
        if (!episode || typeof episode !== "object") continue;
        for (const deliverable of episode.deliverables ?? []) add(deliverable, episode.id ?? null);
        // ep.deliverableIds 是对 project.deliverables 的引用；已在上方登记，这里回填归属集。
        for (const id of episode.deliverableIds ?? []) {
            const known = byId.get(String(id));
            if (known && !known.episodeId) known.episodeId = episode.id ?? null;
        }
    }
    return [...byId.values()];
}

/* ------------------------------------------------------------------ *
 * 4. plan：影响范围 + 分支重跑计划
 * ------------------------------------------------------------------ */

function reasonKey(entry) {
    const changed = entry.changed ?? {};
    return `${changed.type ?? ""}|${changed.id ?? ""}|${changed.revision ?? ""}|${entry.via ?? ""}`;
}

/**
 * 依据依赖关系算出受影响的 镜 / 场 / 集 / 音频 Cue / 交付物。
 *
 * @param {object}  args
 * @param {object}  args.project           普通对象：{ episodes[], assetRefs?, cues?, deliverables? }
 * @param {string}  [args.sourceRevisionId] 本次分支的源基线 revision（原样回显，供分支 run 记录）
 * @param {Array}   args.changed           [{ type:'assetRef'|'script'|'storyboard'|'shotCamera', id, revision }]
 * @returns {{ stale:string[], keep:string[], reasons:object, staleShots:string[], staleScenes:string[],
 *            staleEpisodes:string[], staleCues:string[], staleDeliverables:string[], warnings:string[],
 *            sourceRevisionId:string|null }}
 */
export function plan({ project, sourceRevisionId = null, changed = [] } = {}) {
    const proj = project && typeof project === "object" ? project : {};
    const assetRefs = Array.isArray(proj.assetRefs) ? proj.assetRefs : [];
    const episodes = flattenEpisodes(proj);
    const scenes = flattenScenes(proj);
    const shots = flattenShots(proj);
    const cues = flattenCues(proj, shots);
    const deliverables = flattenDeliverables(proj);

    const staleShots = new Set();
    const staleScenes = new Set();
    const staleEpisodes = new Set();
    const staleCues = new Set();
    const staleDeliverables = new Set();
    const reasons = new Map(); // id -> Map(reasonKey -> entry)
    const warnings = [];

    const note = (id, entry) => {
        let bucket = reasons.get(id);
        if (!bucket) {
            bucket = new Map();
            reasons.set(id, bucket);
        }
        const key = reasonKey(entry);
        if (!bucket.has(key)) bucket.set(key, entry);
    };
    const addShot = (id, entry) => {
        staleShots.add(String(id));
        note(String(id), entry);
    };
    const addScene = (id, entry) => {
        staleScenes.add(String(id));
        note(String(id), entry);
    };
    const addEpisode = (id, entry) => {
        staleEpisodes.add(String(id));
        note(String(id), entry);
    };
    const addCue = (id, entry) => {
        staleCues.add(String(id));
        note(String(id), entry);
    };
    const addDeliverable = (id, entry) => {
        staleDeliverables.add(String(id));
        note(String(id), entry);
    };

    const cuesOfShot = (shotId) => cues.filter((cue) => cue.shotId === String(shotId));
    const deliverablesOfShot = (shotId) => deliverables.filter((deliverable) => deliverable.shotIds.includes(String(shotId)));
    const deliverablesOfEpisode = (episodeId) => deliverables.filter((deliverable) => deliverable.episodeId === String(episodeId));
    const cuesOfEpisode = (episodeId) => cues.filter((cue) => cue.episodeId === String(episodeId));

    // 镜头 → 该镜的 Cue、包含该镜的成片，一并失效（规则 3：下游按依赖失效）。
    const cascadeShot = (shotId, entry) => {
        addShot(shotId, entry);
        for (const cue of cuesOfShot(shotId)) addCue(cue.id, { ...entry, via: "cue-of-shot" });
        for (const deliverable of deliverablesOfShot(shotId)) addDeliverable(deliverable.id, { ...entry, via: "deliverable-of-shot" });
    };
    const cascadeScene = (sceneId, entry) => {
        addScene(sceneId, entry);
        for (const row of shots.filter((item) => item.sceneId === String(sceneId))) cascadeShot(row.shot.id, { ...entry, via: "shot-of-scene" });
    };
    const cascadeEpisode = (episodeId, entry) => {
        addEpisode(episodeId, entry);
        for (const scene of scenes.filter((item) => item.episodeId === String(episodeId))) cascadeScene(scene.scene.id, { ...entry, via: "scene-of-episode" });
        for (const row of shots.filter((item) => item.episodeId === String(episodeId))) {
            if (!staleShots.has(String(row.shot.id))) cascadeShot(row.shot.id, { ...entry, via: "shot-of-episode" });
        }
        for (const cue of cuesOfEpisode(episodeId)) addCue(cue.id, { ...entry, via: "cue-of-episode" });
        for (const deliverable of deliverablesOfEpisode(episodeId)) addDeliverable(deliverable.id, { ...entry, via: "deliverable-of-episode" });
    };

    const changedList = Array.isArray(changed) ? changed : [];
    for (const item of changedList) {
        if (!item || typeof item !== "object") continue;
        const type = item.type === undefined || item.type === null ? "" : String(item.type);
        const rawId = item.id === undefined || item.id === null ? "" : String(item.id);
        if (!rawId) {
            warnings.push(`changed 项缺少 id：${JSON.stringify(item)}`);
            continue;
        }
        const changedRef = { type, id: rawId, revision: item.revision ?? null };

        if (type === "script") {
            // 剧本是 storyboard 的上游根输入：下游整体失效（规则 2 先给用户看完整范围）。
            for (const episode of episodes) cascadeEpisode(episode.id, { changed: changedRef, via: "root", note: "剧本变更，下游整体失效" });
            for (const row of shots) if (!staleShots.has(String(row.shot.id))) cascadeShot(row.shot.id, { changed: changedRef, via: "root", note: "剧本变更，下游整体失效" });
            for (const cue of cues) if (!staleCues.has(cue.id)) addCue(cue.id, { changed: changedRef, via: "root", note: "剧本变更，下游整体失效" });
            for (const deliverable of deliverables) if (!staleDeliverables.has(deliverable.id)) addDeliverable(deliverable.id, { changed: changedRef, via: "root", note: "剧本变更，下游整体失效" });
            continue;
        }

        if (type === "assetRef") {
            const keys = resolveKeys([rawId], assetRefs);
            // 场景类资产（场地母版/关键视角）变更时，其所在场的镜头一并失效；
            // 角色/道具类资产只失效「直接引用该锚点」的镜头（§12：改主角三视图不重跑整部剧）。
            const sceneAssetKeys = new Set();
            for (const ref of assetRefs) {
                if (!ref || ref.role !== "scene") continue;
                const refId = ref.id === undefined || ref.id === null ? null : String(ref.id);
                const binding = ref.bindingId === undefined || ref.bindingId === null ? null : String(ref.bindingId);
                if ((refId && keys.has(refId)) || (binding && keys.has(binding))) {
                    if (refId) sceneAssetKeys.add(refId);
                    if (binding) sceneAssetKeys.add(binding);
                }
            }
            for (const row of shots) {
                if (overlaps(shotRefKeys(row.shot, assetRefs), keys)) cascadeShot(row.shot.id, { changed: changedRef, via: "asset-dependency", note: `镜头引用资产 ${rawId}` });
            }
            for (const row of scenes) {
                const refs = sceneRefKeys(row.scene, assetRefs);
                if (!overlaps(refs, keys)) continue;
                if (sceneAssetKeys.size && overlaps(refs, sceneAssetKeys)) cascadeScene(row.scene.id, { changed: changedRef, via: "asset-dependency", note: `场引用场景资产 ${rawId}` });
                else addScene(row.scene.id, { changed: changedRef, via: "asset-dependency", note: `场引用资产 ${rawId}` });
            }
            for (const cue of cues) {
                if (cue.characterId && keys.has(cue.characterId)) addCue(cue.id, { changed: changedRef, via: "asset-dependency", note: `对白 Cue 绑定资产 ${rawId}` });
            }
            continue;
        }

        if (type === "shotCamera" || type === "storyboard") {
            const via = type === "shotCamera" ? "shot-camera" : "storyboard";
            const noteText = type === "shotCamera" ? "本镜机位变更" : "分镜变更";
            const entry = { changed: changedRef, via, note: noteText };
            const shotHit = shots.find((row) => String(row.shot.id) === rawId);
            const sceneHit = scenes.find((row) => String(row.scene.id) === rawId);
            const episodeHit = episodes.find((episode) => String(episode.id) === rawId);
            if (shotHit) cascadeShot(rawId, entry);
            else if (sceneHit) cascadeScene(rawId, entry);
            else if (episodeHit) cascadeEpisode(rawId, entry);
            else warnings.push(`${type} 变更指向不存在的对象：${rawId}`);
            continue;
        }

        // 未知 type：按对象 id 解析，能定位就按包含关系级联；定位不到则记 warning，不误伤。
        const shotHit = shots.find((row) => String(row.shot.id) === rawId);
        const sceneHit = scenes.find((row) => String(row.scene.id) === rawId);
        const episodeHit = episodes.find((episode) => String(episode.id) === rawId);
        const entry = { changed: changedRef, via: "unknown-type", note: `未知变更类型 ${type}` };
        if (shotHit) cascadeShot(rawId, entry);
        else if (sceneHit) cascadeScene(rawId, entry);
        else if (episodeHit) cascadeEpisode(rawId, entry);
        else warnings.push(`未知变更类型 ${type}：${rawId}`);
    }

    const staleShotIds = [...staleShots];
    const stale = [...staleShotIds, ...staleScenes, ...staleEpisodes, ...staleCues, ...staleDeliverables];
    const keep = shots.filter((row) => !staleShots.has(String(row.shot.id))).map((row) => String(row.shot.id));

    return {
        sourceRevisionId: sourceRevisionId ?? null,
        stale,
        keep,
        staleShots: staleShotIds,
        staleScenes: [...staleScenes],
        staleEpisodes: [...staleEpisodes],
        staleCues: [...staleCues],
        staleDeliverables: [...staleDeliverables],
        reasons: Object.fromEntries([...reasons].map(([id, bucket]) => [id, [...bucket.values()]])),
        warnings,
    };
}

/* ------------------------------------------------------------------ *
 * 5. isReusable：规则 3 复用判定（doc §11.5.3 原文）
 * ------------------------------------------------------------------ */

/**
 * 只有「输入指纹相同 + 上游 Artifact 选择相同（output.selectedArtifactId 存在）+ Tool 参数相同（由指纹覆盖）」
 * 且产物已完成，才允许复用；否则标记 stale。
 */
export function isReusable(output, input) {
    if (!output || typeof output !== "object") return false;
    return output.inputFingerprint === fingerprint(input) && output.status === "done" && Boolean(output.selectedArtifactId);
}

/* ------------------------------------------------------------------ *
 * 6. markStale：不可变地把受影响对象标为 stale
 * ------------------------------------------------------------------ */

function markDeliverableIfHit(deliverable, keys, staleShotIds) {
    if (!deliverable || typeof deliverable !== "object") return deliverable;
    const id = deliverable.id === undefined || deliverable.id === null ? null : String(deliverable.id);
    const hit = id !== null && keys.has(id) ? true : deliverableShotIds(deliverable).some((shotId) => staleShotIds.has(shotId));
    if (!hit || deliverable.status === "stale") return deliverable;
    return { ...deliverable, status: "stale" };
}

function markCueIfHit(cue, keys, staleShotIds, fallbackShotId) {
    if (!cue || typeof cue !== "object") return cue;
    const id = cue.id === undefined || cue.id === null ? null : String(cue.id);
    const characterId = cue.characterId === undefined || cue.characterId === null ? null : String(cue.characterId);
    const shotId = cue.shotId !== undefined && cue.shotId !== null ? String(cue.shotId) : fallbackShotId;
    const hit = (id !== null && keys.has(id)) || (characterId !== null && keys.has(characterId)) || (shotId !== null && staleShotIds.has(shotId));
    if (!hit || cue.status === "stale") return cue;
    return { ...cue, status: "stale" };
}

/**
 * 把依赖 changedIds 的对象标为 stale —— 不改原对象，返回新对象（浅拷贝 + 只改必要层级）。
 *
 * @param {object} project
 * @param {Array|string} changedIds  变更的 bindingId / 对象 id（也接受 changed[] 形状）
 * @returns {object} 新的 project（原对象及其未被影响的子对象保持引用不变）
 */
export function markStale(project, changedIds) {
    if (!project || typeof project !== "object") return project;
    const ids = toIdList(changedIds);
    const assetRefs = Array.isArray(project.assetRefs) ? project.assetRefs : [];
    const keys = resolveKeys(ids, assetRefs);

    // 1) 先算受影响集合（只读遍历，不碰原对象）。
    const staleShotIds = new Set();
    for (const episode of project.episodes ?? []) {
        if (!episode || typeof episode !== "object") continue;
        const episodeChanged = keys.has(String(episode.id));
        for (const { shot } of shotsOfEpisode(episode)) {
            if (episodeChanged || shotDependsOnKeys(shot, keys, assetRefs)) staleShotIds.add(String(shot.id));
        }
    }
    const staleSceneIds = new Set();
    for (const episode of project.episodes ?? []) {
        if (!episode || typeof episode !== "object") continue;
        const episodeChanged = keys.has(String(episode.id));
        for (const scene of episode.scenes ?? []) {
            if (!scene || typeof scene !== "object" || scene.id === undefined || scene.id === null) continue;
            if (episodeChanged || keys.has(String(scene.id)) || overlaps(sceneRefKeys(scene, assetRefs), keys)) staleSceneIds.add(String(scene.id));
        }
    }

    // 2) 生成新对象：只叶子改动，未受影响的子对象原样复用。
    const nextAssetRefs = assetRefs.map((ref) => {
        if (!ref || typeof ref !== "object") return ref;
        const hit = (ref.bindingId !== undefined && ref.bindingId !== null && keys.has(String(ref.bindingId)))
            || (ref.id !== undefined && ref.id !== null && keys.has(String(ref.id)));
        return hit && ref.status !== "stale" ? { ...ref, status: "stale" } : ref;
    });
    const assetRefsChanged = nextAssetRefs.some((ref, index) => ref !== assetRefs[index]);

    const nextEpisodes = (project.episodes ?? []).map((episode) => {
        if (!episode || typeof episode !== "object") return episode;
        const episodeStale = keys.has(String(episode.id)) && episode.status !== "stale";

        const nextScenes = Array.isArray(episode.scenes) ? episode.scenes.map((scene) => {
            if (!scene || typeof scene !== "object") return scene;
            const sceneStale = staleSceneIds.has(String(scene.id)) && scene.status !== "stale";
            const nextSceneShots = Array.isArray(scene.shots) ? scene.shots.map((shot) => (
                shot && typeof shot === "object" && staleShotIds.has(String(shot.id)) && shot.status !== "stale" ? { ...shot, status: "stale" } : shot
            )) : scene.shots;
            const sceneShotsChanged = Array.isArray(scene.shots) && nextSceneShots.some((shot, index) => shot !== scene.shots[index]);
            if (!sceneStale && !sceneShotsChanged) return scene;
            const patch = {};
            if (sceneShotsChanged) patch.shots = nextSceneShots;
            if (sceneStale) patch.status = "stale";
            return { ...scene, ...patch };
        }) : episode.scenes;
        const scenesChanged = Array.isArray(episode.scenes) && nextScenes.some((scene, index) => scene !== episode.scenes[index]);

        const nextShots = Array.isArray(episode.shots) ? episode.shots.map((shot) => (
            shot && typeof shot === "object" && staleShotIds.has(String(shot.id)) && shot.status !== "stale" ? { ...shot, status: "stale" } : shot
        )) : episode.shots;
        const shotsChanged = Array.isArray(episode.shots) && nextShots.some((shot, index) => shot !== episode.shots[index]);

        const nextCues = Array.isArray(episode.cues) ? episode.cues.map((cue) => markCueIfHit(cue, keys, staleShotIds, null)) : episode.cues;
        const cuesChanged = Array.isArray(episode.cues) && nextCues.some((cue, index) => cue !== episode.cues[index]);
        const nextDeliverables = Array.isArray(episode.deliverables) ? episode.deliverables.map((deliverable) => markDeliverableIfHit(deliverable, keys, staleShotIds)) : episode.deliverables;
        const deliverablesChanged = Array.isArray(episode.deliverables) && nextDeliverables.some((deliverable, index) => deliverable !== episode.deliverables[index]);

        const patch = {};
        if (scenesChanged) patch.scenes = nextScenes;
        if (shotsChanged) patch.shots = nextShots;
        if (cuesChanged) patch.cues = nextCues;
        if (deliverablesChanged) patch.deliverables = nextDeliverables;
        if (episodeStale) patch.status = "stale";
        if (!Object.keys(patch).length) return episode;
        return { ...episode, ...patch };
    });
    const episodesChanged = nextEpisodes.some((episode, index) => episode !== (project.episodes ?? [])[index]);

    const nextCues = Array.isArray(project.cues) ? project.cues.map((cue) => markCueIfHit(cue, keys, staleShotIds, null)) : project.cues;
    const cuesChanged = Array.isArray(project.cues) && nextCues.some((cue, index) => cue !== project.cues[index]);
    const nextDeliverables = Array.isArray(project.deliverables) ? project.deliverables.map((deliverable) => markDeliverableIfHit(deliverable, keys, staleShotIds)) : project.deliverables;
    const deliverablesChanged = Array.isArray(project.deliverables) && nextDeliverables.some((deliverable, index) => deliverable !== project.deliverables[index]);

    const patch = {};
    if (assetRefsChanged) patch.assetRefs = nextAssetRefs;
    if (episodesChanged) patch.episodes = nextEpisodes;
    if (cuesChanged) patch.cues = nextCues;
    if (deliverablesChanged) patch.deliverables = nextDeliverables;
    if (!Object.keys(patch).length) return { ...project };
    return { ...project, ...patch };
}

export default { fingerprint, plan, isReusable, markStale, shotDependsOn };

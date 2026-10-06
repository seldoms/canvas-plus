/**
 * 素材一致性体检（read-only）——人工干预前的「保险」，不是修复工具。
 *
 * ## 为什么需要它
 *
 * 2026-10-06 实测踩过的坑：keyframe 门禁报 `scene:内景（no-ref）`，追下去发现
 * **四处数据源口径不一致**：
 *
 *   shot.sceneId → script.scenes → scene.location → design.locations.name
 *     → shot.locationId → assetRefs[role=scene].bindingId
 *
 * 任何一处错位都表现成同一个 `no-ref`。而这类不一致**不会报错、不会告警**：
 * 每条数据单独看都合法，只是写法不同，系统自己发现��了，只能靠人看出来。
 * 同一个项目里还实测到「同一个角色有两条 assetRef（`陈默` 指向旧图、`ch_001` 指向新图）」，
 * 选参考图时会**随机命中其中一条**。
 *
 * ## 刻意只读、只报、不改
 *
 * 诊断与处置必须分开。若这个工具顺手改数据，它自己就成了新的写入源——
 * 下次别的 Agent 照样会乱，而你会失去「哪里被动过」的可追溯性。
 * 修复一律走各阶段的正规入口（`asset-refs/:refId/select`、`steps/:stage/input` 等）。
 */

/** 体检发现的问题严重度。error = 已经影响出图；warn = 会导致选图随机命中。 */
/** @typedef {"error"|"warn"} IssueSeverity */

/** 一条问题：说清「哪里不一致」与「会影响什么」，而不是只报个错。 */
/**
 * @typedef {Object} ConsistencyIssue
 * @property {IssueSeverity} severity
 * @property {"duplicate-binding"|"binding-mismatch"|"orphan-ref"|"unresolved-binding"} kind
 * @property {string} message
 * @property {string[]} refIds
 * @property {string[]} shotIds
 */

/** 体检输入：只要这几组事实，不需要 IO。 */
/**
 * @typedef {Object} ConsistencyInput
 * @property {Array<Record<string, unknown>>} assetRefs
 * @property {Array<Record<string, unknown>>} scenes
 * @property {Array<Record<string, unknown>>} locations
 * @property {Array<Record<string, unknown>>} shots
 * @property {Array<Record<string, unknown>>} characters
 */

const text = (value) => (typeof value === "string" ? value.trim() : "");
const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

/** 「陈默家客厅·日」→ 地点名「陈默家客厅」。assetRefs 登记时常用「地点·时间」，而门禁按纯地点名匹配。 */
function baseName(bindingId) {
    const trimmed = bindingId.trim();
    const dot = trimmed.indexOf("·");
    return dot > 0 ? trimmed.slice(0, dot).trim() : trimmed;
}

/** 归一：用于判断「是不是同一个东西」。全角空格、首尾空白都抹平。 */
function normalizeKey(value) {
    return value.replace(/\s+/g, " ").trim();
}

/**
 * 跑一次体检。纯函数：不写任何文件、不改任何状态。
 *
 * 检查四类问题：
 *   1. duplicate-binding：同一 role 下同一个 bindingId 有多条 assetRef
 *      ——选参考图时会随机命中其中一条（实测踩过）。
 *   2. binding-mismatch：assetRef 的 bindingId 带「·时间」后缀，
 *      而门禁按纯地点名匹配 —— 必然查不到（实测踩过，报 no-ref）。
 *   3. orphan-ref：assetRef 的 bindingId 在 script 场次里根本没有对应地点
 *      —— 多半是场景改名/删场后没清。
 *   4. unresolved-binding：镜头能推导出地点名，但没有任何 assetRef 绑到它
 *      —— 这一镜会直接被门禁挡住。
 */
export function checkAssetConsistency(input) {
    const issues = [];
    const refs = Array.isArray(input.assetRefs) ? input.assetRefs.map(record).filter(Boolean) : [];
    const scenes = Array.isArray(input.scenes) ? input.scenes.map(record).filter(Boolean) : [];
    const locations = Array.isArray(input.locations) ? input.locations.map(record).filter(Boolean) : [];
    const shots = Array.isArray(input.shots) ? input.shots.map(record).filter(Boolean) : [];
    const characters = Array.isArray(input.characters) ? input.characters.map(record).filter(Boolean) : [];

    // —— ① 同一 role + bindingId 重复登记：选图会随机命中 ——
    const groups = new Map();
    for (const ref of refs) {
        const role = text(ref.role);
        const bindingId = text(ref.bindingId);
        if (!role || !bindingId) continue;
        const key = `${role}::${normalizeKey(bindingId)}`;
        groups.set(key, [...(groups.get(key) ?? []), ref]);
    }
    for (const [key, group] of groups) {
        if (group.length < 2) continue;
        const [role, bindingId] = key.split("::");
        issues.push({
            severity: "warn",
            kind: "duplicate-binding",
            message: `${role}「${bindingId}」登记了${group.length} 条资产引用，选参考图时会随机命中其中一条；建议只保留实际在用的那条。`,
            refIds: group.map((ref) => text(ref.id)).filter(Boolean),
            shotIds: [],
        });
    }

    // —— ② bindingId 带「·时间」后缀，门禁按纯名匹配必然查不到 ——
    const locationNames = new Set(locations.map((entry) => normalizeKey(text(entry.name) || text(entry.location))).filter(Boolean));
    const sceneLocations = new Set(scenes.map((entry) => normalizeKey(text(entry.location))).filter(Boolean));
    for (const ref of refs) {
        if (text(ref.role) !== "scene") continue;
        const bindingId = text(ref.bindingId);
        if (!bindingId.includes("·")) continue;
        const base = normalizeKey(baseName(bindingId));
        // 只有当「纯地点名」确实是已知地点时才算口径问题（否则归到 orphan）
        if (locationNames.has(base) || sceneLocations.has(base)) {
            issues.push({
                severity: "error",
                kind: "binding-mismatch",
                message: `场景「${bindingId}」的 bindingId 带「·时间」后缀，而门禁按纯地点名「${base}」匹配，必然查不到。`,
                refIds: [text(ref.id)].filter(Boolean),
                shotIds: [],
            });
        }
    }

    // —— ③ assetRef 的地点在script 场次里不存在 ——
    const knownLocations = new Set([...locationNames, ...sceneLocations]);
    for (const ref of refs) {
        if (text(ref.role) !== "scene") continue;
        const base = normalizeKey(baseName(text(ref.bindingId)));
        if (!base || knownLocations.has(base)) continue;
        issues.push({
            severity: "warn",
            kind: "orphan-ref",
            message: `场景资产「${text(ref.bindingId)}」在剧本场次里没有对应地点，多半是场景改名后没清理。`,
            refIds: [text(ref.id)].filter(Boolean),
            shotIds: [],
        });
    }

    // —— ④ 角色同时以「名字」和「id」两种 key 登记（实测踩过）——
    // 按人物表把每条角色引用归到「同一个人」，若一个人出现两种 key 就是口径混乱。
    const characterKeys = new Map();
    for (const ref of refs) {
        if (text(ref.role) !== "character") continue;
        const bindingId = normalizeKey(text(ref.bindingId));
        if (!bindingId) continue;
        const owner = characters.map((character) => ({ id: text(character.id), name: text(character.name) })).find((entry) => entry.id === bindingId || entry.name === bindingId);
        if (!owner) continue;
        const bucket = characterKeys.get(owner.id) ?? { name: owner.name, keys: new Set() };
        bucket.keys.add(bindingId);
        characterKeys.set(owner.id, bucket);
    }
    for (const [characterId, bucket] of characterKeys) {
        if (bucket.keys.size < 2) continue;
        issues.push({
            severity: "warn",
            kind: "duplicate-binding",
            message: `角色 ${bucket.name ? `「${bucket.name}」` : `(${characterId})`} 同时以 ${[...bucket.keys].map((key) => `「${key}」`).join(" 与 ")} 两种 key 登记，选定妆照会随机命中其中一条。`,
            refIds: refs.filter((ref) => text(ref.role) === "character" && bucket.keys.has(normalizeKey(text(ref.bindingId)))).map((ref) => text(ref.id)).filter(Boolean),
            shotIds: [],
        });
    }

    // —— ⑤ 镜头能推出地点名，但没有 assetRef 绑到它（这一镜会被门禁挡住）——
    const boundLocations = new Set(
        refs.filter((ref) => text(ref.role) === "scene").map((ref) => normalizeKey(baseName(text(ref.bindingId)))).filter(Boolean),
    );
    const missingByLocation = new Map();
    for (const shot of shots) {
        const locationId = normalizeKey(text(shot.locationId));
        if (!locationId || locationId === "内景" || locationId === "外景") continue;
        if (boundLocations.has(locationId)) continue;
        missingByLocation.set(locationId, [...(missingByLocation.get(locationId) ?? []), text(shot.id)].filter(Boolean));
    }
    for (const [locationId, shotIds] of missingByLocation) {
        issues.push({
            severity: "error",
            kind: "unresolved-binding",
            message: `镜头用到的场景「${locationId}」没有任何资产引用，这 ${shotIds.length} 个镜头会被关键帧门禁挡住（报缺参考图）。`,
            refIds: [],
            shotIds,
        });
    }

    // 排序：先 error 后 warn，同severity 内按 kind 稳定排 —— 让界面每次刷新顺序一致。
    const severityOrder = { error: 0, warn: 1 };
    return issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message));
}

/**
 * 一句话摘要，给界面顶部用。返回「无问题」或「N 个错误 / M 个提醒」。
 */
export function summarizeConsistency(issues) {
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.length - errors;
    const text = !issues.length ? "素材口径一致，无问题。" : errors ? `${errors} 个会影响出图的问题、${warnings} 个提醒。` : `${warnings} 个提醒。`;
    return { ok: !issues.length, errors, warnings, text };
}
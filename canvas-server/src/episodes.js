import { ID_PREFIX } from "./contracts.js";
import { safeJoin } from "./files.js";

/**
 * Episode / Scene / Shot 存储内核（P0-a 深水区）。
 * 只做目录读写 + 校验 + 纯函数，不依赖 HTTP；路由接线在 index.js。
 * 共享原语（ulid / 原子写 / project 读写）由 projects.js 在建栈时注入，避免与 projects.js 循环依赖。
 *
 * 布局：data/projects/<pid>/episodes/<epId>.json = 一集（Episode + 内嵌 scenes[] / shots[]）。
 * 稳定 ID 规则（契约 §4）：ep_/sc_ 为 4 位序号，sh_ 创建时生成（ULID）；重排只改 index，绝不改 id。
 */

const EPISODE_ID = new RegExp(`^${ID_PREFIX.episode}\\d{4}$`);
const pad4 = (value) => String(value).padStart(4, "0");

/** 取一批形如 sc_0007 的 id 的最大序号（无则 0）。 */
function maxSeq(ids, prefix) {
    let max = 0;
    for (const id of ids || []) {
        const text = String(id ?? "");
        if (!text.startsWith(prefix)) continue;
        const value = Number(text.slice(prefix.length));
        if (Number.isInteger(value) && value > max) max = value;
    }
    return max;
}

export function createEpisodes(store) {
    const { ulid, nowIso, badRequest, httpError, requireArray, requireProject, persistProject, readJson, writeJsonAtomic } = store;

    const episodeFile = (dir, episodeId) => safeJoin(dir, "episodes", `${String(episodeId)}.json`);
    const summary = (episode) => ({ id: episode.id, index: episode.index, title: episode.title, status: episode.status });

    /** 集 id：显式给定必须合法；否则取现有索引最大序号 + 1。 */
    function nextEpisodeId(project) {
        const max = maxSeq((project.episodes || []).map((item) => item.id), ID_PREFIX.episode);
        return ID_PREFIX.episode + pad4(max + 1);
    }

    /** 写请求引用的集必须存在，否则按非法引用 400（不合法一律 400 且信息可读）。 */
    function requireEpisode(projectId, episodeId) {
        const { project, dir } = requireProject(projectId);
        const id = String(episodeId ?? "");
        const episode = readJson(episodeFile(dir, id));
        if (!episode) throw badRequest(`集不存在：${id}`);
        return { project, dir, episode };
    }

    /** 把集索引并回 project.json（project.episodes 只存 id/index/title/status）。 */
    function syncIndex(dir, project, episode) {
        project.episodes = [...(project.episodes || []).filter((item) => item.id !== episode.id), summary(episode)].sort((a, b) => a.index - b.index);
        return persistProject(dir, project);
    }

    /** 建集 / 覆盖写一集（保留已有 scenes/shots）。 */
    function save(projectId, input = {}) {
        const { project, dir } = requireProject(projectId);
        const body = input && typeof input === "object" ? input : {};
        const explicit = String(body.id ?? "").trim();
        if (explicit && !EPISODE_ID.test(explicit)) throw badRequest("集 id 必须是 ep_ + 4 位序号");
        const id = explicit || nextEpisodeId(project);
        const prev = readJson(episodeFile(dir, id)) || {};
        const indexed = Number(body.index);
        const episode = {
            id,
            projectId: project.id,
            index: indexed > 0 ? indexed : prev.index || (project.episodes?.length || 0) + 1,
            title: String(body.title ?? prev.title ?? "").trim() || id,
            logline: body.logline !== undefined ? String(body.logline) : prev.logline ?? "",
            plan: body.plan !== undefined ? body.plan : prev.plan ?? {},
            sceneIds: requireArray(body.sceneIds ?? prev.sceneIds ?? [], "sceneIds"),
            canvasIds: requireArray(body.canvasIds ?? prev.canvasIds ?? [], "canvasIds"),
            status: String(body.status ?? prev.status ?? "pending"),
            deliverableIds: requireArray(body.deliverableIds ?? prev.deliverableIds ?? [], "deliverableIds"),
            scenes: requireArray(prev.scenes ?? [], "scenes"),
            shots: requireArray(prev.shots ?? [], "shots"),
        };
        writeJsonAtomic(episodeFile(dir, id), episode);
        syncIndex(dir, project, episode);
        return { episode, project };
    }

    function get(projectId, episodeId) {
        const { dir } = requireProject(projectId);
        return readJson(episodeFile(dir, episodeId));
    }

    function list(projectId) {
        const { project } = requireProject(projectId);
        return project.episodes || [];
    }

    /** 读全部集详情（含内嵌 scenes/shots），供 context / gates 组装。 */
    function listDetails(projectId) {
        const { dir } = requireProject(projectId);
        const rows = [];
        for (const item of list(projectId)) {
            const episode = readJson(episodeFile(dir, item.id));
            if (episode) rows.push(episode);
        }
        return rows;
    }

    const EPISODE_MUTABLE = new Set(["title", "index", "logline", "plan", "status", "canvasIds", "deliverableIds"]);

    function update(projectId, episodeId, patch = {}) {
        const { project, dir, episode } = requireEpisode(projectId, episodeId);
        const body = patch && typeof patch === "object" ? patch : {};
        for (const key of Object.keys(body)) if (!EPISODE_MUTABLE.has(key)) throw badRequest(`未知字段：${key}`);
        if (body.title !== undefined) {
            const title = String(body.title).trim();
            if (!title) throw badRequest("集标题不能为空");
            episode.title = title;
        }
        if (body.index !== undefined) {
            const index = Number(body.index);
            if (!(index > 0)) throw badRequest("index 必须是正数");
            episode.index = index;
        }
        if (body.logline !== undefined) episode.logline = String(body.logline);
        if (body.plan !== undefined) episode.plan = body.plan ?? {};
        if (body.status !== undefined) episode.status = String(body.status);
        if (body.canvasIds !== undefined) episode.canvasIds = requireArray(body.canvasIds, "canvasIds");
        if (body.deliverableIds !== undefined) episode.deliverableIds = requireArray(body.deliverableIds, "deliverableIds");
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { episode, project };
    }

    /** 场 id：序号在项目内全局唯一（sc_ + 4 位），避免不同集出现同名 sc_0001 导致按 id 定位歧义。 */
    function nextSceneId(projectId, project, dir) {
        let max = 0;
        for (const item of project.episodes || []) {
            const row = readJson(episodeFile(dir, item.id));
            max = Math.max(max, maxSeq((row?.scenes || []).map((scene) => scene.id), ID_PREFIX.scene));
        }
        return ID_PREFIX.scene + pad4(max + 1);
    }

    /** 在一集内新建场：locationId / time / intent 必填（契约 §3.3）。 */
    function addScene(projectId, episodeId, input = {}) {
        const { project, dir, episode } = requireEpisode(projectId, episodeId);
        const body = input && typeof input === "object" ? input : {};
        const locationId = String(body.locationId ?? "").trim();
        if (!locationId) throw badRequest("场缺少地点 locationId");
        const time = String(body.time ?? "").trim();
        if (!time) throw badRequest("场缺少时间 time");
        const intent = String(body.intent ?? "").trim();
        if (!intent) throw badRequest("场缺少意图 intent");
        const scenes = requireArray(episode.scenes ?? [], "scenes");
        const id = nextSceneId(projectId, project, dir);
        const indexed = Number(body.index);
        const scene = {
            id,
            episodeId: episode.id,
            index: indexed > 0 ? indexed : scenes.length + 1,
            locationId,
            time,
            intent,
            beatIds: requireArray(body.beatIds ?? [], "beatIds"),
        };
        episode.scenes = [...scenes, scene];
        episode.sceneIds = episode.scenes.map((item) => item.id);
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { scene, episode };
    }

    const SCENE_MUTABLE = new Set(["index", "locationId", "time", "intent", "beatIds"]);

    function updateScene(projectId, sceneId, patch = {}) {
        const found = findScene(projectId, sceneId);
        if (!found) throw badRequest(`场不存在：${sceneId}`);
        const { project, dir, episode, scene } = found;
        const body = patch && typeof patch === "object" ? patch : {};
        for (const key of Object.keys(body)) if (!SCENE_MUTABLE.has(key)) throw badRequest(`未知字段：${key}`);
        if (body.index !== undefined) {
            const index = Number(body.index);
            if (!(index > 0)) throw badRequest("index 必须是正数");
            scene.index = index;
        }
        if (body.locationId !== undefined) {
            const value = String(body.locationId).trim();
            if (!value) throw badRequest("场缺少地点 locationId");
            scene.locationId = value;
        }
        if (body.time !== undefined) {
            const value = String(body.time).trim();
            if (!value) throw badRequest("场缺少时间 time");
            scene.time = value;
        }
        if (body.intent !== undefined) {
            const value = String(body.intent).trim();
            if (!value) throw badRequest("场缺少意图 intent");
            scene.intent = value;
        }
        if (body.beatIds !== undefined) scene.beatIds = requireArray(body.beatIds, "beatIds");
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { scene, episode };
    }

    /** 新建镜头：id 创建时生成（sh_ + ULID），此后重排不改。sceneId 必须在同一集内。 */
    function addShot(projectId, sceneId, input = {}) {
        const found = findScene(projectId, sceneId);
        if (!found) throw badRequest(`场不存在：${sceneId}`);
        const { project, dir, episode } = found;
        const body = input && typeof input === "object" ? input : {};
        // 目标场必须仍在本集：悬空或跨集一律拒绝（契约 §3.4 代码校验并 join）
        const targetSceneId = body.sceneId !== undefined ? String(body.sceneId) : String(sceneId);
        if (!(episode.scenes || []).some((item) => item.id === targetSceneId)) throw badRequest(`镜头引用的 sceneId 不在本集：${targetSceneId}`);
        const shots = requireArray(episode.shots ?? [], "shots");
        const id = ID_PREFIX.shot + ulid();
        const indexed = Number(body.index);
        const shot = {
            id,
            episodeId: episode.id,
            sceneId: targetSceneId,
            index: indexed > 0 ? indexed : shots.reduce((max, item) => Math.max(max, Number(item.index) || 0), 0) + 1,
            storyboard: body.storyboard ?? {},
            generationSlots: requireArray(body.generationSlots ?? [], "generationSlots"),
            status: String(body.status ?? "pending"),
        };
        episode.shots = [...shots, shot];
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { shot, episode };
    }

    const SHOT_MUTABLE = new Set(["sceneId", "index", "storyboard", "status"]);

    /**
     * 分镜内容字段：前端 `ShotPatchInput` 声明的就是这批平铺字段（durationSec/shotSize/prompt…），
     * 但服务端此前只认 `storyboard` 嵌套对象 —— 于是**前端按自己的类型传平铺字段会被 400 拒**。
     * 这里把平铺字段合并进 shot.storyboard（嵌套对象优先，可显式传 storyboard 覆盖整块），
     * 两个口径都留着，避免再次漂移。
     */
    const SHOT_STORYBOARD_FIELDS = new Set([
        "durationSec",
        "shotSize",
        "camera",
        "cameraSpec",
        "action",
        "dialogue",
        "dialogueLines",
        "audio",
        "prompt",
        "negativePrompt",
        "textOverlays",
    ]);

    function updateShot(projectId, shotId, patch = {}) {
        const found = findShot(projectId, shotId);
        if (!found) throw badRequest(`镜头不存在：${shotId}`);
        const { project, dir, episode, shot } = found;
        const body = patch && typeof patch === "object" ? patch : {};
        for (const key of Object.keys(body)) if (!SHOT_MUTABLE.has(key) && !SHOT_STORYBOARD_FIELDS.has(key)) throw badRequest(`未知字段：${key}`);
        if (body.sceneId !== undefined) {
            const target = String(body.sceneId);
            if (!(episode.scenes || []).some((item) => item.id === target)) throw badRequest(`镜头引用的 sceneId 不在本集：${target}`);
            shot.sceneId = target;
        }
        if (body.index !== undefined) {
            const index = Number(body.index);
            if (!(index > 0)) throw badRequest("index 必须是正数");
            shot.index = index;
        }
        const flat = {};
        for (const key of Object.keys(body)) if (SHOT_STORYBOARD_FIELDS.has(key)) flat[key] = body[key];
        if (Object.keys(flat).length) {
            const base = shot.storyboard && typeof shot.storyboard === "object" ? shot.storyboard : {};
            shot.storyboard = { ...base, ...flat };
        }
        if (body.storyboard !== undefined) shot.storyboard = body.storyboard ?? {};
        if (body.status !== undefined) shot.status = String(body.status);
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { shot, episode };
    }

    /** slotId 规则（契约 §3.5）：slot_<shotId>_<role>；解析出 role，不匹配返回空串。 */
    function slotRoleOf(shotId, slotId) {
        const prefix = `slot_${String(shotId ?? "")}_`;
        const text = String(slotId ?? "");
        if (!text.startsWith(prefix)) return "";
        return text.slice(prefix.length).trim();
    }

    const CONTINUATION_APPROVALS = new Set(["pending", "approved", "rejected", "superseded"]);

    /** 续接扩展字段（契约 §3.6 P1）：写入续接候选时九个字段必须完整（可空），非续接候选不带。 */
    function normalizeContinuationFields(body) {
        const chainId = body.continuationChainId === undefined || body.continuationChainId === null ? null : String(body.continuationChainId);
        const takeId = body.takeId === undefined || body.takeId === null ? null : String(body.takeId);
        if (chainId === null && takeId === null) return {};
        const asNullableId = (value) => (value === undefined || value === null ? null : String(value));
        return {
            takeId,
            parentCandidateId: asNullableId(body.parentCandidateId),
            approvalStatus: CONTINUATION_APPROVALS.has(body.approvalStatus) ? body.approvalStatus : "pending",
            continuationChainId: chainId,
            segmentIndex: Number.isInteger(body.segmentIndex) ? body.segmentIndex : null,
            parentArtifactId: asNullableId(body.parentArtifactId),
            contextArtifactId: asNullableId(body.contextArtifactId),
            latentArtifactId: asNullableId(body.latentArtifactId),
            continuation: body.continuation && typeof body.continuation === "object" ? body.continuation : null,
        };
    }

    /** 候选字段完整性（契约 §3.5）：jobId 必填，形状归一，来源 source 有值才带。 */
    function normalizeSlotCandidate(input) {
        const body = input && typeof input === "object" ? input : {};
        const jobId = String(body.jobId ?? "").trim();
        if (!jobId) throw badRequest("候选缺少 jobId");
        return {
            template: String(body.template ?? ""),
            jobId,
            artifactUrl: body.artifactUrl ?? null,
            status: String(body.status ?? ""),
            ...(body.source ? { source: String(body.source) } : {}),
            createdAt: String(body.createdAt ?? nowIso()),
            ...normalizeContinuationFields(body),
        };
    }

    /**
     * 槽位候选追加（M2）：shot 必须存在；slotId 必须匹配 slot_<shotId>_<role> 规则，
     * 槽位不存在则按规则创建壳（selected:null、candidates:[]）。幂等：同 jobId 不重复追加、不写盘。
     */
    function appendSlotCandidate(projectId, shotId, slotId, input) {
        const found = findShot(projectId, shotId);
        if (!found) throw badRequest(`镜头不存在：${shotId}`);
        const { project, dir, episode, shot } = found;
        const role = slotRoleOf(shot.id, slotId);
        if (!role) throw badRequest(`slotId 必须是 slot_<shotId>_<role>：${slotId}`);
        const candidate = normalizeSlotCandidate(input);
        shot.generationSlots = requireArray(shot.generationSlots ?? [], "generationSlots");
        let slot = shot.generationSlots.find((item) => item.id === String(slotId));
        if (!slot) {
            slot = { id: String(slotId), shotId: shot.id, role, selected: null, candidates: [] };
            shot.generationSlots = [...shot.generationSlots, slot];
        }
        if ((slot.candidates || []).some((item) => item.jobId === candidate.jobId)) return { slot, episode };
        slot.candidates = [...(Array.isArray(slot.candidates) ? slot.candidates : []), candidate];
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { slot, episode };
    }

    /**
     * 槽位采用（M2）/ 撤销采用（M3）：jobId 必须是该槽位已有候选（否则 404 CANDIDATE_NOT_FOUND）；
     * jobId 为 null 时清空 selected（撤销采用，candidates 不动）。幂等：已是指向 / 已是 null 不写盘。
     */
    function selectSlotCandidate(projectId, shotId, slotId, jobId) {
        const found = findShot(projectId, shotId);
        if (!found) throw badRequest(`镜头不存在：${shotId}`);
        const { project, dir, episode, shot } = found;
        const slot = (shot.generationSlots || []).find((item) => item.id === String(slotId ?? ""));
        if (jobId === null) {
            if (!slot) throw Object.assign(httpError(404, `槽位不存在：${slotId}`), { code: "SLOT_NOT_FOUND", field: "slotId" });
            if (slot.selected != null) {
                slot.selected = null;
                writeJsonAtomic(episodeFile(dir, episode.id), episode);
                syncIndex(dir, project, episode);
            }
            return { slot, episode };
        }
        const id = String(jobId ?? "").trim();
        if (!id) throw badRequest("缺少 jobId");
        const candidate = slot && (slot.candidates || []).find((item) => item.jobId === id);
        if (!slot || !candidate) throw Object.assign(httpError(404, `候选不存在：${id}`), { code: "CANDIDATE_NOT_FOUND", field: "jobId" });
        if (slot.selected !== id) {
            slot.selected = id;
            writeJsonAtomic(episodeFile(dir, episode.id), episode);
            syncIndex(dir, project, episode);
        }
        return { slot, episode };
    }

    /**
     * 候选字段修补（M3.5）：续接编排回写状态/产物/接缝 QC、采用时回写 approvalStatus 走这里。
     * 字段完整性仍归存储层：patch 只允许改已有键或续接扩展键，jobId 不可改；无实际变化不写盘（幂等）。
     */
    function updateSlotCandidate(projectId, shotId, slotId, jobId, patch) {
        const found = findShot(projectId, shotId);
        if (!found) throw badRequest(`镜头不存在：${shotId}`);
        const { project, dir, episode, shot } = found;
        const slot = (shot.generationSlots || []).find((item) => item.id === String(slotId ?? ""));
        const id = String(jobId ?? "").trim();
        if (!id) throw badRequest("缺少 jobId");
        const candidate = slot && (slot.candidates || []).find((item) => item.jobId === id);
        if (!slot || !candidate) throw Object.assign(httpError(404, `候选不存在：${id}`), { code: "CANDIDATE_NOT_FOUND", field: "jobId" });
        let changed = false;
        for (const [key, value] of Object.entries(patch && typeof patch === "object" ? patch : {})) {
            if (key === "jobId") continue;
            if (JSON.stringify(candidate[key] ?? null) === JSON.stringify(value ?? null)) continue;
            candidate[key] = value;
            changed = true;
        }
        if (changed) {
            writeJsonAtomic(episodeFile(dir, episode.id), episode);
            syncIndex(dir, project, episode);
        }
        return { slot, candidate, episode };
    }

    /** 遍历项目所有集，找场/镜所属的集（跨集引用由此可被识别为不在本集）。 */
    function findScene(projectId, sceneId) {
        const { project, dir } = requireProject(projectId);
        const id = String(sceneId ?? "");
        for (const item of project.episodes || []) {
            const episode = readJson(episodeFile(dir, item.id));
            const scene = (episode?.scenes || []).find((row) => row.id === id);
            if (scene) return { project, dir, episode, scene };
        }
        return null;
    }

    function findShot(projectId, shotId) {
        const { project, dir } = requireProject(projectId);
        const id = String(shotId ?? "");
        for (const item of project.episodes || []) {
            const episode = readJson(episodeFile(dir, item.id));
            const shot = (episode?.shots || []).find((row) => row.id === id);
            if (shot) return { project, dir, episode, shot };
        }
        return null;
    }

    /** 重排：只改 index，绝不改任何 id（契约 §4）。传入的 id 必须是本集已有 id 的完整排列。 */
    function reorder(projectId, episodeId, input = {}) {
        const { project, dir, episode } = requireEpisode(projectId, episodeId);
        const body = input && typeof input === "object" ? input : {};
        if (body.sceneIds !== undefined) {
            const ids = requireArray(body.sceneIds, "sceneIds").map(String);
            const have = new Set((episode.scenes || []).map((item) => item.id));
            if (ids.length !== have.size || ids.some((id) => !have.has(id))) throw badRequest("sceneIds 必须是本集场的完整排列");
            const order = new Map(ids.map((id, position) => [id, position + 1]));
            episode.scenes = episode.scenes.map((scene) => ({ ...scene, index: order.get(scene.id) })).sort((a, b) => a.index - b.index);
            episode.sceneIds = episode.scenes.map((scene) => scene.id);
        }
        if (body.shotIds !== undefined) {
            const ids = requireArray(body.shotIds, "shotIds").map(String);
            const have = new Set((episode.shots || []).map((item) => item.id));
            if (ids.length !== have.size || ids.some((id) => !have.has(id))) throw badRequest("shotIds 必须是本集镜头的完整排列");
            const order = new Map(ids.map((id, position) => [id, position + 1]));
            episode.shots = episode.shots.map((shot) => ({ ...shot, index: order.get(shot.id) })).sort((a, b) => a.index - b.index);
        }
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { episode };
    }

    return { save, get, list, listDetails, update, addScene, updateScene, addShot, updateShot, reorder, findScene, findShot, requireEpisode, appendSlotCandidate, selectSlotCandidate, updateSlotCandidate };
}

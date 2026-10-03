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
    const { ulid, badRequest, httpError, requireArray, requireProject, persistProject, readJson, writeJsonAtomic } = store;

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

    function updateShot(projectId, shotId, patch = {}) {
        const found = findShot(projectId, shotId);
        if (!found) throw badRequest(`镜头不存在：${shotId}`);
        const { project, dir, episode, shot } = found;
        const body = patch && typeof patch === "object" ? patch : {};
        for (const key of Object.keys(body)) if (!SHOT_MUTABLE.has(key)) throw badRequest(`未知字段：${key}`);
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
        if (body.storyboard !== undefined) shot.storyboard = body.storyboard ?? {};
        if (body.status !== undefined) shot.status = String(body.status);
        writeJsonAtomic(episodeFile(dir, episode.id), episode);
        syncIndex(dir, project, episode);
        return { shot, episode };
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

    return { save, get, list, listDetails, update, addScene, updateScene, addShot, updateShot, reorder, findScene, findShot, requireEpisode };
}

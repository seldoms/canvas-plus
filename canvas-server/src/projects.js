import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { ID_PREFIX } from "./contracts.js";
import { ensureDir, safeJoin } from "./files.js";
import { createEpisodes } from "./episodes.js";
import { createSources } from "./sources.js";
import { createAssets } from "./assets.js";
import { deriveGates } from "./gates.js";

/**
 * Project 服务端存储内核（P0-a）。
 * 只做目录读写 + 纯函数，不依赖 HTTP；路由接线在 index.js。
 * 目录布局（development-plan §3.2）：
 *   data/projects/<projectId>/project.json          项目元数据、规划、主线索引
 *   data/projects/<projectId>/sources/<revId>.json   不可变源版本
 *   data/projects/<projectId>/episodes/<epId>.json   集详情
 */

/** Crockford Base32（去掉易混的 I / L / O / U）。 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 26 位 ULID 的正则：10 位时间戳 + 16 位随机。 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Plan 必填字段默认值（D8：项目级默认）。 */
const PLAN_DEFAULTS = Object.freeze({ genre: "", tone: "", visualStyle: "", ratio: "9:16", episodeDurationSec: 60, dramaMode: "短剧向", audience: "", episodeCount: 1 });

/**
 * 01 剧本阶段 planSuggestion 可回填的字段白名单。
 * ratio / styleAnchor 不在 01 建议范围内，绝不在此列表里 —— 防止回填越权改动画幅与风格锚点。
 */
const PLAN_SUGGESTION_FIELDS = Object.freeze(["genre", "tone", "visualStyle", "dramaMode", "audience", "episodeCount", "episodeDurationSec"]);

function nowIso() {
    return new Date().toISOString();
}

/** 把非负整数编码成定长 Crockford Base32。 */
function encodeBase32(value, length) {
    const chars = [];
    let current = BigInt(value);
    for (let index = 0; index < length; index += 1) {
        chars.unshift(CROCKFORD[Number(current & 31n)]);
        current >>= 5n;
    }
    return chars.join("");
}

// 同一毫秒内递增随机位，保证 ULID 不重复（等价于标准 ULID 的单调实现，顺带兼容时钟回拨）。
let lastUlidTime = 0;
let lastUlidRandom = 0n;

/** 生成 26 位 ULID：10 位时间戳 + 16 位（80 bit）随机。零依赖，只用 node:crypto 取随机字节。 */
export function ulid() {
    let time = Date.now();
    if (time <= lastUlidTime) {
        time = lastUlidTime;
        lastUlidRandom += 1n;
        if (lastUlidRandom >> 80n) {
            time += 1;
            lastUlidRandom = 0n;
        }
    } else {
        let random = 0n;
        for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
        lastUlidRandom = random;
    }
    lastUlidTime = time;
    return encodeBase32(time, 10) + encodeBase32(lastUlidRandom, 16);
}

/** 补齐 Plan 必填字段；数值字段只接受正数。 */
function normalizePlan(plan) {
    const source = plan && typeof plan === "object" ? plan : {};
    const merged = { ...PLAN_DEFAULTS, ...source };
    const duration = Number(merged.episodeDurationSec);
    const count = Number(merged.episodeCount);
    merged.episodeDurationSec = duration > 0 ? duration : PLAN_DEFAULTS.episodeDurationSec;
    merged.episodeCount = count > 0 ? count : PLAN_DEFAULTS.episodeCount;
    return merged;
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
const badRequest = (message) => httpError(400, message);
const notFound = (id) => httpError(404, `项目不存在：${id}`);
/** 版本冲突：回当前 version 供客户端识别写入归属（D7）。 */
const versionConflict = (expected, current) => Object.assign(httpError(409, `项目版本冲突：期望 ${expected}，当前 ${current}`), { currentVersion: current });

function requireArray(value, name) {
    if (!Array.isArray(value)) throw badRequest(`${name} 必须是数组`);
    return value;
}

export function createProjects({ dataDir } = {}) {
    const projectsDir = ensureDir(join(dataDir, "projects"));
    const archiveDir = ensureDir(join(dataDir, "projects-archive"));

    const projectFile = (dir) => safeJoin(dir, "project.json");
    const activeDir = (id) => safeJoin(projectsDir, String(id));
    const archivedDir = (id) => safeJoin(archiveDir, String(id));

    function readJson(file) {
        if (!file || !existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            // 与 pipeline.js 一致：坏文件按空处理并告警，不让服务崩。
            console.warn(`[projects] 文件损坏，按空处理：${file}（${error.message}）`);
            return null;
        }
    }

    /** 临时文件 + 同目录 rename：避免读到写了一半的 project.json。 */
    function writeJsonAtomic(file, value) {
        ensureDir(dirname(file));
        const temp = `${file}.${process.pid}${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(temp, JSON.stringify(value, null, 2));
        renameSync(temp, file);
    }

    const readProject = (dir) => {
        const project = readJson(projectFile(dir));
        return project && typeof project === "object" ? project : null;
    };

    /** 活动目录优先、其次归档目录；返回目录本身，便于 update/archive 原地写回。 */
    function locate(id) {
        for (const dir of [activeDir(id), archivedDir(id)]) {
            if (dir && existsSync(join(dir, "project.json"))) return dir;
        }
        return null;
    }

    function requireProject(id) {
        const dir = locate(id);
        const project = dir ? readProject(dir) : null;
        if (!project) throw notFound(id);
        return { project, dir };
    }

    // —— 实体存储模块的共享原语（存储层内部依赖，不含 HTTP 概念）——
    // 写回 project.json：统一重算 updatedAt / version 自增 + 原子写。
    const persistProject = (dir, project) => {
        project.updatedAt = nowIso();
        project.version += 1;
        writeJsonAtomic(projectFile(dir), project);
        return project;
    };
    const entityStore = { dataDir, ulid, nowIso, httpError, badRequest, requireArray, requireProject, persistProject, readJson, writeJsonAtomic };
    const episodes = createEpisodes(entityStore);
    const sources = createSources(entityStore);
    const assets = createAssets(entityStore);

    /** 列表摘要：不吐 project.json 全文（风格锚点、剧本正文都不进列表响应）。 */
    function summarize(project) {
        const episodes = Array.isArray(project.episodes) ? project.episodes : [];
        const checklist = Array.isArray(project.checklist) ? project.checklist : [];
        return {
            id: project.id,
            title: project.title,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            version: project.version,
            completion: {
                episodes: episodes.length,
                episodesDone: episodes.filter((episode) => episode.status === "done").length,
                checklistTotal: checklist.length,
                checklistDone: checklist.filter((item) => item.done).length,
            },
        };
    }

    function create(input = {}) {
        const title = String(input.title ?? "").trim();
        if (!title) throw badRequest("缺少项目标题 title");
        const now = nowIso();
        const project = {
            id: ID_PREFIX.project + ulid(),
            title,
            createdAt: now,
            updatedAt: now,
            styleAnchor: String(input.styleAnchor ?? "").trim(),
            plan: normalizePlan(input.plan),
            script: input.script ?? null,
            sourceRevisionId: null,
            episodes: [],
            assetRefs: [],
            runIds: [],
            canvasIds: [],
            checklist: [],
            reviewNotes: [],
            version: 1,
        };
        if (input.ownerUserId !== undefined) project.ownerUserId = String(input.ownerUserId);
        writeJsonAtomic(projectFile(activeDir(project.id)), project);
        return project;
    }

    function get(id) {
        const dir = locate(id);
        return dir ? readProject(dir) : null;
    }

    function list({ includeArchived = false } = {}) {
        const dirs = includeArchived ? [projectsDir, archiveDir] : [projectsDir];
        const rows = [];
        for (const dir of dirs) {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const project = readProject(join(dir, entry.name));
                if (project) rows.push(summarize(project));
            }
        }
        return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    /** 可更新字段白名单；expectedVersion 是控制位，不落盘。 */
    const MUTABLE_FIELDS = new Set(["title", "styleAnchor", "plan", "script", "sourceRevisionId", "assetRefs", "runIds", "canvasIds", "checklist", "reviewNotes", "ownerUserId"]);

    function update(id, patch = {}) {
        const { project, dir } = requireProject(id);
        const body = patch && typeof patch === "object" ? patch : {};
        for (const key of Object.keys(body)) {
            if (key !== "expectedVersion" && !MUTABLE_FIELDS.has(key)) throw badRequest(`未知字段：${key}`);
        }
        if (body.expectedVersion !== undefined && body.expectedVersion !== project.version) {
            throw versionConflict(body.expectedVersion, project.version);
        }
        if (body.title !== undefined) {
            const title = String(body.title).trim();
            if (!title) throw badRequest("标题不能为空");
            project.title = title;
        }
        if (body.styleAnchor !== undefined) project.styleAnchor = String(body.styleAnchor).trim();
        if (body.plan !== undefined) project.plan = normalizePlan({ ...project.plan, ...(body.plan || {}) });
        if (body.script !== undefined) project.script = body.script;
        if (body.assetRefs !== undefined) project.assetRefs = requireArray(body.assetRefs, "assetRefs");
        if (body.runIds !== undefined) project.runIds = requireArray(body.runIds, "runIds");
        if (body.canvasIds !== undefined) project.canvasIds = requireArray(body.canvasIds, "canvasIds");
        if (body.checklist !== undefined) project.checklist = requireArray(body.checklist, "checklist");
        if (body.reviewNotes !== undefined) project.reviewNotes = requireArray(body.reviewNotes, "reviewNotes");
        if (body.sourceRevisionId !== undefined) project.sourceRevisionId = body.sourceRevisionId === null ? null : String(body.sourceRevisionId);
        if (body.ownerUserId !== undefined) project.ownerUserId = String(body.ownerUserId);
        project.updatedAt = nowIso();
        project.version += 1;
        writeJsonAtomic(projectFile(dir), project);
        return project;
    }

    /**
     * 把 01 剧本阶段产出的 planSuggestion 回填到项目 plan，只填「用户尚未填写」的字段：
     * 未填写 = 仍是 PLAN_DEFAULTS 的占位值（或空串/缺省）；已有值一律不动。ratio / styleAnchor 不在建议范围内，不碰。
     * 回填走 update()：原子写 + version 自增。幂等：建议值与现值相同则跳过，重启重放不会反复覆盖。
     */
    function applyPlanSuggestion(id, suggestion) {
        const project = get(id);
        if (!project) return { project: null, applied: false };
        const source = suggestion && typeof suggestion === "object" ? suggestion : {};
        const plan = project.plan && typeof project.plan === "object" ? project.plan : {};
        const patch = {};
        for (const key of PLAN_SUGGESTION_FIELDS) {
            const raw = source[key];
            if (raw === undefined || raw === null) continue;
            const numeric = key === "episodeCount" || key === "episodeDurationSec";
            const next = numeric ? Number(raw) : String(raw).trim();
            if (numeric ? !(next > 0) : next === "") continue;
            const current = plan[key];
            const unfilled = current === undefined || current === null || current === "" || current === PLAN_DEFAULTS[key];
            // 未填写且建议值与现值不同才回填：已填（含被本函数填过）或建议与现值相同时跳过 → 幂等。
            if (unfilled && next !== current) patch[key] = next;
        }
        if (Object.keys(patch).length === 0) return { project, applied: false };
        return { project: update(id, { plan: patch }), applied: true };
    }

    /** 归档：项目目录移出活动区（列表不再出现，get/context 仍可读）；project.json 字段不变。 */
    function archive(id) {
        const { project, dir } = requireProject(id);
        const target = archivedDir(id);
        if (dir === target) return project;
        project.updatedAt = nowIso();
        project.version += 1;
        writeJsonAtomic(projectFile(dir), project);
        ensureDir(dirname(target));
        renameSync(dir, target);
        return project;
    }

    /**
     * Project Context API：项目页 / 画布 / 流水线 / 素材库统一取同一份上下文。
     * 默认回轻量形状（project + episodes 索引 + runIds + canvasIds）；includeRefs 时追加 assetRefs
     * 与 gates（阶段门禁纯推导），供总览/工作区按需取，避免列表接口背负大对象。
     */
    function context(id, { includeRefs = false } = {}) {
        const project = get(id);
        if (!project) return null;
        const base = {
            project,
            episodes: project.episodes || [],
            runIds: project.runIds || [],
            canvasIds: project.canvasIds || [],
        };
        if (!includeRefs) return base;
        return { ...base, assetRefs: project.assetRefs || [], gates: deriveGates({ project, episodes: episodes.listDetails(id) }) };
    }

    /** 阶段门禁：据 Project + 各集详情纯推导（不落盘）；项目不存在返回 null。 */
    function gates(id) {
        const project = get(id);
        if (!project) return null;
        return deriveGates({ project, episodes: episodes.listDetails(id) });
    }

    // 集/场/镜与源版本由独立存储模块实现；这里只做转发，保持「一个实体一个模块」。
    const saveEpisode = (projectId, input) => episodes.save(projectId, input);
    const getEpisode = (projectId, episodeId) => episodes.get(projectId, episodeId);
    const saveSource = (projectId, input) => sources.save(projectId, input);
    const getSource = (projectId, revisionId) => sources.get(projectId, revisionId);

    return {
        create, get, list, update, archive, context, gates, applyPlanSuggestion,
        saveEpisode, getEpisode, saveSource, getSource,
        episodes, sources, assets,
        ulid, ULID_PATTERN,
    };
}

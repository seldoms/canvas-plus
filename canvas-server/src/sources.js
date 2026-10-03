import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { safeJoin } from "./files.js";

/**
 * 源版本存储内核（P0-a 深水区）。
 * 布局：data/projects/<pid>/sources/<revisionId>.json —— 写入后不可变（immutable）。
 * 重复提交同一 revisionId：**拒绝覆盖**（409），不做幂等合并。
 * project.json.sourceRevisionId 指向当前采用的版本。
 */

export function createSources(store) {
    const { ulid, httpError, badRequest, nowIso, requireProject, persistProject, readJson, writeJsonAtomic } = store;

    const sourcesDir = (dir) => safeJoin(dir, "sources");
    const sourceFile = (dir, id) => safeJoin(dir, "sources", `${String(id)}.json`);
    // 列表不回正文，只回轻量摘要。
    const summary = (source) => ({ id: source.id, kind: source.kind, title: source.title, sha256: source.sha256, chars: source.chars, createdAt: source.createdAt });

    function list(projectId) {
        const { dir } = requireProject(projectId);
        const folder = sourcesDir(dir);
        if (!folder || !existsSync(folder)) return [];
        return readdirSync(folder)
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJson(join(folder, name)))
            .filter(Boolean)
            .map(summary)
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    function save(projectId, input = {}) {
        const { project, dir } = requireProject(projectId);
        const body = input && typeof input === "object" ? input : {};
        const explicit = String(body.id ?? "").trim();
        const id = explicit || `src_${ulid()}`;
        const file = sourceFile(dir, id);
        if (!file) throw badRequest("源版本 id 非法");
        if (existsSync(file)) throw httpError(409, `源版本不可覆盖：${id}`);
        const text = String(body.text ?? body.content ?? "");
        const revision = {
            id,
            projectId: project.id,
            kind: String(body.kind ?? "novel"),
            title: String(body.title ?? "").trim(),
            sha256: createHash("sha256").update(text).digest("hex"),
            chars: Array.from(text).length,
            from: String(body.from ?? "upload"),
            createdAt: nowIso(),
            text,
        };
        writeJsonAtomic(file, revision);
        project.sourceRevisionId = id;
        persistProject(dir, project);
        return revision;
    }

    function get(projectId, revisionId) {
        const { dir } = requireProject(projectId);
        return readJson(sourceFile(dir, revisionId));
    }

    return { list, save, get };
}

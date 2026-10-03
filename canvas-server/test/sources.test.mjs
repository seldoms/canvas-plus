import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProjects } from "../src/projects.js";

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-sources-"));
    return { root, projects: createProjects({ dataDir: root }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error("期望抛出异常，但没有");
}

test("源版本：写入落盘、回填 project.sourceRevisionId、带 sha256/chars", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    assert.equal(env.projects.get(project.id).sourceRevisionId, null, "新建项目该字段为空");

    const revision = env.projects.sources.save(project.id, { kind: "novel", title: "原著", text: "第一章" });
    assert.match(revision.id, /^src_/);
    assert.equal(revision.kind, "novel");
    assert.equal(revision.title, "原著");
    assert.equal(revision.text, "第一章");
    assert.equal(revision.chars, 3);
    assert.match(revision.sha256, /^[0-9a-f]{64}$/);
    assert.equal(revision.from, "upload");

    const file = join(env.root, "projects", project.id, "sources", `${revision.id}.json`);
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).text, "第一章");

    // project.json 指向当前采用版本
    assert.equal(env.projects.get(project.id).sourceRevisionId, revision.id);

    const second = env.projects.sources.save(project.id, { kind: "script", text: "改稿" });
    assert.notEqual(second.id, revision.id);
    assert.equal(env.projects.get(project.id).sourceRevisionId, second.id, "新版本成为当前采用版本");
});

test("源版本不可覆盖：同 revisionId 重复提交被拒绝，原版本不变", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const revision = env.projects.sources.save(project.id, { kind: "novel", text: "第一章" });

    const conflict = catchError(() => env.projects.sources.save(project.id, { id: revision.id, text: "改稿" }));
    assert.equal(conflict.status, 409);
    assert.match(conflict.message, /不可覆盖/);
    assert.equal(env.projects.sources.get(project.id, revision.id).text, "第一章", "原版本不得被覆盖");
});

test("源版本列表：不回正文，只回摘要", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    env.projects.sources.save(project.id, { kind: "novel", title: "原著", text: "很长的正文".repeat(500) });

    const rows = env.projects.sources.list(project.id);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["chars", "createdAt", "id", "kind", "sha256", "title"]);
    assert.ok(!JSON.stringify(rows).includes("很长的正文"), "列表不应包含正文");

    assert.equal(env.projects.sources.get(project.id, "src_nope"), null);
});

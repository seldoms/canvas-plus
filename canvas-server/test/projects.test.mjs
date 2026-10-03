import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProjects, ulid } from "../src/projects.js";

const ULID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
/** 契约 §3.1 的 Project 必填字段。 */
const CONTRACT_FIELDS = ["id", "title", "createdAt", "updatedAt", "styleAnchor", "plan", "script", "episodes", "assetRefs", "runIds", "canvasIds", "checklist", "reviewNotes", "version"];

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-projects-"));
    return { root, projects: createProjects({ dataDir: root }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 捕获同步抛错并返回 error 对象（assert.throws 不返回 error）。 */
function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error("期望抛出异常，但没有");
}

const readProject = (root, id) => JSON.parse(readFileSync(join(root, "projects", id, "project.json"), "utf8"));

test("create：磁盘上出现 project.json 且契约字段齐全、默认值补齐", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "测试剧", styleAnchor: "冷色调胶片感", plan: { genre: "悬疑", episodeCount: 12 }, ownerUserId: "u1" });
    const file = join(env.root, "projects", project.id, "project.json");
    assert.ok(existsSync(file), "project.json 应落盘");

    const onDisk = readProject(env.root, project.id);
    for (const key of CONTRACT_FIELDS) assert.ok(key in onDisk, `缺少契约字段 ${key}`);
    assert.equal(onDisk.id, project.id);
    assert.equal(onDisk.title, "测试剧");
    assert.equal(onDisk.styleAnchor, "冷色调胶片感");
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.ownerUserId, "u1");
    // Plan 缺失字段按 D8 项目级默认补齐，数值字段归一
    assert.equal(onDisk.plan.genre, "悬疑");
    assert.equal(onDisk.plan.episodeCount, 12);
    assert.equal(onDisk.plan.ratio, "9:16");
    assert.equal(onDisk.plan.episodeDurationSec, 60);
    assert.equal(onDisk.script, null);
    assert.deepEqual(onDisk.episodes, []);
    assert.deepEqual(onDisk.assetRefs, []);
    assert.deepEqual(onDisk.runIds, []);
    assert.deepEqual(onDisk.canvasIds, []);
    assert.deepEqual(onDisk.checklist, []);
    assert.deepEqual(onDisk.reviewNotes, []);
    assert.ok(onDisk.createdAt && onDisk.updatedAt);

    assert.throws(() => env.projects.create({ title: "   " }), /标题/);
});

test("ID 形态：prj_ + 26 位 Crockford Base32，不含易混字符", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const { id } = env.projects.create({ title: "形态检查" });
    assert.match(id, ULID_RE);
    assert.equal(id.length, 30, "prj_ + 26 位");
    assert.doesNotMatch(id, /[ILOU]/, "Crockford Base32 不含 I/L/O/U");
});

test("list：只回摘要，不吐 project.json 全文", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({
        title: "甲",
        styleAnchor: "风格锚点".repeat(200),
        script: { huge: "x".repeat(20000) },
    });
    env.projects.update(project.id, { checklist: [{ id: "c1", done: true }, { id: "c2", done: false }] });
    const rows = env.projects.list();
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["completion", "createdAt", "id", "title", "updatedAt", "version"]);
    assert.equal(rows[0].id, project.id);
    assert.deepEqual(rows[0].completion, { episodes: 0, episodesDone: 0, checklistTotal: 2, checklistDone: 1 });

    const serialized = JSON.stringify(rows);
    assert.ok(!serialized.includes("huge"), "摘要不应包含剧本正文");
    assert.ok(!serialized.includes("风格锚点"), "摘要不应包含风格锚点全文");
    assert.ok(serialized.length < 500, `摘要应保持精简，实际 ${serialized.length}`);
});

test("update：expectedVersion 不匹配回 409、磁盘 version 不变；未知字段 400；缺失 404", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const bumped = env.projects.update(project.id, { title: "乙", expectedVersion: 1 });
    assert.equal(bumped.version, 2);
    assert.equal(bumped.title, "乙");

    const conflict = catchError(() => env.projects.update(project.id, { title: "丙", expectedVersion: 1 }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.currentVersion, 2);

    const onDisk = readProject(env.root, project.id);
    assert.equal(onDisk.version, 2, "冲突写不得改变磁盘版本");
    assert.equal(onDisk.title, "乙", "冲突写不得改变磁盘内容");

    assert.equal(catchError(() => env.projects.update(project.id, { nope: 1 })).status, 400);
    assert.equal(catchError(() => env.projects.update(project.id, { runIds: "not-array" })).status, 400);

    const missing = catchError(() => env.projects.update("prj_missing", { title: "x" }));
    assert.equal(missing.status, 404);
    assert.equal(env.projects.get("prj_missing"), null);
    assert.equal(env.projects.get("../../etc"), null);
});

test("原子写：写完目录下无残留临时文件", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    env.projects.update(project.id, { title: "乙" });
    const dir = join(env.root, "projects", project.id);
    const files = readdirSync(dir);
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "不应残留 .tmp");
    assert.deepEqual(files.sort(), ["project.json"]);
});

test("archive：移出活动列表但仍可读取", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const archived = env.projects.archive(project.id);
    assert.ok(archived.version >= 2);
    assert.equal(env.projects.list().length, 0, "归档后不在活动列表");
    assert.equal(env.projects.list({ includeArchived: true }).length, 1);
    assert.equal(env.projects.get(project.id).id, project.id, "归档后仍可按 id 读取");
    assert.ok(existsSync(join(env.root, "projects-archive", project.id, "project.json")));
    assert.ok(!existsSync(join(env.root, "projects", project.id)));
    assert.equal(env.projects.archive(project.id).id, project.id, "重复归档幂等");
    assert.equal(catchError(() => env.projects.archive("prj_nope")).status, 404);
});

test("context：project + episodes 索引 + runIds + canvasIds；集详情落 episodes/<id>.json", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    env.projects.update(project.id, { runIds: ["run-1"], canvasIds: ["cv-1"] });
    env.projects.saveEpisode(project.id, { id: "ep_0001", index: 1, title: "第一集", status: "done" });

    const ctx = env.projects.context(project.id);
    assert.deepEqual(Object.keys(ctx).sort(), ["canvasIds", "episodes", "project", "runIds"]);
    assert.equal(ctx.project.id, project.id);
    assert.deepEqual(ctx.episodes, [{ id: "ep_0001", index: 1, title: "第一集", status: "done" }]);
    assert.deepEqual(ctx.runIds, ["run-1"]);
    assert.deepEqual(ctx.canvasIds, ["cv-1"]);
    assert.equal(env.projects.context("prj_nope"), null);

    const detail = env.projects.getEpisode(project.id, "ep_0001");
    assert.equal(detail.projectId, project.id);
    assert.equal(detail.title, "第一集");
    assert.deepEqual(detail.sceneIds, []);
    assert.ok(existsSync(join(env.root, "projects", project.id, "episodes", "ep_0001.json")));
    assert.equal(catchError(() => env.projects.saveEpisode(project.id, { id: "ep-1" })).status, 400);
});

test("sources：不可变源版本，同 revisionId 不可覆盖", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const revision = env.projects.saveSource(project.id, { kind: "novel", text: "第一章" });
    assert.match(revision.id, /^src_/);
    assert.equal(env.projects.getSource(project.id, revision.id).text, "第一章");
    assert.equal(catchError(() => env.projects.saveSource(project.id, { id: revision.id, text: "改稿" })).status, 409);
    assert.equal(env.projects.getSource(project.id, revision.id).text, "第一章", "原版本不得被覆盖");
});

test("批量 create：200 个 id 不重复且形态正确", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const ids = new Set();
    for (let index = 0; index < 200; index += 1) {
        const id = env.projects.create({ title: `剧 ${index}` }).id;
        assert.match(id, ULID_RE);
        ids.add(id);
    }
    assert.equal(ids.size, 200, "200 次 create 不应出现重复 id");
    // 同一毫秒密集取值也不撞（模块级单调递增）
    assert.equal(new Set(Array.from({ length: 200 }, () => ulid())).size, 200);
});

test("index 集成：/api/projects 系列端点（真实 HTTP）", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-projects-index-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
    });
    // 指向临时数据目录，绝不碰生产 data/；env 必须在 import 前设好。
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    const mod = await import("../src/index.js");
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${mod.server.address().port}`;
    const asJson = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
        const created = await (await fetch(`${base}/api/projects`, asJson({ title: "端到端", styleAnchor: "冷调" }))).json();
        assert.match(created.project.id, ULID_RE);
        assert.equal(created.project.version, 1);

        const listed = await (await fetch(`${base}/api/projects`)).json();
        assert.equal(listed.projects.length, 1);
        assert.ok(!("styleAnchor" in listed.projects[0]), "列表只回摘要");

        const detail = await (await fetch(`${base}/api/projects/${created.project.id}`)).json();
        assert.equal(detail.project.title, "端到端");

        const conflict = await fetch(`${base}/api/projects/${created.project.id}`, asJson({ title: "改", expectedVersion: 999 }, "PATCH"));
        assert.equal(conflict.status, 409);
        const conflictBody = await conflict.json();
        assert.equal(conflictBody.version, 1, "409 要回当前 version");
        assert.equal(conflictBody.error.code, "version_conflict");

        const patched = await fetch(`${base}/api/projects/${created.project.id}`, asJson({ title: "改", expectedVersion: 1 }, "PATCH"));
        assert.equal(patched.status, 200);
        assert.equal((await patched.json()).project.version, 2);

        const ctx = await (await fetch(`${base}/api/projects/${created.project.id}/context`)).json();
        assert.deepEqual(Object.keys(ctx).sort(), ["canvasIds", "episodes", "project", "runIds"]);
        assert.equal(ctx.project.title, "改");

        assert.equal((await fetch(`${base}/api/projects/prj_missing`)).status, 404);
        assert.equal((await fetch(`${base}/api/projects/prj_missing/context`)).status, 404);
        assert.equal((await fetch(`${base}/api/projects`, asJson({ title: "" }))).status, 400);
        const archived = await fetch(`${base}/api/projects/${created.project.id}/archive`, { method: "POST" });
        assert.equal(archived.status, 200);
        assert.equal((await (await fetch(`${base}/api/projects`)).json()).projects.length, 0);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

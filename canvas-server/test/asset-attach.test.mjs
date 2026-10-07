import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProjects } from "../src/projects.js";

/**
 * 归入资料包（assets.attach）的契约测试。
 *
 * 走**真实生产代码路径**：真实 createProjects + 真实 project.json 落盘，
 * 不把 attach 的逻辑复制进测试（2026-10-06 踩过「单测全绿但功能错」的坑）。
 * 有效性用回退法验证：把src/assets.js 的 attach 改回 create 语义，本文件必须变红。
 */

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-attach-"));
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

test("attach：首次归入新建引用，并自动采用该产物", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包甲" });
    const out = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_1" });

    assert.equal(out.created, true);
    assert.equal(out.addedArtifactIds, 1);
    assert.match(out.assetRef.id, /^as_/);
    assert.equal(out.assetRef.role, "character");
    assert.equal(out.assetRef.bindingId, "c1");
    assert.deepEqual(out.assetRef.artifactIds, ["art_1"]);
    // 首次归入即采用：只有一个候选时不存在「选哪个」的问题，不该让人再点一次。
    assert.equal(out.assetRef.selectedArtifactId, "art_1");

    // 真落盘，重新读项目仍能拿到
    const refs = env.projects.get(project.id).assetRefs;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, out.assetRef.id);
});

test("attach：同 role+bindingId 重复归入是幂等追加，不新增重复引用（duplicate-binding 的根治点）", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包乙" });
    const first = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_1" });
    const second = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_2" });

    assert.equal(second.created, false);
    assert.equal(second.addedArtifactIds, 1);
    // 同一条引用被追加，而不是新建 —— reference-lock 的 findAssetRef 只取第一条，
    // 若这里新建，选参考图就会随机命中（asset-consistency 的 duplicate-binding 就是这个坑）。
    assert.equal(second.assetRef.id, first.assetRef.id);
    assert.deepEqual(second.assetRef.artifactIds, ["art_1", "art_2"]);
    assert.equal(env.projects.get(project.id).assetRefs.length, 1);
    // 已有采用不被后来的归入顶掉
    assert.equal(second.assetRef.selectedArtifactId, "art_1");

    // 同一产物重复归入：不再重复计数（真幂等）
    const again = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_2" });
    assert.equal(again.addedArtifactIds, 0);
    assert.deepEqual(again.assetRef.artifactIds, ["art_1", "art_2"]);
    assert.equal(env.projects.get(project.id).assetRefs.length, 1);
});

test("attach：role 或 bindingId 不同则各自新建，绝不合并不同实体", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包丙" });
    const c1 = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_1" });
    const c2 = env.projects.assets.attach(project.id, { role: "character", bindingId: "c2", artifactId: "art_1" });
    const loc1 = env.projects.assets.attach(project.id, { role: "scene", bindingId: "c1", artifactId: "art_1" });

    assert.notEqual(c2.assetRef.id, c1.assetRef.id);
    assert.notEqual(loc1.assetRef.id, c1.assetRef.id);
    assert.equal(env.projects.get(project.id).assetRefs.length, 3);

    // bindingId 前后空白视为同一个锚点：否则手输id 会静默造出第二条重复引用。
    const spaced = env.projects.assets.attach(project.id, { role: "character", bindingId: "  c1  ", artifactId: "art_9" });
    assert.equal(spaced.created, false);
    assert.equal(spaced.assetRef.id, c1.assetRef.id);
    assert.equal(env.projects.get(project.id).assetRefs.length, 3);
});

test("attach：归因元数据只补空不覆盖，来源信息不被后一次归入抹掉", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包丁" });
    const first = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_1", sourceJobId: "job_A", stageId: "casting", name: "阿海" });
    assert.equal(first.assetRef.metadata.sourceJobId, "job_A");
    assert.equal(first.assetRef.metadata.stageId, "casting");
    assert.equal(first.assetRef.metadata.name, "阿海");

    const second = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_2", sourceJobId: "job_B", name: "阿海·三视图" });
    assert.equal(second.assetRef.metadata.sourceJobId, "job_A", "已有来源不该被后来的归入覆盖");
    assert.equal(second.assetRef.metadata.name, "阿海", "已有名称不该被覆盖");
});

test("attach：select:false 只进候选池，不自动采用；显式 selectedArtifactId 必须已在候选内", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包戊" });

    const pending = env.projects.assets.attach(project.id, { role: "prop", bindingId: "p1", artifactId: "art_1", select: false });
    assert.equal(pending.assetRef.selectedArtifactId, null);
    assert.deepEqual(pending.assetRef.artifactIds, ["art_1"]);

    // 人工选定：必须在 artifactIds 内，否则 400（不允许指向不存在的候选）
    const picked = env.projects.assets.attach(project.id, { role: "prop", bindingId: "p1", artifactId: "art_2", selectedArtifactId: "art_2" });
    assert.equal(picked.assetRef.selectedArtifactId, "art_2");

    const missing = catchError(() => env.projects.assets.attach(project.id, { role: "prop", bindingId: "p1", artifactId: "art_3", selectedArtifactId: "art_9" }));
    assert.equal(missing.status, 400);
    assert.match(missing.message, /不在 artifactIds/);
});

test("attach：一次可归入多个产物（artifactIds），主产物在前且被采用", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包己" });
    const out = env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "art_main", artifactIds: ["art_side", "art_side"] });

    assert.deepEqual(out.assetRef.artifactIds, ["art_main", "art_side"]);
    assert.equal(out.assetRef.selectedArtifactId, "art_main");
    assert.equal(out.addedArtifactIds, 2);
});

test("attach：入参校验——role 非法 / 缺 bindingId / 缺 artifactId 全部 400", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包庚" });

    assert.equal(catchError(() => env.projects.assets.attach(project.id, { role: "unknown", bindingId: "c1", artifactId: "a" })).status, 400);
    assert.equal(catchError(() => env.projects.assets.attach(project.id, { role: "character", bindingId: "  ", artifactId: "a" })).status, 400);
    assert.equal(catchError(() => env.projects.assets.attach(project.id, { role: "character", bindingId: "c1" })).status, 400);
    assert.equal(catchError(() => env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "  " })).status, 400);
    // 不存在的项目必须是 404，不能退化成新建
    assert.equal(catchError(() => env.projects.assets.attach("prj_不存在", { role: "character", bindingId: "c1", artifactId: "a" })).status, 404);
});

test("attach：归入的引用能被 list 与 reference-lock 的参考图解析认出来", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "资料包辛" });
    env.projects.assets.attach(project.id, { role: "character", bindingId: "c1", artifactId: "/api/artifacts/job_x/c1.png" });

    const listed = env.projects.assets.list(project.id, { role: "character" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].selectedArtifactId, "/api/artifacts/job_x/c1.png");

    // 归因可查：跨项目总览能按名字/角色看到这条引用
    const overview = env.projects.assets.overview();
    const row = overview.assetRefs.find((item) => item.projectId === project.id);
    assert.equal(row.role, "character");
    assert.equal(row.url, "/api/artifacts/job_x/c1.png");
});
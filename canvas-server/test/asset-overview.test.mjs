import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProjects } from "../src/projects.js";

/**
 * 跨项目资产总览（assets.overview()）：只读聚合全部项目的 AssetRef。
 * 覆盖：空数据、正常聚合与字段解析、URL 回落链、排序分组、计数、损坏项目跳过。
 */

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-asset-overview-"));
    return { root, projects: createProjects({ dataDir: root }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("总览：空环境返回空列表与零计数", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const out = env.projects.assets.overview();
    assert.deepEqual(out.assetRefs, []);
    assert.equal(out.counts.total, 0);
    assert.deepEqual(out.counts.byRole, {});
    assert.deepEqual(out.counts.byProject, []);
    assert.deepEqual(out.warnings, []);
});

test("总览：摊平全部项目的 AssetRef 并解析常用字段（role/kind/name/url/artifactCount）", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const a = env.projects.create({ title: "甲剧" });
    const b = env.projects.create({ title: "乙剧" });
    env.projects.assets.create(a.id, {
        role: "character",
        bindingId: "c1",
        artifactIds: ["u1", "u2"],
        selectedArtifactId: "u2",
        metadata: { name: "老周", kind: "reference", stageId: "design" },
    });
    env.projects.assets.create(a.id, { role: "keyframe", bindingId: "sh1-start", artifactIds: ["k1"], metadata: { stageId: "keyframe" } });
    env.projects.assets.create(b.id, { role: "clip", bindingId: "sh1-clip", artifactIds: ["v1"], metadata: { stageId: "assembly" } });

    const out = env.projects.assets.overview();
    assert.equal(out.counts.total, 3);
    assert.deepEqual(out.counts.byRole, { character: 1, keyframe: 1, clip: 1 });

    const charRef = out.assetRefs.find((row) => row.role === "character");
    assert.equal(charRef.projectId, a.id);
    assert.equal(charRef.projectTitle, "甲剧");
    assert.equal(charRef.name, "老周");
    assert.equal(charRef.kind, "reference");
    assert.equal(charRef.url, "u2", "渲染 URL 取选中产物");
    assert.equal(charRef.artifactCount, 2);
    assert.equal(charRef.stageId, "design");
    assert.equal(charRef.bindingId, "c1");

    const kf = out.assetRefs.find((row) => row.role === "keyframe");
    assert.equal(kf.name, "sh1-start", "无 metadata.name 时回落 bindingId");
    assert.equal(kf.kind, "");
    assert.equal(kf.url, "k1", "无选中/无 artifactUrl 时回落 artifactIds[0]");

    // 按项目计数：只含有资产的项目，且带项目标题
    assert.deepEqual(
        out.counts.byProject
            .map((row) => `${row.projectId}:${row.count}`)
            .sort(),
        [`${a.id}:2`, `${b.id}:1`].sort(),
    );
    assert.equal(
        out.counts.byProject.find((row) => row.projectId === a.id).projectTitle,
        "甲剧",
    );
});

test("总览：渲染 URL 回落链（选中产物 → metadata.artifactUrl → artifactIds[0] → 空串）", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "回落" });
    env.projects.assets.create(project.id, { role: "character", bindingId: "sel", artifactIds: ["a1", "a2"], selectedArtifactId: "a2" });
    env.projects.assets.create(project.id, { role: "scene", bindingId: "meta", artifactIds: ["b1"], metadata: { artifactUrl: "/api/artifacts/b.png" } });
    env.projects.assets.create(project.id, { role: "keyframe", bindingId: "first", artifactIds: ["c1"] });
    env.projects.assets.create(project.id, { role: "clip", bindingId: "empty", artifactIds: [] });

    const out = env.projects.assets.overview();
    const byBinding = Object.fromEntries(out.assetRefs.map((row) => [row.bindingId, row.url]));
    assert.equal(byBinding.sel, "a2");
    assert.equal(byBinding.meta, "/api/artifacts/b.png");
    assert.equal(byBinding.first, "c1");
    assert.equal(byBinding.empty, "");
});

test("总览：按项目分组、组内按 id 的 ULID 时序新→旧", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const a = env.projects.create({ title: "甲" });
    const b = env.projects.create({ title: "乙" });
    const r1 = env.projects.assets.create(a.id, { role: "keyframe", bindingId: "k1", artifactIds: ["x1"] });
    const r2 = env.projects.assets.create(a.id, { role: "keyframe", bindingId: "k2", artifactIds: ["x2"] });
    const r3 = env.projects.assets.create(b.id, { role: "keyframe", bindingId: "k3", artifactIds: ["x3"] });

    const out = env.projects.assets.overview();
    // 同一项目的记录连续成段，不被别的项目打断
    const seq = out.assetRefs.map((row) => row.projectId);
    const runs = seq.filter((id, index) => index === 0 || seq[index - 1] !== id);
    assert.equal(runs.length, new Set(seq).size, "同一项目应连续成段");

    // 甲剧的两条：后建的 r2 排在前面
    assert.deepEqual(
        out.assetRefs.filter((row) => row.projectId === a.id).map((row) => row.id),
        [r2.id, r1.id],
    );
    assert.ok(out.assetRefs.some((row) => row.id === r3.id));
});

test("总览：损坏项目（坏 JSON / assetRefs 非数组 / 坏引用条目）跳过并记 warning，不影响其它项目", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const good = env.projects.create({ title: "好项目" });
    env.projects.assets.create(good.id, { role: "scene", bindingId: "loc1", artifactIds: ["s1"], metadata: { name: "公交车内" } });

    // 坏 JSON：project.json 解析失败
    mkdirSync(join(env.root, "projects", "broken"), { recursive: true });
    writeFileSync(join(env.root, "projects", "broken", "project.json"), "{ this is not json", "utf8");

    // assetRefs 非数组
    mkdirSync(join(env.root, "projects", "weird"), { recursive: true });
    writeFileSync(join(env.root, "projects", "weird", "project.json"), JSON.stringify({ id: "prj_weird", title: "怪项目", assetRefs: { not: "array" } }), "utf8");

    // 数组里混入损坏条目：跳过该条，项目本身仍可读
    mkdirSync(join(env.root, "projects", "mixed"), { recursive: true });
    writeFileSync(
        join(env.root, "projects", "mixed", "project.json"),
        JSON.stringify({ id: "prj_mixed", title: "半坏", updatedAt: "2020-01-01T00:00:00.000Z", assetRefs: [null, { id: "as_x", role: "prop", bindingId: "p1", artifactIds: [], metadata: {} }] }),
        "utf8",
    );

    const out = env.projects.assets.overview();
    assert.equal(out.counts.total, 2, "好项目 1 条 + 半坏项目的合法条目 1 条");
    assert.ok(out.warnings.some((w) => w.includes("broken")));
    assert.ok(out.warnings.some((w) => w.includes("weird")));
    assert.ok(out.warnings.some((w) => w.includes("mixed")));
    assert.ok(out.assetRefs.some((row) => row.projectId === good.id));
    assert.ok(out.assetRefs.every((row) => row.id !== ""));
});

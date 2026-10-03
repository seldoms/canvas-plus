import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProjects } from "../src/projects.js";

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-assets-"));
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

test("AssetRef：登记引用、绑定锚点 bindingId、元数据，不改动 artifact 像素（D2）", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const ref = env.projects.assets.create(project.id, { role: "character", bindingId: "char_主角", artifactIds: ["art_1", "art_2"], metadata: { model: "x" } });

    assert.match(ref.id, /^as_/);
    assert.equal(ref.projectId, project.id);
    assert.equal(ref.role, "character");
    assert.equal(ref.bindingId, "char_主角");
    assert.deepEqual(ref.artifactIds, ["art_1", "art_2"]);
    assert.equal(ref.selectedArtifactId, null);
    assert.deepEqual(ref.metadata, { model: "x" });

    // 落在 project.assetRefs[]，context(?include=refs) 能取到
    assert.deepEqual(env.projects.get(project.id).assetRefs.map((item) => item.id), [ref.id]);
    const ctx = env.projects.context(project.id, { includeRefs: true });
    assert.equal(ctx.assetRefs.length, 1);

    // role / bindingId 校验
    assert.equal(catchError(() => env.projects.assets.create(project.id, { role: "unknown", bindingId: "x" })).status, 400);
    assert.equal(catchError(() => env.projects.assets.create(project.id, { role: "prop", bindingId: "  " })).status, 400);
    assert.equal(catchError(() => env.projects.assets.create(project.id, { bindingId: "x" })).status, 400);
});

test("AssetRef：切换采用版本 select，只能选 artifactIds[] 内的候选", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const ref = env.projects.assets.create(project.id, { role: "keyframe", bindingId: "kf_start", artifactIds: ["a1", "a2"] });

    const outOfRange = catchError(() => env.projects.assets.select(project.id, ref.id, { artifactId: "a3" }));
    assert.equal(outOfRange.status, 400);
    assert.match(outOfRange.message, /不在 artifactIds/);

    const selected = env.projects.assets.select(project.id, ref.id, { artifactId: "a2" });
    assert.equal(selected.selectedArtifactId, "a2");
    assert.equal(env.projects.get(project.id).assetRefs[0].selectedArtifactId, "a2", "切换落盘");

    const switched = env.projects.assets.select(project.id, ref.id, { artifactId: "a1" });
    assert.equal(switched.selectedArtifactId, "a1");

    assert.equal(catchError(() => env.projects.assets.select(project.id, "as_nope", { artifactId: "a1" })).status, 404);
});

test("AssetRef：unlink 解除引用并清空选中，不越界；list 可按 role 过滤", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const character = env.projects.assets.create(project.id, { role: "character", bindingId: "c1", artifactIds: ["a1", "a2"] });
    env.projects.assets.create(project.id, { role: "scene", bindingId: "s1", artifactIds: [] });

    assert.equal(env.projects.assets.list(project.id).length, 2);
    assert.deepEqual(env.projects.assets.list(project.id, { role: "character" }).map((item) => item.id), [character.id]);
    assert.equal(catchError(() => env.projects.assets.list(project.id, { role: "bad" })).status, 400);

    env.projects.assets.select(project.id, character.id, { artifactId: "a2" });
    const unlinked = env.projects.assets.unlink(project.id, character.id, { artifactId: "a2" });
    assert.deepEqual(unlinked.artifactIds, ["a1"]);
    assert.equal(unlinked.selectedArtifactId, null, "解除正在采用的候选后清空选中");

    const patched = env.projects.assets.update(project.id, character.id, { bindingId: "c2", metadata: { note: "ok" }, episodeId: "ep_0001" });
    assert.equal(patched.bindingId, "c2");
    assert.equal(patched.episodeId, "ep_0001");
    const cleared = env.projects.assets.update(project.id, character.id, { episodeId: null });
    assert.equal("episodeId" in cleared, false, "置空可解除可选归属");
    assert.equal(catchError(() => env.projects.assets.update(project.id, character.id, { nope: 1 })).status, 400);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createProjects } from "../src/projects.js";

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-episodes-"));
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

const readEpisodeFile = (root, projectId, episodeId) => JSON.parse(readFileSync(join(root, "projects", projectId, "episodes", `${episodeId}.json`), "utf8"));

test("集：自动生成 ep_ + 4 位序号，详情落盘、索引并入 project.episodes", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const { episode } = env.projects.episodes.save(project.id, { title: "第一集", logline: "开场" });

    assert.match(episode.id, /^ep_\d{4}$/);
    assert.equal(episode.id, "ep_0001");
    assert.equal(episode.projectId, project.id);
    assert.equal(episode.index, 1);
    assert.equal(episode.title, "第一集");
    assert.equal(episode.status, "pending");
    assert.deepEqual(episode.scenes, []);
    assert.deepEqual(episode.shots, []);
    assert.ok(existsSync(join(env.root, "projects", project.id, "episodes", "ep_0001.json")));

    const onDisk = readEpisodeFile(env.root, project.id, "ep_0001");
    assert.equal(onDisk.logline, "开场");
    assert.deepEqual(env.projects.episodes.list(project.id), [{ id: "ep_0001", index: 1, title: "第一集", status: "pending" }]);

    const second = env.projects.episodes.save(project.id, { title: "第二集" });
    assert.equal(second.episode.id, "ep_0002");
    assert.equal(second.episode.index, 2);

    const patched = env.projects.episodes.update(project.id, "ep_0001", { status: "done", index: 3 });
    assert.equal(patched.episode.status, "done");
    assert.equal(patched.episode.index, 3);
    assert.deepEqual(env.projects.episodes.list(project.id).map((row) => row.id), ["ep_0002", "ep_0001"], "索引按 index 排序");
    assert.equal(catchError(() => env.projects.episodes.update(project.id, "ep_0001", { nope: 1 })).status, 400);
});

test("场/镜：必填校验 + 磁盘落盘，shot.id 创建时生成", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);

    const project = env.projects.create({ title: "甲" });
    const { episode } = env.projects.episodes.save(project.id, { title: "第一集" });

    assert.equal(catchError(() => env.projects.episodes.addScene(project.id, episode.id, { time: "夜", intent: "开场" })).status, 400, "缺 locationId");
    assert.equal(catchError(() => env.projects.episodes.addScene(project.id, episode.id, { locationId: "loc", intent: "开场" })).status, 400, "缺 time");
    assert.equal(catchError(() => env.projects.episodes.addScene(project.id, episode.id, { locationId: "loc", time: "夜" })).status, 400, "缺 intent");

    const { scene } = env.projects.episodes.addScene(project.id, episode.id, { locationId: "loc_1", time: "夜", intent: "开场", beatIds: ["b1"] });
    assert.equal(scene.id, "sc_0001");
    assert.equal(scene.episodeId, episode.id);
    assert.equal(scene.index, 1);
    assert.equal(scene.locationId, "loc_1");
    assert.deepEqual(scene.beatIds, ["b1"]);

    const { shot } = env.projects.episodes.addShot(project.id, scene.id, { storyboard: { camera: "推" } });
    assert.match(shot.id, /^sh_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(shot.sceneId, "sc_0001");
    assert.equal(shot.index, 1);
    assert.equal(shot.status, "pending");
    assert.deepEqual(shot.generationSlots, []);

    const onDisk = readEpisodeFile(env.root, project.id, "ep_0001");
    assert.equal(onDisk.scenes.length, 1);
    assert.equal(onDisk.shots.length, 1);
    assert.deepEqual(onDisk.sceneIds, ["sc_0001"], "sceneIds 与 scenes 同步");
    assert.equal(onDisk.shots[0].id, shot.id);

    const moved = env.projects.episodes.updateScene(project.id, scene.id, { time: "晨", intent: "追车" });
    assert.equal(moved.scene.time, "晨");
    assert.equal(moved.scene.intent, "追车");
    assert.equal(catchError(() => env.projects.episodes.updateScene(project.id, scene.id, { locationId: "  " })).status, 400);
});

test("引用校验：未知 episodeId / 悬空 sceneId / 跨集 shot 三类非法输入都被拒（400）", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);
    const { projects } = env;
    const project = projects.create({ title: "甲" });

    // ① 未知 episodeId：往不存在的集里建场 → 400
    const unknownEpisode = catchError(() => projects.episodes.addScene(project.id, "ep_9999", { locationId: "loc", time: "夜", intent: "开场" }));
    assert.equal(unknownEpisode.status, 400);
    assert.match(unknownEpisode.message, /集不存在/);

    // 准备两集，各带一场
    const a = projects.episodes.save(project.id, { title: "A" }).episode;
    const b = projects.episodes.save(project.id, { title: "B" }).episode;
    const sceneA = projects.episodes.addScene(project.id, a.id, { locationId: "locA", time: "夜", intent: "i" }).scene;
    const sceneB = projects.episodes.addScene(project.id, b.id, { locationId: "locB", time: "夜", intent: "i" }).scene;

    // ② 悬空 sceneId：往不存在的场建镜 → 400
    const dangling = catchError(() => projects.episodes.addShot(project.id, "sc_9999", {}));
    assert.equal(dangling.status, 400);
    assert.match(dangling.message, /场不存在/);

    // ③ 跨集 shot：在 A 的场下，引用属于 B 的场 → 400（不在本集）
    const cross = catchError(() => projects.episodes.addShot(project.id, sceneA.id, { sceneId: sceneB.id }));
    assert.equal(cross.status, 400);
    assert.match(cross.message, /不在本集/);

    // ③b 修改时把镜头改挂到跨集的场 → 同样 400，且不得落盘
    const shot = projects.episodes.addShot(project.id, sceneA.id, {}).shot;
    const crossUpdate = catchError(() => projects.episodes.updateShot(project.id, shot.id, { sceneId: sceneB.id }));
    assert.equal(crossUpdate.status, 400);
    assert.equal(projects.episodes.findShot(project.id, shot.id).shot.sceneId, sceneA.id, "非法修改不得改变落盘的 sceneId");

    // 悬空：改挂到不存在的场 → 400
    assert.equal(catchError(() => projects.episodes.updateShot(project.id, shot.id, { sceneId: "sc_9999" })).status, 400);
});

test("重排：只改 index，绝不改 Shot.id（契约 §4 / 陷阱 6）", (t) => {
    const env = makeEnv();
    t.after(env.cleanup);
    const { projects } = env;
    const project = projects.create({ title: "甲" });
    const episode = projects.episodes.save(project.id, { title: "第一集" }).episode;
    const scene = projects.episodes.addScene(project.id, episode.id, { locationId: "loc", time: "夜", intent: "i" }).scene;
    const shots = [0, 1, 2].map(() => projects.episodes.addShot(project.id, scene.id, {}).shot);
    const idsBefore = shots.map((shot) => shot.id);

    // 倒序重排
    const { episode: reordered } = projects.episodes.reorder(project.id, episode.id, { shotIds: [...idsBefore].reverse() });
    assert.deepEqual(reordered.shots.map((shot) => shot.id), [...idsBefore].reverse(), "顺序变了");
    assert.deepEqual(reordered.shots.map((shot) => shot.index), [1, 2, 3]);
    assert.deepEqual(new Set(reordered.shots.map((shot) => shot.id)), new Set(idsBefore), "id 集合不变");

    const onDisk = readEpisodeFile(env.root, project.id, episode.id);
    assert.deepEqual(new Set(onDisk.shots.map((shot) => shot.id)), new Set(idsBefore), "落盘后 id 恒定");
    assert.deepEqual(onDisk.shots.map((shot) => shot.id), [...idsBefore].reverse());

    // 非法排列（缺项 / 多余项）→ 400
    assert.equal(catchError(() => projects.episodes.reorder(project.id, episode.id, { shotIds: idsBefore.slice(0, 2) })).status, 400);
    assert.equal(catchError(() => projects.episodes.reorder(project.id, episode.id, { shotIds: [...idsBefore, "sh_x"] })).status, 400);
});

test("HTTP 集成：/api/projects/:id 下的集/场/镜、资产与门禁路由", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-episodes-http-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    const mod = await import("../src/index.js");
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${mod.server.address().port}`;
    const asJson = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const jget = async (path) => (await fetch(`${base}${path}`)).json();
    try {
        const project = (await (await fetch(`${base}/api/projects`, asJson({ title: "端到端" }))).json()).project;

        const created = await fetch(`${base}/api/projects/${project.id}/episodes`, asJson({ title: "第一集" }));
        assert.equal(created.status, 201);
        const episode = (await created.json()).episode;
        assert.equal(episode.id, "ep_0001");

        const badScene = await fetch(`${base}/api/projects/${project.id}/episodes/${episode.id}/scenes`, asJson({ time: "夜", intent: "i" }));
        assert.equal(badScene.status, 400, "缺 locationId 应 400");

        const scene = (await (await fetch(`${base}/api/projects/${project.id}/episodes/${episode.id}/scenes`, asJson({ locationId: "loc", time: "夜", intent: "开场" }))).json()).scene;
        const shot = (await (await fetch(`${base}/api/projects/${project.id}/scenes/${scene.id}/shots`, asJson({}))).json()).shot;
        assert.match(shot.id, /^sh_/);

        const cross = await fetch(`${base}/api/projects/${project.id}/scenes/${scene.id}/shots`, asJson({ sceneId: "sc_0002" }));
        assert.equal(cross.status, 400, "跨集/悬空引用应 400");

        const reordered = (await (await fetch(`${base}/api/projects/${project.id}/episodes/${episode.id}/reorder`, asJson({ shotIds: [shot.id] }))).json()).episode;
        assert.equal(reordered.shots[0].id, shot.id, "重排后 id 不变");

        const asset = (await (await fetch(`${base}/api/projects/${project.id}/asset-refs`, asJson({ role: "character", bindingId: "char_1", artifactIds: ["a1"] }))).json()).assetRef;
        assert.equal(asset.bindingId, "char_1");

        const gates = await jget(`/api/projects/${project.id}/gates`);
        assert.equal(gates.gates.length, 7);
        assert.ok(gates.gates.some((gate) => gate.stageId === "keyframe"));

        const ctx = await jget(`/api/projects/${project.id}/context?include=refs`);
        assert.deepEqual(Object.keys(ctx).sort(), ["assetRefs", "canvasIds", "episodes", "gates", "project", "runIds"]);

        assert.equal((await fetch(`${base}/api/projects/prj_missing/episodes`)).status, 404);
        assert.equal((await fetch(`${base}/api/projects/${project.id}/episodes`)).status, 200);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

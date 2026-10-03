import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 回马枪·影响分析 HTTP 路由集成测试（POST /api/projects/:id/impact、GET .../impact/options）。
 * 只做分析、不真跑：这里从不触碰 ComfyUI / LLM（地址都指向不可达端口），也不入队 job。
 * 隔离环境：临时 data/skills 目录 + 不可达的 Comfy/LLM，避免污染真实数据。
 */
const root = mkdtempSync(join(tmpdir(), "canvas-impact-"));
process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
process.env.CANVAS_SERVER_SKILLS_DIR = join(root, "skills");
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_LLM_MODEL = "test-model";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
mkdirSync(process.env.CANVAS_SERVER_SKILLS_DIR, { recursive: true });

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_LLM_MODEL", "CANVAS_SERVER_COMFY_URL"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const jsonReq = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, jsonReq(body));
    return { res, data: await res.json() };
};
const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { res, data: await res.json() };
};

/**
 * 造一个可控项目：1 集 2 场 4 镜；c1（老周）被 sh1（场1）与 sh3（场2）引用，c2（小李）只被 sh2 引用。
 * 全部走真实 HTTP 路由写盘，确保影响分析读的是存储里的权威事实。
 */
async function makeFixture(title = "回马枪影响分析") {
    const project = (await post("/api/projects", { title })).data.project;
    const id = project.id;
    await post(`/api/projects/${id}/asset-refs`, { role: "character", bindingId: "c1", artifactIds: ["a1"], metadata: { name: "老周" } });
    await post(`/api/projects/${id}/asset-refs`, { role: "character", bindingId: "c2", artifactIds: ["a2"], metadata: { name: "小李" } });
    await post(`/api/projects/${id}/episodes`, { id: "ep_0001", index: 1, title: "第一集" });
    const sc1 = (await post(`/api/projects/${id}/episodes/ep_0001/scenes`, { locationId: "loc_a", time: "日", intent: "开场" })).data.scene;
    const sc2 = (await post(`/api/projects/${id}/episodes/ep_0001/scenes`, { locationId: "loc_b", time: "夜", intent: "冲突" })).data.scene;
    const sh1 = (await post(`/api/projects/${id}/scenes/${sc1.id}/shots`, { storyboard: { characters: ["c1"], summary: "老周入画" } })).data.shot;
    const sh2 = (await post(`/api/projects/${id}/scenes/${sc1.id}/shots`, { storyboard: { characters: ["c2"], summary: "小李反应" } })).data.shot;
    const sh3 = (await post(`/api/projects/${id}/scenes/${sc2.id}/shots`, { storyboard: { characters: ["c1"], summary: "老周转身" } })).data.shot;
    const sh4 = (await post(`/api/projects/${id}/scenes/${sc2.id}/shots`, { storyboard: { characters: [], summary: "空镜" } })).data.shot;
    return { id, sc1, sc2, sh1, sh2, sh3, sh4 };
}

const sorted = (list) => [...list].sort();

/* --------------------------- 合法请求 --------------------------- */

test("impact 路由可用：合法 assetRef 变更返回 200 JSON（无 router.post is not a function）", async () => {
    const { id, sh1, sh2, sh3, sh4 } = await makeFixture();
    const { res, data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "assetRef", id: "c1" }] });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(data.projectId, id);
    // 只有引用 c1 的镜头 stale，其余 keep
    assert.deepEqual(sorted(data.stale), sorted([sh1.id, sh3.id]));
    assert.deepEqual(sorted(data.keep), sorted([sh2.id, sh4.id]));
});

test("impact：reasons 是可读中文，指向具体 changed 项并给出受影响镜头数", async () => {
    const { id } = await makeFixture("可读原因");
    const { data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "assetRef", id: "c1", revision: 2 }] });

    assert.ok(Array.isArray(data.reasons));
    assert.equal(data.reasons.length, 1);
    assert.equal(data.reasons[0].changed.type, "assetRef");
    assert.equal(data.reasons[0].changed.id, "c1");
    assert.equal(data.reasons[0].changed.revision, 2);
    assert.match(data.reasons[0].text, /角色「老周」的三视图已变/);
    assert.match(data.reasons[0].text, /2 个镜头需要重跑/);
});

test("impact：summary 计数正确（角色变更只连累镜头，不连累场/集）", async () => {
    const { id } = await makeFixture("计数");
    const { data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "assetRef", id: "c1" }] });

    assert.deepEqual(data.summary, { total: 2, affectedShots: 2, affectedScenes: 0, affectedEpisodes: 0, affectedCues: 0, affectedDeliverables: 0 });
});

test("impact：改单镜（type=shot）只 stale 该镜，其它镜 keep", async () => {
    const { id, sh1, sh2, sh3, sh4 } = await makeFixture("单镜");
    const { data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "shot", id: sh1.id }] });

    assert.deepEqual(data.stale, [sh1.id]);
    assert.deepEqual(sorted(data.keep), sorted([sh2.id, sh3.id, sh4.id]));
    assert.equal(data.summary.affectedShots, 1);
});

test("impact：改某场（type=scene）→ 该场与其镜头 stale，另一场不受影响", async () => {
    const { id, sc1, sh1, sh2, sh3, sh4 } = await makeFixture("改场");
    const { data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "scene", id: sc1.id }] });

    assert.deepEqual(data.staleScenes, [sc1.id]);
    assert.deepEqual(sorted(data.staleShots), sorted([sh1.id, sh2.id]));
    assert.deepEqual(sorted(data.keep), sorted([sh3.id, sh4.id]));
});

test("impact：改剧本（根输入）→ 下游整体 stale，keep 为空", async () => {
    const { id, sc1, sc2, sh1, sh2, sh3, sh4 } = await makeFixture("改剧本");
    const { data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "script", id: "script", revision: 12 }] });

    assert.deepEqual(sorted(data.staleShots), sorted([sh1.id, sh2.id, sh3.id, sh4.id]));
    assert.deepEqual(sorted(data.staleScenes), sorted([sc1.id, sc2.id]));
    assert.deepEqual(data.staleEpisodes, ["ep_0001"]);
    assert.deepEqual(data.keep, []);
    assert.equal(data.summary.affectedShots, 4);
    assert.match(data.reasons[0].text, /剧本已变更/);
});

test("impact：多项 changed 取并集（c1 变更 + sh4 变更）", async () => {
    const { id, sh1, sh3, sh4 } = await makeFixture("并集");
    const { data } = await post(`/api/projects/${id}/impact`, {
        changed: [
            { type: "assetRef", id: "c1" },
            { type: "shot", id: sh4.id },
        ],
    });

    assert.deepEqual(sorted(data.staleShots), sorted([sh1.id, sh3.id, sh4.id]));
    assert.equal(data.reasons.length, 2, "每条 changed 各一条可读 reason");
});

/* --------------------------- 参数校验 --------------------------- */

test("impact：空 changed → 400 且错误可解释", async () => {
    const { id } = await makeFixture("空 changed");
    const { res, data } = await post(`/api/projects/${id}/impact`, { changed: [] });

    assert.equal(res.status, 400);
    assert.match(data.error.message, /changed 不能为空/);
});

test("impact：缺少 changed → 400", async () => {
    const { id } = await makeFixture("缺 changed");
    const { res, data } = await post(`/api/projects/${id}/impact`, {});

    assert.equal(res.status, 400);
    assert.match(data.error.message, /缺少 changed/);
});

test("impact：changed 非数组 → 400", async () => {
    const { id } = await makeFixture("changed 非数组");
    const { res, data } = await post(`/api/projects/${id}/impact`, { changed: "c1" });

    assert.equal(res.status, 400);
    assert.match(data.error.message, /必须是数组/);
});

test("impact：变更类型非法 → 400", async () => {
    const { id } = await makeFixture("非法类型");
    const { res, data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "bogus", id: "c1" }] });

    assert.equal(res.status, 400);
    assert.match(data.error.message, /变更类型非法/);
});

test("impact：changed 项缺少 id → 400", async () => {
    const { id } = await makeFixture("缺 id");
    const { res, data } = await post(`/api/projects/${id}/impact`, { changed: [{ type: "assetRef" }] });

    assert.equal(res.status, 400);
    assert.match(data.error.message, /缺少 id/);
});

test("impact：项目不存在 → 404", async () => {
    const { res, data } = await post("/api/projects/prj_does_not_exist/impact", { changed: [{ type: "assetRef", id: "c1" }] });

    assert.equal(res.status, 404);
    assert.match(data.error.message, /项目不存在/);
});

/* --------------------------- options --------------------------- */

test("impact/options：返回 assetRefs / shots / scenes 与扁平 options（带名字与 revision）", async () => {
    const { id, sc1, sh1 } = await makeFixture("下拉选项");
    const { res, data } = await get(`/api/projects/${id}/impact/options`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(data.projectId, id);

    assert.equal(data.assetRefs.length, 2);
    assert.equal(data.shots.length, 4);
    assert.equal(data.scenes.length, 2);

    const charRef = data.assetRefs.find((row) => row.bindingId === "c1");
    assert.equal(charRef.role, "character");
    assert.equal(charRef.name, "老周");
    assert.ok(charRef.revision !== undefined && charRef.revision !== null, "assetRef 带 revision");
    assert.ok(data.assetRefs.every((row) => row.revision !== undefined && row.revision !== null));
    assert.ok(data.shots.every((row) => row.id && row.revision !== undefined && row.revision !== null));

    assert.ok(data.options.some((row) => row.type === "assetRef" && row.id === charRef.id && /角色：老周/.test(row.label)));
    assert.ok(data.options.some((row) => row.type === "shot" && row.id === sh1.id));
    assert.ok(data.options.some((row) => row.type === "scene" && row.id === sc1.id));
});

test("impact/options：项目不存在 → 404", async () => {
    const { res, data } = await get("/api/projects/prj_does_not_exist/impact/options");

    assert.equal(res.status, 404);
    assert.match(data.error.message, /项目不存在/);
});

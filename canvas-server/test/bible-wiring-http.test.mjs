import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * P0-f 接线的 HTTP 实打：/api/projects/:id/bibles 系列 + /gates 圣经放行判据。
 * 隔离环境（临时 data/skills、不可达 ComfyUI），绝不碰真实项目业务数据。
 */

const root = mkdtempSync(join(tmpdir(), "canvas-bible-http-"));
const skillsDir = join(root, "skills");
mkdirSync(skillsDir, { recursive: true });
writeFileSync(
    join(skillsDir, "registry.json"),
    JSON.stringify({
        version: 1,
        stages: [
            { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
            { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
            { id: "design", title: "服化道", skill: "03-design", requires: ["script"], produces: "design" },
            { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design"], produces: "keyframes" },
            { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
        ],
    }),
);

process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_LLM_MODEL = "test-model";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9"; // 不可达：绝不真跑
const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_MODEL", "CANVAS_SERVER_COMFY_URL"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const json = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (path, body) => fetch(`${base}${path}`, json(body));
const gateById = (gates) => Object.fromEntries(gates.map((gate) => [gate.stageId, gate]));
const makeProject = async (title) => (await (await post("/api/projects", { title })).json()).project;

test("HTTP：创建圣经 → 未批准挡门禁 → 推进 approved/locked 放行 → 改已锁派生新 revision → 非法迁移 400", async () => {
    const project = await makeProject("圣经 HTTP 实打");

    // 列表：空
    const listRes = await fetch(`${base}/api/projects/${project.id}/bibles`);
    assert.equal(listRes.status, 200);
    assert.match(listRes.headers.get("content-type"), /application\/json/);
    assert.deepEqual((await listRes.json()).bibles, []);

    // 未批准时门禁：无实体 → 不挡
    let gates = gateById((await (await fetch(`${base}/api/projects/${project.id}/gates`)).json()).gates);
    assert.equal(gates.script.ready, true, "无 Bible 实体 → 不阻断（向后兼容）");

    // 创建 SeriesBible（draft / revision 1）
    const createRes = await post(`/api/projects/${project.id}/bibles`, { kind: "series", logline: "一条主线" });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()).bible;
    assert.equal(created.status, "draft");
    assert.equal(created.revision, 1);
    assert.match(created.id, /^bib_/);

    // 未批准 → script 被阻，reason 可读
    gates = gateById((await (await fetch(`${base}/api/projects/${project.id}/gates`)).json()).gates);
    assert.equal(gates.script.ready, false, "存在未批准 SeriesBible → script 被阻");
    const blocker = gates.script.blockedBy.find((item) => item.type === "bible");
    assert.ok(blocker && blocker.stageId === "script" && blocker.kind === "series");
    assert.match(gates.script.reason, /圣经未批准/);

    // 非法迁移：draft 直达 lock → 400 且原因可读
    const illegal = await post(`/api/projects/${project.id}/bibles/${created.id}/transition`, { action: "lock" });
    assert.equal(illegal.status, 400);
    const illegalBody = await illegal.json();
    assert.match(illegalBody.error.message, /非法迁移/);
    assert.match(illegalBody.error.message, /submit_review/);

    // 合法推进：submit_review → approve
    const submitted = await post(`/api/projects/${project.id}/bibles/${created.id}/transition`, { action: "submit_review" });
    assert.equal(submitted.status, 200);
    assert.equal((await submitted.json()).to, "review");
    const approvedRes = await post(`/api/projects/${project.id}/bibles/${created.id}/transition`, { action: "approve", actor: "pm" });
    assert.equal(approvedRes.status, 200);
    const approved = (await approvedRes.json()).bible;
    assert.equal(approved.status, "approved");

    // 已批准 → script 放行
    gates = gateById((await (await fetch(`${base}/api/projects/${project.id}/gates`)).json()).gates);
    assert.equal(gates.script.ready, true, "已批准 → 放行");
    assert.equal(gates.script.blockedBy.some((item) => item.type === "bible"), false);

    // 锁定 → 仍放行
    const lockRes = await post(`/api/projects/${project.id}/bibles/${created.id}/transition`, { action: "lock" });
    assert.equal(lockRes.status, 200);
    assert.equal((await lockRes.json()).bible.status, "locked");

    // 改已锁 → 新 revision，不静默覆盖（PATCH）
    const patchRes = await fetch(`${base}/api/projects/${project.id}/bibles/${created.id}`, json({ logline: "改后的主线", actor: "editor" }, "PATCH"));
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.changed, true);
    assert.equal(patchBody.requiresNewRevision, true, "改已锁 → 派生新 revision");
    assert.equal(patchBody.bible.revision, 2);
    assert.equal(patchBody.bible.status, "draft");
    assert.equal(patchBody.bible.logline, "改后的主线");
    assert.equal(patchBody.bible.history.at(-1).status, "locked");
    assert.equal(patchBody.bible.history.at(-1).logline, "一条主线", "旧 revision 原内容保留");

    // 回到未批准 → 门禁再次被阻
    gates = gateById((await (await fetch(`${base}/api/projects/${project.id}/gates`)).json()).gates);
    assert.equal(gates.script.ready, false, "新 revision 未批准 → 再次被阻");

    // 契约路径 POST 改实体 + 单条 GET
    const postUpdate = await post(`/api/projects/${project.id}/bibles/${created.id}`, { theme: "宿命" });
    assert.equal(postUpdate.status, 200);
    const oneRes = await fetch(`${base}/api/projects/${project.id}/bibles/${created.id}`);
    assert.equal(oneRes.status, 200);
    const one = (await oneRes.json()).bible;
    assert.equal(one.theme, "宿命");
    assert.equal(one.revision, 2, "draft 就地合并，不涨 revision");

    // 非法类别 → 400
    const badKind = await post(`/api/projects/${project.id}/bibles`, { kind: "nope" });
    assert.equal(badKind.status, 400);
    assert.match((await badKind.json()).error.message, /kind/);

    // context?include=refs 的 gates 同样带圣经判据
    const ctx = await (await fetch(`${base}/api/projects/${project.id}/context?include=refs`)).json();
    assert.equal(gateById(ctx.gates).script.ready, false);
});

test("HTTP：不存在的项目/实体 → 404；空 patch 幂等不涨 revision", async () => {
    const missingProject = await fetch(`${base}/api/projects/prj_nope/bibles`);
    assert.equal(missingProject.status, 404);

    const project = await makeProject("圣经 HTTP 404");
    const missingBible = await fetch(`${base}/api/projects/${project.id}/bibles/bib_nope`);
    assert.equal(missingBible.status, 404);

    const created = (await (await post(`/api/projects/${project.id}/bibles`, { kind: "audio", bgmDirection: "舒缓" })).json()).bible;
    const same = await fetch(`${base}/api/projects/${project.id}/bibles/${created.id}`, json({ bgmDirection: "舒缓" }, "PATCH"));
    const body = await same.json();
    assert.equal(body.changed, false, "同值 patch 幂等");
    assert.equal(body.bible.revision, 1);
});

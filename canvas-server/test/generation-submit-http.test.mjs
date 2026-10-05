import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * M1 统一提交链 HTTP 真链路（隔离实例，ComfyUI 指向不可达地址，绝不真跑生成）：
 *   · POST /api/generate/image：meta 归属字段（source/projectId/shotId/slotId/toolId/idempotencyKey）透传进 job.meta；
 *   · 同 idempotencyKey 重放 → 返回原 Job、队列不膨胀；
 *   · meta.projectId 指向不存在的项目 → 拒绝（400/409 级），不入队；
 *   · POST /api/images/enqueue：source="workbench"、projectId/toolId 同形写入。
 * 三条链的 job.meta 归属字段同形（契约 §3.10）。
 */

const root = mkdtempSync(join(tmpdir(), "canvas-submit-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_WEB_DIR = join(root, "webdist");
delete process.env.CANVAS_SERVER_PORT;
delete process.env.CANVAS_SERVER_HOST;

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_WEB_DIR"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const post = (url, payload) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const getJob = async (id) => (await (await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`)).json()).job;

test("/api/generate/image：归属 meta 透传 + 同 idempotencyKey 重放返回原 Job", async () => {
    const project = (await (await post("/api/projects", { title: "M1 提交链" })).json()).project;

    const meta = { projectId: project.id, shotId: "sh_0001", slotId: "slot_sh_0001_start", idempotencyKey: "m1-http-key-1" };
    const res = await post("/api/generate/image", { template: "img_zimage_artistic", params: { PROMPT: "一只猫", WIDTH: 1024, HEIGHT: 1024 }, meta });
    assert.equal(res.status, 201);
    const first = (await res.json()).job;

    const stored = await getJob(first.id);
    assert.equal(stored.meta.source, "api", "缺省 source 按 api 记账");
    assert.equal(stored.meta.projectId, project.id);
    assert.equal(stored.meta.shotId, "sh_0001");
    assert.equal(stored.meta.slotId, "slot_sh_0001_start");
    assert.equal(stored.meta.toolId, "img_zimage_artistic");
    assert.equal(stored.meta.idempotencyKey, "m1-http-key-1");
    assert.ok(String(stored.params.PROMPT || "").trim().length > 0, "编译降级也不得产生空 prompt");

    // 重放：同 key 再提交 → 同一个 job id，队列计数不变。
    const before = (await (await fetch(`${base}/api/jobs`)).json()).jobs.length;
    const replay = await post("/api/generate/image", { template: "img_zimage_artistic", params: { PROMPT: "一只猫", WIDTH: 1024, HEIGHT: 1024 }, meta });
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).job.id, first.id);
    const afterReplay = (await (await fetch(`${base}/api/jobs`)).json()).jobs.length;
    assert.equal(afterReplay, before, "重放不得新增 Job");
});

test("/api/generate/image：meta.projectId 指向不存在的项目 → 拒绝且不入队", async () => {
    const before = (await (await fetch(`${base}/api/jobs`)).json()).jobs.length;
    const res = await post("/api/generate/image", {
        template: "img_zimage_artistic",
        params: { PROMPT: "一只猫", WIDTH: 1024, HEIGHT: 1024 },
        meta: { projectId: "prj_nope" },
    });
    assert.ok([400, 409].includes(res.status), `悬空 projectId 应拒绝（400/409），实际 ${res.status}`);
    assert.match((await res.json()).error.message, /项目不存在/);
    const afterRejected = (await (await fetch(`${base}/api/jobs`)).json()).jobs.length;
    assert.equal(afterRejected, before);
});

test("/api/images/enqueue：source=workbench、projectId/toolId 与直连链同形", async () => {
    const project = (await (await post("/api/projects", { title: "M1 工作台" })).json()).project;
    const res = await post("/api/images/enqueue", { template: "img_zimage_artistic", prompt: "一只猫", projectId: project.id });
    assert.equal(res.status, 201);
    const created = (await res.json()).jobs;
    assert.equal(created.length, 1);
    const stored = await getJob(created[0].id);
    assert.equal(stored.meta.source, "workbench");
    assert.equal(stored.meta.projectId, project.id);
    assert.equal(stored.meta.toolId, "img_zimage_artistic");
    assert.ok(String(stored.params.PROMPT || "").trim().length > 0);
});

test("/api/images/enqueue：projectId 指向不存在的项目 → 拒绝且不入队", async () => {
    const res = await post("/api/images/enqueue", { template: "img_zimage_artistic", prompt: "一只猫", projectId: "prj_nope" });
    assert.ok([400, 409].includes(res.status));
    assert.match((await res.json()).error.message, /项目不存在/);
});

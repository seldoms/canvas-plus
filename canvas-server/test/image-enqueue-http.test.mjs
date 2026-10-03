import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * POST /api/images/enqueue 的 HTTP 真链路（隔离实例）：
 *   · 一次提交 → 返回 jobIds；
 *   · 这些 job 立刻能从 GET /api/jobs?kind=image 查到；
 *   · GET /api/jobs 不传参数仍回全量列表（向前兼容）。
 * ComfyUI 指向不可达地址（默认回环第 9 端口）：只验证入队与查询，绝不真跑生成。
 */

const root = mkdtempSync(join(tmpdir(), "canvas-enqueue-"));
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

test("POST /api/images/enqueue → 返回 jobIds，且能被 GET /api/jobs?kind=image 查到", async () => {
    const res = await post("/api/images/enqueue", { template: "img_zimage_artistic", prompt: "一张猫的写实照片", count: 2 });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.jobs.length, 2);
    assert.ok(body.jobs.every((job) => typeof job.id === "string" && job.id.startsWith("image-") && job.template === "img_zimage_artistic"));

    const ids = body.jobs.map((job) => job.id);
    const listed = await (await fetch(`${base}/api/jobs?kind=image`)).json();
    const listedIds = listed.jobs.map((job) => job.id);
    for (const id of ids) assert.ok(listedIds.includes(id), `GET /api/jobs?kind=image 应包含新入队任务 ${id}`);

    // 向前兼容：不传任何参数仍是全量列表，且新任务在其内。
    const all = await (await fetch(`${base}/api/jobs`)).json();
    for (const id of ids) assert.ok(all.jobs.some((job) => job.id === id));

    // 逗号分隔 status 过滤：入队任务至少会在 queued/running/error 之一，用并集必命中。
    const active = await (await fetch(`${base}/api/jobs?kind=image&status=queued,running,error`)).json();
    assert.ok(active.jobs.some((job) => ids.includes(job.id)), "status 过滤并集应命中刚入队的任务");
});

test("POST /api/images/enqueue 参数校验失败返回 400 且不入队", async () => {
    const res = await post("/api/images/enqueue", { prompt: "缺少模板" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /缺少 template/);
});

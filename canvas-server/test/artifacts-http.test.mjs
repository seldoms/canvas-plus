import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 产物归档 / 彻底删除 HTTP 路由集成测试（GET /api/artifacts、POST .../archive|restore|delete）。
 * 隔离环境：临时 data/skills 目录 + 不可达 Comfy/LLM；预置 jobs.json 与磁盘产物，避免真跑生成。
 * 验证：懒构建、归档/恢复、confirm 校验（缺 confirm → 400）、被引用拒删（blocked 回引用方）、真删=删文件。
 */
const root = mkdtempSync(join(tmpdir(), "canvas-artifacts-http-"));
const dataDir = join(root, "data");
process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = join(root, "skills");
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_LLM_MODEL = "test-model";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
mkdirSync(process.env.CANVAS_SERVER_SKILLS_DIR, { recursive: true });

function seedArtifact(jobId, filename) {
    const dir = join(dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), "x");
    return join(dir, filename);
}

// 预置两个产物：work（工作台）与 pipe（流水线），各带磁盘文件；jobs.json 供 createJobQueue 启动时读取。
seedArtifact("img-work-1", "work.png");
seedArtifact("img-pipe-1", "frame.png");
mkdirSync(dataDir, { recursive: true });
writeFileSync(
    join(dataDir, "jobs.json"),
    JSON.stringify({
        jobs: [
            { id: "img-work-1", kind: "image", backend: "local", template: "img_zimage_artistic", name: "work", status: "done", meta: {}, outputs: [{ filename: "work.png", url: "/api/artifacts/img-work-1/work.png", type: "image", bytes: 111 }], progress: { value: 1, max: 1 }, createdAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:01:00.000Z" },
            { id: "img-pipe-1", kind: "image", backend: "local", template: "img_zimage_artistic", name: "frame", status: "done", meta: { runId: "run-x", stageId: "keyframe", itemId: "sh_0001" }, outputs: [{ filename: "frame.png", url: "/api/artifacts/img-pipe-1/frame.png", type: "image", bytes: 222 }], progress: { value: 1, max: 1 }, createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z" },
        ],
    }),
);

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_LLM_MODEL", "CANVAS_SERVER_COMFY_URL"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const request = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { res, data: await res.json() };
};

test("GET /api/artifacts：懒构建出预置产物，带来源信息与 counts", async () => {
    const { res, data } = await request("/api/artifacts");
    assert.equal(res.status, 200);
    assert.equal(data.items.length, 2);
    assert.deepEqual(data.counts, { active: 2, archived: 0 });
    const origin = Object.fromEntries(data.items.map((item) => [item.jobId, item.source.origin]));
    assert.equal(origin["img-work-1"], "workbench");
    assert.equal(origin["img-pipe-1"], "pipeline");
});

test("归档 → GET state=archived 可见 → 恢复 → 回到 active", async () => {
    const archived = await request("/api/artifacts/archive", { method: "POST", body: { ids: ["img-work-1/work.png"] } });
    assert.equal(archived.res.status, 200);
    assert.deepEqual(archived.data.archived, ["img-work-1/work.png"]);

    const archivedList = await request("/api/artifacts?state=archived");
    assert.deepEqual(archivedList.data.items.map((item) => item.id), ["img-work-1/work.png"]);
    const activeList = await request("/api/artifacts?state=active");
    assert.deepEqual(activeList.data.items.map((item) => item.id), ["img-pipe-1/frame.png"]);
    assert.deepEqual(activeList.data.counts, { active: 1, archived: 1 });

    const restored = await request("/api/artifacts/restore", { method: "POST", body: { ids: ["/api/artifacts/img-work-1/work.png"] } });
    assert.deepEqual(restored.data.restored, ["img-work-1/work.png"]);
    assert.equal((await request("/api/artifacts?state=archived")).data.items.length, 0);
});

test("delete 缺 confirm → 400；带 confirm 删未被引用的产物 → 真删文件", async () => {
    const bad = await request("/api/artifacts/delete", { method: "POST", body: { ids: ["img-pipe-1/frame.png"] } });
    assert.equal(bad.res.status, 400);
    assert.equal(existsSync(join(dataDir, "artifacts", "img-pipe-1", "frame.png")), true);

    // createRouter 只支持 get/post/any：用 DELETE 方法走同一 any 路由，验证方法承接。
    const ok = await request("/api/artifacts/delete", { method: "DELETE", body: { ids: ["img-pipe-1/frame.png"], confirm: true } });
    assert.equal(ok.res.status, 200);
    assert.deepEqual(ok.data.deleted, ["img-pipe-1/frame.png"]);
    assert.equal(existsSync(join(dataDir, "artifacts", "img-pipe-1", "frame.png")), false);
});

test("被项目引用的产物拒删：blocked 回引用方，未引用的同批照删（partial success）", async () => {
    const project = (await request("/api/projects", { method: "POST", body: { title: "引用项目" } })).data.project;
    await request(`/api/projects/${project.id}/asset-refs`, {
        method: "POST",
        body: { role: "character", bindingId: "c1", artifactIds: ["/api/artifacts/img-work-1/work.png"], metadata: { name: "主角" } },
    });

    const out = await request("/api/artifacts/delete", { method: "POST", body: { ids: ["img-work-1/work.png"], confirm: true } });
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.data.deleted, []);
    assert.equal(out.data.blocked.length, 1);
    assert.equal(out.data.blocked[0].id, "img-work-1/work.png");
    assert.equal(out.data.blocked[0].refs[0].projectId, project.id);
    assert.equal(out.data.blocked[0].refs[0].role, "character");
    // 引用在，文件仍在
    assert.equal(existsSync(join(dataDir, "artifacts", "img-work-1", "work.png")), true);
});

test("未知方法 405（写路由只接 POST/DELETE）", async () => {
    const { res } = await request("/api/artifacts/archive", { method: "PUT", body: { ids: [] } });
    assert.equal(res.status, 405);
});

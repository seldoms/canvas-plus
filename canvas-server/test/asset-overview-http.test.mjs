import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// 隔离环境：临时 data/skills，ComfyUI 指向不可达地址（绝不真跑生成）。
const root = mkdtempSync(join(tmpdir(), "canvas-asset-overview-http-"));
process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
process.env.CANVAS_SERVER_SKILLS_DIR = join(root, "skills");
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
});

async function call(pathname, init) {
    const res = await fetch(`${base}${pathname}`, init);
    return { status: res.status, contentType: res.headers.get("content-type") || "", body: await res.json() };
}

const jsonInit = (method, payload) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("GET /api/asset-refs：空数据返回零计数（且是 JSON，不是 SPA 回落页）", async () => {
    const res = await call("/api/asset-refs");
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.deepEqual(res.body.assetRefs, []);
    assert.equal(res.body.counts.total, 0);
    assert.deepEqual(res.body.counts.byRole, {});
});

test("GET /api/asset-refs：跨项目聚合真实返回已解析字段与计数", async () => {
    const a = await call("/api/projects", jsonInit("POST", { title: "接口甲" }));
    assert.equal(a.status, 201);
    const b = await call("/api/projects", jsonInit("POST", { title: "接口乙" }));
    const aId = a.body.project.id;
    const bId = b.body.project.id;

    const ref = await call(
        `/api/projects/${aId}/asset-refs`,
        jsonInit("POST", {
            role: "character",
            bindingId: "c1",
            artifactIds: ["/api/artifacts/x1.png", "/api/artifacts/x2.png"],
            selectedArtifactId: "/api/artifacts/x2.png",
            metadata: { name: "老周", kind: "reference", stageId: "design" },
        }),
    );
    assert.equal(ref.status, 201);
    await call(`/api/projects/${bId}/asset-refs`, jsonInit("POST", { role: "clip", bindingId: "sh1-clip", artifactIds: ["/api/artifacts/v1.mp4"], metadata: { stageId: "assembly" } }));

    const res = await call("/api/asset-refs");
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.total, 2);
    assert.deepEqual(res.body.counts.byRole, { character: 1, clip: 1 });
    assert.equal(res.body.counts.byProject.length, 2);

    const char = res.body.assetRefs.find((row) => row.role === "character");
    assert.equal(char.projectId, aId);
    assert.equal(char.projectTitle, "接口甲");
    assert.equal(char.name, "老周");
    assert.equal(char.kind, "reference");
    assert.equal(char.url, "/api/artifacts/x2.png");
    assert.equal(char.artifactCount, 2);
    assert.equal(char.stageId, "design");
});

test("GET /api/asset-refs：损坏项目被跳过并记 warning，接口仍 200", async () => {
    const brokenDir = join(root, "data", "projects", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "project.json"), "{ broken json", "utf8");

    const res = await call("/api/asset-refs");
    assert.equal(res.status, 200);
    assert.ok(res.body.warnings.some((w) => w.includes("broken")));
    // 上一个用例建的两个项目仍在
    assert.ok(res.body.counts.total >= 2);
});

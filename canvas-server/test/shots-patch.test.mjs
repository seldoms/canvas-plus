import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// —— 隔离环境：临时 data/skills，LLM/ComfyUI 指向不可达地址 ——
// 本测试只验证「改镜头」这条路径的方法匹配（前端走 PATCH），不建真实项目：
// 项目不存在应当返回**业务 404**，而不是「方法不符 → 未找到路由」的兜底 404。
const root = mkdtempSync(join(tmpdir(), "canvas-shots-patch-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_WEB_DIR = join(root, "webdist"); // 不存在：只提供 API

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_WEB_DIR"]) {
        delete process.env[key];
    }
    rmSync(root, { recursive: true, force: true });
});

const shotsUrl = `${base}/api/projects/prj_nope/shots/sh_nope`;
const patchShot = (body) => fetch(shotsUrl, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PATCH /api/projects/:id/shots/:shotId 命中路由，不再返回「未找到路由」", async () => {
    const res = await patchShot({ status: "confirmed" });
    // 项目不存在是**业务**结果；关键是被 PATCH 打到了，而不是方法不符被 dispatch 跳过。
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error.message, /项目不存在：prj_nope/);
    assert.doesNotMatch(body.error.message, /未找到路由/);
});

test("POST 同一条路径行为不变（仍进业务逻辑）", async () => {
    const res = await fetch(shotsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error.message, /项目不存在：prj_nope/);
    assert.doesNotMatch(body.error.message, /未找到路由/);
});

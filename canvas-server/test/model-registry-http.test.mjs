import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

// —— 隔离环境：临时 data（含一个 deepseek 渠道），ComfyUI 指向不可达地址（绝不真跑生成）——
const root = mkdtempSync(join(tmpdir(), "canvas-model-registry-http-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(
    join(dataDir, "llm-providers.json"),
    JSON.stringify({ providers: [{ name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-test" }] }),
    "utf8",
);
process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

// 真机对齐：本地模板数 = canvas-server/workflows/*.json 的实际个数。
const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const templateNames = readdirSync(workflowsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
});

async function call(pathname, init) {
    const res = await fetch(`${base}${pathname}`, init);
    return { status: res.status, body: await res.json() };
}
const jsonInit = (method, payload) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("启动即完成首次同步（模板 + LLM 渠道全部登记）；显式 POST sync 幂等", async () => {
    // 注册表是模型清单的唯一读源（网关不再探测上游），所以 index.js 启动就 sync 一次：
    // 否则全新环境要等用户手动点「同步」，/v1/models 会一直是空的。
    const listed = await call("/api/model-registry");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.counts.total, templateNames.length + 1, "18 个本地模板 + 1 个 deepseek 渠道");
    assert.ok(listed.body.models.some((model) => model.name === "deepseek"));

    const res = await call("/api/model-registry/sync", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.added, [], "启动已同步过，再 sync 不应新增");
    assert.deepEqual(res.body.staled, []);
    assert.deepEqual(res.body.refreshed, [], "渠道声明没变就不该刷新");
    assert.equal(res.body.kept, templateNames.length + 1);
});

test("GET /api/model-registry 分类正确：image/video/audio + deepseek→text", async () => {
    const res = await call("/api/model-registry");
    assert.equal(res.status, 200);
    const { models, counts } = res.body;
    assert.equal(counts.total, templateNames.length + 1);
    assert.equal(counts.audio, 1);
    assert.equal(counts.text, 1);
    assert.equal(counts.image + counts.video + counts.audio, templateNames.length);

    const byName = new Map(models.map((m) => [m.name, m]));
    for (const name of templateNames) assert.ok(byName.has(name), `未登记模板 ${name}`);
    assert.equal(byName.get("audio_qwen3_tts").category, "audio");
    assert.equal(byName.get("audio_qwen3_tts").alias, "千问3 语音合成");
    assert.equal(byName.get("img_qwen21_t2i").category, "image");
    assert.equal(byName.get("img_qwen21_t2i").alias, "千问2.1 文生图");
    assert.equal(byName.get("upscale_4x").category, "image");
    assert.equal(byName.get("video_h3_i2v").category, "video");
    assert.equal(byName.get("video_h3_i2v").runtime, "local");
    assert.equal(byName.get("deepseek").category, "text");
    assert.equal(byName.get("deepseek").runtime, "cloud");
    assert.equal(byName.get("deepseek").source, "channel");
});

test("PATCH 改 alias + enabled 后再 sync 不被冲掉；sync 幂等", async () => {
    const list = await call("/api/model-registry");
    const target = list.body.models.find((m) => m.name === "img_qwen21_t2i");

    const patched = await call(
        `/api/model-registry/${target.id}`,
        jsonInit("PATCH", { alias: "我的自定义别名", enabled: false }),
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.model.alias, "我的自定义别名");
    assert.equal(patched.body.model.enabled, false);

    const again = await call("/api/model-registry/sync", { method: "POST" });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.added, []);
    assert.deepEqual(again.body.staled, []);

    const after = await call("/api/model-registry");
    const kept = after.body.models.find((m) => m.id === target.id);
    assert.equal(kept.alias, "我的自定义别名");
    assert.equal(kept.enabled, false);
    // 未改过的条目仍是默认别名 + 启用
    assert.equal(after.body.models.find((m) => m.name === "img_qwen21_edit").alias, "千问2.1 改图");
});

test("PATCH name 不可改（400）；POST 重复 name（409）", async () => {
    const list = await call("/api/model-registry");
    const target = list.body.models.find((m) => m.name === "img_qwen21_t2i");
    const bad = await call(`/api/model-registry/${target.id}`, jsonInit("PATCH", { name: "别的名字" }));
    assert.equal(bad.status, 400);

    const dup = await call("/api/model-registry", jsonInit("POST", { name: "img_qwen21_t2i", category: "image" }));
    assert.equal(dup.status, 409);
    const ok = await call("/api/model-registry", jsonInit("POST", { name: "my_manual_model", category: "image", alias: "手工模型" }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.model.source, "manual");
});

test("GET ?category=&enabled=true 过滤；DELETE 删登记", async () => {
    const filtered = await call("/api/model-registry?category=image&enabled=true");
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.models.length > 0);
    assert.ok(filtered.body.models.every((m) => m.category === "image" && m.enabled === true));

    const created = await call("/api/model-registry", jsonInit("POST", { name: "delete_me", category: "audio" }));
    const removed = await call(`/api/model-registry/${created.body.model.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed.name, "delete_me");
    const gone = await call(`/api/model-registry/${created.body.model.id}`, { method: "DELETE" });
    assert.equal(gone.status, 404);
});

test("GET /api/model-registry/available 输出「可用 vs 已登记」差异", async () => {
    const res = await call("/api/model-registry/available");
    assert.equal(res.status, 200);
    assert.equal(res.body.available.length, templateNames.length + 1);
    assert.equal(res.body.registered, templateNames.length + 2); // 模板 + deepseek + my_manual_model
    assert.deepEqual(res.body.missing, []);
    assert.ok(res.body.available.some((item) => item.name === "deepseek" && item.category === "text"));
});

test("未支持的 :id 方法返回 405", async () => {
    const list = await call("/api/model-registry");
    const id = list.body.models[0].id;
    const res = await call(`/api/model-registry/${id}`, { method: "POST" });
    assert.equal(res.status, 405);
});

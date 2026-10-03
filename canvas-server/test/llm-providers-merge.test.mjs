import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// —— 隔离环境：临时 data/skills，预置一份带 key 的渠道注册表 ——
const root = mkdtempSync(join(tmpdir(), "canvas-llm-merge-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

const providersFile = join(dataDir, "llm-providers.json");
const seed = {
    providers: [
        { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "***" },
        { name: "kimi", baseUrl: "https://api.moonshot.cn", apiKey: "***" },
        { name: "localgw", baseUrl: "http://127.0.0.1:1234", apiKey: "" },
    ],
};
writeFileSync(providersFile, JSON.stringify(seed, null, 2));

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9"; // 不可达：本测试不依赖本机 LLM
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

const listProviders = async () => (await (await fetch(`${base}/api/llm/providers`)).json()).providers;
const readFileProviders = () => JSON.parse(readFileSync(providersFile, "utf8")).providers;

const postProviders = (providers) =>
    fetch(`${base}/api/llm/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers }),
    });

const deleteProvider = (name) => fetch(`${base}/api/llm/providers/${encodeURIComponent(name)}`, { method: "DELETE" });

const byName = (list) => Object.fromEntries(list.map((item) => [item.name, item]));

test("POST 只含部分渠道 → 既有渠道仍在，且原 key 未被清空（不全量替换）", async () => {
    // 模拟浏览器提交它自带的那份列表：只有 browser-gpt，没有服务端的 deepseek。
    const res = await postProviders([{ name: "browser-gpt", baseUrl: "https://browser.example.com/v1" }]);
    assert.equal(res.status, 200);
    const list = await listProviders();
    const map = byName(list);

    assert.ok(map.deepseek, "服务端既有渠道 deepseek 不能被浏览器列表冲掉");
    assert.ok(map.kimi, "服务端既有渠道 kimi 不能被冲掉");
    assert.ok(map.localgw, "服务端既有渠道 localgw 不能被冲掉");
    assert.ok(map["browser-gpt"], "浏览器渠道应被新增进注册表");
    assert.equal(map["browser-gpt"].baseUrl, "https://browser.example.com/v1");

    // 落盘文件里原 key 必须一字未动（GET 脱敏不回传 key，但文件里要保持明文）。
    const fileMap = byName(readFileProviders());
    assert.equal(fileMap.deepseek.apiKey, "***", "deepseek 的 key 不能被清空");
    assert.equal(fileMap.kimi.apiKey, "***", "kimi 的 key 不能被清空");
    assert.equal(fileMap.localgw.apiKey, "", "无 key 渠道保持无 key");
});

test("同名 upsert：baseUrl 更新、apiKey 为空时保留原 key", async () => {
    const res = await postProviders([
        { name: "deepseek", baseUrl: "https://api.deepseek.com/" }, // 尾部斜杠应被规整
        { name: "kimi", baseUrl: "https://new-kimi.example.com", apiKey: "" }, // 空 key → 保留原 key
    ]);
    assert.equal(res.status, 200);
    const map = byName(await listProviders());
    assert.equal(map.deepseek.baseUrl, "https://api.deepseek.com", "同名渠道 baseUrl 应被更新（去掉尾斜杠）");
    assert.equal(map.kimi.baseUrl, "https://new-kimi.example.com", "同名渠道 baseUrl 应被更新");
    assert.equal(map.deepseek.hasKey, true, "apiKey 未提供时应保留原 key（hasKey 仍为 true）");
    assert.equal(map.kimi.hasKey, true, "apiKey 为空时应保留原 key");

    const fileMap = byName(readFileProviders());
    assert.equal(fileMap.deepseek.apiKey, "***", "未提供 apiKey 时文件里的原 key 必须保留");
    assert.equal(fileMap.kimi.apiKey, "***", "apiKey 为空串时文件里的原 key 必须保留");
});

test("提交空数组 → 不删任何渠道", async () => {
    const before = await listProviders();
    const res = await postProviders([]);
    assert.equal(res.status, 200);
    const after = await listProviders();
    assert.deepEqual(
        after.map((p) => p.name).sort(),
        before.map((p) => p.name).sort(),
        "空数组必须是 no-op，绝不删除渠道",
    );
});

test("DELETE /api/llm/providers/:name 删除指定渠道；不存在返回可解释 404", async () => {
    // 新增一个一次性渠道再删除，避免影响其它断言。
    await postProviders([{ name: "to-delete", baseUrl: "https://temp.example.com" }]);
    assert.ok(byName(await listProviders())["to-delete"], "前置：渠道已存在");

    const res = await deleteProvider("to-delete");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.removed, "to-delete");
    assert.ok(!byName(await listProviders())["to-delete"], "删除后不应再出现在清单里");
    assert.ok(!byName(readFileProviders())["to-delete"], "删除后不应再出现在落盘文件里");
    // 既有渠道不受删除影响。
    assert.ok(byName(await listProviders()).deepseek, "删除单个渠道不应波及其它渠道");

    const missing = await deleteProvider("no-such-channel");
    assert.equal(missing.status, 404);
    const err = await missing.json();
    assert.match(err.error.message, /渠道不存在：no-such-channel/, "404 必须可解释，指出渠道名");
});

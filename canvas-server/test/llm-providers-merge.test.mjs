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

test("同名 upsert：不改地址 + 不传/空 apiKey → 200，原 key 保留", async () => {
    // 真实场景：GET 只回脱敏清单（hasKey 而非 apiKey），浏览器把这份渠道表回环提交。
    const res = await postProviders([
        { name: "deepseek", baseUrl: "https://api.deepseek.com" }, // 不传 apiKey
        { name: "kimi", baseUrl: "https://api.moonshot.cn", apiKey: "" }, // 空 apiKey
    ]);
    assert.equal(res.status, 200);
    const map = byName(await listProviders());
    assert.equal(map.deepseek.hasKey, true, "不传 apiKey 时内存渠道表必须保留原 key");
    assert.equal(map.kimi.hasKey, true, "apiKey 为空串时内存渠道表必须保留原 key");

    const fileMap = byName(readFileProviders());
    assert.equal(fileMap.deepseek.apiKey, "***", "不传 apiKey 时落盘文件里的原 key 不能被清空");
    assert.equal(fileMap.kimi.apiKey, "***", "apiKey 为空串时落盘文件里的原 key 不能被清空");
});

test("同名 upsert：改地址 + 提供新 apiKey → 200，地址与新 key 一起更新", async () => {
    const res = await postProviders([{ name: "kimi", baseUrl: "https://new-kimi.example.com", apiKey: "kimi-new-key" }]);
    assert.equal(res.status, 200);
    const map = byName(await listProviders());
    assert.equal(map.kimi.baseUrl, "https://new-kimi.example.com", "换地址 + 新 key 时地址应更新");
    assert.equal(map.kimi.hasKey, true, "换地址 + 新 key 后渠道仍应有 key");

    const fileMap = byName(readFileProviders());
    assert.equal(fileMap.kimi.baseUrl, "https://new-kimi.example.com", "落盘 baseUrl 应为新地址");
    assert.equal(fileMap.kimi.apiKey, "kimi-new-key", "落盘 apiKey 应为新 key，而不是沿用原 key");
});

test("同名 upsert：改地址 + 不传/空 apiKey → 400，落盘文件与渠道表一字未变", async () => {
    const beforeFile = readFileSync(providersFile, "utf8");
    const beforeList = await listProviders();

    const noKey = await postProviders([{ name: "deepseek", baseUrl: "https://evil.example.com" }]);
    assert.equal(noKey.status, 400, "已存 key 的渠道换地址而不给新 key 必须被拒");
    const emptyKey = await postProviders([{ name: "deepseek", baseUrl: "https://evil.example.com", apiKey: "" }]);
    assert.equal(emptyKey.status, 400, "已存 key 的渠道换地址而只给空 apiKey 同样必须被拒");
    assert.match((await noKey.json()).error.message, /更换地址时必须同时提供新的 API Key/, "400 必须说明拒绝原因");

    assert.equal(readFileSync(providersFile, "utf8"), beforeFile, "被拒的请求不得改动落盘文件");
    const fileMap = byName(readFileProviders());
    assert.equal(fileMap.deepseek.baseUrl, "https://api.deepseek.com", "落盘 baseUrl 必须保持原值");
    assert.equal(fileMap.deepseek.apiKey, "***", "落盘 key 必须保持原值，绝不能被转发到新地址");
    assert.deepEqual(await listProviders(), beforeList, "被拒的请求不得改动内存渠道表");
});

test("同名 upsert：只差尾部斜杠的同址 → 200，地址规整后仍是原址", async () => {
    const res = await postProviders([{ name: "deepseek", baseUrl: "https://api.deepseek.com//" }]);
    assert.equal(res.status, 200, "只差尾部斜杠不算换地址，不应触发换 key 守卫");
    const map = byName(await listProviders());
    assert.equal(map.deepseek.baseUrl, "https://api.deepseek.com", "同址提交后地址仍为规整后的原址");
    assert.equal(map.deepseek.hasKey, true, "只差尾部斜杠时原 key 必须保留");

    const fileMap = byName(readFileProviders());
    assert.equal(fileMap.deepseek.baseUrl, "https://api.deepseek.com", "落盘 baseUrl 应去掉尾部斜杠");
    assert.equal(fileMap.deepseek.apiKey, "***", "只差尾部斜杠时落盘原 key 必须保留");
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

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// —— 隔离环境：临时 data/skills，假本地 LLM 与假外部渠道，ComfyUI 指向不可达地址 ——
const root = mkdtempSync(join(tmpdir(), "canvas-gateway-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

const startStub = (handler) =>
    new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
const closeStub = (stub) => {
    stub.server.closeAllConnections?.();
    stub.server.close();
};
const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(payload);
};
const readReq = (req) =>
    new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

// 本地 Ollama：/api/tags 出模型；/v1/chat/completions 回一个 OpenAI 形状，用于验证本地模型仍原样转发。
let localSeen = null;
const local = await startStub(async (req, res) => {
    if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "qwen3.8:27b" }] });
    if (req.url === "/v1/chat/completions") {
        localSeen = JSON.parse(await readReq(req));
        return json(res, 200, { choices: [{ message: { role: "assistant", content: "local-ok" } }] });
    }
    json(res, 404, {});
});

// 外部渠道：/v1/models 出两个模型；/v1/chat/completions 记录收到的模型名与鉴权头。
let extSeen = null;
const ext = await startStub(async (req, res) => {
    if (req.url === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] });
    if (req.url === "/v1/chat/completions") {
        extSeen = { body: JSON.parse(await readReq(req)), auth: req.headers.authorization };
        return json(res, 200, { choices: [{ message: { role: "assistant", content: "ext-ok" } }] });
    }
    json(res, 404, {});
});

// 无 Key 渠道：远端一律 401，模拟「拿不到 key 问不到模型列表」。
const nokey = await startStub((req, res) => json(res, 401, { error: { message: "unauthorized" } }));

// 死渠道：占一个端口后关掉，任何请求都连接被拒。
const deadPort = await new Promise((resolve) => {
    const srv = createServer(() => {});
    srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
    });
});

// 渠道注册表：index.js 启动时从 data/llm-providers.json 载入。
writeFileSync(
    join(dataDir, "llm-providers.json"),
    JSON.stringify({
        providers: [
            { name: "ext", baseUrl: ext.baseUrl, apiKey: "sk-ext" },
            { name: "nokey", baseUrl: nokey.baseUrl, apiKey: "" },
            { name: "dead", baseUrl: `http://127.0.0.1:${deadPort}` },
        ],
    }),
);

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_LLM_URL = local.baseUrl;
// defaultModel 指向外部渠道，用于验证「裸模型名回退到 defaultModel 所在渠道」。
process.env.CANVAS_SERVER_LLM_MODEL = "ext::deepseek-v4-pro";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9"; // 不可达：绝不真跑生成
process.env.CANVAS_SERVER_WEB_DIR = join(root, "webdist"); // 不存在：只提供 API

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const stub of [local, ext, nokey]) closeStub(stub);
    for (const key of [
        "CANVAS_SERVER_DATA_DIR",
        "CANVAS_SERVER_SKILLS_DIR",
        "CANVAS_SERVER_LLM_URL",
        "CANVAS_SERVER_LLM_MODEL",
        "CANVAS_SERVER_COMFY_URL",
        "CANVAS_SERVER_WEB_DIR",
    ]) {
        delete process.env[key];
    }
    rmSync(root, { recursive: true, force: true });
});

const postChat = (payload) =>
    fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("/v1/models 合并本地与外部渠道模型，探测失败/无 Key 的渠道被跳过且不报错", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));

    const ids = body.data.map((item) => item.id);
    assert.ok(ids.includes("qwen3.8:27b"), `本地模型应在列表里：${ids.join(",")}`);
    assert.ok(ids.includes("ext::deepseek-v4-pro"), `外部渠道模型应以「渠道名::模型名」列出：${ids.join(",")}`);
    assert.ok(ids.includes("ext::deepseek-flash"), `外部渠道模型应全部列出：${ids.join(",")}`);
    assert.ok(!ids.some((id) => id.startsWith("dead::")), "死渠道不应出现在列表里");
    assert.ok(!ids.some((id) => id.startsWith("nokey::")), "无 Key 渠道不应出现在列表里");
    assert.ok(body.data.every((item) => item.object === "model" && typeof item.id === "string"), "仍是标准 OpenAI 形状");
    assert.ok(Date.now() - started < 5000, "探测失败不应把列表接口拖慢");

    // 与 /api/providers 的 llm.models 同源：那边列出的模型这边必须都有。
    const providers = await (await fetch(`${base}/api/providers`)).json();
    for (const id of providers.llm.models) assert.ok(ids.includes(id), `/v1/models 缺少 /api/providers 列出的 ${id}`);
});

test("/v1/chat/completions 带渠道前缀的模型名路由到对应渠道，并用该渠道的 Key", async () => {
    extSeen = null;
    const res = await postChat({ model: "ext::deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "ext-ok");
    assert.ok(extSeen, "外部渠道应收到请求");
    assert.equal(extSeen.body.model, "deepseek-v4-pro", "前缀应被剥掉，上游只收模型名");
    assert.equal(extSeen.auth, "Bearer sk-ext", "应使用该渠道自己的 Key");
});

test("/v1/chat/completions 裸模型名与 defaultModel 外部模型同名时回退到该渠道", async () => {
    extSeen = null;
    const res = await postChat({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "ext-ok");
    assert.equal(extSeen.body.model, "deepseek-v4-pro");
});

test("/v1/chat/completions 未注册的渠道前缀返回清晰 400，而非含糊 404", async () => {
    const res = await postChat({ model: "nope::x", messages: [] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /未注册的外部 LLM 渠道：nope/);
});

test("/v1/chat/completions 本地模型名仍原样转发到本地 LLM", async () => {
    localSeen = null;
    const res = await postChat({ model: "qwen3.8:27b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "local-ok");
    assert.equal(localSeen.model, "qwen3.8:27b");
});

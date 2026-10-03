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
// localTagsHits / extModelsHits 用来证明「模型清单只读注册表」后网关**不再向上游探测**。
let localSeen = null;
let localTagsHits = 0;
const local = await startStub(async (req, res) => {
    if (req.url === "/api/tags") {
        localTagsHits += 1;
        return json(res, 200, { models: [{ name: "qwen3.8:27b" }] });
    }
    if (req.url === "/v1/chat/completions") {
        localSeen = JSON.parse(await readReq(req));
        return json(res, 200, { choices: [{ message: { role: "assistant", content: "local-ok" } }] });
    }
    json(res, 404, {});
});

// 外部渠道：/v1/models 出两个模型（**不应再被请求**）；/v1/chat/completions 记录收到的模型名与鉴权头。
let extSeen = null;
let extModelsHits = 0;
const ext = await startStub(async (req, res) => {
    if (req.url === "/v1/models") {
        extModelsHits += 1;
        return json(res, 200, { object: "list", data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] });
    }
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
// `models` 是渠道**声明**的模型 id —— 静态清单的唯一来源；nokey / dead 不声明，因此不会出现在清单里。
writeFileSync(
    join(dataDir, "llm-providers.json"),
    JSON.stringify({
        providers: [
            { name: "ext", baseUrl: ext.baseUrl, apiKey: "sk-ext", models: ["deepseek-v4-pro", "deepseek-flash"] },
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

test("/v1/models 只读注册表：列渠道声明的模型，且**不向上游发任何探测请求**", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));

    const ids = body.data.map((item) => item.id);
    assert.deepEqual(ids, ["ext::deepseek-v4-pro", "ext::deepseek-flash"], `清单应等于渠道声明的模型：${ids.join(",")}`);
    assert.ok(!ids.some((id) => id.startsWith("dead::")), "未声明模型的死渠道不产出 id");
    assert.ok(!ids.some((id) => id.startsWith("nokey::")), "未声明模型的无 Key 渠道不产出 id");
    assert.ok(!ids.includes("qwen3.8:27b"), "本地 Ollama 模型不再被自动发现：要列出来就登记渠道并声明模型 id");
    assert.ok(body.data.every((item) => item.object === "model" && typeof item.id === "string"), "仍是标准 OpenAI 形状");
    assert.ok(Date.now() - started < 2000, `静态清单不该有上游耗时，实际 ${Date.now() - started}ms`);
    assert.equal(extModelsHits, 0, "不得向外部渠道探测 /v1/models");
    assert.equal(localTagsHits, 0, "不得向本地 Ollama 探测 /api/tags");

    // 与 /api/providers、/api/llm/models 同源：三处清单必须逐字一致。
    const providers = await (await fetch(`${base}/api/providers`)).json();
    assert.deepEqual(providers.llm.models, ids);
    const llmModels = await (await fetch(`${base}/api/llm/models`)).json();
    assert.deepEqual(llmModels.models, ids);
    assert.equal(extModelsHits, 0, "三个清单接口都不允许触发探测");

    // 存活接口不再等 LLM 探测：llm 段是注册表静态事实，明确标注未探测。
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true, "网关能应答即存活，不因上游状态翻脸");
    assert.equal(health.llm.probed, false);
    assert.equal(health.llm.source, "registry");
    assert.deepEqual(health.llm.models, ids);
    assert.equal(extModelsHits, 0);
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

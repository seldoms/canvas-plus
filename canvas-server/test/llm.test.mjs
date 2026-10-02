import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { chat, forwardToLlm, listLlmModels, probeLlm } from "../src/providers/llm.js";

/** 起一个 stub 上游，返回 { server, baseUrl }。 */
function startStub(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}

function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

/** 关闭端口，用于验证 fallback 与不可达分支。 */
const DEAD_URL = "http://127.0.0.1:1";

test("listLlmModels：baseUrl 不带 /v1 时补 /v1，并兼容 OpenAI 形态", async (t) => {
    const paths = [];
    const stub = await startStub((req, res) => {
        paths.push(req.url);
        if (req.url === "/v1/models") {
            json(res, 200, { object: "list", data: [{ id: "alpha" }, { id: "beta" }, { id: "alpha" }] });
            return;
        }
        json(res, 404, { error: { message: "not found" } });
    });
    t.after(() => stub.server.close());

    const models = await listLlmModels({ llm: { baseUrl: stub.baseUrl, timeoutMs: 5000 } });
    assert.deepEqual(models, ["alpha", "beta"]);
    assert.ok(paths.includes("/v1/models"));
    assert.ok(paths.includes("/api/tags"), "Ollama 原生接口也应被探测");
});

test("listLlmModels：baseUrl 自带 /v1 或尾斜杠都不会拼出 /v1/v1", async (t) => {
    const paths = [];
    const stub = await startStub((req, res) => {
        paths.push(req.url);
        json(res, 200, req.url === "/v1/models" ? { data: [{ id: "only" }] } : {});
    });
    t.after(() => stub.server.close());

    const models = await listLlmModels({ llm: { baseUrl: `${stub.baseUrl}/v1/`, timeoutMs: 5000 } });
    assert.deepEqual(models, ["only"]);
    assert.ok(!paths.some((path) => path.includes("/v1/v1")), `不应出现 /v1/v1：${paths.join(",")}`);
    assert.ok(paths.includes("/api/tags"), `/api/tags 应从站点根请求：${paths.join(",")}`);
});

test("listLlmModels：解析 Ollama /api/tags 形态", async (t) => {
    const stub = await startStub((req, res) => {
        if (req.url === "/api/tags") {
            json(res, 200, { models: [{ name: "qwen3.8:27b", model: "qwen3.8:27b" }, { name: "gemma3:4b" }] });
            return;
        }
        json(res, 404, {});
    });
    t.after(() => stub.server.close());

    const models = await listLlmModels({ llm: { baseUrl: stub.baseUrl, timeoutMs: 5000 } });
    assert.deepEqual(models, ["qwen3.8:27b", "gemma3:4b"]);
});

test("listLlmModels：两种形态合并去重", async (t) => {
    const stub = await startStub((req, res) => {
        if (req.url === "/v1/models") {
            json(res, 200, { data: [{ id: "a" }, { id: "b" }] });
            return;
        }
        json(res, 200, { models: [{ name: "b" }, { name: "c" }] });
    });
    t.after(() => stub.server.close());

    const models = await listLlmModels({ llm: { baseUrl: stub.baseUrl, timeoutMs: 5000 } });
    assert.deepEqual(models, ["a", "b", "c"]);
});

test("主地址不可达时按 fallbacks 顺序生效，probe 返回实际地址", async (t) => {
    const stub = await startStub((req, res) => json(res, 200, { data: [{ id: "fallback-model" }] }));
    t.after(() => stub.server.close());

    const config = { llm: { baseUrl: DEAD_URL, fallbacks: [stub.baseUrl], timeoutMs: 5000 } };
    const probe = await probeLlm(config);
    assert.equal(probe.ok, true);
    assert.equal(probe.baseUrl, stub.baseUrl);
    assert.deepEqual(probe.models, ["fallback-model"]);
});

test("全部不可达时 probe 返回 ok:false 与可读中文错误", async () => {
    const probe = await probeLlm({ llm: { baseUrl: DEAD_URL, fallbacks: ["http://127.0.0.1:2"], timeoutMs: 5000 } });
    assert.equal(probe.ok, false);
    assert.equal(probe.baseUrl, DEAD_URL);
    assert.match(probe.error, /不可达|没有模型/);
    assert.match(probe.error, /127\.0\.0\.1:1/);
});

test("forwardToLlm：SSE 逐块透传，不缓冲整段", async (t) => {
    let upstreamFinished = false;
    const upstream = await startStub((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => {
            res.write("data: two\n\n");
            res.end();
            upstreamFinished = true;
        }, 80);
    });
    t.after(() => upstream.server.close());

    const gateway = http.createServer((req, res) => {
        forwardToLlm(req, res, { llm: { baseUrl: upstream.baseUrl, timeoutMs: 5000 } }, req.url).catch(() => {});
    });
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    t.after(() => gateway.close());

    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");

    let text = "";
    let finishedWhenFirstChunk = null;
    for await (const chunk of response.body) {
        if (!text) finishedWhenFirstChunk = upstreamFinished;
        text += Buffer.from(chunk).toString("utf8");
    }
    assert.equal(finishedWhenFirstChunk, false, "首块到达时上游应仍在输出，说明没有整体缓冲");
    assert.equal(text, "data: one\n\ndata: two\n\n");
});

test("forwardToLlm：上游不可达时返回 502 且带 CORS", async (t) => {
    const gateway = http.createServer((req, res) => {
        forwardToLlm(req, res, { llm: { baseUrl: DEAD_URL, timeoutMs: 5000 } }, req.url).catch(() => {});
    });
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    t.after(() => gateway.close());

    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/models`);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json();
    assert.match(body.error.message, /不可达/);
});

test("chat：非流式便捷调用，转发 model 且固定 stream:false", async (t) => {
    let received;
    const stub = await startStub(async (req, res) => {
        received = { url: req.url, body: JSON.parse(await new Promise((resolve) => {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })) };
        json(res, 200, { choices: [{ message: { role: "assistant", content: "你好" } }] });
    });
    t.after(() => stub.server.close());

    const result = await chat({ llm: { baseUrl: stub.baseUrl, defaultModel: "qwen3.8:27b", timeoutMs: 5000 } }, { messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(result.choices[0].message.content, "你好");
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.body.model, "qwen3.8:27b");
    assert.equal(received.body.stream, false);
});

test("chat：上游报错时抛出含地址与状态码的中文错误", async (t) => {
    const stub = await startStub((req, res) => json(res, 500, { error: { message: "boom" } }));
    t.after(() => stub.server.close());

    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, timeoutMs: 5000 } }, { messages: [], model: "m" }),
        (error) => {
            assert.match(error.message, /LLM 请求失败/);
            assert.match(error.message, new RegExp(`${stub.baseUrl}/v1/chat/completions`));
            assert.match(error.message, /500/);
            return true;
        },
    );
});

// 回归：外部渠道注册表引入后，/api/health 与 /api/llm/models 会逐个探测渠道。
// 若沿用 chat 的 600s 超时且串行探测，一个 TCP 连上就不回包的死链能把接口挂住几十分钟。
test("外部渠道挂死时按 probeTimeoutMs 跳过，不拖住本机与其它渠道", async (t) => {
    const local = await startStub((req, res) => {
        if (req.url === "/api/tags") json(res, 200, { models: [{ name: "qwen3.8:27b" }] });
        else json(res, 404, {});
    });
    const good = await startStub((req, res) => {
        if (req.url === "/v1/models") json(res, 200, { data: [{ id: "deepseek-v4-pro" }] });
        else json(res, 404, {});
    });
    const hang = await startStub(() => {}); // 永不回包
    t.after(() => {
        for (const stub of [local, good, hang]) {
            stub.server.closeAllConnections?.();
            stub.server.close();
        }
    });

    const started = Date.now();
    const models = await listLlmModels({
        llm: {
            baseUrl: local.baseUrl,
            timeoutMs: 600000, // chat 用的长超时，不应影响列模型探测
            probeTimeoutMs: 300,
            providers: [
                { name: "hang", baseUrl: hang.baseUrl },
                { name: "good", baseUrl: good.baseUrl, apiKey: "sk-test" },
            ],
        },
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(models, ["qwen3.8:27b", "good::deepseek-v4-pro"], "死渠道只应丢自己的模型，不能连累本机与其它渠道");
    assert.ok(elapsed < 3000, `探测应在 probeTimeoutMs 量级返回，实际 ${elapsed}ms`);
});

test("多个外部渠道并行探测，总耗时接近最慢的一个而非累加", async (t) => {
    const local = await startStub((req, res) => {
        if (req.url === "/api/tags") json(res, 200, { models: [{ name: "m0" }] });
        else json(res, 404, {});
    });
    const delayed = () =>
        startStub((req, res) => {
            setTimeout(() => {
                if (req.url === "/v1/models") json(res, 200, { data: [{ id: "m" }] });
                else json(res, 404, {});
            }, 400);
        });
    const stubs = [local, await delayed(), await delayed(), await delayed()];
    t.after(() => {
        for (const stub of stubs) {
            stub.server.closeAllConnections?.();
            stub.server.close();
        }
    });

    const started = Date.now();
    const models = await listLlmModels({
        llm: {
            baseUrl: local.baseUrl,
            probeTimeoutMs: 5000,
            providers: [
                { name: "a", baseUrl: stubs[1].baseUrl },
                { name: "b", baseUrl: stubs[2].baseUrl },
                { name: "c", baseUrl: stubs[3].baseUrl },
            ],
        },
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(models, ["m0", "a::m", "b::m", "c::m"]);
    assert.ok(elapsed < 1000, `并行应约 400ms，串行会 >=1200ms，实际 ${elapsed}ms`);
});

test("真实 Ollama 集成（不可达则跳过）", async (t) => {
    const probe = await probeLlm({ llm: { baseUrl: "http://127.0.0.1:11434", timeoutMs: 5000 } });
    if (!probe.ok) {
        t.skip(`Ollama 不可达：${probe.error}`);
        return;
    }
    assert.ok(probe.models.length > 0, "应至少返回一个模型");
    assert.ok(probe.models.every((name) => typeof name === "string" && name.length > 0));
});

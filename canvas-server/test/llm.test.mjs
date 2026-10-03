import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { chat, forwardToLlm, externalProviders } from "../src/providers/llm.js";

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

// 回归：模型清单已改为「只读注册表」（不再探测上游），本模块只保留**发请求**那条链路。
// 地址选择（主地址 → fallbacks）由 chat / forwardToLlm 承担，这里直接对它们取证。
test("主地址不可达时 chat 按 fallbacks 顺序落到可用地址", async (t) => {
    const stub = await startStub((req, res) => json(res, 200, { choices: [{ message: { role: "assistant", content: "来自 fallback" } }] }));
    t.after(() => stub.server.close());

    const result = await chat({ llm: { baseUrl: DEAD_URL, fallbacks: [stub.baseUrl], timeoutMs: 5000 } }, { messages: [], model: "m" });
    assert.equal(result.choices[0].message.content, "来自 fallback");
});

test("全部地址不可达时 chat 抛出列出已尝试地址的中文错误", async () => {
    await assert.rejects(
        () => chat({ llm: { baseUrl: DEAD_URL, fallbacks: ["http://127.0.0.1:2"], timeoutMs: 5000 } }, { messages: [], model: "m" }),
        (error) => {
            assert.match(error.message, /LLM 服务不可达/);
            assert.match(error.message, /127\.0\.0\.1:1/);
            assert.match(error.message, /127\.0\.0\.1:2/);
            return true;
        },
    );
});

test("externalProviders：渠道声明的 models 原样带出（静态清单来源），未声明则为空数组", () => {
    const providers = externalProviders({
        llm: {
            providers: [
                { name: "deepseek", baseUrl: "https://api.deepseek.com/", apiKey: "sk-x", models: ["deepseek-flash", " deepseek-v4-pro ", "", "deepseek-flash"] },
                { name: "dead", baseUrl: "https://ai.input.im" },
                { name: "", baseUrl: "https://no-name.example" },
            ],
        },
    });
    assert.deepEqual(providers, [
        { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x", models: ["deepseek-flash", "deepseek-v4-pro"] },
        { name: "dead", baseUrl: "https://ai.input.im", apiKey: "", models: [] },
    ]);
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

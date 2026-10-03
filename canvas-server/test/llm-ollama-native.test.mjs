import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { chat } from "../src/providers/llm.js";

/**
 * 回归：本地 Ollama 渠道必须走原生 /api/chat 并带上 options.num_ctx 与顶级 think:false，
 * 否则提示词超过 Modelfile 默认 8192 会被硬截断（模型返回残缺 JSON，keyframe 阶段报「模型未返回合法 JSON」）。
 * 外部 OpenAI 兼容渠道保持原路径 /chat/completions，不能把 num_ctx/think 透传过去。
 */

function startStub(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}

function closeStub(stub) {
    stub.server.closeAllConnections?.();
    stub.server.close();
}

/** 读完整请求体后交给回调，避免竞态。 */
function withBody(handler) {
    return (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            handler(req, res, raw ? JSON.parse(raw) : undefined);
        });
    };
}

function sendJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

/** Ollama 原生 /api/chat 的响应形状。 */
const nativeReply = (content) => ({ model: "m", message: { role: "assistant", content }, done: true, done_reason: "stop" });

test("本地 Ollama（显式标记）走原生 /api/chat，请求体带 options.num_ctx 与 think:false", async (t) => {
    let seen;
    const stub = await startStub(withBody((req, res, body) => {
        seen = { url: req.url, body };
        sendJson(res, 200, nativeReply("OK"));
    }));
    t.after(() => closeStub(stub));

    const result = await chat(
        { llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "qwen3.8:27b", numCtx: 32768, timeoutMs: 5000 } },
        { messages: [{ role: "user", content: "hi" }] },
    );
    assert.equal(seen.url, "/api/chat");
    assert.equal(seen.body.model, "qwen3.8:27b");
    assert.equal(seen.body.think, false, "原生调用必须传顶级 think:false 关掉思考");
    assert.equal(seen.body.stream, false);
    assert.equal(seen.body.options.num_ctx, 32768, "num_ctx 应取自 config.llm.numCtx");
    assert.equal(result.choices[0].message.content, "OK");
});

test("本地 Ollama：baseUrl 带 /v1 也走站点根的 /api/chat，不拼出 /v1/api/chat", async (t) => {
    const paths = [];
    const stub = await startStub(withBody((req, res) => {
        paths.push(req.url);
        sendJson(res, 200, nativeReply("ok"));
    }));
    t.after(() => closeStub(stub));

    await chat({ llm: { baseUrl: `${stub.baseUrl}/v1`, ollama: true, defaultModel: "m", timeoutMs: 5000 } }, { messages: [] });
    assert.deepEqual(paths, ["/api/chat"]);
});

test("本地 Ollama：num_ctx 由 rest.num_ctx 覆盖，rest.options 可再覆盖单项", async (t) => {
    const bodies = [];
    const stub = await startStub(withBody((req, res, body) => {
        bodies.push(body);
        sendJson(res, 200, nativeReply("ok"));
    }));
    t.after(() => closeStub(stub));
    const config = { llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "m", numCtx: 32768, timeoutMs: 5000 } };

    await chat(config, { messages: [], num_ctx: 8192 });
    await chat(config, { messages: [], options: { num_ctx: 16384, num_predict: 512 } });
    assert.equal(bodies[0].options.num_ctx, 8192);
    assert.equal(bodies[1].options.num_ctx, 16384);
    assert.equal(bodies[1].options.num_predict, 512);
});

test("本地 Ollama：temperature 落到 options.temperature（原生不认顶级 temperature）", async (t) => {
    let seen;
    const stub = await startStub(withBody((req, res, body) => {
        seen = body;
        sendJson(res, 200, nativeReply("ok"));
    }));
    t.after(() => closeStub(stub));

    await chat({ llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "m", timeoutMs: 5000 } }, { messages: [], temperature: 0 });
    assert.equal(seen.options.temperature, 0);
    assert.equal(seen.temperature, undefined);
});

test("本地 Ollama：原生 {message:{content}} 归一成 OpenAI 形状，文本提取正确", async (t) => {
    const stub = await startStub(withBody((req, res) => sendJson(res, 200, nativeReply("镜头提示词正文"))));
    t.after(() => closeStub(stub));

    const result = await chat({ llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "m", timeoutMs: 5000 } }, { messages: [] });
    assert.equal(result.choices[0].message.content, "镜头提示词正文", "调用方仍按 choices[0].message.content 取值");
    assert.equal(result.message.content, "镜头提示词正文", "原生字段也保留");
    assert.equal(result.done, true);
});

test("外部兼容渠道仍走 /chat/completions，且不透传 num_ctx/think", async (t) => {
    let seen;
    const stub = await startStub(withBody((req, res, body) => {
        seen = { url: req.url, body };
        sendJson(res, 200, { choices: [{ message: { role: "assistant", content: "你好" } }] });
    }));
    t.after(() => closeStub(stub));

    // 随机端口的非 11434 地址就是外部渠道，不得被误判为本地 Ollama。
    const result = await chat(
        { llm: { baseUrl: stub.baseUrl, defaultModel: "deepseek-v4-pro", timeoutMs: 5000 } },
        { messages: [], num_ctx: 999999, options: { num_predict: 1 } },
    );
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.body.num_ctx, undefined, "num_ctx 不应泄漏到外部渠道");
    assert.equal(seen.body.options, undefined);
    assert.equal(seen.body.think, undefined);
    assert.equal(seen.body.stream, false);
    assert.equal(result.choices[0].message.content, "你好");
});

test("外部渠道（::前缀）路由到渠道 baseUrl，仍走 /chat/completions", async (t) => {
    let seen;
    const stub = await startStub(withBody((req, res, body) => {
        seen = { url: req.url, body };
        sendJson(res, 200, { choices: [{ message: { content: "done" } }] });
    }));
    t.after(() => closeStub(stub));

    await chat(
        { llm: { baseUrl: "http://127.0.0.1:1", providers: [{ name: "rh", baseUrl: stub.baseUrl, apiKey: "k" }], timeoutMs: 5000 } },
        { messages: [], model: "rh::wan" },
    );
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.body.model, "wan");
});

test("本地 Ollama：超时仍归一 timeoutMs 并带地址抛出可读错误", async (t) => {
    const stub = await startStub(() => {}); // 永不回包
    t.after(() => closeStub(stub));

    const started = Date.now();
    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "m", timeoutMs: 250 } }, { messages: [] }),
        (error) => {
            assert.match(error.message, /未响应|超时/);
            assert.ok(error.message.includes(stub.baseUrl), `错误应带上下游地址：${error.message}`);
            return true;
        },
    );
    assert.ok(Date.now() - started < 3000, "超时应由 timeoutMs 触发");
});

test("本地 Ollama：外部 signal 取消立即中断，不等 timeoutMs", async (t) => {
    const stub = await startStub(() => {});
    t.after(() => closeStub(stub));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "m", timeoutMs: 30000 } }, { messages: [], signal: controller.signal }),
        /已取消/,
    );
    assert.ok(Date.now() - started < 3000, `取消应立即生效，实际 ${Date.now() - started}ms`);
});

test("本地 Ollama：上游非 2xx 抛出含地址与状态码的中文错误", async (t) => {
    const stub = await startStub(withBody((req, res) => sendJson(res, 500, { error: "boom" })));
    t.after(() => closeStub(stub));

    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, ollama: true, defaultModel: "m", timeoutMs: 5000 } }, { messages: [] }),
        (error) => {
            assert.match(error.message, /LLM 请求失败/);
            assert.ok(error.message.includes(`${stub.baseUrl}/api/chat`));
            assert.match(error.message, /500/);
            return true;
        },
    );
});

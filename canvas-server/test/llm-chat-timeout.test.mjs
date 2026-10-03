import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { chat } from "../src/providers/llm.js";

/**
 * 回归：chat() 不能用 Node 内置 fetch（undici，headersTimeout 默认 300s）。
 * ollama 非流式要整段生成完才发响应头，长生成 > 5 分钟会被 undici 先掐断，
 * 而 chat() 设的 timeoutMs（默认 10 分钟）根本没机会生效。
 * 这里用本地 stub 验证「超时完全由 timeoutMs 掌控、延迟响应头能等到、取消能立刻中断」
 * 这一行为契约（真等 5 分钟不现实，故不直接复现 300s 默认值）。
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

function okJson(res, content) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
}

test("chat：上游延迟发响应头（模拟长生成）时，在 timeoutMs 内仍能成功", async (t) => {
    const stub = await startStub((req, res) => {
        req.resume();
        req.on("end", () => {
            // 收完请求后延迟 700ms 才发响应头——等价于「生成完才回包」
            setTimeout(() => okJson(res, "长文结果"), 700);
        });
    });
    t.after(() => closeStub(stub));

    const result = await chat(
        { llm: { baseUrl: stub.baseUrl, defaultModel: "m", timeoutMs: 8000 } },
        { messages: [{ role: "user", content: "写" }] },
    );
    assert.equal(result.choices[0].message.content, "长文结果");
});

test("chat：上游先发响应头、再分块延迟发 body，新实现能等到完整 body 并聚合 JSON", async (t) => {
    const stub = await startStub((req, res) => {
        req.resume();
        req.on("end", () => {
            const body = JSON.stringify({ choices: [{ message: { content: "拼接完成" } }] });
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.write(body.slice(0, 12));
            setTimeout(() => {
                res.write(body.slice(12));
                res.end();
            }, 120);
        });
    });
    t.after(() => closeStub(stub));

    const result = await chat({ llm: { baseUrl: stub.baseUrl, timeoutMs: 8000 } }, { messages: [], model: "m" });
    assert.equal(result.choices[0].message.content, "拼接完成");
});

test("chat：超过自定义 timeoutMs 未收到响应头时抛可读超时错误", async (t) => {
    const stub = await startStub(() => {}); // 永不回包
    t.after(() => closeStub(stub));

    const started = Date.now();
    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, timeoutMs: 250 } }, { messages: [], model: "m" }),
        (error) => {
            assert.match(error.message, /未响应|超时/);
            assert.ok(error.message.includes(stub.baseUrl), `错误应带上游地址：${error.message}`);
            return true;
        },
    );
    assert.ok(Date.now() - started < 3000, "超时应由 timeoutMs 触发，不能依赖 undici 的 300s 默认值");
});

test("chat：外部 signal 取消时立即中断在途请求，不等 timeoutMs", async (t) => {
    const stub = await startStub(() => {}); // 永不回包
    t.after(() => closeStub(stub));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, timeoutMs: 30000 } }, { messages: [], model: "m", signal: controller.signal }),
        /已取消/,
    );
    assert.ok(Date.now() - started < 3000, `取消应立即生效，实际 ${Date.now() - started}ms`);
});

test("chat：已取消的 signal 在发请求前直接抛「已取消」", async (t) => {
    const stub = await startStub((req, res) => okJson(res, "不应被调用"));
    t.after(() => closeStub(stub));

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, timeoutMs: 5000 } }, { messages: [], model: "m", signal: controller.signal }),
        /已取消/,
    );
});

test("chat：上游非 2xx 时仍抛出含地址与状态码的中文错误", async (t) => {
    const stub = await startStub((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "boom" } }));
        });
    });
    t.after(() => closeStub(stub));

    await assert.rejects(
        () => chat({ llm: { baseUrl: stub.baseUrl, timeoutMs: 5000 } }, { messages: [], model: "m" }),
        (error) => {
            assert.match(error.message, /LLM 请求失败/);
            assert.ok(error.message.includes(`${stub.baseUrl}/v1/chat/completions`));
            assert.match(error.message, /500/);
            return true;
        },
    );
});

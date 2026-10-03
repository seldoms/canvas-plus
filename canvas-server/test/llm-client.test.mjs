import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { callLlm, llmCall, LlmError, findProvider, DEFAULT_MODEL } from "../src/llm-client.js";

/**
 * llm-client 行为契约回归（用本地 stub 验，不等真超时）：
 *   成功 / 超时 / 取消 / 非 2xx / finish_reason=length / 渠道缺失。
 * 关键点：用 node:http 发请求（避开 undici 300s headersTimeout），超时/取消可被精确区分。
 */

/** 起一个只处理 POST 的 stub server；handler(req,res) 自定义行为。 */
function startStub(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
        });
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise((done) => server.close(done)),
            });
        });
    });
}

/** 标准成功响应体。 */
function okBody(content = "Hello", finish = "stop") {
    return JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { total_tokens: 1 } });
}

const provider = (baseUrl) => ({ baseUrl, apiKey: "test-key" });

test("success：返回 text/finishReason/chars，请求体带 max_tokens=8192 与 stream:false，走 /v1/chat/completions", async () => {
    let seen = null;
    const stub = await startStub((req, res, body) => {
        seen = { url: req.url, body: JSON.parse(body), auth: req.headers.authorization };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okBody("好的，这是一段英文提示词", "stop"));
    });
    try {
        const r = await callLlm({ system: "sys", user: "user", provider: provider(stub.baseUrl) });
        assert.equal(r.text, "好的，这是一段英文提示词");
        assert.equal(r.finishReason, "stop");
        assert.equal(r.chars, r.text.length);
        assert.equal(r.model, DEFAULT_MODEL);
        assert.equal(seen.url, "/v1/chat/completions");
        assert.equal(seen.body.model, DEFAULT_MODEL);
        assert.equal(seen.body.stream, false);
        assert.equal(seen.body.max_tokens, 8192);
        assert.deepEqual(
            seen.body.messages.map((m) => m.role),
            ["system", "user"],
        );
        assert.equal(seen.auth, "Bearer test-key");
    } finally {
        await stub.close();
    }
});

test("success：model 覆盖生效（如 deepseek-v4-pro）", async () => {
    let seen = null;
    const stub = await startStub((req, res, body) => {
        seen = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okBody("x", "stop"));
    });
    try {
        const r = await callLlm({ user: "u", model: "deepseek-v4-pro", provider: provider(stub.baseUrl) });
        assert.equal(r.model, "deepseek-v4-pro");
        assert.equal(seen.model, "deepseek-v4-pro");
    } finally {
        await stub.close();
    }
});

test("timeout：永不回包 + timeoutMs=250 → 抛 llm_timeout，且很快（不是 undici 的 300s）", async () => {
    const stub = await startStub(() => {
        /* 故意不回包，也不 end */
    });
    try {
        const started = Date.now();
        await assert.rejects(
            callLlm({ user: "u", timeoutMs: 250, provider: provider(stub.baseUrl) }),
            (error) => error instanceof LlmError && error.code === "llm_timeout" && /250ms 未响应/.test(error.message),
        );
        assert.ok(Date.now() - started < 3000, "应远早于 undici 的 300s 就触发");
    } finally {
        await stub.close();
    }
});

test("cancel：外部 signal 中途 abort → 抛 llm_canceled（不误报超时）", async () => {
    const stub = await startStub(() => {
        /* 永不回包 */
    });
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(callLlm({ user: "u", timeoutMs: 30000, signal: controller.signal, provider: provider(stub.baseUrl) }), (error) => error.code === "llm_canceled");
    } finally {
        await stub.close();
    }
});

test("cancel：发请求前就已 abort 的 signal 直接抛 llm_canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(callLlm({ user: "u", signal: controller.signal, provider: provider("http://127.0.0.1:1") }), (error) => error.code === "llm_canceled");
});

test("non-2xx：401 → 抛 llm_http_401 且带状态码", async () => {
    const stub = await startStub((req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    try {
        await assert.rejects(callLlm({ user: "u", provider: provider(stub.baseUrl) }), (error) => error.code === "llm_http_401" && error.httpStatus === 401);
    } finally {
        await stub.close();
    }
});

test("finish_reason=length：callLlm 原样回报截断信号（不抛，调用方可感知）", async () => {
    const stub = await startStub((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okBody("partial", "length"));
    });
    try {
        const r = await callLlm({ user: "u", provider: provider(stub.baseUrl) });
        assert.equal(r.finishReason, "length");
        assert.equal(r.chars, 7);
    } finally {
        await stub.close();
    }
});

test("finish_reason=length + 空正文：llmCall 适配器抛错（绝不静默回退空稿）", async () => {
    const stub = await startStub((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okBody("", "length"));
    });
    try {
        // 空正文 → llm_empty 优先；有正文但 length → llm_truncated。两者都属于「不许静默当成功」。
        await assert.rejects(llmCall({ user: "u", provider: provider(stub.baseUrl) }), (error) => error.code === "llm_empty" && error.finishReason === "length");
    } finally {
        await stub.close();
    }
});

test("finish_reason=length + 非空正文：llmCall 抛 llm_truncated", async () => {
    const stub = await startStub((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okBody("partial text", "length"));
    });
    try {
        await assert.rejects(llmCall({ user: "u", provider: provider(stub.baseUrl) }), (error) => error.code === "llm_truncated" && error.chars === 12);
    } finally {
        await stub.close();
    }
});

test("llmCall 适配器成功时返回 string", async () => {
    const stub = await startStub((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okBody("A cat on a windowsill.", "stop"));
    });
    try {
        const text = await llmCall({ system: "s", user: "u", provider: provider(stub.baseUrl) });
        assert.equal(typeof text, "string");
        assert.equal(text, "A cat on a windowsill.");
    } finally {
        await stub.close();
    }
});

test("渠道缺失：未知 provider 名 → 抛 llm_unavailable", async () => {
    await assert.rejects(callLlm({ user: "u", provider: "no-such-channel-xyz" }), (error) => error.code === "llm_unavailable" && /no-such-channel-xyz/.test(error.message));
});

test("findProvider：默认渠道 deepseek 有 baseUrl", () => {
    const found = findProvider("deepseek");
    assert.ok(found && /^https?:\/\//.test(found.baseUrl), "渠道表应能查到 deepseek 的 baseUrl");
});

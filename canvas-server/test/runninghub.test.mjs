import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRunningHubOutputs, createRunningHubClient, listRunningHubModels, probeRunningHub, runRunningHubJob } from "../src/providers/runninghub.js";
import { RUNNINGHUB_MODELS } from "../src/runninghub-models.js";

const tmp = mkdtempSync(join(tmpdir(), "runninghub-test-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
}

/** 起一个本地 stub 冒充 RunningHub，记录全部原始请求。 */
async function startStub(handler) {
    const requests = [];
    const server = createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
            requests.push(request);
            handler(req, res, request);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function stubConfig(baseUrl, extra = {}) {
    return { dataDir: tmp, publicUrl: "", runninghub: { baseUrl, apiKey: "test-key", pollIntervalMs: 5, timeoutMs: 5000, ...extra } };
}

test("模型目录只保留 4 图 4 视频且字段完整", () => {
    assert.equal(RUNNINGHUB_MODELS.image.length, 4);
    assert.equal(RUNNINGHUB_MODELS.video.length, 4);
    assert.deepEqual(RUNNINGHUB_MODELS.image.map((item) => item.endpoint), [
        "z-image/turbo",
        "seedream-v4.5/text-to-image",
        "rhart-image-v1/text-to-image",
        "rhart-image-n-pro/text-to-image",
    ]);
    for (const item of [...RUNNINGHUB_MODELS.image, ...RUNNINGHUB_MODELS.video]) {
        assert.ok(item.id && item.name && item.endpoint && item.outputType && item.priceLabel, `字段缺失：${JSON.stringify(item)}`);
    }
});

test("listRunningHubModels 返回 { image, video } 且不请求上游", async () => {
    const stub = await startStub((req, res) => sendJson(res, 500, {}));
    try {
        const catalog = listRunningHubModels();
        assert.equal(catalog.image.length, 4);
        assert.equal(catalog.video.length, 4);
        assert.equal(stub.requests.length, 0);
    } finally {
        await stub.close();
    }
});

test("未配置 apiKey 时 probe 返回不可用且不发任何请求", async () => {
    const stub = await startStub((req, res) => sendJson(res, 200, { taskId: "1", status: "SUCCESS" }));
    try {
        const result = await probeRunningHub({ runninghub: { baseUrl: stub.baseUrl, apiKey: "" } });
        assert.equal(result.ok, false);
        assert.equal(result.error, "未配置 RunningHub API Key");
        assert.equal(result.baseUrl, stub.baseUrl);
        assert.equal(stub.requests.length, 0);
    } finally {
        await stub.close();
    }
});

test("probe 识别 806 / 1602，能拿到 status 字段即视为连通", async () => {
    const invalid = await startStub((req, res) => sendJson(res, 200, { taskId: "1", status: "", errorCode: "806", errorMessage: "APIKEY_USER_NOT_FOUND" }));
    try {
        const result = await probeRunningHub(stubConfig(invalid.baseUrl));
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, "806");
        assert.match(result.error, /Key 无效/);
        assert.equal(invalid.requests.length, 1);
    } finally {
        await invalid.close();
    }

    const missingHeader = await startStub((req, res) => sendJson(res, 200, { code: 1602, msg: "HEADER_API_KEY_NOT_FOUND" }));
    try {
        const result = await probeRunningHub(stubConfig(missingHeader.baseUrl));
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, "1602");
    } finally {
        await missingHeader.close();
    }

    const alive = await startStub((req, res) => sendJson(res, 200, { taskId: "999999999999999999", status: "", errorCode: "807", errorMessage: "APIKEY_TASK_NOT_FOUND" }));
    try {
        assert.equal((await probeRunningHub(stubConfig(alive.baseUrl))).ok, true);
    } finally {
        await alive.close();
    }
});

test("submit 带 Bearer 鉴权与 JSON body，兼容 taskId / task_id", async () => {
    const stub = await startStub((req, res, request) => {
        if (request.url === "/z-image/turbo") return sendJson(res, 200, { taskId: "1001" });
        if (request.url === "/seedream-v4.5/text-to-image") return sendJson(res, 200, { task_id: 1002 });
        sendJson(res, 404, { errorCode: "1000", errorMessage: "unknown endpoint" });
    });
    try {
        const client = createRunningHubClient(stubConfig(stub.baseUrl));
        assert.equal(client.configured, true);
        assert.equal(await client.submit("z-image/turbo", { prompt: "一只猫" }), "1001");
        assert.equal(await client.submit("/seedream-v4.5/text-to-image", { prompt: "一只狗" }), "1002");
        const [first, second] = stub.requests;
        assert.equal(first.method, "POST");
        assert.equal(first.headers.authorization, "Bearer test-key");
        assert.match(String(first.headers["content-type"]), /application\/json/);
        assert.deepEqual(JSON.parse(first.body.toString()), { prompt: "一只猫" });
        assert.equal(second.url, "/seedream-v4.5/text-to-image");
    } finally {
        await stub.close();
    }
});

test("query 状态机：QUEUED→RUNNING→SUCCESS，FAILED/CANCEL/errorCode/未知状态都抛错", async () => {
    const responses = [
        { taskId: "123", status: "QUEUED", errorCode: "", errorMessage: "" },
        { taskId: "123", status: "RUNNING", errorCode: "", errorMessage: "" },
        { taskId: "123", status: "SUCCESS", errorCode: "", errorMessage: "", results: [{ url: "https://example.com/a.png", outputType: "png" }] },
        { taskId: "123", status: "FAILED", errorCode: "", errorMessage: "", failedReason: { message: "显存不足" } },
        { taskId: "123", status: "CANCEL", errorCode: "", errorMessage: "" },
        { taskId: "123", status: "SUCCESS", errorCode: "806", errorMessage: "APIKEY_USER_NOT_FOUND" },
        { taskId: "123", status: "WEIRD_STATE", errorCode: "", errorMessage: "" },
    ];
    const stub = await startStub((req, res) => sendJson(res, 200, responses.shift()));
    try {
        const client = createRunningHubClient(stubConfig(stub.baseUrl));
        assert.equal((await client.query("123")).status, "QUEUED");
        assert.equal((await client.query("123")).status, "RUNNING");
        const done = await client.query("123");
        assert.equal(done.status, "SUCCESS");
        assert.deepEqual(done.results, [{ url: "https://example.com/a.png", outputType: "png" }]);
        await assert.rejects(() => client.query("123"), /任务失败：显存不足/);
        await assert.rejects(() => client.query("123"), /任务已取消/);
        await assert.rejects(() => client.query("123"), (error) => {
            assert.equal(error.errorCode, "806");
            return true;
        });
        await assert.rejects(() => client.query("123"), /未知任务状态：WEIRD_STATE/);
        assert.equal(stub.requests.length, 7);
        // taskId 是数值型，上游按数值解析
        assert.deepEqual(JSON.parse(stub.requests[0].body.toString()), { taskId: 123 });
    } finally {
        await stub.close();
    }
});

test("超长 taskId 直接拼数字字面量，不经过 Number 丢精度", async () => {
    const stub = await startStub((req, res) => sendJson(res, 200, { taskId: "1", status: "QUEUED", errorCode: "", errorMessage: "" }));
    try {
        await createRunningHubClient(stubConfig(stub.baseUrl)).query("2009215121247047681");
        assert.equal(stub.requests[0].body.toString(), '{"taskId":2009215121247047681}');
    } finally {
        await stub.close();
    }
});

test("uploadFile 用 file 字段发 multipart，并返回 data.download_url", async () => {
    const stub = await startStub((req, res) => sendJson(res, 200, { code: 0, data: { download_url: "https://cdn.example/upload/ref.png" } }));
    try {
        const client = createRunningHubClient(stubConfig(stub.baseUrl));
        assert.equal(await client.uploadFile(PNG, "ref.png"), "https://cdn.example/upload/ref.png");
        const request = stub.requests[0];
        assert.match(String(request.headers["content-type"]), /^multipart\/form-data; boundary=/);
        const body = request.body.toString("binary");
        assert.match(body, /name="file"/);
        assert.match(body, /filename="ref\.png"/);
        assert.ok(request.body.includes(PNG));
    } finally {
        await stub.close();
    }
});

test("submit 对网络/5xx/429 瞬态错误重试，401/403 不重试", async () => {
    let failures = 1;
    const transient = await startStub((req, res) => {
        if (failures > 0) {
            failures -= 1;
            return sendJson(res, 503, { errorMessage: "服务暂时不可用" });
        }
        sendJson(res, 200, { taskId: "2001" });
    });
    try {
        assert.equal(await createRunningHubClient(stubConfig(transient.baseUrl)).submit("z-image/turbo", {}), "2001");
        assert.equal(transient.requests.length, 2);
    } finally {
        await transient.close();
    }

    const denied = await startStub((req, res) => sendJson(res, 403, { errorCode: "806", errorMessage: "APIKEY_USER_NOT_FOUND" }));
    try {
        await assert.rejects(() => createRunningHubClient(stubConfig(denied.baseUrl)).submit("z-image/turbo", {}), (error) => {
            assert.equal(error.errorCode, "806");
            assert.match(error.message, /HTTP 403/);
            return true;
        });
        assert.equal(denied.requests.length, 1);
    } finally {
        await denied.close();
    }

    const exhausted = await startStub((req, res) => sendJson(res, 429, { errorMessage: "请求过于频繁" }));
    try {
        await assert.rejects(() => createRunningHubClient(stubConfig(exhausted.baseUrl)).submit("z-image/turbo", {}), /HTTP 429/);
        assert.equal(exhausted.requests.length, 3);
    } finally {
        await exhausted.close();
    }
});

test("collectRunningHubOutputs 下载 URL 产物并按扩展名判定 type，文本写 .txt", async () => {
    const mp4 = Buffer.from("0000001866747970", "hex");
    const stub = await startStub((req, res) => {
        if (req.url === "/result.png") {
            res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
            return res.end(PNG);
        }
        if (req.url === "/clip.mp4") {
            res.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length });
            return res.end(mp4);
        }
        sendJson(res, 404, {});
    });
    try {
        const outputs = await collectRunningHubOutputs(
            [{ url: `${stub.baseUrl}/result.png` }, { outputUrl: `${stub.baseUrl}/clip.mp4` }, { text: "分镜文本" }],
            "rh-job-1",
            stubConfig(stub.baseUrl),
        );
        assert.deepEqual(outputs.map((item) => item.type), ["image", "video", "file"]);
        assert.equal(outputs[0].url, "/api/artifacts/rh-job-1/result.png");
        assert.equal(outputs[0].bytes, PNG.length);
        assert.equal(outputs[2].filename, "rh-job-1.txt");
        assert.equal(readFileSync(join(tmp, "artifacts", "rh-job-1", "result.png")).length, PNG.length);
        assert.equal(readFileSync(join(tmp, "artifacts", "rh-job-1", "rh-job-1.txt"), "utf8"), "分镜文本");
        assert.ok(existsSync(join(tmp, "artifacts", "rh-job-1", "clip.mp4")));
    } finally {
        await stub.close();
    }
});

test("runRunningHubJob 缺 endpoint 抛中文错误", async () => {
    await assert.rejects(() => runRunningHubJob({ id: "rh-1", params: {} }, {}), /RunningHub 任务缺少 endpoint/);
});

test("runRunningHubJob 上传本机素材、轮询到 SUCCESS 并落盘", async () => {
    const local = join(tmp, "ref.png");
    writeFileSync(local, PNG);
    const queryResults = [
        { taskId: "3001", status: "QUEUED", errorCode: "", errorMessage: "" },
        { taskId: "3001", status: "RUNNING", errorCode: "", errorMessage: "" },
        { taskId: "3001", status: "SUCCESS", errorCode: "", errorMessage: "", results: [] },
    ];
    const stub = await startStub((req, res, request) => {
        const origin = `http://${request.headers.host}`;
        if (request.url === "/z-image/turbo") return sendJson(res, 200, { taskId: "3001" });
        if (request.url === "/media/upload/binary") return sendJson(res, 200, { code: 0, data: { download_url: `${origin}/uploaded/ref.png` } });
        if (request.url === "/query") {
            const next = queryResults.shift();
            if (next.status === "SUCCESS") next.results = [{ url: `${origin}/out.png` }];
            return sendJson(res, 200, next);
        }
        if (request.url === "/out.png") {
            res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
            return res.end(PNG);
        }
        sendJson(res, 404, {});
    });
    try {
        const progress = [];
        const patches = [];
        const job = { id: "rh-job-e2e", params: { endpoint: "z-image/turbo", prompt: "海边日落", imageUrl: local } };
        const config = stubConfig(stub.baseUrl);
        const result = await runRunningHubJob(job, { progress: (value, max, node) => progress.push(node), patch: (patch) => patches.push(patch) }, config);

        assert.equal(result.outputs.length, 1);
        assert.equal(result.outputs[0].type, "image");
        assert.equal(result.outputs[0].url, "/api/artifacts/rh-job-e2e/out.png");
        assert.equal(readFileSync(join(tmp, "artifacts", "rh-job-e2e", "out.png")).length, PNG.length);
        assert.deepEqual(progress, ["已提交", "排队中", "生成中", "已完成"]);
        assert.deepEqual(patches, [{ promptId: "3001" }]);

        const submit = stub.requests.find((item) => item.url === "/z-image/turbo");
        assert.deepEqual(JSON.parse(submit.body.toString()), { prompt: "海边日落", imageUrl: `${stub.baseUrl}/uploaded/ref.png` });
        assert.equal(stub.requests.filter((item) => item.url === "/media/upload/binary").length, 1);
    } finally {
        await stub.close();
    }
});

test("ctx.signal 中断时调用 cancel 并抛已取消", async () => {
    const controller = new AbortController();
    const stub = await startStub((req, res, request) => {
        if (request.url === "/z-image/turbo") return sendJson(res, 200, { taskId: "4001" });
        if (request.url === "/query") {
            controller.abort();
            return sendJson(res, 200, { taskId: "4001", status: "RUNNING", errorCode: "", errorMessage: "" });
        }
        if (request.url === "/task/cancel") return sendJson(res, 200, { code: 0, msg: "success", data: null });
        sendJson(res, 404, {});
    });
    try {
        await assert.rejects(
            () => runRunningHubJob({ id: "rh-job-cancel", params: { endpoint: "z-image/turbo", prompt: "x" } }, { signal: controller.signal, progress: () => {} }, stubConfig(stub.baseUrl)),
            /已取消/,
        );
        assert.equal(stub.requests.filter((item) => item.url === "/task/cancel").length, 1);
    } finally {
        await stub.close();
    }
});

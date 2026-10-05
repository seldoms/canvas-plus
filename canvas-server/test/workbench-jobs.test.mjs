import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createImageEnqueue, filterJobs, parseSize, MAX_ENQUEUE_COUNT } from "../src/workbench-jobs.js";

/**
 * workbench-jobs 单元测试：入队建 job、参数校验、编译降级、/api/jobs 过滤。
 * 全程用假队列 / 假 runJob / 假 llmCall 隔离 ComfyUI 与 DeepSeek，不产生任何网络请求。
 */

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));

/** 假队列：只记录 enqueue 的 spec/runner，返回一个 queued job（形状与 jobs.js 一致）。 */
function fakeQueue() {
    const enqueued = [];
    return {
        enqueued,
        enqueue(spec, runner) {
            const job = { ...spec, status: "queued", progress: { value: 0, max: 0 }, outputs: [] };
            enqueued.push({ spec, runner, job });
            return job;
        },
    };
}

const runJob = async () => ({ outputs: [] });
/** 假 llmCall：直接回英文改写稿（模拟 DeepSeek 成功）。 */
const fakeLlm = (text) => async () => text;

test("enqueue：count 拆成 N 个 kind=image 任务，复用同一队列与执行体", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob, llmCall: fakeLlm("A cinematic photo of a cat.") });
    const result = await enqueue.enqueue({ template: "img_qwen21_t2i", prompt: "一只猫", count: 3 });

    assert.equal(result.jobs.length, 3);
    assert.equal(queue.enqueued.length, 3);
    assert.ok(result.jobs.every((job) => job.status === "queued" && job.template === "img_qwen21_t2i"));
    assert.ok(result.jobs.every((job) => job.id.startsWith("image-")), "工作台 job id 不得以 run- 开头（否则会被任务页归到流水线组）");

    for (const entry of queue.enqueued) {
        assert.equal(entry.runner, runJob, "必须复用同一执行体（comfy 提交链路）");
        assert.equal(entry.spec.kind, "image");
        assert.equal(entry.spec.backend, "local");
        assert.equal(entry.spec.params.BATCH, 1);
        assert.ok(entry.spec.params.PROMPT.includes("A cinematic photo of a cat."), "PROMPT 应是后端编译结果");
        assert.equal(entry.spec.meta.source, "workbench");
        assert.match(entry.spec.params.OUTPUT_PREFIX, /^canvas\/image-/);
    }
    // 每个 job 的 OUTPUT_PREFIX 必须互不相同，避免同名产物在 ComfyUI 输出目录互相覆盖。
    const prefixes = new Set(queue.enqueued.map((entry) => entry.spec.params.OUTPUT_PREFIX));
    assert.equal(prefixes.size, 3);
});

test("enqueue：count 缺省为 1，超上限被夹到 MAX_ENQUEUE_COUNT", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob });
    assert.equal((await enqueue.enqueue({ template: "img_zimage_artistic", prompt: "x" })).jobs.length, 1);
    assert.equal((await enqueue.enqueue({ template: "img_zimage_artistic", prompt: "x", count: 999 })).jobs.length, MAX_ENQUEUE_COUNT);
});

test("enqueue：参考图按模板声明槽位注入（edit 模板 INPUT_IMAGE + REF_IMAGE_1）", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob });
    await enqueue.enqueue({
        template: "img_qwen21_edit",
        prompt: "换成红色外套",
        references: [{ url: "comfy:base.png" }, { url: "comfy:ref.png" }],
    });
    const params = queue.enqueued[0].spec.params;
    assert.equal(params.INPUT_IMAGE, "comfy:base.png");
    assert.equal(params.REF_IMAGE_1, "comfy:ref.png");
});

test("enqueue：size 解析为宽高；解析不出时回落 config 默认尺寸（保证 WIDTH/HEIGHT 齐全）", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir, pipeline: { imageWidth: 768, imageHeight: 1344 } }, jobs: queue, runJob });
    await enqueue.enqueue({ template: "img_zimage_artistic", prompt: "x", size: "1024x768" });
    assert.equal(queue.enqueued[0].spec.params.WIDTH, 1024);
    assert.equal(queue.enqueued[0].spec.params.HEIGHT, 768);
    await enqueue.enqueue({ template: "img_zimage_artistic", prompt: "x", size: "auto" });
    assert.equal(queue.enqueued[1].spec.params.WIDTH, 768, "size=auto 必须回落 config 默认宽");
    assert.equal(queue.enqueued[1].spec.params.HEIGHT, 1344, "size=auto 必须回落 config 默认高");
    assert.equal(parseSize("auto"), null);
    assert.equal(parseSize("3:4"), null);
});

test("参数校验：缺 template / 缺 prompt / 模板不存在 / 需要底图却无参考图", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob, registry: { canRun: () => ({ ok: true }) } });
    await assert.rejects(enqueue.enqueue({ prompt: "x" }), (e) => e.status === 400 && /缺少 template/.test(e.message));
    await assert.rejects(enqueue.enqueue({ template: "img_zimage_artistic" }), (e) => e.status === 400 && /缺少 prompt/.test(e.message));
    await assert.rejects(enqueue.enqueue({ template: "no_such_template", prompt: "x" }), (e) => e.status === 400 && /模板不存在/.test(e.message));
    await assert.rejects(enqueue.enqueue({ template: "img_qwen21_edit", prompt: "x" }), (e) => e.status === 400 && /INPUT_IMAGE/.test(e.message));
    assert.equal(queue.enqueued.length, 0, "校验失败不得产生任何 job");
});

test("参数校验：注册表 canRun 拒绝时给出可读原因且不入队", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob, registry: { canRun: () => ({ ok: false, reason: "设备不可用" }) } });
    await assert.rejects(enqueue.enqueue({ template: "img_zimage_artistic", prompt: "x" }), (e) => e.status === 400 && /设备不可用/.test(e.message));
    assert.equal(queue.enqueued.length, 0);
});

test("编译降级：llmCall 抛错 → 结构照旧产出 + 记 warning，不阻塞入队", async () => {
    const queue = fakeQueue();
    const failing = async () => {
        throw Object.assign(new Error("LLM 不可用"), { code: "llm_unavailable" });
    };
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob, llmCall: failing });
    const result = await enqueue.enqueue({ template: "img_qwen21_t2i", prompt: "一只猫" });

    assert.equal(result.jobs.length, 1, "编译失败仍必须完成入队");
    const { params, meta } = queue.enqueued[0].spec;
    assert.equal(typeof params.PROMPT, "string");
    assert.ok(params.PROMPT.trim().length > 0);
    assert.ok(!params.PROMPT.includes("[untranslated"), "排查标记不得进入实际 PROMPT");
    assert.ok(meta.promptWarning, "降级必须留下可读 warning");
});

test("编译降级：无 llmCall（离线）同样产出结构稿并记 warning", async () => {
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob });
    await enqueue.enqueue({ template: "img_qwen21_t2i", prompt: "一只猫" });
    const { params, meta } = queue.enqueued[0].spec;
    assert.ok(params.PROMPT.trim().length > 0);
    assert.ok(!params.PROMPT.includes("[untranslated"));
    assert.ok(meta.promptWarning);
});

test("filterJobs：kind / 逗号分隔 status / limit / since；空查询原样返回（向前兼容）", () => {
    const list = [
        { id: "a", kind: "image", status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:05.000Z" },
        { id: "b", kind: "image", status: "done", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:06.000Z" },
        { id: "c", kind: "video", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:07.000Z" },
    ];
    assert.deepEqual(filterJobs(list, {}).map((job) => job.id), ["a", "b", "c"], "无参数必须原样返回");
    assert.deepEqual(filterJobs(list, { kind: "image" }).map((job) => job.id), ["a", "b"]);
    assert.deepEqual(filterJobs(list, { status: "queued,running" }).map((job) => job.id), ["a", "c"]);
    assert.deepEqual(filterJobs(list, { kind: "image", status: "done" }).map((job) => job.id), ["b"]);
    assert.deepEqual(filterJobs(list, { limit: "2" }).map((job) => job.id), ["a", "b"]);
    assert.deepEqual(filterJobs(list, { since: "2026-01-01T00:00:06.000Z" }).map((job) => job.id), ["b", "c"]);
});

test("enqueue：模型值带「渠道id::模型名」前缀时自动剥成裸模板名（前端旧缓存兜底）", async () => {
    // 现场事故：前端把配置里的 "9S0-XCW7tZ7dqP90WxcxZ::img_qwen21_t2i" 原样当 template 发来
    // → 后端按 workflows/<template>.json 找不到 → 报「模板不存在」，整条提交链路不可用。
    const queue = fakeQueue();
    const enqueue = createImageEnqueue({ config: { workflowsDir }, jobs: queue, runJob, llmCall: fakeLlm("A cinematic photo of a cat.") });
    const result = await enqueue.enqueue({ template: "9S0-XCW7tZ7dqP90WxcxZ::img_qwen21_t2i", prompt: "一只猫", count: 1 });

    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].template, "img_qwen21_t2i");
    assert.equal(queue.enqueued[0].spec.template, "img_qwen21_t2i");
});

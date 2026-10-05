import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGenerationIntent, submitGenerationIntent } from "../src/generation-intent.js";
import { createJobQueue } from "../src/jobs.js";

/**
 * M1 统一生成提交链单元测试：
 *   · createGenerationIntent 契约校验（缺 kind/template → 400 CONTRACT_INVALID）；
 *   · submitGenerationIntent 四步：项目上下文校验 / canRun 能力解析 / 编译（已编译跳过、降级有 warning）/ 归属 meta；
 *   · jobs 幂等键：同 key 重放返回原 Job（含终态、含「重启后」用重开 queue 模拟），队列计数不变、不重复执行。
 * 全程临时目录 + 假 runner，不触碰网络与 GPU。
 */

function tempDir(t) {
    const dir = mkdtempSync(join(tmpdir(), "canvas-intent-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const idleRunner = async () => ({ outputs: [] });

function makeQueue(t) {
    return createJobQueue({ dataDir: join(tempDir(t), "data"), label: "intent-test" });
}

// ——— createGenerationIntent 契约校验 ———

test("createGenerationIntent：缺 kind / 非法 kind / 缺 template → 400 CONTRACT_INVALID", () => {
    assert.throws(() => createGenerationIntent({ template: "img_x" }), (e) => e.status === 400 && e.code === "CONTRACT_INVALID" && e.field === "kind");
    assert.throws(() => createGenerationIntent({ kind: "text", template: "img_x" }), (e) => e.status === 400 && e.code === "CONTRACT_INVALID" && e.field === "kind");
    assert.throws(() => createGenerationIntent({ kind: "image" }), (e) => e.status === 400 && e.code === "CONTRACT_INVALID" && e.field === "template");
});

test("createGenerationIntent：规整 source/context/params；source 缺省 api；归属字段缺省为 null", () => {
    const intent = createGenerationIntent({ kind: "image", template: " img_x ", context: { projectId: "prj_1" }, params: { WIDTH: 768 } });
    assert.equal(intent.source, "api");
    assert.equal(intent.template, "img_x");
    assert.equal(intent.context.projectId, "prj_1");
    assert.equal(intent.context.shotId, null);
    assert.deepEqual(intent.params, { WIDTH: 768 });
    assert.throws(() => createGenerationIntent({ kind: "image", template: "img_x", source: "nowhere" }), (e) => e.status === 400 && e.field === "source");
});

// ——— submitGenerationIntent：上下文校验 / 能力解析 / 编译 / 归属 ———

test("submit：context.projectId 指向不存在的项目 → 409 PROJECT_NOT_FOUND，不入队", async (t) => {
    const jobs = makeQueue(t);
    const intent = createGenerationIntent({ kind: "image", template: "img_x", context: { projectId: "prj_nope" } });
    await assert.rejects(
        submitGenerationIntent(intent, { jobs, runner: idleRunner, getProject: () => null }),
        (e) => e.status === 409 && e.code === "PROJECT_NOT_FOUND",
    );
    assert.equal(jobs.list().length, 0);
});

test("submit：canRun 拒绝 → 400 且可读原因，不入队", async (t) => {
    const jobs = makeQueue(t);
    const intent = createGenerationIntent({ kind: "image", template: "img_x" });
    await assert.rejects(
        submitGenerationIntent(intent, { jobs, runner: idleRunner, registry: { canRun: () => ({ ok: false, code: "DEVICE_UNAVAILABLE", reason: "设备不可用" }) } }),
        (e) => e.status === 400 && /设备不可用/.test(e.message),
    );
    assert.equal(jobs.list().length, 0);
});

test("submit：归属字段全量写入 meta（有值才写），调用方 meta 留痕原样保留", async (t) => {
    const jobs = makeQueue(t);
    const intent = createGenerationIntent({
        source: "project",
        kind: "image",
        template: "img_x",
        context: { projectId: "prj_1", episodeId: "ep_1", sceneId: "sc_1", shotId: "sh_1", slotId: "slot_sh_1_start", runId: "run_1", stageId: "keyframe" },
        toolId: "image.qwen21.edit",
        params: { PROMPT: "compiled prompt" },
        options: { idempotencyKey: "attr-key-1", meta: { sizeAdjust: { basis: "requested" } } },
    });
    const job = await submitGenerationIntent(intent, { jobs, runner: idleRunner, getProject: () => ({ id: "prj_1" }) });
    assert.equal(job.meta.source, "project");
    for (const field of ["projectId", "episodeId", "sceneId", "shotId", "slotId", "runId", "stageId"]) assert.ok(job.meta[field], `meta.${field} 应写入`);
    assert.equal(job.meta.toolId, "image.qwen21.edit");
    assert.equal(job.meta.idempotencyKey, "attr-key-1");
    assert.deepEqual(job.meta.sizeAdjust, { basis: "requested" }, "调用方留痕字段不得丢");

    // 无归属的独立试验：meta 只有 source，不凭空写字段。
    const bare = await submitGenerationIntent(createGenerationIntent({ kind: "image", template: "img_x", params: { PROMPT: "p" } }), { jobs, runner: idleRunner });
    assert.equal(bare.meta.source, "api");
    for (const field of ["projectId", "episodeId", "sceneId", "shotId", "slotId", "runId", "stageId", "toolId", "idempotencyKey"]) {
        assert.ok(!(field in bare.meta), `独立试验不得凭空写 ${field}`);
    }
});

test("submit：params.PROMPT 已存在（调用方已编译）→ 跳过 promptCompiler", async (t) => {
    const jobs = makeQueue(t);
    const intent = createGenerationIntent({ kind: "image", template: "img_x", params: { PROMPT: "已编译" } });
    const job = await submitGenerationIntent(intent, {
        jobs,
        runner: idleRunner,
        promptCompiler: async () => {
            throw new Error("不应被调用");
        },
    });
    assert.equal(job.params.PROMPT, "已编译");
});

test("submit：PROMPT 缺失走 promptCompiler；编译降级产 warning、PROMPT 非空；空结果不写回", async (t) => {
    const jobs = makeQueue(t);
    const intent = createGenerationIntent({ kind: "image", template: "img_x", facts: { prompt: "一只猫" } });
    const job = await submitGenerationIntent(intent, {
        jobs,
        runner: idleRunner,
        // 模拟「LLM 改写失败 → 回落同步结构稿 + warning」的既有降级语义。
        promptCompiler: async () => ({ prompt: "cat, cinematic", warnings: ["提示词未英文化：已按同步结构产出"] }),
    });
    assert.equal(job.params.PROMPT, "cat, cinematic");
    assert.ok(job.params.PROMPT.trim().length > 0, "绝不产生空 prompt");
    assert.match(job.meta.promptWarning, /同步结构/, "降级必须留 warning");

    // 编译器给出空结果 → 不写回空 PROMPT（留给执行体按模板校验报缺参，而不是静默发空串）。
    const empty = await submitGenerationIntent(createGenerationIntent({ kind: "image", template: "img_x" }), {
        jobs,
        runner: idleRunner,
        promptCompiler: async () => ({ prompt: "", warnings: [] }),
    });
    assert.equal(empty.params.PROMPT, undefined);
});

// ——— jobs.js 幂等键（决策 B：同 key 重放一律返回原 Job，含终态）———

test("幂等键：同 key 重放返回原 Job，队列计数不变、runner 不重复执行", async (t) => {
    let runnerCalls = 0;
    const runner = async () => {
        runnerCalls += 1;
        return { outputs: [] };
    };
    const jobs = makeQueue(t);
    const first = jobs.enqueue({ id: "job-a", kind: "image", template: "img_x", meta: { idempotencyKey: "key-1" } }, runner);
    assert.equal(runnerCalls, 1);
    const replay = jobs.enqueue({ id: "job-b", kind: "image", template: "img_x", meta: { idempotencyKey: "key-1" } }, runner);
    assert.equal(replay.id, first.id, "同 key 必须返回原 Job");
    assert.equal(jobs.list().length, 1, "重放不得新增 Job");
    assert.equal(runnerCalls, 1, "重放不得重复执行");
});

test("幂等键：「重启」（重开 queue 读同一 jobs.json）后同 key 重放仍命中原终态 Job", async (t) => {
    const dataDir = join(tempDir(t), "data");
    const queue1 = createJobQueue({ dataDir, label: "before-restart" });
    const first = queue1.enqueue({ id: "job-a", kind: "image", template: "img_x", meta: { idempotencyKey: "key-1" } }, idleRunner);
    // 等 runner 落终态 + persist 去抖（250ms）写盘完成。
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(queue1.get(first.id).status, "done");

    let runner2Calls = 0;
    const queue2 = createJobQueue({ dataDir, label: "after-restart" });
    const replay = queue2.enqueue({ id: "job-b", kind: "image", template: "img_x", meta: { idempotencyKey: "key-1" } }, async () => {
        runner2Calls += 1;
        return { outputs: [] };
    });
    assert.equal(replay.id, "job-a", "重启后同 key 仍返回原 Job");
    assert.equal(replay.status, "done", "终态原样返回，不重新执行");
    assert.equal(queue2.list().length, 1);
    assert.equal(runner2Calls, 0);
});

test("幂等键：不同 key 各自入队；无 key 行为与旧版一致", async (t) => {
    const jobs = makeQueue(t);
    jobs.enqueue({ id: "job-1", kind: "image", template: "img_x", meta: { idempotencyKey: "k1" } }, idleRunner);
    jobs.enqueue({ id: "job-2", kind: "image", template: "img_x", meta: { idempotencyKey: "k2" } }, idleRunner);
    jobs.enqueue({ id: "job-3", kind: "image", template: "img_x" }, idleRunner);
    jobs.enqueue({ id: "job-4", kind: "image", template: "img_x" }, idleRunner);
    assert.equal(jobs.list().length, 4);
});

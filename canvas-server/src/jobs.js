import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { artifactUrl, ensureDir, sanitizeName, saveBuffer } from "./files.js";

const TERMINAL = new Set(["done", "error", "canceled"]);

/**
 * 资源类别 → 队列分组键（D6 按资源调度）。
 * 关键约束：GPU_IMAGE / GPU_VIDEO 共用同一条本地队列 —— 147 只有一张 16GB 卡，
 * 生图与生视频必须串行，不能因为分了两类就放开并发。
 */
const QUEUE_OF_CLASS = { GPU_IMAGE: "gpu", GPU_VIDEO: "gpu", CPU: "cpu", API: "api", LLM: "llm" };

/** GPU 以外（CPU 后期 / 外部 API / LLM）各自独立队列，默认并发 1，可用 classConcurrency 覆盖。 */
const DEFAULT_CLASS_CONCURRENCY = 1;

function nowIso() {
    return new Date().toISOString();
}

/**
 * 未显式声明 resourceClass 时按现有 kind/backend 约定推断，
 * 保证 generate.js 等既有调用方行为不变：本地生图/生视频 → 同一条 GPU 队列。
 */
function inferResourceClass({ kind, backend }) {
    if (backend === "runninghub") return "API";
    if (kind === "image") return "GPU_IMAGE";
    if (kind === "video") return "GPU_VIDEO";
    return null;
}

/** 未识别/未声明的类别一律并入本地 GPU 队列，避免绕过单卡并发保护。 */
function queueKeyOf(resourceClass) {
    return QUEUE_OF_CLASS[resourceClass] || "gpu";
}

/**
 * 按资源类别分队列的任务队列（D6，P0-d 第一步）。
 *
 * 默认行为与旧版单 worker 队列一致：只有一个 `concurrency`（现指本地 GPU 队列，默认 1），
 * 未声明类别的任务全部走该队列。新增能力是 CPU / API / LLM 各自独立的队列，
 * 不再被 GPU 队列堵住。
 */
export function createJobQueue({ dataDir, concurrency = 1, label = "job", classConcurrency = {}, resolveDevice } = {}) {
    const storePath = join(ensureDir(dataDir), "jobs.json");
    const jobs = new Map();
    // 幂等键派生索引（决策 B）：meta.idempotencyKey → jobId。内存派生、随 jobs.json 持久化重建，
    // 不单独落盘 —— 权威仍是每个 job 自己的 meta。
    const idempotencyIndex = new Map();
    const controllers = new Map();
    const queues = new Map();
    const events = new EventEmitter();
    let persistTimer = null;

    /** 取（或惰性创建）一条队列。GPU 队列并发用 concurrency，其余类别默认 1。 */
    function queueOf(key) {
        let queue = queues.get(key);
        if (!queue) {
            const limit =
                key === "gpu"
                    ? Number.isInteger(concurrency) && concurrency > 0
                        ? concurrency
                        : 1
                    : Number.isInteger(classConcurrency[key]) && classConcurrency[key] > 0
                      ? classConcurrency[key]
                      : DEFAULT_CLASS_CONCURRENCY;
            queue = { key, pending: [], running: 0, concurrency: limit };
            queues.set(key, queue);
        }
        return queue;
    }

    if (existsSync(storePath)) {
        try {
            const saved = JSON.parse(readFileSync(storePath, "utf8"));
            for (const job of saved.jobs || []) {
                // 进程重启后不可能还在跑：把悬挂的中间态收敛成明确失败，避免前端永远轮询。
                if (!TERMINAL.has(job.status)) {
                    job.status = "error";
                    job.error = "服务重启，任务中断";
                    job.finishedAt = job.finishedAt || nowIso();
                }
                jobs.set(job.id, job);
                // 启动回填幂等索引：重启后同 key 重放仍命中原 Job（含已被收敛成 error 的中断任务）。
                const savedKey = typeof job?.meta?.idempotencyKey === "string" ? job.meta.idempotencyKey : "";
                if (savedKey) idempotencyIndex.set(savedKey, job.id);
            }
        } catch (error) {
            console.error(`[${label}] 读取历史任务失败：${error.message}`);
        }
    }

    function persist() {
        if (persistTimer) return;
        persistTimer = setTimeout(async () => {
            persistTimer = null;
            try {
                await saveBuffer(storePath, Buffer.from(JSON.stringify({ jobs: list() }, null, 2)));
            } catch (error) {
                console.error(`[${label}] 持久化失败：${error.message}`);
            }
        }, 250);
        persistTimer.unref?.();
    }

    function list(filter = {}) {
        let result = [...jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        if (filter.status) result = result.filter((job) => job.status === filter.status);
        if (filter.kind) result = result.filter((job) => job.kind === filter.kind);
        if (filter.limit) result = result.slice(0, Number(filter.limit));
        return result;
    }

    function get(id) {
        return jobs.get(id) || null;
    }

    function update(id, patch) {
        const job = jobs.get(id);
        if (!job) return null;
        Object.assign(job, patch, { updatedAt: nowIso() });
        persist();
        events.emit("change", job);
        return job;
    }

    /** 保持既有形状 { running, pending }：/api/health 与前端依赖它，绝不改坏。 */
    function counts() {
        let pending = 0;
        for (const queue of queues.values()) pending += queue.pending.length;
        return {
            running: [...jobs.values()].filter((job) => job.status === "running").length,
            pending,
        };
    }

    function enqueue({ id, kind, backend, template, name, params, meta, resourceClass, deviceId }, runner) {
        // 幂等重放（决策 B）：同 meta.idempotencyKey 一律返回原 Job（含终态），
        // 不改状态、不重复入队、不重复执行。key 由调用方按「一次业务意图一个 key」生成。
        const idempotencyKey = typeof meta?.idempotencyKey === "string" ? meta.idempotencyKey.trim() : "";
        if (idempotencyKey) {
            const existingId = idempotencyIndex.get(idempotencyKey);
            if (existingId && jobs.has(existingId)) return jobs.get(existingId);
        }
        const resolvedClass = resourceClass || inferResourceClass({ kind, backend });
        const key = queueKeyOf(resolvedClass);
        // deviceId 优先用调用方显式传入；否则由接线方（注册表）按资源类别解析出「该在哪台设备排队」。
        const resolvedDevice = deviceId || (resolvedClass && typeof resolveDevice === "function" ? resolveDevice(resolvedClass) : null);
        const stamp = nowIso();
        const job = {
            id,
            kind,
            backend: backend || "local",
            template,
            name: name || id,
            params: params || {},
            meta: meta || {},
            resourceClass: resolvedClass || null,
            queue: key,
            deviceId: resolvedDevice || null,
            status: "queued",
            outputs: [],
            progress: { value: 0, max: 0 },
            queuedAt: stamp,
            createdAt: stamp,
            updatedAt: stamp,
        };
        jobs.set(id, job);
        if (idempotencyKey) idempotencyIndex.set(idempotencyKey, id);
        queueOf(key).pending.push({ job, runner });
        persist();
        events.emit("change", job);
        drain();
        return job;
    }

    /**
     * 登记一份外部字节为已完成 Job（kind="import"，M2 画布存量图片入事实链）：
     * 字节落 data/artifacts/<jobId>/<filename>，outputs 形状与真实生成 Job 一致，
     * 产物由 artifacts.js 懒索引拾取（不另开索引来源）。幂等键语义与 enqueue 一致：
     * 同 meta.idempotencyKey 重放返回原 Job，不重写字节、不新增记录。
     */
    async function recordImport({ id, filename, buffer, type, meta, name } = {}) {
        const idempotencyKey = typeof meta?.idempotencyKey === "string" ? meta.idempotencyKey.trim() : "";
        if (idempotencyKey) {
            const existingId = idempotencyIndex.get(idempotencyKey);
            if (existingId && jobs.has(existingId)) return jobs.get(existingId);
        }
        const jobId = id || `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const safeName = sanitizeName(filename || "import");
        const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
        await saveBuffer(join(ensureDir(join(dataDir, "artifacts", jobId)), safeName), bytes);
        const stamp = nowIso();
        const job = {
            id: jobId,
            kind: "import",
            backend: "local",
            template: "import",
            name: name || safeName,
            params: {},
            meta: meta || {},
            resourceClass: null,
            queue: null,
            deviceId: null,
            status: "done",
            outputs: [{ url: artifactUrl(null, jobId, safeName), type: type || "file", filename: safeName, bytes: bytes.length }],
            progress: { value: 1, max: 1 },
            queuedAt: stamp,
            startedAt: stamp,
            finishedAt: stamp,
            createdAt: stamp,
            updatedAt: stamp,
        };
        jobs.set(jobId, job);
        if (idempotencyKey) idempotencyIndex.set(idempotencyKey, jobId);
        persist();
        events.emit("change", job);
        return job;
    }

    function cancel(id) {        const job = jobs.get(id);
        if (!job) return null;
        if (TERMINAL.has(job.status)) return job;
        const queue = queues.get(job.queue) || queues.get(queueKeyOf(job.resourceClass));
        if (queue) {
            const index = queue.pending.findIndex((item) => item.job.id === id);
            if (index >= 0) queue.pending.splice(index, 1);
        }
        controllers.get(id)?.abort();
        controllers.delete(id);
        return update(id, { status: "canceled", finishedAt: nowIso(), error: job.error });
    }

    function drain() {
        for (const queue of queues.values()) drainQueue(queue);
    }

    function drainQueue(queue) {
        while (queue.running < queue.concurrency && queue.pending.length) {
            const { job, runner } = queue.pending.shift();
            if (TERMINAL.has(job.status)) continue;
            queue.running += 1;
            const controller = new AbortController();
            controllers.set(job.id, controller);
            const startedAt = nowIso();
            const queued = Date.parse(job.queuedAt || job.createdAt || startedAt);
            update(job.id, { status: "running", startedAt, waitMs: Number.isFinite(queued) ? Date.now() - queued : undefined });
            const ctx = {
                signal: controller.signal,
                // percent 随progress 一起落库：后端算出的单调百分比是唯一可信口径。
                // 前端自己用 value/max 算会踩「分母随新节点加入而变大」的坑 —— 实测 92% 回落到 61%。
                // 不传时为 undefined，旧调用点与既有测试不受影响。
                progress: (value, max, node, percent) => update(job.id, { progress: { value, max, node, percent } }),
                patch: (patch) => update(job.id, patch),
            };
            void (async () => {
                try {
                    const result = await runner(job, ctx);
                    if (controller.signal.aborted) {
                        update(job.id, { status: "canceled", finishedAt: nowIso(), runMs: Date.now() - Date.parse(startedAt) });
                    } else {
                        update(job.id, {
                            status: "done",
                            outputs: result?.outputs || [],
                            finishedAt: nowIso(),
                            runMs: Date.now() - Date.parse(startedAt),
                            error: undefined,
                        });
                    }
                } catch (error) {
                    const aborted = controller.signal.aborted;
                    update(job.id, {
                        status: aborted ? "canceled" : "error",
                        error: aborted ? undefined : error?.message || String(error),
                        finishedAt: nowIso(),
                        runMs: Date.now() - Date.parse(startedAt),
                    });
                } finally {
                    controllers.delete(job.id);
                    queue.running -= 1;
                    drainQueue(queue);
                }
            })();
        }
    }

    function on(event, handler) {
        events.on(event, handler);
        return () => events.off(event, handler);
    }

    /** 等待队列跑空，给流水线编排与部署自检用。 */
    function waitForIdle({ timeoutMs = 7200_000, intervalMs = 1000 } = {}) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                const snapshot = counts();
                if (!snapshot.running && !snapshot.pending) return resolve();
                if (Date.now() > deadline) return reject(new Error("等待任务队列空闲超时"));
                setTimeout(check, intervalMs);
            };
            check();
        });
    }

    return { enqueue, recordImport, get, list, update, cancel, counts, on, persist, storePath, waitForIdle };
}

/** 让调用方（流水线编排）能等待某个任务进入终态。 */
export function waitForJob(queue, id, { signal, timeoutMs = 7200_000, intervalMs = 1500 } = {}) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            if (signal?.aborted) {
                reject(new Error("已取消"));
                return;
            }
            const job = queue.get(id);
            if (!job) {
                reject(new Error(`任务不存在：${id}`));
                return;
            }
            if (TERMINAL.has(job.status)) {
                if (job.status === "done") resolve(job);
                else reject(new Error(job.error || `任务${job.status}`));
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error(`任务超时：${id}`));
                return;
            }
            setTimeout(check, intervalMs);
        };
        check();
    });
}

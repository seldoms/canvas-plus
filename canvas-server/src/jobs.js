import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { ensureDir, saveBuffer } from "./files.js";

const TERMINAL = new Set(["done", "error", "canceled"]);

function nowIso() {
    return new Date().toISOString();
}

/**
 * 单 worker 串行任务队列。
 * 16GB 显存一次只能跑一个 ComfyUI 任务，串行是硬约束而不是性能取舍。
 */
export function createJobQueue({ dataDir, concurrency = 1, label = "job" } = {}) {
    const storePath = join(ensureDir(dataDir), "jobs.json");
    const jobs = new Map();
    const controllers = new Map();
    const pending = [];
    const events = new EventEmitter();
    let running = 0;
    let persistTimer = null;

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

    function counts() {
        return {
            running: [...jobs.values()].filter((job) => job.status === "running").length,
            pending: pending.length,
        };
    }

    function enqueue({ id, kind, template, name, params, meta }, runner) {
        const job = {
            id,
            kind,
            template,
            name: name || id,
            params: params || {},
            meta: meta || {},
            status: "queued",
            outputs: [],
            progress: { value: 0, max: 0 },
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        jobs.set(id, job);
        pending.push({ job, runner });
        persist();
        events.emit("change", job);
        drain();
        return job;
    }

    function cancel(id) {
        const job = jobs.get(id);
        if (!job) return null;
        if (TERMINAL.has(job.status)) return job;
        const index = pending.findIndex((item) => item.job.id === id);
        if (index >= 0) pending.splice(index, 1);
        controllers.get(id)?.abort();
        controllers.delete(id);
        return update(id, { status: "canceled", finishedAt: nowIso(), error: job.error });
    }

    async function drain() {
        while (running < concurrency && pending.length) {
            const { job, runner } = pending.shift();
            if (TERMINAL.has(job.status)) continue;
            running += 1;
            const controller = new AbortController();
            controllers.set(job.id, controller);
            update(job.id, { status: "running", startedAt: nowIso() });
            const ctx = {
                signal: controller.signal,
                progress: (value, max, node) => update(job.id, { progress: { value, max, node } }),
                patch: (patch) => update(job.id, patch),
            };
            void (async () => {
                try {
                    const result = await runner(job, ctx);
                    if (controller.signal.aborted) {
                        update(job.id, { status: "canceled", finishedAt: nowIso() });
                    } else {
                        update(job.id, { status: "done", outputs: result?.outputs || [], finishedAt: nowIso(), error: undefined });
                    }
                } catch (error) {
                    const aborted = controller.signal.aborted;
                    update(job.id, {
                        status: aborted ? "canceled" : "error",
                        error: aborted ? undefined : error?.message || String(error),
                        finishedAt: nowIso(),
                    });
                } finally {
                    controllers.delete(job.id);
                    running -= 1;
                    drain();
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
                if (!running && !pending.length) return resolve();
                if (Date.now() > deadline) return reject(new Error("等待任务队列空闲超时"));
                setTimeout(check, intervalMs);
            };
            check();
        });
    }

    return { enqueue, get, list, update, cancel, counts, on, persist, storePath, waitForIdle };
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

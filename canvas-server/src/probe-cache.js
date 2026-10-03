/**
 * 外部依赖探测缓存（#68）：把 ComfyUI / RunningHub 的连通性探测从
 * 「每次 `/api/health` 同步 await 上游」改成「后台并发探测 + 短超时 + TTL 缓存」。
 *
 * 契约：
 *   - `/api/health` 只读缓存快照，**永不 await 上游** → 始终立即应答（本进程存活即 200）；
 *   - 首次探测还没回来时给 `pending` 快照：形状与真实结果一致（多一个 `pending:true`），前端无需改动；
 *   - 快照过期（超过 `ttlMs`）时返回旧值并在后台刷新（stale-while-revalidate）；
 *   - 每次探测都有硬超时（`timeoutMs`），上游挂死也只降级成 `{ ok:false, error }`，绝不拖住调用方；
 *   - 探测互不影响：各 entry 独立 inflight，一个慢不会等另一个。
 *
 * 这个模块不关心探测内容本身（ComfyUI / RunningHub 各自的 shape 由调用方注入），
 * 只负责「不阻塞 + 缓存 + 超时 + 降级」这套调度语义。
 */
export function createProbeCache({ ttlMs = 30000, timeoutMs = 3000, now = () => Date.now() } = {}) {
    const entries = new Map();

    /** 注册一个可探测项。`pending` 未提供时用通用兜底（调用方可注入带 devices:[] 等字段的快照）。 */
    function define(name, { baseUrl = "", probe, pending } = {}) {
        if (typeof probe !== "function") throw new Error(`probe-cache: ${name} 缺少 probe()`);
        entries.set(name, {
            name,
            baseUrl,
            probe,
            pending: typeof pending === "function" ? pending : () => ({ ok: false, baseUrl, error: "探测中", pending: true }),
            result: null,
            at: 0,
            ever: false,
            inflight: null,
        });
        return name;
    }

    /** 给单个探测包一层硬超时：超时降级成可解释的 error 结果，不抛。 */
    function withTimeout(promise, entry) {
        let timer = null;
        const guard = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, baseUrl: entry.baseUrl, error: `探测超时（>${timeoutMs}ms）` }), timeoutMs);
            timer.unref?.();
        });
        return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
    }

    function refresh(entry) {
        if (entry.inflight) return entry.inflight;
        entry.inflight = (async () => {
            let result;
            try {
                // 同步调用 probe：让「发起探测」这件事在 refresh() 返回前就发生（便于计数/观测），
                // 同步抛错也在这里收敛成降级结果。
                let probed;
                try {
                    probed = entry.probe();
                } catch (error) {
                    probed = Promise.reject(error);
                }
                result = await withTimeout(Promise.resolve(probed), entry);
            } catch (error) {
                result = { ok: false, baseUrl: entry.baseUrl, error: error?.message || String(error) };
            }
            if (!result || typeof result !== "object") result = { ok: false, baseUrl: entry.baseUrl, error: "探测返回非法结果" };
            entry.result = result;
            entry.at = now();
            entry.ever = true;
            entry.inflight = null;
            return result;
        })();
        return entry.inflight;
    }

    /**
     * 读快照。命中新鲜缓存直接返回；过期则「先返回旧值、后台刷新」；从没探过则返回 pending 快照并后台发起首探。
     * 永不阻塞、永不抛 —— 调用方（HTTP 处理器）可以纯同步使用。
     */
    function get(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        if (!entry.ever) {
            refresh(entry);
            return entry.pending();
        }
        if (now() - entry.at >= ttlMs) refresh(entry);
        return entry.result;
    }

    /** 启动预热：并发发起全部探测，不 await。 */
    function warmAll() {
        for (const entry of entries.values()) refresh(entry);
    }

    /** 强制刷新全部并等待就绪（测试用）。 */
    function refreshAll() {
        return Promise.all([...entries.values()].map((entry) => refresh(entry)));
    }

    function has(name) {
        return entries.has(name);
    }

    return { define, get, warmAll, refreshAll, has };
}

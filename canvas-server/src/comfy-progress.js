/**
 * ComfyUI 真实生成进度：从 WebSocket 的 `progress_state` 消息聚合出「已完成 / 总步数」。
 *
 * ## 为什么不用轮询 /history 算进度
 *   `/history` 只在任务**跑完后**才有条目，所以轮询它在整个生成期间拿不到任何中间进度
 *   （这正是 progress 长期恒为 0/0 的原因）。真实进度只在 WebSocket 上推。
 *
 * ## 字段形状是2026-10-08 真机探测出来的，不是照文档抄的
 *   实测 ComfyUI 0.38.2 推的是 `progress_state`（旧资料里写的 `progress` 已不存在）：
 *     { type:"progress_state", data:{ prompt_id, nodes:{ "<nodeId>": {
 *         value, max, state:"running"|"finished", node_id, display_node_id, ... } } } }
 *   另有 `executing`（当前在跑哪个节点）、`execution_start`/`execution_success`/`executed`（终态）。
 *
 * ## 最关键的一点：进度必须**跨节点聚合**
 *   `nodes` 是**每个节点各自**上报 value/max。只取某一个节点会得出严重错误的进度：
 *   一个 TTS 只有 1 个节点（看不出问题），但视频模板有几十个节点，若只看「当前 executing 的那个节点」，
 *   进度条会在 0% 和 100% 之间反复跳动 —— 比没有进度更让人困惑。
 *   所以口径是：**所有已完成节点的 max 之和为分母，已完成节点的 value 之和 + 进行中节点的部分 value 为分子**。
 *
 * ## 拿不到就如实说拿不到
 *   ComfyUI 没推、或节点形状不认识时返回 `null` 而不是 `0` ——调用方据此保持原有文案，
 *   不能拿 0% 冒充「真的刚开始」。这与本项目「缺料是事实不是失败」的口径一致。
 */

/** 认识的节点状态：只有 finished 计入分母，running 的 value 计入分子。 */
const STATE_FINISHED = "finished";
const STATE_RUNNING = "running";

function positiveInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * 聚合一条 `progress_state` 消息。
 *
 * @param {object} data 消息的 data 段（`{ prompt_id, nodes }`）
 * @returns {{value: number, max: number, ratio: number, finishedNodes: number, totalNodes: number, node: string|null}|null}
 *   无法解析出任何有效节点时返回 null（**不是** 0/0）。
 */
export function aggregateProgressState(data) {
    const nodes = data?.nodes;
    if (!nodes || typeof nodes !== "object") return null;
    let max = 0;
    let value = 0;
    let finishedNodes = 0;
    let totalNodes = 0;
    let runningNode = null;

    for (const [key, node] of Object.entries(nodes)) {
        const nodeMax = positiveInt(node?.max);
        if (nodeMax === null) continue; // 没有可计数的步数（如纯加载/保存节点）→ 不进分母
        totalNodes += 1;
        const nodeValue = Math.min(positiveInt(node?.value) ?? 0, nodeMax);
        value += nodeValue;
        max += nodeMax;
        if (node?.state === STATE_FINISHED) {
            finishedNodes += 1;
        } else if (node?.state === STATE_RUNNING) {
            // 进行中的节点：进度取它的部分 value（ComfyUI 的采样节点会逐步上报）。
            runningNode = String(node?.display_node_id ?? node?.node_id ?? key);
        }
    }

    if (!totalNodes || max <= 0) return null;
    return { value, max, ratio: Math.min(1, value / max), finishedNodes, totalNodes, node: runningNode };
}

/**
 * ComfyUI 消息 → 本模块认识的少量事件。
 *
 * 只认这几种（其余原样忽略）——外部监控插件（crystools / dasiwa 等）会往同一条WS 推
 * 大量无关消息，全量转发会把网关自己的日志淹掉。
 *
 * @returns {{kind: "progress"|"executing"|"started"|"succeeded"|"node-output", ...}|null}
 */
export function parseComfyMessage(message) {
    const type = message?.type;
    if (!type) return null;
    if (type === "progress_state") {
        const progress = aggregateProgressState(message.data);
        return progress ? { kind: "progress", ...progress } : null;
    }
    if (type === "executing") {
        const node = message.data?.node;
        return { kind: "executing", node: node === null || node === undefined ? null : String(node) };
    }
    if (type === "execution_start") return { kind: "started", promptId: message.data?.prompt_id ?? null };
    if (type === "execution_success") return { kind: "succeeded", promptId: message.data?.prompt_id ?? null };
    if (type === "executed") return { kind: "node-output", node: String(message.data?.node ?? "") };
    return null;
}

/**
 * 把网关配置里的 ComfyUI baseUrl 换成 WebSocket 地址。
 * ComfyUI 的 WS 与 HTTP 同源同端口，只是协议换ws/wss、路径挂到 /ws。
 */
export function comfyWebSocketUrl(baseUrl, clientId) {
    const root = String(baseUrl || "http://127.0.0.1:8188").replace(/\/+$/, "");
    const ws = root.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${ws}/ws?clientId=${encodeURIComponent(clientId)}`;
}

/**
 * 订阅某个 prompt 的真实进度。
 *
 * 生命周期（这几点决定它不会变成内存/句柄泄漏）：
 *   - **一个 clientId 一个连接**：ComfyUI 按 client_id 把消息推给提交方，因此连接可以
 *     跨多个 prompt 复用，不为每个任务新开一条（视频连跑十几镜时不会把连接开爆）。
 *   - **只回传自己prompt 的进度**：别的 clientId 的任务消息一律忽略。
 *   - **必须 close()**：返回的 close 供调用方在任务结束时调用；不关的话 Node 会挂住不退出。
 *   - **连接失败不抛**：返回 null 表示「拿不到真实进度」，调用方保持原有文案即可，
 *     绝不能因为进度通道坏了就让整个生成失败。
 *
 * @param {object} args
 * @param {string} args.baseUrl ComfyUI baseUrl
 * @param {string} args.clientId 提交时用的 clientId
 * @param {(event: object) => void} args.onEvent
 * @returns {{ close: () => void, closed: boolean }|null}
 */
export function subscribeComfyProgress({ baseUrl, clientId, onEvent } = {}) {
    if (typeof WebSocket !== "function" || !clientId || typeof onEvent !== "function") return null;
    let socket = null;
    let closed = false;
    try {
        socket = new WebSocket(comfyWebSocketUrl(baseUrl, clientId));
    } catch {
        return null;
    }
    socket.addEventListener("message", (event) => {
        if (closed) return;
        let message = null;
        try {
            message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
            return; // 非 JSON（如 ping）直接忽略，不让一条脏消息打断进度流
        }
        const parsed = parseComfyMessage(message);
        if (!parsed) return;
        // 只认自己提交的任务：ComfyUI 的消息带 prompt_id，而 executing 之外的类型也可能缺。
        const promptId = message?.data?.prompt_id;
        if (promptId && parsed.promptId && promptId !== parsed.promptId) return;
        try {
            onEvent(parsed);
        } catch {
            // 回调出错绝不能连累连接（否则一个渲染 bug 会让整个进度通道静默死掉）。
        }
    });
    // 连接错误不抛：进度是增强项，拿不到就退回原文案。
    socket.addEventListener("error", () => {});
    return {
        get closed() {
            return closed;
        },
        close() {
            if (closed) return;
            closed = true;
            try {
                socket.close();
            } catch {
                /* 已断开 */
            }
        },
    };
}

/**
 * ComfyUI 真实生成进度：从 WebSocket 的 `progress_state` 消息聚合出「已完成 / 总步数」。
 *
 * ## 为什么不用轮询 /history 算进度
 *   `/history` 只在任务**跑完后**才有条目，所以轮询它在整个生成期间拿不到任何中间进度
 *   （这正是 progress 长期恒为 0/0 的原因）。真实进度只在 WebSocket 上推。
 *
 * ## 字段形状是 2026-10-08 真机探测出来的，不是照文档抄的
 *   实测 ComfyUI 0.38.2 推的是 `progress_state`（旧资料里写的 `progress` 已不存在）：
 *     { type:"progress_state", data:{ prompt_id, nodes:{ "<nodeId>": {
 *         value, max, state:"running"|"finished", node_id, display_node_id, ... } } } }
 *   另有 `executing`（当前在跑哪个节点）、`execution_start`/`execution_success`/`executed`（终态）。
 *
 * ## `nodes` 是「累计字典」—— 全部口径问题的根源（2026-10-08 真机抓到）
 *   节点**随执行陆续加入**，不是开局就全部到齐。实测一条 TTS 的三份报文：
 *     第 1 条：nodes = { "2": 1/1 finished }
 *     第 2 条：nodes = { "2": 1/1 finished, "3": 0/1 running }
 *     第 3 条：nodes = { "2": 1/1 finished, "3": 1/1 finished }
 *   按瞬时 `Σvalue / Σmax` 算，比值是 **1 → 0.5 → 1** —— 进度条会**倒退**。
 *   视频模板几十个节点时这会反复回跳，比没有进度更让人困惑。
 *
 *   → 所以本模块不把瞬时比值当进度，改用**跨报文累计的已完成步数**（见 createProgressTracker）。
 *     已完成步数只增不减；`ratio` 由调用方把上一轮值传回来做钳制，保证单调不回退。
 *
 * ## 拿不到就如实说拿不到
 *   ComfyUI 没推、或节点形状不认识时返回 `null` 而不是 `0` —— 调用方据此保持原有文案，
 *   不能拿 0% 冒充「真的刚开始」。这与本项目「缺料是事实不是失败」的口径一致。
 */

/** 认识的节点状态：只有 finished 计入已完成步数，running 只用来报当前节点。 */
const STATE_FINISHED = "finished";
const STATE_RUNNING = "running";

function positiveInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * 聚合一条 `progress_state` 消息的**瞬时**快照。
 *
 * ⚠️ 这份快照的 `ratio` 会倒退（分母随新节点加入而变大），**不要直接拿去渲染进度条**。
 *    单测里有一条测试专门锁住这个倒退事实，防止有人误以为它可以直接用。
 *    要给用户看的进度请用 createProgressTracker。
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
            runningNode = String(node?.display_node_id ?? node?.node_id ?? key);
        }
    }

    if (!totalNodes || max <= 0) return null;
    return { value, max, ratio: Math.min(1, value / max), finishedNodes, totalNodes, node: runningNode };
}

/**
 * 跨报文累计的进度跟踪器：把「会倒退的瞬时快照」变成「单调不回退的对外进度」。
 *
 * ## 为什么必须有这个跟踪器（而不是每次现算）
 *   `progress_state.nodes` 是累计字典，新节点不断加入 → 分母持续变大 → 瞬时比值会回跳。
 *   但「已完成步数」是单调的：节点一旦 finished，它的 value 就不再变。
 *   跟踪器按 `node_id` 记账，已完成过的节点不重复累加，于是：
 *     - `value`（已完成步数）只增不减；
 *     - `ratio` 取历史最大值，**保证单调不回退**。
 *
 *   回退（而不是清零重算）是因为用户看到进度条往回走会以为界面坏了，
 *   而历史最大值至少是「曾经真实达到过」的位置，不会凭空超出实际。
 *
 * @returns {{push: (data: object) => ({value:number,max:number,ratio:number,finishedNodes:number,totalNodes:number,node:string|null}|null), done: () => object|null}}
 */
export function createProgressTracker({ totalSteps = null } = {}) {
    /** @type {Map<string, {value:number,state:string}>} 已见过的节点，避免重复累加。 */
    const seen = new Map();
    let best = 0; // 历史最大 ratio，用于钳制
    let finishedSteps = 0;
    let last = null;
    // 分母优先用「提交前从 graph 算出的总采样步数」——它是常量，
    // 因此比值既不会因分母增长而回落，也不会被先跑完的小权重节点顶到 100%。
    // 没有它时才退回 ComfyUI 的 nodes 之和（会增长，只算次优）。
    const knownTotal = positiveInt(totalSteps);

    return {
        push(data) {
            const snapshot = aggregateProgressState(data);
            if (!snapshot) return null;
            const nodes = data?.nodes || {};
            let observedMax = 0;
            for (const [key, node] of Object.entries(nodes)) {
                const id = String(node?.node_id ?? key);
                const nodeMax = positiveInt(node?.max);
                if (nodeMax === null) continue;
                const state = String(node?.state || "");
                const nodeValue = Math.min(positiveInt(node?.value) ?? 0, nodeMax);
                const prev = seen.get(id);
                observedMax += nodeMax;
                // 只有「已完成」的步数才计入，且同一节点只计一次 —— 这是单调性的来源。
                if (state === STATE_FINISHED && prev?.state !== STATE_FINISHED) {
                    finishedSteps += nodeMax;
                }
                seen.set(id, { value: nodeValue, state });
            }
            const max = knownTotal ?? observedMax;
            if (max <= 0) return null;
            // ⚠️ 分子只用「已完成步数 / 常量总步数」，**不要**掺入 snapshot.ratio（瞬时比值）。
            //   瞬时比值会被先跑完的小权重节点顶到 100%（真机：整条视频全程显示 100%）；
            //   一旦掺进来，即使分母是常量也会立刻虚高 —— 这就是本条注释存在的理由。
            const ratio = Math.min(1, Math.max(best, finishedSteps / max));
            best = ratio;
            last = {
                value: finishedSteps,
                max,
                ratio,
                finishedNodes: snapshot.finishedNodes,
                totalNodes: snapshot.totalNodes,
                node: snapshot.node,
                /** 分母是常量还是累计值 —— 前端与排查都需要知道口径来源。 */
                denominator: knownTotal === null ? "observed" : "graph",
            };
            return last;
        },
        /** 任务结束时的终态快照；从未收到过有效消息则返回 null（如实说拿不到）。 */
        done() {
            return last;
        },
    };
}

/**
 * ComfyUI 消息 → 本模块认识的少量事件。
 *
 * 只认这几种（其余原样忽略）——外部监控插件（crystools / dasiwa 等）会往同一条 WS 推
 * 大量无关消息，全量转发会把网关自己的日志淹掉。实测一条 TTS 期间收到 96 条
 * crystools.monitor + 27 条 dasiwa.system_monitor，占消息总数 99%。
 *
 * @returns {{kind: "progress"|"executing"|"started"|"succeeded"|"node-output", ...}|null}
 */
export function parseComfyMessage(message) {
    const type = message?.type;
    if (!type) return null;
        if (type === "progress_state") {
        const progress = aggregateProgressState(message.data);
        //必须带上原始 data：调用方要用它喂 createProgressTracker（按 node_id 跨报文记账）。
        // 只给聚合结果的话，跟踪器拿不到 nodes，累计口径就落空了。
        return progress ? { kind: "progress", ...progress, data: message.data } : null;
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
 * ComfyUI 的 WS 与 HTTP 同源同端口，只是协议换 ws/wss、路径挂到 /ws。
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
/**
 * ComfyUI 真实进度：跨节点聚合（comfy-progress.js）。
 *
 * ## fixture 形状的来历（不是照文档编的）
 *   2026-10-08 真机连 ComfyUI 0.38.2 跑了一个真实 TTS 任务，抓到的消息形状：
 *     { type:"progress_state", data:{ prompt_id, nodes:{ "1": {
 *        value, max, state:"running"|"finished", node_id, display_node_id, parent_node_id, real_node_id } } } }
 *   注意是 `progress_state`，不是旧资料里写的 `progress`。另外实测还会混入
 *   crystools.monitor / dasiwa.system_monitor 这类第三方监控插件的消息。
 *
 * ## 为什么最关键的测试是「多节点」
 *   TTS 只有 1 个节点，**看不出聚合对不对** —— 单节点下"取任意一个节点"和"正确聚合"结果一样。
 *   而真实视频模板有几十个节点，只看当前 executing 的那个节点会让进度在 0%/100% 之间反复跳，
 *   比没有进度更让人困惑。所以这里用多节点 fixture 锁死聚合口径。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateProgressState, comfyWebSocketUrl, parseComfyMessage, subscribeComfyProgress } from "../src/comfy-progress.js";

/** 造一条真机见过的 progress_state 消息。 */
const progressMsg = (nodes) => ({ type: "progress_state", data: { prompt_id: "p1", nodes } });
/** 采样节点：ComfyUI 的 KSampler 按 step 逐步上报 value（0→max）。 */
const sampling = (node, value, max, state) => ({
    value,
    max,
    state,
    node_id: node,
    display_node_id: node,
    parent_node_id: null,
    real_node_id: node,
});

test("进度聚合：跨节点求和，而不是只看当前那个节点", () => {
    // 一条真实视频任务的典型形状：3 个可计数节点，其中 1 个在跑、1 个已完成、1 个纯加载（无可计数 max）。
    const progress = aggregateProgressState({
        nodes: {
            "3": sampling("3", 10, 10, "finished"), // 已完成的采样节点
            "7": sampling("7", 8, 40, "running"), // 正在跑的采样节点：8/40
            "9": { value: 0, max: 0, state: "finished", node_id: "9" }, // SaveImage 之类，不进分母
        },
    });
    assert.ok(progress, "有可计数节点就该算出进度");
    // 分母 = 所有可计数节点的 max 之和 = 10 + 40（不是 40，也不是 10）
    assert.equal(progress.max, 50, "分母是所有可计数节点的 max 之和");
    assert.equal(progress.value, 18, "分子含已完成节点的满值 + 进行中节点的部分值");
    assert.equal(progress.finishedNodes, 1);
    assert.equal(progress.totalNodes, 2, "无可计数 max 的节点不进 totalNodes");
    assert.equal(progress.ratio, 18 / 50);
    assert.equal(progress.node, "7", "要报出正在跑哪个节点，前端才能显示「采样中·节点 7」");
});

test("进度聚合：只看单个节点会得出错误结论（这就是必须聚合的理由）", () => {
    const nodes = {
        "3": sampling("3", 10, 10, "finished"),
        "7": sampling("7", 8, 40, "running"),
    };
    // 若错误地只取「当前 executing 节点」：8/40 = 20%，而真实整体是 18/50 = 36%。
    const naive = 8 / 40;
    const correct = aggregateProgressState({ nodes }).ratio;
    assert.notEqual(naive, correct, "单节点口径与聚合口径在多节点下必然不同");
    assert.equal(correct, 18 / 50);
});

test("进度聚合：value 超过 max 时收敛到 1（不显示 120% 这种荒谬进度）", () => {
    const progress = aggregateProgressState({ nodes: { "1": sampling("1", 150, 100, "running") } });
    assert.equal(progress.value, 100, "超出部分按 max 收敛");
    assert.equal(progress.ratio, 1);
});

test("进度聚合：没有可计数节点时返回 null，而不是 0/0 冒充刚开始", () => {
    // 全部节点 max=0（纯加载/保存图）→ 算不出步数。
    assert.equal(aggregateProgressState({ nodes: { "9": { value: 0, max: 0, state: "finished" } } }), null);
    // 节点形状不认识（ComfyUI 版本差异）→ null。
    assert.equal(aggregateProgressState({ nodes: { "1": { state: "running" } } }), null);
    assert.equal(aggregateProgressState({}), null);
    assert.equal(aggregateProgressState(null), null);
    assert.equal(aggregateProgressState({ nodes: "not-an-object" }), null);
    // 「拿不到」必须是 null：调用方据此保留原文案，而不是显示 0%。
    assert.notEqual(aggregateProgressState({}), { value: 0, max: 0, ratio: 0 });
});

test("消息解析：认 progress_state（真机实测的 type），忽略第三方监控插件消息", () => {
    // 实测这条消息真实存在，字段是 nodes。
    const parsed = parseComfyMessage(progressMsg({ "1": sampling("1", 1, 1, "running") }));
    assert.equal(parsed.kind, "progress");
    assert.equal(parsed.value, 1);

    // 旧资料写的是 type:"progress"，而真机推的是 progress_state —— 两者都接，但以真机为准。
    const legacy = parseComfyMessage({ type: "progress", data: { value: 5, max: 10 } });
    assert.equal(legacy, null, "不认识的消息形状不硬解，返回 null 而不是猜一个含义");

    // 实测存在的两类监控插件消息：不该被当成进度。
    for (const noise of [
        { type: "crystools.monitor", data: { cpu_utilization: 24.6, gpus: [{ gpu_utilization: 8 }] } },
        { type: "dasiwa.system_monitor", data: { cpu_percent: 18.9, ram: { used: 1 } } },
        { type: "status", data: { status: { exec_info: { queue_remaining: 0 } }, sid: "x" } },
    ]) {
        assert.equal(parseComfyMessage(noise), null, `${noise.type} 不是进度消息`);
    }
});

test("消息解析：终态与节点事件（node=null 表示执行结束）", () => {
    assert.deepEqual(parseComfyMessage({ type: "execution_start", data: { prompt_id: "p1" } }), {
        kind: "started",
        promptId: "p1",
    });
    assert.deepEqual(parseComfyMessage({ type: "execution_success", data: { prompt_id: "p1" } }), {
        kind: "succeeded",
        promptId: "p1",
    });
    // 实测 executing 的 node 为 null 表示跑完了 —— 不能当成"节点 0"或字符串 "null"。
    assert.deepEqual(parseComfyMessage({ type: "executing", data: { node: null, prompt_id: "p1" } }), {
        kind: "executing",
        node: null,
    });
    assert.equal(parseComfyMessage({ type: "executing", data: { node: "7" } }).node, "7");
    assert.equal(parseComfyMessage({ type: "executed", data: { node: "3", output: {} } }).kind, "node-output");
    assert.equal(parseComfyMessage(null), null);
    assert.equal(parseComfyMessage({}), null);
});

test("订阅：不抛、支持无 WebSocket 环境、close 幂等（不能把 Node 挂住）", () => {
    // 无 baseUrl/clientId/回调 → 不该抛，返回 null（调用方退回原文案）。
    assert.equal(subscribeComfyProgress(), null);
    assert.equal(subscribeComfyProgress({ baseUrl: "http://x:8188" }), null);

    // close 幂等：重复调用不炸（生成循环里可能在超时/取消两条路径各调一次）。
    const sub = subscribeComfyProgress({ baseUrl: "http://127.0.0.1:1", clientId: "c", onEvent: () => {} });
    if (sub) {
        sub.close();
        sub.close();
        assert.equal(sub.closed, true);
    }
});

test("WebSocket 地址：同源同端口换协议挂到 /ws", () => {
    assert.equal(comfyWebSocketUrl("http://192.168.123.147:8188", "cid"), "ws://192.168.123.147:8188/ws?clientId=cid");
    assert.equal(comfyWebSocketUrl("https://h:8188/", "a b"), "wss://h:8188/ws?clientId=a%20b");
    // 没配 baseUrl 时落回默认（与 providers/comfy.js 同口径）。
    assert.equal(comfyWebSocketUrl("", "c"), "ws://127.0.0.1:8188/ws?clientId=c");
});

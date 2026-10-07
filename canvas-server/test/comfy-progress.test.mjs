/**
 * ComfyUI 真实进度：累计口径与单调性（comfy-progress.js）。
 *
 * ## fixture 形状的来历（不是照文档编的）
 *   2026-10-08 真机连 ComfyUI 0.38.2 跑了一个真实 TTS 任务，抓到的消息形状：
 *     { type:"progress_state", data:{ prompt_id, nodes:{ "<id>": {
 *        value, max, state:"running"|"finished", node_id, display_node_id,
 *        parent_node_id, real_node_id } } } }
 *   注意是 `progress_state`，不是旧资料里写的 `progress`。另外实测还会混入
 *   crystools.monitor / dasiwa.system_monitor 这类第三方监控插件的消息
 *   （一条 TTS 期间实测 96 + 27 条，占消息总数 99%）。
 *
 * ## 本文件最重要的两组测试：为什么会有这两组
 *   真机探测抓到一个事实：**`nodes` 是「累计字典」**——节点随执行陆续加入，不是开局到齐。
 *   实测一条 TTS 的三份报文是：
 *     ① nodes = { "2": 1/1 finished }
 *     ② nodes = { "2": 1/1 finished, "3": 0/1 running }
 *     ③ nodes = { "2": 1/1 finished, "3": 1/1 finished }
 *   按瞬时 Σvalue/Σmax 算，比值是 **1 → 0.5 → 1**，进度条会**倒退**。
 *   所以：
 *     - 第一组把「瞬时快照会倒退」这个事实**锁成断言**（不是修掉它，而是让后人知道别直接用它）；
 *     - 第二组验证 createProgressTracker 产出的对外进度**单调不回退**。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    aggregateProgressState,
    comfyWebSocketUrl,
    createProgressTracker,
    parseComfyMessage,
    subscribeComfyProgress,
} from "../src/comfy-progress.js";

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

/** 真机抓到的三份报文（一条 TTS，节点 2 先完成后节点 3 才出现）。 */
const REAL_TTS_SEQUENCE = [
    { "2": sampling("2", 1, 1, "finished") },
    { "2": sampling("2", 1, 1, "finished"), "3": sampling("3", 0, 1, "running") },
    { "2": sampling("2", 1, 1, "finished"), "3": sampling("3", 1, 1, "finished") },
];

test("瞬时快照：跨节点求和（分母是所有可计数节点的 max 之和）", () => {
    // 一条真实视频任务的典型形状：2 个可计数节点（1 完成 1 在跑）+ 1 个纯加载节点（max=0）。
    const progress = aggregateProgressState({
        nodes: {
            "3": sampling("3", 10, 10, "finished"),
            "7": sampling("7", 8, 40, "running"),
            "9": { value: 0, max: 0, state: "finished", node_id: "9" },
        },
    });
    assert.ok(progress, "有可计数节点就该算出进度");
    assert.equal(progress.max, 50, "分母是所有可计数节点的 max 之和");
    assert.equal(progress.value, 18, "分子含已完成节点的满值 + 进行中节点的部分值");
    assert.equal(progress.finishedNodes, 1);
    assert.equal(progress.totalNodes, 2, "无可计数 max 的节点不进 totalNodes");
    assert.equal(progress.ratio, 18 / 50);
    assert.equal(progress.node, "7", "要报出正在跑哪个节点，前端才能显示「生成中·节点 7」");
});

test("瞬时快照会倒退 —— 真机实测事实，锁住它以防有人直接拿去渲染进度条", () => {
    // 这不是缺陷断言，是**事实**断言：nodes 是累计字典，新节点加入会让分母变大。
    // 曾按 1 → 0.5 → 1 的顺序在代码注释里写「聚合可避免跳动」，与事实相反，已改正。
    const ratios = REAL_TTS_SEQUENCE.map((nodes) => aggregateProgressState({ nodes }).ratio);
    assert.deepEqual(ratios, [1, 0.5, 1], "瞬时比值确实会倒退：节点 3 加入后分母从 1 涨到 2");
    assert.ok(ratios[1] < ratios[0], "第 2 条比第 1 条低 —— 这就是不能直接渲染的证据");
});

test("跟踪器：对外进度单调不回退（这是给用户看的那一份）", () => {
    const tracker = createProgressTracker();
    const seen = REAL_TTS_SEQUENCE.map((nodes) => tracker.push({ prompt_id: "p1", nodes }));
    for (const s of seen) assert.ok(s, "每份有效报文都应产出进度");
    // 已完成步数单调不减：节点 2 的 1 步 → 加上节点 3 的 1 步。
    assert.equal(seen[0].value, 1);
    assert.equal(seen[1].value, 1, "节点 3 还在跑，不该把它的部分步数算进「已完成」");
    assert.equal(seen[2].value, 2, "节点 3 完成后已完成步数才 +1");
    // ratio 被钳在历史最大值，永不回退。
    assert.equal(seen[0].ratio, 1);
    assert.equal(seen[1].ratio, 1, "瞬时值是 0.5，但对用户必须是 1");
    assert.equal(seen[2].ratio, 1);
});

test("跟踪器：同一节点重复上报 finished 不重复累加", () => {
    // ComfyUI 会为同一节点多次推 finished 报文；重复累加会让进度虚高。
    const tracker = createProgressTracker();
    const nodes = { "2": sampling("2", 1, 1, "finished"), "3": sampling("3", 1, 1, "finished") };
    assert.equal(tracker.push({ nodes }).value, 2);
    assert.equal(tracker.push({ nodes }).value, 2, "同一份报文再推一次，已完成步数不变");
    assert.equal(tracker.push({ nodes }).value, 2);
});

test("跟踪器：没有可计数节点时如实返回 null，不拿 0% 冒充刚开始", () => {
    const tracker = createProgressTracker();
    assert.equal(tracker.push({ nodes: { "9": { value: 0, max: 0, state: "finished" } } }), null);
    assert.equal(tracker.push({}), null);
    assert.equal(tracker.done(), null, "从未收到有效消息 → 终态也是 null（调用方据此说「没拿到」）");
});

test("进度聚合：value 超过 max 时收敛到 1（不显示 120% 这种荒谬进度）", () => {
    const progress = aggregateProgressState({ nodes: { "1": sampling("1", 150, 100, "running") } });
    assert.equal(progress.value, 100, "超出部分按 max 收敛");
    assert.equal(progress.ratio, 1);
});

test("进度聚合：没有可计数节点时返回 null，而不是 0/0 冒充刚开始", () => {
    assert.equal(aggregateProgressState({ nodes: { "9": { value: 0, max: 0, state: "finished" } } }), null);
    assert.equal(aggregateProgressState({ nodes: { "1": { state: "running" } } }), null);
    assert.equal(aggregateProgressState({}), null);
    assert.equal(aggregateProgressState(null), null);
    assert.equal(aggregateProgressState({ nodes: "not-an-object" }), null);
    assert.notEqual(aggregateProgressState({}), { value: 0, max: 0, ratio: 0 });
});

test("消息解析：progress 事件必须带原始 data（跟踪器要靠它按 node_id 记账）", () => {
    const nodes = { "2": sampling("2", 1, 1, "finished") };
    const parsed = parseComfyMessage(progressMsg(nodes));
    assert.equal(parsed.kind, "progress");
    assert.equal(parsed.value, 1);
    // 少了 data，createProgressTracker 会拿到 undefined，累计口径直接落空。
    assert.deepEqual(parsed.data.nodes, nodes, "progress 事件要带原始 data.nodes");

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
    assert.equal(subscribeComfyProgress(), null);
    assert.equal(subscribeComfyProgress({ baseUrl: "http://x:8188" }), null);

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
    assert.equal(comfyWebSocketUrl("", "c"), "ws://127.0.0.1:8188/ws?clientId=c");
});
test("跟踪器：分母优先用 graph 给出的常量总步数，不被累计字典带偏", () => {
    // 真机教训（视频模板video_h3_ref2v_image_turbo）：
    //   ComfyUI 的 nodes 之和从 2 一路涨到 13，且先跑完的节点 14（max 极小）立刻把比值顶到 100%。
    //   而 graph 里已知的总步数是 8+1 = 9，开局就确定。
    const tracker = createProgressTracker({ totalSteps: 9 });
    // 第一份报文：节点 2 完成（1 步）+ 节点 3 在跑（0/1）
    const first = tracker.push({ prompt_id: "p1", nodes: { "2": sampling("2", 1, 1, "finished"), "3": sampling("3", 0, 1, "running") } });
    assert.equal(first.max, 9, "分母是 graph 的常量总步数，不随报文变化");
    assert.equal(first.denominator, "graph", "要标明分母口径来源，便于排查");
    assert.equal(first.value, 1);
    assert.equal(first.ratio, 1 / 9, "1/9 ≈ 11%，而不是被顶到 100%");
    // 后续新节点加入：分母仍是 9。
    const second = tracker.push({ prompt_id: "p1", nodes: { "2": sampling("2", 1, 1, "finished"), "3": sampling("3", 1, 1, "finished"), "11": sampling("11", 0, 8, "running") } });
    assert.equal(second.max, 9, "新节点加入不改变分母");
    assert.equal(second.value, 2, "节点 3 完成后已完成 2 步");
    assert.ok(Math.abs(second.ratio - 2 / 9) < 1e-9);
});

test("跟踪器：没有 graph 总步数时才退回 observed 分母，并标明口径", () => {
    const tracker = createProgressTracker();
    const p = tracker.push({ prompt_id: "p1", nodes: { "2": sampling("2", 1, 1, "finished") } });
    assert.equal(p.denominator, "observed", "没有常量分母时如实标明是累计值");
    assert.equal(p.max, 1);
    assert.equal(p.ratio, 1);
});

test("跟踪器：ratio 恒不超过 1（即使已完成步数超过 graph 总步数也不越界）", () => {
    // graph 漏算了某个采样节点时，分子可能超过分母；宁可显示 100% 也不能显示 130%。
    const tracker = createProgressTracker({ totalSteps: 2 });
    const p = tracker.push({ prompt_id: "p1", nodes: { "2": sampling("2", 1, 1, "finished"), "3": sampling("3", 1, 1, "finished"), "11": sampling("11", 8, 8, "finished") } });
    assert.ok(p.ratio <= 1, `ratio 必须 ≤ 1，实际 ${p.ratio}`);
    assert.equal(p.ratio, 1);
});

test("跟踪器：totalSteps 传 0 /负数/ 非数时退回 observed，不产生除零", () => {
    for (const bad of [0, -5, Number.NaN, "abc", null]) {
        const tracker = createProgressTracker({ totalSteps: bad });
        const p = tracker.push({ prompt_id: "p1", nodes: { "2": sampling("2", 1, 1, "finished") } });
        assert.ok(p, `totalSteps=${String(bad)} 不该让跟踪器崩`);
        assert.equal(p.denominator, "observed", `totalSteps=${String(bad)} 应退回 observed`);
    }
});

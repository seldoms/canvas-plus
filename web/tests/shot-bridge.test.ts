import { expect, test } from "bun:test";

import { buildShotNode, isShotNode, partitionDropShots, shotGridPosition, shotNodeText, shotPatchFromNode, shotRefOf, shotNodeTitle } from "../src/lib/canvas/shot-bridge";
import type { CanvasNodeData } from "../src/types/canvas";

/**
 * 画布 ↔ 分镜 双向（P2-B5）的纯函数契约。
 *
 * 这些函数是「发到画布」与「回写分镜」两头的形状定义：形状错了，画布上会出现空壳节点，
 * 或者回写时把画布自己的字段（size/quality）当成镜头字段写进 run 产物。
 */

/**
 * **真实的项目侧形状**：`Shot` 的分镜字段嵌在 `storyboard` 里（服务端 episodes.js 就是这么存的），
 * 顶层只有 id/index/episodeId/sceneId 这类结构位。
 *
 * 这条注释本身就是一条测试防线：上一版测试用的是平铺数据，于是
 * 「buildShotNode 只读顶层」这个真 bug 测了 9 条全绿，而真机上是 70 个空白节点。
 */
const SHOT = {
    id: "sh_1",
    index: 3,
    episodeId: "ep_0001",
    sceneId: "sc_0001",
    storyboard: {
        shotSize: "中景",
        durationSec: 4,
        camera: "固定机位",
        action: "她推开车门",
        dialogue: "你等谁？",
        prompt: "a woman stepping into a night bus",
        audio: "",
    },
};

/** 流水线 run 产物形状：同样的字段平铺在顶层（storyboard.json 就是这样）。 */
const RUN_SHOT = {
    id: "sh_2",
    index: 4,
    episodeId: "ep_0001",
    sceneId: "sc_0001",
    shotSize: "近景",
    durationSec: 5,
    camera: "推",
    action: "回头",
    dialogue: "",
    prompt: "close-up",
};

test("项目侧镜头（字段嵌在 storyboard 里）读得出来 —— 回归防线：曾只读顶层导致 70 个空白节点", () => {
    const node = buildShotNode(SHOT, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    expect(node.metadata?.shot?.prompt).toBe("a woman stepping into a night bus");
    expect(node.metadata?.shot?.durationSec).toBe(4);
    expect(node.metadata?.shot?.shotSize).toBe("中景");
    // 正文非空：空白节点就是「发到画布」看起来什么都不发生的那一幕
    expect(String(node.metadata?.content || "").length).toBeGreaterThan(0);
    expect(node.metadata?.content).toContain("中景");
    expect(node.metadata?.content).toContain("你等谁？");
});

test("两种输入形状（嵌套 project 侧 / 平铺 run 侧）产出同样的节点内容", () => {
    const fromProject = buildShotNode({ id: "sh_x", index: 1, storyboard: { prompt: "p1", action: "a1", durationSec: 3 } }, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    const fromRun = buildShotNode({ id: "sh_x", index: 1, prompt: "p1", action: "a1", durationSec: 3 }, { x: 0, y: 0 }, { projectId: "p", source: "run" });
    expect(fromProject.metadata?.shot).toEqual(fromRun.metadata?.shot);
    expect(fromProject.metadata?.content).toEqual(fromRun.metadata?.content);
});

test("正文不放生图提示词：文本节点的「生成图片」读 content，放进去只会拿中文当提示词出废图", () => {
    const node = buildShotNode(SHOT, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    expect(node.metadata?.content).not.toContain("a woman stepping into a night bus");
    // 提示词仍在可写副本里，回写面板读得到
    expect(node.metadata?.shot?.prompt).toBe("a woman stepping into a night bus");
});

test("镜头节点被识别（用于屏蔽「生成图片」这类不该出现的动作）", () => {
    expect(isShotNode(buildShotNode(SHOT, { x: 0, y: 0 }, { projectId: "p", source: "project" }))).toBe(true);
    expect(isShotNode({ id: "t1", type: "text", title: "随便写点", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { content: "hi" } })).toBe(false);
});

test("回写 patch 的比较忽略对象键序（{text,kind} 与 {kind,text} 判为未改动）", () => {
    const node = buildShotNode({ id: "sh_y", index: 1, storyboard: { textOverlays: [{ text: "喜宴", kind: "sign" }] } }, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    const patch = shotPatchFromNode(node, { textOverlays: [{ kind: "sign", text: "喜宴" }] });
    expect("textOverlays" in patch).toBe(false);
});

test("镜头节点带 shotRef 与可写内容副本（回写的数据源就在节点上）", () => {
    const node = buildShotNode(SHOT, { x: 100, y: 200 }, { projectId: "prj_1", source: "project" });
    expect(node.metadata?.shotRef?.shotId).toBe("sh_1");
    expect(node.metadata?.shotRef?.projectId).toBe("prj_1");
    expect(node.metadata?.shot?.prompt).toBe("a woman stepping into a night bus");
    expect(node.metadata?.shot?.durationSec).toBe(4);
    expect(node.metadata?.shot?.dialogue).toBe("你等谁？");
});

test("空值字段不塞进节点（audio 为空串就不该出现，回写时也该被跳过）", () => {
    // 注意覆盖方式：SHOT 是**嵌套**形状（字段在 storyboard 里），
    // `{ ...SHOT, audio: "" }` 只在顶层加了个空串，storyboard.audio 还在 —— 测的就不是「空值被跳过」了。
    const node = buildShotNode({ ...SHOT, storyboard: { ...SHOT.storyboard, audio: "", dialogue: "" } }, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    expect("audio" in (node.metadata?.shot || {})).toBe(false);
    expect("dialogue" in (node.metadata?.shot || {})).toBe(false);
    expect(String(node.metadata?.content || "")).not.toContain("台词：");
});

test("镜头 id 由 shot.id 自动填进 ref（调用方漏写也不会产出无归属节点）", () => {
    const node = buildShotNode(SHOT, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    expect(shotRefOf(node)?.shotId).toBe("sh_1");
    expect(shotRefOf(node)?.episodeId).toBe("ep_0001");
    expect(shotRefOf(node)?.sceneId).toBe("sc_0001");
});

test("没有 shotRef 的普通画布节点不可回写（shotRefOf 返回 null）", () => {
    const plain: CanvasNodeData = { id: "text-1", type: "text", title: "随便写点", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "hi" } };
    expect(shotRefOf(plain)).toBe(null);
    expect(shotRefOf(null)).toBe(null);
    // shotRef 存在但没有 shotId 的残缺数据也不能被当成可回写节点
    expect(shotRefOf({ ...plain, metadata: { shotRef: { shotId: "" } } })).toBe(null);
});

test("回写 patch 只取改动过的字段（与镜头原值相同的字段不提交）", () => {
    // 同样要改嵌套层：顶层加 prompt 不会覆盖 storyboard.prompt，那样测的是「什么都没变」。
    const node = buildShotNode({ ...SHOT, storyboard: { ...SHOT.storyboard, prompt: "新的提示词" } }, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    const patch = shotPatchFromNode(node, SHOT.storyboard);
    expect(patch.prompt).toBe("新的提示词");
    expect("durationSec" in patch).toBe(false);
    expect("action" in patch).toBe(false);
    expect("shotSize" in patch).toBe(false);
});

test("没有原值可比时（首次编辑）全量提交改动字段", () => {
    const node = buildShotNode(SHOT, { x: 0, y: 0 }, { projectId: "p", source: "project" });
    const patch = shotPatchFromNode(node, null);
    expect(patch.prompt).toBe("a woman stepping into a night bus");
    expect(patch.durationSec).toBe(4);
});

test("画布自身的字段绝不会被当成镜头字段回写（size 被画布规格占着）", () => {
    const node: CanvasNodeData = {
        id: "shot-sh_1",
        type: "text",
        title: "镜 3",
        position: { x: 0, y: 0 },
        width: 320,
        height: 200,
        metadata: { content: "画面描述", size: "1024x1536", quality: "hd", prompt: "只做画面预览", shot: { prompt: "真正的镜头提示词" } },
    };
    const patch = shotPatchFromNode(node, null);
    expect(patch.prompt).toBe("真正的镜头提示词");
    expect("size" in patch).toBe(false);
    expect("quality" in patch).toBe(false);
    expect("content" in patch).toBe(false);
});

test("网格排布不重叠：前 8 个镜头不共位，第 9 个换行", () => {
    const positions = Array.from({ length: 9 }, (_, index) => `${shotGridPosition(index).x},${shotGridPosition(index).y}`);
    expect(new Set(positions).size).toBe(9);
    expect(shotGridPosition(0).y).toBe(shotGridPosition(3).y);
    expect(shotGridPosition(4).y).toBeGreaterThan(shotGridPosition(0).y);
});

test("节点标题带镜号与 id；正文把可视化字段说清楚", () => {
    expect(shotNodeTitle(SHOT)).toContain("sh_1");
    const text = shotNodeText(SHOT);
    expect(text).toContain("中景");
    expect(text).toContain("你等谁？");
    // 正文**不含**提示词：文本节点的「生成图片」读 content，放进去会拿中文当提示词出废图。
    // （这条与「正文不放生图提示词」是同一件事的正面与反面，此处只锁「该说的说清了」）
    expect(text).not.toContain("a woman stepping into a night bus");
});
test("投递去重：按 shotId 幂等，且如实报出重复数（假反馈防线）", () => {
    const existing = ["sh_1", "sh_2"];
    const incoming = [{ id: "sh_1" }, { id: "sh_3" }, { id: "sh_2" }, { id: "sh_4" }];
    const { fresh, duplicateCount } = partitionDropShots(existing, incoming);
    expect(fresh.map((s) => s.id)).toEqual(["sh_3", "sh_4"]);
    expect(duplicateCount).toBe(2);
    // 重复投递整集：一条都不新增，调用方必须能据此说「没有新增」而不是报「已排布 N 个」。
    const again = partitionDropShots([...existing, "sh_3", "sh_4"], incoming);
    expect(again.fresh).toHaveLength(0);
    expect(again.duplicateCount).toBe(4);
});

test("投递去重：同一批里自身重复也只算一次", () => {
    const { fresh, duplicateCount } = partitionDropShots([], [{ id: "sh_1" }, { id: "sh_1" }]);
    expect(fresh).toHaveLength(1);
    expect(duplicateCount).toBe(1);
});

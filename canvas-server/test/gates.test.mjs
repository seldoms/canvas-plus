import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deriveGates, GATE_STAGES } from "../src/gates.js";
import { createProjects } from "../src/projects.js";

const gateById = (gates) => Object.fromEntries(gates.map((gate) => [gate.stageId, gate]));

test("deriveGates：纯函数，阶段齐全、结构含 { stageId, ready, reason, blockedBy }", () => {
    const gates = deriveGates({ project: { plan: {} }, episodes: [] });
    assert.deepEqual(gates.map((gate) => gate.stageId), GATE_STAGES.map((stage) => stage.id));
    for (const gate of gates) {
        assert.ok("stageId" in gate && "ready" in gate && "reason" in gate && "blockedBy" in gate);
        assert.equal(typeof gate.ready, "boolean");
        assert.equal(typeof gate.reason, "string");
        assert.ok(Array.isArray(gate.blockedBy));
    }
});

test("缺上游阻挡：无剧本时 分镜 被 script 挡住；补上源版本后放行", () => {
    const project = { plan: {}, script: null, sourceRevisionId: null, assetRefs: [], reviewNotes: [] };

    const before = gateById(deriveGates({ project, episodes: [] }));
    assert.equal(before.plan.ready, true);
    assert.equal(before.plan.done, true, "有 plan 即规划 done");
    assert.equal(before.script.ready, true, "上游 plan 已就绪");
    assert.equal(before.script.done, false, "无剧本产物");
    assert.equal(before.storyboard.ready, false, "剧本未完成，分镜被挡");
    assert.ok(before.storyboard.blockedBy.some((item) => item.type === "upstream" && item.stageId === "script"));
    assert.match(before.storyboard.reason, /上游阶段未完成/);
    assert.equal(before.keyframe.ready, false, "更下游一并被挡");

    // 有了源版本 → 剧本 done → 分镜放行；但资产未就绪，关键帧仍被挡
    const after = gateById(deriveGates({ project: { ...project, sourceRevisionId: "src_1" }, episodes: [] }));
    assert.equal(after.script.done, true);
    assert.equal(after.storyboard.ready, true);
    assert.equal(after.storyboard.done, false, "尚无分镜产物");
    assert.equal(after.keyframe.ready, false);
    assert.ok(after.keyframe.blockedBy.some((item) => item.type === "upstream" && item.stageId === "design"));
});

test("阶段 ID 冻结：GATE_STAGES 与流水线阶段对齐（design/assembly 命名 + requires 链）", () => {
    const byId = Object.fromEntries(GATE_STAGES.map((stage) => [stage.id, stage]));
    // 唯一权威命名（domain-contract.md §3.9「阶段 ID 权威命名」）
    assert.deepEqual(GATE_STAGES.map((stage) => stage.id), ["plan", "script", "storyboard", "design", "keyframe", "assembly", "post"]);
    // 旧命名不得残留
    assert.equal("assets" in byId, false, "assets 已并入 design");
    assert.equal("video" in byId, false, "video 已并入 assembly");
    // requires 链：design 替代 assets、assembly 替代 video，与 skills/registry.json 的 run 阶段一致
    assert.deepEqual(byId.design.requires, ["script"]);
    assert.deepEqual(byId.keyframe.requires, ["storyboard", "design"]);
    assert.deepEqual(byId.assembly.requires, ["keyframe"]);
    assert.deepEqual(byId.post.requires, ["assembly"]);
    // requires 不得悬空：指向的阶段必须真实存在，否则该阶段永远放行不了
    for (const stage of GATE_STAGES) for (const dep of stage.requires) assert.ok(byId[dep], `${stage.id} 的 requires 指向不存在的阶段 ${dep}`);
});

test("design 门禁：登记 assetRefs 即 done，并解除 keyframe 的 design 依赖", () => {
    const project = { plan: {}, script: {}, sourceRevisionId: "src_1", assetRefs: [], reviewNotes: [] };
    const episode = { id: "ep_0001", status: "pending", scenes: [{ id: "sc_0001" }], shots: [] };
    const before = gateById(deriveGates({ project, episodes: [episode] }));
    assert.equal(before.design.ready, true, "上游 script 已就绪");
    assert.equal(before.design.done, false, "尚无资产引用");
    assert.ok(before.keyframe.blockedBy.some((item) => item.type === "upstream" && item.stageId === "design"));

    const after = gateById(deriveGates({ project: { ...project, assetRefs: [{ id: "as_1" }] }, episodes: [episode] }));
    assert.equal(after.design.done, true, "有 assetRefs 即资产阶段 done");
    assert.equal(after.keyframe.blockedBy.some((item) => item.type === "upstream" && item.stageId === "design"), false);
});

test("block 风险提示阻断对应阶段；标记 resolved 后解除（D9/R9）", () => {
    const episode = { id: "ep_0001", status: "pending", scenes: [{ id: "sc_0001" }], shots: [] };
    const project = { plan: {}, script: {}, sourceRevisionId: "src_1", assetRefs: [], reviewNotes: [{ id: "n1", level: "block", stage: "keyframe", message: "连续性风险", resolvedAt: null }] };

    const blocked = gateById(deriveGates({ project, episodes: [episode] }));
    assert.equal(blocked.keyframe.ready, false);
    assert.ok(blocked.keyframe.blockedBy.some((item) => item.type === "review" && item.noteId === "n1"));
    assert.match(blocked.keyframe.reason, /阻断风险提示/);
    assert.equal(blocked.storyboard.ready, true, "block 只阻断它归属的阶段，不误伤上游");

    const resolved = gateById(deriveGates({ project: { ...project, reviewNotes: [{ ...project.reviewNotes[0], resolvedAt: "2026-10-03T00:00:00.000Z" }] }, episodes: [episode] }));
    assert.equal(resolved.keyframe.blockedBy.some((item) => item.type === "review"), false, "已处理的风险不再阻断");

    // warn / info 不阻断
    const warn = gateById(deriveGates({ project: { ...project, reviewNotes: [{ id: "w1", level: "warn", stage: "keyframe", message: "提示", resolvedAt: null }] }, episodes: [episode] }));
    assert.equal(warn.keyframe.blockedBy.some((item) => item.type === "review"), false);
});

test("projects.gates：走真实存储，block 风险落 project.reviewNotes 后即阻断", (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-gates-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { projects } = { projects: createProjects({ dataDir: root }) };

    const project = projects.create({ title: "甲" });
    const gates = projects.gates(project.id);
    assert.equal(gates.length, 7);
    assert.equal(gateById(gates).storyboard.ready, false, "无剧本、无源版本");

    projects.update(project.id, { reviewNotes: [{ id: "n1", level: "block", stage: "script", message: "备案风险", resolvedAt: null }] });
    const blocked = gateById(projects.gates(project.id));
    assert.equal(blocked.script.ready, false);
    assert.ok(blocked.script.blockedBy.some((item) => item.type === "review"));

    assert.equal(projects.gates("prj_nope"), null);
});

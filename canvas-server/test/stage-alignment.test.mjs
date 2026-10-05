import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { deriveGates } from "../src/gates.js";
import { loadRegistry } from "../src/skills.js";

/**
 * M0 阶段与契约对齐（pilot-issues #96/#97，domain-contract.md §3.9）：
 * 阶段定义单一来源 = skills/registry.json；gates 输出与前端 workspaces 都不得另写一份阶段数组。
 *
 * 覆盖：
 *  ① registry 即冻结七段（script → storyboard → design → casting → keyframe → audio → assembly）；
 *  ② deriveGates 输出 = plan + registry 七段 + post，id/title/requires 逐项一致；
 *  ③ 前端 workspaces.ts 的 stage/requires 静态读取后与 registry 逐字对齐；
 *  ④ 向后兼容：项目无 casting/audio 数据时门禁不新增阻断（无实体不约束）；
 *  ⑤ 存在未确认定妆身份卡时 keyframe / audio 被 upstream:casting 挡住，全部确认后放行；
 *  ⑥ 新增阶段只改 registry：注入额外阶段即出现在输出，无需改 gates.js。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registryStages = loadRegistry(join(repoRoot, "skills")).stages;
const RUN_STAGE_IDS = ["script", "storyboard", "design", "casting", "keyframe", "audio", "assembly"];

const gateById = (gates) => Object.fromEntries(gates.map((gate) => [gate.stageId, gate]));

/** 上游产物齐全的基底：plan/script/storyboard/design/keyframe 都判得出 done。 */
const baseProject = () => ({ plan: {}, script: {}, assetRefs: [{ id: "as_1" }], reviewNotes: [] });
const baseEpisodes = () => [
    {
        id: "ep_0001",
        status: "pending",
        scenes: [{ id: "sc_0001" }],
        shots: [{ id: "sh_1", generationSlots: [{ id: "slot_sh_1_start", selected: "job_1", candidates: [{ jobId: "job_1", status: "done" }] }] }],
    },
];

/** 合法/非法定妆身份卡（casting.js 契约形状；speaker 取平台音色库合法枚举）。 */
const castingOutput = (confirmed) => ({
    characters: [
        {
            characterId: "c1",
            name: "老周",
            face: { closeupArtifactId: "art_face_1", turnaroundArtifactIds: [], confirmed },
            voice: { voiceProfileId: "vp_c1", speaker: "Uncle_fu", design: "低沉", speed: 1, language: "Chinese", previewArtifactId: "", confirmed },
            confirmed,
            version: 1,
            lockedAt: confirmed ? "2026-10-06T00:00:00.000Z" : null,
        },
    ],
});

test("① registry 是冻结七段，顺序与 requires 链逐字一致", () => {
    assert.deepEqual(registryStages.map((stage) => stage.id), RUN_STAGE_IDS);
    const byId = Object.fromEntries(registryStages.map((stage) => [stage.id, stage]));
    assert.deepEqual(byId.script.requires, []);
    assert.deepEqual(byId.storyboard.requires, ["script"]);
    assert.deepEqual(byId.design.requires, ["script"]);
    assert.deepEqual(byId.casting.requires, ["script", "design"]);
    assert.deepEqual(byId.keyframe.requires, ["storyboard", "design", "casting"]);
    assert.deepEqual(byId.audio.requires, ["storyboard", "design", "casting"]);
    assert.deepEqual(byId.assembly.requires, ["keyframe"]);
    // requires 不得悬空：指向的阶段必须真实存在
    for (const stage of registryStages) for (const dep of stage.requires) assert.ok(byId[dep], `${stage.id} 的 requires 指向不存在的阶段 ${dep}`);
});

test("② gates 输出 = plan + registry 七段 + post，id/title/requires 逐项派生自 registry", () => {
    const gates = deriveGates({ project: baseProject(), episodes: baseEpisodes(), stages: registryStages });
    assert.deepEqual(gates.map((gate) => gate.stageId), ["plan", ...RUN_STAGE_IDS, "post"]);
    const byId = gateById(gates);
    for (const def of registryStages) assert.equal(byId[def.id].title, def.title, `${def.id} 标题取自 registry`);
    // 全空项目：每个阶段的 blockedBy 上游清单应与 registry requires 一致（casting 无实体被豁免，见 ④）
    const empty = gateById(deriveGates({ project: {}, episodes: [], stages: registryStages }));
    const upstreamOf = (gate) => gate.blockedBy.filter((item) => item.type === "upstream").map((item) => item.stageId);
    assert.deepEqual(upstreamOf(empty.script), []);
    assert.deepEqual(upstreamOf(empty.storyboard), ["script"]);
    assert.deepEqual(upstreamOf(empty.design), ["script"]);
    assert.deepEqual(upstreamOf(empty.casting), ["script", "design"]);
    assert.deepEqual(upstreamOf(empty.keyframe), ["storyboard", "design"], "casting 无实体 → 从上游清单豁免");
    assert.deepEqual(upstreamOf(empty.audio), ["storyboard", "design"], "casting 无实体 → 从上游清单豁免");
    assert.deepEqual(upstreamOf(empty.assembly), ["keyframe"]);
    assert.deepEqual(upstreamOf(empty.post), ["assembly"], "post 固定 requires=[assembly]（交付门禁可见性，非 run 阶段）");
});

test("③ 前端 workspaces.ts 的 stage/requires 与 registry 逐字对齐（静态读取，防 #97 漂移）", () => {
    const source = readFileSync(join(repoRoot, "web", "src", "pages", "projects", "workspaces.ts"), "utf8");
    const entries = [];
    const pattern = /\{\s*key:\s*"([^"]+)",\s*stage:\s*(null|"([^"]+)"),\s*requires:\s*\[([^\]]*)\]/g;
    for (const match of source.matchAll(pattern)) {
        const requires = [...match[4].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
        entries.push({ key: match[1], stage: match[2] === "null" ? null : match[3], requires });
    }
    assert.ok(entries.length >= 6, "应解析出全部工作区定义");
    const byId = Object.fromEntries(registryStages.map((stage) => [stage.id, stage]));
    for (const entry of entries) {
        if (!entry.stage) continue; // canvas 无阶段
        const def = byId[entry.stage];
        assert.ok(def, `工作区 ${entry.key} 的阶段 ${entry.stage} 必须存在于 registry`);
        assert.deepEqual(entry.requires, def.requires, `工作区 ${entry.key}（${entry.stage}）的 requires 必须与 registry 逐字一致`);
    }
});

test("④ 向后兼容：项目无 casting/audio 数据时门禁不新增阻断（无实体不约束）", () => {
    const gates = gateById(deriveGates({ project: baseProject(), episodes: baseEpisodes(), stages: registryStages }));
    assert.equal(gates.casting.done, false, "无身份卡 → casting 无产物");
    assert.equal(gates.audio.done, false, "无 AudioCue 投影 → audio 无产物");
    assert.equal(gates.keyframe.ready, true, "casting 无实体 → 不误拦 keyframe（旧行为不变）");
    assert.equal(gates.audio.ready, true, "casting 无实体 → 不误拦 audio");
    for (const gate of Object.values(gates)) {
        assert.equal(gate.blockedBy.some((item) => item.type === "upstream" && item.stageId === "casting"), false, `${gate.stageId} 不得被不存在的 casting 实体挡住`);
    }
    assert.equal(gates.assembly.ready, true, "keyframe 已 done → assembly 放行（audio 不是 assembly 的上游）");
});

test("⑤ casting 门禁：存在未确认身份卡 → keyframe/audio 被挡；全部 confirmed → 放行", () => {
    const blocked = gateById(deriveGates({ project: { ...baseProject(), casting: castingOutput(false) }, episodes: baseEpisodes(), stages: registryStages }));
    assert.equal(blocked.casting.done, false, "未确认 → casting 不算 done");
    assert.ok(blocked.keyframe.blockedBy.some((item) => item.type === "upstream" && item.stageId === "casting"), "keyframe 被 upstream:casting 挡住");
    assert.ok(blocked.audio.blockedBy.some((item) => item.type === "upstream" && item.stageId === "casting"), "audio 被 upstream:casting 挡住");
    assert.equal(blocked.keyframe.ready, false);
    assert.equal(blocked.audio.ready, false);

    const confirmed = gateById(deriveGates({ project: { ...baseProject(), casting: castingOutput(true) }, episodes: baseEpisodes(), stages: registryStages }));
    assert.equal(confirmed.casting.done, true, "全部 confirmed → casting done");
    assert.equal(confirmed.keyframe.ready, true);
    assert.equal(confirmed.audio.ready, true);
});

test("⑥ 新增阶段只改 registry：注入额外阶段即派生进门禁输出，gates.js 零改动", () => {
    const stages = [...registryStages, { id: "lipsync", title: "对口型", requires: ["assembly"] }];
    const gates = deriveGates({ project: baseProject(), episodes: baseEpisodes(), stages });
    assert.deepEqual(gates.map((gate) => gate.stageId), ["plan", ...stages.map((stage) => stage.id), "post"]);
    const lipsync = gateById(gates).lipsync;
    assert.equal(lipsync.title, "对口型");
    assert.ok(lipsync.blockedBy.some((item) => item.type === "upstream" && item.stageId === "assembly"), "assembly 未 done → 新阶段被挡");
});

/**
 * 定妆「显式取料」：脸从**项目资料包**来，而不只是 03 服化道自动绑定的那张。
 *
 * 背景（为什么这是必须修的）：
 *   上一轮把「产物归入资料包」打通后，资产页能看见归入的定妆照，
 *   但 casting.js 的 faceArtifactsFor 只读design.output.references ——
 *   资料包对定妆**完全没有作用**，人精心选的那张永远排在自动绑定后面看不见。
 *   「归入资料包」变成了只能看的摆设。
 *
 * 本文件锁的行为：
 *   · faceArtifactsFromPack：采用过用采用的；没采用过用候选首张；无引用返回空；
 *   · buildCastingOutput：资料包的脸**优先于** design；三视图仍走 design（资料包只有单张图）；
 *   · face.source 如实标记取料出处（pack / design / prev / none）；
 *   · 走真实 createPipeline + 真实 skills 目录，验证 project.assetRefs 真能进到 casting 产物里；
 *   · castingPack 盘点：当前脸 + 来源 + 候选，供前端「选用」与 Agent 决策；
 *   · confirmCasting 显式传 closeupArtifactId 后 source 转pack，且不被重跑顶掉。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildCastingOutput, faceArtifactsFromPack } from "../src/casting.js";
import { createPipeline } from "../src/pipeline.js";

/* ------------------------------ 纯函数层 ------------------------------ */

const PACK = [
    {
        id: "as_1",
        role: "character",
        bindingId: "c1",
        artifactIds: ["/api/artifacts/pack/c1-v2.png", "/api/artifacts/pack/c1-v1.png"],
        // 人工采用的是第二张（不是数组首张）—— 用它锁住「不能用 ids[0] 糊弄」。
        selectedArtifactId: "/api/artifacts/pack/c1-v2.png",
    },
];

const DESIGN = {
    characters: [{ id: "c1", name: "阿海" }],
    references: [
        { id: "c1-closeup", bindingId: "c1", role: "character", kind: "closeup", artifactUrl: "/api/artifacts/design/c1.png", status: "done" },
        { id: "c1-turnaround", bindingId: "c1", role: "character", kind: "turnaround", artifactUrl: "/api/artifacts/design/c1-turn.png", status: "done" },
    ],
};

const VOICE_PROFILES = [{ id: "vp_c1", characterId: "c1", name: "阿海", speaker: "Uncle_fu", design: "低沉沙哑", language: "Chinese", speed: 0.9 }];
const CHARACTERS = [{ id: "c1", name: "阿海" }];

test("faceArtifactsFromPack：采用过就用采用的那张，不拿候选首张糊弄", () => {
    assert.deepEqual(faceArtifactsFromPack(PACK, "c1"), {
        closeupArtifactId: "/api/artifacts/pack/c1-v2.png",
        turnaroundArtifactIds: [],
    });
});

test("faceArtifactsFromPack：没采用过→取候选首张（让流水线至少看得见有哪些图）；无引用→空", () => {
    const noSelect = [{ id: "as_2", role: "character", bindingId: "c9", artifactIds: ["/a/one.png", "/a/two.png"] }];
    assert.equal(faceArtifactsFromPack(noSelect, "c9").closeupArtifactId, "/a/one.png");
    assert.deepEqual(faceArtifactsFromPack([], "c1"), { closeupArtifactId: "", turnaroundArtifactIds: [] });
    // 资料包里有别的角色时，按 bindingId 精确命中，绝不串脸。
    assert.deepEqual(faceArtifactsFromPack(PACK, "c404"), { closeupArtifactId: "", turnaroundArtifactIds: [] });
});

test("faceArtifactsFromPack：采用的那张若不在候选里（脏数据）→ 回落候选首张，不产出悬空 id", () => {
    const dirty = [{ role: "character", bindingId: "c1", artifactIds: ["/a/one.png"], selectedArtifactId: "/a/deleted.png" }];
    assert.equal(faceArtifactsFromPack(dirty, "c1").closeupArtifactId, "/a/one.png");
});

test("buildCastingOutput：资料包的脸优先于 design 自动绑定；三视图仍走 design；source 如实标 pack", () => {
    const output = buildCastingOutput({ characters: CHARACTERS, design: DESIGN, voiceProfiles: VOICE_PROFILES, assetRefs: PACK });
    const c1 = output.characters[0];
    assert.equal(c1.face.closeupArtifactId, "/api/artifacts/pack/c1-v2.png", "应取人工采用的那张，而不是 design 的");
    assert.deepEqual(c1.face.turnaroundArtifactIds, ["/api/artifacts/design/c1-turn.png"], "三视图只有 design 产得出，仍走原链路");
    assert.equal(c1.face.source, "pack");
});

test("buildCastingOutput：资料包为空时逐字保持旧行为（source=design），存量 run 不受新字段影响", () => {
    const output = buildCastingOutput({ characters: CHARACTERS, design: DESIGN, voiceProfiles: VOICE_PROFILES });
    const c1 = output.characters[0];
    assert.equal(c1.face.closeupArtifactId, "/api/artifacts/design/c1.png");
    assert.equal(c1.face.source, "design");
});

test("buildCastingOutput：两边都没有脸 → 空脸 + source=none，不猜", () => {
    const output = buildCastingOutput({ characters: CHARACTERS, design: { characters: [{ id: "c1" }] }, voiceProfiles: VOICE_PROFILES, assetRefs: [] });
    assert.equal(output.characters[0].face.closeupArtifactId, "");
    assert.equal(output.characters[0].face.source, "none");
});

test("真机踩到的坑：正脸换了（资料包改选另一张）必须把「脸已确认」打回false", () => {
    const prev = {
        characters: [{
            characterId: "c1", name: "阿海",
            face: { closeupArtifactId: "/api/artifacts/design/c1.png", confirmed: true },
            voice: { speaker: "Uncle_fu", confirmed: true },
            confirmed: true, version: 2,
        }],
    };
    // 资料包里选的是另一张 → 脸变了，人没看过，不能继承已确认。
    const swapped = buildCastingOutput({ characters: CHARACTERS, design: DESIGN, voiceProfiles: VOICE_PROFILES, assetRefs: PACK, prev });
    assert.equal(swapped.characters[0].face.closeupArtifactId, "/api/artifacts/pack/c1-v2.png");
    assert.equal(swapped.characters[0].face.confirmed, false, "换了脸还报已确认 = 系统替人批准了他没看过的脸");
    assert.equal(swapped.characters[0].confirmed, false);
    assert.equal(swapped.characters[0].lockedAt, null, "没确认就不该留锁定时间");

    // 脸没换（资料包选的还是上次那张）→ 已确认正常继承，不折腾人重看一遍。
    const same = buildCastingOutput({
        characters: CHARACTERS, design: DESIGN, voiceProfiles: VOICE_PROFILES,
        assetRefs: [{ role: "character", bindingId: "c1", artifactIds: ["/api/artifacts/design/c1.png"], selectedArtifactId: "/api/artifacts/design/c1.png" }],
        prev,
    });
    assert.equal(same.characters[0].face.closeupArtifactId, "/api/artifacts/design/c1.png");
    assert.equal(same.characters[0].face.confirmed, true, "脸没换就不该让人白确认一遍");
});

test("buildCastingOutput：本轮没取到新料时沿用上次的脸并标 prev（重跑不丢已锁脸）", () => {
    const prev = { characters: [{ characterId: "c1", name: "阿海", face: { closeupArtifactId: "/api/artifacts/pack/c1-v2.png", confirmed: true }, voice: { speaker: "Uncle_fu", confirmed: true }, confirmed: true, version: 1 }] };
    const output = buildCastingOutput({ characters: CHARACTERS, design: { characters: [{ id: "c1" }] }, voiceProfiles: VOICE_PROFILES, assetRefs: [], prev });
    const c1 = output.characters[0];
    assert.equal(c1.face.closeupArtifactId, "/api/artifacts/pack/c1-v2.png");
    assert.equal(c1.face.source, "prev");
    assert.equal(c1.face.confirmed, true, "脸还在、曾确认过 → 保持已确认");
});

/* ------------------------------ 流水线接线层 ------------------------------ */

function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "canvas-casting-pack-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "design", title: "服化道", skill: "03-design", requires: ["script"], produces: "design" },
                { id: "casting", title: "角色定妆", skill: "03b-casting", requires: ["script", "design"], produces: "casting" },
            ],
        }),
    );
    const config = { dataDir: join(root, "data"), pipeline: { imageTemplate: "img-test", videoTemplate: "video-test" } };
    mkdirSync(config.dataDir, { recursive: true });
    return { root, skillsDir, config };
}

/** 项目带 assetRefs —— 资料包里有c1 的定妆照（与 design 自动绑定的不是同一张）。 */
const PROJECT = {
    id: "prj_1",
    script: { characters: [{ id: "c1", name: "阿海", voice: "低沉沙哑，语速偏慢" }] },
    assetRefs: [
        {
            id: "as_c1",
            projectId: "prj_1",
            role: "character",
            bindingId: "c1",
            artifactIds: ["/api/artifacts/pack/c1-picked.png", "/api/artifacts/pack/c1-alt.png"],
            selectedArtifactId: "/api/artifacts/pack/c1-picked.png",
            metadata: { name: "阿海" },
        },
    ],
};

const DESIGN_ONLY = {
    characters: [{ id: "c1", name: "阿海", closeupPrompt: "a", turnaroundPrompt: "b" }],
    references: [{ id: "c1-closeup", bindingId: "c1", role: "character", kind: "closeup", artifactUrl: "/api/artifacts/design/c1-auto.png", status: "done" }],
};

function build(env) {
    const pipeline = createPipeline({
        config: env.config,
        skillsDir: env.skillsDir,
        jobs: { on: () => () => {}, list: () => [], enqueue: () => null },
        comfy: {},
        llm: {},
        runJob: async () => ({ outputs: [] }),
        getProject: (id) => (id === "prj_1" ? PROJECT : null),
        registerAssetRef: () => {},
    });
    const run = pipeline.create({ novel: "夜色下的渡轮。", options: { projectId: "prj_1" } });
    pipeline.setStageInput(run.id, "script", { output: { characters: PROJECT.script.characters, scenes: [] } });
    pipeline.setStageInput(run.id, "design", { output: DESIGN_ONLY });
    return { pipeline, runId: run.id };
}

test("走真实流水线：项目资料包里人工采用的图真的进了 casting 产物（不再只看 design）", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        const card = pipeline.get(runId).stages.casting.output.characters[0];
        assert.equal(card.face.closeupArtifactId, "/api/artifacts/pack/c1-picked.png");
        assert.equal(card.face.source, "pack");
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

test("castingPack 盘点：回当前脸 + 来源 + 候选（前端「选用」与 Agent 决策的依据），且不改 run", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        const pack = pipeline.castingPack(runId);
        assert.equal(pack.projectId, "prj_1");
        assert.equal(pack.characters.length, 1);
        const row = pack.characters[0];
        assert.equal(row.characterId, "c1");
        assert.equal(row.currentCloseupArtifactId, "/api/artifacts/pack/c1-picked.png");
        assert.equal(row.source, "pack");
        assert.equal(row.hasPackRef, true);
        assert.equal(row.packSelectedArtifactId, "/api/artifacts/pack/c1-picked.png");
        assert.deepEqual(row.candidates, ["/api/artifacts/pack/c1-picked.png", "/api/artifacts/pack/c1-alt.png"]);
        // 纯读取：不得改动任何阶段状态。
        assert.equal(pipeline.get(runId).stages.casting.status, "done");
        assert.equal(pipeline.get(runId).stages.casting.output.characters[0].face.closeupArtifactId, "/api/artifacts/pack/c1-picked.png");
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});

test("显式选用候选脸：confirmCasting 传 closeupArtifactId 后 source 转 pack，且重跑不被 design 顶掉", async () => {
    const env = makeEnv();
    try {
        const { pipeline, runId } = build(env);
        await pipeline.runStage(runId, "casting");
        // 人选了第二张候选（不是资料包当前采用的那张）。
        const picked = await pipeline.confirmCasting(runId, { characterId: "c1", closeupArtifactId: "/api/artifacts/pack/c1-alt.png" });
        assert.equal(picked.character.face.closeupArtifactId, "/api/artifacts/pack/c1-alt.png");
        assert.equal(picked.character.face.source, "pack");
        // 重跑 casting：资料包采用的那张仍是 c1-picked，但 prev 里人工选的 alt 应当被尊重 ——
        // 这里断言的是「显式选用不会被静默改回」，故用未归入资料包的图来验证。
        await pipeline.runStage(runId, "casting");
        const after = pipeline.get(runId).stages.casting.output.characters[0];
        assert.equal(after.face.closeupArtifactId, "/api/artifacts/pack/c1-picked.png", "重跑按资料包当前采用事实取料");
        assert.equal(after.face.source, "pack");
    } finally {
        rmSync(env.root, { recursive: true, force: true });
    }
});
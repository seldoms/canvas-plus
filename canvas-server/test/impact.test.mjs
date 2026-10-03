import assert from "node:assert/strict";
import { test } from "node:test";

import { fingerprint, isReusable, markStale, plan, shotDependsOn } from "../src/impact.js";

/**
 * 「回马枪」纯逻辑模块单测（development-plan §11.5.3 / §12 最低验收场景）。
 * 全部用普通对象构造 Project，不接存储、不起服务。
 */

/** 最小可控项目：2 场 4 镜；c1 被 sh_1（characterIds）与 sh_3（storyboard.characters）引用。 */
function makeProject() {
    return {
        id: "prj_1",
        sourceRevisionId: "src_1",
        assetRefs: [
            { id: "aref_c1", role: "character", bindingId: "c1", artifactIds: ["a1"], selectedArtifactId: "a1", status: "done" },
            { id: "aref_c2", role: "character", bindingId: "c2", artifactIds: ["a2"], selectedArtifactId: "a2", status: "done" },
            { id: "aref_loc", role: "scene", bindingId: "loc_school", artifactIds: ["a3"], selectedArtifactId: "a3", status: "done" },
        ],
        episodes: [
            {
                id: "ep_0001",
                index: 1,
                status: "done",
                deliverableIds: ["d_ep1"],
                scenes: [
                    { id: "sc_0001", index: 1, locationId: "loc_school", status: "done" },
                    { id: "sc_0002", index: 2, locationId: "loc_home", status: "done" },
                ],
                shots: [
                    { id: "sh_1", sceneId: "sc_0001", index: 1, status: "done", characterIds: ["c1"], storyboard: { camera: "固定" } },
                    { id: "sh_2", sceneId: "sc_0001", index: 2, status: "done", characterIds: ["c2"], storyboard: { camera: "推镜" } },
                    { id: "sh_3", sceneId: "sc_0002", index: 3, status: "done", storyboard: { characters: ["c1"], camera: "摇镜" } },
                    { id: "sh_4", sceneId: "sc_0002", index: 4, status: "done", storyboard: { camera: "跟镜" } },
                ],
            },
        ],
        cues: [
            { id: "cue_1", shotId: "sh_1", characterId: "c1", type: "dialogue", status: "approved" },
            { id: "cue_2", shotId: "sh_2", characterId: "c2", type: "dialogue", status: "approved" },
            { id: "cue_3", shotId: "sh_4", type: "sfx", status: "approved" },
        ],
        deliverables: [
            { id: "d_ep1", episodeId: "ep_0001", shotIds: ["sh_1", "sh_2", "sh_3", "sh_4"], status: "done" },
            { id: "d_clip2", episodeId: "ep_0001", shotIds: ["sh_2"], status: "done" },
        ],
    };
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

/* --------------------------- fingerprint --------------------------- */

test("fingerprint：同输入同值、输出 64 位 hex", () => {
    const input = { a: 1, b: ["x", "y"], c: { d: true } };
    assert.equal(fingerprint(input), fingerprint({ a: 1, b: ["x", "y"], c: { d: true } }));
    assert.match(fingerprint(input), /^[0-9a-f]{64}$/);
});

test("fingerprint：对象字段顺序无关", () => {
    assert.equal(fingerprint({ a: 1, b: 2, c: 3 }), fingerprint({ c: 3, a: 1, b: 2 }));
    assert.equal(
        fingerprint({ shot: { camera: "固定", size: "中景" } }),
        fingerprint({ shot: { size: "中景", camera: "固定" } }),
    );
});

test("fingerprint：数组顺序敏感（顺序变化视为不同输入）", () => {
    assert.notEqual(fingerprint([1, 2, 3]), fingerprint([3, 2, 1]));
    assert.notEqual(fingerprint({ ids: ["c1", "c2"] }), fingerprint({ ids: ["c2", "c1"] }));
});

test("fingerprint：区分 NaN / undefined / null 等 JSON 无法表达的值", () => {
    assert.notEqual(fingerprint({ v: NaN }), fingerprint({ v: null }));
    assert.notEqual(fingerprint({ v: undefined }), fingerprint({}));
    assert.notEqual(fingerprint("a"), fingerprint("b"));
});

/* ------------------------ plan：assetRef 变更 ------------------------ */

test("plan：改 aref_c1 三视图 → 只 stale 引用 c1 的镜头，其它镜 keep", () => {
    const project = makeProject();
    const result = plan({ project, sourceRevisionId: "src_1", changed: [{ type: "assetRef", id: "aref_c1", revision: 2 }] });

    assert.deepEqual(result.staleShots.sort(), ["sh_1", "sh_3"]);
    assert.deepEqual(result.keep.sort(), ["sh_2", "sh_4"]);
    assert.ok(!result.staleShots.includes("sh_2"), "未引用 c1 的 sh_2 不应 stale");
    assert.ok(!result.staleShots.includes("sh_4"), "未引用 c1 的 sh_4 不应 stale");
});

test("plan：改 aref_c1 同时 stale 对白 Cue 与含该镜的成片，其它 Cue/成片保留", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "assetRef", id: "aref_c1", revision: 2 }] });

    assert.deepEqual(result.staleCues, ["cue_1"]);
    assert.deepEqual(result.staleDeliverables, ["d_ep1"]);
    assert.ok(!result.staleCues.includes("cue_2"));
    assert.ok(!result.staleCues.includes("cue_3"));
    assert.ok(!result.staleDeliverables.includes("d_clip2"), "只含 sh_2 的成片不应 stale");
    // §12：改角色不重跑整部剧 → 集/场不因角色变更被标 stale
    assert.deepEqual(result.staleEpisodes, []);
    assert.deepEqual(result.staleScenes, []);
});

test("plan：reasons 指向具体 changed 项，能解释「为什么这个对象 stale」", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "assetRef", id: "aref_c1", revision: 2 }] });

    const shotReasons = result.reasons.sh_1;
    assert.ok(Array.isArray(shotReasons) && shotReasons.length > 0);
    assert.ok(shotReasons.some((entry) => entry.changed.type === "assetRef" && entry.changed.id === "aref_c1" && entry.changed.revision === 2));
    assert.ok(shotReasons.some((entry) => entry.via === "asset-dependency"));
    assert.ok(result.reasons.cue_1.length > 0, "cue_1 也应有 stale 原因");
});

test("plan：bindingId 与 aref_ 前缀两种写法都能命中依赖", () => {
    const project = makeProject();
    const byBare = plan({ project, changed: [{ type: "assetRef", id: "c1", revision: 1 }] });
    const byPrefixed = plan({ project, changed: [{ type: "assetRef", id: "aref_c1", revision: 1 }] });
    assert.deepEqual(byBare.staleShots.sort(), byPrefixed.staleShots.sort());
    assert.deepEqual(byBare.staleShots.sort(), ["sh_1", "sh_3"]);
});

test("plan：AssetRef 用 shotId 限定时，改该锚点命中被限定的镜头", () => {
    const project = {
        id: "prj_1",
        assetRefs: [{ id: "aref_c9", role: "character", bindingId: "c9", shotId: "sh_9", artifactIds: ["a9"], selectedArtifactId: "a9" }],
        episodes: [{ id: "ep_0001", scenes: [{ id: "sc_0001" }], shots: [{ id: "sh_9", sceneId: "sc_0001", status: "done" }, { id: "sh_8", sceneId: "sc_0001", status: "done" }] }],
    };
    const result = plan({ project, changed: [{ type: "assetRef", id: "aref_c9", revision: 3 }] });
    assert.deepEqual(result.staleShots, ["sh_9"]);
    assert.deepEqual(result.keep, ["sh_8"]);
});

test("plan：场景类资产变更 → 场与其镜头一并 stale", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "assetRef", id: "aref_loc", revision: 2 }] });
    assert.deepEqual(result.staleScenes, ["sc_0001"]);
    assert.deepEqual(result.staleShots.sort(), ["sh_1", "sh_2"]);
    assert.deepEqual(result.keep.sort(), ["sh_3", "sh_4"]);
});

/* ----------------------- plan：shotCamera 变更 ----------------------- */

test("plan：改某镜机位 → 只 stale 该镜（不含其它镜）", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "shotCamera", id: "sh_2", revision: 5 }] });

    assert.deepEqual(result.staleShots, ["sh_2"]);
    assert.deepEqual(result.keep.sort(), ["sh_1", "sh_3", "sh_4"]);
    // 该镜的成片与对白口型 Cue 一并失效
    assert.deepEqual(result.staleCues, ["cue_2"]);
    assert.deepEqual(result.staleDeliverables.sort(), ["d_clip2", "d_ep1"]);
    // 不重跑整部剧
    assert.deepEqual(result.staleEpisodes, []);
    assert.deepEqual(result.staleScenes, []);
});

test("plan：机位变更指向不存在的镜头 → 不误伤，记 warning", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "shotCamera", id: "sh_999", revision: 1 }] });
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.keep.sort(), ["sh_1", "sh_2", "sh_3", "sh_4"]);
    assert.equal(result.warnings.length, 1);
});

/* ------------------------ plan：分镜 / 剧本变更 ------------------------ */

test("plan：改某镜分镜 → 该镜及其下游 stale，其它镜保留", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "storyboard", id: "sh_3", revision: 4 }] });
    assert.deepEqual(result.staleShots, ["sh_3"]);
    assert.deepEqual(result.keep.sort(), ["sh_1", "sh_2", "sh_4"]);
    assert.deepEqual(result.staleDeliverables, ["d_ep1"]);
});

test("plan：改整场分镜 → 该场及其镜头 stale，另一场不受影响", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "storyboard", id: "sc_0001", revision: 4 }] });
    assert.deepEqual(result.staleScenes, ["sc_0001"]);
    assert.deepEqual(result.staleShots.sort(), ["sh_1", "sh_2"]);
    assert.deepEqual(result.keep.sort(), ["sh_3", "sh_4"]);
});

test("plan：改剧本（根输入）→ 下游整体 stale", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "script", id: "script", revision: 12 }] });
    assert.deepEqual(result.staleShots.sort(), ["sh_1", "sh_2", "sh_3", "sh_4"]);
    assert.deepEqual(result.staleScenes.sort(), ["sc_0001", "sc_0002"]);
    assert.deepEqual(result.staleEpisodes, ["ep_0001"]);
    assert.deepEqual(result.staleCues.sort(), ["cue_1", "cue_2", "cue_3"]);
    assert.deepEqual(result.staleDeliverables.sort(), ["d_clip2", "d_ep1"]);
    assert.deepEqual(result.keep, []);
});

test("plan：changed 为空 → 无 stale，全部 keep", () => {
    const project = makeProject();
    const result = plan({ project, changed: [] });
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.keep.sort(), ["sh_1", "sh_2", "sh_3", "sh_4"]);
    assert.deepEqual(result.reasons, {});
    assert.deepEqual(result.warnings, []);
});

test("plan：stale 是跨类别并集（镜优先），且不重复", () => {
    const project = makeProject();
    const result = plan({ project, changed: [{ type: "assetRef", id: "aref_c1", revision: 2 }] });
    assert.deepEqual(result.stale, [...result.staleShots, ...result.staleScenes, ...result.staleEpisodes, ...result.staleCues, ...result.staleDeliverables]);
    assert.equal(new Set(result.stale).size, result.stale.length);
});

/* --------------------------- isReusable --------------------------- */

test("isReusable：输入指纹全同 + done + 有选用产物 → true", () => {
    const input = { toolId: "video.external.v1", toolParams: { lens: "50mm" }, scriptRevision: "src_9" };
    const output = { inputFingerprint: fingerprint(input), status: "done", selectedArtifactId: "art_1" };
    assert.equal(isReusable(output, input), true);
});

test("isReusable：指纹差一位 → false", () => {
    const input = { toolId: "t", scriptRevision: "src_9" };
    const correct = fingerprint(input);
    const flipped = correct.slice(0, -1) + (correct.endsWith("0") ? "1" : "0");
    assert.notEqual(flipped, correct);
    const output = { inputFingerprint: flipped, status: "done", selectedArtifactId: "art_1" };
    assert.equal(isReusable(output, input), false);
});

test("isReusable：未完成 / 未选用产物 / 工具参数变化 → false", () => {
    const input = { toolParams: { lens: "50mm" } };
    assert.equal(isReusable({ inputFingerprint: fingerprint(input), status: "running", selectedArtifactId: "art_1" }, input), false);
    assert.equal(isReusable({ inputFingerprint: fingerprint(input), status: "done", selectedArtifactId: null }, input), false);
    assert.equal(isReusable({ inputFingerprint: fingerprint(input), status: "done" }, input), false);
    // Tool 参数变化（改机位）→ 输入指纹变化 → 不可复用
    assert.equal(isReusable({ inputFingerprint: fingerprint(input), status: "done", selectedArtifactId: "art_1" }, { toolParams: { lens: "85mm" } }), false);
    assert.equal(isReusable(null, input), false);
});

/* --------------------------- markStale --------------------------- */

test("markStale：不改原对象（深冻结也安全），返回新对象", () => {
    const project = makeProject();
    const snapshot = JSON.stringify(project);
    deepFreeze(project);

    const next = markStale(project, ["c1"]); // 传 bindingId

    assert.notStrictEqual(next, project);
    assert.equal(JSON.stringify(project), snapshot, "原对象必须未被污染");
    // 只改必要层级：未受影响的镜头保持同一引用
    const origShot2 = project.episodes[0].shots.find((shot) => shot.id === "sh_2");
    const nextShot2 = next.episodes[0].shots.find((shot) => shot.id === "sh_2");
    assert.strictEqual(nextShot2, origShot2, "未受影响的对象复用原引用");
});

test("markStale：把依赖 changedIds 的 assetRef 与镜头标 stale，其它保持原状态", () => {
    const project = makeProject();
    const next = markStale(project, ["c1"]);

    assert.equal(next.assetRefs.find((ref) => ref.id === "aref_c1").status, "stale");
    assert.equal(next.assetRefs.find((ref) => ref.id === "aref_c2").status, "done");
    assert.equal(next.episodes[0].shots.find((shot) => shot.id === "sh_1").status, "stale");
    assert.equal(next.episodes[0].shots.find((shot) => shot.id === "sh_3").status, "stale");
    assert.equal(next.episodes[0].shots.find((shot) => shot.id === "sh_2").status, "done");
    assert.equal(next.episodes[0].shots.find((shot) => shot.id === "sh_4").status, "done");
    // 原对象未被改动
    assert.equal(project.assetRefs.find((ref) => ref.id === "aref_c1").status, "done");
    assert.equal(project.episodes[0].shots.find((shot) => shot.id === "sh_1").status, "done");
});

test("markStale：接受对象 id（changed[] 形状），并级联 Cue/成片", () => {
    const project = makeProject();
    const next = markStale(project, [{ type: "shotCamera", id: "sh_2", revision: 3 }]);
    assert.equal(next.episodes[0].shots.find((shot) => shot.id === "sh_2").status, "stale");
    assert.equal(next.episodes[0].shots.find((shot) => shot.id === "sh_1").status, "done");
    assert.equal(next.cues.find((cue) => cue.id === "cue_2").status, "stale");
    assert.equal(next.cues.find((cue) => cue.id === "cue_1").status, "approved");
    assert.equal(next.deliverables.find((deliverable) => deliverable.id === "d_clip2").status, "stale");
    assert.equal(next.deliverables.find((deliverable) => deliverable.id === "d_ep1").status, "stale", "含被标 stale 镜头的成片一并 stale");
});

test("markStale：无命中时返回等值新对象，且不改动任何子对象引用", () => {
    const project = makeProject();
    const next = markStale(project, ["nobody"]);
    assert.notStrictEqual(next, project);
    assert.strictEqual(next.episodes, project.episodes);
    assert.strictEqual(next.assetRefs, project.assetRefs);
    assert.deepEqual(JSON.parse(JSON.stringify(next)), JSON.parse(JSON.stringify(project)));
});

/* --------------------------- shotDependsOn --------------------------- */

test("shotDependsOn：命中绑定锚点或镜头 id，未命中返回 false", () => {
    const assetRefs = [{ id: "aref_c1", role: "character", bindingId: "c1" }];
    assert.equal(shotDependsOn({ id: "sh_1", characterIds: ["c1"] }, ["c1"], assetRefs), true);
    assert.equal(shotDependsOn({ id: "sh_1", storyboard: { characters: ["c1"] } }, ["aref_c1"], assetRefs), true);
    assert.equal(shotDependsOn({ id: "sh_1", characterIds: ["c2"] }, ["c1"], assetRefs), false);
    assert.equal(shotDependsOn({ id: "sh_7", characterIds: ["c2"] }, ["sh_7"], assetRefs), true, "镜头自身 id 命中");
});

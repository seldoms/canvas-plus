import assert from "node:assert/strict";
import { test } from "node:test";

import {
    buildShotBinding,
    missingRefsReport,
    resolveSelectedArtifacts,
    stableSeed,
} from "../src/reference-lock.js";

/**
 * 参考图锁定纯逻辑模块单测（development-plan §11.5.4 / §12 第 2 优先级）。
 * 全部用普通对象构造 design / storyboard / assetRefs，不接存储、不起服务。
 */

/** 03 服化道产物：characters[].id / locations[].id 即 AssetRef.bindingId 的锚点。 */
function makeDesign() {
    return {
        characters: [
            { id: "c1", name: "林晚", props: ["旧皮包"] },
            { id: "c2", name: "陈默", props: [] },
        ],
        locations: [{ id: "loc1", name: "老宅" }],
        props: [{ id: "prop_phone_01", name: "旧手机" }],
    };
}

/** 02 分镜产物 + 供 sceneId → 地点 映射的 scenes（scene.location 是地点名）。 */
function makeStoryboard() {
    return {
        shots: [
            { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋", dialogue: "你终于来了。", prompt: "LIN WAN walks in" },
            { id: "sh_2", sceneId: "sc1", action: "陈默沉默", dialogue: "", prompt: "CHEN MO silent" },
        ],
        scenes: [
            { id: "sc1", locationId: "", location: "老宅" },
            { id: "sc2", locationId: "loc1", location: "" },
        ],
    };
}

/** 项目资产引用：bindingId 是引用自身字段（不是 metadata.bindingId）。 */
function makeAssetRefs() {
    return [
        { id: "as_c1", role: "character", bindingId: "c1", artifactIds: ["art_c1_a", "art_c1_b"], selectedArtifactId: "art_c1_a", revision: 3, metadata: { name: "林晚" } },
        { id: "as_c2", role: "character", bindingId: "c2", artifactIds: ["art_c2"], selectedArtifactId: "art_c2", revision: 1, metadata: { name: "陈默" } },
        { id: "as_loc1", role: "scene", bindingId: "loc1", artifactIds: ["art_loc1"], selectedArtifactId: "art_loc1", revision: 2, metadata: { name: "老宅" } },
        { id: "as_prop_phone", role: "prop", bindingId: "prop_phone_01", artifactIds: ["art_prop_phone"], selectedArtifactId: "art_prop_phone", revision: 1, metadata: {} },
    ];
}

function makeArtifacts() {
    return [
        { id: "art_c1_a", url: "/media/c1_front.png" },
        { id: "art_c1_b", url: "/media/c1_side.png" },
        { id: "art_c2", url: "/media/c2_front.png" },
        { id: "art_loc1", url: "/media/loc1_master.png" },
        { id: "art_prop_phone", url: "/media/prop_phone.png" },
    ];
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

/* --------------------------- buildShotBinding --------------------------- */

test("buildShotBinding：从镜头自由文本按角色名映射出 characterIds（不依赖不存在的字段）", () => {
    const shot = { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋", dialogue: "你终于来了。", prompt: "LIN WAN walks in" };
    const binding = buildShotBinding({ shot, design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.equal(binding.shotId, "sh_1");
    assert.deepEqual(binding.characterIds, ["c1"]); // 「林晚」→ c1，而不是把名字/描述当 id
});

test("buildShotBinding：显式 characterIds 保留，文本角色补其后，顺序稳定且去重", () => {
    const shot = { id: "sh_9", sceneId: "sc1", characterIds: ["c2"], action: "林晚把旧手机放在桌上" };
    const binding = buildShotBinding({ shot, design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.deepEqual(binding.characterIds, ["c2", "c1"]); // 显式优先 → 文本回填
});

test("buildShotBinding：sceneId → scene.location 名称映射到 design 地点锚点 id", () => {
    const shot = { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋" };
    const binding = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.equal(binding.locationId, "loc1"); // 「老宅」→ loc1
});

test("buildShotBinding：locationId 已是锚点 id 时直接命中", () => {
    const shot = { id: "sh_2", sceneId: "sc2" };
    const binding = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.equal(binding.locationId, "loc1");
});

test("buildShotBinding：道具按 design 名字映射到 prop id", () => {
    const shot = { id: "sh_3", sceneId: "sc1", props: ["旧手机"] };
    const binding = buildShotBinding({ shot, design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.deepEqual(binding.propIds, ["prop_phone_01"]);
});

test("buildShotBinding：assetRevision 从 assetRefs.revision 取，缺失锚点记 0", () => {
    const shot = { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋", props: ["旧手机"] };
    const binding = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.deepEqual(binding.assetRevision, { c1: 3, loc1: 2, prop_phone_01: 1 });
    const noRefs = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: [] });
    assert.equal(noRefs.assetRevision.c1, 0);
});

test("buildShotBinding：空镜头 / 无 design 时不抛错，稳定返回空结构", () => {
    const binding = buildShotBinding({});
    assert.deepEqual(binding, { shotId: "", characterIds: [], locationId: null, propIds: [], assetRevision: {} });
    const noDesign = buildShotBinding({ shot: { id: "sh_x", sceneId: "sc1", characterIds: ["c1"] } });
    assert.deepEqual(noDesign.characterIds, ["c1"]); // 显式 id 无 design 也保留
});

test("buildShotBinding：同输入结果稳定；design 字段顺序不影响", () => {
    const shot = { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋", props: ["旧手机"] };
    const a = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: makeAssetRefs() });
    const b = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: makeAssetRefs() });
    assert.deepEqual(a, b);
    const reordered = { props: makeDesign().props, locations: makeDesign().locations, characters: makeDesign().characters };
    const c = buildShotBinding({ shot, storyboard: makeStoryboard(), design: reordered, assetRefs: makeAssetRefs() });
    assert.deepEqual(c, a);
});

/* ----------------------- resolveSelectedArtifacts ----------------------- */

test("resolveSelectedArtifacts：按 ShotBinding 解析出角色 / 场景 / 道具的可选参考图 url", () => {
    const shot = { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋", props: ["旧手机"] };
    const shotBinding = buildShotBinding({ shot, storyboard: makeStoryboard(), design: makeDesign(), assetRefs: makeAssetRefs() });
    const refs = resolveSelectedArtifacts({ shotBinding, assetRefs: makeAssetRefs(), artifacts: makeArtifacts() });
    assert.equal(refs.complete, true);
    assert.deepEqual(refs.missing, []);
    assert.equal(refs.character.length, 1);
    assert.equal(refs.character[0].bindingId, "c1");
    assert.equal(refs.character[0].artifactId, "art_c1_a"); // selectedArtifactId 而非 artifactIds[1]
    assert.equal(refs.character[0].url, "/media/c1_front.png");
    assert.equal(refs.scene[0].url, "/media/loc1_master.png");
    assert.equal(refs.prop[0].url, "/media/prop_phone.png");
});

test("resolveSelectedArtifacts：bindingId 取引用自身字段，metadata.bindingId 干扰项不生效", () => {
    const shotBinding = { characterIds: ["c1"], locationId: null, propIds: [] };
    const assetRefs = [
        // 干扰项：metadata.bindingId 命中 c1，但引用自身 bindingId 是 cX —— 不得被选中。
        { id: "as_decoy", role: "character", bindingId: "cX", metadata: { bindingId: "c1" }, artifactIds: ["art_decoy"], selectedArtifactId: "art_decoy" },
        { id: "as_c1", role: "character", bindingId: "c1", metadata: { bindingId: "zzz" }, artifactIds: ["art_c1"], selectedArtifactId: "art_c1" },
    ];
    const artifacts = [
        { id: "art_decoy", url: "/media/decoy.png" },
        { id: "art_c1", url: "/media/real_c1.png" },
    ];
    const refs = resolveSelectedArtifacts({ shotBinding, assetRefs, artifacts });
    assert.equal(refs.character.length, 1);
    assert.equal(refs.character[0].assetRefId, "as_c1");
    assert.equal(refs.character[0].url, "/media/real_c1.png");

    // 仅 metadata.bindingId 命中、引用自身 bindingId 不命中 → 视为没有引用，显式报告 no-ref。
    const onlyMeta = [{ id: "as_m", role: "character", bindingId: "other", metadata: { bindingId: "c1" }, artifactIds: ["art_m"], selectedArtifactId: "art_m" }];
    const missing = resolveSelectedArtifacts({ shotBinding, assetRefs: onlyMeta, artifacts });
    assert.deepEqual(missing.character, []);
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.missing, [{ role: "character", bindingId: "c1", reason: "no-ref" }]);
});

test("resolveSelectedArtifacts：缺参考图显式报告（no-ref / no-selected / artifact-not-found）", () => {
    const shotBinding = { characterIds: ["c1", "c2"], locationId: "loc1", propIds: ["prop_phone_01"] };
    const assetRefs = [
        { id: "as_c1", role: "character", bindingId: "c1", artifactIds: ["art_c1"], selectedArtifactId: "art_c1" },
        { id: "as_c2", role: "character", bindingId: "c2", artifactIds: ["art_c2"], selectedArtifactId: null }, // 没选定
        { id: "as_loc1", role: "scene", bindingId: "loc1", artifactIds: ["art_loc1"], selectedArtifactId: "art_missing" }, // artifact 不存在
    ];
    const artifacts = [{ id: "art_c1", url: "/media/c1.png" }, { id: "art_c2", url: "/media/c2.png" }, { id: "art_loc1", url: "/media/loc1.png" }];
    const refs = resolveSelectedArtifacts({ shotBinding, assetRefs, artifacts });
    assert.equal(refs.complete, false);
    assert.equal(refs.character.length, 1);
    assert.deepEqual(
        refs.missing.map((item) => [item.role, item.bindingId, item.reason]),
        [
            ["character", "c2", "no-selected"],
            ["scene", "loc1", "artifact-not-found"],
            ["prop", "prop_phone_01", "no-ref"],
        ],
    );
});

test("resolveSelectedArtifacts：同一角色在多镜都解析到同一 artifact（跨镜身份锁定）", () => {
    const design = makeDesign();
    const assetRefs = makeAssetRefs();
    const artifacts = makeArtifacts();
    const shotA = { id: "sh_1", sceneId: "sc1", action: "林晚推门进屋" };
    const shotB = { id: "sh_7", sceneId: "sc2", action: "林晚回头", prompt: "close-up on LIN WAN" };
    const bindA = buildShotBinding({ shot: shotA, storyboard: makeStoryboard(), design, assetRefs });
    const bindB = buildShotBinding({ shot: shotB, storyboard: makeStoryboard(), design, assetRefs });
    const refsA = resolveSelectedArtifacts({ shotBinding: bindA, assetRefs, artifacts });
    const refsB = resolveSelectedArtifacts({ shotBinding: bindB, assetRefs, artifacts });
    assert.deepEqual(bindA.characterIds, ["c1"]);
    assert.deepEqual(bindB.characterIds, ["c1"]);
    assert.equal(refsA.character[0].url, refsB.character[0].url); // 同角色 → 同参考图
    assert.equal(refsA.character[0].artifactId, "art_c1_a");
});

test("resolveSelectedArtifacts：未传 artifacts 时不误报 not-found，url 记 null", () => {
    const shotBinding = { characterIds: ["c1"], locationId: null, propIds: [] };
    const refs = resolveSelectedArtifacts({ shotBinding, assetRefs: makeAssetRefs() });
    assert.equal(refs.complete, true);
    assert.equal(refs.character[0].url, null);
    assert.equal(refs.character[0].artifactId, "art_c1_a");
});

/* ------------------------------ stableSeed ------------------------------ */

test("stableSeed：同输入同值、返回 32 位无符号整数", () => {
    const rev = { c1: 3, loc1: 2 };
    const a = stableSeed("prj_1", "sh_1", rev);
    const b = stableSeed("prj_1", "sh_1", { loc1: 2, c1: 3 }); // 字段顺序无关
    assert.equal(a, b);
    assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
});

test("stableSeed：assetRevision / projectId / shotId 任一变化则 seed 变", () => {
    const base = stableSeed("prj_1", "sh_1", { c1: 3 });
    assert.notEqual(base, stableSeed("prj_1", "sh_1", { c1: 4 })); // 三视图 revision 变了
    assert.notEqual(base, stableSeed("prj_1", "sh_1", { c1: 3, loc1: 2 }));
    assert.notEqual(base, stableSeed("prj_2", "sh_1", { c1: 3 }));
    assert.notEqual(base, stableSeed("prj_1", "sh_2", { c1: 3 }));
});

/* --------------------------- missingRefsReport --------------------------- */

test("missingRefsReport：no-ref / no-candidate → blocked，not-selected → warning", () => {
    const shotBinding = { characterIds: ["c1", "c2", "c3"], locationId: "loc1", propIds: [] };
    const assetRefs = [
        { id: "as_c1", role: "character", bindingId: "c1", artifactIds: ["art_c1"], selectedArtifactId: "art_c1" }, // ok
        { id: "as_c2", role: "character", bindingId: "c2", artifactIds: ["art_c2"], selectedArtifactId: null }, // warning
        { id: "as_loc1", role: "scene", bindingId: "loc1", artifactIds: [], selectedArtifactId: null }, // blocked
    ];
    const report = missingRefsReport({ shotBinding, assetRefs });
    assert.equal(report.complete, false);
    assert.deepEqual(
        report.blocked.map((item) => [item.role, item.bindingId, item.reason]),
        [
            ["character", "c3", "no-ref"],
            ["scene", "loc1", "no-candidate"],
        ],
    );
    assert.deepEqual(
        report.warning.map((item) => [item.role, item.bindingId, item.reason]),
        [["character", "c2", "not-selected"]],
    );
    assert.equal(report.missing.length, 3);
});

test("missingRefsReport：全部已选定参考图 → complete", () => {
    const shotBinding = { characterIds: ["c1"], locationId: "loc1", propIds: ["prop_phone_01"] };
    const report = missingRefsReport({ shotBinding, assetRefs: makeAssetRefs() });
    assert.deepEqual(report, { complete: true, blocked: [], warning: [], missing: [] });
});

test("reference-lock：不修改传入对象（纯函数，可安全传冻结数据）", () => {
    const design = deepFreeze(makeDesign());
    const storyboard = deepFreeze(makeStoryboard());
    const assetRefs = deepFreeze(makeAssetRefs());
    const artifacts = deepFreeze(makeArtifacts());
    const shot = deepFreeze({ id: "sh_1", sceneId: "sc1", action: "林晚推门进屋", props: ["旧手机"] });
    const binding = buildShotBinding({ shot, storyboard, design, assetRefs });
    const refs = resolveSelectedArtifacts({ shotBinding: binding, assetRefs, artifacts });
    assert.equal(refs.complete, true);
    assert.equal(stableSeed("prj_1", shot.id, binding.assetRevision) >= 0, true);
});

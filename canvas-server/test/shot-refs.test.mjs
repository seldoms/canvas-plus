/**
 * 镜头参考清单（refs）：把隐式推导变成可见清单。
 *
 * 走真实生产代码：`buildShotBinding`（reference-lock）+ `composeShotRefs`（shot-refs）。
 * 只造最小 fixture，不复制推导逻辑进测试 —— 复制了就等于测了个假的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildShotBinding } from "../src/reference-lock.js";
import { buildShotRefs, composeShotRefs, describeShotRefs, numberShotRefs, refsGaps } from "../src/shot-refs.js";

/* 形状照 03 服化道真实产物（characters/locations/props），不是想当然的字段名。 */
const DESIGN = {
    characters: [
        { id: "c_ling", name: "林灵" },
        { id: "c_mother", name: "母亲" },
    ],
    locations: [{ id: "sc_stop", name: "老城南路公交站" }],
    props: [{ id: "pr_ticket", name: "末班车票" }],
};

/**
 * 场次表。**场次上必须带 locationId** 才归位得到地点锚点——
 * 真实契约（resolveLocationId）是按 shot.locationId / shot.location /
 * scene.locationId / scene.location 这几个候选逐个试，光有 sceneId 不够。
 */
const STORYBOARD = {
    scenes: [{ id: "sc_0001", sceneId: "sc_0001", locationId: "sc_stop" }],
};

/**
 * 一镜里同时出现角色名、场景名、道具名。
 *
 * ⚠️ 显式 token 的字段名照 reference-lock 的真实契约写（CHARACTER_FIELDS / PROP_FIELDS）：
 *   角色 = characterIds / characters / character / characterId / cast
 *   道具 = propIds / props / prop
 * 这**不是**想当然：角色有「角色名文本兜底」（名字在 action 里就能命中），
 * 但场景与道具**只认显式 token，不做文本匹配** —— 道具名容易撞车，猜错就是锁错脸/挂错图。
 * 早先按「文本里写了就该命中」写断言，生产代码是对的、测试是错的。
 */
const SHOT = {
    id: "sh_1",
    sceneId: "sc_0001",
    characterIds: ["c_ling", "c_mother"],
    propIds: ["pr_ticket"],
    action: "林灵攥着末班车票站在站牌下，母亲在身后唤她",
};

test("参考清单：从镜头文本推导出角色/场景/道具，并带上中文名", () => {
    const binding = buildShotBinding({ shot: SHOT, storyboard: STORYBOARD, design: DESIGN });
    const { refs } = composeShotRefs({ binding, design: DESIGN });

    const characters = refs.filter((ref) => ref.kind === "character").map((ref) => ref.bindingId);
    const scenes = refs.filter((ref) => ref.kind === "scene").map((ref) => ref.bindingId);
    const props = refs.filter((ref) => ref.kind === "prop").map((ref) => ref.bindingId);

    // 推导链是「角色名文本匹配」→ c_ling 与 c_mother 名字都在 action 里，都该命中。
    assert.ok(characters.includes("c_ling"), "角色名「林灵」在镜头文本里，应推导出绑定 id");
    assert.ok(characters.includes("c_mother"), "角色名「母亲」也在文本里，不该只认第一个");
    assert.deepEqual(scenes, ["sc_stop"], "场景由 sceneId 归位到服化道地点锚点");
    assert.deepEqual(props, ["pr_ticket"], "道具名「末班车票」应命中道具锚点");

    const ling = refs.find((ref) => ref.bindingId === "c_ling");
    assert.equal(ling.label, "林灵", "要显示中文名，不是裸 id —— 给人看的东西要给名字");
    assert.equal(ling.role, "形象", "角色在本镜里的用法是「形象」");
});

test("参考清单：编号只在渲染期生成，不落库（顺序变编号就得变）", () => {
    const binding = buildShotBinding({ shot: SHOT, storyboard: STORYBOARD, design: DESIGN });
    const { refs } = composeShotRefs({ binding, design: DESIGN });

    assert.ok(refs.length >= 3, "本镜至少有角色、场景、道具三类参考");
    // 编号连续且从 1 开始 —— 这正是「@image#1 / #2 / #3」那种写法。
    assert.deepEqual(
        refs.map((ref) => ref.index),
        refs.map((_, i) => i + 1),
        "编号按顺序连续",
    );
    assert.equal(refs[0].tag, "@image#1", "首项是 @image#1");
    // stableKey 与顺序无关，供 React key 与去重用。
    assert.equal(refs[0].stableKey, "character:c_ling");

    // 顺序换了编号必须跟着换 —— 这正是不落库的理由。
    // 倒序后每一项都重新按**新位置**编号：原本最后那项现在排第一就该拿 @image#1。
    const reversed = numberShotRefs([...refs].reverse());
    assert.equal(reversed[0].tag, "@image#1", "倒序后新的第一项拿到 @image#1");
    assert.equal(reversed[0].bindingId, refs[refs.length - 1].bindingId, "确认它就是原本最后那项");
    assert.equal(reversed[reversed.length - 1].tag, "@image#4", "原本第一项现在排最后，编号跟着变");
    // stableKey 与顺序无关 —— 这是给 React key / 去重用的，编号变了它不能变。
    assert.deepEqual(
        reversed.map((ref) => ref.stableKey).sort(),
        refs.map((ref) => ref.stableKey).sort(),
        "stableKey 不受顺序影响",
    );
});

test("参考清单：角色名文本兜底命中，但场景/道具只认显式 token（撞车不猜）", () => {
    // 这条锁的是 reference-lock 的**真实契约**，不是我的期望：
    // 角色名在 action 里出现 → 能推导出绑定 id（分镜阶段常常不写 characterIds）。
    const byName = buildShotBinding({
        shot: { id: "sh_n", action: "母亲在门口站着" },
        storyboard: STORYBOARD,
        design: DESIGN,
    });
    assert.deepEqual(byName.characterIds, ["c_mother"], "只有「母亲」在文本里，不该把林灵也拖进来");

    // 道具名在文本里**不**命中：模型名/道具名撞车太常见，猜错等于挂错图。
    const propByTextOnly = buildShotBinding({
        shot: { id: "sh_n2", action: "桌上放着末班车票" },
        storyboard: STORYBOARD,
        design: DESIGN,
    });
    assert.deepEqual(propByTextOnly.propIds, [], "道具不做文本兜底：宁可没有，也不挂错");
});

test("参考清单：音色与形象分成两条（两者是不同参考，不是同一条）", () => {
    const design = {
        characters: [{ id: "c_ling", name: "林灵", voiceProfileId: "vp_female_warm" }],
        locations: [],
        props: [],
    };
    const binding = buildShotBinding({
        shot: { id: "sh_1", action: "林灵开口" },
        storyboard: STORYBOARD,
        design,
    });
    const { refs } = composeShotRefs({ binding, design });
    const forLing = refs.filter((ref) => ref.bindingId === "c_ling");
    assert.deepEqual(
        forLing.map((ref) => ref.kind).sort(),
        ["character", "voice"],
        "同一角色的形象与音色应是两条参考",
    );
    const voice = refs.find((ref) => ref.kind === "voice");
    assert.equal(voice.role, "音色");
    assert.equal(voice.label, "vp_female_warm", "没有中文名时如实回落到音色 id，不编名字");
});

test("参考清单：剧本声明了角色但本镜没引用到 → 如实报缺口，不静默", () => {
    const binding = buildShotBinding({ shot: SHOT, storyboard: STORYBOARD, design: DESIGN });
    const { gaps } = composeShotRefs({ binding, design: DESIGN, expectedCharacterIds: ["c_ling", "c_mother", "c_brother"] });
    assert.deepEqual(gaps, ["c_brother"], "只报真缺的那个（剧本有、本镜没引），不为已经引用的报缺口");
});

test("参考清单：空镜头返回空清单与空文案（不编「无参考」以外的任何东西）", () => {
    const binding = buildShotBinding({ shot: { id: "sh_x", action: "" }, storyboard: STORYBOARD, design: DESIGN });
    const { refs, summary, gaps } = composeShotRefs({ binding, design: DESIGN });
    assert.deepEqual(refs, [], "没引用就没有清单");
    assert.equal(summary, "", "空清单不给造一句话的文案");
    assert.deepEqual(gaps, [], "没给 expected 就不报缺口 —— 不知道该有什么，不猜");
});

test("参考清单：纯函数层的边界（空输入不炸、去重、空 bindingId 丢弃）", () => {
    assert.deepEqual(buildShotRefs(), [], "无 binding 返回空");
    assert.deepEqual(buildShotRefs({ characterIds: ["", null, undefined], locationId: "", propIds: [""] }), [], "空 id 一律丢弃，不产出半截条目");
    assert.deepEqual(numberShotRefs(), [], "无输入返回空");
    assert.deepEqual(numberShotRefs(null), [], "null 也返回空，不抛");
    assert.equal(describeShotRefs([]), "");

    // 重复 bindingId 只出一条（否则同一张脸会被列两遍，看起来像两张图）。
    const duplicated = buildShotRefs({ characterIds: ["c_ling", "c_ling"], locationId: null, propIds: [] });
    assert.equal(duplicated.length, 1, "同一 bindingId 不重复列出");

    assert.deepEqual(refsGaps(["a", "b"], ["a", "c"]), ["c"], "缺口= 期望里有、现有里没有");
    assert.deepEqual(refsGaps(null, ["a"]), ["a"], "现有为空时全部算缺口");
});

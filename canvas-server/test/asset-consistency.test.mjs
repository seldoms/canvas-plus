/**
 * 素材一致性体检的测试。
 *
 * **测试数据就是2026-10-06 真实项目「喜宴之外」踩过的坑**（我为了修复它们debug 了三轮）：
 *   - 场景 bindingId 写成「地点·时间」，而门禁按纯地点名匹配 → 报 no-ref；
 *   - 同一个角色同时以 `陈默` 与 `ch_001` 两种 key 登记 → 选定妆照随机命中；
 *   - design.locations 被清空 → locationId 推不出 → 整批镜头被挡。
 *
 * 这些不一致**单看每条数据都合法**，所以不报错、不告警，系统自己发现不了。
 * 体检工具的价值就在于把它们一次性摆出来。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAssetConsistency, summarizeConsistency } from "../src/asset-consistency.js";

/** 「喜宴之外」的镜头与人物表（精简到体检需要的字段）。 */
const REAL_SCENES = [
    { id: "sc_src_0001", title: "场景1 内景·陈默家客厅·日", location: "陈默家客厅", time: "日", interior: "内景" },
    { id: "sc_src_0002", title: "场景2 外景·山路·日", location: "山路", time: "日", interior: "外景" },
    { id: "sc_src_0003", title: "场景3 内景·陈默家客厅·夜", location: "陈默家客厅", time: "夜", interior: "内景" },
];

const REAL_LOCATIONS = [
    { id: "loc_001", name: "陈默家客厅", interior: "内景", times: ["日", "夜"] },
    { id: "loc_002", name: "山路", interior: "外景", times: ["日"] },
];

const REAL_CHARACTERS = [
    { id: "ch_001", name: "陈默" },
    { id: "ch_002", name: "林慧" },
];

test("真实坑①：场景 bindingId 带「·时间」后缀 →报 error（这正是 no-ref 的成因）", () => {
    const issues = checkAssetConsistency({
        assetRefs: [{ id: "ref_1", role: "scene", bindingId: "陈默家客厅·日", selectedArtifactId: "/api/a.png" }],
        scenes: REAL_SCENES,
        locations: REAL_LOCATIONS,
        shots: [],
        characters: REAL_CHARACTERS,
    });
    const mismatch = issues.find((issue) => issue.kind === "binding-mismatch");
    assert.ok(mismatch, "应报 binding-mismatch");
    assert.equal(mismatch.severity, "error");
    assert.match(mismatch.message, /陈默家客厅·日/);
    assert.match(mismatch.message, /纯地点名/);
});

test("真实坑②：同一角色两种 key（陈默 / ch_001）→ 报 warn（选图随机命中）", () => {
    const issues = checkAssetConsistency({
        assetRefs: [
            { id: "ref_c1", role: "character", bindingId: "陈默", selectedArtifactId: "/api/old.png" },
            { id: "ref_c2", role: "character", bindingId: "ch_001", selectedArtifactId: "/api/new.png" },
        ],
        scenes: [],
        locations: [],
        shots: [],
        characters: REAL_CHARACTERS,
    });
    const dup = issues.find((issue) => issue.kind === "duplicate-binding");
    assert.ok(dup, "应报 duplicate-binding");
    assert.equal(dup.severity, "warn");
    assert.match(dup.message, /陈默/);
    assert.match(dup.message, /ch_001/);
    assert.deepEqual(dup.refIds.sort(), ["ref_c1", "ref_c2"], "应指出是哪两条");
});

test("真实坑③：design.locations 被清空 → 镜头推不出地点、报 unresolved-binding", () => {
    const issues = checkAssetConsistency({
        assetRefs: [],
        scenes: REAL_SCENES,
        locations: [], // ← 被清空
        shots: [{ id: "sh_1", sceneId: "sc_src_0001", locationId: "陈默家客厅" }],
        characters: [],
    });
    const unresolved = issues.find((issue) => issue.kind === "unresolved-binding");
    assert.ok(unresolved, "应报 unresolved-binding");
    assert.equal(unresolved.severity, "error");
    assert.deepEqual(unresolved.shotIds, ["sh_1"], "应指出受影响镜头");
});

test("真实坑④：locationId 被错切成「内景」（我解析剧本时切错一位的产物）→ 归到 unresolved", () => {
    const issues = checkAssetConsistency({
        assetRefs: [{ id: "ref_1", role: "scene", bindingId: "陈默家客厅", selectedArtifactId: "/a.png" }],
        scenes: REAL_SCENES,
        locations: REAL_LOCATIONS,
        shots: [{ id: "sh_1", sceneId: "sc_src_0001", locationId: "内景" }],
        characters: [],
    });
    // locationId 是「内景」这种泛值时不该报「没有资产引用」——它本身就不该是地点名，
    // 报出来会误导（真实情况是脚本字段切错了，不是缺引用）。
    assert.equal(issues.filter((issue) => issue.kind === "unresolved-binding").length, 0);
});

test("真实坑⑤：场景改名后旧引用没清理 → 报 orphan-ref", () => {
    const issues = checkAssetConsistency({
        assetRefs: [{ id: "ref_1", role: "scene", bindingId: "小饭馆·日" }],
        scenes: REAL_SCENES,
        locations: REAL_LOCATIONS,
        shots: [],
        characters: [],
    });
    const orphan = issues.find((issue) => issue.kind === "orphan-ref");
    assert.ok(orphan, "应报 orphan-ref");
    assert.equal(orphan.severity, "warn");
});

test("同 role + bindingId 完全重复登记两条 → 也是 duplicate-binding", () => {
    const issues = checkAssetConsistency({
        assetRefs: [
            { id: "ref_a", role: "scene", bindingId: "山路", selectedArtifactId: "/a.png" },
            { id: "ref_b", role: "scene", bindingId: "山路", selectedArtifactId: "/b.png" },
        ],
        scenes: REAL_SCENES,
        locations: REAL_LOCATIONS,
        shots: [],
        characters: [],
    });
    assert.equal(issues.filter((issue) => issue.kind === "duplicate-binding").length, 1);
});

test("口径一致时零问题（别制造噪音）", () => {
    const issues = checkAssetConsistency({
        assetRefs: [
            { id: "ref_1", role: "scene", bindingId: "陈默家客厅", selectedArtifactId: "/a.png" },
            { id: "ref_2", role: "character", bindingId: "ch_001", selectedArtifactId: "/b.png" },
        ],
        scenes: REAL_SCENES,
        locations: REAL_LOCATIONS,
        shots: [{ id: "sh_1", sceneId: "sc_src_0001", locationId: "陈默家客厅" }],
        characters: REAL_CHARACTERS,
    });
    assert.deepEqual(issues, [], `不该有问题，实际：${JSON.stringify(issues)}`);
    assert.equal(summarizeConsistency(issues).ok, true);
});

test("排序稳定：error 在前，且两次运行结果一致（界面不能每次刷新乱跳）", () => {
    const input = {
        assetRefs: [
            { id: "ref_c1", role: "character", bindingId: "陈默" },
            { id: "ref_c2", role: "character", bindingId: "ch_001" },
            { id: "ref_1", role: "scene", bindingId: "陈默家客厅·日" },
        ],
        scenes: REAL_SCENES,
        locations: REAL_LOCATIONS,
        shots: [],
        characters: REAL_CHARACTERS,
    };
    const first = checkAssetConsistency(input);
    const second = checkAssetConsistency(input);
    assert.deepEqual(first.map((i) => i.kind), second.map((i) => i.kind));
    assert.equal(first[0].severity, "error", "error 应排最前");
});

test("摘要：一句话说清错与警的个数", () => {
    assert.equal(summarizeConsistency([]).text, "素材口径一致，无问题。");
    const issues = [
        { severity: "error", kind: "binding-mismatch", message: "", refIds: [], shotIds: [] },
        { severity: "warn", kind: "duplicate-binding", message: "", refIds: [], shotIds: [] },
        { severity: "warn", kind: "orphan-ref", message: "", refIds: [], shotIds: [] },
    ];
    const summary = summarizeConsistency(issues);
    assert.equal(summary.errors, 1);
    assert.equal(summary.warnings, 2);
    assert.equal(summary.ok, false);
    assert.match(summary.text, /1 个/);
});

test("空输入不炸（阶段还没产物时界面也会调它）", () => {
    const issues = checkAssetConsistency({ assetRefs: [], scenes: [], locations: [], shots: [], characters: [] });
    assert.deepEqual(issues, []);
});

test("缺字段的脏数据不炸（undefined 数组也该兜住）", () => {
    assert.doesNotThrow(() => checkAssetConsistency({}));
    assert.doesNotThrow(() => checkAssetConsistency({ assetRefs: undefined, scenes: [{}], locations: [{}], shots: [{}], characters: [{}] }));
});
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BIBLE_KIND, BIBLE_KIND_STAGE, createBibleStore, isBibleKind } from "../src/bible.js";
import { createProjects } from "../src/projects.js";
import { deriveGates } from "../src/gates.js";

/**
 * P0-f 接线单测：把已交付的 bible.js 接进项目存储 + 门禁。
 * 覆盖：① 未批准 → 阶段被阻且原因可读；② 已批准/已锁 → 放行；③ 项目无该实体 → 不阻断（向后兼容）；
 *       ④ 改已锁实体产生新 revision 且原对象不变；⑤ kind→阶段映射、幂等更新、非法迁移原因可读。
 * HTTP 路由层见 bible-wiring-http.test.mjs。
 */

const gateById = (gates) => Object.fromEntries(gates.map((gate) => [gate.stageId, gate]));

// M0：gates.js 不再手写阶段数组，门禁派生需注入 stages（形状同 registry.json 的 stages）；
// 本套件只关心 bible 映射到的 plan / script / design / post，注入最小两段即可。
const STAGES = [
    { id: "script", title: "剧本", requires: [] },
    { id: "design", title: "服化道", requires: ["script"] },
];

function setup() {
    const root = mkdtempSync(join(tmpdir(), "canvas-bible-wiring-"));
    const projects = createProjects({ dataDir: root });
    const store = createBibleStore({ dataDir: root, ulid: projects.ulid });
    const project = projects.create({ title: "圣经接线" });
    return { root, projects, store, project };
}

const gatesFor = (projects, store, project) => deriveGates({ project: projects.get(project.id), episodes: [], bibles: store.list(project.id), stages: STAGES });

test("接线①：存在未批准的 SeriesBible → script 阶段被阻且 reason 可读", (t) => {
    const { root, projects, store, project } = setup();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const { bible } = store.create(project.id, { kind: "series", logline: "主线一条" });
    assert.equal(bible.status, "draft", "新建一律 draft");
    assert.equal(bible.revision, 1);

    const gates = gateById(gatesFor(projects, store, project));
    assert.equal(gates.script.ready, false, "存在未批准实体 → 对应阶段被阻");
    const blocker = gates.script.blockedBy.find((item) => item.type === "bible");
    assert.ok(blocker, "阻断项形状仍为对象数组，type=bible");
    assert.equal(blocker.stageId, "script");
    assert.equal(blocker.kind, "series");
    assert.equal(blocker.bibleId, bible.id);
    assert.equal(blocker.status, "draft");
    assert.match(gates.script.reason, /圣经未批准/);
    assert.match(gates.script.reason, /尚未批准/);
    // 未涉及其它类别时，其它阶段不被误伤
    assert.equal(gates.design.blockedBy.some((item) => item.type === "bible"), false);
    assert.equal(gates.plan.blockedBy.some((item) => item.type === "bible"), false);
});

test("接线②：approved / locked 后对应阶段放行", (t) => {
    const { root, projects, store, project } = setup();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const { bible } = store.create(project.id, { kind: "series", logline: "主线一条" });
    store.transition(project.id, bible.id, "submit_review");
    const approved = store.transition(project.id, bible.id, "approve").bible;
    assert.equal(approved.status, "approved");

    let gates = gateById(gatesFor(projects, store, project));
    assert.equal(gates.script.ready, true, "已批准 → 放行");
    assert.equal(gates.script.blockedBy.some((item) => item.type === "bible"), false);

    const locked = store.transition(project.id, bible.id, "lock").bible;
    assert.equal(locked.status, "locked");
    gates = gateById(gatesFor(projects, store, project));
    assert.equal(gates.script.ready, true, "已锁定 → 仍放行");
    assert.equal(gates.script.blockedBy.some((item) => item.type === "bible"), false);
});

test("接线③：项目无该圣经实体 → 不阻断，门禁与旧版逐字相同（向后兼容）", (t) => {
    const { root, projects, store, project } = setup();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const view = projects.get(project.id);
    const legacy = deriveGates({ project: view, episodes: [], stages: STAGES }); // 不传 bibles（P0-f 前的调用形态）
    const withEmpty = deriveGates({ project: view, episodes: [], bibles: [], stages: STAGES });
    const withRealList = gatesFor(projects, store, project); // store.list 返回 []

    assert.deepEqual(withEmpty, legacy, "传空 bibles 与旧签名逐字相同");
    assert.deepEqual(withRealList, legacy, "项目无实体时 store.list() 为空，不改变门禁");
    assert.equal(gateById(legacy).script.ready, true);
    assert.equal(legacy.some((gate) => gate.blockedBy.some((item) => item.type === "bible")), false);
});

test("接线④：改已锁实体产生新 revision，原对象不变（旧版本进 history）", (t) => {
    const { root, projects, store, project } = setup();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const { bible } = store.create(project.id, { kind: "world", name: "老屋", lightDirection: "顶光" });
    store.transition(project.id, bible.id, "submit_review");
    store.transition(project.id, bible.id, "approve");
    const locked = store.transition(project.id, bible.id, "lock").bible;
    assert.equal(locked.revision, 1);
    assert.equal(locked.status, "locked");

    const res = store.update(project.id, bible.id, { name: "新屋" });
    assert.equal(res.changed, true);
    assert.equal(res.requiresNewRevision, true, "改已锁 → 需要新 revision");
    assert.equal(res.bible.revision, 2, "产生新 revision");
    assert.equal(res.bible.status, "draft", "改动后回到 draft，需重新审批");
    assert.equal(res.bible.name, "新屋");
    assert.equal(res.bible.previousRevision, 1);

    const snapshot = res.bible.history.at(-1);
    assert.equal(snapshot.revision, 1, "旧 revision 快照保留");
    assert.equal(snapshot.status, "locked");
    assert.equal(snapshot.name, "老屋", "旧对象原内容未被静默覆盖");
    assert.equal(snapshot.lightDirection, "顶光");

    // 从盘上重读，history 仍在（持久化，不是内存假象）
    const reread = store.get(project.id, bible.id);
    assert.equal(reread.revision, 2);
    assert.equal(reread.status, "draft");
    assert.equal(reread.history.at(-1).name, "老屋");

    // 新 revision 未批准 → 门禁再次被阻
    const gates = gateById(gatesFor(projects, store, project));
    assert.equal(gates.design.ready, false, "world bible 对应 design，改动后回到未批准被阻");
});

test("接线⑤：kind→阶段映射齐全；draft 就地更新幂等、不涨 revision；非法迁移原因可读", (t) => {
    const { root, store, project } = setup();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    assert.deepEqual(BIBLE_KIND_STAGE, { project_brief: "plan", series: "script", character: "design", world: "design", audio: "post" });
    for (const kind of Object.values(BIBLE_KIND)) assert.equal(isBibleKind(kind), true);
    assert.equal(isBibleKind("nope"), false);

    const { bible } = store.create(project.id, { kind: "character", name: "阿珍" });
    const same = store.update(project.id, bible.id, { name: "阿珍" });
    assert.equal(same.changed, false, "同值 patch 幂等：不写盘");
    assert.equal(same.bible.revision, 1);

    const diff = store.update(project.id, bible.id, { name: "阿强" });
    assert.equal(diff.changed, true);
    assert.equal(diff.bible.revision, 1, "draft 就地合并，不产生新 revision");
    assert.equal(diff.bible.status, "draft");

    assert.throws(
        () => store.transition(project.id, bible.id, "lock"),
        (error) => error.status === 400 && /非法迁移/.test(error.message) && /submit_review/.test(error.message),
        "draft 直达 locked 应 400 且原因可读",
    );
    assert.throws(
        () => store.create(project.id, { kind: "unknown" }),
        (error) => error.status === 400 && /kind/.test(error.message),
        "非法类别应 400",
    );
});

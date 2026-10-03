import assert from "node:assert/strict";
import test from "node:test";

/**
 * Shot.id 稳定性（契约 §4）：reindex 只重排 index，增删调序绝不重写 id；
 * 旧数据里的 sh1..shN 编号 id 仍可读（只读兼容，不强制迁移）。
 *
 * 被测对象是画布插件 storyboard-studio 的纯逻辑
 * （plugins/canvas/storyboard-studio/src/storyboard.ts）——「reindex 重写 id」的缺陷就在那里。
 * 该插件没有自己的测试运行器；Node 24 原生支持 TS 类型擦除，因此由 canvas-server 的
 * node:test 门禁直接 import 插件源码，保持单一事实来源（不复制一份实现来测）。
 */
const { appendShot, ensureShotIds, insertShotAfter, moveShotBy, newShotId, parseStoryboard, readStoryboard, reindex, removeShotById } =
    await import("../../plugins/canvas/storyboard-studio/src/storyboard.ts");

/** 造一个最小可用镜头（只关心 id/index 的用例）。 */
const shot = (id, index) => ({ id, index, durationSec: 4, shotSize: "中景", camera: "", action: "", dialogue: "", audio: "", prompt: "x" });

test("reindex 只重排 index，绝不重写 id（缺陷回归）", () => {
    const before = [shot("sh_a", 9), shot("sh_b", 3), shot("sh_c", 7)];
    const after = reindex(before);
    assert.deepEqual(
        after.map((s) => s.id),
        ["sh_a", "sh_b", "sh_c"],
        "id 原样保留",
    );
    assert.deepEqual(
        after.map((s) => s.index),
        [1, 2, 3],
        "index 从 1 严格递增",
    );
    assert.deepEqual(
        before.map((s) => s.index),
        [9, 3, 7],
        "不改原数组",
    );
});

test("插入一镜后，其它镜 id 不变，只有 index 重排", () => {
    const before = [shot("sh_a", 1), shot("sh_b", 2), shot("sh_c", 3)];
    const after = insertShotAfter(before, "sh_a");

    assert.equal(after.length, 4);
    // 原三镜 id 一个不少，且相对次序不变
    assert.deepEqual(
        after.filter((s) => s.id !== after[1].id).map((s) => s.id),
        ["sh_a", "sh_b", "sh_c"],
        "其余镜 id 与次序不变",
    );
    // 新镜拿到 sh_ 前缀的新 id，且不是任何一个旧 id
    assert.match(after[1].id, /^sh_/);
    assert.ok(!["sh_a", "sh_b", "sh_c"].includes(after[1].id));
    // index 依旧连续
    assert.deepEqual(
        after.map((s) => s.index),
        [1, 2, 3, 4],
    );
});

test("删除一镜后，其它镜 id 不变，index 重排；删除的 id 不回收", () => {
    const before = [shot("sh_a", 1), shot("sh_b", 2), shot("sh_c", 3)];
    const after = removeShotById(before, "sh_b");

    assert.deepEqual(
        after.map((s) => s.id),
        ["sh_a", "sh_c"],
        "其余镜 id 不变",
    );
    assert.deepEqual(
        after.map((s) => s.index),
        [1, 2],
    );

    // 删除不回收：再插一镜，旧 id sh_b 不会被复用
    const again = insertShotAfter(after, "sh_a");
    assert.ok(!again.some((s) => s.id === "sh_b"), "已删除的 id 不得被回收复用");
});

test("排序后 id 不变、index 变化", () => {
    const before = [shot("sh_a", 1), shot("sh_b", 2), shot("sh_c", 3)];
    const after = moveShotBy(before, "sh_c", -1); // 上移最后一镜

    assert.deepEqual(
        after.map((s) => s.id),
        ["sh_a", "sh_c", "sh_b"],
        "次序变了",
    );
    assert.equal(after[1].id, "sh_c");
    assert.equal(after[1].index, 2, "index 随位置变化");
    assert.deepEqual(
        after.map((s) => s.index),
        [1, 2, 3],
    );
    assert.deepEqual(new Set(after.map((s) => s.id)), new Set(["sh_a", "sh_b", "sh_c"]), "id 集合不变");
});

test("旧数据兼容：已有 sh1..shN 编号 id 原样可读，不被迁移", () => {
    const board = readStoryboard({ shots: [{ id: "sh1", index: 1 }, { id: "sh2", index: 2 }] });
    assert.deepEqual(
        board.shots.map((s) => s.id),
        ["sh1", "sh2"],
        "旧编号 id 逐字保留",
    );

    const parsed = parseStoryboard(JSON.stringify({ shots: [{ id: "sh1", durationSec: 3, shotSize: "近景", camera: "推", action: "回头", prompt: "a girl" }] }));
    assert.equal(parsed.shots[0].id, "sh1", "解析旧 JSON 仍读出原 id");
    assert.equal(parsed.shots[0].index, 1);
});

test("只有缺失 id 的镜头才补新 id，已有 id 一律不动", () => {
    const rows = ensureShotIds([shot("", 1), shot("sh1", 2), shot("sh_a", 3)]);
    assert.match(rows[0].id, /^sh_/);
    assert.equal(rows[1].id, "sh1");
    assert.equal(rows[2].id, "sh_a");
    assert.notEqual(rows[0].id, rows[1].id);
    // 同一对象未变更 id 时保持原引用（不动已有数据）
    const plain = [shot("sh_a", 1)];
    assert.equal(ensureShotIds(plain)[0], plain[0]);
});

test("appendShot 追加新镜：老镜 id 不变，新镜带 sh_ 新 id", () => {
    const before = [shot("sh_a", 1)];
    const after = appendShot(before);
    assert.deepEqual(
        after.map((s) => s.id).slice(0, 1),
        ["sh_a"],
    );
    assert.match(after[1].id, /^sh_/);
    assert.deepEqual(
        after.map((s) => s.index),
        [1, 2],
    );
});

test("newShotId 生成 sh_ 前缀且互不相同（删除后不复用）", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newShotId()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^sh_[0-9a-zA-Z]+$/);
});

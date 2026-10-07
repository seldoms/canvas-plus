import { expect, test } from "bun:test";

import { buildAssetPacks, type PackEntry } from "../src/pages/projects/asset-ref-model";
import type { AssetRef } from "../src/types/domain";

/**
 * 资料包聚合（buildAssetPacks）的测试。
 *
 * 这个函数是「缺谁一目了然」的唯一依据，一旦主轴搞错（比如退回按引用条目分组），
 * 缺口就会重新隐形 —— 而缺口隐形正是 2026-10-06 素材出事时的真实形态。
 * 所以重点验证：**剧本里有、但没归入任何产物的实体，必须以 missing 状态出现**。
 */

/** 组一条 AssetRef，只写与用例相关的字段。 */
function ref(patch: Partial<AssetRef> & { bindingId: string; role: AssetRef["role"] }): AssetRef {
    return { id: `as_${patch.bindingId}`, artifactIds: [], selectedArtifactId: null, metadata: {}, ...patch } as AssetRef;
}

/** 只取某一类里的某个实体，省得每个用例都写 find 链。 */
function entryOf(packs: ReturnType<typeof buildAssetPacks>, role: string, bindingId: string): PackEntry {
    const pack = packs.find((item) => item.role === role)!;
    return pack.entries.find((item) => item.bindingId === bindingId)!;
}

const script = {
    characters: [
        { id: "c1", name: "阿海" },
        { id: "c2", name: "小满" },
    ],
    scenes: [{ id: "sc1", title: "夜航对话", location: "渡轮驾驶室" }],
};

test("剧本实体没有归入产物时必须显式列为 missing，不能凭空消失", () => {
    const packs = buildAssetPacks([], script);

    const characters = packs.find((pack) => pack.role === "character")!;
    expect(characters.expected).toBe(2);
    expect(characters.entries.map((item) => item.bindingId)).toEqual(["c1", "c2"]);
    expect(characters.missing).toBe(2);
    expect(characters.adopted).toBe(0);
    expect(characters.entries.every((item) => item.status === "missing")).toBe(true);
});

test("已采用产物的实体标记 adopted 并带上缩略图地址", () => {
    const packs = buildAssetPacks([ref({ role: "character", bindingId: "c1", artifactIds: ["/api/artifacts/j1/c1.png"], selectedArtifactId: "/api/artifacts/j1/c1.png" })], script);

    const entry = entryOf(packs, "character", "c1");
    expect(entry.status).toBe("adopted");
    expect(entry.url).toBe("/api/artifacts/j1/c1.png");
    // 另一个角色仍未归入 —— 部分完成不能被当成整体完成。
    expect(entryOf(packs, "character", "c2").status).toBe("missing");
});

test("有候选但没选定是 candidates 而非 adopted：选了才算锁定", () => {
    const packs = buildAssetPacks([ref({ role: "character", bindingId: "c1", artifactIds: ["a1", "a2"] })], script);

    const entry = entryOf(packs, "character", "c1");
    expect(entry.status).toBe("candidates");
    expect(entry.candidateCount).toBe(2);
    // 没有 selected 时缩略图退回第一张候选（渲染要能看到东西），但状态不能算已锁定。
    expect(entry.url).toBe("a1");
});

test("场景包的名称取 location（与门禁匹配口径一致），不是场次标题", () => {
    const packs = buildAssetPacks([ref({ role: "scene", bindingId: "sc1", artifactIds: ["a1"], selectedArtifactId: "a1" })], script);

    expect(entryOf(packs, "scene", "sc1").name).toBe("渡轮驾驶室");
});

test("归因信息（阶段 + job）并入来源字段，便于回查这张图哪来的", () => {
    const packs = buildAssetPacks([ref({ role: "character", bindingId: "c1", artifactIds: ["a1"], selectedArtifactId: "a1", metadata: { stageId: "casting", sourceJobId: "run-x" } })], script);

    const entry = entryOf(packs, "character", "c1");
    expect(entry.source).toContain("casting");
    expect(entry.source).toContain("run-x");
});

test("道具类剧本没有清单：只列已登记的引用，expected 不编造数字", () => {
    const packs = buildAssetPacks([ref({ role: "prop", bindingId: "p1", artifactIds: ["a1"], selectedArtifactId: "a1" })], script);

    const props = packs.find((pack) => pack.role === "prop")!;
    expect(props.expected).toBe(0);
    expect(props.entries).toHaveLength(1);
    expect(props.entries[0].bindingId).toBe("p1");
});

test("剧本里没有的绑定引用排在剧本实体之后，不会挤掉缺口视野", () => {
    const packs = buildAssetPacks([ref({ role: "character", bindingId: "c9", artifactIds: ["a1"], selectedArtifactId: "a1" })], script);

    const characters = packs.find((pack) => pack.role === "character")!;
    // 剧本实体在前：c1/c2 的缺口必须先被看见，c9 排最后。
    expect(characters.entries.map((item) => item.bindingId)).toEqual(["c1", "c2", "c9"]);
    expect(characters.entries[2].name).toBe("c9");
});

test("镜头级引用（keyframe/clip）不进资料包：它们不是角色/场景/道具", () => {
    const packs = buildAssetPacks([ref({ role: "keyframe", bindingId: "sh1", artifactIds: ["a1"], selectedArtifactId: "a1" })], script);

    expect(packs.some((pack) => pack.role === ("keyframe" as never))).toBe(false);
});

test("剧本为空/损坏时不崩，且不产出空包", () => {
    expect(buildAssetPacks([], null)).toEqual([]);
    expect(buildAssetPacks([], { characters: "not-an-array" })).toEqual([]);
    expect(buildAssetPacks(null as never, script)).toBeTruthy();
});
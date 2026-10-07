import { expect, test } from "bun:test";

import type { ShotRef, ShotRefs } from "../src/services/api/projects";
import { buildRefRows, canShowNumbering, missingReasonText, numberingWarning, refSummary } from "../src/pages/projects/shot-refs-model";

/** 形状照后端 shot-refs.js 的真实产出：音色 index/tag 为 null，url 是网关地址。 */
function ref(over: Partial<ShotRef> = {}): ShotRef {
    return {
        kind: "character",
        bindingId: "c_ling",
        label: "林灵",
        role: "形象",
        stableKey: "character:c_ling",
        index: 1,
        tag: "@image#1",
        ordinal: 1,
        artifactId: "j1/a_ling.png",
        url: "/api/artifacts/j1/a_ling.png",
        assetRefId: "as_1",
        ...over,
    };
}

test("参考清单行：图类带编号与缩略图，音色不带编号", () => {
    const rows = buildRefRows([
        ref(),
        ref({ kind: "voice", bindingId: "c_ling", label: "vp_female_warm", role: "音色", stableKey: "voice:c_ling", index: null, tag: null, artifactId: null, url: null }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].tag).toBe("@image#1");
    expect(rows[0].thumbUrl).toBe("/api/artifacts/j1/a_ling.png");
    // 音色是音频，模型那边没有这个号 —— 前端不能给它编一个缩略图位。
    expect(rows[1].tag).toBeNull();
    expect(rows[1].thumbUrl).toBeNull();
    expect(rows[1].role).toBe("音色");
});

test("参考清单行：缩略图地址认不出来就不给图（不拿占位图冒充）", () => {
    expect(buildRefRows([ref({ url: "" })])[0].thumbUrl).toBeNull();
    expect(buildRefRows([ref({ url: null })])[0].thumbUrl).toBeNull();
    // data:/blob: 是本地临时地址，进不了资料包也不该当产物图。
    expect(buildRefRows([ref({ url: "blob:http://x/y" })])[0].thumbUrl).toBeNull();
    // 绝对地址要还原成网关相对路径（AssetRef 里存的就是相对形态）。
    expect(buildRefRows([ref({ url: "http://gw:8788/api/artifacts/j1/a.png?token=x" })])[0].thumbUrl).toBe("/api/artifacts/j1/a.png?token=x");
});

test("参考清单行：缺参考的项要标出原因（缺料是事实，不能静默成「没图」）", () => {
    const rows = buildRefRows([ref({ artifactId: null, url: null })], [{ role: "character", bindingId: "c_ling", reason: "no-selected" }]);
    expect(rows[0].thumbUrl).toBeNull();
    expect(rows[0].missingReason).toBe("no-selected");
    expect(missingReasonText("no-selected")).toBe("未选定参考图");
    // 未知原因回落到原文 —— 不编一个听起来更确定的说法。
    expect(missingReasonText("brand-new-reason")).toBe("brand-new-reason");
    expect(missingReasonText(null)).toBe("");
});

test("编号只在后端核对通过时才允许当对应关系显示（本轮修掉的真 bug 的判据）", () => {
    // 对齐通过 → 可以显示编号
    expect(canShowNumbering({ aligned: true, mismatches: [] })).toBe(true);
    expect(numberingWarning({ aligned: true, mismatches: [] })).toBe("");

    // 对齐失败 → 绝不能显示编号对应关系，必须给警示。
    // 场景：音色曾占编号，界面说 @image#3 是母亲，模型那边的 <image3> 却是场景。
    expect(canShowNumbering({ aligned: false, mismatches: [{ index: 3, ref: null, injected: null }] })).toBe(false);
    expect(numberingWarning({ aligned: false, mismatches: [{ index: 3, ref: null, injected: null }] })).toContain("1");

    // 压根没核对过（alignment 缺失）→ 同样不能声称对应关系。
    expect(canShowNumbering(null)).toBe(false);
    expect(canShowNumbering(undefined)).toBe(false);
    expect(numberingWarning(null)).toContain("未与实际发送的图核对过");
});

test("参考清单行：空输入不炸（没有 refs 就该是空清单，不编条目）", () => {
    expect(buildRefRows([])).toEqual([]);
    expect(buildRefRows(null as unknown as ShotRef[])).toEqual([]);
    expect(refSummary(null)).toBe("");
    expect(refSummary({ summary: "林灵（形象）" } as ShotRefs)).toBe("林灵（形象）");
});

test("参考清单行：缺 label 时回落到 bindingId（不显示空白格）", () => {
    expect(buildRefRows([ref({ label: "" })])[0].label).toBe("c_ling");
});

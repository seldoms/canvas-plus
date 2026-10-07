import { expect, test } from "bun:test";

import { journeyHint, resolveJourney, type JourneyInput } from "../src/pages/projects/project-journey";

const emptyStatus = {};
const readyGates = [{ stageId: "script", ready: true, blockedBy: [] }];

/** 组一份输入，只覆盖与本用例相关的字段。 */
function input(patch: Partial<JourneyInput> = {}): JourneyInput {
    return { hasSource: false, hasScript: false, canvasIds: [], runIds: [], stageStatus: emptyStatus, gates: [], ...patch };
}

test("全新项目指向第一步：落原文/剧本", () => {
    const steps = resolveJourney(input());
    expect(steps[0].key).toBe("source");
    expect(steps[0].active).toBe(true);
    expect(steps[0].action).toBe("openPlan");
    // 后续步骤不得同时 active，否则引导会出现两个「当前」。
    expect(steps.filter((step) => step.active).length).toBe(1);
});

test("有剧本无画布时指向创建拆解画布（断点 B2）", () => {
    const steps = resolveJourney(input({ hasScript: true }));
    const canvas = steps.find((step) => step.key === "canvas")!;
    expect(canvas.active).toBe(true);
    // 没有画布时必须给「创建」，不能假装已存在可打开。
    expect(canvas.action).toBe("createCanvas");
    expect(canvas.done).toBe(false);
});

test("已有画布时改为打开最近那一张，而不是再建一张", () => {
    const steps = resolveJourney(input({ hasScript: true, canvasIds: ["cv-1", "cv-2"] }));
    const canvas = steps.find((step) => step.key === "canvas")!;
    expect(canvas.done).toBe(true);
    expect(canvas.action).toBe("openCanvas");
    expect(canvas.actionTarget).toBe("cv-1");
});

test("有画布无 run 时指向开启流水线", () => {
    const steps = resolveJourney(input({ hasScript: true, canvasIds: ["cv-1"] }));
    const pipeline = steps.find((step) => step.key === "pipeline")!;
    expect(pipeline.active).toBe(true);
    expect(pipeline.action).toBe("openPipeline");
});

test("有 run 时指向流水线阶段，并沿用服务端门禁的阻断原因", () => {
    const steps = resolveJourney(
        input({
            hasScript: true,
            canvasIds: ["cv-1"],
            runIds: ["run-1"],
            // script 未 done → 下一个未完成阶段是 script，服务端说还缺 design
            stageStatus: { script: "running" },
            gates: [{ stageId: "script", ready: false, blockedBy: ["design"], reason: "先跑服化道" }],
        }),
    );
    const stages = steps.find((step) => step.key === "stages")!;
    expect(stages.active).toBe(true);
    expect(stages.actionTarget).toBe("script");
    expect(stages.blockedReason).toBe("先跑服化道");
});

test("门禁放行时不显示阻断原因", () => {
    const steps = resolveJourney(
        input({ hasScript: true, canvasIds: ["cv-1"], runIds: ["run-1"], stageStatus: { script: "running" }, gates: readyGates }),
    );
    expect(steps.find((step) => step.key === "stages")!.blockedReason).toBe("");
});

test("七段全 done 后停在交付这一步（导出是重复动作，不假装已完成）", () => {
    const allDone = { script: "done", storyboard: "done", design: "done", casting: "done", keyframe: "done", audio: "done", assembly: "done" };
    const steps = resolveJourney(input({ hasScript: true, canvasIds: ["cv-1"], runIds: ["run-1"], stageStatus: allDone, gates: readyGates }));
    const stages = steps.find((step) => step.key === "stages")!;
    const delivery = steps.find((step) => step.key === "delivery")!;
    // 生产确实跑完了。
    expect(stages.done).toBe(true);
    // 但导出不是一次性状态：交付永远是当前一步，导完刷新也不会被清掉。
    expect(delivery.active).toBe(true);
    expect(delivery.action).toBe("openDelivery");

    // assembly 还在跑时，当前一步仍是 stages（生产未完），不是交付。
    const running = resolveJourney(input({ hasScript: true, canvasIds: ["cv-1"], runIds: ["run-1"], stageStatus: { ...allDone, assembly: "running" } }));
    expect(running.find((step) => step.key === "stages")!.active).toBe(true);
    expect(running.find((step) => step.key === "delivery")!.pending).toBe(true);
});

test("任何时刻有且只有一个 active 步骤", () => {
    const cases = [
        input(),
        input({ hasScript: true }),
        input({ hasScript: true, canvasIds: ["cv-1"] }),
        input({ hasScript: true, canvasIds: ["cv-1"], runIds: ["run-1"] }),
        input({ hasScript: true, canvasIds: ["cv-1"], runIds: ["run-1"], stageStatus: { script: "done", assembly: "done" } }),
    ];
    for (const one of cases) {
        const steps = resolveJourney(one);
        expect(steps.filter((step) => step.active).length).toBe(1);
    }
});

test("后续步骤标记为 pending，不会被当成当前", () => {
    const steps = resolveJourney(input({ hasScript: true, canvasIds: ["cv-1"], runIds: ["run-1"], stageStatus: { script: "done" } }));
    const stages = steps.find((step) => step.key === "stages")!;
    const delivery = steps.find((step) => step.key === "delivery")!;
    expect(stages.active).toBe(true);
    expect(delivery.pending).toBe(true);
    expect(delivery.active).toBe(false);
});

test("journeyHint 与 resolveJourney 口径一致：无集即在第一步", () => {
    expect(journeyHint({ completion: { episodes: 0, episodesDone: 0, checklistTotal: 0, checklistDone: 0 } })).toBe("source");
    expect(journeyHint({ completion: { episodes: 10, episodesDone: 0, checklistTotal: 0, checklistDone: 0 }, canvasCount: 0 })).toBe("canvas");
    expect(journeyHint({ completion: { episodes: 10, episodesDone: 0, checklistTotal: 0, checklistDone: 0 }, canvasCount: 2, runCount: 0 })).toBe("pipeline");
    expect(journeyHint({ completion: { episodes: 10, episodesDone: 0, checklistTotal: 0, checklistDone: 0 }, canvasCount: 2, runCount: 3 })).toBe("stages");
});

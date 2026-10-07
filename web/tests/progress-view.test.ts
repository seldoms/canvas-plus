/**
 * 前端进度判据：单调不回退（jobProgressPercent / taskPercent）。
 *
 * ## 为什么前端也要防一次
 *   后端已把 ComfyUI 的累计字典口径修成单调，但前端仍不能裸算 `value / max * 100`：
 *   轮询是跨请求的，可能读到修复上线前写下的旧 job 记录。
 *   更实际的问题是：同一页面上用户看着进度条往回跳会以为界面坏了。
 *   所以这里是最后一道防线 —— 只接受不低于历史值的比例。
 *
 * ## fixture 的来历
 *   2026-10-08 真机 ComfyUI 0.38.2 抓到的三份 progress_state（一条 TTS）：
 *     ① nodes = { "2": 1/1 finished }
 *     ② nodes = { "2": 1/1 finished, "3": 0/1 running }   ← 瞬时比值 0.5，比 ① 低
 *     ③ nodes = { "2": 1/1 finished, "3": 1/1 finished }
 *   前端只需知道「后端给出的 value/max 可能出现回落」，不必关心节点细节。
 */
import { describe, expect, test } from "bun:test";

import { jobProgressPercent, taskPercent } from "../src/components/workbench/task-utils";
import { clampLikeHook } from "../src/components/workbench/progress-clamp";

describe("jobProgressPercent", () => {
    test("正常比例：按 value/max 算", () => {
        expect(jobProgressPercent({ value: 18, max: 50 })).toBe(36);
        expect(jobProgressPercent({ value: 1, max: 4 })).toBe(25);
        expect(jobProgressPercent({ value: 0, max: 20 })).toBe(0);
    });

    test("没有真实分母时返回 -1，而不是画一条 0% 的假进度", () => {
        // 后端拿不到真实进度时就是 { value: 0, max: 0 } —— 显示 0% 等于说「真的刚开始」，是撒谎。
        expect(jobProgressPercent({ value: 0, max: 0 })).toBe(-1);
        expect(jobProgressPercent({ value: 0, max: 0, node: "排队中" })).toBe(-1);
        expect(jobProgressPercent(undefined)).toBe(-1);
        expect(jobProgressPercent({})).toBe(-1);
    });

    test("value 超过 max 时收敛到 100，不显示 120% 这种荒谬进度", () => {
        expect(jobProgressPercent({ value: 150, max: 100 })).toBe(100);
    });

    test("回落的比例被钳在历史值，不让进度条往回走", () => {
        // 真机序列的后端修复后不该出现这个形状，但旧 job 记录 / 后端覆盖仍可能带来回落。
        expect(jobProgressPercent({ value: 1, max: 2 }, 100)).toBe(100);
        expect(jobProgressPercent({ value: 1, max: 2 }, 50)).toBe(50);
        // 历史值更高时不采纳更低的原始值。
        expect(jobProgressPercent({ value: 18, max: 50 }, 80)).toBe(80);
    });

    test("真实上涨时正常跟进，不被历史值卡住", () => {
        expect(jobProgressPercent({ value: 30, max: 50 }, 20)).toBe(60);
        expect(jobProgressPercent({ value: 5, max: 10 }, 0)).toBe(50);
    });

    test("历史值非法时按 0 处理，不因此把真实进度也吞掉", () => {
        expect(jobProgressPercent({ value: 5, max: 10 }, Number.NaN)).toBe(50);
        expect(jobProgressPercent({ value: 5, max: 10 }, -30)).toBe(50);
    });
});

describe("taskPercent", () => {
    const job = (progress?: { value?: number; max?: number }) =>
        ({ id: "j1", status: "running", progress } as never);

    test("单条任务优先用真实进度", () => {
        expect(taskPercent([job({ value: 18, max: 50 })], 0, 1)).toBe(36);
    });

    test("单条任务没有真实分母时退回已完成/总数", () => {
        expect(taskPercent([job({ value: 0, max: 0 })], 0, 1)).toBe(0);
        expect(taskPercent([undefined], 1, 2)).toBe(50);
    });

    test("多条任务按完成数算，且不低于历史值", () => {
        const list = [job({ value: 1, max: 2 }), job({ value: 1, max: 2 })];
        expect(taskPercent(list, 1, 2)).toBe(50);
        // 后端给出 100% 却只有一半完成时，取两者更大的事实（完成数）而不是更低的比例。
        expect(taskPercent([job({ value: 1, max: 2 })], 0, 1, 90)).toBe(90);
    });

    test("总数为 0 时不返回 NaN", () => {
        expect(taskPercent([], 0, 0)).toBe(0);
    });
});
describe("后端下发的 percent 优先于本地 value/max（真机 92%→61% 的教训）", () => {
    // 真机实测：视频任务跑到 92% 时 ComfyUI 加入新节点，max 从 14 涨到 21。
    // 若前端拿 value/max 自己算：13/21 = 62% —— 进度条倒退 30 个百分点。
    // 后端下发的 percent 已经钳制过，前端必须**优先用它**，而不是重算。
    test("percent 存在时用它，不被会增长的分母带偏", () => {
        expect(jobProgressPercent({ value: 13, max: 21, percent: 92 })).toBe(92);
        // value/max 明明算出 62%，但 percent 才是可信口径。
        expect(Math.round((13 / 21) * 100)).toBe(62);
    });

    test("percent 仍要过单调钳制，且收敛到 100", () => {
        expect(jobProgressPercent({ percent: 40 }, 70)).toBe(70, "不低于历史值");
        expect(jobProgressPercent({ percent: 140 })).toBe(100, "不许超过 100%");
    });

    test("percent 缺失（旧 job 记录）才退回本地算，且同样钳制", () => {
        expect(jobProgressPercent({ value: 18, max: 50 })).toBe(36);
        expect(jobProgressPercent({ value: 1, max: 2 }, 80)).toBe(80);
    });
});

describe("useMonotonicPercent 的纯逻辑（等价核心 clampLikeHook）", () => {
    // hook 本身要 React 环境才能跑，所以把它的核心（取历史 → 算 → 记最大值）抽成纯函数测：
    // 这样「历史值真的参与了钳制」是可执行的断言，而不是靠人读代码确认。
    test("连续多次回落时，返回值不低于上一次", () => {
        let last = 0;
        const run = (raw: number) => {
            const percent = clampLikeHook(raw, last);
            last = Math.max(last, percent);
            return percent;
        };
        expect(run(36)).toBe(36);
        expect(run(0)).toBe(36); // 大幅回落 → 维持 36，不让进度条跳回去
        expect(run(50)).toBe(50); // 真实上涨要能跟上
        expect(run(10)).toBe(50);
    });

    test("历史值不会把后续真实上涨卡住", () => {
        let last = 0;
        const run = (raw: number) => {
            const percent = clampLikeHook(raw, last);
            last = Math.max(last, percent);
            return percent;
        };
        run(90);
        expect(run(95)).toBe(95, "95 > 90，应当跟进");
    });

    test("历史值为 0 时正常跟随", () => {
        let last = 0;
        expect(clampLikeHook(40, last)).toBe(40);
    });
});

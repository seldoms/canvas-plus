import type { ProjectCompletion, ProjectGate } from "@/services/api/projects";

import type { StageStatusMap } from "./workspace-gates";
import { resolveNextStep } from "./workspace-gates";

/**
 * 项目主线「下一步」推导（P0 串联引导，skeleton §6 P0 / 断点 B1、B2）。
 *
 * 回答的是「这个项目现在该做什么」这个产品级问题，而不是「流水线下一个阶段是什么」
 * （那是 workspace-gates.resolveNextStep 的职责，两者互补不重叠）：
 *   1. source   原文/剧本落库  → 断点 B1：建完项目没人告诉他下一步
 *   2. canvas   拆解画布       → 断点 B2：建项目不会自动建拆解画布
 *   3. pipeline 开启生产       → 有画布却没人接上流水线
 *   4. stages   逐阶段生产     → 复用门禁结论，不另起一套
 *   5. delivery 导出交付包     → 成片后的收口
 *
 * 判定是**纯函数**且只读服务端事实（context / stageStatus / gates），不臆造完成度：
 * 读不到的事实一律按「未完成」呈现，宁可多提示一步也不假装已连通。
 */

export type JourneyStepKey = "source" | "canvas" | "pipeline" | "stages" | "delivery";

/** 每一步在界面上能触发的真实动作；面板据此接真实接口，不做占位按钮。 */
export type JourneyAction = "openPlan" | "createCanvas" | "openCanvas" | "openPipeline" | "openWorkspace" | "openDelivery";

export type JourneyStep = {
    key: JourneyStepKey;
    /** 已完成（不再提示）。 */
    done: boolean;
    /** 当前该做的那一步（第一个未完成项；全部完成时为 undefined）。 */
    active: boolean;
    /** 尚未轮到的后续步骤（界面应弱化显示）。 */
    pending: boolean;
    /** action 指向的目标：工作区 key / 画布 id / run id。 */
    action: JourneyAction;
    actionTarget?: string;
    /** 被门禁挡住时的原因（只有 stages 步骤会有）。 */
    blockedReason?: string;
};

export type JourneyInput = {
    /** 项目已有原文版本或剧本（任一即可视为已落库）。 */
    hasSource: boolean;
    hasScript: boolean;
    /** 已绑定的画布 id 列表。 */
    canvasIds: string[];
    /** 已关联的 run id 列表。 */
    runIds: string[];
    stageStatus: StageStatusMap;
    gates: ProjectGate[];
};

export const JOURNEY_STEPS: JourneyStepKey[] = ["source", "canvas", "pipeline", "stages", "delivery"];

export function resolveJourney(input: JourneyInput): JourneyStep[] {
    const { hasSource, hasScript, canvasIds, runIds, stageStatus, gates } = input;
    const nextStage = resolveNextStep(gates, stageStatus);
    const done: Record<JourneyStepKey, boolean> = {
        source: hasSource || hasScript,
        canvas: canvasIds.length > 0,
        pipeline: runIds.length > 0,
        // stages 的完成定义就是「没有下一个阶段」（七段跑完）。
        stages: nextStage === null,
        // delivery 是**可重复**的收口动作，不存在「导完了」这个一次性状态：
        // 项目事实链里只有 `assembly === done`（成片已产出），没有「交付包已导出」字段。
        // 所以这里恒为 false —— 成片出来后它永远是当前一步，导完刷新也不会被清掉。
        // 宁可多提示一次，也不臆造一个「已完成」骗用户。
        delivery: false,
    };

    const firstUndone = JOURNEY_STEPS.find((key) => !done[key]);
    const workspaceStage = nextStage?.stage;

    return JOURNEY_STEPS.map((key) => {
        const step: JourneyStep = {
            key,
            done: done[key],
            active: key === firstUndone,
            pending: firstUndone !== undefined && JOURNEY_STEPS.indexOf(key) > JOURNEY_STEPS.indexOf(firstUndone),
            action: "openPipeline",
        };

        if (key === "source") {
            step.action = "openPlan";
            step.actionTarget = "plan";
        } else if (key === "canvas") {
            // 有画布就直接打开最近创建的那一个，而不是让用户去画布列表里找。
            step.action = canvasIds.length ? "openCanvas" : "createCanvas";
            step.actionTarget = canvasIds[0];
        } else if (key === "pipeline") {
            step.action = "openPipeline";
        } else if (key === "stages") {
            step.action = "openWorkspace";
            step.actionTarget = workspaceStage;
            // 门禁不可读时不给「跑」的假象，只如实说明原因（unknown 不拦截，但也不谎称可跑）。
            step.blockedReason = nextStage ? (nextStage.runnable ? "" : nextStage.reason || "") : "";
        } else if (key === "delivery") {
            step.action = "openDelivery";
            step.actionTarget = "video";
        }

        return step;
    });
}

/** 当前该做的那一步（全部完成时返回 undefined）。 */
export function currentJourneyStep(steps: JourneyStep[]): JourneyStep | undefined {
    return steps.find((step) => step.active);
}

/**
 * 列表页卡片用的轻量摘要：卡片上没有 gates / stageStatus（要打网关，不划算），
 * 只按服务端列表摘要已给的计数给出粗粒度提示，避免每张卡都拉一次详情。
 * 口径与 resolveJourney 一致：canvas 有没有、run 有没有，只看计数是否为 0。
 */
export function journeyHint(summary: { completion?: ProjectCompletion; canvasCount?: number; runCount?: number }): JourneyStepKey | null {
    if (!summary.completion?.episodes) return "source";
    if (!summary.canvasCount) return "canvas";
    if (!summary.runCount) return "pipeline";
    return "stages";
}

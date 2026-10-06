import type { ContinuationChain, ContinuationSeam, ContinuationSegment } from "@/services/api/projects";

/**
 * 「视频·后期」工作区续接链的纯逻辑（M3.5-D2）：把服务端派生视图（GET .../continuation-chains）
 * 折算成渲染层直接可用的判断，零 IO、零 React。
 *
 * 契约见 domain-contract.md §3.6 与 m35-implementation-plan.md §3：链只能通过父引用向前追溯；
 * `selected` 仍由 GenerationSlot 统一指向，采用一条 take = 采用它**末段候选**的 jobId。
 */

/** 段是否还在跑（queued/running）；链上有活动段时不能采用、也不该重复续跑。 */
export function isSegmentActive(segment: ContinuationSegment) {
    return segment.status === "queued" || segment.status === "running";
}

/** 链上是否有活动段。 */
export function isChainActive(chain: ContinuationChain) {
    return chain.segments.some(isSegmentActive);
}

/** 已完成的段（按 segmentIndex 升序）；采用/分叉都只认有产物地址的 done 段。 */
export function doneSegments(chain: ContinuationChain) {
    return chain.segments.filter((segment) => segment.status === "done" && segment.artifactUrl).sort((a, b) => a.segmentIndex - b.segmentIndex);
}

/** 采用这条 take 时要写进 `slot.selected` 的 jobId = 末段候选；没有可用段时为 null。 */
export function adoptableJobId(chain: ContinuationChain) {
    const done = doneSegments(chain);
    return done.length ? done[done.length - 1].jobId : null;
}

/** 能否采用：有可用末段且链上没有活动段（跑到一半不让采用，避免采用到半条链）。 */
export function canAdopt(chain: ContinuationChain) {
    return !isChainActive(chain) && adoptableJobId(chain) !== null;
}

/** 能否续跑：链未完成即可点（幂等：已完成段命中原 Job、链已完成回 job:null，不会重复入队）。 */
export function canResume(chain: ContinuationChain) {
    return chain.status !== "done";
}

/** 可从此段分叉：done 且有产物（服务端同样要求父候选 done，否则 409 PARENT_NOT_DONE）。 */
export function canBranchFrom(segment: ContinuationSegment) {
    return segment.status === "done" && Boolean(segment.artifactUrl);
}

/** 接缝是否需要人工复核：QC 标了 needsReview 或复核状态仍是 pending（QC 已产出接缝）。 */
export function needsSeamReview(segment: ContinuationSegment) {
    if (!segment.seam) return false;
    return segment.needsReview || segment.seam.reviewed === "pending";
}

/** 复核状态：无接缝 = "none"；其余按 seam.reviewed 原样返回（pending/approved/rejected）。 */
export function seamReviewState(segment: ContinuationSegment): "none" | string {
    return segment.seam ? String(segment.seam.reviewed || "pending") : "none";
}

/** 一个可渲染的接缝指标（label 走 i18n key 由渲染层翻译，这里只给 key 与已格式化值）。 */
export type SeamMetric = { key: string; value: string; warn: boolean };

/** 接缝门槛（与服务端 continuation.js SEAM_THRESHOLDS 一致）：超门槛的指标在界面上标警示色。 */
export const SEAM_THRESHOLDS = { ssimMin: 0.85, audioStepMaxDb: 12 } as const;

const decimals = (value: number, digits: number) => value.toFixed(digits);

/**
 * 接缝量化指标（只列 UI 展示用的四项）：边界帧 SSIM、接缝音频落差、冻结帧、接缝积分响度。
 * 缺失（null）的指标**不占位**——没测到就不显示，不用 0 或 — 假装有数据。
 */
export function seamMetrics(seam: ContinuationSeam | null): SeamMetric[] {
    if (!seam) return [];
    const metrics = seam.metrics ?? {};
    const list: SeamMetric[] = [];
    if (typeof metrics.boundarySsim === "number") {
        list.push({ key: "ssim", value: decimals(metrics.boundarySsim, 3), warn: metrics.boundarySsim < SEAM_THRESHOLDS.ssimMin });
    }
    if (typeof seam.rmsStepDb === "number") {
        list.push({ key: "audioStep", value: `${decimals(seam.rmsStepDb, 1)} dB`, warn: seam.rmsStepDb > SEAM_THRESHOLDS.audioStepMaxDb });
    }
    if (seam.freezeDetected) list.push({ key: "freeze", value: "", warn: true });
    if (typeof metrics.seamIntegratedLufs === "number") {
        list.push({ key: "lufs", value: `${decimals(metrics.seamIntegratedLufs, 1)} LUFS`, warn: false });
    }
    return list;
}

/** 链的分叉来源：父候选属于哪条链（用于在视图上标出「分叉自 <chainId>/seg<N>」）。 */
export function branchOrigin(chains: ContinuationChain[], chain: ContinuationChain): { chainId: string; segmentIndex: number } | null {
    if (!chain.parentCandidateId) return null;
    for (const candidate of chains) {
        const segment = candidate.segments.find((item) => item.jobId === chain.parentCandidateId);
        if (segment) return { chainId: candidate.chainId, segmentIndex: segment.segmentIndex };
    }
    return null;
}

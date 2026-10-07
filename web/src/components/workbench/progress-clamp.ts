/**
 * 进度单调钳制的**纯核心**。
 *
 * 单独成文件是为了解开循环依赖：use-monotonic-percent 需要 taskPercent，
 * 而 task-utils 的 jobProgressPercent 又需要本函数。放在一起必然成环。
 */

/**
 * 单调钳制：本次算出的百分比不得低于上一次。
 *
 * 单独导出是为了能**在无 React 环境里测它**——
 * 否则 hook 里那行 Math.max 只能靠人读代码确认，而本项目吃过太多次
 * 「以为防住了、其实没防」的亏（与 refs 那次同款）。
 */
export function clampLikeHook(raw: number, previous: number): number {
    const floor = Number.isFinite(previous) ? Math.max(0, previous) : 0;
    return Math.max(Number.isFinite(raw) ? raw : 0, floor);
}
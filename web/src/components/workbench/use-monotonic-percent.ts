/**
 * 组进度的单调钳制：记住上一次算出的百分比，供 taskPercent 用。
 *
 * ## 为什么需要它
 *   `taskPercent(list, finished, total, previousPercent)` 的第四参是历史值。
 *   三处调用点（queue-panel / video / image）若都传 0，钳制就是**空转的** ——
 *   看起来加了防线，实际一道都拦不住。这正是本项目反复出现的「以为防住了其实没防」。
 *
 * ## 为什么封装成 hook 而不是让每个调用点自己 useRef
 *   调用点要写成「先取历史 →算 → 写回」三步，顺序写反或忘记写就**静默失效**，
 *   而失效表现是「进度条偶尔回跳」这种难复现的问题。
 *   封装后调用方只需一行 `useMonotonicPercent(list, finished, total)`。
 *
 * ## 为什么用 ref 而不是 state
 *   历史值只用于算本次百分比，不需要触发重渲染；
 *   队列面板每几秒刷新一次，进度变化时多一次渲染纯属浪费。
 */
import { useRef } from "react";

import type { WorkbenchJob } from "./types";
import { taskPercent } from "./task-utils";

export { clampLikeHook } from "./progress-clamp";
import { clampLikeHook } from "./progress-clamp";

/**
 * 返回一个「只增不减」的组进度百分比。
 *
 * @param list 队列里的 job（可含 undefined）
 * @param finished 已完成数
 * @param total 总数
 */
export function useMonotonicPercent(list: Array<WorkbenchJob | undefined>, finished: number, total: number): number {
    const last = useRef(0);
    const percent = clampLikeHook(taskPercent(list, finished, total, last.current), last.current);
    last.current = percent;
    return percent;
}
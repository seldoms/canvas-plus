/**
 * 工作台共享业务逻辑（生图工作台 / 视频创作台共用同一套）。
 *
 * 之前两个页面各自实现「记录怎么落 / 取消怎么发 / 归档目标怎么找」——
 * UI 组件早就抽到 `components/workbench/**` 了，但**业务逻辑没抽**，两边口径会漂。
 * 这里把与渲染无关的编排逻辑收成纯函数/小工具：
 *   - `cancelWorkbenchJobs`  ：取消怎么发（逐个走后端 cancel，汇总失败数）
 *   - `archiveTargetsFromJobs`：归档目标怎么找（**从该次任务的产物取**，规范 §2.5）
 *   - `jobIdsForItemIds`     ：历史记录 → 反查它对应的后端 job（老记录缺 jobIds 时的兜底）
 *
 * 规范 §2.5：归档目标的来源是**该次任务的产物（job 的产物清单）**，
 * 不是记录里被序列化过的图形对象字段 —— 老记录常缺 `jobIds` / `artifactUrl`，
 * 直接依赖那些字段会让归档按钮**整颗不渲染**（点了都没有）。
 */
import type { ArtifactTarget } from "@/components/artifact-actions";
import { isArtifactUrl } from "@/services/api/artifacts";

import type { WorkbenchJob } from "./types";

/**
 * 取消一组 job（生图 / 视频共用）：逐个调用传入的 cancel，返回成功/失败计数。
 * 不抛错 —— 取消是尽力而为，失败由调用方决定怎么提示。
 */
export async function cancelWorkbenchJobs(
    jobIds: string[],
    cancel: (jobId: string) => Promise<unknown>,
): Promise<{ cancelled: number; failed: number }> {
    const results = await Promise.all(jobIds.map((id) => cancel(id).then(() => true).catch(() => false)));
    const failed = results.filter((ok) => !ok).length;
    return { cancelled: results.length - failed, failed };
}

/**
 * 归档目标（规范 §2.5）：**从该次任务的产物取**（job 的 outputs 清单）。
 * - 主来源：每个 job 的 `outputs[].url`（后端产物清单，唯一事实源）；
 * - 兜底：调用方给的 `extraUrls`（记录里若还留着产物地址，一并纳入）；
 * - 只保留指向**本网关产物**的地址（`/api/artifacts/...`）并去重，避免对本地 blob 误发归档请求。
 */
export function archiveTargetsFromJobs(
    jobs: Array<WorkbenchJob | undefined | null>,
    extraUrls: Array<string | undefined | null> = [],
): ArtifactTarget[] {
    const urls = new Set<string>();
    for (const job of jobs) {
        for (const output of job?.outputs ?? []) {
            if (isArtifactUrl(output.url)) urls.add(output.url);
        }
    }
    for (const url of extraUrls) {
        if (isArtifactUrl(url ?? undefined)) urls.add(String(url));
    }
    return [...urls].map((url) => ({ url }));
}

/**
 * 历史记录 → 它对应的后端 job id。
 * 记录条目的 id 形如 `<jobId>-<filename>`（`jobOutputToImage` 生成），据此前缀匹配回查产物清单；
 * 用于「记录里没存 jobIds」时仍能从 job 产物找到归档目标。
 */
export function jobIdsForItemIds(itemIds: string[], jobsById: Record<string, WorkbenchJob>): string[] {
    const allJobIds = Object.keys(jobsById);
    const found = new Set<string>();
    for (const itemId of itemIds) {
        for (const jobId of allJobIds) {
            if (itemId === jobId || itemId.startsWith(`${jobId}-`)) found.add(jobId);
        }
    }
    return [...found];
}

/**
 * slot-candidates.js —— 槽位候选业务（M2，domain-contract §3.5）：画布 / 导入产物 →
 * Project 侧 `shots[].generationSlots[]` 的候选追加与采用。
 *
 * 纯业务模块：不 import http.js、不碰存储路径；Job 查询与槽位存储全部由调用方注入。
 * 错误形状沿用 generation-intent.js：Error + status + code + field，路由层按 status 回响应。
 *
 * 硬约束（M2-D6）：自动投影只追加候选、**绝不动 selected**；采用只能由显式 select 改变。
 */

/** 契约错误：status（HTTP）+ code（机器可判）+ field（出错字段）。 */
function contractError(status, code, message, field) {
    return Object.assign(new Error(message), { status, code, field });
}

export function createSlotCandidates({ jobs, episodes } = {}) {
    if (typeof jobs?.get !== "function") throw new Error("createSlotCandidates 需要注入 jobs.get");
    if (typeof episodes?.appendSlotCandidate !== "function" || typeof episodes?.selectSlotCandidate !== "function") {
        throw new Error("createSlotCandidates 需要注入 episodes 的槽位存储函数");
    }

    /** Job → 槽位候选（契约 §3：template/jobId/artifactUrl/status/source/createdAt）；无产物输出返回 null。 */
    function candidateFor(job) {
        const output = (Array.isArray(job.outputs) ? job.outputs : []).find((item) => item?.url);
        if (!output) return null;
        return {
            template: String(job.template ?? ""),
            jobId: String(job.id),
            artifactUrl: output.url,
            status: String(job.status ?? ""),
            source: job.meta?.source ? String(job.meta.source) : undefined,
            createdAt: new Date().toISOString(),
        };
    }

    /**
     * 追加候选：404 JOB_NOT_FOUND / NO_ARTIFACT_OUTPUT；409 PROJECT_MISMATCH
     * （job.meta.projectId 与目标项目不符）。幂等由存储层保证（同 jobId 不重复）。
     */
    function appendCandidate({ projectId, shotId, slotId, jobId } = {}) {
        const id = String(jobId ?? "").trim();
        if (!id) throw contractError(400, "CONTRACT_INVALID", "缺少 jobId", "jobId");
        const job = jobs.get(id);
        if (!job) throw contractError(404, "JOB_NOT_FOUND", `任务不存在：${id}`, "jobId");
        const candidate = candidateFor(job);
        if (!candidate) throw contractError(404, "NO_ARTIFACT_OUTPUT", `任务没有产物输出：${id}`, "jobId");
        const owner = job.meta?.projectId ? String(job.meta.projectId) : "";
        if (owner && owner !== String(projectId)) {
            throw contractError(409, "PROJECT_MISMATCH", `任务归属项目（${owner}）与目标项目（${projectId}）不符`, "projectId");
        }
        const { slot } = episodes.appendSlotCandidate(projectId, shotId, slotId, candidate);
        return { slot };
    }

    /**
     * 采用候选：设 slot.selected = jobId；jobId 传 null 撤销采用（清空 selected，candidates 不动）；候选不存在 → 404 CANDIDATE_NOT_FOUND（存储层抛出）。
     * M3.5 续接扩展（D35-7，追加式行为）：采用的候选属于某个 take 时，整链段 approvalStatus→approved、其它 take 段→superseded；
     * 无 takeId 的候选（画布/普通候选）不受影响。
     */
    function selectCandidate({ projectId, shotId, slotId, jobId } = {}) {
        const { slot } = episodes.selectSlotCandidate(projectId, shotId, slotId, jobId);
        if (jobId !== null && typeof episodes.updateSlotCandidate === "function") {
            const selected = (slot.candidates || []).find((candidate) => candidate.jobId === slot.selected);
            if (selected?.takeId) {
                for (const candidate of slot.candidates || []) {
                    if (!candidate.takeId) continue;
                    const next = candidate.takeId === selected.takeId ? "approved" : "superseded";
                    if (candidate.approvalStatus !== next) {
                        episodes.updateSlotCandidate(projectId, shotId, slotId, candidate.jobId, { approvalStatus: next });
                    }
                }
            }
        }
        return { slot };
    }

    /**
     * 画布终态自动投影（M2-D6，服务端内部，非 HTTP）：终态 done 且 meta 含
     * projectId+shotId+slotId 且无 runId → 追加候选（source 取 job.meta.source），**不改 selected**。
     * 投影失败只告警，绝不拖垮 Job 回写链。
     */
    function projectCanvasTerminalJob(job) {
        const meta = job?.meta || {};
        if (job?.status !== "done") return null;
        if (!meta.projectId || !meta.shotId || !meta.slotId || meta.runId) return null;
        try {
            return appendCandidate({ projectId: meta.projectId, shotId: meta.shotId, slotId: meta.slotId, jobId: job.id });
        } catch (error) {
            console.warn(`[slot-candidates] 画布任务投影失败 ${job?.id}：${error.message}`);
            return null;
        }
    }

    return { appendCandidate, selectCandidate, projectCanvasTerminalJob };
}

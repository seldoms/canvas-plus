import { checkStageArtifact } from "./stage-artifact-check.js";
import { buildAudioTimeline } from "./audio-timeline.js";

/** 跨阶段质量检查的纯函数入口；不改正文、不改产物，只返回可重放报告。 */
export function buildQualityReport({ run, stageUpstream, stage = null, now = new Date().toISOString() } = {}) {
    const issues = [];
    const stages = run?.stages || {};
    const stageIds = stage ? [String(stage)] : Object.keys(stages);
    for (const id of stageIds) {
        const value = stages[id];
        if (!value?.output || value.status !== "done") {
            issues.push({ code: "stage_incomplete", severity: "block", stage: id, message: `阶段 ${id} 尚未完成，不能判定质量通过` });
        }
        if (!value?.output) continue;
        for (const issue of value.output.timingIssues || []) issues.push({ ...issue, stage: id, severity: "block" });
        const result = checkStageArtifact(id, value.output, typeof stageUpstream === "function" ? stageUpstream(id) : {});
        for (const issue of [...(result.errors || []), ...(result.warnings || [])]) {
            issues.push({
                code: issue.code || `stage_${id}`,
                severity: issue.severity || (result.errors?.includes(issue) ? "block" : "warn"),
                stage: id,
                message: issue.message || String(issue),
                path: issue.path || null,
            });
        }
    }

    if (!stage || stage === "assembly") {
        const film = stages.assembly?.output?.assembly;
        for (const issue of film?.quality?.issues || []) issues.push({ ...issue, severity: "block", stage: "assembly" });
        if (film?.status !== "done" || !film?.url) {
            issues.push({ code: "film_incomplete", severity: "block", stage: "assembly", message: "成片尚未完成，实际媒体时间轴无法验收" });
        } else {
            // 只检查交付层实测并落盘的对白窗口，禁止拿规划 Cue 时长重新排布后掩盖重叠。
            const timing = film?.quality?.dialogueTiming || [];
            const clips = film?.quality?.clips || [];
            if (timing.length) {
                const timeline = buildAudioTimeline({ clips, audio: timing, durations: timing.map((item) => item.durationSec), transitionDurationSec: film.quality.transitionDurationSec || 0 });
                for (const issue of timeline.issues) issues.push({ ...issue, severity: "block", stage: "assembly" });
            }
            issues.push({ code: "perceptual_review", severity: "warn", stage: "assembly", message: "请预览复核跨镜音色与口型同步；结构和时间轴检查不能替代听感与画面验收" });
        }
    }

    const blocking = issues.filter((issue) => issue.severity === "block" || issue.severity === "error");
    return {
        id: `qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        runId: run?.id || null,
        stage: stage || null,
        createdAt: now,
        status: blocking.length ? "blocked" : issues.length ? "needs_review" : "pass",
        issues,
        summary: { total: issues.length, blocking: blocking.length, warnings: issues.length - blocking.length },
    };
}

/**
 * 阶段门禁（P0-a 深水区）：纯推导，不读写盘。
 * 给定 Project + 各集详情，算出每个阶段能否进入：`{ stageId, title, ready, reason, blockedBy, done }`。
 *
 * 放行规则（D11 逐阶段人工门禁 + R9）：
 *  - 上游阶段全部 done，且本阶段无未解决的 `ReviewNote.level === "block"`（按 note.stage 命中本阶段），才 ready；
 *  - done 由「该阶段产物是否已存在于 Project/Episode 数据里」判定（可重放、幂等）。
 * 阶段 ID 唯一权威命名见 domain-contract.md §3.9「阶段 ID 权威命名」。
 * 阶段用例：plan(规划) → script(剧本) → storyboard(分镜) → design(资产/服化道) → keyframe(关键帧) → assembly(片段生成) → post(成片交付/后期)。
 * 其中 plan 是项目级规划（非 run 阶段），design 对应流水线 03 服化道，assembly 对应 05 片段合成，与 skills/registry.json 的阶段 id 一致。
 */

export const GATE_STAGES = Object.freeze([
    Object.freeze({ id: "plan", title: "规划", requires: Object.freeze([]) }),
    Object.freeze({ id: "script", title: "剧本", requires: Object.freeze(["plan"]) }),
    Object.freeze({ id: "storyboard", title: "分镜", requires: Object.freeze(["script"]) }),
    Object.freeze({ id: "design", title: "资产", requires: Object.freeze(["script"]) }),
    Object.freeze({ id: "keyframe", title: "关键帧", requires: Object.freeze(["storyboard", "design"]) }),
    Object.freeze({ id: "assembly", title: "片段生成", requires: Object.freeze(["keyframe"]) }),
    Object.freeze({ id: "post", title: "后期", requires: Object.freeze(["assembly"]) }),
]);

/** 该阶段是否有产物可判定为 done。 */
function hasOutput(stageId, project, episodes) {
    const rows = Array.isArray(episodes) ? episodes : [];
    switch (stageId) {
        case "plan":
            return Boolean(project?.plan);
        case "script":
            return Boolean(project?.script) || Boolean(project?.sourceRevisionId) || rows.length > 0;
        case "storyboard":
            return rows.some((episode) => Array.isArray(episode?.scenes) && episode.scenes.length > 0);
        case "design":
            return Array.isArray(project?.assetRefs) && project.assetRefs.length > 0;
        case "keyframe":
            return rows.some((episode) => (episode?.shots || []).some((shot) => (shot?.generationSlots || []).some((slot) => slot.selected || (slot.candidates || []).some((candidate) => candidate.status === "done"))));
        case "assembly":
            return rows.length > 0 && rows.every((episode) => episode.status === "done");
        default:
            return false;
    }
}

export function deriveGates({ project, episodes } = {}) {
    const notes = Array.isArray(project?.reviewNotes) ? project.reviewNotes : [];
    const done = {};
    const gates = [];
    for (const stage of GATE_STAGES) {
        const blockedBy = [];
        for (const upstream of stage.requires) {
            if (!done[upstream]) blockedBy.push({ type: "upstream", stageId: upstream });
        }
        for (const note of notes) {
            if (note && note.level === "block" && !note.resolvedAt && note.stage === stage.id) {
                blockedBy.push({ type: "review", noteId: note.id ?? null, message: String(note.message ?? "") });
            }
        }
        const ready = blockedBy.length === 0;
        done[stage.id] = ready && hasOutput(stage.id, project, episodes);

        let reason = "";
        if (!ready) {
            const names = blockedBy.filter((item) => item.type === "upstream").map((item) => item.stageId);
            if (names.length) reason = `上游阶段未完成：${names.join("、")}`;
            const risks = blockedBy.filter((item) => item.type === "review").length;
            if (risks) reason = `${reason ? `${reason}；` : ""}存在未处理的阻断风险提示（${risks} 条）`;
            reason = reason || "被上游或风险提示阻断";
        } else {
            reason = "可进入（上游已就绪，无阻断风险）";
        }
        gates.push({ stageId: stage.id, title: stage.title, ready, reason, blockedBy, done: done[stage.id] });
    }
    return gates;
}

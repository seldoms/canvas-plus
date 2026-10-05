/**
 * 阶段门禁（P0-a 深水区；M0 起改为 registry 派生）：纯推导，不读写盘。
 * 给定 Project + 各集详情 + 调用方注入的 run 阶段定义，算出每个阶段能否进入：`{ stageId, title, ready, reason, blockedBy, done }`。
 *
 * 阶段集合的单一来源是 `skills/registry.json`（domain-contract.md §3.9「阶段 ID 权威命名」，pilot-issues #96）：
 * run 七阶段 `script → storyboard → design → casting → keyframe → audio → assembly` 的 id / title / requires
 * 一律由调用方（路由层 `loadRegistry`）注入，本模块不再手写第二份阶段数组；不注入（stages 为空）时输出只剩
 * plan / post 两项。
 *  - `plan`：项目级规划（非 run 阶段），保留为输出首项，done 判据照旧 `Boolean(project?.plan)`；
 *  - `post`：交付后期（非 run 阶段，不在 registry 的 stages 里），保留为输出末项（`requires=["assembly"]`），
 *    仅为交付门禁可见性；注入的 stages 缺 `assembly` 时它将永远被上游挡住。
 *
 * 放行规则（D11 逐阶段人工门禁 + R9）：
 *  - 上游阶段全部 done，且本阶段无未解决的 `ReviewNote.level === "block"`（按 note.stage 命中本阶段），才 ready；
 *  - done 由「该阶段产物是否已存在于 Project/Episode 数据里」判定（可重放、幂等）。
 *
 * P0-f 追加（Bible 门禁，向后兼容）：项目**存在**对应类别的圣经实体时，该阶段 ready 还要看
 * 实体是否 `approved`/`locked`（下游只消费已批准版本）；实体缺失则不产生任何约束（旧项目行为逐字不变）。
 *
 * M0 追加（casting / audio 判据，向后兼容）：
 *  - casting：项目存在定妆身份卡（`project.casting.characters` 非空）时，以「全部 confirmed（脸+声都真）」
 *    为 done 判据（casting.js 契约），未确认则 keyframe / audio 被 `upstream:casting` 挡住
 *    （与 pipeline.js `enforceCastingGate` 同口径）；**项目从未产出身份卡时 casting 不作为上游约束**
 *    （无实体不约束，旧项目不得被误拦）。
 *  - audio：以 AudioCue 投影落点 `project.audioCues`（audio-track.js `applyAudioProjection`）的存在性判 done；
 *    registry 中没有任何阶段 requires audio，故不产生下游约束，无数据项目不受影响。
 */

import { BIBLE_KIND_LABEL, BIBLE_KIND_STAGE, isConsumable } from "./bible.js";
import { isCastingConfirmed } from "./casting.js";

/** plan：项目级规划（非 run 阶段，不参与 registry 派生），固定为输出首项。 */
const PLAN_STAGE = Object.freeze({ id: "plan", title: "规划", requires: Object.freeze([]) });
/** post：交付后期（非 run 阶段，不在 registry 的 stages 里），固定为输出末项，仅为交付门禁可见性。 */
const POST_STAGE = Object.freeze({ id: "post", title: "后期", requires: Object.freeze(["assembly"]) });

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
        case "casting": {
            const cards = Array.isArray(project?.casting?.characters) ? project.casting.characters : [];
            if (!cards.length) return false;
            return isCastingConfirmed(project.casting);
        }
        case "keyframe":
            return rows.some((episode) => (episode?.shots || []).some((shot) => (shot?.generationSlots || []).some((slot) => slot.selected || (slot.candidates || []).some((candidate) => candidate.status === "done"))));
        case "audio":
            return Array.isArray(project?.audioCues) && project.audioCues.length > 0;
        case "assembly":
            return rows.length > 0 && rows.every((episode) => episode.status === "done");
        default:
            return false;
    }
}

/** 注入的 registry stages 规整为 `{ id, title, requires }`；缺 id 的项跳过（与 skills.js loadRegistry 同口径）。 */
function normalizeStages(stages) {
    const list = [];
    for (const item of Array.isArray(stages) ? stages : []) {
        const id = String(item?.id ?? "").trim();
        if (!id) continue;
        const requires = Array.isArray(item.requires) ? item.requires.map((dep) => String(dep ?? "").trim()).filter(Boolean) : [];
        list.push({ id, title: String(item?.title || id), requires });
    }
    return list;
}

export function deriveGates({ project, episodes, bibles, stages } = {}) {
    const notes = Array.isArray(project?.reviewNotes) ? project.reviewNotes : [];
    // 圣经实体：优先取显式入参；否则回落到 project.bibles（两种来源都支持，缺失即不约束）。
    const bibleRows = Array.isArray(bibles) ? bibles : Array.isArray(project?.bibles) ? project.bibles : [];
    // 无实体不约束：项目从未产出定妆身份卡时，casting 不作为上游阻断（旧项目行为逐字不变）。
    const castingConstrains = Array.isArray(project?.casting?.characters) && project.casting.characters.length > 0;
    const sequence = [PLAN_STAGE, ...normalizeStages(stages), POST_STAGE];
    const done = {};
    const gates = [];
    for (const stage of sequence) {
        const blockedBy = [];
        for (const upstream of stage.requires) {
            if (upstream === "casting" && !castingConstrains) continue;
            if (!done[upstream]) blockedBy.push({ type: "upstream", stageId: upstream });
        }
        for (const note of notes) {
            if (note && note.level === "block" && !note.resolvedAt && note.stage === stage.id) {
                blockedBy.push({ type: "review", noteId: note.id ?? null, message: String(note.message ?? "") });
            }
        }
        // P0-f：项目存在该阶段的圣经实体但尚未 approved/locked → 阻断（无实体则不产生约束）。
        for (const bible of bibleRows) {
            if (!bible || BIBLE_KIND_STAGE[bible.kind] !== stage.id) continue;
            if (isConsumable(bible.status)) continue;
            const label = BIBLE_KIND_LABEL[bible.kind] || bible.kind;
            blockedBy.push({ type: "bible", stageId: stage.id, bibleId: bible.id ?? null, kind: bible.kind, status: bible.status ?? null, message: `${label} 尚未批准（当前 ${bible.status || "draft"}）` });
        }
        const ready = blockedBy.length === 0;
        done[stage.id] = ready && hasOutput(stage.id, project, episodes);

        let reason = "";
        if (!ready) {
            const names = blockedBy.filter((item) => item.type === "upstream").map((item) => item.stageId);
            if (names.length) reason = `上游阶段未完成：${names.join("、")}`;
            const risks = blockedBy.filter((item) => item.type === "review").length;
            if (risks) reason = `${reason ? `${reason}；` : ""}存在未处理的阻断风险提示（${risks} 条）`;
            const unapproved = blockedBy.filter((item) => item.type === "bible");
            if (unapproved.length) reason = `${reason ? `${reason}；` : ""}圣经未批准：${unapproved.map((item) => item.message).join("、")}`;
            reason = reason || "被上游或风险提示阻断";
        } else {
            reason = "可进入（上游已就绪，无阻断风险）";
        }
        gates.push({ stageId: stage.id, title: stage.title, ready, reason, blockedBy, done: done[stage.id] });
    }
    return gates;
}

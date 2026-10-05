/**
 * 阶段产物契约校验（P0-g「统一 QC 门禁」的结构校验 + 引用完整性部分）。
 *
 * 依据 `development-plan.md` §8 P0-g：「结构校验、引用完整性、连续性…统一为可重放 QC 检查」
 * 与 §4.1「只有契约校验通过且所有必需 Job 成功才 `done`」。
 * 规则来源是各段 `skills/<阶段>/SKILL.md` 的输出契约 + `domain-contract.md` §3/§10/§11（该文档没有产物结构专章）。
 *
 * **纯函数**：只吃产物与上游产物，不读盘、不改状态。判级总则（防止误拦）：
 *  - 只有被引用集合**存在且非空**时，找不到 id 才判 error；集合缺失或为空只判 warn；
 *  - id 本身缺失（空串 / null）只判 warn；
 *  - 各段 SKILL.md 标注为可选增强的字段（cameraSpec / textOverlays / dialogueLines / negativePrompt /
 *    planSuggestion、artifact id 空串或空数组、jobId / artifactUrl / selected / candidates / url / manifestUrl、
 *    keyframeId=null）一律放过，不产生任何问题项。
 *
 * 不做的事：说话人合法性（casting.js 已枚举校验）、时长合计（pipeline.validateSkeleton 已算）、
 * 提示词编译（prompt-compiler.js 的活）——重复实现只会两处漂移。
 */

const IDLE_ROLES = new Set(["start", "end", "key"]);

const rows = (value) => (Array.isArray(value) ? value : []);
const list = (value) => rows(value);
const text = (value) => (typeof value === "string" ? value.trim() : "");
/** 一套 id 里出现过的非空取值。 */
const idSet = (items, pick = (item) => item?.id) => new Set(items.map((item) => text(pick(item))).filter(Boolean));

function duplicates(items) {
    const seen = new Set();
    const dup = new Set();
    for (const item of items) {
        const id = text(item);
        if (!id) continue;
        if (seen.has(id)) dup.add(id);
        seen.add(id);
    }
    return [...dup];
}

/**
 * 校验一个阶段的产物。
 * @param {string} stageId script / storyboard / design / casting / keyframe / audio / assembly
 * @param {unknown} output 该阶段产物
 * @param {Record<string, unknown>} [upstream] 上游产物，按阶段 id 取（script / storyboard / design / keyframe）
 * @returns {{ ok: boolean, errors: Array<{code: string, path: string, message: string}>, warnings: Array<{code: string, path: string, message: string}> }}
 */
export function checkStageArtifact(stageId, output, upstream = {}) {
    const errors = [];
    const warnings = [];
    const fail = (code, path, message) => errors.push({ code, path, message });
    const warn = (code, path, message) => warnings.push({ code, path, message });

    if (stageId === "script") checkScript(output, fail, warn);
    else if (stageId === "storyboard") checkStoryboard(output, upstream, fail, warn);
    else if (stageId === "design") checkDesign(output, upstream, fail, warn);
    else if (stageId === "casting") checkCasting(output, upstream, fail, warn);
    else if (stageId === "keyframe") checkKeyframe(output, upstream, fail, warn);
    else if (stageId === "audio") checkAudio(output, upstream, fail, warn);
    else if (stageId === "assembly") checkAssembly(output, upstream, fail, warn);

    return { ok: errors.length === 0, errors, warnings };
}

/** 把问题项压成一句可直接回给调用方的中文说明（门禁拒绝 / 人工改产物 400 都用它）。 */
export function formatArtifactErrors(errors = []) {
    const items = rows(errors);
    if (!items.length) return "";
    const head = items.slice(0, 3).map((item) => `${item.path}：${item.message}`);
    const rest = items.length > head.length ? `；另有 ${items.length - head.length} 处` : "";
    return `产物未通过契约校验（${items.length} 处）：${head.join("；")}${rest}`;
}

/** 引用完整性：被引用集合非空时才判 error，否则 warn。 */
function checkRef({ ref, refPath, targetIds, targetLabel, missingCode, fail, warn }) {
    const value = text(ref);
    if (!value) {
        warn(missingCode, refPath, `缺少 ${targetLabel} 引用`);
        return;
    }
    if (!targetIds.size) {
        warn(missingCode, refPath, `上游${targetLabel}集合为空，无法对账（引用 ${value}）`);
        return;
    }
    if (!targetIds.has(value)) fail(missingCode, refPath, `引用的 ${targetLabel}「${value}」不存在`);
}

function checkScript(output, fail, warn) {
    const scenes = list(output?.scenes);
    const characters = list(output?.characters);
    const episodes = list(output?.episodes);

    for (const id of duplicates(scenes.map((scene) => scene?.id))) fail("script.scene_duplicate", "scenes", `场次 id 重复：${id}`);
    for (const id of duplicates(characters.map((character) => character?.id))) fail("script.character_duplicate", "characters", `角色 id 重复：${id}`);
    for (const id of duplicates(episodes.map((episode) => episode?.id))) fail("script.episode_duplicate", "episodes", `分集 id 重复：${id}`);

    const sceneIds = idSet(scenes);
    episodes.forEach((episode, index) => {
        for (const sceneId of list(episode?.sceneIds).map(text).filter(Boolean)) {
            if (sceneIds.size && !sceneIds.has(sceneId)) fail("script.episode_scene_ref", `episodes[${index}].sceneIds`, `引用的场次「${sceneId}」不存在`);
        }
    });

    if (!scenes.length) warn("script.scenes_empty", "scenes", "没有任何场次");
    if (!episodes.length) warn("script.episodes_empty", "episodes", "没有分集（短篇可省略）");
    scenes.forEach((scene, index) => {
        if (!list(scene?.beats).some((beat) => text(beat))) warn("script.beats_empty", `scenes[${index}].beats`, "该场次没有节拍");
    });
}

function checkStoryboard(output, upstream, fail, warn) {
    const shots = list(output?.shots);
    const scriptScenes = idSet(list(upstream?.script?.scenes));
    const scriptEpisodes = idSet(list(upstream?.script?.episodes));

    for (const id of duplicates(shots.map((shot) => shot?.id))) fail("storyboard.shot_duplicate", "shots", `镜头 id 重复：${id}`);
    shots.forEach((shot, index) => {
        checkRef({ ref: shot?.sceneId, refPath: `shots[${index}].sceneId`, targetIds: scriptScenes, targetLabel: "剧本场次", missingCode: "storyboard.scene_ref", fail, warn });
        if (text(shot?.episodeId) && scriptEpisodes.size && !scriptEpisodes.has(text(shot.episodeId))) {
            warn("storyboard.episode_ref", `shots[${index}].episodeId`, `引用的分集「${shot.episodeId}」不在剧本分集里`);
        }
    });
}

function checkDesign(output, upstream, fail, warn) {
    const characters = list(output?.characters);
    const locations = list(output?.locations);
    const scriptCharacters = idSet(list(upstream?.script?.characters));

    for (const id of duplicates(characters.map((character) => character?.id))) fail("design.character_duplicate", "characters", `造型角色 id 重复：${id}`);
    for (const id of duplicates(locations.map((location) => location?.id))) fail("design.location_duplicate", "locations", `场景 id 重复：${id}`);

    characters.forEach((character, index) => {
        const id = text(character?.id);
        if (id && scriptCharacters.size && !scriptCharacters.has(id)) fail("design.character_ref", `characters[${index}].id`, `角色「${id}」不在剧本角色表里`);
        if (character?.confirmed === false) warn("design.character_unconfirmed", `characters[${index}].confirmed`, "造型尚未确认");
    });

    list(output?.references).forEach((reference, index) => {
        if (!text(reference?.artifactUrl)) warn("design.reference_pending", `references[${index}]`, `参考图尚未产出（${text(reference?.bindingId) || "未绑定"}）`);
    });
}

function checkCasting(output, upstream, fail, warn) {
    const cards = list(output?.characters);
    const scriptCharacters = idSet(list(upstream?.script?.characters));

    for (const id of duplicates(cards.map((card) => card?.characterId))) fail("casting.character_duplicate", "characters", `定妆角色 id 重复：${id}`);
    cards.forEach((card, index) => {
        const id = text(card?.characterId);
        if (id && scriptCharacters.size && !scriptCharacters.has(id)) warn("casting.character_ref", `characters[${index}].characterId`, `角色「${id}」不在剧本角色表里`);
    });
}

function checkKeyframe(output, upstream, fail, warn) {
    const frames = list(output?.frames);
    const shotIds = idSet(list(upstream?.storyboard?.shots));

    for (const id of duplicates(frames.map((frame) => frame?.id))) fail("keyframe.frame_duplicate", "frames", `关键帧 id 重复：${id}`);
    frames.forEach((frame, index) => {
        checkRef({ ref: frame?.shotId, refPath: `frames[${index}].shotId`, targetIds: shotIds, targetLabel: "分镜镜头", missingCode: "keyframe.shot_ref", fail, warn });
        const role = text(frame?.role);
        if (role && !IDLE_ROLES.has(role)) fail("keyframe.role", `frames[${index}].role`, `未知的帧角色「${role}」（只能是 start / end / key）`);
        if (!text(frame?.prompt)) warn("keyframe.prompt_empty", `frames[${index}].prompt`, "没有生图提示词");
    });
}

function checkAudio(output, upstream, fail, warn) {
    const cues = list(output?.audio);
    const shotIds = idSet(list(upstream?.storyboard?.shots));

    for (const id of duplicates(cues.map((cue) => cue?.id))) fail("audio.cue_duplicate", "audio", `配音条目 id 重复：${id}`);
    cues.forEach((cue, index) => {
        checkRef({ ref: cue?.shotId, refPath: `audio[${index}].shotId`, targetIds: shotIds, targetLabel: "分镜镜头", missingCode: "audio.shot_ref", fail, warn });
        const start = Number(cue?.startSec);
        const end = Number(cue?.endSec);
        if (Number.isFinite(start) && start < 0) fail("audio.time_range", `audio[${index}].startSec`, `起始时间为负：${start}`);
        else if (Number.isFinite(start) && Number.isFinite(end) && end <= start) fail("audio.time_range", `audio[${index}]`, `结束时间 ${end} 不晚于起始时间 ${start}`);
        if (!text(cue?.characterId)) warn("audio.character_missing", `audio[${index}].characterId`, "没有归属角色（跨镜音色可能漂移）");
        if (!text(cue?.text)) warn("audio.text_empty", `audio[${index}].text`, "没有台词正文");
    });
}

function checkAssembly(output, upstream, fail, warn) {
    const clips = list(output?.clips);
    const shotIds = idSet(list(upstream?.storyboard?.shots));
    const frameIds = idSet(list(upstream?.keyframe?.frames));

    for (const id of duplicates(clips.map((clip) => clip?.id))) fail("assembly.clip_duplicate", "clips", `片段 id 重复：${id}`);
    clips.forEach((clip, index) => {
        checkRef({ ref: clip?.shotId, refPath: `clips[${index}].shotId`, targetIds: shotIds, targetLabel: "分镜镜头", missingCode: "assembly.shot_ref", fail, warn });
        const keyframeId = text(clip?.keyframeId);
        if (!keyframeId) warn("assembly.keyframe_missing", `clips[${index}].keyframeId`, "没有起始关键帧（图生视频拿不到首帧）");
        else if (frameIds.size && !frameIds.has(keyframeId)) fail("assembly.keyframe_ref", `clips[${index}].keyframeId`, `引用的关键帧「${keyframeId}」不存在`);
        else if (!frameIds.size) warn("assembly.keyframe_ref", `clips[${index}].keyframeId`, `上游关键帧集合为空，无法对账（引用 ${keyframeId}）`);
        if (!text(clip?.artifactUrl)) warn("assembly.clip_pending", `clips[${index}].artifactUrl`, "片段尚未产出");
    });

    const clipIds = idSet(clips);
    for (const id of list(output?.assembly?.order).map(text).filter(Boolean)) {
        if (!clipIds.has(id)) warn("assembly.order_unknown", "assembly.order", `拼接顺序里出现未知片段「${id}」`);
    }
}

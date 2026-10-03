import type { AssetRef, Scene, Shot } from "@/types/domain";

import type { SceneWithShots, ShotPatchInput } from "@/services/api/projects";

/**
 * 分镜工作区纯函数：`Shot.storyboard`(unknown) 的读取、可编辑字段、排序与调序方案。
 * 不碰请求、不碰 React；`Shot.storyboard` 内部形态见 domain-contract §3.4 与 p0a-project-kernel-plan §3.2
 * （02 分镜契约 11 字段：id / sceneId / index / durationSec / shotSize / camera / action / dialogue / audio / prompt / negativePrompt）。
 */

/** 02 分镜契约里属于「分镜数据」的字段，补齐缺失值后供渲染与编辑。 */
export type ShotFields = {
    durationSec: number;
    shotSize: string;
    camera: string;
    action: string;
    dialogue: string;
    audio: string;
    prompt: string;
    negativePrompt: string;
};

/** 镜级就地编辑覆盖的字段（去掉 id / sceneId / index 这些结构位）。 */
export const EDITABLE_SHOT_FIELDS = ["durationSec", "shotSize", "camera", "action", "dialogue", "prompt"] as const;
export type EditableShotField = (typeof EDITABLE_SHOT_FIELDS)[number];

/** 景别枚举沿用 02 分镜技能（skills/02-storyboard/SKILL.md）。 */
export const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"];

/** 时长边界沿用 02 契约（1~8 秒）。 */
export const SHOT_DURATION_MIN = 1;
export const SHOT_DURATION_MAX = 8;

const asString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

/** 从 `Shot.storyboard`(unknown) 读出字段；storyboard 缺失时回退到镜顶层同名字段（读不到给空/0，不臆造）。 */
export function readShotFields(shot: Shot): ShotFields {
    const nested = shot.storyboard && typeof shot.storyboard === "object" ? (shot.storyboard as Record<string, unknown>) : {};
    const top = shot as unknown as Record<string, unknown>;
    const pick = (key: keyof ShotFields) => (nested[key] !== undefined ? nested[key] : top[key]);
    const duration = Number(pick("durationSec"));
    return {
        durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
        shotSize: asString(pick("shotSize")),
        camera: asString(pick("camera")),
        action: asString(pick("action")),
        dialogue: asString(pick("dialogue")),
        audio: asString(pick("audio")),
        prompt: asString(pick("prompt")),
        negativePrompt: asString(pick("negativePrompt")),
    };
}

/** 展示排序：按 index 升序，index 相同按 id 稳定；返回副本，不改原数组。 */
export function sortByIndex<T extends { index: number; id: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
}

/** 组 PATCH body：只带可编辑字段，时长收敛到 1~8 整数，其余去首尾空格。 */
export function buildShotPatch(fields: ShotFields): ShotPatchInput {
    const duration = Math.round(fields.durationSec);
    return {
        durationSec: Math.min(SHOT_DURATION_MAX, Math.max(SHOT_DURATION_MIN, duration || SHOT_DURATION_MIN)),
        shotSize: fields.shotSize.trim(),
        camera: fields.camera.trim(),
        action: fields.action.trim(),
        dialogue: fields.dialogue.trim(),
        prompt: fields.prompt.trim(),
    };
}

/**
 * 调序方案：与相邻镜交换 index，只产出 index 变更，绝不改 id。
 * 正常交换两条 index；若原 index 重复，则按位置重新编号（仍只改 index）保证能落位。
 */
export function planShotMove(shots: Shot[], shotId: string, delta: -1 | 1): Array<{ shotId: string; index: number }> {
    const ordered = sortByIndex(shots);
    const at = ordered.findIndex((shot) => shot.id === shotId);
    const target = at + delta;
    if (at < 0 || target < 0 || target >= ordered.length) return [];
    const a = ordered[at];
    const b = ordered[target];
    if (a.index !== b.index) {
        return [
            { shotId: a.id, index: b.index },
            { shotId: b.id, index: a.index },
        ];
    }
    return ordered.map((shot, position) => ({ shotId: shot.id, index: position + 1 }));
}

/** 用服务端返回的镜替换本地；未命中时原样返回。 */
export function replaceShotInScenes(scenes: SceneWithShots[], shot: Shot): SceneWithShots[] {
    return scenes.map((scene) =>
        scene.shots.some((item) => item.id === shot.id) ? { ...scene, shots: scene.shots.map((item) => (item.id === shot.id ? { ...item, ...shot } : item)) } : scene,
    );
}

/** 调序成功后按新 index 落位。 */
export function applyIndexesInScenes(scenes: SceneWithShots[], patches: Array<{ shotId: string; index: number }>): SceneWithShots[] {
    const byId = new Map(patches.map((patch) => [patch.shotId, patch.index]));
    return scenes.map((scene) => ({ ...scene, shots: scene.shots.map((shot) => (byId.has(shot.id) ? { ...shot, index: byId.get(shot.id) as number } : shot)) }));
}

/** 场级展示标题：地点 + 时间 + 意图拼装；都为空时回空字符串交给上层用空态。 */
export function sceneLabel(scene: Scene) {
    return [scene.locationId, scene.time, scene.intent].filter(Boolean).join(" · ");
}

/** 镜的关系摘要：场景 / 时长 / 景别 / 参考资产 / 关键帧 / 片段。 */
export type ShotRelation = {
    sceneLocation: string;
    sceneTime: string;
    durationSec: number;
    shotSize: string;
    assetRefs: AssetRef[];
    keyframeSlots: number;
    clipSlots: number;
};

/** 该镜适用的参考资产：镜级优先，其次场级、集级（更具体的引用覆盖更粗的）。 */
export function assetRefsForShot(refs: AssetRef[], shot: Shot): AssetRef[] {
    return refs.filter((ref) => {
        if (ref.shotId) return ref.shotId === shot.id;
        if (ref.sceneId) return ref.sceneId === shot.sceneId;
        if (ref.episodeId) return ref.episodeId === shot.episodeId;
        return false;
    });
}

/** 生成活扣归类：role 枚举属 P0-a 未冻结，按已知关键词归类，未知 role 不计入。 */
export function classifySlots(shot: Shot) {
    let keyframeSlots = 0;
    let clipSlots = 0;
    for (const slot of shot.generationSlots ?? []) {
        const role = String(slot.role ?? "").toLowerCase();
        if (/key|frame|start|end/.test(role)) keyframeSlots += 1;
        else if (/clip|video|segment|assembly/.test(role)) clipSlots += 1;
    }
    return { keyframeSlots, clipSlots };
}

/** 汇总一镜的关系摘要。 */
export function shotRelation(shot: Shot, scene: Scene | undefined, refs: AssetRef[]): ShotRelation {
    const fields = readShotFields(shot);
    const { keyframeSlots, clipSlots } = classifySlots(shot);
    return {
        sceneLocation: scene ? scene.locationId : "",
        sceneTime: scene ? scene.time : "",
        durationSec: fields.durationSec,
        shotSize: fields.shotSize,
        assetRefs: assetRefsForShot(refs, shot),
        keyframeSlots,
        clipSlots,
    };
}

/* ------------------------------------------------------------------ *
 * 节奏条 / 详情只读读取（cameraSpec / textOverlays / 景别族）
 * 02 契约里 cameraSpec、textOverlays 不属可编辑字段，这里只读展示，缺失留空、不臆造。
 * ------------------------------------------------------------------ */

const asText = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

/** 把 `Shot.storyboard`(unknown) 与镜顶层同名字段并成一份只读记录（顶层被嵌套覆盖）。 */
export function readStoryboardRaw(shot: Shot): Record<string, unknown> {
    const nested = shot.storyboard && typeof shot.storyboard === "object" ? (shot.storyboard as Record<string, unknown>) : {};
    return { ...(shot as unknown as Record<string, unknown>), ...nested };
}

/** 结构化机位（02 契约 cameraSpec）的只读展示形态；字段缺失留空，非对象返回 null。 */
export type ShotCameraSpecView = {
    position: string;
    height: string;
    angle: string;
    lens: string;
    aperture: string;
    movement: string;
    focus: string;
};

export function readCameraSpec(shot: Shot): ShotCameraSpecView | null {
    const raw = readStoryboardRaw(shot).cameraSpec;
    if (!raw || typeof raw !== "object") return null;
    const spec = raw as Record<string, unknown>;
    const focus = spec.focus && typeof spec.focus === "object" ? (spec.focus as Record<string, unknown>) : null;
    const movement = spec.movement && typeof spec.movement === "object" ? (spec.movement as Record<string, unknown>) : null;
    const focusText = focus
        ? [`${asText(focus.from)} → ${asText(focus.to)}`.replace(/^\s*→\s*/, "").trim(), focus.atSec !== undefined ? `@${asText(focus.atSec)}s` : ""].filter(Boolean).join(" ")
        : "";
    return {
        position: asText(spec.position),
        height: asText(spec.height),
        angle: asText(spec.angle),
        lens: asText(spec.lens),
        aperture: asText(spec.aperture),
        movement: movement ? [asText(movement.type), asText(movement.direction), asText(movement.speed), asText(movement.stabilization)].filter(Boolean).join(" · ") : "",
        focus: focusText,
    };
}

/** 画上文字清单（02 契约 textOverlays）；只保留确有文字且 kind≠none 的条目。 */
export type ShotTextOverlay = { text: string; kind: string; position: string; style: string };

export function readTextOverlays(shot: Shot): ShotTextOverlay[] {
    const raw = readStoryboardRaw(shot).textOverlays;
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((item) => item && typeof item === "object")
        .map((item) => {
            const row = item as Record<string, unknown>;
            return { text: asText(row.text), kind: asText(row.kind), position: asText(row.position), style: asText(row.style) };
        })
        .filter((row) => row.text.trim() !== "" && row.kind !== "none");
}

/** 截断长文本用于摘要（默认 48 字），不改语义、不补字。 */
export function truncateText(text: string, max = 48) {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 景别族：暖（近景/特写/细节）· 中性（中景系）· 冷（全景系）· 未知。节奏条据此着色。 */
export type ShotSizeFamily = "warm" | "neutral" | "cool" | "unknown";

export function shotSizeFamily(shotSize: string): ShotSizeFamily {
    const value = shotSize.trim();
    if (!value) return "unknown";
    // 中性先判：中近景/中全景含「近景/全景」字样，必须先归中性，避免被暖/冷抢先命中。
    if (/中近景|中全景|中远景|中景/.test(value)) return "neutral";
    if (/特写|近景|细节|微距/.test(value)) return "warm";
    if (/远景|全景/.test(value)) return "cool";
    return "unknown";
}

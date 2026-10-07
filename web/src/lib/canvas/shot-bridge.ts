import { readStoryboardRaw } from "@/pages/projects/storyboard-model";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasShotRef, Position } from "@/types/canvas";

/**
 * 画布 ↔ 流水线 双向桥（P2-B5）的**纯函数层**：只负责把分镜镜头变成节点、把节点变回 patch 体。
 * 不碰 React、不碰 store、不发请求 —— 这样它能被画布页、流水线页、Agent 三处复用，
 * 也便于用单测锁住形状（真机验证之外再加一道）。
 */

/**
 * 可从节点回写的镜头字段白名单（与服务端 episodes.js 的 SHOT_STORYBOARD_FIELDS 对齐）。
 * 多了会让服务端 400，少了会让用户改了却存不进去 —— 这份清单要与服务端**同一份**。
 */
const WRITABLE_SHOT_FIELDS = ["prompt", "negativePrompt", "action", "dialogue", "dialogueLines", "durationSec", "shotSize", "camera", "cameraSpec", "textOverlays", "audio"] as const;

/**
 * 镜头输入：项目侧 `Shot`（字段嵌在 `storyboard` 里）或流水线产物 shot（字段平铺）。
 *
 * **两种形状必须都支持** —— 这是本轮最贵的教训：原先只读顶层，于是「发到画布」
 * 投递 70 个镜全部读成 undefined，画布上出现 70 个**空白节点**；TypeScript 不报错
 * （有索引签名），而测试恰好用的是平铺数据，于是测试全绿、功能完全不可用。
 * 现在统一走 `readStoryboardRaw`（嵌套优先、顶层兜底），与项目工作区同一口径。
 */
export type StoryboardShot = {
    id: string;
    index?: number;
    episodeId?: string | null;
    sceneId?: string | null;
    // 声明为 unknown 而非 Record：domain-contract §3.4 里 Shot.storyboard 就是 unknown
    // （storyboard-model.ts:6 明写「读不安全的字段就按 unknown 收」）。
    // 声明得比现实乐观，调用方传真数据就编译不过 —— 类型不匹配在这里是好事，它拦住了一次「我以为它是对象」。
    storyboard?: unknown;
    [key: string]: unknown;
};

/** 读镜头字段：嵌套 storyboard 优先，顶层兜底（与项目工作区 readStoryboardRaw 同一口径）。 */
export function readShotContent(shot: StoryboardShot): Record<string, unknown> {
    return readStoryboardRaw(shot as never);
}

/** 取单个镜头字段（同样两处都读）。 */
function field(shot: StoryboardShot, key: string): unknown {
    return readShotContent(shot)[key];
}

/** 节点标题里带上集/场/镜序号，用户在画布上一眼认得出这是哪一镜。 */
export function shotNodeTitle(shot: StoryboardShot, episodeLabel?: string | null, sceneLabel?: string | null): string {
    const no = shot.index ?? "?";
    const where = [episodeLabel, sceneLabel].filter(Boolean).join(" / ");
    const base = `镜 ${no}${shot.id ? ` · ${shot.id}` : ""}`;
    return where ? `${where} · ${base}` : base;
}

/**
 * 镜头描述文本：把可视化字段拼成一段能读的说明，写进节点正文。
 *
 * **刻意不重复「生图提示词」**：它在 `metadata.shot.prompt` 里已经有了，
 * 而画布文本节点的「生成图片」动作取的是 `metadata.content`（正文）——
 * 正文里塞中文说明会让那一次生成拿中文当提示词，画出一坨废图。
 */
export function shotNodeText(shot: StoryboardShot): string {
    const lines: string[] = [];
    const shotSize = field(shot, "shotSize");
    const camera = field(shot, "camera");
    const durationSec = field(shot, "durationSec");
    const action = field(shot, "action");
    const dialogue = field(shot, "dialogue");
    if (shotSize) lines.push(`景别：${shotSize}`);
    if (camera) lines.push(`机位：${camera}`);
    if (durationSec != null && durationSec !== "") lines.push(`时长：${durationSec}s`);
    if (action) lines.push(`动作：${action}`);
    if (dialogue) lines.push(`台词：${dialogue}`);
    return lines.join("\n");
}

/**
 * 由分镜镜头构造一个画布文本节点（承载镜头说明）+ 归因。
 *
 * ref 只给「这一批的共同归属」（projectId/runId/…），**镜头 id 由本函数从 shot.id 填**：
 * 让调用方自己写 shotId 等于把最容易漏的一步交出去 —— 漏了就会产出一个「看起来是镜头节点、
 * 但回写时找不到对应镜头」的节点，而且没有任何报错。
 *
 * 为什么是**文本节点**而不是图片节点：分镜阶段根本没有图（参考图是关键帧阶段的事）。
 * 硬造一个图片节点只会得到一个空壳，反而是假数据。
 */
export function buildShotNode(shot: StoryboardShot, position: Position, ref: Omit<CanvasShotRef, "shotId">, labels?: { episode?: string | null; scene?: string | null }): CanvasNodeData {
    const content: NonNullable<CanvasNodeMetadata["shot"]> = {};
    const raw = readShotContent(shot);
    for (const name of WRITABLE_SHOT_FIELDS) {
        const value = raw[name];
        if (value === undefined || value === null || value === "") continue;
        (content as Record<string, unknown>)[name] = value;
    }
    const shotRef: CanvasShotRef = {
        ...ref,
        shotId: shot.id,
        episodeId: ref.episodeId ?? (shot.episodeId ? String(shot.episodeId) : undefined),
        sceneId: ref.sceneId ?? (shot.sceneId ? String(shot.sceneId) : undefined),
    };
    const metadata: CanvasNodeMetadata = {
        content: shotNodeText(shot),
        shotRef,
        shot: content,
        status: "success",
        // metadata.prompt 只给「查看/复制提示词」这类只读用途；
        // 文本节点的「生成图片」动作读的是 content，所以正文不放提示词（见上）。
        ...(content.prompt ? { prompt: String(content.prompt) } : {}),
    };
    return {
        id: `shot-${shot.id}-${Math.random().toString(36).slice(2, 7)}`,
        type: "text",
        title: shotNodeTitle(shot, labels?.episode, labels?.scene),
        position,
        width: 320,
        height: 200,
        metadata,
    };
}

/** 按 index 网格排布，避免「发到画布」全叠在原点。 */
export function shotGridPosition(index: number, gap = 380): Position {
    const columns = 4;
    return { x: (index % columns) * gap, y: Math.floor(index / columns) * gap };
}

/** 稳定序列化：对象键递归排序后再 stringify。语义相同、键序不同的对象必须判为相等。 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/**
 * 节点 → patch 体：只取白名单字段，且**只取与镜头原值不同的**。
 *
 * 为什么不整份 metadata.shot 传过去：服务端 patchStageShot / updateShot 都要过白名单，
 * 传错字段会被拒（run 侧更糟：它是浅合并，传错就静默污染产物）。
 * 逐字段比对新旧值也顺带避免了「同值回写」触发无谓的下游 stale 标记。
 */
export function shotPatchFromNode(node: CanvasNodeData, original: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const content = node.metadata?.shot;
    if (!content) return {};
    const patch: Record<string, unknown> = {};
    for (const name of WRITABLE_SHOT_FIELDS) {
        const next = (content as Record<string, unknown>)[name];
        if (next === undefined || next === null || next === "") continue;
        if (original && stableStringify(original[name]) === stableStringify(next)) continue;
        patch[name] = next;
    }
    return patch;
}

/** 节点是否带回写能力（两套命名空间各自的回写端点不同）。 */
export function shotRefOf(node: CanvasNodeData | null | undefined): CanvasShotRef | null {
    const ref = node?.metadata?.shotRef;
    if (!ref || typeof ref !== "object" || !ref.shotId) return null;
    return ref;
}

/** 镜头节点不该出现「用正文去生图」——分镜正文是中文说明，生成只会出废图。 */
export function isShotNode(node: CanvasNodeData | null | undefined): boolean {
    return shotRefOf(node) !== null;
}
/**
 * 「发到画布」投递去重：算出真正会新增的镜头。
 *
 * 为什么单独抽出来：画布页原先在 `setNodes` 回调里算完就拿**投递总数**去提示，
 * 于是重复投递同一集时一个节点都没新增，界面却提示「已排布 70 个镜头」。
 * 假反馈比不反馈更糟 —— 用户会以为已经排好了，然后去别处找镜头。
 *
 * 按 shotId 去重（不是按节点 id）：同一镜重复投递应当幂等，而不是叠出一堆同名节点。
 */
export function partitionDropShots<T extends { id: string }>(
    existingShotIds: Iterable<string>,
    incoming: readonly T[],
): { fresh: T[]; duplicateCount: number } {
    const seen = new Set(existingShotIds);
    const fresh: T[] = [];
    let duplicateCount = 0;
    for (const shot of incoming) {
        if (seen.has(shot.id)) {
            duplicateCount += 1;
            continue;
        }
        seen.add(shot.id);
        fresh.push(shot);
    }
    return { fresh, duplicateCount };
}

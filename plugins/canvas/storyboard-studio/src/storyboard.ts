// 分镜数据模型、解析、重排与本地体检规则(不调 LLM)。

export type Shot = {
    id: string; // sh1, sh2... 与排序位置一致
    index: number; // 从 1 严格递增
    sceneId?: string;
    durationSec: number; // 1~8
    shotSize: string; // 远景/全景/中景/近景/特写
    camera: string; // 运镜行为描述
    action: string; // 主体动作/表情
    dialogue: string; // 台词,可空
    audio: string; // 环境音/配乐说明,可空
    prompt: string; // 英文生图提示词
    negativePrompt?: string;
    imageNodeId?: string; // 试拍/关键帧关联的图片节点 id
    videoNodeId?: string; // 生视频关联的视频节点 id
    approved?: boolean; // 人工审核通过,缺省 false
};

export type Storyboard = { title?: string; shots: Shot[]; sourceFiles?: string[]; sourceText?: string };

export type ShotIssue = { level: "error" | "warn"; text: string };

export const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"];

export function emptyShot(): Omit<Shot, "id" | "index"> {
    return { durationSec: 4, shotSize: "中景", camera: "", action: "", dialogue: "", audio: "", prompt: "", negativePrompt: "" };
}

// metadata.storyboard 读出为 unknown,统一在这里断言并补齐字段
export function readStoryboard(raw: unknown): Storyboard {
    const obj = (raw && typeof raw === "object" ? raw : {}) as { title?: unknown; shots?: unknown; sourceFiles?: unknown; sourceText?: unknown };
    const shots = (Array.isArray(obj.shots) ? obj.shots : []).map(normalizeShot).filter((shot): shot is Shot => Boolean(shot));
    return {
        title: typeof obj.title === "string" ? obj.title : undefined,
        shots: reindex(shots),
        sourceFiles: Array.isArray(obj.sourceFiles) ? obj.sourceFiles.filter((f): f is string => typeof f === "string") : undefined,
        sourceText: typeof obj.sourceText === "string" ? obj.sourceText : undefined,
    };
}

function normalizeShot(raw: unknown): Shot | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const duration = Number(o.durationSec);
    return {
        id: str(o.id),
        index: Number(o.index) || 0,
        sceneId: str(o.sceneId) || undefined,
        durationSec: Number.isFinite(duration) ? Math.min(8, Math.max(1, Math.round(duration))) : 4,
        shotSize: str(o.shotSize) || "中景",
        camera: str(o.camera),
        action: str(o.action),
        dialogue: str(o.dialogue),
        audio: str(o.audio),
        prompt: str(o.prompt),
        negativePrompt: str(o.negativePrompt) || undefined,
        imageNodeId: str(o.imageNodeId) || undefined,
        videoNodeId: str(o.videoNodeId) || undefined,
        approved: Boolean(o.approved),
    };
}

// 增删调序后重排:id 与 index 保持 sh1..shN 连续
export function reindex(shots: Shot[]): Shot[] {
    return shots.map((shot, i) => ({ ...shot, id: `sh${i + 1}`, index: i + 1 }));
}

export function stripCodeFence(text: string): string {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    return (fenced ? fenced[1] : trimmed).trim();
}

export function parseStoryboard(text: string): Storyboard {
    return readStoryboard(JSON.parse(stripCodeFence(text)));
}

// ---------------------------------------------------------------------------
// 体检规则(纯本地)
// ---------------------------------------------------------------------------

const VAGUE_CAMERA_WORDS = ["电影感", "高级感", "氛围感", "电影级", "大片感", "质感", "唯美感"];

export function checkShot(shot: Shot): ShotIssue[] {
    const issues: ShotIssue[] = [];
    if (!shot.shotSize.trim()) issues.push({ level: "error", text: "缺少景别" });
    if (!shot.action.trim()) issues.push({ level: "error", text: "缺少动作/表情描述" });
    if (!shot.prompt.trim()) issues.push({ level: "error", text: "缺少英文生图 prompt" });
    if (!(shot.durationSec >= 1 && shot.durationSec <= 8)) issues.push({ level: "error", text: "时长需在 1~8 秒之间" });

    const camera = shot.camera.trim();
    if (!camera) {
        issues.push({ level: "error", text: "缺少运镜描述" });
    } else {
        if (camera.length < 8) issues.push({ level: "error", text: "运镜描述过短,应写清起点、方向、速度与落点" });
        const compact = camera.replace(/[\s,，。、/丨]+/g, "");
        const rest = VAGUE_CAMERA_WORDS.reduce((acc, word) => acc.split(word).join(""), compact);
        if (compact && !rest) issues.push({ level: "error", text: "运镜描述过于空泛(只有「电影感/高级感」类词汇)" });
    }

    if (shot.prompt.trim()) {
        const ascii = [...shot.prompt].filter((ch) => ch.charCodeAt(0) < 128).length;
        if (ascii / [...shot.prompt].length <= 0.7) issues.push({ level: "error", text: "prompt 应使用英文(ASCII 占比需超过 70%)" });
    }

    if (shot.dialogue.trim() && [...shot.dialogue].length > shot.durationSec * 6) issues.push({ level: "warn", text: "台词可能说不完(超过 时长×6 字/秒)" });
    if (shot.durationSec > 6) issues.push({ level: "warn", text: "超过 6 秒,建议拆镜" });
    return issues;
}

// ---------------------------------------------------------------------------
// LLM 提示词模板
// ---------------------------------------------------------------------------

export const STORYBOARD_PROMPT = `你是分镜师。把下面的剧本/小说拆成逐个镜头的分镜表。
要求：
1. 每个镜头只安排一个主运镜（推/拉/摇/移/跟/升降/固定），写清起点、方向、速度与落点。
2. durationSec 取 3~6；动作复杂或含台词的镜头可到 8，超过 8 必须拆镜。
3. prompt 用英文，结构：主体外观 + 服装 + 场景 + 动作 + 构图景别 + 光线氛围 + 画质词。
4. negativePrompt 用英文，覆盖：多手多指、面部畸变、文字水印、低清、过曝。
5. dialogue 只放本镜头实际说出的台词，没有就留空字符串。
6. 只输出 JSON 本体，不要 Markdown 代码块、不要解释：
{"shots":[{"id":"sh1","index":1,"sceneId":"sc1","durationSec":4,"shotSize":"中景","camera":"","action":"","dialogue":"","audio":"","prompt":"","negativePrompt":""}]}

原文：
<content>
{{上游文本}}
</content>`;

export const REWRITE_PROMPT = `你是分镜师。请按修改指令重写下面这个镜头，只输出该镜头的新 JSON 对象，不要 Markdown 代码块、不要解释。
字段结构保持不变，id 与 index 保持原值。prompt 与 negativePrompt 仍用英文。
修改指令：{{指令}}
当前镜头 JSON：
{{镜头}}
全部镜号顺序（仅供理解上下文，不要改变 index）：{{镜号}}`;

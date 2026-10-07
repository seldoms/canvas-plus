/**
 * 《喜宴之外》演示数据 —— 形状严格对齐后端真实契约：
 * - 镜头按后端现行存储放在「集级扁平 shots[]」，由 useStoryboard 同款逻辑按 sceneId 归位到场（清单 §4.4）。
 * - run 是执行记录，挂在 项目+集 之下；options.episodeId 标记生产范围。
 * - 模型按能力域分组：文本(LLM) / 图像模板 / 视频模板 / 音色库 —— 来源是 model-registry，不再读不存在的 family 字段（清单 §4.6/§4.7）。
 */

export type StageStatus = "pending" | "running" | "partial" | "done" | "error" | "blocked" | "canceled";

export interface MockEpisode {
    id: string;
    index: number;
    title: string;
    logline: string;
}

export interface MockScene {
    id: string;
    index: number;
    locationId: string;
    time: string;
    intent: string;
}

export interface MockShot {
    id: string;
    sceneId: string;
    index: number;
    storyboard: {
        shotSize?: string;
        camera?: string;
        action?: string;
        background?: string;
        dialogue?: string;
        durationSec?: number;
        characters?: string[];
    };
    status: StageStatus;
}

export interface MockRun {
    id: string;
    title: string;
    createdAt: string;
    episodeId: string;
    parentId?: string;
    snapshotVersion: number;
    stages: Record<string, StageStatus>;
}

export const PROJECT = {
    id: "proj-xizhi",
    title: "喜宴之外",
    styleAnchor: "电影感写实摄影 · 现代都市家庭伦理 · 纪录片质感",
    ratio: "9:16 竖屏",
    audioMode: "独立配音",
    episodeMinutes: 2,
    episodeCount: 10,
};

export const EPISODES: MockEpisode[] = [
    { id: "ep-01", index: 1, title: "缺席的座位", logline: "婚礼当天，陈默发现母亲把外婆的座位安排在了最远的角落。" },
    { id: "ep-02", index: 2, title: "旧围裙", logline: "外婆坚持要自己下厨做一道菜，林慧左右为难。" },
    { id: "ep-03", index: 3, title: "红包", logline: "赵建军和妻子为红包的数目在楼道里压低声音争执。" },
];

export const SCENES: MockScene[] = [
    { id: "sc-01", index: 1, locationId: "酒店宴会厅·外廊", time: "日", intent: "建立婚礼现场的喧闹与疏离" },
    { id: "sc-02", index: 2, locationId: "宴会厅·主桌区", time: "日", intent: "座位矛盾爆发" },
    { id: "sc-03", index: 3, locationId: "酒店后厨通道", time: "日", intent: "外婆的退场，情绪落点" },
];

export const SHOTS: MockShot[] = [
    {
        id: "sh-0101", sceneId: "sc-01", index: 1, status: "done",
        storyboard: { shotSize: "远景", camera: "固定", action: "宾客陆续入场，红色喜字在玻璃门上反光", background: "酒店宴会厅·外廊", durationSec: 3, characters: [] },
    },
    {
        id: "sh-0102", sceneId: "sc-01", index: 2, status: "done",
        storyboard: { shotSize: "中景", camera: "手持跟拍", action: "陈默搀着外婆穿过人群，外婆脚步慢", dialogue: "外婆：慢点走，不着急，让他们先忙。", durationSec: 4, characters: ["陈默", "外婆"] },
    },
    {
        id: "sh-0201", sceneId: "sc-02", index: 3, status: "done",
        storyboard: { shotSize: "近景", camera: "固定", action: "陈默看到桌牌，目光停在角落的位置", background: "主桌区桌牌特写", durationSec: 3, characters: ["陈默"] },
    },
    {
        id: "sh-0202", sceneId: "sc-02", index: 4, status: "partial",
        storyboard: { shotSize: "中景", camera: "缓推", action: "陈默走到林慧身边，压低声音", dialogue: "陈默：外婆的座位怎么在那边？\n林慧：今天人多，先安顿下来再说……", durationSec: 5, characters: ["陈默", "林慧"] },
    },
    {
        id: "sh-0301", sceneId: "sc-03", index: 5, status: "pending",
        storyboard: { shotSize: "全景", camera: "固定", action: "外婆独自走向后厨通道，背影被走廊灯拉长", background: "后厨通道", durationSec: 4, characters: ["外婆"] },
    },
    {
        id: "sh-0302", sceneId: "sc-03", index: 6, status: "pending",
        storyboard: { shotSize: "特写", camera: "固定", action: "外婆在窗边坐下，抚平围裙上的褶皱，望向远处的喧闹", dialogue: "外婆（自语）：坐哪儿都一样，看得见你们就行。", durationSec: 6, characters: ["外婆"] },
    },
];

export const RUNS: MockRun[] = [
    {
        id: "run-muw3op80-j5uhl", title: "第 1 集 · 完整闭环验收", createdAt: "2026-10-06 15:12", episodeId: "ep-01", snapshotVersion: 3,
        stages: { script: "done", storyboard: "done", design: "done", casting: "done", keyframe: "done", audio: "done", assembly: "done" },
    },
    {
        id: "run-muw4aa12-k8dpq", title: "第 1 集 · 重剪配音", createdAt: "2026-10-06 18:40", episodeId: "ep-01", parentId: "run-muw3op80-j5uhl", snapshotVersion: 3,
        stages: { script: "done", storyboard: "done", design: "done", casting: "done", keyframe: "done", audio: "running", assembly: "pending" },
    },
    {
        id: "run-muw6bb77-m2zxc", title: "第 2 集 · 初稿", createdAt: "2026-10-07 09:05", episodeId: "ep-02", snapshotVersion: 1,
        stages: { script: "done", storyboard: "running", design: "pending", casting: "pending", keyframe: "pending", audio: "pending", assembly: "pending" },
    },
];

export interface MockCharacter {
    id: string;
    name: string;
    tagline: string;
    faceConfirmed: boolean;
    voice: { speaker: string; language: string; design: string; speed: number };
    voiceConfirmed: boolean;
    gradient: string;
}

export const CHARACTERS: MockCharacter[] = [
    { id: "ch-chenmo", name: "陈默", tagline: "新郎，32 岁，克制内敛", faceConfirmed: true, voice: { speaker: "云野", language: "中文", design: "低沉平稳，压抑情绪时略微发紧", speed: 1.0 }, voiceConfirmed: true, gradient: "from-stone-700 to-stone-500" },
    { id: "ch-linhui", name: "林慧", tagline: "新娘，29 岁，干练周全", faceConfirmed: true, voice: { speaker: "晓萱", language: "中文", design: "清亮干脆，疲惫时尾音下沉", speed: 1.05 }, voiceConfirmed: true, gradient: "from-rose-800 to-rose-500" },
    { id: "ch-waipo", name: "外婆", tagline: "78 岁，从乡下来，安静坚韧", faceConfirmed: true, voice: { speaker: "祖母", language: "中文", design: "苍老缓慢，带轻微方言尾音", speed: 0.9 }, voiceConfirmed: false, gradient: "from-amber-800 to-amber-600" },
    { id: "ch-zhaojj", name: "赵建军", tagline: "陈默父亲，好面子", faceConfirmed: true, voice: { speaker: "铁军", language: "中文", design: "洪亮，习惯压别人半头", speed: 1.0 }, voiceConfirmed: true, gradient: "from-slate-700 to-slate-500" },
    { id: "ch-linjuan", name: "林娟", tagline: "陈默母亲，精明焦虑", faceConfirmed: false, voice: { speaker: "桂枝", language: "中文", design: "语速快，尾音上扬", speed: 1.1 }, voiceConfirmed: false, gradient: "from-orange-800 to-orange-500" },
    { id: "ch-xiaonuo", name: "小诺", tagline: "花童，7 岁", faceConfirmed: true, voice: { speaker: "童声·糖糖", language: "中文", design: "天真雀跃", speed: 1.0 }, voiceConfirmed: true, gradient: "from-sky-700 to-sky-500" },
    { id: "ch-zhaoxue", name: "赵雪", tagline: "伴娘，林慧表妹", faceConfirmed: true, voice: { speaker: "晓雪", language: "中文", design: "活泼，爱接话", speed: 1.05 }, voiceConfirmed: true, gradient: "from-teal-700 to-teal-500" },
    { id: "ch-lihao", name: "李昊", tagline: "伴郎，陈默发小", faceConfirmed: true, voice: { speaker: "阿灿", language: "中文", design: "松弛，带笑音", speed: 1.0 }, voiceConfirmed: true, gradient: "from-indigo-700 to-indigo-500" },
];

export interface MockAudioLine {
    id: string;
    shotId: string;
    character: string;
    text: string;
    design: string;
    speed: number;
    measuredSec?: number;
    plannedSec?: number;
    round: number;
    status: StageStatus;
}

export const AUDIO_LINES: MockAudioLine[] = [
    { id: "au-01", shotId: "sh-0102", character: "外婆", text: "慢点走，不着急，让他们先忙。", design: "苍老缓慢，带方言尾音", speed: 0.9, measuredSec: 3.8, plannedSec: 4, round: 2, status: "done" },
    { id: "au-02", shotId: "sh-0202", character: "陈默", text: "外婆的座位怎么在那边？", design: "压低声音，情绪发紧", speed: 1.0, measuredSec: 2.1, plannedSec: 2.5, round: 1, status: "done" },
    { id: "au-03", shotId: "sh-0202", character: "林慧", text: "今天人多，先安顿下来再说……", design: "疲惫，尾音下沉", speed: 1.05, measuredSec: 2.9, plannedSec: 2.5, round: 3, status: "error" },
    { id: "au-04", shotId: "sh-0302", character: "外婆", text: "坐哪儿都一样，看得见你们就行。", design: "自语，平静中带释然", speed: 0.9, round: 0, status: "pending" },
];

/**
 * 模型按能力域分组 —— 数据源是 GET /api/model-registry?category=…&enabled=true。
 * 形状对齐注册表条目：value=真实 name，base=分组标题，task=能力名，chips=能力标签。
 */
export interface MockModel {
    value: string;
    base: string;
    task: string;
    label: string;
    cloud?: boolean;
    chips: string[];
}

export const MODEL_GROUPS: Record<"text" | "image" | "video", MockModel[]> = {
    text: [
        { value: "qwen3.8-32b", base: "Qwen3.8 · 内网", task: "32B · 长文剧本", label: "Qwen3.8 32B · 长文剧本", chips: ["内网", "32k 上下文", "JSON 输出稳"] },
        { value: "qwen3.8-14b", base: "Qwen3.8 · 内网", task: "14B · 快速草稿", label: "Qwen3.8 14B · 快速草稿", chips: ["内网", "快 3 倍"] },
        { value: "glm-4.6", base: "GLM · 云端", task: "4.6 · 对白润色", label: "GLM 4.6 · 对白润色", cloud: true, chips: ["按 token 计费", "文学性强"] },
        { value: "deepseek-v3", base: "DeepSeek · 云端", task: "V3 · 结构推理", label: "DeepSeek V3 · 结构推理", cloud: true, chips: ["按 token 计费", "结构强"] },
    ],
    image: [
        { value: "img_qwen21_t2i_720", base: "Qwen-Image 2.1 · 本地 5060Ti", task: "文生图 · 720p 草稿", label: "Qwen-Image 2.1 · 720p 草稿", chips: ["本地", "≈8s/张", "图上中文稳"] },
        { value: "img_qwen21_t2i_1080", base: "Qwen-Image 2.1 · 本地 5060Ti", task: "文生图 · 1080p 成片", label: "Qwen-Image 2.1 · 1080p 成片", chips: ["本地", "≈22s/张"] },
        { value: "img_flux_dev", base: "FLUX.1 Dev · 本地", task: "质感优先", label: "FLUX.1 Dev · 质感优先", chips: ["本地", "需量化加载", "质感最佳"] },
    ],
    video: [
        { value: "vid_wan22_i2v", base: "Wan 2.2 · 本地 5060Ti", task: "I2V · 标准", label: "Wan 2.2 I2V · 标准", chips: ["本地", "5s/段", "768×1344"] },
        { value: "vid_wan22_kf2v", base: "Wan 2.2 · 本地 5060Ti", task: "KF2V · 首尾帧", label: "Wan 2.2 KF2V · 首尾帧", chips: ["本地", "首尾帧锁定"] },
        { value: "vid_h3_talk", base: "H3 Talk · 本地", task: "口型驱动", label: "H3 Talk · 口型驱动", chips: ["受限", "仅单人近景"] },
    ],
};

export const STAGES = [
    { id: "script", title: "剧本", modelDomain: "text" },
    { id: "storyboard", title: "分镜", modelDomain: "text" },
    { id: "design", title: "服化道", modelDomain: "text+image" },
    { id: "casting", title: "角色定妆", modelDomain: null },
    { id: "keyframe", title: "关键帧", modelDomain: "image" },
    { id: "audio", title: "配音", modelDomain: "voice" },
    { id: "assembly", title: "成片交付", modelDomain: "video" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

/**
 * prompt-compiler —— 后端「提示词编译器」（策略层）。
 *
 * 立身之本（产品负责人原话）：内容层只产出「模型无关的内容事实」（分镜/动作/机位/台词/文字），
 * **后端必须在「发起生成请求」那一刻，按所选模型的标准把内容编译成该模型要的提示词**，再发给模型接口。
 * 图片生成与视频生成一视同仁 —— 都要按各自模型的要求写。
 *
 * 本模块不自己发明规则：**一律以 `src/model-rules.js`（规则表只读查询层）分派**。
 *   模板名 --ruleKeyForTemplate--> 规则键 --> 该模型的 prompt 口径 / negativePolicy / textInImageRule / presetFor。
 *
 * 各模型口径（依据 config/model-prompt-rules.json 与 research/win147-comfyui）：
 *   · minimax_h3      → 本地字段口径：I2VA/FL2VA/L2VA 第一行是关键帧对齐指令行（时间两位小数、后空一行），
 *                       正文三字段固定顺序 integrated_multimodal_description / overall_soundscape /
 *                       non_diegetic_music；参考素材用 <Picture 1>；没有负面字段（negative=none），
 *                       负向约束并进正向句；运镜用官方词表（类型+幅度+速度）写成自然句式；
 *                       台词说话人稳定 ID (S1)、内容 <d>[English] ...</d> 逐字不翻译；描述总时长=目标时长。
 *   · qwen_image_2_1  → 官方口径是「英文长 prompt（400~500 词）+ 多参考图 <image1>~<image10>」。
 *                       官方实现是专用 PE 权重/改写器；本模块 sync 出口在**拿不到 llmCall 改写结果**时
 *                       退化为中文 + 显式 `[untranslated]` 标记（绝不假装已英文化）。
 *   · krea2_turbo / flux1_dev → 规则表明**仅英文有官方依据**：同样经改写器英文化；无 LLM 时中文 +
 *                       `[untranslated]` 标记（不得默默发中文）。FLUX 负面 = zero_out（官方反对负面）。
 *   · 其它模板（z_image_turbo / boogu_edit / scail2 / wan22_animate / upscale …）→ 通用兜底，
 *     与既有行为**逐字一致**（兼容红线）。
 *
 * 负面词：**一律按 negativePolicy(template) 分派**，旧的「英文负向词→中文映射表」已整块拆除：
 *   none → 无负面段（负向约束改写进正向句）；required/optional → 官方中文负面串；zero_out → 不产出。
 *
 * 入口（**必须返回字符串**，ComfyUI 槽语义不变）：
 *   compilePromptForTemplate({ template, family, shot, scene, characters, style, slots, overlays,
 *                              basePrompt, item, durationSec, rewrite, llmCall }) → string
 * async 出口（可选，能在调用方 await 时用官方改写器英文化）：
 *   compilePromptForTemplateAsync(input) → Promise<string>
 *
 * slots 约定（流水线在「发起生成请求」时按**本次实际注入的槽位**组装，见 pipeline.js generativePlan）：
 *   {
 *     images: [{ url, kind: 'first_frame'|'last_frame'|'input_image'|'reference', role?, name? }],
 *     transparent?: boolean,   // 仅 Qwen 系：需要透明背景
 *   }
 *
 * 纯函数、零外部依赖（只依赖本项目 model-rules / prompt-rewriter 两个只读模块）。
 */

import {
    ruleKeyForTemplate,
    rulesForTemplate,
    negativePolicy,
    textInImageRule,
    presetFor,
    h3DefaultProtocol,
    loadModelRules,
} from "./model-rules.js";
import { rewriterForTemplate, rewritePrompt } from "./prompt-rewriter.js";
import { splitDialogue } from "./audio.js";

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/**
 * 归一 style 参数的**唯一入口**（所有取 style.* 的位置都必须经此，不得直接 style?.anchor）。
 *
 * 为什么必须在这里挡（验收问题①）：若调用方把 `style` 传成**字符串**（如 `'写实电影感'`），
 * 那么 `style.anchor` 会沿原型链命中 `String.prototype.anchor`（一个函数），
 * `String(style.anchor)` 就会把 "function anchor() { [native code] }" 静默写进发给模型的提示词。
 * 因此这里对每个字段断言 `typeof === "string"`：**任何情况下都不得把函数/对象强转进提示词**。
 *
 * 口径：
 *   · style 是字符串 → 视为纯风格锚点文本（等价 `{ anchor: style }`）；
 *   · style 是对象     → 只取**字符串类型**的 anchor / context / filmLayer，非字符串字段一律视为空；
 *   · null / undefined / 数字 / 布尔等其它 → 全部为空串（既有「空 style 原样返回」回退行为不变）。
 * @returns {{ anchor: string, context: string, filmLayer: string }}
 */
export function readStyleFields(style) {
    if (typeof style === "string") return { anchor: style.trim(), context: "", filmLayer: "" };
    if (style && typeof style === "object") {
        const pick = (value) => (typeof value === "string" ? value.trim() : "");
        return { anchor: pick(style.anchor), context: pick(style.context), filmLayer: pick(style.filmLayer) };
    }
    return { anchor: "", context: "", filmLayer: "" };
}

/** 生成提示词的风格出口（唯一）：首句锚点只在这里保证在场。与 pipeline.withPromptHead 同口径。 */
export function styleHead(style, text) {
    const body = String(text ?? "").trim();
    const { anchor, context, filmLayer } = readStyleFields(style);
    let head;
    if (!context) head = body;
    else if (anchor && body.startsWith(anchor)) head = body; // 锚点已在首句 → 不重复前置
    else head = body ? `${context}。${body}` : context;
    return filmLayer ? `${head} ${filmLayer}`.trim() : head;
}

/** 归一为字符串数组（去空、去非字符串）。 */
function asTextList(value) {
    return (Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/** 去尾标点，便于把一句话嵌进更长的句子。 */
function stripTail(text) {
    return String(text ?? "").trim().replace(/[。．.，,；;、\s]+$/u, "");
}

/** 文本是否有实质内容。 */
function hasText(value) {
    return String(value ?? "").trim().length > 0;
}

/** 秒数格式化为**两位小数**（H3 铁律：时间精确到两位小数）。 */
function fmt2(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : "0.00";
}

/** 秒数 → `MM:SS.mmm` 时间码（H3 切镜点用，如 3.5 → 00:03.500）。 */
function fmtTimecode(value) {
    const n = Number(value);
    const total = Number.isFinite(n) && n > 0 ? n : 0;
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
}

/** 秒数格式：1.5 → "1.5"，5 → "5"（通用辅助，非 H3 铁律口径）。 */
function fmtSec(value) {
    const n = Math.round(Number(value) * 10) / 10;
    return Number.isFinite(n) ? String(n) : "0";
}

/* ------------------------------------------------------------------ *
 * 规则解析：模板名 → 规则对象（先走规则查询层；再允许「直接以规则键调用」）
 * ------------------------------------------------------------------ */

/**
 * 取某模板的规则对象。
 * 优先 `rulesForTemplate`（模板名 → 规则键的官方映射）；映射不到时，允许把**规则键本身**
 * （如 `wan21_t2v`）当作模板名直接查表 —— 便于按模型键直接验证负面分派，不绕过规则查询层。
 */
function ruleForTemplate(templateName) {
    const mapped = rulesForTemplate(templateName);
    if (mapped) return mapped;
    const name = String(templateName ?? "").trim();
    if (!name) return null;
    const models = loadModelRules().models;
    const direct = models && typeof models === "object" ? models[name] : null;
    return direct && typeof direct === "object" ? { key: name, ...direct } : null;
}

/** 该模板要求的**正文字**（改写目标语言）：'en' 表示官方仅英文有依据。 */
function rewriteTargetLang(templateName) {
    const rule = ruleForTemplate(templateName);
    const to = rule?.prompt?.translate_to;
    return to === "en" ? "en" : null;
}

/**
 * 负面段（按 negativePolicy 分派）。
 *   none     → 无独立负面段（负向约束由各编译器改写成正向句）；
 *   required → 官方中文负面串（negative_default）；
 *   optional → 官方负面串（有默认值才写）；
 *   zero_out → 官方反对负面、条件清零 → 不产出（FLUX）。
 * @returns {string} 负面段（整行，含字段名）或空串
 */
export function negativeClause(templateName) {
    const np = negativePolicy(templateName);
    const rule = ruleForTemplate(templateName);
    const policy = np?.negative ?? rule?.prompt?.negative ?? null;
    const defaultText = np?.negative_default ?? rule?.prompt?.negative_default ?? null;
    if (policy === "required" || policy === "optional") {
        return hasText(defaultText) ? `negative_prompt: ${String(defaultText).trim()}` : "";
    }
    // none（H3 / Qwen 2.1 / Krea2 / Z-Image）与 zero_out（FLUX）都不产出独立负面段。
    return "";
}

/** 参数档：按规则表取 speed / quality 预设（不硬编码 steps/cfg/sampler）。 */
export function presetForTemplate(templateName, mode = "speed") {
    return presetFor(templateName, mode);
}

/* ------------------------------------------------------------------ *
 * textOverlays：模型无关的「图上文字」，按 textInImageRule 逐模型落地
 * ------------------------------------------------------------------ */

/** kind → 中文语义前缀（中文提示词 / 通用兜底用）。 */
const OVERLAY_KIND_CN = Object.freeze({
    sign: "招牌文字",
    ticket: "票据文字",
    screen: "屏幕文字",
    logo: "标识文字",
    subtitle: "字幕",
});

/** kind → 英文语义前缀（英文提示词 / 通用兜底用）。 */
const OVERLAY_KIND_EN = Object.freeze({
    sign: "sign reading",
    ticket: "ticket text",
    screen: "screen text",
    logo: "logo text",
    subtitle: "subtitle text",
});

/** kind → 英文**载体**名（H3 画面文字自然句式用）。 */
const OVERLAY_CARRIER_EN = Object.freeze({
    sign: "sign",
    ticket: "ticket",
    screen: "screen",
    logo: "logo",
    subtitle: "subtitle",
});

/** 取有效文字层：text 非空且 kind !== none。 */
function effectiveOverlays(overlays) {
    const out = [];
    for (const raw of Array.isArray(overlays) ? overlays : []) {
        if (!raw || typeof raw !== "object") continue;
        const text = raw.text === undefined || raw.text === null ? "" : String(raw.text);
        if (!text.trim()) continue;
        const kind = String(raw.kind ?? "").trim().toLowerCase();
        if (!kind || kind === "none") continue;
        out.push({ text, kind, position: String(raw.position ?? "").trim(), style: String(raw.style ?? "").trim() });
    }
    return out;
}

/** 英文「图上文字」子句（与 pipeline.textOverlayClause 逐字同口径，供通用兜底编译器复用）。 */
function overlayClauseEn(overlays) {
    const items = effectiveOverlays(overlays);
    if (!items.length) return "";
    const parts = items.map((item) => {
        const label = OVERLAY_KIND_EN[item.kind] || "text";
        return `${label} "${item.text}"${item.position ? ` at ${item.position}` : ""}${item.style ? ` in ${item.style}` : ""}`;
    });
    return `on-screen text rendered verbatim: ${parts.join(", ")}`;
}

/** 中文「图上文字」子句（通用/中文提示词兜底用）。 */
function overlayClauseCn(overlays) {
    const items = effectiveOverlays(overlays);
    if (!items.length) return "";
    const parts = items.map((item) => {
        const label = OVERLAY_KIND_CN[item.kind] || "画面文字";
        const meta = [];
        if (item.position) meta.push(`位置：${item.position}`);
        if (item.style) meta.push(`样式：${item.style}`);
        return `${label}「${item.text}」${meta.length ? `（${meta.join("，")}）` : ""}`;
    });
    return `画面中必须清晰呈现以下文字，逐字准确、不增删、不错字：${parts.join("、")}`;
}

/**
 * H3 画面文字（textInImageRule：英文双引号包原文，逐字不翻译）：
 * `A red neon sign reading "营业中"`。
 */
function overlayClauseH3(overlays, textInImage) {
    const items = effectiveOverlays(overlays);
    if (!items.length) return "";
    // 规则表未定义画面文字口径（如 WanAnimate/SCAIL-2）→ 退回通用英文逐字口径，保证不丢字。
    if (!hasText(textInImage)) return overlayClauseEn(overlays);
    const parts = items.map((item) => {
        const carrier = OVERLAY_CARRIER_EN[item.kind] || "surface";
        const where = item.position ? ` (${item.position})` : "";
        return `A ${carrier}${where} reading "${item.text}"`;
    });
    return `On-screen text kept verbatim: ${parts.join("; ")}.`;
}

/* ------------------------------------------------------------------ *
 * 素材说明：按「本次实际注入的槽位」生成编号与用途
 * ------------------------------------------------------------------ */

/** 有序图片槽位（保留 url 存在的项）。 */
function slotImages(slots) {
    return (Array.isArray(slots?.images) ? slots.images : []).filter((img) => img && hasText(img.url));
}

/** 槽位是否为首帧（first_frame / input_image 都代表「起始底图」）。 */
function isFirstFrame(image) {
    return image?.kind === "first_frame" || image?.kind === "input_image";
}

/**
 * H3 关键帧对齐指令行（I2VA/FL2VA/L2VA 的第一行，时间两位小数）。
 * 官方原文口径见 config/model-prompt-rules.json · h3_prompt_protocols.local_fields.keyframe_alignment_line。
 * @returns {string} 指令行；T2VA 返回空串（无此行）
 */
export function h3AlignmentLine(mode, durationSec) {
    const dur = fmt2(durationSec);
    if (mode === "I2VA") {
        return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
    }
    if (mode === "FL2VA") {
        return (
            "How the reference pictures align with the target video — " +
            `Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; ` +
            `Picture 2 (from Shot 1) aligns with the ${dur}-second mark of the target video.`
        );
    }
    if (mode === "L2VA") {
        return "How the reference pictures align with the target video — " + `<Picture 1> (from [Shot 1]) aligns with the ${dur}-second mark of the target video.`;
    }
    return "";
}

/**
 * 判定 H3 输入模式（决定是否写关键帧对齐指令行、写几段图）。
 * 依据：模板名意图优先，本次实际注入的槽位兜底。
 */
export function h3Mode(template, images = []) {
    const name = String(template ?? "").toLowerCase();
    const kinds = images.map((image) => image.kind);
    const hasFirst = kinds.some((kind) => kind === "first_frame" || kind === "input_image");
    const hasLast = kinds.includes("last_frame");
    if (/ref2v|r2v/.test(name)) return "Ref2VA";
    if (/fl2v|i2v[_-]?fl|first[_-]?last/.test(name)) return "FL2VA";
    if (/(^|[_/-])l2v/.test(name)) return "L2VA";
    if (/(^|[_/-])t2v/.test(name) && !hasFirst && !hasLast) return "T2VA";
    // 模板名点明 i2v（图生视频）→ 默认 I2VA；本次实际注入了尾帧则按槽位升级为 FL2VA/L2VA。
    if (/i2v/.test(name)) {
        if (hasFirst && hasLast) return "FL2VA";
        if (hasLast && !hasFirst) return "L2VA";
        return "I2VA";
    }
    if (hasFirst && hasLast) return "FL2VA";
    if (hasLast && !hasFirst) return "L2VA";
    if (hasFirst) return "I2VA";
    return "T2VA";
}

/* ------------------------------------------------------------------ *
 * 运镜：cameraSpec / 自然语言 camera → H3 官方运镜词表（类型+幅度+速度）
 * ------------------------------------------------------------------ */

/** 方向词归一（left/right/up/down/in/out）。 */
function dirWord(direction, fallback) {
    const text = String(direction ?? "").toLowerCase();
    for (const word of ["left", "right", "up", "down"]) if (text.includes(word)) return word;
    if (text.includes("in")) return "in";
    if (text.includes("out")) return "out";
    return fallback;
}

/** movement.type → 官方运镜自然句式（不含幅度/速度）。 */
const CAMERA_MOTION = Object.freeze({
    static: () => "holds a static shot",
    pan: (d) => `pans ${dirWord(d, "right")}`,
    tilt: (d) => `tilts ${dirWord(d, "up")}`,
    truck: (d) => `trucks ${dirWord(d, "right")}`,
    tracking: () => "follows the subject in a tracking shot",
    dolly: () => "moves with the subject",
    push: () => "pushes in",
    pull: () => "pulls out",
    zoom: (d) => `zooms ${dirWord(d, "in") === "out" ? "out" : "in"}`,
    pedestal: (d) => `pedestals ${dirWord(d, "up")}`,
    crane: () => "rises in a crane shot",
    arc: () => "moves in an arc shot around the subject",
    handheld: () => "holds a slightly shaking handheld shot",
    shake: () => "shakes slightly",
    pov: () => "presents a POV shot",
    roll: (d) => `rolls ${/counter|ccw/.test(String(d ?? "").toLowerCase()) ? "counterclockwise" : "clockwise"}`,
});

/** movement.speed → 官方速度词（medium/normal 省略不写）。 */
function speedPhrase(speed) {
    const text = String(speed ?? "").toLowerCase();
    if (text === "slow") return "at slow speed";
    if (text === "fast") return "at fast speed";
    return "";
}

/** movement.amplitude → 官方幅度词（medium 省略不写）。 */
function amplitudePhrase(amplitude) {
    const text = String(amplitude ?? "").toLowerCase();
    if (text === "small") return "with small amplitude";
    if (text === "large") return "with large amplitude";
    return "";
}

/**
 * 由 cameraSpec 编出**英文自然句式**运镜句（官方要求：类型+幅度+速度三维、写成自然句式而非堆标签）。
 * 无结构信息时回落 shot.camera 自然语言（原样）。
 */
export function cameraSentence(shot) {
    const spec = shot?.cameraSpec && typeof shot.cameraSpec === "object" ? shot.cameraSpec : null;
    const movement = spec?.movement && typeof spec.movement === "object" ? spec.movement : null;
    if (movement && hasText(movement.type)) {
        const type = String(movement.type).trim().toLowerCase();
        const render = CAMERA_MOTION[type];
        const motion = render ? render(movement.direction) : `${type} ${dirWord(movement.direction, "")}`.trim();
        // 固定机位本身没有幅度/速度维度：只写 `holds a static shot`，不硬凑 at slow speed。
        const extras = type === "static" ? [] : [amplitudePhrase(movement.amplitude), speedPhrase(movement.speed)].filter(Boolean);
        return `The camera ${motion}${extras.length ? ` ${extras.join(" ")}` : ""}.`;
    }
    if (hasText(shot?.camera)) return `The camera: ${stripTail(shot.camera)}.`;
    return "";
}

/** 景别 → 英文官方词（全景→wide shot …）；未知景别原样保留。 */
const SHOT_SIZE_EN = Object.freeze({
    大远景: "extreme long shot",
    远景: "extreme long shot",
    全景: "wide shot",
    中全景: "medium-wide shot",
    中景: "medium shot",
    中近景: "medium close-up",
    近景: "close shot",
    特写: "close-up",
    大特写: "extreme close-up",
});

function shotSizeEn(shot) {
    const size = hasText(shot?.shotSize) ? String(shot.shotSize).trim() : "";
    if (!size) return "";
    return SHOT_SIZE_EN[size] || size;
}

/* ------------------------------------------------------------------ *
 * 负向约束（none 策略）→ 正向句：**不做英文负向词到中文的逐词映射**
 * 规则表口径：H3/Qwen 没有独立负向槽，负向约束并进正向句；只写**通用、正向框架**的洁净约束，
 * 不搬运 shot.negativePrompt 里的英文词表（那些是写给生图模型的，cfg=1 下本就无效）。
 * ------------------------------------------------------------------ */

/** 正片洁净约束（中文、通用，不含任何具体英文负向词）。 */
const CLEAN_FRAME_CN = "画面保持干净稳定，避免畸形肢体、多余手指、水印与文字乱码";

function positiveCleanClause() {
    return CLEAN_FRAME_CN;
}

/* ------------------------------------------------------------------ *
 * 动作 / 台词
 * ------------------------------------------------------------------ */

const END_STATE_RE = /段末(?:可见)?状态\s*[：:]/;

/** 剥离「段末可见状态：…」，返回 { process, endState }。 */
function splitEndState(action) {
    const text = String(action ?? "").trim();
    if (!text) return { process: "", endState: "" };
    const match = END_STATE_RE.exec(text);
    if (!match) return { process: text, endState: "" };
    return { process: text.slice(0, match.index).trim(), endState: text.slice(match.index + match[0].length).trim() };
}

/**
 * 拆分分镜台词：**复用 audio.js 的 splitDialogue**（#50 的产物），不另写括号解析。
 *
 * 为什么要拆（验收问题②）：`shot.dialogue` 常写成
 * 「姑娘，这么晚，去哪儿？（低声、音量低、语速慢、略带关心）」——括号里是表演注解。
 * 调研口径（config/model-prompt-rules.json · minimax_h3.prompt.structure_notes，依据 sources/video-models.md:160）
 * 要求 `<d>[English] ...</d>` 内**逐字是台词正文**；把注解留在 `<d>` 内会被模型当台词读出来。
 * 按 #50 的定论「表演注解不参与生产参数」，注解应剥出、移到描述层作表演提示，绝不塞回 `<d>`。
 *
 * @returns {{ text: string, performance: string, hasText: boolean }}
 *   text=纯台词正文；performance=表演注解（无则空串）；
 *   hasText=false 表示整条只有注解、无正文（splitDialogue 以 warning code=empty_after_cleaning 标记回退原文）。
 */
function splitShotDialogue(raw) {
    const source = typeof raw === "string" ? raw.trim() : "";
    if (!source) return { text: "", performance: "", hasText: false };
    const { text, performance, warnings } = splitDialogue(source);
    // splitDialogue 在「剥完为空」时会回退原文并给出 warning —— 据此判定「整条只有注解」，
    // 让 <d> 块整块不输出（不得输出空的 `<d>[English] </d>`）。
    const onlyAnnotation = warnings.some((entry) => entry?.code === "empty_after_cleaning");
    const script = onlyAnnotation ? "" : text.trim();
    return { text: script, performance: String(performance ?? "").trim(), hasText: script.length > 0 };
}

/**
 * 表演提示句（描述层）：注解按调研口径并入 integrated_multimodal_description，
 * **绝不塞回 `<d>` 内**。无注解返回空串。
 */
function h3PerformanceHint(shot) {
    const { performance } = splitShotDialogue(shot?.dialogue);
    return hasText(performance) ? `Performance: ${stripTail(performance)}.` : "";
}

/** 说话人 ID：按出场顺序稳定编号 (S1)(S2)…（H3 官方要求同一说话人跨镜保持同 ID）。 */
export function speakerId(index) {
    return `S${Math.max(0, Number(index) || 0) + 1}`;
}

/** 取镜头涉及的角色名（稳定顺序）。 */
function characterNames(characters) {
    return (Array.isArray(characters) ? characters : []).map((entry) => String(entry?.name ?? "").trim()).filter(Boolean);
}

/**
 * 选说话人：优先 action/dialogue 中点名的角色；否则取该镜第一个角色；再否则中性称谓。
 * 返回 { name, id }。
 */
function pickSpeaker(shot, characters) {
    const names = characterNames(characters);
    const haystack = `${String(shot?.action ?? "")} ${String(shot?.dialogue ?? "")}`;
    const named = names.find((name) => name && haystack.includes(name));
    const name = named || names[0] || "The speaker";
    const index = Math.max(0, names.indexOf(name));
    return { name, id: speakerId(index) };
}

/**
 * H3 台词句（正文逐字不翻译、**不含表演注解**）：
 *   `<角色> (S1) says: <d>[English] ...</d>`；画外音写 `says in an off-screen voiceover` 且紧跟「嘴唇保持闭合」。
 * 括号表演注解已由 splitShotDialogue 剥出（见 h3PerformanceHint 写进描述层）；
 * 整条只有注解、无正文时返回空串（`<d>` 块整块不输出）。
 */
export function h3DialogueSentence(shot, characters, { voiceover = false } = {}) {
    const { text, hasText: hasLine } = splitShotDialogue(shot?.dialogue);
    if (!hasLine) return "";
    const { name, id } = pickSpeaker(shot, characters);
    const isVoiceover = voiceover || shot?.voiceover === true || /画外音|旁白|off-?screen/.test(`${shot?.audio ?? ""} ${shot?.action ?? ""}`);
    const tag = isVoiceover ? "says in an off-screen voiceover" : "says";
    const block = `${name} (${id}) ${tag}: <d>[English] ${text}</d>`;
    return isVoiceover ? `${block}, while the lips remain completely closed.` : `${block}`;
}

/* ------------------------------------------------------------------ *
 * 编译器 1：H3 系（minimax_h3）—— 本地字段口径
 * ------------------------------------------------------------------ */

/** H3 overall_soundscape：1–4 句环境声/动作声/非语言人声，**不含台词**；无内容写 N/A。 */
function h3Soundscape(shot) {
    const audio = String(shot?.audio ?? "").trim();
    const cleaned = audio
        .replace(/[；;]?\s*本镜[有无]对白[。.，,]?/gu, "")
        .replace(/[；;]?\s*本镜无对白[。.]?/gu, "")
        .trim();
    return hasText(cleaned) ? cleaned : "N/A";
}

/** H3 non_diegetic_music：默认 N/A（不要 BGM 就写 N/A）；仅当内容层显式给出配乐才写。 */
function h3Music(shot) {
    const music = String(shot?.nonDiegeticMusic ?? shot?.music ?? "").trim();
    return hasText(music) ? music : "N/A";
}

/**
 * H3 integrated_multimodal_description 正文（英文结构 + 内容层事实原语言）。
 * 单镜写 [Shot 1]；多镜按 shot.cuts（[{ atSec, text }]）在文件内写清切镜点（两位小数时间码）。
 */
function h3Description(shot, { scene, characters, style, mode, durationSec, overlays, textInImage }) {
    const parts = [];
    const { anchor: styleAnchor } = readStyleFields(style);
    // [Shot 1] 头部：风格 + 初始构图。
    const headBits = ["Live-action, cinematic"];
    const size = shotSizeEn(shot);
    const place = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const subjectClause = [size ? `a ${size}` : "a shot", place ? `set in ${place}` : ""].filter(Boolean).join(" ");
    parts.push(`[Shot 1] ${headBits.join(", ")}, ${styleAnchor ? `${stripTail(styleAnchor)}. ` : ""}${subjectClause}.`);
    // 动作过程（内容层事实原样）。
    const { process, endState } = splitEndState(shot?.action);
    if (hasText(process)) parts.push(`${stripTail(process)}.`);
    // 运镜（官方词表自然句式）。
    const camera = cameraSentence(shot);
    if (camera) parts.push(camera);
    // 参考图对齐（关键帧模式）。
    if (mode === "I2VA") parts.push("The frame begins from <Picture 1>, preserving its composition, subjects, colours, and lighting.");
    if (mode === "FL2VA") parts.push("The motion runs continuously from Picture 1 to Picture 2 with no cut in between.");
    if (mode === "L2VA") parts.push("The described action gradually converges to <Picture 1> at the end of the video.");
    // 多场景：显式切镜点（两位小数时间码）。
    const cuts = Array.isArray(shot?.cuts) ? shot.cuts : [];
    cuts.forEach((cut, index) => {
        if (!cut || !hasText(cut.text)) return;
        parts.push(`[Shot ${index + 2}] At ${fmtTimecode(cut.atSec)}, the camera cuts to ${stripTail(cut.text)}.`);
    });
    // 段末可见状态。
    if (hasText(endState)) parts.push(`By the end of the shot, ${stripTail(endState)}.`);
    // 台词（正文逐字不翻译；括号表演注解已被剥出）。
    const dialogue = h3DialogueSentence(shot, characters);
    if (dialogue) {
        parts.push(dialogue);
        // 表演注解 → 描述层作表演提示（绝不塞回 <d>）。仅在有台词正文时输出：
        // 整条只有注解、无正文时 <d> 块整块不输出，也不该为不存在的台词写表演提示。
        const performance = h3PerformanceHint(shot);
        if (performance) parts.push(performance);
    }
    // 画面文字（英文双引号包原文）。
    const overlay = overlayClauseH3(overlays, textInImage);
    if (overlay) parts.push(overlay);
    // 负向约束并进正向句（negative=none；不做英文负向词映射）。
    if (stringNegativeList(shot).length) parts.push(`${positiveCleanClause()}。`);
    return parts.filter(Boolean).join(" ");
}

/** shot.negativePrompt（字符串或数组）→ 字符串数组（仅用于「是否存在负向意图」判定）。 */
function stringNegativeList(shot) {
    const raw = shot?.negativePrompt ?? shot?.negative_prompt;
    if (Array.isArray(raw)) return asTextList(raw);
    if (hasText(raw)) return [String(raw).trim()];
    return [];
}

/**
 * H3 编译器：本地字段口径（T2VA/I2VA/FL2VA/L2VA 三字段；Ref2VA 六段）。
 * @returns {string}
 */
export function compileH3VideoPrompt({ template, shot, scene, characters, style, slots, overlays, durationSec } = {}) {
    const seconds = Number(durationSec) > 0 ? Number(durationSec) : Number(shot?.durationSec) > 0 ? Number(shot.durationSec) : 5;
    const images = slotImages(slots);
    const mode = h3Mode(template, images);
    const rule = ruleForTemplate(template) || ruleForTemplate("video_h3_i2v");
    const textInImage = textInImageRule(template) ?? rule?.prompt?.text_in_image ?? null;

    // Ref2VA：六段固定顺序（全参考模式）。
    if (mode === "Ref2VA") {
        return compileH3Ref2VA({ shot, scene, characters, style, slots, overlays, durationSec: seconds, images, textInImage });
    }

    const blocks = [];
    // ① 关键帧对齐指令行（I2VA/FL2VA/L2VA 第一行，后空一行）。
    const alignment = h3AlignmentLine(mode, seconds);
    if (alignment) blocks.push(alignment);

    // ② 三字段固定顺序（字段名与顺序取自规则表 h3_prompt_protocols.local_fields.fields_fixed_order）。
    const protocol = h3DefaultProtocol();
    const fieldOrder = Array.isArray(protocol?.fields_fixed_order)
        ? protocol.fields_fixed_order
        : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
    const description = h3Description(shot, { scene, characters, style, mode, durationSec: seconds, overlays, textInImage });
    const fieldValue = {
        integrated_multimodal_description: description,
        overall_soundscape: h3Soundscape(shot),
        non_diegetic_music: h3Music(shot),
    };
    blocks.push(fieldOrder.map((name) => `${name}: ${fieldValue[name] ?? ""}`).join("\n\n"));
    return blocks.join("\n\n");
}

/** H3 Ref2VA：subject_definitions → summary → retention_analysis → detailed_description → soundscape → music。 */
function compileH3Ref2VA({ shot, scene, characters, style, slots, overlays, durationSec, images, textInImage }) {
    const lines = [];
    const refs = images.map((image, index) => {
        const tag = `<Picture ${index + 1}>`;
        const who = hasText(image.name) ? ` (${image.name})` : "";
        return `${tag}${who}`;
    });
    // subject_definitions
    const subjectDefs = refs.length ? refs.map((ref, index) => `${ref}: reference ${imageKindCn(images[index])}`).join("; ") : "No reference material supplied.";
    lines.push(`subject_definitions: ${subjectDefs}`);
    // summary（带 [任务类型] 前缀）
    lines.push(`summary: [reference-to-video] ${stripTail(shot?.action) || "A single continuous shot built from the supplied references"}.`);
    // retention_analysis（关系标记）
    const retention = refs.length ? refs.map((ref) => `${ref}: fully_preserved`).join("; ") : "N/A";
    lines.push(`retention_analysis: ${retention}`);
    // detailed_description（350–500 英文词目标；此处按事实精炼，交由官方改写器扩写）
    const place = hasText(scene?.name) ? String(scene.name).trim() : "";
    const { anchor: styleAnchor } = readStyleFields(style);
    // 台词：正文逐字不翻译、括号表演注解剥出；有正文才带描述层的表演提示（绝不塞回 <d>）。
    const dialogueLine = h3DialogueSentence(shot, characters);
    const detailParts = [
        styleAnchor ? `${stripTail(styleAnchor)}.` : "Live-action, cinematic.",
        place ? `The scene is set in ${place}.` : "",
        refs.length ? `The subjects are defined by ${refs.join(", ")}.` : "",
        stripTail(splitEndState(shot?.action).process) ? `${stripTail(splitEndState(shot?.action).process)}.` : "",
        cameraSentence(shot),
        dialogueLine,
        dialogueLine ? h3PerformanceHint(shot) : "",
        overlayClauseH3(overlays, textInImage),
    ].filter(Boolean);
    lines.push(`detailed_description: ${detailParts.join(" ")}`);
    // soundscape + music（Ref2VA 六段固定顺序的最后两段）
    lines.push(`overall_soundscape: ${h3Soundscape(shot)}`);
    lines.push(`non_diegetic_music: ${h3Music(shot)}`);
    return lines.join("\n\n");
}

/** 参考素材 kind → 中文用途（Ref2VA subject_definitions 用）。 */
function imageKindCn(image) {
    switch (image?.kind) {
        case "first_frame":
        case "input_image":
            return "起始画面（首帧/画布）";
        case "last_frame":
            return "结束画面（尾帧）";
        default:
            if (image?.role === "scene") return "场景";
            if (image?.role === "prop") return "道具";
            return hasText(image?.name) ? `角色 ${image.name}` : "角色";
    }
}

/* ------------------------------------------------------------------ *
 * 编译器 2：Qwen-Image 2.1 系（qwen_image_2_1）—— 官方英文长 prompt 口径
 * ------------------------------------------------------------------ */

/** Qwen 参考图引用行：<image1>~<image10> 对应 INPUT_IMAGE / REF_IMAGE_N 的注入顺序（禁止「图1」式指代）。 */
export function qwenReferenceClause(slots) {
    const images = slotImages(slots).slice(0, 10);
    if (!images.length) return "";
    const parts = images.map((image, index) => {
        const tag = `<image${index + 1}>`;
        const who = hasText(image.name) ? `（${image.name}）` : "";
        switch (image.kind) {
            case "first_frame":
                return `${tag} 为本镜首帧，保持其构图、主体位置与光线一致`;
            case "last_frame":
                return `${tag} 为本镜尾帧，向该画面平滑过渡`;
            case "reference":
                return image.role === "scene"
                    ? `${tag} 为场景参考，锁定空间结构与光线方向`
                    : image.role === "prop"
                      ? `${tag} 为道具参考，锁定外形、材质与颜色`
                      : `${tag} 为角色参考${who}，锁定面容、发型、服装与体型`;
            default:
                return image.role === "character"
                    ? `${tag} 为角色参考${who}，锁定面容、发型、服装与体型`
                    : `${tag} 为参考底图${who}，以其主体为准`;
        }
    });
    return `参考图对应关系：${parts.join("；")}。`;
}

/** Qwen 透明图固定咒语（官方原文）。 */
const QWEN_TRANSPARENT_MAGIC = "This is an RGBA image with transparency.";

function qwenTransparentClause(description) {
    const body = hasText(description) ? `${stripTail(description)}.` : "";
    return `${QWEN_TRANSPARENT_MAGIC} ${body} The image has alpha channel and the background is transparent.`.trim();
}

/**
 * Qwen 2.1 编译器。
 * 官方口径 = 英文长 prompt（400~500 词）+ <image1>~<image10> + 引号内文字逐字 + 透明图咒语。
 * sync 出口：有 `rewrite`（由 compilePromptForTemplateAsync 经官方改写器产出）才用英文；
 * 否则**明确标记 [untranslated]**，绝不假装已英文化。
 */
export function compileQwen21ImagePrompt({ template, shot, scene, characters, style, slots, overlays, legacyBody, basePrompt, rewrite, llmCall } = {}) {
    const names = (Array.isArray(characters) ? characters : [])
        .map((entry) => {
            const name = String(entry?.name ?? "").trim();
            const outfit = String(entry?.outfit ?? "").trim();
            if (!name) return "";
            return outfit ? `${name}（${outfit}）` : name;
        })
        .filter(Boolean);
    const sceneName = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const action = stripTail(splitEndState(shot?.action).process || shot?.action);
    const bits = [];
    if (names.length) bits.push(`主体：${names.join("、")}`);
    if (shotSizeEn(shot)) bits.push(`景别：${shotSizeEn(shot)}`);
    if (sceneName) bits.push(`场景：${sceneName}`);
    if (action) bits.push(`画面内容：${action}`);
    const camera = cameraSentence(shot);
    if (camera) bits.push(`机位与运镜：${stripTail(camera)}`);
    let body = bits.length ? `${bits.join("；")}。` : "";

    const refClause = qwenReferenceClause(slots);
    if (refClause) body += refClause;

    const base = String(basePrompt ?? legacyBody ?? shot?.prompt ?? "").trim();
    if (base && !body.includes(base)) body += `${stripTail(base)}。`;

    const overlay = overlayClauseEn(overlays);
    if (overlay) body += overlay;

    // 官方 path 负面完全无效 → 负向约束改写进正向（通用洁净句，不做逐词映射）。
    if (stringNegativeList(shot).length) body += `${positiveCleanClause()}。`;

    // 透明图咒语（仅该镜需要被抠的主体时）：作为整段开头。
    const withTransparent = slots?.transparent ? qwenTransparentClause(body) : body;

    // 有英文化改写结果 → 直接用（改写器已按官方 PE 口径输出英文长 prompt）。
    if (hasText(rewrite)) return styleHead(style, String(rewrite).trim());

    // 无改写器结果 → 中文降级 + 显式未升级标记（不得假装已英文化）。
    const marker = `[untranslated: 需经官方 qwen-image-2.1-pe 改写器英文化]`;
    const rendered = body ? `${withTransparent} ${marker}` : marker;
    return styleHead(style, rendered);
}

/* ------------------------------------------------------------------ *
 * 编译器 3：仅英文有官方依据的模型（krea2_turbo / flux1_dev）
 * 无 LLM → 中文 + [untranslated] 标记；禁止默默发中文。
 * ------------------------------------------------------------------ */

/** 通用「中文事实主体」拼装（供 Krea2/FLUX 中文降级用）。 */
function imageFactsCn({ shot, scene, characters, style, overlays, slots, basePrompt, legacyBody }) {
    const names = (Array.isArray(characters) ? characters : []).map((entry) => String(entry?.name ?? "").trim()).filter(Boolean);
    const sceneName = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const action = stripTail(splitEndState(shot?.action).process || shot?.action);
    const bits = [];
    if (names.length) bits.push(`主体：${names.join("、")}`);
    if (shotSizeEn(shot)) bits.push(`景别：${shotSizeEn(shot)}`);
    if (sceneName) bits.push(`场景：${sceneName}`);
    if (action) bits.push(`画面内容：${action}`);
    const camera = cameraSentence(shot);
    if (camera) bits.push(`机位与运镜：${stripTail(camera)}`);
    const { anchor: styleAnchor } = readStyleFields(style);
    if (styleAnchor) bits.push(`风格：${styleAnchor}`);
    const base = String(basePrompt ?? legacyBody ?? shot?.prompt ?? "").trim();
    if (base) bits.push(stripTail(base));
    const overlay = overlayClauseCn(overlays);
    if (overlay) bits.push(overlay);
    if (stringNegativeList(shot).length) bits.push(positiveCleanClause());
    return bits.join("；");
}

/**
 * Krea2 编译器：官方仅英文有依据；自然语言整句、禁关键词堆叠与权重语法。
 * 有 `rewrite` 用英文；否则中文 + [untranslated] 标记。
 */
export function compileKrea2ImagePrompt(input = {}) {
    const { style, rewrite } = input;
    if (hasText(rewrite)) return styleHead(style, String(rewrite).trim());
    const facts = imageFactsCn(input);
    const marker = "[untranslated: Krea 2 仅英文有官方依据，需经 llmCall 翻译为英文]";
    return styleHead(style, `${facts} ${marker}`.trim());
}

/**
 * FLUX 编译器：官方仅英文有依据；负面走 zero_out（官方反对负面）。
 * 有 `rewrite` 用英文；否则中文 + [untranslated] 标记。
 */
export function compileFluxImagePrompt(input = {}) {
    const { style, rewrite } = input;
    if (hasText(rewrite)) return styleHead(style, String(rewrite).trim());
    const facts = imageFactsCn(input);
    const marker = "[untranslated: FLUX.1 仅英文有官方依据，需经 llmCall 翻译为英文]";
    return styleHead(style, `${facts} ${marker}`.trim());
}

/* ------------------------------------------------------------------ *
 * 编译器 4：通用兜底（其它所有模板）—— 与既有行为逐字一致（兼容红线）
 * ------------------------------------------------------------------ */

export function compileGenericPrompt({ style, legacyBody, basePrompt, overlays } = {}) {
    let body = String(legacyBody ?? basePrompt ?? "").trim();
    // 文字层逐字：legacyBody 已含（如关键帧）则不再重复追加。
    const overlay = overlayClauseEn(overlays);
    if (overlay) {
        const texts = effectiveOverlays(overlays).map((item) => item.text);
        const already = texts.length && texts.every((text) => body.includes(text));
        if (!already) body = [body, overlay].filter(Boolean).join("。");
    }
    return styleHead(style, body);
}

/* ------------------------------------------------------------------ *
 * 分派表：按 model-rules 的规则键分派（新增模型只需往规则表登记映射）
 * ------------------------------------------------------------------ */

/** 规则键 → 编译器。 */
const COMPILER_BY_RULE = Object.freeze({
    minimax_h3: compileH3VideoPrompt,
    qwen_image_2_1: compileQwen21ImagePrompt,
    krea2_turbo: compileKrea2ImagePrompt,
    flux1_dev: compileFluxImagePrompt,
});

/** 有序分派表：先命中先返回；最后一条是 catch-all 兜底。 */
export const COMPILER_RULES = Object.freeze([
    {
        id: "h3-local-fields",
        match: ({ template }) => ruleKeyForTemplate(template) === "minimax_h3",
        compile: compileH3VideoPrompt,
    },
    {
        id: "qwen-image-2.1",
        match: ({ template }) => ruleKeyForTemplate(template) === "qwen_image_2_1",
        compile: compileQwen21ImagePrompt,
    },
    {
        id: "krea2",
        match: ({ template }) => ruleKeyForTemplate(template) === "krea2_turbo",
        compile: compileKrea2ImagePrompt,
    },
    {
        id: "flux",
        match: ({ template }) => ruleKeyForTemplate(template) === "flux1_dev",
        compile: compileFluxImagePrompt,
    },
    {
        id: "generic",
        match: () => true,
        compile: compileGenericPrompt,
    },
]);

/** 为给定模板挑编译器（返回规则对象，含 id / compile）。 */
export function compilerFor(template, family) {
    const rule = COMPILER_RULES.find((entry) => entry.match({ template, family }));
    return rule || COMPILER_RULES[COMPILER_RULES.length - 1];
}

/**
 * 编译入口：按所选模型/模板把「模型无关的内容事实」编译成该模型要的提示词。
 * @returns {string} 编译后的 PROMPT（**仍是字符串**，ComfyUI 槽语义不变）
 */
export function compilePromptForTemplate(input = {}) {
    const rule = compilerFor(input.template, input.family);
    try {
        const compiled = rule.compile(input);
        if (hasText(compiled)) return compiled;
    } catch {
        /* 兜底：编译器异常绝不拖垮生成请求，回落通用编译器 */
    }
    return compileGenericPrompt(input);
}

/* ------------------------------------------------------------------ *
 * async 出口：能在调用方 await 时，用**官方改写器**把事实改写成目标语言
 * （rewriterForTemplate 选改写器；llmCall 由调用方注入，模块内不发请求）
 * ------------------------------------------------------------------ */

/** 把模型无关事实拼成改写器输入的源文本。 */
function rewriteSourceText(input) {
    const { shot, scene, characters, style, overlays } = input;
    const names = characterNames(characters);
    const sceneName = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const action = stripTail(splitEndState(shot?.action).process || shot?.action);
    const bits = [];
    if (names.length) bits.push(`主体：${names.join("、")}`);
    if (shotSizeEn(shot)) bits.push(`景别：${shotSizeEn(shot)}`);
    if (sceneName) bits.push(`场景：${sceneName}`);
    if (action) bits.push(`画面内容：${action}`);
    const camera = cameraSentence(shot);
    if (camera) bits.push(`机位与运镜：${stripTail(camera)}`);
    const { anchor: styleAnchor } = readStyleFields(style);
    if (styleAnchor) bits.push(`风格：${styleAnchor}`);
    if (hasText(shot?.dialogue)) bits.push(`台词：${String(shot.dialogue).trim()}`);
    const overlay = overlayClauseCn(overlays);
    if (overlay) bits.push(overlay);
    return bits.join("；");
}

/** 无官方改写器、但模型仅英文有官方依据时的通用英文化 system（Krea2 / FLUX）。 */
const ENGLISH_TRANSLATION_SYSTEM =
    "You rewrite an image-generation brief into one fluent, natural English prompt for a text-to-image model. " +
    "Preserve every quoted on-screen text string verbatim and keep all subjects, counts, colours, and positions. " +
    "Output only the English prompt, no explanations.";

/**
 * async 编译入口：模型官方要英文时，**经 llmCall** 英文化后再编译 ——
 *   · 有官方改写器（rewriterForTemplate 命中）→ 走 rewritePrompt（Qwen / Wan / Boogu / SCAIL-2）；
 *   · 无官方改写器但仅英文有依据（Krea2 / FLUX）→ 直接经 llmCall 翻译为英文；
 * llmCall 缺失 / 改写失败 → 回落 sync `compilePromptForTemplate`（中文 + 显式 [untranslated] 标记）。
 * @returns {Promise<string>}
 */
export async function compilePromptForTemplateAsync(input = {}) {
    const template = String(input?.template ?? "");
    const llmCall = input?.llmCall;
    if (rewriteTargetLang(template) === "en" && typeof llmCall === "function") {
        const source = rewriteSourceText(input);
        if (hasText(source)) {
            const rewriterId = rewriterForTemplate(template);
            try {
                if (rewriterId) {
                    const out = await rewritePrompt({ rewriterId, text: source, targetLang: "en", context: { promptsDir: input.promptsDir }, llmCall });
                    if (out && hasText(out.text)) return compilePromptForTemplate({ ...input, rewrite: out.text });
                } else {
                    const out = await llmCall({ system: ENGLISH_TRANSLATION_SYSTEM, user: source });
                    if (hasText(out)) return compilePromptForTemplate({ ...input, rewrite: String(out).trim() });
                }
            } catch {
                /* 改写/翻译失败 → 回落 sync（显式未升级标记） */
            }
        }
    }
    return compilePromptForTemplate(input);
}

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
 *                       官方改写规范要求**正文英文**（字段名/结构本就英文）；本模块在走专用整段英文化
 *                       入口拿到**通过逐字锁校验**的改写稿时才输出英文正文，否则同步中文事实 + `[untranslated]`
 *                       标记 —— 「H3 结构固定」不等于「正文不用改」，两者不得再混为一谈。
 *   · qwen_image_2_1  → 官方口径是「英文长 prompt（400~500 词）+ 多参考图 <image1>~<image10>」。
 *                       官方实现是专用 PE 权重/改写器；本模块 sync 出口在**拿不到 llmCall 改写结果**时
 *                       退化为中文 + 显式 `[untranslated]` 标记（绝不假装已英文化）。
 *   · krea2_turbo / flux1_dev → 规则表明**仅英文有官方依据**；当前没有厂商官方改写器资产，
 *                       使用本项目补充的通用英文翻译路径；无 LLM 时中文 + `[untranslated]` 标记（不得默默发中文）。
 *                       FLUX 负面 = zero_out（官方反对负面）。
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
import { splitDialogue, resolveDialogueLines } from "./audio.js";
import { dialogueMetaForTemplate } from "./dialogue-roles.js";

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

/** 删除仅供排查的降级标记；该标记绝不能进入实际模型 PROMPT。 */
export function stripUntranslatedMarker(text) {
    return String(text ?? "")
        .replace(/\s*\[untranslated[^\]]*\]/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
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

/** 项目画幅是生产事实，不能让改写器自行猜测横竖屏。 */
function aspectRatioFact(style) {
    const raw = String(style && typeof style === "object" ? style.ratio ?? "" : "").trim();
    const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(raw);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0 && height > 0)) return null;
    const ratio = `${match[1]}:${match[2]}`;
    if (height > width) return { ratio, orientationCn: "竖屏", orientationEn: "vertical portrait" };
    if (width > height) return { ratio, orientationCn: "横屏", orientationEn: "horizontal landscape" };
    return { ratio, orientationCn: "方形", orientationEn: "square" };
}

function aspectRatioClauseCn(style) {
    const fact = aspectRatioFact(style);
    return fact ? `画幅：${fact.ratio}（${fact.orientationCn}构图，严格保持，不得改成${fact.orientationCn === "竖屏" ? "横屏" : fact.orientationCn === "横屏" ? "竖屏" : "非方形"}）` : "";
}

/**
 * 交给改写器的画幅约束：独立一行、标明是**不可改写的生产事实**。
 * 改写器只能表达事实，不能猜测或覆盖画幅（画幅与 WIDTH/HEIGHT 同源于 project.plan.ratio）。
 */
function aspectRatioConstraint(style) {
    const fact = aspectRatioFact(style);
    if (!fact) return "";
    const forbidden =
        fact.orientationEn === "vertical portrait"
            ? "horizontal / landscape / widescreen / 16:9"
            : fact.orientationEn === "horizontal landscape"
              ? "vertical / portrait / 9:16"
              : "horizontal / landscape / vertical / portrait";
    return `【固定生产事实·不得更改】画幅 ${fact.ratio}，${fact.orientationCn}构图；英文稿必须写成 ${fact.orientationEn} composition，禁止出现相反方向（${forbidden}）。`;
}

/**
 * 相反方向的词与比例（按项目事实取向查表）。
 * `words` 用于「方向词 + 构图名词紧邻」判定（可含 portrait 这类多义词）；
 * `subjectWords` 用于「整幅画面主语 + 系动词 + 方向词」判定，只留无歧义的词 —— 否则
 * 横屏项目里的 `The shot is a portrait of a man`（人像）会被误判成画幅断言。
 */
const OPPOSITE_ORIENTATION = Object.freeze({
    "vertical portrait": { words: "horizontal|landscape|widescreen|wide-screen", subjectWords: "horizontal|landscape|widescreen|wide-screen", ratio: "16\\s*[:x×]\\s*9" },
    "horizontal landscape": { words: "vertical|portrait|tall", subjectWords: "vertical", ratio: "9\\s*[:x×]\\s*16" },
    square: { words: "horizontal|landscape|widescreen|wide-screen|vertical|portrait", subjectWords: "horizontal|landscape|widescreen|vertical", ratio: "16\\s*[:x×]\\s*9|9\\s*[:x×]\\s*16" },
});

/** 构图名词：与方向词紧邻时（`landscape orientation`、`frame is vertical`）才算画幅断言。 */
const COMPOSITION_NOUN = "composition|frame|framing|format|orientation|aspect\\s*ratio|canvas|layout|screen";

/** 「整幅画面」主语：只有它做主语时，句子里的方向词才可能在说画幅而不是说某个物体。 */
const FRAME_SUBJECT = "image|picture|photo|photograph|frame|framing|shot|scene|video|composition|canvas|screen";

/** 系动词/状态词：把主语和方向词连起来（`The image is a horizontal …`、`The video is shot in widescreen`）。 */
const LINKING_VERB = "is|are|appears|looks|rendered|shot|framed|formatted|oriented|presented|in|as";

/** 运镜/位移语境：`horizontal pan`、`横向移动` 是合法描述，不是画幅断言。 */
const MOVEMENT_HINT = /\b(?:pan(?:s|ning)?|track(?:s|ing)?|mov(?:e|es|ing|ement)|sweep(?:s|ing)?|scroll(?:s|ing)?|drift(?:s|ing)?|glid(?:e|es|ing)|slid(?:e|es|ing)|travels?)\b|(?:横移|摇摄|横向移动)/i;

/** 首句 = 改写稿的构图总述句（实测故障就出在这里：`The image is a horizontal ... close-up`）。 */
function firstSentence(text) {
    const value = String(text ?? "").trim();
    const cut = value.search(/[.。!！?？]/);
    return cut > 0 ? value.slice(0, cut + 1) : value;
}

function windowAround(text, index, length, span = 20) {
    return String(text).slice(Math.max(0, index - span), index + length + span);
}

/**
 * **检测**改写稿是否把项目画幅写成了反方向（返回可读原因；无冲突返回 null）。
 *
 * 只检测、不改写：正则文本手术改不干净时会留下「开头补一句竖屏、正文仍写横屏」的自相矛盾稿，
 * 比整稿弃用更糟。判定命中后由 `compilePromptForTemplateAsync` 弃用改写稿、回落同步结构稿并记 warning。
 *
 * 三条判定（都要求方向词处在**画幅语境**里，避免误伤 `a horizontal band of sky`、`horizontal pan`）：
 *   ① 出现相反的显式比例（9:16 ↔ 16:9）—— 无歧义，位置不限；
 *   ② 方向词与构图名词紧邻：`horizontal frame` / `landscape orientation` / `aspect ratio is vertical`；
 *   ③ 首句里「整幅画面主语 + 系动词 + 方向词」：`The image is a horizontal ... close-up`。
 * 命中处附近若是运镜语境（pan / tracking / 横移）一律放过。
 */
export function aspectRatioConflict(text, style) {
    const fact = aspectRatioFact(style);
    const value = String(text ?? "").trim();
    if (!fact || !value) return null;
    const opposite = OPPOSITE_ORIENTATION[fact.orientationEn];
    if (!opposite) return null;
    const reason = (found) => `改写稿把画幅写成「${found}」，与项目生产事实 ${fact.ratio}（${fact.orientationCn}）冲突`;
    const hit = (re, scope) => {
        const match = re.exec(scope);
        return match && !MOVEMENT_HINT.test(windowAround(scope, match.index, match[0].length)) ? match[0] : null;
    };

    const found =
        hit(new RegExp(`\\b(?:${opposite.ratio})\\b`, "gi"), value) ||
        hit(new RegExp(`\\b(?:${opposite.words})\\s+(?:${COMPOSITION_NOUN})\\b|\\b(?:${COMPOSITION_NOUN})\\s+(?:is\\s+|:\\s*)?(?:${opposite.words})\\b`, "gi"), value) ||
        hit(new RegExp(`\\b(?:${FRAME_SUBJECT})\\b[^.。]{0,40}?\\b(?:${LINKING_VERB})\\b[^.。]{0,20}?\\b(?:${opposite.subjectWords})\\b`, "gi"), firstSentence(value));
    return found ? reason(found) : null;
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
    // ⚠️ 不再有 subtitle：对白字幕由后期独立 .srt 提供，**绝不进画面**（产品铁律，成片要过剪映精剪）
});

/** kind → 英文语义前缀（英文提示词 / 通用兜底用）。 */
const OVERLAY_KIND_EN = Object.freeze({
    sign: "sign reading",
    ticket: "ticket text",
    screen: "screen text",
    logo: "logo text",
});

/** kind → 英文**载体**名（H3 画面文字自然句式用）。 */
const OVERLAY_CARRIER_EN = Object.freeze({
    sign: "sign",
    ticket: "ticket",
    screen: "screen",
    logo: "logo",
});

/**
 * H3「画面内无文字」禁令 —— textInImageRule 的**反向口径**：当 textOverlays 为空（本次画面
 * 没有任何要呈现的文字事实）时，明确禁止画面内出现文字/字幕/标题。与 textOverlays 非空时
 * 「逐字保留原句」的正向口径对称。
 *
 * ⚠️⚠️ 真跑溯源（2026-10-04）**推翻了最初的判断：烧进画面的台词字幕不是 H3 干的**。
 *   现象：video_h3_i2v 的 sh1 成片底部三行中文台词、三帧静态相同，而 textOverlays 全空。
 *   真因在**关键帧图**：图像编译器把内容事实里的 `台词：…` 一并交给了官方 Qwen PE 改写器，
 *   改写出「Along the bottom edge of the frame, three lines of white Chinese subtitles … read
 *   "姑娘，这么晚，去哪儿？" …」（见 data/jobs.json 里 img_qwen21_edit 的 PROMPT 原文）——
 *   关键帧图自带字幕，H3 的 I2VA 只是**原样保留**。已在本文件的 tierTwoSourceText / rewriteSourceText
 *   堵住（台词不再进图像提示词）：重跑关键帧 + 视频，抽帧 0.5/2.5/4.5s 底部均无任何字幕。
 *   对照实验：① 只在 H3 提示词里加/不加本条禁令，成片都无字幕（关键帧干净时 H3 不会自加字幕）；
 *   ② 把工作流 `strict_prompt_tags` 设 false 也不改变结果。
 *
 * 本条禁令仍**保留**：它是「画面内文字事实为空 → 显式声明画面内无文字」的正向兜底，成本为零、无副作用，
 * 且与 textOverlays 非空时的逐字口径成对。它**不是**该问题的修复手段（修复在图像侧）。
 *
 * ⚠️ 只禁止画面内文字，**不删** `<d>` 台词块 —— H3 仍靠它合成台词语音与口型驱动（见 h3DialogueSentence）。
 */
const H3_NO_ON_SCREEN_TEXT =
    "Absolutely no on-screen text of any kind is present: there are no subtitles, no captions, no titles, " +
    "no logos, no signage, no graphical overlays, and no written characters anywhere in the frame. " +
    "The spoken dialogue is conveyed by the audio only — it must never be displayed as text, subtitles, or captions in the picture.";

/**
 * 取有效文字层：text 非空且 kind !== none。
 *
 * ⚠️ **`kind: "subtitle"` 一律丢弃（产品铁律）**：成片要过剪映精剪，烧死在画面里的字幕是像素、没法改。
 * 对白字幕一律由后期以独立 `.srt` 文件提供，**任何画面都不得渲染字幕**。
 * 这是纵深防御 —— 上游分镜/关键帧 skill 已不再输出 `subtitle` kind，但旧数据/旧模型输出仍可能带着它。
 * 画面内文字只允许真实的**物体文字**：sign（站牌/招牌/路牌）/ ticket（车票）/ screen（屏幕）/ logo（商标）。
 */
function effectiveOverlays(overlays) {
    const out = [];
    for (const raw of Array.isArray(overlays) ? overlays : []) {
        if (!raw || typeof raw !== "object") continue;
        const text = raw.text === undefined || raw.text === null ? "" : String(raw.text);
        if (!text.trim()) continue;
        const kind = String(raw.kind ?? "").trim().toLowerCase();
        if (!kind || kind === "none") continue;
        if (kind === "subtitle") continue; // ← 字幕绝不进画面（见上方注释）
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
    // textOverlays 为空（本次画面没有任何要呈现的文字事实）→ 走 textInImageRule 的反向口径：
    // 显式禁止画面内出现任何文字/字幕/标题（H3 默认会把 <d> 台词块烧成画面内文字，已抽帧核实）。
    // ⚠️ 只加禁令，<d> 台词块照旧保留（H3 靠它合成台词与口型）。
    if (!items.length) return H3_NO_ON_SCREEN_TEXT;
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

/** 同步降级提示词使用中文机位描述，避免英文运镜句与中文事实混在一起。 */
function cameraSentenceCn(shot) {
    const spec = shot?.cameraSpec && typeof shot.cameraSpec === "object" ? shot.cameraSpec : null;
    const movement = spec?.movement && typeof spec.movement === "object" ? spec.movement : null;
    if (movement && hasText(movement.type)) {
        const labels = { static: "固定机位", pan: "摇摄", tilt: "俯仰", truck: "横移", tracking: "跟拍", dolly: "推拉", push: "推进", pull: "拉远", zoom: "变焦", handheld: "手持", shake: "轻微晃动", pov: "主观视角" };
        const type = String(movement.type).trim().toLowerCase();
        const parts = [labels[type] || type];
        if (hasText(movement.direction) && !/^(none|static)$/i.test(String(movement.direction).trim())) parts.push(`方向${String(movement.direction).trim()}`);
        if (hasText(movement.amplitude)) parts.push(`幅度${String(movement.amplitude).trim()}`);
        if (hasText(movement.speed) && type !== "static") parts.push(`速度${String(movement.speed).trim()}`);
        return `机位与运镜：${parts.join("，")}`;
    }
    return hasText(shot?.camera) ? `机位与运镜：${stripTail(shot.camera)}` : "";
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
 * 说话人 ID：按**稳定序号**编号 (S1)(S2)…（H3 官方要求同一说话人跨镜保持同 ID）。
 * 序号来自 `resolveDialogueLines`（优先全局 cast 的顺序，保证同一角色跨镜同号）。
 */
export function speakerId(index) {
    return `S${Math.max(0, Number(index) || 0) + 1}`;
}

/** 取镜头涉及的角色名（稳定顺序）。 */
function characterNames(characters) {
    return (Array.isArray(characters) ? characters : []).map((entry) => String(entry?.name ?? "").trim()).filter(Boolean);
}

/**
 * 表演提示句（描述层）：注解按调研口径并入 integrated_multimodal_description，**绝不塞回 `<d>` 内**。
 * 只取**有台词正文**的那些条（整条只有注解的不算——没有台词就不该写表演提示）；多角色多条用「；」连接。
 * 无注解返回空串。
 */
function h3PerformanceHint(shot, characters, cast) {
    const { lines } = resolveDialogueLines(shot, characters, cast);
    const perf = [
        ...new Set(
            lines
                .filter((line) => !line.onlyAnnotation && hasText(line.text))
                .map((line) => String(line.performance ?? "").trim())
                .filter(Boolean),
        ),
    ];
    return perf.length ? `Performance: ${stripTail(perf.join("；"))}.` : "";
}

/**
 * H3 台词句（正文逐字不翻译、**不含表演注解**）：逐条台词带说话人，每条一个块：
 *   `<角色> (S1) says: <d>[English] ...</d>`
 * 画外音写 `says in an off-screen voiceover` 且紧跟「嘴唇保持闭合」。
 *
 * 说话人由 `resolveDialogueLines` 逐级回落解析（新契约 `dialogueLines[]` 的显式说话人优先；
 * 旧字符串 `dialogue` 当「一条、无明确说话人」）；`(Sx)` 序号取全局 cast 的稳定位置 → 同一角色跨镜同号。
 * `<d>` 标签与语言标签从**模型能力元数据**取（dialogue-roles.js · minimax_h3），本函数只负责渲染，不另创一套口径。
 * 括号表演注解已剥出（见 h3PerformanceHint 写进描述层）；整条只有注解、无正文时该块不输出（不输出空 `<d>[English] </d>`）。
 * @returns {string} 多条用空格连接；无台词正文返回空串。
 */
export function h3DialogueSentence(shot, characters, { voiceover = false, cast = null, template = null } = {}) {
    const meta = template ? dialogueMetaForTemplate(template) : null;
    const tag = meta?.utteranceTag || "d";
    const lang = meta?.utteranceLangTag || "English";
    const { lines } = resolveDialogueLines(shot, characters, cast);
    const blocks = [];
    for (const line of lines) {
        if (line.onlyAnnotation || !hasText(line.text)) continue; // 整条只有注解 → 不输出 <d> 块
        const name = line.speaker.name || "The speaker";
        const id = speakerId(line.speaker.index);
        // 电话声属于这一句的说话人；不能把同镜其他可见角色一起判成画外音。
        const phoneVoice = /电话里|电话中|on the phone/i.test(line.performance)
            && !String(shot?.action ?? "").includes(name);
        const isVoiceover = voiceover || (line.voiceover ?? (shot?.voiceover === true || phoneVoice || /画外音|旁白|off-?screen/i.test(line.performance)));
        const verb = isVoiceover ? "says in an off-screen voiceover" : "says";
        const block = `${name} (${id}) ${verb}: <${tag}>[${lang}] ${line.text}</${tag}>`;
        blocks.push(isVoiceover ? `${block}, while the visible listeners' lips remain completely closed.` : `${block}, with ${name}'s mouth movements synchronized to this line; the other characters listen without speaking.`);
    }
    return blocks.length > 1 ? `${blocks.join(" ")} The speakers take turns in the written order, each finishing before the next begins; no overlapping dialogue.` : blocks.join(" ");
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
function h3Description(shot, { scene, characters, cast, template, style, mode, durationSec, overlays, textInImage, audioMode }) {
    const parts = [];
    const { anchor: styleAnchor } = readStyleFields(style);
    // [Shot 1] 头部：风格 + 初始构图。
    const headBits = ["Live-action, cinematic"];
    const aspect = aspectRatioFact(style);
    const size = shotSizeEn(shot);
    const place = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const subjectClause = [size ? `a ${size}` : "a shot", place ? `set in ${place}` : ""].filter(Boolean).join(" ");
    parts.push(
        `[Shot 1] ${headBits.join(", ")}, ${styleAnchor ? `${stripTail(styleAnchor)}. ` : ""}${aspect ? `The composition is ${aspect.orientationEn}, with a ${aspect.ratio} aspect ratio. ` : ""}${subjectClause}.`,
    );
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
    // 台词（逐条带说话人；正文逐字不翻译；括号表演注解已被剥出）。
    const dialogue = audioMode === "separate_dialogue_track" ? "" : h3DialogueSentence(shot, characters, { cast, template });
    if (dialogue) {
        parts.push(dialogue);
        // 表演注解 → 描述层作表演提示（绝不塞回 <d>）。仅在有台词正文时输出：
        // 整条只有注解、无正文时 <d> 块整块不输出，也不该为不存在的台词写表演提示。
        const performance = h3PerformanceHint(shot, characters, cast);
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
 * 有**通过逐字锁校验**的 `rewrite` → 正文英文（锚点/运镜/字段仍由编译器直拼、不用 LLM 回显）；
 * 否则同步中文稿；模型要求英文（translate_to==="en"）而本次没有可用 rewrite 时追加 `[untranslated]` 标记。
 * @returns {string}
 */
export function compileH3VideoPrompt({ template, shot, scene, characters, cast = null, style, slots, overlays, durationSec, rewrite, audioMode } = {}) {
    const seconds = Number(durationSec) > 0 ? Number(durationSec) : Number(shot?.durationSec) > 0 ? Number(shot.durationSec) : 5;
    const images = slotImages(slots);
    const mode = h3Mode(template, images);
    const input = { template, shot, scene, characters, cast, style, overlays, audioMode, textInImage: h3TextInImage(template) };
    const parsed = hasText(rewrite) ? h3ParseRewrite(rewrite, input) : null;
    const marker = rewriteTargetLang(template) === "en" ? ` ${H3_UNTRANSLATED_MARKER}` : "";

    // Ref2VA：六段固定顺序（全参考模式）。
    if (mode === "Ref2VA") {
        const body = compileH3Ref2VA({ ...input, seconds, images, parsed });
        return parsed ? body : `${body}${marker}`;
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
    const description = parsed
        ? h3RewriteDescription(parsed.visual, input, { mode })
        : h3Description(shot, { ...input, mode, durationSec: seconds });
    const fieldValue = {
        integrated_multimodal_description: description,
        overall_soundscape: h3RouteSoundscape(parsed ? h3RewrittenAudio(parsed.soundscape, h3Soundscape(shot)) : h3Soundscape(shot), audioMode),
        non_diegetic_music: parsed ? h3RewrittenAudio(parsed.music, h3Music(shot)) : h3Music(shot),
    };
    blocks.push(fieldOrder.map((name) => `${name}: ${fieldValue[name] ?? ""}`).join("\n\n"));
    return blocks.join("\n\n") + (parsed ? "" : marker);
}

/** H3 Ref2VA：subject_definitions → summary → retention_analysis → detailed_description → soundscape → music。 */
function compileH3Ref2VA({ shot, scene, characters, cast, template, style, slots, overlays, seconds, images, textInImage, parsed, audioMode }) {
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
    // detailed_description（350–500 英文词目标）
    let detailed;
    if (parsed) {
        // 改写稿只供正文；参考素材引用句仍由编译器直拼（<Picture N> 是结构，不许 LLM 重写）。
        const refsClause = refs.length ? `The subjects are defined by ${refs.join(", ")}.` : "";
        detailed = [refsClause, h3RewriteDescription(parsed.visual, { shot, characters, cast, template, overlays, textInImage, audioMode })].filter(Boolean).join(" ");
    } else {
        const place = hasText(scene?.name) ? String(scene.name).trim() : "";
        const { anchor: styleAnchor } = readStyleFields(style);
        // 台词：逐条带说话人、正文逐字不翻译、括号表演注解剥出；有正文才带描述层的表演提示（绝不塞回 <d>）。
        const dialogueLine = audioMode === "separate_dialogue_track" ? "" : h3DialogueSentence(shot, characters, { cast, template });
        const detailParts = [
            styleAnchor ? `${stripTail(styleAnchor)}.` : "Live-action, cinematic.",
            place ? `The scene is set in ${place}.` : "",
            refs.length ? `The subjects are defined by ${refs.join(", ")}.` : "",
            stripTail(splitEndState(shot?.action).process) ? `${stripTail(splitEndState(shot?.action).process)}.` : "",
            cameraSentence(shot),
            dialogueLine,
            dialogueLine ? h3PerformanceHint(shot, characters, cast) : "",
            overlayClauseH3(overlays, textInImage),
        ].filter(Boolean);
        detailed = detailParts.join(" ");
    }
    lines.push(`detailed_description: ${detailed}`);
    // soundscape + music（Ref2VA 六段固定顺序的最后两段）
    lines.push(`overall_soundscape: ${h3RouteSoundscape(parsed ? h3RewrittenAudio(parsed.soundscape, h3Soundscape(shot)) : h3Soundscape(shot), audioMode)}`);
    lines.push(`non_diegetic_music: ${parsed ? h3RewrittenAudio(parsed.music, h3Music(shot)) : h3Music(shot)}`);
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
 * 编译器 1b：H3 英文化改写（整段正文，专用入口）
 * ------------------------------------------------------------------ *
 * 规则表 minimax_h3.prompt.translate_to = "en"：字段名与结构固定英文，**正文也必须英文**（官方改写规范）。
 * 「结构固定」只约束字段名与顺序，不等于正文不用改 —— 此前把两者混为一谈，H3 既从不英文化、
 * 也不追加 [untranslated] 标记，于是流水线那道英文化闸门（pipeline 的 untranslatedWarning）对它恒为关闭。
 *
 * 与分级路径（qwen / krea2 / flux）的区别：H3 是**整段正文**改写，不是「一级直拼 + 二级改写」，
 * 故不进 prompt_tier_policy.rewritable_models，由 compilePromptForTemplateAsync 的专用入口喂源。
 *
 * 无论是否有改写稿，以下部分**恒由编译器自己拼**，绝不交给 LLM：
 *   字段名 / 关键帧对齐指令行 / 模式引用句 / <d> 台词块 / 画面文字英文引号句 / 运镜句 / 负向句 /
 *   overall_soundscape 与 non_diegetic_music 的字段名与 N/A 哨兵值。
 * LLM 只产三样：画面描述正文、环境声·动作声、配乐。
 *
 * 台词与画面文字是**逐字锚点**：LLM 必须原样照抄（不得翻译）；编译器校验通过后仍**丢弃**其回显，
 * 只采用自己拼的规范块 —— 漏写 / 篡改 / 混进正文任一条 → 整稿弃用、回落同步中文稿（不新造降级机制）。
 * ------------------------------------------------------------------ */

/** H3 未英文化排查标记（与图片侧同形；stripUntranslatedMarker 会剥离，绝不进模型 PROMPT）。 */
const H3_UNTRANSLATED_MARKER = "[untranslated: MiniMax H3 官方改写规范要求正文英文，需经 llmCall 英文化]";

/** 改写源 / 改写稿的段标签（system 要求 LLM 按同名标签返回）。 */
const H3_REWRITE_LABELS = Object.freeze({
    visual: "【画面描述事实】",
    soundscape: "【环境声与动作声】",
    music: "【配乐】",
});

/** 逐字锚点行前缀：LLM 必须整行原样照抄；编译器校验后剥离，不采用其回显正文。 */
const H3_ANCHOR_PREFIX = "ANCHOR: ";

/** 逐字锚点行（含行首缩进）。 */
const H3_ANCHOR_LINE_RE = /^[ \t]*ANCHOR:.*$/gm;

/**
 * H3 英文化 system：写明「台词、歌词、画面文字原样逐字照抄，不翻译」，并要求按同名三段标签返回。
 * 与图片侧 ENGLISH_TRANSLATION_SYSTEM 分开：图片口径明确排除台词，H3 恰恰相反 —— 台词必须逐字在场。
 */
const H3_REWRITE_SYSTEM =
    "You rewrite a MiniMax H3 video shot brief into the exact H3 local-field prompt. " +
    "Write the descriptive prose in fluent, natural English. " +
    "Dialogue content inside <d>...</d>, any song lyrics, and every on-screen text inside double quotes are verbatim anchors: " +
    "copy them character for character in their original language — never translate, never transliterate, never drop them. " +
    "Lines starting with 'ANCHOR:' must each be copied unchanged on their own line, at the end of the visual section. " +
    "Return exactly three labelled sections in this order: 【画面描述事实】 / 【环境声与动作声】 / 【配乐】, " +
    "keeping the labels, and output nothing else.";

/** H3 画面文字口径（与 compileH3VideoPrompt 同源，供改写源与校验共用）。 */
function h3TextInImage(template) {
    const rule = ruleForTemplate(template) || ruleForTemplate("video_h3_i2v");
    return textInImageRule(template) ?? rule?.prompt?.text_in_image ?? null;
}

/** 逐字锚点正文（编译器直拼的那一份）：台词块 + 画面文字句。 */
function h3RewriteAnchors(input) {
    const { shot, characters, cast = null, template, overlays, textInImage } = input;
    return {
        dialogue: input.audioMode === "separate_dialogue_track" ? "" : h3DialogueSentence(shot, characters, { cast, template }),
        overlay: overlayClauseH3(overlays, textInImage),
    };
}

/** 逐字锁清单：每条 <d> 台词正文 + 每个画面文字（原语言），外加台词包裹标签名。 */
function h3VerbatimLock(input) {
    const { shot, characters, cast = null, template, overlays } = input;
    const meta = template ? dialogueMetaForTemplate(template) : null;
    const tag = meta?.utteranceTag || "d";
    const { lines } = resolveDialogueLines(shot, characters, cast);
    const dialogue = input.audioMode === "separate_dialogue_track" ? [] : lines.filter((line) => !line.onlyAnnotation && hasText(line.text)).map((line) => String(line.text).trim());
    const overlay = effectiveOverlays(overlays).map((item) => item.text);
    return { tag, dialogue, overlay };
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 逐字锁校验：改写稿里每条 `<d>…</d>` 的**内容**必须逐字仍在同一标签块内，
 * 每个英文双引号内的画面文字必须逐字仍在引号内。规则原文：「台词/歌词/画面文字保留原语言」。
 * 不满足即视为失败（调用方记 onWarning 并回落同步稿）。
 */
function verifyH3Rewrite(raw, input) {
    const text = String(raw ?? "");
    if (input.audioMode === "separate_dialogue_track" && /<d>|\(S\d+\)\s+says/i.test(text)) return { ok: false, reason: "独立配音路线的改写稿不得引入视频原生对白" };
    if (!text.includes(H3_REWRITE_LABELS.visual)) return { ok: false, reason: `改写稿缺少「${H3_REWRITE_LABELS.visual}」标签，无法按字段回填` };
    const { tag, dialogue, overlay } = h3VerbatimLock(input);
    for (const line of dialogue) {
        if (!text.includes(line)) return { ok: false, reason: `改写稿漏写或篡改台词（必须逐字保留原语言）：${line}` };
        if (!new RegExp(`<${tag}>[\\s\\S]*?${escapeRegExp(line)}[\\s\\S]*?</${tag}>`).test(text)) {
            return { ok: false, reason: `改写稿把台词移出 <${tag}> 块（必须原块逐字保留）：${line}` };
        }
    }
    for (const item of overlay) {
        if (!text.includes(`"${item}"`)) return { ok: false, reason: `改写稿漏写或篡改画面文字（必须逐字保留在英文双引号内）：${item}` };
    }
    return { ok: true };
}

/** 按同名标签切段；缺失 / 乱序的段回空串，由调用方回落同步值。 */
function h3RewriteSections(raw) {
    const text = String(raw ?? "");
    const { visual, soundscape, music } = H3_REWRITE_LABELS;
    const pick = (label, others) => {
        const start = text.indexOf(label);
        if (start < 0) return "";
        const from = start + label.length;
        const ends = others.map((other) => text.indexOf(other, from)).filter((at) => at >= 0);
        return text.slice(from, ends.length ? Math.min(...ends) : text.length).trim();
    };
    return {
        visual: pick(visual, [soundscape, music]),
        soundscape: pick(soundscape, [music, visual]),
        music: pick(music, [visual, soundscape]),
    };
}

/** 剥掉逐字锚点回显（ANCHOR 行 + 残留 `<d>` 块 + 锚点字面串），保证正文里不再出现台词/画面文字。 */
function stripH3VerbatimAnchors(visual, anchors, tag) {
    let out = String(visual ?? "").replace(H3_ANCHOR_LINE_RE, " ");
    if (hasText(anchors.dialogue)) out = out.split(anchors.dialogue).join(" ");
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), " ");
    if (hasText(anchors.overlay)) out = out.split(anchors.overlay).join(" ");
    return out.replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
}

/** 英文句尾补句号（LLM 正文若忘了收尾，别把它和下一句粘成一句）。 */
function sentenceTail(text) {
    const value = String(text ?? "").trim();
    if (!value) return "";
    return /[.!?。！？]$/.test(value) ? value : `${value}.`;
}

/**
 * H3 改写源文本：三段带标签事实（画面描述事实 / 环境声·动作声 / 配乐）+ 逐字锚点行。
 * 运镜句由编译器拼（不进改写源）；画幅作为不可改写的生产事实写进源里。
 */
function h3RewriteSourceText(input) {
    const { shot, scene, characters, style } = input;
    const facts = [];
    const { anchor: styleAnchor } = readStyleFields(style);
    if (styleAnchor) facts.push(`风格：${stripTail(styleAnchor)}`);
    const aspect = aspectRatioFact(style);
    if (aspect) facts.push(`画幅：${aspect.ratio}（${aspect.orientationCn}构图，严格保持，不得更改）`);
    const names = characterNames(characters);
    if (names.length) facts.push(`主体：${names.join("、")}`);
    if (hasText(shot?.shotSize)) facts.push(`景别：${String(shot.shotSize).trim()}`);
    const place = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    if (place) facts.push(`场景：${place}`);
    const { process, endState } = splitEndState(shot?.action);
    if (hasText(process)) facts.push(`画面内容：${stripTail(process)}`);
    if (hasText(endState)) facts.push(`段末可见状态：${stripTail(endState)}`);
    const cuts = Array.isArray(shot?.cuts) ? shot.cuts : [];
    cuts.forEach((cut, index) => {
        if (cut && hasText(cut.text)) facts.push(`切镜 ${index + 2}（${fmtTimecode(cut.atSec)}）：${stripTail(cut.text)}`);
    });
    const anchors = h3RewriteAnchors(input);
    const lines = [H3_REWRITE_LABELS.visual, facts.join("；")];
    for (const anchor of [anchors.dialogue, anchors.overlay]) {
        if (hasText(anchor)) lines.push(`${H3_ANCHOR_PREFIX}${anchor}`);
    }
    lines.push("", H3_REWRITE_LABELS.soundscape, h3Soundscape(shot), "", H3_REWRITE_LABELS.music, h3Music(shot));
    return lines.join("\n");
}

/** 改写后的音轨字段：空 / N/A → 回编译器哨兵值（字段名与 N/A 恒由编译器写）。 */
function h3RewrittenAudio(section, syncValue) {
    const text = String(section ?? "").trim();
    if (!text || /^n\/?a\.?$/i.test(text)) return syncValue;
    return text;
}

function h3RouteSoundscape(soundscape, audioMode) {
    return audioMode === "separate_dialogue_track" ? `${soundscape === "N/A" ? "" : `${soundscape} `}Environmental and action sounds only; no dialogue, speech or singing.` : soundscape;
}

/** 改写稿正文（描述层）：LLM 正文 + 编译器自拼的运镜 / 模式引用 / 台词 / 画面文字 / 负向句。 */
function h3RewriteDescription(visual, input, { mode = null } = {}) {
    const { shot, characters, cast = null, template, overlays, textInImage, audioMode } = input;
    const parts = [sentenceTail(visual)];
    const camera = cameraSentence(shot);
    if (camera) parts.push(camera);
    if (mode === "I2VA") parts.push("The frame begins from <Picture 1>, preserving its composition, subjects, colours, and lighting.");
    if (mode === "FL2VA") parts.push("The motion runs continuously from Picture 1 to Picture 2 with no cut in between.");
    if (mode === "L2VA") parts.push("The described action gradually converges to <Picture 1> at the end of the video.");
    const dialogue = audioMode === "separate_dialogue_track" ? "" : h3DialogueSentence(shot, characters, { cast, template });
    if (dialogue) {
        parts.push(dialogue);
        const performance = h3PerformanceHint(shot, characters, cast);
        if (performance) parts.push(performance);
    }
    const overlay = overlayClauseH3(overlays, textInImage);
    if (overlay) parts.push(overlay);
    if (stringNegativeList(shot).length) parts.push(`${positiveCleanClause()}。`);
    return parts.filter(Boolean).join(" ");
}

/**
 * 解析 + 校验改写稿：三段可解析、逐字锚点全在、剥离后正文不再残留锚点 → 返回三段文本；否则 null。
 * 任一条件不满足都回落同步稿（宁可中文，也绝不放翻译过的台词 / 丢字的画面文字进模型）。
 */
function h3ParseRewrite(raw, input) {
    if (!verifyH3Rewrite(raw, input).ok) return null;
    const sections = h3RewriteSections(raw);
    const anchors = h3RewriteAnchors(input);
    const { tag, dialogue, overlay } = h3VerbatimLock(input);
    const visual = stripH3VerbatimAnchors(sections.visual, anchors, tag);
    if (!hasText(visual)) return null;
    // 剥离后仍残留台词 / 画面文字 → 会与编译器直拼的规范块重复（台词与画面文字被渲染两遍），弃稿。
    if (dialogue.some((line) => visual.includes(line)) || overlay.some((item) => visual.includes(item))) return null;
    return { visual, soundscape: sections.soundscape, music: sections.music };
}

/* ------------------------------------------------------------------ *
 * 分级（tier）：一级强约束 / 二级画面细节
 * ------------------------------------------------------------------ *
 * 产品口径：提示词工程必须分级 ——
 *   · 一级（强约束）：风格锚点 / 画幅 / 比例 / 负面策略 / 画面内文字（textOverlays）。
 *     由编译器**直接拼上**，绝不进入改写器的输入，也不参与其输出；与二级冲突时永远优先。
 *   · 二级（画面细节）：主体 / 角色 / 景别 / 场景 / 动作 / 机位与运镜 / 光线 / 槽位对应关系，
 *     可交改写器改写。
 *   · 画面内文字（textOverlays）为什么属一级：调研口径要求它**逐字原文引用，不得翻译、改写、留空**
 *     （config/model-prompt-rules.json · *.prompt.text_in_image）。它是与画幅同级的生产硬事实，
 *     放进二级就给改写器改写/漏写的机会，故锁进一级、由编译器逐字拼上，改写器根本拿不到。
 *   · 冲突时二级服从一级：`aspectRatioConflict` 只做检测；命中后**不整稿弃用**，
 *     而是作废/纠正二级块（先纠正重写一次；仍冲突则只保留一级 + 同步结构稿的二级并记 warning）。
 *
 * ⚠️ 兼容红线：分级只作用于「有会消费 rewrite 的编译器」的模型
 *   （qwen_image_2_1 / krea2_turbo / flux1_dev）。
 *   无官方改写器的模型（z_image_turbo / boogu_edit / scail2 / wan22_animate / upscale …）
 *   走通用兜底或 H3 口径；H3 的**字段结构与锚点恒由编译器拼**，只有正文走专用整段英文化入口
 *   （见「编译器 1b」），不参与本分级表。
 */

/** 一级块（同步 / 降级产物）：风格锚点 → 画幅·比例 → 负面策略 → 画面内文字，顺序固定。 */
function tierOneSync(input) {
    const { style, template, overlays, shot } = input;
    const clauses = [];
    const { anchor } = readStyleFields(style);
    if (anchor) clauses.push(anchor);
    const aspect = aspectRatioClauseCn(style);
    if (aspect) clauses.push(aspect);
    const neg = negativeClause(template);
    if (neg) clauses.push(neg);
    if (stringNegativeList(shot).length) clauses.push(positiveCleanClause());
    const overlay = overlayClauseCn(overlays);
    if (overlay) clauses.push(overlay);
    return clauses;
}

/**
 * 一级块（改写成功产物）：风格锚点 → 画幅·比例 → 负面策略 → 画面内文字（英文口径），顺序固定。
 *
 * ⚠️ 风格锚点**无条件**由编译器直拼（不依赖是否存在画幅事实）：产品口径把「风格」定死为一级，
 * 改写器既不该看到它、也不该改写它。此前「仅在有画幅事实时前置、无画幅时随二级交付改写器」的
 * 例外已按本轮需求整块拆除 —— 无论有无画幅事实，锚点都只在一级块出现。
 */
function tierOneRewrite(input) {
    const { style, template, overlays } = input;
    const clauses = [];
    const { anchor } = readStyleFields(style);
    if (anchor) clauses.push(anchor);
    const aspect = aspectRatioClauseCn(style);
    if (aspect) clauses.push(aspect);
    const neg = negativeClause(template);
    if (neg) clauses.push(neg);
    const overlay = overlayClauseEn(overlays);
    if (overlay) clauses.push(overlay);
    return clauses;
}

/** 拼装：一级块在前、二级块在后（分隔用「；」）。 */
function assembleTiers(tierOne, tierTwo) {
    const flat = (value) => (Array.isArray(value) ? value : [value]).map((entry) => String(entry ?? "").trim()).filter(Boolean);
    return [...flat(tierOne), ...flat(tierTwo)].join("；");
}

/* ------------------------------------------------------------------ *
 * 编译器 2：Qwen-Image 2.1 系（qwen_image_2_1）—— 官方英文长 prompt 口径（分级）
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

/** Qwen 二级事实（同步 / 降级产物的中文事实句）：主体 / 景别 / 场景 / 画面内容 / 机位。 */
function qwenTierTwoFacts(input) {
    const { shot, scene, characters } = input;
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
    const shotSize = hasText(shot?.shotSize) ? String(shot.shotSize).trim() : "";
    if (shotSize) bits.push(`景别：${shotSize}`);
    if (sceneName) bits.push(`场景：${sceneName}`);
    if (action) bits.push(`画面内容：${action}`);
    const camera = cameraSentenceCn(shot);
    if (camera) bits.push(camera);
    return bits.join("；");
}

/** Qwen 二级块（同步 / 降级产物）：事实 + 参考图槽位映射；无结构化事实时退回旧版快照。 */
function qwenTierTwoSync(input) {
    const { slots, basePrompt, legacyBody, shot } = input;
    const facts = qwenTierTwoFacts(input);
    const refClause = qwenReferenceClause(slots);
    if (facts) return [facts, refClause].filter(Boolean);
    if (refClause) return [refClause];
    const base = String(basePrompt ?? legacyBody ?? shot?.prompt ?? "").trim();
    return base ? [stripTail(base)] : [];
}

/** Qwen 同步 / 降级产物主体（一级 + 二级；透明图咒语包裹）。 */
function qwenSyncBody(input) {
    const body = assembleTiers(tierOneSync(input), qwenTierTwoSync(input));
    return input.slots?.transparent ? qwenTransparentClause(body) : body;
}

/**
 * Qwen 2.1 编译器（分级）。
 * 一级（画幅·比例 / 负面 / 文字 / 风格）由编译器直拼，改写器看不到；
 * 有 rewrite → 只把它当二级块拼在一级之后；无 rewrite → 中文降级 + 显式 [untranslated] 标记。
 */
export function compileQwen21ImagePrompt(input = {}) {
    const { rewrite } = input;
    if (hasText(rewrite)) return assembleTiers(tierOneRewrite(input), [String(rewrite).trim()]);
    const body = qwenSyncBody(input);
    const marker = `[untranslated: 需经官方 qwen-image-2.1 pe 改写器英文化]`;
    return body ? `${body} ${marker}` : marker;
}

/* ------------------------------------------------------------------ *
 * 编译器 3：仅英文有官方依据的模型（krea2_turbo / flux1_dev）—— 分级
 * 无 LLM → 中文 + [untranslated] 标记；禁止默默发中文。
 * ------------------------------------------------------------------ */

/** Krea2 / FLUX 二级事实（同步 / 降级产物的中文事实句）。 */
function kreaFluxTierTwoFacts(input) {
    const { shot, scene, characters, basePrompt, legacyBody } = input;
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
    const base = String(basePrompt ?? legacyBody ?? shot?.prompt ?? "").trim();
    if (base) bits.push(stripTail(base));
    return bits.join("；");
}

/**
 * Krea2 / FLUX 分级编译器：一级直拼 + 二级可改写。
 * 有 rewrite → 只把它当二级块拼在一级之后；否则中文降级 + [untranslated] 标记。
 */
function compileKreaFluxPrompt(input, marker) {
    const { rewrite } = input;
    if (hasText(rewrite)) return assembleTiers(tierOneRewrite(input), [String(rewrite).trim()]);
    const body = assembleTiers(tierOneSync(input), [kreaFluxTierTwoFacts(input)]);
    return body ? `${body} ${marker}` : marker;
}

export function compileKrea2ImagePrompt(input = {}) {
    return compileKreaFluxPrompt(input, "[untranslated: Krea 2 仅英文有官方依据，需经 llmCall 翻译为英文]");
}

export function compileFluxImagePrompt(input = {}) {
    return compileKreaFluxPrompt(input, "[untranslated: FLUX.1 仅英文有官方依据，需经 llmCall 翻译为英文]");
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

/** 把模型无关事实拼成改写器输入的源文本（末尾附**不可改写**的生产事实约束）。 */
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
    // ⚠️ 同理：台词绝不进图像提示词（会被改写器渲染成画面内字幕）。说话动作由画面内容表达。
    const overlay = overlayClauseCn(overlays);
    if (overlay) bits.push(overlay);
    // 画幅不混进内容事实串里：单独一行作为约束，改写器只能表达、不能猜测或覆盖。
    const constraint = aspectRatioConstraint(style);
    const facts = bits.join("；");
    return constraint ? `${facts}\n${constraint}` : facts;
}

/**
 * 二级源文本（分级模型专用）：主体 / 景别 / 场景 / 画面内容 / 机位与运镜 / 台词。
 * **绝不含任何一级强约束**（风格锚点 / 画幅·比例 / 负面 / 画面内文字）——
 * 改写器看不到、也改不了它们。风格锚点无条件归一级块（tierOneRewrite）直拼，
 * 此前「无画幅事实时随二级源交付改写器」的例外已整块拆除。
 */
function tierTwoSourceText(input) {
    const { shot, scene, characters } = input;
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
    // ⚠️ 台词**绝不进图像提示词**（真跑溯源核实）：把 `台词：…` 交给图像改写器，官方 PE 会把台词
    // 逐字渲染成「画面底部三行白色中文字幕」（见 jobs 里 img_qwen21_edit 的 PROMPT 原文），
    // 于是关键帧图自带字幕，再被 H3 的 I2VA 原样烧进视频。产品口径是「台词归 TTS、字幕后期按音轨逐句烧」，
    // 图像只负责画面，说话动作由 action/画面内容表达。故此处不再输出台词正文。
    return bits.join("；");
}

/**
 * 无官方改写器、但模型仅英文有官方依据时的项目补充英文化 system（Krea2 / FLUX）。
 * 这不是厂商官方资产；官方改写器只在 model-registry/research 明确登记时使用。
 */
const ENGLISH_TRANSLATION_SYSTEM =
    "You rewrite an image-generation brief into one fluent, natural English prompt for a text-to-image model. " +
    "Preserve every quoted on-screen text string verbatim and keep all subjects, counts, colours, and positions. " +
    "Lines marked as fixed production facts (aspect ratio, orientation) must be carried over exactly as stated; never infer or invert them. " +
    "Output only the English prompt, no explanations.";

/** 二级纠正指令（不泄露一级画幅事实，只要求别再写画幅/方向）。 */
const TIER2_CORRECTION_NOTE = "纠正要求：只描述主体、动作、场景、机位与光线；不要提及画幅、构图方向、屏幕比例或画面宽高，也不要新增任何方向词。";

/** 该模板是否走分级编译（有会消费 rewrite 的编译器：qwen_image_2_1 / krea2_turbo / flux1_dev）。 */
function isTieredTemplate(template) {
    const key = ruleKeyForTemplate(template);
    return key === "qwen_image_2_1" || key === "krea2_turbo" || key === "flux1_dev";
}

/** 分级模型的同步二级块（供「仍冲突」时只保留一级 + 同步稿二级）。 */
function tieredSyncTierTwo(input) {
    const key = ruleKeyForTemplate(input.template);
    if (key === "krea2_turbo" || key === "flux1_dev") return [kreaFluxTierTwoFacts(input)];
    return qwenTierTwoSync(input);
}

/** 调一次改写器（官方改写器或项目补充的英文化路径），只喂二级源文本。 */
async function rewriteTierTwoOnce(input, llmCall, { correction = false } = {}) {
    const template = String(input?.template ?? "");
    let source = tierTwoSourceText(input);
    if (correction) source = `${source}\n${TIER2_CORRECTION_NOTE}`;
    if (!hasText(source)) return "";
    const rewriterId = rewriterForTemplate(template);
    if (rewriterId) {
        const out = await rewritePrompt({ rewriterId, text: source, targetLang: "en", context: { promptsDir: input.promptsDir }, llmCall });
        return out && hasText(out.text) ? String(out.text).trim() : "";
    }
    const out = await llmCall({ system: ENGLISH_TRANSLATION_SYSTEM, user: source });
    return hasText(out) ? String(out).trim() : "";
}

/**
 * async 编译入口（分级版）：模型官方要英文时，**只把二级画面细节**交给改写器 ——
 *   · 一级强约束（风格锚点 / 画幅·比例 / 负面 / 文字）由编译器直拼，
 *     不进改写器输入、不参与其输出（风格锚点**无条件**归一级，无论有无画幅事实）；
 *   · 二级经官方改写器（rewriterForTemplate 命中）或项目补充的通用英文化路径改写；
 *   · 二级出现相反画幅 → **不整稿弃用**：先纠正/重写二级块一次；仍冲突 → 只保留一级 + 同步结构稿的二级，
 *     并记 warning（宁可少写二级细节，也绝不把错误的画幅方向交给生成模型）；
 *   · H3 走**专用整段英文化入口**（三段标签源 + 逐字锚点锁），不进分级表；无改写稿时回落同步稿 + 标记；
 *   · 无官方改写器的其它模板（如 scail2）沿用既有改写流程；无改写器的模型直接回落 sync 出口。
 * `onWarning` 收集失败原因，供 API/流水线写入排查元数据；不把异常静默吞掉。
 * @returns {Promise<string>}
 */
export async function compilePromptForTemplateAsync(input = {}) {
    const template = String(input?.template ?? "");
    const llmCall = input?.llmCall;
    if (rewriteTargetLang(template) === "en" && typeof llmCall === "function") {
        // —— 分级模型（qwen / krea2 / flux）：改写器只处理二级块 ——
        if (isTieredTemplate(template)) {
            const source = tierTwoSourceText(input);
            if (hasText(source)) {
                try {
                    let rewritten = await rewriteTierTwoOnce(input, llmCall);
                    if (rewritten) {
                        const conflict = aspectRatioConflict(rewritten, input.style);
                        if (conflict) {
                            // 二级服从一级：不整稿弃用，只纠正/重写二级块一次。
                            const corrected = await rewriteTierTwoOnce(input, llmCall, { correction: true });
                            if (corrected && !aspectRatioConflict(corrected, input.style)) {
                                rewritten = corrected;
                            } else {
                                // 仍冲突 → 只保留一级 + 同步结构稿的二级，并记 warning。
                                if (typeof input.onWarning === "function") input.onWarning(new Error(conflict));
                                return assembleTiers(tierOneSync(input), tieredSyncTierTwo(input));
                            }
                        }
                        return assembleTiers(tierOneRewrite(input), [rewritten]);
                    }
                } catch (error) {
                    if (typeof input.onWarning === "function") input.onWarning(error);
                }
            }
            return compilePromptForTemplate(input);
        }
        // —— H3 专用入口：整段正文英文化（三段标签源 + 台词/画面文字逐字锁） ——
        // 不复用 rewriteSourceText：那是图片口径，不含 audio/music、且明确排除台词；H3 恰恰要求台词逐字在场。
        if (ruleKeyForTemplate(template) === "minimax_h3") {
            const h3Input = { ...input, textInImage: h3TextInImage(template) };
            const source = h3RewriteSourceText(h3Input);
            if (hasText(source)) {
                try {
                    const out = await llmCall({ system: H3_REWRITE_SYSTEM, user: source });
                    const rewritten = hasText(out) ? String(out).trim() : "";
                    if (rewritten) {
                        const compiled = compilePromptForTemplate({ ...h3Input, rewrite: rewritten });
                        // 编译器对未过逐字锁的改写稿会回落同步稿（带标记）→ 这里补记原因，供流水线/API 排查。
                        if (!compiled.includes("[untranslated")) return compiled;
                        const check = verifyH3Rewrite(rewritten, h3Input);
                        if (typeof input.onWarning === "function") input.onWarning(new Error(check.reason || "H3 改写稿未通过逐字锁校验，已回落同步稿"));
                    }
                } catch (error) {
                    if (typeof input.onWarning === "function") input.onWarning(error);
                }
            }
            return compilePromptForTemplate(input);
        }
        // —— 兼容：无分级编译器的模板（如 scail2）沿用既有改写流程 ——
        const source = rewriteSourceText(input);
        if (hasText(source)) {
            const rewriterId = rewriterForTemplate(template);
            try {
                let rewritten = "";
                if (rewriterId) {
                    const out = await rewritePrompt({ rewriterId, text: source, targetLang: "en", context: { promptsDir: input.promptsDir }, llmCall });
                    if (out && hasText(out.text)) rewritten = String(out.text).trim();
                } else {
                    const out = await llmCall({ system: ENGLISH_TRANSLATION_SYSTEM, user: source });
                    if (hasText(out)) rewritten = String(out).trim();
                }
                if (rewritten) {
                    const conflict = aspectRatioConflict(rewritten, input.style);
                    if (conflict) {
                        if (typeof input.onWarning === "function") input.onWarning(new Error(conflict));
                    } else {
                        return compilePromptForTemplate({ ...input, rewrite: rewritten });
                    }
                }
            } catch (error) {
                if (typeof input.onWarning === "function") input.onWarning(error);
            }
        }
    }
    return compilePromptForTemplate(input);
}

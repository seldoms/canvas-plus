/**
 * prompt-compiler —— 后端「提示词编译器」。
 *
 * 立身之本（产品负责人原话）：内容层只产出「模型无关的内容事实」（分镜/动作/机位/台词/文字），
 * **后端必须在「发起生成请求」那一刻，按所选模型的标准把内容编译成该模型要的提示词**，再发给模型接口。
 * 图片生成与视频生成一视同仁 —— 都要按各自模型的要求写。
 *
 * 设计原则：
 *   1. **按模型/模板分派**（COMPILER_RULES 有序表），不把所有模型塞进一个 if 堆；
 *      新增模型 = 往表里加一条 { id, match, compile }，调用方无需改动。
 *   2. **纯函数、零依赖**：除本项目内小工具外无 IO、无副作用，便于单测与干跑。
 *   3. **素材编号按「本次实际注入的槽位」生成**：编译器只读 `slots.images`（按注入顺序的有序数组），
 *      绝不把 @图片1/@图片2 的编号写死在内容层（上传顺序由流水线决定，写死在分镜里必然对不上）。
 *
 * 入口：compilePromptForTemplate({ template, family, shot, scene, characters, style, slots, overlays, legacyBody, item, durationSec }) → string
 *
 * slots 约定（流水线在「发起生成请求」时组装，见 pipeline.js 的 generativePlan）：
 *   {
 *     images: [{ url, kind: 'first_frame'|'last_frame'|'input_image'|'reference', role?: 'character'|'scene'|'prop', name?: '老周' }],
 *     transparent?: boolean,   // 该镜需要透明背景（有需要被抠的主体）时置 true（仅 Qwen 系使用）
 *   }
 */

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 生成提示词的风格出口（唯一）：首句锚点只在这里保证在场。与 pipeline.withPromptHead 同口径。 */
export function styleHead(style, text) {
    const body = String(text ?? "").trim();
    const anchor = String(style?.anchor ?? "").trim();
    const context = String(style?.context ?? "").trim();
    let head;
    if (!context) head = body;
    else if (anchor && body.startsWith(anchor)) head = body; // 锚点已在首句 → 不重复前置
    else head = body ? `${context}。${body}` : context;
    const layer = String(style?.filmLayer ?? "").trim();
    return layer ? `${head} ${layer}`.trim() : head;
}

/** 归一为字符串数组（去空、去非字符串）。 */
function asTextList(value) {
    return (Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/** 去尾标点，便于把一句话嵌进更长的句子。 */
function stripTail(text) {
    return String(text ?? "").trim().replace(/[。．.，,；;、\s]+$/u, "");
}

/** 只统计有效字符（CJK / 字母数字），用于按内容长度分配时间轴。 */
function contentLength(text) {
    const matches = String(text ?? "").match(/[\u4e00-\u9fff\uff00-\uffef0-9a-zA-Z]/g);
    return matches ? matches.length : 0;
}

/** 秒数格式化：1.5 → "1.5"，5 → "5"。 */
function fmtSec(value) {
    const n = Math.round(Number(value) * 10) / 10;
    return Number.isFinite(n) ? String(n) : "0";
}

/** 文本是否有实质内容。 */
function hasText(value) {
    return String(value ?? "").trim().length > 0;
}

/* ------------------------------------------------------------------ *
 * textOverlays：模型无关的「图上文字」，编译器负责逐字落地 + 明确「不增删改」
 * ------------------------------------------------------------------ */

/** kind → 中文语义前缀（中文提示词用）。 */
const OVERLAY_KIND_CN = Object.freeze({
    sign: "招牌文字",
    ticket: "票据文字",
    screen: "屏幕文字",
    logo: "标识文字",
    subtitle: "字幕",
});

/** kind → 英文语义前缀（通用/兜底编译器用，与 pipeline 的既有措辞一致）。 */
const OVERLAY_KIND_EN = Object.freeze({
    sign: "sign reading",
    ticket: "ticket text",
    screen: "screen text",
    logo: "logo text",
    subtitle: "subtitle text",
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

/** 中文「图上文字」子句：必须写原文、逐字准确（H3 / Qwen 中文提示词用）。 */
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

/* ------------------------------------------------------------------ *
 * 素材说明：按「本次实际注入的槽位」生成编号与用途
 * ------------------------------------------------------------------ */

/** 有序图片槽位（保留 url 存在的项）。 */
function slotImages(slots) {
    return (Array.isArray(slots?.images) ? slots.images : []).filter((img) => img && hasText(img.url));
}

/** H3 参考素材说明段：多图先声明上传顺序，再逐张写用途；无素材返回空串（官方：整段跳过）。 */
function h3MaterialSection(slots) {
    const images = slotImages(slots);
    if (!images.length) return "";
    const lines = [];
    if (images.length > 1) {
        lines.push(`图片上传顺序：${images.map((_, i) => `@图片${i + 1}`).join(" → ")}，编号严格按上传顺序对应。`);
    }
    images.forEach((img, index) => {
        const label = `@图片${index + 1}`;
        const who = hasText(img.name) ? `（${img.name}）` : "";
        let use;
        switch (img.kind) {
            case "first_frame":
                use = "是首帧参考图：锁定起始画面构图、主体位置与光线方向，只补首帧之后发生的动作、运镜、光影与声音；不切镜、不改变主体样貌与构图。";
                break;
            case "last_frame":
                use = "是尾帧参考图：与首帧之间只补过渡动作、光影与声音，不发生切镜。";
                break;
            case "reference":
                use =
                    img.role === "scene"
                        ? "是场景参考：锁定空间结构、色彩与光线方向。"
                        : img.role === "prop"
                          ? "是道具参考：锁定其外形、材质与颜色。"
                          : `是角色参考${who}：锁定面容、发型、服装与体型。`;
                break;
            default:
                use = `是参考底图${who}：以它为基准保持主体一致。`;
        }
        lines.push(`${label} ${use}`);
    });
    lines.push("忽略参考图中的背景、水印、界面文字与压缩伪影。");
    return lines.join("\n");
}

/** Qwen-Image 2.1 参考图引用行：<image1>/<image2> 对应 INPUT_IMAGE / REF_IMAGE_N 的注入顺序。 */
function qwenReferenceClause(slots) {
    const images = slotImages(slots);
    if (!images.length) return "";
    const parts = images.map((img, index) => {
        const tag = `<image${index + 1}>`;
        const who = hasText(img.name) ? `（${img.name}）` : "";
        switch (img.kind) {
            case "first_frame":
                return `${tag} 为本镜首帧，保持其构图、主体位置与光线一致`;
            case "last_frame":
                return `${tag} 为本镜尾帧，向该画面平滑过渡`;
            case "reference":
                return img.role === "scene"
                    ? `${tag} 为场景参考，锁定空间结构与光线方向`
                    : img.role === "prop"
                      ? `${tag} 为道具参考，锁定外形、材质与颜色`
                      : `${tag} 为角色参考${who}，锁定面容、发型、服装与体型`;
            default:
                return `${tag} 为参考底图${who}，以其主体为准`;
        }
    });
    return `参考图对应关系：${parts.join("；")}。`;
}

/* ------------------------------------------------------------------ *
 * 相机：把结构化 cameraSpec / 自然语言 camera 编译成模型要的运镜描述
 * ------------------------------------------------------------------ */

/** movement.type → H3 认识的运镜词（官方建议英文具体词，如 pan/truck）。 */
const MOVE_TERM = Object.freeze({
    static: "固定机位（static，无推拉摇移）",
    pan: "pan",
    tilt: "tilt",
    dolly: "dolly",
    tracking: "truck",
    truck: "truck",
    zoom: "zoom",
    push: "push in",
    pull: "pull out",
    handheld: "handheld",
    crane: "crane",
});

/** movement.speed → 中文速度词。 */
const SPEED_CN = Object.freeze({ slow: "缓速", normal: "匀速", medium: "中速", fast: "快速" });

/** 由 cameraSpec 生成一句具体运镜描述；无结构信息时回落 shot.camera 自然语言。 */
function cameraClause(shot) {
    const spec = shot?.cameraSpec && typeof shot.cameraSpec === "object" ? shot.cameraSpec : null;
    const movement = spec?.movement && typeof spec.movement === "object" ? spec.movement : null;
    if (movement && hasText(movement.type)) {
        const type = String(movement.type).trim().toLowerCase();
        const term = MOVE_TERM[type] || type;
        if (type === "static") return term;
        const direction = hasText(movement.direction) && String(movement.direction).toLowerCase() !== "none" ? ` ${String(movement.direction).trim()}` : "";
        const extras = [];
        if (hasText(movement.speed)) extras.push(SPEED_CN[String(movement.speed).trim().toLowerCase()] || `${String(movement.speed).trim()}`);
        if (hasText(movement.stabilization) && String(movement.stabilization) !== "steady") extras.push(String(movement.stabilization).trim());
        return `${term}${direction}${extras.length ? `（${extras.join("、")}）` : ""}`;
    }
    if (hasText(shot?.camera)) return stripTail(shot.camera);
    return "";
}

/** 景别 + 机位（中文）子句。 */
function framingClause(shot) {
    const size = hasText(shot?.shotSize) ? String(shot.shotSize).trim() : "";
    return size ? `${size}` : "";
}

/* ------------------------------------------------------------------ *
 * 动作分段：按时间轴分段，边界落在可见变化处（官方分段纪律）
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

/** 按句号/问号/叹号切成完整句（每句是一个完整微事件，可在句界分段）。 */
function splitSentences(text) {
    return String(text ?? "")
        .split(/(?<=[。！？!?])/u)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 把过程描述按时间轴分段：以「完整句」为微事件单位，按内容长度比例分配时长，最后一段补满到镜头时长。
 * 同一句内的连续动作不再拆分（不把同一未完成的动作相位拆两段）。
 */
function timePhases(process, seconds) {
    const sentences = splitSentences(process);
    if (!sentences.length) return [];
    const total = sentences.reduce((sum, s) => sum + Math.max(1, contentLength(s)), 0);
    const phases = [];
    let cursor = 0;
    sentences.forEach((text, index) => {
        const weight = Math.max(1, contentLength(text));
        const span = seconds * (weight / total);
        const start = cursor;
        const end = index === sentences.length - 1 ? seconds : cursor + span;
        cursor = end;
        phases.push({ text, start, end });
    });
    return phases;
}

/** 台词/时长对齐提示：把镜头时长明确写给模型（口型问题多源于台词与镜头不匹配）。 */
function dialogueLine(dialogue, seconds) {
    const text = String(dialogue ?? "").trim();
    if (!text) return "";
    // 只统计真正要说的字（剔除括号里的表演提示），经验：中文约 4 字/秒（含停顿）。
    const spoken = text.replace(/[（(][^）)]*[）)]/g, "");
    const estimate = contentLength(spoken) / 4;
    const hint = estimate > seconds ? `；本镜仅 ${fmtSec(seconds)} 秒，台词偏长，请压缩语速或删字以保证口型对齐` : "";
    return `台词（务必在本镜 ${fmtSec(seconds)} 秒内说完，语速与口型严格对齐${hint}）：${text}`;
}

/** H3「不想要」约束：负向词并入正向句（H3 无负向槽）。 */
function wantedExclusion(shot, negatives) {
    const extra = asTextList(negatives);
    const fixed = ["画面文字乱码", "多余人物", "字幕", "水印", "切镜"];
    const all = [...extra, ...fixed];
    return `不想要（避免出现）：${all.join("、")}。`;
}

/** 主负向词列表（shot.negativePrompt 可能是字符串或数组）。 */
function negativeList(shot) {
    const raw = shot?.negativePrompt ?? shot?.negative_prompt;
    if (Array.isArray(raw)) return asTextList(raw);
    if (hasText(raw)) return [String(raw).trim()];
    return [];
}

/* ------------------------------------------------------------------ *
 * 编译器 1：H3 系（family=video，模板名含 h3 / minimax_h3）
 * 输出官方三段式中文：【参考素材说明】+【核心创意】+【画面过程说明】
 * ------------------------------------------------------------------ */

export function compileH3VideoPrompt({ shot, scene, characters, style, slots, overlays, durationSec } = {}) {
    const seconds = Number(durationSec) > 0 ? Number(durationSec) : Number(shot?.durationSec) > 0 ? Number(shot.durationSec) : 5;
    const sections = [];

    // ① 参考素材说明（无素材整段跳过）
    const material = h3MaterialSection(slots);
    if (material) sections.push(`【参考素材说明】\n${material}`);

    // ② 核心创意：主体 + 地点 + 事件 + 题材风格 + 特殊运镜
    const names = (Array.isArray(characters) ? characters : [])
        .map((c) => String(c?.name ?? "").trim())
        .filter(Boolean);
    const subject = names.length ? names.join("、") : "画面主体";
    const place = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const shotSize = framingClause(shot);
    const event = stripTail(splitEndState(shot?.action).process) || stripTail(shot?.action) || stripTail(shot?.prompt);
    const styleBits = [String(style?.anchor ?? "").trim(), String(style?.flavor ?? "").trim()].filter(Boolean).join("，");
    const camera = cameraClause(shot);
    const coreParts = [`${subject}${place ? `，在${place}` : ""}${event ? `，${event}` : ""}`];
    if (shotSize) coreParts.push(`景别：${shotSize}`);
    if (camera) coreParts.push(`运镜：${camera}`);
    if (styleBits) coreParts.push(`题材风格：${styleBits}`);
    const images = slotImages(slots);
    if (images.some((img) => img.kind === "first_frame") && images.some((img) => img.kind === "last_frame")) {
        coreParts.push("首尾两帧之间只补动作、光影与声音，不发生切镜");
    }
    sections.push(`【核心创意】\n${coreParts.join("；")}。`);

    // ③ 画面过程说明：按时间轴分段，每段「想要」+「不想要」
    const process = [];
    const { process: processText, endState } = splitEndState(shot?.action);
    const phases = timePhases(processText, seconds);
    for (const phase of phases) {
        const tail = [];
        if (shotSize) tail.push(shotSize);
        tail.push(stripTail(phase.text));
        if (camera) tail.push(`运镜：${camera}`);
        process.push(`${fmtSec(phase.start)}-${fmtSec(phase.end)}秒：${tail.join("，")}。`);
    }
    if (endState) process.push(`段末可见状态（约 ${fmtSec(seconds)} 秒）：${endState}`);
    if (!phases.length && !endState && hasText(shot?.prompt)) process.push(`全程（0-${fmtSec(seconds)}秒）：${stripTail(shot.prompt)}`);

    const overlayCn = overlayClauseCn(overlays);
    if (overlayCn) process.push(overlayCn);
    const dialogue = dialogueLine(shot?.dialogue, seconds);
    if (dialogue) process.push(dialogue);
    if (hasText(shot?.audio)) process.push(`音效：${String(shot.audio).trim()}`);
    process.push("非叙事性音乐：N/A（只保留现场原声，不要 BGM）");
    process.push(wantedExclusion(shot, negativeList(shot)));
    sections.push(`【画面过程说明】\n${process.join("\n")}`);

    return sections.join("\n\n");
}

/* ------------------------------------------------------------------ *
 * 编译器 2：Qwen-Image 2.1 系（img_qwen21_t2i / img_qwen21_edit）
 * 中文提示词利于中文文字渲染；参考图以 <imageN> 引用；需要透明背景用官方 RGBA 句式
 * ------------------------------------------------------------------ */

export function compileQwen21ImagePrompt({ shot, scene, characters, style, slots, overlays, legacyBody, basePrompt } = {}) {
    // 官方透明背景句式：作为整段提示词的开头（仅当该镜需要被抠的主体时）。
    const rgbaHead = slots?.transparent
        ? "This is an RGBA format image with transparency. Isolate the subject with a clean transparent background, no background scene and no environment."
        : "";

    // 中文主体描述（中文提示词利于中文文字渲染）
    const names = (Array.isArray(characters) ? characters : [])
        .map((c) => {
            const name = String(c?.name ?? "").trim();
            const outfit = String(c?.outfit ?? "").trim();
            if (!name) return "";
            return outfit ? `${name}（${outfit}）` : name;
        })
        .filter(Boolean);
    const sceneName = hasText(scene?.name) ? String(scene.name).trim() : hasText(scene?.location) ? String(scene.location).trim() : "";
    const shotSize = framingClause(shot);
    const camera = cameraClause(shot);
    const action = stripTail(splitEndState(shot?.action).process || shot?.action);
    const cnBits = [];
    if (names.length) cnBits.push(`主体：${names.join("、")}`);
    if (shotSize) cnBits.push(`景别：${shotSize}`);
    if (sceneName) cnBits.push(`场景：${sceneName}`);
    if (action) cnBits.push(`画面内容：${action}`);
    if (camera) cnBits.push(`机位与运镜：${camera}`);
    let body = cnBits.length ? `${cnBits.join("；")}。` : "";

    // 参考图 <imageN> 引用行
    const refClause = qwenReferenceClause(slots);
    if (refClause) body += refClause;

    // 保留原静态生图描述（模型无关的内容事实；不动其英文语义）
    const base = String(basePrompt ?? legacyBody ?? shot?.prompt ?? "").trim();
    if (base && !body.includes(base)) {
        const cleaned = base.replace(/[.。]+$/u, "");
        body += `${cleaned}。`;
    }

    // 中文文字渲染指令：图上文字逐字落地。指令沿用既有「逐字」口径（双引号原文），
    // 既满足 Qwen 中文提示词，也不破坏既有对「文字逐字拼进 PROMPT」的回归断言。
    const overlayDirective = overlayClauseEn(overlays);
    if (overlayDirective) body += overlayDirective.endsWith("。") ? overlayDirective : `${overlayDirective}。`;

    const styled = styleHead(style, body);
    return rgbaHead ? `${rgbaHead} ${styled}`.trim() : styled;
}

/* ------------------------------------------------------------------ *
 * 编译器 3：通用兜底（其它所有模板）
 * 把 shot.prompt + textOverlays 逐字 + 风格锚点拼好，保持与既有行为兼容、不退化
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
 * 分派表：新增模型只需追加一条规则
 * ------------------------------------------------------------------ */

/** 模板名/家族 → 编译器。有序：先命中先返回；最后一条是 catch-all 兜底。 */
export const COMPILER_RULES = Object.freeze([
    {
        id: "h3-video",
        // H3 系：视频家族，模板名含 h3 / minimax_h3（video_h3_i2v / video_minimax_h3_t2v / video_h3_ref2v* / video_h3_talk …）
        match: ({ template, family }) => family === "video" && /(^|[_-])h3|minimax[_-]?h3/i.test(String(template ?? "")),
        compile: compileH3VideoPrompt,
    },
    {
        id: "qwen-image-2.1",
        // Qwen-Image 2.1 系：img_qwen21_t2i / img_qwen21_edit（含 qwen21 / qwen-image-2.1 变体）
        match: ({ template }) => /qwen[\s_-]?image[\s_-]?2[._-]?1|qwen21/i.test(String(template ?? "")),
        compile: compileQwen21ImagePrompt,
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
 * @returns {string} 编译后的 PROMPT（仍是字符串，ComfyUI 槽语义不变）
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

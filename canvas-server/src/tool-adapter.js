import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * tool-adapter —— 把 ComfyUI 模板「实际能吃哪些输入」变成机器可查询的能力声明。
 *
 * 设计原则（对应 development-plan §11.5.4）：
 *   1. 能力必须靠扫模板 JSON 的**真实节点 / 占位符**得出，不得硬编码模板名单；
 *      换一个新模板（哪怕文件名没规律）也应被自动识别。
 *   2. 当镜头需要「参考图锁角色」而所选模板根本没有参考图入口时，必须**显式**判不可用，
 *      绝不能返回 ok:true 假装角色已锁定。
 *
 * 纯函数：除 scanTemplateDir 读模板目录外零 IO，无副作用，无外部依赖。
 */

/** 模板里的输入占位符形如 {{TOKEN}}（与 providers/comfy.js 的 TOKEN_RE 约定一致）。 */
const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/** REF_IMAGE_<n> 是「额外参考图」槽位。 */
const REF_IMAGE_TOKEN_RE = /^REF_IMAGE_(\d+)$/;

/** 主输入图槽位。 */
const PRIMARY_IMAGE_TOKEN = "INPUT_IMAGE";

/** 语义明确的其他图像素材槽位（如换装模板的人物图 / 服装图）。 */
const EXTRA_IMAGE_TOKENS = new Set(["PERSON_IMAGE", "CLOTHING_IMAGE"]);

/** 约定的额外参考图上限 1..9（与 generate.js ASSET_TOKENS 对齐）。 */
const MAX_REF_IMAGE_SLOTS = 9;

/** 判定一个占位符名是否是「图像素材输入槽」。 */
function isImageSlotToken(name) {
    return name === PRIMARY_IMAGE_TOKEN || EXTRA_IMAGE_TOKENS.has(name) || REF_IMAGE_TOKEN_RE.test(name);
}

/** 提取一段文本里的全部 {{TOKEN}} 名。 */
function tokensIn(text) {
    const found = new Set();
    for (const match of String(text).matchAll(TOKEN_RE)) found.add(match[1]);
    return found;
}

/** 规范化输入：接受已解析的对象或 JSON 字符串，非法输入归一为 {}. */
function graphOf(workflowJson) {
    if (workflowJson == null) return {};
    if (typeof workflowJson === "string") {
        const parsed = JSON.parse(workflowJson);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    return typeof workflowJson === "object" ? workflowJson : {};
}

/** 取出模板里所有节点对象（ComfyUI 导出格式：顶层键 → { class_type, inputs, ... }）。 */
function nodesOf(graph) {
    return Object.values(graph).filter((node) => node && typeof node === "object" && !Array.isArray(node));
}

/**
 * 从真实节点里算出「图像输入槽」：只有存在 LoadImage 节点、且它的 image 输入引用了某个
 * 图像占位符时，该槽位才算被模板真正消费。纯文生图模板没有 LoadImage，自然得到空集。
 */
function imageSlotsFromNodes(graph) {
    const slots = new Set();
    for (const node of nodesOf(graph)) {
        if (node.class_type !== "LoadImage") continue;
        const image = node.inputs?.image;
        if (typeof image !== "string") continue;
        for (const name of tokensIn(image)) {
            if (isImageSlotToken(name)) slots.add(name);
        }
    }
    return slots;
}

/** 参考图槽位排序：主输入图在前，REF_IMAGE_n 按序号，其余按字典序。 */
function sortSlots(a, b) {
    if (a === PRIMARY_IMAGE_TOKEN) return -1;
    if (b === PRIMARY_IMAGE_TOKEN) return 1;
    const ra = REF_IMAGE_TOKEN_RE.exec(a);
    const rb = REF_IMAGE_TOKEN_RE.exec(b);
    if (ra && rb) return Number(ra[1]) - Number(rb[1]);
    if (ra) return -1;
    if (rb) return 1;
    return a.localeCompare(b);
}

/**
 * 依据真实节点类型判定模板产出能力。
 * 只要图中出现任何 Video 类节点（SaveVideo / VHS_VideoCombine / *ToVideo / VHS_LoadVideo ...）
 * 即视为 video；否则看是否有生图/解码/放大类节点（SaveImage / EmptyLatentImage / VAEDecode ...）判为 image；
 * 两者都无则 other。
 */
function capabilityFromNodes(graph) {
    const classTypes = new Set();
    for (const node of nodesOf(graph)) {
        if (typeof node.class_type === "string") classTypes.add(node.class_type);
    }
    if ([...classTypes].some((name) => /video/i.test(name))) return "video";
    if ([...classTypes].some((name) => /(saveimage|latentimage|vaedecode|upscale|loadimage|encodeimage|image)/i.test(name))) return "image";
    return "other";
}

/**
 * 分析单个模板，产出能力声明。
 *
 * @param {object|string} workflowJson 导出的 workflow JSON（对象或字符串）
 * @returns {{
 *   slots: Record<string, boolean>,   // 每个输入槽能否被喂：PROMPT / INPUT_IMAGE / REF_IMAGE_1..9 / PERSON_IMAGE / CLOTHING_IMAGE
 *   capability: 'image'|'video'|'other',
 *   supportsReference: boolean,       // 是否「吃得下参考图」
 *   maxReferenceImages: number,       // 图像输入槽总数（主输入图 + 额外参考图 + 人物/服装图）
 *   referenceSlots: string[],         // 有序的、机器可读的图像输入槽名
 *   tokens: string[],                 // 模板里出现的全部占位符
 * }}
 */
export function analyzeTemplate(workflowJson) {
    const graph = graphOf(workflowJson);
    const tokens = tokensIn(JSON.stringify(graph));
    const imageSlots = imageSlotsFromNodes(graph);

    const slots = { PROMPT: tokens.has("PROMPT"), [PRIMARY_IMAGE_TOKEN]: imageSlots.has(PRIMARY_IMAGE_TOKEN) };
    for (let index = 1; index <= MAX_REF_IMAGE_SLOTS; index += 1) {
        slots[`REF_IMAGE_${index}`] = imageSlots.has(`REF_IMAGE_${index}`);
    }
    for (const name of EXTRA_IMAGE_TOKENS) slots[name] = imageSlots.has(name);

    const referenceSlots = [...imageSlots].sort(sortSlots);

    return {
        slots,
        capability: capabilityFromNodes(graph),
        supportsReference: referenceSlots.length > 0,
        maxReferenceImages: referenceSlots.length,
        referenceSlots,
        tokens: [...tokens].sort(),
    };
}

/**
 * 扫描模板目录下的 *.json，返回 { <模板名>: <analyzeTemplate 结果> }。
 * 目录不存在 / 为空时返回 {}（不抛错，便于上层无模板时降级）。
 */
export function scanTemplateDir(dir) {
    if (!dir || !existsSync(dir)) return {};
    const catalog = {};
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
        const name = file.slice(0, -".json".length);
        catalog[name] = analyzeTemplate(readFileSync(join(dir, file), "utf8"));
    }
    return catalog;
}

/**
 * 为镜头解析所选模板是否可用。
 *
 * @param {object} options
 * @param {string|object} options.template 模板名（在 catalog 中查）或直接是 analyzeTemplate 结果
 * @param {boolean|number} [options.needReferenceImages] 是否/需要几张参考图来锁角色
 * @param {Record<string, object>} [options.catalog] scanTemplateDir 的结果
 * @returns {{ ok: boolean, reason: string, template: string }}
 *
 * 关键约束：needReferenceImages > 0 且模板 supportsReference === false 时，**必须** ok:false，
 * 并给出可解释的 reason；绝不返回 ok:true 假装角色已锁定。
 */
export function resolveToolForShot({ template, needReferenceImages = 0, catalog = {} } = {}) {
    let name = "";
    let info = null;

    if (template && typeof template === "object") {
        info = template;
        name = String(template.name || template.template || "<inline>");
    } else {
        name = String(template ?? "").trim();
        info = name && catalog ? catalog[name] : null;
    }

    if (!name || !info) {
        return { ok: false, template: name, reason: name ? `未知模板：${name}` : "缺少 template" };
    }

    const need = needReferenceImages === true ? 1 : needReferenceImages === false ? 0 : Number(needReferenceImages) || 0;

    if (need > 0) {
        if (!info.supportsReference) {
            const candidates = listReferenceCapableTemplates(catalog, info.capability);
            const hint = candidates.length ? `，可改用：${candidates.join("、")}` : "";
            return {
                ok: false,
                template: name,
                reason: `模板 ${name} 不支持参考图（未检测到任何 LoadImage 图像输入槽），无法锁定角色${hint}`,
            };
        }
        if (need > info.maxReferenceImages) {
            return {
                ok: false,
                template: name,
                reason: `模板 ${name} 最多接受 ${info.maxReferenceImages} 张参考图，镜头需要 ${need} 张`,
            };
        }
        return { ok: true, template: name, reason: `模板 ${name} 支持 ${info.maxReferenceImages} 张参考图，可锁定角色` };
    }

    return { ok: true, template: name, reason: `模板 ${name} 可用` };
}

/**
 * 列出「吃得下参考图」的模板名，供上层为需要锁角色的镜头选型。
 *
 * @param {Record<string, object>} catalog scanTemplateDir 的结果
 * @param {string} [capability] 可选，按 image / video 过滤
 * @returns {string[]} 有序模板名数组
 */
export function listReferenceCapableTemplates(catalog = {}, capability) {
    return Object.entries(catalog || {})
        .filter(([, info]) => info && info.supportsReference && (!capability || info.capability === capability))
        .map(([name]) => name)
        .sort();
}

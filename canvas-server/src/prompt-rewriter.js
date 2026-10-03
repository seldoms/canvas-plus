/**
 * prompt-rewriter.js —— 官方提示词改写器（策略层资产）
 *
 * 职责：把「内容事实」（分镜拼接出来的事实文本）按**目标模型的官方改写规范**
 * 改写成该模型真正吃的提示词——主要是语言适配与结构化改写。
 *
 * 五个官方改写器原文落在 `prompts/rewriters/*.md`（逐字抓取自各官方仓库/官方模板
 * JSON，见文件头 `rewriter-meta`）。本模块只负责：
 *   1. 选对改写器 + 选对变体（Wan 六套 / Qwen T2I·Edit / 2.1 PE / Boogu / SCAIL-2 两段式）；
 *   2. 把选中的**系统提示词**交给调用方注入的 `llmCall`（模块内绝不发网络请求）；
 *   3. 做官方口径的**后处理**（Qwen T2I 拼 magic prompt；Qwen Edit 解析 JSON 取 Rewritten）
 *      与**上限提示**（如 Qwen T2I <200 词 → truncated 标记）。
 *
 * ⚠️ 合规：Boogu 改写器原第 14 条「安全改写」条款已在本项目落盘资产中**整条剔除**
 *    （依据《AGENTS.md · 内容创作规范》「风险只提示、不改稿」）。本模块不做任何内容
 *    审查、过滤或规避；风险只能由调用方以独立字段/文件提示用户，绝不改稿。
 *
 * 依赖：仅 node 内置 fs/path/url。零外部依赖、零网络。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 官方改写器资产目录（canvas-server/prompts/rewriters/）。 */
export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/rewriters/", import.meta.url));

/** 五个官方改写器 id（对外契约，固定）。 */
export const REWRITER_IDS = Object.freeze([
    "wan-prompt-extend",
    "qwen-image-rewrite",
    "qwen-image-2.1-pe",
    "boogu-rewriter",
    "scail2-enhancer",
]);

/** H3 官方云端手册的提示词字符上限（研究结论，非改写器；仅作出境提示用）。 */
export const H3_MAX_PROMPT_CHARS = 7000;

/**
 * 改写器登记表。`impl` 语义：
 *   - `"prompt"`：系统提示词全文可取，可直接喂给任意 LLM；
 *   - `"weights"`：官方实现是专用微调权重，系统提示词不足以复现 → 返回「需专用权重」信号，不假装能用。
 * `variants` 只登记可选项名（正文在 md 文件里）；`hardWords` 为该变体的**硬**字数上限。
 */
export const REWRITERS = Object.freeze({
    "wan-prompt-extend": Object.freeze({
        file: "wan-prompt-extend.md",
        impl: "prompt",
        languages: Object.freeze(["zh", "en"]),
        variants: Object.freeze(["lm_zh", "lm_en", "vl_zh", "vl_en", "vl2_zh", "vl2_en"]),
        // 官方口径：改写后 80~100 字（软目标，不截断）。
        targetWords: Object.freeze([80, 100]),
    }),
    "qwen-image-rewrite": Object.freeze({
        file: "qwen-image-rewrite.md",
        impl: "prompt",
        languages: Object.freeze(["zh", "en"]),
        variants: Object.freeze(["t2i_en", "t2i_zh", "edit"]),
        // T2I 官方硬约束：改写后 <200 词；Edit 无字数上限。
        hardWords: Object.freeze({ t2i_en: 200, t2i_zh: 200 }),
        magicSuffix: Object.freeze({ t2i_en: "Ultra HD, 4K, cinematic composition", t2i_zh: "超清，4K，电影级构图" }),
    }),
    "qwen-image-2.1-pe": Object.freeze({
        file: "qwen-image-2.1-pe.md",
        // 官方实现是 Qwen3.5-VL 9B 专用微调权重；但系统提示词全文在本地官方模板 JSON 中可取，
        // 故按调研口径走 `prompt`（用通用 LLM 跑同一系统提示词为降级替代）。
        impl: "prompt",
        officialImpl: "weights",
        variants: Object.freeze(["pe_t2i", "pe_i2i"]),
        // 官方 PE-T2I 预期产出 400~500 词（目标区间，不截断）。
        targetWords: Object.freeze([400, 500]),
    }),
    "boogu-rewriter": Object.freeze({
        file: "boogu-rewriter.md",
        impl: "prompt",
        languages: Object.freeze(["zh", "en"]),
        variants: Object.freeze(["zh", "en"]),
        // ⚠️ 原第 14 条「安全改写」已在档案中整条剔除（见 md 文件「剔除说明」）。
        strippedClause: "boogu-14",
    }),
    "scail2-enhancer": Object.freeze({
        file: "scail2-enhancer.md",
        impl: "prompt",
        variants: Object.freeze(["caption", "replacement"]),
        defaultVariant: "replacement",
        // 第二段官方口径：英文一段 90~140 词（目标区间，不截断）。
        targetWords: Object.freeze([90, 140]),
    }),
});

// ————————————————————— 解析 prompts/rewriters/*.md —————————————————————

/** 解析文件头的 `<!-- rewriter-meta ... -->` 块为对象。 */
function parseMeta(raw) {
    const m = String(raw).match(/<!--\s*rewriter-meta\s*\n([\s\S]*?)-->/);
    if (!m) return {};
    const meta = {};
    for (const line of m[1].split("\n")) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key) meta[key] = value;
    }
    return meta;
}

/** 解析 `<<<KIND id="x">>> ... <<<END-KIND>>>` 块为 { id: text }。 */
function parseBlocks(raw, kind) {
    const re = new RegExp(`<<<${kind} id="([^"]+)">>>\\n([\\s\\S]*?)\\n<<<END-${kind}>>>`, "g");
    const out = {};
    let m;
    while ((m = re.exec(raw)) !== null) out[m[1]] = m[2];
    return out;
}

/**
 * 读取某个改写器的落盘资产。文件不存在/不可读 → 返回 null（容错，不抛）。
 * @param {string} rewriterId
 * @param {{dir?: string}} [opts] dir：资产目录覆盖（测试/多环境用）
 */
export function loadRewriterFile(rewriterId, { dir } = {}) {
    const def = REWRITERS[rewriterId];
    if (!def) return null;
    const baseDir = dir || PROMPTS_DIR;
    const path = join(baseDir, def.file);
    if (!existsSync(path)) return null;
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    } catch {
        return null;
    }
    const prompts = parseBlocks(raw, "REWRITER-PROMPT");
    if (Object.keys(prompts).length === 0) return null;
    return {
        rewriterId,
        path,
        meta: parseMeta(raw),
        prompts,
        assets: parseBlocks(raw, "REWRITER-ASSET"),
        raw,
    };
}

/** 取某个改写器某个变体的系统提示词原文；取不到返回 null。 */
export function systemPromptFor(rewriterId, variantId, { dir } = {}) {
    const file = loadRewriterFile(rewriterId, { dir });
    if (!file) return null;
    return file.prompts[variantId] ?? null;
}

/** 列出全部改写器（id + 元数据 + 变体），供策略层/前端展示。 */
export function listRewriters() {
    return REWRITER_IDS.map((id) => {
        const def = REWRITERS[id];
        const file = loadRewriterFile(id);
        return {
            rewriterId: id,
            impl: def.impl,
            officialImpl: def.officialImpl ?? null,
            variants: [...def.variants],
            warnings: file?.meta?.warning ?? null,
            strippedClause: def.strippedClause ?? null,
            available: Boolean(file),
        };
    });
}

// ————————————————————— 变体选择 —————————————————————

/** 判断文本主语言：含 CJK 视为 zh，否则 en（对齐官方 get_caption_language 的粗判）。 */
export function detectLang(text) {
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text ?? "")) ? "zh" : "en";
}

function pickLang(targetLang, text, fallback) {
    const lang = String(targetLang ?? "").toLowerCase();
    if (lang === "zh" || lang === "en") return lang;
    if (lang) return lang; // 其它语言由调用方按需处理
    if (fallback) return fallback;
    return text != null && String(text).length ? detectLang(text) : "zh";
}

/** 各改写器的变体选择器：返回变体 id（若该 id 不在登记表内则为非法）。 */
const VARIANT_SELECTORS = Object.freeze({
    "wan-prompt-extend": (o) => {
        const ctx = o.context || {};
        let mode = "lm";
        if (ctx.wan === "vl" || ctx.wan === "vl2") mode = ctx.wan;
        else if (ctx.multiImages || ctx.multi_images) mode = "vl2";
        else if (ctx.vl || ctx.image) mode = "vl";
        const lang = pickLang(o.targetLang, o.text, "zh"); // 官方默认 tar_lang='zh'
        return `${mode}_${lang === "en" ? "en" : "zh"}`;
    },
    "qwen-image-rewrite": (o) => {
        const ctx = o.context || {};
        const isEdit = ctx.qwenEdit === true || ctx.edit === true || ctx.task === "edit" || ctx.kind === "edit";
        if (isEdit) return "edit";
        return pickLang(o.targetLang, o.text, undefined) === "zh" ? "t2i_zh" : "t2i_en";
    },
    "qwen-image-2.1-pe": (o) => {
        const ctx = o.context || {};
        const isI2I = ctx.peTask === "i2i" || ctx.peTask === "edit" || ctx.qwenEdit === true || ctx.task === "edit";
        return isI2I ? "pe_i2i" : "pe_t2i";
    },
    "boogu-rewriter": (o) => {
        const lang = pickLang(o.targetLang, o.text, undefined);
        return lang === "en" ? "en" : "zh"; // 官方默认中国语境
    },
    "scail2-enhancer": (o) => {
        const ctx = o.context || {};
        if (ctx.scail2Stage === "caption" || ctx.stage === "caption") return "caption";
        return "replacement";
    },
});

/**
 * 计算一次改写的执行计划（纯函数，不读盘、不发请求），便于测试与调用方预检。
 * @returns {{rewriterId:string, variantId:string, impl:string, file:string,
 *            systemPromptPath:string|null, requiresWeights:boolean,
 *            targetWords?:number[], hardWords?:number, magicSuffix?:string}}
 */
export function buildPlan(rewriterId, { targetLang, text, context } = {}, registry = REWRITERS, dir) {
    const def = registry[rewriterId];
    if (!def) throw new TypeError(`未知改写器 rewriterId: ${rewriterId}`);
    const selector = VARIANT_SELECTORS[rewriterId];
    const variantId = selector ? selector({ targetLang, text, context }) : def.defaultVariant;
    const impl = def.impl || "prompt";
    return {
        rewriterId,
        variantId,
        impl,
        officialImpl: def.officialImpl ?? null,
        requiresWeights: impl === "weights",
        file: def.file,
        systemPromptPath: def.file ? join(dir || PROMPTS_DIR, def.file) : null,
        targetWords: def.targetWords ?? null,
        hardWords: def.hardWords?.[variantId] ?? null,
        magicSuffix: def.magicSuffix?.[variantId] ?? null,
        strippedClause: def.strippedClause ?? null,
    };
}

// ————————————————————— 后处理 —————————————————————

/** 统计词数：含 CJK 时按「CJK 字数 + 拉丁词数」，否则按空白切词。 */
export function countWords(text) {
    const s = String(text ?? "");
    const cjk = s.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
    if (cjk && cjk.length) {
        const latin = s.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
        return cjk.length + latin;
    }
    return s.trim() ? s.trim().split(/\s+/).filter(Boolean).length : 0;
}

/** 从可能带 ```json 围栏/前后缀散字的回复里解析 `{"Rewritten": "..."}`。 */
function extractRewritten(raw) {
    const cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
    const tryParse = (s) => {
        try {
            const o = JSON.parse(s);
            if (o && typeof o.Rewritten === "string") return o.Rewritten;
        } catch {
            /* ignore */
        }
        return null;
    };
    const direct = tryParse(cleaned);
    if (direct != null) return { text: direct, parsed: true };
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
        const nested = tryParse(m[0]);
        if (nested != null) return { text: nested, parsed: true };
    }
    return { text: String(raw), parsed: false };
}

/** 填充 SCAIL-2 第二段模板的 {instruction}/{caption}/{examples} 槽位（split/join 避免正则转义）。 */
function fillScail2(template, fill) {
    let out = template;
    for (const key of ["instruction", "caption", "examples"]) {
        if (fill && fill[key] != null) out = out.split(`{${key}}`).join(String(fill[key]));
    }
    return out;
}

// ————————————————————— 主入口 —————————————————————

/**
 * 按目标模型规范改写源文本。
 *
 * @param {object} o
 * @param {string} o.rewriterId   'wan-prompt-extend'|'qwen-image-rewrite'|'qwen-image-2.1-pe'|'boogu-rewriter'|'scail2-enhancer'
 * @param {string} o.text         待改写的源文本（分镜事实拼接）
 * @param {string} [o.targetLang] 'en'|'zh'|...
 * @param {object} [o.context]    变体选择信息（wan 的 'lm'|'vl'|'vl2' 与语言；qwen-edit 的任务类型；scail2 的 stage/fill；promptsDir 覆盖等）
 * @param {Function} o.llmCall    **调用方注入**的 LLM 调用：async ({system,user}) => string（模块内不发请求）
 * @returns {Promise<{text:string, meta:{rewriterId:string, variant:string, systemPromptPath:string, chars:number, truncated:boolean, impl:string, [k:string]:any}}>}
 */
export async function rewritePrompt(o = {}) {
    const { rewriterId, text, targetLang, context = {} } = o;
    const llmCall = o.llmCall;

    if (typeof rewriterId !== "string" || !REWRITERS[rewriterId]) {
        throw new TypeError(`未知改写器 rewriterId: ${String(rewriterId)}`);
    }
    if (typeof llmCall !== "function") {
        throw new TypeError("llmCall 必须由调用方注入（async ({system,user}) => string）");
    }
    if (typeof text !== "string" || !text.trim()) {
        throw new TypeError("text 必须是非空字符串");
    }

    const dir = context.promptsDir;
    const plan = buildPlan(rewriterId, { targetLang, text, context }, REWRITERS, dir);

    // 官方实现是专用权重、且系统提示词不足以复现 → 显式返回「需专用权重」信号，不假装能用。
    if (plan.requiresWeights) {
        return {
            text: "",
            meta: {
                rewriterId,
                variant: plan.variantId,
                impl: "weights",
                requiresWeights: true,
                systemPromptPath: plan.systemPromptPath,
                chars: 0,
                truncated: false,
                reason: "该改写器的官方实现是专用微调权重，系统提示词不足以复现；请部署对应权重（见 prompts/rewriters 元数据）。",
            },
        };
    }

    const file = loadRewriterFile(rewriterId, { dir });
    if (!file) {
        throw new Error(`改写器提示词文件缺失：prompts/rewriters/${REWRITERS[rewriterId].file}（无法加载 ${rewriterId}）`);
    }
    let systemPrompt = file.prompts[plan.variantId];
    if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
        throw new Error(`改写器 ${rewriterId} 缺少变体 ${plan.variantId} 的系统提示词`);
    }

    // SCAIL-2 第二段：官方用 .format() 填入 instruction/caption/examples。
    let filled = false;
    if (rewriterId === "scail2-enhancer" && plan.variantId === "replacement") {
        const fill = context.scail2 || context.fill || null;
        if (fill) {
            const next = fillScail2(systemPrompt, fill);
            filled = next !== systemPrompt;
            systemPrompt = next;
        }
    }

    const raw = await llmCall({ system: systemPrompt, user: text });

    // —— 后处理 ——
    let modelOut = String(raw ?? "");
    let parsed = null;
    if (rewriterId === "qwen-image-rewrite" && plan.variantId === "edit" && context.parseJson !== false) {
        const r = extractRewritten(modelOut);
        modelOut = r.text;
        parsed = r.parsed ? "json" : "raw";
    }

    // 字数上限针对「模型改写出来的提示词」，不含 magic suffix —— 先量后拼。
    const words = countWords(modelOut);
    const hard = plan.hardWords;
    const truncated = Boolean(hard && words > hard);

    let out = modelOut;
    let magicAppended = false;
    if (plan.magicSuffix && context.appendMagic !== false) {
        // 官方 prompt_utils 为直接拼接（`polished_prompt + magic_prompt`），此处保持官方口径。
        out = out.trim() + plan.magicSuffix;
        magicAppended = true;
    }

    const meta = {
        rewriterId,
        variant: plan.variantId,
        impl: plan.impl,
        systemPromptPath: file.path,
        chars: out.length,
        truncated,
    };
    if (plan.officialImpl) meta.officialImpl = plan.officialImpl;
    meta.words = words;
    if (hard) meta.limit = { words: hard, actual: words, enforced: "flag-only" };
    if (plan.targetWords) meta.targetRange = { words: plan.targetWords };
    if (magicAppended) meta.magicAppended = true;
    if (parsed) meta.parsed = parsed;
    if (rewriterId === "scail2-enhancer" && plan.variantId === "replacement") meta.slotsFilled = filled;
    if (plan.strippedClause) meta.strippedClause = plan.strippedClause;

    return { text: out, meta };
}

// ————————————————————— 模板 → 改写器 桥接 —————————————————————

/**
 * 依据调研把「模型模板名」映射到该用的官方改写器 id。
 * 规则（研究结论 optimization.md §3.1/§3.2/§3.4/§3.5）：
 *   - Wan 全系（Wan2.1/2.2、WanAnimate）与 SCAIL-2（Wan 基座）→ `wan-prompt-extend`；
 *   - Qwen-Image 2.1 → `qwen-image-2.1-pe`；其余 Qwen-Image 系（T2I / Edit 2509·2511）→ `qwen-image-rewrite`；
 *   - Boogu → `boogu-rewriter`；
 *   - SCAIL-2 换人/替换专用 → `scail2-enhancer`（两段式）。
 * @param {string} templateName
 * @returns {string|null} 改写器 id；无官方改写器（如 H3/FLUX/Krea2/ZImage/放大/TTS）返回 null
 */
export function rewriterForTemplate(templateName) {
    const d = rewriterDescriptorForTemplate(templateName);
    return d ? d.rewriterId : null;
}

/** 同 `rewriterForTemplate`，但返回完整描述（含 reason / alternatives）。 */
export function rewriterDescriptorForTemplate(templateName) {
    const raw = String(templateName ?? "").trim();
    if (!raw) return null;
    const name = raw.toLowerCase();
    if (/replac|换人|swap/.test(name)) {
        return { rewriterId: "scail2-enhancer", reason: "SCAIL-2 换人/角色替换专用两段式改写器（caption → 合成）", alternatives: ["wan-prompt-extend"] };
    }
    if (/^scail2|wan/.test(name)) {
        return { rewriterId: "wan-prompt-extend", reason: "Wan 全系及 Wan 基座的 SCAIL-2/WanAnimate 用官方 prompt_extend", alternatives: ["scail2-enhancer"] };
    }
    if (/^img[_-]?qwen/i.test(name) || /qwen-?image/i.test(name)) {
        if (/2[._-]?1/.test(name)) {
            return { rewriterId: "qwen-image-2.1-pe", reason: "Qwen-Image 2.1 用官方 PE（PE-T2I / PE-I2I）", alternatives: ["qwen-image-rewrite"] };
        }
        return { rewriterId: "qwen-image-rewrite", reason: "Qwen-Image 系（T2I / Edit 2509·2511）用官方 prompt_utils 改写器", alternatives: ["qwen-image-2.1-pe"] };
    }
    if (/boogu/.test(name)) {
        return { rewriterId: "boogu-rewriter", reason: "Boogu 用官方 Qwen3-VL 改写器（最小改写原则；已剔除第 14 条）", alternatives: [] };
    }
    return null;
}

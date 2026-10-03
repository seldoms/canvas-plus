/**
 * prompt-api.js —— `POST /api/prompt/compile` 的业务 + 路由装配（提示词策略层的对外入口）。
 *
 * 职责：把请求体（模型无关的内容事实 + 目标模板）交给 prompt-compiler 按该模型标准编译成提示词，
 * 并把「是否经过官方改写器英文化」等元数据一并回给排查/运维用（**前端不得渲染**，见 AGENTS.md 内容创作规范）。
 *
 * 分层：本模块是路由层的一小块，只解析请求 / 调业务（compilePromptForRequest）/ 回响应；
 * 真正的编译逻辑全部在 `prompt-compiler.js`，本模块不自己发明规则。
 *
 * 契约（冻结）：
 *   Request : { template, family, shot, scene?, characters?, style?, slots?, overlays?, durationSec?, rewrite? }
 *   Response: { prompt, meta: { template, modelKey, language: 'zh'|'en', rewriterId?|null,
 *                              untranslated?, applied: { structure, negative, textInImage },
 *                              llm?: { model, finishReason, chars }|null, notes?: string[] } }
 *   `rewrite: true` 时走 async 版并注入 llmCall（DeepSeek；注入失败/截断只降级为带 [untranslated] 的同步稿）；
 *   未传 `rewrite` 时保持同步行为。
 */

import { compilePromptForTemplate, compilePromptForTemplateAsync, negativeClause, stripUntranslatedMarker } from "./prompt-compiler.js";
import { ruleKeyForTemplate, languagePolicy, textInImageRule } from "./model-rules.js";
import { rewriterForTemplate } from "./prompt-rewriter.js";
import { callLlm } from "./llm-client.js";
import { readJson, sendError, sendJson } from "./http.js";

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 模板名 → family（仅信息性字段；编译器分派只按模板名，不看 family）。 */
function familyOf(template) {
    return /^video[_-]|h3/i.test(String(template ?? "")) ? "video" : "image";
}

/**
 * 包一层 llmCall：既回填 meta.llm，又守住「截断/空内容不得当成功」的纪律
 * （拿不到可用正文就抛错 → compilePromptForTemplateAsync 回落同步降级稿 + [untranslated]）。
 * 注入的是 rich 版 `callLlm`（返回 { text, model, finishReason, chars }）。
 */
function capturingLlmCall(collector, call) {
    return async (options = {}) => {
        const result = await call(options);
        collector.llm = { model: result.model, finishReason: result.finishReason, chars: result.chars };
        if (!result.text || !result.text.trim()) {
            const error = new Error(`LLM 返回空内容（finish_reason=${result.finishReason}, chars=${result.chars}）`);
            error.code = "llm_empty";
            throw error;
        }
        if (result.finishReason === "length") {
            const error = new Error(`LLM 输出被截断（finish_reason=length, chars=${result.chars}）`);
            error.code = "llm_truncated";
            throw error;
        }
        return result.text;
    };
}

/** 语言归一：带未英文化标记 → zh；模型要求 en 且已改写 → en；否则按正文是否含 CJK 粗判。 */
function languageOf(prompt, template, untranslated) {
    if (untranslated) return "zh";
    if (languagePolicy(template)?.translate_to === "en") return "en";
    return CJK_RE.test(String(prompt ?? "")) ? "zh" : "en";
}

/**
 * 纯业务：编译一次提示词。
 * @param {object} body 请求体
 * @param {{callLlm?: Function}} [options] callLlm：rich 版 LLM 调用（默认 llm-client 的 callLlm，可注入假的做测试）
 * @returns {Promise<{prompt: string, meta: object}>}
 */
export async function compilePromptForRequest(body = {}, { callLlm: injected } = {}) {
    const template = String(body?.template ?? "").trim();
    if (!template) {
        const error = new Error("缺少 template");
        error.status = 400;
        throw error;
    }
    const call = typeof injected === "function" ? injected : callLlm;
    const input = {
        template,
        family: String(body?.family ?? "").trim() || familyOf(template),
        shot: body?.shot ?? {},
        scene: body?.scene ?? null,
        characters: Array.isArray(body?.characters) ? body.characters : [],
        style: body?.style ?? null,
        slots: body?.slots ?? {},
        overlays: Array.isArray(body?.overlays) ? body.overlays : [],
        durationSec: body?.durationSec,
        basePrompt: body?.basePrompt,
    };

    const collector = { llm: null, warnings: [] };
    const rawPrompt =
        body?.rewrite === true
            ? await compilePromptForTemplateAsync({
                  ...input,
                  llmCall: capturingLlmCall(collector, call),
                  onWarning: (error) => collector.warnings.push(error?.message || String(error)),
              })
            : compilePromptForTemplate(input);

    const untranslated = /\[untranslated/.test(rawPrompt);
    const prompt = stripUntranslatedMarker(rawPrompt);
    const notes = [];
    if (untranslated) notes.push("提示词未英文化：语言适配 LLM 不可用/未生效，已回落同步结构；降级标记仅保留在元数据");
    for (const warning of collector.warnings) notes.push(`提示词改写失败：${warning}`);
    if (collector.llm?.finishReason === "length") notes.push("LLM 输出被截断（finish_reason=length），已降级为同步稿");

    const meta = {
        template,
        modelKey: ruleKeyForTemplate(template) ?? null,
        language: languageOf(prompt, template, untranslated),
        rewriterId: rewriterForTemplate(template),
        untranslated,
        applied: {
            structure: true,
            negative: Boolean(negativeClause(template)),
            textInImage: Boolean(textInImageRule(template)),
        },
        llm: collector.llm,
    };
    if (notes.length) meta.notes = notes;
    return { prompt, meta };
}

/** 路由装配：index.js 只做 `router.post("/api/prompt/compile", createPromptApi().handle)`。 */
export function createPromptApi({ callLlm: injected } = {}) {
    return {
        handle: async (req, res) => {
            let body;
            try {
                body = await readJson(req);
            } catch (error) {
                sendError(res, 400, `请求体不是合法 JSON：${error.message}`);
                return;
            }
            try {
                const result = await compilePromptForRequest(body, { callLlm: injected });
                sendJson(res, 200, result);
            } catch (error) {
                sendError(res, error?.status || 500, error?.message || "提示词编译失败");
            }
        },
    };
}

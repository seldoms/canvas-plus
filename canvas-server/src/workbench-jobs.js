/**
 * workbench-jobs.js —— 生图工作台的「提交进服务端队列」入口（POST /api/images/enqueue）。
 *
 * 为什么单独成模块：工作台此前是**浏览器直连模型**，任务只活在页面内存里，一刷新就全丢。
 * 现在改为「前端提交 → 后端入队 → 前端从 GET /api/jobs 轮询」，本模块负责把一次提交
 * 拆成 N 个 kind=image 的 job 放进**现有本地 GPU 队列**（绝不另起并行队列），并复用
 * generate.js 的 comfy 执行链路（OUTPUT_PREFIX / REF_IMAGE_N / INPUT_IMAGE 槽位语义）。
 *
 * 提示词在后端编译：内容层只给「模型无关的一段画面事实」，本模块用
 * compilePromptForTemplateAsync + 注入的 llm-client `llmCall`（DeepSeek）按所选模板标准编译；
 * 编译失败/超时的降级策略**照搬 pipeline.js**：结构照旧产出 + 记 warning，绝不阻塞入队。
 *
 * 契约（冻结）：
 *   Request : { template, prompt, count?, size?, references?[{url}], seed?,
 *               projectId?, episodeId?, sceneId?, shotId?, slotId? }
 *     归属字段与 /api/generate/* 同口径（contextFromBody）读入 job.meta，
 *     任务终态即可自动投影为项目槽位候选（slot-candidates.js）。
 *   Response: { jobs: [{ id, status, template }] }
 */

import { existsSync } from "node:fs";

import { safeJoin } from "./files.js";
import { extractTokens } from "./providers/comfy.js";
import { compilerFor, compilePromptForTemplate, compilePromptForTemplateAsync, stripUntranslatedMarker } from "./prompt-compiler.js";
import { createGenerationIntent, contextFromBody, submitGenerationIntent } from "./generation-intent.js";
import { readJson, sendError, sendJson } from "./http.js";

/** 单次提交最多几张（与前端 generationCount 的 1..10 对齐）。 */
export const MAX_ENQUEUE_COUNT = 10;
/** 参考图上限：INPUT_IMAGE 占 1 张 + REF_IMAGE_1..9。 */
export const MAX_REFERENCE_IMAGES = 10;
/** 入队前编译提示词的上界：超时即降级为同步结构稿，绝不把提交挂死。 */
export const DEFAULT_COMPILE_TIMEOUT_MS = 60_000;

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/** PROMPT 带 [untranslated] 标记 → 一条 warning（该模型官方口径未生效），否则 null。 */
function untranslatedWarning(prompt) {
    return typeof prompt === "string" && prompt.includes("[untranslated")
        ? { reason: "提示词未英文化：语言适配 LLM 不可用/未生效，已按同步结构产出并显式标记 [untranslated]" }
        : null;
}

/** "1024x1024" → { width, height }；"auto"/比例/空 → null（沿用模板默认尺寸）。 */
export function parseSize(size) {
    const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(size ?? ""));
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

/** 给注入的 llmCall 补一个超时上界（llm-client 的 llmCall 读 timeoutMs），编译失败只降级不挂死。 */
function withTimeout(llmCall, timeoutMs) {
    if (typeof llmCall !== "function") return null;
    return (options = {}) => llmCall({ ...options, timeoutMs });
}

/**
 * 纯业务：按所选模板把「一段画面事实」编译成该模型要的 PROMPT。
 *
 * 事实装进 `shot.action`（改写器 rewriteSourceText 只读 action/景别/机位等，不读 shot.prompt），
 * 这样 DeepSeek 才有东西可改写；generic 兜底编译器不认 action，改用 legacyBody 传原文。
 * 降级策略与 pipeline.compilePromptItem 一致：先同步结构稿，命中「需英文化」且注入可用才走 async；
 * async 失败/截断/带未升级标记 → 回落同步稿，warning 由 onWarning 收集。
 * @returns {Promise<{prompt: string, warnings: string[]}>}
 */
export async function compileWorkbenchPrompt({ template, prompt, slotImages = [], llmCall, onWarning } = {}) {
    const text = String(prompt ?? "").trim();
    const { id: compilerId } = compilerFor(template, "image");
    // generic 兜底只认 legacyBody/basePrompt；其余编译器按「画面事实」结构化，事实放 action 才不会和 base 重复。
    const input =
        compilerId === "generic"
            ? { template, family: "image", legacyBody: text, basePrompt: text, slots: { images: slotImages } }
            : { template, family: "image", shot: { prompt: text, action: text }, slots: { images: slotImages } };

    const syncPrompt = compilePromptForTemplate(input);
    const warning = untranslatedWarning(syncPrompt);
    const warnings = [];
    let raw = syncPrompt;
    if (warning && typeof llmCall === "function") {
        try {
            raw = await compilePromptForTemplateAsync({ ...input, llmCall, onWarning });
        } catch (error) {
            if (typeof onWarning === "function") onWarning(error);
            raw = syncPrompt;
        }
        if (typeof raw !== "string" || !raw.trim() || raw.includes("[untranslated")) raw = syncPrompt;
    }
    if (warning && (!llmCall || (typeof raw === "string" && raw.includes("[untranslated")))) warnings.push(warning.reason);
    const compiled = stripUntranslatedMarker(raw).trim() || stripUntranslatedMarker(syncPrompt).trim() || text;
    return { prompt: compiled, warnings };
}

/** 归一 references：字符串或 {url} 都收；去空、切片到上限。 */
function normalizeReferences(references) {
    const list = Array.isArray(references) ? references : [];
    return list
        .map((item) => (typeof item === "string" ? item : item?.url))
        .map((url) => String(url ?? "").trim())
        .filter(Boolean)
        .slice(0, MAX_REFERENCE_IMAGES);
}

/**
 * GET /api/jobs 的可选过滤（kind / status(逗号分隔) / limit / since）。
 * 不传任何参数时返回原样列表 —— **向前兼容**：与旧行为逐字一致。
 * @param {object[]} list 已按 createdAt 倒序的 job 列表
 * @param {{kind?: string, status?: string, limit?: string|number, since?: string}} [query]
 */
export function filterJobs(list, { kind, status, limit, since } = {}) {
    let result = Array.isArray(list) ? [...list] : [];
    const wantedKind = String(kind ?? "").trim();
    if (wantedKind) result = result.filter((job) => job?.kind === wantedKind);
    const statuses = String(status ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (statuses.length) {
        const set = new Set(statuses);
        result = result.filter((job) => set.has(job?.status));
    }
    const sinceText = String(since ?? "").trim();
    if (sinceText) {
        const threshold = Date.parse(sinceText);
        if (Number.isFinite(threshold)) {
            result = result.filter((job) => {
                const at = Date.parse(job?.updatedAt || job?.createdAt || "");
                return Number.isFinite(at) && at >= threshold;
            });
        }
    }
    const limitValue = Number(limit);
    if (Number.isFinite(limitValue) && limitValue > 0) result = result.slice(0, Math.floor(limitValue));
    return result;
}

/**
 * 装配生图入队入口。
 * @param {{ config: object, jobs: object, runJob: Function, registry?: object, llmCall?: Function,
 *           getProject?: Function, compileTimeoutMs?: number }} deps
 *   jobs/runJob 必须来自 index.js 的**同一**本地 GPU 队列与执行体（复用 comfy 提交链路）。
 *   llmCall 为 llm-client 的 string 版出口（DeepSeek）；缺失时保持同步结构稿（离线/测试）。
 *   getProject 用于统一 submit 链的项目上下文校验（body.projectId 非空时项目须存在）。
 */
export function createImageEnqueue({ config, jobs, runJob, registry, llmCall, getProject, compileTimeoutMs = DEFAULT_COMPILE_TIMEOUT_MS } = {}) {
    if (typeof jobs?.enqueue !== "function") throw new Error("createImageEnqueue 需要注入 jobs.enqueue（必须复用现有任务队列）");
    if (typeof runJob !== "function") throw new Error("createImageEnqueue 需要注入 runJob（复用现有 comfy 执行体）");

    // 语言适配出口补上超时上界：DeepSeek 慢/不可用时编译降级，但绝不把提交挂死。
    const callLlm = withTimeout(llmCall, compileTimeoutMs);

    /** 纯业务：入队一次提交，返回创建的 jobs。 */
    async function enqueue(body = {}) {
        // 前端配置里的模型值可能是「渠道id::模型名」（渠道模型的标准形态），而这里要的是**裸模板名**。
        // 旧版前端漏剥前缀会把整串发过来 → 直接报「模板不存在」。此处兜底剥掉，避免因前端缓存版本不一致而整条链路不可用。
        const rawTemplate = String(body?.template ?? "").trim();
        const template = rawTemplate.includes("::") ? rawTemplate.slice(rawTemplate.lastIndexOf("::") + 2).trim() : rawTemplate;
        if (!template) throw httpError(400, "缺少 template");
        const prompt = String(body?.prompt ?? "").trim();
        if (!prompt) throw httpError(400, "缺少 prompt");

        const countRaw = Number(body?.count);
        const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(MAX_ENQUEUE_COUNT, Math.floor(countRaw))) : 1;

        const templatePath = safeJoin(config.workflowsDir, `${template}.json`);
        if (!templatePath || !existsSync(templatePath)) throw httpError(400, `模板不存在：${template}`);
        if (typeof registry?.canRun === "function") {
            const verdict = registry.canRun(template);
            if (verdict && !verdict.ok) throw httpError(400, `无法提交生图任务：${verdict.reason}`);
        }

        const tokens = extractTokens(templatePath);
        const references = normalizeReferences(body?.references);

        const params = {};
        // 尺寸：请求可传 "1024x768"；解析不出（auto / 比例 / 缺省）时回落 config 默认宽高，
        // 保证生图模板必填的 WIDTH/HEIGHT 永远齐全（否则执行体在补齐 token 阶段就失败）。
        const dims = parseSize(body?.size) || { width: Number(config.pipeline?.imageWidth) || 768, height: Number(config.pipeline?.imageHeight) || 1344 };
        params.WIDTH = dims.width;
        params.HEIGHT = dims.height;

        const slotImages = [];
        let remaining = [...references];
        if (tokens.includes("INPUT_IMAGE")) {
            if (!remaining.length) throw httpError(400, `模型 ${template} 需要底图（INPUT_IMAGE），请先上传参考图`);
            params.INPUT_IMAGE = remaining[0];
            slotImages.push({ url: remaining[0], kind: "input_image" });
            remaining = remaining.slice(1);
        }
        remaining.slice(0, 9).forEach((url, index) => {
            params[`REF_IMAGE_${index + 1}`] = url;
            slotImages.push({ url, kind: "reference" });
        });

        const compiled = await compileWorkbenchPrompt({ template, prompt, slotImages, llmCall: callLlm });

        const created = [];
        for (let index = 0; index < count; index += 1) {
            const id = `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            const jobParams = { ...params, BATCH: 1, PROMPT: compiled.prompt, OUTPUT_PREFIX: `canvas/${id}` };
            const seed = Number(body?.seed);
            if (Number.isFinite(seed)) jobParams.SEED = seed;
            // 统一提交链（M1）：编译结果经 params.PROMPT 传入 → submit 跳过重复编译；
            // 归属字段（source/projectId/toolId）由 submit 统一写入 meta。
            // 归属上下文与 /api/generate/* 同口径抽：此前这里硬编码只读 body.projectId，
            // episodeId/sceneId/shotId/slotId 传了也到不了 meta → 生图工作台的产物
            // 无法投影为项目槽位候选（P2-B4）。
            const intent = createGenerationIntent({
                source: "workbench",
                kind: "image",
                context: contextFromBody(body),
                toolId: template,
                template,
                params: jobParams,
                options: {
                    jobId: id,
                    name: `${template}-${index + 1}`,
                    meta: {
                        template,
                        prompt,
                        referenceCount: references.length,
                        ...(compiled.warnings.length ? { promptWarning: compiled.warnings.join("；") } : {}),
                    },
                },
            });
            const job = await submitGenerationIntent(intent, { jobs, runner: runJob, registry, getProject });
            created.push({ id: job.id, status: job.status, template });
        }
        return { jobs: created };
    }

    return {
        enqueue,
        handle: async (req, res) => {
            let body;
            try {
                body = await readJson(req);
            } catch (error) {
                sendError(res, 400, `请求体不是合法 JSON：${error.message}`);
                return;
            }
            try {
                sendJson(res, 201, await enqueue(body));
            } catch (error) {
                sendError(res, error?.status || 400, error?.message || "生图入队失败");
            }
        },
    };
}

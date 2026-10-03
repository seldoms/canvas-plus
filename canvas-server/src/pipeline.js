import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitNovelIntoChunks } from "./chunk-novel.js";
import { assembleEpisode } from "./delivery.js";
import { artifactUrl, ensureDir, safeJoin } from "./files.js";
import { listTemplates } from "./providers/comfy.js";
import { loadRegistry, readSkill } from "./skills.js";

/** 生成型阶段：只构造生成任务参数并交给任务队列，不等真实产物。 */
const GENERATIVE_STAGES = new Set(["keyframe", "assembly"]);

/** 生成型阶段 → 可用模板 family：关键帧出图、片段出视频。 */
const STAGE_TEMPLATE_FAMILY = Object.freeze({ keyframe: "image", assembly: "video" });

/** Job 终态：只有落到这里才回写流水线。 */
const TERMINAL_JOB = new Set(["done", "error", "canceled"]);

/** 带 HTTP 状态码的业务错误：路由层据此回 400/409，不再一律 400（门禁拒绝路径需要区分）。 */
function gateError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/**
 * H3 系列模板的 LENGTH 走 17n+5 帧网格（5s≈123 帧、10s≈243 帧）。
 * 取不小于目标时长的最小网格点，避免把非网格帧数喂给模型。
 */
function frameCountFor(seconds, fps) {
    const desired = Math.max(1, Math.round(Number(seconds) * Number(fps)));
    const steps = Math.max(0, Math.round((desired - 5) / 17));
    return 17 * steps + 5;
}

function nowIso() {
    return new Date().toISOString();
}

/** 从模型输出里抠出 JSON 对象，容忍 Markdown 代码块与前后解释文字。 */
function parseJsonLoose(text) {
    let value = String(text ?? "").trim();
    if (!value) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
    if (fenced) value = fenced[1].trim();
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(value.slice(start, end + 1));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** 取 SKILL.md 里某个二级章节的正文，用于抽出「提示词模板」。 */
function extractSection(markdown, title) {
    const lines = String(markdown ?? "").split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `## ${title}`);
    if (start < 0) return "";
    const body = [];
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^##\s/.test(lines[index])) break;
        body.push(lines[index]);
    }
    return body.join("\n").trim();
}

/** 填充 {{key}} / {{a.b}} 占位；未知占位原样保留，便于用户发现写错的 key。 */
function fillTemplate(text, context) {
    return String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
        const value = key.split(".").reduce((acc, part) => (acc === undefined || acc === null ? acc : acc[part]), context);
        if (value === undefined) return match;
        return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    });
}

/**
 * 五段式流水线编排器。
 * comfy 只作为能力依赖传入，真实生图/生视频执行体通过 runJob 注入（index.js 传 runGenerationJob）；
 * 没有 runJob 时生成型阶段只构造任务参数并标记 queued，不伪造产物。
 * assemble 是「片段 → 成片」的后期执行体，默认用 delivery.js 的 assembleEpisode；
 * 编排器只负责判定何时拼接、把清单与参数交给它，ffmpeg 命令构造与执行都留在 delivery.js。
 */
export function createPipeline({ config, skillsDir, jobs, comfy, llm, runJob, assemble = assembleEpisode } = {}) {
    const pipelineConfig = config?.pipeline || {};
    const runsDir = ensureDir(join(config?.dataDir || "data", "runs"));
    const registry = loadRegistry(skillsDir);
    const stageDefs = new Map(registry.stages.map((item) => [item.id, item]));
    // 模板名 → family（image/video/edit/upscale）。regenerate 用它校验「换的模型属于该阶段该出图还是出视频」。
    const templateFamilies = new Map(listTemplates(config?.workflowsDir).map((template) => [template.name, template.family]));

    const runFile = (runId) => safeJoin(runsDir, String(runId), "run.json");
    const stageFile = (runId, stageId) => safeJoin(runsDir, String(runId), `${stageId}.json`);
    const progressFile = (runId) => safeJoin(runsDir, String(runId), "progress.json");
    const chunksDir = (runId) => safeJoin(runsDir, String(runId), "chunks");
    const chunkFile = (runId, index) => safeJoin(chunksDir(runId), `${Number(index)}.json`);

    function readJsonFile(file) {
        if (!file || !existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            console.warn(`[pipeline] 文件损坏，按空处理：${file}（${error.message}）`);
            return null;
        }
    }

    function saveRun(run) {
        run.updatedAt = nowIso();
        ensureDir(join(runsDir, run.id));
        writeFileSync(runFile(run.id), JSON.stringify(run, null, 2));
        return run;
    }

    function saveOutput(runId, stageId, output) {
        writeFileSync(stageFile(runId, stageId), JSON.stringify(output, null, 2));
    }

    /**
     * 阶段进度写在独立的小文件里，**不写 run.json**：run.json 内嵌整本小说，
     * 222 万字的书有 6.4MB，逐块 saveRun 会产生上百次全量重写，前端每 3 秒轮询
     * 也要每次拖 6.4MB。progress.json 只有几十字节。
     */
    function writeProgress(runId, progress) {
        const file = progressFile(runId);
        if (!file) return;
        ensureDir(join(runsDir, String(runId)));
        try {
            writeFileSync(file, JSON.stringify({ ...progress, updatedAt: nowIso() }));
        } catch (error) {
            console.warn(`[pipeline] 进度写入失败（不影响生成）：${error.message}`);
        }
    }

    const readProgress = (runId) => readJsonFile(progressFile(runId));

    function clearProgress(runId) {
        try {
            rmSync(progressFile(runId), { force: true });
        } catch {
            /* 不存在即可 */
        }
    }

    /**
     * 每块的 map 结果单独落盘，重跑时跳过已完成的块。
     * 163 块 / 83 分钟的任务，中途崩溃或重启不该从头再来一遍。
     */
    function saveChunkPartial(runId, index, partial) {
        const dir = chunksDir(runId);
        const file = chunkFile(runId, index);
        if (!dir || !file) return;
        ensureDir(dir);
        writeFileSync(file, JSON.stringify(partial));
    }

    const readChunkPartial = (runId, index) => readJsonFile(chunkFile(runId, index));

    function clearChunks(runId) {
        try {
            rmSync(chunksDir(runId), { recursive: true, force: true });
        } catch {
            /* 不存在即可 */
        }
    }

    /** 已落盘的块结果数，用于 resume 时告诉用户能省下多少。 */
    function countChunks(runId) {
        const dir = chunksDir(runId);
        if (!dir || !existsSync(dir)) return 0;
        try {
            return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
        } catch {
            return 0;
        }
    }

    function get(id) {
        const run = readJsonFile(runFile(id));
        return run && typeof run === "object" ? run : null;
    }

    function list() {
        const runs = [];
        for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const run = get(entry.name);
            if (run) runs.push(run);
        }
        return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    function requireRun(id) {
        const run = get(id);
        if (!run) throw new Error(`流水线不存在：${id}`);
        return run;
    }

    function requireStageDef(stageId) {
        const def = stageDefs.get(String(stageId));
        if (!def) throw new Error(`未知阶段：${stageId}`);
        return def;
    }

    function requireStage(run, def) {
        const stage = run.stages?.[def.id];
        if (!stage) throw new Error(`流水线缺少阶段：${def.id}`);
        return stage;
    }

    function stages() {
        return registry.stages;
    }

    /**
     * 开跑前就能给出的成本预估。口径必须与 composeWithLlm 的分块判定完全一致 ——
     * 那边比的是**填充后的 prompt 长度**（含 SKILL.md 模板），不是小说字数。
     * estSecondsPerChunk 默认 31：实测 222 万字 / 163 块 / 83 分钟 ≈ 30.5s/块（deepseek-flash）。
     */
    function estimateFor(run) {
        const def = stageDefs.get("script");
        const maxChunkChars = Number(pipelineConfig.maxNovelChunkChars) || 16000;
        const perChunkSeconds = Number(pipelineConfig.estSecondsPerChunk) > 0 ? Number(pipelineConfig.estSecondsPerChunk) : 31;
        const novel = String(run?.novel || "");
        let promptChars = novel.length;
        if (def) {
            try {
                promptChars = fillTemplate(readPromptTemplate(def), buildContext(run, def)).length;
            } catch {
                /* SKILL.md 读不到时退回按正文字数估 */
            }
        }
        const chunked = promptChars > maxChunkChars;
        const chunks = chunked ? splitNovelIntoChunks(novel, maxChunkChars).length : 1;
        const llmCalls = chunked ? chunks + 1 : 1; // N 次 map + 1 次 reduce
        return {
            novelChars: novel.length,
            promptChars,
            maxChunkChars,
            chunked,
            chunks,
            llmCalls,
            perChunkSeconds,
            estSeconds: llmCalls * perChunkSeconds,
            resumableChunks: countChunks(run?.id),
        };
    }

    function create({ novel, title, options } = {}) {
        const text = String(novel ?? "").trim();
        if (!text) throw new Error("缺少小说正文 novel");
        const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const now = nowIso();
        const run = {
            id,
            title: String(title ?? "").trim() || "未命名流水线",
            novel: text,
            options: options && typeof options === "object" ? options : {},
            createdAt: now,
            updatedAt: now,
            stages: {},
        };
        for (const def of registry.stages) {
            run.stages[def.id] = { id: def.id, title: def.title, status: "pending", inputs: {}, output: null, artifacts: [] };
        }
        // 创建时就算好成本预估：163 块 / 83 分钟这种量级必须让用户在点「开始」之前看到
        run.estimate = estimateFor(run);
        return saveRun(run);
    }

    /** 人工修订产物：body `{ output: <该阶段产物 JSON> }` 时置为 done 并落盘，下游立即可用；其余键合并进 inputs。 */
    function setStageInput(runId, stageId, patch = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        const body = patch && typeof patch === "object" ? patch : {};
        if (body.output !== undefined) {
            stage.output = body.output;
            stage.status = "done";
            stage.error = undefined;
            stage.finishedAt = stage.finishedAt || nowIso();
            saveOutput(run.id, def.id, body.output);
        } else {
            stage.inputs = { ...stage.inputs, ...body };
        }
        return saveRun(run);
    }

    /** 把 novel、流水线配置与全部已产出的上游产物组装成模板上下文，上游 key 用该阶段 produces 的名字。 */
    function buildContext(run, def) {
        const context = { novel: run.novel, title: run.title, options: run.options || {}, pipeline: pipelineConfig };
        for (const item of registry.stages) {
            if (item.id === def.id) continue;
            const output = run.stages?.[item.id]?.output;
            if (output !== undefined && output !== null) context[item.produces[0] || item.id] = output;
        }
        return context;
    }

    function readPromptTemplate(def) {
        const template = extractSection(readSkill(skillsDir, def.skill), "提示词模板");
        if (!template) throw new Error(`技能 ${def.skill} 缺少「## 提示词模板」章节`);
        return template;
    }

    function resolveModel(run, stageId) {
        // 按阶段绑定的模型优先，其次整条流水线的 llmModel，最后网关默认
        return run.options?.stageModels?.[stageId] || run.options?.llmModel || pipelineConfig.llmModel || "";
    }

    async function chat(messages, run, temperature, stageId, provider, signal) {
        if (typeof llm?.chat !== "function") throw new Error("未配置 LLM 提供方");
        if (signal?.aborted) throw new Error("已取消");
        const options = { messages, temperature, response_format: { type: "json_object" } };
        const model = resolveModel(run, stageId);
        if (model) options.model = model;
        // 浏览器渠道透传的外部 API（仅本次调用生效，不落盘）
        if (provider) options.provider = provider;
        if (signal) options.signal = signal;
        const result = await llm.chat(options);
        return result?.choices?.[0]?.message?.content ?? "";
    }

    /** 调一次模型并解析 JSON，失败带原文重试一次；再失败抛出带 raw 的错误。signal 为阶段取消信号。 */
    async function askJson(messages, run, stageId, provider, temperature = 0.6, signal) {
        const first = await chat(messages, run, temperature, stageId, provider, signal);
        const parsed = parseJsonLoose(first);
        if (parsed) return parsed;
        // 已取消就别再补一次重试调用，否则用户点了停止还要多等一次完整的模型往返
        if (signal?.aborted) throw new Error("已取消");
        const retry = await chat(
            [...messages, { role: "assistant", content: String(first ?? "") }, { role: "user", content: "你上一次的输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块、不要任何解释。" }],
            run,
            0,
            stageId,
            provider,
            signal,
        );
        const retried = parseJsonLoose(retry);
        if (retried) return retried;
        const error = new Error("模型未返回合法 JSON");
        error.raw = String(retry ?? first ?? "");
        throw error;
    }

    /**
     * 01 剧本分块路径与阶段技能共用同一份「内容创作红线（硬约束）」：直接抽取 SKILL.md 的
     * `## 内容创作红线（硬约束）` 正文供 map（逐块提取）与 reduce（合并成篇）两个提示词复用，
     * 不再在两处各写一遍逐字重复的硬编码字符串。技能缺该节时返回空串，退回无红线的旧形态。
     */
    function scriptRedlines(def) {
        try {
            return extractSection(readSkill(skillsDir, def.skill), "内容创作红线（硬约束）").trim();
        } catch {
            return "";
        }
    }

    /**
     * 01 剧本分块改编（map-reduce）：整本长篇超过阈值时切成 N 块，逐块提取局部人物/场次，
     * 再把全部局部结果与项目标题喂给模型合并成符合 01 SKILL.md 契约的完整剧本。
     * stage.output 与单次调用完全同构，分块信息记在 stage.chunked。
     */
    async function composeScriptChunked(run, def, stage, provider, maxChunkChars, ctx = {}) {
        const { signal, resume = false, estSecondsPerChunk = 31 } = ctx;
        const chunks = splitNovelIntoChunks(run.novel, maxChunkChars);
        // 阶段技能的内容创作红线（忠于原著 / 不注入教化结构 / 风险只提示不改稿 / 质量校验照做），
        // map 与 reduce 两处复用同一份文案；技能没写该节时留空，退回旧的 \n\n 分隔。
        const redlines = scriptRedlines(def);
        const redlineBlock = redlines ? `\n\n改编必须遵守阶段技能的内容创作红线（硬约束）：\n${redlines}\n` : "\n\n";
        const system = { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` };
        const partials = [];
        const startedAt = Date.now();
        let reused = 0;
        for (const chunk of chunks) {
            if (signal?.aborted) throw new Error(`已取消（第 ${partials.length}/${chunks.length} 块完成后中止）`);
            const mapPrompt = `你是影视剧本改编。长篇小说《${run.title}》太长，已分成 ${chunks.length} 块，这是第 ${chunk.index}/${chunks.length} 块（来源：${chunk.label}）。

<novel-part>
${chunk.text}
</novel-part>${redlineBlock}要求：

1. 只提取本块出现的 characters 与 scenes，不要写 logline / synopsis / episodes。
2. characters 覆盖本块所有有台词或推动剧情的角色：profile 写身份、性格、人物关系；appearance 写成能直接喂给生图模型的外观描述（年龄、体态、五官、发型、服装基调），不要抽象形容词；voice 写音色、语速、口音等可复现的声音特征。
3. scenes 按本块时间顺序排列；beats 用 3~8 条原文里的可拍摄动作/台词节拍，不要文学抒情和心理描写。
4. location 统一写成「内景/外景 + 地点」，time 只用 日 / 夜 / 黄昏 / 清晨 这类可布光的词。
5. 只输出下面结构的 JSON 本体，只输出契约允许的字段、不得增删或改名，id 在本块内唯一即可（合并时会统一重排），不要 Markdown 代码块、不要解释文字：

{"characters":[{"id":"c1","name":"","profile":"","appearance":"","voice":""}],"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}]}`;
            // resume 时优先复用上次已落盘的块结果：163 块 / 83 分钟的任务崩了不该从头再来
            let partial = resume ? readChunkPartial(run.id, chunk.index) : null;
            if (partial && typeof partial === "object") {
                reused += 1;
            } else {
                partial = await askJson([system, { role: "user", content: mapPrompt }], run, def.id, provider, 0.6, signal);
                saveChunkPartial(run.id, chunk.index, partial);
            }
            partials.push({ index: chunk.index, label: chunk.label, ...partial });
            const done = partials.length;
            const called = done - reused;
            // 有真实调用样本就用实测均速，否则退回配置的估值（实测 163 块 / 83 分钟 ≈ 30.5s/块）
            const avgMs = called > 0 ? Math.round((Date.now() - startedAt) / called) : Math.round(Number(estSecondsPerChunk) * 1000);
            writeProgress(run.id, {
                runId: run.id,
                stage: def.id,
                phase: "map",
                done,
                total: chunks.length,
                label: chunk.label,
                reused,
                avgMsPerChunk: avgMs,
                etaMs: avgMs * (chunks.length - done),
                startedAt: new Date(startedAt).toISOString(),
            });
        }
        const reducePrompt = `你是影视剧本改编。长篇小说《${run.title}》已分 ${chunks.length} 块逐块提取出局部人物与场次（JSON 如下，label 是该块在原文里的来源标记）。把它们合并成一份完整剧本。

<partials>
${JSON.stringify(partials, null, 2)}
</partials>${redlineBlock}要求：

1. 生成 logline（一句话故事线）与 synopsis（不超过 300 字的故事梗概）。
2. characters 按姓名合并去重，profile 合并各块信息；appearance 与 voice 必须每条非空，缺失时依据原文细节合理推断补齐。
3. scenes 按时间顺序合并，跨块重复的场次合并且不丢 beats；beats 保留可拍摄的动作/台词细节。
4. characters[].id 与 scenes[].id 全部重排为连续稳定的 c1、c2… 与 sc1、sc2…，只允许 [A-Za-z0-9_-]。
5. 短篇可省略 episodes；若给出，sceneIds 必须都能在 scenes 里找到。
6. 只输出下面结构的 JSON 本体，只输出契约允许的字段、字段名不得增删或改名，不要 Markdown 代码块、不要解释文字：

{"logline":"","synopsis":"","characters":[{"id":"c1","name":"","profile":"","appearance":"","voice":""}],"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}],"episodes":[]}`;
        if (signal?.aborted) throw new Error(`已取消（${chunks.length} 块已全部提取，合并前中止）`);
        writeProgress(run.id, {
            runId: run.id,
            stage: def.id,
            phase: "reduce",
            done: chunks.length,
            total: chunks.length,
            label: `合并 ${chunks.length} 块局部结果`,
            reused,
            startedAt: new Date(startedAt).toISOString(),
        });
        stage.output = await askJson([system, { role: "user", content: reducePrompt }], run, def.id, provider, 0.3, signal);
        stage.chunked = { chunks: chunks.length, labels: chunks.map((chunk) => chunk.label), mergeModel: resolveModel(run, def.id), reused };
    }

    /** 文本型阶段：填模板 → 要求严格 JSON → 失败重试一次 → 再失败置 error。provider 为浏览器透传的外部渠道（仅本次调用）。 */
    async function composeWithLlm(run, def, stage, provider, ctx = {}) {
        const prompt = fillTemplate(readPromptTemplate(def), buildContext(run, def));
        const maxChunkChars = Number(pipelineConfig.maxNovelChunkChars) || 16000;
        try {
            // 只有 01 剧本阶段会做分块；填入小说后的完整 prompt 超阈值时走 map-reduce，其余一律单次调用。
            if (def.id === "script" && prompt.length > maxChunkChars) {
                await composeScriptChunked(run, def, stage, provider, maxChunkChars, ctx);
                return;
            }
            // 单次调用也写一条同形状的进度，前端不必为「有没有分块」写两套渲染
            writeProgress(run.id, { runId: run.id, stage: def.id, phase: "single", done: 0, total: 1, label: `模型生成中（提示词 ${prompt.length} 字）` });
            const messages = [
                { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
                { role: "user", content: prompt },
            ];
            stage.output = await askJson(messages, run, def.id, provider, 0.6, ctx.signal);
            stage.chunked = undefined;
        } catch (error) {
            stage.output = null;
            throw error;
        }
    }

    /** item 的派生别名（jobId/artifactUrl/status）由候选列表算出，selected 指向当前采用的候选；绝不删除旧候选。 */
    function syncItem(item) {
        const candidates = Array.isArray(item.candidates) ? item.candidates : [];
        if (!candidates.length) return;
        const selected = candidates[candidates.length - 1];
        item.selected = selected.jobId;
        item.jobId = selected.jobId;
        item.status = selected.status;
        // 产物取「当前候选，其次最近一次成功」，重跑进行中也不会丢掉上一次的结果。
        const lastUrl = [...candidates].reverse().find((candidate) => candidate.artifactUrl)?.artifactUrl;
        item.artifactUrl = selected.artifactUrl || lastUrl || null;
    }

    /** 幂等 upsert 一个候选：同一个 jobId 只更新状态与产物，不重复追加。 */
    function upsertCandidate(item, job) {
        item.candidates = Array.isArray(item.candidates) ? item.candidates : [];
        const artifactUrl = job.status === "done" ? job.outputs?.[0]?.url ?? null : null;
        const existing = item.candidates.find((candidate) => candidate.jobId === job.id);
        if (existing) {
            existing.status = job.status;
            existing.artifactUrl = artifactUrl;
            return;
        }
        item.candidates.push({ template: job.template, jobId: job.id, artifactUrl, status: job.status, params: job.params, createdAt: job.createdAt || nowIso() });
    }

    /**
     * 成片是否已由 delivery 产出：只有拿到可访问地址才算，绝不把「片段生成完」当「成片完成」。
     * 返回登记进 stage.artifacts 的成片条目（成片本体 + 可复现清单 + 日志 + 封面）。
     */
    function filmArtifacts(stage) {
        const assembly = stage.output?.assembly;
        if (!assembly || assembly.status !== "done" || !assembly.url) return [];
        const list = [{ id: assembly.deliverableId, kind: "film", role: "output", url: assembly.url }];
        if (assembly.manifestUrl) list.push({ id: assembly.deliverableId, kind: "film", role: "manifest", url: assembly.manifestUrl });
        if (assembly.logUrl) list.push({ id: assembly.deliverableId, kind: "film", role: "log", url: assembly.logUrl });
        if (assembly.coverUrl) list.push({ id: assembly.deliverableId, kind: "film", role: "cover", url: assembly.coverUrl });
        return list;
    }

    /**
     * 阶段状态以任务终态为准：必需 Job 全部成功才 done；
     * 全部进行中 running、部分成功 partial、全失败 error、有取消 canceled。重算 artifacts。
     * artifacts 会重建为「片段条目 + 成片条目」，成片信息由 filmArtifacts 从 assembly 派生，天然幂等。
     */
    function recomputeStage(stage) {
        const items = stage.output?.frames || stage.output?.clips || [];
        const latest = items.map((item) => (item.candidates || []).at(-1)).filter(Boolean);
        stage.artifacts = [...items.filter((item) => item.artifactUrl).map((item) => ({ jobId: item.jobId, url: item.artifactUrl })), ...filmArtifacts(stage)];
        if (!latest.length) return;
        const statuses = latest.map((candidate) => candidate.status);
        // 只要有任务还在排队/运行就是 running —— 部分已完成既不代表阶段可审阅、也不代表可续跑；
        // 前端也靠 stage.status === "running" 决定要不要继续轮询阶段进度。
        if (statuses.some((status) => status === "queued" || status === "running")) stage.status = "running";
        else if (statuses.every((status) => status === "done")) stage.status = "done";
        else if (statuses.some((status) => status === "done")) stage.status = "partial";
        else if (statuses.includes("canceled")) stage.status = "canceled";
        else stage.status = "error";
        if (TERMINAL_JOB.has(stage.status)) stage.finishedAt = stage.finishedAt || nowIso();
    }

    /** 单个条目的生成参数与就绪判定：模板要求的 token 必须全给，尺寸取 config.pipeline 默认值。 */
    function generativePlan(run, def, item, frames, shots) {
        const extraParams = (def.id === "keyframe" ? run.options?.image : run.options?.video) || {};
        const start = frames.find((frame) => frame.shotId === item.shotId && frame.role === "start");
        if (def.id === "keyframe") {
            // start / key / end 都用同一个文生图模板；end 帧要等同镜 start 帧产出后才能带参考图入队。
            return {
                kind: "image",
                template: pipelineConfig.imageTemplate,
                ready: item.role !== "end" || Boolean(start?.artifactUrl),
                params: {
                    WIDTH: Number(pipelineConfig.imageWidth) || 768,
                    HEIGHT: Number(pipelineConfig.imageHeight) || 1344,
                    BATCH: Number(pipelineConfig.imageBatch) || 1,
                    PROMPT: item.prompt,
                    ...(item.role === "end" ? { INPUT_IMAGE: start?.artifactUrl } : {}),
                    ...extraParams,
                },
            };
        }
        item.durationSec = Number(item.durationSec) > 0 ? Number(item.durationSec) : Number(pipelineConfig.videoSeconds) || 5;
        if (!item.keyframeId) item.keyframeId = start?.id ?? null;
        const shot = shots.find((entry) => entry.id === item.shotId);
        return {
            kind: "video",
            template: pipelineConfig.videoTemplate,
            // 图生视频必须有起始帧；没拿到就保持 queued + jobId:null，等关键帧产物就绪后由回写代理入队（契约见 05 SKILL.md）。
            ready: Boolean(start?.artifactUrl),
            params: {
                WIDTH: Number(pipelineConfig.videoWidth) || 768,
                HEIGHT: Number(pipelineConfig.videoHeight) || 1344,
                PROMPT: [shot?.prompt, shot?.action].filter(Boolean).join(", "),
                LENGTH: frameCountFor(item.durationSec, Number(pipelineConfig.videoFps) || 24),
                ...(start?.artifactUrl ? { INPUT_IMAGE: start.artifactUrl } : {}),
                ...extraParams,
            },
        };
    }

    /** 入队一次生成尝试并追加候选。重跑用带时间戳的新 id，绝不覆盖旧 jobId/artifactUrl。 */
    function enqueueAttempt(run, def, item, plan) {
        if (typeof runJob !== "function" || typeof jobs?.enqueue !== "function") return null;
        const base = `${run.id}-${item.id}`;
        // 重跑必然带时间戳 + 随机后缀：同一毫秒内连点两次也不能撞出同一个 jobId，否则候选会被 upsert 合并。
        const id = item.candidates?.length ? `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : base;
        const job = jobs.enqueue({ id, kind: plan.kind, template: plan.template, name: item.id, params: plan.params, meta: { runId: run.id, stageId: def.id, itemId: item.id } }, runJob);
        if (!job) return null;
        item.candidates = [...(item.candidates || []), { template: plan.template, jobId: job.id, artifactUrl: null, status: "queued", params: plan.params, createdAt: nowIso() }];
        item.jobId = job.id;
        item.selected = job.id;
        item.status = "queued";
        return job.id;
    }

    /** 让尚未入队且前置已就绪的条目补入队；幂等：已有本次 jobId 的跳过。首次编排与回写后都走这里。 */
    function enqueueReady(run, def, stage, items, frames, shots) {
        for (const item of items) {
            const plan = generativePlan(run, def, item, frames, shots);
            item.template = plan.template;
            if (item.jobId || !plan.ready) continue;
            enqueueAttempt(run, def, item, plan);
        }
    }

    /**
     * 逐条重跑（regenerate）同步部分：只做门禁与本次 attempt 的生成计划，**不产生任何副作用**。
     * 语义：给一个 item 换模板再追加一个候选，不动其它 item、不删旧候选；慢的真实生成由任务队列后台跑。
     * 门禁失败抛 gateError：参数/引用非法 400，阶段或条目正忙（防并发重复入队）409。
     */
    function beginRegenerate(runId, stageId, { itemId, template, params } = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        // 只有生成型阶段有候选活扣；文本阶段（script/storyboard 等）明确拒绝。
        const family = STAGE_TEMPLATE_FAMILY[def.id];
        if (!family) throw gateError(`阶段「${def.title}」不是生成型阶段，不支持逐条重跑`);
        // 阶段整体在跑（LLM 编排中，或已有条目在排队/生成）→ 拒绝并发重复入队。
        if (stage.status === "running") throw gateError(`阶段「${def.title}」正在运行中，请先取消或等它结束再逐条重跑`, 409);
        const items = def.id === "keyframe" ? stage.output?.frames : stage.output?.clips;
        const item = Array.isArray(items) ? items.find((entry) => entry.id === itemId) : null;
        if (!item) throw gateError(`阶段「${def.title}」里没有条目：${itemId ?? "(空)"}`);
        // 该条目自己已有未完成候选 → 拒绝（即便阶段状态因人为修订不是 running，也不能撞 jobId）。
        const unfinished = (item.candidates || []).find((candidate) => candidate.status === "queued" || candidate.status === "running");
        if (unfinished) throw gateError(`条目「${item.id}」已有未完成候选（${unfinished.jobId}），请等它结束或先取消`, 409);
        if (typeof runJob !== "function" || typeof jobs?.enqueue !== "function") throw gateError("未接入生成执行体，无法逐条重跑");
        // template 必须存在且属于该阶段 family（图/视频），杜绝把视频模板塞进关键帧阶段。
        const chosen = String(template ?? "").trim();
        if (chosen) {
            const known = templateFamilies.get(chosen);
            if (!known) throw gateError(`模板不存在：${chosen}`);
            if (known !== family) throw gateError(`模板「${chosen}」属于 ${known} family，不能用于「${def.title}」（需要 ${family}）`);
        }
        const shots = run.stages?.storyboard?.output?.shots || [];
        const frames = def.id === "keyframe" ? items : run.stages?.keyframe?.output?.frames || [];
        const plan = generativePlan(run, def, item, frames, shots);
        if (!plan.ready) throw gateError(`条目「${item.id}」的前置产物还没就绪，不能重跑`);
        plan.template = chosen || plan.template;
        if (params && typeof params === "object") plan.params = { ...plan.params, ...params };
        return { run, def, stage, item, plan };
    }

    /**
     * 逐条重跑（regenerate）异步部分：把本次 attempt 入队并追加候选，新候选成为 selected。
     * 入队非阻塞（真实执行在任务队列后台），job 终态由 projectJob 幂等回写。
     */
    function executeRegenerate(begun) {
        const { run, def, stage, item, plan } = begun;
        const jobId = enqueueAttempt(run, def, item, plan);
        if (!jobId) throw gateError("生成任务入队失败");
        item.template = plan.template;
        recomputeStage(stage);
        // 写一条 running 进度：阶段此前多半是 done，不刷新的话轻量进度轮询会一直读到旧的 phase:"done"。
        writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: "running", label: `重跑条目 ${item.id}（${plan.template}）` });
        saveRun(run);
        return { run, jobId };
    }

    /**
     * 生成型阶段：模型只负责写提示词与清单，template/jobId/artifactUrl/status 全部由编排器回填。
     * 关键帧先入队 start 帧，end 帧等 start 帧产物回写后由投影补入队；片段等关键帧就绪后入队。
     * prev 是重排前的产物，用于继承旧候选与产物（重跑只追加候选）。
     */
    function attachGeneration(run, def, stage, prev) {
        const output = stage.output && typeof stage.output === "object" ? stage.output : {};
        const items = def.id === "keyframe" ? output.frames : output.clips;
        if (!Array.isArray(items) || !items.length) throw new Error(`模型未返回 ${def.id === "keyframe" ? "frames" : "clips"} 数组`);
        const shots = run.stages?.storyboard?.output?.shots || [];
        const frames = def.id === "keyframe" ? items : run.stages?.keyframe?.output?.frames || [];
        const prevItems = def.id === "keyframe" ? prev?.frames : prev?.clips;
        for (const item of items) {
            const old = prevItems?.find((entry) => entry.id === item.id);
            item.candidates = old?.candidates ? old.candidates.map((candidate) => ({ ...candidate })) : [];
            item.artifactUrl = old?.artifactUrl ?? null;
            item.selected = old?.selected ?? null;
            item.jobId = null;
            item.status = "queued";
        }
        enqueueReady(run, def, stage, items, frames, shots);
        for (const item of items) syncItem(item);
        const assembly = output.assembly && typeof output.assembly === "object" ? output.assembly : {};
        stage.output =
            def.id === "keyframe"
                ? { frames: items }
                : {
                      clips: items,
                      assembly: {
                          order: Array.isArray(assembly.order) && assembly.order.length ? assembly.order : items.map((clip) => clip.id),
                          transition: assembly.transition || run.options?.transition || "cut",
                          status: "queued",
                      },
                  };
        recomputeStage(stage);
    }

    /** Job 终态投影：按 meta 反查 run/stage/item，幂等回写候选与派生字段，并让前置刚就绪的下游条目入队。 */
    function projectJob(job) {
        if (!job || !TERMINAL_JOB.has(job.status)) return null;
        const { runId, stageId, itemId } = job.meta || {};
        if (!runId || !stageId || !itemId) return null;
        const run = get(runId);
        const def = stageDefs.get(String(stageId));
        const stage = run?.stages?.[stageId];
        const items = stage?.output?.frames || stage?.output?.clips;
        const item = Array.isArray(items) ? items.find((entry) => entry.id === itemId) : null;
        if (!def || !item) return null;
        upsertCandidate(item, job);
        syncItem(item);
        const shots = run.stages?.storyboard?.output?.shots || [];
        if (def.id === "keyframe") enqueueReady(run, def, stage, items, items, shots);
        else if (def.id === "assembly") enqueueReady(run, def, stage, items, run.stages?.keyframe?.output?.frames || [], shots);
        recomputeStage(stage);
        return saveRun(run);
    }

    /**
     * 订阅任务队列终态事件并重放历史任务，建立 Job→Artifact→Item 投影。index.js 启动时调用一次。
     * 重放让服务重启后能从 jobs.json 的终态任务重建流水线状态（幂等）。
     */
    function bindJobs() {
        if (typeof jobs?.on !== "function") return;
        jobs.on("change", (job) => {
            try {
                projectJob(job);
            } catch (error) {
                console.error(`[pipeline] 任务回写失败 ${job?.id}：${error.message}`);
            }
        });
        for (const job of jobs.list?.() || []) projectJob(job);
    }

    /** 取消阶段：连带取消该阶段已入队的图像/视频 Job，并把阶段落成 canceled。 */
    function cancelStage(runId, stageId) {
        requireRun(runId);
        const def = requireStageDef(stageId);
        let canceled = 0;
        for (const job of jobs?.list?.() || []) {
            const meta = job.meta || {};
            if (meta.runId !== runId || meta.stageId !== def.id || TERMINAL_JOB.has(job.status)) continue;
            jobs.cancel(job.id);
            // 取消一次就投影一次：即便队列没有订阅者，也能把终态写回流水线。
            projectJob(jobs.get(job.id) || job);
            canceled += 1;
        }
        return { canceled, run: get(runId) };
    }

    /**
     * 同步部分：校验依赖、绑定模型、标记 running 并落盘，返回执行所需上下文。
     * 拆出来是为了让 HTTP 路由能立刻返回 202 —— 一个 163 块 / 83 分钟的阶段不能用一个
     * 阻塞式 POST 扛：隧道、反向代理、浏览器都会在几分钟内掐断连接，前端 await 抛错后
     * 按钮复位、页面「毫无反应」，而后端仍在继续跑并消耗 LLM 额度。
     */
    function beginStage(runId, stageId, runOptions = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
        if (stage.status === "running") throw new Error(`阶段「${def.title}」正在运行中，请先取消或等它结束`);
        // 调用方可按阶段绑定模型：body.model 持久化到 run.options.stageModels，重跑沿用
        if (typeof runOptions.model === "string" && runOptions.model.trim()) {
            run.options = { ...(run.options || {}), stageModels: { ...(run.options?.stageModels || {}), [def.id]: runOptions.model.trim() } };
        }
        // 浏览器渠道透传的外部 API：仅校验形状，仅本次调用生效，绝不写入 run/options
        let provider = null;
        if (runOptions.provider && typeof runOptions.provider === "object") {
            const baseUrl = String(runOptions.provider.baseUrl || "").trim();
            if (!/^https?:\/\//i.test(baseUrl)) throw new Error("provider.baseUrl 必须是 http(s) 地址");
            provider = { baseUrl, apiKey: String(runOptions.provider.apiKey || "") };
        }
        for (const depId of def.requires) {
            const dep = run.stages?.[depId];
            if (!dep || dep.status !== "done" || dep.output === undefined || dep.output === null) {
                throw new Error(`请先完成 ${dep?.title || depId}`);
            }
        }
        stage.status = "running";
        stage.error = undefined;
        stage.startedAt = nowIso();
        stage.finishedAt = undefined;
        // resume 为真时保留上次的分块结果以便断点续跑；否则清空，避免小说改过之后复用陈旧块
        if (runOptions.resume) {
            const cached = countChunks(runId);
            writeProgress(runId, { runId, stage: def.id, phase: "map", done: cached, total: 0, reused: cached, resumed: true, label: cached ? `复用已完成的 ${cached} 块` : "准备分块" });
        } else {
            clearChunks(runId);
            clearProgress(runId);
        }
        saveRun(run);
        return { run, def, stage, provider };
    }

    /** 异步部分：真正跑 LLM 与入队，并把终态与进度落盘。 */
    async function executeStage(begun, runOptions = {}) {
        const { run, def, stage, provider } = begun;
        const estSecondsPerChunk = Number(pipelineConfig.estSecondsPerChunk) > 0 ? Number(pipelineConfig.estSecondsPerChunk) : 31;
        try {
            // 生成型阶段重排前的产物，用于继承旧候选（重跑只追加候选，不清空旧 jobId/artifactUrl）。
            const prevOutput = GENERATIVE_STAGES.has(def.id) ? stage.output : null;
            // 五个阶段都先由 LLM 按「输出契约」产出 JSON；生成型阶段再回填生成参数并入队。
            await composeWithLlm(run, def, stage, provider, { signal: runOptions.signal, resume: Boolean(runOptions.resume), estSecondsPerChunk });
            if (GENERATIVE_STAGES.has(def.id)) {
                attachGeneration(run, def, stage, prevOutput);
                // 不再「入队即 done」：有任务就等任务终态（回写投影会重算），没有可跑任务（未接 runJob）才算完成。
                const enqueued = (stage.output.frames || stage.output.clips || []).some((item) => (item.candidates || []).length);
                if (!enqueued) {
                    stage.status = "done";
                    stage.finishedAt = nowIso();
                }
            } else {
                stage.status = "done";
                stage.finishedAt = nowIso();
            }
            if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
            // 成功也保留一条进度：只有真正 done 才写 phase:"done"，生成型阶段等 Job 终态时写 running，
            // 否则前端会误判「跑完了」而停止轮询一个还在生成的任务。
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: stage.status === "done" ? "done" : "running", finishedAt: stage.finishedAt });
        } catch (error) {
            stage.status = "error";
            stage.error = error.raw ? `${error.message}：${String(error.raw).slice(0, 4000)}` : error.message;
            stage.finishedAt = nowIso();
            // 失败/取消时保留进度：前端才能显示「跑到第几块停的」，用户也才知道 resume 能省下多少
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: "failed", error: stage.error });
        }
        return saveRun(run);
    }

    /** 同步等整段跑完（测试与内部调用用）；HTTP 路由走 beginStage + executeStage 以便立刻返回 202。 */
    async function runStage(runId, stageId, runOptions = {}) {
        return executeStage(beginStage(runId, stageId, runOptions), runOptions);
    }

    /** 片段就绪判定：任一未成功的片段都会阻止合成，并给出人能看懂的原因。 */
    function clipsReadiness(clips) {
        if (!Array.isArray(clips) || !clips.length) return { ready: false, reason: "assembly 阶段还没有片段清单，请先运行「片段合成」规划片段" };
        const unfinished = clips.filter((clip) => clip.status !== "done");
        if (unfinished.length) {
            const detail = unfinished.map((clip) => `${clip.id}（${clip.status || "未知"}）`).join("、");
            return { ready: false, reason: `还有 ${unfinished.length}/${clips.length} 个片段未成功，不能合成成片：${detail}` };
        }
        const missing = clips.filter((clip) => !clip.artifactUrl);
        if (missing.length) return { ready: false, reason: `片段 ${missing.map((clip) => clip.id).join("、")} 没有产物地址，不能合成成片` };
        return { ready: true };
    }

    /**
     * 合成成片（同步部分）：独立于阶段 LLM 编排的用户触发动作 —— D11 定了保留逐阶段人工审核门禁，
     * 用户要先看过片段才决定拼，所以不因 clips 齐了就自动拼。
     * 这里只做门禁与幂等判定：片段未全部成功直接抛错（不能把「片段生成完」报成「成片完成」）；
     * 已有成片且未显式要求重拼时直接复用，不重复调 ffmpeg。慢的 ffmpeg 执行留给 executeAssemble。
     */
    function beginAssemble(runId, options = {}) {
        const run = requireRun(runId);
        const def = requireStageDef("assembly");
        const stage = requireStage(run, def);
        const output = stage.output;
        if (!output || !Array.isArray(output.clips)) throw new Error("assembly 阶段还没有产物，请先运行「片段合成」规划片段");
        const readiness = clipsReadiness(output.clips);
        if (!readiness.ready) throw new Error(readiness.reason);

        const assembly = output.assembly && typeof output.assembly === "object" ? output.assembly : (output.assembly = {});
        const force = options.force === true || options.rerun === true;
        if (assembly.status === "assembling" && !force) throw new Error("成片正在合成中，请等它结束（要重拼请带 force:true）");
        if (assembly.status === "done" && assembly.url && !force) return { run, def, stage, reused: true, assembly };

        // 重拼用新的产物目录，绝不覆盖上一次已成功的成片（即使这次拼失败，旧成片仍在）
        const attempt = (Number(assembly.attempt) || 0) + 1;
        const id = attempt > 1 ? `assembly-${run.id}-r${attempt}` : `assembly-${run.id}`;
        assembly.attempt = attempt;
        assembly.status = "assembling";
        assembly.startedAt = nowIso();
        assembly.finishedAt = undefined;
        assembly.error = undefined;
        // 本次调用可覆盖拼接顺序/转场；未给则沿用规划值
        if (Array.isArray(options.order) && options.order.length) assembly.order = options.order;
        if (typeof options.transition === "string" && options.transition) assembly.transition = options.transition;
        saveOutput(run.id, def.id, stage.output);
        saveRun(run);
        return { run, def, stage, reused: false, assembly, id };
    }

    /**
     * 合成成片（异步部分）：把片段清单与参数交给 delivery 的 assembleEpisode，产物地址与成片信息回写 assembly。
     * 成功才写 url 并登记 artifacts；失败保留 delivery 已落盘的清单与 ffmpeg 日志地址，错误信息带原因，方便排查。
     */
    async function executeAssemble(begun, options = {}) {
        const { run, def, stage, id } = begun;
        const assembly = stage.output.assembly;
        const clips = stage.output.clips;
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: "assembling", label: `正在把 ${clips.length} 个片段合成成片` });
        try {
            const result = await assemble({
                config,
                episodeId: run.id,
                clips,
                order: assembly.order,
                transition: assembly.transition,
                options: {
                    id,
                    quality: options.quality,
                    transitionDurationSec: options.transitionDurationSec,
                    audio: options.audio,
                    subtitles: options.subtitles,
                    cover: options.cover,
                },
                now: nowIso(),
            });
            assembly.status = "done";
            assembly.deliverableId = result.id;
            assembly.url = result.url;
            assembly.manifestUrl = result.manifestUrl;
            assembly.logUrl = result.logPath ? artifactUrl(config, result.id, "ffmpeg.log") : null;
            assembly.coverUrl = result.coverUrl || null;
            assembly.bytes = result.bytes;
            assembly.info = result.info || null;
            assembly.finishedAt = nowIso();
            assembly.error = undefined;
        } catch (error) {
            assembly.status = "error";
            assembly.error = `合成成片失败：${error.message}`;
            assembly.finishedAt = nowIso();
            // 保留 delivery 落盘的清单与日志（都在同一个交付目录下），失败也要能复现
            const dir = safeJoin(config.dataDir, "artifacts", id);
            assembly.manifestUrl = dir && existsSync(safeJoin(dir, "assembly-manifest.json")) ? artifactUrl(config, id, "assembly-manifest.json") : null;
            assembly.logUrl = dir && existsSync(safeJoin(dir, "ffmpeg.log")) ? artifactUrl(config, id, "ffmpeg.log") : null;
        }
        recomputeStage(stage);
        if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
        writeProgress(run.id, { runId: run.id, stage: def.id, phase: assembly.status === "done" ? "done" : "failed", label: assembly.status === "done" ? "成片已生成" : assembly.error, finishedAt: assembly.finishedAt });
        return saveRun(run);
    }

    /** 同步等合成结束（测试与内部调用用）；HTTP 路由走 beginAssemble + executeAssemble 以便立刻返回 202。 */
    async function assembleStage(runId, options = {}) {
        const begun = beginAssemble(runId, options);
        if (begun.reused) return begun.run;
        return executeAssemble(begun, options);
    }

    /** 轻量进度：只读 progress.json（几十字节），不返回内嵌整本小说的 run.json（可达数 MB）。 */
    const stageProgress = (runId) => readProgress(runId);

    /**
     * 启动收敛：把上次进程遗留的 running 阶段落成明确 error。
     * 必须做 —— beginStage 会拒绝在 running 阶段上重跑，不收敛的话重启一次就把那个阶段永久锁死。
     * 分块结果仍在 chunks/ 里，带 resume:true 重跑即可续上，不必从头再来。
     */
    function reconcileRunning() {
        const fixed = [];
        for (const run of list()) {
            let touched = false;
            for (const stage of Object.values(run.stages || {})) {
                if (stage.status !== "running") continue;
                stage.status = "error";
                stage.error = "服务重启导致中断；已完成的分块结果已保留，可用 resume 续跑";
                stage.finishedAt = nowIso();
                writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: stage.id, phase: "failed", error: stage.error });
                touched = true;
            }
            if (touched) {
                saveRun(run);
                fixed.push(run.id);
            }
        }
        return fixed;
    }

    return { stages, list, get, create, estimate: estimateFor, runStage, beginStage, executeStage, stageProgress, reconcileRunning, setStageInput, projectJob, bindJobs, cancelStage, beginAssemble, executeAssemble, assembleStage, beginRegenerate, executeRegenerate };
}

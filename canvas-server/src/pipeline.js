import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { splitNovelIntoChunks } from "./chunk-novel.js";
import { ensureDir, safeJoin } from "./files.js";
import { loadRegistry, readSkill } from "./skills.js";

/** 生成型阶段：只构造生成任务参数并交给任务队列，不等真实产物。 */
const GENERATIVE_STAGES = new Set(["keyframe", "assembly"]);

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
 */
export function createPipeline({ config, skillsDir, jobs, comfy, llm, runJob } = {}) {
    const pipelineConfig = config?.pipeline || {};
    const runsDir = ensureDir(join(config?.dataDir || "data", "runs"));
    const registry = loadRegistry(skillsDir);
    const stageDefs = new Map(registry.stages.map((item) => [item.id, item]));

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
     * 01 剧本分块改编（map-reduce）：整本长篇超过阈值时切成 N 块，逐块提取局部人物/场次，
     * 再把全部局部结果与项目标题喂给模型合并成符合 01 SKILL.md 契约的完整剧本。
     * stage.output 与单次调用完全同构，分块信息记在 stage.chunked。
     */
    async function composeScriptChunked(run, def, stage, provider, maxChunkChars, ctx = {}) {
        const { signal, resume = false, estSecondsPerChunk = 31 } = ctx;
        const chunks = splitNovelIntoChunks(run.novel, maxChunkChars);
        const system = { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` };
        const partials = [];
        const startedAt = Date.now();
        let reused = 0;
        for (const chunk of chunks) {
            if (signal?.aborted) throw new Error(`已取消（第 ${partials.length}/${chunks.length} 块完成后中止）`);
            const mapPrompt = `你是影视剧本改编。长篇小说《${run.title}》太长，已分成 ${chunks.length} 块，这是第 ${chunk.index}/${chunks.length} 块（来源：${chunk.label}）。

<novel-part>
${chunk.text}
</novel-part>

要求：

1. 只提取本块出现的 characters 与 scenes，不要写 logline / synopsis / episodes。
2. characters 覆盖本块所有有台词或推动剧情的角色：profile 写身份、性格、人物关系；appearance 写成能直接喂给生图模型的外观描述（年龄、体态、五官、发型、服装基调），不要抽象形容词；voice 写音色、语速、口音等可复现的声音特征。
3. scenes 按本块时间顺序排列；beats 用 3~8 条原文里的可拍摄动作/台词节拍，不要文学抒情和心理描写。
4. location 统一写成「内景/外景 + 地点」，time 只用 日 / 夜 / 黄昏 / 清晨 这类可布光的词。
5. 只输出下面结构的 JSON 本体，id 在本块内唯一即可（合并时会统一重排），不要 Markdown 代码块、不要解释文字：

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
</partials>

要求：

1. 生成 logline（一句话故事线）与 synopsis（不超过 300 字的故事梗概）。
2. characters 按姓名合并去重，profile 合并各块信息；appearance 与 voice 必须每条非空，缺失时依据原文细节合理推断补齐。
3. scenes 按时间顺序合并，跨块重复的场次合并且不丢 beats；beats 保留可拍摄的动作/台词细节。
4. characters[].id 与 scenes[].id 全部重排为连续稳定的 c1、c2… 与 sc1、sc2…，只允许 [A-Za-z0-9_-]。
5. 短篇可省略 episodes；若给出，sceneIds 必须都能在 scenes 里找到。
6. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

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

    function enqueueItem(run, def, itemId, kind, template, params) {
        const job = jobs.enqueue(
            { id: `${run.id}-${itemId}`, kind, template, name: itemId, params, meta: { runId: run.id, stageId: def.id, itemId } },
            runJob,
        );
        return job?.id || null;
    }

    /**
     * 生成型阶段：模型只负责写提示词与清单，template/jobId/artifactUrl/status 全部由编排器回填。
     * end 帧要等同镜 start 帧拿到 artifactUrl 才能入队，没有真实 ComfyUI 时一律停在 queued。
     */
    function attachGeneration(run, def, stage) {
        const output = stage.output && typeof stage.output === "object" ? stage.output : {};
        const items = def.id === "keyframe" ? output.frames : output.clips;
        if (!Array.isArray(items) || !items.length) throw new Error(`模型未返回 ${def.id === "keyframe" ? "frames" : "clips"} 数组`);
        const shots = run.stages?.storyboard?.output?.shots || [];
        const frames = def.id === "keyframe" ? items : run.stages?.keyframe?.output?.frames || [];
        const extraParams = (def.id === "keyframe" ? run.options?.image : run.options?.video) || {};
        const fps = Number(pipelineConfig.videoFps) || 24;
        const fallbackSeconds = Number(pipelineConfig.videoSeconds) || 5;
        // 模板要求的 token 必须全部给到，否则渲染阶段就会报「缺少参数」。尺寸取 config.pipeline 的默认值，
        // 调用方仍可用 run.options.image / run.options.video 覆盖。
        const imageDefaults = {
            WIDTH: Number(pipelineConfig.imageWidth) || 768,
            HEIGHT: Number(pipelineConfig.imageHeight) || 1344,
            BATCH: Number(pipelineConfig.imageBatch) || 1,
        };
        const videoDefaults = {
            WIDTH: Number(pipelineConfig.videoWidth) || 768,
            HEIGHT: Number(pipelineConfig.videoHeight) || 1344,
        };
        const canEnqueue = typeof runJob === "function" && typeof jobs?.enqueue === "function";
        for (const item of items) {
            item.jobId = null;
            item.artifactUrl = null;
            item.status = "queued";
            const start = frames.find((frame) => frame.shotId === item.shotId && frame.role === "start");
            if (def.id === "keyframe") {
                // start / key / end 三种帧都用同一个文生图模板。end 帧此前被指向 editTemplate
                // （img_boogu_outfit_edit 是换装模板，要 PERSON_IMAGE + CLOTHING_IMAGE），既语义不符也必然报错。
                item.template = pipelineConfig.imageTemplate;
                const params = { ...imageDefaults, PROMPT: item.prompt, ...extraParams };
                // 模板确实需要 INPUT_IMAGE 时（例如后续接入图生图模板）才带上起始帧，避免无意义地触发上传。
                if (item.role === "end" && start?.artifactUrl) params.INPUT_IMAGE = start.artifactUrl;
                if (canEnqueue) item.jobId = enqueueItem(run, def, item.id, "image", item.template, params);
            } else {
                item.template = pipelineConfig.videoTemplate;
                item.durationSec = Number(item.durationSec) > 0 ? Number(item.durationSec) : fallbackSeconds;
                if (!item.keyframeId) item.keyframeId = start?.id ?? null;
                const shot = shots.find((entry) => entry.id === item.shotId);
                const params = {
                    ...videoDefaults,
                    PROMPT: [shot?.prompt, shot?.action].filter(Boolean).join(", "),
                    LENGTH: frameCountFor(item.durationSec, fps),
                    ...extraParams,
                };
                if (start?.artifactUrl) params.INPUT_IMAGE = start.artifactUrl;
                // 图生视频必须有起始帧；没拿到就保持 queued + jobId:null，等关键帧阶段产出后再跑（契约见 05 SKILL.md）。
                if (canEnqueue && params.INPUT_IMAGE) item.jobId = enqueueItem(run, def, item.id, "video", item.template, params);
            }
        }
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
        stage.artifacts = items.filter((item) => item.artifactUrl).map((item) => ({ jobId: item.jobId, url: item.artifactUrl }));
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
            // 五个阶段都先由 LLM 按「输出契约」产出 JSON；生成型阶段再回填生成参数并入队。
            await composeWithLlm(run, def, stage, provider, { signal: runOptions.signal, resume: Boolean(runOptions.resume), estSecondsPerChunk });
            if (GENERATIVE_STAGES.has(def.id)) attachGeneration(run, def, stage);
            stage.status = "done";
            stage.finishedAt = nowIso();
            if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
            // 成功也保留一条 phase:"done" 的进度：前端据此停止轮询，不必为了判断「跑完了没」
            // 去拉内嵌整本小说、可达数 MB 的 run.json
            writeProgress(run.id, { ...(readProgress(run.id) || {}), runId: run.id, stage: def.id, phase: "done", finishedAt: stage.finishedAt });
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

    return { stages, list, get, create, estimate: estimateFor, runStage, beginStage, executeStage, stageProgress, reconcileRunning, setStageInput };
}

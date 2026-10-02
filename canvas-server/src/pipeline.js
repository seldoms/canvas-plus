import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

    async function chat(messages, run, temperature, stageId, provider) {
        if (typeof llm?.chat !== "function") throw new Error("未配置 LLM 提供方");
        const options = { messages, temperature, response_format: { type: "json_object" } };
        const model = resolveModel(run, stageId);
        if (model) options.model = model;
        // 浏览器渠道透传的外部 API（仅本次调用生效，不落盘）
        if (provider) options.provider = provider;
        const result = await llm.chat(options);
        return result?.choices?.[0]?.message?.content ?? "";
    }

    /** 调一次模型并解析 JSON，失败带原文重试一次；再失败抛出带 raw 的错误。 */
    async function askJson(messages, run, stageId, provider, temperature = 0.6) {
        const first = await chat(messages, run, temperature, stageId, provider);
        const parsed = parseJsonLoose(first);
        if (parsed) return parsed;
        const retry = await chat(
            [...messages, { role: "assistant", content: String(first ?? "") }, { role: "user", content: "你上一次的输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块、不要任何解释。" }],
            run,
            0,
            stageId,
            provider,
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
    async function composeScriptChunked(run, def, stage, provider, maxChunkChars) {
        const chunks = splitNovelIntoChunks(run.novel, maxChunkChars);
        const system = { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` };
        const partials = [];
        for (const chunk of chunks) {
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
            const partial = await askJson([system, { role: "user", content: mapPrompt }], run, def.id, provider);
            partials.push({ index: chunk.index, label: chunk.label, ...partial });
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
        stage.output = await askJson([system, { role: "user", content: reducePrompt }], run, def.id, provider, 0.3);
        stage.chunked = { chunks: chunks.length, labels: chunks.map((chunk) => chunk.label), mergeModel: resolveModel(run, def.id) };
    }

    /** 文本型阶段：填模板 → 要求严格 JSON → 失败重试一次 → 再失败置 error。provider 为浏览器透传的外部渠道（仅本次调用）。 */
    async function composeWithLlm(run, def, stage, provider) {
        const prompt = fillTemplate(readPromptTemplate(def), buildContext(run, def));
        const maxChunkChars = Number(pipelineConfig.maxNovelChunkChars) || 16000;
        try {
            // 只有 01 剧本阶段会做分块；填入小说后的完整 prompt 超阈值时走 map-reduce，其余一律单次调用。
            if (def.id === "script" && prompt.length > maxChunkChars) {
                await composeScriptChunked(run, def, stage, provider, maxChunkChars);
                return;
            }
            const messages = [
                { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
                { role: "user", content: prompt },
            ];
            stage.output = await askJson(messages, run, def.id, provider);
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

    async function runStage(runId, stageId, runOptions = {}) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
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
        saveRun(run);
        try {
            // 五个阶段都先由 LLM 按「输出契约」产出 JSON；生成型阶段再回填生成参数并入队。
            await composeWithLlm(run, def, stage, provider);
            if (GENERATIVE_STAGES.has(def.id)) attachGeneration(run, def, stage);
            stage.status = "done";
            stage.finishedAt = nowIso();
            if (stage.output !== undefined && stage.output !== null) saveOutput(run.id, def.id, stage.output);
        } catch (error) {
            stage.status = "error";
            stage.error = error.raw ? `${error.message}：${String(error.raw).slice(0, 4000)}` : error.message;
            stage.finishedAt = nowIso();
        }
        return saveRun(run);
    }

    return { stages, list, get, create, runStage, setStageInput };
}

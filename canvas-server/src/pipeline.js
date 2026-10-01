import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, safeJoin } from "./files.js";
import { loadRegistry, readSkill } from "./skills.js";

/** 生成型阶段：只构造生成任务参数并交给任务队列，不等真实产物。 */
const GENERATIVE_STAGES = new Set(["keyframe", "assembly"]);

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

    async function chat(messages, run, temperature) {
        if (typeof llm?.chat !== "function") throw new Error("未配置 LLM 提供方");
        const options = { messages, temperature, response_format: { type: "json_object" } };
        const model = run.options?.llmModel || pipelineConfig.llmModel || "";
        if (model) options.model = model;
        const result = await llm.chat(options);
        return result?.choices?.[0]?.message?.content ?? "";
    }

    /** 文本型阶段：填模板 → 要求严格 JSON → 失败重试一次 → 再失败置 error。 */
    async function composeWithLlm(run, def, stage) {
        const prompt = fillTemplate(readPromptTemplate(def), buildContext(run, def));
        const messages = [
            { role: "system", content: `你是「${def.title}」阶段的执行者。严格只返回一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。` },
            { role: "user", content: prompt },
        ];
        const first = await chat(messages, run, 0.6);
        const parsed = parseJsonLoose(first);
        if (parsed) {
            stage.output = parsed;
            return;
        }
        const retry = await chat(
            [...messages, { role: "assistant", content: String(first ?? "") }, { role: "user", content: "你上一次的输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块、不要任何解释。" }],
            run,
            0,
        );
        const retried = parseJsonLoose(retry);
        if (retried) {
            stage.output = retried;
            return;
        }
        stage.output = null;
        const error = new Error("模型未返回合法 JSON");
        error.raw = String(retry ?? first ?? "");
        throw error;
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
        const canEnqueue = typeof runJob === "function" && typeof jobs?.enqueue === "function";
        for (const item of items) {
            item.jobId = null;
            item.artifactUrl = null;
            item.status = "queued";
            const start = frames.find((frame) => frame.shotId === item.shotId && frame.role === "start");
            if (def.id === "keyframe") {
                item.template = item.role === "end" ? pipelineConfig.editTemplate : pipelineConfig.imageTemplate;
                const params = { PROMPT: item.prompt, ...extraParams };
                if (item.role === "end" && start?.artifactUrl) params.INPUT_IMAGE = start.artifactUrl;
                if (canEnqueue && (item.role !== "end" || params.INPUT_IMAGE)) item.jobId = enqueueItem(run, def, item.id, "image", item.template, params);
            } else {
                item.template = pipelineConfig.videoTemplate;
                item.durationSec = Number(item.durationSec) > 0 ? Number(item.durationSec) : fallbackSeconds;
                if (!item.keyframeId) item.keyframeId = start?.id ?? null;
                const shot = shots.find((entry) => entry.id === item.shotId);
                const params = {
                    PROMPT: [shot?.prompt, shot?.action].filter(Boolean).join(", "),
                    LENGTH: Math.max(1, Math.round(item.durationSec * fps)),
                    FRAME_RATE: fps,
                    ...extraParams,
                };
                if (start?.artifactUrl) params.INPUT_IMAGE = start.artifactUrl;
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

    async function runStage(runId, stageId) {
        const run = requireRun(runId);
        const def = requireStageDef(stageId);
        const stage = requireStage(run, def);
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
            await composeWithLlm(run, def, stage);
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

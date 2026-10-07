/**
 * generation-intent.js —— 统一生成提交链（M1）：所有生成提交收敛为
 * `GenerationIntent → 上下文校验 → 能力解析 → 提示词编译 → Job` 一条链。
 *
 * 纯业务模块：不 import http.js、不自己起 server、不碰存储路径；
 * 队列 / 项目查询 / 注册表 / 编译器全部由调用方经 deps 注入。
 *
 * 编译出口折中（决策 C，M3.6 再收口单一编译出口）：调用方已编译时把结果放进
 * `intent.params.PROMPT`，submit 跳过编译（pipeline 的 compilePromptItem 带指纹缓存、
 * 工作台的 compileWorkbenchPrompt 都走这条路）；未编译时才走 deps.promptCompiler。
 * 编译失败只降级记 warning（沿用既有语义），绝不产生空 prompt。
 */

const INTENT_SOURCES = new Set(["project", "canvas", "workbench", "api"]);

/**
 * source 白名单**按前缀**判定（P2 修复一次真实回归）。
 *
 * 此前是精确匹配：工作台把 `source: "video-workbench"` 放进 meta，而 `/api/generate/*` 读
 * `body.source ?? meta.source`，于是 createGenerationIntent 直接 400 —— **视频工作台一条都提交不了**
 * （真机实测：只传 meta.source → 400，顶层传合法 source → 201）。
 * 精确匹配让「在合法来源上加个后缀区分具体页面」这种合理做法直接崩掉主链路。
 *
 * 现在：`<合法来源>`、`<合法来源>-<子标识>`、`<子标识>-<合法来源>`（如真实的
 * `video-workbench` / `image-workbench`）都放行，不含合法段的仍拒。
 * 分段校验保留了「未知来源不许进」的底线，不是无边界放行。
 */
function isIntentSource(value) {
    if (INTENT_SOURCES.has(value)) return true;
    // 按 `-` 分段，任一段命中合法来源即放行。
    // 为什么不能只认「合法来源开头」：真实来源名是 `video-workbench` / `image-workbench`，
    // 子标识（区分哪个页面）在**前**、来源名在后 —— 只做 startsWith 的话这两个全被拒，
    // 而它们恰恰是生图/生视频工作台一直在用的名字（P0 回归，真机实测 400）。
    // 仍然保留底线：`foo-bar`、`workbenchish` 这类不含合法段的仍拒。
    return value.split("-").some((part) => INTENT_SOURCES.has(part));
}
const INTENT_KINDS = new Set(["image", "video", "audio"]);

/** 归属字段：context → job.meta 的直通清单（契约 §3.10，有值才写）。 */
const CONTEXT_FIELDS = ["projectId", "episodeId", "sceneId", "shotId", "slotId", "runId", "stageId"];

/**
 * 从提交体里抽归属上下文（P2-B4）。
 *
 * 为什么不各写各的：`/api/generate/*`（index.js）、`/api/images/enqueue`（workbench-jobs.js）
 * 此前各读各的字段，前者支持 7 个、后者只认 `body.projectId` 单个 —— 归因在生图工作台静默失效
 * （shotId/slotId 传了也到不了 job.meta，任务终态无法投影为项目槽位候选）。
 * 三条提交链（generate / enqueue / artifacts import）统一从这里取，口径只有这一份。
 *
 * 顶层字段优先于 `body.meta`：与 index.js 既有口径一致（顶层是显式归因，meta 是留痕袋）。
 * 空串 / undefined / 非标量一律丢弃，由 asId 归一。
 */
export function contextFromBody(body = {}) {
    const meta = body?.meta && typeof body.meta === "object" ? body.meta : {};
    const read = (field) => asId(body?.[field] ?? meta[field]);
    return {
        projectId: read("projectId"),
        episodeId: read("episodeId"),
        sceneId: read("sceneId"),
        shotId: read("shotId"),
        slotId: read("slotId"),
        runId: read("runId"),
        stageId: read("stageId"),
    };
}

/** 契约错误：形状参照 production-contracts.js（路由层可直接用 .status 回响应）。 */
function contractError(message, field) {
    const error = new Error(message);
    error.status = 400;
    error.code = "CONTRACT_INVALID";
    error.field = field;
    return error;
}

const asId = (value) => (value === undefined || value === null || String(value).trim() === "" ? null : String(value));

/**
 * 规整一次生成意图。缺 kind / template 属结构性非法 → 抛 400 契约错误。
 * @returns {{ id: string, source: string, kind: string, context: object, toolId: string|null,
 *             template: string, facts: object, references: Array, params: object, options: object }}
 */
export function createGenerationIntent(input = {}) {
    const kind = typeof input.kind === "string" ? input.kind.trim() : "";
    if (!INTENT_KINDS.has(kind)) throw contractError(`缺少或非法 kind（须为 image|video|audio）：${kind || "(空)"}`, "kind");
    const template = typeof input.template === "string" ? input.template.trim() : "";
    if (!template) throw contractError("缺少 template", "template");
    const source = asId(input.source) || "api";
    if (!isIntentSource(source)) throw contractError(`非法 source（须为 project|canvas|workbench|api，可带 -子标识 后缀）：${source}`, "source");
    const context = input.context && typeof input.context === "object" ? input.context : {};
    return {
        id: asId(input.id) || `intent_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        source,
        kind,
        context: Object.fromEntries(CONTEXT_FIELDS.map((field) => [field, asId(context[field])])),
        toolId: asId(input.toolId),
        template,
        facts: structuredClone(input.facts && typeof input.facts === "object" ? input.facts : {}),
        references: [...(Array.isArray(input.references) ? input.references : [])],
        params: { ...(input.params && typeof input.params === "object" ? input.params : {}) },
        options: { ...(input.options && typeof input.options === "object" ? input.options : {}) },
    };
}

/**
 * 提交一次生成意图，四步：① 上下文校验 → ② 能力解析 → ③ 提示词编译 → ④ 入队。
 * @param {object} intent 经 createGenerationIntent 规整的意图
 * @param {{ jobs: object, runner: Function, getProject?: Function, registry?: object,
 *           promptCompiler?: (intent) => Promise<{ prompt: string|null, warnings?: string[] }> }} deps
 *   jobs/runner 必填；getProject 在 context.projectId 非空时必填（项目不存在 → 409）；
 *   registry 提供时做 canRun 能力校验（复用现有判定，不新增规则）；
 *   promptCompiler 仅在 params.PROMPT 缺失时调用（已编译跳过）。
 */
export async function submitGenerationIntent(intent, deps = {}) {
    if (typeof deps.jobs?.enqueue !== "function") throw new Error("submitGenerationIntent 需要注入 jobs.enqueue（复用现有任务队列）");
    if (typeof deps.runner !== "function") throw new Error("submitGenerationIntent 需要注入 runner（复用现有执行体）");
    const { context, options } = intent;

    // ① 上下文校验：归属项目必须真实存在，不把悬空 projectId 写进事实链。
    if (context.projectId) {
        if (typeof deps.getProject !== "function") throw new Error("submitGenerationIntent 缺少 getProject 依赖，无法校验项目上下文");
        if (!deps.getProject(context.projectId)) {
            throw Object.assign(new Error(`项目不存在：${context.projectId}`), { status: 409, code: "PROJECT_NOT_FOUND", field: "context.projectId" });
        }
    }

    // ② 能力解析：复用 registry.canRun 的现有判定（能力不匹配 / 设备不可用 → 拒绝并给可读原因）。
    if (typeof deps.registry?.canRun === "function") {
        const verdict = deps.registry.canRun(intent.template);
        if (verdict && !verdict.ok) {
            throw Object.assign(new Error(`无法提交生成任务：${verdict.reason}`), { status: 400, code: verdict.code || "CAPABILITY_UNAVAILABLE", field: "template" });
        }
    }

    // ③ 提示词编译：调用方已编译（params.PROMPT 存在）则跳过；编译器降级结果带 warning，空结果不写回。
    const params = { ...intent.params };
    const warnings = [];
    if (params.PROMPT === undefined && typeof deps.promptCompiler === "function") {
        const compiled = (await deps.promptCompiler(intent)) || {};
        if (typeof compiled.prompt === "string" && compiled.prompt.trim()) params.PROMPT = compiled.prompt;
        if (Array.isArray(compiled.warnings)) warnings.push(...compiled.warnings.map(String).filter(Boolean));
    }

    // ④ 入队：归属字段有值才写（契约 §3.10）；options.meta 里调用方的留痕字段原样保留。
    const meta = { ...(options.meta && typeof options.meta === "object" ? options.meta : {}) };
    meta.source = intent.source;
    for (const field of CONTEXT_FIELDS) {
        if (context[field]) meta[field] = context[field];
    }
    if (intent.toolId) meta.toolId = intent.toolId;
    const idempotencyKey = asId(options.idempotencyKey);
    if (idempotencyKey) meta.idempotencyKey = idempotencyKey;
    if (warnings.length) meta.promptWarning = [...new Set(warnings)].join("；");

    return deps.jobs.enqueue(
        {
            id: asId(options.jobId) || `${intent.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            kind: intent.kind,
            backend: asId(options.backend) || "local",
            template: intent.template,
            name: asId(options.name) || intent.template,
            params,
            meta,
        },
        deps.runner,
    );
}

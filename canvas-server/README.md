# canvas-server — 无限画布本地网关

无限画布（infinite-canvas）原本是纯前端应用，AI 接口由浏览器直连第三方。本服务是**新增的本地网关后端**，把内网模型与生图/生视频能力收口成一套稳定接口：

- 统一 LLM 出口：Ollama / LM Studio / llama.cpp 等 OpenAI 兼容服务
- 统一生图 / 生视频出口：OMEN 主机上的 ComfyUI（模板化工作流）
- 串行任务队列：16GB 显存一次只跑一个任务，避免 OOM
- 产物落盘与静态回传：生成结果落在服务本地，前端按 URL 取用
- 五段式流水线编排：小说 → 剧本 → 分镜 → 服化道 → 关键帧 → 片段合成

零运行时依赖，只用 Node 内置模块（`node >= 20`）。不引入构建步骤：

```bash
cd canvas-server
node src/index.js            # 默认 127.0.0.1:8788
```

## 配置

复制 `config.example.json` 为 `config.json` 后修改；所有字段都可用环境变量覆盖（`CANVAS_SERVER_*`）。
配置文件路径可用 `CANVAS_SERVER_CONFIG` 指定。

> **模型选型提醒**：`llm.defaultModel` 必须是目标主机真能装下的模型。实测 ubuntu 主机的 Quadro RTX 5000 只有 16GB 显存，且与其它服务共享，27B 级模型加载需要约 15GB、会被 Ollama 判定超出可用显存后反复驱逐甚至连接中断。默认值因此放在 7B 档（`qwen2.5:latest`）。要跑大模型请换到显存更宽裕的主机，或把 `llm.baseUrl` 指向那台机器。
>
> LLM 与 ComfyUI 分属两台机器（ubuntu 的 Quadro RTX 5000 与 OMEN 的 RTX 5060 Ti），互不争抢显存，这是有意的部署方式。

## 接口契约（冻结）

所有响应均为 JSON（产物文件接口除外）。错误统一为 `{ "error": { "message": string, "code"?: string } }`，HTTP 状态码非 2xx。

### 健康与能力

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, llm: {ok, baseUrl, error?}, comfy: {ok, baseUrl, error?}, runninghub: {ok, baseUrl, error?}, queue: {running, pending} }` |
| GET | `/api/backends` | `{ backends: BackendInfo[], defaultBackend, allowRunningHub }` |
| GET | `/api/providers` | `{ llm: { models: string[] }, comfy: { templates: TemplateInfo[], models: {...} }, backends: BackendInfo[] }` |
| GET | `/api/runninghub/models` | `{ image: RunningHubModel[], video: RunningHubModel[] }`，本地内置目录，不请求上游 |
| GET | `/api/skills` | `{ skills: SkillInfo[] }` |

`TemplateInfo` = `{ name, family: "image"｜"video"｜"upscale"｜"edit", title, tokens: string[] }`
`BackendInfo` = `{ id: "local"｜"runninghub", label, available: boolean, baseUrl, default: boolean, reason?: string }`
`RunningHubModel` = `{ id, name, endpoint, outputType, priceLabel?, description? }`

### 生成后端（本地优先）

**生图、生视频默认且必须走本地 ComfyUI**（`backends[0].id === "local"`，`defaultBackend` 默认 `"local"`）。
RunningHub 是**保留的可选云端后端**：未配置 `runninghub.apiKey` 时它在 `/api/backends` 里显示为不可用，
且完全不影响本地链路；只有请求里显式传 `backend: "runninghub"` 才会走云端。

`config.generation.allowRunningHub` 置为 `false` 可整体关闭云端后端（此时即使传 `backend` 也会被拒绝）。

### LLM 透传（OpenAI 兼容）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| ANY | `/v1/*` | 原样转发到 `config.llm.baseUrl`，保留流式响应（SSE 逐块透传）。前端把渠道 baseUrl 填 `http://<host>:8788` 即可。 |
| GET | `/api/llm/models` | 便捷别名，等价于 `GET /v1/models` 并规整为 `{ models: string[] }` |

### 生成任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/generate/image` | body `{ template, params, name?, backend? }` → `201 { job }` |
| POST | `/api/generate/video` | 同上，语义分类不同 |
| POST | `/api/uploads` | multipart 上传参考图/视频 → `201 { name, comfyName }` |
| GET | `/api/jobs` | `?status=&limit=` → `{ jobs: Job[] }` |
| GET | `/api/jobs/:id` | → `{ job: Job }` |
| POST | `/api/jobs/:id/cancel` | → `{ job: Job }` |
| GET | `/api/artifacts/<jobId>/<filename>` | 产物文件字节流（带正确 content-type） |

- `backend: "local"`（默认）：`template` 是 `canvas-server/workflows/` 下的工作流模板名。
- `backend: "runninghub"`：`params.endpoint` 是 RunningHub 模型端点（如 `z-image/turbo`），`params.prompt` 等按该模型 schema 透传；本地素材会先上传再替换为 `download_url`。

`Job` = `{ id, kind: "image"｜"video"｜"upscale"｜"edit", backend: "local"｜"runninghub", template, name, params, status: "queued"｜"running"｜"done"｜"error"｜"canceled", promptId?, progress?: { value, max, node? }, outputs: Artifact[], error?, createdAt, startedAt?, finishedAt? }`
`Artifact` = `{ filename, url, type: "image"｜"video"｜"audio"｜"file", width?, height?, bytes? }`

### 流水线（五段式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pipeline/stages` | `{ stages: StageInfo[] }`，来自 `skills/registry.json` |
| POST | `/api/pipeline/runs` | body `{ novel, title?, options? }` → `201 { run }` |
| GET | `/api/pipeline/runs` | → `{ runs: Run[] }` |
| GET | `/api/pipeline/runs/:id` | → `{ run: Run }` |
| POST | `/api/pipeline/runs/:id/steps/:stage/run` | 运行单步 → `{ run }` |
| POST | `/api/pipeline/runs/:id/steps/:stage/input` | 人工修订该步产物 → `{ run }` |

`Run` = `{ id, title, novel, createdAt, updatedAt, stages: { [stageId]: { id, title, status, inputs, output, artifacts, error?, startedAt?, finishedAt? } } }`

阶段 id 固定为：`script`（小说→剧本）、`storyboard`（分镜拆解）、`design`（服化道）、`keyframe`（关键帧）、`assembly`（片段合成拼接）。

### 生成产物与前端的关系

前端通过 `GET /api/jobs/:id` 轮询任务，`status === "done"` 后取 `outputs[].url`，URL 直接指向 `GET /api/artifacts/...`，可被 `<img>` / `<video>` 直接消费。

## 模块接口（内部）

| 文件 | 导出 | 契约 |
| --- | --- | --- |
| `src/config.js` | `loadConfig()`, `config` | 返回规整后的配置对象，见 `config.example.json` |
| `src/http.js` | `createRouter()`, `readJson(req)`, `sendJson(res, status, body)`, `sendError(res, status, message)`, `applyCors(res)`, `readBody(req)`, `serveFile(req, res, filePath)` | 路由表 `router.add(method, pattern, handler)`，`pattern` 支持 `:param` |
| `src/jobs.js` | `createJobQueue()`, `jobs`（单例 store） | 队列 API：`enqueue(job, runner)`、`get(id)`、`list(filter)`、`cancel(id)`、`update(id, patch)`；`runner(job, ctx)` 返回 `{ outputs }` |
| `src/files.js` | `artifactsDir`, `ensureDir`, `saveBuffer`, `artifactUrl`, `guessContentType`, `safeJoin` | 产物落盘与路径安全 |
| `src/providers/llm.js` | `createLlmProvider(config)`, `probeLlm(config)`, `listLlmModels(config)`, `forwardToLlm(req, res, config, pathWithQuery)` | 见下 |
| `src/providers/comfy.js` | `createComfyClient(config)`, `probeComfy(config)`, `listComfyCapabilities(config)`, `listTemplates(workflowsDir)` | 见下 |
| `src/skills.js` | `loadSkills(skillsDir)`, `loadRegistry(skillsDir)`, `readSkill(skillsDir, id)` | 见下 |
| `src/pipeline.js` | `createPipeline({ config, skillsDir, jobs, comfy, llm })` | 见下 |

### `src/providers/comfy.js`

```js
// 返回客户端对象
createComfyClient(config) => {
  probe(): Promise<{ ok, baseUrl, version?, devices?, error? }>,
  objectInfo(node?): Promise<any>,
  systemStats(): Promise<any>,
  queueCounts(): Promise<{ running, pending }>,
  uploadFile(buffer, filename, type): Promise<string>,   // 返回 ComfyUI 侧引用名
  queuePrompt(graph, clientId?): Promise<string>,        // 返回 prompt_id
  history(promptId): Promise<object|null>,               // 未完成返回 null
  view({ filename, subfolder, type }): Promise<Buffer>,  // 取产物字节
  interrupt(): Promise<void>,
}
```

模板渲染契约（与现有 Python 执行器保持一致）：

```js
renderTemplate(templatePath, params) => graph   // {{TOKEN}} 全量替换；纯数字字符串转 number
extractTokens(templatePath) => string[]
disableEmptyLoras(graph) => string[]            // 摘除 lora_name 为空的 LoraLoaderModelOnly 节点，返回被摘节点 id
```

- 缺少必需 token 时抛错，错误信息包含缺失 token 名。
- 替换值必须做 JSON 字符串转义，避免换行/引号破坏 JSON。
- token 命名沿用现有模板：`PROMPT` `LORA_FILE` `LORA_STRENGTH` `WIDTH` `HEIGHT` `BATCH` `SEED` `OUTPUT_PREFIX` `INPUT_IMAGE` `REF_VIDEO` `REF_FRAME_CAP` `LENGTH` `FRAME_RATE` `TTS_TEXT` `TTS_SPEAKER` `TTS_VOICE_DESIGN` `REALISM_STRENGTH` `STEPS` `NEGATIVE_PROMPT` `PERSON_IMAGE` `CLOTHING_IMAGE`。
- 数值 token 集合：`SEED WIDTH HEIGHT BATCH LENGTH REF_FRAME_CAP STEPS FRAME_RATE LORA_STRENGTH REALISM_STRENGTH`。

**LoRA 可选化**：部分模板把 LoRA 参数化成 `{{LORA_FILE}}`，但通用调用方并不知道该填哪个 lora 文件名。网关的行为是：调用方没传 `LORA_FILE` 时补空串，渲染后由 `disableEmptyLoras` 把 `LoraLoaderModelOnly` 节点摘除并把下游重连到其上游，因此**调用方永远不需要感知 LoRA**；想固定形象时才显式传 `LORA_FILE` / `LORA_STRENGTH`。`LoraLoader`（双输出）无法安全摘除，缺 `lora_name` 时直接抛中文错误。

### `src/providers/llm.js`

```js
probeLlm(config) => Promise<{ ok, baseUrl, models?, error? }>
listLlmModels(config) => Promise<string[]>
forwardToLlm(incomingReq, outgoingRes, config, pathWithQuery) => Promise<void>  // 含 SSE 流式透传
```

### `src/skills.js`

```js
loadRegistry(skillsDir) => { stages: [{ id, title, skill, requires: string[], produces: string[] }] }
loadSkills(skillsDir) => [{ id, name, description, path }]   // 扫描 skills/*/SKILL.md 的 YAML 头
readSkill(skillsDir, id) => string                            // SKILL.md 全文
```

### `src/pipeline.js`

```js
createPipeline({ config, skillsDir, jobs, comfy, llm }) => {
  stages(): StageInfo[],
  list(): Run[],
  get(id): Run | null,
  create({ novel, title, options }): Run,
  runStage(runId, stageId): Promise<Run>,
  setStageInput(runId, stageId, patch): Run,
}
```

每个阶段由 `skills/<skill>/SKILL.md` 定义提示词与输出 JSON 契约；阶段间产物以 JSON 传递，落盘在 `data/runs/<runId>/<stage>.json`。

## 与上游项目约定

本目录是无限画布的增强部分，遵循根目录 `AGENTS.md` 的写法约定，并在此显式记录一处有意偏离：
上游约定「外部服务请求统一放在 `web/src/services/api/`，由浏览器前端直连，不假设存在项目后端」。
本增强引入 `canvas-server` 作为**本地网关后端**，原因是浏览器直连无法解决 CORS、长任务轮询、密钥落盘与跨机访问；前端仍然通过 `web/src/services/api/` 发起请求，只是目标改为网关。

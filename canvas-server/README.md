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

运行时数据都在 `config.dataDir`（默认 `data/`）：`jobs.json`（任务队列持久化）、
`runs/<runId>/run.json`（运行状态与产物指针，**内嵌整本小说，长篇可达数 MB**）、
`runs/<runId>/<stage>.json`（阶段产物）、`runs/<runId>/progress.json`（轻量进度，轮询用）、
`runs/<runId>/chunks/<i>.json`（分块 map 结果，断点续跑用）、
`uploads/`（上传素材）、`artifacts/`（生成产物）、`llm-providers.json`（外部 LLM 渠道注册表，权限 `0600`）。

> ⚠️ **外部 LLM 渠道注册表只认 `data/llm-providers.json`**。`index.js` 启动时无条件执行
> `config.llm.providers = readLlmProviders()`，文件缺失或损坏时按空数组处理——因此**在 `config.json` 里写 `llm.providers` 会被启动时覆盖掉**，
> 要注册渠道请走 `POST /api/llm/providers`（或直接写那个文件后重启）。

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
| GET | `/api/llm/providers` | `{ providers: [{ name, baseUrl, hasKey }] }`，**脱敏**：只报有没有 Key，绝不回吐 SK |
| POST | `/api/llm/providers` | body `{ providers: [{ name, baseUrl, apiKey? }] }` **全量替换**注册表 → `{ providers }`（同上脱敏） |

**外部 LLM 渠道注册表**：让本地模型与远程 API 对调用方完全同构，页面只需连一个端口。

- 注册表独立存 `data/llm-providers.json`（不写进 `config.json`），启动时并入 `config.llm.providers`，`POST` 后**热更新**、无需重启。
- 校验：`name` 非空且不得含 `::`；`baseUrl` 必须是 `http(s)` 地址，尾部斜杠会被去掉。不合法直接 400。
- `GET /api/llm/models` 会把外部渠道的模型以 **`渠道名::模型名`** 命名空间追加进列表（如 `deepseek::deepseek-v4-pro`）；本地上游一个都连不上但注册表非空时，不再抛「LLM 服务不可达」。
- `chat()` 按 `::` 前缀路由到对应渠道；也可传 `options.provider = { baseUrl, apiKey }` **临时**指定渠道（仅本次调用生效，**绝不落盘**，流水线用它透传浏览器侧渠道）。
- `/v1/*` 透传**不走**注册表，仍固定打 `config.llm.baseUrl` / `fallbacks`。

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

### 资产总览（跨项目聚合）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/asset-refs` | 只读聚合全部活动项目的 `AssetRef`，供顶部「我的资产」页跨项目筛选/预览/跳转 |

响应：`{ assetRefs: AssetRefView[], counts: { total, byRole: { [role]: number }, byProject: [{ projectId, projectTitle, count }] }, warnings: string[] }`

`AssetRefView` = `{ id, projectId, projectTitle, role, kind, name, url, artifactCount, bindingId, episodeId, sceneId, shotId, stageId, createdAt, updatedAt }`

- **已解析字段**：`role` 取引用自身；`kind`/`stageId` 取 `metadata`；`name` 优先 `metadata.name`、回落 `bindingId`；
  `url` 按 **`selectedArtifactId` → `metadata.artifactUrl` → `artifactIds[0]` → 空串** 回落，前端可直接喂 `<img>` / `<video>`。
- **排序**：按项目成段（项目按 `updatedAt` 新→旧），组内按 `id` 的 ULID 时序新→旧（引用自身无时间字段时用它兜底）。
- **计数**：`byRole` 只列数据里真实出现过的 role（筛选项据此生成，不在前端硬编码名单）；`byProject` 只含有资产的项目。
- **容错**：某个 `project.json` 缺失/损坏、`assetRefs` 非数组、单条引用损坏时**跳过并在 `warnings[]` 记录**，接口不 500。

### 流水线（五段式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pipeline/stages` | `{ stages: StageInfo[] }`，来自 `skills/registry.json` |
| POST | `/api/pipeline/runs` | body `{ novel, title?, options? }` → `201 { run }`，`run.estimate` 已算好 |
| GET | `/api/pipeline/runs` | → `{ runs: Run[] }` |
| GET | `/api/pipeline/runs/:id` | → `{ run: Run }`。**响应内嵌整本小说，222 万字的书有 6.4MB，不要拿它轮询进度** |
| GET | `/api/pipeline/runs/:id/progress` | → `{ progress: Progress \| null, inflight }`。轻量（几十字节），**轮询进度只用这个** |
| POST | `/api/pipeline/runs/:id/steps/:stage/run` | 运行单步，body 可选 `{ model?, provider?, resume? }` → **`202 { run, inflight }`** |
| POST | `/api/pipeline/runs/:id/steps/:stage/cancel` | 取消正在执行的阶段 → `{ canceled, stage, ranMs }`；没有在执行的任务返回 **409** |
| POST | `/api/pipeline/runs/:id/steps/:stage/input` | 人工修订该步产物 → `{ run }` |

`Run` = `{ id, title, novel, createdAt, updatedAt, estimate?, options?, stages: { [stageId]: { id, title, status, inputs, output, artifacts, error?, chunked?, startedAt?, finishedAt? } } }`

`Estimate` = `{ novelChars, promptChars, maxChunkChars, chunked, chunks, llmCalls, perChunkSeconds, estSeconds, resumableChunks }`
—— 创建 run 时算好，让调用方在**开跑之前**就知道代价。`promptChars` 是**填充后**的 prompt 长度（含 SKILL.md 模板），
与 `composeWithLlm` 的分块判定同口径，不是小说字数。`perChunkSeconds` 取 `config.pipeline.estSecondsPerChunk`（默认 **31**，
实测 222 万字 / 163 块 / 83 分钟 ≈ 30.5s/块）。

`Progress` = `{ runId, stage, phase: "map"\|"reduce"\|"single"\|"done"\|"failed", done?, total?, label?, reused?, resumed?, avgMsPerChunk?, etaMs?, error?, startedAt?, finishedAt?, updatedAt? }`

阶段 id 固定为：`script`（小说→剧本）、`storyboard`（分镜拆解）、`design`（服化道）、`keyframe`（关键帧）、`assembly`（片段合成拼接）。

**运行是异步的**：`POST .../run` **立刻返回 202**，返回的 `run` 里该阶段是 `running`，工作在后台跑。
不要指望这个请求解析时阶段已完成 —— 一个 163 块 / 83 分钟的阶段用一个阻塞式 POST 扛，隧道、反向代理、
浏览器都会在几分钟内掐断连接，前端 `await` 抛错后按钮复位、页面「毫无反应」，而后端仍在继续跑并消耗 LLM 额度。
终态靠轮询 `progress` 到 `phase: "done" | "failed"`，再 `GET /api/pipeline/runs/:id` 取产物。
同一阶段正在跑时再次 `POST .../run` 会 **400**（`阶段「X」正在运行中`）。

**按阶段绑定模型**：`body.model` 会持久化到 `run.options.stageModels[stageId]`，重跑沿用。模型解析优先级是
`options.stageModels[stageId]` → `options.llmModel` → `config.pipeline.llmModel` → 网关默认。
`body.provider = { baseUrl, apiKey }` 是浏览器侧渠道的**临时透传**：只校验形状（`baseUrl` 必须是 http(s)），
仅本次调用生效，**绝不写入 `run` 或 `options`**。

**取消**：`POST .../cancel` abort 后由 `executeStage` 的 catch 落终态（`status: "error"` + `已取消…`），
所以 cancel **不回传 `run`** —— 那一刻 run 还没写完，回传会是过期的 `running` 态。信号贯通
`index.js` → `runStage/executeStage` → `composeWithLlm` → `composeScriptChunked` → `askJson` → `pipeline.chat` → `llm.chat(options.signal)`；
`llm.chat` 里外部 signal 与内部超时共用一个 `AbortController`，且**取消不会被当成连接失败去试下一个 fallback**。

**超长小说分块改编（仅 `script` 阶段）**：填入小说后的完整 prompt 超过 `config.pipeline.maxNovelChunkChars`
（默认 **16000** 字符）时自动走 map-reduce——`splitNovelIntoChunks` 切块 → 逐块提取局部 `characters`/`scenes` →
再把全部局部结果合并成一份完整剧本。`stage.output` 与单次调用**完全同构**，分块信息记在
`stage.chunked = { chunks, labels, mergeModel, reused }`；未超阈值时维持单次调用且 `chunked` 为 `undefined`。
每次 LLM 调用（含 map、reduce 与 JSON 重试）都沿用该阶段绑定的模型与 provider。

**断点续跑**：每块的 map 结果单独落盘到 `data/runs/<id>/chunks/<index>.json`，进度写在 `data/runs/<id>/progress.json`。
两者都**不写进 `run.json`** —— 那个文件内嵌整本小说，逐块 `saveRun` 会产生上百次数 MB 的全量重写。
`body.resume: true` 时复用已落盘的块、只补跑缺的（`stage.chunked.reused` 报告复用了几块）；
缺省 `false` 会**清空 `chunks/`**，避免小说改过之后复用陈旧块。

**启动收敛**：进程被杀时正在跑的阶段会永远停在 `running`，而 `beginStage` 拒绝在 `running` 阶段上重跑，
不收敛就会把那个阶段永久锁死。所以启动时 `reconcileRunning()` 把所有遗留 `running` 落成
`status: "error"` + `服务重启导致中断；已完成的分块结果已保留，可用 resume 续跑`，并打一条告警。

### 生成产物与前端的关系

前端通过 `GET /api/jobs/:id` 轮询任务，`status === "done"` 后取 `outputs[].url`，URL 直接指向 `GET /api/artifacts/...`，可被 `<img>` / `<video>` 直接消费。

## 模块接口（内部）

| 文件 | 导出 | 契约 |
| --- | --- | --- |
| `src/config.js` | `loadConfig()`, `config` | 返回规整后的配置对象，见 `config.example.json` |
| `src/http.js` | `createRouter()`, `readJson(req)`, `sendJson(res, status, body)`, `sendError(res, status, message)`, `applyCors(res)`, `readBody(req)`, `serveFile(req, res, filePath)` | 路由表 `router.add(method, pattern, handler)`，`pattern` 支持 `:param` |
| `src/jobs.js` | `createJobQueue()`, `jobs`（单例 store） | 队列 API：`enqueue(job, runner)`、`get(id)`、`list(filter)`、`cancel(id)`、`update(id, patch)`；`runner(job, ctx)` 返回 `{ outputs }` |
| `src/files.js` | `artifactsDir`, `ensureDir`, `saveBuffer`, `artifactUrl`, `guessContentType`, `safeJoin` | 产物落盘与路径安全 |
| `src/generate.js` | `createLocalRunner({ config, comfy, jobs })`, `ASSET_TOKENS` | 本地 ComfyUI 执行器：素材解析 → 尺寸吸附 → 模板渲染 → 提交 → 轮询 → 回收产物 |
| `src/chunk-novel.js` | `splitNovelIntoChunks(text, maxChunkChars)` | 纯函数长文切块，见下 |
| `src/providers/llm.js` | `createLlmProvider(config)`, `probeLlm(config)`, `listLlmModels(config)`, `forwardToLlm(req, res, config, pathWithQuery)`, `chat(config, options)`, `externalProviders(config)` | 见下 |
| `src/providers/comfy.js` | `createComfyClient(config)`, `probeComfy(config)`, `listComfyCapabilities(config)`, `listTemplates(workflowsDir)` | 见下 |
| `src/skills.js` | `loadSkills(skillsDir)`, `loadRegistry(skillsDir)`, `readSkill(skillsDir, id)` | 见下 |
| `src/pipeline.js` | `createPipeline({ config, skillsDir, jobs, comfy, llm, runJob })` | 见下 |

### `src/chunk-novel.js`

```js
splitNovelIntoChunks(text, maxChunkChars = 16000) => [{ index, label, text }]
```

切块优先级：**【文件名】分节标记** → **中文章节标题**（`第N章/节/回/卷/部`）→ **定长窗口**（在窗口内最后一个段落边界截断，其次换行，再硬切）。
单节仍超阈值时按窗口二次切，`label` 带 `（i/N）` 序号；相邻小节在阈值内会被贪心合并进同一块，`label` 用「、」连接。
原文短于阈值时原样返回单块（`label` 为空串），空文本返回 `[]`。每块都保留来源标记便于追溯，`text.length` 恒不超过 `maxChunkChars`。

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
disableEmptyImageRefs(graph) => string[]        // 摘除 image 为空的 LoadImage 节点，并删掉引用它的输入键
```

- 缺少必需 token 时抛错，错误信息包含缺失 token 名。**空串 `""` 不算缺失**，可选 token 就是靠这一点实现（见下）。
- 替换值必须做 JSON 字符串转义，避免换行/引号破坏 JSON。
- token 命名沿用现有模板：`PROMPT` `LORA_FILE` `LORA_STRENGTH` `WIDTH` `HEIGHT` `BATCH` `SEED` `OUTPUT_PREFIX` `INPUT_IMAGE` `REF_VIDEO` `REF_FRAME_CAP` `LENGTH` `TTS_TEXT` `TTS_SPEAKER` `TTS_VOICE_DESIGN` `REALISM_STRENGTH` `STEPS` `NEGATIVE_PROMPT` `PERSON_IMAGE` `CLOTHING_IMAGE` `REF_IMAGE_1`…`REF_IMAGE_9`。
  （`FRAME_RATE` **不是**任何现有模板的 token：H3 的帧数走 `LENGTH`，且必须落在 **17n+5** 网格上——5s≈124 帧、2.3s≈56 帧，不要直接把「秒数 × fps」喂进去。）
- 数值化不靠白名单：`toNumberTree` 把**任意** dict 直接字符串值里的纯数字还原成 `number`（与 Python 执行器 `run_pipeline.py` 的 `fixnum` 同语义）。**数组内的字符串一律不转**，否则节点引用 `["10", 0]` 会变成数字、ComfyUI 校验抛 `KeyError: prompt_outputs_failed_validation`（坑 #1，有回归测试锁住）。

**素材 token（`ASSET_TOKENS`）**：`INPUT_IMAGE` `REF_VIDEO` `PERSON_IMAGE` `CLOTHING_IMAGE` `REF_IMAGE_1`…`REF_IMAGE_9`。
`createLocalRunner` 在渲染前对这些 token 调 `resolveAsset`，因此调用方可以传本机路径、`/api/artifacts/...` 相对路径、`http(s)` 远端 URL 或上游产物路径，网关统一换成 ComfyUI 侧的引用名。空值跳过。

**H3 尺寸吸附**：H3 的 conditioning 节点硬性要求宽高可被 **32** 整除（否则 `ValueError` → `execution_error`）。
`createLocalRunner` 对 `template` 以 `video_` 开头的任务，在渲染前把 `WIDTH`/`HEIGHT` 吸附到最近的 32 倍数（下限 32，720→736）并打日志。
调用方仍应尽量传标准尺寸（480×864、768×1344），吸附只是兜底。

**LoRA 可选化**：部分模板把 LoRA 参数化成 `{{LORA_FILE}}`，但通用调用方并不知道该填哪个 lora 文件名。网关的行为是：调用方没传 `LORA_FILE` 时补空串，渲染后由 `disableEmptyLoras` 把 `LoraLoaderModelOnly` 节点摘除并把下游重连到其上游，因此**调用方永远不需要感知 LoRA**；想固定形象时才显式传 `LORA_FILE` / `LORA_STRENGTH`。`LoraLoader`（双输出）无法安全摘除，缺 `lora_name` 时直接抛中文错误。

**参考图槽位可选化**：`REF_IMAGE_1`…`REF_IMAGE_9` 是「额外参考图」槽位，与 LoRA 同一套机制——调用方没传时补空串，渲染后由 `disableEmptyImageRefs` 摘掉对应的 `LoadImage` 节点**并删掉引用它的输入键**（不需要重连下游，这是与 LoRA 的区别）。这样**一个模板就能服务 1~10 张参考图**，不必为每种数量各做一个模板。
`img_qwen21_edit` 是第一个用例：`INPUT_IMAGE` 固定映射到 `images.image_1`（**编辑目标**），`REF_IMAGE_N` 映射到 `images.image_{N+1}`（参考图），提示词里用 `<image1>`、`<image2>`… 指代。前端按 token 出现顺序把上传的图片**按位**填进图槽，因此模板里 `{{INPUT_IMAGE}}` 必须写在所有 `{{REF_IMAGE_N}}` 之前（有回归测试锁住这个顺序）。

### `src/providers/llm.js`

```js
probeLlm(config) => Promise<{ ok, baseUrl, models?, error? }>
listLlmModels(config) => Promise<string[]>   // 含外部渠道的「渠道名::模型名」
forwardToLlm(incomingReq, outgoingRes, config, pathWithQuery) => Promise<void>  // 含 SSE 流式透传
externalProviders(config) => [{ name, baseUrl, apiKey }]   // 规整 config.llm.providers，丢弃 name/baseUrl 缺失项
chat(config, { messages, model?, temperature?, provider?, ...rest }) => Promise<OpenAIChatCompletion>
```

`chat` 固定非流式（要流式走 `forwardToLlm`）。渠道路由优先级：`options.provider.baseUrl`（临时，不落盘）→ `model` 里的 `渠道名::` 前缀（查注册表，未注册直接抛中文错误）→ `config.llm.baseUrl` / `fallbacks`。`model` 为空时兜底到 `config.llm.defaultModel`，仍为空则抛错。**连接层失败**会带上 `cause.code`（如 `ECONNREFUSED`）便于排查；**HTTP 非 2xx 不重试**，直接把状态码与前 300 字响应体带进错误信息。

**探测超时与 `timeoutMs` 分开**：`timeoutMs`（默认 600000）是给长思考 `chat` 与 `/v1/*` 透传的，**绝不能**用于列模型探测。`listLlmModels` 一律用 `probeTimeoutMs`（默认 **8000**）。原因：`/api/health` 与 `/api/llm/models` 要探测每个外部渠道，而 `getJson` 失败只返回 `null` 不抛错，所以一个「TCP 连上但不回包」的死链会一直耗到超时——串行 + 600s 时单个死渠道能挂住接口 20 分钟，前端模型下拉直接卡死。
因此外部渠道是**并行**探测的（`Promise.all`），`modelsAt` 内部的 `/v1/models` 与 `/api/tags` 也是并行的：总耗时 ≈ 最慢的一个渠道，不随渠道数累加。返回空模型的渠道会打一条 `[llm] 外部渠道「X」(url) 在 Ns 内未返回模型，本次跳过` 告警，**只丢它自己的模型**，不影响本机与其它渠道。

### `src/skills.js`

```js
loadRegistry(skillsDir) => { stages: [{ id, title, skill, requires: string[], produces: string[] }] }
loadSkills(skillsDir) => [{ id, name, description, path }]   // 扫描 skills/*/SKILL.md 的 YAML 头
readSkill(skillsDir, id) => string                            // SKILL.md 全文
```

### `src/pipeline.js`

```js
createPipeline({ config, skillsDir, jobs, comfy, llm, runJob }) => {
  stages(): StageInfo[],
  list(): Run[],
  get(id): Run | null,
  create({ novel, title, options }): Run,               // run.estimate 在创建时算好
  estimate(run): Estimate,                              // 单独重算预估（口径与分块判定一致）
  beginStage(runId, stageId, runOptions?): Begun,       // 同步：校验依赖、绑定模型、标记 running 并落盘
  executeStage(begun, runOptions?): Promise<Run>,       // 异步：真正跑 LLM 与入队，落终态与进度
  runStage(runId, stageId, runOptions?): Promise<Run>,  // = executeStage(beginStage(...))，同步等完（测试用）
  stageProgress(runId): Progress | null,                // 只读 progress.json，不碰数 MB 的 run.json
  reconcileRunning(): string[],                         // 启动收敛遗留 running 阶段，返回被收敛的 runId
  setStageInput(runId, stageId, patch): Run,
}
// runOptions = { model?, provider?, signal?, resume? }
```

HTTP 路由走 `beginStage` + 不 await 的 `executeStage`（立刻 202）；`runStage` 保留给测试与内部同步调用。
`beginStage` 与 `executeStage` 拆开是这套异步语义的前提 —— 校验必须在响应前同步完成（不合法要能返回 400），
执行必须在响应后继续（否则长任务会把连接拖断）。

每个阶段由 `skills/<skill>/SKILL.md` 定义提示词与输出 JSON 契约；阶段间产物以 JSON 传递，落盘在 `data/runs/<runId>/<stage>.json`。

文本型阶段统一走 `askJson`：要求严格 JSON → 解析失败带原文重试一次（`temperature: 0`）→ 再失败抛错并把模型原文挂在 `error.raw`（`runStage` 会截前 4000 字写进 `stage.error`，同时把 `stage.output` 置 `null`）。
生成型阶段（`keyframe` / `assembly`）由编排器**回填** `template` / `jobId` / `artifactUrl` / `status`，**不采信模型编造的这些字段**；尺寸等默认值来自 `config.pipeline.image*` / `video*`，模板要求的全部 token 必须覆盖到（有契约回归测试用真实模板锁住）。

## 部署与远程调试

远程环境是 ubuntu 主机，部署目录 **`/sobey/canvas-plus`**，由 systemd 单元 `canvas-server.service` 拉起（`WorkingDirectory=/sobey/canvas-plus/canvas-server`，日志在 `/var/log/canvas-server.log`）。

两条部署路径，按需要选：

| 脚本 | 机制 | 适用 |
| --- | --- | --- |
| `scripts/deploy.sh` | git 推送裸仓库 → 远程 pull → 构建 → 测试 → 重启 | 正式发布，要求工作区干净 |
| `scripts/sync-remote.sh` | rsync 直接同步工作区 → 构建 → 重启 | **远程直接部署和调试**，可带未提交改动 |

```bash
./scripts/sync-remote.sh                # 同步 + 构建前端 + 重启 + 健康检查
./scripts/sync-remote.sh --no-build     # 只改后端时用，快很多
./scripts/sync-remote.sh --no-restart   # 只同步，不动服务
```

同步会排除 `node_modules`、`dist`、`data`、`config.json`，因此远程的依赖、构建产物、生成记录与配置不会被本地覆盖。

远程特有的配置项（`canvas-server/config.json`，不入库）已按环境写死为：LLM 指向本机 `127.0.0.1:11434`，ComfyUI 指向 GPU 主机 `192.168.123.147:8188`。**ComfyUI 与 LLM 分属两台机器**，互不争抢显存。

从本机浏览器访问远程网关：

```bash
ssh -f -N -L 8788:127.0.0.1:8788 ubuntu   # 然后打开 http://127.0.0.1:8788
```

排查顺序：`systemctl status canvas-server` → `tail -50 /var/log/canvas-server.log` → `curl -s http://127.0.0.1:8788/api/backends` → `curl -s http://127.0.0.1:8788/api/health`。

## 与上游项目约定

本目录是无限画布的增强部分，遵循根目录 `AGENTS.md` 的写法约定，并在此显式记录一处有意偏离：
上游约定「外部服务请求统一放在 `web/src/services/api/`，由浏览器前端直连，不假设存在项目后端」。
本增强引入 `canvas-server` 作为**本地网关后端**，原因是浏览器直连无法解决 CORS、长任务轮询、密钥落盘与跨机访问；前端仍然通过 `web/src/services/api/` 发起请求，只是目标改为网关。

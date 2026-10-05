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
| GET | `/api/health` | `{ ok, service: {ok, name, version, uptimeSec}, llm: {ok, baseUrl, source:"registry", probed:false, models: string[], error?}, comfy: {ok, baseUrl, error?}, runninghub: {ok, baseUrl, error?}, queue: {running, pending} }`。**`ok` 是存活语义**（本进程能应答即 true），不代表生产就绪；`llm` 段是注册表静态事实（`probed:false`，`ok` 只表示「已登记启用的文本模型」），`comfy`/`runninghub` 是**后台探测的缓存快照**（#68）：首次未就绪给 `{ ok:false, …, pending:true }`（字段名 `ok`/`baseUrl`/`devices`（comfy）/`error` 不变，前端无需改动），就绪后按 30s TTL 复用、过期后台刷新，单次探测硬超时 3s |
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
| GET | `/api/llm/models` | `{ models: string[] }`，与 `GET /v1/models` 同源：**只读模型注册表**（不探测上游） |
| GET | `/api/llm/providers` | `{ providers: [{ name, baseUrl, hasKey, models }] }`，**脱敏**：只报有没有 Key，绝不回吐 SK |
| POST | `/api/llm/providers` | body `{ providers: [{ name, baseUrl, apiKey?, models? }] }` 按 `name` **增量 upsert**（不在请求里的渠道原样保留，`apiKey`/`models` 缺省沿用原值）→ `{ providers }`（同上脱敏）。写完自动 sync 模型注册表 |

**外部 LLM 渠道注册表**：让本地模型与远程 API 对调用方完全同构，页面只需连一个端口。

- 注册表独立存 `data/llm-providers.json`（不写进 `config.json`），启动时并入 `config.llm.providers`，`POST` 后**热更新**、无需重启。
- 校验：`name` 非空且不得含 `::`；`baseUrl` 必须是 `http(s)` 地址，尾部斜杠会被去掉。不合法直接 400。
- 模型清单**不探测上游**：`GET /v1/models` / `/api/llm/models` 把渠道**声明**的 `models[]` 展开成 **`渠道名::模型名`**（如 `deepseek::deepseek-v4-pro`）；未声明模型的渠道一个 id 也不产出，因此死渠道既不进下拉也拖不住接口。
- `chat()` 按 `::` 前缀路由到对应渠道；也可传 `options.provider = { baseUrl, apiKey }` **临时**指定渠道（仅本次调用生效，**绝不落盘**，流水线用它透传浏览器侧渠道）。
- `/v1/*` 透传**不走**注册表，仍固定打 `config.llm.baseUrl` / `fallbacks`。

### 提示词编译（按所选模型标准）

产品硬约束：用户只关心剧情与分镜，**按模型标准写提示词是后端内部机制**。发起生成请求那一刻，后端必须把
「模型无关的内容事实」按所选模型的标准编译成该模型要的提示词，再发给模型接口（图片/视频一视同仁）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/prompt/compile` | 把内容事实按目标模型编译成提示词 → `200 { prompt, meta }` |

body：`{ template, family, shot, scene?, characters?, style?, slots?, overlays?, durationSec?, rewrite? }`

- `rewrite: true` 时走带官方改写器的 async 版：仅英文有官方依据的模型（Qwen-Image 2.1 / Krea2 / FLUX）经**语言适配 LLM（DeepSeek）**英文化；未传 `rewrite` 时保持同步编译。
- `meta` = `{ template, modelKey, language: 'zh'|'en', rewriterId: string|null, untranslated, applied: { structure, negative, textInImage }, llm: { model, finishReason, chars }|null, notes?: string[] }`。
- `meta.untranslated` / `meta.llm.finishReason` 等是**给排查与运维看的**元数据，**前端不得渲染到界面**（见 `AGENTS.md` 内容创作规范）。
- 语言适配 LLM 不可用 / 超时 / 输出被截断（`finish_reason=length`）时**只降级不阻塞**：同步结构照旧产出，PROMPT 带显式 `[untranslated]` 标记并在 `notes` 记录原因——**绝不假装配好了英文**。
- **画幅是生产事实，改写器不得猜测或覆盖**：`project.plan.ratio` 经 `style.ratio` 进编译输入，作为「不可改写事实」单独一行交给改写器；改写稿若把画幅写成反方向（`aspectRatioConflict()` 三条判定命中），**整稿弃用** → 回落同步结构稿 + 记 warning（`notes` / job meta），错误方向绝不进 PROMPT。不对英文稿做正则替换（改不干净会留下自相矛盾的提示词）。

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

### 模型注册表（服务端唯一模型清单）

模型清单由**服务端唯一持有**，前端只读；浏览器渠道退化为「连接与凭据」。存储 `data/model-registry.json`
（**服务端唯一写者**，临时文件 + rename 原子写；文件缺失/损坏 → 视为空表并记 warning，**不 500**）。
契约全文：`docs/content/docs/progress/model-registry-contract.md`（v1 冻结）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/model-registry` | `{ models: ModelEntry[], counts: { text, image, video, audio, total, enabled }, groups: Group[] }`。支持 `?category=image`、`?enabled=true` 过滤；`counts` 恒为**全部登记**的汇总（不随过滤变化），`groups` 按**过滤后的** `models` 聚合 | 
| POST | `/api/model-registry` | 新增登记。body `{ name, category, alias?, base?, task?, enabled?, provider?, source?, template?, channelId? }`；`name`+`category` 必填，**name 唯一，重复 409**；缺 `base`/`task` 时按 §2.5 默认表 / alias 拆分 / name 回落推 → `201 { model }` |
| PATCH | `/api/model-registry/:id` | 局部更新，接受 `alias` / `enabled` / `category` / `base` / `task`（**`name` 不可改**，改它返回 400）；**改 `base` 或 `task` 会重算 `alias = base + 空格 + task`**（显式同传的 `alias` 会被覆盖）→ `{ model }` |
| DELETE | `/api/model-registry/:id` | 删除**登记**（不动模板/渠道本身）→ `{ removed }`；不存在 404 |
| POST | `/api/model-registry/sync` | 从「服务端实际可用的模板 + LLM 渠道」同步 → `{ added, staled, kept, backfilled }`（`backfilled` = 本次补齐 base/task 的存量条数） |
| GET | `/api/model-registry/available` | 服务端发现的可用清单（未登记项也含）→ `{ available, registered, missing }`，供配置页显示「可补」差异 |

`ModelEntry` = `{ id: "mdl_<ULID>", name, base, task, alias, category: "text"｜"image"｜"video"｜"audio", enabled, runtime: "local"｜"cloud", provider, source: "template"｜"channel"｜"manual", template, channelId, channelName, script, meta, stale, createdAt, updatedAt }`

`Group` = `{ category, bases: [{ base, models: ModelEntry[] }] }`（`groups` 只含非空 category，按 `text→image→video→audio` 排序）

- **`base` + `task`（契约 §2.4/§2.5，分组键）**：`base` = 基座 / 模型名（分组键，同 base 归一组），
  `task` = 能力 / 用途名（组内那一行的标题）。`alias` 降级为「`base` + 空格 + `task`」的**组合视图**（由服务端计算维护）。
  默认 base/task 表（19 条）在 `src/model-registry.js` 的 `DEFAULT_BASE_TASK`，`DEFAULT_ALIASES` 由它派生（**单一事实源**）。
- **`groups` 聚合与排序（§2.4 规则 4/5）**：按 `category` 分栏后再按 `base` 分组；组间 base 顺序 = 默认表首次出现顺序、
  表外按 `base` 字典序；组内按默认表顺序、表外按 `name` 字典序。**base 只在组头出现一次**，组内每行只渲染 `task`，
  前端不必自己拆字符串或聚合（禁硬编码）。
- **`sync` 幂等回填存量**：老条目（只有 `alias`、缺 `base`/`task`）在 `sync` 时按「默认表命中 → alias 拆分 → `base=alias||name`」
  补齐，**只补字段，绝不改写已有的 `alias`/`enabled`**（所以未必等于新的组合视图，但分组键 `base`/`task` 一定正确）。
  已具备 `base`/`task` 的条目不动；`GET`/`GET :id` 读取时也会就地为缺失项推导（不落盘），保证前端在下次 `sync` 前即可正确分组。


- **分类映射（唯一事实源在服务端）**：LLM 渠道 → `text`；模板 `family=video` → `video`；
  `image｜edit｜upscale` → `image`；`family=audio` **或模板名以 `audio_` 开头** → `audio`
  （`providers/comfy.js` 的 `familyOf()` 会把 `audio_qwen3_tts` 判成 `edit`，故按名字前缀兜底，避免音频混进生图下拉）。
- **runtime 判定**：本地 ComfyUI 模板 / 本地 LLM（ollama、回环、私有网段、`.local`/`.internal`）→ `local`；
  LLM 云端渠道 / 云端 ComfyUI（RunningHub）→ `cloud`。UI 对 `cloud` 加 ☁️ 图标（别名文字里不得再写「云端」）。
- **sync 行为**：缺失的补登记（`enabled` 默认 `true`，`base`/`task`/`alias` 命中 §2.5 默认表则填，未命中按 alias 拆分 / name 回落）；
  已消失的置 `stale: true`（**不删**）；回归的清除 `stale`。**绝不覆盖用户改过的 `alias`/`enabled`**，并对存量条目
  **幂等补齐**缺失的 `base`/`task`（返回 `backfilled` 计数）。（`source=manual` 的手工登记项不参与 stale 判定）。重复调用幂等。
- **`script`**：模板类条目的请求脚本由服务端生成（等价前端 `buildGatewayTemplateScript`，前端不再自己拼脚本）；
  渠道类条目为空串。

### 流水线（五段式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pipeline/stages` | `{ stages: StageInfo[] }`，来自 `skills/registry.json` |
| POST | `/api/pipeline/runs` | body `{ novel, title?, options? }` → `201 { run }`，`run.estimate` 已算好 |
| GET | `/api/pipeline/runs` | → `{ runs: Run[] }` |
| GET | `/api/pipeline/runs/:id` | → `{ run: Run }`。**响应内嵌整本小说，222 万字的书有 6.4MB，不要拿它轮询进度** |
| GET | `/api/pipeline/runs/:id/progress` | → `{ progress: Progress \| null, inflight }`。轻量（几十字节），**轮询进度只用这个** |
| GET | `/api/pipeline/runs/:id/log` | → `{ log: LogEntry[] }`，追加式审计日志的尾部（`?limit=`，默认 200 / 上限 2000）；写的是 `runs/<id>/log.jsonl` |
| POST | `/api/pipeline/runs/:id/steps/:stage/run` | 运行单步，body 可选 `{ model?, provider?, resume?, actor? }` → **`202 { run, inflight }`** |
| POST | `/api/pipeline/runs/:id/steps/:stage/cancel` | 取消正在执行的阶段 → `{ canceled, stage, ranMs }`；没有在执行的任务返回 **409** |
| POST | `/api/pipeline/runs/:id/steps/:stage/input` | 人工修订该步产物，body `{ output, actor? }` → `{ run }`；产物未过契约校验返回 **400** |
| POST | `/api/pipeline/runs/:id/steps/casting/confirm` | 逐角色确认角色定妆：body `{ characterId, face?, voice?, speaker?, language?, design?, speed?, previewArtifactId? }` → `{ run, character, readiness }`；确认齐后自动解除 `keyframe`/`audio` 的 `casting` 阻断 |
| GET | `/api/tts/voices` | 平台音色库（命名音色 + 语种枚举，来自 147 `TDQwen3TTSCustomVoice` 只读探测）→ `{ template, voices: string[], speakers, languages, defaultSpeaker, defaultLanguage, source }`；前端选项唯一来源 |
| POST | `/api/tts/preview` | 试听：body `{ speaker, design?, language?, speed?, text? }` → `{ url, artifactId, jobId, speaker, language, text, ms }`；复用 147 提交/轮询/产物登记链路，音色/语种非法 400，147 忙/失败回可读 502 |

`Run` = `{ id, title, novel, createdAt, updatedAt, estimate?, options?, stages: { [stageId]: { id, title, status, inputs, output, artifacts, error?, chunked?, startedAt?, finishedAt? } } }`

`Estimate` = `{ novelChars, promptChars, maxChunkChars, chunked, chunks, llmCalls, perChunkSeconds, estSeconds, resumableChunks }`
—— 创建 run 时算好，让调用方在**开跑之前**就知道代价。`promptChars` 是**填充后**的 prompt 长度（含 SKILL.md 模板），
与 `composeWithLlm` 的分块判定同口径，不是小说字数。`perChunkSeconds` 取 `config.pipeline.estSecondsPerChunk`（默认 **31**，
实测 222 万字 / 163 块 / 83 分钟 ≈ 30.5s/块）。

`Progress` = `{ runId, stage, phase: "map"\|"reduce"\|"single"\|"done"\|"failed", done?, total?, label?, reused?, resumed?, avgMsPerChunk?, etaMs?, error?, startedAt?, finishedAt?, updatedAt? }`

`LogEntry` = `{ at, actor, op: "run.create"\|"stage.begin"\|"stage.output"\|"stage.edit"\|"stage.error"\|"assemble.done", stage?, hash?, ok?, message? }`
—— 追加式审计（`runs/<id>/log.jsonl`，一行一条，永不重写）。`hash` 是产物内容指纹（sha256 前 16 位）：
阶段本身没有 revision，用它回答「这一步写进去的到底是哪一版产物」。`actor` 由调用方传（网页端 `web`、Agent 自带名字），缺省 `local`。

**阶段产物契约校验（P0-g 结构 + 引用完整性）**：每次产物写入前跑 `stage-artifact-check.js`（纯函数）：
引用断裂（分镜 `sceneId` 不在剧本、关键帧 `shotId` 不在分镜、片段 `keyframeId` 不存在、配音 `shotId` 不在分镜、分集 `sceneIds` 不在剧本）、
id 重复、帧角色非法、配音时间倒挂判 **error → 阶段 `error`、产物不落盘、下游拿不到 done**；
可选增强字段缺失、artifact/job 为空、`keyframeId=null`、上游集合缺失一律放过或只写 `stage.warnings`（避免误拦）。
人工修订走同一道门（不合法 400）；成片已落盘时只记 warning，**不因结构问题作废已合成的成片**。

阶段 id 固定为：`script`（小说→剧本）、`storyboard`（分镜拆解）、`design`（服化道）、`casting`（角色定妆）、`keyframe`（关键帧）、`audio`（配音）、`assembly`（片段合成拼接）。

**配音（`audio` 阶段）**：`skills/registry.json` 新增的生成型阶段，插在 `keyframe` 与 `assembly` 之间（`requires: ["storyboard","design"]`，
与关键帧并行）。它**不调 LLM**，而是把分镜台词与角色音色确定性派生为逐条 AudioCue（`audio.js` / `audio-track.js`），
**只为有对白的镜头**逐条入队 TTS（`config.pipeline.audioTemplate`，默认 `audio_qwen3_tts`），产物登记成带
`shotId + startSec` 的 audio item（`run.stages.audio.output.audio[]`）。`assembly` 合成成片时若调用方未显式传 `audio`，
会自动从该阶段产物派生混音入参 —— **只有已有产物的条目进混音，TTS 失败/未跑配音自动跳过，绝不阻塞出片**
（`assembly.requires` 里不含 `audio`）。音色描述 → 具体 TTS 模型音色枚举的映射属**后端适配**，写在编排层（`qwen3Speaker`），
内容层只给模型无关的音色事实。

**角色定妆（`casting` 阶段）**：`skills/registry.json` 的独立阶段，插在 `design` 与 `keyframe` 之间
（`requires: ["script","design"]`）—— 产品负责人拍板「服化道管物与景，AI 生产还得显式定人脸与声音」。
它**不调 LLM**，只做两件事 —— **定脸 + 定声音**，确定性组装**身份卡** `run.stages.casting.output.characters[]`：
`face`（`closeupArtifactId` / `turnaroundArtifactIds` / `confirmed`，**复用**服化道 `closeupPrompt` / `turnaroundPrompt`
产出的参考图，绑定仍走 `bindDesignReferenceArtifacts`）与 `voice`（`voiceProfileId` / `speaker` / `design` / `speed` /
`language` / `previewArtifactId` / `confirmed`，`speaker` **只能**取自平台音色库 `src/voices.js`）。
`face.confirmed` / `voice.confirmed` / 角色 `confirmed` 三级，角色 `confirmed` = 脸与声都真；确认写 `lockedAt`，确认后修改 `version + 1`。
**未确认不得进下游**：`keyframe.requires` / `audio.requires` 含 `casting`；若 `casting` 已产出但存在未确认角色，
编排器（`enforceCastingGate`）把 `keyframe` / `audio` 置 `status = "blocked"` 并写清**哪个角色、缺脸还是缺声音**
（`blockedReason` / `blockedMissing`，复用 #70 的可见可行动机制），「运行本步」也回 409，绝不静默降级；确认齐后精确解除放行。

**成片音轨按镜头时间轴混入（路径 B）**：分镜台词经 TTS（`audio_qwen3_tts`）出音后，**不改 H3 视频图**，
而是在 `assembly` 阶段由 `src/delivery.js` 把已有 TTS 产物混进成片——`buildAssemblyPlan` 把每条音轨的
`shotId + startSec`（镜头内相对偏移）换算成成片时间轴上的**绝对 `delayMs`**（转场档自动扣除重叠），
`buildConcatArgs` 对每轨施加 `adelay=<ms>` 后再 `amix`，末尾 `apad` 把音轨补静音到与视频等长
（否则 `-shortest` 会把「音轨比视频短」的成片截短）。**无 `ref` 的音轨（镜头没音频/产物未就绪）直接跳过，绝不让合成失败。**
`clipStartOffsets(plan)` 是同一套时间轴公式的纯函数出口。

> ⚠️ **画面里的台词字幕来自关键帧，而非 H3**（真跑溯源，2026-10-04，`video_h3_i2v` + sh1）：
> 曾经以为「H3 把 `<d>` 台词块烧成画面内字幕」，实为误判。真相是**图像（关键帧）阶段**把内容事实里的
> `台词：…` 一并喂给了官方 Qwen PE 改写器，改写器逐字写出「Along the bottom edge of the frame, three lines
> of white Chinese subtitles … read "姑娘，这么晚，去哪儿？" …」（见 `data/jobs.json` 里 `img_qwen21_edit`
> 的 PROMPT 原文）—— 关键帧图**自带字幕**，H3 的 I2VA 只是**原样保留**。
> 修复落在图像提示词侧：`prompt-compiler.js` 的 `tierTwoSourceText` / `rewriteSourceText` 不再把台词正文
> 交给改写器（图像只负责画面，说话动作由 `action` 表达；台词归 TTS、字幕后期按音轨逐句烧）。
> 重跑关键帧 + 视频后抽帧 0.5/2.5/4.5s，底部**无任何字幕**（对照：只在 H3 提示词里加/不加「画面内无文字」
> 禁令都不改变结果；`strict_prompt_tags=false` 也无效）。
>
> 仍保留的兜底（若历史素材/其它路径已烧字幕）：按字幕带裁掉或模糊掉底部，例如（均已实跑验证无残留可读文字）：
>
> ```bash
> # 裁掉底部字幕带（720p 竖屏去底部 ~220px；分辨率变为 768x1156）
> ffmpeg -i in.mp4 -vf "crop=iw:ih-220:0:0" -c:a copy out.mp4
> # 保原尺寸，仅模糊底部字幕带
> ffmpeg -i in.mp4 -filter_complex "[0:v]crop=iw:230:0:ih-230,boxblur=25:3[bl];[0:v][bl]overlay=0:H-230" -c:a copy out.mp4
> ```

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

**启动不阻塞（#68）**：`server.listen()` 不等任何外部依赖，端口秒级就绪。历史上这里是两个同步瓶颈，现已拆开：

- **外部探测（ComfyUI / RunningHub）**：改为 `src/probe-cache.js` 的**后台并发探测 + 短超时（3s）+ TTL 缓存（30s）**。`/api/health` 只读缓存快照、**永不 await 上游**，首次未就绪给 `{ ok:false, …, pending:true }`；`healthProbe.warmAll()` 在 listen 回调里触发首探，就绪后自动反映。
- **历史任务重放**：旧实现直接在模块加载时 `pipeline.bindJobs()`，会**同步重放 jobs.json 里全部终态 Job**（实测 535 个、其中 350 个命中同一个数 MB 的 `run.json`，逐条读写 ≈ **104 秒纯 CPU**，把 listen 拖到 100 秒开外）。现在只保留廉价的 `jobs.on("change")` 订阅（模块加载即挂），重放改成 listen 之后的 `replayHistoricalJobs()`：**逐条 `setImmediate` 让出事件循环**，重放期间 `/api/health`、`/api/jobs` 全程可应答。
- **各阶段计时**：被直接启动时打 `[startup] <阶段>: +Nms` 日志，一眼看出瓶颈在哪一段。

**成片字幕（独立交付，默认不烧）**：产品定性 —— 成片是**粗剪装配**，精剪交剪映。因此成片 mp4 **默认不含字幕**
（烧死的像素在剪映里改不了），字幕以**独立 `.srt` 文件**与成片同交付目录落盘、暴露成 `/api/artifacts/<deliverableId>/<episodeId>.srt`，
并登记进 run 的 `assembly.subtitles = { burned:false, cueCount, lines, url, name }`。`delivery.assembleEpisode` 的
`subtitlesText` 现在**总是**落盘 SRT、但只在显式 `options.burnSubtitles === true`（或直给 `options.subtitles` 文件路径）时才交 ffmpeg 烧入
（烧录能力保留）。无台词/无时间轴 → 无字幕 + `成片无独立字幕：…` warning，成片照常产出。前端成片预览（站内弹窗）会把该 SRT
转成 WebVTT 自动挂成 `<track>`，无 SRT 时静默不挂。

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
| `src/providers/llm.js` | `createLlmProvider(config)`, `forwardToLlm(req, res, config, pathWithQuery)`, `chat(config, options)`, `externalProviders(config)` | 见下（**不含模型清单/探测**：清单只读模型注册表） |
| `src/llm-client.js` | `callLlm({ system, user, maxTokens?, timeoutMs?, model?, provider? })`, `llmCall({ system, user })`, `findProvider(name)`, `loadProviders()` | 服务端 LLM 客户端（提示词策略层的语言适配出口）。零依赖、用 `node:https` 不用 `fetch`（避开 undici 300s headersTimeout）；默认打 `data/llm-providers.json` 的 `deepseek` 渠道 + `deepseek-flash`；返回带 `finishReason`/`chars`；空内容/截断（`finish_reason=length`）抛错，绝不静默回退 |
| `src/prompt-api.js` | `createPromptApi()`, `compilePromptForRequest(body, { callLlm })` | `POST /api/prompt/compile` 的业务 + 路由装配：按模板编译提示词 → `{ prompt, meta }`（见「提示词编译」节） |
| `src/providers/comfy.js` | `createComfyClient(config)`, `probeComfy(config)`, `listComfyCapabilities(config)`, `listTemplates(workflowsDir)` | 见下 |
| `src/probe-cache.js` | `createProbeCache({ ttlMs, timeoutMs, now })` | 外部依赖探测缓存（#68）：`define(name, { baseUrl, probe, pending })` / `get(name)`（同步读快照，未就绪给 pending、过期 stale-while-revalidate）/ `warmAll()` / `refreshAll()`。并发、短超时、永不阻塞调用方 |
| `src/skills.js` | `loadSkills(skillsDir)`, `loadRegistry(skillsDir)`, `readSkill(skillsDir, id)` | 见下 |
| `src/stage-artifact-check.js` | `checkStageArtifact(stageId, output, upstream)`, `formatArtifactErrors(errors)` | 阶段产物契约校验（P0-g 结构 + 引用完整性）：纯函数、零 IO，返回 `{ ok, errors, warnings }`，每条 `{ code, path, message }` |
| `src/run-log.js` | `appendRunLog(runsDir, runId, entry)`, `readRunLog(runsDir, runId, limit)`, `runLogPath(runsDir, runId)`, `RUN_LOG_FILE` | 追加式审计日志（`runs/<id>/log.jsonl`）：只追加不重写；写入失败只 warn 不抛 |
| `src/pipeline.js` | `createPipeline({ config, skillsDir, jobs, comfy, llm, llmCall, runJob })` | 见下 |
| `src/model-registry.js` | `createModelRegistry({ dataDir })`（含 `textModels()`）, `computeAvailable()`, `textModelIds()`, `asModelIdList()`, `categoryForTemplate()`, `runtimeForProvider()`, `buildTemplateScript()`, `buildGroups()`, `composeAlias()`, `fallbackBaseTask()`, `DEFAULT_ALIASES`, `DEFAULT_BASE_TASK` | 模型注册表存储内核：CRUD + `sync`（含存量幂等回填、渠道 `meta.baseUrl`/`meta.models` 刷新）+ `available` + 分组聚合；**文本模型清单的唯一读源**（`textModelIds` → `渠道名::模型名`）；分类/runtime 映射与默认 base/task 别名表（契约 v1） |

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

**生成参数自适应（`capability-limits.js` + `input-image.js`）**：发起生成那一刻（`submitGeneration`）按所选模型的**能力元数据**（`sizes.js` 的 `SIZE_CATALOG`：官方规格 + 像素上限 `maxPixels`）把不合规的尺寸/时长**自动吸附到合法档**，**不再报错拒绝**（产品口径：「只要方向对，该压缩的压缩、该放大的放大」）：
- **尺寸基准 = 该次实际输入图的真实比例**（图生 / 参考生视频）：147 节点 `first_frame → resize_image(..., "disabled")` 是**不保持比例直接拉伸**（`ref_images` 才是等比缩放），平台「先选画布再喂图」→ 比例不一致必变形。`input-image.js` 在提交那一刻从**实际资产/产物**（`/api/artifacts/...` / 本机路径 / data URL / 远端 URL）只读文件头解析输入图真实像素（**不信前端传的尺寸**；token 优先级 `FIRST_FRAME > INPUT_IMAGE > REF_IMAGE_1..3`，只认模板声明的 token；解析不出 → 按提交尺寸），再把图真实宽高交给 `adaptSizeParams`（`image-dims.js` 零依赖解析 PNG/JPEG/GIF/WebP/BMP）。
- `adaptSizeParams`：**图比例 ≠ 提交比例 → 以图为准**（`basis:"input-image"`）；一致 / 无输入图（纯文生视频）→ 按 `WIDTH/HEIGHT`（`basis:"requested"`，尊重用户明确选的档、该放大照样放大）。用依据比例在该模型合法档里挑**同比例、像素不超上限的最大档**（能放大就放大）；无同比例 → 挑比例最接近且不超上限的。
- `adaptDurationParams`：`LENGTH`（帧）不在 `17k+5` 网格 → **向上吸附**（复用 `durations.js` 口径）；超该模型档位上限 → 吸附到最大合法档。
- **留痕可查（绝不静默偷改）**：调整写进该次任务 `job.meta.sizeAdjust = { from, to, ratio, basis, reason, image?, imageRatio?, aspectMismatch? }` / `meta.durationAdjust = { from, to, grid, reason }`，`params.WIDTH/HEIGHT/LENGTH` 用调整后的值；界面不堆解释字。`basis` 表明依据输入图还是提交尺寸调整（`"input-image" | "requested"`）。
- **变形风险可见**：最终画布比例与输入图比例仍有可感知差异（>2%）→ `sizeAdjust.aspectMismatch = { image, canvas, note }`，随任务记录可见（画布侧也用现有 Tooltip 提示「画布比例 vs 参考图比例不符」）。
- **兜底（不许静默放过）**：模板无规格 / 上限缺失 / 连一个不超上限的档都没有 → 回落 `validateSizeParams` 的**可读拒绝**。前端画布规格下拉只列合法档（`GET /api/providers` 的 `sizes`），旧的超限尺寸自动按比例吸附并展示最终值。


**LoRA 可选化**：部分模板把 LoRA 参数化成 `{{LORA_FILE}}`，但通用调用方并不知道该填哪个 lora 文件名。网关的行为是：调用方没传 `LORA_FILE` 时补空串，渲染后由 `disableEmptyLoras` 把 `LoraLoaderModelOnly` 节点摘除并把下游重连到其上游，因此**调用方永远不需要感知 LoRA**；想固定形象时才显式传 `LORA_FILE` / `LORA_STRENGTH`。`LoraLoader`（双输出）无法安全摘除，缺 `lora_name` 时直接抛中文错误。

**参考图槽位可选化**：`REF_IMAGE_1`…`REF_IMAGE_9` 是「额外参考图」槽位，与 LoRA 同一套机制——调用方没传时补空串，渲染后由 `disableEmptyImageRefs` 摘掉对应的 `LoadImage` 节点**并删掉引用它的输入键**（不需要重连下游，这是与 LoRA 的区别）。这样**一个模板就能服务 1~10 张参考图**，不必为每种数量各做一个模板。
`img_qwen21_edit` 是第一个用例：`INPUT_IMAGE` 固定映射到 `images.image_1`（**编辑目标**），`REF_IMAGE_N` 映射到 `images.image_{N+1}`（参考图），提示词里用 `<image1>`、`<image2>`… 指代。前端按 token 出现顺序把上传的图片**按位**填进图槽，因此模板里 `{{INPUT_IMAGE}}` 必须写在所有 `{{REF_IMAGE_N}}` 之前（有回归测试锁住这个顺序）。

### `src/providers/llm.js`

```js
forwardToLlm(incomingReq, outgoingRes, config, pathWithQuery) => Promise<void>  // 含 SSE 流式透传
externalProviders(config) => [{ name, baseUrl, apiKey, models }]   // 规整 config.llm.providers，丢弃 name/baseUrl 缺失项
chat(config, { messages, model?, temperature?, provider?, ...rest }) => Promise<OpenAIChatCompletion>
```

`chat` 固定非流式（要流式走 `forwardToLlm`）。渠道路由优先级：`options.provider.baseUrl`（临时，不落盘）→ `model` 里的 `渠道名::` 前缀（查注册表，未注册直接抛中文错误）→ `config.llm.baseUrl` / `fallbacks`。`model` 为空时兜底到 `config.llm.defaultModel`，仍为空则抛错。**连接层失败**会带上 `cause.code`（如 `ECONNREFUSED`）便于排查；**HTTP 非 2xx 不重试**，直接把状态码与前 300 字响应体带进错误信息。

**模型清单不在本模块，也不探测上游**（产品负责人 2026-10-03 拍板：外部模型探测不实用，清单只读模型注册表）。
`/v1/models`、`/api/llm/models`、`/api/providers.llm.models`、`/api/health.llm` 全部读 `model-registry.js` 的 `textModelIds()`：
已启用的 `category:text` 条目按渠道声明的 `meta.models[]` 展开成 `渠道名::模型名`（与本模块的前缀路由同口径）。
渠道声明写在 `data/llm-providers.json` 的 `models` 字段（或 `POST /api/llm/providers` 带 `models`），写入后自动 sync 进注册表；启动时也会 sync 一次。
**没声明模型的渠道不产出任何 id** —— 死渠道既拖不住接口，也不会被列进下拉。代价：本机 Ollama 的模型不再被自动发现，要用就把它们登记成一个渠道并声明模型 id。
`timeoutMs`（默认 600000）只服务 `chat` 与 `/v1/*` 透传；`config.llm.probeTimeoutMs` 已随探测一起删除。

### `src/skills.js`

```js
loadRegistry(skillsDir) => { stages: [{ id, title, skill, requires: string[], produces: string[] }] }
loadSkills(skillsDir) => [{ id, name, description, path }]   // 扫描 skills/*/SKILL.md 的 YAML 头
readSkill(skillsDir, id) => string                            // SKILL.md 全文
```

### `src/pipeline.js`

```js
createPipeline({ config, skillsDir, jobs, comfy, llm, llmCall, runJob }) => {
  stages(): StageInfo[],
  list(): Run[],
  get(id): Run | null,
  create({ novel, title, options }): Run,               // run.estimate 在创建时算好
  estimate(run): Estimate,                              // 单独重算预估（口径与分块判定一致）
  beginStage(runId, stageId, runOptions?): Begun,       // 同步：校验依赖、绑定模型、标记 running 并落盘
  executeStage(begun, runOptions?): Promise<Run>,       // 异步：真正跑 LLM 与入队，落终态与进度
  runStage(runId, stageId, runOptions?): Promise<Run>,  // = executeStage(beginStage(...))，同步等完（测试用）
  stageProgress(runId): Progress | null,                // 只读 progress.json，不碰数 MB 的 run.json
  runLog(runId, limit?): LogEntry[],                    // 只读 runs/<id>/log.jsonl 尾部（默认 200 / 上限 2000）
  reconcileRunning(): string[],                         // 启动收敛遗留 running 阶段，返回被收敛的 runId
  setStageInput(runId, stageId, patch): Run,
}
// runOptions = { model?, provider?, signal?, resume?, actor? }
```

HTTP 路由走 `beginStage` + 不 await 的 `executeStage`（立刻 202）；`runStage` 保留给测试与内部同步调用。
`beginStage` 与 `executeStage` 拆开是这套异步语义的前提 —— 校验必须在响应前同步完成（不合法要能返回 400），
执行必须在响应后继续（否则长任务会把连接拖断）。

每个阶段由 `skills/<skill>/SKILL.md` 定义提示词与输出 JSON 契约；阶段间产物以 JSON 传递，落盘在 `data/runs/<runId>/<stage>.json`。
产物落盘前统一过 `src/stage-artifact-check.js`（结构 + 引用完整性）：error 级问题 → 阶段 `error`、产物不落盘、下游拿不到 `done`；
warning 级问题 → 写进 `stage.warnings`（可选增强字段缺失、未出图/未产出、上游集合缺失都只提示，不误拦）。
每次写入都会向 `data/runs/<runId>/log.jsonl` **追加**一条审计记录（谁、何时、哪个阶段、产物指纹、成功与否），可用 `GET /api/pipeline/runs/:id/log` 读取。

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

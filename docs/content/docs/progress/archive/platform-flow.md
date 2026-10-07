# 平台系统流程梳理（以代码为准）

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 本文是 canvas-plus 「小说 → 成片」全流程的**技术视角**梳理。所有结论以**读代码**为准，
> 不采信文档自述。每个关键点标注 `文件:函数:行`，并按证据强度分级。
>
> **证据分级图例**
> - ✅ 读代码核对过 —— 直接读过对应源码，结论即代码事实。
> - 📄 只是抄文档 —— 只见过文档自述，本轮未逐行核对代码。
> - ⚠️ 文档与代码对不上 —— 文档写的与代码实际不一致，逐条列在文末「第 8 节」。
>
> **阅读基线**：仓库工作区状态为 2026-10-04 的 `canvas-plus` 分支（含未提交改动）。
> 阶段 id 与门禁以运行时的 `skills/registry.json` 为准（不是历史文档里的六阶段清单，当前为七段运行时流程，见第 8 节）。

---

## 1. 端到端总览（一张图）

### 1.1 生产链路（业务视角）

```text
小说原文(novel)
  │
  ▼  阶段 0「规划」── 不是 run 阶段，来自项目 settings（plan）
  │     episodeCount / episodeDurationSec(秒, 必须∈模型档位) / ratio /
  │     visualStyle / genre / tone / audience / dramaMode / styleAnchor
  ▼
① script「小说→剧本」      输入=novel(+plan)         输出=characters/scenes/episodes
  │                          （3 个子步骤：analyze 读原文 → outline 分集规划 → script 逐集剧本）
  ▼
② storyboard「分镜拆解」   输入=script               输出=shots[]（含 shotSize/camera/action/dialogue/audio/prompt/...）
  │
  ▼
③ design「服化道」         输入=script               输出=characters/locations/props + references[]
  │                          （references：角色特写/三视图、场景空场母版；会真实入队生图）
  ▼
④ keyframe「关键帧」       输入=storyboard+design    输出=frames[]（每条含 candidates[] 多个候选）
  │                          （真实入队生图；start/end 帧、参考图锁角色、稳定 seed）
  ▼
⑤ assembly「片段合成拼接」 输入=keyframe             输出=clips[] + assembly（真实入队生视频）
  │
  ▼  用户手动触发（不是自动）：POST .../steps/assembly/assemble
成片（ffmpeg concat/xfade + amix + 字幕 + 封面）→ 交付包 zip
```

### 1.2 编排链路（控制视角）

```text
HTTP 路由 (src/index.js)
  └─ POST /api/pipeline/runs/:id/steps/:stage/run
        ├─ pipeline.beginStage()          同步：门禁校验 → 标记 running → 落盘，返回上下文
        └─ pipeline.executeStage()        异步（HTTP 立刻 202）
              ├─ composeWithLlm()          文本阶段：调 LLM 产出 JSON；生成型阶段才回填生成参数
              │      └─ llm.chat() → src/llm-client.js callLlm()（DeepSeek，node:https）
              ├─ [生成型] precompilePrompts()   按模型编译提示词，落快照
              ├─ [生成型] attachGeneration()    组装任务 → enqueueReady() → jobs.enqueue()
              │                                 （本地 GPU 串行队列，并发 1）
              └─ saveOutput() / saveRun() / writeProgress()
任务队列 (src/jobs.js)
  └─ drainQueue()  真实跑 ComfyUI（src/generate.js）→ 终态 emit "change"
        └─ pipeline.bindJobs() 订阅 change → projectJob() 幂等回写 run/stage/item
              └─ recomputeStage() 重算阶段状态 / artifacts / 项目投影
```

---

## 2. 逐阶段小节

阶段的定义**不在文档里，而由运行时技能注册表提供**：

- `skills/registry.json` 定义 5 个阶段（`id / title / skill / requires / produces`）。
- `canvas-server/src/pipeline.js:createPipeline:L302` 读注册表：`loadRegistry(skillsDir)`，L303 建 `stageDefs` Map。
- 阶段定义（✅ 读代码核对过）：

| 顺序 | id | title | skill | requires | produces |
|---|---|---|---|---|---|
| ① | `script` | 小说→剧本 | `01-novel-to-script` | `[]` | `script` |
| ② | `storyboard` | 分镜拆解 | `02-storyboard` | `[script]` | `storyboard` |
| ③ | `design` | 服化道 | `03-costume-props` | `[script]` | `design` |
| ④ | `keyframe` | 关键帧 | `04-keyframes` | `[storyboard, design]` | `keyframes` |
| ⑤ | `assembly` | 片段合成拼接 | `05-clip-assembly` | `[keyframe]` | `clips` |

> 关键事实：**② storyboard 与 ③ design 都可从 ① script 直接进入，二者互不依赖**；④ keyframe 同时需要 storyboard 与 design。
> 代码常量：`GENERATIVE_STAGES = {keyframe, assembly}`（`pipeline.js:L20`）；`STAGE_TEMPLATE_FAMILY = {keyframe:"image", assembly:"video"}`（`pipeline.js:L23`）。

### 2.0 阶段 0「规划」（不是 run 阶段）

- ✅ 规划参数来自**项目**（`project.plan`）或建 run 时的 `run.options`，不是 registry 里的阶段。
  见 `pipeline.js:planConstraints:L674`（plan 优先，`run.options` 兜底）。
- 阶段 0 字段与来源：`create-project-modal.tsx` 的表单 → `POST /api/projects` → `projects.create()`。
- 时长档位（D1）：`plan.episodeDurationSec` 必须是视频模型的档位之一。
  校验入口 `pipeline.js:durationPolicy:L1455`，档位事实源 `src/durations.js`（`DURATION_CATALOG:L43`，H3 仅 `[5,10,15]`）。

### 2.1 ① script「小说→剧本」

| 项 | 内容 | 证据 |
|---|---|---|
| 做什么 | 读原文 → 分集规划 → 逐集剧本；产出 characters/scenes/episodes | `pipeline.js:SCRIPT_STEPS:L32` |
| 输入 | `novel`（run 内嵌）；`buildContext` 注入 plan | `pipeline.js:buildContext:L588` |
| 输出 | `stage.output` = `{characters, scenes, episodes, ...}`；落 `data/runs/<runId>/script.json` | `pipeline.js:saveOutput:L337`、`stageFile:L315` |
| 子步骤 | `analyze` / `outline` / `script` 三步状态写进 `stage.steps` | `pipeline.js:initializeScriptSteps:L687`、`markScriptStep:L698` |
| 门禁 | 入口阶段：必须有 `run.novel` 非空 | `pipeline.js:stageGate:L463` |
| 用哪些模型 | LLM（云 DeepSeek），按阶段可选模型 | `pipeline.js:resolveModel:L611` |
| 分块 | 填充后 prompt > `maxNovelChunkChars`(默认 16000) → map-reduce 分块 | `pipeline.js:composeScriptChunked:L779`、`estimateFor:L506` |
| 断点续跑 | 每块落 `chunks/<i>.json`，`resume:true` 时跳过已完成块 | `pipeline.js:saveChunkPartial:L371`、`countChunks:L390` |
| 产物投影 | 跑完把计划建议回填 plan、把 script/episodes 投影进 Project | `pipeline.js:backfillPlanSuggestion:L1253`、`projectScriptFacts:L1271`、`projectEpisodeFacts:L1288` |

### 2.2 ② storyboard「分镜拆解」

| 项 | 内容 | 证据 |
|---|---|---|
| 做什么 | 按剧本产出镜头列表 `shots[]` | `pipeline.js:composeWithLlm:L1068`（统一 LLM 出口） |
| 输入 | 已 `done` 的 script | `registry.json` requires |
| 输出 | `stage.output.shots[]`（shotSize/camera/action/dialogue/audio/prompt/negativePrompt/...） | `pipeline.js:patchStageShot:L482` 按 shot 局部编辑 |
| 落盘 | `data/runs/<runId>/storyboard.json` | `pipeline.js:saveOutput:L337` |
| 门禁 | 上游 script 必须 `done` 且有产物 | `pipeline.js:upstreamBlock:L441` |
| 集对齐 | 归一 `shots[].episodeId`，回填 `project.episodes[].shotIds` | `pipeline.js:normalizeStoryboardEpisodes:L1369`、`persistProjectEpisodeShotIds:L1333` |
| 骨架校验 | Σ段时长必须等于骨架，缺段显式报出 | `pipeline.js:validateSkeleton:L1395`（调用点 `executeStage:L2778`） |
| 定点编辑 | 只支持 storyboard 阶段按 `shotId` 局部改，shot.id 不可改 | `pipeline.js:patchStageShot:L482`（L485 限制、L493 锁 id） |

### 2.3 ③ design「服化道」

| 项 | 内容 | 证据 |
|---|---|---|
| 做什么 | 产出角色/场景/道具设定，并**真实生成参考图** | `pipeline.js:attachDesignReferences:L1772` |
| 输入 | 已 `done` 的 script（**不需要 storyboard**） | `registry.json` |
| 输出 | `output.characters/locations/props` + `output.references[]` | `pipeline.js:designReferenceSpecs:L1727` |
| 参考图规格 | 每个角色 `closeupPrompt`（正脸特写）/`turnaroundPrompt`（三视图）；每个场景 `sceneMasterPrompt`（空场母版） | `pipeline.js:designReferenceSpecs:L1727` |
| 生成 | 按规格逐条入队生图（纯文生图），产物登记进 `stage.artifacts` | `pipeline.js:designReferencePlan:L1748`、`attachDesignReferences:L1798` |
| 绑定资产 | 参考图全部终态 → 绑定到 `AssetRef.selectedArtifactId` | `pipeline.js:bindDesignReferenceArtifacts:L1814`（projectJob 在 design 分支调用 L2656） |
| 登记 AssetRef | 没有参考图 prompt 的绑定才留空占位；有参考图的延后由上面绑定 | `pipeline.js:registerDesignAssets:L1894`（deferred 跳过 L1910-1913） |
| 门禁 | 上游 script `done`；未选定基准版本的资产不能作默认参考 | `upstreamBlock:L441`、`missingRefsReport`（reference-lock） |

### 2.4 ④ keyframe「关键帧」

| 项 | 内容 | 证据 |
|---|---|---|
| 做什么 | 为每个镜头生成首/尾帧图片（多个候选） | `pipeline.js:generativePlan:L2267`（keyframe 分支 L2271-2371） |
| 输入 | storyboard + design 都要 `done` | `registry.json` requires `[storyboard, design]` |
| 输出 | `output.frames[]`，每条含 `candidates[]`（一幕多候选）、`selected`、`jobId`、`artifactUrl` | `pipeline.js:syncItem:L1120`、`enqueueAttempt:L2435` |
| 候选数 | 单镜一次入队 `maxKeyframesPerShot`（默认 **4**，上限 8）个候选 | `pipeline.js:candidatesPerEnqueue:L300`、`config.js` DEFAULTS `maxKeyframesPerShot:4`（L75） |
| 参考图锁角色 | 按 ShotBinding 注入 `INPUT_IMAGE` + `REF_IMAGE_1..N` | `pipeline.js:shotReferenceContext:L2065`、生成计划 L2309-2335 |
| 稳定 seed | 同项目/同镜/同资产 revision → 同 seed | `pipeline.js:L2357` → `reference-lock.js:stableSeed:L90` |
| 模板选择 | 需参考图时自动选能吃下参考图的模板，否则显式 blocked | `pipeline.js:decideKeyframeTemplate:L2135`、`preferredReferenceTemplate:L2121` |
| end 帧 | 引用本镜 start 帧产物；等 start 回写后由投影补入队 | `pipeline.js:generativePlan:L2297`、`projectJob:L2653` |
| 自动重试 | 无任何达标候选时按 `maxItemRetries`(默认 2) 追加新候选 | `pipeline.js:retryFailedItem:L2508` |
| 门禁 | storyboard + design 均 `done` 且产物非空 | `upstreamBlock:L441` |

### 2.5 ⑤ assembly「片段合成拼接」

| 项 | 内容 | 证据 |
|---|---|---|
| 做什么 | 为每个镜头入队生视频；再由用户手动触发出成片 | `pipeline.js:generativePlan`（video 分支 L2372-2428） |
| 输入 | keyframe 必须 `done` | `registry.json` |
| 输出 | `output.clips[]` + `output.assembly{order, transition, status}` | `pipeline.js:attachGeneration:L2607`（L2625 组装） |
| 时长/帧数 | `LENGTH = frameCountFor(秒, fps)`，走 17n+5 网格 | `pipeline.js:frameCountFor:L52` |
| 首尾帧 | 按模板 token 注入 `FIRST_FRAME/LAST_FRAME` 或 `INPUT_IMAGE` | `pipeline.js:L2392-2400` |
| 成片触发 | **手动接口**（D11 保留人工门禁），片段齐了不自动拼；⚠️ 该接口**当前 web 前端未接线**（见第 8 节 #10） | `pipeline.js:beginAssemble:L2826`、`index.js:L725` |
| 成片门禁 | 任一片段非 `done` 或缺产物地址 → 拒绝 | `pipeline.js:clipsReadiness:L2808` |
| 成片产出 | ⚠️ 拼接/出片接口只在后端，web 前端**无触发按钮**（视频工作区是骨架，注释写「拼接/导出由既有 /pipeline 承担」，但 `/pipeline` 页也未调该接口） | `index.js:L725`（后端）、`web/src/pages/projects/video.tsx:L7`（骨架注释） |
| 成片执行 | ffmpeg concat/xfade + `amix` + 字幕 + 抽封面 + 清单 | `src/delivery.js:assembleEpisode:L288` |
| 成片回写 | 成功才写 `assembly.url` 并登记 artifacts；失败保留清单与日志 | `pipeline.js:executeAssemble:L2860`（L2882-2899） |

---

## 3. 阶段状态机与门禁

### 3.1 阶段状态取值（✅ 读代码核对过）

- run 初始化时每个阶段 = `pending`（`pipeline.js:create:L555`）。
- 运行中 = `running`（`beginStage:L2721`）。
- 生成型阶段终态由 `recomputeStage` 收敛（`pipeline.js:recomputeStage:L1173`）：
  - 有候选在 `queued`/`running` → `running`
  - 有条目被 blocked → `partial`（L1193）
  - 全部候选 `done` → `done`
  - 部分 `done` → `partial`
  - 有 `canceled` → `canceled`
  - 其余 → `error`
  - **完全没有候选但有 blocked 条目 → 整个阶段 `blocked`**（L1181-1185）
- `blocked` 的语义：**前置条件缺失、没跑**（参考图能力不足/参考图缺失），与 `error`（执行失败）区分（前端 `workspace-gates.ts:STATUS_PRIORITY:L23`）。

### 3.2 门禁（`stageGate`）

- 入口阶段（`requires` 为空，即 script）要求 `run.novel` 非空（`pipeline.js:stageGate:L463`）。
- 每个上游依赖都要：`status === "done"` 且 `output` 非空（`pipeline.js:upstreamBlock:L445`）。
- 上游 `error/partial/running/canceled/未产出` 一律阻断，并给可读原因（`upstreamBlock:L446-451`）。
- HTTP：`GET /api/pipeline/runs/:id/gates`（`index.js:L668`）返回全阶段门禁视图（纯推导不落盘，`stageGates:L473`）。
- 运行前最后一道权威校验：`beginStage` 再次 `stageGate`，不通过抛 409（`beginStage:L2719-2720`）。

### 3.3 服务重启收敛

- 启动时 `reconcileRunning()` 把遗留 `running` 落成 `error`（分块保留，可 resume），否则 `beginStage` 会永久锁死该阶段（`pipeline.js:reconcileRunning:L2925`）。
- 队列启动时把 `jobs.json` 里非终态任务收敛成 `error: 服务重启，任务中断`（`jobs.js:L77-81`）。

---

## 4. 数据流与领域对象

### 4.1 对象关系

```text
Project ──< Episode ──< Scene ──< Shot
   │                                  │
   ├──< AssetRef (role: character|scene|prop|keyframe|clip, bindingId, selectedArtifactId)
   ├──< Canvas (引用)
   └── plan / sourceRevisionId        Shot ──< GenerationSlot(candidates[])  ←→  Job ──< Artifact
Run(runId) ──< stages{plan? no} 每阶段 output / artifacts / status
Job ── meta{runId, stageId, itemId}   → 投影回 item.candidates / stage.artifacts
```

- ✅ `Project` 存储：`src/projects.js:createProjects:L172`；原子写 `writeJsonAtomic:L192`；乐观版本；`create:L261`、`context:L447`、`gates:L461`。
- ✅ `Episode/Scene/Shot` 投影：`projects.js:applyEpisodeProjection:L405`；run 侧 shot ↔ project 侧 shot 映射在 `production-contracts.js`（`buildShotIdMap:L733`、`matchProjectShotsToRunShots:L789`、`backfillProjectShotRunIds:L875`）。
- ✅ `GenerationSlot` = keyframe/assembly 条目上的 `candidates[]`（`pipeline.js:syncItem:L1120`、`upsertCandidate:L1136`）。
- ✅ `AssetRef`：`src/assets.js`；管线侧合并视图 `pipeline.js:mergedAssetRefs:L2006`；锁角色解析 `reference-lock.js:buildShotBinding:L318`、`resolveSelectedArtifacts:L383`、`missingRefsReport:L467`。
- ✅ `Job`：`src/jobs.js:createJobQueue:L46`；字段含 `resourceClass/queue/deviceId/status/outputs/progress`（`enqueue:L133`）。
- ✅ `Artifact`：`src/artifacts.js:createArtifacts:L88`（从 jobs/runs/assetRefs 聚合产物索引）。
- ✅ 制作圣经 / 确认锁：`src/bible.js`（`BIBLE_STATES=[draft,review,approved,locked]` L52；状态迁移 `transition:L427`；不改已锁对象产生新 revision `bumpRevision:L459`）。
- ✅ 影响分析：`src/impact.js`（`plan:L347`、`markStale:L553`）；HTTP `POST /api/projects/:id/impact`（`index.js:L1055`）。

### 4.2 落盘位置

| 内容 | 路径 | 证据 |
|---|---|---|
| run 元数据（内嵌整本小说） | `data/runs/<runId>/run.json` | `pipeline.js:runFile:L314` |
| 阶段产物 | `data/runs/<runId>/<stageId>.json` | `stageFile:L315`、`saveOutput:L337` |
| 阶段进度（几十字节小文件） | `data/runs/<runId>/progress.json` | `progressFile:L316`、`writeProgress:L346` |
| 分块 map 结果 | `data/runs/<runId>/chunks/<i>.json` | `chunkFile:L318`、`saveChunkPartial:L371` |
| 任务队列 | `data/jobs.json` | `jobs.js:storePath:L47` |
| 产物/成片文件 | `data/artifacts/<jobId|deliveryId>/<filename>` | `index.js:L592-597`、`delivery.js:assembleEpisode:L320` |
| 产物索引 | `data/artifacts-index.json`（由 artifacts.js 维护） | `artifacts.js:writeIndex:L108` |
| 渠道表 | `data/llm-providers.json` | `llm-client.js:DEFAULT_PROVIDERS_FILE:L34` |
| 模型注册表 | `data/model-registry.json`（`model-registry.js` 管理） | `model-registry.js:createModelRegistry:L466` |

---

## 5. 本地 vs 云端分工

- ✅ **生图 / 生视频跑本地**：默认后端 `local`（`config.js:generation.defaultBackend:"local"` L40），执行体是 ComfyUI。
  路由：`POST /api/images/enqueue`（工作台，`index.js:L473`）、`POST /api/generate/image|video`（`index.js:L498`）。
  队列：本地 GPU 队列并发 1（`jobs.js:inferResourceClass:L27`、`createJobQueue` 的 `concurrency=1`）。
- ✅ **LLM 用云端 API（DeepSeek）**：`src/llm-client.js`（`callLlm:L155`，用 `node:https` 的 `postJson`；`DEFAULT_PROVIDER="deepseek"` L37）。
  路由：`/v1/chat/completions` 转发（`index.js:L487`）。
- ✅ **RunningHub 云端**是可选项，默认关闭：`defaultBackend:"local"`，显式 `runninghub` 才走；未配置不静默回落（`/api/backends` L307）。
- ✅ **提示词编译/改写用 LLM（云端）**：`pipeline.js:compilePromptItem:L2231` 通过注入的 `llmCall` 调 DeepSeek 改写二级画面事实。

### 5.1 模型注册表如何决定「这次用哪个模型」

- ✅ 模型清单**只读注册表，网关不探测上游**（产品负责人 2026-10-03 拍板）：
  `GET /v1/models`（`index.js:L481`）、`GET /api/llm/models`（L392）、`/api/providers.llm.models`（L316）、`/api/health.llm`（L283）全部读 `modelRegistry.textModels()`（`model-registry.js:L671`）。
- ✅ 可用模型来源：`computeAvailable()`（`model-registry.js:L291`）汇总两类：
  1. 本地 ComfyUI 模板（`listTemplates`）→ `source:"template"`, `runtime:"local"`；
  2. LLM 渠道声明的 `models[]`（`data/llm-providers.json`）→ `渠道名::模型名`（`textModelIds`）。
- ✅ `sync()`（L608）把发现的模型登记进注册表，**只增量 upsert，不整车替换**（避免「前端保存把服务端渠道冲掉」）。
- ✅ 具体某次生成用哪个模板/模型：
  - 文本阶段用 LLM 模型：`resolveModel(run, stageId)` = `run.options.stageModels[stageId] || run.options.llmModel || pipelineConfig.llmModel`（`pipeline.js:L611`）。
  - 关键帧生图模板：`decideKeyframeTemplate`（需锁角色时自动换参考图模板）（`pipeline.js:L2135`）。
  - 片段生视频模板：`pipelineConfig.videoTemplate`（`pipeline.js:L2383`）。
  - 覆盖入口：`POST /api/pipeline/runs/:id/steps/:stage/regenerate`（逐条换模板，`index.js:L751`）。

---

## 6. 提示词是怎么从「分镜事实」变成「发给某个模型的提示词」的

这是**后端内部机制，用户无感**（`AGENTS.md`「内容创作规范」硬约束，前端不暴露入口 —— 见第 7 节验证）。

### 6.1 一句话链路

```text
分镜事实(shot/scene/characters/style/slots/overlays)
  → pipeline.generativePlan 组装 compileInput（含模板、实际注入的参考图槽位）
  → promptFor / compilePromptItem 调编译器
      → compilePromptForTemplate(同步)  : 一级块直拼 + 二级块同步稿
      → compilePromptForTemplateAsync(异步, 有 llmCall): 只把二级块交给改写器英文化
  → 写入 item.promptCompilation 快照（含 fingerprint）
  → params.PROMPT = 编译结果 → jobs.enqueue → ComfyUI
```

### 6.2 分级规则（一级 vs 二级）

- ✅ **一级 = 风格锚点 / 画幅·比例 / 负面策略 / 画面内文字**：由编译器**直接拼**，绝不进改写器。
  代码：`prompt-compiler.js:tierOneSync:L831`、`tierOneRewrite:L853`。
- ✅ **二级 = 画面细节**（主体/景别/场景/画面内容/机位与运镜/台词）：可经改写器英文化。
  代码：`prompt-compiler.js:tierTwoSourceText:L1122`。
- ✅ **冲突时二级服从一级**：二级改写出相反画幅 → 先纠正重写一次；仍冲突 → 只保留一级 + 同步结构稿的二级，并记 warning（绝不把错误画幅方向交给模型）。
  代码：`prompt-compiler.js:compilePromptForTemplateAsync:L1190`（L1201-1211）。
- ✅ 走分级的模板：`qwen_image_2_1` / `krea2_turbo` / `flux1_dev`（`isTieredTemplate:L1152`）。
  其余模板（H3 / scail2 / 通用）沿用既有整稿改写或同步兜底。

### 6.3 编译器 / 规则表 / 改写器 / LLM 客户端

- ✅ **编译器**：`src/prompt-compiler.js`，入口 `compilePromptForTemplate:L1076` / `compilePromptForTemplateAsync:L1190`；
  规则分派 `COMPILER_RULES:L1038` + `compilerFor:L1067`（按 `ruleKeyForTemplate` 匹配：H3/Qwen2.1/Krea2/Flux/通用）。
- ✅ **规则表**：`config/model-prompt-rules.json`（13 个模型；顶层含 `h3_prompt_protocols`）。
  只读查询层 `src/model-rules.js`（`loadModelRules:L105`、`ruleKeyForTemplate:L119`、`promptTierPolicy:L225`、`presetFor:L177`）。
  **唯一事实源是 `research/win147-comfyui/registry.json`**，本表是它的运行时副本（改任一字段须先改调研，见文件 `_readme`）。
- ✅ **改写器**：`src/prompt-rewriter.js`（`REWRITERS:L46`、`rewriterForTemplate:L413`、`rewritePrompt:L303`），模板资产在 `prompts/rewriters/*`；无官方改写器时用项目补充的通用英文化 system（`prompt-compiler.js:ENGLISH_TRANSLATION_SYSTEM:L1142`）。
- ✅ **改写 LLM 客户端**：`src/llm-client.js:callLlm:L155`（node:https），出口 `llmCall:L240`（空内容/`finish_reason=length` 截断**直接抛错，绝不静默回退原稿**）。
- ✅ 编译失败降级：保留结构稿 + 打 `[untranslated]` 标记 + 记 warning（`pipeline.js:compilePromptItem:L2231`、`untranslatedWarning:L2164`）。

### 6.4 编译快照与幂等

- ✅ 快照指纹：`promptCompileFingerprint:L2197`（排除派生字段，内容/槽位/模板变则指纹变）。
- ✅ 复用规则：`promptFor:L2217` 只在「同模板 + 同指纹」时复用快照，否则同步编译。
- ✅ 显式重跑 `force:true` 强制重新编译（`executeRegenerate:L2581`），旧 job 的 params 永不改写。
- ⚠️ 曾因 warning 回灌自我放大撑爆 run.json（事故），代码已 `appendWarning:L2185` 按「；」去重修复。

### 6.5 参考图槽位怎么注入

- ✅ `generativePlan`（keyframe）把 `shotReferenceContext` 解析出的 URL 槽位写入 params：
  `INPUT_IMAGE`（模板必填底图时取参考图第一张）+ `REF_IMAGE_1..9`（角色在前、场景/道具在后），并记录 `slotImages` 供编译器生成素材编号。
  代码：`pipeline.js:L2309-2335`。
- ✅ 视频侧：按模板 token 注入 `FIRST_FRAME`/`LAST_FRAME`/`INPUT_IMAGE`（`pipeline.js:L2392-2400`）。
- ✅ 编译器按注入顺序写引用（Qwen 用 `<image1>~<image10>`）：`prompt-compiler.js:qwenReferenceClause:L878`。

---

## 7. 硬约束的代码验证（对照 `AGENTS.md`「内容创作规范」）

| 约束 | 代码验证 | 结论 |
|---|---|---|
| 提示词编译用户无感，前端不得暴露预览/强化痕迹 | 全仓 `web/src` grep `已强化/未强化/预览提示词/promptPreview` **0 命中**；`web/src/pages/image/index.tsx:L429-430` 注释「提示词编译已移到后端…前端不再调用 /api/prompt/compile」 | ✅ 符合 |
| 动线上只能「归档」，彻底删除只在「我的资产」 | 生图工作台只给归档（`web/src/pages/image/index.tsx:L880`）；彻底删除仅 `artifact-manager.tsx`（`requestDelete:L115`，被引用不可选）；后端 `POST /api/artifacts/delete` 必须 `confirm:true`、被引用默认拒删（`artifacts.js:remove:L386`、L402-405） | ✅ 符合 |
| 预览一律站内弹窗（禁跳新页） | keyframe-board 用 `Image.PreviewGroup` 站内弹窗（`web/src/pages/projects/components/keyframe-board.tsx:L22`）；资产页「站内弹窗预览」 | ✅ 符合 |

---

## 8. ⚠️ 文档与代码对不上（产品负责人最看重的一节）

> 以下均为**本轮读代码核对后**发现的「文档写的 ≠ 代码实际」。只列我亲手验证过的。

| # | 文档出处（原文） | 代码实际 | 判定 |
|---|---|---|---|
| 1 | `development-plan.md` §11.1 P1-c：「**D1 时长档位跟模型（`24×秒+3`，仅 5/10/15s）未落**（grep 0 处）」 | **已实现**。`src/durations.js`（139 行）完整实现 `H3_DURATIONS=[5,10,15]`（L21）、`frameCountForDuration=24×秒+3`（L29）、`durationsForTemplate:L82`、`isDurationAllowed:L91`、`skeletonAlignment:L111`；`pipeline.js:durationPolicy:L1455` 已导出；`validateSkeleton:L1395` 已接在 storyboard 阶段（`executeStage:L2778`）；`GET /api/durations`（`index.js:L376`）已上线 | ⚠️ 对不上（文档过期） |
| 2 | `development-plan.md` §11.1 P1-c & §11.2：「**D3 关键帧单镜 ≥4 张未落**（`config.pipeline.maxKeyframesPerShot` 仍 = 2）」 | **默认已是 4**。`config.js` DEFAULTS.pipeline `maxKeyframesPerShot:4`（L75）、`config.json:L48`、`config.example.json:L57` 均为 4；`candidatesPerEnqueue:L300` 关键帧一次入队该数；`retryFailedItem:L2508` 自动重生成 | ⚠️ 对不上（文档过期） |
| 3 | `development-plan.md` §11.2 #31：「关键帧 `start` 只提交 `PROMPT/WIDTH/HEIGHT/SEED`，**没有角色参考图**」 | **已注入**。`generativePlan` 在 L2279 解析 `shotReferenceContext`，L2309-2335 写入 `INPUT_IMAGE` + `REF_IMAGE_1..N`；`registerArtifacts:L1941` 把产物登记为 AssetRef 供锁定 | ⚠️ 对不上（文档过期） |
| 4 | `development-plan.md` §11.2 #28：「`pipeline.js:registerDesignAssets` 仍登记 `artifactIds: []`，**没有生成/绑定这些参考图**」 | **已生成并绑定**：`attachDesignReferences:L1772` 按 `closeupPrompt/turnaroundPrompt/sceneMasterPrompt` 真实入队生图，`bindDesignReferenceArtifacts:L1814` 绑定到 AssetRef。`registerDesignAssets` 只对**没有参考图 prompt** 的绑定留空占位（deferred 跳过，L1910-1924） | ⚠️ 部分对不上（文档过期） |
| 5 | `development-plan.md` §11.2：「多 run 时前端**只取 `runIds[0]`**，第二个及以后不可见（`workspace-gate-panel.tsx:40`、`use-project-timeline.ts:20`）」 | **已有 run 选择器**：`use-project-workspace.ts:L31` `activeRunId = selectedRunId … || runIds[0]`，UI 可切「当前 run」（i18n `workspace.runSelector`） | ⚠️ 对不上（已改进） |
| 6 | `development-plan.md` §11.2：「`pipeline.js` **1456 行**全能编排器」 | 实际 **2947 行** | ⚠️ 对不上（行数过期） |
| 7 | `development-plan.md` §11.1 P0-0：「阶段 ID `plan/script/storyboard/design/keyframe/assembly/post` 冻结」 | 运行时注册表只有 **5 个 run 阶段**（script/storyboard/design/keyframe/assembly，`skills/registry.json`）；`plan` 是项目级阶段 0（非 run 阶段），`post` 在注册表里**不存在** | ⚠️ 对不上（命名口径） |
| 8 | 测试基线：`development-plan.md` 头「**667/667 pass**」 vs `HANDOFF.md`「**673/673**」 | 两份文档自己就不一致；本轮**未重跑测试**，不裁定哪个对 | 📄 未复核 |
| 9 | `HANDOFF.md`「工作区**未提交**且混着改动」 | `git status --short` 确认有未提交改动（前端/后端/doc 混合，含本轮两个新文档） | ✅ 与代码一致（现状事实） |
| 10 | 文档暗示成片可在网页里产出（`delivery-export-button` 文案「项目还没有已完成的成片」等） | **后端有出片接口，前端无触发入口**：`POST /api/pipeline/runs/:id/steps/assembly/assemble`（`index.js:L725`）全仓 grep（排除后端与测试）**前端 0 命中**；视频工作区自述是「骨架」（`web/src/pages/projects/video.tsx:L7`「拼接/导出由既有 /pipeline 承担」，但 `/pipeline` 页也未调该接口）。因此**当前在网页上只能跑到「片段」，出成片需直接打后端接口** | ⚠️ 能力未闭环（前端缺入口） |

> 说明：第 1–4 条是同一根源 —— `development-plan.md` §11.1/§11.2 是 **2026-10-03 傍晚**的复核快照，
> 之后代码已把 D1/D3 与参考图链路补上，但该节未同步更新。建议接手者以上述代码位置为准重新对账 §11。
> §11 本身在 §11.3 第 4 条已自我提醒「证据效力只覆盖旧代码版本」，与此一致。

---

## 9. 接口面速查（`src/index.js`）

- 存活/清单：`GET /api/health`(L282，`ok` 是**存活语义**；`service` 段 + `llm.probed:false` + `comfy` 探测 + `queue`)、`GET /api/backends`(L307)、`GET /api/providers`(L316)、`GET /v1/models`(L481)。
- 模型注册表：`GET/POST /api/model-registry`(L323/331) + `/sync`(L339) + `/available`(L347) + `PATCH/DELETE /api/model-registry/:id`(L356)。
- 时长档位：`GET /api/durations?template=`(L376)。
- 提示词编译（仅运维）：`POST /api/prompt/compile`(L470)。
- 生图工作台：`POST /api/images/enqueue`(L473)；通用生成：`POST /api/generate/image|video`(L498)。
- 任务：`GET /api/jobs`(L536)、`GET /api/jobs/:id`(L547)、`POST /api/jobs/:id/cancel`(L553)。
- 产物生命周期：`GET /api/artifacts`(L562)、`archive/restore/delete`(L588-590)、`GET /api/artifacts/:jobId/:filename`(L592)。
- 流水线：`GET /api/pipeline/stages|runs`(L599/603)、`POST /api/pipeline/runs`(L607)、`GET runs/:id`(L621)、`progress`(L632)、`POST steps/:stage/run`(L644)、`GET gates`(L668)、`PATCH shots/:shotId`(L678)、`cancel`(L693)、`input`(L711)、`assemble`(L725)、`regenerate`(L751)。
- 项目内核：`/api/projects`(L765+) 系列（context/stories、episodes/scenes/shots、sources、asset-refs、bibles、gates、impact）。
- **路由实现约束**：`createRouter` 只支持 `get/post/any` —— 凡 PATCH/DELETE 一律用 `any` 承接（`index.js:L355`、L577 注释）。

---

## 10. 关键代码位置索引（便于接手）

| 关注点 | 位置 |
|---|---|
| 流水线编排器（全部核心逻辑） | `canvas-server/src/pipeline.js:createPipeline:L283` |
| 阶段注册表 | `skills/registry.json`；读入 `pipeline.js:L302` |
| 提示词编译器 | `canvas-server/src/prompt-compiler.js` |
| 模型规则表（13 模型） | `canvas-server/config/model-prompt-rules.json` + `src/model-rules.js` |
| 改写器 | `canvas-server/src/prompt-rewriter.js` + `prompts/rewriters/*` |
| LLM 客户端（DeepSeek） | `canvas-server/src/llm-client.js` |
| 任务队列（本地 GPU 串行） | `canvas-server/src/jobs.js` |
| 生图工作台入队 | `canvas-server/src/workbench-jobs.js` |
| 参考图锁角色 | `canvas-server/src/reference-lock.js` |
| 成片交付（ffmpeg） | `canvas-server/src/delivery.js` |
| 剪辑导出（FCPXML/EDL/zip） | `canvas-server/src/edit-export.js` |
| 时长档位（D1） | `canvas-server/src/durations.js` |
| 模型注册表 | `canvas-server/src/model-registry.js` |
| 产物生命周期 | `canvas-server/src/artifacts.js` |
| 制作圣经 / 确认锁 | `canvas-server/src/bible.js` |
| 影响分析 | `canvas-server/src/impact.js` |
| HTTP 全部路由 | `canvas-server/src/index.js` |
```

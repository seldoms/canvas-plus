# 开发计划 —— Project 一等实体与模块联动

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 版本：v2（2026-10-03）。来源：一次三视角并行调研（资产复用 / 数据流断点 / 用户成本）+ LibTV 联动模式对标 + 代码审计。
> 上位文档：`prd.md`（产品需求）。本文是**执行计划**，PRD 是**产品意图**。
>
> **证据分级**：每条结论标注
> **【已复核】**= 我亲自 grep/读码/真机验证过；**【调研】**= 子代理报告、未逐条复核，落地前需再确认。

---

## 0. 一句话结论

**Project 是第一优先级的生产事实层，必须与产物回写和任务状态修复一起推进。**
当前系统能单独创建画布、流水线 run、生成任务和浏览器素材，但没有一条稳定关系能回答「这部剧的哪一集、哪一场、哪一镜，使用了哪套工作流和工具，生成了哪些关键帧与片段」。
因此整改目标不是再加一个列表页，而是建立一套自洽的
**Project → Episode → Scene → Shot → GenerationSlot → Job → Artifact → Asset** 生产链，并让 Canvas 成为这条链的编辑视图。

产物回写断链、生成阶段假完成、run 刷新丢失和缺少成片执行体是当前必须同步修的 P0；没有这四项，Project 页面只能展示不可靠的状态。

## 1. 致命断链：`artifactUrl` 从不回写 【已复核】

```js
// canvas-server/src/pipeline.js:474  attachGeneration 内
item.artifactUrl = null;
```

全仓**再无任何对 `item.artifactUrl` 的赋值**（`grep -rn artifactUrl canvas-server/src/` 其余命中全是读取或
`files.js` 的 URL 构造函数）；且 `grep -rn "jobs.on|events.on|subscribe" src/index.js src/pipeline.js` **零命中**
—— 任务队列完成时没有任何回调进流水线。`jobs.js` 有 `events.emit("change", job)`，只是没人监听。

三处连锁失效：

| 位置 | 后果 |
| --- | --- |
| `pipeline.js:483` | `if (item.role === "end" && start?.artifactUrl)` 恒假 → **尾帧永远拿不到首帧当参考图** |
| `pipeline.js:497-498` | `if (start?.artifactUrl) params.INPUT_IMAGE = …` 恒假 → `if (canEnqueue && params.INPUT_IMAGE)` 恒假 → **assembly 永不入队，clips 永远 `queued` / `jobId:null`** |
| `pipeline.js:513` | `stage.artifacts = items.filter(i => i.artifactUrl)` → **恒为 `[]`** |

第 497 行注释写的是「等关键帧阶段产出后再跑」—— **意图正确，但没有任何东西把产出写回来**，
所以手工重跑 assembly 也无效（`start.artifactUrl` 仍是 null）。唯一现存通路是用
`POST .../steps/:stage/input` 手工把 artifactUrl 填进产物 JSON，不可用。

**为什么一直没被发现**：关键帧图片**确实生成了**（job 跑了、产物落盘了），前端
`use-pipeline-run.ts` 绕过 run、直接轮询 jobs 渲染 `job.outputs`，所以图看得见。
但 **run 自己永远不知道**，下游拿不到。HANDOFF 记的「端到端跑通到 keyframe」是真的，
「五段式流水线」是假的 —— 实际是**四段半**。

**修法（小）**：`index.js` 订阅 `jobs` 的 change 事件，job 落终态时把 `outputs[0].url` 回写到
对应 item 的 `artifactUrl`/`status`，并重算 `stage.artifacts` 与 `saveRun`。
需要一个 `jobId → (runId, stageId, itemId)` 的反查；`enqueueItem` 已经在 `job.meta` 里存了
`{runId, stageId, itemId}`（`pipeline.js:439-445`），**反查所需的信息已经在了**。

**与「活扣」的关系**：活扣的 `candidates[]` 本质就是同一条「job 完成 → 回写 item」通路，
只是从单值变数组。**修断链不是绕路，是活扣的前置。**

## 2. run 丢失：唯一会造成不可逆金钱损失的缺陷

| 事实 | 证据 | 分级 |
| --- | --- | --- |
| `run` 是裸 `useState`，刷新即丢 | `web/src/pages/pipeline/use-pipeline-run.ts:64` | 【已复核】 |
| 服务端**早就有** `GET /api/pipeline/runs`，前端**没有对应客户端函数** | `canvas-server/src/index.js:268`；`web/src/services/api/gateway.ts` 只有 create/get/runStage/progress/cancel/input | 【已复核】 |
| 全站无 `beforeunload` 拦截 | — | 【调研】 |
| 创建 run 时前端不传 title，服务端一律落「未命名流水线」，UI 也无改名入口 | `use-pipeline-run.ts` `createPipelineRun({ novel })`；`pipeline.js:239` | 【已复核】 |

后果：一部 222 万字的书跑 83 分钟，用户一刷新就再也拿不回那个 run，**而后端仍在跑、仍在烧 LLM 额度**，
且因为 run 无名、磁盘上已有 7 个同名 run，事后也无法辨认。

> 注：本轮已完成的服务端改造（202 异步 + `progress.json` + `cancel` + `resume`）让**后端**具备了
> 可恢复性；缺的是**前端**把 runId 持久化并接上已有的列表接口。

## 3. Project 的定位

**不是文件夹，不是画布，不是标签。Project 是一组标识符的宿主，也是三个世界唯一的联动中枢。**

现状是三个互不相通的世界（`grep -rn "runId|pipelineRun"` 在 `web/src/stores/canvas/`、
`web/src/pages/canvas/`、`web/src/lib/canvas/` **零命中**【已复核】）：

| 世界 | 存储 | 实体 | 缺 |
| --- | --- | --- | --- |
| 画布项目 | 浏览器 localforage | `CanvasProject`（`use-canvas-store.ts:10-22`） | 只是画布容器：无剧本、无主线、无资产作用域、无 run 关联 |
| 素材库 | 浏览器 localforage | `Asset`（`use-asset-store.ts:15-26`） | **无 `projectId`**（全局一锅）、**无 `bindingId`**（绑不到角色/场景） |
| 流水线 run | 服务端 `data/runs/<id>/` | novel + 5 阶段 + artifacts + estimate | **无 projectId、无画布引用** → 跑完即孤儿 |

Project 的价值不在于多一个层级，而在于让
**「这张图是第几集第几镜、用了哪个提示词、参考了哪张定妆图」在系统里可回答**。
现在这句话只活在用户脑子里。

### 3.0 Project–Canvas–Workflow–Tool–Asset 联动模型

这部分按 LibTV 的联动思路落地，但保留本项目的本地优先和画布编辑方式：**服务端保存生产事实，浏览器保存高频编辑态**。
Project 是生产上下文，Canvas 是上下文里的编辑表面；工作流不是某个页面上的按钮，工具也不是某个模型下拉项。

```text
Project（整部剧）
  ├─ source revisions / script / style anchor / review notes
  ├─ Episode（集/单元）
  │   └─ Scene → Shot → GenerationSlot → Job → Artifact
  ├─ Canvas（角色板、场景板、某集分镜板等编辑视图）
  ├─ AssetRef（角色、场景、道具、关键帧、片段、成片的项目引用）
  └─ WorkflowRun（某版工作流在本项目上的一次运行）

Workflow（可版本化的 DAG）
  └─ Stage（剧本/分镜/资产/关键帧/视频/后期等逻辑阶段）
      └─ Tool（一次可执行能力：LLM、ComfyUI 模板、外部 API、TTS、ffmpeg）
          └─ Provider / Device（本地模型、局域网设备或外部 API）
```

四个对象的职责必须固定：

| 对象 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| **Project** | 剧本、主线、资产作用域、工作流版本、运行记录、交付物和完成度 | 不承载画布每次拖动产生的大对象 |
| **Canvas** | 节点、连线、视口、助手会话，以及对 Project 对象的编辑引用 | 不拥有剧本或生成任务的唯一事实 |
| **Workflow** | 阶段 DAG、依赖、输入/输出契约、人工确认门禁、可选工具策略 | 不直接绑定某一台 GPU |
| **Tool** | 单次执行的能力契约、参数 schema、资源类别、取消/重试方式和产物映射 | 不决定项目归属和镜头顺序 |
| **AssetRef / Artifact** | Artifact 是不可变文件；AssetRef 是项目内的角色/场景/镜头语义引用，可指向多个候选 | 不把像素复制成第三份无主文件 |

同一个工具可以被多个工作流使用，同一个工作流可以按项目策略选择本地 ComfyUI、局域网 LLM 或外部 API；
工具执行产生的 Job 必须同时带 `projectId`、`episodeId`、`sceneId`、`shotId`、`workflowRunId` 和 `toolId`。
这样“换模型重跑一镜”只新增一次 Job/Artifact，不会把旧结果从生产记录里抹掉。

Project 页应成为这些对象的交汇点：选择集/场景/镜头后，可以查看剧本来源、分镜、角色和场景资产、关键帧候选、视频片段、任务进度和最终交付物；
Canvas、流水线和素材库都从同一 Project 上下文打开，而不是各自维护一套孤立的选择状态。

### 3.1 要补的标识符（按层）

| 层级 | 现状 | 要补 | 分级 |
| --- | --- | --- | --- |
| run | 无 projectId | `projectId`（**可先塞 `run.options`，零服务端改动** —— `create()` 原样落盘 options，`beginStage` 已在拿它当扩展袋） | 【已复核】 |
| episode | `episodes[]` 在契约与提示词里存在、**代码零消费** | 提为分区键，scene/shot/frame/clip 全带 `episodeId` | 【已复核】（`grep episodes canvas-server/src` 只命中提示词串） |
| scene | `shots[].sceneId` 由 LLM 自由书写，代码从不校验从不 join；`design.locations` 靠 **name 字符串**对齐场景 | 改代码校验 + 用 `sceneId`/`locationId` 对齐 | 【调研】 |
| shot | 插件 `reindex()` 把 id 一律重写成 `sh1..shN`，外部引用一次增删调序即失效 | shotId 定为不可重排的稳定 id，reindex 只改 `index` | 【调研】 |
| job | `meta:{runId,stageId,itemId}`，无语义 id | 补 `{projectId,episodeId,sceneId,shotId}`；**服务端已透传 `body.meta`（`generate.js:143`），画布侧 `GatewayGenerateBody` 只是没这个字段** | 【调研】 |
| 节点 | `CanvasNodeMetadata` 无 jobId/template/seed/shotId | 增 `jobId/template/seed` + `origin:{projectId,runId,stageId,shotId}` | 【调研】 |
| 角色 | `characters[].appearance` 产出了、SKILL 也要求 prompt 与之一致，但**只能当 JSON 看** | 升格为项目级资产（`bindingId`） | 【已复核】（契约见 `skills/01-novel-to-script/SKILL.md`） |

### 3.2 建议的数据边界

Project 不应把所有内容继续塞进一个不断膨胀的 `run.json`。建议按生产事实拆成以下服务端目录；浏览器只保存 Canvas 的高频编辑数据和本地缓存。

```text
data/projects/<projectId>/
  project.json                 # 项目元数据、规划参数、风格锚点、episode 索引、完成度
  sources/<revisionId>.json    # 原文/剧本源版本，内容不可变
  episodes/<episodeId>.json    # 集、场景、镜头和交付状态
  workflows/<workflowRunId>.json
  assets/<assetRefId>.json     # 语义引用，不复制 artifact 字节
  deliverables/<id>.json       # 成片、字幕、音频、封面和交付包索引
  runs/<runId>/                # 该项目下的执行细节、阶段输出和进度
```

最小字段约定：

```text
Project  { id, title, sourceRevisionId, workflowId, workflowVersion,
           plan, styleAnchor, episodeIds[], canvasIds[], assetRefIds[],
           runIds[], deliverables[], checklist, reviewNotes[], version }
Episode  { id, projectId, index, title, sceneIds[], canvasIds[], status, deliverableIds[] }
Scene    { id, episodeId, index, locationId, time, intent, beatIds[] }
Shot     { id, episodeId, sceneId, index, storyboard, generationSlots[], status }
AssetRef { id, projectId, role, bindingId, episodeId?, sceneId?, shotId?,
           artifactIds[], selectedArtifactId, metadata }
Artifact { id, jobId, url, type, checksum, createdAt, nodeId?, outputName? }
```

`run` 的小说正文改为引用 `sourceRevisionId`，运行记录只保存输入版本、提示词版本、模型/工具选择和输出引用。
这样项目页可以快速加载摘要，长篇小说不会随着每次进度轮询重复传输，也能知道一次运行是否基于已经被用户修改过的原文。

当前五阶段注册表应升级为可版本化的 `Workflow` 注册表。每个 Stage 要声明输入/输出 schema、人工确认门禁和可用 Tool；
每个 Tool 要声明 `capability`、参数 schema、资源类别（GPU/CPU/LLM/API）、Provider 选择策略、取消和重试能力。
ComfyUI 模板、外部图像/视频 API、LLM、TTS、ffmpeg 都是 Tool 的不同适配器，不能继续用一个 `template` 字段表达全部执行语义。

## 4. 用户成本：调研量化出的代价

| 摩擦 | 代价 | 分级 |
| --- | --- | --- |
| 刷新即丢 run | 83 分钟 + 全部 LLM 费用不可逆 | 【已复核】 |
| 流水线产物是死胡同：`pages/pipeline/` 对 `useAssetStore`/`useCanvasStore`/`navigate` 引用数 = **0** | 30 镜 × 2 帧 ≈ **60 次「另存为 + 重新上传 + 2 次页面切换」**（画布只支持文件上传，不支持从 URL 导入） | 【调研】 |
| 分镜 schema 同构却无导入通道（插件 `Shot` 与服务端 02 契约 **11 字段同名同义**） | 想把流水线分镜搬进画布，只能复制 JSON → 建文本节点 → 让 LLM **再付费重跑一遍** | 【调研】 |
| 角色一致性只靠 LLM 把外观描述重复写进每个 shot 的 prompt；LoRA 在 `model-plugin.ts:485` 存在但 **UI 零暴露** | N 镜 = N 次手工连参考图，或接受脸崩重 roll | 【调研】 |
| 插件设置跨项目串台（`ctx.storage` 只按 pluginId 命名空间） | 改第 2 集的模型，第 1 集静默跟着变，无提示 | 【调研】（两个子代理独立佐证同一条） |
| 出图尺寸/模板 UI 不可控（取服务端 `config.pipeline.imageWidth`，`/config` 页对 `pipeline` 引用 = 0） | 做竖屏短剧必须**手改服务器 config.json 并重启** | 【调研】 |
| 5 阶段无「一键跑完」，且每阶段各选一次模型 | 5 次点击 + 5 次选择，且必须守着页面 | 【已复核】 |
| 重复实现：文本文件导入 2 份逐字重复、`type="file"` 11 处、模型下拉 3 套、「渠道::模型」2 种编码、尺寸 3 套词汇、「存进素材库」7 处各写一遍 | 学习与维护成本同步上升 | 【调研】 |

### 4.1 本次代码审计新增的结构性结论

以下问题直接影响“在本地局域网完成全套短剧”的目标，优先级高于一般 UI 或模板扩充：

| 等级 | 发现 | 代码证据 | 整改方向 |
| --- | --- | --- | --- |
| **P0** | Project、Canvas、Asset、Run 四套数据没有关系字段，项目概念实际上不存在 | `use-canvas-store.ts:10-22`、`use-asset-store.ts:15-26`、`pipeline.js:232-251` | 先建立服务端 Project/项目上下文，再让 Canvas、Run、AssetRef、Job 强制带项目归属 |
| **P0** | 生成任务完成后没有回写流水线条目；关键帧可见但下游拿不到 | `pipeline.js:471-514`；`jobs.js:68-74` 有 change 事件但没有订阅者 | 建立唯一的 Job→Artifact→GenerationSlot 投影器；终态回写必须幂等、可重放 |
| **P0** | 关键帧/片段阶段在“任务入队”后立即标记 `done`，不代表所有生成任务完成 | `pipeline.js:560-581` | 阶段拆成 `planned/running/partial/ready/failed/canceled`；只有契约校验通过且所有必需 Job 成功才 `done` |
| **P0** | `assembly` 目前只是规划片段，没有 ffmpeg/音频/字幕/封面/交付包执行体 | `skills/05-clip-assembly/SKILL.md`；全仓无 ffmpeg 执行调用 | 增加 CPU 后期 Tool，按 Episode 生成可播放成片，并保存可复现的拼接清单 |
| **P0** | 取消阶段不会取消已经入队的图像/视频 Job，且可能在旧执行尚未结束时允许重跑 | `index.js:332-338`、`pipeline.js:560-581` | 取消要沿 `workflowRun → stage → job` 传播；重跑用 attempt/idempotency key，禁止旧执行覆盖新状态 |
| **P0** | 16GB GPU 被全局单 worker 锁死，没有局域网设备、显存和资源类别调度 | `index.js:55` 固定 `concurrency: 1`；`config.js:25-32` 只有单一 ComfyUI 地址 | 引入 Device/Provider Registry、按 GPU/CPU/远端 API 分队列、能力路由、容量和优先级策略 |
| **P1** | 本地 LLM 与外部 LLM 已能路由，但图像/视频流水线仍主要依赖本地模板或 RunningHub，缺少统一外部生成 Tool | `pipeline.js:439-499`、`index.js:57-86` | Provider 统一抽象；本地 ComfyUI、外部 OpenAI 兼容图像/视频 API、RunningHub 都实现同一 Job/Artifact 契约 |
| **P1** | LLM 输出和人工修订没有运行时 schema/引用校验，`parseJsonLoose` 只保证“像对象” | `pipeline.js:25-39`、`pipeline.js:254-269` | 用共享 JSON Schema 校验每个 Stage；检查 scene/shot/asset 引用、范围、枚举和完整性，失败不得推进下游 |
| **P1** | 生成任务重跑会清空旧 `jobId/artifactUrl`，无法比较；任务 id 由 run/item 拼接，重跑存在覆盖风险 | `pipeline.js:472-475`、`pipeline.js:439-444` | 采用 `GenerationSlot.candidates[]`，每次 attempt 使用唯一 Job/Artifact，保留 selected 指针 |
| **P1** | 生成进度只有 `0/0`，无法在视频长任务中判断设备是否工作或排队 | `generate.js:105-117`、`jobs.js:95` | 接入 ComfyUI WebSocket/事件流；统一返回 queue、device、node、percent、ETA 和耗时 |
| **P1** | 画布插件把设置和镜头 id 当作局部状态，重排会重写 `sh1..shN`，项目外部引用会断 | `plugins/canvas/storyboard-studio/src/storyboard.ts:65-68`；`plugin-node-context.ts:8-29` | 插件存储命名空间加入 `projectId/episodeId/nodeId`；稳定 shotId 与展示 index 分离 |
| **P1** | 默认 `0.0.0.0`、CORS `*`、网关无鉴权，局域网内任何人可提交任务和消耗模型额度 | `config.js:7-10`、`http.js:40-45`、`index.js:403-408` | 增加 `auth.mode`、来源 allowlist、项目级权限和资源配额；启动告警不能替代鉴权 |
| **P2** | run 直接内嵌全文，列表和详情不适合做项目级索引；文件写入也缺少原子提交/版本校验 | `pipeline.js:91-95`、`index.js:268-300` | 源文档版本化、运行摘要化；临时文件 + rename、版本号和恢复日志，避免半写文件成为项目事实 |

审计结论：当前代码更像“画布 + 一个可工作的本地生成网关 + 流水线原型”，还不是完整的项目化短剧生产平台。
项目化不是后续包装层，而是连接内容、执行、资产和交付的基础设施；应把它和任务状态、资源调度、成片执行体视为同一条主线。

## 5. 复用盘点

### 5.1 白捡（照抄即可）

- **服务端 Project/VFS 的落盘方式**：复用 `pipeline.js:71-181` 的目录/读写函数 +
  `files.js`（`safeJoin`/`ensureDir`/`sanitizeName`）+ `http.js` router + `jobs.js` 的重启收敛，
  但要新增真正的 `data/projects/<id>/` 模块；当前仓库并没有已经可用的 Project 实体【已复核】
- **`run.options` 可作为第一步的 projectId 过渡字段**，但不能替代 Project 表、权限、Episode 和 AssetRef 关联【已复核】
- **`applyCanvasAgentOps` + 8 个 op** = 「run 产物铺到画布」的现成底座，不需要新机制【已复核】
- `pages/canvas/index.tsx` 列表骨架（网格 + 批量选择 + 导入导出 + 回收站）、
  `canvas-side-panel.tsx:157-172` 组树、`pages/assets/index.tsx` 过滤分页网格、`stage-card.tsx`、
  `lib/zip.ts`、`app-sync.ts` 的通用 `syncDomain<T>`、长任务 202+轮询+取消三件套【调研】

### 5.1.1 LibTV 对标后必须吸收的联动方式

- **生产事实在服务端**：LibTV 的项目页、画布入口和 Agent VFS 是一个项目上下文；对本项目而言，原文、剧本、草稿、工作流运行和产物索引应放在 Project 服务端，Canvas 只保存编辑态和引用，避免把生产事实锁在某个浏览器标签页。详见 [`libtv-product-analysis.md`](./libtv-product-analysis.md) §3.2、§3.4、§6.4。
- **模板就是可复制的工作流入口**：LibTV 用 `sourceSpaceId + sourceProjectUuid` 把官方模板复制到用户空间。我们应让短剧模板、角色板、场景板和分镜板成为带版本的 Workflow/Canvas 模板，创建时复制结构和配置，但不复制外部 Artifact 字节。
- **上下文贯穿工具调用**：从 Project 页进入 Workflow、从 Canvas 选中 Shot 调 Tool、从 Asset 页回到角色/场景绑定，都携带同一个 `projectId` 和稳定的语义 id；工具结果自动回写项目，而不是只返回一个孤立 URL。Agent 的 `write_file`、`nodes_connections_batch` 是我们现有 Agent op 可以吸收的两种语义：项目文件操作和画布批量操作。
- **工作流与工具分层**：工作流保存“先做什么、依赖什么、何时人工确认”；工具保存“如何调用哪台设备/哪个 API”。替换工具不应改变剧本、镜头和资产引用；同一个工具可以被人工按钮、画布节点和 Agent 调用。
- **分组是执行单元**：LibTV 的分镜组可批量创建视频生成器组并整组执行。我们已有 Group/批量 op，应把组升级为可追踪的 Batch/WorkflowRun，拥有取消、进度、失败项和重试，而不是插件面板里的临时循环。
- **素材是引用图谱**：项目素材不是全局文件夹里的副本，而是指向 Artifact 的带角色/场景/镜头语义的 AssetRef；候选、采用版本、来源、模型、设备和审核/质量状态都可追溯。
- **参数面板由 schema 驱动**：LibTV 将模型参数下发为可渲染 schema（组件、默认值、枚举、提示）。我们的 `TemplateInfo.schema` 应扩展为 Tool schema，覆盖本地模板、外部 API、TTS 和后期工具，新增工具不要求同步修改多个前端分支。
- **资源治理属于产品链路**：LibTV 有 Agent 算力预算与 yield/release 语义。本地版对应 `Project/WorkflowRun` 预算、设备队列、优先级和让出/取消机制；要让局域网硬件最大化，必须让用户知道哪台设备在排队、为什么等待、取消后释放了什么。
- **项目页是交汇点**：集/场景/镜头是导航主轴，画布、任务、素材和交付物从这里互相跳转；不要让用户在三个页面之间靠文件名手工对账。只吸收生产内核，不照搬 LibTV 的会员、积分、社区和实时协作外壳。

### 5.2 要改造

- `Asset` 以新的 `AssetRef` 项目引用模型重做；现有浏览器 Asset CRUD 只能作为迁移输入，不能约束新接口或继续作为全局事实【调研】
- `CanvasProjectCard` 解绑 store 与导航；`use-pipeline-run` 提成 store（现在 run 在组件里，没有 store 能给 Project 订阅）【已复核后半】
- `cleanupUnusedImages`/`cleanupUnusedMedia` **必须知道服务端引用**，否则删画布会误删项目产物【调研】
- `GatewayGenerateBody` 加完整 `origin/meta`（project、episode、scene、shot、workflowRun、tool）【调研】
- `pipeline.js` 的单值 `template` / `jobId` / `artifactUrl` 改为 Tool + Job + Artifact 投影；保留旧字段只作为 selected 候选的派生别名【已复核】
- `jobs.js` 从全局单队列改为资源队列；ComfyUI GPU、CPU ffmpeg、外部 API 和 LLM 分别统计并调度，避免一台慢 GPU 卡住全局任务【已复核】
- `plugins/canvas/storyboard-studio` 的 `reindex()` 只改 `index`，不再重写稳定 `shotId`；插件 storage 按 `projectId/episodeId/nodeId` 隔离【已复核】
- `run.json` 从“全文 + 阶段状态”改为“输入版本 + 执行摘要 + 引用”；长篇原文、阶段输出、Job 事件和 Artifact 清单分开保存【已复核】

### 5.3 必须新建

Project 服务端模块与路由；`Project`/`Episode`/`Scene`/`Shot`/`AssetRef`/`GenerationSlot`/`Artifact` 类型
（**`episodes[]` 在 TS 侧完全不存在**【已复核】）；项目页与路由/导航项；插件 storage 的项目命名空间。

还必须新建以下基础设施：

- **Workflow Registry**：版本化 DAG、阶段门禁、输入/输出 schema、默认 Tool policy；现有 `skills/registry.json` 迁移为其中一种实现，而不是继续作为唯一的运行时契约。
- **Tool / Provider / Device Registry**：统一描述本地 LLM、ComfyUI 工作流、外部图像/视频 API、TTS 和 ffmpeg；记录能力、模型、设备、显存/并发限制、健康状态和成本估计。
- **Artifact Projection**：监听 Job 终态，将 Job 输出幂等写入 Artifact、GenerationSlot、Stage 和 Project；支持重启后从事件/Job 状态重放。
- **Schema Validator**：共享 Stage、Shot、AssetRef、Tool 参数和交付物 schema，禁止不完整或悬空引用推进下游。
- **Delivery Executor**：CPU 侧 ffmpeg 拼接、转场、音频/TTS、字幕、封面、分集输出和全剧交付包，作为独立 Tool 接入调度器。
- **Project Context API**：从项目页、画布、流水线和素材库统一获取当前 Project/Episode/Shot，避免每个页面自行拼接上下文。

## 6. 落地当天就会踩的七个陷阱

1. **`useCanvasStore` 是「单 key 存全部项目」**，每次写都 `JSON.stringify` 全量 →
   项目元数据塞进去会让**每次画布拖动都重写全库**【调研】
2. **事件总线是全局单例、无 scope** → 项目页与画布页同时挂载会互相收到事件【调研】
3. **插件 storage 只按 pluginId、不按 projectId** → 项目间串台【调研，双代理佐证】
4. **全局媒体 GC 的扫描范围只有浏览器数据** → 删画布会误删服务端 `assetRefs` 仍指向的图【调研】
5. **把 `stage.status = done` 当作生成完成** → 任务只是入队，项目完成度、下游门禁和交付按钮都会提前变绿【已复核】
6. **取消只 abort LLM 不取消生成 Job** → 用户以为释放了 GPU，队列仍会继续消耗显存和时间；重跑还可能被旧任务覆盖【已复核】
7. **用一个全局 `concurrency: 1` 代表整个局域网** → 单卡保护变成全系统瓶颈，CPU 后期、第二张 GPU、远端 API 无法并行利用【已复核】

## 7. 决策登记

以下两条是 CTO 建议，用户要求「把意见登记进开发计划」。**按建议执行，若否决请在本文批注后回退。**

### D1 命名：Project = 剧，Canvas = 画布 【建议】

新实体叫 `Project`（项目 = 一部剧），现有 `CanvasProject` 重命名为 `Canvas`（画布），
一个 Project 可包含多个 Canvas。

- **理由**：语义最清，且与「多集共享资产」的心智一致（一部剧可以有多个画布：角色设定板、场景板、每集分镜板）。
- **代价**：`CanvasProject` 在 `use-canvas-store.ts`、`canvas-project-card.tsx`、`pages/canvas/index.tsx`、
  `canvas-export.ts`、`app-sync.ts` 等多处被引用，是一次纯改名重构。
- **不改的代价更大**：`CanvasProject.title` 已在用「项目」指画布容器，
  `CanvasAgentSnapshot.projectId`（`canvas-agent-ops.ts:18`）填的也是**画布 id**。
  不先定名，后续所有 `projectId` 引用都会歧义。
- **执行方式**：这是领域模型重构，不以旧组件的机械改名为目标。先在 P0-0 冻结 `Project`/`Canvas` 语义，再由 P0-a 的新项目页面和上下文 API 直接采用新命名；旧数据需要时通过一次性导入适配。

### D2 产物存储：默认引用服务端产物，不下载不复制 【建议】

`Asset` 允许直接引用 `/api/artifacts/<jobId>/<file>`，入素材库时**不复制像素**。

- **理由**：消除第三份副本（现状：画布节点 ↔ 素材库共享 storageKey 是同一份，
  流水线 artifacts 是独立第三份，与浏览器 GC 完全隔离、无引用机制）。
  短剧一部 30 镜 × 2 帧 × 多候选，复制会迅速吃掉浏览器配额。
- **代价**：图在网关磁盘上，**离线或换机器时浏览器拿不到**；且必须同时改 GC（陷阱 4），
  否则删画布会误删项目产物。
- **兜底**：WebDAV 同步与「导出 zip」时把被引用的 artifacts 一并打包（`canvas-export.ts` 的
  `collectStorageKeys` 递归机制可扩展成也收集 artifact URL）。
- **未选「下载存浏览器」**：同一张图存两份，且 6.4MB 级的 run 已经证明服务端才是大件的正确归属。
- **未选「默认引用 + 可手动转存」**：多一个概念、多一套状态，且用户不会主动转存，
  等价于默认引用 + 一个几乎没人用的按钮。**若后续确有离线需求再加，属加法不属返工。**

### D3 生产事实：Project 服务端权威，Canvas 浏览器编辑态【建议】

Project、Episode、Shot、AssetRef、WorkflowRun、Artifact 清单和交付物索引必须以服务端为权威；
Canvas 继续保留在浏览器，用于高频拖拽、排版、视口和临时助手会话。两者通过 `projectId`、`canvasId` 和稳定语义 id 关联。
浏览器刷新、换设备或切换画布时，都应能从 Project 恢复生产上下文；不把完整剧本和任务事实复制到每个 Canvas。

### D4 工作流与工具分层【建议】

`skills/registry.json` 升级为可版本化 Workflow Registry；ComfyUI 模板、LLM、外部 API、TTS 和 ffmpeg 都注册成 Tool。
Workflow 决定阶段、依赖、门禁和产物契约，Tool 决定一次调用如何路由到 Provider/Device。这样替换本地模型、外部 API 或工作流模板时，
不会改变项目中的 Shot、AssetRef 和历史 Artifact。

### D5 阶段状态以任务终态为准【建议】

“LLM 已生成 JSON”“Job 已入队”“关键帧已产出”“片段已完成”“成片已封装”是五个不同状态，不能都叫 `done`。
每个 Stage、GenerationSlot、Job 和 Deliverable 都采用独立状态机；Job 事件重放后仍能得到同样的项目状态，
取消、重试和服务重启不能让旧任务覆盖新 attempt。

### D6 局域网硬件最大化：按资源调度，而不是全局串行【建议】

建立 Device/Provider Registry，至少区分 GPU 生图、生视频、CPU 后期、LLM 和外部 API；每个设备公布能力、显存、并发、健康状态和队列。
默认仍可对单张 16GB GPU 使用并发 1，但不能用一个全局 worker 限制整套局域网。调度器按 Tool capability、资源类别、优先级和项目配额选择执行位置，
并把 `deviceId`、排队时间、执行时间和失败原因写入 Job。

### D7 画布冲突：单写者约定，不做自动合并 【用户已定】

同一项目/画布同一时间只由**一个人**跟进，归属靠人工协商，不在技术上做多端并发合并。

- 契约层保留 `ownerUserId` / `lastEditorId` / `version` 字段，导出与同步时携带；写入方与本机记录的归属不一致时**只提示**「该项目当前由 X 跟进」，不自动覆盖。
- 不做：后写覆盖下的自动冲突解决、锁服务、CRDT 协同编辑。
- 理由：一条产品线只有一个跟进人，冲突态在流程上就不该产生，技术上只需能识别与提示。

### D8 规划参数：项目级默认，逐集可覆盖 【用户已定】

`Project.plan` 是全局默认值；`Episode.plan?` 可覆盖任意字段，未覆盖的继承项目级。修改项目级默认**不影响**已显式覆盖的集。

### D9 审核风险提示：任何环节都可产生，按 scope 就近展示 【用户已定】

```text
ReviewNote { id, scope: project|episode|scene|shot, targetId?, stage,
             source: llm|human, level: info|warn|block, message,
             createdAt, resolvedAt? }
```

- 任何阶段都可产生提示；项目总览页汇总全部未解决项，对应环节页面就近显示本 scope 的条目。
- 与产物正文**严格分离**（独立字段 `project.reviewNotes[]`），只提示不改稿，见 `AGENTS.md` 内容创作规范。
- 展示位置以「谁在那个环节做决策，就在那个环节看得见」为准：剧本环节看剧情/尺度类、资产环节看 IP/形象类、交付环节看分级类。

### D10 候选项不设上限 【用户已定】

`GenerationSlot.candidates[]` 不设数量上限，不自动清理；磁盘压力由用户手动归档或清理。生成记录的可追溯性优先于磁盘节省。

### D11 不做「一键跑完五阶段」 【用户已定】

保留逐阶段人工审核门禁。一键跑完绕不过人工确认环节，不做。

### D12 旧画布数据丢弃，不做迁移 【用户已定】

项目尚未上线，**现有画布数据只是用户的测试数据，已确认不要**。因此**不做数据迁移、不写兼容层**：不读浏览器 localforage 里的旧 `CanvasProject` / `Asset`，不建一次性导入适配层，也不设 legacy 导入端点；新 Project 一律由 `/projects` 新建，画布引用由用户在新页面重新登记进 `project.json.canvasIds[]`。

- **撤下 P0-a 的两条规则**：`p0a-project-kernel-plan.md` 的 R1（旧画布数据导入方式）与 R11（迁移时 `Asset → AssetRef` 的 `role`/`bindingId` 兜底）随之作废；该方案 §2.8「旧数据一次性导入」删除、§4.3 改写为「不迁移、不兼容」、M5 里程碑改为「新页面直接接管」。
- **与 §7.3 的关系**：§7.3 末尾「以迁移期适配层收口旧数据」的表述对**旧画布数据**不再适用——新页面不读旧结构，也不需要适配层；旧 localforage 数据原样留在浏览器，不处理也不删。
- **边界**：不做数据迁移 ≠ 旧页面立刻下线。P0-a 期间 `/canvas`、`/assets` 等旧页面仍可打开使用，只是不再接入 Project；旧页面的移除属 P2。

### 7.1 用户故事：从小说到可交付短剧

以下用户故事是页面设计和接口验收的主线。用户不应该理解 `runId`、ComfyUI prompt 或某个模板文件的目录结构，
页面要围绕“我正在制作哪一部剧、现在做到哪一集哪一镜、下一步需要我确认什么”来组织。

#### 故事 A：创建一部剧并完成规划

用户进入「项目」页，点击「新建短剧项目」，填写剧名、导入小说或剧本文件，选择默认比例、单集时长、目标集数和本地/外部模型策略。
系统立即创建 Project 和一个默认 Canvas，但只保存原文的 `sourceRevisionId`；页面显示可编辑的规划报告、完成度检查表和预计资源成本。

用户可以选择一个短剧模板（角色设定板、场景板、分镜板、默认六阶段 Workflow），模板只复制结构、提示词和参数，不复制历史产物。
规划阶段结束后，系统停在“待确认”，用户确认后才允许进入剧本阶段。超过阈值的长篇应在这里显示预计 LLM 调用数、预计时间和可取消/续跑说明。

页面必须能处理：文件格式不支持、文件为空、重复导入、编码异常、原文超长、网关不可达、模型列表为空，以及用户在尚未运行前修改规划参数。
修改参数后应产生新的 source/plan revision，不能悄悄改变已经完成的运行。

#### 故事 B：生成并审阅剧本，建立主线

用户在 Project 页打开“剧本”工作区，选择本地 LLM 或外部 API，点击「生成剧本」。系统创建一个可命名的 WorkflowRun，显示模型、Provider、设备、调用次数、排队状态和取消按钮。
生成完成后，页面同时提供结构化剧本编辑器和原文对照：梗概、人物、场景、集/单元、风险提示和未解决引用问题分开显示。

用户可以人工修改人物外观、声音、场景和集的归属，再点击「确认剧本」。确认会生成新的剧本 revision，后续分镜只读取这个版本；如果用户改了已被关键帧使用的角色，页面必须提示受影响的镜头和资产，不得静默覆盖旧版本。

模型返回非法 JSON、缺少场景、`sceneId` 悬空、人物外观为空或集的场景引用不存在时，页面应停在“需修复”，不能让下游阶段变绿。

#### 故事 C：分镜、角色和场景资产形成可复用基准

用户进入某一集，看到章节 → 场景 → 镜头树。分镜阶段按当前剧本 revision 生成镜头，用户可以在列表或 Canvas 中调整时长、景别、运镜、台词和声音。
镜头 id 永久稳定，调序只改变 `index`；页面显示每个镜头的“剧本来源、场景、角色、参考资产、关键帧、视频片段”关系。

资产阶段为角色、场景、道具生成项目级 AssetRef。每个角色至少有文字设定、参考图、适用模型/LoRA 和一致性状态；每个场景至少有地点 id、时间、布光和视角参考。
用户可以从素材库登记已有图片，也可以调用 Tool 生成候选。候选结果先进入项目资产区，用户选择采用版本后才成为后续镜头的默认引用。

页面必须标出缺失资产、引用了已废弃版本的镜头、场景名称无法对齐、参考图尺寸/格式不适配和模型不支持的参考图数量。
资产更新应提供“只影响新镜头 / 同步到未生成镜头 / 创建新版本”三个明确选择。

#### 故事 D：批量生成关键帧并逐镜确认

用户在某一集的分镜板点击「生成关键帧」，先看到成本估算：镜头数、每镜帧数、预计图片数、预计 GPU 时间、使用的设备和队列位置。
用户可以选择整集、章节或部分镜头，并设定同一集的默认 Tool；单镜可以覆盖模型、尺寸、LoRA、参考图和 seed。

系统把每一镜作为独立 GenerationSlot，按资源调度器排队。页面显示“待生成/排队中/生成中/部分成功/待确认/已采用/失败”，
每一镜的候选图横向对比，失败项可以单独重试或更换 Tool，成功项不能被重跑删除。

用户确认首帧/尾帧和角色、场景连续性后，系统才把选中的 Artifact 标成 `selected`，并允许进入视频阶段；未确认的镜头不能被一键跑入成片。

可能的问题包括 GPU 显存不足、ComfyUI 节点缺失、模板 schema 不满足、队列长时间无进展、单镜生成失败、服务重启和用户取消。
这些都应保留已成功的候选，并支持从失败镜头续跑；不能把整集回滚成空白。

#### 故事 E：生成视频片段并完成后期

用户选择“已确认关键帧”的镜头，点击「生成视频片段」。系统显示每镜时长、帧数网格、参考图、动作提示、声音需求和预计时间；视频任务可分配到支持该 Tool 的 GPU 或外部 API。
片段完成后，用户可以逐镜播放、重拍、比较候选，并调整顺序、转场、音频、字幕和封面。所有调整都是可追踪的版本，不改变原始片段。

「合成成片」是独立的 CPU Workflow：校验所有必需片段、音频和字幕已就绪，生成 ffmpeg 清单，执行拼接/转场/混音/字幕/封面，输出该集和全剧交付物。
成片失败时保留中间片段和 ffmpeg 日志，只重跑失败的后期步骤；禁止把“片段全部生成”误报为“成片完成”。

#### 故事 F：项目恢复、交付和复用

用户刷新页面或换到另一台局域网设备后，从「项目」页继续看到当前集、完成度、正在运行的任务、已采用资产和下一步建议。
服务重启后，系统把遗留任务收敛为明确状态，并提供「续跑缺失项」「查看失败原因」「重新选择设备」三个动作。

项目完成后，用户可以导出成片、字幕、音频、封面、关键帧、提示词、Workflow 配置和来源清单；导出包中的每个文件都能追溯到 Project/Episode/Shot/Job。
用户复制项目或创建下一集时复用角色和场景 AssetRef，但生成任务、候选和交付物使用新的版本与 id，避免跨集串状态。

### 7.2 页面信息架构与阶段门禁

建议页面层级保持简单，但所有入口都携带 Project 上下文：

| 页面 | 用户要完成的事 | 主要数据 | 离开页面前的门禁 |
| --- | --- | --- | --- |
| 项目列表 | 创建、复制、归档、恢复、搜索 Project | Project 摘要、最近运行、完成度 | 运行中项目提示仍有后台任务 |
| 项目总览 | 看整部剧的进度、集、资产、运行和交付物 | Project、Episode、Checklist、Deliverable | 不允许显示与服务端事实冲突的本地假状态 |
| 规划/剧本 | 导入来源、规划、生成和确认剧本 | SourceRevision、Script、ReviewNotes | 确认前不能推进分镜 |
| 分镜工作区 | 编辑章节/场景/镜头，导入 Canvas | Scene、Shot、Storyboard Canvas | 悬空引用和不合法时长必须先修复 |
| 资产工作区 | 管理角色/场景/道具基准与候选 | AssetRef、Artifact、Binding | 未选择基准版本的资产不能作为默认参考 |
| 关键帧工作区 | 批量生成、比较、采用关键帧 | GenerationSlot、Job、Artifact | 未确认关键帧不能进入视频 |
| 视频/后期工作区 | 生成片段、音频、字幕、拼接和导出 | Clip、Audio、Subtitle、Deliverable | 缺片段或后期校验失败不能标记成片完成 |
| Canvas | 排版、引用、局部创作和 Agent 批量操作 | Canvas nodes/connections + Project refs | Canvas 保存失败不能伪造 Project 已保存 |

所有阶段都应支持“查看输入版本 → 运行 → 观察资源 → 取消/续跑 → 审阅 → 确认 → 生成下一阶段”的闭环。
“一键跑完整部剧”只能作为高级操作，默认仍按阶段停下确认；一键操作必须有全局取消、预算上限和失败后从最近成功阶段继续的能力。

### 7.3 页面重构原则：以生产闭环为准，不受现有插件页面约束

现有插件页、流水线页和素材页只是原型实现，不能作为新产品的信息架构、组件边界或交互流程的约束。
后续可以直接重做页面、路由和状态组织；保留的是已确认的数据事实、接口能力和可复用的执行适配器，不是旧页面的布局与操作顺序。

页面重构遵循以下规则：

- **Project 是唯一入口**：用户先进入项目，再进入集、场景和镜头；画布、任务、素材和交付物都是项目上下文中的工作区。
- **页面围绕用户任务组织**：每个页面只回答“当前输入是什么、系统正在做什么、我需要确认什么、失败后如何继续”，不按现有代码目录拆页面。
- **旧插件可拆、合并或删除**：Storyboard、批量生成、素材管理等能力可以重组为分镜、资产、关键帧和后期工作区；不为兼容旧组件保留孤立入口。
- **组件从契约反推**：先确定 Project/Episode/Scene/Shot/GenerationSlot/Job/Artifact 的数据和状态，再设计表格、时间线、画布面板和详情抽屉；避免先复制旧 UI 再给它补字段。
- **交互优先保证可恢复**：长任务必须在页面刷新、切换设备、服务重启和部分失败后仍可找到；本地状态只能做缓存，不能成为唯一事实。
- **画布是可替换的编辑表面**：可以沿用现有画布引擎，也可以为分镜、角色板和交付编排设计新的画布视图；任何画布操作都必须落到稳定项目引用上。
- **以迁移期适配层收口旧数据**：如果旧插件数据仍需读取，使用一次性导入/转换适配器；新页面和新接口不继续扩散 `CanvasProject`、无项目 Asset 或不稳定 `shotId` 等旧概念。

因此，P0 阶段应先做领域模型、Project 上下文和状态契约，再按用户故事重建页面；不把“旧页面还能否复用”当成排期或架构决策的前提。

### 7.4 全周期问题处理矩阵

这些情况不能由页面各自临时处理，必须成为 WorkflowRun、Job、Artifact 和 Project 的统一行为：

| 问题 | 系统行为 | 用户可以做什么 |
| --- | --- | --- |
| 模型、Provider 或设备不可用 | 标记为 `blocked`/`unavailable`，保留输入版本，不自动改用未知模型 | 更换 Provider/设备、等待恢复或取消 |
| 显存不足、节点缺失、参数不合法 | 只失败当前 Job/Slot，记录可读原因和 Tool 版本，不清空成功候选 | 修参数、换 Tool、只重试失败镜头 |
| 局域网队列过长 | 展示设备、排队位置、预计等待和资源占用，不把排队伪装成运行中 | 调整优先级、换设备、暂停或取消 |
| 批量任务部分成功 | Batch/Stage 进入 `partial`，成功项可审阅，失败项单独重试 | 继续确认成功项或续跑失败项 |
| 页面刷新、浏览器关闭或服务重启 | 以服务端快照和 Job 状态恢复；无法确认的任务进入 `reconcile`，不重复扣费 | 查看恢复结果、续跑或人工处理 |
| 用户修改剧本、角色或场景 | 创建新 revision，标记受影响的 Shot/AssetRef，不覆盖旧 Artifact | 选择只影响未生成镜头、批量重跑或保留旧版本 |
| 外部 API 超时、限流或密钥失效 | 记录 Provider 错误和重试次数，凭证不写入产物和日志 | 修复凭证、换 Provider、重试 |
| 片段齐全但音频/字幕/封面缺失 | 后期门禁阻止 Deliverable 变成 `ready`，保留已生成片段 | 补齐素材或调整交付配置 |
| 删除画布、资产或项目 | 先检查 AssetRef/Artifact 引用和运行任务，采用归档/回收站，不直接删仍被引用的文件 | 查看引用、解除绑定后再清理 |
| 成本或磁盘预算达到上限 | 阻止新增 Job，保留已完成结果和预算明细 | 调整预算、清理无引用候选或分批执行 |

## 8. 工作包与顺序

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **P0-0** | 冻结领域词汇、稳定 ID、状态机、Stage/Tool/Artifact schema 和 Project 上下文协议；以新模型作为页面重构的唯一依据 | — | 能用同一份契约描述一集、一场、一镜、一次候选生成、一次任务和一个交付物；旧插件字段不再作为新接口必选字段 |
| **P0-a** | 建立 Project 内核：服务端 Project/Episode/Scene/Shot/AssetRef/Canvas 引用、源版本、Project Context API，以及全新的项目总览页骨架 | P0-0 | 创建项目→导入来源→创建集/镜头→打开画布/任务/素材工作区；刷新或换设备仍能恢复同一项目上下文 |
| **P0-b** | 修 Job→Artifact→GenerationSlot 回写断链，并实现真实阶段状态、取消传播、attempt/idempotency 和可重放投影 | P0-0 | 关键帧完成后 `stage.artifacts` 非空且能驱动下游；部分失败、取消、重启、重跑均不会覆盖旧结果 |
| **P0-c** | run 可恢复：持久化 run/sourceRevision、服务端列表与详情、命名、断点续跑和刷新保护；长篇正文改为版本引用 | P0-a、P0-b | 跑到一半刷新或服务重启，能从项目页找回、取消、续跑并看到原输入版本 |
| **P0-d** | Device/Provider/Tool Registry 与资源调度：区分 GPU 生图、生视频、CPU 后期、LLM、外部 API，增加 schema 驱动参数和 LAN 鉴权/配额 | P0-0 | 两台设备或两类资源可并行；页面显示排队设备、能力不匹配和成本；取消能释放对应资源 |
| **P1-a** | 打通项目产物图谱：Artifact/AssetRef 回写项目，分镜、角色、场景和关键帧可在新工作区互相跳转；必要时提供旧插件数据导入适配器 | P0-a、P0-b | 关键帧进入项目资产无需复制像素；镜头详情可追溯来源、工具、任务和采用候选 |
| **P1-b** | 活扣与批量执行：`GenerationSlot.candidates[]`、分组运行、逐镜重试、并排比较、采用/回退和 Canvas 批量操作 | P0-b、P0-d | 同一镜头使用两个 Tool 生成候选，保留全部历史并可点选采用；整集部分失败可续跑 |
| **P1-c** | 六阶段方法论吸收 + 阶段 0 规划 + `skills/libraries/` 接线，按 Project/Workflow 版本运行 | P0-a、P0-c | 受 `AGENTS.md` 内容创作规范约束；规划、剧本、分镜、资产、关键帧、视频和后期均有确认门禁 |
| **P1-d** | Delivery Executor：CPU ffmpeg 拼接、音频/TTS、字幕、封面、分集/全剧交付包和可复现清单 | P0-b、P0-d | 片段全部完成不自动等于成片完成；后期失败可单步重跑并保留日志和中间产物 |
| **P2** | 项目复用、跨集资产版本、引用计数/清理、性能与离线导出；逐步移除旧页面和兼容适配层 | P1 | 一部剧多集共享资产且不串状态，导出包可追溯，旧插件不再是运行时依赖 |

## 9. 明确不做

- **不给 WebDAV 加同步域**：服务端已是权威副本，且域清单是四处硬编码的闭合集合
  （`app-sync.ts:14`、`:88-127`、`domainLabel:377-382`、`AppSyncResult:53-65`），加域要改四处【调研】
- **不动 `exportCanvasProjects` 的 zip 契约**：`version:3` 闭合，复用会破坏现有 zip 的向后兼容读取【调研】
- 不做实时协作、商业化外壳、模型市场、云端生成后端（见 `prd.md` §9）

## 10. 待确认

原五项已于 2026-10-03 由用户全部拍板，决策登记见 §7：

1. 画布冲突策略 → **D7**（单写者约定，人工协商，不做自动合并）
2. 阶段 0 规划参数的层级 → **D8**（项目级默认，逐集可覆盖）
3. `reviewNotes[]` 粒度 → **D9**（任何环节可产生，按 scope 就近展示）
4. 活扣候选保留上限 → **D10**（不设上限，不自动清理）
5. 「一键跑完五阶段」 → **D11**（不做，保留逐阶段人工门禁）

当前无待确认项。

后续追加：**D12 旧画布数据丢弃、不做迁移**（用户已拍板，见 §7）。

---

## 11. 进度快照与问题台账（2026-10-03 复核）

> 本章回答两个问题：**做到什么程度**、**遇到哪些问题**。§8 写的是「要做什么 + 验收标准」，本章写「实际到哪了」。
> **复核方式**：读代码 + 跑后端测试 + 打接口，不采信 CHANGELOG 自述。
> **复核基线**：后端 `cd canvas-server && node --test test/*.test.mjs` → **206 tests / 206 pass / fail 0 / 2.9s**。
> 问题详情与整改单在 `pilot-issues.md`（只追加、不替换）；本章只做**汇总与分级**。

### 11.1 做到什么程度 —— 对着 §8 工作包逐项对账

图例：✅ 验收达成 ｜ 🟡 主体可用但有明确缺口 ｜ ⬜ 未开始

| 工作包 | 实际状态 | 一手证据 / 缺口 |
| --- | --- | --- |
| **P0-0** 冻结领域契约 | ✅ | `canvas-server/src/contracts.js`(4.6KB)、`web/src/types/domain.ts`(9.5KB)、`docs/content/docs/progress/domain-contract.md`(29.7KB)；阶段 ID 权威命名 `plan/script/storyboard/design/keyframe/assembly/post` 冻结；D1–D12 决策全部登记 |
| **P0-a** Project 内核 | 🟡 | `canvas-server/src/projects.js`(15.1KB) 把项目落盘到 `data/projects/<id>/`（`prj_` ULID + 原子写 + 乐观版本）；网关 `/api/projects` 列表/创建/详情/上下文/归档；前端「我的项目」+ 6 个工作区骨架页（带阶段门禁）。**缺口（2026-10-03 复核更正）**：会诊判定的「`Project.runIds[]` **全仓**无写入点」**只对后端成立** —— 回填实际由**前端**做：项目工作区内建 run 后 `attachProjectRun` 调 `PATCH /api/projects/:id`（`web/src/pages/projects/hooks/use-project-run.ts:106`，提交 `004f30a` 落地，失败还有 `linkFailed` 提示）。但回填**只覆盖这一条路径**：实测 `GET /api/projects/prj_01M3ZK27NYPXRPBVRAT0SSJ2B5/context` → `runIds = ["run-murnwa81-k27eq"]`（**有值** ✅），而**从流水线页建的 run 不在其中**（出片 run `run-murpt28o-46f5q` 的 `options.projectId` 指向本项目、却不在 `runIds[]` 里）。服务端侧仍无「建 run 时按 `options.projectId` 幂等追加」的逻辑（会诊建议的 `POST /api/projects/:id/runs` 未实现） |
| **P0-b** Job→Artifact→Slot 回写断链 | ✅ | 网关订阅任务终态并重放 `jobs.json` 历史终态；`registerArtifacts`(pipeline.js:942) 幂等回写 `(projectId,runId,artifactUrl)`；阶段状态以任务终态为准（`done/running/partial/error/canceled`）。**活证据**：`run-murpt28o-46f5q` keyframe `artifacts=29`、assembly `artifacts=9`（此前恒为 0） |
| **P0-c** run 可恢复 | 🟡 | 异步 run（`POST .../run` 立即 202）+ 轻量 `progress.json` + `GET /runs/:id/progress` + 取消贯通 LLM/Job + 断点续跑 + `run.estimate` 成本预估 + 启动收敛 `reconcileRunning()`。**缺口（复核更正）**：反向导航**已部分可用** —— `context.runIds` 已被 `workspace-gates.ts`（阶段门禁）、过程时间线、资源面板、项目总览共用，不再是空数组。残留两条：① 只覆盖「项目内建 run」路径，从流水线页建的 run 不回填（见 P0-a 更正）；② 多 run 时前端**只取 `runIds[0]`**（`workspace-gate-panel.tsx:40`、`use-project-timeline.ts:20`），第二个及以后的 run 在门禁与时间线里不可见 |
| **P0-d** 资源调度与注册表 | ✅ | `canvas-server/src/registry.js`(12.4KB)：本地 GPU / CPU / 外部 API / LLM 四类独立队列；`canRun` 提交前能力路由（能力不匹配直接拒，不静默换设备）；`deviceLabel`/`maxConcurrency`。测试 `registry`(8) + `registry-wiring`(5) |
| **P1-a** 项目产物图谱 | 🟡 | 生成型阶段产物自动登记 AssetRef（幂等去重）；项目工作区新增「过程时间线」，图片/视频缩略图 + 文本摘要 + 成片清单，阶段运行中 3s/8s 节流轮询。**缺口**：① 资产页只有 artifact id、无缩略图（会诊 M3）；② 「资产」页读前端本地 store，与项目 AssetRef **仍是两个数据源** |
| **P1-b** 活扣与批量执行 | ✅ | `GenerationSlot.candidates[]` + 逐条 `regenerate` 端点（换模型只追加候选、保留历史）+ 模型别名（`alias` 字段，请求仍用原名）+ 横向候选交互 + 逐镜重试（默认 2 次） |
| **P1-c** 六阶段方法论 + 阶段 0 规划 | 🟡 | 阶段 0 预置选项（题材/基调/动画片/像素风/布偶戏）+ `planSuggestion` 自动回填（仅字段仍占位且建议≠现值）；01 改三段式 `analyze→outline→script`（`progress.steps` 可见）；五个阶段技能接进方法论库并加「内容创作红线」；`normalizeEpisodes` 强制集数对齐 `plan.episodeCount`。**缺口**：**D1 时长档位跟模型（`24×秒+3`，仅 5/10/15s）未落**；**D3 关键帧单镜 ≥4 张未落（现配置 2，自动重生成未接）**——两处因产品负责人 2026-10-03 喊停改码而挂起，`pipeline.js` 已空出 |
| **P1-d** Delivery Executor | ✅ | `canvas-server/src/delivery.js`(15.2KB)：片段 ffmpeg concat（`cut`）/ xfade（`fade`/`dissolve`/`slide`）+ 外部音轨 `amix` 混音 + 字幕烧入 + 抽封面 + 可复现拼接清单 + ffmpeg 日志；独立接口 `POST /runs/:id/steps/assembly/assemble`（片段未全成功 400、已成片默认复用）。测试 `delivery`(19) + `delivery-wiring`(8) |
| **P2** 项目复用与清理 | ⬜ | 未开始（跨集资产版本、引用计数/清理、离线导出、移除旧兼容层）|

**一句话**：P0 五个包（契约/内核/回写/恢复/调度）与 P1 的活扣、交付两个包**主体已落地且有测试或活证据**；剩下三处**明确缺口**——① 项目↔run 双向绑定（`runIds[]` 从未写）；② D1/D3 两条产品硬约束未实现；③ 资产页与项目 AssetRef 双数据源。

### 11.2 遇到哪些问题（按严重度分级，仅列**当前仍未解决**的）

> 完整历史（含已修复项与四视角会诊结论）见 `pilot-issues.md`。以下只列此刻还压着流程的。

**🔴 阻断级（流程走不通 / 成片不可用）**

| # | 问题 | 现状 |
| --- | --- | --- |
| 22 | **角色形象没有固定下来**（用户 2026-10-03 报） | 「角色一致性」只存在于**文字**：01 让模型输出 `characters[].appearance`，之后每镜把这段文字重复写进提示词。**没有定妆图/参考图锁脸、没有 seed 锁定、没有角色 ID 贯穿到生图**。而 H3 参考图生视频模板（`video_h3_ref2v_image`，一张参考图即可锁角色）**已经具备能力却没被接进来** |
| 23 | **角色音频 / 音色没有固定下来**（用户 2026-10-03 报） | `voice` 字段同样只是**文本描述**（"音色、语速、口音"），**下游零消费**：无 TTS 接线、无音色库、无配音产物。`delivery.js` 有 `amix` 混音能力，但 `plan.audio` **靠外部手工传入**，流水线没有任何环节生产音频轨 |
| — | **成片配乐与配音不一致** | 根因未定位（上一轮排查被新诉求打断）。与 #23 同源：音频轨既非流水线产出、也无对齐校验 |
| 25 | **成片 6 镜显存 OOM**（复跑实测） | 复跑 run `run-murpt28o-46f5q` 的 assembly 落 **`partial`**：16 镜前 10 成功、`sh11`–`sh16` 全数 ComfyUI `SamplerCustomAdvanced` 报 **`VBAR OOM`**（147 的 16GB 显存；首次 43 分钟后 OOM、重试 78 秒再 OOM，**非偶发**）。ComfyUI 本身活着（0.38.2 / 16310MB） |
| — | 关键帧 / 视频工作区显示 | 会诊发现 12 行空壳、29 张图不可见；本轮已补「过程时间线」，**但尚未复跑验证** |

**🟡 严重级（能跑但结果错 / 数据不可靠）**

| # | 问题 | 现状 |
| --- | --- | --- |
| — | **多 run 只认第一个 + 跨路径不回填** | `workspace-gate-panel.tsx:40` / `use-project-timeline.ts:20` 硬编码 `runIds[0]`；回填只做在「项目内建 run」路径（`use-project-run.ts:106`），从**流水线页**建的 run 不进 `runIds[]`（实测出片 run `run-murpt28o-46f5q` 即如此）。**注**：会诊原判「`runIds[]` 从未被写」**已失效**，实测 `context.runIds=["run-murnwa81-k27eq"]` 非空 |
| — | 渠道注册表**双写者** | 前端 `POST /api/llm/providers` **整车覆盖**写回。**2026-10-03 实测复现**：渠道表里只剩死渠道「默认渠道 → `api.openai.com`（无 key）」，可用的 deepseek 被冲掉，日志被「每 8s 一条」的死渠道告警刷满（1002 行里绝大多数是它）；已手动恢复 deepseek 并重启（`/v1/models` 现含 `deepseek::*`），**根因未修**。应改为「服务端网关路由表唯一写者 / 浏览器渠道表浏览器唯一写者，只按 name 显式 upsert」 |
| — | 关键帧与分镜对不上 | `shots[5].negativePrompt` 含 `costume change, unnatural transformation`，把正向要求的变身镜用负向词否定；`sh12` 公园抛球实际室内抱狗 |
| — | 「2 集 × 30 秒」无人负责 | 9 个 run `episodes=[]`、分镜 16 镜 83 秒超 38%。本轮 `normalizeEpisodes` + 集数进提示词**已部分修复**，待复跑验证 |
| — | 网关 `/v1/models` 漏外部渠道 | 已修（`GET /v1/models` 在 `/v1/*path` 兜底前），**需重启才生效**，因出片 run 在跑故延后 |
| — | D1 / D3 两条产品硬约束未落 | 见 11.1 的 P1-c 缺口 |

**🟢 一般 / 改进（不影响正确性）**

- `forwardToLlm`(llm.js L145) 仍用 fetch → 非流式长生成仍可能撞 `headersTimeout`（`chat()` 已改 `node:http`）。
- 147 内存：`num_ctx=32768` 稳态 ~14.9GB / 16GB（余 ~1.5GB），出事故退 16384。
- `pipeline.js` 1456 行「全能编排器」超 `AGENTS.md:24` 约定；通用编排器硬编码阶段 id、`|| []` 吞结构错误（架构视角 D1/D2，均带触发条件）。
- `model-plugin.ts` 1435 行；`projects.js` 兼子模块微型框架。

### 11.3 本轮风险面（交给下一个接手者）

1. **工作区有 20 个文件未提交**（含 `canvas-server/src/pipeline.js`、`test/pipeline.test.mjs`、`pilot-issues.md`、7 个前端新文件）——测试 206/206 与 tsc 均绿，属「已验证可提交」状态；建议按主题分批落盘（原文导入 / styleAnchor / 过程时间线）。
2. **出片长跑仍在进行**：`run-murpt28o-46f5q`（项目 `prj_01M3ZK27NYPXRPBVRAT0SSJ2B5`）script/storyboard/design/keyframe ✅，assembly `running`（已 9 个片段产物）。重启网关会打断它——这是 `/v1/models` 修复延后的原因。
3. **服务**：`canvas-server` systemd active，`127.0.0.1:8788`，`/api/health` ok；远端 ComfyUI `192.168.123.147:8188`(0.38.2)。
4. **文档滞后已修正**：`pilot-issues.md` 第一轮 21 条状态此前一律写「待讨论」，与实际不符，本轮按核实结果逐条更新（见该文件）。

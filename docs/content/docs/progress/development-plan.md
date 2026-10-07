# 开发计划 —— Project 一等实体与模块联动

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 版本：v4（2026-10-07 晚）。来源：一次三视角并行调研（资产复用 / 数据流断点 / 用户成本）+ 外部短剧产品与 Skill 对标 + H3 续接方案核查 + 代码审计。
> 上位文档：`prd.md`（产品需求）。本文是**执行计划**，PRD 是**产品意图**。
>
> **证据分级**：每条结论标注
> **【已复核】**= 我亲自 grep/读码/真机验证过；**【调研】**= 子代理报告、未逐条复核，落地前需再确认。

---

## v4 更新（2026-10-07 晚，先读这段）

**本计划 §0–§3 的 P0 断链已成历史**：artifactUrl 回写、run 持久化等问题在 M6 闭环（2026-10-06）中修复，正文保留作问题分析档案，不再作为当前任务。

**用户已拍板目标形态**（2026-10-07）：**以项目为中心，但不绑死项目**——画布/生图/生视频可独立使用，产物一旦带归因（projectId/episodeId/shotId）即自动被项目看见；主线为 建项目 → 画布拆解 → 资料包 → 流水线按集生产。
目标形态、六个断点（B1–B6）与目标架构见 [`project-centric-skeleton.md`](./project-centric-skeleton.md)，**当前开发以其 §6 的 P0–P3 为准**：

1. **P0 串联引导（下一步就做）**：项目页"下一步"引导卡（建项目 → 创建拆解画布 → 进入流水线）+ 改 Agent 安装引导文案；
2. **P1 资料包一等公民**：角色/场景/道具包聚合视图 +「归入项目资料包」生成通道 + 定妆/服化道显式取料；
3. **P2 画布↔流水线双向** + 生图/生视频归因选择器；
4. **P3 分发私有化**（见下）。

**GitHub 发布决策（2026-10-07 用户拍板，待执行）**：项目将发布到 GitHub。发布后：

- 插件分发统一走 `codex plugin marketplace add <github 地址>`（skeleton §5 路径 B），工友装到的即含 51 工具说明与 pipeline 技能的版本；
- **必须配套**：① 改 `agent-connect-view` 引导文案（i18n `agent.connect.plugin*`，现写死上游 `npx @basketikun/canvas-agent@latest`）；② `plugins/infinite-canvas` 的 plugin.json 改名 `canvas-plus`、version 独立递增，避免与官方插件在工友机器上互踩；
- 发布前注意：仓库含内网地址/端口/主机别名等环境信息，公开范围需用户确认。

**本周已落地（10-06 晚 ~ 10-07）**：流水线新页 `/pipeline` 全量真实数据（七面板 + 条目级动作全真接口）；Agent `project_*` 7→17（总 51 工具，项目/阶段/条目三层视角）；agent-instructions / README / 插件 pipeline 技能三面文档同步；页面标注工具全局悬浮窗化。

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

当前七阶段注册表应升级为可版本化的 `Workflow` 注册表。每个 Stage 要声明输入/输出 schema、人工确认门禁和可用 Tool；
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

### D11 人工门禁：现阶段开启，后期可全局切换 【用户已定；本轮修订】

现阶段保留逐阶段人工确认，产出可修改并按影响范围重跑。后期流程与模型能力稳定后，通过全局开关支持自动推进，不永久禁止完整流程自动运行。关闭人工确认不取消必需输入、产物完整性校验和失败处理；自动采用资产/风格版本的策略仍待设计。

本轮目标、批次策略、风格前置及最低资产标准以 `prd.md` §1.1～§1.4 为准；本决定取代历史“不做一键跑完”的产品限制，不表示自动模式已实现。

### D12 旧画布数据丢弃，不做迁移 【用户已定】

项目尚未上线，**现有画布数据只是用户的测试数据，已确认不要**。因此**不做数据迁移、不写兼容层**：不读浏览器 localforage 里的旧 `CanvasProject` / `Asset`，不建一次性导入适配层，也不设 legacy 导入端点；新 Project 一律由 `/projects` 新建，画布引用由用户在新页面重新登记进 `project.json.canvasIds[]`。

- **撤下 P0-a 的两条规则**：`p0a-project-kernel-plan.md` 的 R1（旧画布数据导入方式）与 R11（迁移时 `Asset → AssetRef` 的 `role`/`bindingId` 兜底）随之作废；该方案 §2.8「旧数据一次性导入」删除、§4.3 改写为「不迁移、不兼容」、M5 里程碑改为「新页面直接接管」。
- **与 §7.3 的关系**：§7.3 末尾「以迁移期适配层收口旧数据」的表述对**旧画布数据**不再适用——新页面不读旧结构，也不需要适配层；旧 localforage 数据原样留在浏览器，不处理也不删。
- **边界**：不做数据迁移 ≠ 旧页面立刻下线。P0-a 期间 `/canvas`、`/assets` 等旧页面仍可打开使用，只是不再接入 Project；旧页面的移除属 P2。

### D13 数据边界：素材不出本机，文本可用云端 【用户已定，2026-10-05】

**图像 / 视频 / 音频与私有素材不出本机；文本链路（剧本 / 分镜 / 服化道 / 提示词改写）可以用云端 LLM**，本地模型保留给特殊场景（离线、隐私敏感、降本）。

- **背景**：此前 PRD 写"网关 + ComfyUI + Ollama 全在内网"，但实现上 `config.llm.defaultModel='deepseek::deepseek-v4-pro'`（`index.js:88` 在 `pipeline.llmModel` 为空时兜底注入）→ 文本实际发往 `https://api.deepseek.com`。本轮把口径改成"如实描述"，而不是把实现改回全本地。
- **落地**：`prd.md` §1 已加"数据边界"行；`platform-positioning.md` C1 由"矛盾"转为"已决策"。
- **仍需清理**：其它写"全内网 / 数据不出机器"的文档按此口径逐个对齐。
- **若要切本地**：把 `config.pipeline.llmModel` 指向本地模型即可；代价是实测 **14.45 t/s**、`numCtx=32768` 吃 **14.9GB/16GB** 显存，且与 ComfyUI 争卡。

### D14 画布接入服务端事实链 【用户已定，2026-10-05；集成深度待外部评审】

**画布必须接入服务端事实链**。产品负责人明确"这关系重大"，并希望先交外部更高维度评审再定**集成深度**。

- **现状（为什么这是大事）**：画布与项目在数据模型上完全没有关联 —— `CanvasProject` 无 `projectId`、`Project.canvasIds` 无写入方、canvas-agent 传的 "projectId" 实为画布 id、画布生成走**浏览器直连**（无队列/刷新即丢）、画布产物**不进 `Artifact/AssetRef`**（`/assets`、`/tasks` 看不到）、画布"资产"与服务端资产**双轨**。因此"在画布上产出资料包"目前**在数据层就是断的**。
- **三档深度**（详见 `platform-positioning.md` §5.5）：**A 最小**（产物登记 + `projectId`）｜**B 中度**（A + 画布生成改走服务端队列，收敛三套提交链）｜**C 重度**（B + 画布节点图由服务端持有；与 D7"画布单写者"、§7「画布是可替换的编辑表面」冲突）。
- **工程侧倾向 B**；**拍板前不要在画布侧写资料包入口**（会被现状挡着）。

### D15 声音生产默认分离，口型同步可选 【用户已定，2026-10-05】

默认采用“画面与声音分开生产”：MiniMax H3 负责动态画面，Qwen3-TTS 按角色 `VoiceProfile` 生成独立对白 `AudioCue`，环境声、音效和 BGM 作为独立轨道，最终由 CPU/ffmpeg 混音并生成字幕。H3 原生音频、H3 Talk、MuseTalk 和 LatentSync 保留为按镜头启用的可选增强；口型同步失败不得阻断默认成片。

- **原因**：音色可以跨镜头稳定复用；修改台词只需重做对应音频和字幕，不必重跑视频；当前 16GB 单卡的口型后处理质量和显存调度都不足以成为主链路门槛。
- **调度约束**：本地 TTS、H3 和口型模型共用 GPU 串行队列，CPU 混音在 GPU 任务后执行；没有对白的镜头跳过 TTS 与口型阶段。
- **范围控制**：第一版继续使用已跑通的 Qwen3-TTS，不切换 CosyVoice/GPT-SoVITS；ACE-Step 和口型增强进入后续对比验证，不提前塞进默认工作流。

### D16 Shot/Take/Candidate/Approval 与 H3 续接链分层 【本轮蓝图升级，2026-10-06】

`Shot` 是叙事镜头，`Take` 是同一镜头的一次完整生成尝试或续接分支，`Candidate` 是一次 Job 产出的可比较结果，`Approval` 是当前采用指针。`GenerationSlot.candidates[]` 继续保存历史，不因重跑、换模型或续接而覆盖旧结果。

- MiniMax H3 的多段生成按 `continuationChainId → segmentIndex → parentArtifactId` 组织；每段仍是独立 Job/Artifact/Candidate，支持从任一已批准 Segment 分叉和恢复。
- “无限续接”只作为待验证的 Provider 能力，不写成产品承诺；先在 16GB 单卡上比较原生 Masked AV、MIT latent-tail Continuation、官方 Add Guide 与 Motion Context，再登记默认 Provider。
- Skill 输出先落成结构化事实对象（StoryBible、VisualBible、CharacterBible、SceneBible、PropBible、DialogueBook、ShotPlan），再由 Compiler 按 Provider 能力编译；前端不暴露编译细节。
- 每个续接连接点记录音频相关性、响度突变、冻结检测、运动漂移和人工复核，链深衰减或剧情转折不合格时必须允许重新开链。

该决定对应 `project-integration-implementation-guide.md` 的 M3.5/M3.6，并把真实 60～90 秒闭环验收提升为 M6；在 M3.5 POC 完成前，不把任何 H3 custom node 直接写入主工作流。

### 7.1 用户故事：从小说到可交付短剧

以下用户故事是页面设计和接口验收的主线。用户不应该理解 `runId`、ComfyUI prompt 或某个模板文件的目录结构，
页面要围绕“我正在制作哪一部剧、现在做到哪一集哪一镜、下一步需要我确认什么”来组织。

#### 故事 A：创建一部剧并完成规划

用户进入「项目」页，点击「新建短剧项目」，填写剧名、导入小说或剧本文件，选择默认比例、单集时长、目标集数和本地/外部模型策略。
系统立即创建 Project 和一个默认 Canvas，但只保存原文的 `sourceRevisionId`；页面显示可编辑的规划报告、完成度检查表和预计资源成本。

用户可以选择一个短剧模板（角色设定板、场景板、分镜板、默认七阶段 Workflow），模板只复制结构、提示词和参数，不复制历史产物。
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
| **P0-a** | 建立 Project 内核：服务端 Project/Episode/Scene/Shot/AssetRef/Canvas 引用、源版本、脚本/分集投影、真实阶段门禁、Project Context API，以及全新的项目总览页骨架 | P0-0 | 创建项目→导入来源→运行脚本并回写 Project/episodes→创建集/镜头→打开画布/任务/素材工作区；刷新或换设备仍能恢复同一项目上下文 |
| **P0-b** | 修 Job→Artifact→GenerationSlot 回写断链，并实现真实阶段状态、取消传播、attempt/idempotency 和可重放投影 | P0-0 | 关键帧完成后 `stage.artifacts` 非空且能驱动下游；部分失败、取消、重启、重跑均不会覆盖旧结果 |
| **P0-c** | run 可恢复：持久化 run/sourceRevision、服务端列表与详情、命名、断点续跑和刷新保护；长篇正文改为版本引用 | P0-a、P0-b | 跑到一半刷新或服务重启，能从项目页找回、取消、续跑并看到原输入版本 |
| **P0-d** | Device/Provider/Tool Registry 与资源调度：区分 GPU 生图、生视频、CPU 后期、LLM、外部 API，增加 schema 驱动参数和 LAN 鉴权/配额；现有注册表只是基础骨架 | P0-0 | 两台设备或两类资源可并行；页面显示排队设备、能力不匹配和成本；取消能释放对应资源；每个 Job 能追溯实际 Tool/Provider/Device |
| **P0-e** | 可逆生产链与影响分析：为源版本、脚本、角色/场景资产、分镜、GenerationSlot、音频 Cue 和交付物建立输入指纹与依赖边；支持按项目/集/场/镜/阶段发起分支重跑，旧产物只读保留 | P0-a、P0-b、P0-c | 修改任意上游内容后能列出受影响对象；用户可选择从指定阶段回马枪；旧版本仍可播放、比较和回退；旧 Job 不能覆盖新 attempt |
| **P0-f** | 制作圣经与确认锁：建立 Project Brief、Series Bible、Character/World/Audio Bible、交付规格和预算快照；每个关键阶段支持 `draft → review → approved → locked`，审批对象带 revision | P0-a、P0-c | 用户能明确确认“采用哪版剧本、角色、场景、声音和分镜”；下游只消费已批准版本；修改已锁对象会产生新 revision，不静默覆盖旧结果 |
| **P0-g** | 内容与工艺质量门禁：结构校验、引用完整性、连续性、时长、口型/对白、音频响度、黑帧/静帧、字幕安全区和交付规格检查统一为可重放 QC Job | P0-b、P0-e | 每个阶段给出可解释的 pass/warn/block；失败项能定位到集/场/镜/音频 Cue；人工可以豁免并留下记录，系统不把风险提示混入正文 |
| **P1-a** | 打通项目产物图谱：Artifact/AssetRef 回写项目，分镜、角色、场景和关键帧可在新工作区互相跳转；必要时提供旧插件数据导入适配器 | P0-a、P0-b | 关键帧进入项目资产无需复制像素；镜头详情可追溯来源、工具、任务和采用候选 |
| **P1-b** | 活扣与批量执行：`GenerationSlot.candidates[]`、分组运行、逐镜重试、并排比较、采用/回退和 Canvas 批量操作 | P0-b、P0-d | 同一镜头使用两个 Tool 生成候选，保留全部历史并可点选采用；整集部分失败可续跑 |
| **P1-c** | 七阶段方法论吸收 + 阶段 0 规划 + `skills/libraries/` 接线，按 Project/Workflow 版本运行 | P0-a、P0-c | 受 `AGENTS.md` 内容创作规范约束；规划、剧本、分镜、资产、角色定妆、关键帧、音频和后期均有确认门禁 |
| **P1-d** | Delivery Executor：CPU ffmpeg 拼接、音频/TTS、字幕、封面、分集/全剧交付包和可复现清单；当前仅完成执行器和接口，尚无成功成片证据 | P0-b、P0-d | 片段全部完成不自动等于成片完成；后期失败可单步重跑并保留日志和中间产物；至少完成一次全链路可播放成片验收 |
| **P1-e** | 完整声音后期：对白/旁白 TTS、音色锚点、口型参考音频、环境声、音效、BGM Cue、降噪/响度/混音、M&E 与多语言音轨 | P0-f、P0-g | 每句对白可追溯到角色、VoiceProfile、文本 revision 和 AudioArtifact；能单独替换音轨而不重做画面；交付前通过同步和响度检查 |
| **P1-f** | 编辑与视觉完成：代理文件、时间线、粗剪/精剪、镜头替换、转场、节奏版本、色彩/画面统一、片头片尾和安全区 | P0-b、P0-e、P0-g | 用户可以在镜头级调整顺序和入出点；重做单镜不破坏剪辑版本；每个交付物保留 timeline/EDL/拼接清单 |
| **P1-g** | 本地化、发布与归档：字幕翻译/校对、配音版本、平台规格预设、封面/元数据、版权/来源清单、项目快照和可离线恢复包 | P1-e、P1-f | 同一项目可输出多个语言和平台版本；每个发布包能追溯内容、模型、工具、Artifact、授权提示和 QC 结果 |
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
5. 人工门禁与自动推进 → **D11**（本轮修订：现阶段开启，后期可全局切换）

本轮待确认项见 `prd.md` §1.4；旧决策表不能视为本轮 PRD 与里程碑已全部定稿。

后续追加：**D12 旧画布数据丢弃、不做迁移**（用户已拍板，见 §7）。

---

## 11. 进度快照与问题台账（2026-10-03 复核）

> 本章回答两个问题：**做到什么程度**、**遇到哪些问题**。§8 写的是「要做什么 + 验收标准」，本章写「实际到哪了」。
> **复核方式**：读代码 + 跑后端测试 + 打接口，不采信 CHANGELOG 自述。
> **复核基线**：本轮提示词策略复核在允许回环监听的受控环境执行 `cd canvas-server && node --test test/*.test.mjs` → 当时 **667 tests / 667 pass / fail 0 / 4.31s**（**2026-10-05 独立复核：860 tests / 860 pass / 0 fail / 5.36s**）。更早的 206/206 是旧快照。
> 问题详情与整改单在 `pilot-issues.md`（只追加、不替换）；本章只做**汇总与分级**。

> ⚠️⚠️ **本节是 2026-10-03 傍晚的快照，下列结论已被后续代码超越。**
> 2026-10-04 由小代**读代码 + 打接口 + 跑测试**逐条复核，权威结论见
> `pilot-issues.md` 的「2026-10-04 第四轮 · 独立验收总账」与 `platform-flow.md` §8。**引用本节前先看这张修正表：**
>
> | §11 原文（旧） | 2026-10-04 复核后的实况 |
> |---|---|
> | 「**D1 时长档位**未落（grep 0 处）」 | **已实现**：`src/durations.js` 全套（含 `/api/durations`），骨架校验已接进 storyboard 阶段 |
> | 「**D3 关键帧单镜 ≥4 张**未落（仍 = 2）」 | **默认已是 4**：`config.js` `maxKeyframesPerShot: 4` |
> | 「关键帧 `start` 没有角色参考图」 | **已注入**：`pipeline.js` 写 `INPUT_IMAGE` + `REF_IMAGE_1..N`，并登记为 AssetRef 供锁定 |
> | 「服化道登记 `artifactIds: []`，没有生成参考图」 | **已生成并绑定**：`attachDesignReferences` / `bindDesignReferenceArtifacts`（仅无 prompt 的绑定留空占位） |
> | 「多 run 时前端只取 `runIds[0]`，第二个不可见」 | **已有 run 选择器**：`use-project-workspace.ts` + `workspace.runSelector` |
> | 「`pipeline.js` **1456 行**全能编排器」 | 实际 **2947 行** |
> | 「阶段 ID 冻结 `plan/script/storyboard/design/keyframe/assembly/post`」 | 运行时注册表实际有 **7 个 run 阶段**（`script`/`storyboard`/`design`/**`casting`**/`keyframe`/**`audio`**/`assembly`，见 `skills/registry.json`）；`plan` 是项目级阶段 0、**`post` 不存在** |
> | 「测试基线 **667/667**」 | 现为 **716/716**（2026-10-04，多轮修复后）→ **860/860**（2026-10-05 独立复核实测，5.36s） |
> | 「P0-f `bible.js` 只有 1 处自引用、**未被任何模块消费**」 | **已被门禁消费**：`gates.js:16` 导入 `BIBLE_KIND_LABEL`/`BIBLE_KIND_STAGE`/`isConsumable`，`gates.js:66-70` 对未批准圣经产出 `blockedBy` |
> | 「#26 渠道表双写者**根因未修**」 | **已修**：`POST /api/llm/providers` 改为按 name 增量 upsert（不删未提及渠道、`apiKey` 空则保留原 key），删除走显式 `DELETE`。`canvas-server/src/index.js:591-645`、登记 `d9e9501` |
> | 「`comfy`/`runninghub` 探测仍在 `/api/health` 里同步等待（#64 只做了一半）」 | **已缓存**：30s TTL + 过期后台刷新 + 单次探测 3s 硬超时；`/api/health` 实测 **1.8~2.4ms** |
> | 「模板 16 个（生图 4 / 编辑 3 / 放大 1 / 视频 8）」 | 现为 **19 个**（image 4 / edit 4 / upscale 1 / video 10），`curl /api/providers` 实测 |
> | 「P0-a/P0-c：从**流水线页**建的 run 不回填 `runIds[]`；多 run 只取 `runIds[0]`」 | **均已修**：服务端建 run 时按 `options.projectId` 幂等追加（`index.js:190`、`projects.js:352`、`pipeline.js:593`）+ 前端 run 选择器（`workspace-layout.tsx:138`）；`workspace-gate-panel.tsx` 已不存在 |
> | 「帧数口径 `24×秒+3` → 5s=123 / 15s=363」 | **此口径是错的**。权威 = 官方工作流自述的 **`17k+5` 网格（向上吸附，24fps）** → **5s=124 / 10s=243 / 15s=362**；`durations.js` 与 `pipeline.js` 已统一（提交 `72ccc88`） |
>
> 其余历史结论（含 §11.3 那句「证据效力只覆盖旧代码版本」的自我提醒）**保持原样**，作为演变记录，不删改。

### 11.1 做到什么程度 —— 对着 §8 工作包逐项对账

图例：✅ 验收达成 ｜ 🟡 主体可用但有明确缺口 ｜ ⬜ 未开始

> ⚠️ **口径校正（2026-10-03）**：本节 P1-c 里提到的「**D1 时长档位**」「**D3 关键帧 ≥4 张**」**不是** §7 决策登记里的 D1/D3（那是「D1 命名：Project=剧」「D3 生产事实：服务端权威」）。它们出自 `pilot-issues.md` 的「**产品负责人拍板（2026-10-03）**」章节，是产品负责人当面的四条硬约束，**条号与 §7 撞号**。引用时请写明来源，避免歧义：
> - **时长档位（pilot-issues D1）**：档位**跟着模型走**（模型能力元数据），`24×秒+3` 后按模型网格吸附；H3 推荐 5/10/15s，实际训练区间与合法长度读取模型元数据（不是仅允许三个秒数）；**先算时长再填内容**，Σ段时长必须等于骨架。
> - **关键帧 ≥4 张（pilot-issues D3）**：单镜一次生成 ≥4 个候选，**不达标自动重新生成**，不停下等人挑。

> **本表于 2026-10-03 傍晚二次复核**（今日下午交付 batch 后）。复核口径：每条都取**运行时一手**（打接口 / 跑测试 / 全仓 grep）；**否定断言一律双范围复核**。本轮实测基线：后端 `node --test` **667/667 pass**、`tsc --noEmit` 0 错、`npm run build` 通过。以下状态列**只代表当前**，与上一版的差异均已在「一手证据」列尾部以 `⟶ 复核` 标出。

| 工作包 | 实际状态 | 一手证据 / 缺口 |
| --- | --- | --- |
| **P0-0** 冻结领域契约 | ✅ | `contracts.js`(6.5KB)、`web/src/types/domain.ts`、`domain-contract.md`；阶段 ID `plan/script/storyboard/design/keyframe/assembly/post` 冻结；D1–D12 登记。⟶ 复核：今日新增 `blocked` 阶段状态与 `Shot.episodeId`，均已同步进契约 |
| **P0-a** Project 内核 | 🟡 | `projects.js` 原子写 + 乐观版本；`/api/projects` 列表/创建/详情/上下文/归档；工作区页 + 门禁。建项目绑定 run 时按 `options.projectId` 幂等追加 `runIds[]`。流水线新增项目/集选择尚未通过用户验收：历史 run 未驱动选择器、集级生成范围未接通、制作事实未完整快照、镜头读取形状有误；具体缺口见 `pipeline-feature-api-inventory.md`。多 run 展示与旧页面收敛亦未完成 |
| **P0-b** Job→Artifact→Slot 回写断链 | ✅ | 终态重放 + `registerArtifacts` 幂等回写；阶段状态以任务终态为准。**活证据**：本项目 keyframe `artifacts=17`、assembly 2 条 clip done。⟶ 复核：今日补上 **keyframe→`episodes[].shots[].generationSlots`** 投影（此前缺失导致 `assembly` 门禁被永挡，见 #48）；幂等守卫「已存在≠已完成」缺陷亦修（#41） |
| **P0-c** run 可恢复 | 🟡 | 异步 run（202）+ `progress.json` + `GET /runs/:id/progress` + 取消贯通 + 断点续跑 + `run.estimate` + 启动 `reconcileRunning()`。项目绑定 run 已回填，前端已有 run 选择器；新增阶段分支入口后，旧 run 与新 run 可分别选择恢复。仍待服务重启和真实分支链的页面验收 |
| **P0 prompt strategy** 模型提示词编译与门禁同源 | ✅ | 模型规则表、编译器、外部 LLM 改写客户端与入队接线已在工作区；阶段运行面板点击前重新读取当前 run 的服务端 `/gates`，服务不可达保持 unknown 不放行。后端 667/667 通过，前端 `tsc` 与 build 通过；DeepSeek `deepseek-flash` 真调用返回 `finishReason=stop/chars=3045`，Qwen 改写器返回 `untranslated=false`；生产重载后 CDP 真实点击关键帧使 job **177→282**，并核对新 `img_qwen21_edit` job 的完整英文 PROMPT。同步降级去重/去旧尾巴、编译快照落盘、重跑强制新编译、撤销候选回退、历史进度旧字数清洗均已验证。仍缺 H3 真实 UI 全文与 #56 返回入口专项交互。 |
| **P0-d** 资源调度与注册表 | 🟡 | `registry.js`(12.4KB) 四类注册表 + 能力路由。缺口：各类 Job 未统一进调度链；音频/TTS 未纳入同一生产契约；设备并行与取消释放无端到端验证 |
| **P0-e** 可逆生产链与影响分析 | 🟡 | `impact.js` 已接 HTTP，可返回 changed/stale/keep 与 revision；新增 `POST /api/pipeline/runs/:id/fork`，按指定阶段保留上游、隔离下游并回填项目 runIds，旧 run 不会被覆盖。工作区已可按当前阶段新建分支并运行；剩余缺口是从影响清单直接定位分支起点，以及旧产物并排比较/回退播放 |
| **P0-f** 制作圣经与确认锁 | 🟡 | `bible.js` 已实现五类实体与 `draft→review→approved→locked` revision 状态机；`gates.js` 已消费未批准圣经并阻断下游。剩余缺口是各类圣经的项目页编辑/审批入口与确认记录展示，不能只依赖接口调用 |
| **P0-g** 内容与工艺质量门禁 | 🟡 | `stage-artifact-check.js` 负责七类阶段结构/引用校验；新增 `quality-check.js`、`GET/POST /api/pipeline/runs/:id/qc`，把阶段问题与实际音频时长、对白重叠/超时汇总为可重放报告，前端视频·后期可手动重跑并展示结果。仍待补齐连续性、响度、黑帧/静帧、字幕安全区、交付规格及人工豁免记录 |
| **P1-a** 项目产物图谱 | 🟡 | ⟶ 复核：缺口①②**已修** —— 资产工作区改为**以服务端 AssetRef 为唯一数据源**（不再读前端本地 store）、补上缩略图与站内弹窗预览、采用状态与切换候选入口（`180b173`）。残留缺口③：角色三视图/场景母版**已进入 AssetRef**（本机 keyframe 参考图 6 条已绑定），但**音色基准尚未进入图谱** |
| **P1-b** 活扣与批量执行 | ✅ | `GenerationSlot.candidates[]` + 逐条 `regenerate` + 模型别名 + 横向候选交互 + 逐镜重试（默认 2）。缺口（未变）：分组（整集）运行与画布批量操作 |
| **P1-c** 七阶段方法论 + 阶段 0 规划 | 🟡 | 阶段 0 预置 + `planSuggestion` 回填；01 `analyze→outline→script`；七阶段技能接方法论库；`normalizeEpisodes` 强制集数对齐；D1 时长元数据与 D3 多候选入队已进入配置/编排。候选不足自动重生成已实现并通过回归；剩余是模型实际时长和候选质量的 GPU 端到端证据 |
| **P0-h** Shot/Take/Approval 与 H3 continuation | 🟡 | `continuation.js` 与视频工作区面板已实现开链、resume、分叉、接缝 QC、人工复核和 take 采用；T2VA→I2VA 尾帧续接已有 4 段 POC 和接口测试。仍待更多 provider 对比、跨段对白/口型和 >4 段漂移验收，不宣称“无限续接” |
| **P1-d** Delivery Executor | 🟡 | `delivery.js` 已实现 ffmpeg concat/xfade、外部音轨、字幕、封面、清单与日志；新增实际音频时长时间轴、对白重叠/超时报告和独立声轨状态。仍需 GPU 真机确认跨镜音色、H3 Talk/独立 TTS A/B 与嘴型同步 |
| **P1-e** 完整声音后期 | 🟡 | `audio.js` + `audio-track.js` + `audio_qwen3_tts` 已接入 `audio` 阶段，VoiceProfile / AudioCue / TTS Job / 响度归一均已有实现；首轮已补 H3/独立 TTS 声音事实源分流、实际音频时长时间轴、对白重叠/超时 QC、字幕与 manifest 同源回写及前端质量状态。**仍待 GPU 人工验收**：H3 Talk 与独立 TTS + lipsync 的 A/B、跨镜声纹听感和嘴型同步；口型同步仍是默认关闭的实验阶段。整改记录见 [`audio-video-quality-audit-2026-10-06.md`](./audio-video-quality-audit-2026-10-06.md)。 |
| **P1-f** 编辑与视觉完成 | 🟡 | 已有 assembly 清单、FCPXML/EDL 与交付包导出，可把结果交给剪映/达芬奇继续编辑；仍无站内版本化 Timeline、代理媒体、粗剪精剪与锁画工作区 |
| **P1-g** 本地化、发布与归档 | ⬜ | 无字幕翻译校对、多语言配音、平台规格包、授权来源清单、可离线恢复包 |
| **P2** 项目复用与清理 | ⬜ | 跨集资产版本、引用计数/清理、离线导出、移除旧兼容层均未开始 |

**当前复核结论**：Project 内核、任务回写、投影、候选活扣、**角色一致性锁**、**片段出片**、**音色合成**、分支 run 与可重放 QC 报告均已有代码和测试；剩余工作集中在 GPU 真机声音/口型验收、影响分析到分支的页面闭环、圣经编辑审批 UI、QC 的技术指标扩展，以及 P0-h continuation、P1-g 本地化发布和 P2 复用清理。D1 模型时长元数据、D3 多候选与不足自动重生成均已实现并通过测试，GPU 端到端证据仍待补齐。


### 11.2 遇到哪些问题（按严重度分级，仅列**当前仍未解决**的）

> 完整历史（含已修复项与四视角会诊结论）见 `pilot-issues.md`。以下只列此刻还压着流程的。

**🔴 阻断级（流程走不通 / 成片不可用）**

| # | 问题 | 现状 |
| --- | --- | --- |
| 22 | **角色形象没有固定下来**（用户 2026-10-03 报） | 「角色一致性」只存在于**文字**：01 让模型输出 `characters[].appearance`，之后每镜把这段文字重复写进提示词。**没有定妆图/参考图锁脸、没有 seed 锁定、没有角色 ID 贯穿到生图**。而 H3 参考图生视频模板（`video_h3_ref2v_image`，一张参考图即可锁角色）**已经具备能力却没被接进来** |
| 23 | **角色音频 / 音色没有固定下来**（用户 2026-10-03 报） | `voice` 字段同样只是**文本描述**（"音色、语速、口音"），**下游零消费**：无 TTS 接线、无音色库、无配音产物。`delivery.js` 有 `amix` 混音能力，但 `plan.audio` **靠外部手工传入**，流水线没有任何环节生产音频轨 |
| 24 | **成片配乐与配音不一致** | 根因未定位（上一轮排查被新诉求打断）。与 #23 同源：音频轨既非流水线产出、也无对齐校验 |
| 25 | **成片 6 镜显存 OOM**（复跑实测） | 复跑 run `run-murpt28o-46f5q` 的 assembly 落 **`partial`**：16 镜前 10 成功、`sh11`–`sh16` 全数 ComfyUI `SamplerCustomAdvanced` 报 **`VBAR OOM`**（147 的 16GB 显存；首次 43 分钟后 OOM、重试 78 秒再 OOM，**非偶发**）。ComfyUI 本身活着（0.38.2 / 16310MB） |
| 26 | **渠道注册表被前端全量覆盖 → 外部 LLM 全废**（实测复现） | 前端 `POST /api/llm/providers` 是**全量替换**写回。2026-10-03 实测：`data/llm-providers.json` 只剩死渠道「默认渠道 → `api.openai.com`（无 key）」，可用的 `deepseek` 被冲掉 → **这就是「画布生成文章疯狂弹认证」的根因**（`/api/llm/providers` 实测 `providers:[]` 式空转 → 生成必 401）；网关日志被「每 8s 一条死渠道告警」刷满。已手动恢复 deepseek 并重启（`/v1/models` 现 10 个含 `deepseek::*`），**根因未修**。方案：服务端网关路由表唯一写者 / 浏览器渠道表浏览器唯一写者，只按 name 显式 upsert，禁止全量替换 |
| 27 | **角色音色与配音没有生产链** | `01` 的 `characters[].voice` 只是音色、语速、口音文字；前端虽有全局 `audioModel/audioVoice` 和 OpenAI 兼容 TTS 模板，项目流水线没有 TTS 阶段、`voiceProfileId` 或对白 `AudioCue`。`delivery.js` 的 `amix` 只能混合调用方手工传入的 `plan.audio` |
| 28 | **角色三视图与场景母版没有成为项目资产** | `03-costume-props` 的技能契约已经声明 `turnaroundArtifactIds`、`referenceArtifactIds`、`sceneMasterArtifactId`、`views`、`confirmed`，但 `pipeline.js:registerDesignAssets` 仍登记 `artifactIds: []`，没有生成/绑定这些参考图；`confirmed` 门禁也还没有完整接入 |
| 29 | **机位描述存在但不可验证** | `02-storyboard` 的 `camera` 字符串要求机位、运镜、焦段、光圈、景深和焦点，`04-keyframes` 会把它交给模型；服务端不拆分校验，也不确认视频 Tool 是否消费这些摄影机约束，换工具后可能静默丢失 |
| 30 | **上游修改不能可靠触发下游失效** | 当前 `regenerate` 只支持生成型阶段单条候选，`setStageInput` 替换整段 JSON；没有 revision 输入指纹、影响分析、stale 状态或分支 run，角色/场景/分镜修改后可能新旧产物混用 |
| 31 | **关键帧跨镜头角色漂移** | `pipeline.js:generativePlan` 的关键帧 `start` 只提交 `PROMPT/WIDTH/HEIGHT/SEED`，没有角色参考图、场景母版或 `characterId`；只有同一镜头的 `end` 帧会引用 `start.artifactUrl`。分镜也没有稳定的角色/地点绑定，模型只能从每镜独立 prompt 猜人物，因此同一个人跨镜头长相、发型和服装会漂移 |
| — | 关键帧 / 视频工作区显示 | 会诊发现 12 行空壳、29 张图不可见；本轮已补「过程时间线」（已提交 `78e390a`）。**后端产物已齐**（keyframe 29 / assembly 10），但**前端 UI 未目视验证**——需打开项目工作区确认时间线真能把 29 张图铺出来 |

**🟡 严重级（能跑但结果错 / 数据不可靠）**

| # | 问题 | 现状 |
| --- | --- | --- |
| — | **多 run 只认第一个 + 跨路径不回填** | `workspace-gate-panel.tsx:40` / `use-project-timeline.ts:20` 硬编码 `runIds[0]`；回填只做在「项目内建 run」路径（`use-project-run.ts:106`），从**流水线页**建的 run 不进 `runIds[]`（实测出片 run `run-murpt28o-46f5q` 即如此）。**注**：会诊原判「`runIds[]` 从未被写」**已失效**，实测 `context.runIds=["run-murnwa81-k27eq"]` 非空 |
| — | 关键帧与分镜对不上 | `shots[5].negativePrompt` 含 `costume change, unnatural transformation`，把正向要求的变身镜用负向词否定；`sh12` 公园抛球实际室内抱狗 |
| — | 「2 集 × 30 秒」无人负责 | 9 个 run `episodes=[]`、分镜 16 镜 83 秒超 38%。`normalizeEpisodes` + 集数进提示词**代码已在**（`pipeline.js:523`/调用点 `814`，含单测），但**端到端尚未验证**——唯一一轮复跑跑的是旧代码（见 §11.1 P1-c 注） |
| — | D1 / D3 两条产品硬约束未落 | 见 11.1 的 P1-c 缺口 |

**🟢 一般 / 改进（不影响正确性）**

- `forwardToLlm`(llm.js L145) 仍用 fetch → 非流式长生成仍可能撞 `headersTimeout`（`chat()` 已改 `node:http`）。
- 147 内存：`num_ctx=32768` 稳态 ~14.9GB / 16GB（余 ~1.5GB），出事故退 16384。
- `pipeline.js` 1456 行「全能编排器」超 `AGENTS.md:24` 约定；通用编排器硬编码阶段 id、`|| []` 吞结构错误（架构视角 D1/D2，均带触发条件）。
- `model-plugin.ts` 1435 行；`projects.js` 兼子模块微型框架。

### 11.3 本轮状态与风险面（交给下一个接手者）

1. **本轮提示词策略与门禁修复仍在工作区待统一提交**。本轮复核：后端 **667/667 pass**、前端 `tsc 0` 错、`npm run build` 通过；生产服务已在确认 GPU 队列空闲后受控重载，并完成真实 CDP 关键帧点击（run job **177→282**）与 Qwen `params.PROMPT` 全文取证。
2. **出片复跑已结束，但成片没出来**。`run-murpt28o-46f5q` 落 assembly `partial`（16 镜 10 成 / 6 镜 OOM）。要先出片，顺序是：解决 147 显存（#25，建议先降 480×864 出草稿）→ **逐镜重试 `sh11`–`sh16`**（已有 `regenerate` 能力，不必重跑整条）→ 调 `assemble`。
3. **服务已重启（在确认无在跑 job 后）**：`canvas-server` active @ `127.0.0.1:8788`，`/api/health` ok，当时模板 16 个（2026-10-05 复核：**19 个**）；`/v1/models` 现 **10 个**（8 本地 + `deepseek::deepseek-flash` + `deepseek::deepseek-v4-pro`），那个压了很久的门禁修复顺带生效；外部渠道表已恢复到 `deepseek`（**但前端一保存/一键接入就会再被冲掉**，见 #26）。远端 ComfyUI `192.168.123.147:8188`（0.38.2，活着）。
4. **⚠️ 证据效力提醒（接手者必读）**：`run-murpt28o-46f5q` 是**跨代码版本**的产物 —— 它的 script 段跑的是三段式**之前**的旧代码（`stage.steps` 字段缺失可证）。因此**只能拿它证明**两件事：① P0-b 回写断链已通（keyframe 29 / assembly 10 产物）；② 147 显存 OOM（#25）。**不能**用它评判集数对齐、时长、三段式、styleAnchor 等修复的效果 —— 要评判必须**新建 run 重跑**。本轮新增的 DeepSeek 与 CDP 证据来自 `run-murnwa81-k27eq`，其片段任务在验收后已通过 UI 取消，未保留 GPU 运行任务。

### 11.4 第二轮复跑结论（run `run-murpt28o-46f5q`，2026-10-03）

> 这是整改后的第一轮端到端复跑，也是**唯一**一轮。它跑通了五阶段，但**成片没出来**。

| 阶段 | 终态 | 产物 | 实测细节 |
| --- | --- | --- | --- |
| plan | —（无阶段） | — | 阶段 0 由项目设定提供：`episodeCount=2`、`episodeDurationSec=30`、`ratio=9:16`、`visualStyle=二维动画`、`tone=治愈`、`genre=都市奇幻` |
| script | done | 0 | `characters=2`（小猫/大姐姐、小狗）、`scenes=3`、**`episodes=[]`**；`planSuggestion` 回填 5 个字段（genre/tone/visualStyle/dramaMode/audience，**不含集数/时长**）。**跑的是旧代码** —— 无 `stage.steps`、`warnings=null` |
| storyboard | done | 0 | **16 镜、合计 83 秒**（目标 2×30=60 秒，**超 38%**）；每镜含 `shotSize/camera/action/dialogue/audio/prompt/negativePrompt` |
| design | done | 0 | 2 个角色造型（小猫/大姐姐、小狗） |
| keyframe | ✅ done | **29** | 真实出图 —— P0-b 回写断链修复的活证据 |
| assembly | ❌ **partial** | **10** | `sh1`–`sh10` ✅（每个 clip 带 `candidates[]`/`selected`）、`sh11`–`sh16` 全数 `VBAR OOM`；`assembly.output.assembly.status = queued`，**成片未合** |

**结论**：五阶段**跑通到片段这一层**，成片为止未交付。想再往前走，按这个顺序：

1. **解决 147 显存**（#25）—— 建议先把片段分辨率降到 480×864 出草稿，或改为一镜一清显存；
2. **逐镜重试 `sh11`–`sh16`** —— 用已有的逐条 `regenerate`，不要重跑整条；
3. **调 `assemble`** —— 片段齐了才能出片（这是设计行为，`partial` 时接口会拒）；
4. **想验证集数 / 时长 / 三段式 / styleAnchor**，**必须新建 run** —— 本轮的 script 段是旧代码，证明不了任何事（见 §11.3 第 4 条）。

### 11.5 本轮代码 Review 补充：声音、美术资产与可逆生产链（2026-10-03）

#### 11.5.1 声音不是通用配置，而是三种不同生产对象

当前已有三条能力路线，但被一个全局 `audioModel / audioVoice / audioFormat` 配置混在一起：

| 路线 | 当前能力 | 当前缺口 | 正确的生产对象 |
| --- | --- | --- | --- |
| 本地短视频 | `video_h3_talk` 可将 `TTS_TEXT`、`TTS_SPEAKER` 和画面一起生成；H3 工作流也能输出原生音频 | 没有项目级角色音色锚点；视频内嵌音频与后期对白无法独立替换；尚未进入 Project 产物图 | `VoiceProfile` + `AudioCue` + 带 `audioMode` 的视频 Tool |
| 外部短剧视频 | 前端有 OpenAI 兼容 `/v1/audio/speech`，外部视频接口也有 `generate_audio` / 参考音频参数 | 流水线没有调用 TTS；`voice` 只是剧本文字字段；外部视频的内嵌音频不可证明跨镜一致 | 独立 TTS `AudioArtifact`，再与视频合成；外部视频音频只作为可选候选 |
| 后期声音 | `delivery.js` 支持 `amix`，但 `plan.audio` 由调用方手工传入 | 没有对白、旁白、音效、BGM 的 Cue Sheet 和时间轴校验 | `AudioTrack` / `AudioCue`，由后期阶段按镜头边界混音 |

因此，`audioModel` 只能保留给画布中的快速单次生成。项目生产配置必须改为按能力与阶段快照保存：

```js
const productionAudio = {
  dialogue: {
    toolId: "tts.qwen3.customVoice",       // 本地或外部 TTS Tool
    providerId: "lan-comfyui",
    voiceProfileId: "vp_c1",
    mode: "separate_track",                // separate_track | embedded
  },
  music: { toolId: "music.external", providerId: "api-main" },
  sfx: { toolId: "sfx.local", providerId: "lan-comfyui" },
  mix: { toolId: "ffmpeg.mix", providerId: "local-cpu" },
};

const voiceProfile = {
  id: "vp_c1",
  characterId: "c1",
  language: "zh-CN",
  speaker: "Serena",
  design: "成年女性，清亮、克制、语速偏慢，紧张时尾音上扬",
  referenceArtifactId: "art_voice_c1_anchor",
  version: 1,
};
```

短剧默认采用“独立对白轨”作为事实源：视频 Tool 可以生成原生声音，但进入后期前要抽取为候选并允许替换；最终成片以 `AudioCue` 混音结果为准。这样本地 H3 和外部视频 API 都能接入同一条交付链。

#### 11.5.2 角色三视图、场景资产和机位的现状

- `skills/03-costume-props/SKILL.md` 已定义角色服装、妆容、发型、道具和场景空场陈设；方法论文档还要求正面特写加正/侧/背三视图。
- `03-costume-props` 的技能契约已经补上 `turnaroundArtifactIds`、`referenceArtifactIds`、`sceneMasterArtifactId`、`views`、`confirmed` 字段，但当前运行时只把角色/场景登记成空 `AssetRef`（`artifactIds: []`），没有自动生成或绑定参考图，也没有把确认状态可靠地接到关键帧门禁。
- `skills/02-storyboard/SKILL.md` 已要求 `camera` 携带机位、运镜、焦段、光圈、景深、焦点和光源方向；但它仍是一个长字符串，服务端没有拆分、校验或把这些字段映射到视频 Tool 的独立参数。
- `04-keyframes` 会读取 `design` 和 `storyboard`，但 `pipeline.js:generativePlan` 的关键帧 `start` 任务只提交文字 `PROMPT` 和采样参数，不会自动把角色三视图、正脸特写或场景母版作为 `REF_IMAGE_*`/`INPUT_IMAGE` 传给生图模板；只有同镜 `end` 帧引用本镜 `start`。默认每镜最多 2 帧，也未满足计划中的 D3「每镜至少 4 张」约束。

整改后的资产链应明确为：

```text
角色文字设定 → 角色三视图/特写 → 用户确认 → Character AssetRef
场景文字设定 → 空场母版/关键视角图 → 用户确认 → Scene AssetRef
分镜 camera 结构化 → 关键帧 prompt + 视频 Tool camera 参数
```

示例目标结构：

```js
const characterRef = {
  id: "aref_c1",
  role: "character",
  bindingId: "c1",
  artifactIds: ["art_c1_turnaround", "art_c1_closeup"],
  selectedArtifactId: "art_c1_turnaround",
  metadata: { views: ["front", "three_quarter", "side", "back"], confirmed: true },
};

const shotCamera = {
  position: "subject-front-right",
  height: "chest",
  angle: "15deg-up",
  lens: "50mm",
  aperture: "f2.8",
  focus: { from: "door", to: "face", atSec: 2.2 },
  movement: { type: "dolly", direction: "forward", speed: "slow", stabilization: "steady" },
};
```

`storyboard.camera` 可以作为旧字段继续读取，但新写入应生成上述结构；没有结构化相机数据时，项目只能提示风险，不能宣称机位已被工具可靠执行。

#### 11.5.4 关键帧角色一致性的阻断诊断

这次用户发现的“同一个人在不同镜头长得不一样”已经可以确定为架构缺陷，具体链路如下：

```text
角色文字 appearance
  → 03 服化道文字 prompt
  → 02 每镜 prompt（模型重新改写）
  → 04 每镜独立 start 文生图
  → 05 才使用本镜 start，不再有机会修正跨镜身份
```

当前链路缺少四个必要环节：

1. **参考图没有生成并锁定**：设计阶段虽然声明了三视图字段，但运行时是空 ArtifactRef。
2. **镜头没有角色绑定**：`Shot` 只有 `sceneId` 和自由文本 prompt，没有稳定的 `characterIds`/`locationId` 映射；关键帧无法知道该取哪些参考图。
3. **生图 Tool 没有收到参考图**：`generativePlan` 不填 `REF_IMAGE_*`，也没有 IP-Adapter、参考图编辑或其它身份锁定适配器。
4. **没有一致性 QC**：生成后没有把新图与角色基准图进行相似度/人工确认，漂移图片仍会进入下一阶段。

修复必须按顺序执行，单独增加提示词里的外观描述不能解决问题：

```text
角色资产生成 → 用户确认 → ShotBinding 投影
ShotBinding(characterIds/locationId) → 解析 AssetRef.selectedArtifactId
ToolAdapter(referenceImages + prompt + seed) → 关键帧 start
身份/服装/场景 QC → 通过后才允许进入后续镜头或视频阶段
```

为避免破坏现有 02 阶段 11 字段契约，第一版不直接给 `shots[]` 加字段，而是增加独立的项目投影：

```js
const shotBinding = {
  shotId: "sh_12",
  characterIds: ["c1", "c2"],
  locationId: "loc1",
  propIds: ["prop_phone_01"],
  assetRevision: { c1: 3, loc1: 2 },
};

const refs = resolveSelectedArtifacts(shotBinding);
const params = {
  PROMPT: buildShotPrompt({ shot, design, camera }),
  REF_IMAGE_1: refs.character[0].url,
  REF_IMAGE_2: refs.character[1].url,
  REF_IMAGE_3: refs.scene[0].url,
  SEED: stableSeed(projectId, shot.id, shotBinding.assetRevision),
};
```

不同 Tool 的参考图能力必须由适配器声明：支持 `REF_IMAGE_*` 的模板直接映射；只支持 `INPUT_IMAGE` 的模板采用角色基准合成参考板或改用支持参考图的模板；完全不支持参考图的 Tool 必须在门禁中标为 `unavailable`，不能假装已经锁定角色。

最小验收标准：同一角色至少 3 个不同场景、不同景别的关键帧中，角色基准图、服装版本、发型和绑定道具通过人工确认；关键帧任务记录 `characterIds`、参考 Artifact IDs、资产 revision、seed 和 Tool；任何一项缺失，阶段只能是 `blocked` 或 `warning`，不能标记为可进入视频阶段。

#### 11.5.3 “回马枪”当前支持范围

当前实现有三种局部重做能力：

1. 生成型阶段的 `regenerate` 可以对单个关键帧或片段追加候选，旧候选保留；适合换模型、换参数、处理单镜 OOM。
2. `setStageInput` 可以人工替换某个阶段的完整 JSON；适合人工修订后继续下游。
3. assembly 使用新的 attempt 目录，旧成片不会被覆盖。

这些能力还不能组成完整回马枪。脚本、分镜、角色资产或场景资产发生变化时，系统没有可靠的依赖图来计算受影响镜头；Project 也没有把“当前产物基于哪个 revision”写入每个 Job/Artifact。因此当前行为可能出现旧关键帧、旧视频和新分镜混用。

回马枪必须遵守四条规则：

1. **旧结果永不覆盖**：每次修改创建新的 revision/attempt，旧 Artifact 只读保留。
2. **先算影响范围再入队**：用户看到将被标记为 stale 的集、场、镜、音频 Cue 和交付物，可缩小范围后再运行。
3. **下游按输入指纹失效**：只有输入 revision、上游 Artifact 选择、Tool 参数均相同，才允许复用；否则标记 stale。
4. **新旧链可比较和回退**：Project 记录当前选中的 workflow run/Artifact，历史 run 仍可打开、预览和恢复。

目标接口与投影逻辑示例：

```js
// POST /api/projects/:projectId/reruns
// { scope: "shot", shotIds: ["sh_12"], fromStage: "keyframe", reason: "修改角色三视图" }
const plan = impact.plan({
  projectId,
  sourceRevisionId,
  changed: [{ type: "assetRef", id: "aref_c1", revision: 2 }],
});
// plan.stale = ["sh_12", "sh_13", ...]; plan.keep = 已确认且不受影响的镜头
const workflowRun = runs.createBranch({ parentRunId, inputRevisionId: sourceRevisionId, scope: plan.stale });
jobs.enqueue(plan.stale.map((shotId) => ({ shotId, workflowRunId: workflowRun.id })));
```

```js
function isReusable(output, input) {
  return output.inputFingerprint === fingerprint(input)
    && output.status === "done"
    && output.selectedArtifactId;
}

function markStale(project, changedIds) {
  for (const ref of project.assetRefs) {
    if (changedIds.includes(ref.bindingId)) ref.status = "stale";
  }
  for (const episode of project.episodes) {
    for (const scene of episode.scenes ?? []) {
      for (const shot of scene.shots ?? []) {
        if (shotDependsOn(shot, changedIds)) shot.status = "stale";
      }
    }
  }
}
```

`stale` 是当前结果的派生状态，不等于删除，也不等于失败；只有新 attempt 生成并通过人工门禁后，Project 才切换 `selected` 指针。

### 12. Review 后的整改顺序与关键逻辑示例

本轮审计后的执行顺序调整为：

1. **P0：Project 事实链**——脚本/episodes 投影、明确门禁、分镜 PATCH 路由、sourceRevision 引用。
2. **P0：角色/场景参考锁**——真正生成并确认三视图、正脸特写、场景母版，建立 ShotBinding 和 AssetRef selected 指针。
3. **P0：关键帧一致性链**——关键帧 start 必须按 ShotBinding 注入参考 Artifact；Tool 不支持参考图时明确阻断；增加跨镜身份/服装/场景 QC。
4. **P0：可逆执行链（P0-e）**——revision、输入指纹、影响分析、stale、分支 run、旧结果只读。
5. **P0：音频生产链**——VoiceProfile、TTS Tool、AudioCue、独立对白轨、声画对齐门禁；默认不依赖口型同步，H3 Talk/MuseTalk/LatentSync 作为可选增强。
6. **P1：结构化摄影机**——从 `camera` 字符串逐步升级为可校验对象，并按 Tool 能力映射或明确提示“不支持”。
7. **P1：统一调度与交付**——本地短视频、外部短剧、TTS、音乐、音效和 CPU 混音全部使用同一 Job/Artifact/AssetRef 契约。

最低验收场景：用户修改一个主角的三视图后，系统只将引用该角色的镜头、对白 Cue、相关片段和成片标记为 stale；用户选择从关键帧阶段重跑；旧版本仍可播放，新版本完成后才切换项目当前版本。修改一个镜头的机位时，只影响该镜及其视频、对白口型和交付片段，不重跑整部剧。

## 13. 全生产链主动审计：当前计划还缺什么

当前七阶段流水线覆盖“剧本 → 分镜 → 视觉资产 → 角色定妆 → 关键帧 → 音频 → 片段合成”。一套可以稳定生产短视频和短剧的平台还必须覆盖制片、编辑、质检、本地化和发布。下面按用户真正经历的生产周期重新盘点；“技能文档已有”不等于“系统已实现”。

### 13.1 立项与制作规格

缺少一个可以约束全项目的 `ProjectBrief`。创建项目时还应明确：目标市场和语言、发行平台、画幅和分辨率、集数与单集时长、内容分级、预算/额度、交付格式、是否需要字幕/配音/M&E、使用本地能力还是外部 API，以及哪些素材拥有可用授权。

这些字段现在分散在项目表、全局配置、页面默认值和人工记忆中，导致同一项目可能用不同画幅、语言、音频策略和视频模型运行。`ProjectBrief` 应在 Project 创建时保存，后续所有 WorkflowRun 只引用并快照它。

```js
const projectBrief = {
  market: "global",
  languages: ["zh-CN", "en-US"],
  platformProfiles: ["vertical-short-drama-9x16"],
  episodeCount: 2,
  episodeDurationSec: 30,
  visualMode: "external_video_api", // local_short | external_drama | hybrid
  audioMode: "separate_dialogue_track",
  delivery: { video: "h264-aac-mp4", subtitles: ["vtt", "srt"], cover: true },
  budget: { maxJobs: 200, maxExternalCredits: 50 },
  rights: [{ scope: "source", status: "to_review" }],
  version: 1,
};
```

### 13.2 内容开发与“圣经”

现在有剧本人物 `appearance/voice` 和服化道文字，但缺少能长期约束生产的四份稳定文档：

- **Series Bible**：世界观、时间线、叙事规则、人物关系和不可改变事实。
- **Character Bible**：角色身份、外观、三视图、服装版本、表演边界、音色和语言习惯。
- **World/Location Bible**：地点、时代、空间结构、空场母版、固定光源、可出现/不可出现的物件。
- **Audio Bible**：角色 VoiceProfile、语言、发音、情绪范围、BGM 方向、环境声和禁用声音。

剧本、分镜、提示词和音频 Cue 都应引用这些文档的 revision。它们不是给模型看的长文本，而是可以被校验、审批、锁定和回滚的项目事实。

### 13.3 预制片：角色、场景、道具与镜头设计

当前 `03-costume-props` 主要产出文字；完整预制片还缺：

1. 角色正脸特写、正/侧/背三视图、表情表、服装版本和关键道具绑定。
2. 场景空场母版、平面/空间关系、关键视角、昼夜/天气版本和固定灯光方向。
3. 道具单实例、材质细节、正反面和跨镜头状态变化。
4. 分镜的镜头轴线、屏幕方向、视线关系、景别、焦段、机位、运镜和镜头衔接校验。
5. 阶段审批：角色与场景未确认，不能直接生成整集关键帧。

`camera` 目前是字符串。短期可以保留兼容读取，长期应拆为 `position / height / angle / lens / focus / movement / lighting`，并在每个视频 Tool 上声明哪些字段能真正执行。不能执行的字段要在 QC 中显示 warning，不能静默丢失。

### 13.4 生成执行：草稿、正式版和本地/外部双路径

本地小视频和外部短剧不应只用一个“视频生成”按钮。它们需要同一套 Job/Artifact 契约、不同的生产 Profile：

| Profile | 适用 | 默认策略 |
| --- | --- | --- |
| `local_short` | 预览、短广告、低成本试拍 | 本地 GPU、低分辨率、快速迭代、可接受内嵌音频 |
| `external_drama` | 正式短剧片段 | 外部视频 API、角色/场景参考图、独立 TTS、严格交付规格 |
| `hybrid` | 本地预演后外部精制 | 本地先验证构图与动作，锁定版本后只把选定镜头送外部 |

每个 Profile 都要保存 Tool、Provider、Device、模型、模板、参数、预算和输入 Artifact 快照。当前模型选择仍有全局配置和项目页面两套入口，无法证明一条镜头到底使用了哪套生产策略。

### 13.5 声音生产

声音要与画面平行建链：

```text
台词/旁白文本 → VoiceProfile → TTS Job → AudioArtifact
镜头 audio cue → 环境声/音效 Job → AudioArtifact
情绪/节奏规划 → BGM Cue → MusicArtifact
视频片段 + AudioCue 时间轴 → 对齐/混音 Job → AudioTrack
AudioTrack + 画面 + 字幕 → Deliverable
```

需要新增的最小对象：

```js
const audioCue = {
  id: "cue_sh12_dialogue_01",
  shotId: "sh12",
  type: "dialogue", // dialogue | narration | sfx | ambience | music
  startSec: 1.2,
  endSec: 3.8,
  text: "你终于来了。",
  characterId: "c1",
  voiceProfileId: "vp_c1",
  artifactId: "art_audio_001",
  status: "approved",
};
```

系统必须检查：对白时长与镜头时长、角色与 VoiceProfile、口型参考音频、字幕文本、音频采样率、峰值/响度、对白和 BGM 的压混关系。`delivery.js` 当前的 `amix` 只能作为最后一步执行器，不能代替这些生产对象。

### 13.6 编辑与视觉完成

生成片段不是成片。还缺少一个真正的项目时间线：

- 代理视频和正式视频的替换关系。
- 镜头入点、出点、速度、转场和版本化剪辑。
- 粗剪、精剪、锁画三个阶段。
- 画面裁切、画幅适配、色彩统一、片头片尾和安全区。
- 音频轨与视频轨的锁定关系。
- 可以只替换一个镜头而不破坏已确认剪辑版本。

当前 assembly 清单能完成拼接，但还不能承担剪辑工程；应增加 `TimelineRevision`，让交付物引用明确的镜头顺序、时间范围、转场、音轨和字幕版本。

### 13.7 质量检查与人工确认

需要把质量检查拆成两类，且都要进入项目记录：

| 类型 | 检查内容 | 失败后的行为 |
| --- | --- | --- |
| 内容/连续性 | 角色身份、服装、道具、场景、轴线、视线、动作承接、台词、机位和风格锚点 | 标记具体镜头或 Cue，允许人工确认/退回 |
| 技术/交付 | 文件可读、分辨率、帧率、时长、黑帧、静帧、无声、响度、字幕安全区、编码、封面和文件命名 | 阻止发布，保留日志和可重跑 QC Job |

QC 不应只在最终导出时执行。每个阶段都应有自己的门禁结果，并记录检查器版本、输入 revision、豁免人和时间。

### 13.8 本地化、发行和归档

面向海外发行时，成片之后还缺：

- 字幕翻译、术语表、时间轴重排、双人校对。
- 多语言 TTS/配音和 M&E（无对白音乐音效）版本。
- 平台规格预设、封面、标题、简介、标签和内容分级信息。
- 音乐、素材、模型和外部 API 的来源/授权记录。
- 可离线恢复包：Project JSON、源版本、Workflow、Prompt、Artifact 清单、Timeline、字幕、音轨和 QC 报告。

发布包不是复制几个 mp4 文件；它必须能够回答“这个版本由哪一版脚本、哪一版角色设定、哪一套模型和哪一次音频混音产生”。

### 13.9 运营与故障恢复

平台还缺少制片运营层：外部 API 预算、局域网设备健康、任务优先级、预计等待、失败分类、重试成本、磁盘空间、备份、审计日志和密钥隔离。特别是外部短剧生产，不能把 API 额度消耗隐藏在一次“重新生成”按钮后面。

最低运行记录应包含：

```js
const provenance = {
  projectId,
  workflowRunId,
  inputRevisions: { script: "rev_12", design: "rev_8", audio: "rev_3" },
  toolSnapshot: { toolId: "video.external.v1", providerId: "provider_a", model: "model_x" },
  deviceId: null,
  costEstimate: { localGpuSec: 0, externalCredits: 2.4 },
  startedAt: "2026-10-03T12:00:00.000Z",
};
```

这份全链路审计把后续重点从“继续增加更多生成模板”调整为“先补生产事实、审批、声音、编辑、QC 和发布闭环”。模板数量只有在这些环节能追踪、能回退、能验收后才会转化为稳定产能。

### 11.6 提示词策略层第二轮验收收口（2026-10-03）

此前关键帧路径的验收记录：后端测试 **667/667 通过（约 4.31 秒）**，前端 `tsc --noEmit` 与 `npm run build` 通过；构建产物中不存在「预览提示词」「未强化」及对应英文 key。生产服务在确认远端 GPU 队列为空后完成受控重载，`/api/health` 返回正常。这些记录不代表下述新问题已解决，也不覆盖后续未验收的工作区改动。

真实 CDP 页面点击关键帧按钮前，该 run 有 177 个历史 job；点击后增至 282 个，新增任务使用 `img_qwen21_edit`。抽取任务 `run-murvf1vq-aqyqm-sh17-start-musdrodb-14d74` 的 `params.PROMPT` 为 2785 字单一英文正文：无重复风格锚点、无中英混写、无旧英文尾巴、无 `[untranslated]`。同一轮的降级条目 `sh17-end` 使用 470 字结构化中文，warning 留在 job meta，标记未进入模型输入。点击取消后阶段为 `partial`，旧 QC 通过候选仍保留，147 队列回到 `running=[] / pending=[]`。

任务参数继续采用创建时快照；阶段重跑与逐条 regenerate 强制创建新 attempt 并重新编译，旧 job 不被覆盖。历史 `progress.json` 中的旧「提示词 N 字」后缀由前端兼容清洗，真实页面刷新后只显示「模型生成中」。H3 真实入队提示词全文已于 2026-10-04 取证（`h3-i2v-ui-evidence.md`）；仍待单独补测的只有带台词镜头的视频逐字台词，以及生图工作台「正在生成中 N 张」返回入口的专项 CDP 交互。

### 11.7 当前问题登记：健康检查边界与生产事实

**状态：部分整改完成（2026-10-03 夜），2026-10-04 收口移交。** 产品负责人就「外部模型探测」拍板：**探测不实用，模型清单只读注册表**（见 `model-registry-contract.md` §3.1）。据此 LLM 侧探测链路（`probeLlm`/`listLlmModels`/`modelsAt`/探测缓存/`config.llm.probeTimeoutMs`）已整条删除，四处清单接口改为读注册表静态展开；「画幅校正尝试」已由**只检测不改稿**的 `aspectRatioConflict()` 取代。后端 `node --test test/*.test.mjs` → 当时 **673/673**（4.46s；2026-10-05 复核 **860/860**、5.36s）。~~**残留**：`comfy`/`runninghub` 仍是同步探测（存活接口还会等这两项）~~ → **2026-10-05 复核：已改 30s TTL 缓存 + 后台刷新 + 3s 硬超时，实测约 2ms**；画幅与 H3 视频提示词仍缺真实任务验收。本轮维护到此结束，移交清单见 `HANDOFF.md`「2026-10-04 本轮结论」与 `pilot-issues.md` #64–#67。

#### P0：网关存活、依赖连通与生产就绪混为一谈

当前调用链（依据 `src/index.js`、`src/providers/llm.js`、`src/providers/comfy.js` 与前端 `gateway.ts`）：

- 浏览器通过 `/api/health` 判断网关连接，请求超时为 8 秒。
- `/api/health` 等待 LLM、ComfyUI 和 RunningHub 三项探测全部结束后才返回。
- LLM 探测请求主地址及 fallback 的 `/v1/models`、`/api/tags`，有模型列表即视为可用；这不能证明指定模型已加载或聊天生成成功，也不应默认发送生成请求。
- ComfyUI 探测请求 `/system_stats`；它不能证明目标工作流、模型文件及显存条件已满足。本接口的 `queue` 是网关 Job 计数，不是远端 `/queue` 的实时快照。
- 总体 `ok` 为 `llm.ok || comfy.ok`，HTTP 仍返回 200。两者任一在线不能证明整条生产链可用；两者都离线也不意味着网关进程停止。
- 原有外部渠道探测可能拖慢响应；用户报告 14 次探测中 2 次失败。该现象与等待上游、前端 8 秒超时的结构性冲突一致，但每次失败的具体来源和耗时仍需取证，不能断言 Node 进程崩溃。

**整改策略**：网关存活接口只报告本进程可响应及内部状态，不等待任何上游网络请求。LLM、ComfyUI、外部渠道分别保留依赖状态（状态、检查时间、检查方法、错误）；探测由显式刷新或后台机制执行。未检查、过期、不可达、已发现模型必须可区分；实际生成成功单独记录，模型列表非空不冒充生成能力。阶段可运行性继续由服务端 `/gates` 结合实际 Tool、Provider 和输入产物判断，不由一个全局 `ok` 决定。

优先实现调用边界解耦，避免只靠新增缓存、冷却或重试掩盖问题。后台周期、缓存有效期与超时属于行为参数，实施前需说明默认值与失败处理并确认；当前尝试中的数值不是已批准的产品契约。

**验收**：模拟外部死渠道、本地 LLM 离线、ComfyUI 离线及 GPU 忙碌，网关存活接口均能独立响应；页面保持网关在线并分别显示依赖状态。读取模型列表不触发推理或加载模型；生成探测只能显式发起并说明成本。记录前端超时与各依赖耗时，证明依赖失败没有被显示成网关离线。

**本轮落地**：LLM 侧探测整条删除（含探测缓存 —— 按「不靠缓存掩盖问题」的口径，缓存失去存在理由）；`/v1/models`、`/api/llm/models`、`/api/providers.llm.models`、`/api/health.llm` 改为读注册表静态清单，读清单**零网络请求**（HTTP 层测试断言上游 stub 的 `/v1/models`、`/api/tags` 命中数为 0）。`/api/health` 的 `ok` 改成存活语义并新增 `service` 段；`llm` 段带 `source:"registry"`、`probed:false`，前端「测试连接」的 LLM 行改显示「已登记 N 个文本模型（不探测连通性）」，不再把「已登记」谎报成「已连通」。**未做**：`comfy`/`runninghub` 探测仍在存活接口里同步等待，生成就绪度（generation readiness）仍未与依赖连通分离。

#### P0：改写器擅自改变项目画幅

用户已验证竖屏项目的改写稿出现横屏描述。画幅属于项目生产事实，应与分辨率、参考图槽位一起快照进入编译输入；改写器只能表达事实，不能猜测或覆盖。最终模型参数、提示词构图与项目画幅须一致。文本替换 `horizontal` 只是未验收的尝试，不作为最终策略，避免误伤“横向移动”等合法描述。

**验收**：从真实页面生成新任务，逐项核对项目画幅、改写输入、最终 `params.PROMPT` 和实际尺寸参数；覆盖竖屏、横屏与非 9:16 比例。冲突时保留排查 warning，不把错误方向交给生成模型，也不在前端暴露改写层。

**本轮落地**：文本手术（`enforceAspectRatio`）已删除 —— 它改不干净时会在开头补一句竖屏、正文仍留横屏，把自相矛盾的稿子发给模型。改为**只检测不改稿**：画幅以「不可改写事实」单独一行进改写源文本；`aspectRatioConflict()` 用三条判定识别相反画幅（相反的显式比例 / 方向词与构图名词紧邻 / 首句「画面主语+系动词+方向词」），命中即整稿弃用 → 回落同步结构稿 + 写 `item.warning`（后端可见、前端不暴露）。17 条真实句式取证：实测故障句被抓；`horizontal pan`、`a horizontal band of sky`、`a portrait of a man`（人像）不误伤。**未做**：真实任务的竖屏/横屏/非 9:16 三种画幅逐项验收。

#### 验证缺口：H3 i2v 新任务提示词

目前缺少新代码通过真实 UI 入队的视频 `params.PROMPT` 全文；旧任务快照或编译器干跑不能替代该证据。暂不据此判定视频编译路径损坏。已选中关键帧完成的历史运行，但队列检查发现远端正在执行一个关键帧任务，未点击视频生成叠加任务。

**验收**：使用隔离实例与独立测试页面，队列空闲时通过真实页面触发片段生成，记录点击前后 Job 增量、Job ID、模板、编译输入指纹与完整 PROMPT。按权威调研核对关键帧对齐行、两位小数时间、三字段固定顺序、`<Picture 1>`、运镜、说话人、逐字台词、目标总时长与画幅；保留证据后结束测试任务。生产重载另行安排，不能与占用中的队列冲突。

**本轮落地**：已按上述口径取证，全文与逐项核对见 `h3-i2v-ui-evidence.md` —— 独立 headless 测试页（不碰人工标签）在「片段合成」条目上点「换个模型再出一张 → H3 图生视频」，jobs 488→489，新 job `run-murpt28o-46f5q-sh1-clip-musnttqs-fhw1j` 的 PROMPT 为三段式新稿（对齐行 `0.00` 两位小数、`<Picture 1>`、运镜自然句、`non_diegetic_music: N/A`、`vertical portrait / 9:16` 与项目画幅一致、`LENGTH=90` 帧为 4s@24fps 的 H3 帧网格），同条目旧 job 的旧拼法并存可对照；取证后即撤销、队列归零。**残留**：带台词镜头的视频逐字台词（`(S1)` + `<d>[English]…</d>`）尚未取证。


---

## 11.8 提示词策略层「统一化」改造方案（2026-10-05 登记）

> **触发**：产品负责人口径 —— 「用户只管提内容要求；系统要能联系上下文自动补全这个模型需要的内容，
> 把素材和信息交给一个**全能的提示词接口**，让它翻译成该模型需要的标准」。
> **依据**：同一镜头对 9 模板真编译倒查（`pilot-issues.md` 第七轮 #82–#95，全部一手证据）。
> **状态**：方案已登记，**待产品负责人过 M1 基准后再动代码**。

### 11.8.0 一句话目标

**用户不需要知道任何模型规则。** 后端在「发起生成请求」那一刻，把上下文里该有的要素自动补齐，
交给**同一个提示词出口**，由它按**该模型的官方契约**产出标准提示词。
**模型差异只体现在「官方契约文本 + 参数档」上，不体现在代码分支上** —— 新增模型 = 加数据，不写代码。

### 11.8.1 现状三个病根（对应台账 #82–#86）

| 病根 | 表现 | 一手证据 |
| --- | --- | --- |
| **① 没有「要素」这一层** | 规则表只登记「语言 / 负面 / 画面内文字」三条**属性**，没有登记「该模型官方要求画面必须交代哪些**要素**」。于是只能靠人在编译函数里想起一条写一条 —— `lighting` 就是这么漏的（政策里声明了、编译器不产出） | `prompt_tier_policy.tier_two` 含 `lighting`；`prompt-compiler.js` 全文无从 shot/scene 取光线的代码（#88） |
| **② 编译器按模型 if/else 分派 + 每模型一个手写拼装函数** | 加模型、改要素都要改代码；通用兜底只吃「分镜手写稿」（`legacyBody`），**不吃结构化事实** → 没有手写稿时产出是空壳 | 同镜头真编译：Qwen-2.1 **3273** 字符 vs Z-Image / Boogu / Wan-Animate 各 **88** 字符（#82） |
| **③ 官方改写器被当成一个整体** | 没有按官方自己的**任务分工**（T2I / Edit）与**用途**（翻译 / 扩写）分派：编辑模板误用 PE-T2I；双语模型的改写器因 `translate_to !== 'en'` 永远不可达 | #85（`prompt-compiler.js:1425/1504` 缺任务标记 → 变体恒为 `pe_t2i`）、#86（5 套资产只有 1 套在跑） |

### 11.8.2 目标架构

```
用户要求 + 项目上下文（shot / scene / characters / plan / slots / assetRefs）
        │
        ▼
① 要素表        每模型一份，机器可读，逐条带「官方出处」
② 补全器        按要素表逐项从上下文取：直接取 / 规则推导 / 推不出→显式标缺（绝不编造）
        │
        ▼
③ 「素材 + 信息」包（模型无关）
        │
        ▼
④ 单一出口      system = 该模型官方契约；user = 素材包  →  该模型要的标准提示词
                （失败回落结构化稿 + 标记，不阻塞提交、不在界面暴露）
```

### 11.8.3 三张交付物（改造的基准，写代码前必须先有）

| 交付物 | 内容 | 用途 |
| --- | --- | --- |
| **A. 要素表** `config/model-prompt-elements.json` | 逐模型登记 `required` / `optional` 要素，**每条附官方出处**（官方 repo `文件:行` / 官方系统提示词段落 / 官方文档小节）。**给不出出处的写「未查到官方依据」，不得用通说顶替** | 唯一可对账的基准；以后判「缺不缺核心要素」只看它 |
| **B. 补全映射表** | 要素 ← 上下文来源；每项标注 `直接取` / `规则推导`（如 光照←`scene.time`+内外景+风格锚点）/ `上下文缺 → 标缺` | 补全器的规格 |
| **C. 出口登记表** | 改写器 × 适用任务（t2i / edit / caption）× 用途（翻译 / 扩写 / 编辑指令）× 变体选择条件 | 修 #85/#86 的依据；也是「按任务分派」的判据 |

### 11.8.4 改造清单（产品负责人 2026-10-05 已批）

1. **统一从结构化事实编译** —— 通用兜底也吃 `shot/scene/characters/style/slots`，不再依赖「分镜有没有手写那句」（治 #82）
2. **要素自动补全（含光照）** —— 从 `scene.time` + 内景外景 + 风格锚点推导光线/时间；凑不齐**显式标缺**（治 #88）
3. **一级块按目标语言输出** —— 只吃英文的模型，风格锚点 / 画幅 / 文字子句全给英文，消除中英混写（治 #87）
4. **事实锁扩围** —— 画幅之外，把**时间 / 光照 / 画面文字可见性**也标成「不可改写事实」并加反向校验，被反写则整稿弃用（治 #83/#84）
5. **编辑链路改回 PE-I2I** —— 按任务类型分派变体（治 #85）
6. **UI 补「换个模型再出一张」+ 候选切换** —— 否则产品负责人无法在界面验收（治 #89，PRD §3.3 已要求）

### 11.8.5 落地顺序（每步独立验收，不合并提交）

| 里程碑 | 内容 | 验收方式 |
| --- | --- | --- |
| **M1** | 交付物 A/B/C 三张表（**先给产品负责人过目**） | 逐模型对照官方原文人工核对；基准错了后面全白干 |
| **M2** | 补全器 + 统一编译出口（改造 1–3） | 同一镜头对 19 模板真编译，不得再出现空壳 |
| **M3** | 事实锁扩围 + 校验（改造 4）+ 变体分派（改造 5） | 回归测试 + 真编译各一次（夜景不得变 daylight、必渲染文字不得变 unreadable） |
| **M4** | UI 换模型入口（改造 6） | 真鼠标点击 → 落 job → 刷新后仍在 |
| **M5** | 端到端真跑验收 | ≥3 个生图模型 + ≥1 条视频，抽帧交产品负责人判效果 |

### 11.8.6 验收标准（可复算，不靠自述）

- **覆盖度对账**：逐模板校验 PROMPT 必须包含该模型要素表里 `required` 的全部要素（脚本对账，出报告）
- **不出空壳**：同一镜头对全部模板编译，产出长度分布不再出现「只剩一句画面文字」这一类
- **语言纪律**：只吃英文的模型，PROMPT 中不得出现 CJK 字符
- **事实锁**：`style.anchor` 写明夜戏时，PROMPT 不得出现 `daylight/overcast/day`；`textOverlays` 非空的镜头，对应文字不得被写成 `unreadable/too small to read`
- **可复算**：以上每条都能用 `POST /api/prompt/compile` 重跑复现

### 11.8.7 边界（明确不做）

- **不改内容层产出契约**：分镜仍然只产模型无关事实，模型专属提示词一律后端编译
- **不把「改写」扩成「二次创作」**：补全器只从上下文取数并按规则推导；推不出的**显式标缺**，绝不编造
- **不动已验收的 H3 字段结构**与「台词/画面文字逐字锁」——它现在是唯一跑通并取证过的视频链路
- **不在有任务运行时重启后端**（运维红线，见 `canvas-plus-pipeline` 技能）

## 11.9 质量门与审计日志落地 + 首次全链路 smoke（2026-10-05 晚）

### 11.9.1 本轮落地（已部署，可复算）

| 项 | 内容 | 证据 |
| --- | --- | --- |
| **P0-g 结构 + 引用完整性** | 新增纯函数 `canvas-server/src/stage-artifact-check.js`：七类产物（script / storyboard / design / casting / keyframe / audio / assembly）。**error**：引用断裂（分镜 `sceneId`、关键帧 `shotId`、片段 `keyframeId`、配音 `shotId`、分集 `sceneIds`）、id 重复、帧角色非法、配音时间倒挂 → 阶段 `error`、**产物不落盘**、下游拿不到 `done`；**放过**：可选增强字段缺失、artifact/job 为空、`keyframeId=null`、上游集合缺失 → 只写 `stage.warnings` | commit `02b0eba`；`test/stage-artifact-check.test.mjs` 37 例（20 条击穿 + 防误拦） |
| 接线三处 | `executeStage`（所有阶段，落盘前）、`setStageInput`（人工修订，不合法 400、不覆盖磁盘已有产物）、`executeAssemble`（**只告警，不作废已合成成片**） | `test/stage-artifact-gate.test.mjs` 4 例集成 |
| **追加式审计日志** | 新增 `canvas-server/src/run-log.js` + `GET /api/pipeline/runs/:id/log?limit=`；写 `data/runs/<id>/log.jsonl`（一行一条、永不重写），字段 `at/actor/op/stage/hash/ok/message`，`hash` 为产物内容指纹（阶段无 revision，用它回答「这是哪一版产物」）；写入失败只告警 | `test/run-log.test.mjs` 5 例 + `test/pipeline-log-http.test.mjs` 1 例 |
| 线上真机自检 | 违约产物 → `400 产物未通过契约校验（1 处）：episodes[0].sceneIds：引用的场次「sc9」不存在`；合规产物 → `done`；日志两条（`run.create` / `stage.edit`，带 actor 与指纹）；自检 run 已删除 | 远程 `02b0eba` 部署后实测 |

测试口径：本地 `cd canvas-server && node --test test/*.test.mjs` → **955 用例 / 946 通过 / 1 跳过**；**8 项为本机环境差异**（macOS homebrew ffmpeg 无 libwebp → 4 个缩略图用例、缺真实 `config.json` → deepseek 渠调用例、2 个真机媒体用例），服务器上这 8 项通过。远程对外基线仍记 903/903（本轮新增用例未重算该口径）。

### 11.9.2 真机实测暴露并已修的问题

- **`storyboard.episode_ref` 误报（已修，`5e1d3a4`）**：绑定项目时编排器把 `shots[].episodeId` 归一为**项目侧集 id（`ep_0001`）**，与剧本侧（`ep1`）不同源，拿剧本集合比对必然误报。真机证据：`run-muv6y60o-uesqy` 的 `stage.warnings` 出现该条，而该阶段门与骨架判定均通过。真实问题由 `production-contracts.normalizeShotEpisodeIds` 的 `unresolved / remapped` 告警兜底，本模块不再重复造规则；已补「绑定项目后不得报警」的防回归用例。
- 观察：`stage.warnings` 目前**混着对象与字符串**（既有的 8 条是对象，本轮追加的是字符串），前端又不读该字段，暂无影响，但登记为待统一项。

### 11.9.3 全链路 smoke 现状（进行中）

- **大文本只做分镜验收**（不绑项目，`run-muv6mvcs-ksgz8`）：剧本 done（160s）→ 分镜 done（340s）→ **41 镜 / 205 秒 / 23 场次局部全覆盖 / 门零误拦**。
- **小项目全链路**：`prj_01M45YJN7NFXPQRV8EESK59JQA「[全链路验收] 最后一班」` + `run-muv6y60o-uesqy`（原文 800 字内，plan 1 集 × 45 秒 × 9:16）：

| 阶段 | 状态 | 观测 |
| --- | --- | --- |
| script | ✅ done | 50s |
| storyboard | ✅ done | 120s，**8 镜 / 50 秒 / 2 场次**，门零误拦 |
| design | ✅ done | **12 分钟出 5 张参考图**（2 角色 + 1 场景），`assetRefs` 已登记 |
| casting | ✅ done | 逐角色 `face + voice` 确认后放行（人工拍板点） |
| keyframe | 🔄 running | 8 帧 × 4 候选 = **32 张图入队**；t2i 单张约 30–60 秒 |
| assembly / post | ⏸ 待跑 | 按 8 段 × 5 秒 × H3 ≈ 8 分钟/段估算 ≈ 64 分钟 |
| 资料包 | ⏸ 待跑 | 见 11.9.4 |

### 11.9.4 「标准资料包」还缺的三处（本轮新增登记）

| 缺口 | 现状 | 影响 |
| --- | --- | --- |
| **B 剪辑资料包无入口** | `edit-export.js:654` 的 `exportDeliveryPackage` 只有 CLI（`scripts/export-edit-package.mjs --run <id>`），`index.js` 无路由、`web/` 零引用 | 画布/前端**物理上无法**产出 zip（分集成片 + clips + srt + FCPXML/EDL） |
| **Agent 无流水线工具** | canvas-agent 的 33 个工具全是 `canvas_*` / `workbench_*` / `assets_*` / `prompts_search` | Agent 目前只能操作画布节点，**驱动不了七段流水线、也拿不到资料包**；目标是保留本地桥接并新增 `project_*` 作用域 |
| **无报告渲染层** | 流水线页只渲染原始 JSON，前端不读 `stage.warnings` | 缺「一页可评审」的产物视图（门结果、分镜表、导出按钮无处呈现） |

### 11.9.5 两个数据形态 / 历史故障（务必先看再动手）

- **`project.script` 形态坑**：「喜宴之外」`prj_01M45S6PMAPT56CABAKZAZJC3T` 的 `script` 是 **5751 字 markdown 文本**，而契约要结构化对象 → `normalizeScript` 得到空结构 → **`episodes = 0`**，分镜跑不起来（该项目的 `runs` 也是 0）。同时 **`applyScriptProjection` 会直接覆盖 `project.script`**（`projects.js:407`）→ 在有内容的项目上重跑剧本阶段会**冲掉人写的剧本**，必须先备份或另建 run。
- **视频任务历史全 error**：远程 5 条 `video_h3_i2v` 失败原因均为 `模板 video_h3_i2v 缺少参数：INPUT_IMAGE`（2026-10-04，早于现有「拿不到首帧就不入队」守卫）。新门 `assembly.keyframe_missing` / `keyframe.shot_ref` 会提前把这类状态摆出来。

### 11.9.6 版本控制与部署纪律（本轮修正）

- 远程工作区曾有 **11 个提交从未推给裸仓库**（`/root/repos/canvas-plus.git` 的 HEAD 还停在旧的 `666f0bb`，等于没有备份）。现已推齐：**本地 = 裸仓库 = 远程工作区 = `5e1d3a4`**。
- 另一会话在服务器上的未提交成果（`prompt-sanitize.js` + 测试 + `research/prompt-elements/`）已固定为 `a987cea`，本轮的 `02b0eba` 叠在它之上。
- **部署只走 git**：本地提交 → 推裸仓库 → 远程 `git pull /root/repos/canvas-plus.git canvas-plus`（公网 remote 会因 host key 校验失败）→ `systemctl restart canvas-server`。**不要用 `scripts/sync-remote.sh`**：它是 `rsync -a --delete`，会把服务器上未提交的成果**删掉**。
- 重启前先确认无 running/queued 任务（重启会把在跑任务判失败）。

## 11.10 平台定位与页面职责（待产品负责人拍板，2026-10-05 登记）

> 产品负责人本轮要求：**停下来先想清楚定位**（它决定不同页面放什么功能）、**现阶段与未来的程度**，并捋清 **画布 / 工作流 / 生图工作台 / 生视频工作台** 四者关系，以及**本地模型能力边界与何时该走外部 API**。
> 完整分析见新文档 **`platform-positioning.md`**（草稿 v1，未拍板）。本节只登记结论清单，避免两处写重。

**一句话定位（建议稿）**：本地化的 AI 短剧**前期生产 + 交付打包**平台——把原文做成**能被专业剪辑接手的一集素材包**；图像/视频/音频必须本地，**文本与提示词改写可走云端**（现状已在走），精剪永远交剪映/达芬奇。现阶段只锁一件事：**B 包（剪辑资料包）能出**。

**十条已登记矛盾（C1–C10，详情见 `platform-positioning.md` §3）**

| # | 一句话 |
| --- | --- |
| C1 | 🔴 定位与实现冲突：PRD 写"全内网/数据不出本机"，但**文本链路实际走云端 DeepSeek**（`config.llm.defaultModel='deepseek::deepseek-v4-pro'`，`index.js:88` 兜底注入，路由到 `api.deepseek.com`） |
| C2 | 四页职责无权威定义：只有项目页有定位；**生视频工作台连一段职责描述都没有**；画布与两个工作台功能重叠 |
| C3 | "工作流"一词**五种所指**（契约 DAG / 跑批 run / ComfyUI 模板 / 画布节点图 / registry.json 阶段编排），且 `DP:575` 的"四类注册表"与 `registry.js`（Tool/Provider/Device 三张 Map）**不符** |
| C4 | 文档大面积过期于代码：`PF §8` 已列 9 条；模板数 6 份文档写 11/16，实际 **19**；段数有"五/六/七段"三种说法 |
| C5 | 两套 M1–M5 里程碑同名不同义（`p0a-project-kernel-plan.md:380` vs 本文件 §11.8.5） |
| C6 | BR（`production-boundary-and-roadmap.md`）仍是**草稿 v1**，§7 六条拍板（A–F）没有登记结果 |
| C7 | 🔴 **画布与项目在数据模型上没有关联**：`CanvasProject` 无 `projectId`、`Project.canvasIds` 无写入方、canvas-agent 传的 "projectId" 其实是画布 id、画布资产与服务端 `AssetRef` 双轨、画布产物**不进 `Artifact/AssetRef`**（`/assets`、`/tasks` 看不到）→ **"在画布上产出资料包"在数据层就是断的** |
| C8 | 外部 API 三种形态并存无口径：网关 RunningHub（默认关/未验证）、前端浏览器直连第三方渠道、`canvas-proxy` 旁路 |
| C9 | 契约与实现三方不一致：`domain-contract.md:211` 冻结 6 个阶段 ID，`registry.json` 实为 **7 段**（含 casting/audio），`gates.js` 又没有 casting/audio；前端兜底 `design.requires` 与 registry 冲突 |
| C10 | 三条并行生成提交链：画布直连（无队列/不可恢复/不进资产）、工作台服务端队列、流水线阶段入队 |

**九条待拍板（P1–P9，含建议与代价，见 `platform-positioning.md` §6）**

| # | 议题 | 建议 |
| --- | --- | --- |
| P1 ✅ | 定位句与"文本是否可上云"（C1） | **已拍板 D13**：文本可用云端（默认 DeepSeek），本地模型保留给特殊场景；PRD §1 已按此修正 |
| P2 | 四页唯一职责表 | 照 §5.1 收敛：项目=主线事实、画布/工作台=可丢弃的编辑与试验表面、流水线=跑批控制台 |
| P3 ✅ | "工作流"统一叫法 | **已拍板并落实**：统一为 **阶段 / 跑批 / 模板 / 画布**（写进 `domain-contract.md` §3.9）；UI 本来就没有"工作流"字样 |
| P4 | 本期目标锁定 **B 包能出** | 认同；给 `edit-export` 接 HTTP + UI + Agent 工具（现在只有 CLI） |
| P5 | 是否补 **Agent 的流水线工具** | **建议补 Project 作用域工具**：项目上下文/阶段门禁/Job 与 Artifact 状态/跑阶段/取消/采用候选/导出包；否则“Agent 产出资料包”无从谈起。具体权限、幂等和审计见 `project-integration-implementation-guide.md` §7 |
| P6 | 外部 API 口径（C8） | RunningHub 不投入；浏览器直连渠道只保留在工作台，项目/流水线一律走网关 |
| P7 | BR 草稿 A–F 正式拍板或归档（C6） | 逐条给结论，或把 BR 降级为"参考"并在文首标注 |
| P8 ✅ | 文档过期清理（C4/C5/C9） | **已拍板并部分落实**：段数统一"七段"（`domain-contract.md` §3.9 口径 + PRD 数据边界）；**代码侧仍存**：`gates.js` 缺 casting/audio（已入册 **#96**）、前端 fallback requires 冲突（**#97**）（待施工） |
| P9 ✅ | **画布是否接入服务端事实链**（C7/C10） | **已拍板 D14：接**。深度分 A/B/C 三档（`platform-positioning.md` §5.5），工程侧倾向 **B**，产品负责人要求**先交外部评审**；拍板前不要在画布侧写资料包入口 |

**拍板前不要做的事**：不要在"画布能不能出包"这个问题上继续写代码——P9 没定之前，画布侧的任何资料包入口都建不起来（C7 挡着）。

## 11.11 M6 后声音与声画质量整改（2026-10-06）

M6 已证明七段任务、TTS Job、片段产物和 ffmpeg 成片可以跑通，但用户对最终片段的真实反馈表明质量验收尚未通过：角色音色跨镜不稳定、电话场景出现抢台词、独立语音与嘴型不同步。问题的优先级高于继续增加模板，按 [`audio-video-quality-audit-2026-10-06.md`](./audio-video-quality-audit-2026-10-06.md) 收口。

### 当前判断

- 默认 `separate_dialogue_track` 已在同步、英文改写和 Ref2VA 提示词路径关闭 H3 `<d>` 台词，交付层也拒绝把缺失的独立 TTS 静默当成成功；仍需真实 GPU 任务确认所有模板都遵守这条路由。
- Cue 现在在 TTS 完成后读取实际媒体时长并按镜头顺序串行排布，QC 会报告对白重叠、超时和未知时长；真实媒体的异常样本仍需补充。
- 独立 TTS 不会改变已生成视频的嘴型；`07-lipsync` 当前是实验性、默认关闭，故默认链路没有音画同步承诺。
- 前端 `视频·后期` 已展示声音路线、成片质量状态，并提供跨阶段 QC 重跑入口；已补对白实测起点/时长与口型处理覆盖数量；逐镜 VoiceProfile 展示和感知验收仍待补齐。

### 整改顺序

1. **P0 声音事实源**：编译器接收 `audioMode`；独立对白模式不把 `<d>` 台词交给 H3，原声模式才允许 H3 承载对白；TTS 缺失不得静默改用 H3 人声。
2. **P0 时间轴**：TTS 完成后探测实际时长，生成不重叠的对白时间轴，并把实际时长同步到 AudioCue、字幕、混音清单和 QC；电话场景默认一镜一位主动说话人，要求交叉剪辑表达轮次。
3. **P1 口型路径（参数已补齐）**：`video_h3_talk` 按角色 VoiceProfile 填写 TTS 文本、音色、语言，拒绝多主动说话人、画外音和独立配音模式；和独立 TTS + `video_lipsync` 做同素材 A/B；口型失败可以回落，但必须可见地标记“未处理”。
4. **P2 前端质检**：视频·后期工作区同时读取 `audio` 与 `assembly` 的服务端状态，展示声音路线、角色音色、实际时长、重叠/超时/缺产物/口型回落；合成按钮读取 QC 门禁。
5. **真机验收**：用两镜电话场景跑 H3 Talk 与独立 TTS 两条路线，保存原始片段、TTS、SRT、manifest 和 QC 报告后再决定默认路线；在此之前不更换 H3 或 TTS 模型。

### 质量门定义

没有通过“无意重叠、音色稳定、时间轴一致、口型状态可解释、刷新/重启后事实不变”五项验收，不得把 M6 描述为“声音质量闭环完成”；M6 只保留为功能性成片里程碑。

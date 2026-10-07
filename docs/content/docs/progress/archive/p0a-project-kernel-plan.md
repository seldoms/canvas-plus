> ⚠️ **时点快照，内容已过期（2026-10-05 独立复核）**：本文写于 2026-10-02/03，其中多条结论已被后续代码超越（模板数与测试基线、`delivery.js` 成片执行体、skill 库接线、`runIds` 回填、流水线段数 等）。**引用前请以 `HANDOFF.md` 的「2026-10-05 独立审查结论」、`development-plan.md` §11.1 的修正表、以及 live `GET /api/providers` / `GET /api/pipeline/stages` 为准**；本文只作演变记录保留。

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


# P0-a 开工前梳理：建立 Project 内核

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 版本：v1（2026-10-03）。状态：**方案其余项待拍板、未开工；旧画布数据处理已由用户拍板——不做迁移、不做兼容层（见 R1·R11、M5、§4.3）**。
> 上位文档：`development-plan.md`（执行计划 §8 的 P0-a）、`domain-contract.md`（已冻结领域契约，字段名唯一权威）、`prd.md`（产品意图 §3 混合存储、§5 画布⇄流水线打通）。
>
> 本文回答一件事：**P0-a（建立 Project 内核：服务端 Project/Episode/Scene/Shot/AssetRef/Canvas 引用、源版本、Project Context API，以及全新的项目总览页骨架）开工前要有哪些数据结构、接口、页面和规则。**
> 按研发总管要求，本轮**只出方案、不写代码**：把大改译成数据结构 + 要他拍板的规则清单，过一遍再开工。
>
> **证据分级**：本文结论标注
> **【已复核】** = 我本轮亲自读源码确认（带 `file:line`）；
> **【设计】** = 本文新提出的方案，未实现、待确认；
> **【沿引】** = 来自 `development-plan.md` / `domain-contract.md` / `prd.md` 的既有结论，本轮未逐条复核。
>
> 本文**不修改任何现有文件**（含 `development-plan.md`、`domain-contract.md`、`todo.mdx`、`CHANGELOG.md`、`meta.json`）。字段名一律逐字沿用 `domain-contract.md`；不一致处在 §1.5 单列并给对齐建议。

---

## 0. 范围与边界

**做什么**：服务端 Project 存储内核 + Project Context API + 项目列表/总览页骨架 + 各工作区路由骨架 + 旧页面收口。**旧数据不做导入 / 迁移**（用户已拍板，见 R1）。

**不做什么**（本文明确排除，避免范围膨胀）：
- 不实现 Workflow/Tool/Provider/Device Registry、资源调度（P0-d）。
- 不实现 Job→Artifact→GenerationSlot 回写投影（P0-b **已在代码里落地**，见 §5 前置；本文只做引用接线）。
- 不实现 Delivery Executor（ffmpeg 拼接、音频/字幕/封面，P1-d）。
- 不实现活扣候选竞争、逐镜重试、并排比较（P1-b）。
- 不实现实时协作、锁服务、CRDT（D7 已明确不做）。
- 不写旧字段兼容/迁移兜底（`AGENTS.md` 基本原则）。**用户已拍板：旧画布数据不要了（那是他的测试数据），不做迁移、不做兼容层**，因此也不建导入适配层（见 R1·R11 与 `development-plan.md` D12）；旧 localforage 数据原样留在浏览器不处理，新页面不去读它。

**开工前提**：
1. `domain-contract.md` 已冻结（P0-0 完成），`web/src/types/domain.ts`、`canvas-server/src/contracts.js` 已存在【已复核】。
2. P0-b（Job→Artifact→GenerationSlot 回写断链）在服务端已实现：`pipeline.js` 已有 `bindJobs()`/`projectJob()`/`upsertCandidate()`/`recomputeStage()` 与 `candidates[]`【已复核】。P0-a 的 Project 是**接在 P0-b 已有投影之上**的引用层，不重复造回写。

---

## 1. 服务端数据结构

### 1.1 目录布局 `data/projects/<projectId>/`

沿用 `development-plan.md §3.2` 的建议布局，按 P0-a 实际需要收敛为：

```text
data/projects/<projectId>/
  project.json                 # 项目元数据 + 索引；唯一可写的项目级文件
  episodes/<episodeId>.json    # 一集：Episode + 内嵌 scenes[] + shots[]（含 generationSlots）
  sources/<revisionId>.json    # 原文/剧本源版本；写入后不可变（immutable）
  assets/<assetRefId>.json     # AssetRef 语义引用，只存引用不复制 artifact 字节
  deliverables/<id>.json       # 交付物索引；P0-a 只建目录与最简索引
  workflows/<workflowRunId>.json  # 预留：P0-a 只建约定，不实现（P0-d）
```

**存储决策【设计】**：
- **不新建** per-project `runs/` 目录。现有 run 落在全局 `data/runs/<runId>/`（`pipeline.js:74` `runsDir = ensureDir(join(dataDir, "runs"))`）【已复核】；P0-a 只把 `runId` 记进 `project.json.runIds[]` 做关联，不动 pipeline 落盘位置。per-project runs 见 R12。
- **`data/projects/` 目录当前不存在**（`config.js` 只 `mkdirSync` 了 `artifacts/`、`runs/`、`uploads/`，`config.js:142-144`）【已复核】。P0-a 需新增 `data/projects/` 且在启动时确保存在。
- **Canvas 不落服务端**：`Canvas` 的 nodes/connections/viewport/chatSessions 仍在浏览器 localforage（`domain-contract.md §3.11`、`prd.md §3.1`）。服务端只在 `project.json.canvasIds[]` 存画布 id 引用【沿引】。

### 1.2 `project.json`

字段逐字对齐 `domain-contract.md §3.1` 的 `Project`：

| 字段 | 类型 | 必填 | 说明 / 写入时机 |
| --- | --- | --- | --- |
| `id` | `prj_<26位ULID>` | 是 | 创建项目时生成（`ID_PREFIX.project`，`contracts.js:11`），此后不变【沿引】 |
| `title` | `string` | 是 | 建项目时给；改名时重写 |
| `createdAt` / `updatedAt` | ISO 8601 | 是 | 创建时写；每次成功写入重算 `updatedAt` |
| `styleAnchor` | `string` | 是 | 风格锚点一句话；规划阶段锁定，改时重写 |
| `plan` | `Plan` | 是 | 阶段 0 规划参数（`genre/tone/ratio/episodeDurationSec/dramaMode/audience/episodeCount`）。项目级默认，逐集覆盖见 `Episode.plan?`（D8）【沿引】 |
| `script` | `unknown` | 是 | 01 阶段产物权威副本；**内部形态属 P0-a**，建议见 §1.6 |
| `episodes` | `Episode[]` | — | **契约字段为内嵌数组**；P0-a 落盘取舍见 §1.5 第 1 条（建议：`project.json` 只存 `episodeIds[]` 索引，Episode 实体在 `episodes/<id>.json`）【设计】 |
| `assetRefs` | `AssetRef[]` | — | 同上，建议 `project.json` 只存 `assetRefIds[]`，实体在 `assets/<id>.json`【设计】 |
| `runIds` | `string[]` | 是 | 关联 run；建 run 后 `POST /api/projects/:id/runs` 追加 |
| `canvasIds` | `string[]` | 是 | 关联浏览器画布 id；注册/注销画布时改 |
| `checklist` | `ChecklistItem[]` | 是 | 完成度检查表；形态见 §1.6 |
| `reviewNotes` | `ReviewNote[]` | 是 | 审核风险提示（D9）；任何阶段可产生，`scope` 决定就近展示位置 |
| `ownerUserId` | `string` | 否 | 跟进人（D7 单写者约定） |
| `version` | `number` | 是 | 项目版本号，用于识别写入归属（D7）；每次成功写入 +1 |

**P0-a 需要补充、契约尚未有的字段（待拍板，见 R7 / R9）**：
- `sourceRevisionId: string | null` —— 指向当前 `sources/<revisionId>.json`。`development-plan.md §3.2` 的最小字段里有，`domain-contract.md §3.1` **没有**；但「run 正文改为引用 sourceRevisionId」（`development-plan.md §3.2`）需要它。
- `status: "active" | "archived"`（+ `archivedAt?: string`）—— 归档/回收站所需。契约未定义，见 R3。
- `deliverables: DeliverableIndex[]`（或只保留 `Episode.deliverableIds[]`）—— 见 §1.5 第 3 条。
- **不新增** `workflowId` / `workflowVersion`：`development-plan.md §3.2` 有，但它们属于 Workflow Registry（P0-d）；P0-a 现在写进去会变成一个永远填不上的死字段，建议推迟（R8）。

**写入约定【设计】**：
- 所有写入走「读 → 改 → 原子写」：写临时文件 `<file>.tmp` 再 `rename` 覆盖，避免半写文件成为项目事实（`development-plan.md §5.2` 已点名此要求）。
- 写前做乐观版本校验：请求带 `version`，与磁盘不一致则 `409`（D7 只提示不自动覆盖）。
- `updatedAt`/`version` 每次成功写入都更新。

### 1.3 `episodes/<episodeId>.json`

顶层字段逐字对齐 `domain-contract.md §3.2` 的 `Episode`，另内嵌 `scenes[]` 与 `shots[]`（`development-plan.md §3.2` 明确「episodes/<episodeId>.json = 集、场景、镜头和交付状态」）【沿引】：

```jsonc
{
  // —— Episode（契约 §3.2，逐字）——
  "id": "ep_0001",
  "projectId": "prj_<26位ULID>",
  "index": 1,                 // 可重排，只改 index
  "title": "第一集",
  "logline": "",              // 可选
  "plan": {},                 // Partial<Plan>，逐集覆盖（D8）；空对象 = 全继承项目级
  "sceneIds": ["sc_0001"],    // 本集场次引用（索引）
  "canvasIds": [],            // 本集画布（如分镜板）
  "status": "pending",        // 集状态枚举见 §1.6（属 P0-a）
  "deliverableIds": [],

  // —— 内嵌实体（P0-a 新增）——
  "scenes": [ /* Scene[]，逐字对齐契约 §3.3 */ ],
  "shots":  [ /* Shot[]，逐字对齐契约 §3.4，含 generationSlots[] */ ]
}
```

- `Shot.id` 用 `sh_<创建时生成>`，**稳定不可随重排改变**；调序只改 `index`（契约 §4；插件 `reindex()` 目前会重写 `sh1..shN`，必须改为只改 index —— `plugins/canvas/storyboard-studio/src/storyboard.ts:66`）【已复核】。
- `Shot.storyboard` 内部形态：沿用 02 阶段输出契约的 11 字段，逐字为 `id / sceneId / index / durationSec / shotSize / camera / action / dialogue / audio / prompt / negativePrompt`【已复核：`skills/02-storyboard/SKILL.md:68`】。
- `GenerationSlot`（契约 §3.5）内嵌在 `Shot.generationSlots[]`；P0-b 的投影器已按 `item.id` 回写候选，P0-a 只负责把它挂到稳定 `shotId` 上。

### 1.4 `sources/<revisionId>.json`

**写入后不可变**【设计】。结构：

```jsonc
{
  "id": "<revisionId>",              // 建议 `src_<26位ULID>` 或 `rev-<时间戳>-<随机>`
  "projectId": "prj_…",
  "kind": "novel | script",
  "title": "原始书名 / 剧本名",
  "sha256": "<正文内容哈希>",         // 用于识别「一次运行是否基于已被用户改过的原文」
  "chars": 123456,                    // 正文字数（成本预估与列表展示）
  "from": "upload | pipeline | editor | legacy-import",
  "createdAt": "…",
  "content": "<原文正文>"             // 只读，不重写
}
```

- 一份长篇小说只落一次；后续用户改稿产生**新 revision**，不覆盖旧 revision（`development-plan.md §3.2`：修改参数后应产生新的 source/plan revision）【沿引】。
- `project.json.sourceRevisionId` 指向当前采用版本。
- `episodes/<id>.json` 与 `sources/` 的分工：正文只在 `sources/`；`episodes/` 只存结构化镜头与状态。

### 1.5 与 `domain-contract.md` 的不一致处与对齐建议

> 硬要求：字段名逐字沿用契约。以下 6 处是**契约与 `development-plan.md §3.2` 之间**的差异，P0-a 必须二选一，不能各写一半。

| # | 冲突 | 契约（权威） | `development-plan.md §3.2` | 对齐建议【设计】 |
| --- | --- | --- | --- | --- |
| 1 | 集/资产的落盘形态 | `Project.episodes[]`、`Project.assetRefs[]` 为**内嵌数组** | `Project.episodeIds[]`、`assetRefIds[]` | **对外 JSON 仍是 `episodes[]`/`assetRefs[]`（契约权威）；落盘时 `project.json` 只存 id 索引，实体分文件。** 服务端读取时组装成契约形状返回，前端只认契约形状。 |
| 2 | 源版本字段 | 无 `sourceRevisionId` | 有 `sourceRevisionId` | **补 `sourceRevisionId: string \| null`** 进 `project.json`（不动契约正文，属 P0-a 回填，登记在 R7）。 |
| 3 | 交付物字段 | `Episode.deliverableIds[]`（有），Project 无 `deliverables[]` | `Project.deliverables[]` | **保留 `Episode.deliverableIds[]`**；Project 级汇总走 `deliverables/` 目录扫描或派生的只读视图，不新增 Project 字段（R7）。 |
| 4 | 工作流字段 | 无 `workflowId`/`workflowVersion` | 有 | **P0-a 不落**，推迟到 P0-d（R8）。理由：现在写进去填不上，会变死字段。 |
| 5 | 阶段状态措辞 | `pending/running/partial/done/error/canceled`（§8.2 已裁定） | 正文另出现 `planned/ready/failed/canceled` | **一律用契约 §8.2 的裁定**（`failed`→`error`，`ready`/`planned` 无对应态）【沿引】。 |
| 6 | 项目名 `canvasProjectIds` | `canvasIds[]`（§8.2 已裁定契约权威） | `canvasIds[]` | **用 `canvasIds[]`**，`prd.md §3.2` 的 `canvasProjectIds[]` 表述作废【沿引】。 |

### 1.6 `domain-contract.md §8.3` 点名「留待 P0-a 回填」的内部形态

契约 §8.3 列了 7 项未冻结形态，P0-a 需给出建议值（下面全部为**【设计】，待拍板见 R9**）：

| 项 | 建议值 |
| --- | --- |
| `Project.script` 结构 | `{ revisionId: string \| null, logline: string, synopsis: string, characters: Character[], scenes: SceneOutline[] }`；完整正文放 `sources/`（kind=`script`），`script` 只存 01 阶段结构化产物 |
| `ChecklistItem` | `{ id: string, scope: "project" \| "episode" \| "stage", label: string, done: boolean, ref?: string }`（`ref` 指向阶段 id 或 episodeId） |
| `Shot.storyboard` | 02 阶段 11 字段（见 §1.3） |
| 集 `status` 枚举 | `pending \| in_progress \| review \| done \| archived`（由阶段状态派生，不单独维护） |
| 镜 `status` 枚举 | `pending \| storyboarded \| assets_ready \| keyframe_confirmed \| clip_ready \| done`（同上，派生） |
| `GenerationSlot.role` 枚举 | `start \| key \| end`（关键帧）/ `clip`（片段） |
| `Artifact.type` 枚举 | `image \| video \| audio \| subtitle \| document \| archive` |
| `Workflow.version` 类型 | `string`（P0-a 不实现，仅登记） |
| `ReviewNote.level = block` 是否门禁 | **是**：`block` 阻断进入下一阶段（与 D11「逐阶段人工门禁」一致）；`warn`/`info` 只提示不阻断 |

### 1.7 一次成功的项目创建写入清单【设计】

`POST /api/projects` 成功时：
1. 生成 `prj_<26位ULID>`，写 `data/projects/<id>/project.json`（`version: 1`）。
2. `mkdir` `episodes/`、`sources/`、`assets/`、`deliverables/`。
3. 若请求带 `source`（正文）→ 写 `sources/<revisionId>.json`，回填 `project.json.sourceRevisionId`。
4. 若请求带 `canvasId`（新建默认画布）→ 追加 `canvasIds[]`。
5. 返回组装好的 `Project`。

---

## 2. Project Context API 接口清单

> **现有路由风格约束【已复核】**：`canvas-server/src/http.js` 的 `createRouter()` **只暴露 `get` / `post` / `any` 三个方法**（`http.js:173`），**没有 `put`/`patch`/`delete`/`del` helper**。所有响应走 `sendJson(res, status, body)`（`http.js:48`），错误走 `sendError(res, status, message, code)`（`http.js:55`），错误体形状固定为 `{ error: { message, code? } }`。现有 `index.js` 全部路由都只用 `router.get` / `router.post`（`index.js:114-360`）。
>
> **因此**：本文接口**一律用 GET 读、POST 写**（写动作用 `POST /…/<动作>` 子路径，与现有 `/api/jobs/:id/cancel`、`/api/pipeline/runs/:id/steps/:stage/run` 的风格一致）。若想用语义化的 `PUT`/`DELETE`，需先给 `createRouter` 补 helper —— 这是**一处 3 行的基础设施改动**，列为 R6，请拍板是补 helper 还是继续全用 POST。

### 2.1 通用约定

- **路径前缀**：`/api/projects`。
- **幂等读**：所有 GET 无副作用。
- **错误码**（`sendError` 第三参 `code`）：

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | 缺必填（如 title）、枚举非法、JSON 解析失败 |
| 404 | `PROJECT_NOT_FOUND` | projectId 无对应 `project.json` |
| 404 | `EPISODE_NOT_FOUND` / `SCENE_NOT_FOUND` / `SHOT_NOT_FOUND` / `SOURCE_NOT_FOUND` / `ASSETREF_NOT_FOUND` | 子资源不存在 |
| 409 | `VERSION_CONFLICT` | 请求带 `version` 与磁盘不一致（D7 单写者，只提示不覆盖） |
| 409 | `DUPLICATE_INDEX` | 集/场/镜 `index` 冲突 |
| 409 | `HAS_REFERENCES` | 删除/强删前引用检查未通过（AssetRef/Artifact/运行中 Job/画布仍引用） |
| 409 | `PROJECT_ARCHIVED` | 对已归档项目做写操作 |
| 422 | `DANGLING_REFERENCE` | 非法引用：`Shot.sceneId` 不在本集、`AssetRef.bindingId` 不在剧本、`Episode.deliverableIds` 悬空、`episodeId` 不存在 |
| 500 | `STORE_ERROR` | 磁盘读写/原子写失败 |

- **版本校验【设计】**：所有写请求可选带 `version`；带了就校验，不带则视为「不强校验」（迁移期用），但不带的写法在 R10 里要拍板是否允许。

### 2.2 项目列表 / 概览

| 方法 | 路径 | 请求 | 响应 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/projects` | `?status=active\|archived&q=<关键词>` | `200 { projects: ProjectSummary[] }` | `ProjectSummary = { id, title, status, createdAt, updatedAt, episodeCount, checklistDone, checklistTotal, unresolvedReviewNotes, runningRunCount, canvasCount, coverUrl? }`；**只回摘要，不回 `script`/`sources` 大对象**（对齐 `progress.json` 的轻量原则） |
| POST | `/api/projects` | `{ title, plan?, styleAnchor?, source?: {kind,title,content}, canvasId? }` | `201 { project }` | 建项目；见 §1.7 |
| GET | `/api/projects/:id` | — | `200 { project }` | 返回契约形状 `Project`（含 `episodes[]`/`assetRefs[]` 组装结果、`episodes` 只给摘要级：id/index/title/status/sceneCount/shotCount） |
| POST | `/api/projects/:id` | `{ version?, title?, plan?, styleAnchor?, ownerUserId?, checklist? }` | `200 { project }` | 项目元数据更新（不改 episodes/assetRefs） |
| POST | `/api/projects/:id/archive` | `{ version? }` | `200 { project }` | 置 `status:"archived"` |
| POST | `/api/projects/:id/restore` | `{ version? }` | `200 { project }` | 归位 |
| GET | `/api/projects/:id/references` | — | `200 { references }` | 删除前引用检查：`{ assetRefs: number, artifacts: number, runningJobs: number, canvases: number, deliverables: number, blocked: boolean }` |
| POST | `/api/projects/:id/delete` | `{ version?, force?: boolean }` | `200 { deleted: true }` / `409 HAS_REFERENCES` | 无引用才真删；`force` 只解除引用、**不删 artifact 文件**（R3） |

### 2.3 Project Context API（工作区统一入口）

> `development-plan.md §5.3` 要求「Project Context API：从项目页、画布、流水线和素材库统一获取当前 Project/Episode/Shot，避免每个页面自行拼接上下文」【沿引】。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/context` | `?episodeId=&sceneId=&shotId=&stage=` | `200 { context }` |

`context` 形状【设计】：

```jsonc
{
  "project": { /* Project 摘要 + plan 默认值 + styleAnchor + checklist + reviewNotes */ },
  "episode": null | { /* Episode 摘要 */ },
  "scene": null | { /* Scene */ },
  "shot": null | { /* Shot 摘要 + generationSlots 状态计数 */ },
  "plan": { /* 解析后的有效 Plan：项目级默认被 episode.plan 覆盖（D8） */ },
  "reviewNotes": [ /* 按 scope 过滤后、本页面该就近展示的条目（D9） */ ],
  "episodes": [ /* 集摘要列表，供导航 */ ],
  "assetRefs": [ /* AssetRef 摘要 */ ],
  "runIds": [],
  "canvasIds": [],
  "sources": [ /* {id,kind,title,chars,createdAt}，不含正文 */ ],
  "deliverables": [],
  "stageGates": [ /* {stageId,status,canEnter,blockedBy[]}，见 §3 阶段门禁 */ ]
}
```

- **一个 projectId 打通所有工作区**：画布页传 `canvasId` 过滤画布相关引用、流水线/剧本工作区传 `stage`、分镜/关键帧传 `episodeId/shotId`，都只调这一个接口拿上下文。
- `plan` 的解析（项目级默认 + 逐集覆盖，D8）**只在服务端算一次**，前端不再各页拼【设计】。

### 2.4 集 / 场 / 镜

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/episodes` | — | `200 { episodes: EpisodeSummary[] }` |
| POST | `/api/projects/:id/episodes` | `{ title, index?, logline?, plan? }` | `201 { episode }`（新建 `episodes/<id>.json`，`id=ep_<4位序号>`） |
| GET | `/api/projects/:id/episodes/:episodeId` | — | `200 { episode }`（含内嵌 `scenes[]`、`shots[]`） |
| POST | `/api/projects/:id/episodes/:episodeId` | `{ version?, title?, index?, logline?, plan?, status?, deliverableIds?, canvasIds? }` | `200 { episode }` |
| POST | `/api/projects/:id/episodes/:episodeId/scenes` | `{ index?, locationId, time, intent, beatIds? }` | `201 { scene }` |
| POST | `/api/projects/:id/scenes/:sceneId` | `{ version?, index?, locationId?, time?, intent?, beatIds? }` | `200 { scene }` |
| POST | `/api/projects/:id/scenes/:sceneId/shots` | `{ sceneId?, index?, storyboard? }` | `201 { shot }`（`id=sh_<生成>`） |
| POST | `/api/projects/:id/shots/:shotId` | `{ version?, sceneId?, index?, storyboard?, status? }` | `200 { shot }` |
| POST | `/api/projects/:id/episodes/:episodeId/reorder` | `{ sceneIds: [] , shotIds?: [] }` | `200 { episode }` | **只改 `index`，绝不改任何 `id`**（契约 §4） |

- 若场/镜跨集操作，一律用「当前 episodeId 所在文件」路由；`Shot.sceneId` 必须能在本集 `scenes[]` 找到，否则 `422 DANGLING_REFERENCE`（`development-plan.md §3.1`：`shots[].sceneId` 现状由 LLM 自由书写、代码从不校验，必须改为代码校验并 join）【已复核】。

### 2.5 源版本

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/sources` | — | `200 { sources: [{id,kind,title,chars,sha256,createdAt}] }`（**不含正文**） |
| POST | `/api/projects/:id/sources` | `{ kind: "novel"\|"script", title?, content, from? }` | `201 { source }`；同时把 `project.json.sourceRevisionId` 指向新 revision |
| GET | `/api/projects/:id/sources/:revisionId` | `?head=<n>` | `200 { source }`（含正文；`head` 可只取前 n 字，供对照视图分页） |

### 2.6 资产引用（AssetRef）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/assets` | `?role=` | `200 { assetRefs: AssetRef[] }` |
| POST | `/api/projects/:id/assets` | `{ role, bindingId, episodeId?, sceneId?, shotId?, artifactIds?, metadata? }` | `201 { assetRef }` |
| POST | `/api/projects/:id/assets/:assetRefId` | `{ version?, bindingId?, artifactIds?, selectedArtifactId?, metadata?, episodeId?, sceneId?, shotId? }` | `200 { assetRef }` |
| POST | `/api/projects/:id/assets/:assetRefId/select` | `{ artifactId }` | `200 { assetRef }`（`selectedArtifactId` 切换；`artifactId` 必须在 `artifactIds[]` 内） |
| POST | `/api/projects/:id/assets/:assetRefId/unlink` | `{ artifactId }` | `200 { assetRef }`（解除引用，**不删 artifact 文件**） |

- `AssetRef.role` ∈ `character/scene/prop/keyframe/clip`（契约 §3.8 / `contracts.js:58`）【已复核】。
- `AssetRef.artifactIds[]` 指向 `/api/artifacts/<jobId>/<file>`（D2 引用不复制）【沿引】。

### 2.7 run / 画布 关联

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/runs` | — | `200 { runs: [{id,title,createdAt,updatedAt,stages}] }`（摘要，复用 `summarizeRunStages`，不回 novel 全文） |
| POST | `/api/projects/:id/runs` | `{ runId }` | `200 { project }`（把 `runId` 追加进 `runIds[]`；run 本身仍在 `data/runs/`） |
| POST | `/api/projects/:id/canvases` | `{ canvasId, episodeId? }` | `200 { project }`（追加 `canvasIds[]`；画布实体在浏览器） |
| POST | `/api/projects/:id/canvases/:canvasId/unlink` | — | `200 { project }`（只解除引用） |

### 2.8 旧数据导入 —— 已拍板取消（D12）

**用户已拍板：旧画布数据不要了（那是他的测试数据），不做迁移、不做兼容层。** 因此**不设** `POST /api/projects/import-legacy`，也不做浏览器侧的一次性导入适配层（原 R1 方案作废）；`/api/projects` 系列不含任何 legacy 导入端点。详见 §4.3。

---

## 3. 页面与信息架构

> 依据 `development-plan.md §7.2`（页面信息架构与阶段门禁）、§7.3（**不受现有插件页约束，Project 是唯一入口**）。每个页面只回答四问：**当前输入是什么 / 系统在做什么 / 我需要确认什么 / 失败后如何继续**。

### 3.1 路由

新路由（**全部携带 `projectId`**）【设计】：

| 路由 | 页面 | 职责 |
| --- | --- | --- |
| `/projects` | 项目列表 | 创建、复制、归档、恢复、搜索；显示进度与「仍有后台任务」提示 |
| `/projects/:projectId` | 项目总览 | 交汇点：整部剧的进度、集、资产、运行、交付物、`checklist`、全部未解决 `reviewNotes`、画布缩略图入口 |
| `/projects/:projectId/plan` | 规划·剧本工作区 | 导入来源、规划参数、生成/确认剧本、风险提示（scope=project/episode） |
| `/projects/:projectId/storyboard` | 分镜工作区 | 章节→场景→镜头树；编辑时长/景别/运镜/台词；导入画布；悬空引用修复 |
| `/projects/:projectId/assets` | 资产工作区 | 角色/场景/道具基准与候选（AssetRef）；绑定 `bindingId`；选采用版本 |
| `/projects/:projectId/keyframes` | 关键帧工作区 | 批量生成/比较/采用关键帧（GenerationSlot）；逐镜确认后放行视频 |
| `/projects/:projectId/video` | 视频与后期工作区 | 片段、音频、字幕、拼接、导出；后期门禁 |
| `/projects/:projectId/canvas/:canvasId` | 画布（项目内工作区） | 沿用现有画布引擎；引用 Project 对象；Agent 批量 op |

**每页四问的具体落点【设计】**：

| 页面 | 当前输入 | 系统在做什么 | 要确认什么 | 失败后如何继续 |
| --- | --- | --- | --- | --- |
| 项目总览 | — | 汇总各阶段状态、运行中 Job 数 | 勾 `checklist`、处理 `reviewNotes` | 从最近成功阶段继续；跳对应工作区 |
| 规划·剧本 | `sourceRevisionId` + `plan`（项目级默认 + 逐集覆盖） | 规划/01 阶段 run 运行中、进度、成本预估 | 确认规划报告与剧本 revision → 才放行分镜 | 保留已完成块，`resume:true` 续跑；非法 JSON 停在「需修复」 |
| 分镜 | 已确认剧本 revision | LLM 拆镜中 / 已完成待编辑 | 悬空 `sceneId`、不合法时长必须先修 | 局部重跑，不动已确认镜头 |
| 资产 | 角色/场景/道具 `bindingId` | 生成候选 AssetRef | 未选基准版本的资产不能当默认参考 | 只重试失败资产 |
| 关键帧 | 已确认分镜 + 资产基准 | 逐镜 GenerationSlot 排队/生成 | 首尾帧与连续性确认 → 才放行视频 | 保留成功候选，失败镜单独重试（D10） |
| 视频·后期 | 已确认关键帧 | 片段生成 / 后期校验 | 缺片段或后期校验失败不得标成片完成 | 只重跑失败后期步骤 |

### 3.2 阶段门禁

- 逐阶段人工确认门禁，**不做一键跑完**（D11）【沿引】。
- 门禁放行条件：上游阶段 `status === "done"`（D5 收紧：本阶段所有必需 Job 成功且产物已回写）+ 无未解决的 `ReviewNote.level === "block"`（R9）。
- 服务端在 `context.stageGates[]` 直接给出「能否进入该阶段、被谁挡住」，前端不各自算【设计】。

### 3.3 组件边界原则

- 页面**从契约反推组件**，不先复制旧 UI 再补字段（`development-plan.md §7.3`）【沿引】。
- 前端状态：`Project Context` 走新增 `web/src/services/api/projects.ts`（对齐 `gateway.ts` 的 axios + `gatewayBaseUrl` 写法）；跨页面选中的 `projectId/episodeId/shotId` 放全局 store（`web/src/stores/use-project-context-store.ts`），组件直接取，不做多层 props 透传（`AGENTS.md` 前端规范）。

---

## 4. 与现有页面的关系

### 4.1 现有路由盘点【已复核】

`web/src/router.tsx:25-33` 注册：`/`、`/image`、`/video`、`/assets`、`/prompts`、`/canvas`、`/canvas/:id`、`/pipeline`、`/config`。顶部导航 `navigation-tools.ts` 顺序为 `canvas / pipeline / image / video / prompts / assets / config`【已复核】。

### 4.2 处置结论【设计】

| 现有页面 | 处置 | 说明 |
| --- | --- | --- |
| `/canvas`（列表） | **降级为入口** | P0-a 期间保留，作为「未关联到项目的旧画布」的查看入口（**不做数据迁移**，见 §4.3）；项目内画布改走 `/projects/:projectId/canvas/:canvasId`。 |
| `/canvas/:id`（画布编辑器） | **复用引擎、改挂 Project 上下文** | 画布引擎不变；增加从 URL 带 `projectId` 与写回 `canvasIds[]`。不重写画布。 |
| `/pipeline` | **临时保留可用 + 逐步被工作区取代** | P0-a 期间**保持完全可用**（读写都通），作为新增项目工作区未就绪时的回退；工作区就绪后 `/pipeline` 降级为「快速通道/旧入口」。见 R5。 |
| `/assets` | **保留为全局素材库入口；新增项目内资产工作区** | `/assets` 继续管「无 `projectId` 的全局素材」；`/projects/:projectId/assets` 管项目私有 AssetRef。两者共用素材选择器。 |
| `/image`、`/video` | **不动** | 独立创作页，非生产链主路径。 |
| `/prompts`、`/config` | **不动** | 提示词与网关配置。 |
| 旧插件（storyboard-studio 等） | **不再作为运行时依赖** | `plugins/canvas/storyboard-studio` 只保留为画布内可拆/可删的插件与**导入源**（其 `Shot` 与 02 契约 11 字段同构）；新分镜工作区不依赖它。`reindex()` 重写 `sh1..shN` 的行为（`storyboard.ts:66`）不得进入新链路。 |

### 4.3 旧数据处置 —— 不迁移、不兼容（已拍板）

- **用户已拍板：旧画布数据不要了（那是他的测试数据），不做迁移、不做兼容层。**
- 因此**不读** localforage 的 `CanvasProject` / `Asset`（`use-canvas-store.ts:10-22` / `use-asset-store.ts:9-26`）【已复核】，**不建**一次性导入适配层，**不设** `POST /api/projects/import-legacy`，不把旧记录映射成 `Project` / `AssetRef`。
- **新页面直接接管**：Project 一律由 `/projects` 新建；画布引用由用户在新页面重新登记进 `project.json.canvasIds[]`。旧的 `/canvas`、`/assets` 页面在 P0-a 期间仍可打开（不 500），但不作为任何迁移输入。
- 旧 localforage 数据**原样保留在浏览器、不做处理、也不删**（不写迁移或清空脚本）。
- 原「一次性旧数据导入适配层」方案及 R11 的 `Asset → AssetRef` 兜底随之作废，见 `development-plan.md` §7 D12。

---

## 5. 分步实施顺序（里程碑）

> 5 个里程碑，每个都能独立验证；并标注与 P0-b / P0-c 的并行关系。
> **前置**：P0-b 服务端回写已在代码里（`pipeline.js` `bindJobs`/`projectJob`）【已复核】，故 P0-a 不需要等 P0-b 的服务端部分；但 P0-a 的「关键帧工作区」验证需要 P0-b 的**阶段状态语义**已生效（也在代码里）。

### M1 — 服务端 Project 存储内核（无 HTTP）
- **内容**：`data/projects/` 模块（读写/原子写/版本校验/目录初始化）+ `project.json`、`episodes/<id>.json`、`sources/<id>.json`、`assets/<id>.json` 的 CRUD 函数；在 `config.js` 启动时 `mkdir data/projects`。
- **做完能验证**：用脚本建项目 → 文件按 §1 布局落盘 → 重启服务后能读回同一 `project.json` → 并发写版本不一致被拒。
- **依赖**：无。
- **并行**：与 **P0-b**（只碰 `pipeline.js`/`jobs.js`）、**P0-c 服务端**（只碰 run 落盘）**文件级不冲突**，可并行。

### M2 — Project Context API + 引用校验
- **内容**：§2 全部 GET/POST 路由接进 `index.js`（用现有 `router.get/post`）；错误码表；DANGLING_REFERENCE 校验；`context` 组装与 `plan` 解析（D8）。
- **做完能验证**：`curl` 建项目→建集→建场→建镜→引用悬空返回 422→`GET /context?episodeId=` 返回解析后的有效 Plan；工作区所需上下文一个接口拿全。
- **依赖**：M1。
- **并行**：可与 **P0-c 前端**（`use-pipeline-store`/刷新恢复）并行——M2 不动流水线接口。

### M3 — 前端项目列表 / 总览页骨架
- **内容**：`web/src/services/api/projects.ts` + `use-project-context-store.ts` + `/projects`、`/projects/:projectId` 页面（创建、列表、总览：进度/集/资产/运行/交付物/checklist/reviewNotes）。
- **做完能验证**：UI 建项目 → 刷新/换设备后从列表回到同一项目 → 总览显示与 `GET /context` 一致（无本地假状态）。
- **依赖**：M2。
- **并行**：纯前端，与 P0-b 无冲突。

### M4 — 工作区路由骨架（规划·剧本 / 分镜 / 资产 / 关键帧 / 视频·后期）
- **内容**：6 条 `/projects/:projectId/*` 路由与页面骨架；每页接 `GET /context` 渲染「输入 / 运行中 / 待确认 / 失败续跑」四态；阶段门禁读 `stageGates[]`。写入动作先做「只读 + 跳转到对应既有能力」。
- **做完能验证**：5 个工作区都能打开并显示正确上下文；未确认上游时下一阶段入口被门禁挡住；`/pipeline` 仍可独立跑通不受影响。
- **依赖**：M3。
- **并行**：**P0-c 前端部分**若在同一波改 `pages/pipeline/`，需与本里程碑约定「谁改 `/pipeline`、谁新增 `/projects/*`」的边界，避免同文件冲突。

### M5 — 新页面直接接管 + 旧页面收口
- **内容**：导航收口（新增「项目」为首项，旧的 `canvas/pipeline/assets` 降级为入口，见 R4）；旧页面仍可打开（不 500）。**不做旧数据导入**——用户已拍板旧画布数据不要了，新页面直接接管，没有迁移步骤（见 §4.3、R1·R11）。
- **做完能验证**：新页面创建的 Project 能正确显示、刷新或换设备后从项目页回到同一 Project；旧页面仍可独立打开使用；代码里不出现任何 legacy 导入端点或导入适配层。
- **依赖**：M2、M4。
- **并行**：与 **P0-c** 的 run 恢复验证可同时进行。

**建议排期次序**：M1 → M2 →（M3 ∥ P0-b）→ M4 → M5。M1/M2 与 P0-b 可完全并行启动。

---

## 6. 要用户拍板的规则清单

> 每条给出**建议默认值**与取舍。编号 R1–R12，请逐条确认或改判。

| # | 规则 | 建议默认值 | 取舍 / 理由 |
| --- | --- | --- | --- |
| **R1** | 旧画布数据的导入方式 | **已拍板：不做** —— 用户确认旧画布数据不要了（那是他的测试数据），不迁移、不兼容、不建导入适配层；旧 localforage 数据原样留在浏览器不处理 | 原建议「手动一键导入」作废；「自动迁移」与「一次性清空重建」同样不做。见 `development-plan.md` D12、本文 §4.3。 |
| **R2** | Project 与 Canvas 的入口关系 | **Canvas 是项目内的工作区**；`Project` 是唯一入口（对齐 §7.3）。P0-a 期间保留 `/canvas` 直达作为**旧画布查看入口**（不做数据迁移，见 R1），P2 再退场 | 符合 D1 与「Project 是唯一入口」；保留直达避免 P0-a 期间用户无处看旧画布。 |
| **R3** | 删除/归档时的资源处理 | **归档为默认（可恢复）**；真删前必做 `GET /references` 引用检查；`force` 只解除引用、**不删 artifact 文件**；候选不自动清理（D10） | 与 D10「不自动清理」、陷阱 4「删画布误删服务端产物」一致；GC 需知道服务端引用，P0-a 先不做物理删除。 |
| **R4** | 新页面是否替换现有导航项 | **新增「项目」为导航首项；P0-a 不删任何现有项**；`canvas/pipeline/assets` 降级为入口，等 M4 工作区验证过再于 P2 收口 | 降低回归风险；`navigation-tools.ts` 是四处硬编码之一，改动收敛在 P2。 |
| **R5** | P0-a 期间 `/pipeline` 是否保留可用 | **完整保留可读可写**，作为工作区未就绪时的回退；工作区就绪后再降级 | 用户仍有真实 run 在跑（`data/runs/` 7 个 run，含 222 万字/83 分钟的长任务）【已复核】，中途砍掉会丢可恢复能力。 |
| **R6** | 是否给 `createRouter` 补 `put`/`delete` helper | **补**（`http.js:173` 加 3 行 `put`/`del`），写接口用语义化方法 | 现有只有 `get/post/any`【已复核】；全用 POST 也能跑，但 DELETE/PATCH 语义更清晰、前端 axios 更自然。属于最小基础设施改动。 |
| **R7** | `sourceRevisionId` / `deliverables` 等契约外字段 | **补 `sourceRevisionId: string\|null`；Project 级不新增 `deliverables[]`**（用 `Episode.deliverableIds[]` + `deliverables/` 目录汇总） | `sourceRevisionId` 是「run 正文改为版本引用」的必需品；`deliverables[]` 汇总可由目录派生，加了会与 `Episode.deliverableIds` 重复。 |
| **R8** | `workflowId`/`workflowVersion` 是否进 `project.json` | **不进**，推迟到 P0-d | P0-a 没有 Workflow Registry 可引用，写进去就是死字段（YAGNI）。 |
| **R9** | `§1.6` 各内部形态（集/镜 status、slot.role、artifact.type、block 是否门禁、script 结构、ChecklistItem） | **采用 §1.6 的建议值**，`ReviewNote.level="block"` **作为阶段门禁阻断** | 这些是契约 §8.3 点名要 P0-a 回填的；`block` 阻断与 D11 逐阶段门禁一致，不冲突。 |
| **R10** | 写接口的版本校验强度 | **带 `version` 才校验；不带视为「不强校验」但仅限本机单用户**；冲突返回 `409 VERSION_CONFLICT`，只提示不覆盖（D7） | 兼顾「不写迁移兜底」与「单写者只提示」；若要求所有写都必须带 version，则前端每次写都需回读，成本更高。 |
| **R11** | 迁移时 `Asset → AssetRef` 的 `role`/`bindingId` 兜底 | **已拍板：不做**（随 R1 一并取消） —— 没有迁移即无需兜底规则；项目资产一律由新页面重新登记 | 旧 `Asset` 无 `role`/`bindingId` 字段【已复核：`use-asset-store.ts:15-26`】；原「按 kind 推断 + 留空补绑」方案作废。 |
| **R12** | run 落盘位置（全局 vs per-project） | **保持全局 `data/runs/`，只记 `runIds[]`**；per-project `runs/` 目录推迟 | `pipeline.js:74` 现固定全局【已复核】；改落盘位置牵动 P0-b/P0-c 与已有 7 个 run 的可恢复性，属返工风险，不建议 P0-a 动。 |

---

## 附录 A：本轮现状审计确认的关键事实（`file:line`）

> 全部为**【已复核】**，即我本轮亲自读源码确认；与 `development-plan.md` 中的【调研】项区分。

1. 路由表只有 `get/post/any` 三种 helper：`canvas-server/src/http.js:173`（`get: (p,h)=>add("GET",...)`, `post`, `any`）。响应约定 `sendJson` `http.js:48`、`sendError` `http.js:55`（错误体 `{ error: { message, code? } }`）。
2. 现有全部业务路由只用 `router.get`/`router.post`，无 PUT/PATCH/DELETE：`canvas-server/src/index.js:114-360`。
3. run 落盘为全局 `data/runs/<runId>/run.json`，`run.options` 原样接收（可塞 `projectId` 过渡位）：`canvas-server/src/pipeline.js:74`、`:244`。
4. P0-b 回写已实现：`bindJobs()` `pipeline.js:612`、`projectJob()` `pipeline.js:589`、`recomputeStage()` `pipeline.js:472`、候选 `upsertCandidate()` `pipeline.js:456`；Job 入队带 `meta:{runId,stageId,itemId}` `pipeline.js:532`。
5. 数据目录只建 `artifacts/`、`runs/`、`uploads/`，**没有 `projects/`**：`canvas-server/src/config.js:142-144`；`canvas-server/data/projects` 不存在（`ls` 报 No such file）。`data/runs/` 现有 7 个 run 目录。
6. 契约常量与类型已存在且未被 import：`canvas-server/src/contracts.js`（`ID_PREFIX` `:11`、`LEGACY_ALIASES` `:84`）、`web/src/types/domain.ts`（`Project` `:99-117`、`JobMeta` `:250`）。文件头均自述「本波不接线」。
7. 前端路由：`web/src/router.tsx:25-33`（9 条路由，无 `/projects`）。导航项：`web/src/constant/navigation-tools.ts:5-29`（7 项）。
8. 画布/素材仍全在浏览器 localforage：`use-canvas-store.ts:10-22`（`CanvasProject`）、key `:43`；`use-asset-store.ts:9-26`（`Asset`）、key `:45`；`Asset` 无 `projectId`/`bindingId`。
9. run 前端曾是裸 `useState`：`web/src/pages/pipeline/use-pipeline-run.ts:72`（**注意**：`development-plan.md §2` 标注为 `:64`，本轮实际为 `:72`，行号已漂移；结论不变）。新增的 run 持久化 store 在 `web/src/stores/use-pipeline-store.ts:16`（key `infinite-canvas:pipeline_runs_v1`，上限 30 条）。
10. 插件 `reindex()` 仍会重写 id：`plugins/canvas/storyboard-studio/src/storyboard.ts:66`（`export function reindex`）。
11. 02 阶段 Shot 契约 11 字段：`skills/02-storyboard/SKILL.md:68`（`id/sceneId/index/durationSec/shotSize/camera/action/dialogue/audio/prompt/negativePrompt`）。
12. WebDAV 同步域闭合集合仅 4 个：`web/src/services/app-sync.ts:14`（`"canvas" | "assets" | "image-workbench" | "video-workbench"`）—— 与 `development-plan.md §9`「不给 WebDAV 加同步域」一致。

## 附录 B：本轮未验证 / 属推断的事项

- 旧 localforage 数据在本机浏览器里的**实际条数与结构样本**未核对（无浏览器数据），导入适配层的字段映射需在 M5 用真实数据复核。
- 「工作区页面从契约反推组件」的具体组件清单（表格/时间线/详情抽屉）本轮**未展开**，属 M4 设计细化，不在本方案。
- 阶段门禁与 `ReviewNote.level="block"` 的联动，本文给的是**建议规则**，服务端如何落 `stageGates[]` 属 M2 实现细节。

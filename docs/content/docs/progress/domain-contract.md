# 领域契约（冻结领域词汇）

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 版本：v1（P0-0）。上位文档：`prd.md`（产品意图）、`development-plan.md`（执行计划，本文依据其 §3、§3.1、§3.2、§4.1、§7、§8）。
> 本文是 **P0-a / P0-b / P0-d 共同引用的唯一契约文本**。字段名已冻结，实现必须逐字对齐；不得改名，不得引入同义字段。
> 机器可读部分同步落在 `web/src/types/domain.ts`（类型）与 `canvas-server/src/contracts.js`（常量/枚举）。

---

## 1. 适用范围与权威

本契约只做一件事：**固定一套自洽的生产链词汇与稳定 ID，让「这张图是第几集、哪一场、哪一镜，用了哪个工作流和工具，生成了哪些关键帧与片段」在系统里可回答。**

- 生产链主语：`Project → Episode → Scene → Shot → GenerationSlot → Job → Artifact → AssetRef`。
- 编辑表面：`Canvas`（浏览器侧），是 Project 上下文中对同一批对象的编辑视图，不拥有生产事实。
- 权威来源：`prd.md` §3.1 / §3.2 与 `development-plan.md` §3、§3.2、§7（决策 D1–D6）。冲突时以 `development-plan.md` 的已登记决策与本文冻结骨架为准。

**三条已登记决策直接约束本契约内容**：

- **D1（命名）**：`Project` = 一部剧（剧集容器），现有 `CanvasProject` 更名为 `Canvas`（画布）。一个 Project 可包含多个 Canvas。
- **D2（产物存储）**：`Asset` / `AssetRef` **默认引用服务端产物**（`/api/artifacts/<jobId>/<file>`），**不下载、不复制像素**。
- **D3（生产事实）**：Project、Episode、Scene、Shot、AssetRef、WorkflowRun、Artifact 清单以**服务端为权威**；Canvas 高频编辑态留在浏览器，两者通过 `projectId` / `canvasId` / 稳定语义 id 关联。

补充决策（同为本契约的语义前提）：

- **D4（分层）**：`Workflow`（可版本化 DAG，管阶段/依赖/门禁/产物契约）与 `Tool`（一次可执行能力，管路由到 Provider/Device）分层。替换工具不改变 Shot / AssetRef / 历史 Artifact。
- **D5（状态）**：每个 Stage / Job / GenerationSlot 采用**独立状态机**；阶段 `done` 收紧为「本阶段所有必需 Job 均成功且产物已回写」，不再以「已入队」当完成。
- **D6（调度）**：按资源类别的 Device/Provider Registry 调度，Job 记录 `deviceId`、排队/执行时间与失败原因；本契约只冻结 `Tool.resourceClass` 与 `Job.meta` 的归属字段，不冻结调度算法。

---

## 2. 三个世界与归属边界

| 世界 | 存储位置 | 权威内容 | 不负责 |
| --- | --- | --- | --- |
| **Project（服务端）** | `data/projects/<id>/`（目录细节属 P0-a） | 剧本、主线、资产作用域、工作流版本、运行记录、交付物、完成度、`reviewNotes[]` | 不承载画布每次拖动产生的大对象 |
| **Canvas（浏览器 localforage）** | 浏览器 | nodes / connections / viewport / chatSessions | 不拥有剧本或生成任务的唯一事实 |
| **Artifact（服务端产物）** | 网关磁盘 `/api/artifacts/...` | 不可变文件 | 不复制成第三份无主文件；`AssetRef` 只引用 |

跨世界只通过稳定 id 引用。**任何一方的实体字段都不得承载另一方的内联大对象。**

---

## 3. 实体契约

> 命名统一的字段语义：`id` = 稳定标识（见 §4）；`index` = 可重排展示序（**只有 index 会因重排变化，id 不变**）；时间戳一律 ISO 8601 字符串。

### 3.1 Project（服务端，一部剧）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `prj_<26位ULID>` | 是 | 稳定主键 |
| `title` | `string` | 是 | 剧名 |
| `createdAt` | `string` | 是 | 创建时间 |
| `updatedAt` | `string` | 是 | 最近更新时间 |
| `styleAnchor` | `string` | 是 | 风格锚点：一句话，全项目所有生图/生视频提示词首句必须一字不差（PRD §3.2、§4 阶段 0） |
| `plan` | `Plan` | 是 | 阶段 0 规划产物，结构见下 |
| `script` | `unknown` | 是 | 一份剧本（01 阶段产物的权威副本）。**内部形态由 P0-a/P1-c 定**，本契约只冻结字段名与归属 |
| `sourceRevisionId` | `string \| null` | 否 | 当前采用的源版本 id，指向 `sources/<revisionId>.json`；初始为 `null`（P0-a 回填，见 `p0a-project-kernel-plan.md` §1.5 #2） |
| `episodes` | `Episode[]` | 是 | 多条主线 = 多集/多单元，共享同一套角色/场景/道具资产（PRD §3.2 主线语义） |
| `assetRefs` | `AssetRef[]` | 是 | 项目内的语义引用（引用而非复制，D2） |
| `runIds` | `string[]` | 是 | 关联的流水线 run；一个项目可跑多轮 |
| `canvasIds` | `string[]` | 是 | 关联的画布项目（浏览器侧，即 `Canvas.id`） |
| `checklist` | `ChecklistItem[]` | 是 | 完成度检查表，项目页直接渲染。条目形态记 P0-a |
| `reviewNotes` | `ReviewNote[]` | 是 | 审核风险提示：**只提示、不改稿**（AGENTS.md「内容创作规范」、PRD §7）。结构化条目见下（D9） |
| `ownerUserId` | `string` | 否 | 跟进人标识（D7 单写者约定：一条线只有一个人跟，靠人工协商，不做自动合并） |
| `version` | `number` | 是 | 项目版本号，用于识别写入归属（D7；不做自动冲突解决，细节 P0-a） |

**`ReviewNote`（审核风险提示，D9：任何环节都可产生，按 scope 就近展示）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 稳定主键 |
| `scope` | `project \| episode \| scene \| shot` | 是 | 归属层级，决定在哪个环节页面就近展示 |
| `targetId` | `string` | 否 | 对应层级的实体 id；`scope=project` 时省略 |
| `stage` | `string` | 是 | 产出该提示的阶段（0 规划 / 剧本 / 分镜 / 资产 / 关键帧 / 视频 / 后期） |
| `source` | `llm \| human` | 是 | 提示来源 |
| `level` | `info \| warn \| block` | 是 | 严重程度；`block` 是否作为阶段门禁由 P0-a 定 |
| `message` | `string` | 是 | 提示正文，**与产物正文严格分离** |
| `createdAt` | `string` | 是 | 创建时间 |
| `resolvedAt` | `string` | 否 | 处理时间；未处理为空 |

> 展示位置：项目总览页汇总全部未解决项，对应环节页面就近显示本 scope 的条目——谁在那个环节做决策，就在那个环节看得见。只提示不改稿。

**`Plan`（阶段 0 规划参数，D8：项目级默认，逐集可覆盖）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `genre` | `string` | 是 | 题材 |
| `tone` | `string` | 是 | 剧作基调 |
| `visualStyle` | `string` | 是 | 视觉呈现形式（写实真人 / 二维动画 / 像素风 / 俳偶戏…）；可直接进提示词的短语 |
| `ratio` | `string` | 是 | 画幅比例（如 `9:16`） |
| `episodeDurationSec` | `number` | 是 | 单集时长（秒） |
| `dramaMode` | `string` | 是 | 叙事取向：`短剧向` / `微电影向` / `单元剧` / `连续剧`；预置可选、也支持自定义 |
| `audience` | `string` | 是 | 目标受众 |
| `episodeCount` | `number` | 是 | 目标集数 |

> **01 剧本阶段回填**：`script` 阶段产物可含可选 `planSuggestion`（字段 `genre` / `tone` / `visualStyle` / `dramaMode` / `audience` / `episodeCount?` / `episodeDurationSec?`，语义同上表）。服务端在剧本阶段完成后**只回填项目 `plan` 中用户尚未填写的字段**（仍是默认占位值的字段），已有值一律不动；`ratio` / `styleAnchor` **不在建议范围内**。回填走 `projects.update`（原子写 + version 自增），且**幂等**：重复投递 / 重启重放不会反复覆盖。

### 3.2 Episode（集 / 单元）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `ep_<4位序号>` | 是 | 稳定主键 |
| `projectId` | `prj_…` | 是 | 归属项目 |
| `index` | `number` | 是 | 集序号（可重排；id 不变） |
| `title` | `string` | 是 | 集标题 |
| `logline` | `string` | 否 | 一句话剧情 |
| `plan` | `Partial<Plan>` | 否 | **逐集覆盖**（D8）：只写要覆盖的字段，未写的继承 `Project.plan`；改项目级默认不影响已显式覆盖的集 |
| `sceneIds` | `string[]` | 是 | 本集场次引用 |
| `canvasIds` | `string[]` | 是 | 本集关联的画布（如分镜板） |
| `status` | `string` | 是 | 集状态；枚举值属 P0-a（本契约不冻结集级状态机） |
| `deliverableIds` | `string[]` | 是 | 本集交付物引用 |

### 3.3 Scene（场）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `sc_<4位序号>` | 是 | 稳定主键 |
| `episodeId` | `ep_…` | 是 | 归属集 |
| `index` | `number` | 是 | 场内序（可重排；id 不变） |
| `locationId` | `string` | 是 | 地点稳定 id（**替代现状用地点名对齐**，development-plan §3.1） |
| `time` | `string` | 是 | 时间（日/夜/晨昏等） |
| `intent` | `string` | 是 | 场次意图 |
| `beatIds` | `string[]` | 是 | 节拍引用 |

### 3.4 Shot（镜头）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `sh_<创建时生成>` | 是 | **稳定不可重排**：创建时生成一次，此后增删调序都不得改写（development-plan §3.1、§5.2、陷阱见 §6） |
| `episodeId` | `ep_…` | 是 | 归属集 |
| `sceneId` | `sc_…` | 是 | 归属场；**代码必须校验并 join**，不再由 LLM 自由书写 |
| `index` | `number` | 是 | 镜序；**重排只改 index，不改 id** |
| `storyboard` | `unknown` | 是 | 分镜数据；内部形态记 P0-a（现有插件 `Shot` 与服务端 02 契约 11 字段同名同义，可作为导入来源） |
| `generationSlots` | `GenerationSlot[]` | 是 | 该镜的生成活扣（关键帧、片段等） |
| `status` | `string` | 是 | 镜状态；枚举值属 P0-a |

### 3.5 GenerationSlot（生成活扣）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `slot_<shotId>_<role>` | 是 | 稳定主键 |
| `shotId` | `sh_…` | 是 | 归属镜 |
| `role` | `string` | 是 | 该槽角色（如关键帧 `start`/`key`/`end`、片段 `clip`）；具体枚举 P0-a 定 |
| `selected` | `string \| null` | 是 | 当前采用的候选 `jobId`；未采用为 `null` |
| `candidates` | `Candidate[]` | 是 | 全部历史候选（换模型重跑**只新增候选，不删除旧结果**）；**不设数量上限、不自动清理**（D10），磁盘压力由用户手动归档 |

> 现有 pipeline item 的单值 `jobId` / `artifactUrl` / `status` 是 `selected` 候选的**派生别名**，见 §6。

### 3.6 Candidate（候选）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `template` | `string` | 是 | 本次 attempt 使用的模板/工具标识（每次独立，可在 regenerate 时更换） |
| `jobId` | `string` | 是 | 本次 attempt 的 Job |
| `artifactUrl` | `string \| null` | 是 | 产物 URL；未产出为 `null`（回写断链修复后由投影器写入） |
| `status` | `CandidateStatus` | 是 | 候选状态，见 §5.3 |
| `params` | `Record<string, unknown>` | 是 | 本次实际参数 |
| `createdAt` | `string` | 是 | 创建时间 |

### 3.7 Artifact（不可变产物）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 稳定主键 |
| `jobId` | `string` | 是 | 产出它的 Job |
| `url` | `string` | 是 | `/api/artifacts/<jobId>/<file>`（D2：被引用，不复制） |
| `type` | `string` | 是 | 产物类型（image/video/audio/…）；枚举值 P0-a 定 |
| `checksum` | `string` | 是 | 校验和 |
| `createdAt` | `string` | 是 | 创建时间 |
| `nodeId` | `string` | 否 | 关联画布节点 |
| `outputName` | `string` | 否 | 输出文件名 |

### 3.8 AssetRef（项目内语义引用）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 稳定主键 |
| `projectId` | `prj_…` | 是 | 归属项目 |
| `role` | `character / scene / prop / keyframe / clip` | 是 | 引用语义类别 |
| `bindingId` | `string` | 是 | 绑定到剧本里的哪个角色/场景/道具 → **一致性锚点的落点** |
| `episodeId` | `ep_…` | 否 | 可选：限定到某集 |
| `sceneId` | `sc_…` | 否 | 可选：限定到某场 |
| `shotId` | `sh_…` | 否 | 可选：限定到某镜 |
| `artifactIds` | `string[]` | 是 | 指向的 Artifact（多候选） |
| `selectedArtifactId` | `string \| null` | 是 | 当前采用的 Artifact |
| `metadata` | `Record<string, unknown>` | 是 | 附加上下文（来源、模型、设备、质量状态等；字段开放） |

### 3.9 Workflow / Stage / Tool（D4 分层）

**Workflow**（可版本化 DAG）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 工作流标识 |
| `version` | `string` | 是 | 版本 |
| `stages` | `Stage[]` | 是 | 阶段列表 |

**Stage**（逻辑阶段）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 阶段 id（剧本/分镜/资产/关键帧/视频/后期…） |
| `title` | `string` | 是 | 阶段名 |
| `requires` | `string[]` | 是 | 依赖的上游产物/阶段 |
| `produces` | `string[]` | 是 | 产出的产物契约 |
| `gate` | `string` | 是 | 人工确认门禁（如 `manual` / `auto`）；枚举值 P0-a 定 |
| `tools` | `string[]` | 是 | 可用 Tool id 列表 |

**阶段 ID 权威命名（冻结，唯一权威）**

> 本表冻结「阶段 ID」：门禁、流水线 registry、前端工作区三处**共用同一套命名**，实现逐字对齐，不得改名、不得引入同义别名。
> 落点：服务端门禁 `canvas-server/src/gates.js` 的 `GATE_STAGES`、流水线 `skills/registry.json` 的 run 阶段、前端 `web/src/pages/projects/workspaces.ts` 的 `stage` 字段。

| 阶段 ID | 名称 | 归属 | 上游依赖 requires | 说明 |
| --- | --- | --- | --- | --- |
| `plan` | 规划 | 项目级（非 run 阶段） | — | 阶段 0 规划产物 `Project.plan`；不是流水线 run 的一段 |
| `script` | 剧本 | run 阶段（01） | `plan` | 小说 → 剧本（`skills/01-novel-to-script`），可产出可选 `planSuggestion` |
| `storyboard` | 分镜 | run 阶段（02） | `script` | 剧本 → 分镜表 |
| `design` | 资产（服化道） | run 阶段（03） | `script` | 角色 / 场景 / 道具造型；**取代旧名 `assets`** |
| `keyframe` | 关键帧 | run 阶段（04） | `storyboard`、`design` | 生成型阶段：出关键帧图像 |
| `assembly` | 片段生成 | run 阶段（05） | `keyframe` | 生成型阶段：片段 → 成片；**取代旧名 `video`** |
| `post` | 后期 | 交付阶段 | `assembly` | 成片交付 / 后期（音字等）；非 01~05 五段式 run 阶段的默认组成 |

**旧名作废**：`assets`（→ `design`）、`video`（→ `assembly`）不再作为阶段 ID 使用；门禁匹配、前端 `stage` 字段、`ReviewNote.stage` 均以本表为准。

**Tool**（一次可执行能力）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 工具标识（ComfyUI 模板 / LLM / 外部 API / TTS / ffmpeg 的统一适配器） |
| `capability` | `string` | 是 | 能力名 |
| `paramsSchema` | `Record<string, unknown>` | 是 | 参数 schema（驱动前端渲染，字段开放） |
| `resourceClass` | `GPU_IMAGE / GPU_VIDEO / CPU / LLM / API` | 是 | 资源类别，供 D6 调度 |
| `providers` | `string[]` | 是 | 可选 Provider 列表 |
| `cancelable` | `boolean` | 是 | 是否可取消 |
| `retryable` | `boolean` | 是 | 是否可重试 |

### 3.10 Job.meta（在现有基础上扩展）

现有 `{ runId, stageId, itemId }` **保留**，新增以下**可选**语义归属字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `runId` | `string` | 是 | 归属 run（现有） |
| `stageId` | `string` | 是 | 归属阶段（现有） |
| `itemId` | `string` | 是 | 归属条目（现有） |
| `projectId` | `prj_…` | 否 | 归属项目 |
| `episodeId` | `ep_…` | 否 | 归属集 |
| `sceneId` | `sc_…` | 否 | 归属场 |
| `shotId` | `sh_…` | 否 | 归属镜 |
| `toolId` | `string` | 否 | 执行的 Tool |
| `workflowRunId` | `string` | 否 | 归属项目级工作流运行（development-plan §3.0/§3.1 要求 Job 同时带 projectId/episodeId/sceneId/shotId/workflowRunId/toolId） |

> 服务端 `generate.js:143` 已透传 `body.meta`，画布侧 `GatewayGenerateBody` 尚缺这些字段（属 P0-a/P0-b 接线）。

### 3.11 Canvas（浏览器编辑表面，D1：原 `CanvasProject` 更名）

> 画布保存在浏览器 localforage，是 Project 上下文里的编辑表面；生产事实在服务端（D3）。高频拖拽产生的大对象（nodes/connections/viewport/chatSessions）只存浏览器。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 画布主键；存在 `Project.canvasIds[]` 中 |
| `title` | `string` | 是 | 画布名（角色板 / 场景板 / 某集分镜板…） |
| `createdAt` / `updatedAt` | `string` | 是 | 时间戳 |
| `nodes` / `connections` | `unknown[]` | 是 | 沿用现有结构（本契约不复刻） |
| `chatSessions` / `activeChatId` | `unknown[]` / `string \| null` | 是 | 助手会话 |
| `backgroundMode` / `showImageInfo` / `viewport` | `string` / `boolean` / `{x,y,k}` | 是 | 沿用现有结构 |
| `ownerUserId` | `string` | 否 | **跟进人（D7）**：同一画布同一时间只由一个人跟进，归属靠人工协商 |
| `lastEditorId` | `string` | 否 | 最近写入者；与 `ownerUserId` 不一致时只提示「该项目当前由 X 跟进」，**不自动覆盖** |
| `version` | `number` | 是 | 版本号，用于识别写入归属（D7；不做自动冲突解决） |

---

## 4. 稳定 ID 规则

| 实体 | 前缀 | 生成时机 | 稳定性约束 |
| --- | --- | --- | --- |
| Project | `prj_` | 创建项目时，前缀 + 26 位 ULID | 永不变 |
| Episode | `ep_` | 建集时，`ep_` + 4 位序号 | 序号补零；集重排不改 id |
| Scene | `sc_` | 建场时，`sc_` + 4 位序号 | 序号在**项目内全局唯一**（跨集不重复）；场重排不改 id |
| Shot | `sh_` | 建镜时生成 | **不可随重排改变**：增删调序只改 `index`，`id` 恒定。现有插件 `reindex()` 把 id 重写成 `sh1..shN`，**必须改为只改 index**（development-plan §5.2、§6 陷阱） |
| GenerationSlot | `slot_` | 挂到 shot 上时，`slot_<shotId>_<role>` | 随 shotId 稳定；同 shot 同 role 唯一 |

**统一约束**：

- `index` 是可重排展示序，**任何重排只改 `index`，不改任何 `id`**。
- 外部引用（画布节点、AssetRef、Job.meta）一律引用稳定 `id`，禁止引用 `index` 或序号字符串。

枚举前缀常量见 `canvas-server/src/contracts.js` 的 `ID_PREFIX`。

---

## 5. 状态机

> D5：阶段、任务、活扣各有独立状态机；**Job 状态是唯一事实来源**，阶段与槽的终态由任务终态投影得到，且必须可重放、幂等。

### 5.1 Stage（阶段）

值集：`pending | running | partial | done | error | canceled`

| 迁移 | 条件 |
| --- | --- |
| `pending → running` | 启动该阶段 |
| `running → done` | **本阶段所有必需 Job 均成功且产物已回写**（D5 收紧；「已入队」不算 done） |
| `running → partial` | 有 ≥1 必需 Job 终态为 `error`/`canceled`，且仍有已成功产物可审阅 |
| `running → error` | 阶段整体失败，无可用产物（如 LLM 返回非法 JSON、引用悬空） |
| `running → canceled` | 取消沿 `workflowRun → stage → job` 传播完成 |
| `partial → running` | 仅对失败项续跑/重试 |
| `partial → done` | 原失败项全部补齐，且全部必需 Job 成功且产物已回写 |
| `error / canceled → running` | 显式重跑（新 attempt） |

**终态判定**：`done` | `error` | `canceled` 为终态；**`partial` 非终态**（表示部分成功、待续跑）。
旧行为「入队即 `done`」作废（development-plan §4.1、§6 陷阱 5）。

### 5.2 Job（任务，语义不变）

值集：`queued | running | done | error | canceled`

| 迁移 | 条件 |
| --- | --- |
| `queued → running` | worker 取到并开始执行 |
| `queued → canceled` | 入队后立即取消 |
| `running → done` | 执行成功，`outputs` 非空 |
| `running → error` | 执行失败（非用户取消） |
| `running → canceled` | 用户取消 / abort |

**终态判定**：`done` | `error` | `canceled`。终态不可再迁移；重跑必须使用新 attempt（新 Job / idempotency key），禁止旧任务覆盖新状态。

### 5.3 Candidate / Slot（候选与活扣）

值集：`pending | queued | running | done | failed | canceled`

| 迁移 | 条件 |
| --- | --- |
| `pending → queued` | 为该 slot 入队一个候选 Job |
| `queued → running` | 候选 Job 开跑 |
| `running → done` | 候选产物成功，写入 `Candidate.artifactUrl` |
| `queued / running → failed` | 候选 Job 终态为 `error` |
| `* → canceled` | 取消 |

**判定规则**：

- 单个候选终态：`done` | `failed` | `canceled`。
- **Slot 无独立终态**：是否有可用候选取决于 `candidates[]` 中是否存在 `done`；是否「完成」取决于 `selected` 是否指向一个 `done` 的候选。
- 失败候选不得清空成功候选（整集部分失败可续跑，禁止回滚成空白）。
- 候选**不设上限、不自动清理**（D10）；磁盘压力由用户手动归档。

枚举冻结对象：`canvas-server/src/contracts.js` 的 `STAGE_STATUS` / `JOB_STATUS` / `CANDIDATE_STATUS`。

---

## 6. 兼容别名与迁移映射表

> 现有代码字段 → 新契约字段。**兼容别名保留**：下游与前端不因引入 `candidates[]` 而改动。

### 6.1 兼容别名（必须保留读取）

| 现有字段 | 契约字段 | 处理 |
| --- | --- | --- |
| `item.jobId` | `GenerationSlot.selected`（选中候选的 `jobId`） | 派生别名，保留 |
| `item.artifactUrl` | 选中候选的 `artifactUrl` | 派生别名，保留；回写断链修复后由投影器写入 |
| `item.status` | 选中候选的 `status` | 派生别名，保留 |

### 6.2 迁移映射

| 现有代码字段 / 概念 | 新契约字段 | 说明 |
| --- | --- | --- |
| `CanvasProject`（`use-canvas-store.ts:10-22`） | `Canvas` | 纯改名（D1）；字段不变，仅 `projectId` 语义需纠正 |
| `CanvasAgentSnapshot.projectId`（当前填的是**画布 id**） | `Canvas.id`（在 `Project.canvasIds[]` 中） | 语义纠正，避免 `projectId` 歧义（D1 代价说明） |
| `Asset`（`use-asset-store.ts:15-26`） | `AssetRef`（项目引用模型） | 现有浏览器 Asset CRUD 只作迁移输入，不约束新接口（development-plan §5.2） |
| `Asset.projectId`（**当前缺失**） | `AssetRef.projectId` | 空 = 全局素材库；有值 = 项目私有 |
| `Asset.bindingId`（**当前缺失**） | `AssetRef.bindingId` | 绑定到剧本里的角色/场景/道具 → 一致性锚点 |
| `item.template`（全局单值 `pipelineConfig.imageTemplate`） | `Candidate.template` | 每次 attempt 独立，可在 regenerate 换模板（PRD §3.3） |
| pipeline item 单值 `{jobId, artifactUrl, status, template}` | `GenerationSlot { selected, candidates[] }` | 单值 → 候选数组；旧字段作 §6.1 别名 |
| `run.options.projectId` | `Project.id`（`project.json` 权威） | **过渡位**：可先塞 `run.options`（零服务端改动），Project 内核建立后转正（development-plan §3.1、§5.1） |
| `job.meta { runId, stageId, itemId }` | `JobMeta`（加可选 `projectId`/`episodeId`/`sceneId`/`shotId`/`workflowRunId`/`toolId`） | 服务端已透传 `body.meta`，画布侧待补字段 |
| stage 现用 `status = "done"`（入队即完成） | `StageStatus.done`（收紧为全部必需 Job 成功且产物回写） | 语义收紧（D5） |
| `episodes[]`（01 契约存在、代码零消费） | `Episode` 分区键 | 提为主键；scene/shot/frame/clip 全带 `episodeId`（development-plan §3.1） |
| `shots[].sceneId`（LLM 自由书写、从不校验） | `Scene` / `Shot.sceneId`（代码校验并 join） | `design.locations` 从按地点名对齐改为 `locationId` 对齐 |
| 插件 `reindex()` 重写 `sh1..shN` | `Shot.id` 稳定、`reindex()` 只改 `index` | `plugins/.../storyboard.ts:65-68` |
| `characters[].appearance`（仅能当 JSON 看） | 升格为项目级资产（`bindingId`） | development-plan §3.1 |

机器可读清单见 `canvas-server/src/contracts.js` 的 `LEGACY_ALIASES`。

---

## 7. 明确「不属于本契约」的边界

以下内容**不在本契约范围**，属 P0-a 或后续工作包，**本波不设计、不冻结**：

1. **页面、路由、信息架构、导航**：项目总览页、分镜/资产/关键帧/后期工作区、组件边界与交互流程（development-plan §7.2、§7.3）。
2. **接口契约**：HTTP 方法、URL（如 `POST /api/pipeline/runs/:id/steps/:stage/regenerate`）、请求/响应体（P0-a）。
3. **存储目录细节**：`data/projects/<id>/...` 的目录布局、原子写/rename、版本校验、恢复日志（development-plan §3.2 给出的目录仅为建议，落地属 P0-a）。
4. **Tool 的具体内容**：具体 `paramsSchema` 字段、ComfyUI 模板名、Provider/Device 清单与调度算法（D6 只冻结 `resourceClass`）。
5. **内容创作规范**：本契约**不注入**任何道德教化、审查、正向落点、惩罚落点字段；`reviewNotes[]` 只作独立风险提示、**绝不改稿**（AGENTS.md「内容创作规范」、PRD §7、D 决策无相关内容）。
6. **实时协作、商业化外壳、模型市场、云端生成后端**（PRD §9）。
7. **旧数据迁移脚本与兼容兜底**：项目未上线，不写旧字段兼容/数据迁移兜底（AGENTS.md 基本原则）。
8. **阶段 0 参数枚举、集/镜状态枚举、`GenerationSlot.role` 枚举、`Artifact.type` 枚举等**：留待 P0-a 定义后回填；候选上限（D10）与审核提示粒度（D9）已拍板，见 §8。

---

## 8. 已拍板决策与遗留待定

### 8.1 已由用户拍板（2026-10-03，登记于 `development-plan.md` §7 D7–D11）

| 项 | 决策 | 落点 |
| --- | --- | --- |
| 画布并发写入 | **D7 单写者约定**：一条线只有一个人跟，人工协商归属；不做自动合并/锁服务/CRDT，只在归属不一致时提示 | §3.11 Canvas 的 `ownerUserId`/`lastEditorId`/`version` |
| 规划参数层级 | **D8 项目级默认、逐集可覆盖** | §3.1 `Plan` + §3.2 `Episode.plan?` |
| 审核提示粒度 | **D9 任何环节可产生，按 scope 就近展示** | §3.1 `ReviewNote` 结构化定义 |
| 候选保留上限 | **D10 不设上限、不自动清理** | §3.5 `candidates`、§5.3 |
| 一键跑完五阶段 | **D11 不做**，保留逐阶段人工审核门禁 | 阶段门禁（P0-a 落地） |

### 8.2 文档分歧（按冻结晶执行，无需再拍板）

- **`Job.meta.workflowRunId`**：`development-plan §3.0/§3.1` 要求 Job 带 `workflowRunId`，本契约已采纳（§3.10）。
- **Project 字段命名**：本文/`development-plan §3.2` 用 `canvasIds[]`/`assetRefs[]`/`runIds[]`；`prd.md §3.2` 用 `canvasProjectIds[]`。**统一以本文冻结晶为准**，PRD 表述后续对齐。
- **阶段状态值**：采用 `pending / running / partial / done / error / canceled`；`development-plan §4.1/§6` 出现的 `planned / ready / failed` 措辞作废（`failed`→`error`，`ready`/`planned` 无对应态）。

### 8.3 仍未冻结、留待 P0-a 回填的内部形态

`Project.script` 结构、`ChecklistItem`、`Shot.storyboard`、集/镜 `status` 枚举、`GenerationSlot.role` 枚举、`Artifact.type` 枚举、`Workflow.version` 类型、`ReviewNote.level = block` 是否作为阶段门禁。

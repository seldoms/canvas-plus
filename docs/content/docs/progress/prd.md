# 产品需求文档（PRD）—— 本地化短剧生产平台

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 版本：v1（2026-10-02）。本文描述**现状**与**目标架构**，是后续所有开发的对齐基准。
> 姊妹文档：`local-asset-inventory.md`（对内资产盘点）、`gateway-api-benchmark.md`（对外能力对标）。
>
> 现状描述全部经代码或真机核实，标注 `file:line` 或任务 id。

---

## 1. 产品定位

**一句话**：把「一部长篇小说 → 一部可播放的短剧」这条链路，完整跑在用户自己的机器上。

| 维度 | 定位 |
| --- | --- |
| 目标用户 | 独立创作者、短剧小团队、出海内容工作室 |
| 核心场景 | 长篇小说改编成竖屏短剧；单集 5-10 分钟；多集/多单元共用一套角色与场景资产 |
| 发行市场 | **海外**（决定了 §7 的创作取向） |
| 部署形态 | 本地优先：网关 + ComfyUI + Ollama 全在内网，浏览器直连，单端口同源 |
| 差异化 | 零边际成本、私有资产不出机器、产物永久不过期、可取消可续跑、RGBA 透明直出 |

**不是**：云端 SaaS、多人实时协作平台、模型市场。

## 2. 现状：三个互不相通的世界

这是本 PRD 要解决的**核心问题**。三套数据模型各自成立，但彼此零引用：

| 世界 | 存储位置 | 现有实体 | 缺失 |
| --- | --- | --- | --- |
| **画布项目** | 浏览器 localforage | `CanvasProject`（`web/src/stores/canvas/use-canvas-store.ts:10-22`）= id / title / **nodes / connections** / chatSessions / viewport / backgroundMode；另有 `deletedProjects` 回收站 | 它只是**画布容器**，不是生产项目：无剧本、无主线、无资产作用域、无 run 关联 |
| **素材库** | 浏览器 localforage | `Asset`（`web/src/stores/use-asset-store.ts:15-26`）= kind / title / coverUrl / **tags** / source / note / metadata | **无 `projectId`** → 全局一锅不分项目；**无 `bindingId`** → 无法绑定到剧本里的某个角色/场景/道具 |
| **流水线 run** | 网关 `data/runs/<id>/` | novel + 5 阶段产物 + artifacts + `estimate` + `chunked` | **无 projectId、无画布引用** → 跑完即孤儿，产物进不了画布也进不了素材库 |

**验证**：`grep -rn "runId|pipelineRun" web/src/stores/canvas/ web/src/pages/canvas/ web/src/lib/canvas/` → **零命中**。
路由层面同样割裂：`/canvas/:id`、`/pipeline`、`/assets` 三个孤岛。

### 2.1 已经具备的能力（不要重做）

| 能力 | 证据 |
| --- | --- |
| 五段流水线 + SKILL.md 驱动的依赖图 | `skills/registry.json` 声明 `requires`/`produces`；`createPipeline` |
| 超长小说分块改编（map-reduce） | `src/chunk-novel.js`；222 万字 / 163 块 / 83 分钟真机跑通（`run-muqv28e9-i0j3b`） |
| **进度可见 / 可取消 / 断点续跑 / 成本预估** | `progress.json` + `chunks/<i>.json` + `GET .../progress` + `POST .../cancel` + `run.estimate`；实测 `run-mur4csot-suj8z` |
| 单 worker 串行队列 + 重启收敛 | `jobs.js`；`reconcileRunning()` |
| ComfyUI 模板 token 契约三件套 | `extractTokens` / `renderTemplate` / `disableEmptyLoras` / `disableEmptyImageRefs` |
| 16 个工作流模板（生图 4 / 编辑 3 / 放大 1 / 视频 8） | `/api/providers` |
| **Qwen-Image 2.1 五项能力** | 文生图、指令改图、抠背景、透明贴纸直出、多图参考（≤10 张）—— 全部真机跑通 |
| 外部 LLM 渠道注册表 + `渠道名::模型名` 路由 | `GET/POST /api/llm/providers`；密钥不落 run、GET 脱敏 |
| 画布插件 SDK + 第一个插件 | `plugin-node-context.ts`；`plugins/canvas/storyboard-studio`（分镜工作台） |
| Agent 批量画布 op | `applyCanvasAgentOps` + 8 个 op，等价于对标产品的 `nodes_connections_batch` |

### 2.2 已知缺口（详见 `local-asset-inventory.md` §D 与 `development-plan.md`）

**最严重的一条**：`attachGeneration` 把 `item.artifactUrl` 置 null 后**全仓再无任何代码写回**（任务队列完成时没有回调进流水线），导致 `pipeline.js:483`（尾帧取首帧当参考图）、`:497-498`（assembly 入队条件）、`:513`（`stage.artifacts`）三处恒假 —— **五段流水线实际只有四段半，结构性到不了成片**。图确实生成了、前端靠直接轮询 jobs 也能看见，但 run 自己永远不知道，下游拿不到。

其余缺口：`assembly` 还**另外**缺一个 ffmpeg 拼接执行体（这是与上面那条**不同**的问题：前者是拿不到关键帧所以不入队，后者是即使入队产出了片段也没有拼接成片的执行体）· 前端 `run` 是裸 `useState`，刷新即永久丢失且服务端已有的 `GET /api/pipeline/runs` 前端没封 · 五个阶段的 SKILL.md 提示词很薄（各约 90 行，只有机器契约没有创作方法论）· `skills/libraries/` 两个库导入未接线 · 生图/生视频模板选择写死在全局 config，重跑会清空上次产物，**无法对比** · 网关局域网侧无鉴权。

## 3. 目标架构

### 3.1 Project 成为一等实体（混合存储）

**决策**：生产事实上服务端，编辑态留浏览器，双向 `projectId` 引用。与 LibTV 的分工一致（他们的 VFS `/api/canvas/folder/vfs/*` 在服务端存剧本与草稿，画布编辑态在浏览器）。

| 数据 | 存哪 | 理由 |
| --- | --- | --- |
| 项目元数据、风格锚点、规划参数 | **服务端** `data/projects/<id>/project.json` | 生产事实，需稳定、可被流水线读取、可跨端 |
| 剧本、主线（集/单元）、资产引用、完成度检查表 | **服务端** | 同上；且剧本是分镜/资产/关键帧的唯一上游 |
| 流水线 run 关联 | **服务端** | run 本来就在服务端 |
| 画布 nodes / connections / viewport / chatSessions | **浏览器** localforage | 高频写、体积大、离线可用更重要 |
| 素材二进制 | **浏览器**（现状）+ 服务端 `artifacts/`（生成产物） | 不改现状，用引用打通 |

> AGENTS.md 已明确「项目尚未上线，不需要兼容旧数据；本地存储结构调整时直接按新设计修改，不写旧字段兼容或数据迁移兜底」——本次可自由重构存储结构。

### 3.2 数据模型

```
Project  (服务端 data/projects/<id>/project.json)
  id, title, createdAt, updatedAt
  styleAnchor          // 风格锚点：一句话，全项目所有生图/生视频提示词首句必须一字不差
  plan                 // 阶段 0 规划产物
    { genre, tone, ratio, episodeDurationSec, dramaMode, audience, episodeCount }
  script               // 一份剧本（01 阶段产物的权威副本）
  episodes[]           // 多条主线 = 多集/多单元
    { id, title, logline?, sceneIds[], status, runId?, canvasProjectId? }
  assetRefs[]          // 混用媒体库：引用而非复制
    { assetId, kind, role: character|scene|prop|keyframe|clip, bindingId, episodeId? }
  runIds[]             // 关联的流水线 run（一个项目可跑多轮）
  canvasProjectIds[]   // 关联的画布项目（浏览器侧）
  checklist            // 完成度检查表，项目页直接渲染
  reviewNotes[]        // 审核风险提示（见 §7，只提示不改稿）

Asset  (浏览器，扩展两个字段)
  + projectId?         // 空 = 全局素材库，有值 = 项目私有
  + bindingId          // 绑定到剧本里哪个角色/场景/道具 → 一致性锚点的落点

GenerationSlot  (活扣，挂在 keyframe/assembly 的 item 上)
  candidates[]         // { template, jobId, artifactUrl, status, params, createdAt }
  selected             // 当前采用的候选（jobId）
  // item.jobId / artifactUrl / status 保留为 selected 的别名，下游与前端不用改
```

**主线语义**（已确认）：一个项目 = 一部剧集；多条主线 = **多集/多单元**，每集有自己的分镜与成片，**共享同一套角色/场景/道具资产**。
落点已存在：01 剧本契约里的 `episodes[]`（`{id, title, sceneIds[]}`）当前标为「可选」且无人使用，正好作为主线容器。

### 3.3 生图/生视频「活扣」

现状是两处硬编码（`pipeline.js:329-337`）：

```js
item.jobId = null; item.artifactUrl = null;   // 重跑就摧毁上次结果 → 结构上无法对比
item.template = pipelineConfig.imageTemplate;  // 全局单值；run.options.image.template 也不生效
```

目标：换成 §3.2 的 `GenerationSlot`。新端点 `POST /api/pipeline/runs/:id/steps/:stage/regenerate`，body `{ itemId, template, params? }` → **只给这一个 item 追加一个候选**，不动其它。前端每个 item 横向铺开候选缩略图，点选切换 `selected`，配「换个模型再出一张」下拉（列出 `/api/providers` 里同 family 的全部模板）。

同一套机制天然覆盖 keyframe（图）、assembly（视频），以及将来资产阶段的角色三视图与场景多视角。

## 4. 六阶段流水线（吸收短剧创作方法论后）

现状 5 段，提示词各约 90 行、只有机器契约。吸收外部方法论后为 **6 段**（新增阶段 0），并保留我们已有的输出契约与校验规则 —— 方法论灌进「提示词模板」段，不破坏编排器依赖的 JSON 契约。

| 阶段 | 现状 | 目标补强（关键项） |
| --- | --- | --- |
| **0 规划**（新增） | **无** | 参数澄清、规划报告、**完成度检查表**、**风格锚点锁定** |
| 1 剧本 | 87 行，产出场次拆解 | 四段产物（1500 字梗概 / 人物小传 / 场景清单 / **完整剧本正文**）、`X-Y` 场次号、`△` 动作提示、`角色VO:`、`【节拍：XXX】`、真人电影六大流派大师锚点、单集 3-5 章节结构、长篇幻觉声明与分批交付 |
| 2 分镜 | 89 行 | 三层结构（章节→片段→镜头）、时间戳跨章连续、镜头密度按基调分档、节奏速查表、符号规则 `()<>{}『』【】`、景别/运镜术语表、POV 规则、连续性规则 |
| 3 资产 | 91 行 | 角色三视图规格（左 1/3 正脸特写 + 右 2/3 三视图 + 纯白底）、场景 6 视角、道具三视图、提示词颗粒度三层推演、角色/场景描述顺序、视觉差异化策略、命名规范、目视验收表 |
| 4 关键帧 | 93 行 | **9 条判定标准 + 逆向排除 + 判定口诀**、短剧向/微电影向两套优先级、`EPxx_CHxx_SEGxx_KFxx` 命名与映射表、分镜绑定硬约束、**方向性物体空间关系公式**、9:16/16:9 构图规则 |
| 5 视频提示词 | 96 行 | 7 段提示词结构、9 步转换方法、多主体 `@图片N` 标签、「关键帧承担画面元素、文字只写运镜/动作/剧情/声音」、质检清单、负向约束 |

同时接线 `skills/libraries/` 两个已导入未接线的库：`script-writing-studio`（26 个 reference）与 `Luster-iwai-aesthetic-prompt`（岩井俊二美学，正好是方法论「东方生活流/家庭治愈」流派点名的锚点大师之一）。**风格锚点机制就是把 Luster 接上的钩子。**

### 4.1 不能照搬的外部数值

外部方法论来自云端平台，其数值绑定的是**它们的**模型与配额，必须按我们的实测重推：

| 外部写的 | 我们的实际约束 |
| --- | --- |
| 单段视频锁定 15s | H3 的 `LENGTH` 是 **17n+5 帧 @24fps**（5s≈124 帧、10s≈243 帧）。写 15s 会渲染出错误帧数 |
| 单批最多 2 个视频 | 平台配额。我们是**单卡串行队列**，一次只能一个（约束更硬），排队数量不该设上限 |
| 场景 6 张图 + 角色三视图 | 单卡 16GB、Qwen2.1 int8 约 1 分钟/张 → 6 场景 × 6 视角 = 36 张 ≈ **半小时起**，必须先给成本预估（复用 `run.estimate` 机制） |
| `present_files` 交付 | 我们的等价物是产物落盘 + `/api/artifacts/` + 画布节点 |
| 用户确认门禁 | **我们已经有**（逐阶段手动 run + `setStageInput` 人工修订），但没他们细（资产逐一确认） |

## 5. 画布 ⇄ 流水线打通

用户最强调的一条。最小闭环三步：

1. **流水线 → 画布**：run 产物一键铺到画布 —— 按主线（集）分组，每镜一个图节点 + 一个视频节点，自动连线。**底座已在**：`applyCanvasAgentOps` + Agent 的 8 个 op，不需要新机制。
2. **画布 → 流水线**：画布里的文本节点「送入流水线」创建 run；选中的图片节点「登记为项目资产」并绑定到某个角色/场景（写 `bindingId`）。
3. **项目页**成为交汇点：主线列表 + 剧本 + 完成度检查表 + 画布缩略图 + 资产网格 + 审核风险提示。

## 6. 功能需求与优先级

> 执行细节、依赖关系、验收标准与决策登记见 `development-plan.md` §8。本表只给产品视角的优先级。

| 优先级 | 需求 | 依赖 |
| --- | --- | --- |
| **P0** | 流水线可观测/可取消/可续跑/成本预估 | ✅ **已完成并真机验证** |
| **P0-a** | 修 `artifactUrl` 回写断链，让五段流水线真的能到成片 | — |
| **P0-b** | run 可恢复：持久化 runId、封已有的 `GET /api/pipeline/runs`、run 可命名、离开页面拦截 | — |
| **P0-c** | 命名重构（Project = 剧、Canvas = 画布）+ Project 服务端实体与 CRUD | P0-a、P0-b |
| **P1-a** | 打通流水线出口：产物一键入素材库（引用 URL 不复制）、`shots[]` 一键导入分镜板 | P0-a、P0-c |
| **P1-b** | 生图/生视频活扣（candidates + regenerate + 并排对比 UI） | P0-a（同一条回写通路） |
| **P1-c** | 六阶段方法论吸收（含阶段 0）+ 接线两个库 | P0-c（风格锚点、完成度检查表是项目级字段）；受 §7 约束 |
| **P1** | `episodes[]` 升格为主线容器；剧本成为项目级权威产物 | P0-c |
| **P2** | 项目页完整化、标识符贯通（episodeId/sceneId/shotId）、角色资产升格 | P1 |
| **P2** | `assembly` 接 ffmpeg 拼接执行体（**与 P0-a 是两个不同问题**） | P0-a |
| **P2** | `TemplateInfo.schema` 化（让「拷个 JSON 就自动可用」成立） | — |
| **P2** | 网关 `auth.mode`（局域网侧无鉴权） | — |
| **P3** | 契约死字段清理（`comfy.maxQueue` 从未被读取、job `progress` 只填 0/0） | — |

## 7. 内容创作规范（硬约束）

本项目产出的短剧**面向海外发行**，创作取向由用户决定，不由模型代为把关。写技能、提示词模板与任何改编逻辑时都受本节约束。

- **忠于原著、忠于用户的改动意见**：改编时不得为了道德教化、价值观引导、过审或「更积极健康」而默认改动原著的人物动机、情节走向、结局、尺度或台词。原著怎么写就怎么改，**只有用户明确要求时才改**。
- **不注入教化式结构**：不强制「反派必须受到实质惩罚」，不强制「情感闭环」或「正向落点」。结局形态由原著与用户决定。吸收外部短剧方法论时，其「反派惩罚铁律」「人物小传必须写惩罚落点」「澄清清单里的禁用内容」三条**必须去掉**；微电影向那条「不追求反派实质惩罚」与本项目取向一致，保留。
- **风险只提示、不改稿**：允许并鼓励识别可能过不了审核的内容（政策、平台规则、年龄分级、IP 授权等），但**只能作为独立提示（`project.reviewNotes[]`）交给用户决定，绝不能自行修改正文来规避风险**。风险提示与产物正文严格分离，不混进剧本、分镜表、生图/生视频提示词。
- **评审类角色一律降级为顾问**：`skills/libraries/script-writing-studio` 的「审查官（备案视角）」等评审 persona 接线时必须改成**只输出风险清单、不改稿**；`01b-rhythm-matrix.md` 的「视频号｜中老年友好 / 价值观正向」这类国内平台专属行不适用本项目。
- **质量审查 ≠ 内容审查**：图片与视频的质量校验（人设图左侧是否正脸、三视图是否与特写一致、关键帧是否对得上剧情与资产设定）照做不误，那是工艺要求，与本节无关，不要一起删掉。

> 说明：我们自己的 `skills/01~05/SKILL.md` 经 grep 核实**零条**道德/审查条款，无需删改；本节主要约束**即将进行的方法论吸收（P1）**与**库接线**。

## 8. 非功能需求

| 项 | 要求 | 现状 |
| --- | --- | --- |
| 长任务可观测 | 任何超过 30 秒的操作必须有进度 | ✅ 流水线已做；生成任务的 `progress` 仍只填 0/0（未接 ComfyUI WebSocket） |
| 长任务可中止 | 任何后台任务都能取消并释放产能 | ✅ 生成任务与流水线阶段均可取消 |
| 长任务可恢复 | 崩溃/重启后不必从头再来 | ✅ 分块结果落盘 + `resume`；启动收敛遗留 running |
| 成本可预知 | 开跑前给出块数/调用次数/预计耗时 | ✅ `run.estimate`；**资产阶段的多图生成还需复用同一机制** |
| 探测不复用长超时 | 列资源/探活类接口独立短超时 + 并行 | ✅ `llm.probeTimeoutMs` 8s；曾因复用 600s 导致 `/api/health` 挂 20 分钟 |
| 密钥 | 明文只存 `0600` 文件；GET 脱敏；透传不落盘 | ✅ 最小档已做；正经 `auth.mode` 待做 |
| 轮询开销 | 轮询端点必须轻量 | ✅ `progress.json` 几十字节，**不是** 6.4MB 的 `run.json` |

## 9. 明确不做

- **实时协作与跟随模式**：无 Yjs/CRDT，画布自研（无 React Flow），与本地优先路线正面冲突
- **商业化外壳**：会员、积分、挑战赛、学院
- **模型生态/市场**：不做模型托管与分发
- **云端生成后端**：RunningHub 适配器保留但不投入（旧 Key 已失效，真机验证排在 P3 之后）
- **内容道德把关**：见 §7，风险只提示不改稿

## 10. 待确认

> 权威清单在 `development-plan.md` §10；已给出 CTO 建议并登记为决策的见该文件 §7。

1. Project 的**服务端 CRUD 与浏览器画布**之间，冲突如何解决？（同一项目两台设备同时改画布 → 目前无协同，倾向「后写覆盖 + 版本号提示」，画布域已有墓碑机制可复用）
2. ~~`assetRefs` 是引用还是复制~~ → **已决策 D2：默认引用服务端产物，不下载不复制**，理由与兜底见 `development-plan.md` §7
3. 阶段 0 规划的参数（比例、单集时长、剧作基调）是**项目级一次锁定**，还是允许逐集覆盖？
4. 审核风险提示 `reviewNotes[]` 的粒度：按项目、按集、还是按镜头？
5. 活扣的候选保留上限（防止一个镜头攒几十个候选撑爆磁盘）？
6. 「一键跑完五阶段」要不要做？做了就必须在**全局取消**与**逐阶段确认门禁**之间取舍（外部方法论强调每阶段停下等确认，与一键跑完冲突）
7. 「项目」这个词的归属 → **已给出建议 D1：Project = 剧、Canvas = 画布**，属机械改名重构，但必须在 P0-c 之前完成

## 11. 基线（复核用）

```bash
cd canvas-server && node --test test/*.test.mjs   # 73/73
cd web && npx tsc --noEmit                        # 退出码 0
curl -s http://127.0.0.1:8788/api/health          # llm.ok / comfy.ok 均 true，ComfyUI 0.38.2
curl -s http://127.0.0.1:8788/api/providers       # 16 个模板：image 4 / video 8 / edit 3 / upscale 1
```

147 的 ComfyUI **0.38.2**（`comfy-aimdo` 0.5.5，H3 主力管线已复测通过 `video-muqp3s3h-26kei`）。
Qwen-Image 2.1 走官方 safetensors 路线（`qwen_image_2.1_int8_convrot.safetensors` 6.76GB 已就位），五项能力实测通过；**GGUF 路线是死路**（上游 `detect_arch` 无任何 qwen 架构）。细节见 `HANDOFF.md` 坑位。

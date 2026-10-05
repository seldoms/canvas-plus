# M0/M1 施工计划与现状审计（第一轮）

> 内部文档，不登记进 `meta.json`。
> 基线：分支 `canvas-plus`，提交 `9851959 docs: establish short-drama production blueprint`（工作区干净）。
> 依据：`project-integration-implementation-guide.md`（M0–M6 定义）、`domain-contract.md`（字段冻结）、`development-plan.md`（决策 D1–D16）、`platform-positioning.md`（C1–C10、P1–P9）、`prd.md`。
> 审计方式：两个独立审计子 Agent 分别通读 `canvas-server/src`（46 个源文件、约 21,095 行、100 个测试文件）与 `web/` + `canvas-agent/` + `skills/`，关键结论已由主 Agent 对代码复核（`gates.js` 阶段集合、`registry.json` 七阶段、`jobs.js` 无幂等键均已亲自验证）。

---

## 1. 现状审计结论（摘要）

### 1.1 已经有的（不要重做）

- **七阶段注册表已正确**：`skills/registry.json` = `script → storyboard → design → casting → keyframe → audio → assembly`，requires 链完整（audio 与 assembly 并行）。
- **Project 内核已落地**：`projects.js` / `episodes.js` / `sources.js` / `assets.js` / `bible.js`，Project/Episode/Scene/Shot/AssetRef/Bible 均有存储与路由，原子写 + 乐观版本。
- **Job→Artifact→Candidate 回写已修**（P0-b）：终态投影 + 启动重放，`GenerationSlot.candidates[]` 在 run 侧工作，逐条 `regenerate` 只追加候选。
- **提示词编译已在三条主链入队前执行**（pipeline `compilePromptItem`、工作台 `compileWorkbenchPrompt`、通用 `submitGeneration`），失败降级记 warning，前端无编译暴露（`prompt-compile.ts` 客户端是无调用方的死代码）。
- **产物契约校验 + 审计日志**：`stage-artifact-check.js` + `run-log.js` 已接线。
- **交付执行器**：`delivery.js`（ffmpeg 拼接/混音/字幕/封面/manifest）+ `edit-export.js`（剪辑交接包，仅 CLI）。

### 1.2 关键缺口（整改对象）

| # | 缺口 | 证据 | 归属里程碑 |
| --- | --- | --- | --- |
| 1 | 阶段集合三处不一致：`gates.js` 缺 `casting`/`audio`；前端 `use-pipeline-run.ts` 兜底 `design.requires=["storyboard"]` 与 registry 冲突 | `gates.js:18-30`（已复核）；`pilot-issues.md` #96/#97 | M0 |
| 2 | 阶段状态实际使用 `blocked`，但 `contracts.js` `STAGE_STATUS` 枚举没有它 | `pipeline.js:3040 enforceCastingGate` | M0（待拍板） |
| 3 | 无统一 `GenerationIntent`：四条独立生成构造路径（画布直连 `index.js:311`、工作台 `workbench-jobs.js:154`、流水线 `pipeline.js:2589`、TTS 试听 `index.js:566`） | 服务端审计 §6 | M1 |
| 4 | Job 无 `idempotencyKey`，重复提交产生重复 Job；归属只有 `meta{runId,stageId,itemId}`，缺 `projectId/shotId/slotId/toolId`（契约 §3.10 已规划未实现） | `jobs.js:133`（已复核） | M1 |
| 5 | `GenerationSlot` 无一等实体，`Shot.generationSlots[]` 只是壳；Candidate 只活在 run.json；Take/Approval 无实体 | 服务端审计 §2 | M3.5 |
| 6 | 画布与 Project 数据层零关联（C7）：画布产物不进 Artifact/AssetRef，`CanvasAgentSnapshot.projectId` 填的是画布 id | 前端审计 §2/§6 | M2 |
| 7 | `edit-export.js` 只有 CLI 无 HTTP/UI；Agent 无 `project_*` 工具 | 前端审计 §6 | M4/M5 |
| 8 | 音频链：`audio.js`/`audio-track.js`/`audio_qwen3_tts` 已建且有真实产物，但 AudioCue 落库、对白事实源唯一性、响度/M&E 未闭环 | 服务端审计 §8 | M4 |
| 9 | 分层违规：`files.js` import `http.js`（AGENTS.md 点名案例仍在）、`providers/llm.js` 碰 `res`、`index.js` 约 250 行业务逻辑、`pipeline.js` 3676 行超级编排器 | 服务端审计 §10 | 伴随治理，不单独立项 |

---

## 2. 现状 → M0～M6 映射

| 里程碑 | 现状判定 | 依赖 | 文件范围 | API 变化 | 数据变化 | 验收方式 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M0** 阶段/字段/状态/门禁统一 | 🟡 registry 已对，gates/前端两处漂移 | 无 | `canvas-server/src/gates.js`、`contracts.js`、`index.js`（gates 路由传参）；`web/src/pages/pipeline/use-pipeline-run.ts`、`web/src/pages/projects/workspaces.ts`、`web/src/types/domain.ts`；新增对齐测试 | 无新增；`/api/projects/:id/gates` 与 `/api/pipeline/stages` 阶段集合变得一致 | 无落盘结构变化；枚举可能追加 `blocked`（待拍板） | 三处阶段集合相等断言（契约测试）；未确认 casting 时 keyframe/audio 均 blocked；网关不可达前端不放行 | `hasOutput` 补 casting/audio 判据时误拦旧项目（须保持「无实体不约束」的向后兼容）；枚举追加属冻结契约变更，需先登记 |
| **M1** 统一生成提交链 | 🟡 编译已三链覆盖，但无统一 Intent、无幂等键、归属不全 | M0 | 新增 `canvas-server/src/generation-intent.js`；改 `jobs.js`、`workbench-jobs.js`、`index.js`（submitGeneration 段）、`pipeline.js`（enqueueAttempt 调用点）；`web/src/services/api/gateway.ts`（类型） | 现有三个提交端点形状不变，内部收敛到同一 submit；Job meta 增加归属字段 | `jobs.json` 的 job.meta 增加 `source/projectId/episodeId/sceneId/shotId/slotId/toolId/idempotencyKey`；旧 job 容忍缺失 | 同一事实三入口提交产生同形 Job meta；重复 idempotencyKey 返回原 Job 不重复入队；编译失败仍降级有 warning、无空 prompt；真实 keyframe 镜头走通 Intent→Compiler→Job→Artifact→Candidate | `pipeline.js` 3676 行耦合深，enqueueAttempt 改造面大；pipeline 已有带指纹缓存的编译，统一入口与「避免重复编译」需要折中设计 |
| **M2** Canvas 接入 Project 事实链 | ⬜ 数据层完全断连（C7，D14 已拍板接、深度倾向 B） | M1 | `web/src/pages/canvas/*`、`stores/canvas/*`、`services/api/*`、`lib/canvas/canvas-agent-ops.ts`；服务端资产登记路由复用现有 | 画布生成改走网关队列；新增「加入项目候选/采用」动作调用现有 AssetRef/Slot API | Canvas 增 `projectId`；节点存 `artifactId/assetRefId` 引用不存 base64 | 项目画布生成→刷新+网关重启后节点仍显示同一 Artifact；采用后才改 selected；删节点不删被引用 Artifact | 画布离线能力下降；`pages/canvas/project.tsx` 约 3400 行，改造面大；不做大 UI 重构的前提下接入 |
| **M3** 工作台与项目互通 | 🟡 工作台已走服务端队列，缺「加入项目候选」动作 | M1 | `web/src/pages/image/*`、`pages/video/*`、`services/api/*` | 工作台 Job 结果可登记为 Slot 候选（复用 regenerate/候选追加通路） | 无新实体；工作台 job.meta 带项目上下文 | 换模型生成候选旧候选仍可播；采用/撤销可重复；刷新后两侧候选一致 | 不建第二套 Job/Artifact 状态机是硬约束 |
| **M3.5** Shot/Take/Approval + H3 continuation | ⬜ POC 未跑；契约字段已冻结（§3.6） | M1、H3 能力探测 | `canvas-server/src/production-contracts.js`、pipeline 续接编排（新模块）、Provider 能力描述；`research/win147-comfyui` | 续接提交/分叉/恢复端点（设计属本里程碑） | Candidate 追加 `takeId/continuationChainId/segmentIndex/parentArtifactId/continuation.seam` | 链可回溯、中断恢复不重复入队、分叉不改原链、每接缝有 QC 指标 + 人工复核 | H3「无限续接」是待验证能力，POC 未完成前不得写进主流程；16GB 显存 OOM 史（#25） |
| **M3.6** Skill/Compiler/Provider 分层 | 🟡 bible.js 五类圣经已有且接门禁；Skill 产物是阶段 JSON 而非目标 Bible/Book/Plan 命名 | M0 | `skills/*`（只动产物形态映射）、`canvas-server/src/bible.js`、`prompt-compiler.js`、`registry.js` | Provider 能力查询增强 | Skill 输出映射为结构化事实对象并入 provenance | 同一份 ShotPlan 可编译到 Qwen Image / H3 / Qwen3-TTS；不支持的参考槽位入队前 400/409 | 不复制第三方运行时代码；前端不得暴露编译层 |
| **M4** 声音与后期闭环 | 🟡 TTS 工作流真实出音、台词清洗已修（#50）；Cue 落库与混音闭环缺 | M1、M3.6 | `canvas-server/src/audio.js`、`audio-track.js`、`pipeline.js`、`delivery.js`、`edit-export.js`（接 HTTP）、`skills/06-audio` | 交付包导出接 HTTP/UI；audio 阶段产 AudioCue | `project.voiceProfiles/audioCues` 持久化；对白唯一事实源 | 改一句台词只重跑对应 TTS/字幕/后期，不重跑视频；无对白镜头无 TTS Job；缺片段/音频/字幕/封面不得标 ready | GPU 串行纪律（TTS/H3/口型不得并行占卡） |
| **M5** Agent 批量生产与恢复 | ⬜ canvas-agent 33 个工具全是 canvas_*/workbench_*，无 project_* 作用域 | M1–M4 | `canvas-agent/src/*`（新增 project 工具 + canvas-server HTTP 客户端）、`web/src/lib/agent/*` | 新增 7 个 project_* MCP 工具（context/gates/job/run stage/cancel/adopt/export） | Agent 操作审计（actor/thread/turn/item/前后版本/幂等键） | Agent 完成「读项目→计划→确认→批量入队→等终态→只重试失败→采用→导出」；重复调用不重复入队 | `CanvasAgentSnapshot.projectId` 语义纠正（装的是画布 id）是前置 |
| **M6** 60–90 秒真实闭环 | ⬜ 最远处跑到 keyframe 全 done + assembly partial（6 镜 OOM） | M0–M5 全部 | 全链 | — | — | 真实 Project 走完全链；含 2–4 段 continuation chain、一次中断恢复、一次中间分叉、一次重开链、一次改台词只重跑音频+后期 | 单卡 16GB 串行，一集 8 段 ≈ 1 小时 GPU；验收耗时长，需预留窗口 |

---

## 3. M0 施工计划

**目标**：阶段定义单一来源 = `skills/registry.json`；门禁、前端工作区不再各写一份阶段数组；状态枚举与实现对齐。

### 任务拆分

1. **`gates.js` 改为 registry 派生**（`canvas-server/src/gates.js`）
   - `deriveGates({ project, episodes, bibles, stages })` 新增 `stages` 入参（由路由层从 `skills.js loadRegistry` 注入，保持 gates.js 纯推导不碰 IO）。
   - `GATE_STAGES` 常量删除，阶段集合与 requires 由 registry 派生；`plan`（项目级）与 `post`（交付后期）不作为 run 阶段，plan 保留为项目级门禁首项，post 是否保留在 gates 输出末尾需在施工中按「post 不是 run 阶段、但交付门禁仍要可见」处理——保持输出向后兼容（旧前端读 plan/post 仍拿到条目）。
   - `hasOutput` 补 `casting`（身份卡 `confirmed`）与 `audio`（AudioCue 投影存在性）判据；无对应数据时不产生约束（旧项目行为不变）。
2. **前端去兜底**（`web/src/pages/pipeline/use-pipeline-run.ts`、`web/src/pages/projects/workspaces.ts`）
   - 删除 `FALLBACK_STAGES`；`/api/pipeline/stages` 不可达时显示 unknown、不放行（#59 已修门禁读取，本轮清残余数组）。
   - `workspaces.ts` 的 `requires` 改从阶段元数据读取，不手写。
3. **状态枚举对齐（待拍板项 A）**：`stage.status` 实际取值含 `blocked`（casting 门禁，`pipeline.js:3040`），`contracts.js STAGE_STATUS` 与 `web/src/types/domain.ts` 均不含。
   - 建议：追加 `blocked` 到 `STAGE_STATUS`（追加式冻结，登记进 `domain-contract.md` §5.1 与变更记录），语义 = 「上游/定妆未满足，阶段被挡住，尚未运行」。
   - 备选：`blocked` 不下存入 stage.status，仅作为 gates 输出派生；改动更小但 casting 门禁的落盘状态要改。
4. **契约对齐测试**：新增 `canvas-server/test/stage-alignment.test.mjs` —— registry 阶段集合 ≡ gates 输出集合 ≡（静态读取）前端 workspaces 阶段集合；`web` 侧可用类型/常量断言。

### M0 验收

1. `GET /api/pipeline/stages`、`GET /api/projects/:id/gates`、前端工作区三处阶段 ID 集合完全相等（契约测试断言）。
2. 未确认 casting 时 keyframe 与 audio 均 `blocked`；网关不可达时前端不放行（现有 #59 行为保持）。
3. 新增一个阶段只改 registry 与对应 Tool，不动三处数组（以测试模拟验证）。
4. `node --test test/*.test.mjs` 全绿；`web` `tsc --noEmit` 0 错。

---

## 4. M1 施工计划

**目标**：所有生成提交收敛为 `GenerationIntent → 能力校验 → 提示词编译 → Job` 一条链；Job 带完整归属与幂等键。

### 任务拆分

1. **新增 `canvas-server/src/generation-intent.js`**（纯业务模块，不 import `http.js`）
   - `createGenerationIntent(input)`：规整 `{ id, source: project|canvas|workbench|api, kind: image|video|audio, context: { projectId, episodeId, sceneId, shotId, slotId, runId, stageId }, toolId, template, facts, references, params, options }`；缺 `kind`/`template` 抛 400 级契约错误。
   - `submitGenerationIntent(intent, deps)`：四步——上下文校验（projectId 非空时项目须存在，否则 400/409）→ Tool/能力解析（复用 `registry.js canRun` + `capability-limits.js`，不新增校验逻辑）→ 提示词编译（复用 `prompt-compiler.js`；`intent.params.PROMPT` 已由调用方编译时跳过，避免双重编译——这是与 pipeline 既有指纹缓存编译的折中，M3.6 再收口为单一编译出口）→ `jobs.enqueue`，meta 写入全量归属。
2. **`jobs.js` 幂等键**：`enqueue` 支持 `meta.idempotencyKey`；内存派生索引 `key → jobId`，同 key 命中（不限状态，含终态）直接返回原 Job，不重复入队、不重复执行。索引随 `jobs.json` 持久化重建（启动时从存量 job.meta 回填）。行为语义：**同 key 重放返回原结果**，这是验收标准明文要求。
3. **三个调用方接线**（响应形状不变，前端零改动）：
   - `index.js` `submitGeneration`（约 :311–371）：body → Intent（`source` 取 body.source 或默认 `"api"`），编译/尺寸吸附逻辑移入 submit 路径；路由层只留解析与回响应（顺带治理「index.js 写业务」中这一段）。
   - `workbench-jobs.js` `enqueue`：构造 `source="workbench"` Intent，保留现有 `compileWorkbenchPrompt` 结果经 `params.PROMPT` 传入。
   - `pipeline.js` `enqueueAttempt`：补传 `projectId`（`run.options.projectId`）、`shotId`（item.shotId）、`slotId`（`slot_<shotId>_<role>`）、`toolId`、`idempotencyKey`（`runId+stageId+itemId+attempt` 派生，保证重跑是新 attempt、同 attempt 重放幂等）。
   - TTS 试听路由（`index.js:545` 段）：非生产 Job，本轮不动，登记边界。
4. **前端类型补齐**：`web/src/services/api/gateway.ts` 的 `GatewayGenerateBody` 增 `meta/origin` 可选字段（契约 §3.10/§6.2 已登记）；不发新请求，本轮只让类型就位。
5. **测试**：
   - `test/generation-intent.test.mjs`：缺 kind/template → 400；projectId 不存在 → 400/409；同 idempotencyKey 重放 → 同 job id、队列计数不变；meta 归属字段完整。
   - HTTP 集成：三入口（`/api/generate/image`、`/api/images/enqueue`、pipeline 阶段入队）产出同形 meta。
   - 回归：`node --test` 全绿。

### 第一条真实镜头链路验证（第一轮第 5 项）

M1 落地后立即执行（真实网关、真实队列，接受 GPU 成本约 1 张图）：

1. 取现有项目（如「最后一班」）或新建测试 Project，绑定 run。
2. 对单个 shot 的 keyframe slot 调 `POST /api/pipeline/runs/:id/steps/keyframe/regenerate`。
3. 验证：Job meta 含 `projectId/shotId/slotId/stageId/toolId/source`；Artifact 落盘且索引可查；`candidates[]` 追加新候选、旧候选不动；`selected` 不因生成自动改变；同 idempotencyKey 重复提交不重复入队；编译失败路径（注入 LLM 故障）产出同步结构稿 + warning、无空 prompt。
4. 记录 `projectId/runId/shotId/jobId/artifactId` 与脱敏响应快照；结束后确认 GPU 队列无遗留。

### M1 验收（对照 guide §6 指标）

- 三入口同一事实提交 → Job 的 template/编译版本/参考槽位语义一致。
- 任意 Job 可经 `projectId → shotId → slotId` 回溯；独立试验 `projectId` 为空但可查看。
- 浏览器网络与界面不出现最终编译提示词（维持现状，回归确认）。
- 编译失败降级记 warning，无空 prompt、不卡队列。

---

## 5. 子 Agent 分工（本轮只派 A、B）

| Agent | 范围 | 文件边界 | 不碰 |
| --- | --- | --- | --- |
| **A（M0）** | 阶段集合统一、枚举对齐、对齐测试 | `canvas-server/src/gates.js`、`contracts.js`、`index.js` 仅 `/gates` 调用点、`test/stage-alignment.test.mjs`（新）；`web/src/pages/pipeline/use-pipeline-run.ts`、`pages/projects/workspaces.ts`、`types/domain.ts` | `pipeline.js`、`jobs.js`、`workbench-jobs.js`、`index.js` 其余段落 |
| **B（M1）** | GenerationIntent + 幂等 + 三调用方 | `canvas-server/src/generation-intent.js`（新）、`jobs.js`、`workbench-jobs.js`、`index.js` 仅 submitGeneration 段、`pipeline.js` 仅 `enqueueAttempt` 调用点、`test/generation-intent.test.mjs`（新）；`web/src/services/api/gateway.ts`（类型） | `gates.js`、前端页面、registry.json |

**执行顺序**：A 先行（改 `index.js` gates 调用点），B 在 A 合并后动手（改 `index.js` submitGeneration 段），避免同文件并发。C–F（Canvas 接入、H3 POC、音频后期、Agent 工具）本轮不启动。

**派活要求**（沿用 `subagent-acceptance-checklist.md`）：先读 `domain-contract.md` §3.9/§3.10/§5、`project-integration-implementation-guide.md` §5/§6/§9、本计划对应章节；提交说明写明改了哪条事实链、哪些接口、哪些验证指标通过。

## 6. 待拍板项（施工前需确认）

| # | 议题 | 建议 |
| --- | --- | --- |
| A | `STAGE_STATUS` 追加 `blocked`（`pipeline.js` 已在用，枚举没有） | 追加并登记进 `domain-contract.md` §5.1，语义=「被门禁挡住、尚未运行」 |
| B | `idempotencyKey` 命中语义 | 同 key 重放一律返回原 Job（含终态），不重新执行；key 由调用方按「一次业务意图一个 key」生成 |
| C | pipeline 侧既有带指纹缓存的编译与统一编译出口的关系 | 本轮折中：submit 支持「已编译跳过」；M3.6 再收口单一编译出口 |

## 7. 文档与收尾要求

- M0/M1 施工完成后：变更按前缀记入 `CHANGELOG.md` `Unreleased`；`todo.mdx` 对应条目移 `pending-test.mdx`；`domain-contract.md` §3.9 的「代码侧三处不一致」登记在修复后更新。
- 不改 `skills/registry.json` 阶段定义（它是源）；不复制第三方运行时代码；不做大 UI 重构；不动站内时间线。

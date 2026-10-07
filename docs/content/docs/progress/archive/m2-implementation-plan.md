# M2 施工计划：Canvas 接入 Project 事实链

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 内部文档，不登记进 `meta.json`。接续 `m0-m1-implementation-plan.md`（M0/M1 已验收）。
> 依据：`platform-positioning.md` §5.5（D14 已拍板「接」，深度倾向 **B 中度接入**）、P6（项目/流水线一律走网关，浏览器直连只留试验表面）、`domain-contract.md` §3.5/§3.10。
> 前置调查：画布前端与服务端项目 API 已由两个独立 explore 子 Agent 通读，结论见 §1。

---

## 1. 前置调查结论（施工依据，不要重复查）

### 1.1 画布现状（前端）

- 生成完全**浏览器直连外部 AI 网关**（`web/src/services/api/image.ts` 的 `requestGeneration/requestEdit`，`Authorization: Bearer <apiKey>`），不经 canvas-server；入口汇聚在 `web/src/pages/canvas/project.tsx:2305-2736 handleGenerateNode`。
- 结果存 localforage，节点 `metadata.content` = blob URL + `storageKey`（`web/src/types/canvas.ts:47-98`）；刷新后靠 `hydrateCanvasImages`（`web/src/lib/canvas/canvas-generation-helpers.ts:45-67`）重建 blob URL。
- 多画布存 `web/src/stores/canvas/use-canvas-store.ts`（`CanvasProject[]`，nanoid id，localforage 持久化）；**无任何服务端 projectId**。
- `CanvasAgentSnapshot.projectId`（`web/src/lib/canvas/canvas-agent-ops.ts:17-24`）填的是画布 id，语义错误（M5 前置，本轮顺带修）。
- 反向已有：服务端 Project 上下文带 `canvasIds[]`，项目详情页可跳转 `/canvas/:id`（`web/src/pages/projects/project.tsx:159-174`）；`web/src/services/api/projects.ts` 已是服务端项目 API 客户端。
- 画布→项目方向**零引用**：无任何「加入候选/发送到项目」动作；唯一出口是本地「我的素材」与 zip 导出。

### 1.2 服务端现状

- 浏览链路够用：`GET /api/projects` → `GET /api/projects/:id/episodes` → `GET /api/projects/:id/episodes/:episodeId`（内嵌 scenes/shots/generationSlots）。无需新 GET。
- slotId 规则统一：`slot_<shotId>_<role>`（role 目前只有 `"key"`，`pipeline.js:1592-1610 generationSlotsFor`）。
- **缺口一**：候选投影只认 `runId+stageId+itemId` 三元组（`pipeline.js:3170-3173 projectJob`）；画布 Job 即使 meta 带 projectId/shotId/slotId，终态无人消费。
- **缺口二**：Project 侧 slot 由 `projectKeyframeFacts`（`pipeline.js:1660`）**覆盖式**重写，画布追加的候选会被下次投影冲掉——必须改合并。
- **缺口三**：无「登记外部文件为 Artifact」端点（`/api/uploads` 不进 artifacts 索引；索引由 `artifacts.js` 从 jobs.outputs 懒构建）。
- **缺口四**：Slot 级「追加候选/采用」无任何端点（`episodes.js:230 SHOT_MUTABLE` 白名单拒绝 generationSlots；AssetRef 级有 select 语义可参照 `assets.js:92`）。
- `project.canvasIds[]` 字段已存在（`projects.js:294`），无写入方。
- M1 已就绪：`generation-intent.js` 的 `INTENT_SOURCES` 含 `"canvas"`，context 直通 projectId/episodeId/sceneId/shotId/slotId；`jobs.js` 幂等键可用。

## 2. 设计决策（本轮拍板，施工不得偏离）

| # | 决策 | 理由 |
| --- | --- | --- |
| M2-D1 | **绑定制**：画布显式「绑定」服务端项目（`CanvasProject.serverProjectId` + `Project.canvasIds` 双向登记）后才启用事实链能力；未绑定的画布保持纯本地试验表面，生成链不变 | D14 倾向 B 档 + P6 口径；保住画布离线能力（B 档风险项），绑定动作即用户显式选择 |
| M2-D2 | **绑定画布的图片生成改走服务端队列**（`POST /api/generate/image`，meta 带 source="canvas" + 归属 + idempotencyKey），产物节点 `metadata.content` 直接存 artifact http URL（同源相对路径），不再只存 blob | B 档核心：三套提交链收敛成一条（C10）；artifact URL 天然解决「刷新+网关重启后节点仍显示同一 Artifact」 |
| M2-D3 | 视频/音频生成**本轮不接**，只接图片（关键帧槽位 role="key"，也是目前唯一存在的槽位类型） | slot 只有 keyframe 投影在生成；控制改造面 |
| M2-D4 | 「加入项目候选」支持**存量画布图片**：新端点 `POST /api/artifacts/import` 用「合成已完成 Job」登记字节（复用 jobs→artifacts 整条懒索引机器），再追加为槽位候选 | 避免给 artifacts.js 开第二条索引来源；幂等键天然复用 |
| M2-D5 | 槽位候选追加/采用走**新最小端点**（§3），不复用 run 投影；`projectKeyframeFacts` 改为**合并**：保留非本 run 来源的候选与指向它们的 selected | 缺口一/二的解法；保证 run 重跑不冲掉画布候选 |
| M2-D6 | 绑定画布生成成功 → 服务端**自动投影**为候选（终态 Job meta 有 projectId+shotId+slotId 且无 runId 时追加）；采用（selected）永远只能由显式 select 端点改变 | 对应验收「采用后才改 selected」；自动投影只追加候选、不动 selected |
| M2-D7 | `CanvasAgentSnapshot` 增 `canvasId` 字段装画布 id；`projectId` 改为绑定的服务端项目 id（未绑定为 null）；消费方同步改 | 修正语义错误，M5 前置 |
| M2-D8 | 不做大 UI 重构：不拆 `project.tsx` 巨型组件，新交互收敛为「顶栏绑定入口 + 一个槽位选择对话框 + 节点悬停一个动作」 | 映射表风险项 |

## 3. API 契约（前后端并行施工的对接面，冻结）

```
POST   /api/projects/:id/canvas-refs              body { canvasId }        → { project }   幂等 attach
DELETE /api/projects/:id/canvas-refs/:canvasId                            → { project }   幂等 detach

POST   /api/artifacts/import                      multipart: file + fields
       fields: { source?, projectId?, episodeId?, sceneId?, shotId?, slotId?, idempotencyKey? }
       → 200 { job, artifact: { id, url, bytes, kind } }
       幂等：同 idempotencyKey 返回同一 job+artifact；合成 Job status="done"、kind="import"

POST   /api/projects/:id/shots/:shotId/slots/:slotId/candidates
       body { jobId } → 200 { slot }
       404 JOB_NOT_FOUND / NO_ARTIFACT_OUTPUT；409 PROJECT_MISMATCH（job.meta.projectId 与 :id 不符）
       幂等：同 jobId 重复 POST 不产生重复候选
       candidate = { template, jobId, artifactUrl, status:"done", source, createdAt }
       slotId 必须匹配 slot_<shotId>_<role> 规则且 shot 存在；槽位不存在则按规则创建壳

POST   /api/projects/:id/shots/:shotId/slots/:slotId/select
       body { jobId } → 200 { slot }；404 CANDIDATE_NOT_FOUND
       设 slot.selected = jobId
```

自动投影（服务端内部，非 HTTP）：终态 `done` 且 `job.meta` 含 `projectId+shotId+slotId` 且无 `runId`
→ 等价于调 candidates 追加（source 取 `job.meta.source`）。**不改 selected。**

合并规则：`projectKeyframeFacts` 重写 slot 时，保留 jobId 不在本 run 候选集合内的既有候选；
`selected` 指向被保留候选时保留原值。

## 4. 子 Agent 分工

| Agent | 范围 | 文件边界 | 不碰 |
| --- | --- | --- | --- |
| **C1（服务端）** | §3 全部端点 + 自动投影 + 合并规则 + 测试 | `canvas-server/src/slot-candidates.js`（新）、`artifact-import.js`（新）、`episodes.js`（slot 存储函数）、`jobs.js`（recordImport）、`projects.js`（canvasIds 写入方，先查 PATCH 是否已支持）、`pipeline.js`（仅 projectJob 分支与 projectKeyframeFacts 合并）、`index.js`（仅新路由，薄）、`test/slot-candidates.test.mjs`（新）、`test/artifact-import.test.mjs`（新） | `web/`、`skills/`、registry.json、CHANGELOG/pending-test |
| **C2（前端）** | 绑定 UI + 槽位选择对话框 + 生成走服务端 + 加入候选/采用 + 快照语义修正 | `web/src/stores/canvas/use-canvas-store.ts`、`web/src/services/api/`（扩展 projects.ts，新增 slots/artifacts 客户端函数）、`web/src/components/canvas/`（新对话框组件 + 顶栏/悬停工具栏接线）、`web/src/pages/canvas/project.tsx`（仅接线，不重构）、`web/src/types/canvas.ts`（metadata 增 artifactId/artifactUrl）、`web/src/lib/canvas/canvas-agent-ops.ts`、`web/src/pages/canvas/hooks/use-agent-bridge.ts`、`web/src/lib/canvas/canvas-generation-helpers.ts`（hydrate 兼容 http URL） | `canvas-server/`、CHANGELOG/pending-test、project.tsx 的既有生成主链路逻辑 |

两个 Agent 可**并行**：对接面只有 §3 的 HTTP 契约与本节文件边界。双方都**不得**改 `CHANGELOG.md`、`pending-test.mdx`、`todo.mdx`（主 Agent 收尾统一记）。

## 5. 验收（M2 完成判据）

1. `node --test canvas-server/test/*.test.mjs` 全绿（含新增两测试文件）；`cd web && npx tsc --noEmit` 0 错。
2. 真机链：画布绑定「最后一班」项目 → 槽位对话框对 `sh6-start` 的 keyframe 槽位「生成新候选」→ Job meta 归属全齐、source="canvas" → 终态自动追加候选 → 刷新浏览器 + 重启 canvas-server 后画布节点仍显示同一 artifact 图。
3. 存量画布图片「加入项目候选」→ import 幂等（同 key 重复提交返回同一 artifact）→ 候选出现在 slot。
4. 「采用」后 `slot.selected` 指向该候选；之后对同 shot 跑 run 级 keyframe regenerate，投影合并后画布候选仍在、selected 不被冲掉。
5. 删除画布节点/画布，服务端 Artifact 与候选原样保留（无删除通路即为满足）。
6. 未绑定画布的生成链路与 M1 前完全一致（回归确认）。
7. 浏览器网络与界面不出现最终编译提示词（硬约束回归）。

## 6. 风险与边界

- **离线能力**：绑定画布的生成依赖 canvas-server 可达；未绑定不受影响（M2-D1 已对冲）。
- **artifact URL 同源**：生产经 nginx 同源；dev 下 vite 端口与 8788 不同源——客户端函数统一用相对路径 `/api/...`，沿用工作台页面既有做法（C2 先查 workbench 怎么取 artifact 图）。
- **TTS 试听、视频节点**：边界外，不动。
- **快照 projectId 改语义**：若有 canvas-agent 侧消费方依赖旧语义，C2 一并改并说明。

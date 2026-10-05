# M3 施工计划：工作台与项目互通

> 内部文档，不登记进 `meta.json`。接续 `m2-implementation-plan.md`（M2 已验收并提交 9d97c16）。
> M3 在 M2 建成的槽位候选通路上施工，体量小，单 Agent 完成。

## 1. 现状与缺口

- 已有（不要重做）：生图工作台已走服务端队列（M1，`source="workbench"`，Job meta 归属齐全）；工作台结果有 jobId + artifact URL；M2 已建成 `POST .../slots/:slotId/candidates`（追加，幂等）与 `POST .../slots/:slotId/select`（采用）与自动投影；`web/src/services/api/projects.ts` 有对应客户端函数。
- 缺口一：工作台结果卡片**没有「加入项目候选」动作**——试验产物无法被项目正式采用。
- 缺口二：`select` 端点要求 jobId 必须在候选内，**不支持撤销采用**（清空 selected）。
- 缺口三：槽位级联选择 UI 目前只有画布专用的 `canvas-slot-dialog.tsx`，工作台要用会复制粘贴（AGENTS.md 禁止）。

## 2. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| M3-D1 | **不建第二套 Job/Artifact 状态机**（硬约束）：工作台候选复用 M2 端点，不新增任何实体/存储 | 映射表硬约束 |
| M3-D2 | 只做**显式动作**：结果卡片「加入项目候选…」→ 选槽位 → `appendSlotCandidate(jobId)`（Job 已 done、artifact 已存在，直接追加，不走 import）。不做「提交前预选目标槽位」 | 保持工作台=试验表面的语义干净；采用是用户对单个结果的显式决定（platform-positioning：工作台试验、项目负责正式采用） |
| M3-D3 | 撤销采用 = `select { jobId: null }` 清空 `slot.selected`；服务端 selectCandidate/selectSlotCandidate 支持 null | 验收要求「采用/撤销可重复」 |
| M3-D4 | 把「项目→集→镜头→关键帧槽位」级联选择核心抽为共用组件（放 `web/src/components/` 共享层或就近共用目录，由施工者按现有目录惯例定），画布对话框与工作台各自包壳 | 真实出现第二个使用方才抽（AGENTS.md 判据），现在出现了 |
| M3-D5 | **只接生图工作台**（`web/src/pages/image/`）；视频工作台不接——clip 槽位类型还不存在，属 M3.5 范围，登记边界 | 控制改造面，不造没有契约支撑的槽位类型 |

## 3. 文件边界

- 服务端（小改）：`canvas-server/src/slot-candidates.js`（selectCandidate 接受 null）、`canvas-server/src/episodes.js`（selectSlotCandidate 接受 null，清空不写盘幂等）、`canvas-server/test/slot-candidates.test.mjs`（追加 null 用例：清空、重复清空幂等、清空后 candidates 不动）。
- 前端：`web/src/pages/image/`（结果卡片加动作 + 对话框接线）、共用槽位选择器组件（新）、`web/src/components/canvas/canvas-slot-dialog.tsx`（改为复用共用核心，行为不回归）、`web/src/services/api/projects.ts`（`selectSlotCandidate` 的 jobId 允许 null）。
- 不碰：`canvas-server/src/pipeline.js`、`web/src/pages/video/`、CHANGELOG/pending-test（主 Agent 收尾）。

## 4. 验收

1. `node --test canvas-server/test/*.test.mjs` 全绿；`cd web && npx tsc --noEmit` 0 错。
2. HTTP：`select { jobId: null }` → 200 且 selected=null；重复调幂等；candidates 数组不动。
3. 工作台对话框与画布对话框都渲染同一套级联核心（代码评审确认无复制粘贴）。
4. UI 全链（工作台生成→加入候选→项目侧可见→采用/撤销→刷新两侧一致）进 pending-test 由用户验收。

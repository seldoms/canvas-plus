# M3.5 施工计划：Shot / Take / Approval 与 H3 continuation

> 内部文档，不登记进 `meta.json`。接续 M2（9d97c16）/ M3（afe9a4f）；H3 POC 已完成（05d51a9，报告 `research/win147-comfyui/h3-continuation-poc.md`）。
> 契约依据：`domain-contract.md` §3.4–§3.6（Shot/GenerationSlot/Candidate 续接扩展字段已冻结）、§5.3（候选状态机）。**本计划不得改动已冻结字段，只落地。**

## 1. 输入事实（不要重复验证）

### 1.1 POC 结论（05d51a9）

- 机制成立：父段尾帧（ffmpeg `-sseof` 抽帧）→ 上传 147 → 子段 `first_frame` + `task_type=I2VA`；seg0 用 `T2VA`。4 段主链 + 1 条分叉链全部成功。
- 画面接缝合格（SSIM 0.929–0.952，无冻结）；**音频接缝 4/4 有 17~26dB 段首响度塌陷** → 拼接层必须后处理（交叉淡化/响度归一），QC 只标记不阻断。
- 恢复语义 = 按 `(chainId, segmentIndex)` 跳过已有产物段；**产物文件名会随中断重跑递增，定位只信 history.outputs**。
- 跑批每段前需 preflight（`/free` + ram_free≥4GB），低内存使单段 90s→698s。
- 未验证（**不得宣称已支持**）：>4 段漂移累积、跨段台词/口型接续、Ref2VA 续接路线、`MiniMaxH3AddGuide` 锚定。

### 1.2 已冻结契约字段（§3.6，新写入必须完整填写）

Candidate 续接扩展：`takeId / parentCandidateId / approvalStatus(pending|approved|rejected|superseded) / continuationChainId / segmentIndex / parentArtifactId / contextArtifactId / latentArtifactId / continuation`。

`ContinuationMeta`：`{ overlapFrames, addedFrames, width, height, fps, audioSampleRate, seam: { audioCorrelation, rmsStepDb, freezeDetected, motionDrift, reviewed } }`。

### 1.3 现有基建（复用，不重造）

- M1：`submitGenerationIntent`（能力校验+编译+入队+幂等键+归属）；M2：slot candidates/select 端点 + 非 run Job 终态自动投影 + `mergeGenerationSlots`。
- 147 上 H3 T8 节点配方已有产品侧工作流（`canvas-server/workflows/video_h3_i2v.json` 同结构，POC 已 GPU 实测）；`/api/uploads` 已能把文件推进 ComfyUI 输入目录。
- ffmpeg 调用惯例见 `delivery.js`。

## 2. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D35-1 | **不新增链注册表实体**：链状态从 clip 槽位候选派生——同 `continuationChainId` 的候选按 `segmentIndex` 排序即链；`takeId == continuationChainId`（分叉时两者同时新建，满足契约「创建新的 takeId/continuationChainId」） | 契约§3.6「链只能通过父引用向前追溯」；避免第二套事实源 |
| D35-2 | **clip 槽位**：`slot_<shotId>_clip`（§3.5 role 枚举含 clip）；链段候选全部写入该槽位；`selected` 指向**被采用 take 的末段候选**，拼接时沿 parent 引用回溯整链段序列 | 复用 M2 候选通路；采用语义=采用一整条 take |
| D35-3 | **段 Job 自描述**：每段 Job meta 带 `continuation: { chainId, takeId, segmentIndex, totalSegments, prompt, seed, parentCandidateId }`；幂等键 = `continuation:<chainId>:seg<N>`（重跑同段返回原 Job，天然跳过）；编排器无状态——终态事件驱动 + 启动时扫描 stalled 链 | POC 恢复语义；重启可恢复 |
| D35-4 | **编排器**：新模块 `canvas-server/src/continuation.js`（纯业务）。段 N done 且 N+1<totalSegments → preflight（/free + RAM）→ 抽尾帧（ffmpeg）→ 上传 → 组 I2VA 参数 → submitGenerationIntent 提交段 N+1；段 failed/canceled → 链停，等 resume。缝合在既有 Job 终态消费点（与 slot 自动投影同处） | POC §七.4/5；用户无感（抽帧/上传是内部步骤） |
| D35-5 | **接缝 QC**：段 N（N≥1）done 后在编排器内用 ffmpeg 计算——边界帧 SSIM/PSNR、接缝窗 freezedetect、父尾/子首 0.5s RMS 落差、接缝 ebur128 LUFS/真峰值；写入子段候选 `continuation.seam`（含 `reviewed:"pending"`），超门槛（SSIM<0.85 或 freeze 或 ΔdB>12）标 `needsReview:true`，**不阻断**。指标齐全性优先于字段名一一对应——`ContinuationMeta.seam` 子字段按契约最小形态填，多出的量化值放 `continuation.seam.metrics` | POC §四/§七.2；音频落差是常态不阻断 |
| D35-6 | **分叉**：`parentCandidateId` 必须指向 `done` 候选；新链首段 segmentIndex = 父段 segmentIndex+1，first_frame 取父段产物尾帧；原链候选/产物一律不写 | POC §五已验证机制 |
| D35-7 | **采用/审批**：`approvalStatus` 在候选级标记（采用 take 时整链段标 approved、被顶替的旧 take 段标 superseded）；`slot.selected` 仍由 M2 select 端点写入；接缝人工复核走独立 review 端点（写 `continuation.seam.reviewed` + `reviewNote`） | 契约§3.6「selected 仍由 GenerationSlot 统一指向」 |
| D35-8 | **本轮不接 run 侧 assembly 自动开链**（run 的片段阶段改走链是下一步，本轮先把项目级链通路+验收打穿）；UI 只做只读链视图 + review/采用动作，不做时间线编辑器 | 控制第一轮范围；M6 闭环前再接 run |

## 3. API 契约（新增，冻结后派活）

```
POST /api/projects/:id/shots/:shotId/continuation-chains
     body { prompt, segments: number(1..8), seed?, template?, params? }
     → 201 { chainId, takeId, slotId, firstJob }
     校验：shot 存在；segments 1..8；prompt 非空（契约：不允许空 prompt）

POST /api/projects/:id/shots/:shotId/continuation-branches
     body { parentCandidateId, prompt, segments: number(1..8), seed? }
     → 201 { chainId, takeId, slotId, firstJob }
     404 CANDIDATE_NOT_FOUND；409 PARENT_NOT_DONE（父候选非 done）

POST /api/projects/:id/shots/:shotId/continuation-chains/:chainId/resume
     → 200 { chainId, resumedFromSegment, job | null }
     幂等：已完成段靠幂等键跳过；链已完成返回 job:null

GET  /api/projects/:id/shots/:shotId/continuation-chains
     → { chains: [{ chainId, takeId, parentCandidateId, status,
                    segments: [{ segmentIndex, jobId, status, artifactUrl,
                                 seam, approvalStatus, needsReview }] }] }
     纯派生视图（从 clip 槽位候选分组）

POST /api/projects/:id/shots/:shotId/continuation-reviews
     body { jobId, reviewed: "approved"|"rejected", note? }
     → 200 { candidate }  写 continuation.seam.reviewed + reviewNote
```

采用 take：复用 M2 `POST .../slots/:slotId/select { jobId }`（jobId = take 末段候选）；
select 时把该 take 整链段 approvalStatus→approved、其它 take 段→superseded（select 端点扩展，行为追加式）。

## 4. 子 Agent 分工与顺序

| Agent | 范围 | 文件边界 |
| --- | --- | --- |
| **D1（服务端核心）** | continuation.js + 段编排 + 接缝 QC + 5 条端点 + select 扩展 + stalled 链启动扫描 + 测试 | `canvas-server/src/continuation.js`（新）、`slot-candidates.js`（select 扩展 approvalStatus）、`episodes.js`（候选字段写入需要时）、`index.js`（仅新路由+编排器接线）、`test/continuation.test.mjs`（新）；参考不改动：`delivery.js`（ffmpeg 惯例）、`providers/comfy.js`、`workflows/` |
| **D2（UI，D1 完成后）** | 项目视频工作区只读链视图 + review/采用/分叉/resume 动作 | `web/src/pages/projects/`（视频工作区面板）、`services/api/projects.ts`（客户端函数）；共用级联选择器复用 |

**D1 先行，D2 等 D1 端点落地后派。** 双方不碰 CHANGELOG/pending-test（主 Agent 收尾）。

## 5. 验收（对照第九条验收标准·H3 续接段）

1. 每段是独立 Job/Artifact/Candidate（候选含 §3.6 全部续接字段，新写入完整）。
2. `GET .../continuation-chains` 可按 chain → segment → parent 回溯；分叉链 `parentCandidateId` 指向他链候选。
3. 中断（cancel 段 Job）后 resume：已完成段不重复入队（幂等键命中原 Job），只补跑缺失段。
4. 分叉后原链候选/Artifact 不变（比对候选数组与 artifact 存在性）。
5. 每个接缝候选带 seam 量化指标 + `reviewed` 状态；review 端点写入后可查；超门槛标 needsReview 不阻断。
6. 同幂等键重复提交不重复入队；Artifact 回写可重放。
7. `node --test` 全绿 + 新增 continuation 测试覆盖 2/3/4/5/6。
8. 真机链（接受 GPU 成本 2 段）：对 M2 验收项目开一条 2 段链 → 段0 done 后自动接续段1 → 段1 候选带 parentArtifactId/contextArtifactId/seam 指标。
9. **不宣称无限续接**：文档与 UI 文案不得出现「无限」承诺。

## 6. 风险

- 编排器是服务端首个「多步 GPU 驱动」逻辑——stalled 链扫描必须在启动时幂等（幂等键保证）；他人任务插排时 preflight 等待要有上限与日志。
- 接缝 QC 的 ffmpeg 调用是 CPU 工作，必须在 GPU 队列外执行（不进 jobs 队列、直接 spawn，或按既有 CPU 类队列惯例）。
- clip 槽位首次有候选后，run 侧 keyframe 投影的 merge 逻辑不得误伤（merge 只动 keyframe 槽位，回归测试覆盖）。
- 段 prompt 的模型适配（英文化/H3 格式）走 M1 编译链，前端不得暴露编译结果（硬约束回归）。

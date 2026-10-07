---
name: pipeline
description: 驱动 Infinite Canvas 服务端短剧项目与七段流水线（剧本/分镜/服化道/定妆/关键帧/配音/成片）：查看项目进度、跑阶段、精调单个镜头或素材并重新生成、合成与导出成片。用户谈到项目、短剧、流水线、分镜、定妆、关键帧、配音、成片或批量生产时使用。
---

# 项目流水线

`project_*` 工具走本地网关 HTTP（默认 `http://127.0.0.1:8788`，`CANVAS_GATEWAY_URL` 可覆盖），**不要求网页画布打开**。

## 对象层级

项目 → 集 → 场景 → 镜头 → 素材/候选 → 成片。`run` 是一次执行记录，七段状态存在 `run.stages`。

## 工作流

1. **了解项目**：`project_context`（基本信息/plan/集进度/runIds）→ `project_gates`（七段门禁：什么能跑、被哪个上游挡住）。
   - 独立生成的素材（生图工作台产物、外部图）用 `project_attach_asset` 归入，产物一旦带上归因就被项目看见，不必先建 run。
2. **找执行记录**：`project_list_runs`（可按 projectId 过滤，只回裁剪后的阶段状态，不含剧本文本）。
3. **驱动阶段**：`project_run_stage`（202 异步，真实生成在后台）/ `project_cancel_stage` / `project_retry_failed`（只补跑失败条目，成功的不重跑）/ `project_update_stage_input`（改模型、参数等输入，**改完必须再 `project_run_stage` 才生效**）。
4. **等进度**：只轮询 `project_run_status`（轻量 progress.json：done/total/ETA/inflight）。不要用 `project_stage_items` 当轮询器——它会拉整个 run。
5. **精调单条目**：先 `project_stage_items` 拿条目 id（分镜→shotId、定妆→characterId、关键帧/配音→itemId），再：
   - `project_patch_shot`：改镜头字段（景别/机位/动作/对白/时长）；
   - `project_regenerate_item`：单条重出（itemId 必填；`promptOverride` 人工改词只覆盖提示词，尺寸/参考图/采样参数仍走规则表，不破坏身份锁定；新候选自动选中）；
   - `project_confirm_casting`：锁脸/锁声（face/voice 至少确认一个；确认后自动解除 keyframe/audio 的 casting 阻断，批量生产前必须全部确认）；
   - `project_adopt_candidate`：采用/撤销候选（jobId 传 null 撤销）。
   - `project_asset_pack`：查资料包现状。给 projectId → 每个角色/场景/道具锁了几张参考图、status 是 adopted/candidates/missing，**推进定妆或关键帧前先调它**，missing 的实体就是要先补的缺口；给 runId → 定妆取料盘点（每张脸当前用哪张、source、可换的 candidates）。
   - `project_attach_asset`：把产物归入资料包挂到实体上（artifactId 用网关产物地址 `/api/artifacts/<jobId>/<file>`，不是本地 data:/blob: 地址）。**幂等** —— 同 role+bindingId 重复调用只追加候选，created=false 就是命中已有引用，不会造出重复引用导致选参考图随机命中。
   - 定妆的脸**优先取资料包里人工采用/归入的那张**，服化道自动绑定的排后面；`project_confirm_casting` 可用 `closeupArtifactId` 显式换脸。换了正脸该角色会回到未确认状态，需要重新确认才能放行下游 —— 这是刻意的，不替你批准没看过的脸。
6. **成片交付**：`project_assemble` 合成（ffmpeg 分钟级）→ `project_run_status` 等终态 → `project_export_package` 取交付包（zip：成片 + 分集 clips + SRT + FCPXML + EDL，可直接导入剪映继续剪）。
7. **质检**：`project_run_qc` 读报告。**没报警不等于没问题**——指标接近门槛（如接缝响度差）时主动提醒用户人工复核。

## 纪律

- 跑阶段、重试、单条重出、合成都是 **202 立刻返回**：只说「已开始，用 project_run_status 看进度」，不要说「已生成」。
- 单张生图/生视频用 `workbench_*` 或 `canvas_generate_*`，不要拿流水线工具做单发任务；画布节点操作用 `canvas_*`，不要拿 project_* 改画布。

# H3 i2v 真实 UI 入队提示词取证（2026-10-04）

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 用途：补 `pilot-issues.md` #66 / 开发计划 §11.7「验证缺口」要求的一手证据 ——
> 证明**当前 UI → 入队链路**真的在使用新 H3 编译器产出的三段式提示词，而不是旧快照或干跑结果。

## 取证方式

- 浏览器：常驻 headless 自动化 Chrome（`--remote-debugging-port=9222`，独立 profile `/root/.chrome-persist`），
  **新开独立测试页**，未触碰任何人工浏览器标签。
- 页面：`http://127.0.0.1:8788/pipeline`（run `run-murpt28o-46f5q`「猫狗奇缘-API」，项目 `prj_01M3ZK27NYPXRPBVRAT0SSJ2B5`，
  `plan.ratio = 9:16`）。
- 操作：在「5. 片段合成拼接」阶段、条目 `#1`（`sh1-clip`）上点「换个模型再出一张」→ 下拉选 **「H3 图生视频」**（`video_h3_i2v`）。
  全程真实鼠标事件（CDP `Input.dispatchMouseEvent`）。
- 入队前后 `/api/jobs` 计数：**488 → 489**，新增 job 即下文对象；取证后立刻 `POST /api/jobs/:id/cancel`，
  队列回落 `running:0 / pending:0`，未占用 GPU 产能。

## 新 job（本次取证）

| 字段 | 值 |
|---|---|
| jobId | `run-murpt28o-46f5q-sh1-clip-musnttqs-fhw1j` |
| kind / template | `video` / `video_h3_i2v` |
| createdAt | `2026-10-03T17:22:35.861Z`（点击后 4s 内出现） |
| meta | `{ runId: run-murpt28o-46f5q, stageId: assembly, itemId: sh1-clip }` |
| WIDTH × HEIGHT | `768 × 1376`（9:16，且均为 32 的倍数） |
| LENGTH | `90` 帧 = 4s @24fps 吸附到 H3 `17n+5` 帧网格（与旧 job 一致，非本轮变化） |
| INPUT_IMAGE | `/api/artifacts/run-murpt28o-46f5q-sh1-start/sh1-start_00004_.png`（该条已选关键帧） |

### `params.PROMPT` 全文（743 字，逐字）

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, 二维动画，治愈系暖色调，柔光，圆润可爱的角色造型，干净线条. The composition is vertical portrait, with a 9:16 aspect ratio. a medium shot set in 内景 客厅. 小猫弓起背部，毛发竖立，尾巴竖直，眼睛圆睁盯着小狗；小狗低声呜咽，身体前倾，尾巴低垂，耳朵向后贴。两者相距约0.8米，静止对峙。呼吸起伏可见. The camera: 固定机位，位于客厅地板上方约0.5米，正对小猫和小狗，距离约2米，平视角度，标准焦段50mm，光圈f/2.8，景深焦点固定在小猫眼睛。镜头固定，不推拉摇移，看向对峙的小猫小狗，保持完整构图. The frame begins from <Picture 1>, preserving its composition, subjects, colours, and lighting. By the end of the shot, 小猫保持弓背，小狗保持前倾，视线相对. 画面保持干净稳定，避免畸形肢体、多余手指、水印与文字乱码。

overall_soundscape: 轻微的客厅环境声，可能有窗户外的远处车声，但很弱；小猫喉咙发出极轻的威胁声，小狗低声呜咽。

non_diegetic_music: N/A
```

### 对照旧 job（同一条目的历史任务，旧编译器产物）

`run-murpt28o-46f5q-sh1-clip`（`status: done`，551 字）首段为
「二维动画，治愈系暖色调，…。An orange and white fluffy kitten with big round eyes… Medium shot, two animals facing off, natural ligh…」
—— 即 issue #53 描述的「英文静态生图描述 + 中文动作流水句用 `, ` 拼接」旧格式，无对齐行、无三字段、无运镜、无画幅。
**两者并存即证明新链路已接管入队路径。**

## 逐项核对（对照 skills/minimax-h3-local-prompt 官方口径）

| 检查项 | 结论 |
|---|---|
| I2VA 首行关键帧对齐指令行（时间两位小数、后空一行） | ✅ `at 0.00 seconds … <Picture 1> (from [Shot 1]) is fully referenced.` + 空行 |
| 三字段固定顺序 | ✅ `integrated_multimodal_description` → `overall_soundscape` → `non_diegetic_music` |
| 参考素材编号指代 | ✅ `<Picture 1>`（非「图1」式），且 `INPUT_IMAGE` 指向已选关键帧产物 |
| 画幅与项目事实一致 | ✅ 项目 `plan.ratio=9:16` → 正文 `The composition is vertical portrait, with a 9:16 aspect ratio.`；`WIDTH/HEIGHT=768×1376` |
| 运镜来自 `cameraSpec` 的自然句式 | ✅ 「固定机位…镜头固定，不推拉摇移」（该镜 `movement.type=static`） |
| 音效段来自 `shot.audio` | ✅ `overall_soundscape` 为环境声+动物声描述 |
| 无 BGM 的写法 | ✅ `non_diegetic_music: N/A` |
| 段末可见状态（end state） | ✅ `By the end of the shot, 小猫保持弓背，小狗保持前倾，视线相对.` |
| 目标总时长 | ✅ `LENGTH=90` 帧（H3 帧网格），与旧 job 同口径 |
| 台词逐字（`(S1)` + `<d>[English]…</d>`） | ⚠️ 本镜无对白，未覆盖；带台词镜头的视频逐字台词仍待一次取证 |

## 结论

#66 的核心疑问（「新代码是否真的在 UI→入队链路上生效」）**已解除**：真实页面点击产生的新 job 使用新三段式稿，
且与旧 job 的旧格式并存可对照。残留项只有一条：带台词镜头的视频逐字台词取证。

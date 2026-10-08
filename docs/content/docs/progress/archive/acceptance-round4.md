> ⚠️ **时点快照，内容已过期（2026-10-05 独立复核）**：本文写于 2026-10-02/03，其中多条结论已被后续代码超越（模板数与测试基线、`delivery.js` 成片执行体、skill 库接线、`runIds` 回填、流水线段数 等）。**引用前请以 `HANDOFF.md` 的「2026-10-05 独立审查结论」、`development-plan.md` §11.1 的修正表、以及 live `GET /api/providers` / `GET /api/pipeline/stages` 为准**；本文只作演变记录保留。

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


# 第四轮验收报告：小说 → 成片 全流程真实界面走查（2026-10-04）

> **验收方式**：CDP 驱动**真实界面**点击（私有 tab `/tmp/cdp-ops-qa.py`，tab `C32E55B6…`）。
> **全程未写任何 `POST /api/...` 推流程**（产品负责人硬规矩：「不要上来就操接口，接口又不是用户直接用的」）；
> 只读接口仅用于取证（GET run/job 详情、看前端真实请求、看服务端日志）。
> **环境**：infinite-canvas v0.19.0 @ `http://127.0.0.1:8788`；ComfyUI `192.0.2.147:8188`；后端 PID 844299。

## 0. 本次产生的测试对象（保留待清理，标题含「验收-第4轮」）

| 对象 | id | 如何创建 |
|---|---|---|
| run | `run-musrbea3-t20px` 「验收-第4轮·夜航灯」 | 影视流水线 → 历史记录 → 新建流水线（**非项目绑定**） |
| project | `prj_01M41JXP9F15G200CZNEYD7CVV` 「验收-第4轮·项目」 | 我的项目 → 新建项目（标题 + 粘贴 255 字原文） |
| run | `run-musrs21x-pri3c` 「验收-第4轮·项目」 | 项目内「规划·剧本」→「新建流水线并运行」（**项目绑定**） |

## 1. 逐阶段结果

| 阶段 | 入口 | 真实发出的请求 | 后端真值 | 结论 |
|---|---|---|---|---|
| 剧本 script | 流水线「运行本步」/ 项目「新建流水线并运行」 | `POST /api/pipeline/runs/{id}/steps/script/run` → **202** | status running→done；progress.json 子步骤「读原文/分集规划/逐集剧本」；output 含 logline/synopsis/2 角色/3 场景 | ✅ |
| 分镜 storyboard | 项目「分镜」工作区「运行「分镜」」 | `POST .../steps/storyboard/run` → **202** | done；output **18 镜** | ✅ |
| 服化道 design | 项目「资产」工作区「运行「服化道」」 | `POST .../steps/design/run` → **202** | done；**7 个生图 job 全部 done**（`run-musrs21x-pri3c-c1-closeup…loc3-master`，`img_qwen21_t2i`）；output.characters[].prompt 真实 | ✅ |
| 关键帧 keyframe | 项目「关键帧」工作区「运行「关键帧」」 | `POST .../steps/keyframe/run` → **202** | job 入队：`sh1-start` **running**、sh2/sh3-start **queued**（`img_qwen21_edit`），`params.PROMPT` 真实 | ⏭️ **未等生成完成**（按时间预算） |
| 片段合成 assembly | 项目「视频·后期」「运行「片段合成」」 | 未触发（上游门禁） | status `pending` | ⏭️ 被关键帧挡住（**门禁行为正确**） |
| 导出成片 | 项目「视频·后期」工作区 | `GET /api/pipeline/runs/{id}/gates` | assembly gate `ready:false`，理由「请先完成 关键帧（上游仍在运行中，请等它结束）」—— **服务端给的理由** | ✅ 入口存在、置灰、原因来自服务端（未点击绕过） |

## 2. 发现的问题（含一手证据与严重度）

### 🔴 P0 — 不绑项目的 run 会让「关键帧」永久 blocked，并且 UI 卡死不给错误

**一手证据（我本人复核）**：
```
run-musrbea3-t20px   options.projectId = None            → keyframe.status = blocked
  error: sh1-start：缺少角色/场景参考图，无法锁定身份：character:c1（no-ref）、character:c2（no-ref）、scene:loc1（no-ref）
         ；sh2-start：…（**18 镜全部同类**）
run-musrs21x-pri3c   options.projectId = prj_01M41JX…    → keyframe.status = running ✅
```

**链路**：`/pipeline` 页顶部「开始生成剧本」→ `createRunOnly()` → `createPipelineRun({ novel, title })` **不带 `projectId`**
→ 服化道的参考图无从登记为项目 AssetRef → 关键帧每条都被 `blocked`
→ **而 blocked 的帧没有 jobId → 前端不轮询它 → 界面永久显示「运行中 / 模型生成中」，不给任何错误，所有「运行本步」按钮全禁用**（只能手动点「刷新状态」才恢复）。

**严重度：高**。① 独立入口（影视流水线）功能上是残的；② **更重要的是「blocked 是一种 UI 死胡同」** —— 用户看到的是"一直在跑"，不是"缺参考图"。

### 🟡 P1 — 阶段后端已完成，前端仍显示「运行中」直到手动刷新

**一手证据**：服化道后端 `done` 且 7 个 job 全部 `done`（约 03:04），但 `progress.json` 仍停在 `phase:"running"`、`updatedAt` 冻结在 19:04:01（UTC）；前端显示「服化道：运行中 / 生成中 / 模型生成中」，且所有「运行本步」被禁用（提示「有步骤正在运行，请等待结束」）。直到 03:07 手动「刷新状态」才恢复。
**疑似原因**：design 阶段产物里没有可供 `collectJobIds` 采集的 jobId → 前端没有 job 轮询可依赖，只能靠 `progress.json`，而它没走到终态。

**严重度：中**（每次跑设计/关键帧都要人工点一次刷新，且期间按钮被锁）。

### 🟡 P2 — 「开始生成剧本」是否真的触发了剧本生成 —— **待复现确认**

现象（验收者观测）：点击后 `performance` 里只有 `POST /api/pipeline/runs 201`，没有 `.../steps/script/run`。
**但读代码**：`startWithEstimate()` 在「非分块长文」路径上确实会 `await runStage("script")`（`web/src/pages/pipeline/index.tsx:46-65`）。
→ **两者矛盾，未定论**。不排除是观测时序（performance 条目在导航后读取）或按钮未真正命中。
**严重度：待定**，**必须先复现再定性**。

### ✅ 已确认做对的

- **提示词不暴露转写层**：`grep -rn "预览提示词|已强化|未强化|强化提示词|promptPreview|previewPrompt" web/src web/dist` → **0 命中**；`zh-CN.ts` 中「强化」出现 0 次。
- **`/gates` 同源**：导出成片入口的置灰原因**来自服务端**，不是前端自己算。
- **门禁拦住下游**：片段合成在关键帧未完成时被正确挡住（这正是期望行为）。

## 3. 明确「没验到的」（不许当成通过）

| 项 | 状态 |
|---|---|
| 工作台**刷新后任务是否还在**（`infinite-canvas:image_workbench_tasks` 恢复 + 失败气泡） | 只读了代码（`persistTasks` / `bubbledJobErrorsRef` / `imageWorkbench.jobFailed`），**未在界面实测** |
| 素材「归档」vs「彻底删除」的边界与二次确认清单 | 只读了代码，「我的资产 → 全部产物」**未在界面实测**（未点归档/删除） |
| **成片实际合成与下载** | **未触发**（上游关键帧未完成） |
| 关键帧 / 片段 | **未等生成完成**（按时间预算主动跳过） |
| 带台词镜头的视频逐字台词 `(S1)`+`<d>` | 未覆盖（承接 #66 残留） |

## 4. 待办（转下一轮）

1. **修 P0**：① 独立 run 的 `blocked` 必须有**可读原因 + 可行动作**（不能只显示"运行中"）；② 决定 `/pipeline` 独立入口与「项目绑定」的关系（要么带上项目，要么明确告知需要项目）
2. **修 P1**：阶段终态不能只依赖 `progress.json` —— 前端要能从 run 的 `stage.status` 反推终态并解除按钮锁定
3. **复现 P2** 再定性
4. 补验第 3 节里那三项（工作台刷新恢复 / 归档删除界面 / 成片合成下载）
5. 清理本轮测试对象（run ×2、project ×1）—— **清理前先列清单核对**

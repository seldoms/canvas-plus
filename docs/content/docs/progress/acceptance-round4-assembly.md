# 第四轮补验报告：片段合成 → 成片合成 → 下载成片（2026-10-04）

> **补的是上一轮（`acceptance-round4.md`）没验到的最后两段**：那轮卡在关键帧没跑完，
> 本轮用一个**关键帧已 done** 的真实 run 把「片段 → 成片 → 下载」整条闭环在**真实界面**上跑通。
>
> **验收方式**：CDP 驱动**真实界面**点击。私有 tab 工具 `/tmp/cdp-ops-as.py`（`TABFILE=/tmp/cdp-tab-as.txt`，
> 与 `/tmp/cdp-tab.txt` 隔离，避免多 agent 共用 9222 时互相导航、读出假阴性）。
> **全程未写任何 `POST /api/...` 推流程**（产品负责人硬规矩：「不要上来就操接口，接口又不是用户直接用的」）。
> 脚本只做两件允许的事：① **只读取证**（GET run/job 详情、ffprobe、读磁盘产物）；② **界面操作工具本身**（真鼠标点击、读前端真实请求）。
>
> **环境**：infinite-canvas v0.19.0 @ `http://127.0.0.1:8788`；ComfyUI `192.168.123.147:8188`（单卡 RTX 5060 Ti 16GB）；
> canvas-server PID 常驻（`/api/health` ok，uptimeSec 17230 起）。

## 0. 本次用到的对象（**未删除任何已有对象**）

| 对象 | id | 说明 |
|---|---|---|
| project | `prj_01M41JXP9F15G200CZNEYD7CVV` | 「验收-第4轮·项目」（沿用上一轮） |
| run | `run-musrs21x-pri3c` | 「验收-第4轮·项目」，**关键帧阶段已 `done`（6 帧）** → 正好往下跑 |
| 本次新产出的片段 | `sh1-clip` / `sh2-clip` / `sh3-clip` | 3 个 H3 视频片段（落在该 run 的 assembly 阶段） |
| 本次新产出的成片 | `assembly-run-musrs21x-pri3c`（+ 重拼 `-r2`） | ffmpeg 拼成的成片（含 manifest/cover/log） |

进入入口：项目 → 左侧工作区导航 → **「视频·后期」**（`/projects/<id>/video`，`workspace.stage === "assembly"`）。

---

## 1. 闭环三段逐项结果

### 1.1 片段合成（assembly 阶段 run）

| 项 | 值 |
|---|---|
| **入口在哪** | 「视频·后期」工作区「运行本阶段」面板 → 按钮 **`运行「片段合成」`** |
| **我点了什么** | 真鼠标点击该按钮（点击前三问：`rect.top=468 < innerHeight=913` ✅；`elementFromPoint` = `SPAN` 文本「运行「片段合成」」✅；`disabled=false` ✅） |
| **页面变成什么** | 按钮区变为「**生成中**」+「**取消运行**」；「导出成片」面板显示 `还不能导出成片。/ 片段尚未全部生成完成。`（`合成成片` 置灰） |
| **前端真实请求** | `POST /api/pipeline/runs/run-musrs21x-pri3c/steps/assembly/run` → **202**（30ms）<br>来源：`performance.getEntriesByType('resource')` 过滤 `/api/` |
| **后端真值** | ① 阶段 `assembly.status: pending → running → done`；`output.clips[]` 三件全部 `status:"done"`；`output.assembly.order=[sh1-clip,sh2-clip,sh3-clip]`、`transition:"dissolve"`。<br>② 3 个 job 真入队（`meta={runId,stageId:"assembly",itemId}`，`backend:"local"`）；串行执行，**逐个 done**：<br>&nbsp;&nbsp;· `sh1-clip` 23:47:50→23:52:37（≈4m47s）<br>&nbsp;&nbsp;· `sh2-clip` →23:57:11（≈4m34s，sh1 完才开始）<br>&nbsp;&nbsp;· `sh3-clip` →00:01:48（≈4m37s）<br>&nbsp;&nbsp;**3 片段串行共 ≈13m58s**（单卡 16GB 串行是硬约束，与已知瓶颈一致）。<br>③ `progress.json` 全程 `phase:"running"` / `label:"模型生成中"`（见问题①）。 |
| **结论** | ✅ **通过（已等到 3 个片段全部真出片）** |

**params 真值（`GET /api/jobs/:id`，逐条核对）** —— 三个片段同构，以 `sh1-clip` 为例：

```
status: running→done   backend: local   createdAt 2026-10-03T23:47:50.987Z  updatedAt …23:52:37
params keys: ['WIDTH','HEIGHT','LENGTH','INPUT_IMAGE','PROMPT']
  WIDTH  = 768                 # 9:16，被 32 整除
  HEIGHT = 1376                # 被 32 整除
  LENGTH = 124                 # 5s → 官方 17k+5 网格 124（GET /api/durations 口径一致）
  INPUT_IMAGE = "/api/artifacts/run-musrs21x-pri3c-sh1-start-muss33qe-u7ns5/…_sh1-start_00004_.png"
  PROMPT = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
            integrated_multimodal_description: [Shot 1] Live-action, cinematic, … vertical portrait, 9:16 … 阿海 (S1) say…"
```
- `INPUT_IMAGE` **逐镜对应各自首帧**：`sh1-clip→sh1-start`、`sh2-clip→sh2-start`、`sh3-clip→sh3-start`（图生视频槽位正确）。
- `PROMPT` 是**真实 H3 本地字段口径**：首行关键帧对齐指令行（`at 0.00 seconds … <Picture 1>`）+ `integrated_multimodal_description` + 说话人 `(S1)`，说明**走了提示词编译器**，非模板占位。
- 磁盘产物（真文件）：
  - `artifacts/run-musrs21x-pri3c-sh1-clip/sh1-clip_00008-audio.mp4` = **1,520,689 B**
  - `sh2-clip_00004-audio.mp4` = **2,433,832 B**；`sh3-clip_00004-audio.mp4` = **2,801,140 B**
  - ffprobe(sh1)：`h264 768x1376 24fps nb_frames=124 duration=5.17s` + `aac` 音轨。

### 1.2 成片合成（assemble）

| 项 | 值 |
|---|---|
| **入口在哪** | 同工作区「导出成片」面板 → 按钮 **`合成成片`** |
| **我点了什么** | 真鼠标点击（`elementFromPoint`=「合成成片」，`disabled=false`） |
| **页面变成什么** | 面板从「还不能导出成片」翻为「**成片已生成 / 时长 14 秒**」+ 按钮 `重新合成` / `下载成片` / `导出交付包`；过程时间线出现「**5. 片段合成 已完成 3 项**」 |
| **前端真实请求** | `POST /api/pipeline/runs/run-musrs21x-pri3c/steps/assembly/assemble` → **202**（20ms）<br>（`重新合成` 复点同样命中该端点，构成一次独立复现） |
| **后端真值** | `stages.assembly.output.assembly`：`status:"done"`，`deliverableId:"assembly-run-musrs21x-pri3c"`，`url:"/api/artifacts/assembly-run-musrs21x-pri3c/run-musrs21x-pri3c-final.mp4"`，`bytes:9951338`，`startedAt 00:04:51.374Z → finishedAt 00:04:54.278Z`（**≈3s** 完成 ffmpeg）。磁盘：`assembly-run-musrs21x-pri3c/{run-musrs21x-pri3c-final.mp4(9,951,338B), run-…-final-cover.jpg(108,297B), assembly-manifest.json(3,430B), ffmpeg.log(10,088B), ffmpeg-cover.log}`。 |
| **ffmpeg 真命令**（`ffmpeg.log` 首行） | 三输入 `-filter_complex … xfade=transition=dissolve:duration=0.6:offset=4.400 / offset=8.800 … -map [vcat] -c:v libx264 …` → 成片 `h264 768x1344 335帧 duration=13.96s` |
| **结论** | ✅ **通过（成片真生成、真落盘）**；但见问题② 音轨丢失 |

### 1.3 下载成片

| 项 | 值 |
|---|---|
| **入口在哪** | 成片生成后出现的按钮 **`下载成片`** |
| **我点了什么** | 真鼠标点击（`elementFromPoint`=「下载成片」） |
| **页面变成什么** | 触发**站内 blob 下载**；`location.href` **不变**、CDP page target 数**不变**（10）→ **未跳新页**（符合规范） |
| **前端真实请求** | `GET /api/artifacts/assembly-run-musrs21x-pri3c/run-musrs21x-pri3c-final.mp4` → **200**，`transferSize 9,951,638 B`，`initiatorType:"fetch"` |
| **后端真值 / 落盘** | 浏览器下载目录实测落盘：**`assembly-run-musrs21x-pri3c.mp4`，字节数 `9,951,338`**（与磁盘成片 `bytes` 逐字节相等） |
| **结论** | ✅ **通过（真下载一次，文件名 + 字节数均已留证）** |

> **文件名来源**：前端 `saveAs(blob, \`${assembly.deliverableId || runId}.mp4\`)` → `assembly-run-musrs21x-pri3c.mp4`。
> **成片文件**：`run-musrs21x-pri3c-final.mp4`，**9,951,338 字节**（9.49 MB）。

---

## 2. 问题清单（逐条给一手证据 + 严重度）

### 🔴 问题① — 片段合成跑完后，「导出成片」**不会自动解锁**、「运行本阶段」**永远停在「生成中」**，必须手动「刷新」

- **现象（一手证据）**：3 个片段 **全部 done**（23:52:37 / 23:57:11 / 00:01:48 UTC），`stages.assembly.status = "done"`，但界面在同一时刻仍是：
  ```
  运行本阶段 → 生成中  取消运行
  导出成片 → 还不能导出成片。片段尚未全部生成完成。   [合成成片 置灰]
  ```
  且 `GET …/progress` 一直返回：
  ```json
  {"progress":{"stage":"assembly","phase":"running","done":0,"total":1,
   "label":"模型生成中","updatedAt":"2026-10-03T23:47:50.997Z"},"inflight":false}
  ```
  `updatedAt` **冻结在入队那一刻**（23:47:50），`phase` 永不落终态。→ 手动点「刷新」后，`合成成片` 立刻变为**可点**（`disabled:false`），告警消失。
- **根因（读源码，一手）**：
  1. `canvas-server/src/pipeline.js` `recomputeStage()` 在片段 job 终态回写时把 `stage.status` 置为 `done`（line 1184），**但没有 `writeProgress()`**；而 `writeProgress` 的终态写法只存在于「同步 composeWithLlm 路径」(line 2781) 与「assemble 路径」(line 2893)，**没有覆盖「assembly 阶段经异步 job 队列跑完」这条路径** → `progress.json` 停在 `phase:"running"`。
  2. `web/src/pages/projects/hooks/use-project-run.ts` 的进度轮询 `tick()` **只在 `progress.phase ∈ {done,failed}` 时**才 `setRunning(false)` + `refresh()`（line 68-69），**完全不消费接口已返回的 `inflight` 字段** → `phase` 既然永不为 done，就**永不解锁、永不 refresh**，`stageStatus.assembly` 永远是 `running`，导出面板的 `stageDone` 判定恒 false。
  - 对比：`use-pipeline-run.ts`（line 313）与 `use-project-timeline.ts`（line 27）**都**读了 `inflight`，`use-project-run.ts` **漏了**。这正是台账 **#71** 那一类（「阶段终态别只信 progress.json」）在**项目工作区运行面板**上的残留。
- **严重度：高**。用户跑完片段后看到的是「生成中…」死循环 + 成片入口锁死；界面**不给任何提示要说「去点刷新」**。对「小说→成片」主线而言，这是**最后一步的可用性断点**（本次是我作为验收者知道要点刷新才继续下去的）。
- **补充（诚实标注）**：本次我观测到「前端轮询在片段跑动中途就停了」（最后一条 `/progress` 请求距读取时已 700+ 秒）。
  这**可能**与 headless **后台标签页定时器节流/冻结**有关（我的 tab 不是前台激活 tab），属**验收环境副作用**；
  但**即使轮询一直不停，问题①依然成立**——`phase` 永不落终态 ⇒ 轮询条件永不满足 ⇒ 永远不解锁。两者独立。

### 🟠 问题② — 成片**丢失音轨**（片段有音频，拼完成片无声）

- **一手证据**：
  - 片段 `sh1-clip`：ffprobe `stream,0,h264,video` + `stream,1,aac,audio`（**有音轨**）。
  - 成片 `run-musrs21x-pri3c-final.mp4`（及重拼 `-r2`）：ffprobe **只有 `stream,0,h264,video`**，**无 audio 流**。
  - `ffmpeg.log` 真命令：`… -filter_complex [0:v]…;[1:v]…;[2:v]…;…xfade…[vcat] -map [vcat] -c:v libx264 …`
    —— **只 `-map` 了视频 `[vcat]`，没有任何音频 map**。
- **严重度：中**。H3 生成是带音频的（`-audio.mp4`），成片却是静音交付物；做短剧成片时「人声/环境声」直接没了。
- **注**：本条是**消费侧**观察（成片无音轨）；是否属“预期（成片=纯画面，声音在后期另配）”需产品侧确认——若是预期，应在交付清单/界面里说明，而不是静默丢轨。

### 🟡 问题③ — 本地生图/生视频任务**无量化进度**（只「生成中」，无百分比/步进）

- **一手证据**：`canvas-server/src/generate.js` 本地 ComfyUI 路径全程 `ctx.progress(0, 0, "已提交")` → `ctx.progress(0, 0, "生成中"|"排队中")`（line 115/124），完成后才一次性 `ctx.progress(outputs.length, outputs.length, "已完成")`（line 140）。实测 3 个片段 job 的 `progress` 全程 `{value:0,max:0,node:"生成中"}`，只在 done 时跳 `{1,1,"已完成"}`。
- **严重度：低~中**。16GB 单卡一个 5s 片段要 ~4.5 分钟，用户全程只能看到「生成中」；无 ComfyUI 采样步进回传，无法判断「在动还是卡死」。

### 🟡 问题④ — 片段与成片分辨率不一致（768×1376 → 768×1344）

- **一手证据**：片段 ffprobe `768x1376`；成片 `768x1344`；`ffmpeg.log` 把每段 `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344`。两者都被 32 整除、都属 9:16 附近，但**拼接时会重采样/加黑边**（1376→1344）。
- **严重度：低**。画质有轻微二次缩放；`video_h3_i2v` 出 1376、拼接画布取 1344，两处高度口径不一致。

### ✅ 已确认做对的（本轮亲眼所见）

- **三段入口都在「视频·后期」工作区**且能真点、真发请求：`运行「片段合成」` / `合成成片` / `下载成片`，`POST …/steps/assembly/run` 与 `POST …/steps/assembly/assemble` **均 202**。
- **前置门禁读服务端、前端不自算**：片段未齐时 `合成成片` 置灰、理由文案「片段尚未全部生成完成」；上游 keyframe done 时 assembly gate `ready:true`。
- **params 正确**：`LENGTH=124`（5s 官方网格）、`INPUT_IMAGE` 逐镜对应首帧、`PROMPT` 为真实 H3 本地字段口径（走编译器）。
- **下载是站内**：`location.href` 与 page target 数均未变，未跳新页。
- **串行不并发**：3 个片段严格一个接一个（ComfyUI 队列 `running:1 pending:0`），符合 16GB 硬约束。

---

## 3. 明确「没验到的」（不许当成通过）

| 项 | 状态 |
|---|---|
| **成片音轨应为有/无**（问题②是否属预期） | **未定论**——只客观观测到成片无 audio 流，未找产品侧确认设计意图 |
| **「导出交付包」（zip）** 按钮 | 未点击（`导出交付包` 按钮已出现但本轮未验，避免超范围） |
| **多片段/多集成片**（本 run 仅 3 镜 1 集；>3 片段的长成片） | 未覆盖 |
| **「重新合成」后旧成片是否清理** | 观察到 attempt 2 落到 `-r2` 目录、旧 `assembly-run-musrs21x-pri3c` 仍在盘；**未盘问是否有清理策略** |
| **后台标签页定时器节流对轮询的影响**（问题①的环境副作用） | 只观测到现象，**未做前台激活 tab 对照实验**，如实标注为「疑似环境副作用」 |
| **前端性能缓冲区满载** | 首次读 `performance` 未捕获到 `…/assemble` 条目（3s 轮询把 250 条缓冲占满）；**重拼一次才捕获到**。属**测量口径坑**，非功能缺失——如实记录 |

---

## 4. 本次边界声明

- **未改任何代码**（`canvas-server/**`、`web/**` 一律未动）；**未** `git add/commit/push`；**未**重启 8788；**未**引入新依赖。
- **未删除任何已有项目 / run / 素材**；本轮新产出为该 run 的正常副作用（3 片段 + 1 成片），保留。
- 仅新增本报告 + `progress/meta.json` 加一行导航。
- 私有 tab 收尾已用 `curl http://127.0.0.1:9222/json/close/<我的 tid>` **只关自己那个**。
- 本报告区分「**实测**」与「**推断**」：凡未亲眼在界面/后端看到的，均在 §3 标为「没验到」。

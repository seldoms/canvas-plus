# LocalMiniDrama 深度拆解（供融合路线会诊）

> 调研对象：`xuanyustudio/LocalMiniDrama` —「本地 AI 短剧 & 漫剧生成工具」
> 一手来源：`git clone --depth 1` 到 `/tmp/LocalMiniDrama`（只读分析，未改动任何仓库）。
> 提交：`755192a` （2026-10-02），版本 **v1.2.8**（CHANGELOG 最新条目 2026-07-01）。
> 许可证：**MIT**（`LICENSE`，Copyright (c) 2026 xuanyustudio），**无附加条款**、无商用限制、无 CLA。README 里的打赏入口不构成授权条件。
> 平台：Windows 优先（README/License 徽章均标 Windows），Electron 28 桌面壳。

---

## 0. 一句话定位

**它是一条「剧本 → 逐镜图/视频片段」的本地生成流水线 + 一个「把分镜片段按顺序 ffmpeg 拼接」的粗合成器；它不是剪辑器，也没有时间线。** 画布视图只是列表数据的空间化视图层（批量编排 + 整组重跑），不是 ComfyUI 那种数据流计算图。最终「成片」= `ffmpeg -f concat -c copy` 原生流拼接 + 可选的旁白/对白音轨混入 + 可选的旁白字幕烧录。

---

## 1. 能力边界表（最重要）

| 环节 | 做到了什么 | 做到哪一步就停 / 明确不做的 |
|---|---|---|
| 剧本 | 梗概+风格 → 多集剧本；小说/长文导入（正则切章，`novelImportService.js`）；剧本文本编辑 | 停在「文本剧本」；无分场剧本格式、无剧本协作 |
| 角色 | AI 提取 + 形象图生成；身份锚点 `character_identity_anchors`；Seedance2 角色资产认证（`sd2-certify`）；四视图 | 停在「角色定妆图 + 认证资产」 |
| 场景/道具 | 从剧本提取 + 生成背景/道具图；全局素材库（角色/场景/道具库）跨项目复用 | 停在「图 + 库」 |
| 分镜 | 按集自动生成分镜脚本（景别/运镜/灯光/景深/对白/解说）；经典模式 / 首尾帧模式 / 全能模式（`universal_segment_text`，`@图片N` 多参考） | 停在「分镜表 + 提示词」；**无时间线摆放、无镜间时长精调（只有 duration 数值字段）** |
| 出图 | 逐镜生图（多 provider）；`sharp` 2x 超分；手动上传/拖拽替换；尾帧提取回填下一镜首帧（`tailFrameLinkService`）；连贯帧模式 | 停在「逐镜静帧」 |
| 出视频 | 逐镜生视频（多家云 API）；首帧/尾帧/多图参考；批发生成；失败重试 3 次 | 停在「逐镜视频片段（mp4）」 |
| **成片（合成）** | 见 §2。`video_merges` 表 + `ffmpeg concat -c copy` | **停在「原生流拼接 + 可选音轨/字幕烧录」**。**无转场、无裁剪、无变速、无重排、无多集拼接** |
| 音频/TTS | 见 §3。对白 TTS + 解说 TTS（两条独立轨） | **仅 MiniMax T2A 与 OpenAI 兼容 `/audio/speech` 两家**；**无 BGM、无音效、无音乐库、无 lip-sync/对嘴** |
| 字幕 | 见 §3。导出/烧录**解说** SRT | **无字幕编辑器**；字幕时间轴按分镜「声明时长」均分，**不对齐实际语音**；无对白字幕 |
| 剪辑 | —— | **完全没有内置剪辑 / 时间线 / 精剪 / NLE**（全仓库无 timeline 数据结构；「时间线」字样全部出现在运镜提示词文案里） |
| 交付/导出 | 工程 ZIP 导出导入（`EXPORT_VERSION 1.4`，含媒体+分镜图历史+首尾帧绑定）；分镜表 HTML 导出；集视频下载 | **无剪映/CapCut 草稿导出**（`剪映`/`capcut`/`draft_content` 全仓库零命中）；无字幕文件（对白）导出；无 EDL/XML |
| 部署形态 | Electron 桌面（Windows NSIS/便携），内置 `ffmpeg.exe`(99MB) | **单机单用户**；无登录、无多租户、无权限、无并发配额管理 |
| AI 接入 | 文本/图片/视频/TTS 四类独立配置槽；9 家 provider 预设 | 文本类支持本地 Ollama（OpenAI 兼容）；**无原生 ComfyUI 接入**（仅提供一份用 `comfyui-openai-api` 代理把它包装成 OpenAI 接口的社区教程 `docs/comfyui配置.md`） |
| 画布 | 见 §4。双视图、整组重跑、节点内编辑 | 节点间连线是**引用/视觉关系，不是控制流**（无上游→下游数据传递引擎） |

### 底线结论（对产品负责人判断的印证）
1. **它没有做剪辑/时间线。** 「成片」只是把 N 个已生成片段按分镜顺序暴力拼接。
2. **它没有做剪映桥接。** 一个 Windows 桌面工具，最自然的「最后一公里」出口（导出剪映草稿）它都没做——说明连它都把精剪留给外部工具。
3. **它把「audio/subtitle」做到了「够用即止」**：能配上旁白/对白音轨、能烧一行旁白字幕，但字幕时间轴是「按声明时长均分」的粗对轴，不是真对齐。
4. **它的 roadmap 剩余项全是「生成侧」**（场景图→全景图、参考图自由上传/选择、宫格图生成视频），**没有一条是「编辑侧」**。

---

## 2. 「成片」到底怎么产生的（关键机制）

代码：`backend-node/src/services/videoMergeService.js`（296 行）、`mergedEpisodePostProcess.js`（446 行）、`routes/videoMerges.js`。

流程：
1. 前端（`FilmCreate.vue` `getFinalizeMergeOptions`）提交 `POST /video-merges`，带 `episode_id`、`scenes[]`（每个 scene 含 `scene_id`、`video_url`、`duration`）与 `merge_options`。
2. `resolveVideoToLocalPath()` 把每个 `video_url` 解析成本地路径（命中 storage 根 → 直接用；远程 → 下载到临时目录）。
3. **核心合成 = 拼接**：
   ```
   ffmpeg -f concat -safe 0 -i concat_list.txt -c copy -y merged_<ts>.mp4
   ```
   `-c copy` 原生流拷贝，**不重编码、无转场、无裁剪、无变速、无重排**（顺序=传入的 scenes 顺序=分镜号顺序）。
4. **静默降级**：无 ffmpeg、或 concat 失败、或片段 >100 段时 → `merged_url` 直接取**第一段**（`mergedUrlFallback`），仍标记 `completed`。即「合成失败也不报错，只是给你第一条片段」。
5. **可选后处理**（`mergedEpisodePostProcess.runMergedEpisodePostProcess`，仅当 `merge_options` 需要时才跑）：
   - 需要「烧录对白音轨 / 烧录旁白字幕 / 水印」时触发；
   - 逐镜构造时长槽（`slotSec = max(0.2, scene.duration || 5)`）；
   - 对白轨取库里已存的 `audio_local_path`，缺失则写静音；旁白轨则**对每条 narration 现做 TTS**；
   - 音频用 `atempo`（链式，>2x 分段）拉长/压缩到槽长，或用 `apad` 补静音，做到「音频贴合镜头时长的槽」；
   - 对白+旁白用 `amix=inputs=2:duration=first` 混音；全部 `concat` 成一条 mp3 后再 `alignAudioToVideoDuration` 对齐到视频总时长；
   - 旁白 SRT：**每条分镜一个 cue，时长=该镜声明 duration**（`tMs += slotSec*1000`），累积时间轴写出 `_narration.srt`；
   - 烧字幕 `subtitles=`、烧水印 `drawtext=`（右下角），再 `libx264 + aac + faststart` 与音轨 mux 成 `*_post.mp4`。
6. 落库：`episodes.video_url`、`video_merges.status='completed'`。

> **本质**：它是一个「片段拼接器 + 音轨铺设器 + 硬字幕烧录器」，**不是剪辑器**。所谓「全流程到成片」，成片 = 分镜顺序的粗暴 concat。

---

## 3. 音频 / TTS / 字幕做到哪一步

代码：`ttsService.js`（173 行）、`routes/audio.js`、`mergedEpisodePostProcess.js`。

- **TTS provider 仅 2 类**：MiniMax T2A v2（`speech-02-hd`，`voice_id`）与 OpenAI 兼容 `POST {base_url}/audio/speech`。其余 provider 直接抛「不支持」。
- **两条独立轨**：对白 → `storyboards.audio_local_path`；旁白 → `storyboards.narration_audio_local_path`。前端各有「配音 / 解说配音」按钮，也支持批量。
- **无对齐到语音的字幕**：字幕（仅旁白）时间轴按「每镜声明 duration」均分，与 TTS 实际音频长度无关；音频反而是被 `atempo/apad` 去迁就这个槽长。
- **无 BGM / 音效 / 音乐床 / 音量自动化 / 单人多角色配音管理**（`characters.voice_style` 字段存在但只作为元数据）。
- **无 lip-sync / 对口型**（无音频驱动口型链路）。
- 对白字幕不存在；「字幕」只服务第三人称解说（纪录片式旁白）。
- 备注：`ttsService` 里有一行 `require('./cloudService').reportUsage(...)`，但 `cloudService.js` **文件不存在**（包在 try/catch 里），实际是死代码——**当前无遥测回传**。埋点在，融合时注意别把它带进来。

---

## 4. 画布工作流机制

一手文档：`docs/plans/2026-06-15-drama-canvas-workflow-plan.md`（278 行，阶段 A–D 全已完成）。

**设计原则**：真源不变（仍存既有表 + `project.json`），**画布是视图层**，只额外持久化 `drama.metadata.canvas_layout`（坐标/视口）与 `metadata.workflow_groups`（工作流组）。旧 JSON 兼容（无 layout 则自动布局）。技术栈 Vue 3 + `@vue-flow/core ^1.48`。

**节点类型**（ID 规范）：
| ID | 含义 |
|---|---|
| `drama:header` / `episode:{id}` | 项目标题 / 集标题 |
| `char:{id}` / `scene:{id}` / `prop:{id}` | 角色 / 场景 / 道具（素材节点） |
| `sb:{id}` | 分镜（一行一镜的主卡片） |
| `sbtxt:{id}` / `sbuni:{id}` | 分镜文本摘要（经典）/ 全能分镜词（全能模式） |
| `sbimg:{id}` / `sbimg-first:{id}` / `sbimg-last:{id}` | 分镜图 / 首帧 / 尾帧 |
| `sbvid:{id}` | 分镜视频 |
| `sbaud:{id}:dialogue` | 对白音频 |

**节点关系 = 引用，不是控制流**：
- 素材 → 分镜：绿色虚线（引用关系）。
- 分镜 → 媒体、分镜 ↓ 分镜：实线（顺序链 / 归属，非数据传递）。
- 媒体节点由 adapter（`dramaCanvasAdapter.js`）**动态生成**——数据里只存分镜 ID，图是渲染出来的。
- **没有**「上游节点产出喂给下游节点」的数据流引擎（不是 ComfyUI 那种 DAG 求值）。

**重跑机制**：
- 框选/Ctrl 多选**分镜节点** → 「创建工作流」→ 勾选步骤 `pipeline: ["image","video","audio"]` → 存 `metadata.workflow_groups`（含 `storyboard_ids`、`title`、`pipeline`）。
- **整组重跑** = 按组内分镜顺序**依次**执行勾选步骤，**某镜失败即停止**。是「顺序批处理」，不是并行 DAG。
- 删除工作流只删分组配置，不删分镜/媒体。

**与列表视图分工**：
- 同一个 `/film/:id/canvas`，与列表模式（`FilmCreate.vue`）**同源数据**；画布进出保留集数筛选。
- 列表 = 精细编辑（提示词全文、参数、单条重跑、上传替换）；画布 = 批量编排 + 空间化总览 + 整组重跑 + 节点内轻编辑（v1.2.8 起可在画布内新建/删除/整集生成，`useCanvasCrud` / `useCanvasEpisodeGenerate`）。
- 双击分镜节点 → 跳回列表模式并定位。
- 布局持久化：拖动 debounce 存 `PUT /dramas/:id/canvas-layout`；Vue Flow 配置要点：`:selection-key-code="true"` + `:pan-on-drag="[1,2]"`（左键框选、中/右键平移），**勿用已废弃的 `selection-on-drag`**。

> 结论：画布是「列表数据的空间化 + 批量重跑面板」，实现成本远低于「节点式计算引擎」。这个认知很重要——别把它想象成 ComfyUI。

---

## 5. 架构速览

**三子项目同仓（无 monorepo 工具）**：
- `backend-node/`：Express 4 + better-sqlite3 + adm-zip + sharp + js-yaml + multer + jsonwebtoken + @volcengine/openapi + uuid。**纯 JS，无 TS、无 lint**。端口 5679。`node --test`。启动即自动跑迁移（`ensureColumns()`）。
- `frontweb/`：Vue 3.4 + Vite 5 + Element Plus + Pinia + vue-router + @vue-flow/core（+background/controls/minimap）。端口 3013。
- `desktop/`：Electron 28 + electron-builder；`asarUnpack` better-sqlite3/sharp；`extraResources` 打包内置 `ffmpeg.exe`(99MB)、示例工程、前端 dist；Windows NSIS + 便携。

**数据模型（SQLite，`migrations/01_init.sql` + 22 个增量迁移）**：
`dramas` / `episodes` / `storyboards` / `characters` / `episode_characters` / `scenes` / `props` / `storyboard_props` / `frame_prompts` / `ai_service_configs` / `async_tasks` / `image_generations` / `video_generations` / `video_merges` / `character_libraries` / `scene_libraries` / `prop_libraries` / `assets`。
- 全表软删除（`deleted_at`）；`storyboards` 是核心（含 `image_prompt`/`video_prompt`/`shot_type`/`angle`/`movement`/`dialogue`，迁移新增 `narration`、`universal_segment_text`、`creation_mode`）。
- 生成历史分表存（`image_generations`/`video_generations`），支持重生成版本。
- 媒体 = 本地文件（`storage/local_path`）或 URL；`image_proxy_cache`（迁移 12）做图床 URL 缓存。

**AI 接入（适配层）**：
- 配置表 `ai_service_configs`：`service_type ∈ {text, image, storyboard_image, video, tts, jimeng2_character_auth, model_ark_asset}`；每条含 `provider / api_protocol / base_url / api_key / model / endpoint / query_endpoint / priority / is_default / settings(JSON)`。四类模型独立配置、可多配置 + 默认优先级。
- 派发：`resolveVideoProtocol()` 先看显式 `api_protocol`，否则按 provider/base_url/模型名**启发式推断**（xai / agnes / minimax_h3 / kling_omni / volcengine_omni …）。
- **客户端是手写 Node `http/https`**（后端不用 axios/fetch 做 AI 调用），有 `family:4`（强制 IPv4 规避 Windows/Electron 下 Cloudflare IPv6 超时）、可配置超时（图 10 分钟）、SSE 流式（文本，按静默超时判定）。
- **代码质量提示**：`videoClient.js` **4872 行**单文件、`imageClient.js` 1958 行、`promptI18n.js` 1620 行——巨型单体 + 大量 provider 特判/环境变量覆盖/调试 `console.log`。适配层是「能跑的一堆特例」，**不是干净的插件接口**。

---

## 6. 三条融合路线的成本 · 风险 · 结论

> 前提差异：我们是 **局域网 Web 服务**（Node 零依赖网关 `canvas-server` + React18 前端 + 本地 ComfyUI + Ollama）；它是 **Windows 优先的 Electron 单机桌面应用**（Express + Vue3 + SQLite + 本地文件 + 云 AI API）。

### 路线 (a) 借鉴设计与数据模型，自己实现 —— **推荐**
**可白嫖的清单**：
1. **数据模型**：`dramas/episodes/storyboards/{characters,scenes,props}` + `image_generations/video_generations/video_merges` 的字段划分与软删除约定（可直接映射到我们的库）。
2. **画布的数据契约**：`canvas_layout`（节点坐标+视口+version）与 `workflow_groups`（`storyboard_ids` + `pipeline` 勾选 + 顺序执行）这两个 JSON IR——**体积小、语义清晰、易移植**，是我们画布最值得抄的部分。
3. **成片 ffmpeg 配方**：`videoMergeService` 的 concat 流程 + `mergedEpisodePostProcess` 的「音频贴合槽长（atempo/apad）→ amix → 对齐视频总时长 → 烧 SRT/drawtext」这套 recipe，**plain Node + ffmpeg CLI，几乎与平台无关**，可直接用我们自己的代码复刻（Linux 用系统 ffmpeg，不用它那个 Windows exe）。
4. **工程导出 ZIP 格式**（`EXPORT_VERSION 1.4`）的目录/字段组织，作为我们交付/迁移格式的参考。

**成本**：中（主要是把 JS 逻辑翻译成我们的 JS/React 体系）。
**风险**：低-中。MIT 可放心借鉴（保留版权声明即可）；我们保留 React + canvas-server + ComfyUI 技术栈，无代码耦合；无「fork 后跟不动上游」的风险。
**结论**：**主推。** 尤其「成片（拼接+旁白/对白音轨+字幕烧录）」是我们当前最可能缺的一块，而这套 recipe 成本最低、价值最高。

### 路线 (b) 拿它的某个模块直接跑 / 嵌入
**可嵌入性分级**：
- **后端合成三件套**（`videoMergeService.js` + `mergedEpisodePostProcess.js` + `ttsService.js` + `ffmpegPath.js`，合计 ~1000 行）：**plain Node，最可移植**，可改造成 `canvas-server` 背后一个「片段→成片」微服务/模块。风险：Windows 字体路径假设、`cloudService` 死引用要删、TTS 只两家需替换为我们本地 TTS。
- **画布 UI**：**不可直接用**（Vue3 + Element Plus + @vue-flow vs 我们 React）。只能参考交互，不能搬组件。
- **整个应用**：**不建议**。会把我们变成「维护它的 fork」，而非加速我们；且 24k 行后端、4872 行 videoClient 与我们「零依赖网关」的取向冲突。
**成本**：后端合成模块 = 低；整应用 = 高。
**风险**：中。代码质量参差（单体+调试残留）、纯 JS 无 TS、Windows 假设、云 provider 代码对本地 ComfyUI 无用。
**结论**：**仅限「合成/后处理模块」以参考实现或改写后嵌入**；UI 与整应用不碰。

### 路线 (c) 完全不用
**何时成立**：如果我们真要做**内置剪辑/时间线/精剪**——那它身上没有任何可抄的（它自己就没做）。
**但**：由于 (a) 的成本足够低，直接放弃会白白丢掉「成片拼接 + 音轨 + 硬字幕」这块现成配方。
**结论**：**不推荐全面放弃**；至少把 (a) 清单里的「成片 recipe + 画布 JSON IR + 数据模型」拿走。

---

## 7. 它给我们的正面 / 反面启发

**反面（印证产品负责人的判断：「网页实现全部短剧功能做不到」）**：
1. 一个已迭代到 v1.2.8、22 个迁移、~24k 行后端的**专职短剧工具**，**依然没有内置剪辑/时间线**——「成片」= 原生流拼接 + 可选旁白轨/字幕烧录。
2. 它是 Windows 桌面应用，**却连最顺手的「导出剪映草稿」都没做**——行业做法就是「给粗剪 + 素材，精剪交外部」。
3. 音频只 2 家 TTS、字幕只有旁白自动 SRT 且粗对轴、无 BGM/音效/lip-sync——**最后一公里是被刻意留白的**。
4. roadmap 剩余项**全是生成侧**（全景图/参考图自由选/宫格转视频），**编辑侧一条都没有**。
   → **反向证据明确**：不要试图在 Web 里复刻 NLE。正确定位是「生成 + 拼接 + 粗合成」骨干，把精剪/节奏/字幕精修/BGM 交接出去。

**正面（低成本可复制的设计）**：
1. **双视图单一真源**：画布只是视图层，真源仍是表 + `metadata`；布局/工作流组存 JSON。**极简、可靠，直接抄我们的画布。**
2. **画布 = 批量编排面板，不是计算引擎**：节点连线是引用不是控制流；「整组重跑」= 顺序批处理 + 失败即停。**去魅后实现成本可控。**（我们别一开始就上 DAG 求值引擎。）
3. **AI 适配用「配置表 + service_type + api_protocol」**：多 provider 用一张表管、四类模型独立配置——**这个模式可以直接借鉴**（即使我们接的是 ComfyUI 本地工作流，也可用同一套「配置槽 + 协议字段」抽象）。
4. **生成历史分表 + 软删除 + 版本化**：`image_generations`/`video_generations` 独立成表支持「重生成/历史版本」，避免覆盖丢档——**值得抄**。
5. **`tailFrameLinkService`（尾帧衔接）**：用 ffmpeg 抽当前片段末帧回填下一镜首帧，解决镜间跳变——**低成本、高性价比的小机制，可直接借鉴**。

---

## 8. 引用源

**本地（`/tmp/LocalMiniDrama`，commit 755192a）**
- `README.md`、`docs/en.md`、`LICENSE`（MIT）、`AGENTS.md`、`CHANGELOG.md`（v1.2.8→v1.2.1）
- `docs/plans/2026-06-15-drama-canvas-workflow-plan.md`（画布机制，重点）
- `docs/configuration.md`、`docs/quickstart.md`、`docs/comfyui配置.md`（ComfyUI 仅社区代理教程）
- `backend-node/migrations/01_init.sql`（数据模型）；migrations 01–22（增量演进）
- `backend-node/src/services/videoMergeService.js`、`mergedEpisodePostProcess.js`、`ttsService.js`
- `backend-node/src/services/aiConfigService.js`、`aiClient.js`、`videoClient.js`(4872行)、`imageClient.js`(1958行)
- `backend-node/src/services/aiConfigService.js`（service_type 枚举）、`utils/ffmpegPath.js`（内置 ffmpeg 查找）
- `backend-node/src/routes/index.js`（156 条 API）、`routes/audio.js`、`routes/videoMerges.js`
- `frontweb/package.json`、`desktop/package.json`（Electron/打包配置）
- `openclaw-skill/README.md`（对外 API 覆盖自述）

**约定**
- GitHub API 本次被限流，改用 `git clone --depth 1` 直连获取全部一手文件（成功）。
- 本次调研**只读**：未修改 `/sobey/canvas-plus` 任何文件，未对其做任何 git 操作。

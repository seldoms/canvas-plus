# OpenCut 调研：能否作为短剧流水线的「精剪/时间线」环节

> 调研日期：2026-10-03 ｜ 调研对象：`opencut-app/opencut`（GitHub 显示为 OpenCut-app/OpenCut，大小写不敏感）与其上一代 `opencut-app/opencut-classic`
> 方法：`git clone --depth 1` 只读分析两个仓库源码 + raw.githubusercontent 取 README/package.json + 页面抓取星标数；**未改动 `/sobey/canvas-plus` 任何文件**

## 一句话定位 + 当前可用度结论

**OpenCut 是 MIT 协议、浏览器端本地剪辑器（自称 "the open-source CapCut alternative"，主仓库 91,304 stars / 9,037 forks），它是一个"纯编辑器"：只做剪切/关键帧/蒙版/特效/字幕，不做任何生成，也没有服务端剪辑 API、没有 headless 渲染、不支持 FCPXML/EDL/OTIO 等交换格式。**

**可用度结论：**
- **能用的只有 classic 版**（`opencut-classic`，也是 `opencut.app` 线上版本）；classic README 明确写 **"archived and no longer maintained"**，末次提交 2026-05-17，末个版本 v0.3.0（2026-04-15）。它是一套成熟可跑的应用，但**已停更**。
- **新版（Rust 重写）目前只是脚手架**：默认分支 `apps/web/src/routes/editor.tsx` 内容就是 `"Coming soon."`；`apps/api` 只有 `/`、`/health`、`/echo` 三个骨架路由；`apps/desktop/README.md` 自述 **"Very early. Right now this is just a window that opens."**；根 `Cargo.toml` 只有 `apps/desktop` 一个 member（`crates/*` 被注释掉）。README 自己也说 **"We're not set up to take outside contributions yet while the architecture is being designed."**
- 因此 **新版短期内不可用**（Editor API / MCP server / headless mode 都在"coming"清单里，无落地代码，无时间表）。

---

## classic vs 新版 对比表

| 维度 | classic（`opencut-classic`，opencut.app 线上） | 新版（`opencut` 默认分支，new.opencut.app） |
|---|---|---|
| 状态 | 成熟可用，但 **archived / 不再维护**（末次提交 2026-05-17） | **重写脚手架**，架构设计期，编辑器路由仍是 "Coming soon" |
| 星标 | 263 stars（归档副本） | **91,304 stars / 9,037 forks**（含 classic 时期积累） |
| 技术栈 | Web：**Next.js 16 + React 19 + Zustand + Tailwind 4 + Drizzle/Postgres + Redis/Better-Auth**；核心：**Rust→WASM**（`rust/crates/`：compositor / effects / masks / gpu / time，wgpu 合成器）；桌面：GPUI(Rust) 迁移中 | Web：**Vite 8 + React 19 + TanStack Router/Start**；API：**Elysia on Cloudflare Workers**（骨架）；桌面：GPUI(Rust) 空壳；`crates/media` 只有 FFmpeg 8.1.3 构建脚本 |
| 自托管 | ✅ **Docker Compose 全栈**（postgres:17 + redis:7 + serverless-redis-http + web，映射 3100:3000）；也支持 OpenNext→Cloudflare；纯前端开发可跳过 DB | ⚠️ 只有 dev 脚本（`moon run web:dev` / `api:dev`），无 compose、无生产自托管路径 |
| 能否嵌入我们 Web 应用 | 技术上可 iframe（Next.js，自托管到子域/独立端口），**但项目数据存在用户浏览器本地**（IndexedDB + OPFS），无服务端项目 API —— 宿主无法下发/回收时间线 | 尚无可嵌之物（编辑器未实现） |
| headless / 命令行 / 批量渲染 | ❌ **无**。导出 100% 在浏览器内用 WebCodecs 完成（`export/index.ts` 用 `Blob`+`URL.createObjectURL` 下载；`services/renderer/scene-exporter.ts` 用 canvas + medibunny `BufferTarget`） | ❌ 未实现；README 把 **"Headless mode (automation, batch rendering)"** 列为 roadmap；`crates/media` 的 FFmpeg 多平台构建 CI 是这条路的**地基层**而非成品 |
| 对外 API | ❌ 仅 `/api/health`、`/api/sounds/search`、`/api/feedback`、`/api/auth`（无剪辑/渲染/项目接口） | ⚠️ Elysia 骨架（health/echo）；README 列 **"Editor API"** 为 roadmap，未实现 |
| 插件 / Agent / MCP | ❌ 无 | ❌ 未实现；README 列 **"plugin-first architecture"、"MCP server (for AI agents)"、"scripting tab"** 为 roadmap |
| 许可证 | **MIT**（Copyright 2025-2026 OpenCut）—— 可商用、可修改、可再分发，需保留版权与许可声明 | **MIT**（Copyright 2026 OpenCut）—— 同上 |

> 说明：主仓库 `opencut` 保留了 `pre-rewrite` 标签与 v0.1.0/v0.2.0/v0.3.0 标签，`pre-rewrite` 树里就是 classic 那套完整代码（apps/web/src 下 691 个文件）；`opencut-classic` 仓库是其归档副本。`changelog/0.1.0~0.3.0.md` 记录的是**classic 线**的发布，不是新版功能。

---

## 导入 / 导出格式清单（重点：FCPXML / EDL / SRT）

**结论：OpenCut（classic）不接任何时间线交换格式。**

| 能力 | classic 实际情况 | 一手证据 |
|---|---|---|
| 视频/音频/图片素材导入 | ✅ 广谱容器（MP4/MOV/WebM…，H.264/HEVC/VP9/AV1…），由 **mediabunny `ALL_FORMATS`** 客户端解码，受浏览器 WebCodecs 支持度约束（代码里有 `canDecode` 标记） | `apps/web/src/media/mediabunny.ts` |
| **FCPXML 导入** | ❌ **完全没有** | 全仓 grep `fcpxml`/`fcpx` = 0 命中 |
| **EDL 导入** | ❌ **完全没有**（`grep -i edl` 的命中全是 `getCenteredLineLeft`/`expandedLaneCount` 等子串误报） | 全仓 grep `\bEDL\b` = 0 有效命中 |
| **OpenTimelineIO / XML** | ❌ 无 | grep `otio` 命中全是 `motion` 子串误报 |
| **SRT 导入** | ✅ 有（`subtitles/srt.ts` 的 `parseSrt`） | `apps/web/src/subtitles/parse.ts` 分发 srt→`parseSrt` |
| **ASS 导入** | ✅ 有（含样式映射） | `apps/web/src/subtitles/ass.ts` |
| **SRT/VTT 导出** | ❌ **无字幕文件导出**（grep `buildSrt/toSrt/exportSrt` = 0）；字幕/自动转写只渲染进画面（烧录） | `apps/web/src/subtitles/` 只有 parse，无 serialize；`export/` 只有 MP4/WebM |
| **视频导出** | ✅ 仅 **MP4 / WebM**（质量 low/medium/high/very_high），**浏览器内 canvas + WebCodecs 渲染**，无服务端渲染 | `apps/web/src/export/index.ts`（`EXPORT_FORMAT_VALUES = ["mp4","webm"]`）、`services/renderer/scene-exporter.ts` |
| 自动字幕（ASR） | ✅ 浏览器内 transformers.js/Whisper 转写（多语言，**音频可识别中文**） | `apps/web/src/transcription/`（models/languages/caption） |
| 项目文件本身 | 存浏览器本地 **IndexedDB + OPFS** 的自定义 `SerializedProject` schema；**非通用格式**，无导入导出 API | `apps/web/src/services/storage/service.ts`、`indexeddb-adapter.ts`、`opfs-adapter.ts` |
| 中文 UI | ❌ 无 i18n 框架、无中文界面串（UI 纯英文；仅音频转写支持多语言） | grep `i18next/useTranslation`、`中文/zh-CN` = 0 |

**对我们的直接含义：即便我们把粗剪结果导出成 FCPXML 或 EDL，OpenCut 也接不住；反过来它也无法把剪好的时间线交回给我们——两边只能靠"烧录好的 MP4/WebM"交换，不构成工程化流水线。**

---

## 三条路线（a / b / c）的成本 · 风险 · 结论

### (a) 站内嵌 OpenCut 做精剪 —— ❌ 不推荐
- **做法**：Docker 自托管 classic（Postgres+Redis+Next，3100 端口），用子域/iframe 嵌进我们的 Web 应用。
- **成本**：中高。要把我们的"自动装配结果"喂进去，必须在**没有服务端 API** 的前提下，自己逆向它的 `SerializedProject` / IndexedDB+OPFS schema 来播种项目、再把素材搬进用户浏览器；导出侧只能回收一个浏览器渲染出来的 MP4。
- **风险**：
  1. **依赖已归档停更的代码库**（README: archived / no longer maintained），而它构建在高速迭代的 **Next 16 / React 19 / Turbopack / WebCodecs** 之上，浏览器兼容与安全补丁会持续漂移；
  2. **无服务端项目 API + 无交换格式** → 与我们"服务端流水线"的集成是"深 fork"级别，而非"接一下"；
  3. classic README 自己点名 **"Avoid for now: … export functionality - we're refactoring these with a new binary rendering approach"** —— 连导出都在重构中，稳定性存疑；
  4. 无法把粗剪时间线"交进去"（无 FCPXML/EDL/OTIO），流水线环节断裂。
- **结论**：把"精剪"环节押在一个停更且无 API 的浏览器编辑器上，成本/风险都高，收益被剪映碾压。

### (b) 不嵌，只把导出包（FCPXML / EDL / 分片 / SRT）做成标准，交剪映/达芬奇 —— ✅ 推荐
- **做法**：站内只做粗剪 + 自动装配 + 预览，产出**工业交换包**：`FCPXML`（达芬奇/FCP 首选）或 `EDL`（剪映/多数 NLE 可食）+ 分片素材 + `SRT`；创作者在剪映/达芬奇里做卡点、调色、多轨、特效。
- **成本**：低。FCPXML/EDL/SRT 都是成熟规范，从我们自己的时间线模型导出即可，完全可控、可版本化、可回归测试。
- **风险**：低。唯一成本是格式保真度（帧率/时基/drop-frame、变速、转场映射），但这些是确定性工程问题；且**创作者用他们本来就熟的工具**，学习成本≈0。
- **结论**：与行业口径（LibTV 官方教程 = "LibTV + Seedance2.5 + 即梦 + 剪映"，页面地图无时间线路由）和负责人"网页别试图做全部"的判断完全一致。**这是主路线。**

### (c) 混用（粗剪+预览站内，精剪导出；OpenCut 仅作可选彩蛋） —— ✅ 推荐，作为 (b) 的增强
- **做法**：以 (b) 为主干；OpenCut **只作为"免费可选编辑器"以超链接/独立子域形式提供**（甚至直接导流到 `opencut.app`），让想白嫖云端轻剪的创作者用，但**我们的流水线绝不依赖它的 API 或它的项目格式**。
- **成本**：中低。多做一个"导出交换包"按钮（即 (b) 的产出）+ 一个可选入口。
- **风险**：中低。把 OpenCut 降级为"非关键、可替换依赖"，即使它明天改协议/停更/重写，也不影响主链路。
- **结论**：**推荐 (b) 为默认，(c) 为增强**；除非将来新版真的落地了 **Editor API / headless mode / MCP server**（届时再评估用 Agent 驱动批量精剪），否则现在不要把 OpenCut 写进关键路径。

---

## 对"网页只做到粗剪+导出"这个口径的：证据

### ✅ 支持（强）
1. **最像"网页编辑器标杆"的 OpenCut，本身就是纯编辑器**：91k stars，却没有生成、没有调色台、没有素材库生态，只有 cut/keyframe/mask/blur 级别的能力。
2. **它没有服务端 API，也没有 headless**：`apps/web/src/export/` 全在浏览器里跑（`Blob` 下载 + canvas/WebCodecs），`app/api` 只有 health/sounds/auth/feedback —— 说明**"网页内剪辑"离"可被流水线编排"还有一整个 API 层的距离**。
3. **它不支持任何时间线交换格式**（FCPXML/EDL/OTIO 全无），导出只有 MP4/WebM —— 连 OpenCut 都没打算成为"交换中枢"，我们更没必要把网页做成交换中枢。
4. **它正在"从零重写"**，README 把 **Editor API / plugin-first / 一个 Rust core / MCP server / headless mode / scripting tab** 全列为 *coming* —— **连领先的开源网页编辑器都承认：网页编辑器要做成"自动化/批处理/被 agent 驱动"的生产管线，是个还没解决、需要重写架构的问题。** 这是"网页别做全部"的最强背书。
5. **它自己承认导出是薄弱环节**：classic README 明示 "Avoid for now: … export functionality - we're refactoring these with a new binary rendering approach"。

### ⚠️ 轻微挑战
- OpenCut（classic）证明**网页能做的精剪比想象中多**：蒙版、关键帧曲线（graph editor）、变速变调、多轨、WASM/wgpu 合成、浏览器内 AI 转写都在跑。所以"网页只能粗剪"这个说法**在技术上限上偏保守**。
- 但它同时证明：**做得再多也替代不了剪映的"特效/素材/模板/中文生态"**（见下），且导出慢（浏览器软/硬解渲染）、无中文 UI。所以"挑战"只在"网页能剪到多细"，**不挑战"精剪环节应交给专业工具"这个结论**。

---

## 与剪映 / 达芬奇的对比：创作者为什么选 / 不选 OpenCut

**选 OpenCut 的理由**：MIT 免费、无 watermark、无上传（隐私）、浏览器即用、可自托管、跨平台。

**缺口（相对剪映）**：
- **特效/贴纸/转场/音乐/音效 素材库**：剪映是海量市场 + 一键套用，OpenCut 只有少量内建（classic 里 stickers 仅国旗/形状、第一个 effect 只有 Blur）。
- **中文生态**：无中文 UI、无中文模板/剪同款/数字人/图文成片；自动字幕虽支持中文**音频**，但无成熟的短视频运营配套。
- **调色**：无 LUT/示波器/色轮/LOG 工作流（对照达芬奇更是天壤之别）。
- **导出**：浏览器内渲染，速度/稳定性不如原生工具；无硬件编码调优、无队列批量导出。
- **协作/云端**：项目存在个人浏览器本地，无团队/云工程。

**缺口（相对达芬奇）**：专业调色、Fusion 合成、Fairlight 音频、多轨深度、工业交换格式（FCPXML/AAF/OTIO）、代理/远程协作 —— OpenCut 一律没有，且**连导入都不可能**。

**一句话**：OpenCut 是"够用的轻量剪辑器"，**不是**能承接我们"精剪/卡点/调色/多轨"的专业环节，更不是能与我们流水线对接的中枢。

---

## 一句话给负责人的结论

> OpenCut 的存在**恰好印证**了你的判断：**头部开源网页编辑器（91k stars）做了一年，也停在"纯浏览器剪辑"，并把 API / headless / MCP / 插件列为"将重写才能有"的未来项，同时不支持 FCPXML/EDL、导出只有浏览器内 MP4/WebM。** 所以网页端别追求做全流程——**站内做粗剪 + 自动装配 + 导出交换包（FCPXML/EDL/分片/SRT），精剪交剪映/达芬奇**；OpenCut 最多作为"可选免费轻剪入口"引流，不进关键路径。

---

## 引用源

**主仓库（新版/重写）`opencut-app/opencut`**
- `README.md`（Status：重写中；Editor API / plugins / Rust core / MCP server / Headless mode / scripting tab 为 coming；classic 为今日可选项；opencut.app 跑 classic，new.opencut.app 为重写预览）— https://github.com/opencut-app/opencut
- `apps/web/src/routes/editor.tsx`（内容：`Coming soon.`）
- `apps/api/src/index.ts`（Elysia 仅 `/`、`/health`、`/echo`）
- `apps/desktop/README.md`（"Very early. Right now this is just a window that opens."）
- `Cargo.toml`（workspace 仅 `apps/desktop`；`crates/*` 注释掉）
- `crates/media/setup/ffmpeg.json`（FFmpeg 8.1.3 多平台构建）+ `.github` FFmpeg CI（末次提交 2026-09-24 `ci(media): add the workflow that builds FFmpeg for every platform`）
- `changelog/0.1.0.md`（2026-02-23）、`0.2.0.md`（2026-03-01）、`0.3.0.md`（2026-04-15，含 MediaTime/Rust compositor 技术说明）
- `LICENSE`（MIT，Copyright 2026 OpenCut）
- 标签：`pre-rewrite`、`v0.1.0/0.2.0/0.3.0`、`ffmpeg-8.1.3-1`
- 星标 91,304 / fork 9,037（2026-10-03 页面抓取）

**归档仓库（classic，opencut.app 线上）`opencut-app/opencut-classic`**
- `README.md`（"This is the original OpenCut codebase. It's archived and no longer maintained."；Self-Hosting with Docker；焦点/避免区域含 "export functionality…refactoring"）
- `docker-compose.yml`（postgres:17 + redis:7 + serverless-redis-http + web 3100:3000）
- `apps/web/package.json`（Next 16 / React 19 / mediabunny / opencut-wasm / better-auth / drizzle）
- `apps/web/src/export/index.ts`（`EXPORT_FORMAT_VALUES = ["mp4","webm"]`）、`export/mime-types.ts`
- `apps/web/src/services/renderer/scene-exporter.ts`（canvas + mediabunny `BufferTarget` 浏览器内导出）
- `apps/web/src/subtitles/{parse,srt,ass,types}.ts`（仅 SRT/ASS **导入**，无导出）
- `apps/web/src/media/mediabunny.ts`（`ALL_FORMATS` 客户端解码）
- `apps/web/src/services/storage/service.ts` + `indexeddb-adapter.ts` + `opfs-adapter.ts`（浏览器本地持久化）
- `apps/web/src/app/api/{health,feedback,auth,sounds/search}`（无剪辑/渲染 API）
- `AGENTS.md`（架构：业务逻辑迁移进 `rust/`，apps 仅 UI 外壳）
- `rust/crates/{compositor,effects,masks,gpu,time}`、`rust/wasm/README.md`
- `LICENSE`（MIT，Copyright 2025-2026 OpenCut）；末次提交 2026-05-17；263 stars / 331 forks

**第三方佐证**
- Mervin Praison, "OpenCut Explained: Open-Source CapCut Alternative, Classic Editor vs Ground-Up Rewrite", 2026-07-13 — https://mer.vin/2026/07/opencut-explained-open-source-capcut-alternative-classic-editor-vs-ground-up-rewrite/ （独立确认：classic 跑生产、rewrite 架构设计期；`apps/api` = "Health and echo scaffold—not the future Editor API yet"；root Cargo.toml 仅 desktop 成员）
- OpenTechHub, "OpenCut", 2026-09-24 — https://www.opentechhub.io/opencut/ （"all editing and rendering happen on the user's own device: no vendor backend"）
- NemoVideo, "OpenCut vs CapCut" — https://www.nemovideo.com/blog/video-tool-comparisons/opencut-vs-capcut
- WonderShare Filmora, "OpenCut Full Review"（2026）— https://filmora.wondershare.com/video-editor-review/opencut-review.html

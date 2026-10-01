# HANDOFF — 跨 Agent 交接单

> 用途：任何 Agent（Claude / Codex / Kimi / Gemini / Cursor…）接手「画布强化」时**先读本文件**，30 秒恢复上下文。
> 本文件只放「结论 + 指针」，细节一律去读指向的文件，不要把长内容贴进来。
> 进度细节的唯一真相源是 `CHANGELOG.md` 的 `Unreleased` 与 `docs/content/docs/progress/`，本文件是它的电梯摘要。
> 每段收工前更新「当前状态」这一节。

## 接手顺序（按序读，读完再动手）

1. 本文件
2. `canvas-server/README.md` —— 网关的接口契约（冻结）与模块契约，**改代码前必读**
3. `AGENTS.md` —— 上游项目的写法约定（前端规范、画布 UI 规范、文档规范），本项目继续遵守
4. `CHANGELOG.md` 的 `Unreleased` —— 当前版本实际做了什么
5. 按任务挑读：`skills/registry.json` + `skills/*/SKILL.md`（流水线）、`docs/content/docs/development/local-gateway.zh-CN.mdx`（使用说明）、`docs/content/docs/progress/pending-test.zh-CN.mdx`（待人工验收清单）

## 项目是什么

上游是开源项目 **infinite-canvas（无限画布）**，纯前端 Vite + React，AI 请求由浏览器直连第三方接口。
本项目 `画布强化` 在它之上新增了一个**本地网关后端** `canvas-server`，把内网模型和本地 GPU 的生图/生视频收口成一套接口，并编排五段式短剧流水线。

**总目标（用户明确过两次，不要跑偏）**：
- 生图、生视频等任务**必须跑在本地**（本地 ComfyUI，RTX 5060 Ti）。
- 同时**保留 RunningHub 云端接入接口**，作为可选后端，不是默认。

## 当前状态

**最后更新**：2026-10-02（Lead）

**已完成并验证**

| 部分 | 状态 | 证据 |
| --- | --- | --- |
| `canvas-server` 网关（零依赖 Node ESM） | 完成 | `node --test test/*.test.mjs` → **52/52 全绿** |
| 本地 LLM 接入（Ollama / LM Studio / llama.cpp，SSE 逐块透传） | 完成 | 真实 Ollama 列出 8 个模型；真实 `/v1/chat/completions` 返回正常 |
| 本地 ComfyUI 生图 | 完成 | 真实产出 768×1344 PNG（`img_krea2_artistic`、`img_zimage_artistic` 均验过） |
| 本地 ComfyUI 生视频 | 完成 | 真实产出 768×1344 / 24fps / **5.17s / H.264 + AAC 原生音频**（`video_minimax_h3_t2v`） |
| 五段式流水线（小说→剧本→分镜→服化道→关键帧→片段合成） | 前四段跑通，片段合成只有规划 | 真实跑通 `script`→`storyboard`→`design`→`keyframe`，关键帧**真实出图** 768×1344 PNG |
| 前端的接入（配置页「本地网关」页签、流水线页面、5 个脚本模板） | 完成 | `npx tsc --noEmit` 新增文件 0 错；`npm run build` 通过 |
| 生成后端抽象（本地优先 + RunningHub 可选） | 完成 | `/api/backends` 返回 local 可用且默认、runninghub 未配置；显式 runninghub 会明确失败，不静默回落 |
| RunningHub 适配器（提交/轮询/上传/取消） | 代码完成，**未真机验证** | 13 项 stub 用例通过；旧 Key 已失效，见下 |
| skill 库导入（script-writing-studio、Luster 岩井俊二美学） | 已入库，**未接线** | `skills/libraries/README.md` |
| 本地能力盘点 | 完成 | `docs/content/docs/progress/local-capability-audit.md`（400 行，结论分【实测】/【文档】/【推断】） |
| 远程部署 `/sobey/canvas-plus` | 完成 | systemd `active`，远程真实生图成功 |

**进行中 / 未完成**

- **流水线阶段尚未引用导入的 skill 库**。目前 `skills/01-* ~ 05-*` 用的是骨架期给的默认提示词，`skills/libraries/` 里的两个库还没接上。这是下一步最大的一块。
- **片段合成只有「生成」没有「后期」**：`assembly` 阶段只规划 clips 与拼接顺序并生成片段，**没有拼接/转场执行体、没有视频超分、没有音轨混流**。盘点报告建议拼接直接用本机 ffmpeg（不占 GPU）。
- **视频速度是最大体验瓶颈**：当前节点图上 H3 480×864 / 56 帧就要 8.2 分钟（【实测】），5s 短剧单镜会更久；上游现成的 `video_h3_i2v_sla` / `_blockcache` 加速模板**未实测**。
- 前端**还没有 RunningHub 的 UI**（本轮只做了后端接口，`/api/backends`、`/api/runninghub/models`）。
- 换装精确性不足：`img_boogu_outfit_edit` 已跑通但属**语义重绘**（领口袖型与参考图不一致），精确换装需要 SAM3 遮罩链路（SAM3 在盘，无模板）。
- `video_h3_ref2v` 只接了 1 张参考图，多图锁角色需要补 `ref_image_1/2` 之类输入。

## 下一步（按优先级）

1. **接线 skill 库**：让 `01-novel-to-script` 走 `script-writing-studio` 的 `01 → 01b`（可选 `02` 会诊、`03` 台词精修），`02-storyboard` 走 `04-ai-video-storyboard`，`03-costume-props` 走 `05-asset-library`，`04-keyframes` 注入 `Luster` 的冻结风格层，`05-clip-assembly` 参考 `06` 的段落结构与 `07` 的声音设计。
   ⚠️ 两个库都面向**云端生成器**（Seedance 2.0 / Midjourney），我们走本地 ComfyUI，所以是**分层**不是替换：库管内容与风格，阶段技能负责翻译成 ComfyUI 模板 token，并剥掉 MJ 专用尾参。详见 `skills/libraries/README.md` 末尾。
2. **补片段合成的后期链路**：拼接/转场用本机 ffmpeg（不占 GPU）；视频超分（SEEDVR2 权重与节点都在盘，只差模板）；音轨混流。
3. **解决视频速度**：实测上游 `video_h3_i2v_sla` / `video_h3_i2v_blockcache` 加速模板；先降分辨率出草稿也是零成本方案。
4. **RunningHub 真机验证**：需要用户提供**新的有效 API Key**（旧 Key 已失效，见「坑」）。拿到后跑一次最小生图任务，确认 submit/query/upload 三条链路。
5. 前端补 RunningHub 配置与后端切换入口（如果用户要求把它做成可选 UI）。

## 已踩过的坑（别再踩）

1. **`renderTemplate` 不能把数组里的节点引用数字化**。ComfyUI 用 `["10", 0]` 里的字符串当 prompt 字典键，转成数字后校验抛 `KeyError`，报错是 `prompt_outputs_failed_validation`。只允许把 **dict 的直接字符串值**转数字（与 Python 执行器 `run_pipeline.py` 的 `fixnum` 语义一致）。有回归测试锁住。
2. **摘除 LoRA 节点后重连要按字符串比较**。`value[0] === id` 在 id 是 `"2"`、引用是 `2` 时会静默失配，留下悬空引用。
3. **`jobs.enqueue` 必须把 `backend` 写进 job 对象**。漏写会让后端分派恒为 `local`，`backend:"runninghub"` 静默走本地。
4. **静态托管前端必须补 MIME 类型**。`.html/.js/.css` 落回 `application/octet-stream` 会让浏览器拒绝执行，页面直接白屏。
5. **bash 里 `$VAR` 紧跟中文全角标点会被并入变量名**，`set -u` 下报 `unbound variable`。写 `${VAR}`。
6. **远程构建前端前要重建依赖树**。仓库里的 `web/package-lock.json` 是 macOS 上生成的，缺 `@rollup/rollup-linux-x64-gnu`，直接 `npm install` 会在 `vite build` 报 `Cannot find module`；同时上游有既有 peer 冲突（`@ant-design/pro-components@3.0.0-beta.3` 声明 peer `antd@^5`，根依赖是 `antd@^6`），要加 `--legacy-peer-deps`。
7. **健康探测不要用任务级超时**。RunningHub 任务超时是 30 分钟，`/api/health` 用它会被拖住；已单独加 `runninghub.probeTimeoutMs`（默认 8000ms）。
8. **本机 8788 上的 SSH 隧道会遮住本地服务**。本地跑 `node src/index.js` 时如果 8788 已被隧道占用，`curl 127.0.0.1:8788` 打到的是远程。排查前先 `pgrep -fl 8788`。
9. **RunningHub 的 taskId 是数值且超出 JS 安全整数**（如 `2009215121247047681`）。不要经 `Number`，要直接拼数字字面量。
10. **旧 RunningHub Key 已失效**：真 Key 与伪造 Key 都返回 `806 APIKEY_USER_NOT_FOUND`，无 Authorization 头返回 `1602 HEADER_API_KEY_NOT_FOUND`。用这个区分「Key 无效」与「请求头缺失」。
11. **编排器产出的参数必须覆盖模板要求的全部 token**。`pipeline.js` 早先只给关键帧传 `PROMPT`，而 `img_zimage_artistic` 还要 `WIDTH/HEIGHT/BATCH`，渲染阶段直接报「缺少参数」；end 帧还被指向 `editTemplate`（`img_boogu_outfit_edit` 是换装模板，要 `PERSON_IMAGE + CLOTHING_IMAGE`），语义和参数都错。现在尺寸默认值来自 `config.pipeline.image*/video*`，并有契约回归测试用**真实模板**渲染编排器产出的参数。新增或更换模板时务必让这个测试覆盖到。
12. **`FRAME_RATE` 不是 H3 模板的 token**，LENGTH 才是帧数，且走 17n+5 网格（5s≈124 帧、2.3s≈56 帧）。不要直接把 `秒数 × fps` 喂进去。

## 运行环境速查

**远程（ubuntu，ThinkPad P15，Quadro RTX 5000 16G）**

```bash
ssh ubuntu                                   # route.wbsyb.cloud:12550, user root
cd /sobey/canvas-plus                        # 工程目录（systemd 服务从这里的 canvas-server 启动）
systemctl status canvas-server               # 服务状态
systemctl restart canvas-server              # 重启
tail -50 /var/log/canvas-server.log          # 日志
curl -s http://127.0.0.1:8788/api/health     # 健康检查（llm / comfy / runninghub 三段）
curl -s http://127.0.0.1:8788/api/backends   # 生成后端清单
```

- 网关端口 **8788**；`web/dist` 存在时同一端口也托管画布页面
- 远程配置 `canvas-server/config.json`（**不入库**，rsync 时被排除）：LLM `127.0.0.1:11434`，ComfyUI `192.168.123.147:8188`
- 裸仓库 `/root/repos/canvas-plus.git`；本地分支 `canvas-plus`（产品线独立根提交），上游历史保留在本地 `main`
- 旧的 `/root/canvas-plus` 是上一轮部署位置，已不再被 systemd 使用，可清理

**GPU 主机（OMEN / 5060，RTX 5060 Ti 16GB）**

```bash
ssh 5060                                     # route.wbsyb.cloud:3580, WSL2 mirrored 网络
# ComfyUI 已在跑，Windows 原生实例，监听 0.0.0.0:8188
curl -s http://192.168.123.147:8188/system_stats
```

- ComfyUI 版本 0.33.3；工作流模板库 `/mnt/d/Comfyui-WF-2026.8.8/pipelines/workflows_api/`
- **不要重启用户正在跑的 ComfyUI 实例**；16GB 显存一次只能跑一个任务，网关已做单 worker 串行队列

**本机 Mac（开发机，与内网不通，必须走隧道）**

```bash
ssh -f -N -L 8788:127.0.0.1:8788 ubuntu                      # 访问远程网关 http://127.0.0.1:8788
ssh -f -N -L 11434:127.0.0.1:11434 ubuntu                    # 本地开发用：内网 LLM
ssh -f -N -L 18188:192.168.123.147:8188 5060                 # 本地开发用：ComfyUI
```

- Mac 在 `192.168.2.x/24`，**无法直连** `192.168.123.x/24`，所有实时验证都要走隧道，或带 `CANVAS_SERVER_COMFY_URL=http://127.0.0.1:18188` 跑
- 节点 v26 / npm 11，无 bun；`web/node_modules` 已装（含 linux 可选依赖的锁文件已被远程重建过）

**部署**

```bash
./scripts/sync-remote.sh              # rsync 直接同步 + 构建 + 重启（调试用，可带未提交改动）
./scripts/sync-remote.sh --no-build   # 只改后端时用
./scripts/deploy.sh                   # git 推送裸仓库 → 远程 pull → 构建 → 测试 → 重启（发布用，要求工作区干净）
```

两者都会排除 `node_modules`、`dist`、`data`、`config.json`，不会覆盖远程数据与配置。

## 目录地图

```
canvas-server/            本地网关后端（零依赖 Node ESM）
├── src/index.js          HTTP 入口：路由、后端分派、静态托管
├── src/generate.js       本地 ComfyUI 执行器（模板渲染→提交→轮询→回收产物）
├── src/jobs.js           单 worker 串行队列（含 backend 字段与持久化）
├── src/pipeline.js       五段式编排器
├── src/skills.js         skill 装载与 registry 解析
├── src/providers/        comfy.js / llm.js / runninghub.js
├── workflows/            ComfyUI API 格式模板（11 个，`{{TOKEN}}` 占位）
├── scripts/smoke.mjs     端到端冒烟（打真实 HTTP 接口）
└── test/                 52 项 node:test 用例
skills/                   五段式阶段技能 + libraries/（导入的第三方 skill 库，逐字保留）
web/                      无限画布前端（配置页、流水线页、5 个生图生视频脚本模板）
docs/                     文档站；开发说明在 development/local-gateway，进度在 progress/
deploy/                   systemd 单元
scripts/                  deploy.sh（git 发布）/ sync-remote.sh（rsync 调试）
```

## 交接纪律

- 改 `canvas-server/` 前先读 `canvas-server/README.md` 的冻结契约，接口变了要同步改契约与测试。
- 每次改动后跑 `cd canvas-server && node --test test/*.test.mjs`，**必须全绿**再声明完成。
- 真实生成验证要串行提交，不要并发（16GB 显存）。
- 文档、`CHANGELOG.md` 的 `Unreleased`、`docs/content/docs/progress/` 要随改动更新，规矩见 `AGENTS.md`。
- 不要把没验证的东西写成已验证；报告里区分「实测」与「推断」。

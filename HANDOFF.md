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

**最后更新**：2026-10-02（Qwen 接手 Kimi 被限额中断处；Kimi 原记录保留在下方表格）

**本轮新增（已浏览器实测）**

| 部分 | 状态 | 证据 |
| --- | --- | --- |
| 分镜工作台插件 `plugins/canvas/storyboard-studio` | 完成并实测 | 画布节点「分镜工作台」：连文本节点→生成分镜（本地 qwen3.8:27b 出 6 镜）→卡片编辑/单镜重写/体检/试拍/批量关键帧全链路实测通过 |
| 本地网关一键接入 | 完成并实测 | 设置→本地网关→「一键接入」：探测 8 LLM+3 生图+5 视频模板，幂等建渠道、自动挂调用脚本、自动设默认模型（文本 qwen3.8:27b / 生图 krea2 / 视频 h3_i2v） |
| 插件 LLM/生图通路 | 完成 | SDK `ctx.ai`（generateText/generateImage/listModels）宿主注入，插件零密钥管理 |
| 前端 typecheck | 全绿 | 顺手修了 `model-script-editor.tsx` 的 antd v6 Modal `styles.content` 报错（仓库原有问题） |
| `video_h3_ref2v_image` 模板 + LENGTH 换算修复 | 完成，未真机生成 | 纯参考图变体（摘除节点 17，`length` 由 `{{LENGTH}}` 提供）；前端三处脚本统一「秒数×24 → 17n+5 网格」换算；分镜工作台默认视频模型优先 `video_h3_ref2v_image`；测试 54/54 |

**本轮续做（Qwen 接手 Kimi 被限额中断的部分）**

| 部分 | 状态 | 证据 |
| --- | --- | --- |
| 网关外部 LLM 渠道注册表 | 完成并**线上实测** | `GET/POST /api/llm/providers`（存 `data/llm-providers.json`，GET 脱敏不吐 SK）；模型以「渠道名::模型名」聚合，`chat()` 按前缀路由。线上 `/api/health` 已返回 `deepseek::deepseek-flash`、`deepseek::deepseek-v4-pro` |
| 「01 剧本」超长小说分块改编（map-reduce） | 代码完成 + 单测通过，**未跑整本真机** | `src/chunk-novel.js`（纯函数）+ `pipeline.composeScriptChunked`；阈值 `pipeline.maxNovelChunkChars` 默认 **16000**；产物契约与单次调用同构，分块信息记在 `stage.chunked` |
| 流水线按阶段选模型 | 代码完成，**未浏览器实测** | `runStage(runId, stage, { model, provider })`，`model` 持久化到 `run.options.stageModels`；`provider` 仅本次调用生效、**绝不落盘** |
| 小说/分镜原文文件导入、网关地址自动探测、`/api`+`/v1` 同源反代 | 代码完成，**未浏览器实测** | 前端 `tsc --noEmit` 0 错；验收项见 `pending-test.zh-CN.mdx` |
| `video_h3_talk` 补登记中文标题 | 完成 | 此前 `TITLES` 漏登记，`/api/providers` 把裸模板名当 title 吐给前端；已补「H3 台词对口型」，并加回归测试锁住「每个模板都必须有标题」 |
| 文档口径纠正 | 完成 | Kimi 把 9 条中文验收项写进了**英文版** `pending-test.mdx`、中文版只补了 4 条；已全部归位（中文版 117 条为完整清单，英文版译回英文）。CHANGELOG 与验收项里「默认 6 万字符」改为与代码一致的 **1.6 万字符** |
| 后端测试 | **68/68 全绿** | `cd canvas-server && node --test test/*.test.mjs` |
| `img_qwen21_t2i` + `img_qwen21_edit` 模板 | **完成并真机跑通** | 147 已由用户升级到 ComfyUI **0.38.2**；改走官方 safetensors 路线（GGUF 上游不支持，见坑）。五项实测通过：文生图 `image-muqq7gy8-o41z0`、指令改图 `image-muqqov3y-0fosg`、抠背景透明 `image-muqqyhb0-gb4b9`、透明贴纸直出 `image-muqquoup-elupj`、多图参考合成 `image-muqrx41l-4qxk6`。H3 主力管线在 aimdo 0.5.5 下也复测通过（`video-muqp3s3h-26kei`） |
| `/api/health` 被死渠道挂住 | **已修** | 外部 LLM 渠道探测改用独立 `llm.probeTimeoutMs`（默认 8s，不复用 chat 的 600s）+ 并行探测。修前一个死渠道能挂 20 分钟、前端模型下拉卡死；修后线上实测 **8.07s 返回 200**。见坑末条 |

**已踩过的新坑**

- 文本节点正文是 `metadata.content`，但用户常把文字写在下方提示词面板（`metadata.prompt`）；插件读上游要 `content || prompt`，与宿主 `builtinResource` 口径一致。
- qwen3.8:27b 经 OpenAI 兼容层是「思考型」输出，首 token 要等 1~2 分钟（思考链先跑），插件流式字数统计会有长时间 0 字，属正常。
- **Qwen-Image 2.1 只能走官方 safetensors 路线，GGUF 是死路**（2026-10-02 全程实测）。曾在 v0.33.3 上撞到两个阻塞点：① `TextEncodeQwenImage21` 节点不存在，上游 `img_qwen21_gguf.json` 因此不可用（盘点报告标「未实测」是对的）；② `qwen_image_2.1_vae_bf16.safetensors` 的 `modelspec.architecture` 是 `qwen_image_2.1_vae`，而 v0.33.3 的 `comfy/sd.py` 只有 Wan 2.1/2.2 两个 VAE 分支，看到 `decoder.upsamples.0.upsamples.0.residual.2.weight` 就硬编码走 Wan2.2（`dim=160`/`z_dim=48`），实际是 `dim=96`(enc)/`128`(dec)、`z_dim=64` → `execution_error: size mismatch for WanVAE`（任务 `image-muqhbfkd-a8i9f`）。
  用户把 147 升到 **v0.38.2** 后这两点都解除了（`sd.py:840` 有 Qwen 2.1 VAE 专门分支，节点也齐了，节点类 4364→4485，我们 15 个模板的 67 个 `class_type` 全部仍存在）。**但换出第三个阻塞点，而且升级修不了**：`UnetLoaderGGUF` 报 `ValueError: This model is not currently supported - (Unknown model architecture!)`。根因是 `qwen_image_2.1-Q4_K.gguf` / `-Q8_0.gguf`（各 265 张量）**元数据 KV = 0**，没有 `general.architecture` → `loader.py:95` 走 `arch_str is None` 分支回退 `tools/convert.py::detect_arch()` → 其 `arch_list` 只有 11 个架构（Flux/SD3/Aura/HiDream/CosmosPredict2/LTXV/HyVid/Wan/SDXL/SD1/Lumina2），**一个 qwen 都没有** → `convert.py:169` 的 assert 抛出。即便侥幸 detect 成功，`IMG_ARCH_LIST` 也只有 `qwen_image` 没有 `qwen_image_2.1`，`loader.py:109` 白名单还会再拦一次。**ComfyUI-GGUF 的 master 与本地逐字相同，所以升级该插件同样无用。**（`IMG_ARCH_LIST` 里有 `qwen_image` 说明带正确元数据的 1.0 GGUF 是能加载的，断点是「2.1 架构名 + 零元数据」这个组合。）
  **可行路线**：从 ModelScope 下 `Comfy-Org/Qwen-Image-2.1` 的 `diffusion_models/qwen_image_2.1_int8_convrot.safetensors`（**6.76GB**，HF 在这台机器上不可达），配盘上已有的 `vae/qwen_image_2.1_vae_bf16.safetensors`，CLIP 用已有的 `qwen3vl_8b_fp8_scaled.safetensors`（实测可替代官方的 `qwen3vl_8b_int8_convrot`，省 8.71GB）；`UNETLoader` 无需重启即可看到新文件。接线以 ComfyUI 自带官方模板 `image_qwen_image_2_1_t2i.json` / `_image_edit.json` / `_background_removal.json` 为准（在 `site-packages/comfyui_workflow_templates_json/templates/`）。
  **接线要点**：`TextEncodeQwenImage21.vae` 在编辑路径**必须连**（参考图要 VAE 编码成 latent 拼进序列）；`KSampler.latent_image` 要取该节点的**第 3 个输出（latent）**而不是 `EmptyLatentImage`——官方源码 tooltip 明写 *"any other size shifts the edit"*；`images` 是 `COMFY_AUTOGROW_V3`，**API 格式的键名是字面的 `"images.image_1"`**，`min=0` 所以全部可选；`cfg` 必须为 1，此时 `negative_prompt` 无效；`resolution` 是**总像素预算**不是边长，0 = 不缩放只对齐 32 倍数；`steps` 官方 40-50、模板起步 25；`SaveImage` 就能保留 alpha（产物 PNG colorType=6），不需要官方的 `SaveImageAdvanced`。
  **两个能力边界**：透明直出要把提示词包一层官方话术 `This is an RGBA format image with transparency. … The image has an alpha channel and a transparent background.`（对照组不包则 alpha 全 255）；抠背景那句 `Remove the background, and output a PNG image` **只对主体清晰的图有效**，满幅无明确主体的图（如整版霓虹海报）会失效——实测同一句话在海报上 alpha 全 255、在「纯灰背景正中央一个苹果」上透明 81.4%。
  **注意 2512 ≠ 2.1**：`image_qwen_Image_2512*.json` 用的是 `qwen_image_2512_fp8_e4m3fn` + `qwen_2.5_vl_7b` + **1.0 的 `qwen_image_vae`** + `CLIPTextEncode`/`EmptySD3LatentImage`/`ModelSamplingAuraFlow`，属 1.0 架构的更新版；盘上那个 `Qwen-Image-2512-Lightning-4steps` LoRA **不能用在 2.1 上**。2512 那条线独有 2/4 步加速与 ControlNet Union，值得单独评估。
- **`/api/health` 与 `/api/llm/models` 曾被一个死渠道挂住 20 分钟**：外部 LLM 渠道注册表引入后，`listLlmModels` 会逐个探测渠道，而探测复用了 `chat` 的 `timeoutMs`（默认 **600000**）；`getJson` 失败只返回 `null` 不抛错，所以「TCP 能连上但永不回包」的地址（实测 `https://ai.input.im`）会一直耗到超时，`modelsAt` 又要打 `/v1/models` 与 `/api/tags` 两个端点且串行 → 单个死渠道 20 分钟，前端模型下拉直接卡死。修法是拆出 `llm.probeTimeoutMs`（默认 **8000**）只给列模型探测用，并把渠道探测与两个端点都改成并行。**教训：探活/列资源类接口绝不能复用长任务的超时值，也不能串行探测第三方。** 顺带查出 4 个注册渠道里 3 个是死的（`gpt` 不回包、`kimi` 401、`本地网关` 被边缘 Basic Auth 挡住且是网关自己的公网地址），清掉后 `/api/health` 可从 8s 降到 1s 内。
- **网关日志不在 journal 里**：`canvas-server.service` 设了 `StandardOutput=append:/var/log/canvas-server.log`，`journalctl -u canvas-server` 只有 systemd 自己的启停消息。排查要看 `/var/log/canvas-server.log`。

**此前已完成并验证**

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
13. **H3 宽高必须可被 32 整除**，否则 conditioning 节点直接 `ValueError`。网关已在渲染前自动吸附（720→736），调用方仍应尽量传标准尺寸（480×864、768×1344）。
14. **ComfyUI 会「活着但装死」**：进程在、8188 在 LISTENING、TCP 能握手，但 HTTP 永不响应（本次网关任务挂了 27 分钟才发现）。判活要用 `curl --max-time 8 …/system_stats` 能返回 JSON 才算。恢复姿势：`ssh win147 "schtasks /End /TN ComfyUI_Start"` → `taskkill /PID <pid> /F` → `schtasks /Run /TN ComfyUI_Start`，约 105 秒起完。网关侧任务需取消后重新提交（ComfyUI 重启丢队列）。

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

- ComfyUI 版本 **0.38.2**（2026-10-02 由用户用自有工具从 v0.33.3 升级，commit `daeb5e53`，`deploy_environment: local-git`）；关键依赖 `comfy-aimdo` **0.5.5**、`comfy-kitchen` 0.2.36、`comfyui-frontend-package` 1.53.6、`comfyui-workflow-templates` 0.11.74，pytorch 2.10.0+cu130 未变；节点类 4485 个，自定义节点 94 个全部加载正常（我们 15 个模板的 67 个 `class_type` 全部存在）；H3 主力管线已在 aimdo 0.5.5 下复测通过。工作流模板库 `/mnt/d/Comfyui-WF-2026.8.8/pipelines/workflows_api/`，ComfyUI **官方**模板库 `/mnt/d/Comfyui-WF-2026.8.8/python/Lib/site-packages/comfyui_workflow_templates_json/templates/`（606 个，接新模型前先来这儿找官方接线）
- **不要重启用户正在跑的 ComfyUI 实例**；升级/装插件由用户用自有工具做，Agent 只负责只读探测（`/system_stats`、`/object_info`）与验证。16GB 显存一次只能跑一个任务，网关已做单 worker 串行队列

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
├── workflows/            ComfyUI API 格式模板（12 个，`{{TOKEN}}` 占位）
├── scripts/smoke.mjs     端到端冒烟（打真实 HTTP 接口）
└── test/                 54 项 node:test 用例
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

## 2026-10-02 追加：H3 Ref2VA 加速包（Turbo LoRA + BlockCache）部署实录

**结论（均同机实测，任务 id 可查）**

| 配置 | 任务 | 耗时 | BlockCache 命中 | 质量 |
| --- | --- | --- | --- | --- |
| 基线 `video_h3_ref2v_image`（昨日） | video-mupxl3ut-w2rlr | 580s | — | 正常 |
| 基线（今日复跑，同参数） | video-muq9ng3r-62xb5 | 1078s | — | 正常 |
| turbo（8步 LoRA + cache@0.12 默认） | video-muqabvqm-bueyi | 1359s | **0/8** | 正常 |
| turbo + cache@0.5 | video-muqb7xsd-i4k09 | **673s** | 4/8 | 首帧虚影/拖影，不可接受 |
| turbo + cache@0.3（最终采用） | video-muqbobkp-rkpko | 961s | 3/8 | 与基线目测一致 |

- 今日机器整体退化约 1.86×（基线复跑 580→1078s），原因是 147 物理内存不足（空闲仅 3GB）：ComfyUI 0.33.3 的 aimdo/vbar 动态显存加载把 20GB 权重 staging 到内存，无内存可缓存就不停在 pagefile/磁盘间倒腾，单步全量前向从约 1 分钟膨胀到 2.5 分钟。要恢复昨日速度需先释放 147 的内存（关掉吃内存的桌面应用）或加内存。同环境下对比 turbo@0.3 比基线快约 11%。
- BlockCache（F1B0）在 8 步蒸馏调度下默认阈值 0.12 **命中 0 次**，纯 overhead；阈值 0.3 命中 3/8、0.5 命中 4/8 但出虚影。阈值是质量/速度旋钮，调在模板节点 20 的 `residual_diff_threshold`。
- 命中时一步约 1 秒，全量一步（内存不足时）约 2.5 分钟，加速上限由命中率决定。

**已部署**

- 147 ComfyUI（`D:\Comfyui-WF-2026.8.8\ComfyUI`）：`models/loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_20_bf16.safetensors`（291MB，drbaph 转换版，hf-mirror 下载，SHA256 d9292674…）；`custom_nodes/comfyui-minimax-h3-blockcache-T8` 从旧版更新到 commit `36336dce`（旧版无 .git，直接整目录替换）。
- 网关：新模板 `canvas-server/workflows/video_h3_ref2v_image_turbo.json`（原模板未动；基座 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`、steps 8、shift 12/3、LoRA strength 1.0、BlockCache threshold 0.3 / cache_device gpu），`comfy.js` TITLES 已注册。token 与原模板完全一致，前端可直接按原名换模板名调用。测试 54 项 0 失败。

**新坑**

- aimdo 子系统一旦报 `hostbuf_file_reader_read failed`（内存压力下的读盘失败），同进程内后续任务会「假死」：进程活着、HTTP 能握手、但 CPU/GPU 全 0 不再推进，`/interrupt` 也不响应，只能 schtasks 重启。判断真死锁 vs 慢：取进程 10 秒 CPU delta + nvidia-smi，双 0 即死锁；有活动就耐心等（今天最慢一单 22 分钟也跑完了）。
- 这套 5060 Ti 16GB 跑 H3 时**物理内存比显存更像瓶颈**：内存不足时速度波动可达 2 倍，测加速必须同时间段对比基线，不能拿历史数据比。
- 8 步 turbo LoRA 本身不比基线的 4 步 LoRA@6 steps 快（步数更多），它的价值是 Ref2VA 专用、质量上限更高；要速度靠 BlockCache 阈值。

## 2026-10-02 追加：QuantFunc INT4 W4A4 引擎实测（H3 Ref2VA）

**结论：当前不切换主力管线。** 官方 3.19×/步 的数字在 147（RTX 5060 Ti 16GB + 32GB RAM）完全达不到，瓶颈不在引擎而在内存。

| 配置 | 任务 | 耗时 | 备注 |
| --- | --- | --- | --- |
| int8 基线（今日同机） | video-muq9ng3r-62xb5 | 1078s | 4步LoRA@6步 DualClock |
| QuantFunc pinned=false | 裸测 de357683 | 1959s | 8步 euler/simple，含约 8 分钟首次加载 |
| QuantFunc pinned=true | 裸测 a33075c9 | 1785s | 仅快 9%，且把空闲内存压到 0.2~0.8GB（危险区） |
| QuantFunc 网关端到端 | video-muqf8jgd-z8v1o | 1642s | 含 pinned 开关切换导致的整模型重载；产物 736×736/124帧/h264+aac 验证通过 |

**已部署（147，`D:\Comfyui-WF-2026.8.8\ComfyUI`）**

- `custom_nodes/ComfyUI-QuantFunc`（插件 0.0.07，引擎 0.0.17-sm120a-cu13 自动装到 `bin/windows/`，驱动 610.88 ≥580 满足 CUDA 13 引擎要求）。
- `models/diffusion_models/minimax_h3_ref2va_8steps_quantfunc_int4_r128.safetensors`（12.37GB，魔搭 `QuantFunc/Minimax-H3-Quantfunc-4bit`；同仓库还有 fl2va 4step 版）。
- 网关新模板 `canvas-server/workflows/video_h3_quantfunc_ref2v.json`（token 与基线完全一致：INPUT_IMAGE/PROMPT/WIDTH/HEIGHT/LENGTH/SEED/OUTPUT_PREFIX），comfy.js TITLES 已注册「H3 参考图生视频（QuantFunc INT4）」。测试 54 项全绿。

**实测现象与坑**

- 出片本身正常：736×736、124 帧、5.17s、h264+aac 32kHz 立体声，ffprobe 可解码。
- 采样期 GPU 占用长期 1~3%、偶发 100% 突发：引擎每步从系统内存流式读 int4 权重，而系统内存早已被占满，权重实际从 pagefile 读（Pages Input/sec 峰值 2.1 万，pagefile 用量 35.7GB）。**QuantFunc 的速度前提是权重能驻留内存，32GB 机器跑 H3（CLIP nvfp4 15.7GB + int4 权重 12.4GB + ComfyUI 自身 + 另一套 8190 ComfyUI/工作台）注定换页。**
- `pinned_memory=true`（官方示例默认）会把 ~12GB 权重锁进物理内存，在低内存机器上反而把其他进程全挤进 pagefile，README 自己也警告会导致系统不稳定；147 上慎用。
- 引擎首次加载 int4 权重约 8 分钟（CPU/磁盘 bound），之后改 quality_enhance/cache/LoRA 不重载，换模型文件或 pinned 开关才重载。
- LoRA 组合未测：原生 LoRA 节点只认 diffusers/PEFT 格式，kohya 版 turbo LoRA 需先用插件自带 `scripts/qf_lora_convert.py` 转换；鉴于纯引擎已慢于基线，转换优先级低，未做。
- 复测触发条件：147 内存扩到 64GB+ 或常驻内存大户（8190 ComfyUI 实例、桌面应用）清退后，用同一模板重跑即可，官方数字打对折（≤710s）就算值得切换。

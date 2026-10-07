# 外部方案与短剧 Skill 调研

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 调研目标：判断 MiniMax H3 是否存在可用的长视频续接方案，并寻找能够补强本项目“小说/剧本 → 资产 → 分镜 → 生图 → 生视频 → 音频 → 交付”链路的成熟开源经验。
>
> 本文只记录外部项目的可验证能力和适合本项目的吸收方式。README 中的演示时长、星标和作者自报质量不作为本项目的性能承诺。

## 1. 执行结论

有三类方案值得吸收：

1. **H3 Continuation Provider**：把单个 H3 短片的 latent、音频和尾部上下文传给下一段，解决连续运动与音频接缝问题。
2. **项目级 Agent/生产编排**：让 Agent 使用和网页相同的 Project、Job、Artifact 与队列，不能再只操作浏览器 Canvas。
3. **短剧创作 Skill 与确定性门禁**：把角色、场景、道具、画面文字、镜头切点、对白和提示词适配做成结构化事实，并在生产前预览确认。

这三类能力要组合成一条链：

```text
剧本/分镜事实
  → 角色/场景/道具/声音资产
  → H3 独立短片
  → 可恢复 continuation chain
  → 每段审核、分叉、重试
  → TTS/环境音/配乐/字幕
  → FFmpeg 确定性装配与交付包
```

外部项目不会取代我们的 Project 事实链。它们只能提供 Provider、Skill、节点和交互设计。

## 2. H3 Motion Context 能不能用

### 2.1 它解决的是什么问题

[`ComfyUI-H3-Motion-Context`](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context) 不是把多个 MP4 粗暴拼接，也不是让模型一次生成无限时长。它提供一组 ComfyUI 节点：

```text
上一段 H3 sampler latent
  → Save Latent
  → 下一段 Load Latent
  → Motion Context 注入尾部视频/音频上下文
  → H3 采样下一段
  → Trim 去除隐藏重叠区
  → 再进入拼接
```

它同时传递视频和音频 latent，使下一段可以延续上一段的运动方向、速度、声音时间关系。官方接线说明要求保存/加载 `clip_index`，并强调生成段开头的重复帧和重复音频必须在最终拼接前裁掉。

### 2.2 “无限”的准确含义

它的“无限”是**可以循环追加多个有界片段**，不是一次采样无限长，也不保证无限追加后仍然保持专业质量。链越长，潜变量存储越大，语义和画面细节仍可能漂移；自然转场、剧情转折、音乐换段也不适合强行沿用同一条链。

产品文案应使用：

> 可恢复的多段 H3 连续生成 / continuation chain

不要使用：

> 无限无损生成一整集

### 2.3 与官方 Add Guide 的区别

ComfyUI 官方 MiniMax H3 文档已经支持 T2V、I2V、R2V、首尾帧和任意时间点的 `MiniMaxH3AddGuide`。但官方明确说明 Add Guide 是 conditioning reference，采样仍从空 latent 开始，它不是完整的 video-to-video continuation。[官方 H3 工作流说明](https://github.com/Comfy-Org/docs/blob/main/tutorials/video/minimax/minimax-h3-native.mdx)

因此本项目需要区分：

| 能力 | 用途 | 是否是真正链式续接 |
| --- | --- | --- |
| 首尾帧 I2V | 镜头之间构图交接、重新开镜 | 否 |
| Add Guide | 在任意时间点锚定图片/视频/音频 | 否，仍是新采样 |
| H3 Motion Context | 延续视频与音频 latent | 是，适合同一连续动作 |
| FFmpeg 拼接 | 确定性装配和交付 | 否，不能改善模型接缝 |

### 2.4 重要限制

- H3 的有效时间轴遵循 `17k+5` 帧网格，当前官方工作流以 24fps 为基础。
- 一条 continuation chain 必须锁定分辨率、模型族、音频采样率和关键采样配置。
- H3 原生音频是 32kHz 立体声，不能在链中假设 48kHz；后期混音时再统一输出格式。
- Turbo LoRA、频谱增强等加速/增强路径可能损伤音频连续性，必须单独对照验证。
- 画面和音频会随链深累积误差；自然音乐、对白、场景切换处需要允许“重新开链”。
- H3 节点是 GPL-3.0；H3 模型还有独立的 MiniMax 社区许可，模型许可和节点许可是两层问题。面向海外商业发行前必须核查地区和商业用途授权。[MiniMax H3 模型卡](https://huggingface.co/MiniMaxAI/MiniMax-H3)

## 3. H3 续接候选的采用顺序

在安装任何第三方包之前，先对当前 ComfyUI 做能力探测：是否支持 H3 的原生 per-token video/audio noise mask（对应 [ComfyUI PR #15375](https://github.com/Comfy-Org/ComfyUI/pull/15375)）。如果支持，优先验证原生 Masked AV；如果不支持，再走 latent-tail 或 Motion Context 兼容路径。

近期还出现了两个值得关注、但必须先做独立验证的方案：

- [`Herrgotts-H3-Infinite-Continuation-Suite`](https://github.com/HerrgottMargott/Herrgotts-H3-Infinite-Continuation-Suite)：基于原生 Masked AV，分别保护视频和音频前缀，并提供冻结/不稳定落点检测。
- [`ComfyUI-MiniMaxH3-PrefixStream`](https://github.com/knoic/ComfyUI-MiniMaxH3-PrefixStream)：把 continuation context、Clip Bin、评分、父子 lineage、历史镜头选择和磁盘流式输出结合起来，概念上最贴近我们的 Canvas + Project Artifact 图谱。

这两个项目目前只能进入“候选实验区”，不能因为 README 的“infinite”命名直接进入默认生产。需要先核对实际 ComfyUI commit、模型版本、许可证、显存和完整 GPU 运行证据。

### P0：先探测原生 Masked AV，再验证 latent-tail Continuation

[`ComfyUI-Minimax-H3-Continuation`](https://github.com/ttulttul/ComfyUI-Minimax-H3-Continuation) 使用滚动重叠窗口：上一段的同步视频/音频尾部作为下一段起始 guide，采样完成后丢弃隐藏重叠，只把新后缀追加到累计 latent。它是 MIT，依赖少，不 patch ComfyUI，并且给出了 `overlap_frames`、`extension_frames` 和音频 40Hz 时间轴的明确约束。

如果本机的 ComfyUI 已支持原生 Masked AV，先把 Herrgotts 或 PrefixStream 作为实验候选；如果不支持，则使用它作为首个 POC。它的限制是只接受原生 H3 joint AV latent，累计 latent 会增长，也不能保证语义转场自然。

### P1：Motion Context 对照

NikoDemon80 的 Motion Context 更适合验证“latent context 与接缝检测”的效果。它内置 `Seam Probe`、音量/底噪阶跃检查和画面冻结检测，这些检测能力可以吸收到我们的质量门禁，但 GPL 节点代码不应复制进本项目。

### P1：Context Loop 生产交互参考

[`ComfyUI-MiniMaxH3-Context-Loop`](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop) 在 Motion Context 基础上展示了更接近生产的 Plan、Review Gate、Retry、Reroll、Checkpoint、Branch 和 Assemble 概念。最值得吸收的是：

- 每个场景先 checkpoint，再进入审核门禁。
- 后续续接必须从已批准的候选开始。
- 重试和换候选不能覆盖历史产物。
- 音频策略区分最终音频、源音频、模型生成连续音频、口型驱动 stem。

这些概念应映射到我们的 `WorkflowRun / Job / Artifact / Candidate / AssetRef`，不能把它自己的文件状态系统直接当成 Project 数据库。

### 3.1 不建议同时安装多个 H3 Chain 包

多个 Motion Context fork 可能重复 patch H3 的内部布局或注册同名节点。POC 时每个环境只保留一个续接包，并固定 ComfyUI commit、custom node 版本和工作流 JSON。不能把 Niko、MultiRef、Timeline、Context Loop 同时装进同一生产环境。

### 3.2 官方 H3 Skill

MiniMax 官方 H3 仓库还提供 [`h3-prompt-writing` skill](https://github.com/MiniMax-AI/MiniMax-H3)，可作为 H3 base/ref 两类提示词结构的内部参考。它应该进入我们的 `h3-prompt-writing` 编译规则和验证清单，不能变成用户需要填写的“高级提示词表单”。

## 4. 本项目的 H3 Provider 设计

续接不是一个普通 `video_h3_i2v` Job，而是一个由多个 Job 组成的链：

```js
const continuation = {
  continuationChainId: "cc_…",
  segmentIndex: 0,
  parentArtifactId: null,
  contextArtifactId: null,
  latentArtifactId: null,
  overlapFrames: 22,
  extensionFrames: 119,
  resolution: "736x576",
  fps: 24,
  audioSampleRate: 32000,
  audioPolicy: {
    finalAudio: "external_tts_mix",
    generatedContinuity: false,
    lockSourceAudio: false,
    lipSyncStem: null
  }
};
```

每个 segment 都独立登记：

- `Job`：本次采样、重试和设备信息。
- `Artifact`：未裁切的 H3 视频/音频、裁切后的片段、可选 latent checkpoint。
- `Candidate`：候选和 QC 结果。
- `parentArtifactId`：续接来源。
- `continuationChainId + segmentIndex`：链顺序。
- `overlapFrames/extensionFrames/resolution/audioSampleRate`：续接事实。

首段没有 context；后续优先使用 latent continuation；失败时可以降级为上一段尾帧 + 独立音频，并写入 warning。Agent 和页面看到的是链状态与候选，不直接看到 ComfyUI 节点图。

### 4.1 续接质量门禁

首次不要拍脑袋设“通过阈值”，先做测量矩阵。至少记录：

| 指标 | 目的 |
| --- | --- |
| seam audio correlation / lag | 判断音频是否连续或只是相似 |
| RMS / room-tone step | 检查接缝处音量和底噪突变 |
| freeze detection | 检查重叠区是否画面冻结 |
| 光流方向/速度差 | 检查运动是否重启或跳变 |
| 黑帧/闪烁/重复帧 | 检查 trim 和拼接边界 |
| 链深后的高频衰减 | 判断是否需要重新开链 |
| 峰值显存与单段耗时 | 验证 16GB GPU 是否能稳定运行 |

POC 方案：同一角色、同一场景、固定 seed 和分辨率，生成 2、4、8、10 段，每段 5～10 秒；对比普通尾帧 I2V、Motion Context 和原生 latent-tail Continuation。每段都保留未裁切音频、latent、日志和 QC 结果。

### 4.2 16GB 硬件策略

本项目 16GB GPU 首轮只验证：640/736 短边、5～10 秒片段、单 GPU 串行、固定分辨率。官方模板使用 int8 H3 diffusion、量化文本编码器、int8 视频 VAE 和 fp32 音频 VAE；社区结果不能替代本机测量。任何 H3 chain 工作流进入正式注册表前，必须先完成本机兼容性探测。

## 5. 值得借鉴的项目级生产系统

| 项目 | 可借鉴内容 | 对本项目的处理 |
| --- | --- | --- |
| [Calliope](https://github.com/benjiyaya/Calliope) | 本地优先、Agent 与网页共用数据库和渲染队列；项目绑定会话；Agent 可创建项目、写脚本、排队渲染、等待 Job | 借鉴“同一事实链”，不让 Agent 绕过 Project API |
| [StoryBored](https://github.com/storybored-app/storybored) | Project → Scene → Shot；每镜多个 take；approved still → I2V；animatic 预览 | 借鉴 Shot/Take/Approve/Animatic 交互，采用前先复核许可证 |
| [OpenVideoStudio](https://github.com/mne03005-png/OpenVideoStudio) | 阶段 checkpoint、人工 review、provider registry、提示词/模型/seed provenance、FFmpeg 交付 | 借鉴断点和证据链，不替换我们的 H3/Qwen 路线 |
| [Velorn](https://github.com/VelornLabs/velorn) | 项目时间线、Agent 工具分类、previewOnly、undo、资产与时间线边界 | 只借鉴工具协议和审批思想，GPL 代码不直接嵌入 |
| [Kitsu](https://github.com/cgwire/kitsu) | Character/Environment/FX/Props 资产类型、镜头任务状态、交付状态 | 借鉴资产与任务数据模型，不引入完整 VFX 管理系统 |

最值得吸收的共同原则是：**Agent、网页和批处理必须读写同一项目数据库与队列**。Agent 只负责提出计划、调用工具、等待结果和汇报事实，不能有自己的第二套生产状态。

## 6. 值得吸收的短剧创作 Skill

### 6.1 Drama Skills

[`zenstory-ai/drama-skills`](https://github.com/zenstory-ai/drama-skills) 是 MIT 许可的 11 个 Agent Skill，覆盖原著分析、分集剧本、视觉设计、资产、分镜、图片/视频提示词、确认生产、剪辑和审查。它最适合吸收的不是外部 API，而是事实层和门禁：

- 每集保存剧本、视觉设定、分镜、图片提示词、视频提示词和剪辑单。
- 连续性锁以固定短语回链到每个镜头。
- 每个生成任务先预览，再经过明确确认才真正消耗资源。
- 台词字幕从剧本逐字生成，剪辑单记录每个入点/出点的理由。

我们的实现应把这些文件事实映射为 `Project / Episode / Shot / AssetRef / Artifact / ReviewReport / DeliveryManifest`，而不是再建立一套 Markdown 数据库。

### 6.2 shuohao-skills

[`eternityspring/shuohao-skills`](https://github.com/eternityspring/shuohao-skills) 更接近本项目的中文短剧场景，包含 outline、characters、art、script、storyboard 五类 Skill，并提供确定性质量门。尤其值得借鉴：

- 角色以正面锚点派生侧面、背面、特写和细节图。
- 场景与叙事道具具有连续性锚点。
- 道具/场景可以生成白底、无人、无手的素材板，是否透明由资产用途决定。
- 分段、镜头、关键帧和 H3 切点逐项对账。
- 自带 self-test 和质量报告。

它的“段 ≤15 秒、镜头 2～5 秒”不能硬编码进本项目，应改为读取 H3 Provider 的能力配置。

### 6.3 director-skills

[`0xhughs/director-skills`](https://github.com/0xhughs/director-skills) 最契合本项目的统一提示词管线。它把提示词分成三层：

```text
Creative Intent      故事、角色、情绪、事实
  → Cinematic Execution 景别、机位、灯光、动作、声音
  → Model Adaptation    模型语法、参考槽、时长、参数、失败模式
```

这正好证明我们的“统一提示词生成管线”方向是正确的。第三层必须继续作为后端内部 compiler，前端和用户只看到剧情与分镜内容。

### 6.4 Story-Film Skills

[`badgids/Story-Film-Skills`](https://github.com/badgids/story-film-skills) 的价值在工程纪律：稳定的 `SCN / LINE / SHOT / TAKE` ID、持久文件、确定性校验器、可恢复工作流、音频 SHA-256 校验、尾帧交接和 Comfy 工作流验证。它可以补强我们目前的：

- 台词到 TTS 到字幕的逐句追踪。
- Shot/Take/Artifact 的稳定引用。
- continuation chain 的父子产物和恢复点。
- 工作流 JSON 的输入槽位和节点能力校验。

## 7. 本项目最终采用清单

### 立即进入 POC

1. 官方 H3 I2V/R2V 工作流作为基线。
2. MIT `ComfyUI-Minimax-H3-Continuation` 作为首个续接实现。
3. Niko Motion Context 作为接缝和音频连续性对照。
4. 2/4/8/10 段、固定分辨率、16GB GPU 的真实测量。
5. 失败、重试、分叉、重开链都登记为 Project Job/Artifact，不覆盖历史。

### 进入产品架构

1. 增加 `continuationChainId`、`segmentIndex`、`parentArtifactId`、`contextArtifactId`、`latentArtifactId` 和接缝指标。
2. H3 chain 封装成 Provider/Tool，不把 custom node 代码复制进 `canvas-plus`。
3. Agent 增加项目级 chain 状态、候选选择、重试、暂停和导出工具。
4. 采用 `Shot → Take → Candidate → Approve → Animatic` 的可视化结构。
5. 将 Drama Skills、shuohao-skills、director-skills 的字段和门禁映射到现有 Project 契约。

### 明确暂不做

- 不把“无限续接”当作整集单 Job。
- 不把 H3 原生音频重新设为默认最终对白源；Qwen3-TTS + CPU/FFmpeg 仍是默认声音链。
- 不同时引入多个 H3 continuation custom node 包。
- 不把 GPL 节点源代码复制到本项目。
- 不因为外部 Skill 的内容规范而改写用户原著；风险只作为独立报告。
- 不把 Wan、Hunyuan、Seedance、Kling 加入当前主流程；Wan FLF2V 只作为首尾帧转场 baseline。

## 8. 许可证与采用纪律

| 外部内容 | 当前记录 | 采用方式 |
| --- | --- | --- |
| H3 Motion Context | GPL-3.0 | 作为独立 ComfyUI 外置实验依赖，不复制源码 |
| H3 Continuation | MIT | 可独立安装验证；正式集成前保留 NOTICE 和版本锁 |
| Drama Skills | MIT | 可吸收 Skill/模板，保留版权声明并做本项目规则适配 |
| shuohao-skills | Apache-2.0 | 可吸收字段、门禁和测试思路，保留 NOTICE |
| director-skills | MIT | 可吸收三层提示词适配方法 |
| Story-Film Skills | Apache-2.0 | 可吸收稳定 ID 和确定性校验方法 |
| GPL 项目（Velorn、部分 H3 fork） | GPL | 只参考交互和协议，不直接嵌入运行时代码 |
| MiniMax H3 模型 | 独立社区许可 | 海外商业发行前做地区与商业用途核查 |

正式登记模型或 Provider 前，必须同时记录代码许可证、模型许可证、版本/revision、来源 URL、SHA256 和本机验证状态。

## 9. Huobao Drama：真正的优势与边界

### 9.1 它确实做了什么

[`chatfire-AI/huobao-drama`](https://github.com/chatfire-AI/huobao-drama) 不是只展示概念的 README 项目。公开仓库已经包含 Nuxt 3 前端、Hono + Drizzle 后端、SQLite/WAL、Electron 桌面版、FFmpeg 资源和 Mastra Agent。当前 README 列出的四个 Agent 是 `script_rewriter`、`extractor`、`storyboard_breaker` 和 `prompt_generator`；生产入口把剧本、角色/场景/道具、分镜、生图、生视频、批量重试、FFmpeg 合成和导出放在一条页面动线上。[项目 README](https://github.com/chatfire-AI/huobao-drama/blob/master/README.md)

它最有价值的部分是产品工程：

| 能力 | 公开实现迹象 | 对本项目的意义 |
| --- | --- | --- |
| 单任务生命周期 | `generation.ts` 用统一 `sys_task` 记录图片/视频创建、轮询、下载、完成和失败 | 可作为我们 Job 状态与日志设计的对照，但我们仍需保留 Artifact/Candidate 投影 |
| 资产提取与引用 | 角色、场景、道具从剧本抽取，分镜使用 `@character` 参考图 | 证明“资产先抽取、镜头再引用”是低门槛用户体验 |
| 批量生产与重试 | 视频任务按分镜批量生成，失败任务可单独重试 | 可借鉴到我们的 Shot 批量操作与 Agent 工具 |
| 可编辑 Skill | Agent Skill 放在 workspace，可在设置页编辑 | 适合我们做内部创作规则和模型适配规则的版本化入口 |
| 桌面交付 | Electron 单实例、userData 隔离、内置 FFmpeg、SQLite | 以后做本地一键安装时很有参考价值 |
| 多供应商适配 | OpenAI/Gemini/Volcengine 图片，Seedance/MiniMax/Wan 视频 | 可借鉴 Provider registry，但不应照搬其云端依赖 |

### 9.2 它没有解决什么

从公开架构和数据库字段看，它的核心是“分镜记录 + 直接媒体 URL/路径 + `sys_task`”，例如 storyboard 表直接保存 `firstFrameImage`、`lastFrameImage`、`videoUrl`、`composedVideoUrl` 等字段。[schema.ts 的 storyboard 字段](https://github.com/chatfire-AI/huobao-drama/blob/master/backend/src/db/schema.ts)

这和我们计划的 `Job → Artifact → Candidate → AssetRef → Deliverable` 图谱不同。它没有公开证据表明自己解决了以下难题：

- H3 latent continuation、跨段音频/运动连续和长链质量衰减。
- 画布与 Project 事实链的双向绑定。
- 同一镜头多候选、采用指针、旧结果只读和从任意候选分叉续接。
- 统一后端提示词编译管线及模型能力校验。
- 角色声音、TTS、独立对白轨、M&E 轨和逐句字幕的可追溯事实链。

这不是说它不能生成视频，而是它的强项是“把常见能力放到一起”，不是解决我们最核心的连续性和可审计生产问题。

### 9.3 最重要的许可证限制

仓库许可证是 **CC BY-NC-SA 4.0**，明确禁止商业使用；README 同时写明模型能力需要配置 Huobao API Key，图片/视频主要走 OpenAI、Gemini、Volcengine、MiniMax、Wan 等服务。[许可证与 README](https://github.com/chatfire-AI/huobao-drama/blob/master/LICENSE)

因此：

- 不能把它的代码、Agent、页面或数据库实现复制进面向海外商业发行的产品。
- 可以运行它的公开版本，观察交互和数据流；可以借鉴一般性产品思想，但不能复制受保护的实现细节。
- 如果未来需要吸收具体代码，必须先取得作者书面商业授权，并单独做第三方依赖清单。

### 9.4 公开 Issue 也暴露了它的未完成面

仓库公开 Issue 中仍有“生成视频时如何保持声音一致性”“断线中止与重启后继续制作”“Codex 闭环”等问题。这些恰好对应我们正在设计的声音事实链、可恢复 Job 和 Project Agent 作用域。[Issue 列表](https://github.com/chatfire-AI/huobao-drama/issues)

因此不能把“有桌面版、星标多、能一键生成”当成已经解决生产稳定性；它仍然把部分复杂问题留给后续版本。

### 9.5 对本项目的最终判断

| 判断 | 结论 |
| --- | --- |
| 是否值得研究 | 值得，尤其是产品流程、批量确认、任务抽屉、桌面打包、Skill 编辑 |
| 是否替换我们的 Project/Canvas 架构 | 不替换；我们的服务端事实链和 Canvas Agent 方向更适合可追溯生产 |
| 是否直接接入它的代码 | 不建议，CC BY-NC-SA 不符合商业产品边界 |
| 是否使用它的模型路线 | 不作为主线；它偏云端多供应商，我们当前锁定本地 Qwen Image + H3 + Qwen3-TTS |
| 是否能解决 H3 无限续接 | 没有公开证据；继续按独立 H3 continuation Provider 验证 |

它最值得我们抄的不是“一个按钮生成整集”，而是把复杂生产能力压缩成三步用户动作：**确认角色与风格 → 批量生成并重试坏镜头 → 合成和导出**。底层仍必须由我们的 Project、Job、Artifact 和门禁负责。

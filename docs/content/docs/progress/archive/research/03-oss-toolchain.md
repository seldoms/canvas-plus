# 可融合开源工具链调研（成片装配 / 字幕 / TTS / 数字人 / 音效 / 编排 / 短剧垂直）

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../../development-plan.md`、`../../project-centric-skeleton.md`、`../../domain-contract.md`；本区说明见 `../README.md`。


> 调研日期：**2026-10-03**（星数、最近提交、许可证均为当日从 GitHub 一手抓取）
> 调研范围：**只收自托管 / 命令行 / API 可编程调用**；纯 SaaS（DramaReel、Topview、Fliki 等）全部排除。
> 定位前提：全本地化 AI 短剧平台 `/sobey/canvas-plus`（Node 网关 + React18 + 本地 ComfyUI + Ollama），已有五阶段流水线、角色一致性锁、画上文字逐字指定、Qwen3-TTS 固定音色、`delivery.js`（ffmpeg 拼接/字幕烧录/封面）。
> 本轮**只调研、不改仓库**。LocalMiniDrama / OpenCut 由专人负责，本轮不重复。

---

## 0. 总表（环节 → 推荐 → 替代掉我们什么 → 许可证 → 融合成本）

| 环节 | 推荐工具 | 替代掉我们的什么 | 许可证（可商用?） | 融合成本 |
|---|---|---|---|---|
| 成片装配 / 粗剪 | **auto-editor** + **Motion Canvas**（片头动效） | 自研去停顿、自研 canvas 动效/片头 | Unlicense / MIT ✅ | 低–中（1–5 人日） |
| 中文字幕 ASR | **FunASR**（主）+ **WhisperX**（备） | 自研 ASR / 旧字幕手工对齐 | MIT / BSD-2 ✅ | 低（HTTP 包装） |
| TTS / 声音克隆 | **CosyVoice2** 或 **GPT-SoVITS** | 现有 Qwen3-TTS 固定音色 → 升级为情感+角色音色库 | Apache-2.0 / MIT ✅ | 低 |
| 数字人 / 换口型 | **MuseTalk**（轻）/ **LatentSync**（质量） | 从零做口播（我们目前完全没有） | MIT / Apache-2.0 ✅ | 中 |
| 音效 / BGM | **ACE-Step**（BGM） + **Stable Audio Open**（音效） | 手工找 BGM / 外包音效 | Apache-2.0 / Stability 社区许可 ✅ | 低–中 |
| 工作流编排 | **ComfyUI workflow JSON + 自研 Node 网关**（参考 Langflow） | 不要在网页里重造编排 | GPL-3.0（自用无碍）/ MIT | 低（沿用现有） |
| 短剧垂直参考 | **NarratoAI**（管线） + **SkyReels-V1**（专用模型） | 借鉴「解说文案→自动成片」整条粗剪链路 | MIT / Skywork 社区许可 ✅ | 借鉴低、试挂中 |

**一句话结论**：能外挂的全外挂 —— 粗剪交给 `auto-editor`、字幕交给 `FunASR`、配音换成 `CosyVoice/GPT-SoVITS`、口播交给 `MuseTalk/LatentSync`、BGM 交给 `ACE-Step`；编排继续用「ComfyUI workflow + 自研网关」这条已经验证过的路，**不要把编排搬进网页**。许可证红线只有四个：**IndexTTS / Fish-Speech / ChatTTS / MusicGen 权重**。

---

## 1. 成片装配与粗剪（含片头 / 文字动效）

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 16G 可行 | 能替代我们什么 |
|---|---|---|---|---|---|---|
| [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) | 5,410 | 2026-10-03 | **Unlicense** ✅ 全自由 | CLI（ffmpeg 后端） | N/A（CPU） | 自动去停顿/静音剪、按音量切分 —— 正是我们的粗剪缺口 |
| [AcademySoftwareFoundation/OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | 2,003 | 2026-10-01 | **Apache-2.0** ✅ | Python 库/CLI | N/A | 剪辑决策中间格式（OTIO），导出 FCPXML/EDL 对接 Premiere/达芬奇 |
| [Zulko/moviepy](https://github.com/Zulko/moviepy) | 14,944 | 2026-08-26 | **MIT** ✅ | Python 库 | N/A | 程序化拼接/转场/文字合成 —— 比裸 ffmpeg 命令更好维护 |
| [kkroening/ffmpeg-python](https://github.com/kkroening/ffmpeg-python) | 11,011 | 2022-07-11 ⚠️停滞 | **Apache-2.0** ✅ | Python 库 | N/A | ffmpeg 的 Python 封装（但已 4 年不更新，慎选） |
| [remotion-dev/remotion](https://github.com/remotion-dev/remotion) | 61,622 | 2026-10-03 | ⚠️ **Remotion License**（≤3 人免费，团队需付费） | React + Node 渲染 | N/A（CPU/GPU 均可） | **片头/文字动效**（React 描述视频，正合我们前端栈） |
| [motion-canvas/motion-canvas](https://github.com/motion-canvas/motion-canvas) | 19,227 | 2026-07-02 | **MIT** ✅ | TS/浏览器渲染 | N/A | 程序化动效（MIT 版 Remotion，商用零风险） |

**建议用哪个 + 为什么 + 融合成本**
- **粗剪**用 `auto-editor`：一条命令 `auto-editor in.mp4 --margin 0.2s` 就能去掉所有停顿/静音，正好补上我们「自动粗剪」缺口；unlicense 无任何商业顾虑；在我们的 Node 网关里 spawn 调用即可，**成本 ≈ 1 人日**。
- **片头/文字动效**优先 `Motion Canvas`（MIT，商用零风险）；我们前端已是 React18，若团队 ≥4 人想用 Remotion 的 React 语法，必须先买 Remotion 商业授权，**成本中（3–5 人日）**。
- `OpenTimelineIO` 只在「要导出 EDL/FCPXML 交给人工精剪师用 Premiere/达芬奇」时才值得引入，否则不必，**成本中**。

---

## 2. 字幕（ASR 出字幕 + 样式化）

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 16G 可行 | 能替代我们什么 |
|---|---|---|---|---|---|---|
| [modelscope/FunASR](https://github.com/modelscope/FunASR) | 20,572 | 2026-10-02 | **MIT** ✅ | Python 服务 / HTTP API | ✅ 极轻（1–4G） | **中文最强**：Paraformer 字级时间戳、标点、说话人分离、热词 |
| [m-bain/whisperX](https://github.com/m-bain/whisperX) | 24,341 | 2026-09-26 | **BSD-2-Clause** ✅ | Python CLI/库 | ✅（2–6G） | 词级时间戳 + 说话人分离（pyannote），多语稳 |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 25,680 | 2026-10-01 | **MIT** ✅ | Python/CTranslate2 | ✅ 极轻 | 轻量 CPU/GPU 推理，做兜底/批量转写 |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 54,104 | 2026-10-02 | **MIT** ✅ | C/C++ CLI（零 Python 依赖） | ✅ 可纯 CPU | 与我们「Node 零依赖网关」气质最搭的本地 ASR |
| [openai/whisper](https://github.com/openai/whisper) | 109,896 | 2026-08-31 | **MIT** ✅ | Python 参考实现 | ✅ | 基线参考（重、慢，实际用 faster-whisper 替代） |
| [modelscope/FunClip](https://github.com/modelscope/FunClip) | 6,359 | 2026-09-16 | **MIT** ✅ | Gradio + 库 | ✅ | **按识别文本自动剪辑**（选文本→出片），字幕+剪辑一体的参考 |
| [WEIFENG2333/VideoCaptioner](https://github.com/WEIFENG2333/VideoCaptioner) | 16,146 | 2026-05-24 | ⚠️ **GPL-3.0** | 桌面/CLI | ✅ | 字幕翻译+美化+烧录工作流（可参考，GPL 传染性需注意） |

**字幕样式**：不用找新项目 —— 用 **ffmpeg + `libass` 加载 `.ass` 模板**即可。我们 `delivery.js` 现在烧的是普通字幕，升级成「ASS 样式模板库（角色色、位置、描边）」是**纯配置工作，成本 ≈ 0.5 人日**。

**建议用哪个 + 为什么 + 融合成本**
- **FunASR 为主**（中文识别+字级时间戳+说话人分离，MIT，正是中文短剧要的）；**WhisperX 做多语/时间戳兜底**。两者都封装成网关后的 HTTP 服务，**成本低（≈2 人日封装）**。
- 字幕样式**不再自研**，直接上 ASS 模板 + libass，**成本 0.5 人日**。

---

## 3. TTS / 声音克隆（中文优先、可本地、**商用许可为重点**）

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 16G 可行 | 音色一致性 / 情感 | 替代我们什么 |
|---|---|---|---|---|---|---|---|
| [FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice) | 23,822 | 2026-05-25 | **Apache-2.0** ✅ | Python / HTTP | ✅（3–6G） | 零样本克隆强 + **指令化情感/方言** | 升级 Qwen3-TTS 为「角色音色库+情感」 |
| [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 62,271 | 2026-08-18 | **MIT** ✅ | Python / WebUI | ✅（<4G） | **少样本克隆音色一致性最好** | 同上的克隆首选 |
| [index-tts/index-tts](https://github.com/index-tts/index-tts) | 24,265 | 2026-09-29 | ❌ **bilibili 自定义模型许可**（商用受限、需授权） | Python | ✅（4–8G） | 情感控制好、效果强 | 效果好但**许可有红线，商用需谈** |
| [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) | 15,326 | 2026-09-21 | **MIT** ✅ | Python | ✅（≈4G） | 克隆自然、训练可控 | 克隆备选 |
| [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) | 32,924 | 2026-09-16 | ❌ **Fish Audio 研究许可**（商用需单独授权） | Python | ✅（≈4G） | 音质高、多语 | 慎用（商用要付费授权） |
| [SparkAudio/Spark-TTS](https://github.com/SparkAudio/Spark-TTS) | 10,995 | 2025-04-09 ⚠️ | **Apache-2.0** ✅ | Python | ✅（≈4G） | 轻量、可控发声 | 备选 |
| [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) | 54,606 | 2026-09-03 | **MIT**（代码）✅ | Python | ⚠️（8–16G） | 长对话/多说话人，较重 | 长篇多人对话试挂 |
| [2noise/ChatTTS](https://github.com/2noise/ChatTTS) | 39,890 | 2026-04-10 | ⚠️ **AGPL-3.0** | Python | ✅ | 对话口语强，但 AGPL 传染 | 慎用（AGPL 不适合闭源产品） |

**建议用哪个 + 为什么 + 融合成本**
- **主推 CosyVoice2**（Apache-2.0，商用零风险，中文+零样本克隆+**情感/方言指令控制**）或 **GPT-SoVITS**（MIT，少样本克隆的音色一致性业界最强，适合固定角色）。
- **直接替换掉我们现有的 Qwen3-TTS 固定音色链路** → 建「角色音色库（每人一个参考音频）+ 逐句情感标记」即可，模型全在 16G 内，**融合成本低（封装 HTTP ≈2 人日 + 音色库整理）**。
- **红线提醒**：IndexTTS（bilibili 许可）、Fish-Speech（需商业授权）、ChatTTS（AGPL）——效果好但**要么付费授权、要么传染闭源**，产品化先避开。

---

## 4. 数字人 / 口播（换口型）

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 16G 可行 | 口型/画质 | 替代我们什么 |
|---|---|---|---|---|---|---|---|
| [TMElyralab/MuseTalk](https://github.com/TMElyralab/MuseTalk) | 6,653 | 2025-09-26 | **MIT** ✅ | Python / ComfyUI 节点 | ✅（8–12G） | 实时级、轻、稳定性好 | **口播（我们目前完全没有的能力）** |
| [bytedance/LatentSync](https://github.com/bytedance/LatentSync) | 6,105 | 2025-06-20 | **Apache-2.0** ✅ | Python / ComfyUI | ⚠️ 512 分辨率 ~12–16G，贴边可跑 | **口型质量领先**（latent diffusion） | 高质量口播 |
| [OpenTalker/SadTalker](https://github.com/OpenTalker/SadTalker) | 14,112 | 2023-10-10 ⚠️ | **Apache-2.0**（除三方组件）✅ | Python | ✅（≈8G） | 头部+表情，**已停更** | 备选/老方案 |
| [antgroup/echomimic](https://github.com/antgroup/echomimic) | 4,307 | 2026-04-07 | **Apache-2.0** ✅ | Python | ⚠️（10–16G） | 半身+手势，效果好 | 半身口播（比纯换口型更强） |
| [fudan-generative-vision/hallo](https://github.com/fudan-generative-vision/hallo) | 8,666 | 2024-09-14 ⚠️ | **MIT** ✅ | Python | ⚠️（12–16G，贴边） | 音频驱动人像，较慢 | 备选 |
| [Rudrabha/Wav2Lip](https://github.com/Rudrabha/Wav2Lip) | 13,226 | 2025-06-22 | ❌ **无 LICENSE，README 声明仅研究/学术** | Python | ✅（≈4G） | 老牌口型（质量已落后） | **红线：不可商用，排除** |
| [OpenTalker/video-retalking](https://github.com/OpenTalker/video-retalking) | 7,293 | 2023-11-04 ⚠️ | **Apache-2.0** ✅ | Python | ✅（≈8G） | 改口型+修脸（停更） | 备选 |

**建议用哪个 + 为什么 + 融合成本**
- **轻量商业化选 MuseTalk**（MIT，8–12G，可做成 ComfyUI 节点，速度和稳定性最均衡）；**要最好口型质量选 LatentSync**（Apache-2.0，16G 贴边跑 512）。
- 若要「半身+手势」的更强口播，试 **EchoMimic**（Apache-2.0）。
- **Wav2Lip 直接排除**（无许可证 + 仅学术声明）。融合方式：把模型封装成网关后的独立 API/ComfyUI 自定义节点，**成本中（环境隔离 + 异步任务 ≈5 人日）**。

---

## 5. 音效 / BGM

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 16G 可行 | 能替代我们什么 |
|---|---|---|---|---|---|---|
| [ace-step/ACE-Step](https://github.com/ace-step/ACE-Step) | 4,875 | 2026-02-15 | **Apache-2.0** ✅（含权重） | Python / ComfyUI | ✅（8–12G） | **BGM 首选**：快、可控、商用无忧 |
| [Stability-AI/stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) | 3,872 | 2026-05-26 | ⚠️ 代码 MIT / **权重 Stability 社区许可**（年营收 <100 万美元免费商用） | Python / ComfyUI | ✅（≈8G） | 音效/短 BGM 生成 |
| [multimodal-art-projection/YuE](https://github.com/multimodal-art-projection/YuE) | 10,743 | 2026-10-02 | **Apache-2.0** ✅ | Python | ⚠️（12–16G，贴边） | 带唱的歌曲生成（主题曲/片尾曲） |
| [facebookresearch/audiocraft](https://github.com/facebookresearch/audiocraft)（MusicGen/AudioGen） | 23,657 | 2025-03-13 ⚠️ | ⚠️ 代码 MIT，**MusicGen 权重 CC-BY-NC（非商用）** | Python | ✅（4–8G） | ⚠️ 权重非商用，产品化慎用 |

**建议用哪个 + 为什么 + 融合成本**
- **BGM 用 ACE-Step**（Apache-2.0 含权重，商用零风险，且快，可「按情绪/时长」批量出 BGM）；**音效用 Stable Audio Open**（注意其权重许可的 100 万美元营收门槛，商业规模化前需复核）。
- **避坑**：`audiocraft/MusicGen` 代码是 MIT 但**模型权重是 CC-BY-NC-4.0（禁止商用）**，别被仓库 MIT 误导。
- 融合：挂到 ComfyUI 或独立 HTTP，**成本低–中（3 人日 + 音效素材库规范）**。

---

## 6. 画布式工作流编排

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 能替代我们什么 |
|---|---|---|---|---|---|
| [comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI) | 135,930 | 2026-10-03 | **GPL-3.0**（自托管自用无碍） | Python / **workflow JSON + `/prompt` API** | **编排本身就是它** —— 我们已在用，继续以 workflow JSON + 网关调度 |
| [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | 155,471 | 2026-10-01 | **MIT** ✅（最宽松） | Python 服务 / 画布 UI | 若要「Agent 编排画布」参考，这是许可最干净的选择 |
| [langgenius/dify](https://github.com/langgenius/dify) | 157,747 | 2026-10-03 | ⚠️ **改版 Apache-2.0**（多租户 SaaS 需授权、不得去 Logo） | Docker Compose | LLM 应用编排（重，且许可有条件） |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 206,538 | 2026-10-03 | ⚠️ **Sustainable Use License**（内部自用可，**不可转售为服务**） | Node 服务 | 通用自动化（**转售受限**，且 .ee 文件不免费） |
| [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) | 55,485 | 2026-08-13 | ⚠️ Apache-2.0 + **企业目录单独商用许可** | Node 服务 | LLM 流程编排（hosted 服务需商用授权） |
| [mcmonkeyprojects/SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) | 4,624 | 2026-10-01 | **MIT** ✅ | .NET / Web UI | ComfyUI 的更强前端壳（可借鉴其 API 封装） |
| [ltdrdata/ComfyUI-Manager](https://github.com/ltdrdata/ComfyUI-Manager) | 16,329 | 2026-10-03 | **GPL-3.0** | ComfyUI 扩展 | 节点/模型管理 |

**建议用哪个 + 为什么 + 融合成本**
- **继续用「ComfyUI workflow JSON + 我们的 Node 零依赖网关」调度**，这是我们现在已经验证过的路，**不要在网页里重造编排**（正是产品负责人担心的误区）。ComfyUI 自托管自用，GPL-3.0 不构成问题。
- 若未来要做「面向用户的 Agent 编排画布」，参考 **Langflow（MIT，许可最干净）**，**避开 Dify/n8n/Flowise** 的许可限制（多租户 SaaS / 转售 / 企业条款）。**融合成本：沿用现有 ≈0**。

---

## 7. 短剧垂直项目（LocalMiniDrama / OpenCut 除外）

| 项目 | 星数 | 最近提交 | 许可证（可商用?） | 部署形态 | 16G 可行 | 能参考/替代我们什么 |
|---|---|---|---|---|---|---|
| [SkyworkAI/SkyReels-V1](https://github.com/SkyworkAI/SkyReels-V1) | 2,691 | 2025-03-10 | **Skywork 社区许可**（支持商用，有条款）✅ | Python / ComfyUI | ✅ 1.3B 版可跑 | **首个「面向短剧」的人像视频生成模型**（33 表情/400+ 动作） |
| [SkyworkAI/SkyReels-V2](https://github.com/SkyworkAI/SkyReels-V2) | 7,594 | 2026-01-29 | **Skywork 社区许可**（支持商用）✅ | Python / ComfyUI | ⚠️ 1.3B 可跑；14B 需 40G+ | 无限时长电影生成（I2V/T2V） |
| [linyqh/NarratoAI](https://github.com/linyqh/NarratoAI) | 11,272 | 2026-09-17 | **MIT** ✅ | Python / Web | ✅ | **「LLM 解说文案 → 自动剪辑成片」整条粗剪管线**，直接对标我们缺口 |
| [modelscope/FunClip](https://github.com/modelscope/FunClip) | 6,359 | 2026-09-16 | **MIT** ✅ | Python / Gradio | ✅ | 按识别文本选段自动剪 + 字幕（可并入粗剪） |
| [KrillinAI/KrillinAI](https://github.com/KrillinAI/KrillinAI) | 12,569 | 2026-10-03 | **Apache-2.0** ✅ | Go / 服务 | ✅ | 视频翻译+配音+对齐配音（出海/多语字幕参考） |
| [WEIFENG2333/VideoCaptioner](https://github.com/WEIFENG2333/VideoCaptioner) | 16,146 | 2026-05-24 | ⚠️ **GPL-3.0** | 桌面/CLI | ✅ | 字幕全流程（参考，GPL 传染性） |
| [harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | 128,143 | 2026-10-03 | **MIT** ✅ | Python / Web | ✅ | 「一句话→短视频工厂」的整套装配思路（含字幕/BGM/素材合成） |
| [ddean2009/MoneyPrinterPlus](https://github.com/ddean2009/MoneyPrinterPlus) | 7,156 | 2025-03-07 ⚠️ | ⚠️ **GPL-3.0** | Python / Web | ✅ | 同上，多平台分发（GPL） |
| [Doubiiu/ToonCrafter](https://github.com/Doubiiu/ToonCrafter) | 6,030 | 2025-03-19 ⚠️ | **Apache-2.0** ✅ | Python / Gradio | ⚠️（≈12G） | 卡通/漫剧两帧插值（漫剧方向参考） |
| [HVision-NKU/StoryDiffusion](https://github.com/HVision-NKU/StoryDiffusion) | 6,472 | 2024-09-26 ⚠️ | **Apache-2.0** ✅ | Python | ✅ | 长序列一致性漫剧分镜（可借鉴「角色一致」思路） |
| [lcy362/agnes-video-generator](https://github.com/lcy362/agnes-video-generator) | 462 | 2026-09-29 | **MIT** ✅ | 自托管 Web | ✅ | 开源短剧生成（多场景+解说+字幕+数字人口播）小而全的参考 |

**建议用哪个 + 为什么 + 融合成本**
- **最该借鉴的是 `NarratoAI`（MIT）** —— 它的「**LLM 生成解说文案 → 按文案自动切片/拼接 → 配音 → 字幕**」正是我们「自动粗剪装配」缺口的完整答案，架构可直接映射到我们五阶段流水线的「片段合成」后段。**借鉴成本低（读源码+抠管线 ≈3 人日）**。
- **模型侧可试挂 `SkyReels-V1`（1.3B，专为短剧人像训练）** 到我们本地 ComfyUI，作为短剧专用 I2V 备选（Skywork 社区许可支持商用）。**试挂成本中（≈3 人日）**。
- `MoneyPrinterTurbo`（MIT，128k 星）可作「成片装配 + 素材/BGM/字幕」整体工程结构的参考。

---

## 附录 A：许可证红线速查（能不能商用）

**✅ 可放心商用**：auto-editor(Unlicense)、Motion Canvas / MoviePy / funASR / faster-whisper / whisper.cpp / whisperX / Whisper / FunClip / NarratoAI / MoneyPrinterTurbo / agnes(MIT)；OpenTimelineIO / ffmpeg-python / CosyVoice / Spark-TTS / MuseTalk(其实 MIT) / LatentSync / EchoMimic / SadTalker / Hallo / video-retalking / ACE-Step / YuE / KrillinAI(Apache-2.0)；GPT-SoVITS / F5-TTS / VibeVoice(代码)→MIT。

**⚠️ 有条件（需核对条款）**：Remotion（≤3 人免费，团队付费）、stable-audio-tools 权重（年营收 <100 万美元免费）、Dify（多租户 SaaS 需授权）、n8n（不可转售为服务）、Flowise（托管服务需商用许可）、SkyReels（Skywork 社区许可，支持商用带条款）、HunyuanVideo（社区许可，**不含 EU/UK/韩国**，>1 亿 MAU 需另签）。

**❌ 红线（产品化前必须避开或付费）**：**IndexTTS**（bilibili 自定义模型许可，商用受限）、**Fish-Speech**（Fish Audio 研究许可，商用需单独授权）、**ChatTTS**（AGPL-3.0 传染）、**MusicGen 权重**（CC-BY-NC 非商用，注意不要被 audiocraft 的 MIT 代码误导）、**Wav2Lip**（无许可证 + README 声明仅研究/学术）。

---

## 附录 B：16GB 显存（147 机器）可行性总评

| 环节 | 结论 | 说明 |
|---|---|---|
| ASR（FunASR/whisper.cpp/faster-whisper/WhisperX） | ✅ 轻松 | 1–6G，甚至可纯 CPU |
| TTS/克隆（CosyVoice/GPT-SoVITS/F5-TTS/IndexTTS/Fish-Speech/VibeVoice） | ✅ 基本可跑 | 3–8G；VibeVoice 长对话较吃显存（8–16G） |
| 数字人（MuseTalk/SadTalker/Wav2Lip） | ✅ 可跑 | 4–12G |
| 数字人（LatentSync/EchoMimic/Hallo） | ⚠️ 贴边 | 12–16G，需降分辨率(512)或开显存优化，与 ComfyUI 争显存时要串行 |
| 音效（ACE-Step/Stable Audio/audiocraft） | ✅ 可跑 | 4–12G |
| 音效（YuE 带唱） | ⚠️ 贴边 | 12–16G |
| BGM/视频模型（SkyReels-V1 1.3B） | ✅ 可跑 | 1.3B 版消费级可跑 |
| 视频模型（SkyReels-V2 14B / HunyuanVideo / Open-Sora） | ❌ 16G 不够 | 需 40G+ 或多卡/量化，**本轮不作为首选** |

> 全局瓶颈：**147 单卡 16G 上 ComfyUI 与数字人/TTS 会争显存**，落地时要串行调度或错峰（网关加显存锁）。

---

## 附录 C：调研方法说明

- 星数、最近提交日期、许可证：**2026-10-03 从 GitHub 仓库页 HTML 与 `commits.atom` 一手抓取**（非二手文章）。
- 许可证关键条款：直接拉取各仓库 `LICENSE`/`LICENSE.txt` 原文核对商用条款（IndexTTS、Fish-Speech、Dify、n8n、Flowise、MuseTalk、SadTalker、HunyuanVideo、SkyReels 等）。
- 未安装、未运行任何模型，未改动 `/sobey/canvas-plus`。

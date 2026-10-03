# win147 ComfyUI 模型主登记表（model-registry）

> **用途**：「提示词自动改写/增强策略层」的规则来源。前端产出分镜内容、选定模型、点提交后，后端按本表（及配套 `registry.json`）中选中模型的规则自动改写/翻译/强化提示词，用户无感。
> **数据来源**：`sources/` 五份调研文档（inventory-api / qwen-family / image-models / video-models / version-upgrades / optimization），调研日期均为 2026-10-03。
> **机器概况**：win147 = RTX 5060 Ti 16G（约 15.93 GiB VRAM，Blackwell sm_120）/ 32G RAM；双实例共享模型目录：8188 生产实例（ComfyUI v0.38.2，4485 节点，不轻易升级）+ 8190 Qwen-Image 2.1 专用实例（ComfyUI v0.37.0，971 节点，升级风险低）。
> **配套文件**：机器可读规则表 `registry.json`（策略层直接 import）；官方工作流 JSON 在 `workflows/`。

---

## 一、场景 → 模型选型表

| 生产场景 | 首选 | 备选 | 理由（一行） |
| --- | --- | --- | --- |
| 文生图剧照/关键帧 | Qwen-Image 2.1 | Z-Image Turbo、Krea2 Turbo | 2.1 原生 2K + 多参考图；Z-Image 8 步双语最快；Krea2 美学最强但仅英文有官方依据 |
| 图编/换装/身材修改 | Qwen-Image-Edit-2509 | Qwen-Image 2.1（编辑模式）、Boogu Edit | 2509 的 1~3 图编辑 + 身份保留是官方甜蜜点；2.1 适合 >3 图；Boogu Edit 仅 1 图但支持图内文字编辑 |
| 多参考图生成（>3 张） | Qwen-Image 2.1 | —（唯一官方保证 10 张） | 官方保证 10 张、节点 16 槽，`<imageN>` 引用 |
| 海报/文字图/排版 | Qwen-Image 2.1 | Qwen-Image 20B、Boogu Base 2K、Z-Image Turbo | Qwen 系中文文字渲染官方主打；密集排版官方推荐 Boogu Base + 2K |
| 文生视频（带声音） | MiniMax H3（T2VA） | Wan2.1 14B、LTX-2.3 | H3 视频+原生音频一次出，短剧主力；Wan 无声 |
| 图生视频 | MiniMax H3（I2VA） | Wan2.1/2.2 I2V | H3 首帧锚定 + 音频；Wan 系加速 LoRA 生态齐 |
| 首尾帧视频 | MiniMax H3（FL2VA/L2VA） | Wan2.1 FLF2V | H3 首尾帧官方模板已在本地；Wan FLF2V 官方建议中文提示词 |
| 动作迁移/舞蹈复刻 | SCAIL-2 | Wan2.2-Animate（两档均被否决） | 5060 实测 SCAIL-2 已取代 WanAnimate；Animate-2 待升级 |
| 超清放大（图） | 4x-UltraSharp + 低 denoise img2img | SeedVR2 | GAN 只补锐度，要补细节必须接扩散重采样 |
| 超清放大（视频） | SeedVR2（FP8+BlockSwap16） | PDD 视频放大模板 | 社区公认最优视频超分；5060 实测有涂抹感需验收 |
| 语音/音频 | MiniMax H3（原生音视频） | TD-Qwen3TTS（8188 节点） | H3 台词/音效/配乐与画面联合生成 |

---

## 二、模型详表

### 1. Qwen-Image（20B 文生图）

- **场景定位**：中文/多语言文字渲染与海报排版最强的 20B 文生图基座（Apache 2.0）。
- **实例与节点**：8188/8190 均可（官方节点两实例都有）。`UNETLoader qwen_image_fp8_e4m3fn.safetensors` + `CLIPLoader qwen_2.5_vl_7b_fp8_scaled.safetensors（type=qwen_image）` + `VAELoader qwen_image_vae.safetensors`；模板挂 `ModelSamplingAuraFlow shift=3.1`。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | 中英日韩意等直接输入，无需翻译（官方 ComfyUI 教程明示）；按用户语言追加 magic suffix：英文 `, Ultra HD, 4K, cinematic composition.` / 中文 `, 超清，4K，电影级构图.`（官方 README `positive_magic`） |
| 负面提示词 | 基线路径基本不用：官方 diffusers 负面串就是一个空格 `" "`（true_cfg 4.0）；ComfyUI 模板留空。cfg=1（Lightning 路径）时负面完全无效，要用负面必须 cfg≥2.5。可复用 2512 官方中文负面串：`低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。` |
| 画面内文字 | 英文双引号逐字包裹、保持原文字符（中文就写中文字符），写清载体（招牌/海报/屏幕）、字体风格与位置 |
| 分辨率/多图 | 官方 7 档（约 1.3~1.7MP）：1:1 1328×1328、16:9 1664×928、9:16 928×1664、4:3 1472×1104、3:4 1104×1472、3:2 1584×1056、2:3 1056×1584；建议 32 倍数对齐；纯文生图无多图输入 |
| 长度/结构 | diffusers 管线 512 token 静默截断（可配 1024）；ComfyUI 原生不截断但超长「丢尾」，正文控制在 ~500 token 内、重要内容前置；短提示词先过官方 Prompt Enhance 扩写 |

**推荐参数**

| 档 | steps | cfg | sampler | scheduler | shift | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 速度档 | 8 | 1 | euler | simple | 3.1 | 挂 Lightning 8 步 V2.0 LoRA（4 步版细节略软） |
| 质量档 | 50 | 4.0 | euler | simple | 3.1 | 官方 diffusers 值；ComfyUI 模板 20 步为折中 |

- **官方工作流**：`workflows/qwen-image-t2i-official.json` ← [image_qwen_image.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image.json)
- **版本状态**：建议可选升级——Qwen-Image-2512 fp8（2025-12-31，人像真实感/文字渲染提升，且本地已有 2512 Lightning/Turbo LoRA 缺底座）。
- **已知坑**：① Lightning 8 步 LoRA 与社区 15 步蒸馏版不要叠加（官方教程明示兼容性未验证）；② cfg=1 时负面词无效；③ diffusers 超长静默截断；④ 官方 4:3 比例 README（1472×1104）与 ComfyUI 模板 note（1472×1140）不一致，以 README 为准。

### 2. Qwen-Image-Edit-2509（图编/换装）

- **场景定位**：多图输入指令编辑（1~3 图），人物+人物/商品/场景组合，改字不崩脸、身份保留。
- **实例与节点**：8188/8190 均可。`qwen_image_edit_2509_fp8_e4m3fn.safetensors` + `qwen_2.5_vl_7b_fp8_scaled` + `qwen_image_vae`；核心节点 `TextEncodeQwenImageEditPlus`（image1/2/3 三槽）+ `FluxKontextImageScale` + `ModelSamplingAuraFlow shift=3` + `CFGNorm strength=1`。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | 中英双语编辑指令均可；**官方强烈建议先 prompt rewriting**（`polish_edit_prompt`，Qwen-VL-Max 驱动），不改写编辑结果不稳定——策略层必须对齐 |
| 负面提示词 | 官方路径不依赖：diffusers 固定 `negative_prompt=" "` + true_cfg 4.0；模板留空；Lightning 4 步 cfg=1 时无效 |
| 画面内文字 | 目标文字逐字写出+引号包裹+指明载体与位置（官方示例「屏幕上面写着'阿里巴巴'」）；指令式写法「操作 + 显式声明保持不动的部分」，如 `Replace the cat with a dalmatian, keeping the environment and scene consistent` |
| 分辨率/多图 | **多图 1~3 张为官方甜蜜点**（节点三槽一致）；4 张以上需串联 `ReferenceLatent`，社区明示无保证（4~5 图需求用第三方 `TextEncodeQwenImageEditPlusPro`）；输入图被 `FluxKontextImageScale` 压到约 1MP 总像素（16 倍数对齐）再编码——「编辑后变糊」的常见原因；输出尺寸跟随输入图 |
| 长度/结构 | 换装/换物指令必须显式写 preservation 从句（保持面部、发型、体型、姿势不变），否则身份漂移 |

**推荐参数**（模板内官方对照表）

| 档 | steps | cfg | 备注 |
| --- | --- | --- | --- |
| 速度档 | 4 | 1.0 | Lightning-2509 4 步 LoRA；先开 LoRA 调提示词、定稿后关掉出正式图（日文社区流程） |
| 质量档 | 20 | 2.5 | Comfy Original；Qwen Team 官方为 50 步 / cfg 4.0 |

- **官方工作流**：`workflows/qwen-image-edit-2509-official.json` ← [image_qwen_image_edit_2509.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_edit_2509.json)
- **版本状态**：已可用；可选换 Edit-2511 fp8（本地已有 2511 Lightning LoRA），优先级低。
- **已知坑**：① 不改写提示词结果不稳定（官方原话）；② 输入图被压 1MP，细节会糊；③ 超过 3 图无官方保证；④ 不写 preservation 从句身份必漂移。

### 3. Qwen-Image 2.1（7B 统一生成+编辑）——策略层重点

- **场景定位**：2026-09-20 发布，单 checkpoint 统一生图+编辑，原生 2K、原生 RGBA 透明、最多 10 参考图、专业排版。**架构与前代完全不同，1.x/2509 节点与工作流不通用，需 ComfyUI ≥0.37.0。**
- **实例与节点**：8190 专用实例（0.37.0）。权重 `qwen_image_2.1_int8_convrot.safetensors` 或 GGUF `qwen_image_2.1-Q4_K/Q8_0.gguf` + `qwen3vl_8b_fp8_scaled` + `qwen_image_2.1_vae_bf16.safetensors`；核心节点 `TextEncodeQwenImage21`（16 图槽）、`QwenImage21Cache`（多图 KV 缓存）。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | **官方链路 = 任意语言输入 → PE-T2I 改写为英文长提示词**，图中文字保留原语言（PE 系统提示词写死）；编辑指令（PE-I2I）正文跟随用户指令语言，图中文字：用户指定就严格照写，否则跟随图片已有文字主语言；引号内禁止中英混杂 |
| 负面提示词 | **官方路径 cfg=1，负面完全无效**（官方教程：cfg 1 时跳过负面条件计算）。要负面必须抬 cfg（cfg 2 贴密集提示词但边缘过锐，cfg 5 严重劣化，cfg 0.5 崩图）。**策略层默认不生成负面词，「不要 X」改写进正向提示词**（官方模板示例尾部写 `Absolutely no text, no typography, ... no watermark`） |
| 画面内文字 | 每条文字英文直双引号包裹、逐字符照抄、保持原书写系统；写清字重/颜色/大小写/相对大小/位置；换行用文字描述（"a second line"）而非引号内塞真换行；不希望被读出的文字明说 `blurred/indistinct/too small to read`。透明图固定咒语：`This is an RGBA image with transparency. <描述>. The image has alpha channel and the background is transparent.`（存 PNG） |
| 分辨率/多图 | **多图：官方保证 10 张，节点 16 槽**（image_1~image_16，官方模板只接前 10）；`image_1` 是被编辑画布，提示词用 `<image1>`~`<image10>` 按槽位引用，**禁止「图1」「第一张图」自然语言指代**。T2I 原生 2K 七档：1:1 2048×2048、4:3 2400×1792、3:4 1792×2400、3:2 2528×1696、2:3 1696×2528、16:9 2752×1536、9:16 1536×2752；编辑默认输出跟随 image_1（32 倍数对齐）；`resolution` 参数是总像素预算（0~4096 步进 32，默认 1024，0=跟随原尺寸） |
| 长度/结构 | 改写后提示词预期 400~500 词约 20 句（官方 PE「Size」节）；多参考图时必须逐图描述角色分工，禁止合并指代；**远超 2K（如 4K）掉 prompt adherence**（官方教程原话） |

**推荐参数**

| 档 | steps | cfg | sampler | scheduler | 备注 |
| --- | --- | --- | --- | --- | --- |
| 速度档 | 8 | 1 | euler | simple | 社区 8 步 LoRA（`p_qwen_image_2.1_8step_v0.1`，已装）；另有官方 4 步 Turbo GGUF（viggle）可选 |
| 质量档 | 25 | 1 | euler | simple | 官方模板值；官方 diffusers/vLLM/SGLang 为 40 步，25→40 减少细节 fizzle；顽固细节（手部）约 30 步收敛 |

- **官方工作流**：`workflows/qwen-image-2.1-t2i-official.json`、`workflows/qwen-image-2.1-edit-official.json` ← [image_qwen_image_2_1_t2i.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_t2i.json)、[image_qwen_image_2_1_image_edit.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_image_edit.json)
- **版本状态**：已是最新。8190 可择期升 ComfyUI 0.38.x（拿 tiny VAE / union controlnet / 编译优化），非必须。
- **已知坑**：① `thinking_mode` 必须和 PE 改写一起开（checkpoint 带推理块训练，关了掉质量）；② 多张大图参考显著拖慢，开 `QwenImage21Cache`；③ `EmptyLatentImage` 通道/压缩比不同，依赖 0.37.0+ 自动修正，旧版双倍尺寸；④ GGUF 为社区量化，文字渲染小细节随档位下降；⑤ 局部编辑可在 image_1 上画彩色标记，提示词点名颜色定位（"change the jacket in the red area"）。

### 4. Krea 2 Turbo（美学文生图）

- **场景定位**：Krea AI 12.9B 美学向文生图，风格多样性/美学质量独立评测第一；Turbo 为官方 8 步蒸馏推理版。许可为 Krea 2 Community License（非 Apache，商用需读许可证）。
- **实例与节点**：8188（8190 仅基础节点）。`krea2_turbo_fp8_scaled.safetensors` + `qwen3vl_4b_fp8_scaled（type=krea2）` + `qwen_image_vae.safetensors`；timestep-shift **mu=1.15**（官方明确推荐）。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | 官方要求英文自然语言整句，长而详细效果最好；**中文提示词无官方依据**，策略层应翻译为英文。官方提供 `expansion.txt` 作 LLM 扩写 system prompt |
| 负面提示词 | **无效**：Turbo 官方 `--steps 8 --cfg 0.0`（ComfyUI 写 cfg=1）；要负面控制只有社区 ComfyUI-Krea2-NAG 一条路 |
| 画面内文字 | 官方唯一建议：要渲染的文字加英文引号；能力介于 SDXL 与 Ideogram 之间，招牌级可用、海报标题级不可靠 |
| 分辨率 | 官方 1K~2K（1024~2048，自动 pad 到 16 倍数）；社区共识：直接原生 2K 出图，先 1024 再放大等于浪费能力 |
| 长度/结构 | **禁止 CLIP 时代关键词条 + `(word:1.2)` 权重语法**（Qwen3VL 把整句当语言读，>1.2 画面崩）；用语序前置、同义复述、具体词汇（"oxblood" 而非 "red"）；公式：主体+一个动作+光源+一两个质感词 |

**推荐参数**

| 档 | steps | cfg | sampler | scheduler | mu | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 速度档=质量档 | 8 | 1.0 | euler | simple | 1.15 | Turbo 本身即蒸馏版；社区 4 步 LoRA（lvladikov）未装 |

- **官方工作流**：`workflows/krea2-turbo-official.json` ← [image_krea2_turbo_t2i.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_krea2_turbo_t2i.json)
- **版本状态**：已是最新（2026-06-22，无 Krea 3）。
- **已知坑**：① 9 个官方风格 LoRA 必须带触发词（与文件名不对应），且提示词其余部分不要再写风格词；② 单词权重语法会崩画面；③ 直接开 sage attention 有 shape bug，需 guard 补丁；④ 中文表现无官方背书。

### 5. FLUX.1-dev

- **场景定位**：老牌 12B 通用文生图底座，生态最大（LoRA/ControlNet/Redux/Kontext）；dev 非商用许可。
- **实例与节点**：8188。`flux1-dev-fp8.safetensors` + `DualCLIPLoader clip_l + t5xxl_fp8_e4m3fn（type=flux）` + `ae.safetensors`；模板用 `ConditioningZeroOut` 清零负面。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | **官方推荐英文**，中文无官方背书（多语言表态仅见于 FLUX.2）；策略层翻译为英文 |
| 负面提示词 | **官方明确反对**（"FLUX responds to what you describe, not a list of what to avoid"）；guidance-distilled 模型 cfg=1 负面不生效，模板直接 ZeroOut |
| 画面内文字 | 引号包裹精确文字 + 描述字体特征（粗细/大小写/颜色/对齐）；文字内容保持短，长字符串准确率低；文字能力一般，海报排版非强项 |
| 分辨率 | BFL API 官方边界 256~1440、32 倍数、默认 1024×768；甜点约 1MP；本地可超 1440 但偏离训练分布构图变差 |
| 长度/结构 | 官方四件套：主体前置、写光线、颜色用 hex（`#FF6B6B (coral pink)`）、文字加引号；摄影感用相机/胶片/焦段/光圈词汇；BFL 官方 agent skill `flux-image-best-practices` 可作改写规则来源 |

**推荐参数**

| 档 | steps | cfg | guidance | sampler | scheduler | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 速度档 | 8 | 1 | — | euler | simple | 挂 Hyper-FLUX.1-dev-8steps LoRA（已装） |
| 质量档 | 20~28 | 1 | 3.0~3.5 | euler | simple | API 默认 28/3.0；模板 20 步；社区惯例 FluxGuidance 3.5 |

- **官方工作流**：`workflows/flux1-dev-official.json` ← [flux_dev_full_text_to_image.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/flux_dev_full_text_to_image.json)
- **版本状态**：不升级 dev（FLUX.2 dev 32B 跑不动且非商用）；可选装 FLUX.2 klein-4B（Apache 2.0，8GB 级）。
- **已知坑**：① 负面词机制上无效，别写；② 超 1440 构图劣化；③ guidance 过高过饱和、过低发灰；④ 文字渲染能力弱于 Qwen/Z-Image。

### 6. Z-Image Turbo / base

- **场景定位**：阿里通义 6B S3-DiT，Apache 2.0 可商用；Turbo 8 NFE 亚秒出图，主打照片级真实感 + 中英双语文字渲染；base（50 步、支持 CFG）用于微调与高多样性。
- **实例与节点**：8188/8190 均有核心节点。`z_image_turbo_bf16.safetensors`（base：`z_image_bf16.safetensors`）+ `qwen_3_4b.safetensors（type=lumina2）` + `ae.safetensors`；需 `ModelSamplingAuraFlow shift=3`。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | **官方双语**，中文提示词直接写无需翻译；官方配套 Prompt Enhancer（带推理的扩写器） |
| 负面提示词 | **Turbo 无效**（官方 `guidance_scale=0.0`，模型 zoo CFG 列 ❌）；base 官方明确支持负面（50 步，具体 cfg 数值无官方依据）。注意排雷：中文社区「Turbo 加中文负面词库降失败率」说法与机制矛盾，不采信 |
| 画面内文字 | 中英双语文字渲染是官方主打卖点；引号包裹目标文字+描述字体/颜色/位置，中文直接写中文 |
| 分辨率 | 官方示例 1024×1024，无官方上下限；社区实测原生到 4MP（2048×2048），建议 32 倍数对齐 |
| 长度/结构 | Turbo 参数不要动：steps 8（可接受 6~11）、cfg 锁 1.0，官方默认即最优；勿超 ~12 步（蒸馏模型多步反劣化）、cfg 调高过饱和烧图 |

**推荐参数**

| 档 | steps | cfg | sampler | scheduler | shift | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 速度档=质量档 | 8 | 1.0 | res_multistep | simple | 3 | 官方模板值；diffusers 写 9（实 8 次前向） |
| base 质量档 | 50 | 支持 CFG（数值无官方依据） | euler/res_multistep | simple | — | 微调/高多样性场景 |

- **官方工作流**：`workflows/z-image-turbo-official.json` ← [image_z_image_turbo.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_z_image_turbo.json)
- **版本状态**：已是最新（Turbo 2025-11-26 / base 2026-01-27），观望 Z-Image-Edit。
- **已知坑**：① Turbo 不要加步数/抬 cfg；② 负面词对 Turbo 是摆设；③ 147 另有 NSFW merge 版（见「不推荐」节）；④ 训练 LoRA 用 base/De-Turbo，推理用 Turbo。

### 7. Boogu Edit / Turbo

- **场景定位**：Apache 2.0 的 10B 统一理解-生成模型族：Base/Turbo（4 步）/Edit/Edit-Turbo；照片级写实 + 中英双语文字渲染 + 图内文字精细编辑。官方 FAQ：任何以 Boogu 名义收费的服务均为假冒。
- **实例与节点**：两实例都有 `TextEncodeBooguEdit`。Edit：`boogu_image_edit_int8_convrot.safetensors`；Turbo：`boogu_image_turbo_fp8_scaled.safetensors`；编码器 `qwen3vl_8b_fp8_scaled（type=boogu）` + `ae.safetensors`。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | **官方双语**，中文长提示词直接可用；文字渲染只优化了中英，其他语言明显退化。官方提供 Qwen3-VL-32B prompt rewriter（与策略层同构，系统提示词可抄） |
| 负面提示词 | **Edit/Base 支持**（CFG 2.0~5.0，25~50 步；节点第二输入即负面串，模板留空）；**Turbo/Edit-Turbo cfg=1 负面无效** |
| 画面内文字 | 双语文字渲染是核心卖点，支持图内文字增删改（字体/字重/颜色/版式适配）；建议引号包裹（官方未明文）；密集文字渲染官方分级：Turbo ⭐⭐⭐ / Base ⭐⭐⭐⭐；官方自报长文本/小字号仍会错字 |
| 分辨率/多图 | 官方档 1K/1.5K/2K；**Turbo 仅 1K**；Base/Edit 1K~2K 但 **Edit 1K 更稳定**（官方原话）；比例 1:1, 2:3, 3:2, 3:4, 4:3, 1:2, 2:1, 9:16, 16:9；**Edit 目前仅支持 1 张参考图**（官方原话）；Edit latent 画布匹配输入图尺寸保持构图 |
| 长度/结构 | 官方 rewriter 的**最小改写原则**：prompt 已清晰就几乎不改；版式/图文类（流程图/信息图/海报/UI）反向极致详尽；编辑指令自然语言直述（"remove the hat"） |

**推荐参数**

| 档 | steps | cfg | sampler | scheduler | shift | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| Edit 质量档 | 25 | 3.5 | dpmpp_2m | simple | 3.16 | ComfyUI 官方模板实测值；官方区间 25~50 步 / cfg 2~5 |
| Turbo T2I | 4 | 1.0 | lcm | sgm_uniform | — | **必须挂 rank-128 LoRA `boogu_image_turbo_lora_rank_128_bf16`** |

- **官方工作流**：`workflows/boogu-edit-official.json`、`workflows/boogu-edit-int8-official.json`（与 147 int8 权重对应）、`workflows/boogu-turbo-official.json` ← [workflow_templates](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/)（`image_boogu_image_0_1_edit` / `_edit_int8` / `_turbo_t2i`）
- **版本状态**：观望——0.1 即最新正式权重；Turbo-2K / Edit-Turbo 已宣布未放出，放出后直接换文件。
- **已知坑**：① **Turbo 模板必挂的 rank-128 LoRA 在 147 loras 目录盘点中未见，用 Turbo 前需确认/下载**；② Edit 仅 1 参考图；③ 官方自报短板：真实世界知识（品牌/名人/地标）、in-context 主体一致性、复杂姿势人体、小人脸小四肢；④ 16G 需量化权重 + CPU offload；⑤ 旧自定义节点仓库 ComfyUI-Boogu 已 legacy，勿用。

### 8. Wan 2.1 T2V（1.3B / 14B）

- **场景定位**：阿里开源视频基座；1.3B 是 16G 卡快速草稿引擎（480P），14B 是画质档（480P/720P）；支持 T2V/I2V/FLF2V。
- **实例与节点**：8188（WanVideoWrapper 全套仅 8188）。编码器 **必须用 comfyorg 版 `umt5_xxl_fp8_e4m3fn_scaled_comfyorg.safetensors`**（diffusers 格式加载失败，本地实测）；VAE `wan_2.1_vae.safetensors` / `Wan2.1_VAE.safetensors`。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | **官方中英双语**（umt5 多语言 T5）；官方 Prompt Extension 支持 `--prompt_extend_target_lang zh\|en`，扩写系统提示词（`wan/utils/prompt_extend.py`，6 套）可直接抄进策略层。例外：**FLF2V 官方建议中文提示词** |
| 负面提示词 | **必须写，直接用官方中文串**（ComfyUI 模板原样沿用）：`色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走`（Wan2.2 模板在此串后追加「裸露，NSFW」） |
| 画面内文字 | 官方称 Wan2.1 是首个能同时生成中英文画面文字的视频模型；引号/书名号内原文不翻译（扩写规则⑧） |
| 分辨率/时长 | 官方档 480P（832×480）/720P（1280×720）；**1.3B 只支持 480P**（官方明示 720P 不稳定）；16 FPS，帧数需 4k+1（VAE 时序压缩 4×），官方示例 81 帧≈5 秒；I2V 的 size 是画面面积，宽高比跟随输入图 |
| 长度/结构 | 文本编码上限 `text_len=512`（umt5 token）；官方强烈建议开 prompt_extend 把短句扩到 80~100 字：补全主体特征/风格/空间关系/景别、强调运动与镜头运镜、简单直接动词、未指定风格默认纪实摄影、古诗词强制中国古典元素 |

**推荐参数**

| 档 | steps | cfg | shift | sampler | scheduler | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 速度档（1.3B/480P） | 30 | 6.0 | 8 | uni_pc | simple | ComfyUI 官方模板值，147 实测 81 帧约 7 分钟；挂 lightx2v LoRA 可 4~6 步 cfg1 |
| 质量档（14B/720P） | 50 | 5.0 | 720P=12（diffusers 口径 5.0，见矛盾点） | unipc/uni_pc | — | 官方 generate.py 值 |

- **官方工作流**：`workflows/wan21-t2v-official.json` ← [text_to_video_wan.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/text_to_video_wan.json)
- **版本状态**：观望——Wan 2.5/2.6/3.0 全部 API-only 无权重，Wan2.2 仍是最新开源主线。
- **已知坑**：① umt5 只认 comfyorg 格式；② Wan 要高 cfg（≈6），别学 Qwen 的 cfg1；③ 1.3B 勿上 720P；④ TeaCache 可再加速约 2×；⑤ Wan2.1 I2V 14B GGUF 档案有记录但本次盘点未见（见矛盾点）。

### 9. Wan2.2-Animate（动作迁移/角色动画）

- **场景定位**：驱动视频+角色参考图 → 角色复刻动作（animation）或视频换人（replacement）。147 现状：5060 实测两档均被用户否决，SCAIL-2 已取代其主力地位。
- **实例与节点**：8188（WanAnimatePlus 全套）。权重 `Wan22Animate\Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors` 或 `Wan2_2_Animate_14B_Q4_K_M.gguf` + umt5 comfyorg 版；replacement 模式需官方 Relighting LoRA（`WanAnimate_relight_lora_fp16.safetensors`，已装）。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | 沿用 Wan 双语 umt5；**提示词是辅助项**——官方模板示例只有一句 "The character is dancing in the room"；背景/服装/长相由参考图决定，要换场景换服装**换参考图，不改 prompt** |
| 负面提示词 | 沿用 Wan2.1 官方中文串（模板原样沿用）；但加速档 cfg=1 时负面不生效 |
| 分辨率/时长 | 预处理按面积 1280×720；`WanAnimateToVideo` 节点宽高**必须 16 倍数**（官方模板注）；单段 77 帧，段间 `refert_num` 衔接；模板 fps=16（diffusers 导出 30） |
| 长度/结构 | 一句话描述「人在做什么」即可；Move/Mix 两种模式（断开/接上 Background_video+Character_mask），SAM2 点选跟踪对象 |

**推荐参数**

| 档 | steps | cfg | shift | sampler | 备注 |
| --- | --- | --- | --- | --- | --- |
| 速度档 | 6 | 1.0 | 8 | euler/simple | 官方模板 + lightx2v 4 步蒸馏 LoRA；4 步档皮肤塑料感已被否决 |
| 质量档 | 20 | 4.0 | — | — | 5060 实测 HQ 档（去蒸馏 LoRA，约 1h/条）；官方 diffusers 20 步 cfg 1.0 |

- **官方工作流**：`workflows/wan22-animate-official.json` ← [video_wan2_2_14B_animate.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_14B_animate.json)
- **版本状态**：**建议升级 Wan2.2-Animate-2-14B**（2026-08 开源，同 14B 规模，ComfyUI ≥0.31 原生支持，注意命名陷阱：`Animate-14B`=一代、`Animate-2-14B`=二代）。
- **已知坑**：① 官方警告勿给 Wan-Animate 挂 Wan2.2 系 LoRA；② 蒸馏 4 步档「一眼假」；③ 33 帧滑窗衔接闪烁；④ 模板含 subgraph 不能原样 POST /prompt；⑤ prompt 改不了背景/服装。

### 10. SCAIL-2（舞蹈/动作复刻主力）

- **场景定位**：智谱 zai-org 基于 Wan2.1 14B 的端到端角色动画模型；参考图+驱动视频 → 动画/换人。5060 实测路线的当前主力。
- **实例与节点**：8188（WanAnimatePlus SCAIL_2 系列）。`wan2.1_14B_SCAIL_2_fp8_scaled.safetensors` + `umt5_xxl_fp8_e4m3fn_scaled` + `Wan2_1_VAE_bf16` + `clip_vision_h` + `sam3.1_multiplex_fp16`（放 checkpoints/）+ **官方 DPO LoRA 常开**（`wan2.1_SCAIL_2_DPO_lora_bf16`）+ lightx2v rank64。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | 沿用 Wan 双语 umt5；**prompt 描述生成后的视频本身，不是对模型的指令**；替换模式要描述「替换已发生之后」的画面；模型用长而详细的提示词训练，详细描述主体+运动效果更好（官方原话）；官方模板示例为英文长段 |
| 负面提示词 | 官方模板负面为空串（加速档 cfg=1 不生效）；非加速档（cfg 5.0）可沿用 Wan 中文串——无官方依据，按 Wan 系惯例 |
| 分辨率/时长 | 512p / 704p（姿态驱动 704p 更好）；**宽高 32 倍数**（官方 README；ComfyUI 教程说 16，模板内部按 32 取整——以 32 为准）；帧长 ≡1 (mod 4)，分段块 81 帧，段间重叠 5 帧，**不能自动排队需逐段提交**；fps 跟随驱动视频 |
| 长度/结构 | 掩码语义是核心输入（黑=背景不可见/白=可见/彩色=角色对应关系）；替换模式写替换角色可见服装外貌+交互物体；SAM3 跟踪文本（默认 "human"）与生成 prompt 无关；官方 `prompt_enhancer.py`（Gemini 两段式 caption→合成，输出英文一段 90~140 词）可复用为策略层改写器 |

**推荐参数**

| 档 | steps | cfg | shift | sampler | 备注 |
| --- | --- | --- | --- | --- | --- |
| 速度档 | 6 | 1.0 | 5.0 | euler/simple | 官方模板：lightx2v rank64 @0.8 + DPO LoRA @1.0 |
| 质量档 | 40 | 5.0 | 3.0 | unipc（可选 dpm++） | 官方 generate.py 默认；DPO LoRA 仍建议常开（改善手部畸变与唇眼同步） |

- **官方工作流**：`workflows/scail2-character-replacement-official.json` ← [video_wan21_scail2_character_replacement.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan21_scail2_character_replacement.json)
- **版本状态**：已是最新（2026-06，无 SCAIL-3）。
- **已知坑**：① 模板含 subgraph 需展平成原子图再 POST（本地已有展平验证图）；② 掩码错了动画模式退化成替换行为；③ 多参考为零样本能力，官方明示画质可能下降；④ 逐段手动提交；⑤ 输出质量仍需逐帧验收。

### 11. MiniMax H3（短剧视频主力，视频+音频联合生成）

- **场景定位**：全模态视频模型，视频+原生立体声音频（台词/音效/配乐）一次出；147 短剧片段主力。许可为 MiniMax H3 Community License（非 Apache，不覆盖美/欧/英/韩，商用前过法务）。
- **实例与节点**：8188（Turbo/PDD/QuantFunc 全套仅 8188；8190 有基础 9 节点）。UNet `minimax_h3_fl2va_pruned_int8_convrot.safetensors`（T2V/I2V/FL2V）/ `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（Ref2VA，**与 fl2va 不是同一套权重**）+ `qwen3vl_32b_minimax_h3_nvfp4_awq（type=minimax）` + 视频 VAE + `minimax_h3_audio_vae_fp32.safetensors`。节点：`EmptyMiniMaxH3LatentAV` / `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` / `MiniMaxH3SigmaShift` / `MiniMaxH3AddGuide`（≥0.34）。

**改写规则**

| 项 | 规则 |
| --- | --- |
| 语言适配 | 中文提示词即可（官方云端手册，上限 7000 字符）；官方改写规范要求**改写正文用英文、字段名固定英文，台词/歌词/画面文字保留原语言** |
| 负面提示词 | **没有负面字段**（官方手册「负向词：无」）；负向约束并入正向句写「避免/不要…」；不要 BGM 写 `non_diegetic_music: N/A` |
| 画面内文字 | 英文双引号包原文：`A red neon sign reading "营业中"` |
| 分辨率/时长 | 原生短边 768px（16:9=1344×768），32 倍数取整；24 FPS；时长吸附 17k+5 帧网格（5s=124 帧、10s=243 帧、15s=362 帧）（⚠️2026-10-04 修订：原文 15s 写 363，与 17k+5 不符，17×21+5=362），官方 4~15 秒，**16G 卡 5 秒稳档、15 秒易卡死**（实测）；比例 21:9/16:9/4:3/1:1/3:4/9:16；1440p 跑不了走超分 |
| 长度/结构 | **固定字段结构**（策略层核心）：基础模式三字段固定顺序 `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`，I2VA/FL2VA/L2VA 第一行必须是关键帧对齐指令行（时间精确到两位小数）；Ref2VA 六段固定顺序（subject_definitions → summary → retention_analysis → detailed_description 350~500 英文词 → soundscape → music）；台词说话人稳定 ID `(S1)`，内容 `<d>[English] ...</d>` 逐字不翻译；描述总时长必须等于目标视频时长 |

**推荐参数**

| 档 | steps | cfg | shift | sampler | 备注 |
| --- | --- | --- | --- | --- | --- |
| 速度档 | 8 NFE | 1.0 | video 6 / audio 3 | res_multistep/simple | 官方 Turbo 推荐（ModelTC）；4 步 LoRA 档运动/口型略降 |
| 质量档 | 20（可升 25） | 6 | MiniMaxH3SigmaShift 节点 | res_multistep/simple | ComfyUI 官方模板值 |

- **官方工作流**：`workflows/minimax-h3-t2va-official.json`、`workflows/minimax-h3-i2va-official.json` ← [video_minimax_h3_t2v.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json)、[video_minimax_h3_i2v.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json)
- **版本状态**：已是最新（2026-07-31 发布/08-03 开权重）；H3 Max 为 fal 托管 API，观望是否放权重。
- **已知坑**：① 模板含 subgraph 需展平；② LoRA 兼容看 safetensors 头（time_embedder 适配器只能挂完整底模，adaln 输入维度 8 只能挂 pruned）；③ 版本墙：≥0.34 才有 AddGuide，≥0.35 才支持 DiffSynth/PDD LoRA；④ 不自动硬切镜，多场景拆 2~3 秒段 ffmpeg 拼接；⑤ 15 秒档 16G 易卡死。

### 12. LTX-2.3（22B 视频）

- **场景定位**：Lightricks 22B 视频模型（dev/distilled 双版本），已装 fp8 + 7 个 LoRA/IC-LoRA；**源文档未覆盖其提示词规范**（无官方语言/负面/结构依据），策略层接入前需补调研。
- **实例与节点**：8188。checkpoint `ltx-2.3-22b-dev-fp8.safetensors` / `ltx-2.3-22b-distilled-fp8.safetensors` + `ltx-2.3-22b-dev_video_vae.safetensors` + 编码器 `gemma_3_12B_it_fp4_mixed.safetensors`。
- **推荐参数**：速度档 distilled 8 步 cfg 1；质量档官方两段式 15 步 res2s（distilled+dev 同跑）；dev 版 20~50 步 cfg 3~3.5。（来源：optimization.md 2.2 节）
- **官方工作流**：本地未下载；8188 实例内有 WhatDreamsCost 插件的 5 个 LTX 模板（I2V FFLF / First Last Frame / LTX_Director_2 等）。
- **版本状态**：**建议升级 LTX-2.5**（2026-08-11，视频+同步音频、720p~4K，官方自述推荐；GGUF Q4+distilled 可在 16G 跑，ComfyUI ≥0.32 原生支持，8188 已满足；VAE/encoder 不通用需新增 20~30GB 磁盘）。
- **已知坑**：① fp8 全质量需 ~32GB VRAM，16G 必须 GGUF+offload；② 2.3 与 2.5 的 VAE/encoder 不通用；③ 提示词规范未调研。

### 13. 4x-UltraSharp（图像放大）

- **场景定位**：经典 ESRGAN 4× 放大器，擅长修 JPEG 压缩退化、留锐化纹理。**许可 CC-BY-NC-SA-4.0（非商用）——商用交付需换模型或取得授权，策略层必须标注。**
- **用法**：`UpscaleModelLoader(4x-UltraSharp.pth)` → `ImageUpscaleWithModel` → `ImageScale`（lanczos 到目标尺寸）；视频逐帧同理。
- **改写规则**：不涉及提示词；**但 GAN 只提锐度不补语义细节**——要补细节接 img2img 低 denoise 重采样：像素放大后 denoise 0.25~0.5，模型放大器（已锐化）用 0.2~0.35；低于 ~0.3 糊、高于 0.5 改图；大图走 TTP Smart Tile 分块防 OOM。H3 768p 出片 4× 后短边过大，通常缩回 1440p/1080p。
- **官方工作流**：`workflows/upscale-model-official.json` ← [utility-gan_upscaler.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/utility-gan_upscaler.json)（模板默认 RealESRGAN_x4plus，换 4x-UltraSharp 即可）
- **版本状态**：不升级（多年无更新）；新工作流优先 SeedVR2（扩散式，16G 配 FP8+BlockSwap16），4x-UltraSharp 保留兼容旧链路。

### 14. 已装但暂不推荐（简列）

| 资产 | 原因 |
| --- | --- |
| `zImageTurboNSFW_v10_fp8`、`wan_1.3B_exp_e14`（NSFW Wan 1.3B）、`nsfw_wan_14b_e15` GGUF、`wan2.2-rapid-mega-aio-nsfw-v12.1` GGUF ×2 | 社区 merge/微调，无官方升级线，按作者页手动跟踪；非生产优先验证再替换 |
| `BEYOND_REALITY_3.0_BF16` | Civitai 社区写实 checkpoint，无官方版本线 |
| `v1-5-pruned-emaonly` | SD1.5 老底座，仅旧工作流/controlnet 兼容用 |
| `wan2.2_ti2v_5B_fp16` | 已装但源文档未做提示词规范调研，用前补 |
| `sam3.1-multiplex-fp16` 与 `sam3.1_multiplex_fp16` | 疑似同权重重复（文件名不同），建议核对哈希去重 |
| Z-Image-Edit、Boogu Turbo-2K/Edit-Turbo、Wan 2.5/2.6/3.0、H3 Max、FLUX 3 | 均未放权重或 API-only，观望清单 |

---

## 三、速度/质量优化速查（来源：optimization.md）

| 手段 | 适用模型 | 收益 | 代价 | 147 现状 |
| --- | --- | --- | --- | --- |
| 蒸馏/加速 LoRA | 全员（Qwen Lightning、lightx2v、H3 Turbo、Hyper-FLUX 等） | 最大单项收益：50 步→4/8 步，约 4~12×；去 CFG 再省一半 | 4 步档细节/运动略降；8 步档接近原版 | ✅ 弹药充足，缺的是「按模型固化参数配方」 |
| 量化 fp8_scaled / int8_convrot | 全员 | 40/50 系原生 FP8 Tensor Core，最快档；显存减半 | 与 bf16 几乎无差 | ✅ 默认首选，已是现状 |
| 量化 nvfp4 | Blackwell 专属（5060 Ti 满足） | 50 系原生 FP4，实测比 GGUF Q8 快 2×+ | 需 comfy-kitchen/CUDA13 配合（torch 2.10+cu130 已满足） | ⚠️ 增量机会，DiT 侧待试点（Qwen 2.1 / Wan2.2） |
| GGUF Q4_K_M / Q8_0 | 显存不足兜底 | ~4.5/8.5 bpw | 比 fp8 慢（反量化开销） | ✅ Wan2.2-Animate/Qwen2.1 等有 |
| sage attention | 视频、大图（长序列） | Wan 系 1.2~1.5×，质量损失可忽略 | Windows 装 triton+wheel；**Krea2 有 shape bug 需 guard** | ❌ 未开，免费加速没吃到 |
| torch.compile | 长跑批量同一工作流 | 最好 20~30%，高度模型相关 | 首次编译慢 | 入口齐（TorchCompileModel/WanVideoTorchCompileSettings） |
| TeaCache | Wan2.1/2.2、FLUX、LTX | 官方口径无损 2.1×；实测 Wan2.2 每步 4.67s→1.5s | rel_l1_thresh 0.2~0.3 近似无损；use_coefficients 开=稳但几乎不加速 | ✅ WanVideoWrapper 已装可用 |
| QwenImage21Cache | Qwen 2.1 多参考图编辑 | 同批参考图反复编辑省重复编码 | 无损 | ✅ 官方节点两实例都有 |
| 启动参数复查 | 全局 | 去掉反优化 flag | `--disable-smart-memory` 对 16G 通常反优化；`--disable-cuda-malloc` 只在分配报错时才需要；**改动前需向用户确认并实测** | ⚠️ 当前两个 disable flag 都开着 |
| SCAIL-2 DPO LoRA | SCAIL-2 | 手部畸变+唇眼同步改善 | 零 | ✅ 必挂 |
| 图像放大链路标准化 | 全员出图 | 4x-UltraSharp → img2img denoise 0.25~0.35 补细节 | 大图需分块 | ✅ 节点齐 |
| SeedVR2 视频超分 | 视频 | 社区最优视频放大 | 首次自动下载模型；5060 实测有涂抹感 | ✅ 插件已装（3B/7B 下载式） |

---

## 四、官方改写器资产清单（来源：optimization.md 第 3 节）

| 资产 | 源文件 | 后端 | 规则要点 | 策略层复用方式 |
| --- | --- | --- | --- | --- |
| Wan prompt_extend | Wan2.1 repo `wan/utils/prompt_extend.py` | DashScope qwen-plus/qwen-vl-max 或本地 Qwen2.5(VL) | 6 套系统提示词（中英×LM/VL/双图VL）；80~100 字；强调运动与运镜；保留引号书名号原文 | 抄 6 套系统提示词+选模型逻辑，接自有 LLM；也适用 SCAIL-2/WanAnimate |
| Qwen-Image T2I/Edit 改写 | Qwen-Image repo `src/examples/tools/prompt_utils.py`（2512 另有 `prompt_utils_2512.py`） | qwen-plus / qwen-vl-max | T2I <200 词 + magic prompt 拼接；Edit 输出 JSON `{"Rewritten": ...}`，按任务类型分治（文字编辑统一 `Replace "xx" to "yy"` 句式、人像保 ID、上色/修复固定模板） | 抄系统提示词 + Edit JSON 输出协议 |
| Qwen-Image 2.1 PE 权重 | 官方 PE-T2I/PE-I2I（Qwen3.5-VL 9B 微调） | 专用权重 | 任意语言→英文长 prompt（400~500 词）+宽高比建议；系统提示词全文在本地两个 2.1 模板 JSON 里，是**最权威蓝本** | 装 ComfyUI-Prompt-Enhancer（GGUF 路径快约 5×）到 8190，优先级高（未装） |
| Boogu rewriter | Boogu-Image repo `utils/t2i_external_prompt_rewriter.py` | 本地 Qwen3-VL 2B~32B（建议 32B） | **最小改写原则**；版式/图文类反向极致详尽；具名风格只留名称；不主动加相机参数；无否定词；默认中国语境 | 抄原则作通用改写器基线；可复用 147 已有 qwen3vl 权重 |
| SCAIL-2 enhancer | SCAIL-2 repo `prompt_enhancer.py`（wan-scail2 分支） | Gemini（可换任意 OpenAI 兼容 VLM） | 两段式「抽帧 caption → 合成」；输出描述替换已完成后的视频（禁 replace/swap/edit 字样）；英文一段 90~140 词 | 抄两段式结构与两个提示词；前端已有直连 OpenAI 兼容接口模式 |

> ⚠️ **合规警告**：Boogu 官方改写器系统提示词第 14 条含安全合规改写条款，与项目内容创作规范冲突——**复用时必须剔除该条**，按项目规范只作风险提示、不改稿，交给用户决定。Qwen/Boogu 提示词中的合规类条款同理，只提取改写规则。

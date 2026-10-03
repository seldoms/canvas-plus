# win147 ComfyUI 视频生成与放大模型调研（提示词规范 / 官方工作流）

调研目的：为"提示词自动改写/翻译"策略层做模型能力登记。用户只管剧情走向，系统按目标模型的官方规范自动改写、翻译提示词（短剧关键帧 → 视频片段 → 放大成图）。

调研日期：2026-10-03。所有"官方"结论均来自模型官方 GitHub 仓库、ComfyUI 官方模板仓库（Comfy-Org/workflow_templates）与 docs.comfy.org；社区规则单独标注来源。本地技能档案（`/root/.kimi-code/skills/`、`/root/.agents/skills/`）中的实测结论标注为"本地实测"。

官方工作流 JSON 已保存到 `../workflows/`（同目录相对路径），来源 URL 在各节给出。

---

## 1. Wan 2.1 T2V（wan_1.3B / 14B + umt5_xxl + wan_2.1_vae）

### 场景定位
阿里开源视频基座。1.3B 仅需 8.19GB 显存，是 16G 卡上的快速出片/草稿引擎；14B 是画质档。支持 T2V / I2V / FLF2V（首尾帧）/ VACE / T2I，147 上主要用作 T2V 与 I2V（14B GGUF）。

### 语言适配
- 官方明确**中英双语**：文本编码器是 umt5_xxl（多语言 T5），官方称 Wan2.1 是"首个能同时生成中英文画面文字的视频模型"（[Wan2.1 README](https://github.com/Wan-Video/Wan2.1)）。
- 官方 Prompt Extension（提示词扩写）支持 `--prompt_extend_target_lang zh|en`，扩写器系统提示词（`wan/utils/prompt_extend.py`）要求"无论输入什么语言，按目标语言输出"。
- 例外：FLF2V（首尾帧）主要用中文文本-视频对训练，**官方建议用中文提示词**（README 原注）。
- 结论：T2V/I2V 中英皆可；扩写层可直接复用官方系统提示词模板（见下"提示词结构模板"）。

### 负面提示词
**官方默认中文负面串**（`wan/configs/shared_config.py`，ComfyUI 官方模板原样沿用）：

```
色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走
```

Diffusers 示例用的是同义英文版（"Bright tones, overexposed, static, blurred details, subtitles, ..."）。Wan2.2 官方模板在这串后面又追加了"裸露，NSFW"。**要写，且直接用官方串作为默认值**。

### 分辨率/时长/帧率
- 官方档位：480P（832×480）与 720P（1280×720）。1.3B 只支持 480P（720P 能跑但官方明示不稳定）；14B 两档都支持。
- 帧率 16 FPS（`sample_fps=16`），官方示例统一 81 帧（≈5 秒）。帧数需满足 4k+1（VAE 时序压缩 4×）。
- I2V 的 `size` 参数表示画面**面积**，宽高比跟随输入图。
- 文本编码长度上限 `text_len=512`（umt5 token 数）。

### 推荐采样参数
| 来源 | steps | cfg | shift | sampler/scheduler |
|---|---|---|---|---|
| 官方 generate.py（14B T2V） | 50（I2V 40） | 5.0（默认） | 720P=5.0 / 480P=3.0（diffusers flow_shift） | unipc（diffusers UniPCMultistep） |
| 官方 1.3B 建议 | — | **6.0** | 8~12 区间可调 | — |
| ComfyUI 官方模板 `text_to_video_wan.json` | 30 | 6.0 | 8（ModelSamplingSD3） | uni_pc / simple |
| 147 本地实测（NSFW Wan 1.3B） | 30 | 6.0 | 8.0 | uni_pc / simple（81 帧 832×480 约 7 分钟） |

策略层默认：**cfg 6 + shift 8 + uni_pc/simple + 30 步**（1.3B 与 ComfyUI 模板一致）；14B 720P 可升 50 步 cfg 5。

### 提示词结构模板
官方没有"手工模板"，而是提供 **Prompt Extension 机制**（强烈建议开启，`--use_prompt_extend`）：用 Qwen 把用户短句改写成 80–100 字的丰满提示词。改写系统提示词在 `wan/utils/prompt_extend.py`，可直接抄进策略层：

- LM 版（T2V）：`LM_ZH_SYS_PROMPT` / `LM_EN_SYS_PROMPT`；VL 版（I2V）：`VL_*`；首尾帧双图版：`VL_*_FOR_MULTI_IMAGES`。
- 核心规则（官方原文摘要）：① 不改变原意前提下合理补充细节；② 完善主体特征（外貌/表情/数量/种族/姿态）、画面风格、空间关系、**镜头景别**；③ 未指定风格时选最恰当的风格（默认纪实摄影，不随便用插画）；④ 古诗词强调中国古典元素；⑤ **强调运动信息与镜头运镜**；⑥ 给主体加自然动作，用简单直接的动词；⑦ 控制在 80–100 字/词；⑧ 保留引号、书名号内原文不翻译。
- 扩写可用 Dashscope（qwen-plus / qwen-vl-max）或本地 Qwen2.5-14B/7B/3B-Instruct（VL 用 Qwen2.5-VL-7B/3B）——策略层可直接对接。

### 官方工作流
- 本地文件：`workflows/wan21-t2v-official.json`
- 来源：[Comfy-Org/workflow_templates → templates/text_to_video_wan.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/text_to_video_wan.json)（docs.comfy.org 模板库同款）
- 图内含：负面官方中文串、KSampler(30/6.0/uni_pc/simple)、ModelSamplingSD3(shift 8)、832×480×33。
- 备选：同仓库 `image_to_video_wan.json`、`wan2.1_flf2v_720_f16.json`（首尾帧）；ComfyUI 官方示例页 https://comfyanonymous.github.io/ComfyUI_examples/wan/ 。

### 社区硬规则
- 1.3B 不要用 720P（官方 README 明确，非社区）。
- umt5 编码器必须认 ComfyUI 格式：`umt5_xxl_fp8_e4m3fn_scaled_comfyorg.safetensors`（412 张量）才能用，diffusers 格式（243 张量）加载失败——本地实测（comfyui-server-ops/147-wan-t2v-deployment.md）。
- Wan 要**高 cfg（≈6）**，不像 Qwen-Image 那样 cfg 1——本地实测。
- TeaCache 可加速约 2×（官方 README 社区作品栏，ali-vilab/TeaCache）。

---

## 2. Wan 2.2 系列 / Wan2.2-Animate（动作迁移 / 角色动画）

### 场景定位
Wan2.2 引入 MoE 双专家（高噪/低噪各 14B），主打电影级美学标签（灯光/构图/对比度/色调可控）与复杂运动。Animate-14B 是统一的角色动画 + 角色替换模型：给一段驱动视频 + 一张角色参考图，输出角色复刻动作（animation）或把视频里的人换成参考角色（replacement）。147 用于舞蹈/动作复刻。

### 语言适配
沿用 Wan 双语 umt5。但 Animate 场景里**提示词是辅助项**：官方 ComfyUI 模板的示例提示词只有一句 "The character is dancing in the room"——**背景、服装、长相由参考图决定，别指望 prompt 改背景**（本地实测，wananimate-dance-replication 技能）。官方 README 同时警告：**不要给 Wan-Animate 挂 Wan2.2 上训练的 LoRA**，权重变动会导致意外行为。

### 负面提示词
官方 ComfyUI 模板沿用 Wan2.1 中文负面串原文（见 §1）。要写。

### 分辨率/时长/帧率
- 预处理按 `--resolution_area 1280 720` 定面积；ComfyUI `WanAnimateToVideo` 节点宽高**必须是 16 的倍数**（官方模板注）。
- 分段生成：单段 77 帧（`clip_len`），段间用 `refert_num`（默认 1 帧）衔接；diffusers 导出 fps=30，官方 ComfyUI 模板 CreateVideo fps=16。
- 长视频靠复制 Extend 子图串联（官方模板做法）。

### 推荐采样参数
| 来源 | steps | cfg | shift | sampler |
|---|---|---|---|---|
| 官方 diffusers 示例 | 20 | **1.0** | — | 默认 |
| ComfyUI 官方模板（配 lightx2v 4-step 蒸馏 LoRA） | 6 | 1.0 | 8 | euler / simple |
| 5060 本地实测 HQ 档（KJ wrapper，去蒸馏 LoRA） | 20 | 4.0 | — | —（~1h/条） |
| 5060 本地实测 fast 档（lightx2v LoRA 1.2） | 4 | 1.0 | — | 皮肤塑料感明显，已被否决 |

replacement 模式需加官方 Relighting LoRA（`WanAnimate_relight_lora_fp16.safetensors` / `--use_relighting_lora`）让光影融合。

### 提示词结构模板
- 输入 = 驱动视频 + 角色参考图（CLIP vision + ref_images）。预处理官方脚本：`wan/modules/animate/preprocess/preprocess_data.py`（animation 带 `--retarget_flag --use_flux`；replacement 带 `--replace_flag --iterations 3 --k 7 --w_len 1 --h_len 1`），详见官方 [preprocess UserGuider](https://github.com/Wan-Video/Wan2.2/blob/main/wan/modules/animate/preprocess/UserGuider.md)。
- 提示词只需一句话描述"人在做什么"；要换场景/服装**换参考图，不改 prompt**。
- ComfyUI 模板两种模式：Move（姿态迁移，断开 Background_video/Character_mask）/ Mix（角色替换，接上两者），用 SAM2 点选要跟踪的人。

### 官方工作流
- 本地文件：`workflows/wan22-animate-official.json`
- 来源：[Comfy-Org/workflow_templates → templates/video_wan2_2_14B_animate.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_14B_animate.json)；教程 https://docs.comfy.org/tutorials/video/wan/wan2-2-animate
- 图内含：Wan2_2-Animate-14B_fp8 + lightx2v 蒸馏 LoRA + relight LoRA、DWPreprocessor 姿态/人脸提取、SAM2 分割、KSampler(6 步/cfg1/euler/simple)、shift 8。
- Wan2.2 T2V/I2V/TI2V 模板同仓库：`video_wan2_2_14B_t2v.json`（双 KSamplerAdvanced 两段采样：高噪模型 0–2 步、低噪模型 2–4 步，配 lightx2v 4-step 高低噪双 LoRA，cfg 1；无 LoRA 时 20 步 cfg 3.5，shift 5，euler/simple，负面串追加"裸露，NSFW"）、`video_wan2_2_14B_i2v.json`、`video_wan2_2_5B_ti2v.json`。教程：https://docs.comfy.org/tutorials/video/wan/wan2_2

### 社区硬规则
- 官方：**Wan-Animate 勿用 Wan2.2 系 LoRA**（README 原话）。
- 蒸馏 4 步档"一眼假"（皮肤塑料感、光影平），交付默认 20 步 HQ——本地实测（5060）。
- 33 帧滑窗衔接处会闪烁；480p + SeedVR2 超分有涂抹感——本地实测。
- Wan2.2 用户指南（官方钉钉文档，可能需登录）：[中文](https://alidocs.dingtalk.com/i/nodes/jb9Y4gmKWrx9eo4dCql9LlbYJGXn6lpz) / [English](https://alidocs.dingtalk.com/i/nodes/EpGBa2Lm8aZxe5myC99MelA2WgN7R35y)（本次未能抓取正文，仅记录 URL）。

---

## 3. MiniMax H3 本地版（EmptyMiniMaxH3LatentAV / MiniMaxH3ImageToVideo，Comfy-Org 权重）

### 场景定位
全模态视频模型，**视频 + 原生立体声音频联合生成**（人声台词、音效、配乐一次出）。147 主力：短剧视频片段（自拍、对白、情绪戏）。ComfyUI ≥0.30 原生内置 4 节点：`EmptyMiniMaxH3LatentAV`、`MiniMaxH3ImageToVideo`、`MiniMaxH3ReferenceToVideo`、`MiniMaxH3SigmaShift`（PR Comfy-Org/ComfyUI#15224）；≥0.34 另有 `MiniMaxH3AddGuide`（任意帧锚定）。

### 模式
- **T2VA**：纯文本 → 音视频。
- **I2VA / FL2VA / L2VA**：`MiniMaxH3ImageToVideo` 接 `first_frame` / `last_frame`（可只接一个或都接）——首帧 / 首尾帧 / 尾帧。
- **Ref2VA**：`MiniMaxH3ReferenceToVideo`，参考图 ≤9 + 参考视频 ≤3（可自带声轨）+ 参考音频 ≤3；用 `<Picture 1>` `<Video 1>` `<Audio 1>` 标签引用。**R2V 用 `ref2va` 权重，与 T2V/I2V 的 `fl2va` 权重不是同一套**。

### 语言适配
- 官方云端手册：**中文提示词即可**，上限 7000 字符（本地技能档案 minimax-h3-local-prompt，源自官方使用手册）。
- ComfyUI 官方模板的示例提示词为英文；官方改写规范（h3-prompt-writing 技能，源自官方 Prompt Writing Guide）要求**改写正文用英文，台词/歌词/画面文字保留原语言**。
- 策略层建议：叙述层中文输入 → 按官方结构改写（中英均可，字段名固定英文）→ 台词 `<d>[语言] 原文</d>` 不翻译。

### 负面提示词
**没有负面提示词字段**（官方手册明确"负向词：无"）。负向约束必须并进正向句，写"避免/不要 …"（例："避免面部变形、画面模糊、过度磨皮"）；不要 BGM 写 `非叙事性音乐：N/A` / `non_diegetic_music: N/A`。

### 分辨率/时长/帧率
- ComfyUI 官方：原生画布 **768px 短边**（16:9 = 1344×768），分辨率按 32 的倍数取整；模板用 ResolutionSelector 按"总像素 × 宽高比"出档（0.4MP ≈ 864×480@16:9 等）。
- 官方云端档：768p / 1440p（1440p 147 跑不了，高清走超分）。
- 帧率 **24 FPS**；时长吸附 17 帧一块的网格 **17k+5**（5s=124 帧、10s=243 帧、15s=363 帧），官方范围 4–15 秒；16G 卡 5 秒稳档，15 秒易卡死（本地实测）。
- 宽高比支持 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16（竖屏主推 9:16，480×832 / 768×1344）。

### 推荐采样参数
| 来源 | steps | cfg | shift | sampler/scheduler |
|---|---|---|---|---|
| ComfyUI 官方模板（全质量档） | 20（可升 25 改善运动） | 6（模板 PrimitiveFloat 值） | MiniMaxH3SigmaShift | res_multistep / simple |
| 官方 turbo（Lightning LoRA `minimax_h3_fl2v_turbo_8step_v1.0`） | 8 | 1.0 | — | 同上，音质/运动略降 |
| R2V turbo（`ref2v_turbo_4step_v0.1`） | 4 | — | — | — |
| 147 备选加速（本地档案） | v4-600 turbo LoRA（`minimax_h3_turbo_v4_step600_ema`，10s/768p 需 low_vram）；阿里 PDD 8 步 LoRA + PDD-Acc 节点（euler / cfg 1.0 / shift_video=12 / shift_audio=3 / nfe="8" 字符串） |

必备权重（Comfy-Org/MiniMax-H3 再打包）：`minimax_h3_fl2va_pruned_int8_convrot.safetensors`（UNet）、`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`（CLIP，type=minimax）、`minimax_h3_video_vae_int8_convrot.safetensors`、`minimax_h3_audio_vae_fp32.safetensors`。

### 提示词结构模板（官方规范，策略层核心）
**基础模式（T2VA/I2VA/FL2VA/L2VA）**三字段固定顺序（官方 Video Prompt Writing Guide，本地存档 `/root/.agents/skills/h3-prompt-writing/references/base-en.txt`）：

```
[关键帧对齐指令行，I2VA/FL2VA/L2VA 必须有，T2VA 无]

integrated_multimodal_description: [Shot 1] ... [Shot 2] At 00:03.500, the camera cuts to ...
overall_soundscape: ...（1–4 句，环境声+动作声+非语言人声，不含台词）
non_diegetic_music: ...（1–3 句，只有观众能听到的配乐；没有写 N/A）
```

- 关键帧指令行格式（必须为第一行，后空一行）：I2VA=`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`；FL2VA/L2VA 用 `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark ...`（时间精确到两位小数）。
- 镜头运镜官方词表（类型+幅度+速度三维）：Zoom/Push/Pan/Truck/Tilt/Pedestal/Arc/Tracking/Static/Shake/POV/Roll + `with small|large amplitude` + `at slow|fast speed`，写成自然句式而非堆标签。
- 台词：说话人稳定 ID `(S1)(S2)`，内容 `<d>[English] ...</d>` 逐字保留不翻译；画外音必须写 `says in an off-screen voiceover` 且紧跟"嘴唇保持闭合"；跨切镜台词用 `<scenetrans>`，被结尾截断用 `<cutoff>`。
- 画面文字用英文双引号包原文（`A red neon sign reading "营业中"`）。
- **Ref2VA 全参考模式**六段固定顺序：`subject_definitions` → `summary`（带 `[任务类型]` 前缀）→ `retention_analysis`（关系标记 `fully_preserved/partially_preserved/attribute_transfer/weak_reference`，音频 `fully_copy/partially_copy/reference`）→ `detailed_description`（350–500 英文词）→ `overall_soundscape` → `non_diegetic_music`。详见 `/root/.agents/skills/h3-prompt-writing/references/ref-en.txt`。
- 官方中文手册三段式公式（云端口径，可与上面字段结构互换使用）：**参考素材说明 + 核心创意（主体+地点+事件+风格+运镜一句话）+ 画面过程说明（按时间轴分段，每段写"想要/不想要"）**。
- 铁律：少写比喻多写看得见的画面；台词长短与镜头时长对齐；描述总时长必须等于目标视频时长。

### 官方工作流
- 本地文件：`workflows/minimax-h3-t2va-official.json`、`workflows/minimax-h3-i2va-official.json`
- 来源：[video_minimax_h3_t2v.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json)、[video_minimax_h3_i2v.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json)；另有 `video_minimax_h3_r2v.json`、`video_minimax_h3_multiframe_reference.json`、`video_minimax_h3_i2v_continuation.json` 同仓库未下载（需要时可取）
- 教程：https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native
- 注意：模板用 subgraph，**不能原样 POST 到 /prompt**，需先展平（本地实测，SCAIL-2 同理）。

### 社区硬规则
- LoRA 兼容看 safetensors 头：含 `time_embedder` 适配器的只能挂完整版底模；adaln 输入维度 8 = 只能挂 pruned 底模——本地实测判据（minimax-h3-acceleration/h3-asset-compatibility-matrix）。
- ComfyUI 版本墙：≥0.34 才有 AddGuide/embeddings，≥0.35 才支持 DiffSynth/PDD LoRA——升级前按"不支持"处理。
- H3 单次生成不自动硬切镜；多场景拆 2–3 秒段 + ffmpeg 拼接（本地实测）。
- 许可：H3 是 MiniMax H3 Community License（非 Apache），商用/交付前过法务。

---

## 4. SCAIL-2（WanSCAILToVideo + SAM3 跟踪，舞蹈/动作复刻）

### 场景定位
智谱 zai-org 出品，基于 Wan2.1 14B 的端到端角色动画模型（论文 arXiv:2606.10804）：参考角色图 + 驱动视频 → 角色动画（animation）或视频内角色替换（replacement）。相对 Wan2.2-Animate 的优势：抛弃骨架中间表示，用 SAM3 逐人彩色掩码跟踪 + 原生 81 帧分段长视频，5060 实测路线里已取代 WanAnimate 作为舞蹈复刻主力。

### 语言适配
沿用 Wan umt5 双语。官方明确要求：**prompt 描述生成后的视频本身，不是对模型的指令**；替换模式要描述"替换已经发生之后"的画面。**模型用长而详细的提示词训练，短 prompt 能跑但详细描述主体+运动效果更好**（官方 README 原话）。官方模板示例提示词为英文长段（人物发型/服装/场景/交互物全写）。

### 负面提示词
ComfyUI 官方模板中负面 CLIPTextEncode 为**空字符串**（加速档 cfg=1.0 时负面不生效）。非加速档（官方 generate.py 默认 cfg 5.0）可沿用 Wan 中文负面串——官方未给 SCAIL-2 专用负面串，**未找到官方依据**，按 Wan 系惯例处理即可。

### 分辨率/时长/帧率
- 端到端驱动支持 512p 与 704p；姿态驱动在 704p 更好。**宽高都必须是 32 的倍数**（官方 README，如 704×1280）；ComfyUI 教程说 16 的倍数、模板内部按 32 取整。
- 帧长需 ≡1 (mod 4)，官方分段块 = 81 帧；长视频段数 = `ceil(总帧数 / 76)`，段间重叠 5 帧（`previous_frame_count`），**不能自动排队，需逐段提交**（docs.comfy.org 原注）。
- fps 跟随驱动视频（官方模板 CreateVideo 30fps / 本地 16fps 均可）。

### 推荐采样参数
| 来源 | steps | cfg | shift | solver |
|---|---|---|---|---|
| 官方 generate.py 默认 | 40 | 5.0 | 3.0 | unipc（可选 dpm++） |
| 官方 + lightx2v 蒸馏 LoRA | 8 | 1.0 | 1.0 | — |
| ComfyUI 官方模板（lightx2v rank64 @0.8 + 官方 DPO LoRA @1.0） | 6 | 1.0 | 5.0 | euler / simple |

官方 **DPO LoRA**（`wan2.1_SCAIL_2_DPO_lora_bf16`）改善手部畸变与唇眼同步，建议常开；替换模式另有官方 Relighting LoRA。

### 提示词结构模板
- 四路输入：`--image`（参考图）+ `--mask_image`（参考图前景掩码）+ `--pose`（驱动/姿态视频）+ `--mask_video`（逐帧驱动掩码）。
- **掩码语义是核心输入**（官方）：黑=此处背景不可见；白=此处背景可见；彩色=角色区域与驱动动作的对应关系。掩码错了，动画模式会退化成替换行为。
- 替换模式 prompt 要写：替换角色的可见服装与外貌 + 角色交互/贴近的物体（工具、乐器、桌椅、车辆、门、手持物）。
- 官方自带 `prompt_enhancer.py`（基于 Gemini）：把一句替换指令扩成长英文正向描述（采样视频帧 + 参考图 + few-shot `prompt_examples.txt`）——正是策略层可复用的官方改写器思路。
- SAM3 跟踪文本（默认 "human"）控制跟踪谁，**与生成 prompt 无关**；视频与参考图主体相同时用同一个词。

### 官方工作流
- 本地文件：`workflows/scail2-character-replacement-official.json`
- 来源：[Comfy-Org/workflow_templates → templates/video_wan21_scail2_character_replacement.json](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan21_scail2_character_replacement.json)（另有 `_int8` 变体）；教程 https://docs.comfy.org/tutorials/video/zai/scail2
- 权重：`wan2.1_14B_SCAIL_2_fp16.safetensors` + `Wan2_1_VAE_bf16` + `umt5_xxl_fp8_e4m3fn_scaled` + `clip_vision_h` + `sam3.1_multiplex_fp16`（放 checkpoints/）+ 两个 LoRA。节点全部 ComfyUI ≥0.30 内置（`WanSCAILToVideo`、`SCAIL2ColoredMask`、`SAM3_VideoTrack`）。

### 社区硬规则
- 子图模板不能 POST /prompt，需展平成原子图；已验证的原子图见本地档案 `comfyui-server-ops/references/5060-scail2-motion-transfer.md`（含接线坑：SAM3 文本条件要接同一个 CLIPLoader，LoRA 子目录名要带前缀）。
- 多参考（multi-reference）是零样本能力，官方明示画质可能下降；把参考图"伪装成视频"可减损（社区 wuwukasi/iceage，WanAnimatePlus / CustomNodeKit）。
- 147/5060 选型结论（本地实测）：Wan2.2-Animate 两档均被用户否决（"效果都很差"），SCAIL-2 为当前主力；输出质量仍待逐帧验收。

---

## 5. 4x-UltraSharp（放大）

### 用途与定位
社区 ESRGAN 架构 4× 放大模型（64nf23nb，2021 年发布，OpenModelDB 上最经典的真人/写实放大器之一）：https://openmodeldb.info/models/4x-UltraSharp 。基于 4xESRGAN 预训练，用大量真实照片（含 JPEG 压缩退化）训练，**擅长修复 JPEG 压缩、留下锐化纹理**。**许可 CC-BY-NC-SA-4.0（非商用）**，商用交付需换模型或取得授权——策略层登记时必须标注。

### 用法（ComfyUI）
标准链路：`UpscaleModelLoader(4x-UltraSharp.pth)` → `ImageUpscaleWithModel` → `ImageScale`（lanczos 缩到目标尺寸）。视频逐帧：`GetVideoComponents` → 同上 → `CreateVideo`（官方模板 `utility-gan_upscaler.json`，已存 `workflows/upscale-model-official.json`，模板默认用 RealESRGAN_x4plus，换成 4x-UltraSharp 即可）。

### 局限
- GAN 放大**只提锐度和纹理、不补语义细节**（官方模板注："can't create new detail like diffusion can"）。要"重绘细节"需放大后再过一遍低 denoise img2img（本地实测配方：4x-UltraSharp → ImageScale 1536×2688 → VAEEncode → KSampler denoise 0.35，脸和构图不动、细节重绘）。
- 768p H3 出片 → 4× 到 3072 短边过大，通常 4× 后 ImageScale 回 1440p/1080p 目标档。
- 要"真补细节"的视频超分，社区主线是 SeedVR2（扩散式，模板仓库有 `utility_seedvr2_video_upscale.json`），5060 实测有涂抹感，按需选型。

---

## 6. 其他已装资产（147 / 5060 档案记录，不深究）

以下来自本地技能档案的部署记录，**以 147 实际模型目录为准**：

| 资产 | 位置/形态 | 用途与备注 |
|---|---|---|
| `z_image_turbo_bf16.safetensors` + `wenzhiyu_woman_zimage_turbo-1.safetensors` LoRA | diffusion_models + loras | Z-Image Turbo 文生图（定妆照管线已验证：8 步 / cfg 1.0 / dpmpp_sde / shift 3.0 / ConditioningZeroOut 负向，触发词 `wenzhiyu_woman,`）。注：Z-Image NSFW 版在用户登记信息中，档案未记细节 |
| `wan_1.3B_exp_e14.safetensors`（NSFW-API/NSFW_Wan_1.3b） | diffusion_models | NSFW Wan 1.3B，官方作者强推 e14（e1–e10 有解剖崩坏）；仓库附 5MB `prompting-guide.json`（1268 类提示词词汇表，已归档 `/root/feishu_white_lab/nsfw_wan_prompting_guide.json`）。同系还有作者微调的 `NSFW-Wan-UMT5-XXL` 编码器（未装） |
| `wan2.1-i2v-14b-480p-Q4_K_M.gguf` | diffusion_models | Wan2.1 I2V 14B 480p GGUF 档 |
| `wan2.1_14B_SCAIL_2_fp8_scaled.safetensors` + DPO LoRA + lightx2v rank64 + `sam3.1_multiplex_fp16` | 见 §4 | SCAIL-2 全套 |
| `Wan2_2_Animate_14B_Q4_K_M.gguf` | diffusion_models | Wan2.2-Animate GGUF 档 |
| MiniMax H3 全套（fl2va pruned int8、qwen3vl nvfp4、视频/音频 VAE、turbo v4-600、PDD 8 步 LoRA） | 见 §3 | H3 主力栈 |
| `umt5_xxl_fp8_e4m3fn_scaled_comfyorg.safetensors`、`wan_2.1_vae.safetensors`、`clip_vision_h.safetensors` | text_encoders / vae / clip_vision | Wan 系共享件；umt5 只有 comfyorg 版能用 |
| `4x-UltraSharp.pth` | upscale_models | 见 §5 |
| SeedVR2（3b/7b int8，模板仓库有对应官方模板） | — | 视频/图像扩散式超分备选 |

---

## 附：本次保存的官方工作流清单

| 本地文件 | 来源 URL |
|---|---|
| `workflows/wan21-t2v-official.json` | https://github.com/Comfy-Org/workflow_templates/blob/main/templates/text_to_video_wan.json |
| `workflows/wan22-animate-official.json` | https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_14B_animate.json |
| `workflows/minimax-h3-t2va-official.json` | https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json |
| `workflows/minimax-h3-i2va-official.json` | https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json |
| `workflows/scail2-character-replacement-official.json` | https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan21_scail2_character_replacement.json |
| `workflows/upscale-model-official.json` | https://github.com/Comfy-Org/workflow_templates/blob/main/templates/utility-gan_upscaler.json |

未下载但已定位的备选模板（同仓库 `templates/` 下）：`image_to_video_wan.json`、`wan2.1_flf2v_720_f16.json`、`video_wan2_2_14B_t2v.json` / `_i2v.json` / `video_wan2_2_5B_ti2v.json`、`video_minimax_h3_r2v.json`、`video_minimax_h3_multiframe_reference.json`、`video_wan21_scail2_character_replacement_int8.json`、`utility_seedvr2_video_upscale.json`。

注意：H3 / SCAIL-2 / Wan2.2-Animate 官方模板均含 **subgraph 节点，不能原样 POST 到 /prompt API**，策略层落地时需先展平（本地已有 SCAIL-2 展平验证图可参照）。

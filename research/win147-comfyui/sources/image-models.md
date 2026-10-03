# Krea2 / FLUX.1-dev / Z-Image / Boogu 提示词规范与工作流调研

> 用途：win147 ComfyUI 模型能力登记，支撑"提示词自动改写/翻译"策略层设计。
> 调研日期：2026-10-03。所有结论均标注来源；查不到官方依据的明确标注。
> 官方工作流 JSON 已保存到 `../workflows/`，均为 Comfy-Org/workflow_templates 官方模板。

---

## 一、Krea 2 / Krea 2 Turbo（krea2_turbo_fp8_scaled + qwen3vl_4b，CLIPLoader type=krea2，VAE qwen_image_vae）

### 场景定位
Krea AI 从零训练的 12.9B DiT 美学向文生图模型，Krea 2 Community License（非 Apache，商用需读许可证文本）。RAW（52 步基座，供训练/微调）与 Turbo（8 步蒸馏，供推理）成双设计，官方口号 **"TRAIN on Raw and RUN on Turbo"**。主打风格多样性与美学质量，Artificial Analysis 独立实验室文生图第一。([krea-ai/krea-2 GitHub](https://github.com/krea-ai/krea-2))

### 语言适配
- 官方 prompting 指南要求**自然语言整句**（"natural language prompts"），长而详细的提示词效果最好，但短提示词也能出好图。([krea-2/docs/prompting.md](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md))
- 官方示例全部为英文；文本编码器是 Qwen3VL-4B 视觉语言模型（多语言能力理论上存在），但**官方未声明中文提示词支持，中文表现未找到官方依据**。
- 官方提供 `expansion.txt` 作为 LLM 提示词扩写的 system prompt，可接入任意 LLM 做 prompt enhance（ComfyUI 官方模板里也内置了 `prompt_enhance` 开关 + `LLM_max_token`）。([krea-2/docs/prompting.md](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)、[ComfyUI Krea-2 教程](https://docs.comfy.org/tutorials/image/krea/krea-2))

### 负面提示词策略
- **Turbo 官方参数是 `--steps 8 --cfg 0.0`（CFG 完全关闭），负面提示词无效**；RAW 用 `--steps 52 --cfg 3.5`，可用负面。([krea-ai/krea-2 README](https://github.com/krea-ai/krea-2))
- ComfyUI 官方模板 KSampler 固定 `steps=8, cfg=1, euler/simple`（cfg=1 时负面不生效，与官方 cfg=0.0 等价）。（本地 `workflows/krea2-turbo-official.json`）
- 社区方案：**ComfyUI-Krea2-NAG**（Normalized Attention Guidance 节点，iljung1106，2026-08 发布），在注意力空间恢复 Turbo 的负面控制能力，是目前唯一有据可查的"Turbo 负面"路线。([comfyui-wiki 报道](https://comfyui-wiki.com/news/2026-08-10-comfyui-krea2-nag))

### 分辨率与宽高比
- Turbo 官方支持 **1K~2K**（`--width/--height` 1024~2048，自动向上 pad 到 16 的倍数）；RAW 只训练到 1K。([krea-ai/krea-2 README](https://github.com/krea-ai/krea-2))
- ComfyUI 模板用 ResolutionSelector，1K~2K 任选，megapixels=2.0 即 2K。
- 社区共识：模型在 2048×2048 上训练，**先出 1024 再放大等于浪费能力**，直接原生 2K 出图。([instasd Krea 2 提示词指南](https://www.instasd.com/post/krea-2-prompt-and-style-guide-comfyui))

### 推荐参数
| 项 | 官方值 | 来源 |
|---|---|---|
| Turbo steps / cfg | 8 / 0.0（ComfyUI 里 cfg=1） | GitHub README、官方模板 |
| Turbo timestep-shift mu | **1.15**（`--mu 1.15`，官方明确推荐） | GitHub README |
| RAW steps / cfg | 52 / 3.5 | GitHub README |
| 采样器/调度器 | euler / simple（官方模板） | 本地模板 JSON |

### 画面内文字渲染
- 官方唯一建议：**给要渲染的文字加英文引号**（"putting quotes around the words to be rendered"）。([krea-2/docs/prompting.md](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md))
- 社区评价：图中文字能力介于 SDXL 和 Ideogram 之间，招牌级可用，海报标题级不可靠。([instasd](https://www.instasd.com/post/krea-2-prompt-and-style-guide-comfyui))

### 官方工作流
- 本地文件：`workflows/krea2-turbo-official.json`（模板名 `image_krea2_turbo_t2i`，含 Turbo 文生图 subgraph + ResolutionSelector + 9 个官方风格 LoRA 选择器）
- 来源：https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_krea2_turbo_t2i.json ；教程 https://docs.comfy.org/tutorials/image/krea/krea-2
- 另有风格参考模板 `image_krea2_turbo_int8_image_style_reference`（1~2 张风格参考图，用 int8_convrot + krea2_style_reference LoRA），本次未下载，可按需补。

### 社区硬规则
- **不要用 CLIP 时代的关键词条 + `(word:1.2)` 权重语法**：Qwen3VL 把整句当语言读，单词加权会扰乱整个 conditioning，超过 1.2 画面就崩。替代做法：语序前置（先说最重要的）、同义复述代替加权、用具体词汇（"oxblood" 而非 "red" 1.5）。([instasd](https://www.instasd.com/post/krea-2-prompt-and-style-guide-comfyui))
- 提示词公式：主体 + 一个动作 + 光源描述 + 一两个质感词，像"在电话里向人描述一张成片"。
- 9 个官方风格 LoRA 必须带**触发词**（与文件名不对应，例如 softwatercolor → `art deco watercolor style`），且提示词其余部分只写内容不要再写风格词，否则与 LoRA 打架。触发词表见 [ComfyUI 教程](https://docs.comfy.org/tutorials/image/krea/krea-2)。
- FP8 对 16GB 卡是甜点；BF16→FP8 画质损失几乎不可见，INT4 会损细节。([instasd](https://www.instasd.com/post/krea-2-prompt-and-style-guide-comfyui))

---

## 二、FLUX.1-dev（flux1-dev-fp8 / flux1-dev，DualCLIPLoader clip_l + t5xxl，type=flux，VAE ae.safetensors）

### 场景定位
Black Forest Labs 2024 年发布的 12B rectified-flow 基础模型，非商用许可（dev）。老牌通用文生图底座，生态最大（LoRA/ControlNet/Redux/Fill/Kontext 全套），画质与 prompt 遵循至今仍是开源基准参照。

### 语言适配
- **官方推荐英文**。BFL 官方 prompting 文档全部以英文撰写；对多语言的官方表态仅见于 FLUX.2（"可以多语言提示，但英文最精确"），FLUX.1 未找到官方多语言依据，中文提示词表现无官方背书。([BFL Prompt Reference](https://docs.bfl.ai/guides/prompting_unified_reference))
- 文本编码器为 clip_l + t5xxl 双编码器，T5 有一定多语言能力，但社区共识是英文远优于其他语言。

### 负面提示词策略
- **官方明确反对负面提示词**："Avoid negative prompts. FLUX responds to what you describe, not a list of what to avoid."（[BFL Prompt Tips](https://docs.bfl.ai/guides/prompting_summary)）
- 机制上 FLUX.1-dev 是 guidance-distilled 模型：ComfyUI 里 KSampler cfg=1，负面条件不生效。ComfyUI 官方模板直接用 `ConditioningZeroOut` 把负面清零，消极条件完全弃用。（本地 `workflows/flux1-dev-official.json`）

### 分辨率与宽高比
- BFL API（/v1/flux-dev）官方边界：**宽高 256~1440 像素，必须是 32 的倍数**，默认 1024×768。([BFL OpenAPI](https://api.bfl.ai/openapi.json))
- 甜点总量约 1MP；ComfyUI 本地可超 1440，但偏离训练分布越远构图越差（社区共识，无官方上下限声明）。

### 推荐参数
| 项 | 官方值 | 来源 |
|---|---|---|
| steps | API 默认 **28**；ComfyUI 官方模板 **20** | BFL OpenAPI、本地模板 |
| guidance | API 默认 **3.0**（范围 1.5~10，官方注明"高 guidance 提升遵循度但降低真实感"）；ComfyUI 社区惯例 FluxGuidance=**3.5** | BFL OpenAPI、ComfyUI 社区 |
| cfg（KSampler） | 1（负面失效） | 官方模板 |
| 采样器/调度器 | euler / simple（官方模板） | 本地模板 JSON |
| prompt_upsampling | API 有官方开关（默认关），自动扩写提示词 | BFL OpenAPI |

### 画面内文字渲染
- 官方写法：**用引号包裹要渲染的精确文字**，并描述字体特征（粗细、大小写、颜色、对齐）。([BFL Prompt Tips](https://docs.bfl.ai/guides/prompting_summary)："Quote rendered text. Use exact quoted strings for typography, labels, posters, and signs.")
- 官方提示：文字描述前置、文字内容保持短，长字符串渲染准确率低。([BFL Prompt Reference](https://docs.bfl.ai/guides/prompting_unified_reference))
- FLUX.1 的文字能力一般（明显弱于 FLUX.2/Qwen-Image/Z-Image），海报级排版不是它的强项——这是社区共识，官方未给 FLUX.1 文字渲染指标。

### 官方工作流
- 本地文件：`workflows/flux1-dev-official.json`（模板名 `flux_dev_full_text_to_image`："Generate high-quality images with Flux Dev full version"，subgraph 内含 UNETLoader flux1-dev.safetensors + DualCLIPLoader clip_l/t5xxl_fp16 type=flux + VAELoader ae.safetensors + EmptySD3LatentImage 1024×1024 + KSampler 20步/cfg1/euler/simple + ConditioningZeroOut）
- 来源：https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/flux_dev_full_text_to_image.json
- win147 上的 `flux1-dev-fp8` 单文件版对应另一官方模板 `flux_dev_checkpoint_example`（"fp8 量化版，单模型文件，画质略低于完整版"），需要时可从同一仓库下载。

### 社区硬规则
- 提示词写法官方四件套：**主体前置（front-load the subject）、写光线（golden hour / overcast diffused studio light）、颜色用 hex（`#FF6B6B (coral pink)`）、文字加引号**。([BFL Prompt Tips](https://docs.bfl.ai/guides/prompting_summary))
- 摄影感关键词有官方 cheat sheet：相机/胶片型号（"shot on Kodak Portra 400"、"Sony A7IV"）、镜头焦段（85mm 人像、24mm 广角）、光圈（f/1.4 浅景深）。([BFL Prompt Reference](https://docs.bfl.ai/guides/prompting_unified_reference))
- BFL 官方 agent skill `flux-image-best-practices`（github.com/black-forest-labs/skills）系统讲解 prompt 结构、光线词汇、hex 颜色、排版及"为什么 FLUX 不用负面提示词"，可直接作为改写策略层的规则来源。([black-forest-labs/skills](https://github.com/black-forest-labs/skills))
- 社区惯例：dev 出图步数 20~28，guidance 3.5 附近微调；过高 guidance 过饱和、过低发灰。

---

## 三、Z-Image Turbo / Z-Image base（z_image_turbo_bf16 + qwen_3_4b，CLIPLoader type=lumina2，VAE ae.safetensors）

### 场景定位
阿里通义实验室 6B 单流 DiT（S3-DiT），Apache-2.0 可商用。Turbo 经 Decoupled-DMD + DMDR 蒸馏，**8 NFE** 亚秒出图，16GB 显存可跑 bf16 全量。主打照片级真实感、**中英双语文字渲染**、指令遵循。base（50 步、支持 CFG）用于微调与高多样性场景。([Tongyi-MAI/Z-Image-Turbo 模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo)、[Tongyi-MAI/Z-Image GitHub](https://github.com/Tongyi-MAI/Z-Image)、技术报告 arXiv:2511.22699)

### 语言适配
- **官方双语：中文、英文提示词均可直接用**，模型卡明确写 "bilingual text rendering (English & Chinese)" 与 "robust instruction adherence"，编辑变体也支持双语编辑指令。([模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo))
- 官方提供 Prompt Enhancer（带推理能力的提示词扩写器）配套使用。([模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo))

### 负面提示词策略
- **Turbo：官方 diffusers 示例 `guidance_scale=0.0` 并注明 "Guidance should be 0 for the Turbo models"——负面提示词无效**；模型 zoo 表格中 Turbo 的 CFG 列为 ❌。([模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo))
- **base（Z-Image）：CFG ✅，官方明确支持"effective negative prompting"**，50 步。([模型卡 Model Zoo 表](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo))base 的具体推荐 cfg 数值未找到官方依据。
- 注意排雷：有中文社区文章（CSDN）声称给 Turbo 加中文负面词库可降低失败率——cfg=1/0 时负面串在机制上不参与计算，该说法**无官方依据且与机制矛盾**，不要采信。([反例来源](https://blog.csdn.net/weixin_35899324/article/details/157576176))

### 分辨率与宽高比
- 官方示例固定 1024×1024；官方未给明确上下限（未找到官方依据）。
- 社区实测：**原生支持到 4MP（2048×2048）**，常用比例 1:1、16:9、9:16、4:3、3:4，建议 32 倍数对齐。([知乎量化版指南](https://zhuanlan.zhihu.com/p/1992160609542895003))
- ComfyUI 侧需要 `ModelSamplingAuraFlow`（shift=3）节点做 timestep shift，官方模板已内置。

### 推荐参数
| 项 | 值 | 来源 |
|---|---|---|
| Turbo steps | diffusers 写 9（实际 8 次 DiT 前向）；ComfyUI 模板 **8** | 模型卡、本地模板 |
| Turbo guidance/cfg | **0.0 / 1（负面失效）** | 模型卡、本地模板 |
| Turbo 采样器/调度器 | **res_multistep / simple**（官方模板）；社区也常用 euler / simple、beta | 本地模板、社区 |
| Turbo shift | ModelSamplingAuraFlow **shift=3** | 本地模板 |
| base steps / CFG | 50 / 支持（数值未找到官方依据） | 模型卡 Model Zoo |

### 画面内文字渲染
- **中英双语文字渲染是官方主打卖点**："excels at accurately rendering complex Chinese and English text"，官方有专门 showcase。([模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo))
- 写法建议：与同类 VLM 编码器模型一致，引号包裹目标文字 + 描述字体/颜色/位置；中文文字直接写中文。官方 demo 示例提示词即包含中文地标文字（"西安大雁塔"）。

### 官方工作流
- 本地文件：`workflows/z-image-turbo-official.json`（模板名 `image_z_image_turbo`，qwen_3_4b + z_image_turbo_bf16 + ae.safetensors，subgraph 内含 ModelSamplingAuraFlow shift=3 + KSampler 8步/cfg1/res_multistep/simple）
- 来源：https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_z_image_turbo.json ；教程 https://docs.comfy.org/tutorials/image/z-image/z-image-turbo
- 另有官方模板：base 版 `image_z_image`、Turbo Fun Union ControlNet（Canny/HED/Depth/Pose/MLSD 五合一）、Turbo 2K 放大器，需要时可从同一仓库下载。

### 社区硬规则
- Turbo 参数不要动：steps 8（可接受 6~11）、cfg 锁 1.0，官方模板默认值就是最优解，"没有什么需要挖的神奇组合"。([Laser Lloyd 实测](https://www.laserlloyd.com/zh/projects/local-ai-image-generation-on-amd-comfyui-z-image/))
- 中文提示词直接写，无需翻译；风格词、构图词中英文混写均可。([zimageturbo.pro FAQ](https://zimageturbo.pro/))
- 训练 LoRA 用 base/De-Turbo（10~15 步），推理用 Turbo——与 Krea 2 的 RAW/Turbo 分工同构。([zimage.run De-Turbo 指南](https://zimage.run/zh/blog/zi-062-de-turbo-model-en-20260527))
- 16GB 显存可直接跑 bf16；更低显存走 FP8/GGUF。([模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo))

---

## 四、Boogu（boogu_image_edit_int8_convrot / boogu_image_turbo_fp8_scaled + qwen3vl_8b，CLIPLoader type=boogu，VAE ae.safetensors，TextEncodeBooguEdit 节点）

### 场景定位
Apache-2.0 开源 **10B 统一理解-生成模型族**（研究项目，非正式产品发布）：Base（文生图基座）、Turbo（4 步蒸馏文生图，默认推荐）、Edit（指令式图编）、Edit-Turbo（4 步图编）。卖点：照片级写实 + **中英双语文字渲染**（海报/票据/文档/界面等密集排版）+ 指令编辑（含图内文字增删改）。注意官方 FAQ：任何以 Boogu 名义收费的服务均为假冒。([boogu-project/Boogu-Image GitHub](https://github.com/boogu-project/Boogu-Image)、技术报告 arXiv:2607.13125)

### 语言适配
- **官方双语：中文、英文提示词/编辑指令均可**，官方 README 的 T2I 示例直接就是中文长提示词（国风琉金山水画）；文字渲染明确只优化了中英，其他语言会明显退化。([Boogu-Image README](https://github.com/boogu-project/Boogu-Image))
- 官方提供 prompt rewriter（基于 Qwen3-VL-32B 的 instruction reasoner），有独立外置与 pipeline 集成两种用法（`utils/t2i_external_prompt_rewriter.py`、`demo_scripts/*reasoning*`），与我们的"改写策略层"思路同构，可参考。

### 负面提示词策略
- **Edit / Base 支持负面提示词**：模型 zoo 给出 CFG 2.0~5.0（Base 例 4.0、Edit 例 5.0），25~50 步；ComfyUI 的 `TextEncodeBooguEdit` 节点第二输入就是负面串（官方模板中留空 `""`）。([Boogu-Image README Model Zoo](https://github.com/boogu-project/Boogu-Image)、本地 `workflows/boogu-edit-official.json`)
- **Turbo / Edit-Turbo 为 4 步蒸馏，CFG=1.0，负面无效**。([Boogu-Image README](https://github.com/boogu-project/Boogu-Image))
- 官方 ComfyUI Edit 模板实测参数：SamplerCustom **cfg=3.5**、dpmpp_2m、BasicScheduler simple **25 步**、ModelSamplingAuraFlow shift=3.16。

### 分辨率与宽高比
- 官方档位：**1K / 1.5K / 2K**；Turbo 只支持 **1K**；Base/Edit 支持 1K~2K 但 **Edit 在 1K 更稳定**（官方原话 "results are more stable at 1K"）。([Boogu-Image README](https://github.com/boogu-project/Boogu-Image))
- 官方支持宽高比：1:1, 2:3, 3:2, 3:4, 4:3, 1:2, 2:1, 9:16, 16:9。
- 官方建议：**密集/超密集文字渲染任务用 Base + 2K 输出**，排版保真与字符准确率最好；写实摄影默认用 Turbo。([Boogu-Image README 场景对比表](https://github.com/boogu-project/Boogu-Image))
- ComfyUI Edit 官方模板把 latent 画布匹配到输入图尺寸（保持构图），Resize 节点旁注明可调到 4MP 但取决于显存。

### 推荐参数
| 变体 | steps | CFG | 来源 |
|---|---|---|---|
| Turbo（T2I） | 3~4 | 1.0 | 官方 Model Zoo |
| Edit-Turbo | 4 | 1.0 | 官方 Model Zoo |
| Base（T2I） | 25~50 | 2.0~5.0（例 4.0） | 官方 Model Zoo |
| Edit（TI2I） | 25~50 | 2.0~5.0（例 5.0）；ComfyUI 模板 cfg=3.5、25步、dpmpp_2m/simple、shift=3.16 | 官方 Model Zoo、本地模板 |
| Turbo ComfyUI 模板 | 4 | 1 | lcm / sgm_uniform（本地 `boogu-turbo-official.json`） |

已知问题（官方自报）：Turbo 曾有不同宽高比视觉伪影、背景过拟合，2026-06-25 hotfix 权重已修；Edit-Turbo 初版有画质退化与移除类任务差的问题，2026-07-08 hotfix（推荐 1K checkpoint）。

### 画面内文字渲染
- **双语文字渲染是官方核心卖点**，且支持**图内文字的精细编辑**（中英文字符替换/新增/删除，字体/字重/颜色/版式适配）。([Boogu-Image README](https://github.com/boogu-project/Boogu-Image))
- 官方能力分级：简单文字渲染 Turbo ⭐⭐⭐⭐ / Base ⭐⭐⭐⭐；密集文字渲染 Turbo ⭐⭐⭐ / Base ⭐⭐⭐⭐（对比 Z-Image-Turbo 密集文字只有 ⭐⭐）。
- 官方限制声明：长文本、密集排版、小字号、复杂版面仍会错字/缺字/版式漂移。
- 写法建议：编辑指令用自然语言直接描述改动（官方模板示例："remove the hat"、"Keep the character unchanged, replace the desert background..."），要渲染的文字建议加引号（与 Qwen3VL 系惯例一致，官方未明文规定）。

### 官方工作流
- 本地文件：
  - `workflows/boogu-edit-official.json`（模板名 `image_boogu_image_0_1_edit`，fp8 版 Edit 图编，含 TextEncodeBooguEdit）
  - `workflows/boogu-edit-int8-official.json`（模板名 `image_boogu_image_0_1_edit_int8`，**与 win147 的 int8_convrot 权重完全对应**，参数同上）
  - `workflows/boogu-turbo-official.json`（模板名 `image_boogu_image_0_1_turbo_t2i`，4 步 lcm/sgm_uniform，含 rank-128 LoRA `boogu_image_turbo_lora_rank_128_bf16`，注意 Turbo 必须挂这个 LoRA）
- 来源：https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/ （对应文件名见上）；教程 https://docs.comfy.org/tutorials/image/boogu/boogu-image-0.1 ；节点文档 https://docs.comfy.org/built-in-nodes/TextEncodeBooguEdit
- 原生支持 PR：Comfy-Org/ComfyUI#14523；模型文件仓库 huggingface.co/Comfy-Org/Boogu-Image。旧自定义节点仓库 boogu-project/ComfyUI-Boogu 已标记 legacy，不要再用。

### 社区硬规则
- Edit 工作流保持输入图原始宽高比/尺寸作为 latent 画布，否则构图会变。([runcomfy Boogu Edit 工作流解析](https://www.runcomfy.com/comfyui-workflows/boogu-image-edit-comfyui-workflow-instruction-guided-image-editing))
- Edit 目前只支持 **1 张参考图**（官方："Only support 1 reference image for now"）。
- 官方自报短板（改写策略层应规避的场景）：需要真实世界知识（品牌/名人/地标）的生成、严格保持主体一致性的 in-context 编辑（落后 Seedream 5.0 / Nano Banana Pro）、复杂姿势下的人体结构、小人脸/小四肢（因使用 FLUX.1 VAE，重建损失大）。([Boogu-Image README Limitations](https://github.com/boogu-project/Boogu-Image))
- 显存：16GB 需 `--enable_model_cpu_offload_flag`（量化版），ComfyUI 侧直接用 fp8/int8 权重即可。

---

## 附：改写策略层速查表

| 模型 | 提示词语言 | 负面提示词 | 分辨率 | 核心参数 | 图中文字 |
|---|---|---|---|---|---|
| Krea 2 Turbo | 英文自然语言整句（官方）；中文无官方依据 | ❌（cfg=0/1；社区 NAG 节点可恢复） | 1K~2K，16 倍数，mu=1.15 | 8 步 euler/simple | 引号包裹；招牌级可用 |
| FLUX.1-dev | 英文（官方） | ❌（官方明确反对；cfg=1） | 256~1440，32 倍数，~1MP | 20~28 步，guidance 3.0~3.5，euler/simple | 引号+字体描述；能力一般 |
| Z-Image Turbo | **中英双语（官方）** | ❌ Turbo；✅ base（50步 CFG） | 1024 起，社区实测到 2048² | 8 步 cfg=1 res_multistep/simple shift=3 | **官方主打，中英皆强** |
| Boogu Edit/Turbo | **中英双语（官方）** | ✅ Edit（cfg 2~5，模板 3.5）；❌ Turbo | 1K/1.5K/2K；Turbo 仅 1K；Edit 1K 最稳 | Edit 25~50 步 dpmpp_2m；Turbo 4 步 lcm | **官方主打，支持图内文字编辑** |

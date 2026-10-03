# Qwen-Image 系列模型提示词规范与工作流调研

> 用途：win147 ComfyUI 模型能力登记，支撑"提示词自动改写/翻译"策略层设计。
> 调研日期：2026-10-03。所有结论均标注来源；查不到官方依据的明确标注。

---

## 一、Qwen-Image（基础文生图，20B MMDiT，qwen_image_fp8_e4m3fn + qwen_2.5_vl_7b）

### 场景定位
系列首个文生图基础模型，20B MMDiT，Apache 2.0。核心卖点是**复杂多语言文字渲染**（中/英/日/韩等，尤其中文）和海报、PPT、招牌等排版敏感场景。([QwenLM/Qwen-Image](https://github.com/QwenLM/Qwen-Image))

### 语言适配
- 官方明确支持中英日韩意等多语言提示词，**中英文均可直接用**，中文表现是官方主打强项。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image)："currently, it supports at least English, Chinese, Korean, Japanese, Italian, etc.")
- 官方 README 提供**按语言区分的 magic suffix**：英文提示词追加 `, Ultra HD, 4K, cinematic composition.`，中文提示词追加 `, 超清，4K，电影级构图.`（即 `positive_magic["en"]` / `positive_magic["zh"]`）。([QwenLM/Qwen-Image README](https://github.com/QwenLM/Qwen-Image))
- 官方建议对短提示词使用官方 Prompt Enhancement 工具（Qwen-Plus 改写，`tools/prompt_utils.py` 的 `rewrite()`），支持多语言输入。([QwenLM/Qwen-Image README - Prompt Enhance](https://github.com/QwenLM/Qwen-Image))

### 负面提示词策略
- **官方 diffusers 示例中负面提示词就是一个空格** `" "`，注释明确写 "Recommended if you don't use a negative prompt."——即官方基线路径基本不用负面提示词，但 `true_cfg_scale` 默认 **4.0**（此时负面串理论上参与计算）。([QwenLM/Qwen-Image README](https://github.com/QwenLM/Qwen-Image))
- ComfyUI 官方模板里负面框留空（`''`），模板默认 cfg 走 4（原始路径）或 1（Lightning LoRA 路径）。（见本地 `workflows/qwen-image-t2i-official.json`）
- 注意：后继版本 Qwen-Image-2512 官方给出了一条**固定中文负面串**：`低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。` 可作为 Qwen 家族写实人像负面词的官方参考模板。([QwenLM/Qwen-Image README - 2512 示例](https://github.com/QwenLM/Qwen-Image))
- 社区实测：cfg=1（Lightning 蒸馏路径）时负面提示词完全不生效；即便 cfg=4 其对内容的排除作用也偏弱，更多影响质感。([PromptMaster: The Mystery of Qwen-Image's Ignored Negative Prompts](https://blog.promptmaster.pro/posts/qwen-image-negative-prompts/))

### 分辨率与宽高比
官方预设比例表（README 与 ComfyUI 模板 MarkdownNote 一致，总量约 1.3~1.7MP）：

| 比例 | 分辨率 |
|---|---|
| 1:1 | 1328×1328 |
| 16:9 | 1664×928 |
| 9:16 | 928×1664 |
| 4:3 | 1472×1104（ComfyUI 模板 note 写的是 1472×1140，略有出入，以 README 为准） |
| 3:4 | 1104×1472 |
| 3:2 | 1584×1056 |
| 2:3 | 1056×1584 |

来源：[QwenLM/Qwen-Image README](https://github.com/QwenLM/Qwen-Image)、本地模板 `qwen-image-t2i-official.json` 内 MarkdownNote。上下限未找到官方声明；ComfyUI 用 `EmptySD3LatentImage` 自由设置，建议按 32 倍数对齐。

### 文字渲染强化写法
- **官方示例一律用英文双引号逐字包裹要渲染的文字**，中文文字也直接写在引号内，例如：`a chalkboard sign reading "Qwen Coffee 😊 $2 per cup," ... a neon light beside it displaying "通义千问"`。([QwenLM/Qwen-Image README 官方示例](https://github.com/QwenLM/Qwen-Image))
- 官方 ComfyUI 模板示例同样采用"列出所有招牌文字、逐条引号包裹"的写法（香港霓虹街景示例枚举了 20+ 条招牌）。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image)；本地 `qwen-image-t2i-official.json`)
- 经验规则：**文字内容逐字写全、用双引号、保持原文字符（中文就写中文字符）**，并说明文字载体（招牌/海报/屏幕）、字体风格和位置。

### 推荐参数
| 来源 | steps | cfg | sampler | scheduler |
|---|---|---|---|---|
| Qwen 官方 diffusers 示例 | 50 | true_cfg_scale=4.0 | Euler 离散（flow matching，dynamic shifting） | — |
| ComfyUI 官方模板（原始路径） | 20（note 建议想贴官方效果用 50） | 4 | euler | simple |
| ComfyUI 官方模板（Lightning 8步 LoRA 路径） | 8 | 1 | euler | simple |

另：官方模板挂 `ModelSamplingAuraFlow` shift=3.1（增大更锐、减小更柔）。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image)；[runcomfy 社区整理](https://www.runcomfy.com/comfyui-workflows/qwen-image-comfyui-hd-ai-text-generator-create-posters)；本地模板 JSON）

### 官方工作流
- 本地文件：`workflows/qwen-image-t2i-official.json`
- 来源：Comfy-Org 官方模板仓库 [workflow_templates/templates/image_qwen_image.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image.json)；教程页 [docs.comfy.org/tutorials/image/qwen/qwen-image](https://docs.comfy.org/tutorials/image/qwen/qwen-image)；发布博客 [blog.comfy.org/p/qwen-image-in-comfyui-new-era-of](https://blog.comfy.org/p/qwen-image-in-comfyui-new-era-of)

### 社区硬规则
1. **diffusers 管线提示词超长会被静默截断**：`max_sequence_length` 默认 512 token（可配置到 1024），超长部分直接丢弃——策略层若走 diffusers 类接口必须控制长度；ComfyUI 原生节点不做截断，但社区经验是超长提示词后段（"丢尾"）权重明显下降，建议正文控制在 ~500 token 以内、重要内容前置。([diffusers issue #12075](https://github.com/huggingface/diffusers/issues/12075)；[diffusers QwenImage 文档](https://huggingface.co/docs/diffusers/main/en/api/pipelines/qwenimage))
2. **cfg=1 时负面词无效**（蒸馏/Lightning 路径），要用负面词就必须把 cfg 抬到 ≥2.5。([PromptMaster](https://blog.promptmaster.pro/posts/qwen-image-negative-prompts/))
3. Lightning 8步 LoRA 与社区蒸馏版（15步 cfg1）不要叠加使用，官方教程明确提示二者兼容性未验证。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image))
4. 人像细节社区偏好 cfg 2.5~4.5、steps 30~50；`shift` 3.1 是官方模板值。([comfyui-mcp qwen-txt2img skill 汇总表](https://github.com/artokun/comfyui-mcp/blob/main/plugin/skills/qwen-txt2img/SKILL.md))

---

## 二、Qwen-Image-Edit-2509（图编/换装，TextEncodeQwenImageEditPlus，image1/2/3 三图输入）

### 场景定位
Qwen-Image-Edit 的 2025-09 月度迭代：在 8 月版基础上新增**多图输入编辑**（图像拼接方式训练），主打"人物+人物""人物+商品""人物+场景"组合与单图一致性增强（人脸身份保留、多种人像风格、改字不崩脸）。([QwenLM/Qwen-Image README - 2509 发布说明](https://github.com/QwenLM/Qwen-Image)；官方介绍转述见 [博客园评测](https://www.cnblogs.com/sing1ee/p/19106784/qwen-image-edit-2509)、[智源社区](https://hub.baai.ac.cn/view/49174)）

### 语言适配
- 中英文双语编辑指令均支持，官方示例两种语言都有（中文示例："这个女生看着面前的电视屏幕，屏幕上面写着'阿里巴巴'"）。图中文字编辑支持中英双语的增删改，且保留原字号、字体、风格。([QwenLM/Qwen-Image README](https://github.com/QwenLM/Qwen-Image)；[ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit))
- 官方强烈建议编辑任务**先做 prompt rewriting**（`polish_edit_prompt`，Qwen-VL-Max 驱动），否则编辑结果不稳定："editing results may become unstable if prompt rewriting is not used"。这是策略层最需要对齐的一条官方要求。([QwenLM/Qwen-Image README - Prompt Enhance for Image Edit](https://github.com/QwenLM/Qwen-Image))

### 负面提示词策略
- 官方 diffusers 示例固定 `negative_prompt=" "`（空格）+ `true_cfg_scale=4.0` + `guidance_scale=1.0` + steps=40——即官方路径不依赖负面词内容。([QwenLM/Qwen-Image README - 2509 示例](https://github.com/QwenLM/Qwen-Image))
- ComfyUI 官方模板负面框留空；模板内参数对照表：

| 参数 | Qwen Team | Comfy Original | 4步 Lightning LoRA |
|---|---|---|---|
| Steps | 50 | 20 | 4 |
| CFG | 4.0 | 2.5 | 1.0 |

（本地 `qwen-image-edit-2509-official.json` 内 MarkdownNote）

### 分辨率与多图限制
- **多图输入：官方介绍明确"输入 1 到 3 张图像时性能最佳"**，与 ComfyUI 原生 `TextEncodeQwenImageEditPlus` 节点的 image1/image2/image3 三个槽位一致。三张以上需串联 `ReferenceLatent` 节点，社区明确标注"4 张以上是否正确工作没有保证"。([官方介绍转述 - nuowa 整合包页引官方原文](https://nuowa.net/2259)；[dskjal 实践笔记](https://dskjal.com/deeplearning/qwen-image-edit))
- **像素总量限制**：ComfyUI 官方模板在输入图后挂 `FluxKontextImageScale` 节点，把输入图按总像素约 1MP（1024×1024 量级、16 倍数对齐）缩放后再进 VAEEncode——即编辑模型的训练/最佳工作分辨率约为 1MP 总像素，大图会被缩到这个量级，这是"编辑后细节变糊"的常见原因。（本地 `qwen-image-edit-2509-official.json`；同类缩放也可用 `ImageScaleToTotalPixels`）
- 输出尺寸跟随输入图（经缩放后），比例由输入决定。

### 文字渲染强化写法
- 改字/加字指令中把目标文字**逐字写出并用引号包裹**，并指明载体与位置（官方示例："屏幕上面写着'阿里巴巴'"）。2509 相对 8 月版显著增强了文字编辑一致性（改字保留字体版式）。([QwenLM/Qwen-Image README](https://github.com/QwenLM/Qwen-Image))
- 指令式写法（"Replace X with Y, keeping ..."），官方模板示例：`Replace the cat with a dalmatian, keeping the environment and scene consistent`——即"操作 + 显式声明保持不动的部分"是官方范式。（本地模板 JSON）

### 推荐参数
见上表。另：模板挂 `ModelSamplingAuraFlow` shift=3、`CFGNorm` strength=1（官方模板新增的稳定化节点）；加速用 `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16` LoRA（4 步 cfg1）。（本地模板 JSON；[ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit)）

### 官方工作流
- 本地文件：`workflows/qwen-image-edit-2509-official.json`
- 来源：[workflow_templates/templates/image_qwen_image_edit_2509.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_edit_2509.json)；教程页 [docs.comfy.org/tutorials/image/qwen/qwen-image-edit](https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit)（该教程页同时覆盖 2509 模板）
- 模板仓库里还有 `image_qwen_image_edit_2509_relight`（打光变体）与更新的 `image_qwen_image_edit_2511` 模板，本次未下载。([templates/index.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json))

### 社区硬规则
1. **3 图是硬上限的官方甜蜜点**；需要 4~5 张参考（人+产品+场景+多角度衣服）时用第三方节点 `TextEncodeQwenImageEditPlusPro`（lrzjason，支持 5 图 + main_image_index 指定主体图）。([comfy.icu 节点页](https://comfy.icu/node/TextEncodeQwenImageEditPlusPro_lrzjason))
2. **先开 Lightning LoRA 调提示词、定稿后关掉 LoRA 出正式图**，是日文社区推荐的提效流程。([dskjal](https://dskjal.com/deeplearning/qwen-image-edit))
3. 换装/换物指令必须显式写"保持面部、发型、体型、姿势不变"这类 preservation 从句，否则身份漂移。([deAPI: Qwen Image Edit Plus Prompting Guide](https://deapi.ai/blog/qwen-image-edit-plus-prompting-guide-how-to-write-edit-instructions-that-actually-work))

---

## 三、Qwen-Image 2.1（GGUF 独立实例，TextEncodeQwenImage21 节点）——重点问题

### 场景定位
2026-09-20 发布，7B 单流 DiT（32 层）+ Qwen3-VL-8B 文本编码器 + 64 通道 RGBA VAE（16× 压缩）。**生图与编辑统一在一个模型里**，原生 2K 输出、原生透明通道、专业排版。注意：架构与前代完全不同，**1.x/2509 的节点和工作流不通用**，ComfyUI 需 ≥0.37.0。([QwenLM/Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1)；[ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)；[locallyuncensored 部署笔记](https://locallyuncensored.com/blog/how-to-run-qwen-image-2-1-locally.html))

### 用户点名问题：多图/多参考生图到底支持几张、什么分辨率、什么限制
- **张数**：官方口径"**up to 10 reference images**"（diffusers 与 ComfyUI 模板均按 10 张设计）；ComfyUI 原生 `TextEncodeQwenImage21` 节点实际暴露 **16 个槽位（image_1 ~ image_16）**，官方两个编辑模板只接了前 10 个——即节点上限 16、官方保证上限 10。([QwenLM/Qwen-Image-2.1 README](https://github.com/QwenLM/Qwen-Image-2.1)；[ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1))
- **角色分工**：`image_1` 是被编辑的画布/主体，其余 9 张提供内容（衣服、人物、风格等）；提示词用 `<image1>` ~ `<image10>` 按槽位序号引用，**不能用"图1""第一张图"这类自然语言指代**（官方 PE-I2I 改写模型系统提示词里写死的规则）。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)；本地 `qwen-image-2.1-edit-official.json` 内 PE 系统提示词）
- **分辨率**：文生图原生 2K，官方比例表：1:1 2048×2048、4:3 2400×1792、3:4 1792×2400、3:2 2528×1696、2:3 1696×2528、16:9 2752×1536、9:16 1536×2752。编辑模式默认**输出跟随 image_1 的尺寸**（对齐 32 倍数，3000×4000 的照片会得到 3008×4000 画布）；编辑子图的 `resolution` 参数是**总像素预算**（0~4096，步进 32，默认 1024；设 0 则按 image_1 原尺寸），开 `custom_size` 才用 ResolutionSelector 指定画布。([QwenLM/Qwen-Image-2.1 README - Supported Aspect Ratios](https://github.com/QwenLM/Qwen-Image-2.1)；[ComfyUI 官方教程 - Resolution](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1))
- **其他限制**：
  1. **远超 2K（如 4K）会掉 prompt adherence**——官方教程原话 "Targets well above the model's 2K trained size, such as 4K, lose prompt adherence"。
  2. 多张大图参考会显著拖慢编辑（KV cache 前缀要逐图编码）；官方提供 `Qwen Image 2.1 Cache` 节点缓存前缀（auto/gpu/cpu/off + dtype 可压到 int8/int4）。
  3. 各参考图尺寸/比例可以不同，但参考图越大越慢；成本由画布总像素驱动（12MP 画布在 5090 上约 6s/it，1MP 约 0.3s/it）。
  4. `EmptyLatentImage` 是 4 通道 1/8 压缩而 2.1 要 64 通道 1/16，依赖 ComfyUI 0.37.0+ 的 `downscale_ratio_spacial` hint 自动修正；旧版会双倍尺寸渲染。([foprc/qwen-image-2.1-comfyui-workflow](https://github.com/foprc/qwen-image-2.1-comfyui-workflow))
  5. GGUF 版本为社区量化（Unsloth 提供 Q2_K~Q8_0 全档位），非官方精度，文字渲染等小细节质量随量化档位下降。([awesome-qwen-image](https://github.com/wildminder/awesome-qwen-image))

### 语言适配
- 文本编码器换成 Qwen3-VL-8B，多语言能力更强。**官方 PE-T2I 改写模型固定输出英文长提示词**（系统提示词："The description is always in English, whatever language the request arrives in. The only exception is text shown inside the image, which stays in its own script."）——即官方推荐链路是"任意语言输入 → 英文描述正文 + 图中文字保留原语言"。（本地 `qwen-image-2.1-t2i-official.json` 内 PE 系统提示词；[QwenLM/Qwen-Image-2.1 - Prompt Rewriting](https://github.com/QwenLM/Qwen-Image-2.1)）
- 编辑指令（PE-I2I）：正文跟随用户指令语言（中文指令→中文正文），图中文字按"B 决策"决定：用户指定了文字/语言就严格照写；否则跟随图片已有文字的主语言；都没有才跟随指令语言。引号内文字禁止中英混杂。([本地 edit 模板内 PE-I2I 系统提示词](qwen-image-2.1-edit-official.json))

### 负面提示词策略
- **官方路径就是 cfg=1（无 CFG）**：模板与 diffusers/vLLM/SGLang 官方示例均为 cfg/guidance=1，此时 ComfyUI 直接跳过负面条件计算，**负面提示词完全无效**（官方教程明说 "At cfg 1 ComfyUI skips the negative conditioning pass"）。模板原话："cfg: keep 1 for the Qwen Image 2.1 official path. Raise it only if you use a negative prompt."
- 要负面词生效就抬 cfg：cfg 2 更贴密集提示词（含小字和数字）但边缘过锐；cfg 5 质量严重劣化；cfg 0.5 直接崩图。([ComfyUI 官方教程 - Workflow settings](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1))
- 社区（reddit）有相反玩法：shift 抬到 ~16 + 负面词 + cfg>1，声称改善明显——属非官方调参，需实测。([r/StableDiffusion](https://www.reddit.com/r/StableDiffusion/comments/1wnr5u8/qwen_image_21_not_bad/))
- 结论：策略层对 2.1 默认**不生成负面词**，把"不要出现什么"改写进正向提示词（官方 T2I 模板示例就在提示词尾部写 "Absolutely no text, no typography, ... no watermark"）。

### 文字渲染强化写法
- 2.0/2.1 主打"专业排版"：支持 1k-token 级指令直出信息图/PPT/海报。([QwenLM/Qwen-Image README - 2.0 发布说明](https://github.com/QwenLM/Qwen-Image))
- 官方 PE-T2I 系统提示词给出的文字规则（即官方推荐的文字写法）：**每条要渲染的文字用英文直双引号包裹、逐字符照抄、保持原书写系统（中文就写中文）**；写清字重、颜色、大小写、相对大小和位置；换行用文字描述（"a second line"）而不是在引号里塞真换行；不希望被读出的文字要明说"blurred/indistinct/too small to read"而不是编造假字母。（本地 t2i 模板 PE 系统提示词 Step 6）
- 透明图有固定咒语格式：`This is an RGBA image with transparency. <描述>. The image has alpha channel and the background is transparent.`，输出存 PNG 保 alpha。([QwenLM/Qwen-Image-2.1 README](https://github.com/QwenLM/Qwen-Image-2.1))

### 推荐参数
| 来源 | steps | cfg | sampler | scheduler |
|---|---|---|---|---|
| 官方 diffusers/vLLM/SGLang | 40（SGLang 示例 guidance-scale 1） | 1 | euler | — |
| ComfyUI 官方模板（t2i/edit/去底三个模板一致） | 25 | 1 | euler | simple |

官方教程补充：简单局部编辑 4~8 步即可；手部等顽固细节约 30 步收敛；25→40 步可减少细节"fizzle"。另有官方 4 步 Turbo 蒸馏（viggle）GGUF 可选。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)；[Abiray/Qwen-Image-2.1-viggle-4-steps-turbo-GGUF](https://huggingface.co/Abiray/Qwen-Image-2.1-viggle-4-steps-turbo-GGUF))

### 官方工作流
- 本地文件：`workflows/qwen-image-2.1-t2i-official.json`（文生图）、`workflows/qwen-image-2.1-edit-official.json`（多图编辑/换装）
- 来源：[image_qwen_image_2_1_t2i.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_t2i.json)、[image_qwen_image_2_1_image_edit.json](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_image_edit.json)；教程页 [docs.comfy.org/tutorials/image/qwen/qwen-image-2-1](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)；模型包 [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)
- 另有官方去背模板 `image_qwen_image_2_1_background_removal`（提示词固定 `Remove the background, and output a PNG image`），本次未下载，URL：https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_background_removal.json
- 社区参考实现：[foprc/qwen-image-2.1-comfyui-workflow](https://github.com/foprc/qwen-image-2.1-comfyui-workflow)（GGUF 向，注明 ComfyUI ≥0.37.0 与 latent 通道坑）；Civitai [10 图输入编辑工作流](https://civitai.com/models/2958067/qwen-image-21-multi-image-editing-or-up-to-10-images-inputs)

### 社区硬规则
1. **官方链路是"先改写后采样"**：ComfyUI 模板内置 PE 模型（T2I 用 `qwen3.5_9b_qwen_image_2.1_pe_t2i`、I2I 用 `..._pe_i2i`，均为 Qwen3.5-9B 微调），`refine_prompt` 默认关、开了才生效；`thinking_mode` 必须和改写一起开（"checkpoint was trained with a reasoning block and loses quality without it"）。模板 max_length 砍到 4096（官方 16256/24000）防改写跑太久。（本地两个 2.1 模板 JSON 的 Prompt Enhancer note）
2. 改写后提示词长度预期 400~500 词、约 20 句，短请求也要扩写到这个量级（官方 PE 系统提示词 "Size" 节）——策略层长度目标可照此对齐。
3. PE 采样参数官方值：temperature 1.0、top_p 0.95、top_k 20、min_p 0；T2I presence_penalty 1.5、I2I presence_penalty 0。（本地模板 JSON）
4. 多张参考图时提示词必须逐图描述角色（哪张是画布、哪张提供什么素材），禁止合并指代（官方 PE-I2I 系统提示词）。
5. 局部编辑可在 Mask Editor 里用画笔在 image_1 上画标记（标记直接画在 RGB 层），提示词里点名标记颜色定位区域，如 "change the jacket in the red area"。([ComfyUI 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1))

---

## 附：对策略层的直接结论

1. **语言路由**：1.x/2509 中英皆可、按用户语言配 magic suffix；2.1 推荐统一走英文正文（官方 PE-T2I 行为），图中文字保留目标语言。
2. **负面词**：1.x 基础版负面词基本摆设（cfg1 无效，cfg4 弱效），2512 的中文负面串可复用；2.1 默认 cfg1，"不要 X"必须改写进正向提示词。
3. **文字渲染**：三代通用规则——双引号逐字包裹、保持原语言字符、写清载体/位置/字重/颜色。
4. **分辨率**：1.x 用官方 7 档比例表（~1.3MP）；2509 编辑输入会被压到 ~1MP 总像素；2.1 原生 2K 七档比例表，别超 2K。
5. **多图**：2509 官方甜蜜点 1~3 张；2.1 官方保证 10 张（节点 16 槽），`<imageN>` 引用、image_1 是画布。
6. **改写器**：官方为 2.1 提供了可直接部署的 PE 模型（T2I/I2I 两个 9B checkpoint），其系统提示词全文就在本次下载的模板 JSON 里，是策略层提示词规范的最权威蓝本。

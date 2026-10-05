# Krea 2（含 Turbo）官方提示词要素清单

> **用途**：canvas-plus 后端「发起生成那一刻按所选模型官方规范编译提示词」的基准表之一。
> **编写日期**：2026-10-05
> **纪律**：本文件只记录官方原文说过的内容，逐条带出处；核不出的一律进 §6「未查到官方依据的项」，**绝不用「通常/一般来说/社区经验」顶替**。
> **模型口径说明**：Krea 2 有两条官方产品线，本文件**同时登记但严格区分**——
> - **开源权重线**（canvas-plus / 147 ComfyUI 实际用的就是这条）：`krea-ai/krea-2` 仓库发布 **Krea 2 RAW** 与 **Krea 2 Turbo** 两个 checkpoint，ComfyUI 走 `krea2_turbo_fp8_scaled.safetensors` + `CLIPLoader type=krea2` + `qwen3vl_4b`。
> - **Krea 托管 API 线**：Krea 官网/API 的 `krea-2/medium`、`krea-2/large`、`krea-2/medium-turbo`（商业托管版，**不等于**开源 Turbo）。
> 两者提示词要求的官方依据不同，凡涉及对方线的结论会显式标注线别。

---

## 素材与出处索引（引用键 → 实际文件/URL）

| 引用键 | 文件 / URL | 说明 |
|---|---|---|
| `[README]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/README.md:<行>`（本地副本 `/tmp/krea_readme_main.md:<行>`） | 官方仓库 README：参数表、RAW/Turbo 用法、分辨率、mu |
| `[PROMPT]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/prompting.md:<行>`（本地副本 `/tmp/krea_main_docs_prompting.md:<行>`） | 官方《Prompting guidelines》提示词指南 |
| `[EXPANSION]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/expansion.txt:<行>`（本地副本 `/tmp/exp_docs_expansion.txt:<行>`） | 官方 prompt 扩写 system prompt（供任意 LLM 使用） |
| `[SAFETY]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/safety.md:<行>` | 官方安全说明 |
| `[ENC]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/encoder.py:<行>`（本地副本 `/tmp/encoder.py:<行>`） | 官方文本编码器封装：Qwen3VL-4B、max_length、模板前后缀 |
| `[INFER]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/inference.py:<行>`（本地副本 `/tmp/inference.py:<行>`） | 官方推理 CLI：参数清单 |
| `[SAMPLE]` | `https://raw.githubusercontent.com/krea-ai/krea-2/main/sampling.py:<行>`（本地副本 `/tmp/sampling.py:<行>`） | 官方采样代码：CFG / negative_prompts 机制 |
| `[HF-TURBO]` | `https://huggingface.co/krea/Krea-2-Turbo`（API：`/tmp/api_turbo.json`） | 官方 Turbo 模型卡（**gated=auto，README 正文需登录，未取到**；已取到 HF widget 官方示例提示词） |
| `[TECH]` | `https://www.krea.ai/blog/krea-2-technical-report`（正文文本 `/tmp/tech_text.txt`） | 官方技术报告：训练侧 caption / 长提示词 / prompt expander / CFG |
| `[COMFY-DOC]` | `https://docs.comfy.org/tutorials/image/krea/krea-2`（`.md` 源 `/tmp/comfy_krea2.md:<行>`） | Comfy 官方教程（Comfy-Org 产出，官方口径） |
| `[WF]` | `/sobey/canvas-plus/research/win147-comfyui/workflows/krea2-turbo-official.json`（= `https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_krea2_turbo_t2i.json`） | Comfy-Org 官方模板 `image_krea2_turbo_t2i`：节点值 + 内嵌 note |
| `[COMFY-HF]` | `https://hf-mirror.com/Comfy-Org/Krea-2/raw/main/README.md`（`/tmp/comfyorg_krea2.md:<行>`） | Comfy-Org 官方模型封装卡：LoRA 触发词表、文件清单 |
| `[KD-K2]` | `https://www.krea.ai/docs/user-guide/features/krea-2.md` | Krea 托管线官方文档：Krea 2（Medium/Large/Turbo） |
| `[KD-K2T]` | `https://www.krea.ai/docs/user-guide/features/krea-2-turbo.md` | Krea 托管线官方文档：Krea 2 Turbo |
| `[KD-API]` | `https://www.krea.ai/docs/developers/krea-2/overview.md` | Krea 2 托管 API 参数与 creativity |
| `[KD-MED]` | `https://www.krea.ai/docs/api-reference/krea/krea-2-medium.md` | `krea-2/medium` 的 OpenAPI schema（必填字段、取值范围） |

> `[WF]` 的节点 `widgets_values` 与 `MarkdownNote` 是 Comfy-Org 官方模板里写死的值，属官方 Day-0 支持产物，引用时标「模板」以区别 Krea 研究团队原文。

---

## 0. 结论摘要（3-5 行）

- 开源线官方提示词要求极简：**用自然语言整句（natural language prompts）**，**长而详细效果最好**（短提示词也能出图），并建议用官方 `expansion.txt` 做 LLM 扩写 `[PROMPT]:3-5`。官方**没有**给出字段化的「必须包含 N 个要素」清单。
- 官方**唯一**两条刚性写法：**要渲染的画面内文字加英文引号包裹** `[PROMPT]:4`；扩写时**忠于原意、不臆造**新元素 `[EXPANSION]:11-15`。
- 开源 Turbo 官方参数为 **8 步 / cfg 0.0 / mu 1.15**，分辨率 **1K~2K**；RAW 为 **52 步 / cfg 3.5，≤1K** `[README]:45-61,72`。cfg=0 时 CFG 关闭，**负面条件在机制上不参与** `[SAMPLE]:86,113`。
- 语言：官方文档与全部官方示例**均为英文**；文本编码器是 Qwen3VL-4B-Instruct（底座多语言），但**官方从未声明支持中文提示词** → 归入 §6。
- 托管 API 线另有一套（1K、固定宽高比、`creativity` 四档、Intensity/Complexity/Movement 滑条），与开源线不是同一套要求，勿混用 `[KD-API]`。

---

## 1. 官方要求的提示词要素（逐条表格）

> 适用：**开源权重线**（Krea 2 RAW / Krea 2 Turbo），即 canvas-plus 实际使用线。

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| 提示词总体形式 | 官方推荐使用**自然语言**提示词（"use natural language prompts"） | 必需 | `[PROMPT]:3` |
| 详略程度 | **长而详细的提示词效果最好**；但模型在最少 prompt engineering 下也能出高质量图 | 推荐 | `[PROMPT]:4` |
| 训练侧佐证 | 模型以「描述图像密集视觉细节」的 caption 训练；长提示词提供密集监督，收敛更快、loss 更低；同时训练中也有短/中长度提示词 | 官方口径（训练侧） | `[TECH]`（§Captioning："training on long prompts provides dense supervision…"） |
| 文本编码器自带的写法指令 | 官方编码器对每条提示词**固定加** system 前缀：`Describe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:` 再拼用户文本 | 必需（代码固定，不可改） | `[ENC]:35,42` |
| LLM 扩写（可选增强） | 官方提供 `expansion.txt` 作为「任意 LLM 的 system prompt」用于扩写提示词 | 可选 | `[PROMPT]:5`；`[EXPANSION]:1-19` |
| 扩写：忠于原意 | 保留所有原始主体、动作、颜色、空间关系；**不得添加**用户未明确暗示的新物体/道具/角色/动物 | 扩写时必需 | `[EXPANSION]:11` |
| 扩写：T2I 结构 | 写成 T2I 模型能干净解析的段落；主体与其属性/动作归并成组；姿势、互动、空间布局用落地措辞 | 扩写时必需 | `[EXPANSION]:12` |
| 扩写：风格规划内隐 | 用内部推理选风格/媒介/取景/光线，**不在正文里输出规划标签或包裹符** | 扩写时必需 | `[EXPANSION]:13` |
| 扩写：避免过度具体 | 不要臆造用户未支持的服装、颜色、材质、场景细节 | 扩写时必需 | `[EXPANSION]:15` |
| 扩写：输出形态 | 思考块之后输出**单一连贯段落**，不用 bullet / JSON / markdown | 扩写时必需 | `[EXPANSION]:16` |
| 扩写：尊重既有细节 | 原提示词已详细时**轻度润色定稿**，不要重度扩写，保留原措辞与方向 | 扩写时必需 | `[EXPANSION]:17` |
| 扩写：保留用户媒介 | 用户明说媒介（photo of / illustration of / painting of / sketch of / 3D render of）时必须照办，不得为回避难度而换媒介 | 扩写时必需 | `[EXPANSION]:19` |
| 扩写：人物形体 | 有尊严地描绘人物；假定衣物遮盖隐私部位 | 扩写时必需 | `[EXPANSION]:18` |
| 画面内文字 | 要渲染的文字**用引号包裹**（"putting quotes around the words to be rendered"） | 条件必需（有文字时） | `[PROMPT]:4` |
| 画面内文字（扩写器规则） | 若用户要可见文字/引文/标签/排版，**明确写出确切文本**并把要渲染的词加引号 | 条件必需（有文字时） | `[EXPANSION]:14` |
| 提示词 token 上限 | 文本编码器 `max_length=512`（含模板前后缀），超出**截断**（truncation=True） | 官方硬约束 | `[ENC]:15,23,55-61` |
| 扩写最大长度 | Comfy 官方模板扩写节点 `LLM_max_token` 默认 **512** | 官方默认 | `[COMFY-DOC]:110`；`[WF]`（`TextGenerate` 节点 widgets_values 第 2 项 = 512） |
| 扩写开关 | Comfy 官方模板 `prompt_enhance` **默认开启**（"Enabled by default"） | 官方默认 | `[COMFY-DOC]:100,109`；`[WF]`（`Boolean (Refine Prompt?)` 默认 `True`） |
| LoRA 触发词 | 官方 9 个风格 LoRA 各配一个**触发词**，用 LoRA 时必须加 | 条件必需（用 LoRA 时） | `[COMFY-HF]:70-80`；`[COMFY-DOC]:121-131`；`[WF]`（`MarkdownNote`「LoRA Trigger Words and Settings」+ `Concatenate Text (LoRA Trigger Word)` 节点） |
| 官方扩写 system prompt 全量 | Comfy 官方模板把 `expansion.txt` 原文**逐字**塞进 `Text String (System Prompt)` 节点 | 官方实现 | `[WF]`（subgraph `PrimitiveStringMultiline` 标题 `Text String (System Prompt)` 的 `widgets_values`；正文与 `[EXPANSION]` 一致，末尾附 `User's Input:`） |

**托管 API 线（Krea 官方托管模型）另记**（`krea-2/medium`、`krea-2/large`；勿与开源线混用）：

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| `prompt` | 描述图像的文本提示词 | **必需** | `[KD-MED]:107,251-254`；`[KD-API]:308` |
| `aspect_ratio` | 取值之一：`1:1`/`4:3`/`3:2`/`16:9`/`2.35:1`/`4:5`/`3:4`/`2:3`/`9:16` | **必需** | `[KD-MED]:151-165,251-254` |
| `resolution` | 当前**仅支持 `1K`** | **必需** | `[KD-MED]:166-170,251-254` |
| `creativity` | `raw`/`low`/`medium`(默认)/`high`，控制模型对提示词的扩写自由度 | 可选 | `[KD-API]:312,320-342` |
| 写作建议（托管 Turbo） | 主体要清晰；把**风格语言前置**；用参考图/情绪板代替逐项描述视觉细节；批量对比；需要精修时升到 Medium/Large | 建议 | `[KD-K2T]:101-109` |
| 提示词写法（通用 Krea Image） | 可简可详；多数模型加入**主体 + 场景 + 光线 + 情绪**会得到更精确结果 | 建议 | `[KD-K2]`/`image-generation` 文档 §2「Write a prompt」 |

---

## 2. 官方明令禁止 / 不适用

- **画面内文字必须加引号**，否则不属于官方推荐写法 `[PROMPT]:4`、`[EXPANSION]:14`。
- 扩写器**禁止臆造**用户未暗示的新物体/道具/角色/动物 `[EXPANSION]:11`；**禁止**在正文输出规划标签/包裹符/bullet/JSON/markdown `[EXPANSION]:13,16`；**禁止**把用户指定的媒介换成别的媒介 `[EXPANSION]:19`。
- **负面提示词**：开源线**官方文档（README / prompting.md）完全未提及「负面提示词」这一概念**——既没有「推荐写法」，也没有「禁用」声明。机制层面：
  - 官方代码里 `negative_prompts` 是**可选参数**，默认 `None` → 实际置为 `[""] * n`（空串）`[SAMPLE]:63,87-88`；
  - 只有当 `cfg = guidance > 0` 时才会走无条件分支 `[SAMPLE]:86,111-114`；
  - **Turbo 官方推荐 `--cfg 0.0`（CFG disabled）** `[README]:55,60` → cfg=False → 无条件分支被完全跳过 → **负面串不参与任何计算**。
  - Comfy-Org 官方模板同样把负面条件用 `ConditioningZeroOut` 节点置零后送入 KSampler `[WF]`（`ConditioningZeroOut` → KSampler `negative` 输入；KSampler cfg=1）。
  → 结论：**Turbo 不要写负面提示词（写了也不生效）**；RAW 官方允许 CFG（cfg 3.5），但官方**未给**任何负面提示词内容规范。
- 与「用 `(word:1.2)` 权重语法做单概念加权」相关的说法：官方文档**未提及**权重语法，亦无禁止声明 → 归入 §6。

---

## 3. 语言与长度

**语言**

- 官方提示词指南用英文撰写，且**全部官方示例均为英文整句**（`[PROMPT]:11-127`，共约 20 条示例，全部英文）`[PROMPT]:11-127`；`[HF-TURBO]` widget 官方示例亦全英文。
- 官方文本编码器底座是 `Qwen/Qwen3-VL-4B-Instruct`（多语言 VLM）`[ENC]:27`、`[INFER]:27`。
- **官方从未声明支持中文提示词，也未声明多语言表现** → 中文提示词能力**未查到官方依据**（见 §6）。

**长度**

- 官方口径：**长而详细最佳**，但短提示词也可用 `[PROMPT]:4`。
- 官方硬上限：编码器 `max_length=512`（含模板前后缀），超出截断 `[ENC]:15,55-61`。
- 官方 ComfyUI 模板扩写 `LLM_max_token` 默认 512 `[COMFY-DOC]:110`。
- 官方**未给出**「提示词应写多少词/多少字」的具体数值范围 → 见 §6。

---

## 4. 画面内文字（text in image）

| 项 | 官方要求 | 官方出处 |
|---|---|---|
| 核心写法 | 要渲染的文字**加引号包裹**（"putting quotes around the words to be rendered"） | `[PROMPT]:4` |
| 扩写器规则 | 用户要可见文字/引文/标签/排版时，**写出确切文本**并把要渲染词加引号 | `[EXPANSION]:14` |
| 训练侧机制 | 官方 caption 流程先跑 **OCR** 抽取图上可见文字，再连同元数据交给 caption 模型生成更丰富的 caption | `[TECH]`（§Captioning） |
| 托管线定位 | 托管 Krea 2 文档**未列** text-in-image 强项；Krea Image 的「高保真文字」推荐模型是 Seedream 5 Lite（**非 Krea 2**） | `[KD-K2]`（无文字专章）；`image-generation` 文档 §Choosing a model |

> 注意：官方对「文字要写在哪、多大、什么字体」**无要求**（未查到官方依据，见 §6）。

---

## 5. 分辨率与参数档（含官方出处）

### 5.1 开源权重线（canvas-plus 实际使用）

| 项 | 官方值 | 官方出处 |
|---|---|---|
| Turbo 步数 / CFG | **8 步 / cfg 0.0（CFG 关闭）** | `[README]:55,58-60` |
| Turbo timestep-shift mu | **`--mu 1.15`（官方推荐）** | `[README]:60,72` |
| Turbo 分辨率 | **1K ~ 2K**（官方："from 1k ~ 2k resolution"） | `[README]:56`；`[PROMPT]:4` |
| RAW 步数 / CFG | **52 步 / cfg 3.5** | `[README]:45,49-50` |
| RAW 分辨率 | **官方："trained to generate upto 1k resolution"** | `[README]:46` |
| `--width` / `--height` | 默认 1024；范围 1024~2048；**不足 16 的倍数会自动向上 padding** | `[README]:73` |
| CLI 默认 steps / cfg | steps **28** / cfg **4.5**（`0` 关闭 CFG） | `[README]:68-69`；`[INFER]:65-72` |
| timestep-shift y1 / y2 | y1 **0.5**（最小分辨率时的 mu）；y2 **1.15**（最大分辨率时的 mu） | `[README]:70-71`；`[INFER]:73-84` |
| `--num-images` | 默认 **1** | `[README]:74` |
| `--seed` | 默认 **0**；第 i 张用 `seed + i` | `[README]:75` |
| ComfyUI 官方模板采样参数 | KSampler：**steps=8, cfg=1, sampler=euler, scheduler=simple, denoise=1**；负条件经 `ConditioningZeroOut` 置零 | `[WF]`（`KSampler` widgets_values） |
| ComfyUI 官方模板文本编码器 | `CLIPLoader`：`qwen3vl_4b_fp8_scaled.safetensors` + **type=`krea2`** + device `default` | `[WF]` |
| ComfyUI 官方模板默认分辨率 | `EmptyLatentImage` 1024×1024；实际尺寸由 `ResolutionSelector` 输出驱动 | `[WF]` |
| ComfyUI 官方模板分辨率控件 | `ResolutionSelector` 默认 `1:1 (Square)`，megapixels=**1.0**；官方教程：**megapixels 设 2.0 即 2K**，支持 1K~2K | `[WF]`；`[COMFY-DOC]:90` |
| ComfyUI 官方模板扩写默认 | `prompt_enhance` **默认开启**；`LLM_max_token` 默认 512 | `[COMFY-DOC]:100,109-110`；`[WF]`（`Boolean (Refine Prompt?)`=True） |
| 权重推荐 | Turbo **FP8 scaled**（"recommended for most users"）；另有 BF16 / NVFP4 / MXFP8 / INT8 convrot 变体 | `[COMFY-DOC]:141`；`[COMFY-HF]:44-48` |
| 模型底模 | 文本编码器 = `Qwen/Qwen3-VL-4B-Instruct`；VAE = `qwen_image_vae.safetensors` | `[ENC]:27`；`[INFER]:27`；`[WF]` |

### 5.2 托管 API 线（`krea-2/medium`、`krea-2/large`、`krea-2/medium-turbo`）

| 项 | 官方值 | 官方出处 |
|---|---|---|
| `resolution` | **仅支持 `1K`**（"Currently only 1K is supported"） | `[KD-API]:310`；`[KD-MED]:166-170` |
| 宽高比 → 输出尺寸 | 1:1=1024×1024；4:3=1184×896；3:2=1248×832；16:9=1376×768；2.35:1=1568×672；4:5=928×1152；2:3=832×1248；9:16=768×1376 | `[KD-K2]:122-133`；`[KD-K2T]:61-72` |
| 批量 | 官方：单次最多 4 张（"Batch size: Up to 4 images"） | `[KD-K2]:46`；`[KD-K2T]:35` |
| `creativity` | `raw`（不扩写）/`low`/`medium`(默认)/`high`；控制模型在提示词短/模糊时的补全自由度 | `[KD-API]:312,320-342` |
| `intensity`/`complexity`/`movement` | 各 −100~100，默认 0（0=中性）；**不重写提示词**，只调视觉性格 | `[KD-API]:316-318`；`[KD-K2]:93-104`；`[KD-K2T]:87-97` |
| `seed` | 可选；相同 seed + 提示词可复现 | `[KD-API]:311` |
| `image_style_references` | 可选，最多 10 个，strength 0~1 默认 0.5 | `[KD-MED]:128-150` |
| `moodboards` | 可选，**每次请求最多 1 个**，默认 strength 0.23 | `[KD-API]:314`；`[KD-MED]:208-228` |
| `styles`（LoRA） | 可选，strength 范围 −2~2 | `[KD-MED]:113-127` |
| Turbo（托管）速度/价格 | 约 4 秒/张，2 credits/张 | `[KD-K2T]:33-34` |
| Turbo（托管）端点 | `POST /generate/image/krea/krea-2/medium-turbo` | `[KD-K2T]:116` |

> **红线**：开源 Turbo（8 步蒸馏，本地 ComfyUI 用）与托管 `medium-turbo`（Krea 商业服务）**不是同一个东西**；参数（步数/cfg/mu）不可互套。

---

## 6. 未查到官方依据的项（明确列出，禁止推测）

1. **中文提示词支持 / 中文表现**：官方文档与全部官方示例均英文；文本编码器底座 Qwen3VL 虽有原生多语言能力，但 Krea **官方从未声明**中文（或非英文）提示词支持、也未给多语言示例 `[PROMPT]` 全篇、`[README]`、`[TECH]` 均无。
2. **官方「必须包含哪些要素」的字段化清单**：官方只说「自然语言整句 + 长而详细最佳」，**没有**规定必须包含「主体/风格/光线/构图」等具名字段。§1 中「主体+场景+光线+情绪」仅出现在**托管线通用**的 Krea Image 文档建议里，且是「多数模型」通用建议，**不是 Krea 2 专属官方必填** `[KD-K2]`/`image-generation` §2。
3. **提示词最佳长度数值区间（多少词/多少字符）**：官方只给编码器硬上限 512 token（含模板前后缀）与「长而详细最佳」，**未给**推荐词数区间 `[ENC]:15`、`[PROMPT]:4`。
4. **负面提示词的内容规范 / 禁用声明**：官方文档**未提及**；官方代码里 `negative_prompts` 是可选参数但**默认空串**，且 Turbo 官方 cfg=0 使其不生效。因此「Turbo 该写什么负面词」「RAW 该写什么负面词」**均未查到官方依据** `[SAMPLE]:63,87-88`、`[README]:60`。
5. **CLIP 风格关键词/权重语法（`(word:1.2)`）是否可用或禁用**：官方文档**未提及**任何权重语法或关键词堆叠写法，既无推荐也无禁止。（社区有「不要用权重语法」说法，但**非官方**，不采信为口径。）
6. **画面内文字的排版要求**（位置/字号/字体/颜色/大小写）：官方只说「加引号」，**未给**任何排版要素要求 `[PROMPT]:4`、`[EXPANSION]:14`。
7. **Krea 2 官方模型卡的提示词正文**：`huggingface.co/krea/Krea-2-Turbo` 与 `Krea-2-Raw` 均 **`gated=auto`（需登录+授权）**，README 正文 **HTTP 401 未取到**；其官方 HF **widget 示例提示词**已取到（全部英文自然语言长句）`[HF-TURBO]`。模型卡内是否另有提示词规范**未能核实**。
8. **RAW 的推荐 mu / 具体步骤语义**：官方 README 只给 RAW `--steps 52 --cfg 3.5`，**未给** RAW 的 `--mu` 推荐值（`--mu` 仅明确"Recommended 1.15 for oss_turbo"）`[README]:72`。
9. **官方对「主体权重/语序」的优先级规则**：官方扩写器要求「主体与属性归并成组、用落地措辞」，但**未**规定跨主体的权重或强制语序 `[EXPANSION]:12`。
10. **开源线是否支持文字以外的多图/参考图输入**：官方仓库 README 未描述；官方另有独立模板 `image_krea2_turbo_int8_image_style_reference`（1~2 张风格参考图 + `krea2_style_reference` LoRA）`[COMFY-DOC]:174-247`，但**官方未把它写成「提示词要素」要求**。
11. **提示词是否需要含否定式描述**：官方无任何相关声明。
12. **官方是否给出 Krea 2 的 prompt 模板/前缀供用户使用**：除编码器内置固定 system 前缀（`[ENC]:35`，代码写死、用户不可控）与 `expansion.txt`（扩写器用）外，**未查到**官方发布的、供用户直接套用的提示词模板。

---

## 7. 官方原文摘录（关键段落逐字，标明来源 URL）

**A. 提示词指南核心段** — `https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md`（L3-5）
> "We recommend users to use natural language prompts to generate images. The turbo model can generate up to 2k resolution images. Long detailed prompts yield best results, but the model is capable of generating high quality images with minimal prompt engineering. For text rendering, we recommend putting quotes around the words to be rendered. If you wish to use LLM assistance for generating longer prompts, check out expansion.txt and use it as a system prompt for LLM of your choice."

**B. 官方示例（前两条，逐字）** — 同 URL（L11、L17）
> `immense rocket launch exhaust as seen from extremely close up`
> `3D rendered matte black designer toy figure, stylized round anthropomorphic shape, backward black baseball cap, oversized gold-rimmed aviator sunglasses, white traditional line-art tattoos of tiger and bird on torso, black studded belt with gold buckle, smooth vinyl texture, studio lighting, solid vibrant blue background, high contrast minimal composition`

**C. 扩写 system prompt 关键规则条** — `https://github.com/krea-ai/krea-2/blob/main/docs/expansion.txt`（L11-17、L19）
> "1. **Faithfulness First:** Preserve all original subjects, actions, colors, and spatial relationships. Do not add new objects, props, characters, or animals unless the user clearly implies them."
> "2. **Practical T2I Structure:** Write a prompt that a text-to-image model can parse cleanly. Group subjects with their own attributes and actions. Use grounded phrasing for poses, interactions, and spatial layout."
> "3. **Style Planning Stays Internal:** Use your internal reasoning to choose style, medium, framing, and lighting. Do not emit planning tags or wrappers in the visible answer body."
> "4. **Text Rendering:** If the user requests visible text, quotes, labels, or typography, specify the exact text clearly and wrap requested words in quotes."
> "5. **Avoid Over-Specification:** Do not invent highly specific clothing, colors, materials, or scene details unless the input supports them."
> "6. **Structure:** Write one cohesive paragraph after the thinking block. No bullets, JSON, or markdown."
> "7. **Respect Existing Detail:** If the user's prompt is already detailed, lightly polish and finalize rather than heavily expanding — preserve their phrasing and direction."
> "9. **Preserve User Medium:** When the user explicitly requests a medium (e.g. \"photo of\", \"photograph of\", \"illustration of\", \"painting of\", \"sketch of\", \"3D render of\"), honor it. Do not pivot to a different medium to avoid difficulty — match the user's stated intent."

**D. 官方仓库 README 用法段（RAW / Turbo）** — `https://github.com/krea-ai/krea-2/blob/main/README.md`（L45-61）
> "### Raw (`oss_raw`) — The base undistilled model. Use the full sampler with classifier-free guidance: The model has been trained to generate upto 1k resolution."
> `uv run inference.py "a fox walking in the snow" \ --checkpoint oss_raw --steps 52 --cfg 3.5`
> "### Turbo (`oss_turbo`) — Distilled for few-step sampling — run with 8 steps and CFG disabled. The model can generate images from 1k ~ 2k resolution."
> `uv run inference.py "a fox walking in the snow" \ --checkpoint oss_turbo --steps 8 --cfg 0.0 --mu 1.15 --width 2048 --height 2048`

**E. 官方 README 参数表（逐字）** — 同 URL（L65-77）
> `--steps` 默认 `28`；`--cfg` 默认 `4.5`（`0` disables CFG）；`--y1` 默认 `0.5`；`--y2` 默认 `1.15`；`--mu` 默认 `None`（"Pin a constant timestep-shift mu … Recommended 1.15 for oss_turbo"）；`--width`/`--height` 默认 `1024`~`2048`（"Output resolution; padded up to a multiple of 16 if needed"）；`--num-images` 默认 `1`；`--seed` 默认 `0`。

**F. 官方编码器内置提示词前缀（逐字）** — `https://github.com/krea-ai/krea-2/blob/main/encoder.py`（L35）
> `self.prompt_template_encode_prefix = "<|im_start|>system\nDescribe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:<|im_end|>\n<|im_start|>user\n"`
> （L15/L55-61）`max_length: int = 512`；tokenizer 调用含 `truncation=True, padding="max_length"`。

**G. 官方采样代码 CFG / 负面机制（逐字）** — `https://github.com/krea-ai/krea-2/blob/main/sampling.py`（L63、L86-88、L111-114、L127-129）
> `negative_prompts=None` … `cfg = guidance > 0` … `if negative_prompts is None: negative_prompts = [""] * n`
> `# The unconditional branch is only used for CFG; skip encoding/prep entirely when guidance is disabled.` … `if cfg: untxt, untxtmask = encoder(negative_prompts)`
> `uncond = model(img=img, context=untxt, t=t, pos=unpos, mask=unmask); v = cond + guidance * (cond - uncond)`

**H. 技术报告：长提示词 / prompt expander（逐字）** — `https://www.krea.ai/blog/krea-2-technical-report`
> "In training, the model learns from rich, carefully constructed captions that describe images with dense visual detail." … "Some users describe a scene in natural language; others gesture toward a mood, a style, or a reference image. … we build two systems …: a prompt expander and a style-reference system. The prompt expander maps simple or underspecified user prompts into richer visual directions without overwriting the user's intent."
> "Empirically, we find that training on long prompts provides dense supervision, yielding faster convergence and lower training loss. For many downstream and applied use cases, however, performance on short and medium-length prompts remains important. We therefore train predominantly on long captions while ensuring the model is exposed to short and medium-length prompts throughout training."
> （Captioning 段）"First, we run an OCR model on each target image to extract any visible text."
> （CFG 段）"At inference time, CFG can still be enabled as an additional control knob, further improving quality when desired."

**I. Comfy 官方教程（逐字）** — `https://docs.comfy.org/tutorials/image/krea/krea-2`
> "The defaults (8 steps, prompt enhancement enabled, no LoRA) produce a high-quality image with minimal configuration."（L100）
> "`prompt_enhance` — Toggle LLM-powered prompt expansion on/off"；"`LLM_max_token` — Maximum token length for prompt enhancement"（L109-110）
> "Krea 2 supports outputs from 1K to 2K. Set the megapixels value to 2.0 to get 2K resolution."（L90）

**J. Comfy-Org 官方模型封装卡：LoRA 触发词表（逐字）** — `https://huggingface.co/Comfy-Org/Krea-2`（README 表，L70-80）
> `krea2_darkbrush` → `monochrome ink wash style`；`krea2_dotmatrix` → `monochrome stippling style`；`krea2_kidsdrawing` → `naive expressive sketch style`；`krea2_neondrip` → `textured abstract style`；`krea2_rainywindow` → `rainy window style`；`krea2_retroanime` → `purple retro anime style`；`krea2_softwatercolor` → `art deco watercolor style`；`krea2_sunsetblur` → `ethereal motion blur style`；`krea2_vintagetarot` → `vintage tarot style`（Recommended Strength 全部 `1.0`）

**K. 托管 API 参数必填（逐字 OpenAPI）** — `https://www.krea.ai/docs/api-reference/krea/krea-2-medium`
> `required: - prompt - aspect_ratio - resolution`；`resolution` "Currently only 1K is supported."；`creativity` default `low`，"Prompt expansion mode. `raw` disables prompt expansion; `low`, `medium`, and `high` control expansion strength."

**L. 托管 Turbo 提示词建议（逐字表）** — `https://www.krea.ai/docs/user-guide/features/krea-2-turbo`
> "Keep the subject clear — \"A streetwear poster for a neon running shoe\""；"Add style language early — \"risograph print, limited palette, bold silhouette\""；"Use references for visual identity — Upload a poster, editorial image, or moodboard instead of trying to describe every visual detail"；"Generate in batches"；"Escalate when needed — Move to Krea 2 Medium or Large when the draft needs more polish"

---

## 附：给 canvas-plus 编译层的落地要点（仅转述官方口径，不含推测）

1. 提示词正文 = **英文自然语言整句、长而详细**（`[PROMPT]:3-4`）。
2. 走 147 ComfyUI 的 **Krea 2 Turbo** 时：**不要生成负面提示词**（官方 cfg=0，模板已 `ConditioningZeroOut`），参数锁 **8 步 / cfg=1（等价 cfg 0）/ euler / simple / mu 1.15**（`[README]:60,72`、`[WF]`）。
3. 有画面内文字时，**只做一件事：把要渲染的原文加引号**，并保证文本确切（`[PROMPT]:4`、`[EXPANSION]:14`）。
4. 如启用官方 LoRA，**必须追加对应触发词**，且提示词其余部分不要再写风格词（`[COMFY-HF]:70-80`）。
5. 提示词总 token 受 **512** 上限约束（含编码器内置 system 前缀），编译时需做截断保护（`[ENC]:35,55-61`）。
6. 中文提示词：官方无背书，**需自行评估**，不可当作「官方支持中文」对外声明（§6-1）。

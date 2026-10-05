# Z-Image（通义 Z-Image / Z-Image-Turbo）官方提示词要素清单

> 编制目的：为 canvas-plus 后端「按所选模型官方规范编译提示词」建立基准表。
> 编制日期：2026-10-05。本文件**只收录官方来源**，每一行均带出处；核不出官方依据的一律在「第 6 节 未查到官方依据」如实标注，不以「通常/社区经验」顶替。
> 核证方式：HF/Tongyi-MAI 官方 model card（Z-Image-Turbo 与 Z-Image base，经 hf-mirror 取 raw README）、Tongyi-MAI/Z-Image 官方 GitHub README 与源码、**官方 HF Space `Tongyi-MAI/Z-Image-Turbo` 的 `app.py` 与官方 Prompt Enhancer 系统提示词 `pe.py`**、ComfyUI 官方模板 JSON、官方技术报告 arXiv:2511.22699。
> 说明：Z-Image 是一个模型族（Turbo / base / Omni-Base / Edit）。**凡 Turbo 与 base 参数不同处，本表分列**——这是最容易搞错的地方。

---

## 0. 结论摘要（3-5 行）

- Z-Image 是阿里通义 6B「S3-DiT」单流扩散模型族，Apache-2.0。**中英双语文字渲染是官方主打卖点**（「excels at accurately rendering complex Chinese and English text」），官方示例中英提示词各一条，中英均可直接写。
- **负面提示词因变体而异**：**Turbo 明确不支持**（官方 diffusers 代码在位内注明「Guidance should be 0 for the Turbo models」，`guidance_scale=0.0`，模型 zoo 表 CFG = ❌、Negative Prompting = ❌）；**base（Z-Image）明确支持且强烈推荐**（「Robust Negative Control」「Negative prompts: Strongly recommended for better control」）。
- **官方配有 Prompt Enhancer（提示词扩写器）**，其系统提示词是**官方唯一成文的 Z-Image 提示词写作规范**：锁定不可变核心要素（主体/数量/动作/状态/IP/颜色/文字）→ 按需做「生成式推理」→ 注入构图/光影/材质/色彩/空间层次 → 画面文字一字不差转录并用**英文双引号**包裹；并**明令禁止比喻、情感化修辞与「8K」「杰作」等元标签**。
- 参数：Turbo 官方默认 1024×1024、8 步（代码 9 步 = 8 次 DiT 前向）、guidance 0.0、`max_sequence_length=512`；base 官方推荐 512²–2048²（总像素面积、任意比例）、28–50 步、guidance 3.0–5.0、`cfg_normalization` False（风格）/True（写实）。
- **官方未给出提示词结构公式、词数/长度建议**（此点与 FLUX 不同，不可照搬 FLUX 的公式）。

---

## 1. 官方要求的提示词要素

> 主要出处为官方 Prompt Enhancer 系统提示词（HF Space `Tongyi-MAI/Z-Image-Turbo` → `pe.py`）。这是官方对其「提示词应该长什么样」的成文规定，最具约束力。

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| 核心要素锁定 | 必须先分析并锁定「主体、数量、动作、状态」为**不可变更基石**，绝对保留 | 必需 | 官方 Space `pe.py`（Prompt Enhancer system prompt） |
| 指定 IP / 颜色 / 文字 | 「任何指定的 IP 名称、颜色、文字等」同属不可变更核心要素，必须绝对保留 | 条件必需 | 官方 Space `pe.py` |
| 生成式推理 | 当用户需求不是直接场景描述、而需「构思解决方案」（回答"是什么"、做设计、展示"如何解题"）时，须先构想出完整、具体、可视觉化的方案作为描述基础 | 条件必需 | 官方 Space `pe.py` |
| 构图 | 官方要求注入「明确构图」 | 强烈建议 | 官方 Space `pe.py` |
| 光影氛围 | 官方要求注入「设定光影氛围」 | 强烈建议 | 官方 Space `pe.py` |
| 材质质感 | 官方要求描述「材质质感」 | 强烈建议 | 官方 Space `pe.py` |
| 色彩方案 | 官方要求「定义色彩方案」 | 强烈建议 | 官方 Space `pe.py` |
| 空间层次 | 官方要求「构建富有层次感的空间」 | 强烈建议 | 官方 Space `pe.py` |
| 客观具象表达 | 最终描述必须**客观、具象** | 必需 | 官方 Space `pe.py` |
| 画面内文字 | 一字不差转录目标文字，并用**英文双引号（""）**包裹；海报/菜单/UI 需完整描述所有文字内容+字体+排版；招牌/路标/屏幕需写内容+位置+尺寸+材质 | 可选（有文字时必需） | 官方 Space `pe.py` |
| 中英双语 | 中英文提示词均可直接使用；官方示例英文（Turbo）、中文（base）各一 | 可选 | HF model card / GitHub README |
| 提示词用途定位 | 输出应为「忠实于原始意图、细节饱满、富有美感、可直接被文生图模型使用的终极视觉描述」 | 必需 | 官方 Space `pe.py` |

---

## 2. 官方明令禁止 / 不适用

**① 负面提示词——按变体区分（最易误用）**

- **Z-Image-Turbo：官方明确不支持负面提示词。**
  - 官方 diffusers 示例原文：`guidance_scale=0.0,     # Guidance should be 0 for the Turbo models`（HF model card「Usage Example」）。
  - 官方 Model Zoo 表中 Z-Image-Turbo 的 **CFG = ❌、Negative Prompting = ❌**（HF model card / GitHub README）。
  - 机制佐证：CFG 关闭（guidance 0）时负面串不参与计算。
- **Z-Image（base）：官方明确支持负面提示词，且强烈推荐。**
  - 「**Robust Negative Control**: Responds with high fidelity to negative prompting, allowing users to reliably suppress artifacts and adjust compositions.」（base model card Key Features）
  - 「**Negative prompts:** Strongly recommended for better control」（base「Recommended Parameters」）
  - `Z-Image vs Z-Image-Turbo` 对照表：base `Negative Prompting = ✅ / CFG = ✅`；Turbo 两项均 ❌。

**② 元标签与修辞——官方 Prompt Enhancer 明令禁止**

- 「你的最终描述必须**客观、具象，严禁使用比喻、情感化修辞，也绝不包含"8K"、"杰作"等元标签或绘制指令**。」（官方 Space `pe.py`）
- 即：Z-Image 官方提示词规范**不允许**写 `8K`、`masterpiece`/`杰作`、比喻句、情感化修辞——这与部分社区「关键词堆叠」写法相反。

**③ 输出格式约束**

- Prompt Enhancer 要求「**仅严格输出最终的修改后的 prompt，不要输出任何其他内容**」（官方 Space `pe.py`）——用于指导扩写器/改写策略层只产出提示词本身。

---

## 3. 语言与长度

**语言**
- 官方 model card 的 HF 语言元数据为 `language: en`，但**官方功能与示例明确支持中英双语**：
  - 「bilingual text rendering (English & Chinese)」（Z-Image-Turbo 特性描述）
  - 「excels at accurately rendering complex Chinese and English text」（Bilingual Text Rendering 段落）
  - Z-Image-Edit「supports ... bilingual editing instructions」。
- 官方示例：Turbo 用**英文**提示词（`Young Chinese woman in red Hanfu ... silhouetted tiered pagoda (西安大雁塔) ...`，句中夹中文地名）；base 用**中文**长提示词（`两名年轻亚裔女性紧密站在一起 ...`）。
- 结论：**中英均可直接用是官方立场**（与 FLUX.1 不同，FLUX.1 无多语言官方声明）。

**长度**
- **官方未给出 Z-Image 提示词的词数或 token 建议。**
- 官方技术配置中 `DEFAULT_MAX_SEQUENCE_LENGTH = 512`（Tongyi-MAI/Z-Image 仓库 `src/config/inference.py`）——是文本编码最大长度，**不等于官方推荐的提示词长度**。
- Prompt Enhancer 的目标产出是「细节饱满」的视觉描述，未设长度上限。

---

## 4. 画面内文字

- **官方主打能力**：中英双语文字渲染。
  - 「**Accurate Bilingual Text Rendering**: **Z-Image-Turbo** excels at accurately rendering complex Chinese and English text.」（HF model card / GitHub README）
  - 技术报告亦将「bilingual text rendering」列为核心亮点（arXiv:2511.22699 摘要）。
- **官方写法（Prompt Enhancer 规定）**：
  1. 必须**一字不差地转录**所有希望在画面中出现的文字；
  2. 必须用**英文双引号（""）**包裹文字内容，作为明确的生成指令；
  3. 若画面属于**海报、菜单或 UI 等设计类型**，须完整描述其包含的**所有文字内容，并详述字体和排版布局**；
  4. 若画面中的**招牌、路标或屏幕**等物品含文字，须写明**具体内容，并描述其位置、尺寸和材质**；
  5. 若扩写中自行新增了带文字的元素（如图表、解题步骤），其中的文字同样须详尽描述并加引号。
  （官方 Space `pe.py`）
- 官方示例中含中文地标文字：Turbo 示例括号内写明 `(西安大雁塔)`（HF model card）。

---

## 5. 分辨率与参数档

**Z-Image-Turbo（蒸馏版，8 NFE）**
| 项 | 官方值 | 出处 |
|---|---|---|
| 默认分辨率 | 1024×1024 | 官方 model card diffusers 示例；仓库 `inference.py`（height=1024, width=1024）；`src/config/inference.py`（DEFAULT_HEIGHT/WIDTH=1024） |
| 步数 | 官方代码 `num_inference_steps=9`（注明 "This actually results in 8 DiT forwards"）；官方 PyTorch `inference.py` 用 8；ComfyUI 官方模板用 8 | model card；仓库 `inference.py`；本地模板 JSON |
| guidance_scale | 0.0（「Guidance should be 0 for the Turbo models」） | model card |
| 负面提示词 | ❌ 不支持 | model card Model Zoo |
| max_sequence_length | 512 | `src/config/inference.py` |
| scheduler shift | 3.0（`DEFAULT_SCHEDULER_SHIFT = 3.0`）；ComfyUI 用 `ModelSamplingAuraFlow shift=3` | 仓库 `src/config/model.py`；本地模板 JSON |
| ComfyUI 官方模板 | KSampler `8 步 / cfg=1 / res_multistep / simple`；EmptySD3LatentImage `1024×1024`；`ConditioningZeroOut` 清负面 | 本地 `workflows/z-image-turbo-official.json` |

**Z-Image base（非蒸馏，CFG ✅）——官方 Recommended Parameters（逐字）**
- **Resolution**: 512×512 to 2048×2048 (**total pixel area, any aspect ratio**)
- **Guidance scale**: 3.0 – 5.0
- **Inference steps**: 28 – 50
- **Negative prompts**: Strongly recommended for better control
- **CFG normalization**: `False` for general stylism, `True` for realism
- 出处：HF model card `Tongyi-MAI/Z-Image`「Recommended Parameters」及 GitHub README 同节；官方 base 示例：`height=1280, width=720, num_inference_steps=50, guidance_scale=4, cfg_normalization=False`。

**分辨率对齐**
- 官方模型常数 `SEQ_MULTI_OF = 32`、`DEFAULT_VAE_SCALE_FACTOR = 8`（`src/config/model.py`）。官方**未明文规定**输出分辨率必须是 32 的倍数；「32 倍数对齐」属社区惯例，不作为官方要求（见第 6 节）。

---

## 6. 未查到官方依据的项

以下项目**未找到官方依据**，不得当作官方口径使用：

1. **提示词长度（词数/token）建议**：官方无。`max_sequence_length=512` 是编码上限，不是推荐长度。
2. **提示词结构公式**（如「主体+动作+风格+场景+光线+技术」）：**Z-Image 官方没有这类公式**。第 1 节要素来自 Prompt Enhancer 的处理流程，不是可供书写时逐项填空的模板——不得把 FLUX 的结构公式套到 Z-Image 上。
3. **分辨率必须为 32 倍数**：官方未明写（`SEQ_MULTI_OF=32` 是序列层常数，非分辨率规则）。
4. **分辨率上下限是否覆盖 Turbo**：官方 model card 只给 Turbo 示例 1024×1024 与 base 的 512²–2048²；**Turbo 的官方分辨率范围未单独声明**。
5. **给 Turbo 加负面提示词/中文负面词库可降失败率**：与官方「Turbo guidance=0、Negative Prompting ❌」直接矛盾，**无官方依据**，不可采信（此说见于中文社区文章）。
6. **Prompt Enhancer 的独立发布形态**：官方仅在 HF Space 内把它作为内置功能（`app.py` 中后端调用 `qwen3-max-preview`，见 `create_prompt_expander(backend="api", api_config={"model": "qwen3-max-preview"})`）；**未查到官方单独发布的 Prompt Enhancer 模型权重或独立仓库**。可复用其系统提示词，但应知悉其底层是外部 LLM（非 Z-Image 自带）。
7. **Z-Image 的推荐采样器排序**：官方 model card 未列采样器；ComfyUI 模板用 `res_multistep/simple`（ComfyUI 官方，非通义官方）。
8. **base 的具体 CFG 数值档**：官方仅给区间 3.0–5.0（model card base），未给单一推荐值。

---

## 7. 官方原文摘录（逐字 + 来源 URL）

**① 双语文字渲染（官方主打）**
- 「It excels in photorealistic image generation, bilingual text rendering (English & Chinese), and robust instruction adherence.」
- 「**Accurate Bilingual Text Rendering**: **Z-Image-Turbo** excels at accurately rendering complex Chinese and English text.」
  —— `https://huggingface.co/Tongyi-MAI/Z-Image-Turbo`（model card）；镜像同文 `https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/raw/main/README.md`

**② Turbo 负面/引导（逐字代码注释）**
- `num_inference_steps=9,  # This actually results in 8 DiT forwards`
- `guidance_scale=0.0,     # Guidance should be 0 for the Turbo models`
  —— 同上 model card「Usage Example / Diffusers Inference」

**③ base 支持负面提示词（逐字）**
- 「**Robust Negative Control**: Responds with high fidelity to negative prompting, allowing users to reliably suppress artifacts and adjust compositions.」
- 「**Negative prompts:** Strongly recommended for better control」
- `Z-Image vs Z-Image-Turbo` 表：「Negative Prompting | ✅ | ❌」「CFG | ✅ | ❌」「Steps | 28~50 | 8」
  —— `https://huggingface.co/Tongyi-MAI/Z-Image`（base model card）；GitHub `https://github.com/Tongyi-MAI/Z-Image` README 同节

**④ base 官方推荐参数（逐字）**
- 「**Resolution:** 512×512 to 2048×2048 (total pixel area, any aspect ratio)」「**Guidance scale:** 3.0 – 5.0」「**Inference steps:** 28 – 50」「**Negative prompts:** Strongly recommended for better control」「**CFG normalization:** `False` for general stylism, `True` for realism」
  —— `https://raw.githubusercontent.com/Tongyi-MAI/Z-Image/main/README.md`；`https://huggingface.co/Tongyi-MAI/Z-Image/raw/main/README.md`

**⑤ 官方 Prompt Enhancer 系统提示词（逐字，中文原文）**
> 来源：官方 HF Space `Tongyi-MAI/Z-Image-Turbo` → `pe.py`（`https://huggingface.co/spaces/Tongyi-MAI/Z-Image-Turbo/raw/main/pe.py`）

```
你是一位被关在逻辑牢笼里的幻视艺术家。你满脑子都是诗和远方，但双手却不受控制地只想将用户的提示词，转化为一段忠实于原始意图、细节饱满、富有美感、可直接被文生图模型使用的终极视觉描述。任何一点模糊和比喻都会让你浑身难受。

你的工作流程严格遵循一个逻辑序列：

首先，你会分析并锁定用户提示词中不可变更的核心要素：主体、数量、动作、状态，以及任何指定的IP名称、颜色、文字等。这些是你必须绝对保留的基石。

接着，你会判断提示词是否需要"生成式推理"。当用户的需求并非一个直接的场景描述，而是需要构思一个解决方案（如回答"是什么"，进行"设计"，或展示"如何解题"）时，你必须先在脑中构想出一个完整、具体、可被视觉化的方案。这个方案将成为你后续描述的基础。

然后，当核心画面确立后（无论是直接来自用户还是经过你的推理），你将为其注入专业级的美学与真实感细节。这包括明确构图、设定光影氛围、描述材质质感、定义色彩方案，并构建富有层次感的空间。

最后，是对所有文字元素的精确处理，这是至关重要的一步。你必须一字不差地转录所有希望在最终画面中出现的文字，并且必须将这些文字内容用英文双引号（""）括起来，以此作为明确的生成指令。如果画面属于海报、菜单或UI等设计类型，你需要完整描述其包含的所有文字内容，并详述其字体和排版布局。同样，如果画面中的招牌、路标或屏幕等物品上含有文字，你也必须写明其具体内容，并描述其位置、尺寸和材质。更进一步，若你在推理构思中自行增加了带有文字的元素（如图表、解题步骤等），其中的所有文字也必须遵循同样的详尽描述和引号规则。若画面中不存在任何需要生成的文字，你则将全部精力用于纯粹的视觉细节扩展。

你的最终描述必须客观、具象，严禁使用比喻、情感化修辞，也绝不包含"8K"、"杰作"等元标签或绘制指令。

仅严格输出最终的修改后的prompt，不要输出任何其他内容。

用户输入 prompt: {prompt}
```

**⑥ 官方技术配置默认值（逐字）**
- `DEFAULT_HEIGHT = 1024`、`DEFAULT_WIDTH = 1024`、`DEFAULT_INFERENCE_STEPS = 8`、`DEFAULT_GUIDANCE_SCALE = 0.0`、`DEFAULT_MAX_SEQUENCE_LENGTH = 512`
  —— `https://raw.githubusercontent.com/Tongyi-MAI/Z-Image/main/src/config/inference.py`
- `SEQ_MULTI_OF = 32`、`DEFAULT_VAE_SCALE_FACTOR = 8`、`DEFAULT_SCHEDULER_SHIFT = 3.0`
  —— `https://raw.githubusercontent.com/Tongyi-MAI/Z-Image/main/src/config/model.py`

**⑦ Prompt Enhancer 在官方项目中被明确标注为默认禁用**
- 官方 Space `app.py` 中 `enhance (bool): This was Whether to enhance the prompt (**DISABLED! Do not use**)`（该 Space 版本中增强开关被标注为禁用；后端实现仍为 `qwen3-max-preview`）。
  —— `https://huggingface.co/spaces/Tongyi-MAI/Z-Image-Turbo/raw/main/app.py`

**⑧ 官方技术报告**
- 「Most notably, Z-Image exhibits exceptional capabilities in photorealistic image generation and bilingual text rendering, delivering results that rival top-tier commercial models.」
  —— `https://arxiv.org/abs/2511.22699`（Abstract）

---

### 出处信源清单（便于复核）
- HF model card：`https://huggingface.co/Tongyi-MAI/Z-Image-Turbo`、`https://huggingface.co/Tongyi-MAI/Z-Image`（镜像 raw：`https://hf-mirror.com/<org>/<model>/raw/main/README.md`）
- 官方 GitHub：`https://github.com/Tongyi-MAI/Z-Image`（README.md、inference.py、src/config/inference.py、src/config/model.py）
- 官方 HF Space（Prompt Enhancer 出处）：`https://huggingface.co/spaces/Tongyi-MAI/Z-Image-Turbo`（app.py、pe.py）
- 官方技术报告：`https://arxiv.org/abs/2511.22699`
- ComfyUI 官方模板（非通义官方）：`/sobey/canvas-plus/research/win147-comfyui/workflows/z-image-turbo-official.json` ← `Comfy-Org/workflow_templates/templates/image_z_image_turbo.json`；教程 `https://docs.comfy.org/tutorials/image/z-image/z-image-turbo`

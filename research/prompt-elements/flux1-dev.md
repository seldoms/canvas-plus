# FLUX.1-dev 官方提示词要素清单

> 编制目的：为 canvas-plus 后端「按所选模型官方规范编译提示词」建立基准表。
> 编制日期：2026-10-05。本文件**只收录官方来源**，每一行均带出处；核不出官方依据的一律在「第 6 节 未查到官方依据」如实标注，不以「通常/社区经验」顶替。
> 核证方式：BFL 官方 skills 仓库（raw 原文）、docs.bfl.ml（Mintlify，页面 URL 加 `.md` 取原文）、FLUX.1-dev 官方 model card（HF 门禁，经 Wayback 归档原件核读）、BFL OpenAPI（`api.bfl.ai/openapi.json`）、ComfyUI 官方模板 JSON。

---

## 0. 结论摘要（3-5 行）

- **FLUX.1-dev 官方没有单独发布「FLUX.1-dev 提示词指南」**；BFL 现行 `docs.bfl.ml` 的作图指南面向 FLUX 3 Image，而 FLUX.1 模型卡本身只给出一句关键约束——「prompt following is heavily influenced by the prompting-style」。逐条 prompting 规范来自 **BFL 官方 skills 仓库**，其自身声明这些规则「apply to all FLUX models」。
- **官方最强硬的一条：FLUX 不支持负面提示词**。官方原文为「FLUX does NOT support negative prompts. Always describe what you WANT, not what you don't want.」，并解释「Negative prompts can actually make models focus MORE on unwanted elements.」。
- **官方提示词结构公式**：`[Subject] + [Action/Pose] + [Style/Medium] + [Context/Setting] + [Lighting] + [Technical Details]`；重要元素前置；光线必写（「the single greatest impact on image quality」）；用自然语言散文而非关键词堆叠；长度甜点 30–80 词（模型上限 512 token）。
- **语言**：官方模型卡语言标注 `en`；**FLUX.1 系无任何多语言（含中文）官方支持声明**（多语言声明仅见于 FLUX.2 条目）。
- **参数**：BFL 官方 API `/v1/flux-dev` 规定 width/height 256–1440 且为 32 倍数、默认 1024×768；steps 默认 28（1–50）；guidance 默认 3.0（1.5–5）。

---

## 1. 官方要求的提示词要素

> 「官方出处」中：`BFL skills` 指 `github.com/black-forest-labs/skills` 的 `skills/flux-image-best-practices/` 规则文件；`docs.bfl.ml` 为 BFL 官方文档站。凡规则来自全族通用文件（非 dev 单列），已在备注中标注。

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| 主体 Subject | 明确「谁/什么」+ 动作，作为结构公式第一项；「Start with the subject and what it is doing.」 | 必需 | BFL skills `rules/core-principles.md`「Prompt Structure Formula」；`docs.bfl.ml/guides/prompting_unified_building`「Structure helps」 |
| 元素前置 Front-load | FLUX 优先处理靠前的元素；把最重要元素放句首。原文「FLUX prioritizes elements that appear earlier in the prompt. Front-load important elements.」 | 必需 | BFL skills `rules/core-principles.md` §6 |
| 光线 Lighting | 必写，写光源/方向/柔和度；官方称其「has the single greatest impact on image quality」，并提供 golden hour / overcast / softbox / rim light / low key 等词表 | 必需 | BFL skills `rules/core-principles.md` §5；`rules/t2i-prompting.md`「Lighting Patterns」 |
| 场景/环境 Context | 结构公式第四项（where it happens） | 必需 | BFL skills `rules/core-principles.md`；`docs.bfl.ml/guides/prompting_unified_building` |
| 风格/媒介 Style | 明确写 medium / era / film stock（如 oil painting、Kodak Portra 400） | 强烈建议 | BFL skills `rules/core-principles.md`；`docs.bfl.ml/guides/prompting_unified_building`「Name the style concretely: a medium, an era, a film stock.」 |
| 具体性 Specificity | 「More specific prompts yield dramatically better results.」 | 必需 | BFL skills `rules/core-principles.md` §3 |
| 自然语言散文 | 用连贯散文而非关键词列表；「Write prompts as descriptive prose rather than keyword lists.」 | 必需 | BFL skills `rules/core-principles.md` §4 |
| 技术细节 Technical | 结构公式末项：相机、镜头、光圈、景深、胶片 | 可选 | BFL skills `rules/core-principles.md`；`rules/t2i-prompting.md`「Camera and Lens Simulation」 |
| 相机/镜头/胶片词汇 | 官方词表：`shot on Sony A7IV`、`shot on Kodak Portra 400`、`85mm f/1.4`、`f/8`、`ISO 100`、`Hasselblad X2D` 等 | 可选 | BFL skills `rules/t2i-prompting.md` |
| 颜色（hex） | 支持 `#RRGGBB`，**必须配颜色名**（Good: `#FF6B6B (coral pink)`；Bad: `#FF6B6B`）；建议 3–5 色 | 可选 | BFL skills `rules/hex-color-prompting.md` |
| 画面内文字 | 用引号包裹要渲染的精确文字，并描述字体风格/大小写/颜色/对齐；文字描述前置 | 可选（有文字时必需） | BFL skills `rules/typography-text.md`（引号、字体、前置） |
| 构图/景别 | 官方词组表：extreme close-up / medium shot / wide shot；eye level / low angle / Dutch angle；rule of thirds / leading lines 等 | 可选 | BFL skills `rules/t2i-prompting.md`「Composition Techniques」；`docs.bfl.ml/guides/prompting_unified_reference`「Composition Techniques」 |
| 提示词结构公式 | 官方给出固定公式（见摘要），并强调「A clear structure matters more than length.」 | 必需 | BFL skills `rules/core-principles.md`；`docs.bfl.ml/guides/prompting_unified_building` |
| 长度 | 甜点 30–80 词；「FLUX can handle up to 512 tokens」；FLUX.1-dev 模型卡示例 `max_sequence_length=512` | 建议 | BFL skills `rules/core-principles.md` §7；FLUX.1-dev model card |
| prompt_upsampling | FLUX.1-dev API 开关，`true` 时自动改写提示词追求更强创意；官方默认 `false` | 可选 | BFL OpenAPI `/v1/flux-dev`（`FluxDevInputs.prompt_upsampling`） |

---

## 2. 官方明令禁止 / 不适用

**负面提示词（negative prompt）——官方明确不支持。** 这是 BFL 官方对 FLUX 全族的定调，多处原文一致：

- 「FLUX does NOT support negative prompts. Always describe what you WANT, not what you don't want.」（BFL skills `rules/core-principles.md` §1）
- 「**NO negative prompts** - FLUX does not support negative prompts; describe what you want」（BFL skills `SKILL.md`「Critical Rules」第 1 条）
- 「FLUX does not support negative prompts. ... Negative prompts can actually make models focus MORE on unwanted elements.」（BFL skills `rules/negative-prompt-alternatives.md`）
- 「FLUX models don't support negative prompts. Even if they could process negatives, AI models generally struggle with negation. When you write "a person without glasses," the model focuses on the word "glasses" and often generates exactly what you're trying to avoid.」（`docs.bfl.ml/guides/prompting_guide_t2i_negative`）

**正确做法（官方替换策略）**：把排除项改写成「正面视觉对立面」——问自己「如果这个东西不在，我会看到什么？」，然后正面描述。官方例：`"no people"` → `"empty", "deserted", "solitary"`；`"no text"` → `"clean surfaces", "unmarked", "blank"`；`"no modern elements"` → `"traditional", "historical", "period-accurate"`。

**机制层面佐证（ComfyUI 官方模板，非 BFL）**：FLUX.1-dev 是 guidance-distilled 模型，ComfyUI 官方模板 `flux_dev_full_text_to_image` 用 `ConditioningZeroOut` 把负面条件清零、KSampler `cfg=1`，即负面串在本地工作流中根本不参与计算。（本地 `/sobey/canvas-plus/research/win147-comfyui/workflows/flux1-dev-official.json`）

**不适用/弱效果**：关键词列表式堆叠——官方称其「Less Effective」，要求改用散文（BFL skills `rules/core-principles.md` §4）。

---

## 3. 语言与长度

**语言**
- FLUX.1-dev 官方 model card 的语言标注为 **English（`language: en`）**；官方 skills 与 docs 的示例提示词与词表**全部为英文**。
- **未查到 FLUX.1 多语言（含中文）支持的官方声明**。官方多语言条目只针对 FLUX.2：「FLUX.2 can be prompted in multiple languages, so you don't need to write in English. English prompts tend to produce the most precise results.」（`docs.bfl.ml/guides/prompting_unified_reference` →「FLUX.2 (all variants)」）。**不可将此条挪用到 FLUX.1-dev。**

**长度**
- 官方甜点：**30–80 词**；「Too short: Lacks direction, generic results；Too long: Can become unfocused」；模型上限 **512 token**。（BFL skills `rules/core-principles.md` §7）
- FLUX.1-dev 模型卡 diffusers 示例：`max_sequence_length=512`。

---

## 4. 画面内文字

官方规则（BFL skills `rules/typography-text.md`，全族通用）：
1. **用引号包裹精确文字**：`Correct: A poster with "HELLO WORLD" in bold letters` / `Wrong: A poster with HELLO WORLD in bold letters`。
2. **指明字体风格**：`"ADVENTURE" in bold sans-serif`、`"Welcome" in elegant cursive script`、`"CHAPTER ONE" in classic serif typeface`。
3. **描述大小层级与位置**：`Large headline "BREAKING NEWS" above smaller subtext "Details inside"`；`"OPEN" sign centered in storefront window`。
4. **文字描述前置**（Front-Load Text）：「Place text descriptions early in the prompt for better accuracy.」

**能力归属提醒**：官方 skill 明确「Use FLUX.2 [flex] for best typography results.」（`rules/typography-text.md` 首段）。**官方未对 FLUX.1-dev 的画面内文字能力给出任何声明或指标**——即「用引号+字体描述」是官方写法规则，但「能不能写好整段排版」官方未背书 FLUX.1-dev。FLUX.1-dev 模型卡自带的 diffusers 示例提示词为 `A cat holding a sign that says hello world`（未加引号，故不能作为「官方要求加引号」的反例证明，因为该规则来源是官方 typography 规则文件）。

---

## 5. 分辨率与参数档

**BFL 官方 API（`/v1/flux-dev`，权威参数边界）**
| 参数 | 官方约束 | 默认 |
|---|---|---|
| width / height | 整数，**最小 256、最大 1440，必须为 32 的倍数** | 1024 / 768 |
| steps | 1–50 | 28 |
| guidance | 1.5–5.0；官方说明「High guidance scales improve prompt adherence at the cost of reduced realism.」 | 3.0 |
| prompt_upsampling | 布尔 | false |
| safety_tolerance | 0–6（0 最严） | 2 |
| output_format | jpeg / png / webp | jpeg |

出处：BFL OpenAPI（`https://api.bfl.ai/openapi.json`，页面 `docs.bfl.ml/api-reference/models/generate-an-image-with-flux1-[dev]`）。

**FLUX.1-dev 官方 model card（diffusers 参考实现）**：`height=1024, width=1024, guidance_scale=3.5, num_inference_steps=50, max_sequence_length=512`。

**ComfyUI 官方模板（`flux_dev_full_text_to_image`，Comfy-Org 官方模板，非 BFL）**：EmptySD3LatentImage `1024×1024`；KSampler `20 步 / cfg=1 / euler / simple`；`ConditioningZeroOut` 清负面。

> 三处官方口径不一致（API 28 步 / guidance 3.0；model card 50 步 / guidance 3.5；ComfyUI 模板 20 步），系不同运行环境（托管 API vs 参考实现 vs 本地工作流）的各自默认值，**不存在唯一「官方标准档」**。

---

## 6. 未查到官方依据的项

以下项目**未找到官方依据**，不得当作官方口径使用：

1. **FLUX.1-dev 专属的逐条提示词规范**：BFL 未为 `FLUX.1-dev` 单列 prompting 指南；现行 `docs.bfl.ml` 作图指南面向 FLUX 3 Image，`Model-Specific Quick Reference` 只覆盖 FLUX 3 Image / FLUX.2 / FLUX.1 **Kontext**，**没有 FLUX.1 [dev] 文本生图条目**。第 1 节规则来自 BFL 官方 skills 的「全族通用」文件，非 dev 专属。
2. **内部旧稿引用的原句「Avoid negative prompts. FLUX responds to what you describe, not a list of what to avoid.」**：在现行官方站未检索到该逐字句（原 `guides/prompting_summary` 页已改版为 FLUX 3 指南）。本清单改以现行官方原文为准（见第 2、7 节）；该旧句如需引用须标注为「历史版本，现已改版」。
3. **中文/多语言提示词可用性与表现**：FLUX.1 系无官方声明（多语言仅 FLUX.2 有条目）。
4. **权重语法 `(word:1.2)` / 负面词库 / 采样步数甜点**：无官方依据。
5. **FLUX.1-dev 画面内文字准确率**：无官方指标，官方仅推荐 FLUX.2 [flex] 做排版。
6. **本地（ComfyUI）分辨率上限**：除 API 的 1440 上限外，官方未声明本地可越界范围。
7. **提示词词数硬上限**：官方只给「30–80 词甜点」与「512 token 模型上限」，无最短字数要求。

---

## 7. 官方原文摘录（逐字 + 来源 URL）

**① 反对负面提示词（核心三条）**
- 「FLUX does NOT support negative prompts. Always describe what you WANT, not what you don't want.」
  —— `https://raw.githubusercontent.com/black-forest-labs/skills/master/skills/flux-image-best-practices/rules/core-principles.md`（§1 Positive Descriptions Only）
- 「**NO negative prompts** - FLUX does not support negative prompts; describe what you want」
  —— `https://raw.githubusercontent.com/black-forest-labs/skills/master/skills/flux-image-best-practices/SKILL.md`（Critical Rules #1）
- 「FLUX does not support negative prompts. ... Negative prompts can actually make models focus MORE on unwanted elements. Instead, describe exactly what you DO want - this gives clearer direction and better results.」
  —— `https://raw.githubusercontent.com/black-forest-labs/skills/master/skills/flux-image-best-practices/rules/negative-prompt-alternatives.md`（首段）
- 「FLUX models don't support negative prompts. Even if they could process negatives, AI models generally struggle with negation. When you write "a person without glasses," the model focuses on the word "glasses" and often generates exactly what you're trying to avoid.」
  —— `https://docs.bfl.ml/guides/prompting_guide_t2i_negative`（Working Without Negative Prompts）

**② 结构 / 前置 / 光线 / 长度**
- 结构公式：「`[Subject] + [Action/Pose] + [Style/Medium] + [Context/Setting] + [Lighting] + [Technical Details]`」
- 前置：「FLUX prioritizes elements that appear earlier in the prompt. Front-load important elements.」
- 光线：「Always specify lighting - it has the single greatest impact on image quality.」
- 长度：「Optimal prompt length is typically 30-80 words (FLUX can handle up to 512 tokens).」
- 散文优于关键词：「Write prompts as descriptive prose rather than keyword lists.」
  —— 均出自 `https://raw.githubusercontent.com/black-forest-labs/skills/master/skills/flux-image-best-practices/rules/core-principles.md`（§2、§6、§5、§7、§4）
- 「A clear structure matters more than length.」「Start with the subject and what it is doing.」「Name the style concretely: a medium, an era, a film stock.」
  —— `https://docs.bfl.ml/guides/prompting_unified_building`（Structure helps / Practical advice）

**③ hex 颜色**
- 「Never use hex codes alone - include the color name: Good: #FF6B6B (coral pink) Bad: #FF6B6B」
  —— `https://raw.githubusercontent.com/black-forest-labs/skills/master/skills/flux-image-best-practices/rules/hex-color-prompting.md`（Best Practices #1）

**④ 画面内文字**
- 「Always quote the exact text you want rendered」「Front-Load Text: Place text descriptions early in the prompt for better accuracy.」「Use FLUX.2 [flex] for best typography results.」
  —— `https://raw.githubusercontent.com/black-forest-labs/skills/master/skills/flux-image-best-practices/rules/typography-text.md`

**⑤ FLUX.1-dev 官方 model card（HF 门禁，Wayback 归档核读）**
- 「FLUX.1 [dev] is a 12 billion parameter rectified flow transformer capable of generating images from text descriptions.」
- 「Trained using guidance distillation, making FLUX.1 [dev] more efficient.」
- 「Prompt following is heavily influenced by the prompting-style.」（Limitations 段）
- diffusers 示例：`prompt = "A cat holding a sign that says hello world" ... height=1024, width=1024, guidance_scale=3.5, num_inference_steps=50, max_sequence_length=512`
  —— `https://web.archive.org/web/20260927004734/https://huggingface.co/black-forest-labs/FLUX.1-dev`

**⑥ BFL OpenAPI `/v1/flux-dev`**
- width/height：「Must be a multiple of 32.」min 256 / max 1440；steps 默认 28（1–50）；guidance 默认 3（1.5–5）「High guidance scales improve prompt adherence at the cost of reduced realism.」；prompt_upsampling 默认 false。
  —— `https://docs.bfl.ml/api-reference/models/generate-an-image-with-flux1-[dev]`（内嵌 `https://api.bfl.ai/openapi.json`）

---

### 出处信源清单（便于复核）
- BFL 官方 skills 仓库：`https://github.com/black-forest-labs/skills` → `skills/flux-image-best-practices/`（SKILL.md、rules/core-principles.md、rules/negative-prompt-alternatives.md、rules/t2i-prompting.md、rules/hex-color-prompting.md、rules/typography-text.md、rules/flux1-models.md）
- BFL 官方文档站：`https://docs.bfl.ml`（llms.txt 索引；guides/prompting_guide_t2i_negative、guides/prompting_unified_building、guides/prompting_unified_reference、api-reference/models/generate-an-image-with-flux1-[dev]）
- FLUX.1-dev 官方 model card（归档）：`https://web.archive.org/web/20260927004734/https://huggingface.co/black-forest-labs/FLUX.1-dev`
- ComfyUI 官方模板（非 BFL）：`/sobey/canvas-plus/research/win147-comfyui/workflows/flux1-dev-official.json` ← `Comfy-Org/workflow_templates/templates/flux_dev_full_text_to_image.json`

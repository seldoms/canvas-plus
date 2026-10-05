# 视频类模型 · 官方要求的提示词要素基准表

> **用途**：后端在"发起生成那一刻"按所选模型的官方规范编译提示词，需要一张可信的基准表。
> **硬纪律**：本表只写官方说过的；每行带出处；核不出出处的写「未查到官方依据」，不推测、不用社区经验顶替。
> **建立日期**：2026-10-05。
> **覆盖模型**：wan21-t2v、wan22-animate、scail2、minimax-h3（另附 `跨模型共性要素`）。

## 出处记号（正文引用用）

| 记号 | 含义 / 文件路径 |
|---|---|
| **W-PE** | `/sobey/canvas-plus/canvas-server/prompts/rewriters/wan-prompt-extend.md`（逐字来源 Wan2.1 `wan/utils/prompt_extend.py`，6 套系统提示词） |
| **W21-JSON** | `/sobey/canvas-plus/research/win147-comfyui/workflows/wan21-t2v-official.json`（= Comfy-Org/workflow_templates `text_to_video_wan.json`） |
| **W22A-JSON** | `/sobey/canvas-plus/research/win147-comfyui/workflows/wan22-animate-official.json`（= `video_wan2_2_14B_animate.json`） |
| **S2-E** | `/sobey/canvas-plus/canvas-server/prompts/rewriters/scail2-enhancer.md`（逐字来源 SCAIL-2 `prompt_enhancer.py`） |
| **S2-JSON** | `/sobey/canvas-plus/research/win147-comfyui/workflows/scail2-character-replacement-official.json` |
| **H3-BASE** | `/root/.agents/skills/h3-prompt-writing/references/base-en.txt`（官方 Video Prompt Writing Guide · 基础模式） |
| **H3-REF** | `/root/.agents/skills/h3-prompt-writing/references/ref-en.txt`（官方 Full-Reference Mode Rewrite Output Format Guide） |
| **H3-SKILL** | `/root/.agents/skills/h3-prompt-writing/SKILL.md` |
| **H3-T2VA-JSON** / **H3-I2VA-JSON** | `/sobey/canvas-plus/research/win147-comfyui/workflows/minimax-h3-*-official.json` |

补充核证用的官方 URL（本次逐字抓取核对）：

- Wan2.1 README：<https://github.com/Wan-Video/Wan2.1/blob/main/README.md>
- Wan2.1 改写器源码：<https://github.com/Wan-Video/Wan2.1/blob/main/wan/utils/prompt_extend.py>
- Wan2.2 README（含 Animate 段）：<https://github.com/Wan-Video/Wan2.2/blob/main/README.md>
- ComfyUI Wan2.2-Animate 教程：<https://docs.comfy.org/tutorials/video/wan/wan2-2-animate>
- Wan2.2-Animate 官方模板：<https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_14B_animate.json>
- SCAIL-2 README（`wan-scail2` 分支）：<https://github.com/zai-org/SCAIL-2/blob/wan-scail2/README.md>
- SCAIL-2 改写器源码：<https://github.com/zai-org/SCAIL-2/blob/wan-scail2/prompt_enhancer.py>
- SCAIL-2 官方模板：<https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan21_scail2_character_replacement.json>
- ComfyUI SCAIL-2 教程：<https://docs.comfy.org/tutorials/video/zai/scail2>
- MiniMax H3 官方 Prompt Guide（托管页）：<https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide>
- MiniMax H3 原生工作流教程：<https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native>
- MiniMax H3 总览（能力/时长）：<https://docs.comfy.org/tutorials/video/minimax/minimax-h3>

---

## wan21-t2v

### 0. 结论摘要

- 官方**不给"手工提示词模板"**，而是提供 **Prompt Extension（提示词扩写）机制**：官方 README 明确"推荐开启"扩写，用 Qwen 把短输入扩成丰满提示词。
- 官方**要求的提示词要素全部落在 6 套系统提示词**里（`wan/utils/prompt_extend.py`）：不改变原意地补细节、完善主体特征/风格/空间关系/镜头景别、**强调运动与运镜**、给主体加自然动作（简单直接动词）、保留引号/书名号原文、**长度 80–100 字/词**。
- 官方**负面提示词固定为一串中文**（ComfyUI 官方模板原样沿用），需写。
- 官方文本编码器 umt5 支持中英双语，扩写器有 **中/英 × LM/VL/双图-VL 共 6 个变体**，输出语言由变体决定。

### 1. 官方要求的提示词要素

| 要素 | 官方要求（逐字要点） | 必需/可选 | 官方出处 |
|---|---|---|---|
| 不改变原意 | "在不改变原意前提下，合理推断并补充细节"；英文变体 "without altering the original intent" | 必需 | W-PE:20,41 |
| 主体特征 | 完善"外貌、表情，数量、种族、姿态等" | 必需 | W-PE:21、41–42 |
| 画面风格 | "Prompt应匹配符合用户意图且精准细分的风格描述"；未指定时按画面选最恰当风格，或默认纪实摄影 | 必需 | W-PE:23、44 |
| 空间关系 | 完善"空间关系" | 必需 | W-PE:21、41–42 |
| 镜头景别 | 完善"镜头景别"；英文 "shot scales" / "camera angles" | 必需 | W-PE:21、42、85 |
| **运动信息 + 镜头运镜** | "你需要强调输入中的运动信息和不同的镜头运镜" / "Emphasize motion information and different camera movements" | **必需（强调）** | W-PE:25、45 |
| 自然动作 | "输出应当带有自然运动属性……增加这个目标的自然动作，描述尽可能用简单直接的动词" | 必需 | W-PE:26、46 |
| 保留原文 | "保留引号、书名号中原文以及重要的输入信息，不要改写" | 必需 | W-PE:22、43 |
| 长度 | "改写后的prompt字数控制在80-100字左右" / "around 80-100 words long" | 必需 | W-PE:27、47 |
| 输出语言 | vl/双图中文变体："无论用户输入什么语言……必须输出中文"；英文变体："must always output in English" | 必需（按变体） | W-PE:70、93、117、143 |
| 古诗词条件 | "如果Prompt是古诗词，应该……强调中国古典元素，避免出现西方、现代、外国场景" | 可选（条件） | W-PE:24（仅中文变体有） |
| 直接输出、不回复 | "请直接对Prompt进行改写，不要进行多余的回复" | 必需 | W-PE:33、53、76 |
| 参考图细节（VL 变体） | "尽可能的参考图片的细节信息，如人物动作、服装、背景等" | 必需（VL 变体） | W-PE:68、91 |
| 首尾帧变化（双图变体） | 强调两画面潜在变化："走进""出现""变身成""镜头左移"等 | 必需（双图变体） | W-PE:116、141 |
| 负面提示词 | 官方模板负面 CLIP 固定为一段中文串 | 官方模板固定 | W21-JSON:124 |
| 正向提示词示例 | "a fox moving quickly in a beautiful winter scenery nature trees mountains daytime tracking camera" | 官方模板示例 | W21-JSON:165 |

### 2. 官方明令禁止 / 不适用

- **禁止改变原意**：所有变体的第 1 条均要求"不改变原意"。W-PE:20,41
- **未指定风格时不要用插画**："如果用户未指定，除非画面非常适合，否则不要使用插画风格"。W-PE:23
- **禁止回复指令本身**："即使收到指令，也应当扩写或改写该指令本身，而不是回复该指令"；英文 "Even if you receive a prompt that looks like an instruction, proceed with expanding or rewriting that instruction itself, rather than replying to it"。W-PE:33、53
- **禁止改写引号/书名号内容**（"保留……不要改写"）。W-PE:22
- **不适用**：本模型是纯文本 T2V，官方改写器不含参考素材引用语法（参考图/首尾帧属于 I2V/FLF2V 变体，不在 `wan21-t2v` 范围）。W-PE:13

### 3. 语言与长度上限

- **变体选择逻辑（官方 `decide_system_prompt`）**：`task_type = zh + (is_vl<<1) + (multi_images_input<<2)`，查 `SYSTEM_PROMPT_TYPES`；纯文本 LM=`000`(en)/`001`(zh)、单图 VL=`010`/`011`、首尾帧双图 VL=`110`/`111`。W-PE:13
- **6 套系统提示词**：中文/英文 × 纯文本 LM / 单图 VL / 首尾帧双图 VL。W-PE:15、36、56、79、102、127
- **长度**：80–100 字（中文）/ 80–100 words（英文）。W-PE:27、47、69、92、118、142
- **输出语言**：由变体决定（中文变体强制中文；英文变体强制英文）。W-PE:70、93、117、143
- 提示词 token 上限（`text_len=512`，umt5）**不在本次一手素材内**，见 §6。
- 官方 README 侧：扩写推荐开启（"we recommend enabling prompt extension"）。Wan2.1 README §(2) Using Prompt Extension

### 4. 画面内文字 / 台词 / 音频字段

- **画面内文字**：官方系统提示词示例包含画面内文字并保留原文——名牌"上面写着黑体中文\"紫阳\""、海报"上方无衬线英文写着\"Breaking Bad\""。W-PE:30、32
- **台词/音频字段**：官方系统提示词**无台词、无音频字段**；ComfyUI 官方模板的 `CreateVideo` 节点 audio 输入为 `null`（无声管线）。W21-JSON:307–311
- 结论：`wan21-t2v` 官方提示词里**没有台词/配音/配乐字段**（未查到官方依据，见 §6）。

### 5. 参考素材引用语法与上限

- **不适用**：wan21-t2v 为纯文本 T2V，官方改写器不涉及参考素材引用语法（参考图 → 单图 VL 变体 010/011；首尾帧 → 双图 VL 变体 110/111，属 I2V/FLF2V）。W-PE:13
- 无 `<Picture N>` 之类标签体系（该体系属 H3，见 minimax-h3 节）。

### 6. 未查到官方依据的项

- **提示词 token 硬上限**（如 `text_len=512`）：本次一手素材（改写器 + 官方模板）中未出现；该项目另有二手登记（`research/win147-comfyui/sources/video-models.md`），本表不作官方口径。
- **"必须把镜头景别写在句末"之类格式硬规则**：官方只要求"完善镜头景别/强调运镜"，未规定书写位置。
- **负向约束的写法规则**（是否需并进正向句）：Wan 系有独立负面串字段（W21-JSON:124），无"禁项写正向"的要求。
- **分辨率/时长/帧率**：属模型侧参数规范，不属于提示词要素。

### 7. 官方原文摘录（逐字 + 出处）

**纯文本 LM · 中文 · 任务要求（W-PE:20–27）**

```
1. 对于过于简短的用户输入，在不改变原意前提下，合理推断并补充细节，使得画面更加完整好看；
2. 完善用户描述中出现的主体特征（如外貌、表情，数量、种族、姿态等）、画面风格、空间关系、镜头景别；
3. 整体中文输出，保留引号、书名号中原文以及重要的输入信息，不要改写；
4. Prompt应匹配符合用户意图且精准细分的风格描述。如果用户未指定，则根据画面选择最恰当的风格，或使用纪实摄影风格。如果用户未指定，除非画面非常适合，否则不要使用插画风格。如果用户指定插画风格，则生成插画风格；
5. 如果Prompt是古诗词，应该在生成的Prompt中强调中国古典元素，避免出现西方、现代、外国场景；
6. 你需要强调输入中的运动信息和不同的镜头运镜；
7. 你的输出应当带有自然运动属性，需要根据描述主体目标类别增加这个目标的自然动作，描述尽可能用简单直接的动词；
8. 改写后的prompt字数控制在80-100字左右
```

**纯文本 LM · 英文 · Task requirements（W-PE:41–47）**

```
1. For overly concise user inputs, reasonably infer and add details to make the video more complete and appealing without altering the original intent;
2. Enhance the main features in user descriptions (e.g., appearance, expression, quantity, race, posture, etc.), visual style, spatial relationships, and shot scales;
3. Output the entire prompt in English, retaining original text in quotes and titles, and preserving key input information;
4. Prompts should match the user’s intent and accurately reflect the specified style. If the user does not specify a style, choose the most appropriate style for the video;
5. Emphasize motion information and different camera movements present in the input description;
6. Your output should have natural motion attributes. For the target category described, add natural actions of the target using simple and direct verbs;
7. The revised prompt should be around 80-100 words long.
```

**官方负面提示词串（W21-JSON:124，原样沿用）**

```
色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走
```

**官方正向提示词示例（W21-JSON:165）**

```
a fox moving quickly in a beautiful winter scenery nature trees mountains daytime tracking camera
```

---

## wan22-animate

### 0. 结论摘要

- 官方口径：**提示词是辅助项**。三条独立证据：① 官方 ComfyUI 模板正向提示词只有一句 **"The character is dancing in the room"**（W22A-JSON:594）；② 官方 Wan2.2 README 的 Diffusers 示例提示词为 **"People in the video are doing actions."**（Wan2.2 README）；③ 官方 ComfyUI 教程写 **"Update the prompt if you want"**（docs.comfy.org 教程）。
- 角色**长相/服装/背景由"驱动视频 + 角色参考图"决定**，不由 prompt 决定——官方模板用 `LoadVideo`（驱动视频）+ `LoadImage`（角色参考图）作为输入，prompt 仅描述动作。
- 官方**未提供 Animate 专用改写器**（Wan2.2 `prompt_extend.py` 的 `DEFAULT_SYS_PROMPTS` 只覆盖 t2v-A14B / i2v-A14B / ti2v-5B，**没有 animate 项**）。
- 负面提示词：官方模板沿用 Wan2.1 中文负面串，需写。
- 官方 README 警告：**不要在 Wan-Animate 上挂 Wan2.2 训练的 LoRA**。

### 1. 官方要求的提示词要素

| 要素 | 官方要求（逐字要点） | 必需/可选 | 官方出处 |
|---|---|---|---|
| 描述动作（"人在做什么"） | 官方模板示例："The character is dancing in the room"；官方 README Diffusers 示例："People in the video are doing actions." | 模板示例（辅助） | W22A-JSON:594；Wan2.2 README（Diffusers 段 `prompt = "People in the video are doing actions."`） |
| 外观/服装/背景 | 由"角色参考图 + 驱动视频"决定（模板用 `LoadImage` + `LoadVideo` 节点作为输入；prompt 不承载这些） | —（非 prompt 要素） | W22A-JSON（`LoadVideo` 节点#145、`LoadImage` 节点#10） |
| 负面提示词 | 官方模板负面 CLIP 固定为 Wan2.1 中文负面串 | 模板固定 | W22A-JSON:639 |
| 提示词是否必填 | 教程原文 "Update the prompt if you want"（"要改就改"，暗示可选） | 可选/辅助 | docs.comfy.org 教程 <https://docs.comfy.org/tutorials/video/wan/wan2-2-animate> |

### 2. 官方明令禁止 / 不适用

- **不要挂 Wan2.2 系 LoRA**：官方 README 原文 "If you're using **Wan-Animate**, we do not recommend using LoRA models trained on `Wan2.2`, since weight changes during training may lead to unexpected behavior."（Wan2.2 README）
- **不适用**：官方材料**未声明** prompt 可用于控制背景/服装/长相/镜头——这些由驱动视频与参考图决定。用 prompt 改背景/服装在官方材料中**未查到依据**（见 §6）。
- **不适用**：官方未提供 Animate 的提示词改写器（Wan2.2 `DEFAULT_SYS_PROMPTS` 无 animate 键）。

### 3. 语言与长度上限

- 官方模板示例与 README 示例均为**英文**（一句话）。
- 官方**未给出字数上限、也未给出语言硬性规定** → 见 §6。
- 官方 README 明确生成质量约束不在 prompt：`guidance_scale=1.0`、`num_inference_steps=20`（属参数，不属 prompt 规范）。

### 4. 画面内文字 / 台词 / 音频字段

- 官方模板**无音频/台词/配乐字段**；`CreateVideo` 无音频输入（W22A-JSON）。
- 官方模板 Note 说明两种模式（Mix=角色替换 / Move=姿态迁移）用**断开节点连线**切换，与提示词无关。W22A-JSON:235
- → 画面内文字/台词/音频字段：**未查到官方依据**（见 §6）。

### 5. 参考素材引用语法与上限

- **输入是素材而非 prompt 语法**：驱动视频（`LoadVideo`）+ 角色参考图（`LoadImage`）；用 `PointsEditor` 点选要跟踪的人。W22A-JSON（节点#145、#10、#229）
- prompt 中**无** `<Picture N>` 之类引用标签（该体系属 H3）。
- 官方模板 Note：`WanAnimateToVideo` 节点宽高**必须是 16 的倍数**（属节点约束，非 prompt）。W22A-JSON:161 附近 Note "about size"

### 6. 未查到官方依据的项

- prompt 的**字数/语言硬性规定**：官方无。
- prompt **能否控制场景/服装/长相/镜头**：官方材料未声明；官方示例只描述动作。
- Animate 的**负面提示词规范**：官方只给模板固定中文串，无 Animate 专用说明。
- **画面内文字/台词/音频字段**：官方无。
- **Animate 专用提示词改写器/模板**：官方无（Wan2.2 改写器不含 animate）。

### 7. 官方原文摘录（逐字 + 出处）

**官方 ComfyUI 模板正向提示词（W22A-JSON:594）**

```
The character is dancing in the room
```

**官方 ComfyUI 模板负面提示词（W22A-JSON:639）**

```
色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走
```

**官方 README · Run Wan-Animate（Wan2.2 README 原文）**

```
Wan-Animate takes a video and a character image as input, and generates a video in either "animation" or "replacement" mode.

1. animation mode： The model generates a video of the character image that mimics the human motion in the input video.
2. replacement mode: The model replaces the character image with the input video.
```

**官方 README · Diffusers 示例提示词（Wan2.2 README）**

```
prompt = "People in the video are doing actions."
```

**官方 README · LoRA 警告（Wan2.2 README）**

```
> 💡 If you're using **Wan-Animate**, we do not recommend using LoRA models trained on `Wan2.2`, since weight changes during training may lead to unexpected behavior.
```

**官方 ComfyUI 教程（https://docs.comfy.org/tutorials/video/wan/wan2-2-animate）**

```
Make sure all the models are loaded correctly Update the prompt if you want Upload the reference image, the character is this image will be the target character ...
```

**官方 ComfyUI 模板 Note · 两种模式（W22A-JSON:235）**

```
The model has two modes:
- Mix: character replace
- Move: Pose transfer

If you want to switch to **Move** mode, please disconnect **Background_video** and **Character_mask** output from the **WanAnimateToVideo** node.

Bypass will still pass the input video to the **WanAnimateToVideo** node, so please disconnect them.
```

**官方 Wan2.2 改写器覆盖面（Wan2.2 `wan/utils/prompt_extend.py` `DEFAULT_SYS_PROMPTS`，本次抓取核对）**

```
DEFAULT_SYS_PROMPTS = {
    "t2v-A14B": {"zh": T2V_A14B_ZH_SYS_PROMPT, "en": T2V_A14B_EN_SYS_PROMPT},
    "i2v-A14B": {...},
    "ti2v-5B": {...},
}
```

（**无 animate 键** → 官方未提供 Wan2.2-Animate 提示词改写器。）

---

## scail2

### 0. 结论摘要

- 官方核心要求：**prompt 描述"生成后的视频本身"，不是对模型的指令**；替换模式下描述**"替换已经发生之后"**的画面。
- 官方明示：**模型用长而详细的提示词训练**——"Short prompts or an empty prompt can run, but detailed descriptions of the reference subject and motion usually produce better results."
- 官方提供**两段式改写器** `prompt_enhancer.py`：① 对源视频抽帧写英文 caption；② 结合用户指令 + caption + few-shot 示例 + 替换参考图，合成最终正向 prompt（**禁止出现 replace/swap/edit 字样**，英文一段 **90–140 词**）。
- 替换模式必须写：替换角色的**可见服装与外貌**（以参考图为身份/服装来源）+ 角色**交互/贴近的物体**；保留原视频**环境/光线/机位/景别/背景物体/运动轨迹**。

### 1. 官方要求的提示词要素

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| 描述"生成后的视频本身" | "`--prompt` should describe the generated video itself. It should not be an instruction to the model." | 必需 | SCAIL-2 README「Prompt Semantics」；S2-E:37 |
| 替换模式描述"替换已发生之后" | "the prompt should describe the video after replacement has already happened" | 必需（替换模式） | SCAIL-2 README；S2-E:37 |
| 替换角色可见服装与外貌 | "describe the replacement character's visible clothing and appearance in enough detail, using the reference image as the source of identity and wardrobe details" | 必需 | S2-E:51；SCAIL-2 README |
| 移除原主体身份/外观 | 只保留"original subject's motion, pose, timing, spatial position, and interaction with the scene" | 必需 | S2-E:50 |
| 交互/贴近的物体 | "tools, instruments, furniture, vehicles, doors, tables, handheld items, or work surfaces" | 必需 | S2-E:52；SCAIL-2 README |
| 保留原始环境/光线/机位/景别/背景/运动轨迹 | "Keep the original video environment, lighting, camera angle, shot scale, background objects, and motion trajectory." | 必需 | S2-E:53 |
| 具体动词、自然视频措辞 | "Use natural video wording with concrete verbs." | 必需 | S2-E:55 |
| 正值描述（正向 prompt） | "Output a positive video-generation prompt describing the replaced video itself." | 必需 | S2-E:49 |
| 第一段 caption 聚焦点 | 场景/地点/光线/取景/背景；动作/运动/时序/运镜；被替换者服装/姿态/身体运动/交互物 | 必需（第一段） | S2-E:21–26 |
| 长度 | "one English paragraph, around 90-140 words" | 必需 | S2-E:56 |
| 语言 | 全程英文（caption 段 "one detailed English paragraph"） | 必需 | S2-E:21、37、56 |
| 长而详细的描述 | "SCAIL-2 is trained with long, detailed prompts. Short prompts or an empty prompt can run, but detailed descriptions of the reference subject and motion usually produce better results." | 强烈建议 | SCAIL-2 README |

### 2. 官方明令禁止 / 不适用

- **禁止替换/编辑类措辞**：不得输出 "replace X with Y"、"swap"、"edit"、"the task is"。S2-E:49
- **禁止提及实现细节**：不出现 masks、segmentation、editing software、Gemini、提示词生成过程。S2-E:55
- **第一段 caption 禁止**：不提替换目标图、不虚构替换目标身份。S2-E:28
- **只输出最终结果**：caption 段 "Output only the source-video caption."；合成段 "Output only the final enhanced prompt"。S2-E:29、56
- **不适用**：官方模板 Note 中"see **Prompt Writing** below"是**悬空引用**——该小节并未包含在模板文件里（全文件仅出现 1 次 "Prompt Writing"，即这句引用）。S2-JSON:542
- **不适用**：`sam3_video_object` / `sam3_image_object` 不是 SCAIL-2 的生成 prompt，只用于掩码跟踪（默认 "human"）。S2-JSON:542

### 3. 语言与长度上限

- **语言**：英文（caption 段 "one detailed English paragraph"；合成段 "one English paragraph"）。S2-E:21、37、56
- **长度**：合成段 **90–140 words**（英文一段）。S2-E:56
- **第一段**：one detailed English paragraph（未给词数）。S2-E:21
- 官方 few-shot 示例 `prompt_examples.txt` 限 **最多 4000 字符**填入模板 `{examples}` 槽位（改写器实现细节）。S2-E 头部来源说明
- 官方要求"长而详细"（README），短 prompt 能跑但效果差。

### 4. 画面内文字 / 台词 / 音频字段

- 官方两个提示词模板（caption / replacement）中**无台词、无音频、无画面文字字段**。S2-E:19–29、34–57
- few-shot 示例描述画面内容与背景物体，但**无文字渲染要求**。S2-E:64–65
- → 画面内文字/台词/音频：**未查到官方依据**（见 §6）。

### 5. 参考素材引用语法与上限

- **无标签体系**：官方 prompt 不用 `<Picture N>` 之类标签；替换参考图的身份/服装信息由模型从参考图读取，prompt 用**自然语言**描述替换角色外观（"using the reference image as the source of identity and wardrobe details"）。S2-E:51
- **输入四路**（`generate.py`）：`--image`（参考图）+ `--mask_image`（参考图掩码）+ `--pose`（驱动/姿态视频）+ `--mask_video`（逐帧驱动/替换掩码）。SCAIL-2 README
- **ComfyUI 侧输入**：`pose_video` + `reference_image` + SAM3 两个文本输入。S2-JSON:542
- **多参考（experimental）**：官方支持零样本多参考（`--additional_ref_image` / `--additional_ref_mask_image`，两列表长度须一致）；官方明确**未针对优化，视频质量可能下降**："video qualities may degrade even though additional information do get referenced"。SCAIL-2 README「Experimental Functions: Multi-Reference」
- prompt 规范中**未声明**参考图张数上限（上限信息属节点/接口，不在 prompt 规范）。

### 6. 未查到官方依据的项

- **SCAIL-2 专用负面提示词串**：官方未提供（ComfyUI 模板负面为空字符串；加速档 cfg=1 时负面不生效）→ S2-JSON。
- **"Prompt Writing" 小节**：模板注释引用了它，但文件内不存在（悬空引用）→ S2-JSON:542。
- **画面内文字/台词/音频字段规范**：官方无。
- **参考图张数上限（prompt 规范层面）**：官方无。
- **prompt 语言是否允许中文**：官方示例与模板改写器均英文，但未明确"必须英文"以外的语言规定（改写器模板本身要求英文输出）。

### 7. 官方原文摘录（逐字 + 出处）

**第一段 · 源视频抽帧 caption（S2-E:19–29）**

```
You are captioning sampled frames from a source video for a character replacement video generation task.

Describe the source video in one detailed English paragraph. Focus on:
- the scene, location, lighting, camera framing, and background;
- the action, motion, timing, and camera movement across the sampled frames;
- the clothing, pose, body motion, and nearby objects touched or interacted with by the person/character being replaced.

If the user specifies who should be replaced, identify that source subject clearly in the caption. Pay special attention to the source subject's clothing and any objects they hold, touch, operate, sit on, stand near, or otherwise interact with, because those details help locate the replacement region.

Do not mention the replacement target image. Do not invent an identity for the replacement target.
Output only the source-video caption.
```

**第二段 · 替换完成后的最终 prompt（S2-E:35–56）**

```
You are a prompt enhancer for SCAIL-2 character replacement.

Your task is to write one detailed English description of the final replaced video. This is not an editing instruction. The output must describe the video after replacement has already happened: the replacement character from the reference image is performing the source subject's motion in the source scene.
...
Rules:
1. Output a positive video-generation prompt describing the replaced video itself. Do not output wording like "replace X with Y", "swap", "edit", or "the task is".
2. Remove the original source subject's identity and appearance. Keep only the original subject's motion, pose, timing, spatial position, and interaction with the scene.
3. The final prompt for SCAIL-2 should describe the replacement character's visible clothing and appearance in enough detail, using the reference image as the source of identity and wardrobe details.
4. The final prompt should also describe important objects the character interacts with or stays close to in the source video, such as tools, instruments, furniture, vehicles, doors, tables, handheld items, or work surfaces.
5. Keep the original video environment, lighting, camera angle, shot scale, background objects, and motion trajectory.
6. If the source caption mentions the original subject's clothing only to locate body regions or interactions, translate those grounding details into the replacement character's final appearance instead of preserving the original identity.
7. Use natural video wording with concrete verbs. Avoid mentioning masks, segmentation, editing software, Gemini, or the prompt generation process.
8. Output only the final enhanced prompt, in one English paragraph, around 90-140 words.
```

**官方 README · Prompt Semantics（SCAIL-2 README，`wan-scail2` 分支）**

```
For both animation and character replacement, `--prompt` should describe the generated video itself. It should not be an instruction to the model.

For replacement tasks, the prompt should describe the video after replacement has already happened. For better results, describe the replacement character's visible clothing and appearance, and include objects the character interacts with or stays close to in the video, such as tools, instruments, chairs, tables, vehicles, doors, or handheld items.
```

**官方 README · 长提示词说明（SCAIL-2 README）**

```
Note that SCAIL-2 is trained with long, detailed prompts. Short prompts or an empty prompt can run, but detailed descriptions of the reference subject and motion usually produce better results.
```

**官方 README · 多参考质量提示（SCAIL-2 README）**

```
However, as the model is not optimized for such inputs, video qualities may degrade even though additional information do get referenced. To address this, mocking those reference images as videos reduce degradation and artifacts.
```

**官方 ComfyUI 模板 · 官方示例 prompt（S2-JSON:3696 与 7401，两处子图各一份）**

```
A young woman with dark hair tied in a neat high bun, with a few loose strands framing her face, is dancing outdoors on a sunny coastal hillside. She has a normal-sized head and a slim face, with no hat, no headwear, and no oversized hair volume. She wears a fitted black long-sleeve crop top with a shoulder cutout, extremely baggy black cargo pants with straps and pockets, and chunky black combat boots. She performs energetic dance moves with one leg lifted and arms extended, moving naturally in front of a large tree, a small white stone house with a terracotta roof, and a bright blue sea under a clear sky with light clouds.
```

**官方 ComfyUI 模板 Note · Prompt 相关段（S2-JSON:542）**

```
| `prompt` | Output video description — see **Prompt Writing** below |
...
## SAM3 (two inputs)

Not the SCAIL-2 `prompt` — only for mask track/segment:
...
Open-vocabulary text (default `human`). Use the same word when subject matches; use different words if video/ref need different focus (e.g. crowded scene → be more specific).

Colored masks bind body regions between ref and driving. Main `prompt` controls final appearance.
```

（注：上述 Note 引用的 "Prompt Writing" 小节在本模板文件中**不存在**——悬空引用。）

---

## minimax-h3

### 0. 结论摘要

- H3 官方发布**两册提示词改写规范**：基础模式（T2VA/I2VA/FL2VA/L2VA）与全参考模式（R2V/Ref2VA），字段名、段序、标签、时间格式**固定**，不得改动。H3-BASE / H3-REF
- 基础模式结构 =（关键帧对齐指令行，T2VA 无）+ 固定三字段 `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`。
- 全参考模式结构 = 固定六段 `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。
- **正文英文；台词/歌词/画面文字保留原始语言逐字**（台词进 `<d>[语言] ...</d>`，画面文字用英文双引号包原文）。
- **H3 无有效负面提示词**：模板走 BasicGuider 单条件、cfg 1，负向无分支；禁项必须**写成正向**（写"no subtitles"反而会把文字写进画面）。
- 官方云端教程补充：先总述整个场景，再拆成分镜（timed shots）。

### 1. 官方要求的提示词要素

**基础模式（T2VA / I2VA / FL2VA / L2VA）**

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| 关键帧对齐指令（首行） | I2VA 固定句 `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`；FL2VA/L2VA 用 `How the reference pictures align with the target video — …`，时间精确两位小数 | 条件必需（T2VA 无） | H3-BASE:16–34 |
| 三字段固定顺序 | `integrated_multimodal_description` → `overall_soundscape` → `non_diegetic_music` | 必需 | H3-BASE:36–48 |
| `integrated_multimodal_description` | 按时间轴描述视觉、动作、镜头、说话人、台词、歌唱、叙事内音频 | 必需 | H3-BASE:46、76 |
| `overall_soundscape` | 概括全片环境声、物理动作声、非语言人声 | 必需 | H3-BASE:46、152–158 |
| `non_diegetic_music` | 描述角色听不到、仅观众能听到的配乐 | 必需 | H3-BASE:48、160–166 |
| 镜头分镜 `[Shot N]` + 切镜时间 `MM:SS.mmm` | 首镜不加时间戳；后续镜严格递增、落在时长内 | 必需 | H3-BASE:84–92 |
| 运镜三维（类型+幅度+速度） | 写成自然英语动作句，不堆标签 | 必需（有运镜时） | H3-BASE:94–123 |
| 说话人稳定 ID | `(S1)` `(S2)`，多人合唱 `(S1,S2)`，跨镜同 ID；不发声者无 ID | 必需（有语音时） | H3-BASE:125–129 |
| 台词 `<d>` 块 | `<d>[Language] …</d>`，只含语言标签+用户提供的台词，逐字保留、不翻译 | 必需（有台词时） | H3-BASE:129–134 |
| 画外音 | 固定短语 `says in an off-screen voiceover` + 紧跟"嘴唇保持闭合" | 必需（有画外音时） | H3-BASE:136–140 |
| 跨切镜/截断 | `<scenetrans>`（跨切镜台词）、`<cutoff>`（结尾截断） | 条件 | H3-BASE:142 |
| 画面内文字 | 用英文双引号包原文逐字、不翻译（例：`A red neon sign reading "营业中"`） | 必需（有画面文字时） | H3-BASE:144–150；ComfyUI Prompt Guide |
| 风格 + 初始构图 | 在 `[Shot 1]` 开头点明整体风格与初始构图 | 必需 | H3-BASE:78 |
| 关键帧任务结构 | I2VA：首帧锚定→动作起点→连续发展→结果/反应；FL2VA：首帧状态→可见中间变化→差异收窄→尾帧；L2VA：推断前态→明确动作与过渡路径→末镜收敛→尾帧落点 | 要求 | H3-BASE:56、64、70 |
| 时长匹配 | 描述总时长必须等于目标视频时长（4–15 秒） | 必需 | H3-SKILL:37 |

**全参考模式（Ref2VA / R2V）**

| 要素 | 官方要求 | 必需/可选 | 官方出处 |
|---|---|---|---|
| 六段固定顺序 | `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music` | 必需 | H3-REF:13–23 |
| 四类引用标签 | `<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>`，跨段含义一致 | 必需 | H3-REF:26–35 |
| `subject_definitions` | 每项一行，写明标签含义、引用角色、需遵循的主要特征 | 必需 | H3-REF:37 |
| `summary` | 一段，以方括号任务类型前缀开头（`keyframe completion` / `reference generation` / `video editing` / `video continuation` / `audio reuse` / `audio reference`），多类型用 ` + ` 连接 | 必需 | H3-REF:121–141 |
| `retention_analysis` | 每个引用标签一行；视觉用 `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`；音频用 `fully_copy` / `partially_copy` / `reference` / `weak_reference` | 必需 | H3-REF:155–197 |
| `detailed_description` | 逐镜按播放顺序描述视觉/动作/声音/台词，插入引用标签；风格在 `[Shot 1]` 前用 1–2 句先立 | 必需 | H3-REF:209–242 |
| 引用标签在镜头中的用法 | 首次出现时描述其被引用的特征、画面位置、当前动作，后续沿用不重定义 | 必需 | H3-REF:246 |
| 说话人 = `<Subject N> (Sx)` | 引用主体发声时保留视觉标签与说话人 ID | 必需 | H3-REF:260–266 |
| 用户输入/音频复用核心 | 台词/歌词逐字保留原语言；不可辨写 `[unclear]`；标点规整 | 必需 | H3-REF:274、278 |

**官方 ComfyUI 教程补充要点（docs.comfy.org）**

| 要素 | 官方要求 | 出处 |
|---|---|---|
| 先总述整个场景再拆分镜 | "State the overall scene first (location, character, what is happening), then break it into timed shots." | ComfyUI Prompt Guide / native 教程 |
| 参考按连接顺序用 tag 引用（R2V） | "Reference each input by tag in the exact order it was connected, for example `<Picture 1>`, `<Video 1>`, `<Audio 1>`" | ComfyUI native 教程（R2V） |
| 给每个参考分配职责（R2V） | "State which reference drives which part of the shot (identity, style, motion, camera, voice). Explicit assignments tend to work much better." | ComfyUI native 教程（R2V） |
| prompt embedding | 用 `embedding:<name>` 语法引用（可选的风格 token） | ComfyUI Prompt Guide；H3-T2VA-JSON 模板 Note |

### 2. 官方明令禁止 / 不适用

- **负面提示词无效**：H3 模板走 `BasicGuider` 单条件、cfg 1，无负向分支 → 负向 prompt 无效果；且"no subtitles and no on-screen text"这类句子**会把 text 当内容写进画面**。必须改写成正面（如 `the sign above the door is blank`）。ComfyUI Prompt Guide
- **不要用抽象情绪词、不要解释配乐的情绪功能**："do not use abstract mood words or explain the emotional function of the score." H3-BASE:162
- **不要重复台词**：台词/歌唱/叙事内音乐已在 multimodal description，**不得**写进 `overall_soundscape` / `non_diegetic_music`。H3-BASE:154、303
- **禁止翻译/改写台词**：逐字保留原语言，不翻译。H3-BASE:129
- **首镜不加时间戳**："Do not add a timestamp to the first shot." H3-BASE:86
- **不要写成剧情摘要/参考关系清单**：`detailed_description` 要详尽、明确，避免退化成 "a plot summary or a list of reference relationships"。H3-REF:7
- **避免未解析的引用标签、时长不符的时间点**：H3-SKILL:35

### 3. 语言与长度上限

- **语言**：改写正文英文；对话、歌词、画面内可见文字保留原始语言、逐字。H3-REF:5；H3-BASE:129、146；ComfyUI Prompt Guide
- **基础模式长度**：`overall_soundscape` **1–4 句**；`non_diegetic_music` **1–3 句**。H3-BASE:154、162
- **全参考模式长度**：`summary` **一段**；`detailed_description` 生成任务 **350–500 英文词**（编辑类按源视频复杂度伸缩）；`overall_soundscape` / `non_diegetic_music` 同基础模式。H3-REF:123、242、284–301
- **视频时长**：官方范围 **4–15 秒**（4–15 seconds）。H3-SKILL:37；docs.comfy.org（open weights 约 15 秒）
- 时长吸附：ComfyUI 侧 length 为 24fps 帧数，吸附 **17k+5** 网格（属参数，非 prompt 规范）。H3-T2VA-JSON 模板 Note、ComfyUI Prompt Guide
- **提示词字符/token 硬上限**：一手素材未载（见 §6）。

### 4. 画面内文字 / 台词 / 音频字段

- **画面内文字**：用**英文双引号**包住屏幕上可见的文字（牌子、横幅、字幕、霓虹字），逐字复制、不翻译；每个字符串分别列出。例：`A red neon sign reading "营业中" glows above the doorway.` H3-BASE:146–150；ComfyUI Prompt Guide
- **台词/歌词**：`<d>[Language] …</d>`；说话人的识别短语、ID、动作、语气放在 `<d>` **外**，`<d>` **内**只放语言标签 + 台词原文。H3-BASE:129–134
- **画外音**：`says in an off-screen voiceover` + `<d>` 后明写"该角色嘴唇保持闭合"。H3-BASE:138–140
- **跨切镜/截断**：`<scenetrans>`（两侧连接点）与 `<cutoff>`。H3-BASE:142
- **`overall_soundscape`**：环境声 + 物理动作声 + 非语言人声，1–4 句；完全静音才写 `N/A`。H3-BASE:152–158
- **`non_diegetic_music`**：仅观众能听到的配乐，1–3 句；无则 `N/A`。H3-BASE:160–166
- **音频复用标记（R2V）**：`fully_copy` / `partially_copy` / `reference` / `weak_reference`，写在 `retention_analysis` 对应音频层。H3-REF:190–201；ComfyUI Prompt Guide
- **画面文字 vs 台词区分**：引号给印刷/屏幕文字，`<d>` 给角色说的话。ComfyUI Prompt Guide

### 5. 参考素材引用语法与上限

- **标签类型**：`<Subject N>`（可复用的可见内容：人/动物/物/场景/服装/道具/风格/动作/表情/姿态）、`<Picture N>`（具体目标帧或分镜锚点）、`<Video N>`（整视频关系：编辑源/续接起点/时序结构）、`<Audio N>`（复制或引用的音频信号）。H3-REF:26–35、39–106
- **编号独立**：`<Video N>` 与 `<Audio N>` 各自独立编号，索引不表示配对。H3-REF:108–119
- **关键帧对齐句式**：I2VA 固定句；FL2VA/L2VA 用 `How the reference pictures align with the target video — …`，`S.SS` 为有效时长、精确两位小数，**必须是首行**，后空一行。H3-BASE:16–34
- **标签按出现位置插入**：在 `detailed_description` 中标签首次清晰出现处描述其被引用特征；具体帧锚用自然短语（`the shot begins from <Picture 1>` 等）。H3-REF:246–256
- **参考图上限（R2V）**：本地 R2V 节点**≤ 9 张参考图**（"A sheet keeps several views inside the local R2V node's limit of 9 reference images"）。ComfyUI Prompt Guide
- 一张参考图可提供多个 subject，一个 subject 可由多个参考资产定义。H3-REF:48
- 参考图仅用于定义角色/场景/服装/风格时，**不单独建 `<Picture N>` 行**，而在对应的 `<Subject N>` 定义内引用来源。H3-REF:68

### 6. 未查到官方依据的项

- **提示词的字符/token 硬上限**（如"7000 字符"）：本次一手素材（base/ref 官方 guide、ComfyUI 官方页、官方模板）均未载；该数字来自项目其它登记，本表不作官方口径。
- **负面提示词字段**：官方明确**没有**（负向无分支），只能写成正向——不属"未查到"，属"官方否定项"。
- **分辨率/步数/采样**：属参数规范，不在提示词要素范围。

### 7. 官方原文摘录（逐字 + 出处）

**基础模式 · 三字段结构（H3-BASE:36–48）**

```
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...

- **integrated_multimodal_description**: Describes visuals, actions, shots, speakers, dialogue, singing, and diegetic audio along the timeline.
- **overall_soundscape**: Summarizes ambient sound, physical action sounds, and non-verbal human sounds across the entire video.
- **non_diegetic_music**: Describes background music that the characters cannot hear and only the audience can hear.
```

**基础模式 · 关键帧对齐指令（H3-BASE:16–34）**

```
**I2VA** always uses:
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

**FL2VA** always uses:
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.

**L2VA** always uses:
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

**基础模式 · 镜头与切镜（H3-BASE:86–92）**

```
Do not add a timestamp to the first shot. Use sequential shot numbers for later shots, and begin each one with a strictly increasing cut time that falls within the video duration:

[Shot 2] At 00:03.500, the camera cuts to...

For ordinary cuts, use `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, `the shot changes to`, or `the shot switches to`. When explicitly requested by the user, cross-dissolve, fade, or wipe may also be used. A cut should introduce new information about the subject, space, state, viewpoint, or time. If only the distance or a slight angle needs to change, prefer camera motion.
```

**基础模式 · 台词与说话人（H3-BASE:127–140）**

```
Subjects who speak, sing, or produce an off-screen human voice use stable IDs such as `(S1)` and `(S2)`. When multiple already-numbered speakers speak or sing together, use a compound ID such as `(S1,S2)`. A speaker keeps the same ID across shots; characters who never vocalize receive no speaker ID.

When a speaker first appears, provide enough information from the visual and audio context to establish a stable identity, such as character type, age, gender, whether the person is on-screen, pitch, timbre, speaking rate, or accent. Place the speaker's identifying phrase, ID, action, and delivery outside `<d>`. Inside `<d>`, include only the language tag and the actual user-provided spoken content. Preserve every original word and punctuation mark verbatim; do not translate or rewrite them.

The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
The two children (S1,S2) shout together, <d>[English] Wait for us!</d>

For voiceover, use the exact phrase `says in an off-screen voiceover`. Immediately after every voiceover `<d>` block, state that the corresponding on-screen character's lips remain closed:

The man (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while his lips remain completely closed.
```

**基础模式 · 画面内文字（H3-BASE:146–150）**

```
Place any banner, sign, label, subtitle, or neon text that is actually visible on screen in English double quotation marks. Preserve the original text and punctuation verbatim, without translation.

A red neon sign reading "营业中" glows above the doorway.
```

**基础模式 · 两个声音字段（H3-BASE:154、162）**

```
Use 1–4 English sentences in one continuous paragraph to summarize the ambient sound, physical action sounds, and non-verbal human sounds across the full video, such as wind, rain, traffic, footsteps, fabric movement, impacts, breathing, laughter, or panting. Dialogue, singing, and diegetic music already belong in the multimodal description and should not be repeated here. Use `N/A` only when the user explicitly requests complete silence throughout the video.

Use 1–3 English sentences to describe background music that the characters cannot hear and only the audience can hear. Focus on instrumentation, speed, rhythm, and dynamic changes; do not use abstract mood words or explain the emotional function of the score. ...
```

**全参考模式 · 六段结构（H3-REF:13–23）**

```
| Section | Purpose |
| `subject_definitions` | Defines referenced content and its reference labels |
| `summary` | Summarizes the task type, target video, and main reference relationships |
| `retention_analysis` | Describes how referenced content is preserved, transferred, or reused |
| `detailed_description` | Describes visuals, actions, shots, sound, and dialogue in playback order |
| `overall_soundscape` | Summarizes ambience and physical sounds |
| `non_diegetic_music` | Describes background music audible only to the audience |
```

**全参考模式 · 标签定义（H3-REF:28–33）**

```
| `<Subject N>` | Visible content abstracted from reference assets that can be reused or modified in the target video |
| `<Picture N>` | A reference image used as a concrete target frame or shot-planning anchor |
| `<Video N>` | A reference video that provides an editing source, continuation starting point, or whole-video temporal structure |
| `<Audio N>` | An audio signal that is copied or referenced |
```

**全参考模式 · 保留关系标记（H3-REF:163–169、192–197）**

```
| `fully_preserved` | The defined role of the referenced content is fully preserved |
| `partially_preserved` | The referenced content is still used, but some defined characteristics are changed or only partially retained |
| `attribute_transfer` | Referenced characteristics are transferred to a different identifiable target subject |
| `weak_reference` | Only broad similarity in style, category, composition, or atmosphere is retained |

| `fully_copy` | The complete source audio serves as the target video's complete final audio track |
| `partially_copy` | Only part of the timeline or selected audio layers are copied, or other sounds are added, removed, or replaced after copying |
| `reference` | The signal is not copied directly; only timbre, rhythm, music style, dialogue content, or sound texture is referenced |
| `weak_reference` | Only broad similarity in category or atmosphere is retained |
```

**全参考模式 · 词数与语言（H3-REF:5、242）**

```
Write all six rewrite sections in English. Preserve the original language only for dialogue and lyrics inside `<d>` and for text visibly present in the scene.

For generation tasks, `detailed_description` is normally 350-500 English words. Dialogue-dense content prioritizes fitting the complete spoken timeline rather than mechanically reaching a word count. Video-editing descriptions scale with the complexity of the source video and do not have to follow the generation-task range.
```

**官方 SKILL 提示（H3-SKILL:33–40）**

```
- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
## Tips for Better Results
- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.
```

**官方 ComfyUI Prompt Guide（https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide，逐字段落）**

```
The body carries three fields in this order: integrated_multimodal_description: [Shot 1] ... overall_soundscape: ... non_diegetic_music: ... Write the prompt itself in English. Keep dialogue and lyrics inside <d> tags, and screen-visible text in its original language, in both cases verbatim.

Describe the whole scene : State the overall scene first (location, character, what is happening), then break it into timed shots.

Write bans as positives : the H3 templates sample through the BasicGuider node, which carries a single conditioning input, so there is no negative branch and a negative prompt has no effect ... An instruction that names an unwanted element adds that wording to the description the model reads, with no separate pass to subtract it, so a line such as no subtitles and no on-screen text registers text as content. Say what should be in the shot instead, for example the sign above the door is blank .
```

**官方 ComfyUI 教程 · R2V 参考引用（https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native）**

```
Reference by tag : Reference each input by tag in the exact order it was connected, for example <Picture 1> , <Video 1> , <Audio 1>
Assign each reference a job : State which reference drives which part of the shot (identity, style, motion, camera, voice). Explicit assignments tend to work much better
Limits : ...
```

**官方 ComfyUI 模板 · 官方示例 prompt（H3-T2VA-JSON:283，T2VA 示例）**

```
Realistic live-action cinematic look, action movie trailer: practical film photography style, a post-rain dusk metropolis, anamorphic lens, shallow depth of field, film grain, city volumetric fog, flying-car traffic between the towers, restrained grading for a premium feel, powerful natural movement.

Scene overview: at dusk on a cluster of skyscrapers, the protagonist is being chased, sprinting and leaping across rooftops, jumping from one building's roof to the next with pursuers closing in behind. This is the escape sequence of an action movie trailer: every leap is life-or-death, thrilling and fluid.

Storyboard (each shot a separate scene, rapid cuts, all landing on the musical beats):
[0s-1.5s] Shot 1: high side angle: the protagonist sprinting at the roof edge, pursuers appearing in the rooftop doorway behind him, wind catching his coat.
[1s-2.5s] Shot 2: the protagonist leaps across the gap between buildings, body stretching mid-air, towers and flying-car light trails behind him, a slight slow-motion feel.
[2.5s-4s] Shot 3: he lands, rolls and rises, low-angle shot, tower shadows and fog behind him, he keeps running.
[4s-5s] Shot 4: freeze: the instant he hits the edge of the next roof and launches into the jump, silhouette, holding.

Camera: each shot its own angle, cuts clean and hard, no dissolves, a slight frame jitter on the jumps.

Audio: wind, rapid footsteps, city ambience, low score underneath, an accent hit on each leap, the score bursting at 4s, closing the last 1s.

No text, subtitles, logos or watermarks of any kind, no animation or cartoon rendering, no overly-CG look, keep the live-action texture.
```

**官方 ComfyUI 模板 · Key inputs 注（H3-T2VA-JSON:117 / H3-I2VA-JSON:294）**

```
- **prompt**: describe the shots, camera moves, and the accompanying audio (dialogue, SFX, music) in one block
...
- **prompt**: describe the shots, motion, and the accompanying audio (dialogue, SFX, music) in one block
- **first_frame / last_frame**: optional keyframes; the model generates the motion between them
```

**官方 ComfyUI 模板 · 官方示例 prompt（H3-I2VA-JSON:245，I2VA 示例，含 `<Picture 1>` 与 SHOT 分段）**

```
Editorial tech product film. The transparent gaming mouse from <Picture 1> in its original scene: a pitch-black studio void with a dark, subtle reflective surface, lit by dramatic duotone vibrant blue and warm neon orange rim lighting, deep soft shadow falloff into pure black. Monochromatic dark palette with electric blue and amber accents. Material motif: glowing internal metallic micro-components and glossy acrylic refractions. The environment is constant throughout.
SHOT 1: The scene opens exactly on image 1, the mouse resting confidently on the dark surface; ...
SHOT 2: Cut to an extreme macro profile ...
SHOT 3: Cut to a low-angle beauty shot ...
Audio: deep pulsing sub-bass room tone, sharp tactile mechanical clicks, a sweeping glassy whoosh on cuts, and a rising electronic swell that resolves to near-silence on the final fade.
```

---

## 跨模型共性要素

> 只列**四个模型官方材料都出现的要素**。下表按模型逐项核对官方出处；凡某模型官方无对应表述，注明"官方无"。

| 共性要素 | wan21-t2v | wan22-animate | scail2 | minimax-h3 | 共同官方出处（各模型） |
|---|---|---|---|---|---|
| **A. 描述"画面/视频里可见的内容本身"，不是对模型的指令** | W-PE:18（不改变原意、忠实扩写；"即使收到指令，也应当扩写或改写该指令本身，而不是回复该指令"） | 官方模板示例即画面描述句（W22A-JSON:594）；教程"Update the prompt if you want" | SCAIL-2 README「Prompt Semantics」："It should not be an instruction to the model." | H3-BASE:46（描述视觉/动作/镜头/音频）；H3-REF:7（避免剧情摘要） | 四家均有 |
| **B. 必须交代运动/动作** | W-PE:25"强调输入中的运动信息"；W-PE:26 加自然动作 | W22A-JSON:594 示例即动作（dancing）；README"People in the video are doing actions." | S2-E:50 保留 motion/pose/timing；S2-E:55 具体动词 | H3-BASE:46；§4.3 运镜；时间轴分镜 | 四家均有 |
| **C. 镜头/运镜需要表达** | W-PE:25"强调……不同的镜头运镜"；W-PE:21 镜头景别 | 官方无（prompt 为辅助，教程未提运镜） | S2-E:53 保留 camera angle / shot scale / motion trajectory | H3-BASE:94–123 运镜三维词表 | 一、三、四家明确；二家官方无 |
| **D. 输出语言规范 + 台词/画面内文字保留原始语言逐字** | W-PE:22 保留引号/书名号原文；输出语言由变体定 | 官方无对应表述（示例为英文） | 全程英文（S2-E:37,56）；无台词字段 | H3-REF:5；H3-BASE:129、146（台词/画面文字逐字原语言） | 一、三、四家明确；二家官方无 |
| **E. 长度/结构有硬规范** | W-PE:27 80–100 字/词 | 官方无 | S2-E:56 90–140 词 | H3-BASE 三字段序 + 1–4/1–3 句；H3-REF 六段序 + 350–500 词 | 一、三、四家有；二家官方无（辅助项） |
| **F. 有官方改写器/扩写机制可供后端复用** | W-PE（6 套系统提示词） | 官方无 Animate 改写器 | S2-E（两段式 prompt_enhancer.py） | H3-BASE + H3-REF（官方 guide） | 一、三、四家有；二家官方无 |
| **G. 参考素材决定身份/外观（而非 prompt）** | T2V 无参考（VL/双图变体属 I2V/FLF2V） | 角色参考图 + 驱动视频决定长相/服装/背景 | 替换参考图决定替换角色身份/服装（S2-E:51） | `<Picture N>`/`<Subject N>`/`<Video N>`/`<Audio N>`（H3-REF:26–35） | 二、三、四家有；纯 T2V 无 |

**跨模型差异（不是共性，需在编译层分模型处理）**

| 维度 | 差异要点 | 出处 |
|---|---|---|
| 提示词地位 | Wan T2V = 核心；SCAIL-2/H3 = 核心（长而详细）；**Wan2.2-Animate = 辅助项** | W22A-JSON:594；SCAIL-2 README；H3-BASE；W-PE |
| 负面提示词 | Wan/Animate 有固定中文负面串；SCAIL-2 官方未给专用负面串；**H3 无负向分支，禁项必须写正向** | W21-JSON:124；W22A-JSON:639；S2-JSON；ComfyUI Prompt Guide |
| 参考素材语法 | Wan/S2 无标签；H3 有 `<Subject/Picture/Video/Audio N>` 标签体系 | H3-REF:26–35 |
| 台词字段 | 仅 H3 有 `<d>` + `(Sx)` 体系与 `overall_soundscape` / `non_diegetic_music`；Wan/Animate/S2 官方无 | H3-BASE:125–166 |
| 长度 | Wan 80–100 字/词；SCAIL-2 90–140 词；H3 base 1–4/1–3 句 + Ref 350–500 词；Animate 无 | 各节 §3 |

---

*（本文件为只读素材的提炼产物；未改动任何代码/配置/其它文件。）*

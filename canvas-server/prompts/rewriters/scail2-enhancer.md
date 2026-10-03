# 官方改写器 · SCAIL-2 `prompt_enhancer.py`（两段式 caption → 合成）

<!-- rewriter-meta
source: SCAIL-2 repo prompt_enhancer.py（wan-scail2 分支）
backend: Gemini（可换 OpenAI 兼容 VLM）
rule: 两段式抽帧 caption→合成；描述替换已完成后的视频，禁 replace/swap/edit 字样；英文一段 90~140 词
reuse: 抄两段式结构与两个提示词
upstream: https://github.com/zai-org/SCAIL-2/blob/wan-scail2/prompt_enhancer.py
retrieved: 2026-10-03 wan-scail2 分支逐字抓取（含 examples/prompt_examples.txt）
-->

> **来源说明**：`optimization.md` §3.5 只给出「改写规则要点」摘要；本文件全文按 §3.5 指向的官方文件 `prompt_enhancer.py` **原样抓取**（逐字）。
> **两段式**：① `VIDEO_CAPTION_PROMPT` 对源视频抽帧（默认 8 帧）写英文 caption（聚焦场景/光线/取景/背景、动作/运动/时序/运镜、被替换者的服装/姿态/交互物体；**不提替换目标图、不虚构目标身份**）；② `REPLACEMENT_PROMPT_TEMPLATE` 结合用户指令 + caption + few-shot 示例 + 替换角色参考图，产出最终正向 prompt（**描述替换已完成的视频，禁止出现 replace/swap/edit 字样**，英文一段 90~140 词）。
> **few-shot 示例**：官方默认读 `prompt_examples.txt`（最多 4000 字符），填入模板 `{examples}` 槽位；原文随附于本文件末尾。

## 变体 `caption` — 第一段 · 源视频抽帧 caption

<<<REWRITER-PROMPT id="caption">>>
You are captioning sampled frames from a source video for a character replacement video generation task.

Describe the source video in one detailed English paragraph. Focus on:
- the scene, location, lighting, camera framing, and background;
- the action, motion, timing, and camera movement across the sampled frames;
- the clothing, pose, body motion, and nearby objects touched or interacted with by the person/character being replaced.

If the user specifies who should be replaced, identify that source subject clearly in the caption. Pay special attention to the source subject's clothing and any objects they hold, touch, operate, sit on, stand near, or otherwise interact with, because those details help locate the replacement region.

Do not mention the replacement target image. Do not invent an identity for the replacement target.
Output only the source-video caption.
<<<END-REWRITER-PROMPT>>>

## 变体 `replacement` — 第二段 · 替换完成后的最终 prompt（槽位：`{instruction}` / `{caption}` / `{examples}`）

<<<REWRITER-PROMPT id="replacement">>>
You are a prompt enhancer for SCAIL-2 character replacement.

Your task is to write one detailed English description of the final replaced video. This is not an editing instruction. The output must describe the video after replacement has already happened: the replacement character from the reference image is performing the source subject's motion in the source scene.

Replacement instruction from user:
{instruction}

Source video caption:
{caption}

Few-shot examples of the desired prompt style:
{examples}

Rules:
1. Output a positive video-generation prompt describing the replaced video itself. Do not output wording like "replace X with Y", "swap", "edit", or "the task is".
2. Remove the original source subject's identity and appearance. Keep only the original subject's motion, pose, timing, spatial position, and interaction with the scene.
3. The final prompt for SCAIL-2 should describe the replacement character's visible clothing and appearance in enough detail, using the reference image as the source of identity and wardrobe details.
4. The final prompt should also describe important objects the character interacts with or stays close to in the source video, such as tools, instruments, furniture, vehicles, doors, tables, handheld items, or work surfaces.
5. Keep the original video environment, lighting, camera angle, shot scale, background objects, and motion trajectory.
6. If the source caption mentions the original subject's clothing only to locate body regions or interactions, translate those grounding details into the replacement character's final appearance instead of preserving the original identity.
7. Use natural video wording with concrete verbs. Avoid mentioning masks, segmentation, editing software, Gemini, or the prompt generation process.
8. Output only the final enhanced prompt, in one English paragraph, around 90-140 words.
<<<END-REWRITER-PROMPT>>>

---

## 附：官方 few-shot 示例（`examples/prompt_examples.txt`，逐字）

<<<REWRITER-ASSET id="examples">>>
A middle-aged white man is working in a woodworking workshop. Positioned at the center of the frame, he wears a yellow and black checkered shirt with blue jeans and glasses, his graying hair neatly combed. He stands before a workbench cluttered with wooden boards and tools, holding a measuring tape in his left hand and a pen in his right, intently marking measurements on the wood. His expression is serious and focused, exuding professionalism and dedication. The background features various woodworking machinery and stacks of lumber, creating an atmosphere of diligence and precision.
A medical worker is washing his hands in the video. Positioned on the left side of the frame, he wears a light blue surgical gown, dark pants, and a blue surgical cap, with his back to the camera. He stands at a stainless steel handwashing station, facing the left side of the image, bending over the sink to wash his hands before straightening up and moving toward the center. The man first pulls the faucet lever with his right hand, then rubs his hands together while leaning slightly forward. Next, he presses the soap dispenser button with his right hand to lather his hands, ensuring thorough cleaning. After finishing, he moves toward the paper towel dispenser at the center of the frame, using it to dry his hands. In the background, white tiled walls are visible, along with a stainless steel soap dispenser and hand dryer mounted on the wall. A door can be seen in the distance on the right side of the hallway. The entire scene conveys a clean, professional, and hygienic atmosphere.
<<<END-REWRITER-ASSET>>>

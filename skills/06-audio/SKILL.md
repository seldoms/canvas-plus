---
name: audio
description: |
  为有对白的镜头逐条生成配音（TTS）。用于把分镜台词 + 角色音色方案合成为逐条 AudioCue 的 TTS 任务，产物登记成带 shotId+startSec 的 audio item，供成片阶段按镜头时间轴混音。这是流水线的配音阶段（生成型），与关键帧并行、不阻塞成片。
---

# 配音：分镜台词 + 角色音色 → 逐条 TTS

本阶段把**有对白的镜头**变成可混入成片的音频条目：每一条对白 Cue 一个 TTS 任务，产物登记成
`{ shotId, startSec, durationSec, artifactUrl, ... }` 的 audio item，由成片阶段（05-clip-assembly 的
`buildConcatArgs`）按 `shotId + startSec` 换算成片时间轴上的 `adelay` 后混音。

## 与其它阶段的边界

- **不产模型专属提示词**（架构铁律）：台词、角色音色描述都是内容事实；把描述映射成某个 TTS 模型的
  音色枚举（如 Qwen3-TTS 的命名音色）属于**后端适配**，发生在发起生成请求那一刻，不在本阶段产物里。
- **无台词的镜头不产音频**：`dialogue` 为空（或 `dialogueLines` 为空数组）的镜头不生成任何 Cue。
- **失败不阻塞出片**：TTS 任务失败只让配音阶段落 `partial`/`error`；成片阶段按「有产物才混、没产物跳过」
  处理，绝不出不了片（见 05-clip-assembly）。
- 本阶段**不调用 LLM**：Cue 由分镜台词与角色音色**确定性派生**（`src/audio.js` 的 `resolveDialogueLines` /
  `cuesFromShots`、`src/audio-track.js` 的 `projectVoiceProfiles` / `projectAudioCues`），入队与回写由编排器完成。

## 台词归属与配音口径（按模型走 · 模型能力元数据）

**角色的台词归属在不同模型里定义完全不同**，所以口径不是写死在本技能，而是登记在**模型能力元数据**
（`canvas-server/src/dialogue-roles.js`，照 `durations.js` / `sizes.js` 的套路，随 `GET /api/providers`
的 `comfy.templates[].dialogueMeta` 下发，前端只读）。后端在**发起生成那一刻**按所选模型的口径把
「模型无关的内容事实」编译成该模型的最终提示词/参数 —— **这是架构铁律：最终提示词一律由后端在发起生成时
按 skill + 注册表编译，不得散落硬编码。**

| 模型口径 | mode | 怎么表达「谁说的」 | 怎么说台词 |
| --- | --- | --- | --- |
| **MiniMax H3**（原生音视频联合） | `speaker_id_block` | 说话人用**稳定 ID `(S1)(S2)`**（同一角色跨镜同 ID） | 台词正文包在 **`<d>[English] …</d>`** 内逐字不译；括号表演注解剥出 `<d>`，落到 `integrated_multimodal_description` 描述层 |
| **TTS**（`audio_qwen3_tts` / `TDQwen3TTSCustomVoice`） | `voice_enum` | **没有「谁说的」概念**：只吃命名音色枚举 **`SPEAKER`** + 音色描述 **`INSTRUCT`** | 内容层只给「这条台词属于哪个角色」；该角色 → 它的 VoiceProfile → `SPEAKER`/`INSTRUCT` |
| **纯生视频 / 生图**（wan21/wan22_animate/scail2/ltx23/img_*） | `none` | **不承载台词归属** | 对白/旁白走独立配音轨 + 字幕，与画面分开生产 |

### 说话人怎么定（内容契约，见 02-storyboard）

分镜的 `dialogueLines`（逐条带说话人）是归属的事实源；旧字符串 `dialogue` 仍可读。后端按
**逐级回落**解析每条台词的说话人，越靠后越不可靠，靠后命中时**记 warning，绝不乱填、不阻塞**：

1. 台词显式标注的 `speaker`（命中角色表）；
2. 镜头级 `characterId` / `characterIds[0]`；
3. 台词正文里出现的角色名；
4. 镜头 `action`/`dialogue` 文本里出现的角色名（多于一个 → 取第一个并 warning）；
5. 该镜只有一个角色 → 用它；
6. 回落该镜第一个角色（warning）。

`speaker` 应可指向**剧本已有角色**（角色来自 `script` 阶段产物）；指不到时如实标记（warning），**不得乱填**。

### 各模型的口径怎么落地

- **H3（`video_h3_i2v` / `_fl` / `video_h3_talk` / `_ref2v` …）**：`h3DialogueSentence`（`prompt-compiler.js`）
  把每条台词编译成 `<角色> (S1) says: <d>[English] <纯台词正文></d>`，`(Sx)` 按**全局角色表**稳定编号
  （同一角色跨镜同号），`<d>` 内**逐字是正文**（不含括号注解）。`<d>` 标签与语言标签取自能力元数据
  （`minimax_h3.utteranceTag/utteranceLangTag`），不另创一套。
- **TTS（`audio_qwen3_tts`）**：`qwen3Speaker(profile, character)` 把「角色音色事实」适配成命名音色
  `SPEAKER`（如 `Uncle_fu` / `Serena`），`INSTRUCT` 取该角色的 `design`/`timbre` 描述；**同一角色跨镜
  共用同一 VoiceProfile → `SPEAKER`/`INSTRUCT` 逐字一致 → 音色一致**。这条台词属于谁（`characterId`），
  由 `resolveDialogueLines` 解析后随 Cue 一起带给入队逻辑（`resolveAudioProfile`）。
- **纯视频 / 生图**：不产出任何台词字段（对白不在画面模型里承载）。

## 提示词模板

本阶段为生成型阶段且不依赖 LLM 编排，模型无关事实到生成参数的映射由编排器确定性完成，
因此下方模板仅作阶段形状占位；真实入参由编排器按所选 TTS 模型构造（`SPEAKER` / `INSTRUCT` 由
`dialogue-roles.js · qwen3_tts` 登记的字段口径产出，后端在入队那一刻编译）。

```json
{ "audio": [] }
```

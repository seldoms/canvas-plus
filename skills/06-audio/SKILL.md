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
- **无台词的镜头不产音频**：`dialogue` 为空的镜头不生成任何 Cue。
- **失败不阻塞出片**：TTS 任务失败只让配音阶段落 `partial`/`error`；成片阶段按「有产物才混、没产物跳过」
  处理，绝不出不了片（见 05-clip-assembly）。
- 本阶段**不调用 LLM**：Cue 由分镜台词与角色音色**确定性派生**（`src/audio.js` 的 `cuesFromShots`、
  `src/audio-track.js` 的 `projectVoiceProfiles` / `projectAudioCues`），入队与回写由编排器完成。

## 提示词模板

本阶段为生成型阶段且不依赖 LLM 编排，模型无关事实到生成参数的映射由编排器确定性完成，
因此下方模板仅作阶段形状占位；真实入参由编排器按所选 TTS 模型构造。

```json
{ "audio": [] }
```

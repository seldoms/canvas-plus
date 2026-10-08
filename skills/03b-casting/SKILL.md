---
name: casting
description: |
  角色定妆（锁脸锁声音）。用于给每个角色定人脸与声音：脸复用服化道的正脸特写/三视图参考图，声音从平台音色库选命名音色，产出可直接进关键帧与配音的「身份卡」。当需要保证同一角色跨镜头、跨场景人脸一致与音色一致时使用。这是流水线的独立环节（服化道之后、关键帧之前），与关键帧同等重要：**未确认不得进下游**。
---

# 角色定妆：锁脸 + 锁声音

角色定妆是**从服化道里拆出来的独立环节**，和关键帧一样重要。它不是美术形容词，而是**跨镜头一致性的两个锚点**：

- **脸**：同一角色在任何镜头里都必须由同一张「正脸特写 + 三视图」参考图锁定（人脸识别点 + 体态四面形制）；
- **声音**：同一角色在任何镜头里都必须用同一个**平台音色库**里的命名音色（外加同一段音色描述）。

> 服化道（03）管的是**物与景**——服装、妆容、发型、随身道具、场景陈设与布光；那些是「现实拍摄的主要信息」。
> AI 生产不一样：**人（脸）与声音也必须被显式定义**，否则每一镜都在重新掷骰子。所以人抽出来，单独定妆。

本阶段**只做两件事 —— 定脸 + 定声音**，不做别的：不重写服化道造型、不生成场景、不产出关键帧。

## 为什么是独立环节

- 脸与声音是**跨镜身份的锚点**，服化道里既没有它们的产物出口，也没有「确认」门禁；
- 关键帧与配音都要消费它们：关键帧靠脸锁 INPUT_IMAGE 参考图，配音靠声音选 SPEAKER；
- 因此它们必须**先行产出、先行被人工确认**，才能进下游。未确认就放行 = 每一镜重新掷骰子。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `script` | 是 | 上游剧本产物，提供 `characters[]`（id / name / appearance / voice） |
| `design` | 是 | 上游服化道产物，提供角色参考图产物（`references[].artifactUrl`）与造型 |

## 输出契约（冻结，字段名不得改）

只产出一个 JSON 对象，字段名固定：

```json
{
  "characters": [
    {
      "characterId": "c1",
      "name": "阿海",
      "face": {
        "closeupArtifactId": "",
        "turnaroundArtifactIds": [],
        "confirmed": false
      },
      "voice": {
        "voiceProfileId": "vp_c1",
        "speaker": "Uncle_fu",
        "design": "低沉沙哑，语速偏慢",
        "speed": 1,
        "language": "Chinese",
        "previewArtifactId": "",
        "confirmed": false
      },
      "confirmed": false,
      "version": 1,
      "lockedAt": null
    }
  ]
}
```

### 字段规则

- `characterId`：沿用剧本 `characters[].id`，**不允许新建、改名、合并**；同一角色只出现一次。
- `face.closeupArtifactId`：角色**正脸特写**参考图产物 id（**复用**服化道 `closeupPrompt` 生成的产物，不重写生成）。未生成时为空串。
- `face.turnaroundArtifactIds`：角色**正/侧/背三视图**参考图产物 id 数组（**复用**服化道 `turnaroundPrompt` 生成的产物）。未生成时为空数组。
- `voice.voiceProfileId`：该角色的 VoiceProfile id（由 `audio-track.js` 的 `projectVoiceProfiles` 归一）。
- `voice.speaker`：**只能**取平台音色库的命名音色枚举（见下「平台音色库」），非法值一律拒绝。
- `voice.design`：内容层给的**中文音色描述**（如「低沉沙哑，语速偏慢」），落成 TTS 的 `INSTRUCT`。
- `voice.speed`：语速数值，默认 `1`。
- `voice.language`：**只能**取平台音色库的语种枚举。
- `voice.previewArtifactId`：试听产物 id（调用 `POST /api/tts/preview` 后回填）。未试听时为空串。
- `confirmed`（三级）：`face.confirmed`、`voice.confirmed` 各一个；角色 `confirmed` = **脸与声都真**。
- `version`：初始 `1`；**确认后修改**则 `+1`（提示下游需重新确认）。
- `lockedAt`：确认时写 ISO 时间；未确认时为 `null`。

## 平台音色库（声音的唯一合法取值域）

音色不是自由填的字符串，而是**平台侧 TTS 模型自带的一组命名音色**。前端从接口读，**绝不硬编码**。

- `GET /api/tts/voices` → `{ voices: string[], languages: string[], defaultSpeaker, defaultLanguage, source, ... }`
- 也随 `GET /api/providers` 的 `comfy.templates[].voices` 下发（与时长、规格同源）。

数据源（**只读探测，不改 147**）：`GET http://192.0.2.147:8188/object_info/TDQwen3TTSCustomVoice`

| 枚举 | 取值 |
| --- | --- |
| `speaker` | `Aiden` `Dylan` `Eric` `Ono_anna` `Ryan` `Serena` `Sohee` `Uncle_fu` `Vivian` |
| `language` | `Auto` `Chinese` `English` `Japanese` `Korean` `German` `French` `Russian` `Portuguese` `Spanish` `Italian` |

工作流节点：`TDQwen3TTSCustomVoice`（见 `workflows/audio_qwen3_tts.json`）；`speaker` → `{{SPEAKER}}`，`language` → `{{LANGUAGE}}`，`design` → `{{INSTRUCT}}`。

## 门禁：未确认不得进下游（硬规则）

1. `casting` 阶段**未完成**（无产物）→ 下游 `keyframe` / `audio` 不得运行（`requires` 里含 `casting`）。
2. `casting` 里**存在未确认的角色**（脸或声任一未确认真实）→ 编排器把 `keyframe` 与 `audio` 置 `status = "blocked"`，并写清**哪个角色、缺脸还是缺声音**（复用 #70 的 blocked 可见机制，绝不静默降级）。
3. 全部角色确认齐（脸与声都真）→ 精确解除阻断，下游放行。
4. 确认动作发生在 `casting` 阶段产物上：设置 `face.confirmed` / `voice.confirmed` / 角色 `confirmed`；**不得**用「文字已足够」绕过。

## 组装口径（本阶段不调 LLM，无提示词模板）

> ⚠️ **本阶段不调用 LLM**：身份卡由「剧本角色 + 服化道脸产物 + VoiceProfile」**确定性组装**（`src/pipeline.js` 的 `attachCasting` → `src/casting.js` 的 `buildCastingOutput`）。
> 因此本技能**不设 `## 提示词模板` 一节** —— 没有需要发给模型的提示词。组装规则见下，由代码执行、不经过模型。

组装口径（等价于「提示词」，但由代码执行，不经过模型）：

1. 角色来源：`project.script.characters` → 剧本阶段产物 `characters` → 服化道 `characters`（逐级回落）。
2. 脸来源：服化道 `output.references[]` 里 `bindingId == characterId` 且 `role == character` 的条目——
   `kind == closeup` 的 `artifactUrl` → `face.closeupArtifactId`；`kind == turnaround` 的 `artifactUrl` → `face.turnaroundArtifactIds`。
   回落服化道 `characters[].referenceArtifactIds` / `turnaroundArtifactIds`。
3. 声音来源：`projectVoiceProfiles`（`voice-profile.js` / `audio-track.js`）归一出的 VoiceProfile——
   `id → voiceProfileId`、`design/timbre → design`、`speed → speed`、`language` 经语种枚举归一、`speaker` 经 `qwen3Speaker` 适配成平台命名音色。
4. 重跑**不抹掉**已确认状态：`prev` 产物里的 `face.confirmed` / `voice.confirmed` / `previewArtifactId` 在产物仍在时被继承。

## 校验规则

- 顶层必须是对象且含 `characters` 数组（可为空数组但键必须存在）。
- `characters[].characterId` 必须来自上游 `script.characters[].id`，一一对应。
- `face` / `voice` 键必须存在，且各自内层键完整（见契约）。
- `voice.speaker` 必须 ∈ 平台音色库命名音色枚举；`voice.language` 必须 ∈ 语种枚举；非法值**拒绝写入**（回落默认或报错，不静默保留）。
- `voice.speed` 必须是正数，默认 `1`。
- 角色 `confirmed` 必须与「脸与声都真」自洽：写了 `true` 但实际不满足时回落 `false`。
- `version` ≥ 1；`lockedAt` 未确认时必须是 `null`。

## 工具

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/casting/run` | 由编排器执行本阶段（确定性组装身份卡，不调 LLM） |
| `POST /api/pipeline/runs/:id/steps/casting/input` | 人工修订/确认 casting 产物，body `{ "output": { ...casting } }`（确认后自动解禁下游） |
| `POST /api/pipeline/runs/:id/steps/casting/confirm` | 逐角色确认：body `{ characterId, face?, voice?, speaker?, language?, design?, speed?, previewArtifactId? }` |
| `GET /api/tts/voices` | 平台音色库（命名音色 + 语种），前端选项唯一来源 |
| `POST /api/tts/preview` | 试听：body `{ speaker, design?, language?, speed?, text? }` → `{ url, artifactId, speaker, ms }`（复用 147 提交/轮询/产物登记链路） |
| `GET /api/pipeline/runs/:id/gates` | 查看 `keyframe` / `audio` 是否被 casting 拦住及原因 |

产物落盘：`data/runs/<runId>/casting.json`。

## 已知边界（编排器行为，勿踩）

- 本阶段由 `src/pipeline.js` 的 `attachCasting` **确定性组装**（不分块、不调 LLM）；`composeWithLlm` 对本阶段被跳过。
- 门禁由 `stageGate`（拒绝运行）+ `enforceCastingGate`（把 `keyframe` / `audio` 置 `blocked`）共同执行；拦住机制复用 #70 的 `status=blocked` + `blockedReason` / `blockedMissing` / `blocked`，不另造一套。
- 脸产物**复用**服化道参考图链路（`closeupPrompt` / `turnaroundPrompt` → `attachDesignReferences` → `bindDesignReferenceArtifacts`），本阶段只**读取与归一**，绝不重写生成/绑定。
- 音色枚举是**后端副本登记表**（`src/voices.js`，照 `durations.js` / `sizes.js` 套路）；数据源是 147 `TDQwen3TTSCustomVoice` 的只读探测，**不许改 147**，别的 TTS 模型要接进来必须先一手查证它自己的枚举。
- 旧 run（注册表里还没有 casting 阶段）不做 retro 阻断：`enforceCastingGate` 在 run 里没有 casting 阶段时空操作，保证存量 run 行为逐字不变。

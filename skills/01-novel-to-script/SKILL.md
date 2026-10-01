---
name: novel-to-script
description: |
  把小说原文改编成可拍摄的剧本。用于小说转剧本、提取人物表、场次表与戏剧目标，输出严格 JSON（logline/synopsis/characters/scenes）。当用户给出小说原文并需要剧本、人物设定或场次拆分时使用。这是五段式流水线的第一段：剧本。
---

# 剧本：小说 → 剧本

把小说原文当作唯一事实来源：人物关系、时代背景、关键道具都要能在原文里找到依据；原文没写但拍摄必需的，用合理推断补齐，并在 `profile` 里写明是推断。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `novel` | 是 | 小说原文全文，可能很长，是唯一事实来源 |
| `title` | 否 | 项目标题，缺省时由原文自拟 |
| `options.episodeCount` | 否 | 期望分集数；缺省时按原文体量决定 |

编排器会把提示词模板里的 `{{novel}}`、`{{title}}` 替换成真实内容后再发给模型。

## 输出契约

只返回一个 JSON 对象，字段名固定，不要增删、改名或嵌套到别的键里：

```json
{
  "logline": "一句话故事线",
  "synopsis": "300 字以内的故事梗概",
  "characters": [
    { "id": "c1", "name": "角色名", "profile": "身份、性格、人物关系", "appearance": "年龄、体态、五官、发型、服装基调", "voice": "音色与说话方式，供 TTS 使用" }
  ],
  "scenes": [
    { "id": "sc1", "title": "场景标题", "location": "内景/外景 + 地点", "time": "日/夜/黄昏", "intent": "这场戏的戏剧目标", "beats": ["节拍一", "节拍二"] }
  ],
  "episodes": [
    { "id": "ep1", "title": "第一集", "sceneIds": ["sc1", "sc2"] }
  ]
}
```

- `characters[].id`、`scenes[].id` 必须唯一且稳定，后续阶段靠它们建立引用。
- `episodes` 可选：短篇可以整段省略。

## 提示词模板

你是影视剧本改编。把下面这部小说改编成可拍摄的剧本。

项目标题：{{title}}

小说原文：
<novel>
{{novel}}
</novel>

要求：

1. 先提炼 `logline`（一句话）与 `synopsis`（不超过 300 字），再拆人物与场次。
2. `characters` 覆盖所有有台词或推动剧情的角色。`appearance` 要写成能直接喂给生图模型的外观描述（年龄、体态、五官、发型、服装基调），不要写抽象形容词；`voice` 写音色、语速、口音等可复现的声音特征。
3. `scenes` 按时间顺序排列。`beats` 用 3~8 条可拍摄的动作/台词节拍，不要写文学抒情和心理描写。
4. `location` 统一写成「内景/外景 + 地点」，`time` 只用 日 / 夜 / 黄昏 / 清晨 这类可布光的词。
5. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"logline":"","synopsis":"","characters":[{"id":"c1","name":"","profile":"","appearance":"","voice":""}],"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}],"episodes":[]}

## 校验规则

编排器与本阶段共同遵守，任一不满足即视为产物不可用：

- 顶层必须是对象，且 `logline`、`synopsis`、`characters`、`scenes` 四个键必须存在。
- `characters[].id` 与 `scenes[].id` 全局唯一，只允许 `[A-Za-z0-9_-]`。
- `scenes` 至少 1 条；每条 `beats` 至少 1 条非空字符串；`intent` 不能为空。
- `characters[].appearance`、`characters[].voice` 不能为空：前者供关键帧阶段写提示词，后者供 TTS 使用。
- 允许省略 `episodes`；若给出，`sceneIds` 必须都能在 `scenes` 里找到。
- 只输出 JSON 本体。编排器解析失败会自动重试一次（只返回 JSON），再失败则整步标记 `error` 并保留模型原文。

## 工具

本阶段允许调用的 canvas-server 接口：

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/script/run` | 由编排器执行本阶段（内部调用 LLM） |
| `POST /api/pipeline/runs/:id/steps/script/input` | 人工修订剧本产物，body `{ "output": { ...script } }` |
| `ANY /v1/*` | 透传内网 OpenAI 兼容 LLM，用于人工追问或重写 |
| `POST /api/generate/image` | 可选：给人设出一张概念图，模板 `img_*`，参数 `PROMPT` |

产物落盘：`data/runs/<runId>/script.json`；运行状态在 `data/runs/<runId>/run.json`。

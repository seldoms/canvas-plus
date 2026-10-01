---
name: storyboard
description: |
  把剧本拆成可生成的分镜表。用于分镜拆解、镜头设计、景别与运镜规划、生图/生视频提示词编写，输出严格 JSON（shots）。当已有剧本产物、需要逐镜头的时长、景别、运镜、动作与提示词时使用。这是五段式流水线的第二段：分镜。
---

# 分镜：剧本 → 分镜表

每个镜头都要能被一次生成任务承接：一条主运镜、一个连续空间、一个明确的动作落点。不写"镜头愿望清单"。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `script` | 是 | 上游剧本产物（对象，编排器会序列化后填入模板） |
| `novel` | 否 | 小说原文，用于补充剧本丢失的细节 |
| `title` | 否 | 项目标题 |

## 输出契约

只返回一个 JSON 对象，字段名固定：

```json
{
  "shots": [
    {
      "id": "sh1",
      "sceneId": "sc1",
      "index": 1,
      "durationSec": 4,
      "shotSize": "中景",
      "camera": "固定机位，平视，人物居中偏左",
      "action": "人物推门进屋，停在桌边",
      "dialogue": "台词或空字符串",
      "audio": "环境音与配乐说明",
      "prompt": "英文生图提示词",
      "negativePrompt": "英文负向提示词"
    }
  ]
}
```

- `sceneId` 必须引用剧本里已存在的场次 id。
- `prompt` / `negativePrompt` 用英文，供生图与生视频模板的 `PROMPT` token 直接使用。
- 单镜时长默认 3~6 秒；超过 8 秒的镜头要拆成两条。

## 提示词模板

你是分镜师。把下面的剧本拆成逐个镜头的分镜表。

项目标题：{{title}}

剧本 JSON：
<script>
{{script}}
</script>

要求：

1. 按场次顺序拆镜头，`index` 从 1 起全局递增，`sceneId` 必须来自剧本中的 `scenes[].id`。
2. 每个镜头只安排一个主运镜（推/拉/摇/移/跟/升降/固定），并写清起点、方向、速度与落点。
3. `durationSec` 取 3~6；动作复杂或含台词的镜头可到 8，超过 8 必须拆镜。
4. `prompt` 用英文，结构为：主体外观 + 服装 + 场景 + 动作 + 构图景别 + 光线氛围 + 画质词；人物外观必须与剧本 `characters[].appearance` 一致。
5. `negativePrompt` 用英文，覆盖：多手多指、面部畸变、文字水印、低清、过曝。
6. `dialogue` 只放本镜头实际说出的台词，没有就留空字符串。
7. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"shots":[{"id":"sh1","sceneId":"sc1","index":1,"durationSec":4,"shotSize":"中景","camera":"","action":"","dialogue":"","audio":"","prompt":"","negativePrompt":""}]}

## 校验规则

- 顶层必须是对象且含 `shots` 数组，`shots` 至少 1 条。
- `shots[].id` 唯一且只允许 `[A-Za-z0-9_-]`；`sceneId` 必须存在于上游 `script.scenes`。
- `index` 为正整数且严格递增，不允许跳号导致排序歧义。
- `durationSec` 为 1~8 的数字；`shotSize`、`camera`、`action` 非空。
- `prompt` 非空且为英文；`negativePrompt` 允许为空但建议填写。
- 只输出 JSON 本体。解析失败由编排器重试一次，再失败整步标记 `error`。

## 工具

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/storyboard/run` | 由编排器执行本阶段 |
| `POST /api/pipeline/runs/:id/steps/storyboard/input` | 人工修订分镜产物，body `{ "output": { "shots": [...] } }` |
| `POST /api/generate/image` | 用单条镜头的 `prompt` 试拍，模板 `img_*`，参数 `PROMPT` `WIDTH` `HEIGHT` `SEED` |
| `GET /api/jobs/:id` | 轮询试拍任务 |
| `ANY /v1/*` | 透传内网 LLM，用于人工改写单条镜头 |

产物落盘：`data/runs/<runId>/storyboard.json`。

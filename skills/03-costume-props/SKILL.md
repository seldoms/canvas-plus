---
name: costume-props
description: |
  为剧本角色和场景设计服化道。用于角色造型、妆容发型、随身道具、场景陈设与布光设计，输出严格 JSON（characters/locations）。当需要保证跨镜头角色一致性与场景调性统一时使用。这是五段式流水线的第三段：服化道。
---

# 服化道：角色造型与场景美术

服化道不是美术形容词，而是**可复现的生成参数**：同一角色在任何镜头里都必须能用同一段文字描述出来。所有造型都要能追溯到剧本中的身份、时代与处境。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `script` | 是 | 上游剧本产物，提供 `characters[]` 与 `scenes[]` |

## 输出契约

只返回一个 JSON 对象，字段名固定：

```json
{
  "characters": [
    {
      "id": "c1",
      "name": "角色名",
      "outfit": "服装：形制、颜色、材质、磨损程度",
      "makeup": "妆容：底妆、眉眼、唇色、特殊妆效",
      "hair": "发型：长度、分缝、束法、发色",
      "props": ["戒指", "旧皮包"],
      "palette": "主色 #RRGGBB + 辅色 #RRGGBB + 点缀 #RRGGBB",
      "prompt": "英文造型提示词，可直接接在人物外观描述后面"
    }
  ],
  "locations": [
    {
      "id": "loc1",
      "name": "地点名，与剧本 scenes[].location 对应",
      "setDressing": "陈设：家具、墙面、地面、时代物件",
      "lighting": "光源方向、色温、明暗比",
      "palette": "主色 + 辅色 + 点缀",
      "prompt": "英文场景提示词"
    }
  ]
}
```

- `characters[].id` 必须沿用剧本里的人物 id，不允许新建。
- `locations[].name` 必须覆盖剧本用到的每个地点。

## 提示词模板

你是影视美术指导。基于下面的剧本，产出角色服化道与场景美术方案。

剧本 JSON：
<script>
{{script}}
</script>

要求：

1. `characters[].id` 与 `name` 原样沿用剧本 `characters`，不要新增或改名。
2. 造型必须服务人物处境：时代、职业、经济状况、当下情绪都要能在服装材质与磨损程度上看出来。
3. `palette` 用十六进制写死三个颜色（主色/辅色/点缀），供后续统一色调。
4. 每个 `locations[]` 对应剧本中的一个地点，`lighting` 必须写出来源与方向（如"西窗侧逆光，色温 4300K"），不要写"氛围感"这类空话。
5. `prompt` 用英文，包含主体/材质/颜色/光线/画质词，可直接拼进生图提示词。
6. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"characters":[{"id":"c1","name":"","outfit":"","makeup":"","hair":"","props":[],"palette":"","prompt":""}],"locations":[{"id":"loc1","name":"","setDressing":"","lighting":"","palette":"","prompt":""}]}

## 校验规则

- 顶层必须是对象且含 `characters`、`locations` 两个数组，二者都可以为空数组但键必须存在。
- `characters[].id` 必须来自上游 `script.characters[].id`，一一对应，不允许出现剧本之外的 id。
- `characters[].props` 必须是字符串数组，没有道具时给空数组。
- `locations[].name` 必须覆盖 `script.scenes[].location` 去重后的全部取值。
- `outfit`、`makeup`、`hair`、`setDressing`、`lighting` 非空；`palette` 至少含一个 `#RRGGBB`。
- 只输出 JSON 本体。解析失败由编排器重试一次，再失败整步标记 `error`。

## 工具

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/design/run` | 由编排器执行本阶段 |
| `POST /api/pipeline/runs/:id/steps/design/input` | 人工修订服化道产物，body `{ "output": { ...design } }` |
| `POST /api/generate/image` | 出角色定妆图与场景概念图：模板 `img_*`，参数 `PROMPT` `WIDTH` `HEIGHT` `SEED` |
| `POST /api/generate/image` | 以关键帧为底做换装：模板 `img_boogu_outfit_edit`，参数 `PROMPT` `INPUT_IMAGE` |
| `GET /api/jobs/:id` | 轮询生成任务 |
| `ANY /v1/*` | 透传内网 LLM，用于人工调整造型描述 |

产物落盘：`data/runs/<runId>/design.json`。

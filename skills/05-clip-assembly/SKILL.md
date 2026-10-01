---
name: clip-assembly
description: |
  把关键帧串成视频片段并给出拼接顺序。用于图生视频参数构造、逐镜头片段生成、片段排序与转场设计，输出严格 JSON（clips/assembly）。这是五段式流水线的第五段：片段合成，属于生成型阶段。
---

# 片段合成：关键帧 → 视频片段 → 成片拼接

每个镜头一段视频。片段以该镜头的首帧作为 `INPUT_IMAGE`（图生视频），运镜与动作直接沿用分镜描述；拼接阶段只决定顺序与转场，不重新生成画面。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `keyframes` | 是 | 上游关键帧产物，提供 `frames[]`（取每镜 `role: "start"` 的 `artifactUrl` 作为首帧） |
| `storyboard` | 否 | 分镜产物，用于取 `durationSec` 与动作描述 |
| `options.video` | 否 | 透传到生视频任务的参数，如 `WIDTH` `HEIGHT` `SEED` `LENGTH` `FRAME_RATE` |
| `options.transition` | 否 | 拼接转场，默认 `cut` |

## 输出契约

只返回一个 JSON 对象，字段名固定：

```json
{
  "clips": [
    {
      "id": "sh1-clip",
      "shotId": "sh1",
      "keyframeId": "sh1-start",
      "template": "video_h3_i2v",
      "jobId": null,
      "artifactUrl": null,
      "durationSec": 4,
      "status": "queued"
    }
  ],
  "assembly": {
    "order": ["sh1-clip", "sh2-clip"],
    "transition": "cut",
    "outputUrl": null,
    "status": "queued"
  }
}
```

- `keyframeId` 必须是上游 `keyframes.frames[].id`。
- `template` 由编排器填 `config.pipeline.videoTemplate`，模型不决定。
- `jobId`、`artifactUrl`、`outputUrl` 由编排器与任务队列回填，**不得伪造**；没有真实产物时保持 `null` 且 `status: "queued"`。

## 提示词模板

你是片段合成师。为下面每个镜头规划一条图生视频片段，并给出整体拼接方案。

分镜表：
<storyboard>
{{storyboard}}
</storyboard>

关键帧产物：
<keyframes>
{{keyframes}}
</keyframes>

要求：

1. 每个镜头一条片段，`id` 用「镜号-clip」，`shotId` 与 `keyframeId` 必须来自上面的分镜与关键帧。
2. `durationSec` 默认沿用该镜分镜的 `durationSec`；分镜缺失时用 {{pipeline.videoSeconds}} 秒。
3. 视频提示词由编排器取该镜分镜的 `prompt` 与 `action` 拼成，这里不用重复写；运镜与动作的可行性由分镜负责。
4. `assembly.order` 按叙事顺序排好全部片段 id，`transition` 取 `cut` / `fade` / `dissolve` / `slide` 之一。
5. `template`、`jobId`、`artifactUrl`、`outputUrl`、`status` 由编排器回填：原样保留这几个字段并留空或置 null，不要自己编造。
6. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"clips":[{"id":"sh1-clip","shotId":"sh1","keyframeId":"sh1-start","template":null,"jobId":null,"artifactUrl":null,"durationSec":4,"status":"queued"}],"assembly":{"order":["sh1-clip"],"transition":"cut","outputUrl":null,"status":"queued"}}

## 校验规则

- 顶层必须是对象且含 `clips` 数组与 `assembly` 对象，`clips` 至少 1 条。
- 每个 `clips[].shotId` 必须存在于上游分镜；每个镜头至少一条片段，`id` 唯一。
- `keyframeId` 必须存在于上游 `keyframes.frames[].id`；没有可用首帧时该片段保持 `queued` 且不入队。
- `durationSec` 为正数；`assembly.order` 必须覆盖全部 `clips[].id` 且不重复。
- `assembly.transition` 取值 `cut` / `fade` / `dissolve` / `slide` 之一。
- 不伪造产物：`artifactUrl`、`outputUrl` 只能由任务队列的真实产物回填。

## 工具

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/assembly/run` | 由编排器构造片段任务并入队（生成型阶段） |
| `POST /api/pipeline/runs/:id/steps/assembly/input` | 人工修订片段产物，body `{ "output": { "clips": [...], "assembly": {...} } }` |
| `POST /api/generate/video` | 生视频任务：模板 `video_h3_i2v`，token `PROMPT` `INPUT_IMAGE` `LENGTH` `FRAME_RATE` `WIDTH` `HEIGHT` `SEED` `OUTPUT_PREFIX` |
| `GET /api/jobs/:id` | 轮询任务状态，`status === "done"` 后取 `outputs[].url` 回填 `artifactUrl` |
| `POST /api/jobs/:id/cancel` | 中途取消片段生成 |
| `GET /api/artifacts/<jobId>/<filename>` | 产物字节流，可被 `<video>` 直接消费 |

产物落盘：`data/runs/<runId>/clips.json`（阶段 id 是 `assembly`，产物键名是 `clips`）。

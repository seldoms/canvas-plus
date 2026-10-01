---
name: keyframes
description: |
  为分镜逐个镜头生成关键帧（首帧/尾帧）任务。用于把分镜提示词与服化道方案合成为生图参数、选择模板、串起首帧到尾帧的图生图链路，输出严格 JSON（frames）。这是五段式流水线的第四段：关键帧，属于生成型阶段。
---

# 关键帧：分镜 + 服化道 → 首尾帧

关键帧是连接分镜与视频的唯一桥梁：**首帧决定视频的空间事实**，尾帧决定这一段落到哪里。本阶段只负责把每一帧的提示词与生成参数构造正确，真实生图由 canvas-server 的任务队列执行。

- `role: "start"` 走 `config.pipeline.imageTemplate`（文生图）。
- `role: "end"` 走 `config.pipeline.editTemplate`（以同镜头首帧为 `INPUT_IMAGE` 的图生图/改图）。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `storyboard` | 是 | 上游分镜产物，提供 `shots[]` |
| `design` | 是 | 上游服化道产物，提供角色造型与场景美术 |
| `options.image` | 否 | 透传到生图任务的参数，如 `WIDTH` `HEIGHT` `SEED` `STEPS` `LORA_FILE` |

编排器把分镜与服化道产物整体填入提示词模板（`{{storyboard}}`、`{{design}}`），模型一次产出全部关键帧；单镜最多帧数由 `config.pipeline.maxKeyframesPerShot` 控制（默认 2），模板里用 `{{pipeline.maxKeyframesPerShot}}` 取到。

## 输出契约

只返回一个 JSON 对象，字段名固定：

```json
{
  "frames": [
    {
      "id": "sh1-start",
      "shotId": "sh1",
      "role": "start",
      "prompt": "英文生图提示词",
      "template": "img_zimage_artistic",
      "jobId": null,
      "artifactUrl": null,
      "status": "queued"
    }
  ]
}
```

- `role` 只能是 `start` / `end` / `key`。
- `template` 由编排器按 `config.pipeline.imageTemplate` / `editTemplate` 填写，不由模型决定。
- `jobId`、`artifactUrl`、`status` 由编排器回填：入队后 `jobId` 为任务 id，产物完成后 `artifactUrl` 为 `/api/artifacts/<jobId>/<filename>`；**模型不得编造 jobId 或 artifactUrl**。

## 提示词模板

你是关键帧提示词工程师。为下面每个镜头各写关键帧提示词，每个镜头至少要有一帧 `role` 为 `start`。

分镜表：
<storyboard>
{{storyboard}}
</storyboard>

服化道方案（角色造型与场景美术）：
<design>
{{design}}
</design>

要求：

1. 每个镜头输出 1~{{pipeline.maxKeyframesPerShot}} 帧；默认只写 `start`，需要尾帧衔接时再加 `end`。
2. `prompt` 是完整的英文生图提示词：主体外观与服装必须与服化道方案一致，场景陈设与布光沿用对应地点，最后补构图景别与画质词。
3. `role` 为 `start` 时描述动作的起始姿态与空间关系；`role` 为 `end` 时描述同一空间中动作的落点，人物身份、服装、光线必须与首帧完全一致，只改变姿态与景别。
4. 保持单个连续空间，不要引入首帧里不存在的人物、门窗或道具。
5. `template`、`jobId`、`artifactUrl`、`status` 由编排器回填：原样保留这几个字段并留空或置 null，不要自己编造。
6. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"frames":[{"id":"sh1-start","shotId":"sh1","role":"start","prompt":"","template":null,"jobId":null,"artifactUrl":null,"status":"queued"}]}

## 校验规则

- 顶层必须是对象且含 `frames` 数组；每个 `frames[].shotId` 必须存在于上游 `storyboard.shots`。
- `role` 只能是 `start` / `end` / `key`；每个镜头的 `start` 帧最多一帧。
- `prompt` 非空且为英文；`template` 必须是 `config.pipeline.imageTemplate` 或 `editTemplate` 之一。
- `role: "end"` 的帧必须等本镜 `start` 帧拿到 `artifactUrl` 后才能入队，此时才写 `INPUT_IMAGE`；在此之前保持 `status: "queued"`、`jobId: null`。
- 不伪造产物：没有真实任务时只留 `queued`，不允许填假的 `artifactUrl`。

## 工具

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/keyframe/run` | 由编排器构造任务并入队（生成型阶段） |
| `POST /api/pipeline/runs/:id/steps/keyframe/input` | 人工修订关键帧产物，body `{ "output": { "frames": [...] } }` |
| `POST /api/generate/image` | 生图任务：模板 `img_*`，token `PROMPT` `INPUT_IMAGE` `WIDTH` `HEIGHT` `SEED` `BATCH` `OUTPUT_PREFIX` `LORA_FILE` `LORA_STRENGTH` `STEPS` |
| `GET /api/jobs/:id` | 轮询任务状态，`status === "done"` 后取 `outputs[].url` 回填 `artifactUrl` |
| `GET /api/artifacts/<jobId>/<filename>` | 产物字节流，可被 `<img>` 直接消费 |
| `POST /api/uploads` | 上传参考图，返回 ComfyUI 侧引用名 |

产物落盘：`data/runs/<runId>/keyframes.json`（注意：阶段 id 是 `keyframe`，产物键名是 `keyframes`）。

---
name: clip-assembly
description: |
  把关键帧串成视频片段并给出拼接顺序。用于图生视频参数构造、逐镜头片段生成、片段排序与转场设计，输出严格 JSON（clips/assembly）。这是五段式流水线的第五段：片段合成，属于生成型阶段。
---

# 片段合成：关键帧 → 视频片段 → 成片拼接

每个镜头一段视频。片段以该镜头的首帧作为 `INPUT_IMAGE`（图生视频），运镜与动作直接沿用分镜描述；拼接阶段只决定顺序与转场，不重新生成画面。

> 段落结构与后期声音设计方法论接管自 `skills/libraries/script-writing-studio`（`06-*` 段落 / 提示词结构与跨段衔接、`07-post-music-sound-design.md` 后期声音设计），已做本地化接线：只吸收结构、衔接与声音方法论，剥离云端生成器参数、国内平台专属条款与时长配额，遵守 `AGENTS.md`「内容创作规范」。落点见本阶段下文「一 / 二 / 三」「后期声音设计要点」「已知边界」各节（库与阶段是分层，库本体不改）。

## 内容创作红线（硬约束）

- **忠于原著、忠于用户**：片段只还原分镜与关键帧已经确定的动作、顺序与节奏，不得为道德教化、价值观引导、过审或「更积极健康」而改动动作、结局或尺度。
- **不注入教化式结构**：不添加原著 / 分镜里没有的「惩罚落点」「情感闭环」类片段或结尾音效暗示；成片形态由原著与用户决定。
- **风险只提示、不改稿**：识别到的政策、平台规则、年龄分级、IP 授权、**音乐版权**等风险只能作为独立提示（项目层 `reviewNotes[]`）交给用户，**绝不写进 `clips` / `assembly`，绝不为规避风险改动片段或拼接**。
- **质量校验照做**：首帧是否存在且可用、`keyframeId` 是否对得上、拼接顺序是否覆盖全部片段，属工艺要求，照常校验。

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

### 一、段落结构（一段一个情绪转折）

方法论接管自 `06-*`（`06-core-format.md` §三.6、§6.2-6.4 等）。本阶段**不写视频提示词正文**（正文由编排器从分镜 `prompt` + `action` 拼成，见「三」），只负责把每个镜头规划成「一段」并定好时长与衔接。

1. **一段只解决一个情绪转折**：一个片段对应一个镜头一个转折，不要把多个场景或多次情绪反转塞进同一段；分镜已经切好的镜头不要再合并。
2. **时长落在合法帧网格**：本项目生视频的 `LENGTH` 是 **17k+5 帧 @ 24fps**（`canvas-server/src/durations.js` 的 `frameCountForDuration` 向上吸附），即 `5s≈124 帧`、`2.3s≈56 帧`、`10s≈243 帧`。`durationSec` 应取能吸附到合法帧数的值；模型接受任意 `17k+5` 帧（5/10/15s 只是**推荐档、非硬约束**），**不要照搬云端的 15 秒单段上限或 4~15 秒区间**，单段时长以分镜的 `durationSec` 为准。
3. **慢必须有功能**：分镜给出的长镜头 / 停顿要有情绪、悬念、关系、信息或视觉记忆点功能；无功能的空转不要在 `durationSec` 上放大。
4. **不重新分合镜头**：镜头数、每镜的动作与长度以分镜、关键帧为准；本阶段只定时长、顺序与转场。

### 二、跨段衔接（相邻段边界）

方法论接管自 `06-*` §6.2「相邻段边界」与 §6.3「连续性使用模式」，剥离其 FF/MAP/SB/SCV/视频延长等资产方案（本项目逐镜图生视频，跨段靠关键帧与分镜保证）。

1. `assembly.order` 按叙事顺序排全部片段 id，不遗漏、不重复。
2. `transition` 按「相邻段边界」判定，**只从契约允许的四值里选**：
   - **同场景顺延**（下一段是上一段动作 / 镜头的自然继续）：优先 `cut`。
   - **换场景 / 时空跳转**：可用 `fade` 或 `dissolve`。
   - **段落之间的强分割或强调**：`slide`（少用）。
3. 衔接必须能被画面继承：新一段靠它自己的首帧（该镜 `role: "start"`）与分镜动作立足，**契约里不写「承接上一段」「接下一段」这类管理语**（契约也没有承载它们的字段）。
4. 切换新场景时，不沿用上一场的空间 / 站位；一致性靠关键帧与分镜，不靠 `transition` 的文字。

### 三、视频提示词与画面分工（不越界重写）

1. **本阶段不产出视频提示词正文**：编排器（`generativePlan`）用该镜分镜的 `[prompt, action]` 拼出生视频 `PROMPT`，`clips[].*` 里没有提示词字段。**不要**在契约里给片段补写画面 / 运镜 / 动作描述，那会与首帧和分镜冲突且破坏机器契约。
2. **画面元素归关键帧、文字归分镜与声音**（`06-core-format.md` 的「先素材后画面、少堆术语多写可见动作」原则）：画面里的空间与人物事实由该段首帧（关键帧）承担，本阶段不要在片段里重复描述静态画面。
3. **本阶段对视频的唯一影响面**是 `durationSec`、`assembly.order`、`transition`。提示词层面的方法论（7 段结构、运镜可行性、负向约束等）应落在**分镜阶段（02）的 `shots[].prompt`**，本阶段只保证时长 / 顺序 / 衔接与分镜一致。

### 四、自检

1. 每个 `clips[].keyframeId` 是否都能在上游 `keyframes.frames[].id` 里找到？`shotId` 是否都在分镜里？
2. `durationSec` 是否为正数、是否与分镜一致（吸附后应落在合法帧数）？
3. `assembly.order` 是否覆盖全部 `clips[].id` 且不重复？`transition` 是否在 `cut` / `fade` / `dissolve` / `slide` 之内？
4. 有没有往契约里塞音乐 / BGM / 音效字段或视频提示词字段？（**没有**，契约无此字段）
5. `template` / `jobId` / `artifactUrl` / `outputUrl` / `status` 是否已留空或置 null？

## 校验规则

- 顶层必须是对象且含 `clips` 数组与 `assembly` 对象，`clips` 至少 1 条。
- 每个 `clips[].shotId` 必须存在于上游分镜；每个镜头至少一条片段，`id` 唯一。
- `keyframeId` 必须存在于上游 `keyframes.frames[].id`；没有可用首帧时该片段保持 `queued` 且不入队。
- `durationSec` 为正数；`assembly.order` 必须覆盖全部 `clips[].id` 且不重复。
- `assembly.transition` 取值 `cut` / `fade` / `dissolve` / `slide` 之一。
- 不得在 `clips[]` / `assembly` 内新增音频、BGM、音效或视频提示词字段（机器契约字段名与结构不得改）。
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

## 后期声音设计要点（后续工序，不在本阶段契约）

方法论接管自 `skills/libraries/script-writing-studio/references/07-post-music-sound-design.md`。因为 `clips` / `assembly` **契约没有音频字段**，BGM 与声音设计**不能**写进本阶段产物；本节供后续「后期」阶段或人工使用，本阶段只保证片段时长与顺序足够后期按镜头边界铺声音。

- **音乐服务叙事**：每段 BGM 必须说明功能（铺底 / 推进 / 压迫 / 反转 / 催泪 / 喜剧停顿 / 结尾钩子 / 转场桥），不写「悲伤音乐」这类空泛词。
- **对白优先**：有重要对白时音乐低存在感、无歌词或弱旋律，并给压混建议，不得盖过对白与关键音效。
- **静默是武器**：惊吓、反转、难堪、强忍情绪时，静默或只留环境声常比 BGM 更有效。
- **不铺满、不一开始满格**：全片要有起伏、留白与断点；情绪要有递进。
- **可执行搜索词 / 生成提示词**：给「情绪 + 功能 + 乐器 + 速度 + 限制」的信息与结构（时长、是否无人声、乐器、情绪曲线、进出方式、禁止项）。
- **版权只提示、不代改**：商用前必须检查授权；不把具体歌手 / 歌曲 / 影视原声 / 热门 BGM 当生成目标。版权风险作为独立提示（`reviewNotes[]`），不写进任何可投喂内容。
- **与本阶段的接口**：后期按 `assembly.order` + 每段 `durationSec` 计算时间码；本阶段**不生成也不内嵌 BGM**——与 `06-*`「视频提示词只写环境声 / 对白原声 / 同步音效，不生成 BGM」一致。

## 已知边界（编排器行为，勿踩）

- 编排器（`canvas-server/src/pipeline.js` 的 `readPromptTemplate` → `extractSection`）只把本文的 **`## 提示词模板`** 一节发给模型；其余章节是给人 / Agent 看的，不会进模型上下文。因此新方法论必须写进「提示词模板」（用 `###` 子标题，`^##\s` 不会在其中截断）。
- **视频提示词不由本阶段生成**：`generativePlan` 用 `[storyboard.shots[].prompt, .action]` 拼 `PROMPT`，本阶段产出的 `clips[].*` 里**没有**提示词字段。所以「视频提示词 7 段结构 / 9 步转换 / 负向约束」等写法要落在**分镜阶段（02）的 `shots[].prompt`**；本阶段只影响 `durationSec` / `assembly.order` / `assembly.transition`，不重复写视频提示词（这也是本技能的 `## 提示词模板` 第 3 条）。
- **时长网格**：`LENGTH` 在 `canvas-server/src/durations.js` 按 `17k+5` 帧网格 @24fps 向上吸附（`videoFps` 默认 24）；推荐档 5/10/15s 分别对应 124/243/362 帧，均为合法网格点（15 秒不会渲染出错误帧数）；非网格帧数会被向上吸附。宽高须为 32 的倍数（竖屏常用 `480×864` / `768×1344`），由 `config.pipeline.videoWidth/videoHeight` 决定。
- **本机是单卡串行队列**，一次只能跑一个生成任务；不要写云端的「单批最多 2 个视频」这类配额上限。
- **拼接执行体已存在**：`canvas-server/src/delivery.js`（`planAssembly` → ffmpeg concat / xfade）只认契约里的 `cut` / `fade` / `dissolve` / `slide`，非 `cut` 转场要求每段都有有效 `durationSec`。
- **声音不在契约内**：没有音频字段，07 的 BGM Cue Sheet 只能作为后续独立产物 / 独立阶段落地，不得塞进 `clips` / `assembly`（塞进去就破坏机器契约）。
- **待接线**：若要让后期声音设计成为可落库的一环，需要新增独立阶段与字段（属编排器 / 领域契约范围，不在本阶段技能可改范围）。

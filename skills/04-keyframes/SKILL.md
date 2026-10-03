---
name: keyframes
description: |
  为分镜逐个镜头生成关键帧（首帧/尾帧）任务。用于把分镜提示词与服化道方案合成为生图参数、选择模板、串起首帧到尾帧的图生图链路，输出严格 JSON（frames）。这是五段式流水线的第四段：关键帧，属于生成型阶段。
---

# 关键帧：分镜 + 服化道 → 首尾帧

关键帧是连接分镜与视频的唯一桥梁：**首帧决定视频的空间事实**，尾帧决定这一段落到哪里。本阶段只负责把每一帧的提示词与生成参数构造正确，真实生图由 canvas-server 的任务队列执行。

- `role: "start"` 走 `config.pipeline.imageTemplate`（文生图）。
- `role: "end"` 走 `config.pipeline.editTemplate`（以同镜头首帧为 `INPUT_IMAGE` 的图生图/改图）。

> 视觉风格层接管自 `skills/libraries/Luster-iwai-aesthetic-prompt`（岩井俊二美学签名系统，MIT）：只吸收其**光学 / 色彩 / 结构**方法论；**胶片介质层改由编排器按 `styleAnchor` 条件叠加**（命中胶片/写实关键词才叠加，二维动画等非胶片锚点默认关闭），本技能不再无条件套胶片。风格层与项目级 `styleAnchor` 的组合 / 覆盖规则见下文「二」。逐条对照见 `skills/libraries/luster-接线说明.md`。

## 内容创作红线（硬约束）

- **忠于原著、忠于用户**：关键帧只还原分镜与服化道已经确定的人物、服装、场景与动作，不得为道德教化、价值观引导、过审或「更积极健康」而改动画面设定。
- **不注入教化式结构**：不添加原著 / 分镜里没有的「惩罚落点」「情感闭环」类画面暗示；画面内容由分镜与用户决定。
- **风险只提示、不改稿**：识别到的政策、平台规则、年龄分级、IP 授权风险只能作为独立提示（项目层 `reviewNotes[]`）交给用户，**绝不写进 `frames` 或 `prompt`，绝不为规避风险改动画面**。
- **质量校验照做**：`prompt` 能否直接生图、同一镜 `start` / `end` 的人物身份 / 服装 / 光线是否一致，属工艺要求，照常校验，与内容审查无关。

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

### 一、提示词的分层结构（顺序固定）

每一帧的 `prompt` 按下面四层顺序拼成，**先风格、后内容、再光学、末介质**：

1. **首句 = 项目风格锚点**：`{{options.styleAnchor}}`。这是项目级风格锚点（`Project.styleAnchor`），全项目所有生图 / 生视频提示词首句必须**一字不差**。编排器已把该锚点（缺锚点时用中性兜底锚点）注入本变量并替换，所以你拿到的**一定是真实锚点原文**、绝不会是占位符；若锚点为空或异常地仍是占位符字样，改用中性锚点（`统一视觉方向，自然光，干净画面`），且**绝不把占位符字样或 `{{ }}` 写进 `prompt`**。
2. **主体与场景**：人物外观（年龄、体态、五官、发型、服装）与场景陈设必须来自 `design` 与该镜对应的场景，不得在这里改写人物设定。
3. **光学 / 摄影层**：本帧的光源与光学事件（见「二」）。
4. **介质与画质收尾**：按首句锚点的取向收口——胶片 / 写实锚点的介质层由编排器条件叠加（见「二」），非胶片锚点（如二维动画）写该风格自己的收尾（`clean lines, flat colors` 一类），**不要**写死胶片词。

**锚点缺失时的兜底**：编排器在项目与 `run.options` 都没有锚点时注入中性兜底锚点 `统一视觉方向，自然光，干净画面`（也可按 `{{options.plan.visualStyle}}` 推导），因此**不会**再回落到 `35mm film still, expired Kodak Gold 200` 这类胶片默认锚点。

首句一旦由锚点给出，就以它为准，**不要**再自拟第二套风格词，也不要另写胶片介质层（见「二」）。

### 二、风格化叠加层（胶片层由编排器按 `styleAnchor` 条件叠加，本技能不自写）

风格维度**唯一事实源**是项目级 `styleAnchor`（运行层已注入，见「一」）；是否叠加胶片层由编排器按锚点判定，不写死：

1. **锚点独占首句**：`styleAnchor` 一字不差作 `prompt` 首句（见「一」），压过本技能的一切默认风格。
2. **胶片层仅当锚点命中胶片 / 写实介质关键词时才生效**：编排器用 `胶片 / 菲林 / 写实 / 实拍 / film / Kodak / 35mm / grain / 颗粒` 等词判定——命中才在锚点之后追加 Luster 冻结胶片层（`overexposure melting contours golden rim on hair, grey-blue shadows, fine grain, light leak upper right, 1/100s shutter, tack-sharp`）；未命中（如「二维动画」锚点）一律**不叠加**，默认关闭。
3. **本技能不要在 `prompt` 里写死胶片 / 介质层**：那会与锚点冲突、并与编排器叠加重复。本技能只写首句锚点 + 主体/场景 + 光学事件；介质与画质收尾跟随锚点取向（非胶片锚点写该风格自己的收尾）。
4. **不采用 Luster 的人物 / 场景默认锚点**（十八岁日本高中生、日本实物锚点等）：人物以 `design` 为准、场景以 `storyboard` / `design` 为准。光学结构（单一光源 + 恰好一个光学事件 + 发丝级细节 + 冷暖分离）任何基调都可借用，色彩与介质一律以 `styleAnchor` 为准。

光学结构（任何基调都适用）还要遵守：

- **每帧恰好一个光学事件**（不要堆叠两个）。事件从下述库里取一个，英文短语参考见 `skills/libraries/Luster-iwai-aesthetic-prompt/references/style-system.md`：发丝半透明琥珀金边 / 逆光过曝轮廓融化 / 大光斑前景 / 光柱罩住局部 / 云底紫闪+远处雨幕 / 几何影子分割 / 熔金暮蓝对撞 / 双色温分界线 / 花瓣变光斑 / 玻璃折射光斑 / 水面碎金反光 / 窗影投身 / 逆光尘埃悬浮 / 雨珠挂帘透光 / 信号灯红色入雾 / 萤火路灯一点暖 / 白床单透光变纱 / 雪粒逆光成星点 / 风扇发丝吹动慢光 / 汽水瓶壁凝珠反光。
- **动态模糊只允许给环境元素**（草穗 / 花瓣 / 雨幕 / 裙摆），**禁止给人物**。
- **有态度机位**：需要本阶段选机位 / 构图时优先贴地机位、低仰角抓拍、越肩、隔窗偷拍、门框纵深、几何分割等有态度的机位；但**机位必须服从分镜的 `prompt` / `action`**，分镜已给景别与运镜时以分镜为准。
- **正文只用肯定式**：`prompt` 正文不写 `no` / `not` / `without` 这类否定措辞（否定交给模板，不要写进正文）。

### 三、画面质量硬技巧（Luster 踩坑清单 · 质量规则）

> 来自 `skills/libraries/Luster-iwai-aesthetic-prompt/references/pitfalls.md`，属**质量**要求（与内容审查无关）；人物 / 场景设定仍以 `design` / `storyboard` 为准。

1. **显式声明画面人数**：先声明本帧可见人数，再写 `exactly one person` / `exactly two people`（动物入镜把动物计入），避免 AI 自行加人。
2. **场景要写实物锚点**：不要只写抽象地点或风格词（只写 `Japanese` 会出美式街景）；写清具体的可见物件、招牌、电线杆、门窗、路面材质等能锚定环境的物理细节。
3. **情绪写可见微动作，不裸写抽象情绪**：不要只写 `shouting` / `crying` / `sad` 这类抽象词（易被画成痛苦 / 迷茫）；改写成可见的微表情与身体反应，例如 `laughing, mouth open, eyes squeezed shut with joy`。
4. **多人 / 性别混排给双锚点**：男女同框时分别写清性别与发型特征（如女生 `short shoulder-length hair`、男生 `clearly male short-haired`），避免特征互相污染。

### 四、尺寸与生成参数（按本项目约束，不照搬云端）

1. **不写 Midjourney 尾参**：`--ar` / `--style raw` / `--s` / `--no` 一律不写进 `prompt`；画幅由模板的 `WIDTH` / `HEIGHT` 决定。
2. **宽高必须是 32 的倍数**：竖屏常用 `480×864` / `768×1344`，横屏常用 `1344×768`；实际值由 `options.image` 或 `config.pipeline.imageWidth` / `imageHeight` 决定，**模型不写尺寸**。
3. **单镜帧数**不超过 `{{pipeline.maxKeyframesPerShot}}`（默认 2）。
4. 真实生图由 canvas-server 任务队列执行；本阶段只产出提示词与清单，不伪造产物。

### 五、自检

1. 每帧 `prompt` 首句是否为**项目风格锚点原句**（而不是自拟的风格词，也不是未替换的占位符）？
2. 每帧是否**恰好一个**光学事件、动态模糊是否只给环境元素？**胶片 / 介质层不写在 `prompt` 里**（由编排器按锚点条件叠加），有没有误写 `film / Kodak / grain / tack-sharp / light leak` 等与锚点冲突的胶片词？
3. 人物外观 / 服装是否与 `design` 一致、场景是否与该镜一致、有没有引入首帧不存在的人物 / 道具？
4. 有没有显式声明画面人数、场景有没有实物锚点、情绪有没有写成可见微动作？
5. 有没有误写 `--ar` / `--style` 等尾参或尺寸？`template` / `jobId` / `artifactUrl` / `status` 是否已留空或置 null？

## 校验规则

- 顶层必须是对象且含 `frames` 数组；每个 `frames[].shotId` 必须存在于上游 `storyboard.shots`。
- `role` 只能是 `start` / `end` / `key`；每个镜头的 `start` 帧最多一帧。
- `prompt` 非空且为英文；`template` 必须是 `config.pipeline.imageTemplate` 或 `editTemplate` 之一。
- `prompt` 首句必须是项目风格锚点：要么是 `Project.styleAnchor` 原句，要么（运行层未提供锚点时）是中性兜底锚点；不得自拟第三种首句。
- 每帧恰好一个光学事件；**胶片 / 介质层由编排器按锚点条件叠加，`prompt` 内不得出现与锚点冲突的胶片介质词**（「二维动画」锚点不得出现 `film / Kodak / grain / tack-sharp / light leak`）。
- 画面要显式声明可见人数、场景要有实物锚点、情绪要写成可见微动作（质量要求，来自 Luster 踩坑清单）。
- `prompt` 内不得出现 `--ar` / `--style` / `--s` / `--no` 等生成器尾参，也不得残留 `{{...}}` 占位符。
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

## 已知边界（编排器行为，勿踩）

- 编排器（`canvas-server/src/pipeline.js` 的 `readPromptTemplate` → `extractSection`）只把本文的 **`## 提示词模板`** 一节发给模型；其余章节是给人 / Agent 看的，不会进模型上下文。因此新方法论必须写进「提示词模板」（用 `###` 子标题，`^##\s` 不会在其中截断）。
- **风格锚点注入路径（已落地）**：`pipeline.js` 的 `buildContext` 现在把项目级 `styleAnchor`（其次 `run.options.styleAnchor`）注入 `options.styleAnchor`、把项目 `plan` 注入 `options.plan`，所以 `{{options.styleAnchor}}` **一定被替换**；缺锚点时注入中性兜底锚点，不再回落胶片默认锚点。胶片层由 `productionDefaults` / `withPromptHead` 判定为**条件叠加**（见「二」）。
- **尺寸与采样参数由编排器填**：`WIDTH` / `HEIGHT` / `BATCH` / `SEED` / `LORA_FILE` 由 `generativePlan` 从 `config.pipeline` 与 `run.options.image` 取，模型不改。默认 `imageWidth/imageHeight` 为 `768×1344`（竖屏 9:16，均为 32 的倍数）。
- **本项目生图模板以肯定式 `PROMPT` 为主**（如默认 `img_zimage_artistic` 不设独立负向 token），因此 Luster 的 `--no text, words, watermark` 不接线；正文一律用肯定式。
- 本阶段的方法论只影响 `prompt` 内容与清单结构；不引入 Midjourney 尾参、Seedance 参数或任何云端平台专属格式（云端配额 / 时长不在本阶段）。

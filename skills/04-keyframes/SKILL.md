---
name: keyframes
description: |
  为分镜逐个镜头生成关键帧（首帧/尾帧）任务。用于把分镜提示词与服化道方案合成为生图参数、选择模板、串起首帧到尾帧的图生图链路，输出严格 JSON（frames）。这是五段式流水线的第四段：关键帧，属于生成型阶段。画上文字由分镜（02-storyboard）的 textOverlays 逐字给定，本阶段只逐字消费拼进 prompt，不得翻译改写、不得自行编字；分镜缺失该字段时只报 QC warning。
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
| `storyboard` | 是 | 上游分镜产物，提供 `shots[]`（含逐镜 `textOverlays` 画上文字清单，本阶段文字的唯一事实源） |
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
      "prompt": "英文生图提示词（画面里要渲染的文字用引号原样夹进来）",
      "textOverlays": [
        { "text": "站牌 / 车票 / 屏幕上确切的中文字样", "kind": "sign", "position": "文字在画面里的位置与载体", "style": "字体 / 颜色 / 材质 / 新旧" }
      ],
      "template": "img_zimage_artistic",
      "jobId": null,
      "artifactUrl": null,
      "status": "queued"
    }
  ]
}
```

- `textOverlays`：本帧画面上**要渲染的确切文字**清单，**逐字抄自上流分镜 `storyboard.shots[].textOverlays`**（分镜是文字的唯一事实源）、与 `prompt` 一一对应；每条含 `text` / `kind` / `position` / `style` 四个键（`text` 是**要渲染的确切文字**，中文原样给出，**不得翻译、不得改写**）。`kind` 取 `sign` | `ticket` | `screen` | `logo` | `none`（**没有 `subtitle`**）。**本阶段只照抄拼装、绝不自行创造文字**；**若上游误给 `kind: "subtitle"`，一律丢弃并 QC warning —— 字幕绝不进画面**；确无文字时显式写 `[{"text":"","kind":"none","position":"","style":""}]`（键不得缺、不得为 `null`）。**若分镜未提供该字段，只能产生 QC warning，不得静默丢弃、也不得自己编字**。详见「提示词模板 → 五」。
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
3. **图上文字逐字消费分镜**：本阶段不自己造字。分镜（`storyboard.shots[]`）已经用 `textOverlays` 逐条给出这一镜画面上要渲染的**确切文字**（站牌名、车票字样、线路号、目的地显示屏、招牌、路牌、手机屏幕内容、字幕）——原样搬进本帧 `textOverlays`，并在同帧 `prompt` 里用英文双引号**原样引用**（中文照抄、**不得翻译改写**）；**绝不允许留空让模型自行发挥、不得自己编字**；分镜若给 `kind: "none"`（空镜）照抄即可，分镜缺失该字段只报 QC warning（见「五」）。
4. `role` 为 `start` 时描述动作的起始姿态与空间关系；`role` 为 `end` 时描述同一空间中动作的落点，人物身份、服装、光线必须与首帧完全一致，只改变姿态与景别。
5. 保持单个连续空间，不要引入首帧里不存在的人物、门窗或道具。
6. `template`、`jobId`、`artifactUrl`、`status` 由编排器回填：原样保留这几个字段并留空或置 null，不要自己编造。
7. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"frames":[{"id":"sh1-start","shotId":"sh1","role":"start","prompt":"","textOverlays":[{"text":"","kind":"none","position":"","style":""}],"template":null,"jobId":null,"artifactUrl":null,"status":"queued"}]}

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

### 五、图上文字（textOverlays 契约，消费侧，逐字照抄）

**画上文字的唯一事实源是上流分镜（`skills/02-storyboard`）。**「这一镜画面上该出现什么字」在分镜阶段就已经逐字定死；本阶段**不再自行创造文字**，只做一件事：**把分镜 `shots[].textOverlays` 里的每条 `text` 逐字拼接进本帧 `prompt`**——中文原样照抄、**不得翻译、不得改写、不得只写 `a sign` / `站名` / `一块招牌`**。分镜给了确切字样，出图才不会把站牌画成乱码、把线路号渲染成「MH 00 000」这类伪文字。

**字段形状（原样透传，形状不改）**：`textOverlays: [{ text, kind, position, style }]`，每条四个键都要在：

- `text`：**分镜给定的确切文字**，中文原样照抄（如 `"老城南路公交站"`、`"3路"`、`"末班车"`）。本阶段**只搬不改**。
- `kind`：`sign` | `ticket` | `screen` | `logo` | `none`（**没有 `subtitle`**）。站牌 / 招牌 / 路牌 = `sign`；车票 = `ticket`；显示屏 / 手机屏 = `screen`；商标 = `logo`；无文字 = `none`。

> ⚠️ **字幕绝不进画面**：对白字幕由后期以独立 `.srt` 提供；本帧只渲染物体文字，**不得渲染字幕**。
- `position`：文字在画面里的位置与载体（如 `画面左上方的公交站牌主标题`）。
- `style`：字体 / 颜色 / 材质 / 新旧（如 `白底黑体、边缘轻微锈蚀`）。

**硬规则（不可违反）**：

1. **只消费、不创造**：本帧 `textOverlays` 的每一条都必须来自分镜 `shots[].textOverlays`；本阶段不得新增、改写、翻译或删减分镜给的文字。
2. **逐字引用进 `prompt`**：`textOverlays` 里每一条 `text` 都要在同帧 `prompt` 里用英文双引号把**原文字样**包住原样引用；「写什么」和「画在哪、什么字体」都要给全。
3. **禁占位 / 禁空转**：不得把文字留空让模型自行发挥，也不得只写 `a sign` 这类泛指。
4. **分镜缺失该字段时**：**只能产生 QC warning**（项目层 `reviewNotes[]` / 帧上 QC warning），**不得静默丢弃、也不得自己编字**——宁可显式留空 + 告警，也不要凭空造字样。
5. **确无文字**：分镜若给 `kind: "none"`（如空镜），本帧照抄 `[{"text":"","kind":"none","position":"","style":""}]`，键不得缺、不得为 `null`。

**性质说明**：这些文字是**模型必须逐字渲染的内容**，与画面描述（氛围、光线、动作）性质不同——画面描述可以概括，文字**只能逐字照抄**。有几种文字就列几条；`textOverlays` 里每一条 `text` 都必须在同帧 `prompt` 里找到对应引用，否则等于没告诉模型要写什么。

**完整示例（分镜带来站牌文字 → 关键帧逐字消费）**：

```json
{
  "id": "sh7-start",
  "shotId": "sh7",
  "role": "start",
  "prompt": "统一视觉方向，自然光，干净画面。Exactly one person, a young woman in a faded denim jacket standing beside an old city bus stop, a worn bus stop sign reading \"老城南路公交站\" with route number \"3路\" printed in its lower right corner, a paper bus ticket in her hand showing \"3路 末班车\", overcast afternoon light, medium shot.",
  "textOverlays": [
    { "text": "老城南路公交站", "kind": "sign", "position": "画面左上方的蓝白公交站牌主标题", "style": "白底黑体、边缘轻微锈蚀" },
    { "text": "3路", "kind": "sign", "position": "站牌右下角的线路号", "style": "红底白字、略褪色" },
    { "text": "3路 末班车", "kind": "ticket", "position": "她手里捏着的纸质车票票面", "style": "白底黑字、针式打印字体" }
  ],
  "template": null,
  "jobId": null,
  "artifactUrl": null,
  "status": "queued"
}
```

**拼法要点**：`prompt` 里用 `a worn bus stop sign reading \"老城南路公交站\" with route number \"3路\" printed in its lower right corner`、`a paper bus ticket in her hand showing \"3路 末班车\"` 把 `textOverlays` 的三条字样**原样夹进画面描述**，`textOverlays` 再逐条给足确切字样 + 位置 + 字体——「写什么」和「画在哪、什么字体」都要给全。**中文原样保留、不要翻成英文**（Qwen-Image 2.1 等中文字形强的模型能直接渲染中文）；分镜确无文字时照抄 `[{"text":"","kind":"none","position":"","style":""}]`。



### 六、自检

1. 每帧 `prompt` 首句是否为**项目风格锚点原句**（而不是自拟的风格词，也不是未替换的占位符）？
2. 每帧是否**恰好一个**光学事件、动态模糊是否只给环境元素？**胶片 / 介质层不写在 `prompt` 里**（由编排器按锚点条件叠加），有没有误写 `film / Kodak / grain / tack-sharp / light leak` 等与锚点冲突的胶片词？
3. 人物外观 / 服装是否与 `design` 一致、场景是否与该镜一致、有没有引入首帧不存在的人物 / 道具？
4. 有没有显式声明画面人数、场景有没有实物锚点、情绪有没有写成可见微动作？
5. 有没有误写 `--ar` / `--style` 等尾参或尺寸？`template` / `jobId` / `artifactUrl` / `status` 是否已留空或置 null？
6. 画面里的文字是否**逐字来自分镜的 `textOverlays`**、并在 `prompt` 里原样引用？有没有翻译 / 改写 / 新增分镜没给的文字、留空、或只写 `a sign`？分镜缺失该字段时是否只报 QC warning、没有自己编字？确无文字时是否照抄了 `kind: "none"`？

## 校验规则

- 顶层必须是对象且含 `frames` 数组；每个 `frames[].shotId` 必须存在于上游 `storyboard.shots`。
- `role` 只能是 `start` / `end` / `key`；每个镜头的 `start` 帧最多一帧。
- `prompt` 非空且为英文；`template` 必须是 `config.pipeline.imageTemplate` 或 `editTemplate` 之一。
- `prompt` 首句必须是项目风格锚点：要么是 `Project.styleAnchor` 原句，要么（运行层未提供锚点时）是中性兜底锚点；不得自拟第三种首句。
- 每帧恰好一个光学事件；**胶片 / 介质层由编排器按锚点条件叠加，`prompt` 内不得出现与锚点冲突的胶片介质词**（「二维动画」锚点不得出现 `film / Kodak / grain / tack-sharp / light leak`）。
- 画面要显式声明可见人数、场景要有实物锚点、情绪要写成可见微动作（质量要求，来自 Luster 踩坑清单）。
- `prompt` 内不得出现 `--ar` / `--style` / `--s` / `--no` 等生成器尾参，也不得残留 `{{...}}` 占位符。
- 每帧必须含 `textOverlays` 数组；每条含 `text` / `kind` / `position` / `style` 键，`kind` 取 `sign` / `ticket` / `screen` / `logo` / `none`（**没有 `subtitle`**）；每条 `text` 必须与上游 `storyboard.shots[].textOverlays` **逐字一致**，不得翻译 / 改写 / 新增。
- 分镜给的每条文字都要在 `prompt` 内用引号原样引用；**分镜缺失 `textOverlays` 字段时只能产生 QC warning，不得静默丢弃、也不得自行编字**；`textOverlays` 缺键 / 为 `null` / 画面有文字却写成 `kind: "none"` 一律 QC warning；确无文字时必须显式 `kind: "none"`。
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
- **本项目生图模板以肯定式 `PROMPT` 为主**（如默认 `img_zimage_artistic` 不设独立负向 token），因此 Luster 的 `--no text, words, watermark` 不接线；正文一律用肯定式。**画上文字一律走 `textOverlays` 正向逐字指定**——没有全局负向 token，模型只会渲染你明确告诉它的文字，这正是「不写 textOverlays 就出伪文字 / 乱码」的根因。
- **`textOverlays` 契约（消费侧）**：画上文字的唯一事实源是 `02-storyboard` 的 `shots[].textOverlays`（分镜阶段逐字定死）；**本阶段只逐字消费拼进 `prompt`，不自行创造文字**。**若分镜缺失该字段，只能产生 QC warning，不得静默丢弃、也不得自己编字**；服务端解析 / 校验尚未接线，在映射完成前缺失或不合规只能产生 QC warning。注意与 `03-costume-props` 的参考图提示词（`closeupPrompt` / `turnaroundPrompt` / `sceneMasterPrompt` 要求 `no text`）相反：关键帧要写清指定文字、参考图要干净无字，两者不要混用。
- 本阶段的方法论只影响 `prompt` 内容与清单结构；不引入 Midjourney 尾参、Seedance 参数或任何云端平台专属格式（云端配额 / 时长不在本阶段）。

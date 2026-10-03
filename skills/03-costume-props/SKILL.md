---
name: costume-props
description: |
  为剧本角色和场景设计服化道。用于角色造型、妆容发型、随身道具、场景陈设与布光设计，输出严格 JSON（characters/locations）。当需要保证跨镜头角色一致性与场景调性统一时使用。这是五段式流水线的第三段：服化道。角色除外观文字外须给出可直接生图的正脸特写与正/侧/背三视图参考图提示词，场景须给出无人、固定光源的空场母版参考图提示词。
---

# 服化道：角色造型与场景美术

服化道不是美术形容词，而是**可复现的生成参数**：同一角色在任何镜头里都必须能用同一段文字描述出来。所有造型都要能追溯到剧本中的身份、时代与处境。

> 方法论接管自 `skills/libraries/script-writing-studio`（05 资产库：05-asset-library / 05-style-character / 05-handoff-output），已做本地化接线：只吸收一致性、编号稳定、空场母版与可执行布光等方法论，剥离云端生成器参数（Seedance / 豆包 / MJ 尾参）与国内平台专属条款，遵守 `AGENTS.md`「内容创作规范」。逐条对照见 `skills/libraries/script-writing-studio-接线说明.md`。

## 内容创作红线（硬约束）

- **忠于原著、忠于剧本**：造型与场景不得为道德教化、价值观引导、过审或「更积极健康」而默认改动人物形象、服装尺度或场景调性；剧本怎么写就怎么设。
- **不注入教化式结构**：不为了「正向落点」而美化 / 修正人物或环境；角色外观与剧本身份冲突时按剧本走。
- **风险只提示、不改稿**：可以识别政策、平台规则、年龄分级、IP 授权等风险，但只能作为独立提示（项目层 `reviewNotes[]`）交给用户，**绝不写进本阶段 JSON、绝不为规避风险改稿**。
- **质量校验照做**：`prompt` 能否直接生图、角色能否跨镜头一致，属工艺要求，照常校验，与内容审查无关。

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
      "prompt": "英文造型提示词，可直接接在人物外观描述后面",
      "closeupPrompt": "英文正脸特写生图提示词：风格锚点前缀 + 单一角色 + 正面清晰 + 干净背景无文字水印",
      "turnaroundPrompt": "英文正/侧/背三视图生图提示词：风格锚点前缀 + 单一角色 + 四视角一致 + 干净背景无文字水印",
      "turnaroundArtifactIds": ["art_c1_turnaround"],
      "referenceArtifactIds": ["art_c1_closeup"],
      "views": ["front", "three_quarter", "side", "back"],
      "confirmed": false
    }
  ],
  "locations": [
    {
      "id": "loc1",
      "name": "地点名，与剧本 scenes[].location 对应",
      "setDressing": "陈设：家具、墙面、地面、时代物件",
      "lighting": "光源方向、色温、明暗比",
      "palette": "主色 + 辅色 + 点缀",
      "prompt": "英文场景提示词",
      "sceneMasterPrompt": "英文空场母版生图提示词：风格锚点前缀 + 无人 + 固定光源方向 + 干净背景无文字水印",
      "sceneMasterArtifactId": "art_loc1_master",
      "views": ["master", "key_angle_1"],
      "confirmed": false
    }
  ]
}
```

- `characters[].id` 必须沿用剧本里的人物 id，不允许新建。
- `locations[].name` 必须覆盖剧本用到的每个地点。
- `characters[].turnaroundArtifactIds`：角色三视图产物（Artifact）id 数组，对应 `views` 里的正 / 三分之四（`three_quarter`）/ 侧 / 背视角；`characters[].referenceArtifactIds`：角色正脸特写与其它可复用参考图（Artifact）id 数组。
- `characters[].closeupPrompt`：角色**正脸特写参考图**的独立生图提示词（可直接生图），与 `referenceArtifactIds` 对齐；`characters[].turnaroundPrompt`：角色**正 / 侧 / 背三视图参考图**的独立生图提示词，与 `turnaroundArtifactIds` 对齐。两条都自带风格锚点前缀与硬约束（写法见「提示词模板 → 七」）。
- `locations[].sceneMasterPrompt`：场景**空场母版参考图**的独立生图提示词（无人、固定光源方向），与 `sceneMasterArtifactId` 对齐（写法见「提示词模板 → 七」）。
- `characters[].views`：三视图覆盖的视角，默认 `["front", "three_quarter", "side", "back"]`；缺哪个视角就是风险，不得默认「已覆盖」。
- `locations[].sceneMasterArtifactId`：场景**空场母版**（无人、含固定光源方向）的 Artifact id；`locations[].views` 记录空场母版与关键视角。
- `confirmed`：角色 / 场景的**项目级确认状态**，初始一律 `false`（文字设定刚产出、图还没生成或没被用户确认）。只有用户确认过资产，才能置 `true`。
- **确认门禁（硬规则）**：`characters[].confirmed !== true` 或 `locations[].confirmed !== true` 时，**不得直接生成整集关键帧**；未确认的资产只能产出候选图并等待人工确认，确认后才允许进入「整集关键帧」。
- Artifact id 在只有文字、图还没生成时允许为空数组 / 空字符串，但 `views` 与 `confirmed` 键必须存在；不得用文字字段冒充已生成的资产。

## 提示词模板

你是影视美术指导。基于下面的剧本，产出角色服化道与场景美术方案；产物是可复现的生成参数（同一角色在任何镜头都能用同一段文字复现），会逐级喂给本地短剧流水线（关键帧、片段合成）。

剧本 JSON：
<script>
{{script}}
</script>

### 一、创作底线（不可违反）

1. 忠于剧本：造型与场景必须能追溯到剧本中的身份、时代、处境、场次；不得为道德教化、价值观引导或「更积极健康」而改动人物形象、服装尺度或场景调性。
2. 不注入教化式结构：不为了「正向落点」而美化 / 修正人物或环境；角色外观与剧本身份冲突时按剧本走。
3. 风险只提示、不改稿：识别到的审核、IP、年龄分级风险不得写进任何字段，也不得为规避风险改稿；本阶段只输出下面的 JSON。
4. 不捏造：剧本没写但设计必需的细节可合理推断补齐，不得编造与剧本矛盾的身份、地域、时代。

### 二、一致性（本阶段核心）

1. `characters[].id` 与 `name` 原样沿用剧本 `characters`，不新增、不改名、不合并；同一角色只出现一次。
2. 每个角色写清**标志性识别点**（脸型、发型、体态、标志配饰）与**禁止变化点**，使同一角色在任何镜头都能用同一段文字复现。
3. `locations[].name` 必须覆盖剧本 `scenes[].location` 去重后的全部取值，命名与剧本一致。
4. 内部命名 / 编号只能出现在说明里；`prompt` 必须自包含，让生图模型不看本技能也能看懂。

### 三、字段落位（库的资产卡如何折进本阶段契约）

库里的角色资产卡 / 场景资产卡字段很细。除本次新增的结构化资产字段（`turnaroundArtifactIds` / `referenceArtifactIds` / `sceneMasterArtifactId` / `views` / `confirmed`，见「六」）与参考图提示词字段（`closeupPrompt` / `turnaroundPrompt` / `sceneMasterPrompt`，见「七」）外，本阶段 JSON 契约固定，**不得再新增其它字段**。按下列落位把方法论写进去：

1. `outfit`：服装——形制、颜色、材质、磨损程度；服务人物处境（时代、职业、经济状况、当下情绪都要能从材质与磨损看出来）。
2. `makeup`：妆容——底妆、眉眼、唇色、特殊妆效（伤痕、狼狈、伪装态也算）。
3. `hair`：发型——长度、分缝、束法、发色。
4. `props`：随身 / 绑定道具的字符串数组，没有就空数组；命名到能唯一识别（如「裂纹银色打火机」而不是「打火机」）。
5. `palette`（角色）：用十六进制写死三个颜色（主色 / 辅色 / 点缀），供后续统一色调。
6. `prompt`（角色）：英文，写可复现的造型基底——脸型＋五官＋发型＋体态＋服装＋关键道具＋风格质感；人物外观口径必须与剧本 `characters[].appearance` 一致。
7. `setDressing`（场景）：**空场**陈设——家具、墙面、地面、门窗、招牌、时代物件与固定光源；只写固定环境，不写人物、路人、群演、随机顾客或不可控动态物。有内外分界的场景（玻璃 / 门框 / 柜台 / 吧台 / 车窗 / 栏杆），要写清结构关系（哪是室内侧、哪是室外侧）。
8. `lighting`（场景）：可执行布光——光源来源、方向、色温、明暗比、亮区 / 暗区（如「西窗侧逆光，色温 4300K，脸部明暗比约 1:3」）；不要写「氛围感」这类空话。
9. `palette`（场景）：主色＋辅色＋点缀，与场景调性一致。
10. `prompt`（场景）：英文，写空场环境——空间＋材质＋固定物件＋光线＋风格质感，可直接拼进生图提示词。
11. `turnaroundArtifactIds` / `referenceArtifactIds`（角色）：三视图与正脸特写 / 参考图的产物 id 数组，图未生成时为空数组。
12. `views` / `confirmed`（角色）：三视图视角覆盖（默认 `["front","three_quarter","side","back"]`）与项目级确认状态（初始 `false`）。
13. `sceneMasterArtifactId`（场景）：空场母版产物 id，图未生成时为空字符串。
14. `views` / `confirmed`（场景）：空场母版与关键视角列表、项目级确认状态（初始 `false`）。
15. `closeupPrompt` / `turnaroundPrompt`（角色）：正脸特写与三视图的**独立生图提示词**（写法见「七」），与 `referenceArtifactIds` / `turnaroundArtifactIds` 对齐。
16. `sceneMasterPrompt`（场景）：空场母版的**独立生图提示词**（写法见「七」），与 `sceneMasterArtifactId` 对齐。

### 四、风格（写进 prompt，不写内部编号）

1. 角色与场景的 `prompt` 用自然语言表达项目风格（媒介类型、人物审美、场景审美、画面质感、光影质感），使其自包含。
2. 不写 Midjourney 尾参（`--ar/--style/--s/--no`）、不写 Seedance / 豆包参数、不写画幅与分辨率（尺寸由流水线模板的 `WIDTH/HEIGHT` 决定，H3 宽高为 32 的倍数）。
3. 造型 / 场景的 `prompt` 只写正向描述，不把清洁渲染 / 防跑偏的负面串塞进 `prompt`（负面词归下游）；但参考图提示词 `closeupPrompt` / `turnaroundPrompt` / `sceneMasterPrompt` 的**固定硬约束尾**（`clean plain background, no text, no logo, no watermark` 一类）必须逐条保留——参考图是资产，必须干净无字。

### 五、道具（单实例与朝向）

1. `props` 里的关键道具要能唯一识别；同一件道具不要在多个角色的 `props` 里重复登记成两件。
2. 若关键道具同时属于角色造型与场景陈设，两边描述必须指向同一件（用同样的可识别名称），供下游做单实例锁。
3. 手机、照片、证件、信封等小道具若需要特写，在 `prompt` 里写清哪一面朝镜头 / 背向镜头，避免下游把背面生成成屏幕或界面。

### 六、预制资产（三视图 / 特写 / 空场母版）与确认门禁

除文字字段外，本阶段要为下游资产链留出结构化出口（对齐 §11.5.2 / §13.3 的资产链：角色文字设定 → 角色三视图 / 特写 → 用户确认 → Character AssetRef；场景文字设定 → 空场母版 / 关键视角图 → 用户确认 → Scene AssetRef）：

1. 角色要覆盖**正脸特写**与**正 / 侧 / 背三视图**：`turnaroundArtifactIds` 放三视图产物 id，`referenceArtifactIds` 放正脸特写与其它参考图 id，`views` 固定写 `["front", "three_quarter", "side", "back"]`（缺哪个视角就在对应位置说明风险，不得默认已覆盖）。
2. 场景要覆盖**空场母版**（无人、含固定光源方向）与**关键视角**：`sceneMasterArtifactId` 放空场母版 id，`views` 记录母版与关键视角；固定光源方向必须同时写进 `lighting`（可执行布光，写清光源来源、方向、色温、明暗比）。
3. `turnaroundArtifactIds` / `referenceArtifactIds` / `sceneMasterArtifactId` 在只有文字、图还没生成时允许为空数组 / 空字符串；**不得用文字字段冒充已生成资产**。
4. `confirmed` 是本阶段产出的**项目级确认状态**，初始一律 `false`；只有用户确认过角色 / 场景资产后才能置 `true`。**确认门禁（硬规则）**：`confirmed !== true` 时**不得直接生成整集关键帧**——未确认资产只能产出候选图等待人工确认，不能用「文字已足够」绕过。

### 七、参考图提示词（正脸特写 / 三视图 / 空场母版，可直接生图）

除 `prompt`（造型 / 场景的通用外观描述）外，每个角色与每个场景还要各写一段**自包含、可直接丢进文生图**的参考图提示词。这些产物就是 `referenceArtifactIds` / `turnaroundArtifactIds` / `sceneMasterArtifactId` 指向的图，是让**同一角色跨镜头、同一场景跨镜次**保持一致的**唯一视觉参考**；只给文字描述、不给可生图提示词，等于下游每一镜都在重新掷骰子。

**角色两条**（与参考图产物一一对齐）：

1. `closeupPrompt`（正脸特写，对齐 `referenceArtifactIds`）：单人、正面、脸部占画面主体、五官与发型清晰可辨、纯色干净背景；用于锁定面部识别点。
2. `turnaroundPrompt`（正 / 侧 / 背三视图，对齐 `turnaroundArtifactIds`）：同一角色、同一服装、同一光线的角色设定图，从左到右依次给出 `front view` / `three_quarter view` / `side view` / `back view` 四个视角，站姿中性、比例一致；用于锁定体态与服装的四面形制。
3. 两条都必须**自包含**（不看本技能也能照它生图），人物口径与 `prompt`、与剧本 `characters[].appearance` 完全一致，不得互相矛盾。

**场景一条**：

4. `sceneMasterPrompt`（空场母版，对齐 `sceneMasterArtifactId`）：画面内**无一人物 / 路人 / 群演 / 随机顾客 / 不可控动态物**；固定陈设与**固定光源方向**（与 `lighting` 一致，写清光源来源、方向、色温、明暗比）；用于给后续所有该地点的关键帧提供统一的空间与布光基准。

**每条参考图提示词的固定结构（顺序不许变）：**

1. **首句 = 风格锚点前缀**：`{{options.styleAnchor}}`，与全项目其它生图提示词首句**一字不差**；锚点缺失 / 仍是占位符字样时改用中性锚点 `统一视觉方向，自然光，干净画面`，**绝不把 `{{ }}` 或占位符字样写进 prompt**。
2. **主体 / 场景描述**：角色用 `prompt` 的外观口径（脸型、五官、发型、体态、服装、关键道具）；场景用空场陈设 + 固定光源方向。
3. **硬约束尾（英文，逐条固定追加，缺一不可）**：
   - 角色两条：`solo subject, exactly one character, character reference sheet`；场景一条：`empty scene, no people, empty location plate`；
   - `front-facing, sharp clear features`（正面、五官清晰）；
   - `clean plain background, no text, no logo, no watermark`（干净背景，不要文字 / 标志 / 水印）。
4. 不写 Midjourney 尾参、不写画幅与分辨率（尺寸仍由流水线模板 `WIDTH` / `HEIGHT` 决定）。

**分工**：`prompt` 是造型 / 场景的**外观口径**（供关键帧拼场景），`closeupPrompt` / `turnaroundPrompt` / `sceneMasterPrompt` 是**参考图提示词**（供生成参考图），三者不得互相替代；参考图必须干净无字，与关键帧「必须逐字渲染指定文字」相反。

### 八、输出

1. `characters[].id` 与 `name` 沿用剧本；`props` 为字符串数组；`locations[].name` 覆盖剧本全部地点的去重取值；结构化资产字段按「六」输出，参考图提示词字段（`closeupPrompt` / `turnaroundPrompt` / `sceneMasterPrompt`）按「七」输出。
2. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"characters":[{"id":"c1","name":"","outfit":"","makeup":"","hair":"","props":[],"palette":"","prompt":"","closeupPrompt":"","turnaroundPrompt":"","turnaroundArtifactIds":[],"referenceArtifactIds":[],"views":["front","three_quarter","side","back"],"confirmed":false}],"locations":[{"id":"loc1","name":"","setDressing":"","lighting":"","palette":"","prompt":"","sceneMasterPrompt":"","sceneMasterArtifactId":"","views":[],"confirmed":false}]}

## 校验规则

- 顶层必须是对象且含 `characters`、`locations` 两个数组，二者都可以为空数组但键必须存在。
- `characters[].id` 必须来自上游 `script.characters[].id`，一一对应，不允许出现剧本之外的 id。
- `characters[].props` 必须是字符串数组，没有道具时给空数组。
- `locations[].name` 必须覆盖 `script.scenes[].location` 去重后的全部取值。
- `outfit`、`makeup`、`hair`、`setDressing`、`lighting` 非空；`palette` 至少含一个 `#RRGGBB`。
- `characters[]` 必须含 `turnaroundArtifactIds` / `referenceArtifactIds`（数组）、`views`（数组）、`confirmed`（布尔）；`locations[]` 必须含 `sceneMasterArtifactId`（字符串）、`views`（数组）、`confirmed`（布尔）。图未生成时 Artifact 字段允许为空，但键必须存在。
- 角色 `views` 应覆盖 `front` / `three_quarter` / `side` / `back`；缺失视角**不阻断本阶段产出，但必须产生 QC warning**，不得默认「已覆盖」。
- `characters[].closeupPrompt` / `characters[].turnaroundPrompt` / `locations[].sceneMasterPrompt` 必须非空，且各自**首句为项目风格锚点**（`{{options.styleAnchor}}`）或中性兜底锚点，并含参考图硬约束尾（`solo` / `empty scene` / `no text` 一类）；缺风格锚点前缀或缺硬约束尾 → QC warning。
- `confirmed` 初始必须为 `false`；未经用户确认不得置 `true`。
- **确认门禁**：`confirmed !== true` 的角色 / 场景不得直接进入「整集关键帧」生成；下游编排器应据此拦截并提示风险。结构化资产字段缺失或不完整**不阻断本阶段产出，但必须产生 QC warning，不得静默丢失**。
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

## 已知边界（编排器行为，勿踩）

- 编排器（`canvas-server/src/pipeline.js` 的 `readPromptTemplate` → `extractSection`）只把本文的 **`## 提示词模板`** 一节发给模型；其余章节是给人 / Agent 看的，不会进模型上下文。所以**新方法论必须写进「提示词模板」**（用 `###` 子标题，不会被 `^##\s` 截断），写在外面的章节约等于没写。
- 本阶段由 `pipeline.js` 的 `composeWithLlm` **单次调用**（不分块）；`## 内容创作红线（硬约束）` 目前仅 01 剧本阶段的分块路径会抽取注入，本阶段该节主要供人 / Agent 阅读，硬约束同时逐条写进了「提示词模板 → 一、创作底线」。
- 产出契约（`characters[]` / `locations[]` 的字段，含本次新增的 `turnaroundArtifactIds` / `referenceArtifactIds` / `sceneMasterArtifactId` / `views` / `confirmed` 与参考图提示词字段 `closeupPrompt` / `turnaroundPrompt` / `sceneMasterPrompt`）与校验规则由 `pipeline.js` 与 `registry.json`（`produces: "design"`）共同执行。**既有文字字段名与结构不得改动**（下游 `04-keyframes` 读 `design.characters[]` / `design.locations[]`，改动会连挂）；新增的结构化资产字段与参考图提示词字段服务端尚未解析 / 校验，在映射完成前缺失只能产生 QC warning，不得静默丢失；`confirmed` 确认门禁由编排器在进入关键帧阶段前执行。
- 本阶段方法论只影响内容与结构；`prompt` 已按本地 ComfyUI 文生图模板的 `PROMPT` token 形态书写，不引入 Midjourney 尾参（含 `--no`）、Seedance 参数或任何云端平台专属格式；尺寸由模板参数（`WIDTH/HEIGHT`，H3 宽高为 32 的倍数）统一决定，不写进 prompt。

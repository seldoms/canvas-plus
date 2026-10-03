---
name: novel-to-script
description: |
  把小说原文改编成可拍摄的剧本。用于小说转剧本、提取人物表、场次表与戏剧目标，输出严格 JSON（logline/synopsis/characters/scenes）。当用户给出小说原文并需要剧本、人物设定或场次拆分时使用。这是五段式流水线的第一段：剧本。
---

# 剧本：小说 → 剧本

把小说原文当作唯一事实来源：人物关系、时代背景、关键道具都要能在原文里找到依据；原文没写但拍摄必需的，用合理推断补齐，并在 `profile` 里写明是推断。

> 方法论接管自 `skills/libraries/script-writing-studio`（剧本创作工作室的 01 项目开发 / 01b 完整剧本写作 / 02 剧本会诊 / 03 台词精修），已做本地化接线：只吸收内容与结构方法论，剥离云端平台参数与国内平台专属条款，遵守 `AGENTS.md`「内容创作规范」。逐条对照见 `skills/libraries/script-writing-studio-接线说明.md`。

## 内容创作红线（硬约束）

- **忠于原著、忠于用户**：改编不得为道德教化、价值观引导、过审或「更积极健康」而默认改动原著的人物动机、情节走向、结局、尺度或台词；原著怎么写就怎么改。
- **不注入教化式结构**：不强制「反派必须受实质惩罚」，不强制「情感闭环」或「正向落点」；结局形态由原著决定。
- **风险只提示、不改稿**：可以识别政策、平台规则、年龄分级、IP 授权等风险，但只能作为独立提示（项目层 `reviewNotes[]`）交给用户，**绝不写进本阶段 JSON、绝不为规避风险改稿**。
- **质量校验照做**：`appearance` 能否直接生图、`beats` 能否直接拍摄，属工艺要求，照常校验，与内容审查无关。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `novel` | 是 | 小说原文全文，可能很长，是唯一事实来源 |
| `title` | 否 | 项目标题，缺省时由原文自拟 |
| `plan.episodeCount` | 否 | **分集硬约束**：目标集数。绑定项目时取项目 `plan`，否则回落 `options.episodeCount`；缺省按 1 集处理 |
| `plan.episodeDurationSec` | 否 | **分集硬约束**：单集时长（秒）。同上来源；缺省时不强制时长合计 |

本阶段是一段**多步编排**：`analyze`（读原文）→ `outline`（分集规划，以 plan 的集数/时长为硬输入）→ `script`（逐集剧本）。每一步都有独立进度与产物；`stage.output` 由三步合并而成。分集规划真的把 `plan.episodeCount`/`plan.episodeDurationSec` 填进提示词，产出后还会校验集数与时长合计，不一致会记进 `stage.warnings`（不静默放过）。

编排器会把提示词模板里的 `{{novel}}`、`{{title}}` 替换成真实内容后再发给模型；分集规划与逐集剧本另有各自的提示词小节。

## 输出契约

只返回一个 JSON 对象。除下方**可选**字段 `planSuggestion` 外，字段名固定，不要增删、改名，或把现有字段嵌套到别的键里：

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
    { "id": "ep1", "index": 1, "title": "第一集", "durationSec": 30, "synopsis": "本集梗概", "sceneIds": ["sc1", "sc2"] }
  ],
  "planSuggestion": {
    "genre": "题材",
    "tone": "基调",
    "visualStyle": "视觉呈现形式",
    "dramaMode": "叙事取向",
    "audience": "目标受众",
    "episodeCount": 0,
    "episodeDurationSec": 0
  }
}
```

- `characters[].id`、`scenes[].id` 必须唯一且稳定，后续阶段靠它们建立引用。
- `episodes` **必填且非空**：集数必须等于分集硬约束 `plan.episodeCount`（缺省 1 集）；每集 `sceneIds` 必须都能在 `scenes` 里找到，`durationSec` 合计应接近 `plan.episodeCount × plan.episodeDurationSec`。编排器会在 `outline` 步骤后校验并规整（集数不符按目标重排、时长差距写进 `stage.warnings`）。
- `planSuggestion` 可选：本阶段从原文分析出的**创作设定建议**，供后端回填项目 `plan`（字段语义见 `docs/content/docs/progress/domain-contract.md` §3.1 的 `Plan`）。`genre` / `tone` / `visualStyle` / `dramaMode` / `audience` 是字符串，值优先取前端预置项（单一来源 `web/src/constant/drama-presets.ts`），确无合适项才自拟中文短语；`episodeCount` / `episodeDurationSec` 是可选数字，仅在原文体量足以判断时才给。它**不参与下游 02~05 的消费**，缺失或留空都不影响流水线。

## 提示词模板

你是本项目的剧本改编者。把下面这部小说改编成可拍摄的剧本；产物会逐级喂给本地短剧流水线的后续阶段（分镜、服化道、关键帧、片段合成），每个字段都要能被直接消费。

项目标题：{{title}}

小说原文：
<novel>
{{novel}}
</novel>

### 一、创作底线（不可违反）

1. 忠于原著：小说是唯一事实来源，不得为了道德教化、价值观引导、迎合审核或「更积极健康」而改动原著的人物动机、情节走向、结局、尺度或台词。
2. 不注入教化式结构：不强制反派受罚，不强制情感闭环或正向落点；结局形态由原著决定。
3. 不捏造：原文没写但拍摄必需的信息，用合理推断补齐，并写明是推断；不得编造与原文矛盾的人物、地点、事件。
4. 风险只提示、不改稿：识别到的审核、IP、年龄分级风险不得写进任何字段，也不得为规避风险改稿；本阶段只输出下面的 JSON。

### 二、结构与节奏

1. 先判断作品形态与整体节奏（短片 / 微电影 / 长片 / 连续剧集），据此分配场次数量与篇幅比重。
2. 长篇按三幕铺陈：建置约 25%、对抗约 50%、收尾约 25%；短片 / 微电影可压缩建置，尽快进入冲突。
3. 每场戏必须有明确的戏剧目标与推进，不允许原地踏步或空转铺垫。
4. 「慢」必须有功能：任何停顿、留白、空镜都要承担情绪变化、悬念加深、人物关系变化、关键信息释放或下一步动作蓄力的作用；无功能的抒情段落压缩掉。
5. 台词与动作节拍要推进剧情：靠对白倾倒设定的 exposition 尽量改成可见动作或删除；每 1~2 个节拍至少带来一次信息、立场、关系或情绪变化。

### 三、人物

1. `characters` 覆盖所有有台词或推动剧情的角色。
2. `profile`：写身份、性格（表层 / 深层 / 阴影三层）、与其他角色的关系，以及角色弧光（开头 → 结尾）。
3. `appearance`：写成能直接喂给本地生图模型的外观描述（年龄、体态、五官、发型、服装基调），只写可见事实，不写抽象形容词。
4. `voice`：写音色、语速、口音、口头禅等可复现、可直接交给 TTS 的声音特征。
5. 不同角色的用词、句长、说话方式要能区分开，保证辨识度。

### 四、场次

1. `scenes` 按时间顺序排列，`title` 用可识别的场景标题。
2. `location` 统一写成「内景/外景 + 地点」；`time` 只用 日 / 夜 / 黄昏 / 清晨 这类可布光的词。
3. `intent` 写这场戏的戏剧目标。
4. `beats` 写 3~8 条可拍摄的动作 / 台词节拍，只写镜头里能看到、能演出的内容，不写文学抒情和心理描写。
5. 关键道具、转折与台词都要能追溯到原文。

### 五、设定建议（planSuggestion）

完成剧本后，再从原文本身提炼一份设定建议填进 `planSuggestion`，供系统回填项目 plan、用户在生成前按需微调（不改变你对剧本的判断）。

1. 只依据原文：每一项都从原文的人物、场景、语言与情绪里得出，不要套用「短剧就该怎样」的通用模板（例如原文是都市情感，就不要因为要改成短剧而建议古风）。`genre`（题材）与 `visualStyle`（视觉形式）是两个独立维度，不要因为题材是「都市」就默认推「写实真人」。
2. 优先从预置项里选（与前端下拉一致），确无合适项才自拟中文短语。代表项（非全集）：
   - `genre`：现实向（都市 / 家庭 / 职场 / 校园 / 年代 / 悬疑 / 犯罪…）；幻想向（玄幻 / 奇幻 / 科幻 / 末世 / 穿越…）；古风向（古装 / 武侠 / 仙侠 / 宫斗 / 历史…）；动画与偶戏（动画 / 儿童 / 童话 / 俳偶戏…）。
   - `tone`：热血 / 燃 / 励志 / 甜宠 / 治愈 / 温情 / 搞笑 / 爽感 / 虐心 / 暗黑 / 悬疑 / 冷峻 / 史诗…。
   - `visualStyle`：写实真人 / 二维动画 / 三维动画 / 定格动画 / 俳偶戏 / 像素风 / 水墨风 / 漫画分镜…。
   - `dramaMode`：短剧向 / 微电影向 / 单元剧 / 连续剧。
   - `audience`：男性向 / 女性向 / 全年龄 / 青少年 / 中老年 / 儿童 / 合家欢 / 二次元向。
3. `episodeCount`（目标集数）与 `episodeDurationSec`（单集时长，秒）是可选数字：只有原文体量、结构或用户已给出的分集信息足以判断时才填，判断不了就省略这两个键，不要脑补。
4. 某一项原文信息不足，宁可留空也不要硬填。
5. 设定建议只做「题材 / 基调 / 呈现形式 / 取向 / 受众」这类设定层面的分析，**不得反过来改动原著的人物、情节、结局或台词**——上面「一、创作底线」的红线对设定建议同样有效。

### 六、输出

1. 先提炼 `logline`（一句话故事线）与 `synopsis`（不超过 300 字的故事梗概），再拆人物与场次。
2. `characters[].id`、`scenes[].id` 唯一且稳定，只允许 `[A-Za-z0-9_-]`。
3. 本步**只做原文分析**：不要输出 `episodes`（分集由下一步「分集规划」完成）；`scenes` 要把整篇故事的场次按时间顺序铺全，供分集规划引用。
4. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"logline":"","synopsis":"","characters":[{"id":"c1","name":"","profile":"","appearance":"","voice":""}],"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}],"planSuggestion":{"genre":"","tone":"","visualStyle":"","dramaMode":"","audience":""}}

## 分集规划提示词

你是本项目的分集规划师。下面是原著的原文分析结果，请把它规划成 {{episodeCount}} 集，每集约 {{episodeDurationSec}} 秒（集数与单集时长是硬约束，不得擅自增删）。

项目标题：{{title}}

一句话故事线：{{logline}}

故事梗概：{{synopsis}}

人物：

{{characters}}

场次：

{{scenes}}

### 一、规划底线

1. 忠于原著与上面的场次清单：只做「把已有场次分给哪几集」的编排，不新增 / 删除 / 改写场次与剧情。
2. 每集要有独立的戏剧推进与钩子（开场抓人、结尾留扣），不允许把整段剧情堆进一集、其余集空转。
3. `sceneIds` 只能引用上面给出的场次 id，不得出现清单外的 id，也不得漏掉场次。
4. 各集 `durationSec` 之和应接近 {{episodeCount}}×{{episodeDurationSec}} 秒；单集默认取 {{episodeDurationSec}}，需要浮动时写实际值。

### 二、输出

1. 只输出下面结构的 JSON 本体，集数必须等于 {{episodeCount}}，不要 Markdown 代码块、不要解释文字：

{"episodes":[{"id":"ep1","index":1,"title":"","durationSec":0,"synopsis":"","sceneIds":["sc1"]}]}

## 逐集剧本提示词

你是本项目的剧本编剧。现在写第 {{episode.index}} 集（全片共 {{episodeCount}} 集），把本集场次写成效可直接拍摄的镜头级节拍。

项目标题：{{title}}

本集信息：{{episode}}

人物：

{{characters}}

本集场次：

{{episodeScenes}}

### 一、写作底线

1. 忠于原著与本集场次：不新增 / 删除场次、不改人物动机、情节走向与结局；本集只管本集场次。
2. `beats` 写成镜头里能看到、能演出的动作 / 台词节拍，每条都要可拍摄，不写文学抒情与心理描写。
3. 保留每个场次的 `id` 与基本信息（`title` / `location` / `time`），只补足 / 细化 `intent` 与 `beats`。

### 二、输出

1. 只输出下面结构的 JSON 本体，场次 `id` 必须沿用给定值，`beats` 写 3~8 条，不要 Markdown 代码块、不要解释文字：

{"scenes":[{"id":"sc1","title":"","location":"","time":"","intent":"","beats":[""]}]}

## 校验规则

编排器与本阶段共同遵守，任一不满足即视为产物不可用：

- 顶层必须是对象，且 `logline`、`synopsis`、`characters`、`scenes` 四个键必须存在。
- `characters[].id` 与 `scenes[].id` 全局唯一，只允许 `[A-Za-z0-9_-]`。
- `scenes` 至少 1 条；每条 `beats` 至少 1 条非空字符串；`intent` 不能为空。
- `characters[].appearance`、`characters[].voice` 不能为空：前者供关键帧阶段写提示词，后者供 TTS 使用。
- 允许省略 `episodes`（`analyze` 步本就不产出它）；但**合并后的 `stage.output.episodes` 必须非空**，集数等于分集硬约束 `plan.episodeCount`，`sceneIds` 必须都能在 `scenes` 里找到。
- 分步校验：`analyze` 校验 `logline`/`synopsis`/`characters`/`scenes`；`outline` 校验集数、`sceneIds` 引用与时长合计（不一致记 `stage.warnings` 并按目标重排，不静默放过）；`script` 校验场次 `id` 沿用给定值。
- `planSuggestion` 可选、不参与上述硬校验：不产出或留空都不算失败。
- 只输出 JSON 本体。任一步解析失败会自动重试一次（只返回 JSON），再失败该步标记 `error` 并保留模型原文；**已完成的前步产物保留不丢**，可用 `resume` 复用前步重试。

## 工具

本阶段允许调用的 canvas-server 接口：

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/script/run` | 由编排器执行本阶段（内部调用 LLM） |
| `POST /api/pipeline/runs/:id/steps/script/input` | 人工修订剧本产物，body `{ "output": { ...script } }` |
| `ANY /v1/*` | 透传内网 OpenAI 兼容 LLM，用于人工追问或重写 |
| `POST /api/generate/image` | 可选：给人设出一张概念图，模板 `img_*`，参数 `PROMPT` |

产物落盘：`data/runs/<runId>/script.json`；运行状态在 `data/runs/<runId>/run.json`。

## 已知边界（编排器行为，勿踩）

- 编排器（`canvas-server/src/pipeline.js` 的 `readPromptTemplate` → `extractSection`）从本文抽取三段提示词：**`## 提示词模板`**（原文分析 `analyze`）、**`## 分集规划提示词`**（`outline`）、**`## 逐集剧本提示词`**（`script`）。三节都用 `###` 子标题，不会被 `^##\s` 截断；改方法论就写进对应小节，写在外面的章节约等于没写。**这两个新小节名与 `## 提示词模板` 一样是编排器的抽取契约，不得改名**。
- 本阶段的进度是多步结构：`progress.steps = [{ id, title, status, detail }]`，id 固定为 `analyze` / `outline` / `script`，状态用 `pending|running|done|error`；旧的 `stage`/`phase`/`done`/`total`/`label` 字段保留（向后兼容）。
- 每步产物落在 `stage.steps.<stepId>.output`（随 run 落盘、重载可重建）；整个阶段的合并产物仍在 `stage.output`（`logline`/`synopsis`/`characters`/`scenes`/`episodes`），下游 02/03 照旧消费。
- 长篇小说（填充后的提示词超过 `pipeline.maxNovelChunkChars`，默认 16000 字）的 `analyze` 步走 `pipeline.js` 内**硬编码的 map-reduce 提示词**，仍绕开「## 提示词模板」；`outline` / `script` 不受影响。分集规划与逐集剧本另会注入「## 内容创作红线（硬约束）」正文，与分块路径同源。
- `planSuggestion` 由 `analyze` 步产出（长篇 map-reduce 绕道时不产出），供后端回填项目 `plan`、前端展示与微调；它不在 02~05 的消费链里，**即使没有任何下游消费也不影响流水线**。
- 本阶段的方法论只影响内容与结构；`appearance` / `voice` 已按本地生图与 TTS 的可用形态要求书写，不引入 Midjourney 尾参、Seedance 参数或任何云端平台专属格式。

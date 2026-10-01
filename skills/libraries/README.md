# 导入的 skill 库

本目录存放**第三方导入**的 skill 资产，与 `skills/` 下我们自有的五段式阶段技能分开管理。
导入内容一律**逐字保留**，不做改写；需要适配时由我们自己的阶段技能（`skills/01-*` ~ `skills/05-*`）引用它们，而不是改动它们。

## 清单与来源

| 库 | 来源 | 规模 | 说明 |
| --- | --- | --- | --- |
| `script-writing-studio/` | `~/Desktop/2026.8新 国内一线影视内部skill/script-writing-studio/` | `SKILL.md` 262 行 + 35 个 reference，共 12,533 行；另含 `agents/openai.yaml` | 端到端中文剧本创作工作室（总控型 skill，按需读取 reference） |
| `Luster-iwai-aesthetic-prompt/` | `~/Desktop/Luster-岩井俊二美学风格skill-b282ccc2fcfe.zip` | `SKILL.md` + 3 个 reference，共 160 行 | 岩井俊二美学提示词生成（作者 抖音Luster，MIT） |
| `docs/V2.0中文使用手册2.pdf` | 同 `script-writing-studio` 所在目录 | 736 KB | 该工作室的官方中文使用手册 |

两处来源均已用 `diff -r` 与源目录逐字节比对通过，PDF 的 sha1 与源一致。

## `script-writing-studio` 是什么

一个**总控型** skill：自身只负责路由、读取策略和全局红线，具体能力分散在 `references/` 里，由使用者按当前阶段只读必要模块。它的模块划分：

| 模块 | reference | 产出 |
| --- | --- | --- |
| 01 项目开发 | `01-script-creation.md` | Logline、大纲、项目档案、平台节奏档案 |
| 01b 完整剧本写作 | `01b-script-drafting.md` | 剧本初稿/改稿、节奏执行记录 |
| 02 剧本会诊 | `02-script-doctor.md` | 问题清单、优先级、节奏体检 |
| 03 台词精修 | `03-dialogue-expert.md` | 台词诊断、逐句精修、角色语言指纹 |
| 04 AI 视频分镜 | `04-ai-video-storyboard.md` | 大分镜、镜头字段、跨段衔接 |
| 04b 运镜/动作戏 | `04b-camera-action-cheatsheet.md` 及 4 个类型子库 | 摄影机行为、动作链条、类型化动作规则 |
| 05 资产库 | `05-asset-library.md` | 资产总表、`@图N` 映射（角色/场景/道具/服装/妆发/风格） |
| 06 视频提示词适配 | `06-seedance2-adapter.md` | 4~15 秒提示词包、参数、Must Keep、Avoid |
| 07 后期音乐与声音 | `07-post-music-sound-design.md` | BGM 曲线、Cue Sheet、搜索词、音效方案 |

## 与我们五段式流水线的对应

| 我们的阶段 | 主要引用 | 说明 |
| --- | --- | --- |
| `script` 小说→剧本 | `01-script-creation.md` → `01b-script-drafting.md`（可选 `02`/`03` 做会诊与台词精修） | 阶段产出契约仍是我们的 `{logline, synopsis, characters[], scenes[]}`，由阶段技能负责把工作室的大纲/项目档案映射进来 |
| `storyboard` 分镜拆解 | `04-ai-video-storyboard.md`（动作戏追加 `04b-*`） | 工作室的分镜硬规则、衔接与强连续规则直接可用 |
| `design` 服化道 | `05-asset-library.md`、`05-style-character.md`、`05-scene-continuity.md` | 「资产库」正是服化道：角色服装/妆发/道具/场景陈设，并提供稳定编号与风格锁 |
| `keyframe` 关键帧 | `Luster-iwai-aesthetic-prompt/`（风格层） | 用它的冻结签名系统为关键帧提示词定视觉风格 |
| `assembly` 片段合成 | `06-seedance2-adapter.md`（提示词结构）+ `07-post-music-sound-design.md`（声音） | 段落时长、Must Keep/Avoid、跨段衔接、后期声音设计可直接借鉴 |

## 必须知道的一处适配差异

**这两个库面向的是云端生成器，不是我们的本地 ComfyUI。**

- `script-writing-studio` 的 06 模块产出的是 **Seedance 2.0 / 豆包 / 火山方舟** 的提示词包。
- `Luster-iwai-aesthetic-prompt` 只产出 **Midjourney** 提示词（其 SKILL.md 明确写了「仅产出 MJ 单模型提示词」，并要求逐字保留 `--ar --style raw --s 100 --no` 等 MJ 尾参）。

而我们的流水线走的是本地 ComfyUI 模板（`canvas-server/workflows/`：Z-Image / FLUX / Krea2 生图，MiniMax H3 / Wan2.2 生视频）。

因此正确的用法是**分层**，不是替换：

1. 用工作室的 01/01b/04/05 产出**结构性内容**——故事、场次、分镜字段、资产库与风格锁。这些是模型无关的，直接可用。
2. 用 Luster 的**风格层**（冻结句 + 色彩公式 + 光学事件库）决定关键帧的视觉基调。
3. 由我们的阶段技能把上面两者**翻译成 ComfyUI 模板 token**（`PROMPT / WIDTH / HEIGHT / SEED` 等），并去掉 MJ 专用尾参（`--ar`、`--style raw`、`--s`、`--no`）与 Seedance 专用参数。

`Luster-iwai-aesthetic-prompt` 的禁用规则（真人不可加动态模糊、冻结句一字不改）属于该风格自身的约束，接入时若与我们的模板参数冲突，以「风格库管画面描述、我们的模板管尺寸与采样参数」为分工。

## 维护约定

- **不要修改**本目录下的第三方文件。需要本地化改写时，改写 `skills/01-*` ~ `skills/05-*` 里我们自己的阶段技能。
- 升级导入库时整目录替换，并重新跑一次逐字节比对。
- 新增导入库时在本文件补一行来源与用途。

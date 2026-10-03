# 模型注册表（Model Registry）契约 · v1 冻结

> **状态**：契约已冻结，待实现。
> **日期**：2026-10-03
> **来源**：产品负责人当面指令 —— 「这个接口做的太糙了，**应该在后台配置**，然后**允许起别名**，**是否启用**，**文字模型、生图模型、生视频模型，应该都区分开**」

## 0. 要解决的真问题（为什么做这个）

**现状**：工作台能选哪些模型 = **浏览器本地** `config.channels[].models` 快照。
服务端后来新增模板 / 改了登记，**浏览器那份不会自己更新**，UI 也不提示差异。
→ 已经连续踩两次：**「生图工作台看不到 minimax h3」「看不到 qwen2.1」都是这个病根**。

**改造后**：模型清单由**服务端唯一持有**，前端只读。浏览器渠道退化为「连接与凭据」，
不再承担「有哪些模型」的职责。**服务端加了模型，前端刷新就看得见。**

## 1. 存储

- 文件：`canvas-server/data/model-registry.json`（**服务端唯一写者**）
- 结构：`{ "version": 1, "models": [ <ModelEntry>... ], "updatedAt": "<ISO>" }`

## 2. ModelEntry（条目字段，冻结）

```jsonc
{
  "id": "mdl_01J...",              // 服务端生成（ULID，前缀 mdl_），稳定不可变
  "name": "img_qwen21_t2i",        // ★ 真实标识（模板名 / 渠道模型名）—— 请求侧只用它，永不改
  "base": "千问2.1",               // ★ 基座/模型名（**分组键**：同一 base 的条目在 UI 上归到一组，组头只显示一次）
  "task": "文生图",                // ★ 能力名（该基座下的具体用途，显示在组头下面）
  "alias": "千问2.1 文生图",        // ★ 展示名（= base + " " + task 的组合视图；改名不影响请求）
  "category": "image",             // ★ text | image | video | audio   ← 「三类区分开」的落点
  "enabled": true,                 // ★ 是否启用（false = 不在工作台出现，但保留登记与别名）
  "runtime": "local",              // ★ local | cloud —— 云端项在 UI 上加 ☁️ 图标区分
  "provider": "comfy",             // comfy | llm | ...（来源大类）
  "source": "template",            // template | channel | manual
  "template": "img_qwen21_t2i",    // 若来自模板（provider=comfy）时的模板名
  "channelId": null,               // 若来自渠道时的渠道 id
  "channelName": "本地网关",        // 渠道展示名（便于配置页显示）
  "script": "<内联脚本>",           // 请求脚本（服务端生成），前端不再自己拼
  "meta": {                        // 附加元数据（只读，服务端填）
    "family": "image",
    "durations": [5, 10, 15],      // 视频类才有
    "durationMeta": { "...": "同 /api/providers 的口径" },
    "supportsReference": false,
    "referenceLimit": 9,
    "title": "Qwen-Image 2.1 文生图"
  },
  "stale": false,                  // 服务端已发现该模型消失时置 true（不自动删登记）
  "createdAt": "<ISO>",
  "updatedAt": "<ISO>"
}
```

### 分类映射（**唯一事实源在服务端**，前端不得自行判断）
| 来源 | category |
|---|---|
| LLM 渠道模型（deepseek / gpt / kimi…）| `text` |
| 模板 `family = video` | `video` |
| 模板 `family = image \| edit \| upscale` | `image` |
| 模板 `family = audio`（含 `audio_*`）| `audio` |

> 说明：产品负责人点了三类（文字/生图/生视频）。本表把**音频**单列成第四类，
> 而不是硬塞进「生图」—— 否则音频模型会出现在生图下拉里，属于错配。UI 按四组分开呈现。

## 2.1 别名规范（**硬规则** · 2026-10-03 产品负责人当面定）

> 原话：「**i2v 这样的不够直接，你直接写中文**，云端 api 加个 **☁️** 图标就行，**模型的昵称就这么干**」

1. **别名一律写中文，禁止缩写与黑话。** `i2v` / `t2i` / `t2v` / `ref2v` / `fl2v` 这类**不得出现在别名里**；
   要写「图生视频」「文生图」「首尾帧生视频」「参考图生视频」这种**一眼能懂的词**。
   （原始标识 `name` 里带缩写没关系 —— 它只在「真实名」等宽小字里露出，不作为展示名。）
2. **厂商名可保留通用写法**（H3 / Flux / Krea2 / ZImage / Boogu / Wan / 千问 / DeepSeek…），
   其余部分必须中文。
3. **云端 vs 本地靠 `runtime` 字段区分，UI 上云端的加 ☁️** —— **不要把「云端」写进别名文字里**
   （图标已经表达了，名字里再写一遍是冗余）。
4. 同一类下取**最短能区分**的写法（如「千问2.1 文生图」而不是「Qwen-Image 2.1 文生图模型」）。

## 2.2 默认别名表（`sync` 首次登记时用它填 `alias`，避免同步下来是一堆原始名）

> `sync` 时：命中本表 → 用表里的中文别名；未命中 → `alias` 留空，UI 回落 `meta.title` → `name`。
> 用户改过别名的条目，**同步不覆盖**（见 §3 行为约定）。

| name | category | runtime | 默认别名 |
|---|---|---|---|
| `img_qwen21_t2i` | image | local | 千问2.1 文生图 |
| `img_qwen21_edit` | image | local | 千问2.1 改图 |
| `img_flux_artistic` | image | local | Flux 艺术生图 |
| `img_krea2_artistic` | image | local | Krea2 艺术生图 |
| `img_zimage_artistic` | image | local | ZImage 艺术生图 |
| `img_boogu_outfit_edit` | image | local | Boogu 换装 |
| `scail2_action_transfer` | image | local | Scail2 动作迁移 |
| `upscale_4x` | image | local | 4 倍放大 |
| `video_h3_i2v` | video | local | H3 图生视频 |
| `video_h3_i2v_fl` | video | local | H3 首尾帧生视频 |
| `video_h3_talk` | video | local | H3 台词对口型 |
| `video_h3_ref2v_image` | video | local | H3 参考图生视频 |
| `video_h3_ref2v_image_turbo` | video | local | H3 参考图生视频 快速版 |
| `video_h3_quantfunc_ref2v` | video | local | H3 参考图生视频 省显存版 |
| `video_h3_ref2v` | video | local | H3 参考视频生视频 |
| `video_minimax_h3_t2v` | video | local | H3 文生视频 |
| `video_wan_animate` | video | local | Wan 动作驱动 |
| `audio_qwen3_tts` | audio | local | 千问3 语音合成 |
| （LLM 渠道模型，如 `deepseek`）| text | **cloud** | 按渠道配置的展示名 |

> ⚠️ 这张表是**默认值**、不是白名单：服务端出现表里没有的新模板时，`sync` 照常登记（只是别名留空）。
> 但**新模板的 `meta.title` / 中文标题必须在模板登记处补齐**（`providers/comfy.js` 的 `TITLES`），
> 否则别名回落时会露出 `video_h3_i2v_fl` 这种原始名 —— 这正是本次要消灭的情况。

## 2.3 runtime（local / cloud）判定

| 来源 | runtime |
|---|---|
| 本地 ComfyUI 模板（`workflows/*.json`）| `local` |
| 本地 LLM（ollama 等）| `local` |
| LLM 云端渠道（deepseek / gpt / kimi…）| `cloud` |
| 云端 ComfyUI（RunningHub 等）| `cloud` |

**UI 规则**：`runtime === "cloud"` 的条目在别名前加 **☁️**（`☁️ DeepSeek 对话`）；
`local` 不加图标。**别名文字里不得再出现「云端 / 云 API」字样。**

## 2.4 模型分组：`base` + `task`（**硬规则** · 2026-10-03 产品负责人当面定）

> 原话：「因为一个模型可以做不同的场景或满足不同的需求，所以比如**千问占一行**，下面框出来的是
> **文生图、改图**。**就不要反复显示千问了 —— 一个模型的名称只显示一次，它的能力就在它下面展示出来**。
> 用这种方式我认为更加科学一点，不至于有视觉污染」

**两个字段的职责（正交，不可混用）**：
| 字段 | 含义 | 用途 |
|---|---|---|
| `base` | **基座 / 模型名**（如 `千问2.1`、`H3`、`Flux`、`Wan`、`DeepSeek`）| **分组键** —— 同一 base 的条目归为一组 |
| `task` | **能力 / 用途名**（如 `文生图`、`改图`、`首尾帧生视频`）| 组内那一行的标题 |
- `alias` 保留为「`base` + 空格 + `task`」的组合视图（**仅用于无法分组的场合**，如单行展示、日志）。
- **`base` 与 `task` 都必须是中文、禁缩写**（沿用 §2.1）。
- **同级变体**（同一能力的快慢/显存档）**不另开一组**，用 `task` 内的分隔符表达：
  `参考图生视频 · 快速版`、`参考图生视频 · 省显存版`。

**UI 规则（配置页「模型管理」与工作台下拉都要遵守）**：
1. **按 `base` 分组渲染；`base` 名在该组内只出现一次**（组头），**绝不在组内每一行重复 base**。
2. 组内每行只显示 **`task`**（+ 启用开关；原始 `name` 作为次要等宽小字可选露出，供排查用）。
3. 组头处可改 `base` 名（调 `PATCH {base}`）；组内行可改 `task`（调 `PATCH {task}`）。
4. 组按 `category` 分栏（文字/生图/生视频/音频）后再按 `base` 分组。
5. 组内排序：按默认表顺序；表外条目排最后、按 `name` 字典序。
6. **单条目的组不特殊处理**（照样是组头 + 一行），保持列表纵向一致，避免"有的有组头有的没有"的参差感。

## 2.5 默认 base / task 表（`sync` 首次登记时用它填 `base`/`task`，同时据此生成 `alias`）

| name | category | base | task | alias（= base + 空格 + task）|
|---|---|---|---|---|
| `img_qwen21_t2i` | image | 千问2.1 | 文生图 | 千问2.1 文生图 |
| `img_qwen21_edit` | image | 千问2.1 | 改图 | 千问2.1 改图 |
| `img_flux_artistic` | image | Flux | 艺术生图 | Flux 艺术生图 |
| `img_krea2_artistic` | image | Krea2 | 艺术生图 | Krea2 艺术生图 |
| `img_zimage_artistic` | image | ZImage | 艺术生图 | ZImage 艺术生图 |
| `img_boogu_outfit_edit` | image | Boogu | 换装 | Boogu 换装 |
| `scail2_action_transfer` | image | Scail2 | 动作迁移 | Scail2 动作迁移 |
| `upscale_4x` | image | 放大 | 4 倍 | 放大 4 倍 |
| `video_h3_i2v` | video | H3 | 图生视频 | H3 图生视频 |
| `video_h3_i2v_fl` | video | H3 | 首尾帧生视频 | H3 首尾帧生视频 |
| `video_h3_talk` | video | H3 | 台词对口型 | H3 台词对口型 |
| `video_h3_ref2v_image` | video | H3 | 参考图生视频 | H3 参考图生视频 |
| `video_h3_ref2v_image_turbo` | video | H3 | 参考图生视频 · 快速版 | H3 参考图生视频 · 快速版 |
| `video_h3_quantfunc_ref2v` | video | H3 | 参考图生视频 · 省显存版 | H3 参考图生视频 · 省显存版 |
| `video_h3_ref2v` | video | H3 | 参考视频生视频 | H3 参考视频生视频 |
| `video_minimax_h3_t2v` | video | H3 | 文生视频 | H3 文生视频 |
| `video_wan_animate` | video | Wan | 动作驱动 | Wan 动作驱动 |
| `audio_qwen3_tts` | audio | 千问3 | 语音合成 | 千问3 语音合成 |
| （LLM 渠道模型，如 `deepseek`）| text | DeepSeek | 对话 | ☁️ DeepSeek 对话 |

> 分组效果（**这就是改造后「模型管理」该长成什么样**）：
> ```
> 生图
>   千问2.1       文生图 ✓ | 改图 ✓
>   Flux          艺术生图 ✓
>   Krea2         艺术生图 ✓
>   ZImage        艺术生图 ✓
>   Boogu         换装 ✓
>   Scail2        动作迁移 ✓
>   放大          4 倍 ✓
> 生视频
>   H3            图生视频 ✓ | 首尾帧生视频 ✓ | 台词对口型 ✓ | 参考图生视频 ✓
>                 参考图生视频 · 快速版 ✓ | 参考图生视频 · 省显存版 ✓ | 参考视频生视频 ✓ | 文生视频 ✓
>   Wan           动作驱动 ✓
> 音频
>   千问3         语音合成 ✓
> 文字
>   ☁️ DeepSeek   对话 ✓
> ```
> ⚠️ **`base` 只在组头出现一次** —— 组内每行不得再重复 `千问2.1` / `H3` 等字样（这就是产品负责人
> 说的「不至于有视觉污染」）。同理，**工作台下拉也要按 `base` 分组**（分组标题 + 只列 `task`）。

## 3. 端点契约（冻结）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/model-registry` | 列出全部登记。返回 `{ models: [...], counts: { text, image, video, audio, total, enabled } }`。支持查询参数 `?category=image`、`?enabled=true` |
| `POST` | `/api/model-registry` | 新增登记。body：`{ name, category, alias?, enabled?, provider?, source?, template?, channelId? }`；`name`+`category` 必填；**name 唯一，重复返回 409** |
| `PATCH` | `/api/model-registry/:id` | 局部更新：`alias` / `enabled` / `category`（**`name` 不可改**，要改只能删了重建）|
| `DELETE` | `/api/model-registry/:id` | 删除**登记**（不动模板/渠道本身）|
| `POST` | `/api/model-registry/sync` | **从「服务端实际可用的模板 + 渠道」同步**：缺失的补登记（`enabled` 默认 `true`）；已消失的置 `stale: true`（**不删、不覆盖用户改过的 alias/enabled**）。返回 `{ added: [...], staled: [...], kept: n }` |
| `GET` | `/api/model-registry/available` | 服务端发现的**可用模型**清单（未登记项也含），供配置页显示「可补」差异：`{ available: [...], registered: n, missing: [...] }` |

### 行为约定
- **幂等**：`sync` 重复调用不改变结果；用户改过的 `alias`/`enabled` 必须保留。
- **不覆盖用户意图**：`sync` 只做「补缺 + 标记 stale」，绝不把用户设的 `enabled:false` 改回 true。
- **写入**：所有写操作走 `data/model-registry.json`，**原子写**（临时文件 + rename），失败不留半截文件。
- **容错**：文件缺失/损坏 → 视为空表并记 warning，不要 500。

## 4. 前端行为约定

1. **「配置」页新增「模型管理」区**：按 `文字 / 生图 / 生视频 / 音频` **四组分栏**呈现；每条一行显示：
   **别名（可编辑，就地改）**、真实名（次要、等宽小字）、来源渠道、**启用开关**。
2. 页头显示**差异提示**：`服务端发现 N 个可用模型，当前登记 M 个`，附 **「同步补齐」** 按钮（调 `POST /sync`）。← 这一步就是为了**让"清单过期"这件事在界面上可见**，不再靠人记。
3. **工作台（生图/生视频/文字）的模型下拉改读注册表**：
   `GET /api/model-registry?enabled=true&category=<对应类别>`；
   - 生图工作台 → `category=image`
   - 视频创作台 → `category=video`
   - 文本类选择（LLM）→ `category=text`
   - **只出现 `enabled: true` 的项**；展示名回落 `alias → meta.title → name`；
     `runtime === "cloud"` 的条目**别名前加 ☁️**
   - 请求侧仍用 `name`（**别名只影响显示**）
4. **浏览器渠道不再作为模型清单来源**（渠道只保留连接/凭据职责）；`use-asset-store.ts` 与其它既有本地存储不动。
5. **UI 铁律**：禁止解释性小字；筛选项/分组名从接口 `category` 来，**不硬编码**。

## 5. 验收标准（实现完成后按此验）

**后端**
- `node --test test/*.test.mjs` 全绿，基线之上的新增测试覆盖：CRUD、name 唯一 409、`sync` 补缺、`sync` 不覆盖用户 alias/enabled、`stale` 标记、原子写与损坏文件容错、`available` 差异计算、分类映射四类。
- `curl` 实打：`sync` 一次后 `GET /api/model-registry` 应能列出**服务端全部模板**（当前 17 个模板 + LLM 渠道模型），且分类正确（H3 系 → video、qwen21/flux/krea2/zimage → image、qwen3-tts → audio、deepseek → text）。

**前端**
- `npx tsc --noEmit` 0 错 + `npm run build` 通过。
- **真实点击验收**（主代理用 CDP 走）：配置页能改别名、能开关启用；生图工作台下拉**只出现启用的生图模型**且显示别名。

## 6. 非目标（本期不做）

- 不改渠道与密钥的存储位置（LLM key 仍在服务端 `data/llm-providers.json`；浏览器渠道表保持现状）。
- 不做模型的路由/负载均衡/计费。
- 不自动删除任何登记项。

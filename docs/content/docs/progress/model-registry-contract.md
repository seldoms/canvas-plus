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
  "alias": "千问2.1 文生图",        // ★ 展示名（可空；空则回落 label → name）。改名不影响请求
  "category": "image",             // ★ text | image | video | audio   ← 「三类区分开」的落点
  "enabled": true,                 // ★ 是否启用（false = 不在工作台出现，但保留登记与别名）
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
   - **只出现 `enabled: true` 的项**；展示用 `alias || meta.title || name`
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

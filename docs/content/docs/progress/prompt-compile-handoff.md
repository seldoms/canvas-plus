# 提示词策略层 · 现状交接单（2026-10-03）

> 用途：交接给正在整改的 GPT / 后续接手的人。**只描述现状与证据，不含建议**。
> 生成方式：主代理本人一手实测（CDP 真实点击 / 接口调用 / 文件读取），非子代理自报。

> **2026-10-04 收口说明（本轮维护的最后一次更新，之后本单不再维护）**
> ① GPT 复核提出的 4 条（服务阻塞 / 改写器自造事实 / 视频证据 / 探测缓存）已按产品负责人拍板处理完毕：
>    模型清单**只读注册表、网关不再探测上游**（`model-registry-contract.md` §3.1），探测链与探测缓存整条删除；
>    画幅改为**只检测不改稿**（`aspectRatioConflict` 命中即整稿弃用 + warning）；
>    H3 i2v 真实 UI 入队证据已取到（`h3-i2v-ui-evidence.md`）。
> ② 下方 §5 附录里那份「horizontal …」PROMPT **就是 #65 的故障标本**：竖屏项目的改写稿把画幅写成了横屏，
>    现在这种稿会被整稿弃用，不会再发给模型。
> ③ 测试基线已从 667/667 变为 **673/673**；`/api/health` 不再等 LLM 探测（实测 27ms）。
> ④ 本轮曾发生一次自伤事故（warning 自我放大 → 启动崩溃 + 单个 run.json 涨到 529MB），代码与数据均已修复，
>    见 `pilot-issues.md` #67 与 `canvas-server/scripts/repair-bloated-warnings.mjs`。

## 1. 已提交（基线，勿推翻）

| 提交 | 内容 |
|---|---|
| `1a47860` | win147 ComfyUI 全模型能力与提示词规范调研入库（**权威来源**） |
| `aad31ac` | H3 首尾帧模板 `video_h3_i2v_fl`（FL2VA 需要） |
| `9d1ab27` | 规则层：`config/model-prompt-rules.json`（13 模型，与调研**逐字段 deep-equal 一致**）+ `src/model-rules.js` |
| `d7ca58a` | 5 个官方改写器原文 `prompts/rewriters/*` + `src/prompt-rewriter.js`（Boogu 第 14 条已剔除 + 反向断言通过） |
| `66eb543` | `src/prompt-compiler.js` 重写为规则表驱动的策略层 |
| `ca20f1c` | 修 `style` 传字符串的静默垃圾 + H3 台词块剥表演注解 |
| `9937b81` | 硬约束：「提示词转写层用户无感」 |
| `349db32` | #55 反代 Basic Auth 与网关 Bearer 争抢 Authorization 头 |
| `70a0f16` | #56 生图工作台缺「正在生成中」返回入口 |
| 本次 | #57–#61（见 `pilot-issues.md`） |

## 2. 工作区中的本轮改动（尚未提交，主代理已完成代码验收）

```
M canvas-server/README.md
M canvas-server/src/index.js          （注册 POST /api/prompt/compile）
M canvas-server/src/pipeline.js       （关键帧/片段改用 async 版 + 注入 llmCall）
M web/src/i18n/locales/en-US.ts
M web/src/i18n/locales/zh-CN.ts
M web/src/pages/image/index.tsx
?? canvas-server/src/llm-client.js    （DeepSeek 客户端）
?? canvas-server/src/prompt-api.js
?? canvas-server/test/llm-client.test.mjs
?? canvas-server/test/prompt-api.test.mjs
?? canvas-server/test/prompt-compile-pipeline.test.mjs
?? web/src/services/api/prompt-compile.ts
```

- 独立复核：`node --test test/*.test.mjs` → **667 tests / 667 pass / 0 fail**（初次因新降级口径与重跑时序断言过时）；修正测试后定向提示词/流水线/参考锁 **19/19 pass**，完整套件已复跑通过。
- 前端：`tsc --noEmit` 0 错、`npm run build` 通过
- 以上文件之外，本轮还修改了流水线测试、提示词规则/契约与进度文档；当前仍未提交，等待统一提交。

## 3. 前端越界已撤销

硬约束见 `AGENTS.md`「内容创作规范」：**转写层用户无感 —— 前端不得暴露**。
`web/src/pages/image/index.tsx` 中的预览入口、预览弹窗与「未强化」标签已删除；对应 i18n 文案也已删除。重新构建后 `web/dist` grep 结果为 `FORBIDDEN_UI_TEXT_ABSENT`。生成的静默编译、失败降级与后端 warning 均保留。

## 4. 主代理已实测**通过**的部分（一手）

| 项 | 证据 |
|---|---|
| DeepSeek 渠道可用 | `GET /models` → 只有 `deepseek-flash` / `deepseek-v4-pro`；最小改写探针 **0.9s / finish_reason=stop / 181 字** |
| `POST /api/prompt/compile` 可用 | 重启后 **HTTP 200** |
| **语言适配真的生效** | 带 `rewrite:true`：**11.2s**，`language=en`、`rewriterId=qwen-image-2.1-pe`、`untranslated=false`、`llm={model:deepseek-flash, finishReason:stop, chars:3045}` → 产出 **3045 字英文长 prompt** |
| 前端确实传 `rewrite:true` | `web/src/pages/image/index.tsx:337` |
| **降级不阻塞已验证** | 编译接口 404 时，3 个生图任务照常入队（用户未被挡住） |

## 5. 真实 UI 与生产服务复核

- 受控重载前确认 `GET 192.168.123.147:8188/queue` 为 `running=[] / pending=[]`；随后 `systemctl restart canvas-server`，`/api/health` 返回 `ok:true`，LLM/ComfyUI 均可用。
- CDP 在真实项目页点击「运行「关键帧」」：点击前该 run 有 **177** 个历史 job，点击后增至 **282**（新增 **105** 个 job），页面从「运行「关键帧」」切换为「取消运行」，随后通过同一按钮取消本轮，ComfyUI 队列回到 `running=[] / pending=[]`；阶段终态为 `partial`，旧成功候选仍保留。
- 新入队 Qwen job：`run-murvf1vq-aqyqm-sh17-start-musdrodb-14d74`，模板 `img_qwen21_edit`，`params.PROMPT` **2785 字符**。完整正文已保存于本交接单附录（见下方）；正文为单一英文长提示词，未出现 `[untranslated]`、旧版 `overexposure…tack-sharp` 尾巴、重复风格锚点或中英混写。
- 真实降级分支也被同一轮观测到：`sh17-end` 的 job meta 留有 warning，发给模型的 `PROMPT` 为 **470 字结构化中文**，不含 `[untranslated]` 标记；这验证了 warning 可观测且标记不会污染模型输入。
- 刷新同一 CDP 页面后，历史进度只显示「模型生成中」，不再显示旧的「提示词 N 字」后缀（兼容已落盘的旧 `progress.json`）。

### 真实 job 的 `params.PROMPT` 全文

> ⚠️ 2026-10-04 注：这份正文**首句把竖屏项目写成了 horizontal**，正是 #65「改写器自造画幅事实」的故障标本
> （保留在此作为反例）。现行代码会检测出该冲突并整稿弃用，不会再把它发给模型。

```text
The image is a horizontal realistic cinematic medium close-up, held entirely in a static frame, of a man in his sixties placing an old paper bus ticket into the open palm of a girl at a night-time bus terminus, deep blue night gathered around the warm amber of a streetlamp. The scene is outdoors on the paved forecourt of a bus terminal, its asphalt or worn concrete faintly reflective and cool in tone, while a narrow band of deep navy sky runs across the very top edge of the frame with no moon and no visible stars. Over on the left, close behind the man's shoulder, stands the terminus sign — a rounded board on a grey metal pole, dimly lit, its characters small and so softly out of focus that they cannot be read. Behind both figures, well beyond the plane of focus, the blurred mass of a parked bus or a lit waiting shelter suggests itself in bokeh, a few warm windows glowing against the blue. Old Zhou, a man in his sixties, occupies the left half of the frame with his body angled toward the girl on his right; his face is weathered and deeply lined, with short grey hair and a day's grey stubble, and he wears a dark olive quilted jacket over a charcoal knit sweater with the collar turned up. His right arm reaches across the centre of the frame, fingers relaxed and just releasing the ticket, nails short, the hands roughened by age or work. His lips are parted mid-sentence as he speaks to her in a low, slow, even voice, telling her softly that when she misses him she should take the last bus, that a seat is kept for her, his brow slightly lifted and his eyes fixed on her hand. Filling the right half of the frame, the girl appears to be in her early teens, dark hair pulled back into a plain low ponytail, wearing a muted blue padded jacket and a thick cream scarf wound high at her neck, a canvas or backpack strap crossing one shoulder. She is looking down rather than up, her left hand cupped and open at chest height with the fingers slightly spread and ready to close, her other arm hanging loose along her side. In the lower centre of the frame, resting in that open palm, sits the ticket: a small rectangle of yellowed card with browned, curling edges, printed in black dot-matrix characters that read "末班车", the ink faintly dimpled by pin-feed type. The lighting comes from a warm sodium streetlamp above and slightly to the right, raking across both faces and across the yellow ticket, while a cool blue night ambience fills the space behind them and a shallow depth of field keeps the sign, the bus and the sky soft, with fine film grain over the whole frame. The overall composition is an intimate, near-symmetrical exchange around one small slip of paper, warm amber balanced against deep blue night, quiet and tender and heavy with an unspoken goodbye.
```

## 6. 当前仍需人工确认的事项

- ~~H3 i2v 真实 PROMPT 全文取证~~ → **已完成**（2026-10-04，`h3-i2v-ui-evidence.md`）；残留只有**带台词镜头**的视频逐字台词（`(S1)` + `<d>[English]…</d>`）未取证。
- 画幅「只检测不改稿」需要一条**真实任务**验收（当前只有单测 + 流水线级回归）。
- 生图工作台 #56 的「查看历史后返回正在生成」已实现，尚未完成独立 CDP 交互复现。
- `/api/health` 里 `comfy`/`runninghub` 仍是同步探测（LLM 侧已静态化），存活接口与生成就绪度的分离只做了一半（`pilot-issues.md` #64）。

## 7. 环境事实（接手者需要）

- 服务：`canvas-server` systemd，`127.0.0.1:8788`；**重启后 bindJobs 重放约 2 分钟才 listen**，期间 curl 会 refused 但 `is-active` 是 active，别误判崩溃
- ComfyUI：`192.168.123.147:8188`（16GB）+ Qwen-Image 2.1 独立实例 **8190**
- 日志：`/var/log/canvas-server.log`（无时间戳；判断重启后是否刷屏要用「已启动」行之后的内容过滤）
- 测试基线：`cd canvas-server && node --test test/*.test.mjs` → **673/673**
- **模型清单只读注册表**：`/v1/models` 等四处读 `textModelIds()`（渠道声明的 `models[]` → `渠道名::模型名`）；本机 Ollama 模型不再自动出现（产品负责人已接受）
- ⚠️ 重启会打断 queued job（`error: 服务重启，任务中断`）—— 本次实测 3 个生图任务即如此
- 撤销新 attempt 时若存在旧 QC 通过候选会回退选中旧产物；无成功候选仍为 canceled（#60）
- ⚠️ Node `fetch`/undici `headersTimeout=300s` 会腰斩非流式长生成 → LLM 调用必须 `node:https`
- ⚠️ 推理模型隐藏推理 tokens 吃 `max_tokens`（实测 64 → `finish_reason=length` + 空正文）
- ⚠️ `item.warning` 的追加必须去重（`appendWarning`）：启动重放会反复执行投影，不去重会无限增长（#67）
- 数据修复备份：`data/runs/run-murvf1vq-aqyqm/run.json.bak-bloated`（529MB，#67 事故产物，确认无误后可删）

## 8. 相关文档

- 规则契约：`docs/content/docs/progress/model-registry-contract.md`（含「用户无感」附注）
- 问题台账：`docs/content/docs/progress/pilot-issues.md`（#50 / #52–#61）
- 调研（权威只读）：`research/win147-comfyui/`

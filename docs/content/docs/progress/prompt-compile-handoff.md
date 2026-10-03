# 提示词策略层 · 现状交接单（2026-10-03）

> 用途：交接给正在整改的 GPT / 后续接手的人。**只描述现状与证据，不含建议**。
> 生成方式：主代理本人一手实测（CDP 真实点击 / 接口调用 / 文件读取），非子代理自报。

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

## 2. ⚠️ 工作区里**未提交**的改动（子代理产出，主代理**未验收**）

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

- 自测：`node --test test/*.test.mjs` → **664/664 pass**（基线 643）
- 前端：`tsc --noEmit` 0 错、`npm run build` 通过
- ⚠️ 提交者自报的证据**主代理未独立复核**，接手者请复跑

## 3. ⚠️ 前端有 3 处**违反硬约束**（必须撤掉）

硬约束见 `AGENTS.md`「内容创作规范」：**转写层用户无感 —— 前端不得暴露**。
`web/src/pages/image/index.tsx`：

- `:461` 「预览提示词」按钮
- `:611` 预览提示词 Modal（含 `promptPreview` 状态、`openPromptPreview`）
- `:186` / `:565` 结果卡片 `degraded` →「未强化」标签
- 对应 i18n：`imageWorkbench.previewPrompt` / `previewTitle` / `notEnhanced`
- ⚠️ **`web/dist` 已于 17:59 重新构建并含上述文案** → 线上可见，撤销后须重新 build

**保留**：生成的静默编译 + 编译失败静默降级到原提示词 + 后端记 warning。

## 4. 主代理已实测**通过**的部分（一手）

| 项 | 证据 |
|---|---|
| DeepSeek 渠道可用 | `GET /models` → 只有 `deepseek-flash` / `deepseek-v4-pro`；最小改写探针 **0.9s / finish_reason=stop / 181 字** |
| `POST /api/prompt/compile` 可用 | 重启后 **HTTP 200** |
| **语言适配真的生效** | 带 `rewrite:true`：**11.2s**，`language=en`、`rewriterId=qwen-image-2.1-pe`、`untranslated=false`、`llm={model:deepseek-flash, finishReason:stop, chars:3045}` → 产出 **3045 字英文长 prompt** |
| 前端确实传 `rewrite:true` | `web/src/pages/image/index.tsx:337` |
| **降级不阻塞已验证** | 编译接口 404 时，3 个生图任务照常入队（用户未被挡住） |

## 5. 未取得的一手证据（**缺口**）

- **新编译器对 `video_h3_i2v` 的真实 PROMPT 全文**（UI → 入队 这条链没走通）
  - 卡点：主测试项目关键帧阶段被我撤销 job 污染成 `canceled`（见 #60）；
    换项目后撞前端门禁误拦（见 #59）；直调接口拿到的又是 01:28 的**旧 job**（见 #58）
  - **编译器本体**已用真实 shot `sh1/sh2/sh5` 干跑验证输出结构正确
    （首行关键帧对齐指令行 / 三字段固定顺序 / `<Picture 1>` / `non_diegetic_music: N/A` / 运镜取自 `cameraSpec.movement`）
- 生图工作台 #56 的现象（主代理尚未复现）

## 6. 环境事实（接手者需要）

- 服务：`canvas-server` systemd，`127.0.0.1:8788`，`/api/health` 200（**已重启加载新代码**）
- ComfyUI：`192.168.123.147:8188`（16GB）+ Qwen-Image 2.1 独立实例 **8190**
- 日志：`/var/log/canvas-server.log`
- 测试基线：`cd canvas-server && node --test test/*.test.mjs` → **664/664**
- ⚠️ 重启会打断 queued job（`error: 服务重启，任务中断`）—— 本次实测 3 个生图任务即如此
- ⚠️ 撤销 job 会污染阶段状态（#60）
- ⚠️ Node `fetch`/undici `headersTimeout=300s` 会腰斩非流式长生成 → LLM 调用必须 `node:https`
- ⚠️ 推理模型隐藏推理 tokens 吃 `max_tokens`（实测 64 → `finish_reason=length` + 空正文）

## 7. 相关文档

- 规则契约：`docs/content/docs/progress/model-registry-contract.md`（含「用户无感」附注）
- 问题台账：`docs/content/docs/progress/pilot-issues.md`（#50 / #52–#61）
- 调研（权威只读）：`research/win147-comfyui/`

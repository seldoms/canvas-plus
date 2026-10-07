# Canvas Plus Agent

本地 Canvas Agent 用来连接画布网页和用户电脑上的 Codex / ZCode。本地开发时优先连接 `http://localhost:3000`，不需要先使用线上站点。

## 启动

```bash
npx -y @sobey/canvas-agent@latest
```

带上 `@latest` 是因为 npx 会缓存已下载的版本，不加就可能一直运行旧版本。

需要排查连接、线程、Codex app-server 或工具调用问题时，可开启 Debug 模式：

```bash
npx -y @sobey/canvas-agent@latest --debug
```

Debug 日志会以 `[DEBUG][HH:mm:ss]` 等传统格式输出到终端，并按启动日期保存到 `~/.infinite-canvas/logs/canvas-agent-YYYY-MM-DD.log`。终端日志带级别颜色，文件日志为纯文本；日志包含 HTTP、SSE、线程、turn、Codex app-server 和工具调用事件，token 与图片 Data URL 会自动隐藏。

本仓库开发时也可以直接运行：

```bash
cd canvas-agent
npm install
npm run build
node dist/index.js
```

启动后会输出本机地址和 token：

```txt
Local URL: http://127.0.0.1:17371
Connect token: xxxxxx
```

在画布右上角点击 `Agent`，填入地址和 token 后连接。

Codex app 插件会读取启动输出里的 Local URL 和 Connect token，并直接打开画布网页地址；Canvas Agent 不负责生成画布打开 URL。

Canvas Agent 默认只监听 `127.0.0.1`。网页第一次带正确 token 连接后，Canvas Agent 会记录该网页 Origin；之后其他 Origin 不能复用这个本地 Agent，除非用户清理 `~/.infinite-canvas/canvas-agent.json` 里的 `origins`。

## 用哪一份 Agent？

先分清两条路，别装错：

| 你想要 | 怎么做 | 工具数 |
|---|---|---|
| **在平台上干活**（看项目、跑阶段、改单个镜头重出、成片合成） | **直接用网页右侧的 `Agent` 面板**，无需安装 | 51 个，开箱即用 |
| 让本机 Codex / ZCode 也接管画布与流水线 | 按下面《Codex MCP》安装插件或手动加 MCP | 同上 |

网页侧边栏那个 Agent 由站点服务端托管（`canvas-server` 提供网关），版本与本站一致；
本仓库的 `canvas-agent` 是给**本机 Codex** 用的同一套工具的第二份分发。

## 发布

`canvas-agent` 使用自己的 `package.json` 版本号，不跟仓库根目录 `VERSION` 绑定。推送到 `main` 后，GitHub Actions 会检查 npm 上是否已经存在当前包版本；不存在时才发布 `@sobey/canvas-agent`。

发布前需要在 GitHub 仓库 Secrets 中配置 `NPM_TOKEN`，并把 GitHub Actions 里的发布包名从上游的 `@basketikun/canvas-agent` 改为 `@sobey/canvas-agent`。

## Codex MCP

如果希望 Codex 终端能直接操作画布与流水线，需要先把 Canvas Agent 注册成 Codex MCP。

直接运行 `npx -y @sobey/canvas-agent@latest` 只启动本地 Agent 服务，不会安装 MCP，也不会增加 Codex 工具上下文。只有安装 Codex app 插件，或手动执行 `codex mcp add` 后，`canvas-plus` 工具才会进入 Codex 上下文；由于工具较多，不使用时建议移除。

通过插件安装时移除插件：

```bash
codex plugin remove canvas-plus
```

手动添加 MCP 时移除 MCP：

```bash
codex mcp remove canvas-plus
```

### Codex app 插件

仓库内提供了 Codex app 插件：`plugins/infinite-canvas`。在 Codex app 中添加本仓库的 marketplace 后，可以安装 `Canvas Plus` 插件；插件会注册 `canvas-plus` MCP，并带上 `canvas`（画布操作）与 `pipeline`（七段流水线）两份技能说明。

添加本地 marketplace 时建议使用仓库绝对路径，避免 Codex 从其他工作目录解析失败：

```bash
cd /path/to/canvas-plus
codex plugin marketplace add "$(pwd)"
codex plugin add canvas-plus@canvas-plus-local
```

插件默认通过 npm 启动 MCP；这个命令只提供 MCP 工具，不会把 MCP 写入全局配置，也不会在退出时自动卸载：

```bash
npx -y @sobey/canvas-agent@latest mcp
```

使用时可以直接在 Codex 里说“看看项目流水线跑到哪了”“把第 3 镜的对白改一下再重录配音”，插件会启动本地 Agent 并连上站点网关；`project_*` 工具直连网关，不要求画布页面保持打开。

Canvas Agent 启动后，给 Codex 添加 MCP：

给 Codex 添加 MCP：

> ⚠️ **包名是 `@sobey/canvas-agent`，不是上游的 `@basketikun/canvas-agent`。**
> 装上游包能用，但**没有 20 个 `project_*` 项目工具**（建项目 / 发镜头到画布 / 回写分镜
> / 查阶段状态…全都缺）。看到 `@basketikun` 就是旧版。

```bash
codex mcp add infinite-canvas -- npx -y @sobey/canvas-agent@latest mcp
```

本仓库开发时可以改成，实际使用建议替换为本机绝对路径：

```bash
codex mcp add infinite-canvas -- node /path/to/infinite-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 源码使用 TypeScript 编写，MCP 协议层使用官方 `@modelcontextprotocol/sdk`，工具入参使用 `zod` 描述。

如果希望终端里的 Codex 不被 MCP 审批卡住，可以在 `~/.codex/config.toml` 里给这个 MCP 设置自动放行：

```toml
[mcp_servers.infinite-canvas]
command = "npx"
args = ["-y", "@sobey/canvas-agent@latest", "mcp"]
default_tools_approval_mode = "approve"
```

可用工具（53 个，按域分组）：

- **站点与画布**（需网页已连接）：`site_navigate`、`canvas_get_state`、`canvas_get_selection`、`canvas_export_snapshot`、`canvas_apply_ops`、`canvas_create_node`、`canvas_create_attachment_nodes`、`canvas_create_text_node`、`canvas_create_text_nodes`、`canvas_create_config_node`、`canvas_create_image_prompt_flow`、`canvas_create_generation_flow`、`canvas_generate_text`、`canvas_generate_image`、`canvas_generate_video`、`canvas_generate_audio`、`canvas_update_node`、`canvas_update_node_text`、`canvas_move_nodes`、`canvas_resize_node`、`canvas_delete_nodes`、`canvas_connect_nodes`、`canvas_select_nodes`、`canvas_set_viewport`、`canvas_run_generation`、`generation_get_status`
- **工作台与素材**：`workbench_image_get_config`、`workbench_image_generate`、`workbench_video_get_config`、`workbench_video_generate`、`prompts_search`、`assets_list`、`assets_add`
- **项目与流水线**（`project_*`，走网关 HTTP，**网页不在线也能用**）：
  - 项目视角：`project_context`、`project_gates`、`project_list_runs`、`project_run_status`、`project_run_qc`、`project_stage_items`、`project_list_jobs`
  - 阶段驱动：`project_run_stage`、`project_cancel_stage`、`project_retry_failed`、`project_update_stage_input`、`project_assemble`
  - 条目精调：`project_regenerate_item`、`project_patch_shot`、`project_confirm_casting`、`project_adopt_candidate`、`project_export_package`
  - 资料包：`project_asset_pack`（给 projectId 查谁还没锁参考图；给 runId 查定妆取料盘点：每张脸当前用哪张、来源、可换候选）、`project_attach_asset`（把产物归入角色/场景/道具，幂等追加不产生重复引用）

`project_*` 工具默认连接本机 `http://127.0.0.1:8788` 的 canvas-server 网关，可用环境变量 `CANVAS_GATEWAY_URL` 覆盖；网关不可达时工具会显式报错，而不是静默失败。

`canvas_apply_ops` 示例：

```json
{
  "ops": [
    {
      "type": "add_node",
      "nodeType": "text",
      "title": "标题",
      "position": { "x": 0, "y": 0 },
      "metadata": { "content": "文本内容" }
    }
  ]
}
```

## 侧边栏 Codex

本地面板会把提示词发送给 Canvas Agent。Canvas Agent 使用官方 `@openai/codex` CLI 的 `codex app-server --stdio` 启动并复用同一个 Codex thread，启动时会注入 `infinite-canvas` MCP 配置并自动放行 MCP 审批，真正执行画布修改前仍由网页侧边栏二次确认。

侧边栏会展示 Codex 返回的 `thread.started`、`turn.started`、`item.*`、`turn.completed` 等结构化事件；Canvas Agent 会合并短时间内的回复、思考摘要和命令输出增量，网页使用同一条消息持续更新，并把任务进度、计划、搜索、文件修改与工具操作整理为中文过程时间线。

侧边栏上传或粘贴的图片会先发到本机 Canvas Agent，再由 Canvas Agent 临时写入本机文件并作为 app-server `localImage` 输入传给 Codex；前端会提示附件体积，单次请求体限制为 30MB。

## Claude Code

Claude Code Adapter 代码暂时保留，但当前网页侧边栏只开放 Codex。后续开放 Claude 入口时，Canvas Agent 会调用本机 `claude -p --output-format stream-json` 并把流式 JSON 事件转发到侧边栏。

如果希望 Claude Code 也能操作画布，需要给 Claude Code 添加同一个 MCP。建议用 user scope，避免 Canvas Agent 从不同目录启动时找不到配置：

```bash
claude mcp add --scope user --transport stdio infinite-canvas -- npx -y @sobey/canvas-agent@latest mcp
```

本仓库开发时可以改成：

```bash
claude mcp add --scope user --transport stdio infinite-canvas -- node /path/to/infinite-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 调用 Claude Code 时会默认带上 `--allowedTools mcp__infinite-canvas__*`，画布写操作仍由网页侧边栏确认。

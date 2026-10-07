# 本地 Agent 固化与接入（2026-10-06 实测固化）

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


## 一、为什么要固化

之前 canvas-agent 是我手动 `node dist/index.js` 起的：
没有 systemd 服务、服务器一重启就没了、构建产物也没进版本管理。
本文把「服务化 + 令牌持久化 + 多客户端接入」三件事固化下来。

## 二、systemd 服务

`/etc/systemd/system/canvas-agent.service`（已 `enable` + 开机自启）：

```ini
[Unit]
Description=无限画布本地 Agent（canvas-agent）
After=network-online.target canvas-server.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/sobey/canvas-plus/canvas-agent
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
StandardOutput=append:/var/log/canvas-agent.log
StandardError=append:/var/log/canvas-agent.log

[Install]
WantedBy=multi-user.target
```

**关键约束：不要用环境变量覆盖 token。**
令牌持久化在 `/root/.infinite-canvas/canvas-agent.json`，
`loadConfig` 读不到文件时才会生成**随机 token**——
一旦被环境变量诱导去覆盖，页面 localStorage 里存的 token 全部失效、连不上。

日志：`/var/log/canvas-agent.log`（不在 journal）。

## 三、监听与暴露

- Agent 只监听 `127.0.0.1:17371`（**不要改成 0.0.0.0**，会把工具执行面暴露公网）
- 网关只监听 `0.0.0.0:8788`
- 浏览器访问靠 **SSH 端口转发**，两个端口都要：

```bash
ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 ubuntu \
  -L 8788:127.0.0.1:8788 \
  -L 17371:127.0.0.1:17371
```

之后 `http://127.0.0.1:8788`（页面）与 `http://127.0.0.1:17371`（Agent）都可用。

## 四、页面连接 Agent

前端支持 query 参数自动 bootstrap（`web/src/lib/agent/agent-url-bootstrap.ts`）：

```
?agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=<token>
```

**但实测 `?agentUrl=` 本身不会立即连上** —— 它只是让Agent 面板不被自动收起
（`project.tsx:484`），真正建立连接仍需点「打开 Agent」按钮。
点开后 `canvas-agent-url` / `canvas-agent-token` 写入 localStorage，后续免填。

**token 走 query 参数或 `x-canvas-agent-token` 头，不是 `Authorization: Bearer`**
（用 Bearer 会得到 `invalid token`）。见 `web/src/services/api/canvas-agent.ts`。

## 五、让任意本机Agent 客户端都能调用

`~/.infinite-canvas/canvas-agent.json` 的 `origins` 是 CORS + 授权白名单，
**但它是自动追加的**（`src/server/http.ts` 的 `setCors`）：

> 带正确 token 调**业务端点**（如 `POST /api/tools`）且 Origin 不在白名单里
> → 自动 push 进 origins 并落盘 → 之后该 Origin 一直可用。

**注意两个坑**：

1. `/health` 与 `/config` **不记录 origin**（函数里提前 return）。
   用它们"注册"是无效的，必须调业务端点。
2. 非浏览器客户端（curl / MCP / 脚本）通常**不带 Origin**，CORS 直接放行，
   不需要动 origins。

实测：`http://localhost:3000` 调一次 `POST /api/tools` 后自动进白名单，后续调用成功。

## 六、MCP 配置（Codex app / 任意 MCP 客户端）

**必须用 canvas-agent 自带的 codex，不能用 snap 版**：

```bash
#❌ /snap/bin/codex —— 报Failed to read /root/.codex/config.toml: Permission denied
#         （snap 沙箱以别的身份运行，读不到 root 私有配置）
# ✅ node_modules 里的那个 —— 跟随当前身份
cd /sobey/canvas-plus/canvas-agent
node node_modules/@openai/codex/bin/codex.js mcp list
```

配置命令：

```bash
node node_modules/@openai/codex/bin/codex.js mcp add infinite-canvas -- \
  node /sobey/canvas-plus/canvas-agent/dist/index.js mcp
```

验证：`mcp list` 里状态应为 `enabled`。

## 七、两类工具的分工（实测）

| 工具 | 通路 | 需要页面在线 | agent 日志特征 |
|---|---|---|---|
| `project_*`（7 个，M5 加的） | 网关 HTTP `:8788` | **否** | `targetClientId=''` |
| `canvas_*`（25 个原有） | SSE 转发到浏览器画布 | **是** | `targetClientId='<clientId>'` |

判断链路是否打通看 `GET :17371/health`：

```json
{ "hasCanvas": true, "clients": 1, "conversation": { "status": "ready" } }
```

- `hasCanvas:false` → 页面还没连上（点「打开 Agent」）
- `hasCanvas:true` → 画布已接管，`canvas_*` 可用

## 八、网关地址供 project_* 工具使用

`project_*` 走网关 HTTP，默认 `http://127.0.0.1:8788`，
可用环境变量覆盖（**只影响 project_*，与 Agent 自身端口无关**）：

```bash
Environment=CANVAS_GATEWAY_URL=http://127.0.0.1:8788
```

连不上时该工具会显式报错「连不上本地网关」而不是静默失败——
Agent 需要能区分「工具不可用」与「成功但无结果」。

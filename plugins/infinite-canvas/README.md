# Canvas Plus 插件

让 Codex / ZCode 打开并操作 **Canvas Plus**——本地化的 AI 短剧生产平台
（画布 + 七段式流水线 + 20 个 `project_*` 项目工具）。

> **注册名是 `canvas-plus`，不是 `infinite-canvas`。** 那是上游开源项目的名字；
> 照旧名安装会报「找不到插件」。

## 安装

### Codex

macOS / Linux：

```bash
git clone <你们的 canvas-plus 仓库地址>
cd canvas-plus
codex plugin marketplace add "$(pwd)"
codex plugin add canvas-plus@canvas-plus-local
```

Windows PowerShell：

```powershell
git clone <你们的 canvas-plus 仓库地址>
cd canvas-plus
codex plugin marketplace add "$PWD"
codex plugin add canvas-plus@canvas-plus-local
```

Windows CMD 将 `$PWD` 替换为 `%cd%`。

### ZCode

- 打开 **Settings → Plugin Management → Discover**，点击右上角 **`+`** 添加 marketplace。
- 选择 **本仓库目录**（`plugins/infinite-canvas`）或本仓库根目录，即可发现 `infinite-canvas` 插件并安装。
- 或在 ZCode 界面直接以本地目录方式加载该插件目录。

安装后新建一个任务，然后输入：

```text
帮我打开画布，连接站点网关
# 项目类请求直接说：
# 把《喜宴之外》第 1 集第 3 镜发到画布 / 这一镜的下游要不要重跑
```

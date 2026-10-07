# 无限画布文档索引

## 项目介绍

- [快速开始](/zh-CN/docs/overview/quick-start)
- [功能介绍](/zh-CN/docs/overview/features)
- [Render 部署](/zh-CN/docs/overview/render)
- [Docker 部署](/zh-CN/docs/overview/docker)
- [第三方提示词来源](/zh-CN/docs/overview/third-party-prompt-repositories)

## 操作手册

- [画布节点操作手册](/zh-CN/docs/canvas/canvas-node-manual)
- [画布快捷键](/zh-CN/docs/canvas/canvas-shortcuts)

## 开发与数据

- [本地开发](/zh-CN/docs/development/local-development)
- [画布数据结构](/zh-CN/docs/development/canvas-data-structure)

## 商务合作

- [开源协议](/zh-CN/docs/business/license)
- [商务合作](/zh-CN/docs/business/business)

## 支持与安全

- [漏洞提交](/zh-CN/docs/support/security)
- [赞助支持](/zh-CN/docs/support/sponsor)

## 项目进度

- [待测试](/zh-CN/docs/progress/pending-test)
- [TODO](/zh-CN/docs/progress/todo)

## 内部文档（不进文档站导航）

`docs/content/docs/progress/` 下的 `.md` 文件**有意不登记进 `meta.json`**，直接在仓库中阅读。
**现行权威文档**如下；过程性文档（里程碑计划、调研、审计、试跑清单）已归档至 `progress/archive/`，内容定格于写作时点。

- `prd.md` —— **产品需求文档**：定位、目标架构、内容创作规范、功能优先级。所有开发的对齐基准。
- `development-plan.md` —— **开发计划**（当前 v4）：执行排期，当前主线为 skeleton 的 P0–P3。
- `project-centric-skeleton.md` —— **产品骨架**：以项目为中心的五入口串联形态、断点清单与落地路径。
- `domain-contract.md` —— **领域契约（冻结）**：生产链词汇、字段与稳定 ID。
- `model-registry-contract.md` —— **模型注册表契约**：清单只读注册表、别名与分类。
- `ui-interaction-spec.md` —— **交互规范**：UI 铁律与验收铁律（验收必须走完整动线）。
- `audio-video-quality-audit-2026-10-06.md` —— 声音/口型质量审计与验收门禁（**声音质量验收未通过，当前焦点**）。
- `liblibai-api-reference.md` —— 第三方平台 API 事实摘要（可选后端参考）。

## 说明

- 当前画布项目和“我的素材”主要保存在浏览器本地，跨设备可自行配置 WebDAV 同步。
- AI API Key 保存在浏览器本地，并由前端直接请求 OpenAI 兼容接口。

## 原理说明

- [本地 Codex 连接画布原理](/zh-CN/docs/development/local-codex-canvas)

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

- [更新日志](/zh-CN/docs/progress/changelog)
- [待测试](/zh-CN/docs/progress/pending-test)
- [TODO](/zh-CN/docs/progress/todo)

## 内部研究文档（不进文档站导航）

以下是 `docs/content/docs/progress/` 下的纯 `.md` 文件，**有意不登记进 `meta.json`**，
因此不会出现在文档站里，直接在仓库中阅读。

- `docs/content/docs/progress/prd.md` —— **产品需求文档（PRD）**：产品定位、现状（三个互不相通的
  世界）、Project 一等实体与混合存储的目标架构、六阶段流水线、画布⇄流水线打通、功能优先级、
  **内容创作规范（面向海外、忠于原著、风险只提示不改稿）**、非功能需求与待确认项。
  后续所有开发的对齐基准。
- `docs/content/docs/progress/development-plan.md` —— **开发计划**（PRD 的执行侧）：
  三视角调研（资产复用 / 数据流断点 / 用户成本）的结论、`artifactUrl` 从不回写导致
  五段流水线实际只有四段半的致命断链、Project 要补的七层标识符、四个落地即踩的陷阱、
  决策登记（命名、产物存储）、P0-a→P2 工作包与验收标准。每条结论标注【已复核】/【调研】。
- `docs/content/docs/progress/gateway-api-benchmark.md` —— 生成网关 API 对标研究与设计方案：
  以成熟商业平台（LiblibAI）为基准线的能力对照矩阵、三层差距结论、冻结契约上的向后兼容加法设计、
  按性价比排序的补齐路线，以及仍待确认的边界值清单。
- `docs/content/docs/progress/local-capability-audit.md` —— 本地 ComfyUI 能力盘点。
  对标研究里所有实测数字都出自这里，结论分【实测】/【文档】/【推断】三档。
- `docs/content/docs/progress/liblibai-api-reference.md` —— 对标平台 API 的**事实摘要**
  （端点、配额、状态枚举、错误码），用我们自己的表述整理。原页面需登录；
  **有意不提交逐字存档**，因为 `origin` 是公开远端。
- `docs/content/docs/progress/local-asset-inventory.md` —— 本地化能力的**对内**资产盘点：
  结构性护城河、可外提复用的工程资产、值得推广的设计纪律、以及诚实列出的技术债，
  每条都核实到 `file:line` 或真机任务 id，并标注【实测】/【核实】/【推断】。

## 说明

- 当前画布项目和“我的素材”主要保存在浏览器本地，跨设备可自行配置 WebDAV 同步。
- AI API Key 保存在浏览器本地，并由前端直接请求 OpenAI 兼容接口。

## 原理说明

- [本地 Codex 连接画布原理](/zh-CN/docs/development/local-codex-canvas)

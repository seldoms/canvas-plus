# 归档区（progress/archive）

这里存放**已完成或已被取代的过程性文档**：里程碑实施计划、验收报告、调研、审计、试跑问题清单等。
内容**定格于各自写作时点**，可能滞后于代码，请勿作为现行依据引用。

**现行权威文档**（在上一层 `progress/`）：

- `development-plan.md` —— 开发计划（当前 v4，执行排期）
- `project-centric-skeleton.md` —— 产品骨架（以项目为中心的串联形态与 P0–P3）
- `prd.md` —— 产品需求文档
- `domain-contract.md` / `model-registry-contract.md` —— 冻结契约
- `ui-interaction-spec.md` —— 交互与验收铁律
- `audio-video-quality-audit-2026-10-06.md` —— 声音质量审计（验收未通过，当前焦点）

## 从归档文档中带出的遗留问题（截至 2026-10-07 仍未修）

以下来自 `pilot-issues.md` 复核时已确认仍存在，归档不代表解决：

- **#11 提示词与输出持续膨胀**：design/keyframe 阶段提示词达数千字，纯文本准备耗数分钟；上下文裁剪未落。
- **#12 `forwardToLlm` 仍用 fetch**：`canvas-server/src/providers/llm.js` 的前端代理路径保留 undici 300s `headersTimeout` 隐患（`chat()` 已改 `node:http`，代理路径未改）。
- 其余「待讨论」条目多数已在 M0–M6 中修复或被新设计取代；逐条状态以 `pilot-issues.md` 原文为准。

## 归档清单（2026-10-07 整理）

- 里程碑计划：`m0-m1/m2/m3/m35-implementation-plan.md`、`p0a-project-kernel-plan.md`
- 验收与清单：`acceptance-round4.md`、`acceptance-round4-assembly.md`、`subagent-acceptance-checklist.md`、`pilot-issues.md`、`pipeline-feature-api-inventory.md`
- 定位与路线草稿：`platform-positioning.md`、`platform-flow.md`、`production-boundary-and-roadmap.md`、`project-integration-implementation-guide.md`
- 调研与审计：`local-capability-audit.md`、`local-asset-inventory.md`、`external-solutions-and-skills-research.md`、`libtv-product-analysis.md`、`gateway-api-benchmark.md`、`spec-kit-adoption-plan.md`、`research/`（三份）
- 交接与证据：`prompt-compile-handoff.md`、`audio-tts-pipeline-wiring.md`、`h3-i2v-ui-evidence.md`、`deploy_local_agent.md`

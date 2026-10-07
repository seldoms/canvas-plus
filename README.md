# canvas-plus

> 基于开源 [infinite-canvas](https://github.com/basketikun/infinite-canvas) 二次开发的**本地化 AI 短剧生产平台**：把一部小说/一段原文，做成能被专业剪辑直接接手的一集素材包（成片 + 分片 + 字幕 + 时间线交换文件 + 清单）。

图像、视频、音频与私有素材**不出本机**（本地 ComfyUI 出图出视频）；文本与提示词改写可按项目策略走云端 LLM。

## 组成

| 目录 | 说明 |
|---|---|
| `web/` | React 19 + Vite 前端：项目、画布、流水线、AI 图片/视频工作台、提示词、资产、任务 |
| `canvas-server/` | 零依赖 Node 本地网关（`:8788`）：统一生成提交链、七阶段流水线编排、项目事实链、QC 与交付打包 |
| `canvas-agent/` | 本地 Agent 桥（MCP）：51 个工具，含 17 个 `project_*` 项目/阶段/条目三层管线工具 |
| `skills/` | 七阶段生产技能与短剧方法论库 |
| `plugins/` | Codex 插件（canvas / pipeline / open-canvas 技能） |
| `docs/` | 文档站（fumadocs）与全部内部文档 |

## 七阶段流水线

剧本 → 分镜 → 服化道 → 角色定妆 → 关键帧 → 配音 → 片段合成。
对象层级：**项目 → 集 → 场景 → 镜头 → 素材/候选 → 成片**；run 只是执行记录。

## 文档入口

- **`HANDOFF.md`** —— 接手必读：当前状态、测试基线、下一步（按优先级）
- **`docs/content/docs/progress/development-plan.md`** —— 开发计划（当前 v4，执行排期）
- **`docs/content/docs/progress/project-centric-skeleton.md`** —— 产品骨架（以项目为中心的串联形态与 P0–P3）
- **`docs/content/docs/progress/prd.md`** —— 产品需求文档
- **`docs/content/docs/progress/domain-contract.md`** —— 领域契约（冻结字段）
- **`docs/content/docs/guide/user-manual.md`** —— 使用手册（给做内容的人看）
- `docs/content/docs/progress/archive/` —— 历史过程文档（里程碑计划、调研、审计，定格于写作时点）

## 开发

```bash
# 前端
cd web && npm install && npm run dev

# 本地网关
cd canvas-server && npm run start        # 测试：node --test test/*.test.mjs

# Agent 桥
cd canvas-agent && npm install && npm run build
```

行为约束见 `AGENTS.md`；改 `canvas-server/` 前必读 `canvas-server/README.md` 冻结契约。

## License

MIT（继承上游 infinite-canvas）

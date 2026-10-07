# spec-kit v1.1.0 借鉴方案（对照 canvas-plus）

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> **状态**：草案，待产品负责人审阅
> **日期**：2026-10-03
> **来源**：`github/spec-kit` **v1.1.0（2026-10-02）**，本地克隆 `/root/refs/spec-kit`
> **原始调研**（三路深读，共 107KB）：
> - `/root/refs/spec-kit-learnings/01-core-workflow.md`（213 行）核心工作流与五份模板
> - `/root/refs/spec-kit-learnings/02-extensibility.md`（605 行）扩展 / 预设 / 工作流引擎
> - `/root/refs/spec-kit-learnings/03-agent-governance.md`（363 行）agent 治理与工程约定
> 三条要求：基于原文（附短引）、给可借鉴清单、**明确写出哪些不能照搬**。

## 1. 结论先行

**spec-kit 早就不是"模板 + 命令"了** —— v1.1.0 已是一套**四原语**体系：

| 原语 | 干什么 | 一句话 |
|---|---|---|
| **extension** | **加能力** | 用命名空间 `speckit.<ext>.<cmd>` 注册命令/脚本/hooks，有清单文件 + 强校验 + 安装态 registry |
| **preset** | **换内容** | 按 `priority` 栈叠加模板，四种组合策略 `replace/prepend/append/wrap` |
| **workflow** | **做编排** | step 契约 + gate（含 `on_reject ∈ {abort,skip,retry}`）+ **RunState 落盘与断点续跑** |
| **bundle** | **只分发组合** | 无新运行时行为，只把上面三者的组合打包 |

**对我们最有价值的三条**（按投入产出比）：
1. **`AGENTS.md` 写成"改 X 前必读 Y"的指针表**（而不是规则堆砌）—— 成本极低，立刻见效
2. **证据门禁固化成子 agent 验收模板** —— 我们已在"不认自报"，但没写成可引用的 checklist
3. **RunState 落盘 + 断点续跑 + 追加式审计日志** —— **这是我们流水线相比它最具体缺的一块能力**

## 2. 建议采纳（按投入产出比排序）

### ★★★ 立刻做（低成本、当天能落）

**A1. `AGENTS.md` 改造成"必读路由表" + 兜底条款**
- 它的做法：根 `AGENTS.md` 只有 5~6 条 `Before <动作>, read <文档>`，规则细节留在 `CONTRIBUTING.md` / `design/*.md`；末尾一句兜底"不清楚就先读 CONTRIBUTING.md"。原文：`AGENTS.md:1-30`
- 它解决的问题：**根文件越写越长没人读**；agent 动手前不知道去哪看规则
- 落点：我们 `AGENTS.md` 改成指针表，如
  `改前端 web/** 前必读 docs/.../ui-spec.md`｜`改 canvas-server 路由前必读 domain-contract.md`｜
  `改流水线阶段前必读 pipeline-stage.md`｜`改模型清单前必读 model-registry-contract.md`
- 成本：低（一次性整理 + 一张表）

**A2. 证据门禁 → 子 agent 验收 checklist（固化下来）**
- 它的做法：`CONTRIBUTING.md` 的 evidence gate —— 行为变更需**正反覆盖**，bug 修复需**"改前失败、改后通过"的回归证据**；并把这条固化成 reviewer agent skill 的第 1、2 条。原文金句：**"A contribution is evaluated on the evidence it carries, not on how plausible its reasoning sounds."**
- 它解决的问题：子 agent 自报"已完成"但无证据
- 落点：我们已经执行"必须贴证据、不认自报"，**把它写成一份可复制的验收 checklist**：
  ① 每个行为变更列出正例 + 反例测试
  ② bug 修复必须附「改前复现失败 / 改后通过」的对比
  ③ 无法自动化的路径须**说明限制并给可复现证据**
  ④ **禁止用"理论上会失败"代替证据**
  ⑤ 外部副作用（上传/发布/写远端）须给**可验证句柄**（URL/ID/绝对路径）并由主 agent 复核
- 成本：低

**A3. `enabled=false` 的语义闭环（核我们刚做的模型注册表）**
- 它的做法：`extension disable` 后 **"Commands will no longer be available. Hooks will not execute."** 但配置与安装态保留
- 落点：我们的模型注册表 `enabled=false` 目前只验证了**下拉过滤**；**还要保证"服务端不出现在可选清单 / 工作流不引用 / 编排不派发"** —— 待核
- 成本：低（多半是补一处过滤）

**A4. 文档的 APPEND-ONLY 纪律**
- 它的做法：converge / taskstoissues / clarify 的复验只**追加或最小改动**，不重写历史。原文：`APPEND-ONLY, NEVER REWRITE`
- 落点：我们 `pilot-issues.md` 已经是这个路子（只追加、不替换）→ **推广到 `development-plan.md` / `contract` 类文档**，让二次运行不产生噪音 diff
- 成本：低（一条纪律）

### ★★ 值得做（中成本、结构性收益）

**A5. 设计文档自带三段：`Anti-patterns` / `Decision guide` / `Review checklist`**
- 它的做法：`design/cli.md` 末尾有 8 条反模式 + "问题→放哪"决策表 + 9 项 review 复选框
- 它解决的问题：设计文档写成散文后**无人执行**；新代码放哪靠猜；review 无客观标准
- 落点：`domain-contract.md` / `model-registry-contract.md` 各补三段 —— **而且这份 checklist 直接就是子 agent 的验收标准**（与 A2 合流）
- 成本：每份 +20~40 行

**A6. 模型注册表：`official` vs `experimental` 二分 + 版本钉住 + 干跑预览**
- 它的做法：`catalog.json`（`install_allowed:true`）vs `catalog.community.json`（`install_allowed:false`，**"discovery-only, not an install or trust endorsement"**）；条目带 `version` / `sha256` / `download_url`，且**装前必须钉到 release tag**（原文：**`never use releases/latest/`**）；`bundle info` 给出"这次到底会装什么、来自哪个源、是否可信"的**展开预览**，且"这个预览就是 install 真正会执行的计划"
- 落点（三条，都很贴我们）：
  ① 注册表分 `official`（服务端批准、可启用）与 `experimental`（可见、默认 disabled、需显式提升）—— 我们已有 `enabled` 字段，正好承载二分
  ② 每个模型加 `version` + `artifact_sha256` + `revision`（如 HF commit）—— **防止生产环境悄悄换权重**（我们踩过 `quya` 模型名会变的坑）
  ③ **启用前给干跑预览**：这个模型会拉起哪些依赖、占多少显存 —— **我们只有 16GB，这条特别实用**
- 成本：①③ 低，② 中

**A7. 并发子 agent 的"在途任务上限 + 一任务一关注点"**
- 它的做法：单账号 3 个开放 PR 上限；超限须取得明确许可，否则"留在分支上，报告需要确认"；**单 PR 单关注点**
- 落点：我们已经在做文件边界切分 + 串行独占热点文件（如 `pipeline.js`），把它成文即可：**并发在途 ≤N，一任务一关注点，超限停手报告**
- 成本：低

### ★ 有依赖，先记着

**A8. 需求/任务的全局编号与可追溯**
- 它的做法：`FR-###` / `SC-###` / `US#` / `T###` / `CHK###` 全程复用于 analyze 覆盖表、converge 的 source-ref、tasks 的 `[Story]` 标记
- 落点：我们 `pilot-issues` 已有编号（#1…），但**需求 → 计划 → 实现 → 验收**尚未全链路共用一套号。做之前先盘点现状（**历史文档无法回填编号**，别硬来）
- 成本：低（新条目开始用即可）

## 3. 我们最具体缺的一块能力：RunState + 断点续跑 + 追加式日志

**这是三份调研里唯一被点名为"我们相比 spec-kit 差的最具体的一块"**，也是对短剧流水线最值钱的：

| | spec-kit | 我们现状 |
|---|---|---|
| 状态落盘 | `runs/{run_id}/state.json` + `inputs.json` + **`log.jsonl`（追加式）** | `run.stages[].status` 在 run 对象里，**没有独立的现状快照与追加式日志** |
| 状态机 | `CREATED→RUNNING→{COMPLETED, PAUSED, FAILED, ABORTED}` | 我们有 `pending/running/partial/done/error/canceled/blocked`（含我们自己的 `blocked`）|
| 续跑 | **resume 从 `current_step_index` 恢复全部 `step_results`** | 单步重跑有（如导出 `--from`），**没有"整条流水线从断点续跑"** |
| 审批 | `type: gate` + `options:[approve,reject,edit]` + **`on_reject ∈ {abort,skip,retry}`** | 门禁是**流程约定 + 人工确认**，没有把 gate 建成一等公民，也没有三种 reject 语义 |
| 并行 | `fan-out` / `fan-in` + `max_concurrency`、`while(max_iterations)` | 阶段内并行有（D3 一次入队 4 候选），但是**夹具特例，不是通用原语** |
| 数据流 | `{{ steps.plan.output.file }}` 声明式引用 | 阶段间靠代码里直接取 `run.stages.X.output`，**无统一取数契约** |

**建议（分期，别一次上全）**：
1. **P1**：给 run 加 **`state.json`（现状快照）+ `log.jsonl`（追加式审计）** —— 好处立刻可见：出问题能查"哪一步、什么时候、什么输入产出什么"，且**不重写历史**
2. **P2**：把 gate 建成**一等公民**（`approve/reject/edit` + `on_reject` 三语义）—— 我们已有门禁语义，主要补三个分支
3. **P3**：定义**阶段输出取数契约**（`run.stages.<stage>.output.<field>` 的 schema）—— 这是 resume 能恢复上下文的前提
4. **P4**：`from <stage>` **续跑**（不必从头）
5. **P5**：`fan-out/fan-in` 通用原语（**注意**：spec-kit 自己的已知限制是"resume 只到顶层 step，嵌套暂停会重跑父步骤"——我们若做并发恢复，需自建 nested step-path 栈）

## 4. 明确不采纳（照搬反成负担）

| 不采纳 | 为什么 |
|---|---|
| **40+ AI 助手适配矩阵**（Claude/Copilot/Cursor/Gemini…） | 那是"要给全世界各种 agent 用"的成本。我们内部就 Hermes 一家，做渲染层是纯负担 |
| **外部贡献者流程 / 社区目录审核 / verified 徽章 / downloads·stars** | 面向公开生态的治理。我们内部自用不需要审核管线与信任营销 |
| **签名与密钥托管、严格 SemVer、CI 供应链审计快照** | 公开发布才需要；内部仓库有 git 历史足够 |
| **17+ 种输出格式渲染**（markdown/toml/yaml/skills…） | 同上，多宿主适配的副产品 |
| **九条宪法具体条文** | **借机制不借条文** —— 它的宪法是"通用软件工程"的九条，和短剧生产无关；我们若做"全局不可协商原则"，内容得自己写 |
| **extension hooks / 完整插件生态** | 内部单一项目上插件系统是过度设计。**教训吸收（横切关注点不侵入主流程），机制不做** |
| **强隔离的 feature 目录 / clarify 三轮硬上限** | 前者是为并行外部贡献者防冲突，后者的"3 轮"是拍脑袋常数，我们有自己更贴合的节奏 |

## 5. 一句话总结

**spec-kit 值得借的是它的"工程纪律"**（模板即约束、证据门禁、指针表式文档、Append-Only、断点续跑），
**不值得借的是它的"生态基建"**（多宿主适配、社区目录、发布审核、签名）。

我们用它的方式应该是：**把纪律变成我们的模板与 checklist，把生态那一层砍掉。**

# Project 主线整合实施蓝图

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 面向 Kimi、千问和后续开发者的执行文档。本文把 `Project / Canvas / Workflow / Tool / 生图工作台 / 生视频工作台 / 流水线` 统一到一条可实现的生产链上。
>
> 本文不是新的领域契约。字段名、状态和阶段 ID 以 [`domain-contract.md`](./domain-contract.md) 为准；产品范围以 [`prd.md`](./prd.md) 为准；执行优先级以 [`development-plan.md`](./development-plan.md) 为准。本文只补充“怎样接起来”和“怎样证明接对了”。
>
> 当前基线：147 单张 16GB GPU，图像/视频/音频本地串行；文本与提示词编译可走云端 LLM；首个验收目标是 60～90 秒验证短片和剪辑交接包。

## 1. 先给执行结论

现在的能力可以有机结合，但不能把所有页面合并成一个“大工作台”。正确的收敛方式是：

```text
Project = 生产事实主线
Workflow = 阶段编排定义
Tool = 一次具体执行能力
Job = 一次可观察、可取消、可重试的执行
Artifact = 不可变文件
Shot = 可拍摄的叙事镜头
Take = 同一 Shot 的一次完整尝试/续接分支
Candidate = Take 产出的可比较结果
Approval = 对 Candidate/Take 的人工采用指针
AssetRef = 项目内对 Artifact 的语义采用关系
Canvas = Project 上的可视化编辑表面
Workbench = 不带生产承诺的试验/单次生成入口
```

只保留一条服务端生成事实链：

```text
内容事实 / Canvas 操作 / Workbench 单次操作
                 ↓
          GenerationIntent
                 ↓
     模型能力检查 + 提示词编译 + Tool 路由
                 ↓
                Job
                 ↓
             Artifact
                 ↓
       Take / Candidate / Approval
                  ↓
          AssetRef / Deliverable
```

三个入口可以不同，执行链不能不同：

| 入口 | 作用 | 是否改变 Project 事实 |
| --- | --- | --- |
| 项目工作区 | 正式生产、门禁、采用和交付 | 是，必须带 Project 上下文 |
| Canvas | 可视化编排、分镜编辑、局部创作、Agent 批量操作 | 通过 Project API 改事实；画布本身不是事实源 |
| 生图/生视频工作台 | 单张试验、参数探索、模型对比 | 默认不改变 Project；用户点击“加入项目”后才成为候选 |

## 2. 当前项目的真实断点

下列问题是整改的直接对象，不要再增加第四套并行机制：

| 断点 | 当前事实 | 整改方向 |
| --- | --- | --- |
| Project 与 Canvas | Project 服务端已存在，Canvas 仍主要在浏览器 localforage；画布生成曾走浏览器直连，未稳定进入项目产物图 | Canvas 必须携带 `projectId`，生成统一走网关；节点只保存引用和编辑态 |
| 流水线与工作台 | `/api/images/enqueue` 和 `/api/generate/image|video` 都能入队，但参数、元数据和调用方不同 | 两者都构造同一种 `GenerationIntent`，复用同一个 submit/compile/queue 入口 |
| 阶段注册 | `skills/registry.json` 已有 7 段，但 `gates.js` 和前端 fallback 仍有旧的 5/6 段集合 | 以 registry 派生阶段列表；禁止在前端和门禁中另写阶段数组 |
| 阶段语义 | `assembly` 同时被理解为视频片段生成和 ffmpeg 成片 | 保留 ID 以避免迁移，明确 `assembly.clip_generation` 与 `post.delivery` 两个子步骤；最终成片属于 `post` |
| 提示词 | 流水线和生图工作台已有后端编译；Canvas/API 直连路径曾有缺口 | 所有提交都必须在服务端编译；前端不展示编译过程 |
| 资产采用 | 生成结果和项目 AssetRef 已有部分投影，但工作台结果仍容易停留在孤立 Job | “试验结果”与“项目采用结果”分开；只有显式采用才更新 `selectedArtifactId` |
| 音频 | Qwen3-TTS 工作流已能出音，但尚未完整接入流水线 | `audio` 阶段生成 `AudioCue`；最终由 CPU/ffmpeg 混音，口型不作为默认门禁 |
| 镜头尝试与续接 | 现有 GenerationSlot 能保留候选，但还不能表达 Take、批准分支和 H3 continuation chain | 增加 `Shot → Take → Candidate → Approval` 关系；续接每段仍是独立 Job/Artifact |

## 3. 目标数据关系

### 3.1 Project 是唯一生产上下文

一个 Project 包含多个 Episode；Episode 包含 Scene 和 Shot；Shot 下面挂生成活扣。所有正式生成都要能回答：

```text
这是什么项目？第几集？哪一场？哪一镜？
这次使用了哪一版剧本、风格、角色、场景和声音？
调用了哪个 Workflow、Tool、Provider、Device？
生成了哪些 Job 和 Artifact？当前采用哪一个候选？
```

最小上下文对象建议如下：

```js
const productionContext = {
  projectId: "prj_…",
  episodeId: "ep_0001",
  sceneId: "sc_0001",
  shotId: "sh_0001",
  slotId: "slot_sh_0001_clip",
  sourceRevisionId: "src_…",
  styleAnchorRevision: "bible_…",
  characterAssetRefIds: ["assetref_…"],
  sceneAssetRefIds: ["assetref_…"],
  voiceProfileIds: ["vp_…"],
};
```

### 3.2 Shot、Take、Candidate 和 Approval

`GenerationSlot.candidates[]` 仍然保留，作为历史候选的底层数组；产品层再增加一层可读的尝试和采用关系：

```text
Shot
  ├─ Take A（首轮生成）
  │    ├─ Candidate 1
  │    ├─ Candidate 2
  │    └─ Approval: candidate 2
  └─ Take B（从 A 的候选分叉重试）
       └─ Candidate 3
```

- `Shot` 描述剧情中的一个可拍摄镜头，不因重拍改变身份。
- `Take` 表示一次完整生成尝试或从某个已批准结果分叉出的续接链。
- `Candidate` 是具体 Job 产生的 Artifact，失败、重试和换模型都不覆盖历史。
- `Approval` 是人工或自动模式下的采用指针；只有它可以改变下游输入。

页面默认展示 Shot 卡片和 Take/Candidate 选择，不展示 ComfyUI 节点图。Agent 也必须先读取当前 Approval，再决定续接、重试或重新开链。

### 3.3 H3 continuation chain

H3 续接是一个 Provider 能力，不是把整集塞进一个长 Job。每个 segment 都登记为独立 Job/Artifact，并通过 `continuationChainId` 与父产物连接：

```text
Take
  └─ ContinuationChain
       ├─ Segment 0 → Job → Artifact
       ├─ Segment 1 → Job → Artifact（parent = Segment 0）
       └─ Segment 2 → Job → Artifact（parent = Segment 1）
```

最小续接元数据：

```js
{
  continuationChainId: "cc_…",
  segmentIndex: 1,
  parentArtifactId: "art_…",
  contextArtifactId: "art_latent_…",
  overlapFrames: 22,
  extensionFrames: 119,
  resolution: "736x576",
  fps: 24,
  audioSampleRate: 32000,
  seamMetrics: { audioCorrelation: null, rmsStepDb: null, freezeDetected: null }
}
```

产品文案使用“可恢复的多段 H3 连续生成”，不承诺无限无损。连续运动、环境声和同一镜头的动作可以续接；剧情转折、音乐换段和新构图必须允许重新开链。每条链需要支持从任一已批准 Segment 分叉重试。

### 3.4 Skill、Compiler、Provider 三层

外部 `drama-skills`、`shuohao-skills` 和 `director-skills` 的共同启示是：创作事实、电影执行和模型适配必须分层。

```text
Skill          → StoryBible / AssetBible / ShotPlan / DialogueBook
Project        → 保存事实、版本、候选和审批
PromptCompiler → Creative Intent → Cinematic Execution → Model Adaptation
Provider       → Qwen Image / MiniMax H3 / Qwen3-TTS / FFmpeg
```

Skill 不直接写 ComfyUI；Provider 不重新决定剧情；Prompt Compiler 的模型适配仍是后端内部机制，用户只确认剧情、分镜和候选结果。

`productionContext` 是 Job 元数据和输入指纹的一部分，不把整本剧本或图片字节复制到 Job。图片、视频、音频只通过 `Artifact` URL/ID 引用。

### 3.2 Canvas 是生产事实的可视化投影

Canvas 继续保留浏览器高频编辑的优势，但必须增加项目绑定：

```text
Canvas
 ├─ projectId
 ├─ episodeId? / sceneId? / shotId?
 ├─ nodes / connections / viewport / chatSessions
 └─ refs: { artifactId, assetRefId, shotId, role }
```

规则如下：

1. Canvas 可以编辑分镜、排列参考图、发起局部生成，但不能直接写 `Project.script`、`Shot.selected` 或 `Deliverable`。
2. Canvas 生成结果先作为 `Artifact` 和候选返回；用户点击“加入项目/采用”后，才调用 Project API 更新 `GenerationSlot` 或 `AssetRef`。
3. 没有 `projectId` 的旧式画布仍可作为临时草稿，但只能进入工作台试验链，不能被当作正式项目产物。
4. 画布节点保存 `artifactId`/`assetRefId` 等引用，不保存 base64 和重复文件。
5. “导出资料包”入口放在 Project/后期工作区，Canvas 只提供“打开对应镜头/资产”的跳转。

### 3.3 Workflow 与 Tool 的边界

`Workflow` 只描述生产逻辑：阶段、依赖、门禁、产物契约、默认 Tool。`Tool` 只描述一次调用：模板、输入槽、模型能力、资源类别和参数 schema。

例子：

```js
const workflow = {
  id: "short-film-local",
  version: "1.0.0",
  stages: [
    { id: "script", requires: [], tools: ["llm.script"] },
    { id: "storyboard", requires: ["script"], tools: ["llm.storyboard"] },
    { id: "design", requires: ["script"], tools: ["image.qwen21.edit"] },
    { id: "casting", requires: ["design"], tools: ["voice.qwen3.custom"] },
    { id: "keyframe", requires: ["storyboard", "design", "casting"], tools: ["image.qwen21.edit"] },
    { id: "audio", requires: ["storyboard", "casting"], tools: ["audio.qwen3.tts"] },
    { id: "assembly", requires: ["keyframe"], tools: ["video.minimax.h3.fl2va"] },
  ],
};

const tool = {
  id: "video.minimax.h3.fl2va",
  template: "video_h3_i2v_fl",
  resourceClass: "gpu",
  inputSlots: ["first_frame", "last_frame", "ref_images"],
  output: "video",
};
```

不要让前端通过模板文件名判断业务逻辑。前端读取 `/api/pipeline/stages`、`/api/model-registry` 和项目上下文；模板能力由服务端注册表和 schema 决定。

## 4. 页面如何重新分工

### 4.1 项目工作区：正式生产控制台

项目页面是唯一的正式生产入口，按集和镜头展示：

1. 规划/剧本：源版本、风格圣经、剧本和风险提示。
2. 分镜：Scene/Shot 编辑、台词归属、画上文字、机位和节奏。
3. 资产：角色、场景、道具、透明图、文字事实和采用版本。
4. 角色定妆：角色身份卡、正脸/三视图、VoiceProfile，确认后才能下游。
5. 关键帧：按 Shot 批量生图、候选比较、选中 start/end/key 帧。
6. 视频与后期：H3 片段、TTS、音轨、字幕、粗剪、导出。
7. 项目画布：打开当前 Project 绑定的 Canvas。

页面动作都要带 `projectId`，阶段动作还要带 `runId`。页面不直接拼 ComfyUI workflow，不直接调用外部模型。

### 4.2 生图/生视频工作台：试验台和候选来源

工作台保留，因为它适合快速试模型和试参数，但要明确两种模式：

| 模式 | 行为 |
| --- | --- |
| 独立试验 | 无 Project 上下文，只产生 Job/Artifact，结果进入工作台历史 |
| 项目试验 | 从项目镜头进入，预填 Shot 的事实和参考图；结果作为该 Slot 的新候选，但仍要用户采用 |

工作台禁止直接把结果标成项目当前版本。它只提供“加入项目候选”“设为采用”“打开所属镜头”三个项目动作。

### 4.3 Canvas：可视化编排，不再是第三条生产链

Canvas 的价值是“看见关系”和“局部调整”：

- 节点展示 Project 的剧本、Shot、AssetRef、Artifact 和 Job 状态。
- 连接表示引用关系，例如“这个镜头使用这个角色定妆图”。
- Agent 可以批量创建/调整节点和连接，也可以批量提交 Project API 的编辑操作。
- 生成按钮提交 `GenerationIntent`，结果回填为 Artifact 节点；不再浏览器直连模型。
- Project 阶段状态和 Canvas 节点状态分别显示，不能用节点颜色伪造阶段完成。

## 5. 统一提交链的核心实现

### 5.1 GenerationIntent

这是本次整改最值得先实现的最小公共对象。它不是新的“大框架”，只是把已经存在的三条提交路径收敛到同一份输入。

```js
// canvas-server/src/generation-intent.js
export function createGenerationIntent(input = {}) {
  const context = input.context || {};
  return {
    id: input.id || `intent_${Date.now().toString(36)}`,
    source: input.source || "workbench", // project | canvas | workbench
    kind: input.kind,                     // image | video | audio | post
    projectId: context.projectId || null,
    episodeId: context.episodeId || null,
    sceneId: context.sceneId || null,
    shotId: context.shotId || null,
    slotId: context.slotId || null,
    runId: context.runId || null,
    stageId: context.stageId || null,
    toolId: input.toolId || null,
    template: input.template || null,
    facts: structuredClone(input.facts || {}),
    references: [...(input.references || [])],
    params: { ...(input.params || {}) },
    options: { ...(input.options || {}) },
  };
}
```

服务端提交函数只做四件事：校验上下文、解析 Tool、编译提示词、创建 Job。它不负责页面响应，也不负责写 Project 业务状态。

```js
export async function submitGenerationIntent(intent, deps) {
  const tool = deps.registry.requireTool(intent.toolId || intent.template, intent.kind);
  deps.registry.assertContext(tool, intent);
  const compiled = await deps.promptCompiler.compile({
    kind: intent.kind,
    template: tool.template,
    facts: intent.facts,
    references: intent.references,
  });
  const job = deps.jobs.enqueue({
    kind: intent.kind,
    template: tool.template,
    params: { ...intent.params, PROMPT: compiled.prompt },
    meta: {
      source: intent.source,
      projectId: intent.projectId,
      episodeId: intent.episodeId,
      sceneId: intent.sceneId,
      shotId: intent.shotId,
      slotId: intent.slotId,
      runId: intent.runId,
      stageId: intent.stageId,
      toolId: tool.id,
      promptVersion: compiled.version,
    },
  });
  return job;
}
```

这段代码是给 Kimi/千问的结构参考，不要求照抄变量名。必须保持的行为是：提示词编译发生在入队前、Job 带完整归属、产物回写沿用现有 `Job → Artifact → Candidate` 投影。

### 5.2 三个入口的接线方式

| 入口 | 现有入口 | 整改动作 |
| --- | --- | --- |
| 生图工作台 | `POST /api/images/enqueue` | 内部改为构造 `GenerationIntent(source="workbench", kind="image")`；保留原接口，避免前端一次性重写 |
| 生图/生视频通用接口 | `POST /api/generate/image`、`/api/generate/video` | 内部改为同一提交函数；保留 `kind` 路由，只把 body 转成 Intent |
| 流水线 | `POST /api/pipeline/runs/:id/steps/:stage/run` | `pipeline.js` 继续编排，但每个生成槽通过 Intent 提交；阶段状态和投影逻辑不搬到 Tool 里 |
| Canvas | 当前有浏览器直连遗留路径 | 改成调用通用网关接口，加入 `source="canvas"`、`projectId` 和可选 Shot 上下文 |

不要先新建四个 `/api/projects/:id/generate-*` 接口。先让已有接口共享提交函数，等归属和错误语义稳定后再决定是否增加项目专用别名。

## 6. 阶段整改顺序

### M0：阶段和契约对齐

目标：消灭 7 段/5 段/6 段并存。

- `skills/registry.json` 作为阶段定义源。
- `gates.js` 读取同一份阶段 ID，补齐 `casting`、`audio`。
- 前端 `use-pipeline-run.ts` 删除旧 `FALLBACK_STAGES`；服务端不可达时显示 unknown，不用旧数组放行。
- `workspaces.ts` 的 `requires` 从阶段元数据读取，不能手写另一份。
- 保留冻结 ID：`script → storyboard → design → casting → keyframe → audio → assembly`。
- `post` 作为交付后期，不伪装成 run 阶段。

**验收指标**：

1. `GET /api/pipeline/stages`、`GET /api/projects/:id/gates`、前端工作区显示的阶段 ID 集合完全相同。
2. 未确认 casting 时，keyframe 和 audio 都返回 `blocked`；服务端门禁不可达时前端不放行。
3. 新增阶段只改 registry 和对应 Tool，不需要修改三套前端数组。

### M1：统一生成提交链

- 新增 `generation-intent.js` 和一个最小 submit 模块。
- 改造 `workbench-jobs.js`、`submitGeneration`、`pipeline.js` 三个调用方。
- 所有 Job 都写入 `source/kind/projectId/shotId/slotId/stageId/toolId`。
- 所有生图、生视频请求都在服务端进入提示词编译器。
- 所有本地生成继续使用现有 GPU 队列，不建立第二个队列。

**验收指标**：

| 检查 | 通过标准 |
| --- | --- |
| 三入口一致性 | 同一组事实从流水线、工作台、Canvas 提交，最终 Job 的 `template`、编译版本、参考槽位语义一致 |
| 归属完整性 | 任意 Job 可通过 `projectId → shotId → slotId` 找回所属镜头；独立试验的 `projectId` 为空但仍可查看 |
| 提示词内部化 | 浏览器网络和界面不出现最终编译提示词；服务端 Job 参数和日志可排查 |
| 失败降级 | LLM 编译失败时仍产生同步结构稿并记 warning，不能产生空 prompt 或卡死队列 |

### M2：Canvas 接入 Project

- Canvas 创建或打开时记录 `projectId`，项目页能列出 `canvasIds`。
- 节点引用改用 `artifactId/assetRefId/shotId`，不再把图片 base64 当生产数据。
- Canvas 生成统一走网关；Job 完成后回填 Artifact 节点。
- 增加“加入项目候选”和“采用到镜头”动作，分别调用 AssetRef/GenerationSlot API。
- Project 页面可从 Shot 反向打开 Canvas 对应位置。

**验收指标**：

1. 在项目 Canvas 生成一张图，刷新浏览器和重启网关后，节点仍能显示同一 Artifact。
2. 生成结果不会自动成为 selected；点击采用后，Project 的 `selectedArtifactId` 才改变。
3. 删除 Canvas 节点不会删除仍被 AssetRef/Shot 引用的服务端 Artifact。
4. 无 Project 的独立 Canvas 仍可试验，但不能出现在项目交付包中。

### M3：工作台与项目双向进入

- 项目镜头提供“在生图/生视频工作台打开”入口，传入只读上下文快照。
- 工作台完成后提供“加入项目候选”，不复制文件，只登记 Artifact 引用。
- 从工作台历史可返回 Project/Shot；从 Project 进入时显示当前 Shot 的角色、场景、首尾帧和文字事实。
- 参数面板只显示用户可调整的模型参数，不显示提示词编译器内部机制。

**验收指标**：工作台换模型生成候选后，旧候选仍可播放；采用/撤销采用可重复执行；刷新后项目和工作台的候选数量一致。

### M3.5：Shot / Take / Approval 与 H3 continuation

- 在不破坏现有 `GenerationSlot.candidates[]` 的前提下增加 `takeId`、采用指针和父候选关系；重跑、换模型和续接都创建新 Candidate，不覆盖历史。
- 新增 H3 continuation Provider 的能力描述：是否支持 native Masked AV、latent context、首尾帧、音频参考、帧网格、分辨率锁和降级路径。
- 续接 Job 写入 `continuationChainId`、`segmentIndex`、`parentArtifactId`、`contextArtifactId`、重叠/新增帧、音频采样率和接缝指标。
- 先做本机能力探测，再比较官方 Add Guide、原生 Masked AV 候选、latent-tail Continuation 和 Motion Context；任何外部 custom node 只作为 Comfy Provider，不复制代码进主仓库。
- 每 2～4 个 Segment 提供一次审核点；接缝、链深衰减或剧情转折不合格时，允许从已批准 Segment 重新开链。

**验收指标**：

| 检查 | 通过标准 |
| --- | --- |
| 链结构 | 10 段续接仍能按 `chain → segment → parent Artifact` 完整回溯 |
| 可恢复性 | 中断后从最近 checkpoint 继续，不重复创建已完成 Job |
| 分叉 | 从任一已批准候选重新续接，不修改原链历史 |
| 接缝观测 | 每个连接点都有音频相关性、响度突变、冻结检测和人工复核结果 |
| 硬件 | 16GB GPU 在固定分辨率、串行队列下无未解释 OOM |

### M3.6：Skill 事实对象和 Provider 能力注册

- 将创作 Skill 的输出统一映射为 `StoryBible`、`VisualBible`、`CharacterBible`、`SceneBible`、`PropBible`、`DialogueBook`、`ShotPlan`、`ReviewReport` 和 `DeliveryManifest`。
- Provider 注册表声明参考槽位、时长/帧网格、分辨率、音频、续接、显存和失败降级能力；前端不按模板文件名写分支。
- 所有 Skill 和 Provider 版本都写入 Project/Run provenance，外部内容登记许可证和 revision。

**验收指标**：同一份 ShotPlan 可以分别编译成 Qwen Image、MiniMax H3 和 Qwen3-TTS 请求；Provider 不支持的参考槽位在入队前 400/409，不把能力错误留给模型。

### M4：声音和后期闭环

- `audio` 阶段按 `VoiceProfile` 生成每句 `AudioCue`，结果作为独立对白轨。
- H3 片段默认不把原生对白当最终事实源；原生声音最多作为候选。
- `post` 由 CPU/ffmpeg 负责对白、环境声、音效、BGM、字幕、拼接和导出。
- 口型同步只由用户对具体镜头显式开启；失败只影响该增强候选。

**验收指标**：修改一句台词只重跑对应 TTS、字幕和后期；视频画面 Job 不重跑；没有对白的镜头没有 TTS Job；最终成片只有一个对白事实源。

### M5：Agent 驱动的批量生产和恢复

- Agent 通过 Project 作用域工具读取 Shot/Take/Approval、阶段门禁和 Job 状态。
- “批量生成”先返回计划摘要和预计 Job 数，再经确认入队；坏镜头只重试对应 Take，不重跑整集。
- 断线、重启和取消后，Agent 从 Project/Job 状态恢复，不以浏览器 localforage 或对话文本作为事实源。

**验收指标**：Agent 能完成“读取项目 → 生成计划 → 用户确认 → 批量入队 → 等待 → 只重试失败镜头 → 采用候选”，重复调用不重复入队。

### M6：60～90 秒真实闭环

选择一个 6～12 镜头的小故事，必须经过真实 Project，不允许只用工作台拼接；至少包含一条 2～4 段 H3 continuation chain 和一条重新开链的镜头边界：

```text
创建 Project → 导入故事 → script → storyboard
→ design/casting → keyframe → audio 与 assembly
→ Take/Approval → H3 continuation 或重新开链
→ post → 成片 + 分段 + 字幕 + 时间线 + manifest
```

## 7. Agent：保留本地桥接，补上 Project 生产作用域

### 7.1 现有链路是什么

当前 Agent 不是浏览器内置的一个普通聊天组件，而是一条本地桥接链：

```text
浏览器 Agent 面板
  └─ SSE / HTTP + localhost token
       └─ canvas-agent
            ├─ Codex app-server 适配器
            ├─ MCP 工具服务
            └─ 按 clientId / threadId / turnId / itemId 管理会话
                 └─ 浏览器执行 canvas op，并回传结构化结果
```

`canvas-agent` 负责传输、会话绑定、工具校验、审批和超时；浏览器负责真正修改 Canvas 状态。`canvas_apply_ops` 先在浏览器生成一份撤销快照，再批量执行节点、连线、视口和选中态变化，因此这部分已经具备“可视化、可回退、按标签页隔离”的基础，不应推倒重写。

目前的工具可以读写 Canvas，也可以触发生图、生视频和资产工作台。但这些工作台工具主要读写浏览器 Zustand/localforage 状态，`generation_get_status` 也没有把服务端 Project 的 Job、Artifact 和 AssetRef 作为权威来源。这意味着当前 Agent 是“Canvas 操作 Agent”，还不是“短剧生产 Agent”。

### 7.2 必须拆成两个作用域

保留同一个本地 Agent 入口，但把工具明确分成两个作用域：

| 作用域 | 工具前缀 | 能做什么 | 权威写入方 |
| --- | --- | --- | --- |
| Canvas 编辑 | `canvas_*` | 读取节点、排版、批量建连线、把项目产物铺到画布、撤销 | 浏览器 Canvas 编辑态 |
| Project 生产 | `project_*` | 读取项目/集/场/镜、查看门禁、启动或取消阶段、查看 Job/Artifact、采用候选、导出资料包 | `canvas-server` Project/流水线 API |

Canvas 工具可以继续使用结构化 op；Project 工具不能直接改 localforage，也不能绕过阶段门禁去调用 ComfyUI。它们必须调用正式的 Project API，沿用 `GenerationIntent → Job → Artifact → AssetRef`，并把操作记录到项目审计日志。

第一批 Project 工具只需要覆盖生产闭环：

```text
project_get_context
project_get_stage_status
project_get_job_status
project_run_stage
project_cancel_job
project_adopt_candidate
project_export_delivery_package
```

`workbench_*` 继续保留给独立试验；当 Agent 已经处在 Project/Shot 上下文时，正式生产不得静默改走旧的工作台直连路径。

### 7.3 Canvas 快照字段必须纠正

现有 `CanvasAgentSnapshot.projectId` 实际装的是 Canvas id，会把画布 id 和 Project id 混在一起。应改为：

```js
const agentContext = {
  canvasId: "can_…",
  productionContext: {
    projectId: "prj_…",
    episodeId: "ep_…",
    sceneId: "sc_…",
    shotId: "sh_…",
    runId: "run_…",
    stageId: "keyframe"
  }
};
```

`canvasId` 是编辑表面的身份，`productionContext` 是当前生产事实的引用；两者都不能省略或互相冒充。Project 页面进入 Canvas 时同步这份上下文，Agent 工具调用时校验上下文是否仍与当前标签页一致，避免多标签页串项目或把某集的候选写到另一集。

### 7.4 权限、幂等与审计

现有 `confirmTools` 只覆盖少数 Canvas 写工具，无法保护 `workbench_image_generate`、`workbench_video_generate`、`assets_add` 等有副作用的调用。统一按风险分级：

| 风险级别 | 示例 | 默认行为 |
| --- | --- | --- |
| read | 读取状态、门禁、注册表、Job、Artifact | 自动执行 |
| canvas_write | 建删节点、改连线、改视口 | 可配置确认；始终可撤销 |
| production_write | 修改剧本/分镜引用、采用候选、修订阶段产物 | 必须确认，并带版本号 |
| compute_start | 跑阶段、生成图/视频/音频、重试 | 必须确认；返回 Job id |
| export | 导出资料包或写入外部位置 | 必须确认；返回下载/清单信息 |

每个 Project 写操作至少携带 `projectId`、`expectedVersion`、`clientId`、`threadId`、`turnId`、`itemId` 和 `idempotencyKey`。服务端用乐观版本拒绝过期写入，并返回 `operationId`、前后版本、受影响的实体 id、Job/Artifact id。Agent 重试同一个 `idempotencyKey` 只能得到原结果，不能重复创建候选或重复跑批。

Agent 的输出保持摘要化：默认返回状态、实体 id、下一步和 warning；完整剧本、提示词编译稿和大快照仍由显式读取工具提供。提示词编译继续是后端内部机制，Agent 也不能把“最终编译提示词”变成面向用户的产品界面。

### 7.5 整改顺序

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| A0 | `projectId`/`canvasId` 语义纠正；Project 上下文随 Canvas 会话同步 | 多标签页切换不会串项目；旧 Canvas op 仍可撤销 |
| A1 | 7 个只读/生产工具接正式 Project API | Agent 能读到项目、阶段、Job、Artifact，而非只读浏览器任务 |
| A2 | 所有有副作用工具接统一确认、版本和幂等 | 拒绝过期写入；重复调用不重复入队/登记 |
| A3 | 工作台工具在 Project 上下文下转为统一生成入口 | Agent、Canvas、工作台、流水线生成都产生同形 `JobMeta` |
| A4 | `project_export_delivery_package` 与恢复流程 | Agent 能报告资料包缺项、导出结果和可追溯 manifest；中断后可继续 |

Agent 的验收不能只看“模型会不会调用工具”，而要从浏览器完成：读取项目 → 查看门禁 → 启动一个镜头阶段 → 等待 Job 终态 → 采用候选 → 回填 Canvas → 导出资料包。任一步只改了 localforage、没有 Project 版本和 Artifact 记录，都算失败。

## 8. Kimi/千问执行时的文件边界

按职责分工，避免多个模型同时改同一层：

| 任务 | 建议文件范围 | 不要修改 |
| --- | --- | --- |
| 阶段统一 | `skills/registry.json`、`canvas-server/src/gates.js`、`web/src/pages/pipeline/use-pipeline-run.ts`、`web/src/pages/projects/workspaces.ts` | 不改 Project 字段名 |
| 提交链统一 | 新增 `canvas-server/src/generation-intent.js`；修改 `workbench-jobs.js`、`index.js`、`pipeline.js` | 不在路由层写业务编排 |
| Canvas 接入 | `web/src/pages/canvas/*`、`web/src/stores/canvas/*`、`web/src/services/api/*`、必要的 Project API | 不把 Project 事实复制进 localforage |
| 工作台回填 | `web/src/pages/image/*`、`web/src/pages/video/*`、`web/src/services/api/*` | 不创建第二套 Job 状态机 |
| 音频闭环 | `canvas-server/src/audio.js`、`audio-track.js`、`pipeline.js`、`delivery.js`、`skills/06-audio` | 不把口型模型设成默认依赖 |
| 交付验证 | `canvas-server/src/delivery.js`、`edit-export.js`、项目后期工作区 | 不把精剪时间线搬进网页 |

每个任务都必须引用本文件对应的 M0～M6（涉及续接或能力注册时同时注明 M3.5/M3.6），并在提交说明中写明：改了哪个事实链、哪些接口、哪些验证指标通过。

## 9. 端到端验证策略

### 9.1 单元与契约验证

- Registry、gates、workspace 三处阶段集合做集合相等断言。
- GenerationIntent 缺少 `kind/template`、Project 上下文引用不存在、Tool 不支持参考槽位时，提交前 400/409，不能进入队列。
- Job 元数据必须通过 schema 校验；`projectId/shotId/slotId` 不允许只写在 prompt 或文件名里。
- Prompt compiler 失败时检查 `warning` 和同步稿，禁止空提示词、`[untranslated]` 泄漏到用户界面。
- `Artifact → Candidate → AssetRef` 重放两次结果必须幂等，不能重复候选或重复登记。
- `Take` 分叉不得修改原 `Candidate`/`Approval`；相同 `idempotencyKey` 重放不得创建新的 Job。
- continuation 元数据必须能校验父产物、链序号、分辨率锁和音频采样率；Provider 不支持的能力在入队前返回 400/409。

### 9.2 真实网关验证

每个里程碑都要用真实 HTTP 和真实队列完成至少一次，不接受只测纯函数：

```bash
GET  /api/pipeline/stages
GET  /api/projects/:id/context
POST /api/images/enqueue
POST /api/generate/video
POST /api/pipeline/runs/:id/steps/:stage/run
GET  /api/jobs/:jobId
GET  /api/pipeline/runs/:id
POST /api/projects/:id/asset-refs/:refId/select
```

真实验证必须记录 `projectId/runId/shotId/jobId/artifactId`，并保存一份脱敏响应快照。GPU 队列验证结束后确认没有遗留 running/pending 任务。

### 9.3 指标门槛

| 指标 | 首版门槛 |
| --- | --- |
| 阶段定义一致性 | registry、gates、workspace 100% 集合相等 |
| 任务归属完整率 | 真实生成 Job 100% 可回溯到 source；Project 任务 100% 有 `projectId`，镜头任务 100% 有 `shotId/slotId` |
| 产物回写 | 成功 Job 100% 出现 Artifact；重启重放不重复登记 |
| 候选保留 | 重跑不删除旧候选；候选数量与实际成功 Job 数一致 |
| Take/Approval 可追溯 | 每个采用结果能回溯到 Take、Candidate、Job、Artifact；从已批准候选分叉不改写原链 |
| H3 续接可恢复 | 中断后从最近 checkpoint 继续，已完成 Segment 不重复入队；链深和接缝指标完整 |
| 提示词编译 | 所有图像/视频正式请求都经过后端编译；失败有 warning，空 prompt 为 0 |
| 门禁正确性 | 上游未完成时阻断率 100%；网关不可达时误放行率 0 |
| 画布持久性 | 刷新和网关重启后引用 Artifact 成功率 100% |
| 音频事实源 | 最终成片每句对白只能来自一个 `AudioCue`；无对白镜头不产生 TTS |
| 交付完整性 | 缺片段、缺音频、缺字幕时不能标记 `ready`；manifest 能列出每个输入 |
| 硬件纪律 | 本地 GPU 同时运行数 ≤1；验收期间无 VBAR OOM 或未解释的显存争抢 |

### 9.4 用户视角验收

必须从浏览器完成一条完整动线：

1. 新建 Project 并导入故事。
2. 进入分镜工作区，打开对应 Canvas。
3. 在 Canvas 生成一张候选图，返回项目并采用它。
4. 在项目关键帧工作区确认一镜首帧/尾帧。
5. 进入视频工作区生成 H3 片段，并在音频工作区确认角色音色。
6. 从一个已批准候选续接 2～4 个 H3 Segment，并在中断后恢复；从中间 Segment 分叉重试，确认原链不变。
7. 修改一句台词，确认只重跑音频与后期，不重跑 H3。
8. 导出交接包，检查成片、分段、字幕、时间线和 manifest。
9. 刷新页面、重启网关后再次打开项目，确认所有引用和状态一致。

任何一步只能通过 curl 或后台数据完成，都算未完成。

## 10. 暂不做的事情

- 不把 Canvas 变成第二个 Project 数据库。
- 不为每个页面建立单独的 Job/Artifact 状态机。
- 不在前端暴露模型提示词编译过程。
- 不把 H3 原生音频、口型同步、CosyVoice、ACE-Step 放入第一版默认链路。
- 不先做站内专业时间线编辑器。
- 不为了兼容旧画布数据增加迁移层。

完成 M0～M6 后，再评估是否需要更重的 Canvas 服务端持久化、口型增强、音乐生成和多语言发行。

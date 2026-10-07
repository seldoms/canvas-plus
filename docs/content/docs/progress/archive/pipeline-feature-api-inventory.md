# 影视流水线功能与后端接口清单

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


本文按当前工作区的路由和业务实现核对，供前端重新规划使用。接口存在不代表前端已接通，也不代表真实媒体质量已验收；不以旧开发文档的完成标记作为事实依据。

## 1. 生产对象与入口

生产主轴：项目 → 集 → 场景 → 镜头 → 关键帧 / 台词音频 / 视频候选 → 成片与交付包。

- 项目级：原文版本、风格、画幅、目标集数、单集时长、声音路线、共享角色/场景/道具。
- 集级：剧情、场次、镜头顺序、对话与交付物；继承项目默认值，可有本集覆盖。
- 镜头级：画面、动作、景别、运镜、人物、背景、对白、计划与实测时长、参考素材、生成候选和采用版本。
- run：一次执行记录，可有历史与分支；它不是项目，也不是集。

现行注册表是七段：script / storyboard / design / casting / keyframe / audio / assembly。项目准备与最终交付需要独立操作，但不能据此声称后端有八个注册阶段。design 与 storyboard 都依赖 script，audio 与 keyframe 可在依赖满足后分别生产；页面的横向顺序不能替代实际依赖关系。

## 2. 功能清单

| 功能区 | 应具备的功能 | 应显示的成果 | 当前后端支持与边界 |
| --- | --- | --- | --- |
| 项目与集 | 选择/创建项目；选择/新建集；恢复该项目的执行记录；读取项目默认值和本集覆盖 | 项目事实、集列表、当前 run 与版本 | 有项目/集 CRUD、context、run 列表；仅保存 options.episodeId 尚不能让通用阶段只生产这一集；完整制作配置快照未完成 |
| 原文与项目设定 | 导入/查看原文版本；编辑风格、画幅、时长、题材、声音路线；确认共享设定 | 原文、项目规划、角色/世界/声音设定 | 有 sources、项目 PATCH、bibles 创建/编辑/审核/锁定接口；制作设定的版本绑定需继续接通 |
| 剧本 | 选择文本模型；生成/续跑；阅读主线、梗概、人物与逐集剧本；编辑保存；重跑 | 可读剧本与集/场结构 | 有阶段执行、分块进度与续跑、整体产物写回；无专用逐集剧本生成/局部改稿接口 |
| 分镜 | 按集/场展开镜头；同时查看画面、动作、对白、背景、时长；新增、编辑、调序 | 镜头表和完整对白轮次 | 有集/场/镜 CRUD、项目镜头编辑、run 分镜定点编辑；项目与 run 两处编辑的同步关系必须核实 |
| 服化道 | 编辑角色外观、服装、场景、道具；选择图像模型；生成与查看参考图；采用素材 | 角色正脸/三视图、场景母版、道具设定/素材 | 有 LLM 设定生产及角色/场景参考图入队、AssetRef 管理；不是只选一个生图模型就完成全部工序；design 没有通用逐条 regenerate 通路 |
| 角色定妆 | 查看角色身份卡；定脸；选择音色/语言/表演描述；试听；分别确认脸与声 | 人物参考图、可播放声音样本、确认状态 | 有 casting 确定性身份卡、确认接口、音色列表与试听；不需要再选 LLM；speed 字段接受/保存不等于音频执行体已消费 |
| 关键帧 | 按镜头展示画面内容和参考素材；起/关键/尾帧预览；生成、单项重跑、失败重试、候选比较与采用 | 带镜头语义的图板、候选历史、采用状态 | 有生成、再生成、失败批量重试、按参考素材聚合、项目槽位采用；跨 run 与槽位采用同步需验收，换模型参数生成有待修问题 |
| 配音 | 逐句显示说话人/台词/表演；试听与生成；查看实测时长、先后轮次；单句重录、调整声音 | 台词音频及角色/镜头/时间轴归属 | 有阶段 TTS、音色试听、实测时长投影；audio 的通用单项重跑实现未正确读取 audio[]；语速控制、音量编辑未形成完整前端闭环 |
| 视频片段 | 每镜对照关键帧、动作和台词；选择可消费当前素材的视频能力；播放、重跑、比较、采用 | 视频候选，声音路线、实测长度与口型处理状态 | assembly 阶段生成 clips，有视频逐项重跑和候选；H3 Talk 为受限路径；LatentSync 不在默认阶段注册表中，不能宣称默认口型闭环可用 |
| 成片与交付 | 按采用片段重排/拼接；预览成片；生成独立字幕；下载素材包、交换格式和清单 | MP4、SRT、关键帧/片段、FCPXML/EDL、ZIP、manifest | 有 assemble 与 export 独立接口；export 可指定 episodeId；不是 clips 全 done 就代表成片完成；无站内精剪时间线 |
| 运行与恢复 | 查看排队/运行/失败原因；取消；重试失败项；恢复历史；从指定阶段分支 | 阶段进度、任务与候选、父子 run 关系、审计日志 | 有相应 run/Job 接口；无全流程自动推进接口；run 改名目前是浏览器历史别名，没有服务端重命名接口 |
| 质量与影响 | 展示缺参考图、缺定妆、对白超时/重叠；质检重跑；改稿前查看影响范围 | 门禁原因、QC 报告、受影响镜头/音频/交付物 | 有 gates、QC、impact；QC 尚不能客观判断声纹一致和嘴型同步；impact 只分析，不自动执行分支 |
| 续接（可选） | 视频多段续接、分叉、恢复、接缝复核、采用 take | 链/段及接缝报告 | 有独立 continuation 接口；不承诺无限长生成与跨段对白/口型质量 |

所有阶段都应就地看到：输入内容、可编辑的内容事实、适用模型、当前成果、产生中的任务、失败原因、局部重做入口和采用版本。模型提示词编译属于后端内部机制，不应做成用户必须理解或填写的步骤。

## 3. 已注册接口

以下缩写仅为表格易读，拼接后为真实路径：

- `P = /api/projects/:id`
- `R = /api/pipeline/runs/:id`
- `S = R/steps/:stage`
- `H = P/shots/:shotId`

### 项目、来源与集/场/镜

| 方法与路径 | 功能 / 主要参数 |
| --- | --- |
| `GET /api/projects` | 项目列表；`includeArchived=1` 可含归档 |
| `POST /api/projects` | 建项目：title、styleAnchor、plan、script 等 |
| `GET P` | 项目详情 |
| `PATCH P` | 修改项目；支持 expectedVersion 乐观版本校验 |
| `POST P/archive` | 归档项目 |
| `GET P/context` | 项目上下文、集索引、runIds 等；`include=refs` 加资产与门禁 |
| `GET P/sources` | 源版本摘要列表 |
| `POST P/sources` | 保存不可变源版本 |
| `GET P/sources/:revisionId` | 读取原文版本 |
| `GET P/episodes` | 集索引列表 |
| `POST P/episodes` | 建立/保存集 |
| `GET P/episodes/:episodeId` | 集详情，现行存储含 scenes[] 与集级 shots[] |
| `POST P/episodes/:episodeId` | 修改集标题、梗概、plan、状态等 |
| `POST P/episodes/:episodeId/scenes` | 增加场景：locationId、time、intent 等 |
| `POST P/episodes/:episodeId/reorder` | 集内调序；请求体按 episodes.reorder 实现 |
| `POST P/scenes/:sceneId` | 修改场景 |
| `POST P/scenes/:sceneId/shots` | 增加镜头，storyboard 为内容容器 |
| `PATCH/POST H` | 修改镜头：sceneId、index、storyboard、status；内容字段放 storyboard 内 |

没有发现集/场/镜对应的 DELETE 路由，不将“删除镜头”等列为现有接口能力。

### 执行、编辑与重跑

| 方法与路径 | 功能 / 主要参数 |
| --- | --- |
| `GET /api/pipeline/stages` | 七段定义、依赖与产物键 |
| `GET /api/pipeline/runs` | 执行记录列表；当前路由无项目/集过滤参数 |
| `POST /api/pipeline/runs` | 建 run：novel 必填，title、options 可选；projectId 放 options |
| `GET R` | 完整 run：阶段输出、候选、产物、estimate 等 |
| `GET R/progress` | 轻量阶段进度与 inflight；不代表 GPU 节点级真实百分比 |
| `GET R/gates` | 当前 run 的真实产物门禁 |
| `POST S/run` | 阶段生成/重跑：model、resume 等；返回 202 后后台执行 |
| `POST S/cancel` | 取消阶段及已入队任务 |
| `POST S/input` | 保存 inputs，或整体替换 output；不是专用可视化编辑接口 |
| `PATCH/POST S/shots/:shotId` | run 内分镜局部编辑；只支持 storyboard |
| `POST S/regenerate` | 单项候选追加：itemId、template、params、promptOverride；keyframe/assembly 有主要实现，audio 有缺陷 |
| `POST S/retry-failed` | 批量重试失败项：limit；当前条目读取主要针对关键帧/视频 |
| `POST R/fork` | fromStage、title、options；复用上游，重置指定阶段及下游，保留父 run |
| `GET R/log` | 审计记录；可带 limit |
| `GET R/frames/by-reference` | 按真实引用聚合关键帧；可带 stage |

`promptOverride` 是现有后端入参，不表示前端应暴露模型编译后的提示词。

### 模型、音色与定妆

| 方法与路径 | 功能 / 主要参数 |
| --- | --- |
| `GET /api/model-registry` | 分类、启用状态、base/task、别名与元数据；按 category、enabled 过滤，是模型选择的权威读源 |
| `GET /api/providers` | LLM 清单与 Comfy 模板 token、时长、规格、音色等执行元数据；不能替代注册表启用状态 |
| `GET /api/llm/models` | 静态登记的文本模型清单 |
| `GET /api/durations` | 模型时长推荐档与帧规则 |
| `GET /api/tts/voices` | 命名音色与语言列表；可带 template |
| `POST /api/tts/preview` | speaker、language、design、text 等；返回音频 URL、artifactId、jobId。speed 被校验但未进入该处 TTS 参数 |
| `POST R/steps/casting/confirm` | characterId、face/voice 确认、speaker、design、language、speed、previewArtifactId；确认失败应显示原因 |

模型管理另有 `POST /api/model-registry`、`POST /api/model-registry/sync`、`GET /api/model-registry/available`、`PATCH/DELETE /api/model-registry/:id`，属于配置管理，不需要塞入生产步骤。

### 素材、候选、任务与质量

| 方法与路径 | 功能 / 主要参数 |
| --- | --- |
| `GET/POST P/asset-refs` | 按 role 读素材引用 / 建引用 |
| `PATCH/POST P/asset-refs/:refId` | 修改素材引用 |
| `POST P/asset-refs/:refId/select` | 采用素材产物 |
| `POST P/asset-refs/:refId/unlink` | 解除引用，区别于删除磁盘文件 |
| `GET P/asset-consistency` | 项目引用一致性报告 |
| `POST H/slots/:slotId/candidates` | 用 jobId 追加已有产物为候选 |
| `POST H/slots/:slotId/select` | jobId 采用候选；jobId=null 撤销采用 |
| `GET /api/jobs` / `GET /api/jobs/:id` | 任务列表/详情、输出、失败、设备与耗时 |
| `POST /api/jobs/:id/cancel` | 取消单任务 |
| `GET /api/artifacts` | 产物列表与筛选 |
| `GET /api/artifacts/:jobId/:filename` | 原图/音频/视频/文件；图片/视频支持 variant=thumb |
| `POST /api/artifacts/import` | 本机素材入档为已完成 import Job |
| `POST /api/uploads` | 上传生成输入素材 |
| `POST /api/generate/image` / `POST /api/generate/video` | template、params、meta 直接提交统一任务链；有归属时填写项目/集/镜头/槽位 |
| `GET P/gates` | 项目层阶段门禁 |
| `GET R/qc` / `POST R/qc` | 读最近报告 / 重跑跨阶段检查；POST 可带 stage |
| `GET P/impact/options` | 可分析的变更对象 |
| `POST P/impact` | changed[] 指定 assetRef/shot/scene/script；返回 stale/keep/受影响对象，不入队 |

制作设定支持 `GET/POST P/bibles`、`GET/PATCH/POST P/bibles/:bibleId`、`POST P/bibles/:bibleId/transition`；状态操作包含提交审核、批准、驳回、锁定、重新打开与修订。

### 成片、交付与可选续接

| 方法与路径 | 功能 / 主要参数 |
| --- | --- |
| `POST R/steps/assembly/assemble` | order、transition、quality、force 等；片段拼接，已有结果可复用，新合成返回 202 |
| `POST R/steps/assembly/export` | episodeId、allowPartial、transition、steps、options；按集或全部集粗剪并打包，返回 202 |
| `GET R/steps/assembly/export` | 查导出清单与包；可带 packageId；文件通过 artifacts 路径读取 |
| `POST H/continuation-chains` | prompt、segments、seed、template、params；开续接链 |
| `GET H/continuation-chains` | 续接链与段视图 |
| `POST H/continuation-chains/:chainId/resume` | 恢复未完成链 |
| `POST H/continuation-branches` | parentCandidateId、prompt、segments 等；从完成段分叉 |
| `POST H/continuation-reviews` | jobId、reviewed、note；人工接缝复核 |

## 4. 当前必须纠正的问题

1. **项目选择与历史 run 脱节**：新组件默认选首个项目，不从恢复/切换的 run.options 恢复项目和集；禁用选择器不能解决错配。
2. **集范围未落实**：通用阶段不消费 options.episodeId 进行生成过滤；当前按集导出有独立支持，不能用它证明按集生产已实现。
3. **项目基础信息未完整冻结**：run 快照了正文和 sourceRevisionId，但 buildContext / productionDefaults 等仍读取当前项目；选择器锁定不等于制作事实版本锁定。
4. **镜头结构读错**：新组件只读 scene.shots；后端现行是 episode.shots 按 sceneId 关联。已有 useStoryboard 能处理此形状，新组件未复用，可能错误显示 0 镜。
5. **删除了编辑能力**：移除 JSON 编辑后，没有补逐阶段可读可写表单；计数摘要和只读卡片不能代替编辑、试听、确认与采用。
6. **模型来源与能力映射不正确**：新下拉读取模板清单并硬写能力组名，未按注册表 base/task、category、enabled 消费；音频模板在旧 family 分类中为 edit，可能同时进入图像列表。服化道涉及文字设定与图像生成，需要区分两次模型调用。
7. **所选模板可能未生效**：configuredTemplateForStage 读取 templateCatalog[selected].family，但 scanTemplateDir 只返回 capability/slots/tokens 等，没有 family；图像/视频选择会回落默认。已有测试通过未覆盖此问题。
8. **音频逐条重跑未接完整**：beginRegenerate 声明 audio 可用，却从 frames/clips 找条目；需正确读取 audio[] 并构造 TTS 参数。不能仅增加按钮。
9. **语速/音量不构成闭环**：试听 speed 被验证但未注入生成参数，audio 阶段也没有将 speed 写入 TTS params；混音底层有 gainDb，不代表已提供逐句音量编辑接口和页面。
10. **编辑数据有两处**：项目 Shot.storyboard 与 run.stages.storyboard.output.shots 都有写入口；保存项目镜头不等于 run 的下游自动读取新内容，必须明确同步、影响分析与重跑语义。
11. **候选采用有两处**：项目 slot.selected 与 run 条目 selected 需验证一致，避免页面采用一版、成片使用另一版。
12. **质量结论越界**：QC 能查结构、引用、对白时序；声纹、语气、嘴型需要真实媒体与人工复核。口型实验辅助函数不代表有默认可执行的注册阶段。

上一轮的“重构完成、所选模型已经接通、项目事实已经固化”不能作为验收结论；本清单登记的是待纠正事实，本轮未继续改 UI 或生成任务。

## 5. 代码依据

- `skills/registry.json`：真实阶段与依赖。
- `canvas-server/src/index.js`：注册路由、请求参数和响应形状。
- `canvas-server/src/pipeline.js`：阶段执行、素材计划、候选、配音、分支和成片。
- `canvas-server/src/episodes.js`：集/场/镜结构与可写字段。
- `canvas-server/src/tool-adapter.js`、`providers/comfy.js`、`model-registry.js`：模板能力、family、模型分类三者的区别。
- `canvas-server/src/quality-check.js`、`audio-timeline.js`、`delivery.js`：质量检查与媒体处理边界。
- `web/src/pages/pipeline/`、`web/src/pages/projects/hooks/use-storyboard.ts`：新页面接线及既有可复用实现。

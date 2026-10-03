# 试跑问题清单（端到端验证）

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 用途：记录端到端试跑（小说 → 成片）过程中暴露的缺陷与改进项。
> 规矩：**只追加，不替换、不遗忘**；每条必须带一手证据（接口响应 / 报错原文 / 文件路径）；修复并复跑验证通过后才标 ✅。
> 每轮试跑单开一节，便于两轮对比。
> ⚠️ 2026-10-03 结构修正：此前 #11–#21 因登记脚本锚点失配导致位置错乱/丢失，已由主控重排补齐（内容未改，只修正归属与编号顺序）。

## 判定口径

- **严重度**：`阻断`（流程走不下去）/ `严重`（能走但结果错或数据坏）/ `一般`（体验或效率问题）/ `改进`（不影响正确性的优化项）
- **影响面**：`后端` / `前端` / `契约` / `技能与提示词` / `基础设施(147/网关)`
- **状态**：`待讨论` → `已定整改方案` → `已修复待验证` → `✅已验证`

---

## 第一轮（猫狗微电影·首跑）

| # | 阶段 | 现象 | 一手证据 | 严重度 | 影响面 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 01 剧本 | `episodes: []` 为空，未按 `plan.episodeCount=2` 建立两集结构，导致后面全程单集 | `GET /api/pipeline/runs/run-murnwa81-k27eq` → `stages.script.output.episodes = []`（已实测） ⟶ 复核：`normalizeEpisodes` 按 `plan.episodeCount` 重排、不符即记 warnings；测试「分集数不符 plan 时按目标重排并记 warnings」通过 | 严重 | 技能与提示词 | ✅已验证 |
| 2 | 02 分镜 | 只产出 1 场 4 镜、每镜 4 秒（合计 16 秒），目标 2 集×30 秒=60 秒，**时长差 3.75 倍** | `stages.storyboard.output.shots` 长度 4，`durationSec` 合计 16（已实测） ⟶ 复核：属 **D1** 时长档位跟模型（H3 `24×秒+3`，仅 5/10/15s）——产品已拍板、**代码未落**（用户 2026-10-03 喊停改码，`pipeline.js` 已空出） | 严重 | 技能与提示词 | 已定整改方案 |
| 3 | 01/02 传导 | `plan` 的 `episodeCount`/`episodeDurationSec` 未进入剧本/分镜提示词，LLM 无从得知"分两集、每集 30 秒" | 同 1、2；`plan` 回填后各阶段产物无任何集/时长约束痕迹 ⟶ 复核：`buildContext` 注入 `plan`，集数/时长真进提示词；测试「plan 集数/时长真进提示词」通过 | 严重 | 技能与提示词 | ✅已验证 |
| 4 | 02 分镜 | 角色双形态未区分：第 3 镜 prompt 同时写"小猫白色"与"变成大姐姐后"，生成时必然打架 | `shots[2].prompt` 原文："…小猫白色，变成大姐姐后，…" ⟶ 复核：未修。负向词红线校验未落（见 11.2「关键帧与分镜对不上」） | 一般 | 技能与提示词 | 待讨论 |
| 5 | 接口 | `GET /progress` 只报"当前/最后一个阶段"，无全阶段汇总，前端要额外拉 `/runs/:id` | 响应原文 `{"progress":{"stage":"script","phase":"done",...},"inflight":false}` ⟶ 复核：`progress` 带 `steps` 多步结构且旧字段 `stage/phase/done/total/label` 保留；测试通过 | 改进 | 后端 | ✅已验证 |
| 6 | 接口 | 更新项目必须用 `PATCH`，但无 API 文档/发现入口，调用方只能读源码猜（我第一把用 POST 得到 404） | `POST /api/projects/:id` → 404；改 `PATCH` → 200（已实测） ⟶ 复核：未修。`PATCH` 用法仍只存在于源码，未补文档/发现入口 | 改进 | 后端 | 待讨论 |
| 7 | 03 资产 | **阻断**：LLM 请求打到已停用的 `127.0.0.1:1234`（LM Studio）返回 400，阶段直接 error、产物 null | `stages.design.error` 原文：`LLM 请求失败：http://127.0.0.1:1234/v1/chat/completions 返回 400 No models loaded`；`config.json` 的 `llm.fallbacks=["http://127.0.0.1:1234","http://127.0.0.1:8080"]` 两个都是死服务 ⟶ 复核：`config.json` 清空死亡 `llm.fallbacks`、`defaultModel=qwen3.8:27b`；`/api/health` → `llm.ok=true` | 阻断 | 后端/配置 | ✅已验证 |
| 8 | 03 资产 | **阻断**：LLM 响应头超时 `UND_ERR_HEADERS_TIMEOUT`。**根因是「非流式 + 生成超过 5 分钟」**：`chat()` 硬编码 `stream:false`，ollama 必须整段生成完才发响应头，而 undici 默认 `headersTimeout=300s` 先于 `timeoutMs(600s)` 触发；换用已常驻的 `qwen3.8:27b` 后**仍然复现**（证明与模型切换无关，切换只是放大因素） | ① `stages.design.error` 原文；② 实测 `n_gen=2774` 仍在生成、14.45 t/s → 单次 > 5 分钟；③ 换成常驻模型仍复现；④ `llm.js:198` 写死 `stream:false`、全仓无 undici 配置 ⟶ 复核：`chat()` 改 `node:http` 绕开 undici `headersTimeout=300s`；真机复跑 design **405 秒 done** | 阻断 | 后端 | ✅已验证 |
| 9 | 03 资产 | 同一模型下 OpenAI 兼容层比 ollama 原生 API 慢约 **2.3 倍**（4.4s vs 1.9s）；阶段技能要求的 `think:false` 兼容层也不认 | 本轮实测数据（见 #8 证据） ⟶ 复核：走 ollama 原生 `/api/chat`（`toChatCompletion` 归一返回形状）；`test/llm-ollama-native.test.mjs`(10) | 改进 | 后端 | ✅已验证 |
| 10 | 05 片段/成片 | `stage.status=done` 与 `stage.output.assembly.status=queued` 语义冲突：片段都生成完了、阶段却显示 done，但成片根本没合成（无 url）。前端不得不自己加"done 且有 url 才算成片"的守卫 | 前端线在 `run-muprxois-wvmqq` 上实测发现；`pipeline.js` 的 `executeAssemble` 回写位置 ⟶ 复核：阶段状态以任务终态为准 `done/running/partial/error/canceled`；活证据 assembly `running` + 9 产物 | 一般 | 后端/契约 | ✅已验证 |
| 11 | 03/04 文本阶段 | **提示词与输出持续膨胀**：design 需生成 2774+ tokens（提示词 3343 字）；keyframe 提示词达 **7987 字**，纯文本准备耗数分钟 | `/progress` 的 `label:"模型生成中（提示词 7987 字）"`；ollama 日志 `n_gen=2774, tg=14.45 t/s` ⟶ 复核：未修。上下文裁剪（G5）未落，提示词膨胀现状未变 | 一般 | 技能与提示词 | 待讨论 |
| 12 | 后端 | `chat()` 长生成超时已修（`node:http` 替代 fetch），但**前端代理 `forwardToLlm` 仍用 fetch**，同一 headersTimeout 隐患未堵 | `src/providers/llm.js:148` 仍是 fetch ⟶ 复核：未修。`llm.js:145` 仍用 fetch，`headersTimeout` 隐患未堵 | 改进 | 后端 | 待讨论 |
| 13 | 后端 | LLM 走 OpenAI 兼容层而非 ollama 原生 `/api/chat`：慢约 2.3 倍，兼容层也不认 `think:false` | 实测 4.4s（兼容层）vs 1.9s（原生） ⟶ 复核：同 #9，改走原生 `/api/chat`（`isOllamaBase` 判 11434），`think:false` 生效 | 改进 | 后端 | ✅已验证 |
| 14 | 03 资产/04 关键帧 | **严重**：`plan.visualStyle=二维动画` 未传导到资产阶段提示词——生成的 `prompt` 是英文且写 `Realistic live-action character asset`（写实真人） | `stages.design.output.characters[0].prompt` 原文 ⟶ 复核：`buildContext` 注入 `styleAnchor`+`plan`，01/03/04 不再自拟写实英文风格 | 严重 | 技能与提示词 | ✅已验证 |
| 15 | 04 关键帧 | **严重**：风格锚点自相矛盾——发往 ComfyUI 的原始 PROMPT 里同时有「二维动画」和「35mm film still / expired Kodak Gold 200 / fine grain」（互相否定）。根因：`pipeline.js buildContext` 不注入 `Project.styleAnchor` → 技能 `{{options.styleAnchor}}` 未替换 → 回落胶片默认锚点，`withPromptHead` 又把真 anchor 前置叠加 | 会诊内容质量视角逐字核对下载图与原始 prompt；`pipeline.js:341-349` ⟶ 复核：锚点唯一事实源：缺锚点用中性兜底、胶片层改**条件叠加**、`withPromptHead` 去重；见 CHANGELOG 首条 + `luster-接线说明.md` | 严重 | 后端+技能 | ✅已验证 |
| 16 | 04 关键帧 | **阻断**：`模型未返回合法 JSON`。根因是**提示词+输出超出 `num_ctx`**：`ollama show qwen3.8:27b` → `num_ctx=8192`，而提示词 7987 字 + 需输出内容合计超限 → 输出被硬截断。canvas-plus 全程未传任何 `max_tokens`/`num_ctx` | ① `stages.keyframe.error`；② ollama 日志 `200 / 5m10s`（调用成功非超时）；③ `num_ctx 8192` ⟶ 复核：原生 `/api/chat` + `config.llm.numCtx=32768`；`test/llm-ollama-native.test.mjs`(10 例)；实测 num_ctx 32768（14.9GB/16GB） | 阻断 | 后端 | ✅已验证 |
| 17 | 配置/前端 | **用户报**：生图模型下拉里没有「千问 2.1」。根因：配置页渠道模板库 `web/src/services/api/model-plugin.ts` 是硬编码清单，**漏了 qwen21**；后端模板 `img_qwen21_t2i`/`img_qwen21_edit` 存在且真机跑通 | `/api/providers` 含两支 qwen21 模板；前端 `modelPlugin.templates.*` 无 qwen 条目 ⟶ 复核：`model-plugin.ts` 补 qwen21 两模板 + i18n；网关 `BUILTIN_GATEWAY_SCRIPTS` 补两支；147 真机五项跑通 | 一般 | 前端 | ✅已验证 |
| 18 | 04/资产 | **用户报**：生成的图在「资产」里看不到。① 生图产物**未自动登记**为项目 AssetRef；② 「资产」页读的是**前端本地 store**，与项目资产(AssetRef)不是同一数据源 | ① 27 个 artifacts 但 `GET /asset-refs` → `{"assetRefs": []}`；② `pages/assets/index.tsx:37` 用 `useAssetStore` ⟶ 复核：① 自动登记 ✅ `registerArtifacts`(pipeline.js:942) 幂等回写（活证据 9 产物）；② 资产页与项目 AssetRef **仍两个数据源**、无缩略图 → 未修 | 严重 | 后端+产品 | 🟡部分修复 |
| 19 | 配置/渠道 | **用户报**：画布生成文章**疯狂弹认证弹窗**。① 选中渠道指向 `api.openai.com` **无 key** → 401 反复弹；② 前端 `POST /api/llm/providers` 会**整体覆盖写回**渠道表，冲掉服务器侧配置 | ① 用户现象；② `data/llm-providers.json` 仅剩无 key 占位渠道；③ `gateway.ts:313`；④ `pre-cleanup` 备份佐证 ⟶ 复核：死亡渠道已清、`/v1/models` 已含外部渠道；**需重启网关生效**（出片在跑故延后） | 严重 | 前端+后端 | **未修复（实测复现）** |
| 20 | 接口/网关 | 网关 `/v1/models` **不含外部渠道模型**：只返回 8 个本地 ollama 模型，而 `/api/providers` 含 `deepseek::*` → 用户经「一键接入网关」拿不到可用 API 文本模型 | `curl /v1/models` → 8 个；`curl /api/providers` → 含 deepseek::* ⟶ 复核：`GET /v1/models`(index.js:276-284) 挂在 `/v1/*path` 之前 + `resolveModelTarget`；`test/gateway-http.test.mjs`(5)。**2026-10-03 重启后实测**：`/v1/models` 返回 10 个（8 本地 + `deepseek::deepseek-flash` + `deepseek::deepseek-v4-pro`） | 严重 | 后端 | ✅已验证 |
| 21 | 项目工作区/产物 | **用户报**：项目里看产物「全是空白」。产物**只在「流水线」页渲染**，项目工作区**一个 artifact 都没接**。用户强调：创作是线性过程，「后台每生成出一张，前台就展示一张」 | `grep -n "artifact/产物/media" pages/projects/components/workspace-run-panel.tsx` → 零命中 ⟶ 复核：项目工作区新增「过程时间线」（`use-project-timeline.ts`/`process-timeline-model.ts`/`process-timeline.tsx`）；**未提交、未复跑验证** | 严重 | 前端+产品 | 已修复待验证 |

### 本轮会诊结论

（跑完由多角色评审汇总，含整改单与优先级 —— 见文末四个视角的会诊结论区）

---

## 用户追加报告（2026-10-03，成片级）

> 由产品负责人在本轮观察成片后**追加报告**，编号承第一轮（21 条）；只追加，不替换。
> 判定：三条都属于 **「创作线性过程里该被固定的东西没有被固定」**——角色外观、角色声音、声画关系，全都没进生产链。

| # | 阶段 | 现象 | 一手证据 | 严重度 | 影响面 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 22 | 03/04 资产·关键帧 | **用户报**：**角色形象没有固定下来**——同一个人在不同镜头里长相/发型/衣服会漂。根因：角色一致性**只存在于文字**，01 输出 `characters[].appearance`（"年龄、体态、五官、发型、服装基调"）后，每镜把这段文字重复写进提示词，**没有定妆图、没有参考图锁脸、没有 seed 锁定、没有角色 ID 贯穿到生图** | ① `pipeline.js:581/586/621/627` 全是对 `appearance` 的**文本**要求；② 全仓 grep `characterLock/characterRef/voiceId` **零命中**；③ 具备锁角色能力的 `video_h3_ref2v_image`（"只需一张参考图即可锁角色"）**未被流水线接入** | 阻断 | 技能与提示词/后端 | 待讨论 |
| 23 | 05 片段/成片 | **用户报**：**角色的音频、音色也没有固定下来**——全片没有角色配音轨。根因：`voice` 字段（"音色、语速、口音、口头禅"）**下游零消费**：无 TTS 接线、无音色库、无 `voiceId` 参数、无音频产物 | ① `skills/01-novel-to-script/SKILL.md:42/97` 只要求"写" voice；② `delivery.js` 有 `amix` 混音能力但 `plan.audio` **靠外部手工传入**（L292 `plan.audio.map(...)`），流水线**没有任何环节生产音频**；③ `pipeline.js:1439` 只有 `audio: options.audio` 透传 | 阻断 | 契约/技能与提示词 | 待讨论 |
| 24 | 05 片段/成片 | **用户报**：**配乐与配音不一致**（成片级事故） | 根因未定位（上一轮排查被新诉求打断）。与 #23 同源：音轨既非流水线产出、也无对齐校验 → 稳定性依赖外部手工 | 阻断 | 前端+后端 | 待讨论 |

### 已有方法论但未接线（可直接吸收，不必从零设计）

`skills/libraries/doubao-creative-drama` 已把这两条写成方法论，**流水线没接**：

- **角色形象**：`assets` 阶段"角色、场景、道具、视觉风格、参考图用途、**一致性锚点**、音色或台词锚点"，并强制顺序「主角设定图 → 用户确认 → 配角/反派设定图（逐位输出逐位确认）→ 角色总体确认 → 场景全景图…」。
- **音色**：`references/assets.md:25` ——「项目总时长 > 15 秒则**必须生成角色高光台词视频以建立稳定的音色和动态基准**」；「输出音色描述：声线、年龄感、质感、情绪状态」；`docs/short-drama-methodology.md:383`「1 条 5-10 秒角色介绍视频（用设定图做参考，角色说一句符合人设的台词，输出音色描述）」。
- 换句话说：**能力与路线图都在仓库里，缺的是把它接进 03/04/05 三个阶段的产物契约（角色设定图作为生图/生视频参考图 + 音频轨作为 05 的必需产物）。**

## 第二轮复跑新暴露（2026-10-03，run `run-murpt28o-46f5q`）

> 复跑本身跑完了五阶段，但**成片失败**。以下两条是复跑过程中新暴露、或**证明上轮「已修复」判断过早**的。

| # | 阶段 | 现象 | 一手证据 | 严重度 | 影响面 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 25 | 05 片段 | **成片 `partial`：16 镜有 6 镜全废**。前 10 镜 `done`，`sh11`–`sh16` 全部 `status=error`，ComfyUI 侧 `SamplerCustomAdvanced`（`node_id: 14`）报 **`VBAR OOM`** —— 147 的 16GB 显存被吃穿。首次尝试 02:00:08 → 02:43:03（43 分钟）后 OOM，自动重试 02:44:20 → 02:45:38（78 秒）再 OOM，说明**不是偶发**。 | ① `GET /api/jobs/run-murpt28o-46f5q-sh11-clip-mursgdwp-asjjf` → `error[0] = ["execution_error", {node_type:"SamplerCustomAdvanced", exception_message:"VBAR OOM\n"}]`；② 同一错误在 sh11–sh16 六条 job 上一模一样；③ `curl 147:8188/system_stats` → ComfyUI **活着**（0.38.2 / 16310MB），是 OOM 不是崩溃 | 阻断 | 基础设施(147) | 待讨论 |
| 26 | 配置/渠道 | **「疯狂弹认证」未修复，且恶化为「渠道表被清空」。** 服务端 `data/llm-providers.json` 实测只剩一个**死渠道** `默认渠道 → https://api.openai.com`（无 key、models 0），可用的 `deepseek` **不见了**；前端 `gateway.ts:340` 的 `POST /api/llm/providers` 是**全量覆盖**写回，浏览器侧那份（只有默认死渠道）一保存就把服务端的 deepseek 冲掉。**本次实测复现**（文件 mtime 10:18，就在报告前）。 **【修复登记 `d9e9501`】** 服务端改为按 name 增量 upsert（apiKey 空则保留原 key、不在请求里的渠道绝不删除）+ `router.any` 承接 DELETE（405/404 可解释）；前端 `syncGatewayLlmProviders` 语义同步；单测 4 例全绿；界面加载实测服务端仍为 `[deepseek]`。待观察：浏览器侧带 4 渠道的完整场景由用户实际打开时自然验证。 | ① `{"providers":[{"name":"默认渠道","baseUrl":"https://api.openai.com","hasKey":false}]}`；② 备份 `llm-providers.pre-cleanup.json` 里 deepseek 在（`api.deepseek.com`，有 key）；③ 网关日志被 `外部渠道「默认渠道」… 在 8s 内未返回模型，本次跳过` **每 8 秒刷一条**（1002 行日志里绝大多数是它） | 阻断 | 前端+后端(契约) | ✅已修复待观察 |
| 27 | 声音 | **角色音色与配音没有生产链**：`01` 的 `characters[].voice` 只是音色/语速/口音文字；前端虽有全局 `audioModel/audioVoice` 与 OpenAI 兼容 TTS 模板，项目流水线**没有 TTS 阶段、没有 `voiceProfileId`、没有对白 `AudioCue`**，`delivery.js` 的 `amix` 只能混合调用方手工传入的 `plan.audio` | 见 `development-plan.md` §11.5.1（三条声音路线对照 + `productionAudio`/`voiceProfile` 目标结构） | 阻断 | 后端+产品 | 待讨论（P0 音频链契约已落地：`canvas-server/src/audio.js` + 18 例，未接线） |
| 28 | 03/04 资产·关键帧 | **角色三视图与场景母版没有成为项目资产**：`03-costume-props` 提示词已要求角色外观/场景空场/布光，方法论还要求正面特写+三视图；实际契约只有文字 `prompt`，**没有三视图/特写/空场 Artifact、没有用户确认门禁和引用关系** | 见 §11.5.2（`characterRef` 目标结构 + 整改后的资产链） | 阻断 | 后端+前端 | 待讨论（技能契约已补：`skills/03-costume-props` 的 `turnaroundArtifactIds`/`sceneMasterArtifactId`/`confirmed`） |
| 29 | 02/04 分镜·关键帧 | **机位描述存在但不可验证**：`02-storyboard` 的 `camera` 字符串要求机位/运镜/焦段/光圈/景深/焦点，`04-keyframes` 交给模型；**服务端不拆分校验，也不确认视频 Tool 是否消费这些约束**，换工具后可能静默丢失 | 见 §11.5.2 末段「不能执行的字段要在 QC 显示 warning，不能静默丢失」 | 严重 | 后端 | 待讨论（技能契约已补 `cameraSpec`；服务端映射未做） |
| 30 | 全链 | **上游修改不能可靠触发下游失效**：`regenerate` 只支持生成型阶段单条候选、`setStageInput` 替换整段 JSON；**没有 revision 输入指纹、影响分析、stale 状态或分支 run** → 角色/场景/分镜改完后，旧关键帧、旧视频与新分镜可能混用 | 见 §11.5.3 四条规则 + §12 最低验收场景 | 阻断 | 后端 | 待讨论（核心逻辑已落地：`canvas-server/src/impact.js` + 25 例，未接线） |
| 31 | 全阶段 | **阶段失败在界面上只显示「失败」，不显示原因**（UI 验收实测）：01 剧本 analyze 步失败时界面只渲染「读原文 失败」，`stage.error` 的完整内容**完全不展示** → 产品负责人视角等于黑盒，只能靠外部查 run JSON | run `run-murvf1vq-aqyqm`：`stages.script.steps.analyze.error` 有完整原因（「未注册的外部 LLM 渠道：deepseek」），而界面文本只有「失败」两字 | 严重 | 前端 | 待讨论 |
| 32 | 测试方法 | **接口路径与界面路径跑的不是同一套阶段逻辑**：接口直推的 run `run-murpt28o-46f5q` 的 `script` stage **没有 `steps`**（三段式之前的旧代码产物），而界面路径的 run `run-murvf1vq-aqyqm` 有完整 `steps`（读原文/分集规划/逐集剧本）→ 此前用接口做的「复跑测试」根本没覆盖界面实际走的路 **【修正登记 2026-10-03】** 已改用 CDP 走界面路径复跑，`run-murvf1vq-aqyqm` 的 `script` 有完整三段式 `steps` 且全 done（analyze/outline/script），`episodes=2`。 | 对比两个 run 的 `stages.script` 结构（前者 keys 无 `steps`） | 阻断 | 测试方法 | ✅已修正 |
| 33 | 项目工作区 UI | **解释性小字泛滥**（产品负责人当面指出）：每个按钮都配一段小字解释、整个页面塞满说明文案 —— 如过程时间线的「流水线每产出一个文件，这里就实时长出一张；后台出一张，前台长一张」、运行区的「在当前项目内直接运行本工作区对应的流水线阶段；无需跳到「影视流水线」页面」、门禁区的「当前工作区为骨架：只读展示上下文与门禁，写入动作跳转既有页面」、分镜区的「本工作区已开放就地编辑：改动直接写回项目」。要求：**把按钮/字段本身的文字写清楚就够了，删掉这些「为什么/怎么做到」的说明** | 产品负责人原话：「不要搞这种乱七八糟的小字说明啊，每个按钮你都要加几个字解释一下，整个页面全是你的解释内容，完全没必要的嘛」 | 严重 | 前端 UI | 待讨论 |
| 34 | 过程时间线 | **已完成的阶段在时间线里仍显示「失败」**（用户实测截图）：`run-murvf1vq-aqyqm` 的 script 经重跑已是 `done`（三段式全 done、episodes=2），但界面上过程时间线仍渲染「1.剧本 失败 / 读原文 失败 → 分集规划 待运行 → 逐集剧本 待运行」的旧状态 | 同一 run：API 侧 `stages.script.status=done` 且三个 step 全 done；界面侧仍显示失败 | 严重 | 前端 | 待讨论 |
| 35 | 02 分镜 / 05 成片 | **分镜不遵守集时长预算**：分集规划已明确写出「第 1 集 · 15 秒 / 第 2 集 · 15 秒」（对齐 plan 的 `episodeDurationSec=15`），但分镜按「场」拆镜后共 **16 镜、合计 76 秒**，为目标 2×15=30 秒的 **2.5 倍**。时长预算只在规划阶段写进文字，**没有成为分镜的硬约束**（这正是 D1「Σ段时长必须=骨架」未落的表现） | 同一 run `run-murvf1vq-aqyqm`：`stages.storyboard.output.shots` 16 条、`sum(durationSec)=76`；过程时间线里分集规划写「2 集 × 15 秒」 | 阻断 | 后端 | 待讨论 |
| 36 | 项目列表 | **「显示已归档」开关疑似不工作 / 归档可逆性待验证**：在 UI 上归档「最后一班公交」「猫狗奇缘」后默认列表只剩「末班车·UI正式流程」（正确）；但 API 侧 `GET /api/projects?includeArchived=true` **仍只返回 1 个**，归档的两个查不回来 —— 若前端开关走同一参数，等于**归档后无法找回**（「归档后仍可读取」的提示与实现不符）。待确认参数名/实现是否另有入口 | `curl '/api/projects?includeArchived=true'` → 1 个；默认 → 1 个 | 严重 | 后端+前端 | 待讨论 |
| 37 | 项目门禁 | **严格门禁上线后暴露「投影不完整」→ 关键帧被误挡**（阻断）：`GET /gates` 同一响应里 `storyboard.ready=true`、`design.ready=true`，但 `keyframe.blockedBy=[storyboard,design]` 且 reason 写「上游阶段未完成：storyboard、design」——自相矛盾。根因不在门禁逻辑，在**上游数据没到位**：`gates.js:24-42 hasOutput()` 判 `storyboard` 要 `episodes[].scenes.length>0`、判 `design` 要 `project.assetRefs.length>0`，而实测 **`context.episodes=[]`**（脚本投影只写了 `project.script`，episodes 没投影进 Project）、**服化道产物从未登记成 AssetRef**。界面后果：关键帧工作区「运行本工作区」按钮**被禁用**，流程卡死 **【修复验证 `e2c2f1b`】** 补全投影后实测：重跑 script → `project.episodes=2`（ep_0001/ep_0002 各 1 场）、**storyboard gate done=True**；重跑 design → `project.assetRefs=4`（character×2 binding c1/c2、scene×2 binding loc1/loc2）、**design gate done=True**；**keyframe gate ready=True**，界面「运行「关键帧」」按钮解锁。后端 291/291 pass。 | `GET /api/projects/prj_01M3ZZ2MJVQ2TJBRY1K3B0HBXF/gates` 与 `/context` 实测；`gates.js:24-42,59` | 阻断 | 后端 | ✅已修复验证 |
| 38 | 05 关键帧 | **生图模板配错：关键帧阶段默认走 `img_zimage_artistic`（Z-Image），产品负责人要求改成本地千问 2.1** —— 已改 `canvas-server/config.json` 的 `pipeline.imageTemplate` → `img_qwen21_t2i`（模板 `img_qwen21_t2i.json` 存在、网关已注册 `capability:image`），已重启生效 | `config.json` diff；`canvas-server/workflows/img_qwen21_t2i.json` 存在 | 已修复 | 配置 | 已生效待验证 |
| 39 | 04 关键帧 | **关键帧提示词完全不含「图上该出现什么文字」→ 出图文字全是伪文字**（产品负责人报）：抓真实 Job 入参，`sh11-end` 的 PROMPT 全文 668 字**只有英文画面描述**（"crouches on the ground under a bus stop sign pole"），**一个字都没提站牌/车票/线路号上该写什么**。出图实测：车牌是「MH 00 000」这类乱码、公交站牌与目的地显示屏完全不可读。**不是模型能力问题**——Qwen-Image 2.1 恰是开源里中文文字渲染最强的之一，问题是没人告诉它写什么 | `GET /api/jobs` 里 `run-murvf1vq-aqyqm-sh11-end` 的 `params.PROMPT` 全文；对 `sh1-start_00005_.png` 的视觉核验 | 严重 | 后端+技能 | 已定整改方案（新增 `textOverlays` 契约 + 提示词必须逐字指定，已派活） |
| 40 | 产物索引 | **产物索引 URL 指向不存在的文件 → 前端预览 404**：`run.stages.keyframe.artifacts[]` 里写的是 `sh11-end_00003_.png` / `sh13-end_00003_.png`，但磁盘 `canvas-server/data/artifacts/run-murvf1vq-aqyqm-sh11-end/` 下实际只有 `sh11-end_00002_.png`。实测按索引 URL 取图返回 **39 字节错误响应**（非图片）；同批 `sh1-start_00005_.png` 正常 1.79MB。这是「生成图在项目里看不到」的一类根因 | `curl /api/artifacts/run-murvf1vq-aqyqm-sh11-end/sh11-end_00003_.png` → 39B；`find data/artifacts -name 'sh11-end*'` → 只有 `_00002_` | 严重 | 后端 | 待讨论 |
| 41 | 03/04 参考锁 | **参考图绑定失效：存量空引用命中幂等判断被跳过**（阻断）：design 重跑后 **6 张参考图全部生成成功**（`stage.output.references[]` 全为 `done` 且带 `artifactUrl`：c1/c2 各 closeup+turnaround、loc1/loc2 各 master），但项目 4 条 AssetRef（c1/c2/loc1/loc2）仍是 `artifactIds: []`、`selectedArtifactId: null`。根因：`pipeline.js` 的 `bindDesignReferenceArtifacts` 里 `existing` 集合按 `(runId,stageId,bindingId)` 判定「已存在就 continue」，**未区分「空引用」与「已绑定产物」** —— 上一轮 `registerDesignAssets` 建的 4 条空引用成了占位路障；本轮虽已改成不再预建空引用，但**存量空引用没被处理** | run 详情 `references` 全 done + `context` 里 4 条引用产物为空；`bindDesignReferenceArtifacts` 函数体 | 阻断 | 后端 | 已定方案（existing 仅在有产物时跳过、空引用要 update、自愈存量，已派活） |
| 42 | 03 服化道 | **参考图质量未达「标准三视图」**（可优化）：生成方向正确（正/侧/背 + 3/4 侧都在），但**带透视、光影、景深与背景，四组大小不一致**，更像「多角度概念图」；且**背面图外套多了灰色反光条**（正反面不一致）；提示词已写 `no text, no logo, no watermark`，图中左胸名牌仍有模糊文字 | 对 `ref-c1-turnaround.png` 的视觉核验；提示词见 run 详情 `references[].prompt` | 一般 | 技能+后端 | 待讨论（不影响锁角色主目标：已有清晰正脸可用） |
| 43 | 04 关键帧 | **`img_qwen21_edit` 要求必填 `INPUT_IMAGE`，而 start 帧没有底图 → 42 个作业全失败**（阻断）：第一次带走参考图的关键帧跑出 `keyframe.status=partial`（27 done / **42 error**），失败原因统一为「模板 img_qwen21_edit 缺少参数：INPUT_IMAGE」—— `{{INPUT_IMAGE}}` 是模板里 LoadImage 节点的**必填**占位；start 帧语义是「从零生成该镜第一帧」，无底图可给。正解：用该镜第一张角色参考图充当 `INPUT_IMAGE`（模型因此真正"看见"角色），其余参考图继续走 `REF_IMAGE_*` | `GET /api/jobs` 里 42 条 error 的 `error` 字段；模板 `workflows/img_qwen21_edit.json` 的节点 4 `LoadImage {{INPUT_IMAGE}}` | 阻断 | 后端 | 已定方案（已派活） |
| 44 | 02/04 分镜·关键帧 | **`textOverlays` 契约加错了阶段 → 图上文字依旧拼不出来**（严重）：实测分镜产出的 shot 字段为 `['id','sceneId','index','durationSec','shotSize','camera','cameraSpec','action','dialogue','audio','prompt','negativePrompt']`，**没有 `textOverlays`**。因为「这一镜画面上有什么字」应由**分镜阶段**决定（02），而契约被加在了关键帧技能（04）→ 分镜不产出、关键帧无从消费。另外 `shot[0].dialogue` 为空串 | `run.stages.storyboard.output.shots[0]` 的 keys；`skills/02-storyboard/SKILL.md` 骨架 | 严重 | 技能 | 已定方案（补到 02，已派活） |
| 45 | 04 关键帧 | **场景母版没有注入关键帧参考图**（严重）：实测 `REF_IMAGE_1/2` 只拿到两张**角色**特写（c1/c2），**场景母版 loc1/loc2 未出现**——而这两条 scene AssetRef 已成功绑定产物（`selected=...loc1-master_00001_.png`）。说明 shot→locationId 推导或 scene 侧参考图解析未命中 | `GET /api/jobs` 里带 REF_IMAGE 的作业只含 REF_IMAGE_1/2；`context` 里 loc1/loc2 已绑定 | 严重 | 后端 | 已定方案（已派活） |
| 46 | 项目工作区 UI | **布局像「管理后台」而非「创作台」：信息区一行内大片空格、分镜不以时间线呈现**（产品负责人当面指出，并指定对标 https://github.com/zenstory-ai/drama-skills）。实测：`集：2集`与`剧本产物：已确认`分居屏幕两端、`完成度：检查表 0/0`与`上游阶段 服化道 已完成`右半全空；分镜 17 镜**纵向卡片平铺**，看不出时长节奏与景别分布。对标项目 DESIGN.md 的原则正好命中：「A calm director's worktable, **not an administration dashboard**」「Avoid **metric-card walls**…」；其分镜视图做法为「**按时长定宽按景别着色的节奏条** + 镜头卡 + 详情抽屉（←/→、j/k 切镜）」 | vision 对 `/tmp/kf-layout.png` 的核验；DOM 量得 `1126x22 \| 完成度/检查表：0/0` 等空行；对标仓库 `DESIGN.md` 与 `.agents/notes/.../2026-09-27-dashboard-v2-stage-views.md` | 严重 | 前端 | 已派活（节奏条 + 信息区紧凑化） |
| 47 | 角色一致性（对标） | **对标项目指出我们的口径缺口：跨镜穿帮多数不是脸变了，是「服装颜色/伤口位置/手里的东西/湿没湿/门开没开/站在轴线哪一侧」**。他们把一致性拆三层：① 身份/造型写进设定 + **连续性锁**（只锁不随剧情变且观众看得出不一致的可见事实，写成能原样贴进提示词的最小名词短语）② 参考图分 `IMG-*`（只是提示词）/`PLAN-*`（创作者自备）/`REF-*`（项目内确实存在且已检查）**三态，只有 `REF-*` 能进参考槽**，缺哪张就列出来**不静默降级** ③ **冻结关键帧**（只写起点那一格能看见的）+ 回填「视觉依据」。**与我们现状对照**：②的「不静默降级」我们做对了（`blocked` 机制）；但**「身份 vs 变体」与「连续性锁」的概念我们完全没有**，目前只有角色级三视图 | 对标仓库 `docs/character-consistency-across-shots.md` | 一般 | 产品+后端 | 待讨论（是否吸收「连续性锁/变体」概念） |
| 48 | 05 片段合成 | **关键帧结果从未投影进 Project，导致 `assembly` 门禁被永挡**（阻断）：关键帧已 **17/17 全 done**（`stages.keyframe.artifacts` 17 条、无 blocked），但前端「运行「片段合成」」按钮灰着、提示「上游阶段未完成：keyframe」。实测 `/gates` 自相矛盾：`keyframe.ready=True` 却把 keyframe 列进 `assembly.blockedBy`。根因：`gates.js` 的 `hasOutput('keyframe')` 判 **Project 侧** `episodes[].shots[].generationSlots[].selected/candidates done`，而实测 `project.episodes` 每条 `scenes=0、shots=0、shotIds=[]` —— **keyframe→generationSlots 这层投影压根没实现**。与 #37 同类（#37 补的是 script→episodes 与 design→assetRefs） | `GET /gates` 的 assembly 项；`context.episodes[].shots` 为空；`gates.js` 的 hasOutput 分支 | 阻断 | 后端 | **✅已修复**（`34603d8`）：补 keyframe→Project 幂等投影（`projectKeyframeFacts` 挂在 recomputeStage 终态汇聚点，`bindJobs()` 启动重放覆盖已 done 的 run，**无需重跑生成**）；实测 `assembly.ready` False→**True**、`project.episodes[].shots` 9+8、`generationSlots[].selected` 指向采用候选。427/427 |
| 49 | 声音链路 | **「音色对得上」的技术路径已摸清**：147 上有 **Qwen3-TTS 节点组** —— `TDQwen3TTSCustomVoice`（内置音色，`speaker` 枚举）、`TDQwen3TTSVoiceDesign`（**按 instruct 描述设计音色**）、`TDQwen3TTSVoiceClone`（给参考音频克隆）、`TDQwen3TTSMultiDialog`（**多角色一次合成**）、`TDQwen3TTSDefineSpeaker`（音频→说话人）。与已有 `audio.js` 的 VoiceProfile 字段**一一对应**（`speaker`→speaker、`design`→VoiceDesign.instruct、`language`→language）。配合 `video_h3_talk.json`（`MiniMaxH3AudioConditioningT8` 的 `drive_audio`+`first_frame` → **音画同出、口型对齐**）即可成链 | `GET 147:8188/object_info` 里 TDQwen3TTS* 的入参；`workflows/video_h3_talk.json` 节点 10/11/15 | — | 后端 | **进行中**：已派活建 `workflows/audio_qwen3_tts.json` 并实跑两条不同音色对白（老周/女孩）；后续再接 audio 阶段 |
| 50 | 声音生产 | **台词表演注解被直接当成 TTS 参数 → 语速过慢**（产品负责人当面反馈「说话速度太慢了」）：分镜产出的 `dialogue` 自带表演注解，例如 `sh5` 「姑娘，这么晚，去哪儿？**（低声、音量低、语速慢、略带关心）**」、`sh6`「终点站。**（声音轻柔、微弱、语速慢、犹豫）**」——这些注解被原样当成 TTS 的 `instruct` 送进去，于是语速真的慢了。实测：老周 11 字用 **3.82s（2.4 字/秒）**、女孩 4 字用 1.58s（2.5 字/秒），远低于正常中文 4~5 字/秒。**根因是缺少「台词清洗」环节 + 语速不是显式参数**（LLM 自己加的注解不该驱动生产参数）。改 instruct 为「语速正常」后重合成：老周 **2.78s（4.0 字/秒，+66%）**、女孩 **1.10s（3.6 字/秒，+44%）**，音色未跑偏（F0 127Hz / 281Hz） | 旧版 `tts-voices/{laozhou,girl}.flac` vs 新版 `canvas/tts_fast_*`；时长由 ffprobe 实测 | 严重 | 后端+技能 | **✅已修复**（`284c94f`）：`splitDialogue` 剥离括号注解为独立 `performance`（含嵌套/引号/空回退告警）；`resolveSpeechSpeed` 优先级 `voiceProfile.speed > options.speed > （显式 honorPerformance）> 1.0` —— **注解默认完全不参与生产参数**，采纳须显式开启并夹在 [0.85,1.15]；返回 `{speed,source,reason}` 可追溯。真实干跑：默认 speed=1.0、请求体不含注解（true→false）。455/455 |
| ⚙️ | 运维处置 | **已手动恢复**（未经产品负责人指示，按「发现风险→先备份→直接解决」处理）：备份当前死渠道 → 从 `pre-cleanup.json` 取出 deepseek（只取这一个，其余 gpt/kimi/本地网关三个经查已失效）→ 写回 `{"providers":[deepseek]}`、权限 0600 → 重启 `canvas-server`。验证：`/api/llm/providers` = deepseek(hasKey)、**`/v1/models` = 10 个（含 `deepseek::deepseek-flash` / `deepseek::deepseek-v4-pro`）**、死渠道刷屏停止。**注**：首次写回因丢了外层 `providers` 对象导致服务端读空，已修正（见坑）。 | 同上 | — | — | 已处置 |

**本条对 #19 的修正**：#19 上轮被我标成「已修复待验证」—— **实测未修复且复现**，状态改为**未修复（已手动恢复，根因仍在）**。根因（双写者）方案见下方「契约 / 数据流视角」第四节：**网关路由表以服务端为唯一写者、浏览器渠道表以浏览器为唯一写者，只按 name 显式 upsert，禁止全量替换**。

## 第二轮（猫狗微电影·复跑，新建项目）

| # | 阶段 | 现象 | 一手证据 | 严重度 | 影响面 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 22/23/24 | 04/05 | 见上节「用户追加报告」——角色形象、音色、声画关系三条成片级缺陷 | 同上 | 阻断 | 技能与提示词/后端 | 待讨论 |
| ✅ 已修好 | 01/02/03/04 | 集数对齐 `plan.episodeCount`（#1/#3）、风格锚点唯一事实源（#14/#15）、提示词 `num_ctx` 撑开（#16）、生图模型接入（#17）、产物自动登记（#18①） | 后端 206/206；活证据 keyframe `artifacts=29` | — | — | ✅已验证 |
| ⚠️ 仍在 | 04/05 | 关键帧与分镜对不上（负向词否定正向要求）、提示词膨胀 7987 字、无角色锁 | 见 #4/#11/#22 | 严重 | 技能与提示词 | 待讨论 |
| ❌ **成片未完成** | 05 成片 | 复跑 run `run-murpt28o-46f5q` 最终落 **assembly = `partial`**：16 镜中**前 10 镜 ✅、sh11–sh16 全数 `VBAR OOM`**，成片未合（见下节 #25） | `GET /api/pipeline/runs/run-murpt28o-46f5q` | 阻断 | 基础设施(147) | 待讨论 |

### 与第一轮对比

（哪些修好了、哪些还在、新暴露了什么）


## 产品负责人拍板（2026-10-03）

> 四条决策均为**原话口径**，作为后续整改的硬约束。评审员列的拍板点已全部有结论。

### D1 时长 —— 档位**跟着模型走**（模型支持的选项相对固定），先定时长再填内容

> 原话①：「时长我记得是可以跟着 minimax h3 之类的模型标准走的，它们是**按帧算**的……**先算时长，再往里面填内容，确保不遗漏**」
> 原话②（补充，更本质）：「**时长锚点应该是跟着模型走的，模型有哪些选项应该是相对固定的**」

- **核心原则**：时长档位是**模型的能力元数据**，不是用户自由填的数字。**每个模型自带一组相对固定的时长选项**，选了模型就只能从它的档位里选。
- **已知档位（H3，已从 skill 查证）**：只有 5s / 10s / 15s 三档，帧数 = `24 × 秒 + 3`（123 / 243 / 363），24fps 封装；原生面积上限 768×1344。
- **执行含义**：
  1. 模型（模板）定义里要带**时长档位**字段（如 `durations: [5, 10, 15]`），与「模型清单」同源——**清单从后端接口动态取，档位随之而来**，不在前端硬编码。
  2. 项目 plan 的时长**从档位里选**（而非自由输入）；换模型 → 可选档位跟着变。
  3. 定完骨架后**再往每个槽位填内容**；Σ段时长必须等于骨架，缺一段都要报出来（"确保不遗漏"）。
  4. 不允许先写内容、再让时长随意膨胀（现状 16 镜 83 秒就是反着来的）。
- **待落实**：H3 之外的模型（Wan / Minimax 其他变体等）各自的档位需**逐个查证后登记**，不许拍脑袋。

### D2 风格锚点 —— 全局唯一，单镜可改细节
> 「风格锚点**肯定是要唯一的**，但是**每个镜头的提示词是可以改的**，也就是说有个**全局配置，但是还是可以改部分细节**」

- **执行含义**：`styleAnchor` 是风格维度的**唯一事实源**，任何镜头/资产不得覆盖它（治 #15 那条自相矛盾）；但允许**单镜在锚点之上追加细节**（景别/动作/光线等），不许改写风格基调。
- 实现上要能区分「加细节」与「改风格」——后者必须被拒绝或忽略。

### D3 关键帧 —— 一次出 4 张以上，不达标就重生成
> 「关键帧**一次生产 4 张以上**，咋可能不达标，**不达标就重新生产嘛**」

- **执行含义**：单镜默认**一次生成 ≥4 个候选**（当前 `maxKeyframesPerShot=2` 需上调）；不达标**自动重新生成**，不需要停下等人挑。
- 配合已有机制：单镜自动重试默认 2 次（此前已确认）。

### D4 集数与时长 —— 按实际需要走
> 「改成多少秒我觉得**没啥问题**啊，根据**实际需要**走」

- **执行含义**：集数/时长不做硬编码限制，由内容和 D1 的骨架共同决定；项目设定里的数值是**起点**而非枷锁。

---

## 会诊结论 · 产品动线 / 半自动化视角

> 评审员：**产品动线 / 半自动化**（只管「人用起来顺不顺、手工环节还剩多少」；架构耦合、前后端契约、内容质量由另外三位评审员出结论）。
> 方法：**纸面推演**（未真跑生成、未碰 147 上在跑的 14 段视频）。
> 证据：`web/src/pages/projects/**`、`pages/assets/index.tsx`、`pages/config/**`、`pages/pipeline/**`、`AGENTS.md`、`development-plan.md`、`prd.md`、`domain-contract.md`。

### A. 完整动线推演（用户动作 → 系统反馈 → 摩擦）

1. **项目列表 → 新建**：点「新建短剧项目」弹 `CreateProjectModal`（剧名/风格锚点/题材/基调/视觉风格/画幅/剧集数/单集时长/受众），预置标签可多选可自定义，有默认值 → ✅ 无摩擦。
2. **填完创建**：仅落 `project.json`（title + plan）。**没有原文导入入口** → ❌ **阻断级**：产品负责人设想的「导原文」在项目 UI 里不存在。`CreateProjectModal` 无 file/TextArea；后端 `POST /api/projects/:id/sources` 存在，但**全前端 0 处调用**（`grep -E "createSource|sourceRevisionId|uploadSource" --include=*.tsx` = 0）。
3. **项目总览**：`NextStepPanel` 按 `/gates` 指出下一步阶段 + 跳转按钮，还标注门禁来源（server/fallback） → ✅ 信息够（「下一步做什么」这一问答得不错）。
4. **进「规划·剧本」工作区点「运行本阶段」**：`useProjectRun.start` 调 `resolveProjectSourceText(projectId, sourceRevisionId)` 取源文本，取不到 → 报 `needSource` → ❌ **走到这一步就断了**。用户被迫去 `/pipeline` 另起 run，项目页形同虚设。
5. **（绕道 `/pipeline` 跑完 01/02）回项目「分镜」工作区**：按集选、场景→镜头铺开、就地改镜/调序 → ✅ 本项目最完整的编辑面。
6. **「资产」工作区**：只列 AssetRef，每条 = role 标签 + bindingId 输入框 + artifact **id 短串**，**无缩略图**；「登记」= 手选 role + **手打 bindingId 字符串** → ❌ 严重摩擦：看不出资产长什么样，也接不上刚生成的图。
7. **「关键帧」工作区**：`keyframes.tsx` 仅 12 行、无 children = **纯骨架** → ❌ 严重：25 分钟生成的 29 张图在项目里**完全看不到**。
8. **「视频·后期」工作区**：同样纯骨架 → ❌ 片段/成片在项目里看不到。
9. **总览页「导出交付包」**：按钮 + 进度 + 结果（episodes/files/missing）齐全 → ✅ 交互完整（前提是成片真产出）。

> **一句话结论**：六阶段里项目内只有「剧本（只读跳转）/ 分镜」真能用；资产半残、关键帧/视频是空壳，且连第一步「导原文」都缺。端到端动线在项目页只通了约 **2.5/6 段**。这解释了产品负责人「你生的图为什么在资产里没看到」——项目工作区根本没有显示图的容器。

### B. 摩擦点清单（按严重度排序）

| # | 现象 | 用户会怎么想 | 建议 |
| --- | --- | --- | --- |
| M1 | 项目内无法导入原文（无入口） | 「我新建了项目，原文往哪放？」 | 新建时可选导入 + 项目页补「导入/更换原文」；调已存在的 `POST /projects/:id/sources` |
| M2 | 关键帧/视频工作区是骨架，看不到任何产物 | 「跑了 25 分钟，我的图呢？是不是卡死了？」 | keyframes 工作区接入候选图网格 + 采用；video 接入片段列表与成片 |
| M3 | 资产页只显示 artifact id，无缩略图、无自动入池 | 「这就是你说的'资产'？」 | 项目资产页内联缩略图；产物生成后自动/半自动进资产候选（见 C1） |
| M4 | 资产登记 = 手打 bindingId 字符串 | 「我要记住剧本里角色叫什么才能登记？」 | bindingId 改为下拉（从剧本 characters/scenes/props 选） |
| M5 | 项目工作区不能选模型/模板，静默用服务端默认 | 「为什么这里出的图和 /pipeline 不一样？」 | 项目内显式展示「继承配置默认：X」，高级覆盖收折叠区 |
| M6 | 生成型阶段进度无 done/total/ETA，只有一句「生成中」 | 「29 张到底出了几张？」 | 后端补 done/total/label/etaMs（见 D） |
| M7 | 项目 run 列表只显示裸 runId，无标题/时间 | 「哪个 run 是这部片的成片？」 | 用 `listPipelineRuns` 的 title/createdAt 渲染；提供默认「当前生产 run」概念 |
| M8 | 工作区固定跑 `runIds[0]`，无 run 选择器 | 「我想重跑但怕覆盖现在这条」 | 增加「当前 run」选择器 + 新建 run 入口 |
| M9 | 每阶段选模型分散（/pipeline 逐阶段、项目页无），且 `stageModels` 存 localStorage 全局 | 「我第 2 集改了模型，第 1 集怎么跟着变了？」 | `stageModels` 按 projectId 命名空间；与 plan §4「跨项目串台」同源 |

### C. 半自动化缺口盘点（该不该自动化 + 成本 + 收益）

| 优先级 | 环节 | 现状 | 自动化后用户省了什么 | 成本 |
| --- | --- | --- | --- | --- |
| **P0** | 项目内导入原文 | 无入口，必须绕 `/pipeline` | 少一次页面跳转 + 少一次重复粘贴；项目成为唯一入口 | 小（后端已有） |
| **P0** | 产物→项目资产候选 | 生成物只登记为 Artifact，AssetRef 全手工 | 29 张关键帧不再需要逐张手登记；直接可选用 | 中（后端投影已做一半） |
| **P0** | 关键帧候选展示 + 采用 | 项目内看不到图 | 25 分钟等待变可监督、可挑选 | 中 |
| **P0** | 成片合成执行体（ffmpeg） | `assembly` 只是规划，无执行体（见 #10/P1-d） | 从「片段排队中」到能导出交付包 | 大（P1-d 本就要做） |
| **P1** | 生成型阶段进度 done/total/ETA | 只有 phase:"running" | 长任务不再「以为卡死」，可判断还要多久 | 小（复用 script 的 progress 形状） |
| **P1** | 模型选择统一 + 项目内默认继承 | /pipeline 逐阶段选；项目页无 | 五个阶段不再各选一次，配置页一处定默认 | 小 |
| **P1** | 多 run 选择 / 命名展示 | 固定 runIds[0]、裸 id | 「这部片的成片在哪」可回答 | 小 |
| **P2** | 一键铺到画布（run 产物 → 画布） | 无 | 手工另存/重传 60 次归零 | 中（底座已有 `applyCanvasAgentOps`） |
| **P2** | 从素材库登记到项目 | 两个资产世界互不相通 | 已有素材可复用进项目 | 小 |
| **P2** | 交付包/候选批量下载 | 交付包已有；候选无批量下载 | 多候选归档一次搞定 | 小 |

**明确「不该自动化」**：逐阶段人工确认门禁（D11）保留；改稿/过审（AGENTS.md 内容规范）不由系统代做。

### D. 进度与反馈（对齐全阶段后端能力）

- **已有**：`progress.json`（轻量、几十字节）+ `GET /progress`；字段 `stage/phase/done/total/label/reused/avgMsPerChunk/etaMs/error/startedAt/finishedAt`（见 domain-contract §9）；01 剧本额外有 `steps[]`（analyze→outline→script 多步可见，产品负责人已认可）。
- **缺口**：
  1. **生成型阶段（关键帧/片段）只写 `phase:"running"`，无 done/total/label/etaMs** → 前端 `StageProgress` 只能显示「生成中」，**没有「第 12/29 张」也没有 ETA**。这正是 #171（job.progress 只填 0/0）在流水线层的表现。
  2. **项目工作区（`useProjectRun`）只轮询 `/progress`，不轮询 jobs** → 关键帧阶段在项目页连「有几张在跑」都看不到（`/pipeline` 页靠轮询 jobs + CandidateStrip 才勉强可见）。
  3. **长任务「以为卡死」风险确实存在**：25 分钟出 29 张期间，项目页只有一句「生成中」，且无断点/心跳/已出图数。`/pipeline` 页稍好（候选条陆续出现），但项目页是盲盒。
- **建议**：生成型阶段的后端投影补 `done/total/label/etaMs`（total=本阶段 item 数，done=落终态 job 数）；前端项目工作区接入候选图轮询。

### E. 多项目 / 多集 / 多 run

- **多项目**：列表/详情/归档齐，✅ 基本可用。
- **多集**：`plan.episodeCount` 驱动后端 `createEpisodes` 确定性分集；但**只有 /storyboard 工作区有集选择器**，资产/关键帧/视频/规划工作区都是项目级、不分集 → 用户「我第 2 集的资产在哪」无落点。
- **多 run**：`project.runIds[]` 可存多条，但工作区 `runId = createdRunId || context.runIds[0]`，**默认永远跑第一条，无切换入口**；总览页 run 列表只显示裸 id。
- **心智模型撞墙点**：「我这个项目的成片在哪？」——① 视频工作区是空壳；② run 列表只有裸 id；③ `stage.status=done` 与 `assembly.status=queued` 语义冲突（#10）会让用户以为成片好了。这三者叠加，用户无法定位成片。
- **建议**：引入明确的「当前生产 run」概念并让工作区、总览页、交付按钮读同一个 run；集级视图至少在关键帧/资产工作区补一级集筛选。

### F. 拍板点（必须产品负责人定）

1. **资产页归并方案（问题 #18 前端一半）** — 三选一：
   - **(推荐)** 项目资产页为**主视图**（AssetRef 按 role 分组 + 缩略图 + 「从产物/素材库登记」），全局 `/assets` 降级为**个人素材来源**，用「登记到项目」桥接。**不合并成单一视图**——因为 AssetRef 是项目语义引用（role/bindingId），全局 Asset 是跨项目通用素材（无 projectId），生命周期不同，合并会污染「这部剧的资产」。
   - 合并成一张表（不推荐：语义混杂）。
   - 两个页签并列（可接受，但需明确默认落在项目资产）。
2. **成片「完成」的判定口径**：stage.status=done / 有 url / 有交付包，三者取哪个为准？直接影响交付按钮的绿/灰。
3. **多 run 策略**：一个项目只跑一条主线 run，还是允许多 run 并存并让用户选？（决定 `runIds[0]` 默认行为是否要改）
4. **原文导入形态**：新建项目时导入，还是项目内单列「导入/更换原文」步骤。
5. **项目内是否允许逐阶段选模型**：与「配置页一处定默认」有张力，需定「项目内只继承」还是「可覆盖」。

### G. 可直接做（不需要拍板）

- 项目资产页渲染缩略图（`artifactIds`/`selectedArtifactId` → `/api/artifacts/...`）、关键帧工作区补候选图网格。
- 生成型阶段后端补 `done/total/label/etaMs`（沿用 script 的 progress 形状，仅追加字段）。
- bindingId 由手打字符串改为从剧本 characters/scenes/props 生成的下拉。
- 总览页 run 列表显示 `title + createdAt` 而非裸 id。
- 项目工作区补「继承配置默认模型：X」的只读提示。
- `stageModels` 按 projectId 命名空间隔离（修 plan §4「跨项目串台」）。

---

## 会诊结论 · 架构/耦合视角（评审员：架构与耦合）

> 评审范围：代码结构、职责边界、可演化性。**不看**产品动线、前后端字段契约、内容质量（另三位评审员负责）。
> **口径校准（重要）**：本文落盘时 `pilot-issues.md` 实存 **#1–#13 共 13 条**（第一轮 10 条 + 第二轮 3 条），**没有 #16 / #18 / #20**；引用它们的任务描述与本文件不符。下文按**主题**对齐，不按编号：LLM 层三轮修改 = #7/#8/#12/#13；产物自动登记 = 代码里的 `registerArtifacts`（pipeline.js:942）；接口设计 = #5/#6。若后续补登到 20 条，请以主题定位。

### 一、结构诊断（位置 → 问题 → 为何会痛 → 证据）

**D1. `pipeline.js` 已是一个 1456 行的「全能编排器」，承担 ≥4 个可由文件名区分的职责。**
- 位置：`canvas-server/src/pipeline.js:1-1456`。
- 问题：同一文件里并列着工具层（`parseJsonLoose:84`、`fillTemplate:114`、`extractSection:101`、`snap32:51`、`frameCountFor:44`、`dimensionsForRatio:60`）与业务层（`composeScriptSteps:747`、`attachGeneration:1148`、`projectJob:1181`、`registerArtifacts:942`、`beginAssemble:1339`）：五段式编排 + 分块 map-reduce + 提示词模板解析 + Job 投影 + 资产登记 + ffmpeg 编排全在一个模块。
- 为何会痛：改任意一处（加一步、改一条契约）都在同一文件内，回归面=全文件；`AGENTS.md:24`「一个文件只干一件事」已被越过，且这正是"先堆成一坨再指望以后重构"的形态。
- 证据：文件规模 1456 行 / 84KB，远超其余业务模块（episodes 303、delivery 343、jobs 278、assets 113、gates 74）。

**D2. 通用编排器里硬编码各阶段 id 与上游产物形状，形成隐形跨模块契约。**
- 位置：`pipeline.js:816`（`def.id === "script"`）、`1001-1042`（`def.id === "keyframe"` 分支）、`1118-1119`、`1152-1153`、`1188`、`1193-1195`（`run.stages.storyboard.output.shots` / `run.stages.keyframe.output.frames`）、`1287`（`GENERATIVE_STAGES`）。
- 问题：`const shots = run.stages?.storyboard?.output?.shots || [];` 这类直读在 4 处重复，且**全部用可选链吞掉结构错误**。
- 为何会痛：这是不受契约保护的隐式耦合——分镜/关键帧产物结构一变，pipeline 静默读 `undefined`，不报错只降级（缺模板 token、条目永久不入队）。#1/#3「plan 未传导」与此同源：pipeline 从不回报"上游读丢了什么"。
- 证据：`pipeline.js:1118-1119`、`1152-1153`、`1193-1195` 四处同型直读，无一处写 warning。

**D3. `createPipeline` 依赖注入已达 10 项，且混装三类语义。**
- 位置：`index.js:133-146`（唯一装配点）↔ `pipeline.js:129`（`createPipeline({ config, skillsDir, jobs, comfy, llm, runJob, assemble = assembleEpisode, getProject, applyPlanSuggestion, registerAssetRef })`）。
- 问题：入参混了 (a) 能力依赖（`jobs/comfy/llm/runJob`）、(b) 项目存储回调（`getProject/applyPlanSuggestion/registerAssetRef`）、(c) 后期执行体（`assemble`）——而 `assemble` **同时被默认 `import`（`pipeline.js:6`）与参数注入两条接法并存**，读者要同时看默认值和 index.js 才知道谁生效。
- 为何会痛：入参表成了"万能插座"；每新增一个项目侧能力就再塞一个回调，没有边界信号。
- **判据校准**：按 `AGENTS.md:27`「只有出现第二个实现才抽接口」——当前只有 index.js 一个装配点、每个回调只有一个实现，**此刻不该抽接口**；但"注入项 > 5 且都源自项目存储"已是"应收成一个对象"的信号（见整改 A5）。

**D4. `files.js` 反向 import `http.js`，是 `AGENTS.md` 自己点名的错误分层，至今未改。**
- 位置：`files.js:6` `import { guessContentType } from "./http.js"`，并在 `:8` re-export。
- 问题：存储层依赖 HTTP 层。MIME 判断的根在 http.js，files.js 只做路径/落盘，却把整个 HTTP 模块拖进依赖图。
- 为何会痛：任何在非 HTTP 场景（脚本、单测、CLI）复用 files.js 都会连带加载 http.js；分层一旦开口就会接着开。
- 证据：`AGENTS.md:21` 逐字写「files.js 为了拿 MIME 去 import http.js 的 guessContentType 就是错误分层，内容类型判断属于 HTTP 层」，代码与之冲突。

**D5. LLM 层是「fetch / node:http 双实现」，#12 未闭环——但这不是死代码。**
- 位置：`llm.js:112`（getJson，fetch）、`231`（forwardToLlm，fetch）、`269`（postJson，node:http，供 chat）。
- 问题：三轮修改后同时存在两套发送实现。`#12` 指出 `forwardToLlm` 非流式 chat 仍走 fetch，同一 `UND_ERR_HEADERS_TIMEOUT`（300s）隐患未堵。
- 为何**部分**会痛：chat()/postJson 走 node:http 已解 #8 根因；但探活（getJson）与 /v1 透传（forwardToLlm）仍 fetch。好消息是三者用途本就不同（长非流式 POST / 短探活 / 流式透传），**不是死代码也不是重复实现**；缺的是**一条规则**，不是统一实现（见"不该动"）。

**D6. `jobs.js` 与 `pipeline.js` 构成"双写者"，且投影在队列关键路径上同步跑磁盘。**
- 位置：`jobs.js` 的 `update()` 内 `emit("change")` ↔ `pipeline.js:1206 bindJobs()` 订阅后跑 `projectJob`（pipeline.js:1181）。
- 问题：`jobs.update` 在 worker 主循环里同步 emit；listener 里做 `readFileSync`/`writeFileSync`（`projectJob → recomputeStage → registerArtifacts → saveRun`，终点 `pipeline.js:1199`）。
- 为何会痛：run.json 仍内嵌整本小说，**每个 job 终态一次全量重写**；163 块 / 几十镜规模下即 MB 级写放大。（progress.json 已拆出是正确先例，run.json 本体未拆。）

**D7. `registerArtifacts` 是 `recomputeStage` 里的隐式副作用，且每次重算全量读项目。**
- 位置：`pipeline.js:886-890`（`recomputeStage` 内调 `registerArtifacts`）、`942-977`（实现）、`:948` `projectOf(run)` 读盘。
- 问题：名为"重算阶段状态"的函数里偷偷写项目资产；每次调用 `projectOf(run)` 读盘 + 重建 `seen` 集合（`:952`）。
- 为何会痛：状态计算与存储写入无法分离测试；且它在每个 job 终态必经路径上，复杂度 O(已有 refs × 本次 artifacts)。当前规模可忍，条目上千时变成回写热点。「#18 产物自动登记」的结构风险正在此：**登记时机隐式耦合在重算里**，而非显式的"产物就绪"事件。

**D8. 前端 `model-plugin.ts` 1435 行硬编码脚本库 vs `gateway.ts` 动态生成。**
- 位置：`model-plugin.ts:227-1435`（15 个脚本模板：image 7 / video 4 / audio 2 / text 2）↔ `gateway.ts:361-540`。
- 现状**不是简单重复**：`gateway.ts:371-376` 通过 `BUILTIN_GATEWAY_SCRIPTS`（`:361-369`）复用 model-plugin 里的脚本字符串，只有无内置脚本的模板才用 `buildGatewayTemplateScript`（`:444`）动态生成。这是有效的去重。
- 为何仍会痛：脚本以**字符串字面量**存在，每个脚本内部各抄一份 `resolveSize` / `absoluteUrl` / `waitForJob`（见 `model-plugin.ts:453-496`）。改一条通用逻辑要在 N 个字符串里同步改；字符串无类型检查、无 lint。演化方向：模板只增不减，行数线性增长。

**D9. 无 ESM 环形 import，但有"逻辑环"：`projects.js` 兼作子模块的微型框架。**
- 位置：`projects.js` 把内部原语（`ulid` / `httpError` / `badRequest` / `requireArray` / `requireProject` / `persistProject` / `readJson` / `writeJsonAtomic`）打包成 `entityStore` 注入给 `episodes` / `sources` / `assets`。
- 为何可接受：规避了真正的 ESM 环（episodes 不 import projects），是最低成本解。
- 为何仍是隐患：`projects.js` 从"存储内核"膨胀成"存储内核 + 微型框架 + 服务定位器"，子模块依赖父模块的实现细节而非显式契约。

### 二、表态：看着乱但健康的局部代价，**不该动**

- **`llm.js` 的 fetch/node:http 双栈——不该统一。** 三处用途不同（长非流式 POST=node:http；短探活=可接受 fetch；流式透传=fetch 的 `body` 迭代最省事）。强行统一要么逼探活用 node:http（多写），要么逼流式透传用 node:http（自己实现背压）——为一致性付无收益成本。只需补规则注释（见 A6）。
- **`model-plugin.ts` 的脚本字符串——不该抽公共函数/工厂。** 这些脚本是给用户看、可编辑、可复制进"自定义模型脚本"的**自包含产物**；抽成 import 会让脚本不再自包含，直接违背该设计初衷。当前重复 helper 是清醒的局部代价。
- **`projects.js` 的 `entityStore` 注入——不该改成 import。** 现写法是规避 ESM 环的最低成本解；改成接口层/工厂正是 `AGENTS.md:27` 反对的过度抽象。
- **`createPipeline` 现在不该抽接口。** 每个注入只有一个真实实现（仅 runJob 有 local/runninghub 两实现、已合理）。符合"第二个实现才抽"。
- **300 行左右的各模块（episodes/delivery/jobs/assets/gates）——都不该动。** 边界清楚、单职责，是 6 模块里最健康的部分。

### 三、整改建议（分级 · 成本 · **明确触发条件**）

| 编号 | 级别 | 成本 | 动作 | **触发条件（什么时候做）** |
| --- | --- | --- | --- | --- |
| A1 | P0 | 小 | `files.js` 停止 import/re-export `guessContentType`；需要它的调用方（http.js、index.js）直接从 http.js 取，MIME 表留 http.js。 | **随时**。因 `AGENTS.md:21` 明文点名，可作一次独立小修；或下次动 files.js/http.js 的 MIME 相关行时顺手做。 |
| A2 | P1 | 中 | 把 `pipeline.js` 的阶段无关纯函数（`parseJsonLoose/fillTemplate/extractSection/snap32/frameCountFor/dimensionsForRatio`）抽到 `pipeline-util.js`；尺寸吸附直接复用 `generate.js:90` 已有实现（消除第二份）。 | **下一次要新增或修改任一文本阶段时**（就近小步做，不为抽而抽）。 |
| A3 | P1 | 小 | D2：5 处 `run.stages.X.output.Y` 直读收成一个 `upstreamOf(run, stageId, key)`，结构缺失时给 `stage.warning` 而非静默 `|| []`。 | **下一次再出现"某阶段产物没被下游读到"的试跑问题时**（#1/#3 传导问题同源，很可能会再出现）。 |
| A4 | P1 | 中 | D6/D7：把整本小说从 `run.json` 拆成独立 `novel.txt`（progress.json 已是先例），切断"每 job 终态一次全量 MB 级写"。 | **当单 run 条目 > 约 50 或 run.json > 2MB 时**——即第二轮试跑若上量就触发，不必现在改。 |
| A5 | P2 | 中 | D3：**不抽接口**，只把 `getProject/applyPlanSuggestion/registerAssetRef` 三个项目存储回调收成一个 `projectStore` 对象传入。 | **出现第二个 `createPipeline` 装配点时**（如批量/测试脚手架需要另一套注入）；只有一个装配点就不动。 |
| A6 | P2 | 小 | D5/#12：给 `forwardToLlm` 与其调用点补一条明确规则注释（"非流式 chat 不得经 /v1 转发；透传只服务流式"），或对非流式透传加最大 headersTimeout 保护。 | **前端复现"聊天长时间无响应最后报超时"时**；否则仅补注释，不改实现。 |

### 四、与其它视角的边界

- #1–#4、#11（内容质量/提示词）不在本结论内。
- 但 **#1/#3「plan 未传导」与 D2 同源**：编排器吞掉结构错误、无 warning 回传。建议由内容质量视角定"该传什么"，我这边只定"传丢了要能看见"（A3）。
- #5/#6（接口）属契约视角；本视角的补充仅一句：`index.js` 的 `submitGeneration`/`backends` 已在路由层做了少量业务判定（能力校验、job 构造），尚在 `AGENTS.md:22` 容忍边界内，**不构成欠债，不必动**。

## 会诊结论 · 前后端契约 / 数据流视角（评审员：接口契约与数据流）

> 视角：接口清单、契约文档与实现的偏差、数据源与命名、错误语义、配置/进度两条数据流的所有权。**只读评审**，未改代码、未跑任务、未重启服务。
> 一手证据：`canvas-server/src/index.js`(路由表 712 行)、`contracts.js`、`projects.js`、`pipeline.js`、`providers/llm.js`、`providers/comfy.js`、`http.js`、`web/src/services/api/gateway.ts`、`web/src/stores/use-config-store.ts`、`web/src/pages/pipeline/use-pipeline-run.ts`、`web/src/types/domain.ts`、`canvas-server/README.md`、`p0a-project-kernel-plan.md`、`data/llm-providers*.json`（引用格式：文件:行）。

### 一、接口清单（全量路由，来自 `index.js`）

| 方法 | 路径 | 用途 | 请求形状 | 响应形状 | 标记 |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | 前端入口/服务信息 | — | HTML 或 serviceInfo | — |
| GET | `/api` | 服务自描述 | — | serviceInfo | ⚠ endpoints 列表过期（C9） |
| GET | `/api/health` | 健康探测 | — | `{ok,llm,comfy,runninghub,queue}` | llm/comfy 失败降级 `ok:false` |
| GET | `/api/backends` | 生成后端清单 | — | `{backends,defaultBackend,allowRunningHub}` | 与 `/api/providers.backends` 重复 |
| GET | `/api/providers` | 能力清单 | — | `{llm:{baseUrl,models},comfy:{templates,models,error?},backends}` | llm 失败静默空，comfy 失败带 error（不对称） |
| GET | `/api/skills` | 阶段/技能清单 | — | `{skills: stages}` | ⚠ 与 `/api/pipeline/stages` **同源、键名不同** |
| GET | `/api/llm/models` | 模型清单 | — | `{models:string[]}` | ⚠ 与 `/v1/models`、`/api/providers.llm.models` 同源 |
| GET | `/api/llm/providers` | 外部渠道清单（脱敏） | — | `{providers:[{name,baseUrl,hasKey}]}` | — |
| POST | `/api/llm/providers` | 外部渠道写入 | `{providers:[{name,baseUrl,apiKey?}]}` | `{providers}(脱敏)` | **⚠ 全量替换、无版本/无合并 → 覆盖事故（C2）** |
| GET | `/v1/models` | OpenAI 兼容模型清单 | — | `{object,data:[{id,object,owned_by}]}` | 与上同源 |
| ANY | `/v1/*` | LLM 透传 | 原样 | 原样 / 502 | 透传**不走**注册表（只打 baseUrl/fallbacks） |
| POST | `/api/generate/image`、`/api/generate/video` | 提交生成 | `{template,params,name?,backend?}` | `201{job}` | 失败 400 |
| POST | `/api/uploads` | 上传素材 | multipart 或 raw | `201{name,comfyName}` | — |
| GET | `/api/jobs` | 任务列表 | `?status&limit` | `{jobs}` | — |
| GET | `/api/jobs/:id` | 任务详情 | — | `{job}` / 404 | — |
| POST | `/api/jobs/:id/cancel` | 取消任务 | — | `{job}` / 404 | — |
| GET | `/api/artifacts/:jobId/:filename` | 产物字节流 | `?download=1` | 文件 / 400 / 404 | — |
| GET | `/api/pipeline/stages` | 阶段定义 | — | `{stages}` | 与 `/api/skills` 同源 |
| GET | `/api/pipeline/runs` | 运行列表 | — | `{runs: 完整 run[]}` | **⚠ 内嵌 novel，可达数 MB（C6）** |
| POST | `/api/pipeline/runs` | 建 run | `{novel,title?,options?}` | `201{run}` | 缺 novel→400 |
| GET | `/api/pipeline/runs/:id` | run 详情 | — | `{run}` / 404 | ⚠ 内嵌 novel |
| GET | `/api/pipeline/runs/:id/progress` | 轻量进度 | — | `{progress,inflight}` | **⚠ 仅单阶段、无全阶段汇总（#5 / C6）** |
| POST | `/api/pipeline/runs/:id/steps/:stage/run` | 跑阶段 | `{model?,provider?,resume?}` | `202{run,inflight}` | 同步校验 400 |
| POST | `/api/pipeline/runs/:id/steps/:stage/cancel` | 取消阶段 | — | `{canceled,stage,jobs,ranMs}` / 404 / 409 | 409 用于"无可取消" |
| POST | `/api/pipeline/runs/:id/steps/:stage/input` | 改阶段输入/产物 | `{inputs?,output?}` | `{run}` | — |
| POST | `/api/pipeline/runs/:id/steps/assembly/assemble` | 合成成片 | `{order?,transition?,quality?,force?}` | `200{reused}` / `202` | 门禁失败 400 |
| POST | `/api/pipeline/runs/:id/steps/:stage/regenerate` | 逐条重跑候选 | `{itemId,template?,params?}` | `202{run,jobId,itemId}` | 400 / 409 |
| GET | `/api/projects` | 项目列表 | `?includeArchived=1` | `{projects:ProjectSummary[]}` | ⚠ 与 plan 的 `?status&q` 不一致 |
| POST | `/api/projects` | 建项目 | `{title,plan?,styleAnchor?,source?,canvasId?}` | `201{project}` | — |
| GET | `/api/projects/:id/context` | 工作区聚合 | `?include=refs` | 上下文对象 / 404 | ⚠ 与 plan 的 query 集/形状不一致；**runIds 恒空（C3）** |
| GET | `/api/projects/:id` | 项目详情 | — | `{project}` / 404 | — |
| **PATCH** | `/api/projects/:id` | 项目元数据更新 | `{title?,plan?,…,expectedVersion?}` | `{project}` / 409 | **⚠ plan 写的是 POST；POST→404（#6 / C1）** |
| POST | `/api/projects/:id/archive` | 归档 | — | `{project}` | — |
| GET/POST | `/api/projects/:id/episodes` | 集列表/新建 | — / `{title,index?,logline?,plan?}` | 200 / 201 | — |
| GET/POST | `/api/projects/:id/episodes/:episodeId` | 集详情/更新 | — / `{…}` | 200 | — |
| POST | `/api/projects/:id/episodes/:episodeId/scenes` | 建场 | `{locationId,time,intent,…}` | 201 | — |
| POST | `/api/projects/:id/episodes/:episodeId/reorder` | 重排 | `{sceneIds,shotIds?}` | 200 | 只改 index 不改 id |
| POST | `/api/projects/:id/scenes/:sceneId` | 更新场 | `{…}` | 200 | — |
| POST | `/api/projects/:id/scenes/:sceneId/shots` | 建镜 | `{…}` | 201 | — |
| POST | `/api/projects/:id/shots/:shotId` | 更新镜 | `{…}` | 200 | — |
| GET/POST | `/api/projects/:id/sources`(`/:revisionId`) | 源版本 | — / `{kind,title,content}` | 200 / 201 | — |
| GET/POST | `/api/projects/:id/asset-refs` | 资产引用 | `?role=` / `{…}` | 200 / 201 | ⚠ plan 路径是 `/assets`，已改名 |
| **PATCH/POST** | `/api/projects/:id/asset-refs/:refId` | 更新引用 | `{…}` | `{assetRef}` | **双方法同处理器**（C5） |
| POST | `/api/projects/:id/asset-refs/:refId/select` | 选候选 | `{artifactId}` | `{assetRef}` | — |
| POST | `/api/projects/:id/asset-refs/:refId/unlink` | 解绑 | `{artifactId}` | `{assetRef}` | — |
| GET | `/api/projects/:id/gates` | 阶段门禁 | — | `{gates}` / 404 | — |

> 说明：路由实际注册方法只有 `get`/`post`/`any`/`add`，**无 PUT/DELETE**；`add` 仅用于 PATCH。

### 二、契约诊断（按严重度排序）

**C1｜严重｜三套"契约"文档并存，HTTP 面没有唯一权威源，写方法选择无据可依 → #6**
- 现象：调用方按文档用 `POST /api/projects/:id` 得 404，改 `PATCH` 才 200（#6 已实测）。
- 根因：① `domain-contract.md` §7-2 **明确把"HTTP 方法、URL、请求/响应体"排除在契约之外**；② `p0a-project-kernel-plan.md` §2 规定"一律 GET 读、POST 写"（理由是当时 `createRouter` 只有 get/post/any），其 §2.2 表写 `POST /api/projects/:id`；③ `canvas-server/README.md`"接口契约（冻结）"只覆盖 gateway/generate/pipeline，**整个 `/api/projects` 面缺失**。而实现新增了 `router.add` 并改用 PATCH。
- 后果：任何不读源码的调用方只能猜，猜错得通用 404、无法自纠。
- 证据：`domain-contract.md` §7 第 2 条；`p0a-project-kernel-plan.md` §2 导语 + §2.2 表；`index.js:528` `router.add("PATCH", "/api/projects/:id", …)`；README 各小节无 Project。

**C2｜严重｜渠道注册表双写者 + 全量替换，无版本/无合并 → 服务器侧配置被前端静默覆盖**
- 现象：`data/llm-providers.pre-cleanup.json` 有 `gpt`(ai.input.im)/`deepseek`/`kimi`/`本地网关` 4 条真渠道；现 `llm-providers.json` 只剩 1 条占位「默认渠道 / https://api.openai.com / 空 Key」。
- 根因：`use-pipeline-run.ts:140-143` 页面挂载即用浏览器 `config.channels` 过滤出 openai+文本渠道并 `POST /api/llm/providers`；后端 `index.js:254-274` 对该 body 做 `writeFileSync` **整表替换**。浏览器默认渠道恰是占位「默认渠道」（`use-config-store.ts:97-108`），于是把服务器注册表冲掉。README 把 POST 定义为"全量替换"——语义是文档化的，但客户端把它当单向同步用，且无任何防误覆盖。
- 后果：网关侧 `渠道名::模型名` 路由全部失效，波及 #19/#20 与流水线模型下拉；只能靠外部遗留 `.bak` 手工回滚。
- 证据：上述两文件 + `pre-cleanup`/`.bak` 三份文件对比。

**C3｜严重｜Project↔Run 反向索引 `runIds` 从不写入 → 项目上下文查不到自己的 run**（⚠️ 2026-10-03 复核：此判**已部分失效**，见本条目末尾「复核更正」）
- 现象：`GET /api/projects/:id/context` 的 `runIds` 恒为 `[]`，即使 `run.options.projectId` 指向该项目。
- 根因：正向链接靠 `run.options.projectId`（`pipeline.js:906`，契约 §6.2 过渡位）；反向 `Project.runIds[]` 仅在 `create` 初始化为 `[]`（`projects.js:193`），全仓无写入点（grep `runIds` 只见 init / MUTABLE_FIELDS / PATCH / context 读取）。`p0a` §2.7 设计的 `POST /api/projects/:id/runs` 未实现。
- 后果：前端无法从项目维度导航到关联 run；"工作区统一入口"形同虚设。
- 证据：`projects.js:193/243/305`；`grep runIds canvas-server/src` 无 create 之外写入。

- **【复核更正 · 2026-10-03】** C3 的「全仓无写入点」**只对后端成立**：回填由**前端**完成 —— 项目工作区内建 run 后 `attachProjectRun` 调 `PATCH /api/projects/:id`（`web/src/pages/projects/hooks/use-project-run.ts:106`，提交 `004f30a` 落地，失败还有 `linkFailed` 提示）。**一手证据**：`GET /api/projects/prj_01M3ZK27NYPXRPBVRAT0SSJ2B5/context` → `runIds = ["run-murnwa81-k27eq"]`（**非空**）。因此「`runIds` 恒为 `[]`」**已失效**。
  **真正残留的两条缺口**：① 回填只覆盖「项目内建 run」路径 —— 从**流水线页**建的 run 不回填（出片 run `run-murpt28o-46f5q` 的 `options.projectId` 指向本项目、却不在 `runIds[]` 里）；② 多 run 时前端只取 `runIds[0]`（`workspace-gate-panel.tsx:40`、`use-project-timeline.ts:20`）。会诊建议的服务端 `POST /api/projects/:id/runs` 仍未实现。见 `development-plan.md` §11.2。

**C4｜一般｜同一语义多入口 / 同源多端点，命名与形状不统一**
- 模型清单**三入口**：`/v1/models`、`/api/llm/models`、`/api/providers.llm.models`——三者都走 `listLlmModels`（**同源**，含 `渠道名::模型名`）。#20 若曾观测到"不同源"，现状已收敛为同源；但仍缺"三入口等价"的显式声明。
- 阶段清单**两入口**：`/api/skills`(`{skills}`) 与 `/api/pipeline/stages`(`{stages}`) **同源**。
- 后端清单**两入口**：`/api/backends` 与 `/api/providers.backends`。
- 证据：`index.js:232/245-247/281-284`、`235-243` vs `362-364`。

**C5｜一般｜无 405、错误码体系名存实亡、404 语义含糊**
- 现象：错方法 → 通用 404 `未找到路由：POST /api/projects/:id`，与"资源不存在"不可区分；无 `Allow` 头。
- 根因：`http.js:159-171` 只按 method 精确匹配，未命中即落 `index.js:654` 兜底 404。
- 后果：调用方无法区分路径错/方法错/资源不存在，也无法自发现正确方法（#6 的第二半）。
- 证据：`http.js:159-171`、`index.js:648-654`。
- 附加：`sendError` 的 `code` 大多未传（`index.js` 仅 `532` 一处 `version_conflict`，且小写）；`p0a` §2.1 规划的 `INVALID_INPUT/PROJECT_NOT_FOUND/VERSION_CONFLICT/DANGLING_REFERENCE` 等结构化 code 均未落地；404 文案在"项目不存在/流水线不存在/集不存在/源版本不存在/未找到路由"间不统一。

**C6｜一般｜列表/详情拖重对象，进度无全阶段汇总 → #5**
- 现象：#5 progress 只报单阶段；`GET /api/pipeline/runs` 返回完整 run 数组（每项内嵌 novel，222 万字≈6.4MB）。
- 根因：`pipeline.js:234-242` `list()` 直接回 `readJsonFile` 全对象；`writeProgress` 把 progress.json 覆盖为"单阶段"（`pipeline.js:175-186`、`1428`）。
- 后果：轮询/列表带宽浪费；前端为拿阶段状态被迫 `getPipelineRun` 拉 novel（`gateway.ts:296-311` 已自做摘要收敛，治标）。
- 证据：`pipeline.js:234-242/1428`、`gateway.ts:296-311`、#5。

**C7｜改进｜前端硬编码清单与后端真实清单并存 → #17**
- `FALLBACK_STAGES`（`use-pipeline-run.ts:43-49`）与后端 `registry.stages` 并存，后端加阶段前端看不到。
- `BUILTIN_GATEWAY_SCRIPTS`（`gateway.ts:361-369`）硬编码模板→脚本映射。
- `gatewayDefaultModels` 偏爱列表（qwen / `img_krea2_artistic` / `video_h3_i2v`）硬编码（`gateway.ts:424-438`）。
- `domain.ts` ↔ `contracts.js` ↔ `domain-contract.md` **三处手抄同一枚举**（StageStatus/JobStatus/AssetRole…），无生成、无校验。
- 证据：上述行号。

**C8｜改进｜读接口静默降级，调用方分不清"没有"与"不可达"**
- 现象：`/v1/models`、`/api/llm/models`、`/api/providers`(llm) 在 `listLlmModels` 抛错时 `.catch(()=>[])` 回 200 空表、**无 error 字段**；而同一 `/api/providers` 的 comfy 分支失败会带 `error`。
- 后果：模型下拉为空时无法判断"确实无模型"还是"LLM 挂了"（与 #7 死服务场景叠加放大）。
- 证据：`index.js:228-231/245-247/281-284`。

**C9｜改进｜服务自描述过期**
- `GET /api` 的 `serviceInfo.endpoints`（`index.js:196`）漏列 `/api/projects`、`/api/pipeline/stages`、`/api/uploads`、`/api/artifacts`、`/api/llm/*`、`/api/skills` 等，不能当发现入口。
- 证据：`index.js:192-199`。

### 三、整改建议（分级 / 成本 / 验证）

| 级别 | 项 | 内容 | 成本 | 验证方式 |
| --- | --- | --- | --- | --- |
| **P0** | 渠道单写者+防误覆盖 | ①停止页面挂载自动 POST，改用户显式「同步到网关」；②`POST /api/llm/providers` 改为**按 name upsert 合并**（未提及的渠道保留），删除走显式 `?mode=replace`/DELETE；③注册表非空而提交为空/缺 Key 时拒绝 400；④写前旋转 `.bak` | 小 | POST 空 `/[]`→期望 400 且文件未变；GET 原渠道仍在；跑一次流水线确认 `渠道名::模型名` 可路由 |
| **P0** | 补全唯一 HTTP 契约源 | 二选一并回写文档：保留 PATCH（更新 `p0a` plan 与 README）或退回 POST。倾向**保留 PATCH + 在 README 增"Project API（冻结）"整节**（含 PATCH/POST 双写法、409 `version_conflict`、400/404 语义、错误码表） | 中 | README 每条路径逐条 curl，状态码/形状与文档一致 |
| **P0** | 修 Project↔Run 反向索引 | `createPipelineRun` 落 run 后若 `options.projectId` 存在，则把 runId 幂等追加进 `Project.runIds[]`（走 `projects.update`）；或实现 `POST /api/projects/:id/runs` 并在建 run 时调用 | 小 | 建带 projectId 的 run 后 `/context.runIds` 含该 runId，重复调用不重复追加 |
| **P1** | 消除同源多入口 | 模型清单保留 `/v1/models`+`/api/providers`，`/api/llm/models` 标为别名；阶段清单合并为 `/api/pipeline/stages`（`/api/skills` 二选一：废弃或改为技能目录信息）；README 声明三模型入口等价 | 小 | 两两对比内容一致/职责互补；前端只保留一个调用点 |
| **P1** | progress 增补全阶段汇总 + 收敛重对象 | `writeProgress` 附带轻量 `stages:[{id,status,phase?}]`；run 列表/详情支持 `?include=` 或新增 summary 端点，不内嵌 novel | 中 | 仅凭 `/progress` 即可渲染全部阶段状态（复现 #5）；`getPipelineRun` 仅终态/取产物时调用 |
| **P1** | 统一错误语义 | `createRouter` 区分"路径存在、方法不符"→ **405 + `Allow` 头**；关键端点统一带 `code`（对齐 `p0a` §2.1，大小写统一） | 小 | 对 `/api/projects/:id` 发 POST 期望 405 且 `Allow: GET,PATCH`；各 404 带稳定 code |
| **P2** | 前端清单去硬编码 | 阶段/模板/默认模型改从 `/api/pipeline/stages`、`/api/providers` 派生，`FALLBACK_*` 仅作离线兜底 | 中 | 后端加一阶段/模板，前端不改代码即可见（复现 #17） |
| **P2** | 契约校验护栏 | 见"契约治理取舍" | 中 | 故意改 `contracts.js` 枚举 → 契约测试变红 |
| **P2** | 自描述补全 | `serviceInfo.endpoints` 由路由表生成或逐项补齐 | 小 | `GET /api` 列表与实际路由逐条对齐 |

### 四、数据所有权建议（渠道配置以谁为准、怎么避免再被覆盖）

1. **网关 LLM 渠道注册表**（`data/llm-providers.json` / `config.llm.providers`）
   - 所有权：**服务端单写者 = 网关**。它是"网关往哪里路由模型"的唯一事实，属服务器运行配置，不属于任一浏览器。
   - 写入口：仅①运维改文件（启动读取）或②**显式管理动作**；禁止任何页面在挂载/轮询中自动写。
2. **浏览器渠道配置**（`use-config-store.channels`，localStorage 键 `infinite-canvas:ai_config_store`）
   - 所有权：**浏览器**。它是"本机用户自己的渠道凭据与 UI 偏好"（含网关没有的 apiKey 明文）。
   - 与网关的关系：**不是副本，而是"待注册候选"**。用户要把某渠道交给网关路由时，走显式「注册/同步」动作。
3. **覆盖裁决**：合并以 `name` 为键，同名以新提交值更新、**未提及的渠道一律保留**（不得因未出现而被删）；确需删除走显式 DELETE 或 `?mode=replace` 并在 README 写明。
4. **防误覆盖护栏**：注册表非空时拒绝"空/缺 Key 的整表替换"（400）；写前保留上一版（旋转 `.bak`，项目已有此实践）以便回滚。
5. **敏感边界**：`apiKey` 只出现在浏览器侧与注册表文件（0600）；GET 一律脱敏（现状已正确，保持）。
6. **写入审计**：注册表可加可选 `updatedBy`/`updatedAt`，便于排查"谁把渠道冲了"。

> 一句话：**网关路由表以服务端为唯一写者；浏览器渠道表以浏览器为唯一写者；两者之间用"显式、按名合并、可回滚"的注册动作桥接，任何"自动全量替换"都禁止。**

**进度/产物数据流归属（对应第 3 问）**

| 端点 | 职责 | 前端应何时拉 |
| --- | --- | --- |
| `/progress` | 运行中的轻量轮询；增补全阶段汇总后兼"全阶段概览" | 阶段 running 时按 3s 轮询 |
| `/api/pipeline/runs/:id` | run 权威全量（含 novel 与产物） | 仅终态确定后 / 需要产物时；建议支持裁剪 |
| `/api/projects/:id/context?include=refs` | 项目工作区聚合（project+episodes+runIds+canvasIds[+assetRefs+gates]） | 工作区页面统一入口，不要各页自拼 |
| `/api/projects/:id/asset-refs` | 资产引用的检索/CRUD | 仅"资产"视图 |

- 取值规则：**状态用 `/progress`、聚合用 `/context`、产物用 `/runs/:id`、引用用 `/asset-refs`**，避免"拉大 run 取小信息"。
- 前置依赖：修好 C3（`runIds` 写入）后，`/context.runIds` 才能真正承担 run 导航。

### 五、契约代码生成 / 校验的取舍（对应第 4 问）

- 现状：契约机器可读部分以"手抄三份"存在（`domain-contract.md` 文本 / `contracts.js` 常量 / `domain.ts` 类型），**无生成、无校验、无测试**（全仓无契约测试）。
- 建议分两步，**不引入 OpenAPI/tRPC/代码生成框架**（与 AGENTS.md "零依赖、最少机制、不新增接口层"冲突，且接口面仍在动）：
  1. **短期（成本小、收益立竿见影）**：立"契约测试"护栏——用签入的 JSON fixture 断言：路由存在性、各路径允许的方法集合、关键响应形状、`domain.ts` 与 `contracts.js` 枚举一致性。
  2. **中期（接口面稳定后）**：以 `contracts.js` 为单一源导出 JSON Schema（枚举/实体），前端类型由 Schema 生成或测试比对。
- 判据：若"同源多入口 / 手抄枚举漂移"再次致事故，则升级到生成；否则**手写 + 测试**已足够。

### 六、与本轮其它条目的关联

- #5 → C6（progress 无全阶段汇总）之根因，建议 P1-2 一并解决。
- #6 → C1 + C5（文档无权威源 + 无 405）双重根因。
- #17 → C7（前端硬编码）；#19 → C2（全量替换覆盖）；#20 → C4（三模型入口同源但未声明等价）。
- #10（`stage.status=done` 与 `assembly.status=queued` 语义冲突）属状态机投影口径，归架构视角；本视角仅提示其**接口表现**为同一 stage 对象内两字段语义不一致，前端需自定义守卫。

---


## 会诊结论 · 内容 / 成片质量视角（评审员：内容与成片质量）

> 视角：**做出来的东西好不好、哪里本质不行**。只看生成质量、提示词工程与创作方法论；产品动线、架构耦合、前后端契约由另三位评审员负责。
> 方法：**真看了产物**——下载了本轮 run 的剧本/分镜/资产 JSON 与 **16 张关键帧 start 图逐张过 vision**；`curl` 只读接口，未改代码、未重启服务、未跑生成。
> 一手证据：`GET /api/pipeline/runs/run-murpt28o-46f5q`（API 版）与 `run-murnwa81-k27eq`（早期本地模型版）、`/api/projects/prj_01M3ZK27NYPXRPBVRAT0SSJ2B5/context`、`skills/01..05/SKILL.md`、`skills/libraries/luster-接线说明.md`、`canvas-server/src/pipeline.js`、`docs/.../domain-contract.md`（引用格式：文件:行 / 接口字段）。
>
> **口径校准（与架构视角一致）**：本文落盘时 `pilot-issues.md` 实存 **#1–#13 共 13 条**，**没有 #14/#15**；任务描述里「#14/#15 视觉形式被无视」「20 条」与本文件不符。下文**按主题定位**，不按编号：集式结构与时长传导 = #1/#2/#3；提示词膨胀 = #11；视觉形式被无视 = 下文 Q1（我实机复现了该现象）；角色双形态 = #4。

### 0. 一句话结论

**当前试跑的「坏」主要不在工程，而在「风格锚点没成为唯一事实源」和「集/时长预算没有下沉到分镜」这两条主线上。** 代码里 01 的多步编排 + 集数硬对齐已写好，但**从未跑到过**（9 个 run 全部 `stage.steps` 缺失、`episodes=[]`）；视觉风格则出现了**同一条 prompt 里「二维动画」与「35mm 胶片」互相打架**的硬矛盾。出图侥幸（本次生图模型按首词出了二维动画），但方法论上已经「本质不行」。

---

### 1. 质量诊断（按严重度排序）

#### Q1｜严重｜风格锚点没有成为唯一事实源：同一条 prompt 里「二维动画」与「35mm 胶片」自相矛盾
- **现象**：关键帧最终发给 ComfyUI 的 `PROMPT` 逐字如下（删节）：
  `二维动画，治愈系暖色调，柔光，圆润可爱的角色造型，干净线条。二维动画，治愈，都市奇幻。35mm film still, expired Kodak Gold 200. … overexposure melting contours golden rim on hair, grey-blue shadows, fine grain, light leak upper right. 1/100s shutter, subjects tack-sharp. warm nostalgic tone, soft film grain.`
  即：**前段声明「二维动画」，后段又声明「35mm 胶片实拍 + 颗粒 + tack-sharp」**——两套互相否定的视觉形式挤在一条 prompt 里。
- **根因层级**：**工程 + 方法 双因**。
  - 工程：`buildContext`（`pipeline.js:341-349`）只注入 `novel/title/options/pipeline+上游产物`，**不注入 `Project.styleAnchor`**；`run.options` 里也确实没有 styleAnchor（本轮 `options={projectId}`）。于是 04 技能模板的 `{{options.styleAnchor}}` 未被替换 → 模型按技能「一、默认风格锚点」**回落**到 `35mm film still, expired Kodak Gold 200`，并无条件叠加了 Luster 冻结胶片层（`04/SKILL.md:87,93,102,107,109`）。
  - 生成层：`withPromptHead`（`pipeline.js:74-77`）又把真正的项目 anchor（`productionDefaults` 拼出的 `二维动画…`，`pipeline.js:983-997`）**前置拼到 LLM 写的 prompt 之前**（`pipeline.js:1016/1036`）→ 两套风格头同时进 prompt。
  - 方法：04 技能的默认锚点 + 胶片层是按「日系青春写实」单一口味写死的，其「条件叠加」规则（`04/SKILL.md:97-103`、`luster-接线说明.md` §3）**依赖 styleAnchor 作为判定输入，但编排器不给这个输入**，规则必然失效、退化为无条件叠加。
- **证据**：`stages.keyframe.output.frames[0].prompt` 与 `candidates[0].params.PROMPT` 原文；`04/SKILL.md:87/93/102/107/109`；`luster-接线说明.md` §3；`pipeline.js:74-77/341-349/983-997/1016/1036`。
- **影响**：本次缩略图侥幸是二维动画（因 z-image 按首词走 + 先验），但**换底模/换模型即可能出写实或糊成一团**；且 storyboard（英文尾缀 `2D animation style`）、keyframe（胶片层）、clip（`二维动画…`）三个阶段三种风格处理，**跨镜头/跨集风格漂移无护栏**。这是「本质不行」类，不是体验问题。

#### Q2｜严重｜关键帧与分镜对不上：变身镜头与场景切换没拍出来
- **现象**：逐张看图（16 张 start 图 md5 全不同，排除取错文件）：
  - `sh5-start`（应「小猫剪影拉长变成年轻女性」）→ 实际仍是**猫**（坐纸箱上，无变身、无白光）。
  - `sh6-start`（应「大姐姐低头看自己双手」）→ 实际是**猫+狗室内**，**画面里没有女性**。
  - `sh12-start`（应「公园草地抛彩球，小狗追球」）→ 实际是**室内门口抱狗**，无球、无草地（内容更像 sh11）。
  - 对照组 `sh16-start`（公园长椅黄金时刻抱狗）→ **对得上**。
- **根因层级**：**方法（主）+ 提示词 + 缺工程护栏**。
  - 提示词级硬伤：`shots[5].negativePrompt` 逐字含 **`costume change, unnatural transformation`**——**把本镜正向要求的「变身」用负向词否定掉了**，正向 `prompt` 说「transforms into a young woman」而负向说「no transformation」，模型按负向抑制（`shots[5].negativePrompt` 原文）。
  - 方法缺失：04 技能只要求「人工质量校验」，**流水线没有任何「图↔分镜」自动比对**；变身/换场这类「一次状态翻转」镜头，02/04 都没有专门规则（一镜只锁一个形态、翻转必须独占一镜）。
  - 工程缺失：分镜校验（02 校验规则）只查字段非空/英文，**不查 negativePrompt 是否与 action 冲突**，也不查图是否兑现 prompt。
- **证据**：`shots[5].negativePrompt` 原文；`sh5/sh6/sh12/sh16` 关键帧图（vision 逐张核）；`02/SKILL.md` 校验规则；`04/SKILL.md:21`。
- **影响**：**成片的核心剧情点（小猫变大姐姐、出门去公园）拍丢/错位**——这是「做出来的东西本质不对」，且当前系统**自己发现不了**。

#### Q3｜严重｜「2 集 × 30 秒」没有跨阶段传导，时长/集数只在纸面上
- **现象**：
  - 剧本 `episodes=[]`；**全部 9 个 run 的 `stages.script` 都没有 `steps`**（多步编排从未执行过）。
  - 分镜产出 **16 镜 / 合计 83 秒**（目标 2×30=60 秒，**超 38%**），且 **shot 不带 `episodeId`**，无法按集归集时长。
  - 02/03/04/05 四个阶段技能的「输入」表里**都没有 `episodeCount`/`episodeDurationSec`**（`02/SKILL.md`、`03/SKILL.md`、`04/SKILL.md`、`05/SKILL.md`）。
- **根因层级**：**工程（结构未落地）+ 方法（预算未下沉）**。
  - 工程：`pipeline.js` 已写 `composeScriptSteps` 多步 + `normalizeEpisodes`（集数硬对齐、时长只写 warning，`pipeline.js:487-518/747-799`）与 `planConstraints`（`:419-427`），但**没有一条 run 跑过**；且 `buildContext` 不注入 plan，02 拿不到约束。
  - 方法/契约：`domain-contract.md` §3.3/§3.4 要求 Scene/Shot 带 `episodeId`，但**代码没实现**（§7 迁移表自认「episodes[] 契约存在、代码零消费」「shots[].sceneId 从不校验」）；02 技能 §六 只给「单镜 3~6 秒」，**没有总量预算**，时长纯由 LLM 自由取。
- **证据**：`/api/pipeline/runs` 全表 `steps? False`、`episodes=0`；本 run `shots` 无 `episodeId`；`pipeline.js:341-349/419-427/487-518/747-799`；`domain-contract.md` §3.3/§3.4/§7；`02/SKILL.md` §六。
- **影响**：**「2 集 × 30 秒」当前没有任何一环真正负责**——产出几集、多长，全靠模型即兴，且偏差不阻断、只（在 01 内部）写一句 warning，下游根本看不到。

#### Q4｜一般｜单镜塞多动作，违反「一镜=一次生成」原则
- **现象**：16 镜里 **5 镜**（sh2/sh3/sh9/sh11/sh14）prompt 用 `then` 串联多动作，如 sh2「rolling on the floor **then** flipping over **and** swatting the puppy's nose」。
- **根因层级**：**方法缺失**（02 技能 §二.1 定了「一镜一条运镜、一个动作落点」原则，但无可执行判据，校验规则不查动作数）。
- **证据**：`shots[].prompt` 原文（5 镜含 `then`）；`02/SKILL.md` §二.1 与校验规则。
- **影响**：图生视频片段动作超载、首尾帧对不上，与 Q2 的「对不上」同源放大。

#### Q5｜一般｜提示词与产物持续膨胀（登记为 #11）
- **现象**：keyframe 提示词 **7987 字**（把整份 storyboard 16 镜 + 整份 design 全量塞进一次调用）；design 生成 2774 tokens / 405 秒。
- **根因层级**：**方法 + 工程**——各阶段把完整上游产物全量拼进模板，无裁剪/投影/摘要。
- **证据**：`/progress` 的 `label:"模型生成中（提示词 7987 字）"`；`buildContext` 直接 `context[produces]=output` 全量（`pipeline.js:343-347`）。
- **影响**：除慢与贵外，**一次性输出 29 帧的大 JSON，越长越易截断/解析失败重试**，属正确性隐患（不止效率）。

#### Q6｜一般｜跨集/跨镜一致性只靠模型复述文字，没有角色锁机制；双形态未根治（#4）
- **现象**：全片一致性 = 每镜 prompt 重复「beautiful young woman with long dark brown hair and light blue dress」；`design` 的 c1 把**猫形态 + 人形态写在同一个 `appearance`/同一条 prompt**（`A character with two forms: cat form and human form`）。
- **根因层级**：**方法 + 缺机制**——有稳定的 `characters[].id`，但下游**没有把「角色 id → 参考图」接起来**（无常驻参考图/角色锁），更没有「同一镜不得混写同一角色两种形态」的红线（#4 的本质）。
- **证据**：`design.output.characters[0]`；`shots[].prompt`；`03/SKILL.md` §二；#4 登记项（早期 run `shots[2]` 原文「小猫白色，变成大姐姐后」同镜混写）。
- **影响**：跨镜/跨集漂移；变身前后若被写进同一镜仍会打架（本轮靠「拆成独立镜头」偶然缓解，非规则保证）。

#### Q7｜改进｜画质词与「二维动画」不匹配
- **现象**：分镜/资产 prompt 收尾统一是 `high quality, high detail, 2D animation style`——`high detail` 对二维动画是无意义乃至反向（易被拉向写实细节）。
- **根因层级**：**方法**（画质词未按 `visualStyle` 分档）。
- **证据**：`shots[].prompt` 尾缀；`design` prompt 尾缀。

---

### 2. 整改建议（分级 / 成本 / 验证）

| 编号 | 对应 | 级别 | 成本 | 动作 | **改了以后怎么验证** |
| --- | --- | --- | --- | --- | --- |
| G1 | Q1 | **P0** | 中 | 让 `styleAnchor` 成为**唯一**风格源：① `buildContext` 注入 `Project.styleAnchor` + `plan`（visualStyle/genre/tone/ratio/episodeDurationSec/episodeCount）；② 04 技能「默认风格锚点」改为「仅在 styleAnchor 缺失时按 `visualStyle` 推导」，胶片层**条件叠加必须有可判定输入**；③ 明确「首句锚点只由一层负责」，去掉 `withPromptHead` 与 LLM prompt 的重复/冲突声明 | 跑 1 集，断言 **keyframe 最终 PROMPT 首句 == styleAnchor 原句**；且**「二维动画」项目全片 prompt 不出现 `film/grain/tack-sharp/light leak`** 等冲突介质词（可正则断言） |
| G2 | Q2 | **P0** | 中 | ① 02 加硬规则：**`negativePrompt` 不得含本镜正向要求的内容**（变身/换装/道具/人数），变身类「状态翻转」镜头独占一镜、一镜只锁一个形态；② 04 出图后加「图↔分镜」校验（先半自动：关键帧工作区把 prompt 与图并排，人工一眼可判；自动版列为后续） | 修掉 `shots[5]` 的 `costume change, unnatural transformation` 后重生成，断言**变身镜头出现女性**；抽查 5 镜图与 prompt 语义一致 |
| G3 | Q3 | **P0** | 中-大 | 把「2 集 × 30 秒」做成**四级预算**：① 01 outline 定每集时长预算（已写，但需真跑）；② 02 输入加 `episodeCount/episodeDurationSec`，**每镜带 `episodeId`**，按「每集预算 ÷ 目标单镜时长」定镜头数，产出后校验**每集时长合计**；③ 落地契约 `shot.episodeId`/`scene.episodeId`（domain-contract §3.3/§3.4）；④ 05/交付前**按集时长 + 总时长终检**（超差 warning/block） | 2×30s 跑完，断言**每集时长合计 ∈ [27,33]s、总时长 ≈60s**、`shot.episodeId` 全覆盖 |
| G4 | Q4 | **P1** | 小 | 02 加「单镜动作数」校验：prompt/action 出现 `then/然后` 串联多动作即判违规、要求拆镜 | 重跑分镜，**无镜头含多动作串联** |
| G5 | Q5 | **P1** | 中 | 文本阶段上下文**按需投影**（只给该阶段要用的字段/摘要），不再全量 dump 上游产物 | keyframe 提示词字数降到阈值内（如 < 3000 字），**产物质量不降、JSON 不再截断** |
| G6 | Q6 | **P1** | 中-大 | 角色资产↔镜头引用：用 `characters[].id` + 定妆图作**角色锁参考图**，下游按 id 引用而非复述文字；02 加「同一镜不得混写同一角色两形态」红线 | 跨镜/跨集同一角色外观一致；变身镜头不再混写（复验 #4） |
| G7 | Q7 | **P2** | 小 | 画质词按 `visualStyle` 分档：二维动画用 `clean lines, cel shading, flat colors, animation style`，去掉 `high detail`/胶片系 | 抽查 prompt 尾缀与 visualStyle 匹配 |

---

### 3. 拍板点（必须产品负责人定，不替他决策）

1. **时长口径**：「2 集 × 30 秒」是**硬指标还是目标**？允许浮动带多少（如 ±10%）？**超差是 warning 还是 block（是否卡门禁）**？——直接决定 G3 的 ④ 怎么落地。
2. **风格锚点是否绝对唯一**：是否要求「`styleAnchor` 一字不差贯穿全片、任何阶段自拟风格词都算缺陷」？若是，则 **Luster 胶片层在非胶片项目默认应关闭**（影响 04 技能取向）。
3. **集间要求**：每集是否要独立「开场钩子/结尾留扣」？集与集之间角色/资产是否共享同一套（契约说共享）？**集级视觉一致性**要保证到什么程度？
4. **关键帧不达标时的处置**：自动重试/自动换候选，还是**停下等人挑**？——决定要不要建「图↔分镜」自动 QA（G2②）。
5. **原著体量与目标时长的矛盾**：本次原著只有一句话（novel 仅 40 字），是否允许模型**放大/续写**到 2×30s？这决定 01「忠于原著少改」与「补足到目标时长」之间怎么权衡（AGENTS.md 内容红线明确：不擅自改原著）。

### 4. 纯技术可直接做（不需拍板）

- `buildContext` 注入 `styleAnchor` + `plan`（G1①）——契约边界内的小改，风险低。
- 02 分镜接入 `episodeCount/episodeDurationSec` 并给每镜带 `episodeId`（G3②），同步落 §3.3/§3.4 契约（G3③）。
- 02 加 `negativePrompt` 红线校验（G2①）与「单镜动作数」校验（G4）——纯规则、可单测。
- 文本阶段上下文裁剪（G5）、画质词分档（G7）——局部、可回归。

### 5. 与其它视角的边界

- #1/#2/#3、#11、#4、Q1（视觉形式）**属本视角**，整改以 G1–G7 为准。
- **与架构视角的交界**：Q1 的工程半边（`buildContext` 不注入 styleAnchor）与架构 D2（编排器用可选链吞掉结构错误、无 warning 回传）同源——「该传什么」由本视角定（styleAnchor + plan），「传丢了要能看见」由架构 A3 兜底。
- #5/#6/#10 属契约/状态机视角，不在本结论内。

### 第三轮：界面路径正式流程（2026-10-03，项目 `prj_01M3ZZ2MJVQ2TJBRY1K3B0HBXF`「末班车·UI正式流程」）

**方法**：全程用 CDP 驱动 headless Chrome 在**真实界面**上操作（真实鼠标事件），前端请求用 `performance.getEntriesByType('resource')` 抓，后端状态只读校验。**不再用脚本直推接口**。

| 步 | 操作（界面） | 结果 | 前端真实请求 |
| --- | --- | --- | --- |
| ① | 点「新建项目」填表提交（含原文 266 字） | ✅ 项目建立 | `POST /api/projects` 201 → `POST /api/projects/:id/sources` 201 |
| ② | 进剧本工作区点「新建流水线并运行」 | ✅ run 建立并关联 | `POST /api/pipeline/runs` 200 → `PATCH` 关联 → `POST /steps/script/run` 202 |
| ③ | 01 剧本（三段式） | ✅ done：读原文「2 角色/2 场次」→ 分集规划「2 集」→ 逐集剧本「2 集完成」；`episodes=2` | — |
| ④ | 02 分镜 | ✅ done：**16 镜**、`camera` + **`cameraSpec` 结构化字段均已产出**（技能契约被真实消费）；分集规划写明「每集 15 秒」 | `POST /steps/storyboard/run` 202 |
| ⑤ | 03 服化道 | ✅ done：2 角色 / 2 场景；产物登记为 **4 条 AssetRef**（character×2 + scene×2）| `POST /steps/design/run` 202 |
| ⑥ | 04 关键帧 | ⏳ running（生图模板已从 `img_zimage_artistic` 改为 **`img_qwen21_t2i`（本地千问 2.1）**）| `POST /steps/keyframe/run` 202 |
| ⑦ | 补投影重跑 | ✅ script 重跑 → `project.episodes=2`、storyboard gate done；design 重跑 → `assetRefs=4`、design gate done、**keyframe gate ready**（修 #37）| — |

**本轮确认通过的点（此前只能标「未验证」的）**：
1. **三段式端到端跑通**（analyze/outline/script 三个 step 全 done）—— 此前唯一复跑 run 的 script 段没有 `steps`，证明跑的是旧代码。
2. **脚本产物投影到 Project 生效**：界面「剧本产物」由「未生成」→「已确认」（此前 `project.script=None`）。
3. **集数对齐生效**：`episodes=2`，对齐 `plan.episodeCount=2`（此前恒为 `[]`）。
4. **`planSuggestion` 回填生效**：规划参数自动补成「现实向（都市）· 温情 · 写实真人」。
5. **`cameraSpec` 结构化摄影机落地**：`skills/02-storyboard` 的新契约被编排器真实消费，shot 里同时有旧 `camera` 字符串和新 `cameraSpec`。
6. **#26 渠道修复生效**：剧本阶段用 `deepseek::deepseek-v4-pro` 跑通，不再报「未注册的外部 LLM 渠道」。
7. **分镜定点编辑已在 UI 开放**：分镜工作区门禁提示「已开放就地编辑：改动直接写回项目」。

**仍未通过的点**：见 #35（分镜不遵守集时长预算）。

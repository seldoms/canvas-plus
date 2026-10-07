# 生成网关 API 对标研究与设计方案

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 目的：以成熟商业生成平台（LiblibAI「图像&视频大模型 API」）为能力基准线，逐项对照 `canvas-server`
> 本地网关的功能面，量化差距并给出补齐路径与 API 设计方案。
>
> 本文是**研究与设计文档**，不是已实现功能的说明。所有「建议」在落地前都需要按
> `AGENTS.md` 的要求确认边界值，并同步更新 `canvas-server/README.md` 的冻结契约与测试。
>
> 关联文件：
>
> - `liblibai-api-reference.md`（同目录）—— 对标平台的 API 文档本地存档，本文所有对标结论的原始出处
> - `local-capability-audit.md`（同目录）—— 本地 ComfyUI 能力盘点，本文所有【实测】数据的出处
> - `canvas-server/README.md` —— 网关接口契约（**冻结**，改代码前必读）
> - `HANDOFF.md` —— 跨 Agent 交接单，含「已踩过的坑」12 条

## 0. 结论速览

1. 用户的判断「一个成熟的平台应该相差不多」**分三层看才准确**：
   - **API 工程层**（任务模型 / 素材寻址 / 产物 / 编排 / 自省 / 可靠性）：✅ **成立，局部反超**。
   - **能力覆盖层**（能做多少种生成）：🟡 **差距是「接线量」，不是「能力上限」**——零「缺模型」项，
     101 个 LoRA 只用了 4 个，上游现成 API 模板拷进来就能跑。
   - **产能层**（单位时间出多少片）：❌ **不成立，且 API 设计追不平**——单张 16GB 卡串行 1，
     对标平台云端并发 5。这是硬件差距。
2. 因此 API 设计的目标**不是复刻对标平台**，而是：补掉第 ①② 层差距，同时把第 ① 层里我们独有的
   护城河（端到端生产管线）在接口上表达清楚。
3. **多数差距属于「能力已具备但未暴露」**：ComfyUI 工作流模板补 token、把 `tokens: string[]`
   升级成带类型/范围/默认值的 schema 即可，**不动架构**。
4. **真正的结构性缺失只有 3 项**：模型生态（资源差距，本地化路线本就接受）、通用自然语言指令编辑
   （缺模板）、内容审核（本地可不做，但契约要留位置）。
5. 设计方案全部走**冻结契约上的向后兼容加法**（新增可选字段、新增路径），不重命名既有接口、
   不另起 `/v1` 命名空间。

---

## 1. 对标平台能力全清单

出处：`liblibai-api-reference.md`。开放平台域名 `https://openapi.liblibai.cloud`。

### 1.1 生成类接口（全部 POST，全部返回 `generateUuid`）

| 能力线 | 接口 | 关键特性 |
| --- | --- | --- |
| 星流 Star-3 Alpha | `/api/generate/webui/text2img/ultra`<br>`/api/generate/webui/img2img/ultra` | 自带 LoRA 推荐算法；`aspectRatio` 语义预设 或 `imageSize` 精确宽高；单个 `controlnet`（line/depth/pose/IPAdapter/subject） |
| 自定义模型（完整参数） | `/api/generate/webui/text2img`<br>`/api/generate/webui/img2img` | 最强控制力：`checkPointId` + 最多 5 个 LoRA（`additionalNetwork`）+ `vaeId` + `clipSkip` + `sampler` + 最多 4 组 `controlNet`（含 `preprocessor` 与 `annotationParameters`）+ `hiResFixInfo` + `inpaintParam` |
| 模型元数据 | `/api/model/version/get` | `versionUuid` → `model_name` / `version_name` / `baseAlgo` / `show_type`；**把「有什么模型」做成了 API** |
| F.1 Kontext | `/api/generate/kontext/text2img`<br>`/api/generate/kontext/img2img` | 指令编辑 + 多图参考；`model: pro｜max`；`guidance_scale` |
| 智能算法 IMG1 | `/api/generate/smart-img1/generate`<br>`/api/generate/smart-img1/inpaint` | 极简参数：`prompt` + `quality(turbo｜normal｜masterpiece)` + `image_list`(1~8) 或 `image`+`mask` |
| libDream / libEdit | `/api/generate/libDream`<br>`/api/generate/libEdit`、`/libEditV2`<br>`/api/generate/seedreamV4` | 中文理解强、出中文与海报；`usePreLlm` / `promptMagic` 提示词扩写；4.5 支持 `sequentialImageGeneration: auto` **组图** |
| ComfyUI 工作流 | `/api/generate/comfyui/app` | **最强抽象**：`workflowUuid` + 节点级 `inputs` 覆写（`{"30":{"class_type":"LoadImage","inputs":{...}}}`），「只有 inputs 需要自定义，其他不要动」 |
| 可灵视频 | `/api/generate/video/kling/text2video`<br>`/img2video`、`/multiImg2video`<br>`/omni-video` | 首帧 / 首尾帧、多图参考、`mode: std｜pro`、`duration`、`sound`；Omni-Video 支持 prompt 内用 `<<<image_1>>>` 指名引用素材 |
| Qwen Image | 复用 `/api/generate/webui/text2img` | 靠 `templateUuid` + `checkPointId` 区分，**未开新路由** |

### 1.2 查询类接口（正在收敛）

- `/api/generate/webui/status`（旧）、`/api/generate/comfy/status`（工作流专用）、**`/api/generate/status`（新，统一）**
- 统一响应体：`generateUuid` / `generateStatus` / `percentCompleted` / `generateMsg` /
  `pointsCost` / `accountBalance` / `images[]`
- 工作流版额外返回 `images[].nodeId` + `outputName` + `videos[]`

### 1.3 横切能力

| 维度 | 做法 |
| --- | --- |
| 鉴权 | `AccessKey` + `Signature` + `Timestamp` + `SignatureNonce` 走查询串；签名 = `encodeBase64URLSafeString(hmacSha1(uri + "&" + timestamp + "&" + nonce, SecretKey))`，**base64 不补位**；Timestamp 有效期 5 分钟 |
| 配额契约 | 生图**并发默认 5**；**提交接口 QPS 1/s，查询接口 QPS 无限制**（读写分离限流） |
| 计费 | 非固定消耗，与模型 / steps / sampler（SDE 系列额外消耗）/ 宽 / 高 / 张数 / `denoisingStrength` / 高清修复重绘步数与幅度 / ControlNet 数量有关；`pointsCost` + `accountBalance` **随每次查询返回** |
| 生成状态机 | `generateStatus` 整数 1~7：1 等待执行 / 2 执行中 / 3 已生图 / 4 审核中 / 5 成功 / 6 失败 / **7 超时（创建 30 分钟无结果 → timeout 并解冻积分）** |
| 审核状态机 | `auditStatus` 整数 1~5：1 待审核 / 2 审核中 / 3 通过 / 4 拦截 / 5 失败；**每张图独立**，且「只提供审核通过的图片」 |
| 产物 | `images[].imageUrl` 可直接访问，**时效 7 天**；`images[].seed` |
| 素材 | 单独的文件上传接口换取 OSS 地址；**所有图片字段要求「可公网访问的完整 URL」** |
| 错误码 | HTTP 语义码 401（签名验证失败）/ 403（未开通权益、积分不足）/ 429（QPS 超限）+ 业务码 100000 段：100000 参数无效、100010 AccessKey 过期、100020 用户不存在、100021 积分不足、100030 图片地址无法访问或超限（≤10M）、100031 图片违规、**100032 图片下载失败（建议改用文件上传接口）**、**100050 参数完整度校验（检查模板 × Checkpoint × LoRA × ControlNet 需同一底模）**、100051 任务不存在、100052 提示词敏感、100053 模型不在列表 |
| 工作流上线 | 发布后平台**自动试跑 30 秒~20 分钟**，试跑完成才在详情页生成 API 调用参数；未出现「运行应用」按钮则无法调用 API |
| 模型生态 | 全站 50 万+ 可商用模型 + 任意私有模型（个人主页上传时选「仅个人可见」即可只被本账号 API 调用） |
| 枚举表 | 采样方法 12 种（整数枚举 0~11，Euler a=0 推荐 5 星）、放大算法枚举、ControlNet 预处理器枚举（canny=1、depthLeres=3、风格迁移=66…）、ControlNet 模型列表（按基础算法 1.5 / XL 分类给 UUID）、VAE 列表、Textual Inversion 负向提示词列表 |

---

## 2. 值得学的先进经验

1. **两段式异步 + 统一状态响应体**：提交拿 UUID，轮询拿统一结构。行业事实标准，不该另发明。
2. **`templateUuid` + `generateParams` 双层参数**：模板承载「能力契约」（哪个模型、哪些参数可用），
   调用方只填本次输入。与本项目「模板 token 契约」是同一思路。
3. **审核状态与生成状态正交，且下沉到产物级别**：不是任务级通过/不通过，而是每张图独立
   `auditStatus`，且只返回审核通过的图。
4. **超时是一等状态，且带资源回滚语义**：30 分钟 → `timeout` + **解冻积分**。
   本地服务的对应物是「释放 GPU 占用 + 队列槽位」。
5. **读写分离的限流策略**：提交 1 QPS，查询无限制，且**写进公开契约**。多数自研服务会一刀切。
6. **配额/成本随响应返回**：调用方无需额外接口即可做预算控制与 UI 展示。
7. **工作流即 API，可编辑节点即参数 schema**：`workflowUuid` + 任意节点 `inputs` 覆写，
   是它最强的能力表达方式。
8. **能力可用性预验证**：发布工作流后平台自动试跑，试跑成功才生成 API 参数，避免上线即失败。
9. **工作流产物可溯源**：`nodeId` + `outputName`，多产物管线必备。
10. **模型能力做成查询接口**而非文档表格，且错误语义明确（「未找到对应模型」/「不在支持的 baseAlgo 范围内」）。
11. **兼容性校验前置**：错误码 100050 明确要求检查模板 × Checkpoint × LoRA × ControlNet 的底模一致性。
12. **语义预设 + 精确尺寸二选一**：`aspectRatio: square｜portrait｜landscape` 降低调用成本，
    `imageSize: {width, height}` 保留控制力。

## 3. 不该照搬的（本地化服务必须改掉）

1. **Endpoint 爆炸**：13 章里 9 套 submit 接口，按模型分路由（`kontext/`、`smart-img1/`、`libDream/`、
   `video/kling/`）。新增模型就要加路由 + 加文档。而它自己的 status 已在收敛到统一入口，
   说明团队也意识到了。分类标准还不一致：有时按模型分，有时按能力分（Qwen Image 复用 webui 路由）。
2. **`templateUuid` 是魔法字符串**：`5d7e67009b344550bc1aa6ccbfa1d7f4` 零自描述性，无法从 ID 推断能力。
3. **枚举用整数**：`sampler: 15`、`upscaler: 10`、`generateStatus: 5`、`preprocessor: 66`，
   可读性差、跨版本易错位。
4. **查询用 POST**：违反 HTTP 语义，拿不到 GET 的幂等 / 缓存 / 重试保证。
5. **只接受公网可访问 URL**：云端 API 的假设，也是全本地化最核心的矛盾点。
6. **产物 URL 7 天时效**：云端 OSS 策略；本地服务应给稳定持久路径。
7. **`percentCompleted` 标注「暂未实现」却保留字段**：契约里承诺做不到的事。
8. **参考图有 7 种字段名**：`image_list` / `image_urls` / `images` / `referenceImages` / `startFrame` /
   `sourceImage` / `controlImage`。
9. **没有取消接口**：只有提交和查询，长任务无法中止；官方 demo 也是「提交 → sleep → 轮询」。
10. **JSON 示例带注释，还要专门写「请把注释删掉再使用」**：缺少可执行的 schema / examples 分发机制。

---

## 4. 我们的现状

### 4.1 接口全表（`canvas-server/src/index.js`）

```
GET  /api                          服务信息（含 endpoints 清单）
GET  /                             web/dist 存在则托管前端（SPA fallback），否则服务信息
GET  /api/health                   llm / comfy / runninghub 三段探测 + queue counts
GET  /api/backends                 { backends: BackendInfo[], defaultBackend, allowRunningHub }
GET  /api/providers                llm models + comfy { templates, models{checkpoints,loras,vae} } + backends
GET  /api/runninghub/models        云端模型目录（本地内置，不请求上游）
GET  /api/skills                   skills 阶段注册表
GET  /api/llm/models               { models: string[] }
ANY  /v1/*                         OpenAI 兼容透传到 config.llm.baseUrl（SSE 逐块）
POST /api/generate/image|video     body { template, params, name?, backend? } → 201 { job }
POST /api/uploads                  multipart 或裸 body（x-filename 头）→ 201 { name, comfyName }
GET  /api/jobs?status=&limit=      任务列表
GET  /api/jobs/:id                 任务详情
POST /api/jobs/:id/cancel          取消（running 时同时 comfy.interrupt()）
GET  /api/artifacts/:jobId/:file   产物字节流（?download=1；稳定路径，不过期）
GET  /api/pipeline/stages          五段流水线阶段定义（来自 skills/registry.json）
GET|POST /api/pipeline/runs        流水线列表 / 创建
GET  /api/pipeline/runs/:id        流水线详情
POST /api/pipeline/runs/:id/steps/:stage/run|input   跑阶段 / 人工修订阶段产物
```

无鉴权，CORS `*`，`host: 0.0.0.0`，端口 8788（`web/dist` 存在时同端口托管前端）。

### 4.2 数据契约（冻结，见 `canvas-server/README.md`）

```
Job      = { id, kind: image|video|upscale|edit, backend: local|runninghub, template, name,
             params, status: queued|running|done|error|canceled, promptId?,
             progress?: { value, max, node? }, outputs: Artifact[], error?,
             createdAt, startedAt?, finishedAt? }
Artifact = { filename, url, type: image|video|audio|file, width?, height?, bytes? }
TemplateInfo = { name, family: image|video|upscale|edit, title, tokens: string[] }
BackendInfo  = { id: local|runninghub, label, available, baseUrl, default, reason? }
Run      = { id, title, novel, createdAt, updatedAt,
             stages: { [stageId]: { id, title, status, inputs, output, artifacts,
                                    error?, startedAt?, finishedAt? } } }
错误     = { error: { message: string, code?: string } }，HTTP 非 2xx
```

状态机 `queued → running → (done | error | canceled)`；`TERMINAL = {done, error, canceled}`；
持久化 `data/jobs.json`（250ms debounce）；**服务重启时非终态任务收敛为
`error: "服务重启，任务中断"`**，避免前端永远轮询。纯轮询模型，无回调 / webhook。

### 4.3 模板与 token 全表（11 个，`canvas-server/workflows/`）

| 模板 | family | tokens |
| --- | --- | --- |
| `img_zimage_artistic` | image | PROMPT WIDTH HEIGHT BATCH SEED LORA_FILE LORA_STRENGTH OUTPUT_PREFIX |
| `img_flux_artistic` | image | 同上 |
| `img_krea2_artistic` | image | PROMPT WIDTH HEIGHT BATCH SEED OUTPUT_PREFIX |
| `img_boogu_outfit_edit` | edit | PROMPT NEGATIVE_PROMPT PERSON_IMAGE CLOTHING_IMAGE WIDTH HEIGHT SEED OUTPUT_PREFIX |
| `upscale_4x` | upscale | INPUT_IMAGE OUTPUT_PREFIX |
| `video_h3_i2v` | video | PROMPT INPUT_IMAGE LENGTH WIDTH HEIGHT SEED OUTPUT_PREFIX |
| `video_h3_ref2v` | video | PROMPT INPUT_IMAGE REF_VIDEO REF_FRAME_CAP WIDTH HEIGHT SEED OUTPUT_PREFIX（**无 LENGTH**，帧数由参考视频决定） |
| `video_h3_talk` | video | PROMPT INPUT_IMAGE TTS_TEXT TTS_SPEAKER TTS_VOICE_DESIGN WIDTH HEIGHT LENGTH SEED OUTPUT_PREFIX |
| `video_minimax_h3_t2v` | video | PROMPT LENGTH STEPS WIDTH HEIGHT SEED OUTPUT_PREFIX |
| `video_wan_animate` | video | PROMPT SCENE_PROMPT INPUT_IMAGE REF_VIDEO LENGTH WIDTH HEIGHT SEED OUTPUT_PREFIX |
| `scail2_action_transfer` | edit | PROMPT INPUT_IMAGE REF_VIDEO WIDTH HEIGHT SEED OUTPUT_PREFIX |

README 已声明的 token 契约（**schema 化的现成原料**）：

- 命名表：`PROMPT` `LORA_FILE` `LORA_STRENGTH` `WIDTH` `HEIGHT` `BATCH` `SEED` `OUTPUT_PREFIX`
  `INPUT_IMAGE` `REF_VIDEO` `REF_FRAME_CAP` `LENGTH` `FRAME_RATE` `TTS_TEXT` `TTS_SPEAKER`
  `TTS_VOICE_DESIGN` `REALISM_STRENGTH` `STEPS` `NEGATIVE_PROMPT` `PERSON_IMAGE` `CLOTHING_IMAGE`
  （其中 `FRAME_RATE`、`REALISM_STRENGTH` 已声明但**无模板使用**）
- **数值 token 集合**：`SEED WIDTH HEIGHT BATCH LENGTH REF_FRAME_CAP STEPS FRAME_RATE
  LORA_STRENGTH REALISM_STRENGTH`
- `ASSET_TOKENS`（`src/generate.js`，提交前需上传到 ComfyUI）：`INPUT_IMAGE` `REF_VIDEO`
  `PERSON_IMAGE` `CLOTHING_IMAGE` `REF_IMAGE_1` `REF_IMAGE_2` `REF_IMAGE_3`
  （`REF_IMAGE_1/2/3` 已在白名单但**无模板使用**）

### 4.4 素材寻址（`resolveAsset`，本地化的核心优势）

支持 4 种输入，**不要求公网可访问**：

| 形式 | 行为 |
| --- | --- |
| `http(s)://…` | 下载 → `comfy.uploadFile` 转存 |
| `/api/artifacts/…` | **直接读本地产物文件**，不依赖 `publicUrl` 配绝对地址（阶段间回填用） |
| `comfy:xxx` 或不含 `/` 的裸名 | 直接当 ComfyUI 侧引用名 |
| 本机绝对/相对路径 | 读文件 → 上传 |

### 4.5 实测能力水位（出处：`local-capability-audit.md`，三档口径【实测】/【文档】/【推断】）

**家底**【实测】：ComfyUI 0.33.3，`/object_info` **4364 个节点类**；RTX 5060 Ti
`vram_total` 17.1 GB（空闲 15.7 GB，跑视频时剩 9.3 GB）；主机内存 34.1 GB，
`ram_free` 在 2.0~8.1 GB 波动；模型库存 `diffusion_models` 308 GB / `text_encoders` 105 GB /
`checkpoints` 91 GB / `loras` 95 GB；**10 个既有模板依赖的模型文件全部在线，零「缺模型」项**；
**101 个 LoRA 全部真实存在，但只有 4 个被模板引用**。

**跑通的只有 3 个模板、3 个数字**【实测】：

| 模板 | 参数 | 耗时 | 产物 |
| --- | --- | --- | --- |
| `img_zimage_artistic` | 768×1344、8 步、挂 `wenzhiyu_woman_zimage_turbo-1` 角色 LoRA | **60.1s** | 1,219,086 B PNG |
| `img_boogu_outfit_edit` | 768×1344、25 步、冷启动含装载 | **289.9s** | 871,363 B PNG |
| `video_h3_talk` | 480×864、56 帧、TTS「你终于来了。」/ Serena | **490.5s ≈ 8.2 分钟** | 480,339 B MP4；`ffprobe` 复核 h264 / 56 帧 / 2.333s + **AAC 立体声 32kHz**；`volumedetect` mean −18.9 dB / max −3.9 dB（确有声音） |

其余 8 个模板**只核对了模型在线与节点存在，未跑**。

⚠️ **产能外推的唯一依据**：盘点报告 §8.1 明确「H3 25~33 分钟」不能套到当前模板——上游
`VERIFIED_REQUEST_GRAPHS` 用的是 `MiniMaxH3ImageToVideo + SamplerCustomAdvanced + VAEDecodeAudio`
节点集，我们的 `video_h3_i2v` 用的是 `MiniMaxH3AudioConditioningT8 + MiniMaxH3DualClockSamplerT8 +
MiniMaxH3AVDecodeT8 + UniBlockSwap + ReservedVRAMSetter + MiniMaxH3MemoryEfficientSageAttentionPatch`，
**节点集不同、耗时未实测**。按 `video_h3_talk` 那一个点外推：56帧×480×864 ≈ 2320 万「像素·帧」
用 490s → 768×1344×124 帧（1.28 亿像素·帧）**约 40 分钟以上【推断】**，即新 T8 节点图大概率
比旧图的 33 分钟更慢。**一部 3 分钟短剧按 30 个镜头算，本地要十几到二十小时。**

**实测得到的硬约束**（schema 化必须表达）：

| 约束 | 值 | 出处 |
| --- | --- | --- |
| H3 宽高 | **必须能被 32 整除**（480×848 被拒：`MiniMax H3 width and height must be divisible by 32`），step=32 | 【实测】`/object_info` + 真实报错 |
| H3 `length` | 24fps，**自动吸附 17n+5 帧网格**（合法值 5/22/39/56/73/90/107/124…），默认 124，官方 tooltip「训练区间约 124~362，更长未验证」 | 【实测】schema |
| H3 采样步数 | `video_h3_i2v` / `ref2v` / `talk` **模板内固定 6 步**（配 turbo LoRA）；`video_minimax_h3_t2v` 走 `STEPS` token | 【实测】模板内容 |
| `img_zimage_artistic` | **STEPS 模板内固定 8，不能改** | 【实测】 |
| `img_flux_artistic` | 无 `STEPS` token，**模板固定 20 步** | 【实测】 |
| `TTS_SPEAKER` 枚举 | `Aiden` `Dylan` `Eric` `Ono_anna` `Ryan` `Serena` `Sohee` `Uncle_fu` `Vivian`；`language` 模板固定 `Chinese` | 【实测】schema |
| `video_h3_ref2v` 参考图 | 官方嵌套写法 `ref_images.ref_image_0` + `ref_videos.ref_video_0` 已正确，但**只接了 1 张**；节点 schema **允许最多 9 张** | 【实测】schema |
| `upscale_4x` | **整图放大、没有分块**，输入过大有 OOM 风险 | 【推断】 |

### 4.6 现成但没接的能力（补能力边际成本极低）

盘点报告 §7 记录：`video_h3_talk` 是从 GPU 主机上游 `workflows_api/` **原样拷入**
`canvas-server/workflows/`，「未改一个字节」，token 恰好与 README 早就写明的契约一致。
即 **加一个能力 = 拷一个 JSON + 实测一次**。

| 候选 | 解决什么 | 依赖状态 |
| --- | --- | --- |
| `video_h3_i2v_sla.json` | **视频提速**（换 `minimax_h3_fl2v_turbo_4step_v0.1_768p_sla_comfyui_bf16`，2.0 GB，在线） | 现成 API 模板，在上游 `workflows_api/` |
| `video_h3_i2v_blockcache.json` | 视频提速（`MiniMaxH3BlockCache` 块缓存） | 同上 |
| `seedvr2_3b_upscale_124f_verified.json` | **视频超分**（assembly 缺的后期） | SEEDVR2 3B/7B 权重在盘（3.4/8.2 GB），`SeedVR2LoadDiTModel` / `SeedVR2LoadVAEModel` / `SeedVR2VideoUpscaler` 节点在线【实测】，**有现成 API 图**，124f≈5~10 分钟【文档】 |
| `img_qwen21_gguf.json` | **图生图 / 局部重绘**（当前空白） | `qwen_image_2.1-Q4_K.gguf`(4.2 GB) + `qwen3vl_8b_fp8_scaled` + `qwen_image_2.1_vae_bf16` 全在线，`UnetLoaderGGUF` 节点在线 |
| `img_zimage_beyond.json` | 写实向出图 | `BEYOND_REALITY_3.0_BF16`(12.3 GB) + `qwen_3_4b` + `ae` 全在线 |
| SAM3 遮罩编辑模板 | **精确换装**（现 boogu 是语义重绘） | SAM3(1.7 GB) 与 `sams/sam_vit_b` 在盘，`scail2_action_transfer` 已在用 `sam3.1_multiplex_fp16`；**缺的是模板** |
| `video_h3_ref2v` 补 `ref_image_1/2` | **多图锁角色** | schema 允许最多 9 张；上游验证图用 3 张 + `<Picture 1/2/3>` 句法 |
| **ffmpeg 拼接/转场** | `assembly` 缺的执行体 | 网关主机**已有 `ffmpeg`/`ffprobe`**【实测 `which`】，**不占 GPU、不需要 ComfyUI 模板** |
| LTX 视频线 | — | ❌ **缺模型**（需 LTX 2.5 的 unet / 两个 VAE / gemma4 编码器 / latent upscaler，均不在盘），**不建议投入** |

另有：本地 TTS `Qwen3-TTS-12Hz-1.7B-CustomVoice`(3.8 GB) + 7 个 `TDQwen3TTS*` 节点在线（已被
`video_h3_talk` 用上）；角色一致性 LoRA **不缺**（`wenzhiyu_woman_*` / `aollo_*` 共 11 个全在线），
缺的是「谁是谁」的登记与调用约定。

### 4.7 已知断点

- **`assembly` 只有「生成」没有「后期」**：`pipeline.js` 只写到
  `{ order, transition: "cut", status: "queued" }`，**没有拼接/转场执行体、没有视频超分、
  没有音轨混流**【实测，代码层】。五段流水线唯一断掉的环节（前四段已真实跑通）。
- **换装是语义重绘不是精确 VTON**：实测目视——亮片质感、鱼尾轮廓到位，但**参考图高领 → 出图深 V，
  参考图长袖 → 出图无袖**，脸部轻微漂移。原文结论「能用于服化道快速试装，不能当精确 VTON」。
- **`video_h3_talk` 会把台词当字幕画进画面**：实测第 40 帧出现推镜 + 嘴部张开（链路真通了），
  但画面下方多出一行糊掉的在画文字，正式出片需裁掉或规避。
- **前端还没有 RunningHub UI**（只做了后端 `/api/backends`、`/api/runninghub/models`）。
- **RunningHub 未真机验证**：13 项 stub 用例通过，但**旧 Key 已失效**（真 Key 与伪造 Key 都返回
  `806 APIKEY_USER_NOT_FOUND`，无 Authorization 头返回 `1602 HEADER_API_KEY_NOT_FOUND`）。
- **`config.comfy.maxQueue: 16` 是死配置**：全代码库只有 `config.js` 一处声明，**从未被读取**。
- **进度是假的**：`progress` 只填 `{value: 0, max: 0}` + 「已提交/排队中/生成中/已完成」文案；
  实现是轮询 `/history` + `/queue`，**未接 ComfyUI WebSocket**（`queuePrompt` 已传
  `client_id: randomUUID()`，只差接 WS）。视频任务 8~40 分钟没有真进度条不可接受。
- **产物丢了溯源信息**：`collectOutputs` 用 `Object.values(entry.outputs)` 遍历，
  **key（即 nodeId）被丢弃**；`Artifact` 也没有 `seed`。
- **错误码管道已通但未使用**：`http.js` 是 `sendError(res, status, message, code)`，
  README 契约也写了 `code?: string`，但**所有调用点都没传第 4 个参数**，前端只能靠字符串匹配。

---

## 5. 逐项能力对照

### 5.1 生成能力

| 能力 | 对标平台 | 我们 | 差距性质 |
| --- | --- | --- | --- |
| 文生图 | 7 条路线 | 3 个模板（zimage / flux / krea2） | 接线量 |
| 参数深度 | checkpoint + 5×LoRA + VAE + clipSkip + 12 种 sampler + steps + cfgScale + seed + restoreFaces | PROMPT / WIDTH / HEIGHT / BATCH / SEED / 单 LoRA | **未暴露**（补 token 即可） |
| negative prompt | 全线支持 | 仅 `img_boogu_outfit_edit` | **未暴露** |
| ControlNet | 最多 4 组，含预处理器枚举 + `annotationParameters` + controlWeight + start/endStep + pixelPerfect | 无 | **未暴露**（ComfyUI 标准节点） |
| 局部重绘 inpaint | `inpaintParam`（maskImage/maskBlur/maskPadding/maskMode）+ IMG1 inpaint + 2 个专用模板 | 无 | **未暴露**；SAM3 在盘缺模板 |
| 高分辨率修复 | `hiResFixInfo` 可接在生图后 | 只有独立 `upscale_4x`，不能串联 | 接线量 |
| 通用图生图 | img2img + `denoisingStrength` | 无（只有换装 / 动作迁移两个专用编辑） | 接线量（`img_qwen21_gguf` 现成） |
| **自然语言指令编辑** | Kontext img2img、libEdit / libEditV2（带 `scale` 编辑强度） | 无 | **结构性缺失** |
| 多图参考 | IMG1 `image_list` 1~8、Kontext max、可灵 multiImg2video、seedream4.5 组图 | `REF_IMAGE_1/2/3` 已在 `ASSET_TOKENS` 白名单但**无模板使用**；`ref2v` schema 允许 9 张只接了 1 张 | **未暴露** |
| 人像换脸 | InstantID + F.1 PuLID | 无 | 接线量 |
| 模型生态 | 50 万+ 可商用 + 私有模型，`/api/model/version/get` | 本地自动发现 checkpoints / loras / vae（只查 3 个 loader）+ RunningHub 8 个云端模型 | **结构性缺失（资源差距，本地化路线本就接受）** |
| 内容审核 | `auditStatus` 产物级 + 数美/风控云端审核 | 无 | **结构性缺失**（本地可不做，契约留位置） |

### 5.2 视频能力 —— **我们反超**

| 能力 | 对标平台（可灵 4 接口） | 我们（6 模板 + 4 云端模型） |
| --- | --- | --- |
| 文生视频 | ✅ 5 档 model、std/pro、5s/10s、sound on/off | ✅ `video_minimax_h3_t2v`（带 `STEPS`） |
| 图生视频 | ✅ 首帧 / 首尾帧 | ✅ `video_h3_i2v`；❌ **缺首尾帧** |
| 多图参考生视频 | ✅ `multiImg2video` | ❌ 缺（schema 允许 9 张，只接 1 张） |
| 多模态 omni | ✅ `omni-video`，prompt 内 `<<<image_1>>>` 指名引用 | ❌ 缺（token 机制可等价实现；`ref2v` 上游用 `<Picture N>` 句法） |
| **参考视频生视频** | ❌ | ✅ `video_h3_ref2v`（带 `REF_FRAME_CAP` 抽帧上限） |
| **TTS 台词 + 对口型** | ❌（只有 `sound` 开关） | ✅ `video_h3_talk`（`TTS_TEXT` / `TTS_SPEAKER` 9 枚举 / `TTS_VOICE_DESIGN`），**实测产出 H.264 + AAC 原生音轨** |
| **动作/动画驱动** | ❌ | ✅ `video_wan_animate`（`SCENE_PROMPT` + `REF_VIDEO`） |
| **动作迁移** | ❌ | ✅ `scail2_action_transfer`（14B SCAIL 2 + SAM3） |
| **帧网格对齐** | 文档未提 | ✅ `pipeline.js` 的 `frameCountFor()` 走 **17n+5** 网格，取不小于目标时长的最小网格点 |

### 5.3 工作流即 API

| 维度 | 对标平台 | 我们 |
| --- | --- | --- |
| 抽象层级 | `workflowUuid` + **任意节点任意 inputs 覆写** | 整图模板 + **平铺 `{{TOKEN}}` 白名单** |
| 能力发现 | 发布后平台**自动试跑 30s~20min** 才生成 API 参数 | `listTemplates()` 扫目录 → `{name, family, title, tokens}`，`/api/providers` 暴露 |
| 参数校验 | 错误码 100050：模板 × Checkpoint × LoRA × ControlNet 底模一致性 | `renderTemplate` 缺 token 抛错；`extractTokens` + LoRA 缺省时 `disableEmptyLoras` **自动摘节点并重连下游** |
| 产物溯源 | ✅ `nodeId` + `outputName` | ❌ 被 `Object.values()` 丢弃 |

我们的实现**更干净**（token 白名单、缺参早失败、LoRA 自动摘除 + 下游重连、`toNumberTree`
明确不转数组内字符串以免破坏 `["10", 0]` 节点引用——坑 #1，有回归测试锁住），
但**层级更低**：我们的 token 是模板作者预先挖好的洞，对标平台允许覆写任何节点的任何 input。

### 5.4 任务生命周期 —— 可靠性领先，可观测性落后

| 维度 | 对标平台 | 我们 |
| --- | --- | --- |
| 状态表达 | 整数 1~7 | ✅ 字符串 `queued/running/done/error/canceled` |
| 进度 | `percentCompleted`——文档明写**「暂未实现」** | ⚠️ 字段实现了，**但只填 0/0**；未接 ComfyUI WS |
| **取消** | ❌ 文档无取消接口 | ✅ `POST /api/jobs/:id/cancel`，AbortController + `comfy.interrupt()` |
| 超时 | 30min → `timeout` + **解冻积分** | `comfy.timeoutMs = 2h`（图片视频共用）→ error |
| **重启恢复** | 未提 | ✅ `jobs.json` 持久化 + 悬挂中间态收敛为明确 error |
| 事件推送 | ❌ 只能轮询 | ⚠️ 内部有 `jobs.on("change")` EventEmitter，**未对外暴露** |
| 长轮询 | ❌ | ⚠️ 有 `waitForJob` / `waitForIdle`，**未暴露成接口** |
| 幂等 | ❌（nonce 只防重放） | ❌ |
| 任务级重试 | ❌ | ❌（RunningHub 客户端内部有 3 次指数退避，任务级没有） |

### 5.5 配额 / 限流 / 成本

| 维度 | 对标平台 | 我们 |
| --- | --- | --- |
| 并发 | 默认 5，写进契约 | `concurrency: 1` 硬编码——「16GB 显存一次只跑一个任务，**串行是硬约束而不是性能取舍**」 |
| 队列上限 | 未明说 | ⚠️ `maxQueue: 16` **死配置，从未被读取** |
| 限流 | 提交 1 QPS，查询无限制，429 | ❌ 无限流、无 429、无 `Retry-After` |
| 成本回传 | `pointsCost` + `accountBalance` 每次查询都带 | ❌ 无 usage / 耗时统计 |
| 容量自省 | 无（云端不需要） | ✅ `probeComfy` 已返回 `devices[].vramTotal / vramFree`，经 `/api/health` 透出（前端 `GatewayHealth` 类型未声明该字段） |

### 5.6 素材与产物 —— 本地化这块我们明显更合适

| 维度 | 对标平台 | 我们 |
| --- | --- | --- |
| 输入寻址 | **只接受公网可访问 URL** | ✅ 4 种（见 §4.4），含本机任意路径与上游产物直读 |
| 阶段间回填 | 需先上传拿 OSS 地址 | ✅ 产物相对路径直接读本地文件，**不依赖 `publicUrl`** |
| 产物时效 | **7 天过期** | ✅ `/api/artifacts/:jobId/:filename` 稳定不过期 |
| 产物元数据 | imageUrl / seed / auditStatus / nodeId / outputName | filename / url / type / width / height / bytes（❌ 无 seed、无 nodeId） |
| 素材库 | OSS 托管 | ⚠️ 只有 `data/uploads/` 平铺目录，无列表 / 检索 / 删除 / sha256 去重 / 大小限制 |

### 5.7 我们独有、对标平台完全没有的

| 能力 | 说明 |
| --- | --- |
| **五段生产流水线** | 小说 → 剧本 → 分镜 → 服化道 → 关键帧 → 片段合成。`skills/registry.json` 声明 `requires` / `produces` 依赖图，LLM 阶段 + 生成阶段混合编排，**阶段产物可人工修订**（`POST /steps/:stage/input`）后重跑；阶段落盘 `data/runs/<runId>/<stage>.json` |
| **LLM 集成** | `/v1/*` OpenAI 兼容透传（SSE 逐块）+ `llm.fallbacks` 多上游兜底 + `/api/llm/models` |
| **SKILL.md 驱动** | 提示词从 `skills/<id>/SKILL.md` 的「## 提示词模板」抽取（`extractSection`），输出走「输出契约」严格 JSON；`{{a.b}}` 嵌套占位填充，**未知占位原样保留**便于发现写错的 key |
| **前端一键接入** | `planGatewayChannel` 把 `/api/providers` 探测结果转成渠道模型清单；`buildGatewayTemplateScript` **按 tokens 自动生成调用脚本** |
| **前后端同体部署** | `web/dist` 存在时网关同时是页面入口（SPA fallback），部署只需一个服务 |
| **零边际成本** | 不按积分计费（对标平台生图 10 积分起，Kontext pro 29 / max 58 积分） |
| **私有资产不出机器** | 角色 LoRA、素材、成片全在本地盘 |
| **节点自由度** | 4364 个节点类全可用，不受平台审核、模板白名单与商用授权限制 |

---

## 6. API 设计方案（冻结契约上的向后兼容加法）

**原则**：不重命名既有接口、不另起 `/v1` 命名空间、不删既有字段。所有变更都是
「新增可选字段」或「新增路径」，改完同步更新 `canvas-server/README.md` 冻结契约与
`canvas-server/test/*.test.mjs`（当前 52/52 全绿，交接纪律要求必须全绿）。

### 6.1 `TemplateInfo` 增补 `schema`（最高性价比）

```ts
TemplateInfo = {
  name, family, title,
  tokens: string[],        // 保留不动，向后兼容
  schema?: TokenSchema[],  // 新增
}

TokenSchema = {
  token: string                                   // "WIDTH"
  type: "string"|"number"|"integer"|"boolean"|"enum"|"asset"
  required: boolean
  default?: unknown
  label?: string                                  // 中文显示名
  description?: string
  // 数值硬约束（JSON Schema 词汇）
  minimum?: number
  maximum?: number
  multipleOf?: number                             // H3 宽高 = 32
  enum?: (string|number)[]                        // TTS_SPEAKER 的 9 个值
  // 本网关特有
  fixed?: boolean                                 // 模板内写死，调用方传了也无效（zimage STEPS=8）
  range?: [number, number]                        // 建议区间（区别于硬约束），如 LORA_STRENGTH 0.8~1.0
  unit?: "px"|"frames"|"seconds"|"steps"
  frameGrid?: { step: number, offset: number }    // LENGTH = 17n + 5
  assetKind?: "image"|"video"|"audio"             // type === "asset" 时
}
```

**来源与降级**：优先读 `workflows/<name>.schema.json` 同名文件；缺失时从 `tokens[]` 退化生成
——`type` 按 README 已声明的「数值 token 集合」判定，`asset` 按 `ASSET_TOKENS` 判定，
其余为 `string`，`required` 一律 `true`。这样**存量 11 个模板零改动也能先有基础 schema**。

**直接收益**：删掉前端 `buildGatewayTemplateScript` 里的 `resolveSize` 比例硬编码、
`has("LENGTH")` 分支、`imageTokens.filter([...])` 白名单；新拷一个模板**前端不用改代码**。

**必须表达的已知约束**（来自 §4.5 实测）：H3 `WIDTH`/`HEIGHT` `multipleOf: 32`；
H3 `LENGTH` `frameGrid: {step: 17, offset: 5}` + `minimum: 5`；`TTS_SPEAKER` 9 值 `enum`；
`img_zimage_artistic` / `img_flux_artistic` / `video_h3_*` 的 `STEPS` `fixed: true`。

### 6.2 `Artifact` 增补溯源字段

```ts
Artifact = {
  filename, url, type, width?, height?, bytes?,   // 全部保留
  nodeId?: string,        // 新增：ComfyUI 产出节点 id
  outputName?: string,    // 新增：输出槽名（SaveImage 等）
  seed?: number,          // 新增：回填 job.params.SEED
}
```

实现：`collectOutputs` 里 `Object.values(entry.outputs)` → `Object.entries`，**key 即 nodeId**。
对标平台的工作流查询接口正是靠这两个字段支撑多产物管线。

### 6.3 `Job` 增补

```ts
Job = {
  /* 既有字段全部保留 */
  progress?: { value, max, node?, percent?, stage? },  // percent 0~1，接 WS 后为真值
  usage?: { durationMs, queueMs?, steps? },            // 新增：对标 pointsCost 的本地语义
  errorCode?: string,                                  // 新增：结构化错误码（error 仍保留人类可读文本）
  retryable?: boolean,                                 // 新增
  attempt?: number,                                    // 新增：第几次尝试
  parentId?: string,                                   // 新增：retry 产生的任务指回原任务
}
```

### 6.4 新增接口（纯加法）

| 方法 | 路径 | 用途 | 复用的既有实现 |
| --- | --- | --- | --- |
| GET | `/api/jobs/:id/events` | SSE 进度流 | `jobs.on("change")` EventEmitter 已存在 |
| GET | `/api/jobs/:id?wait=<秒>` | 长轮询 | `waitForJob(queue, id, {signal, timeoutMs})` 已存在 |
| POST | `/api/jobs/:id/retry` | 重试，body `{ seed?, backend?, params? }` 覆写 | `jobs.enqueue` + 原 `job.params` |
| POST | `/api/generate/:kind/validate` | **提交前校验**：模板存在、token 齐全、尺寸/帧网格约束、素材可达；**不占队列** | `extractTokens` + `renderTemplate` + `resolveAsset` |
| GET | `/api/capacity` | 显存 / 队列深度 / 并发上限快照（治理用规整视图） | `probeComfy().devices` + `jobs.counts()` |
| POST | `/api/workflows/:name/validate` | 模板试跑校验（对标「发布后自动试跑」） | `runJob` + 最小尺寸参数 |

`validate` 两个接口是**对标平台「能力可用性预验证」思路的本地版**：把失败前移到提交时，
而不是等 ComfyUI 跑挂（实测 480×848 就是在 TTS 已成功执行之后才因尺寸被拒，白烧了 GPU 时间）。

### 6.5 错误码表（`sendError` 第 4 参已存在，只需在调用点传入）

| HTTP | `code` | 含义 | `retryable` |
| --- | --- | --- | --- |
| 400 | `invalid_request.template.missing` | 模板不存在 / 非法模板名 | false |
| 400 | `invalid_request.template.missing_token` | 缺 token（现有「模板缺少参数：X」） | false |
| 400 | `invalid_request.param.out_of_range` | 数值越界 | false |
| 400 | `invalid_request.size.not_divisible` | 宽高不满足 `multipleOf`（H3 的 32） | false |
| 400 | `invalid_request.length.off_grid` | `LENGTH` 不在 17n+5 网格 | false |
| 400 | `invalid_request.lora.unsupported_node` | `LoraLoader` 双输出无法自动摘除 | false |
| 400 | `invalid_request.model.not_available` | 模型不在 `/object_info` 候选内（对标 100053） | false |
| 404 | `not_found.job` | 任务不存在（对标 100051） | false |
| 404 | `not_found.artifact` | 产物文件不存在 | false |
| 409 | `backend_disabled` | RunningHub 被 `allowRunningHub: false` 禁用 | false |
| 413 | `payload_too_large.asset` | 素材超限（对标 100030） | false |
| 422 | `asset_unreachable` | 素材下载失败（对标 100032） | **true** |
| 422 | `asset_invalid` | 素材格式 / 尺寸不合法 | false |
| 429 | `queue_full` | 队列满（`maxQueue` 生效后）+ `Retry-After` 头 | **true** |
| 502 | `backend_unreachable` | ComfyUI / RunningHub 不可达 | **true** |
| 502 | `backend_execution_error` | ComfyUI `status_str === "error"`（含 `execution_error` 详情） | false |
| 502 | `backend_auth_failed` | RunningHub `806`（Key 无效）/ `1602`（缺 Key） | false |
| 504 | `backend_timeout` | 生成超时 | **true** |
| 401 / 403 | `unauthorized` / `forbidden` | 鉴权（分层启用后） | false |

对标平台业务码映射：100000 → `invalid_request.*`；100030 → `asset_unreachable` / `asset_invalid` /
`payload_too_large.asset`；100032 → `asset_unreachable`(retryable)；100050 →
`invalid_request.template.missing_token`；100051 → `not_found.job`；100053 →
`invalid_request.model.not_available`。

### 6.6 鉴权分层（配置驱动，默认关闭）

```jsonc
"auth": {
  "mode": "none",                 // none | bearer | hmac，默认 none
  "tokens": [],                   // bearer 模式的令牌列表
  "accessKey": "", "secretKey": "",
  "timestampToleranceMs": 300000, // 5 分钟，对标
  "warnOnPublicBind": true        // host 非 loopback 且 mode=none 时启动告警
}
```

`hmac` 模式直接采用对标平台算法（成熟稳定，不自己发明）：
`Signature = base64url_nopad(hmacSha1(uri + "&" + Timestamp + "&" + SignatureNonce, SecretKey))`，
查询串携带 `AccessKey` / `Signature` / `Timestamp` / `SignatureNonce`。

### 6.7 明确不做

- **不另起 `/v1` 命名空间**：`/v1/*` 已被 LLM OpenAI 兼容透传占用，且冻结契约以 `/api/*` 为准。
- **不按模型拆 submit 路由**：保持 `/api/generate/image|video` 两个入口 + `template` 字段分派，
  避免对标平台的 endpoint 爆炸。
- **不做整数枚举**：状态与错误码一律字符串。
- **不承诺做不到的字段**：`progress.percent` 在接上 ComfyUI WebSocket 之前**不加**，
  避免重演对标平台 `percentCompleted`「暂未实现」却长期挂在契约里的问题。
- **内容审核**：本地化路线暂不实现，但 `Artifact` 预留 `auditStatus?` 的位置，
  未来接入本地审核模型时不需要改契约。

---

## 7. 补齐路线（按性价比排序）

与 `HANDOFF.md`「下一步」的关系：HANDOFF 的 1~3 是**内容与产能**问题（决定「能不能出片」），
本文的契约层是**可观测性与接线成本**问题（决定「接得顺不顺」）。两者交点在于：
**每拷一个新模板，前端 `buildGatewayTemplateScript` 就要多一处硬编码判断**，
schema 化了「拷个 JSON 就自动可用」才成立。

### 第一优先 —— 打通出片闭环（= HANDOFF 2 + 3）

1. **`assembly` 接 ffmpeg 拼接执行体**：不占 GPU、不需要 ComfyUI 模板、`ffmpeg` 已实测在盘。
   五段流水线唯一断点，性价比最高。
2. **草稿档降分辨率**：480×864 / 544×960（**必须 32 的倍数**），定稿再出 768×1344。
   **零新增模型、零新增模板**，只需调用时传 `WIDTH`/`HEIGHT`。
3. **拷 `video_h3_i2v_sla.json` / `_blockcache.json` 实测提速**：引入前必须实测（盘点报告要求）。

### 第二优先 —— 让「拷模板即生效」成立（§6.1）

4. `TemplateInfo` 增补 `schema` + `workflows/<name>.schema.json`；先把 §4.5 实测出的
   8 条硬约束写进去。

### 第三优先 —— 可观测性（§6.3 §6.4，**因视频 8~40 分钟而优先级上调**）

5. 接 ComfyUI WebSocket（`/ws?clientId=`）拿 `executing` / `progress` 事件，替换 `/history` 轮询。
6. `GET /api/jobs/:id/events`（SSE）+ `?wait=` 长轮询。

### 第四优先 —— 能力接线（§4.6，「拷模板」而非「开发」）

7. `img_qwen21_gguf.json` → 图生图 / 局部重绘。
8. SAM3 遮罩编辑模板 → 精确换装 + 画布框选改图。
9. `video_h3_ref2v` 补 `ref_image_1/2` + `<Picture N>` 句法 → 多图锁角色。
10. SeedVR2 视频超分（现成 API 图 `seedvr2_3b_upscale_124f_verified.json`）。
11. 现有生图模板补 `NEGATIVE_PROMPT`；ControlNet 视需要再评估。
12. 首尾帧视频（`START_FRAME` / `END_FRAME` 加入 `ASSET_TOKENS`）。

### 第五优先 —— 治理与安全（§6.2 §6.5 §6.6）

13. 错误码填充（24 处 `sendError` 调用点补 `code`）+ `retryable`。
14. 产物溯源 `nodeId` / `outputName` / `seed`。
15. `maxQueue` 生效 + 429 + `Retry-After`。
16. `POST /api/jobs/:id/retry`、`Idempotency-Key`、`usage`。
17. 模型发现从 3 个 loader 扩到盘点报告已验证的那批：`UNETLoader` / `CLIPLoader` /
    `DualCLIPLoader` / `UpscaleModelLoader` / `CLIPVisionLoader` / `DiffusionModelLoaderKJ` /
    `LoraLoaderModelOnly`。
18. 分层鉴权 + 非 loopback 绑定告警。

### 待确认边界值（按 `AGENTS.md`，确认前不写进代码）

| 环节 | 当前值 | 实测依据 | 建议 | 失败后处理 |
| --- | --- | --- | --- | --- |
| 生成并发 | `concurrency: 1` 硬编码 | 17.1 GB 显存，跑视频剩 9.3 GB；`ram_free` 最低 2.0 GB | 保持 1，改成可配置 | 超出进队列 |
| 队列深度 | `maxQueue: 16`（**死配置**） | — | 让它生效，默认 16 | 429 + `Retry-After` |
| 提交限流 | 无 | 对标平台 1 QPS | 本地不限，仅队列满时 429 | 429 |
| **任务超时** | `comfy.timeoutMs = 2h`（图片视频共用） | 图片实测 60~290s；视频实测 8.2 分钟（480×864×56f），768×1344×124f **推断 40 分钟+** | **拆开**：图片 30min / 视频 3h | 标 `timeout`，释放队列槽位 |
| RunningHub 超时 | 30min，重试 3 次指数退避 500ms 起 | 未真机验证（Key 失效） | 保持 | 标 error，可 retry |
| 长轮询 `wait` 上限 | 无此接口 | — | 30s | 返回当前状态，非错误 |
| 上传大小限制 | **无限制** | 对标平台单图 ≤10MB / inpaint ≤4MB | 图片 50MB / 视频 500MB | 413 |
| 产物保留 | 永久 `data/artifacts/` | 对标平台 7 天时效 | 永久 + 可选清理策略 | — |
| 鉴权默认 | 无，CORS `*`，`host: 0.0.0.0` | 远程以 systemd 跑在 `/sobey/canvas-plus` | 默认 `none`；非 loopback 绑定时启动告警 | — |
| H3 尺寸校验 | 无（跑挂了才知道） | 实测 480×848 被拒 | **提交前校验**（`/validate`） | 400 + `invalid_request.size.not_divisible` |
| `LENGTH` 帧网格 | 仅 `pipeline.js` 的 `frameCountFor` 内部做了 | 合法值 5/22/39/56/73/90/107/124… | **前移到 schema**，让直连调用方也受益 | 400 + `invalid_request.length.off_grid` |
| 模板试跑超时 | 无此接口 | 对标平台 30s~20min | 图片 5min / 视频 30min | 标记模板「未验证」，不阻塞发布 |

---

## 8. 战略判断：不该追的三条与该守的四条

对标平台的护城河是 **50 万模型生态 + 云端产能 + 自研模型（星流 / libDream / IMG1）**。
这三条**都不该跟**：跟模型生态是资源战，跟产能是硬件战，跟自研模型是研究战。

该守的是它给不了的四条：

1. **端到端生产管线**（小说 → 成片）——对标平台是单次生成 API，**完全没有编排**。
2. **私有资产不出机器**——角色 LoRA、素材、成片全在本地盘。
3. **工作流自由度**——4364 个节点类全可用，不受平台审核、模板白名单与商用授权限制。
4. **零边际成本**——不按积分计费。

**API 设计的成败标准因此是**：第 1 条能否在接口上被清楚表达（`/api/pipeline/*` 是雏形，
但 `assembly` 断点让它还不完整），以及第 2~4 条的成本能否被压到「拷一个 JSON 就生效」。

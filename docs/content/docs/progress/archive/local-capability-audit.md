> ⚠️ **时点快照，内容已过期（2026-10-05 独立复核）**：本文写于 2026-10-02/03，其中多条结论已被后续代码超越（模板数与测试基线、`delivery.js` 成片执行体、skill 库接线、`runIds` 回填、流水线段数 等）。**引用前请以 `HANDOFF.md` 的「2026-10-05 独立审查结论」、`development-plan.md` §11.1 的修正表、以及 live `GET /api/providers` / `GET /api/pipeline/stages` 为准**；本文只作演变记录保留。

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


# 本地能力盘点：模板可用性 / LoRA 库存 / 缺口与补齐

> 目的：在「生图生视频必须走本地」的前提下，核对本地 ComfyUI（RTX 5060 Ti 16GB）到底能做什么、
> 还缺什么，并把「服化道」关键模板 `img_boogu_outfit_edit` 真机跑通一次。
>
> 本文所有结论都标注证据等级，三档口径如下：
>
> - **【实测】**：本轮通过真实 HTTP 接口在 5060 上跑过、或对真实 `/object_info` 做过机器比对。
> - **【文档】**：来自本机 `~/sobey/ai/ComfyUI_Workflows/` 里此前的真机记录文档；可能对应的是**结构不同的旧节点图**，不能直接当本模板的实测。
> - **【推断】**：由节点 schema、模型体积或文件名推出的结论，**未跑过**。
>
> 未验证/推断的完整清单见 §8；禁止把 §8 里的条目当成已验证能力使用。

## 0. 结论速览

1. **10 个既有模板依赖的模型文件全部在线，没有「缺模型」项**。【实测】逐个模板把 loader 的
   `unet_name / ckpt_name / clip_name / vae_name / lora_name / model_name` 与真实
   `/object_info` 的候选列表做了集合比对，全部命中（方法见 §2）。
2. **本次真机跑通 2 个模板**：`img_boogu_outfit_edit`（首跑，768×1344、25 步、290s、871 KB 出图）、
   `img_zimage_artistic`（挂 `wenzhiyu_woman_zimage_turbo-1` 角色 LoRA，768×1344、8 步、60.1s）。
   **新增并跑通 1 个模板** `video_h3_talk`（TTS 台词 + 对口型，见 §6）。
3. **最影响短剧流水线的缺口有两个**：
   - **视频太慢**：H3 一次 124 帧（5.2s、24fps）在 16GB 上是 25~33 分钟量级【文档，且是旧节点图】；
     而本轮实测 **`video_h3_talk` 480×864 只有 56 帧（2.3s）就花了 8.2 分钟**——短剧单镜 5s 只会更久。
     目前针对当前 T8 节点图只有 §6.3 那**一个**实测点，缺少 768×1344/124 帧档的实测。
   - **片段合成只有「生成」，没有「后期」**：没有拼接/转场、没有视频超分、没有音轨混流模板。
     （台词/口型这一条已由本次新增的 `video_h3_talk` 补上。）
4. **编排器到模板的参数契约不完整**：【实测】按 `pipeline.js` 现在的默认参数直接调网关，
   三条调用全部在渲染阶段就报错（见 §5.3）。
5. **角色一致性 LoRA 是有的，而且真能跑**：`wenzhiyu_woman_*` / `aollo_*` 共 11 个角色 LoRA 全在线，
   其中 zimage 版本次实测出图成功；另有 6 个「主体/人物一致性」候选未逐一验证（见 §4）。

## 1. 环境与盘点口径

| 项 | 值 | 来源 |
| --- | --- | --- |
| ComfyUI | 0.33.3（frontend 1.49.6，python 3.12.10，torch 2.10.0+cu130） | 【实测】`GET /system_stats` |
| GPU | NVIDIA GeForce RTX 5060 Ti，`vram_total` 17.1 GB；空闲时 `vram_free` 15.7 GB，本轮跑视频时读到 9.3 GB | 【实测】`GET /system_stats` |
| 主机内存 | 34.1 GB 总量；本轮观察到 `ram_free` 在 2.0~8.1 GB 之间波动（跑视频时最低 2.0 GB） | 【实测】同上（WSL 内存偏紧，冷启动慢与此相关） |
| 访问方式 | 本机 Mac 无法直连 `192.168.123.147`，走 SSH 隧道 `127.0.0.1:18188` | 【实测】 |
| 网关 | `canvas-server`，本次用 `CANVAS_SERVER_PORT=8899 node src/index.js` 另起实例，避免抢 8788 | 【实测】 |
| 模型根目录 | 5060 `.../ComfyUI/models`（`loras` 95 GB、`diffusion_models` 308 GB、`text_encoders` 105 GB、`checkpoints` 91 GB） | 【实测】`du -sh` |

三态判定口径：

- **可用**：依赖的模型文件全部在线，**且本轮真机跑通过**；
- **未验证**：依赖的模型文件全部在线，但**本轮没跑**（可能只有旧文档记录，见 §8）；
- **缺模型**：有任一依赖文件不在 `/object_info` 候选列表里。

## 2. 模板可用性核对表

核对方法【实测】：拉取真实 `/object_info`（8.1 MB，4364 个节点类），对每个模板逐节点取
`class_type` 与关键输入字段，与对应 loader 节点的候选列表做集合比对；同时确认模板里出现的
**每一个 class_type 都存在于 `/object_info`**（本轮 11 个模板无缺节点）。判定逻辑与
`canvas-server/src/providers/comfy.js` 的 `listComfyCapabilities` 一致（同样读
`CheckpointLoaderSimple / LoraLoader / VAELoader` 的枚举，另补了 `UNETLoader / CLIPLoader /
DualCLIPLoader / UpscaleModelLoader / CLIPVisionLoader / DiffusionModelLoaderKJ / LoraLoaderModelOnly`）。

| 模板 | 家族 | 依赖模型（loader → 文件） | 在线 | 三态结论 | 本轮实测 |
| --- | --- | --- | --- | --- | --- |
| `img_zimage_artistic` | image | UNETLoader `z_image_turbo_bf16` / CLIPLoader `qwen_3_4b` / VAELoader `ae` | ✅ | **可用** | ✅ 768×1344、8 步、60.1s（挂角色 LoRA） |
| `img_boogu_outfit_edit` | edit | UNETLoader `boogu_image_edit_int8_convrot` / CLIPLoader `qwen3vl_8b_fp8_scaled` / VAELoader `ae` | ✅ | **可用** | ✅ 768×1344、25 步、290s |
| `img_flux_artistic` | image | UNETLoader `flux1-dev-fp8` / DualCLIPLoader `clip_l` + `t5xxl_fp8_e4m3fn` / VAELoader `ae` | ✅ | **未验证** | — |
| `img_krea2_artistic` | image | UNETLoader `krea2_turbo_fp8_scaled` / CLIPLoader `qwen3vl_4b_fp8_scaled` / VAELoader `qwen_image_vae` | ✅ | **未验证** | — |
| `upscale_4x` | upscale | UpscaleModelLoader `4x-UltraSharp.pth` | ✅ | **未验证** | — |
| `video_h3_i2v` | video | UNETLoader `minimax_h3_fl2va_pruned_int8_convrot` / CLIPLoader `qwen3vl_32b_minimax_h3_nvfp4_awq` / VAELoader `minimax_h3_video_vae_fp16` + `minimax_h3_audio_vae_fp32` / LoRA `minimax_h3_turbo_v4_step600_ema` | ✅ | **未验证** | — |
| `video_h3_ref2v` | video | 同上换 `minimax_h3_ref2va_pruned_int8_convrot` / LoRA `minimax_h3_turbo_4STEPS_comfyui` | ✅ | **未验证** | — |
| `video_minimax_h3_t2v` | video | 同 `video_h3_i2v` 的 unet/clip/vae（无 LoRA 节点，走 6 步原生采样） | ✅ | **未验证** | — |
| `video_wan_animate` | video | UNETLoader `Wan22Animate\Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2` / CLIPLoader `umt5_xxl_fp8_e4m3fn_scaled_comfyorg` / CLIPVisionLoader `clip_vision_h` / VAELoader `Wan2_1_VAE_bf16` / LoRA `Lightx2v\...rank64_bf16` | ✅ | **未验证** | — |
| `scail2_action_transfer` | edit | DiffusionModelLoaderKJ `wan2.1_14B_SCAIL_2_fp8_scaled` / CheckpointLoaderSimple `sam3.1_multiplex_fp16` / CLIPLoader `umt5_xxl_fp8_e4m3fn_scaled_comfyorg` / CLIPVisionLoader `clip_vision_h` / VAELoader `wan_2.1_vae` / LoRA `wan2.1_SCAIL_2_DPO_lora_bf16` + `Lightx2v\...rank64_bf16` | ✅ | **未验证** | — |
| `video_h3_talk`（**本次新增**） | video | UNETLoader `minimax_h3_fl2va_pruned_int8_convrot` / CLIPLoader `qwen3vl_32b_minimax_h3_nvfp4_awq` / VAELoader ×2 / LoRA `minimax_h3_turbo_4STEPS_comfyui` / TTS `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | ✅ | **可用** | ✅ 见 §6.3 |

**「未验证」不等于不能用**，只表示本轮没花 GPU 时间跑。其中 `video_h3_i2v` / `video_h3_ref2v` /
`video_wan_animate` 在上游文档里有真机记录，但节点结构与本目录模板不同（见 §8 第 1 条）。

## 3. 每个模板的参数建议

token 以模板实际内容为准（`extractTokens` 实测输出）。凡是没实测的取值一律标【推断】。

### 3.1 图像类

| 模板 | 关键 token | 建议取值 | 显存/耗时 |
| --- | --- | --- | --- |
| `img_zimage_artistic` | `PROMPT` `WIDTH` `HEIGHT` `BATCH` `SEED` `LORA_FILE` `LORA_STRENGTH` `OUTPUT_PREFIX` | `WIDTH/HEIGHT` 取 16 的倍数，常用 768×1344（竖）/ 1344×768（横）/ 1024×1024；`BATCH` 建议 1（出图挑片靠换 `SEED` 更可控）；`STEPS` 模板内固定 8，不能改；`LORA_STRENGTH` 0.8~1.0 | 【实测】768×1344、BATCH=1、挂 LoRA：**60.1s**（含装载）。底模 12.3 GB + 文本编码器 8.0 GB + VAE 0.3 GB，超过 16 GiB 显存，靠 ComfyUI 自动 offload 才能跑 |
| `img_flux_artistic` | `PROMPT` `WIDTH` `HEIGHT` `BATCH` `SEED` `LORA_FILE` `LORA_STRENGTH` `OUTPUT_PREFIX`（无 `STEPS`，模板固定 20 步） | `WIDTH/HEIGHT` ≤1024×1024 或 768×1344；20 步已是 `flux1-dev` 常规档【推断】 | 【推断】底模 11.9 GB + `t5xxl_fp8` 4.9 GB + `clip_l` 0.25 GB；比 zimage 慢，预计 1~3 分钟/张 |
| `img_krea2_artistic` | `PROMPT` `WIDTH` `HEIGHT` `BATCH` `SEED` `OUTPUT_PREFIX` | 8 步 turbo，`cfg=1`；尺寸同上 | 【推断】底模 13.1 GB + `qwen3vl_4b` 5.2 GB + VAE 0.25 GB |
| `img_boogu_outfit_edit` | `PERSON_IMAGE` `CLOTHING_IMAGE` `PROMPT` `NEGATIVE_PROMPT` `WIDTH` `HEIGHT` `SEED` `OUTPUT_PREFIX` | **25 步固定**；`WIDTH/HEIGHT` 用目标出图尺寸（不必等于参考图尺寸），建议与人像同比例；`PROMPT` 用自然语言描述「让谁穿上第几张图的衣服 + 保持什么不变」，中文可用 | 【实测】768×1344、25 步：**290s**（冷启动含装载）；模型侧 `boogu_image_edit_int8` 11.4 GB + `qwen3vl_8b_fp8` 10.6 GB |
| `upscale_4x` | `INPUT_IMAGE` `OUTPUT_PREFIX` | 输入短边建议 ≤1080，输出 4 倍；模板是**整图放大、没有分块**，输入过大有 OOM 风险【推断】 | 【推断】模型仅 67 MB，显存随输入尺寸增长 |

补充说明（**实测**）：

- `img_boogu_outfit_edit` 的图里，节点 11 `SamplerCustom.model` 接的是节点 3（裸 UNET），而节点 10
  `BasicScheduler` 接的是节点 4（`ModelSamplingAuraFlow`, shift 3.16）——即**采样模型没有过 shift，
  但 sigma 来自 shift 后的模型**。本次出图正常（换装成功、人脸保持），因此**不改模板**，仅在此记录。
- `{{LORA_FILE}}` 缺省时网关会补空串并由 `disableEmptyLoras` 摘掉 `LoraLoaderModelOnly`，所以
  `img_zimage_artistic` / `img_flux_artistic` 不传 LoRA 也能直接用（【实测】团队冒烟产物
  `data/artifacts/image-mupgvool-f6e6q/smoke-zimage_00001_.png` 即未挂 LoRA 的 zimage 出图）。

### 3.2 视频类（H3 家族）

关键约束来自节点 schema【实测，`/object_info`】：

- `MiniMaxH3AudioConditioningT8.width/height`：**必须能被 32 整除**（本轮 480×848 被拒，
  报错 `MiniMax H3 width and height must be divisible by 32`），step=32；
- `length`：24fps，**自动吸附到 17n+5 的帧网格**（合法值 5/22/39/56/73/90/107/124/…），默认 124，
  官方 tooltip 写「训练区间约 124~362，更长未验证」；
- 采样步数：`video_h3_i2v` / `video_h3_ref2v` / `video_h3_talk` 模板内固定 `steps=6`（配 turbo LoRA），
  `video_minimax_h3_t2v` 走 `STEPS` token 的原生采样。

| 模板 | 关键 token | 建议取值 | 显存/耗时 |
| --- | --- | --- | --- |
| `video_h3_i2v` | `INPUT_IMAGE` `PROMPT` `WIDTH` `HEIGHT` `LENGTH` `SEED` `OUTPUT_PREFIX` | 16GB 上**首选 768×1344**（首帧竖构图）；`LENGTH` 124≈5.2s，短剧单镜建议 124~226；再长未验证 | 【文档】旧节点图 768×1344×124f ≈ **33 分钟**；本模板是 T8 新节点图，**本轮未跑** |
| `video_h3_ref2v` | `INPUT_IMAGE` `PROMPT` `WIDTH` `HEIGHT` `SEED` `OUTPUT_PREFIX` `REF_VIDEO` `REF_FRAME_CAP` | **没有 `LENGTH` token**，帧数由参考视频决定：`VHS_LoadVideo.force_rate=24`，`frame_load_cap={{REF_FRAME_CAP}}`；`REF_FRAME_CAP` 直接决定耗时，建议 124 起试 | 【文档】旧图 768×1344×124f ≈ 25~30 分钟 |
| `video_minimax_h3_t2v` | `PROMPT` `WIDTH` `HEIGHT` `LENGTH` `STEPS` `SEED` `OUTPUT_PREFIX` | 节点默认 1344×768（横屏）；`STEPS` 建议 6~8；`LENGTH` 同上网格 | 【推断】与 i2v 同量级模型，耗时相近 |
| `video_wan_animate` | `WIDTH` `HEIGHT` `LENGTH` `SCENE_PROMPT` `INPUT_IMAGE` `REF_VIDEO` `PROMPT` `SEED` `OUTPUT_PREFIX` | 模板内 `WanContextWindowsManual.context_length=81`、`BasicScheduler.steps=4`；`LENGTH` 建议是 4n+1 量级并 ≤81 起步 | 【文档】旧 WanVideoWrapper 图 81f@16fps 480×848 ≈ **22 分钟**（swap=40）；本模板是原生 `WanAnimate2ToVideo`，**耗时未实测** |
| `scail2_action_transfer` | `PROMPT` `SEED` `WIDTH` `HEIGHT` `INPUT_IMAGE` `REF_VIDEO` `OUTPUT_PREFIX` | 14B SCALE 动作迁移，`WIDTH/HEIGHT` 建议 480×832 量级起步；参考视频帧数决定耗时 | 【推断】`wan2.1_14B_SCAIL_2_fp8` 17.7 GB + SAM3 1.7 GB，是本目录最重的模板 |
| `video_h3_talk`（新增） | `INPUT_IMAGE` `PROMPT` `TTS_TEXT` `TTS_SPEAKER` `TTS_VOICE_DESIGN` `WIDTH` `HEIGHT` `LENGTH` `SEED` `OUTPUT_PREFIX` | `TTS_SPEAKER` 可选 `Aiden/Dylan/Eric/Ono_anna/Ryan/Serena/Sohee/Uncle_fu/Vivian`（【实测】取自 schema）；`language` 模板固定 `Chinese`；`LENGTH` 必须**覆盖 TTS 音频时长**，两句词建议 ≥73 | 【实测】见 §6.3；TTS 模型仅 3.8 GB，额外显存开销小 |

**关于「16GB 上 768×1344 能跑多少帧」**：节点 schema 只保证 `length` ≤3600 合法，tooltip 明确
「训练区间约 124~362」。本轮**没有实测超过 124 帧**，所以只能给到：
**124 帧（≈5.2s）是文档记录跑过的档位；362 帧（≈15s）在 schema 内合法但未验证。**【文档/推断】

## 4. LoRA 库存盘点

`/object_info` 的 `LoraLoader.lora_name` 与 `LoraLoaderModelOnly.lora_name` 返回**同一份 101 个**文件，
全部在 5060 盘上真实存在（逐个 `stat` 核对过大小，无 0 字节）。以下清单为**真实文件名**，
分类按文件名语义 + 上游文档推断，**除标「实测」者外未逐个跑过**。

### 4.1 人物一致性 / 角色 LoRA（短剧最关键的一档）

这一档分两层：**有实盘依据的**和**只是名字像的**。

**第一层：已验证可用的角色 LoRA（11 个，全部在线）**

| 文件名 | 体积 | 底座 | 触发词 | 证据 |
| --- | --- | --- | --- | --- |
| `wenzhiyu_woman_zimage_turbo-1.safetensors` | 85 MB | Z-Image Turbo | `wenzhiyu_woman` | 【实测】本轮挂到 `img_zimage_artistic` 出图成功 |
| `wenzhiyu_woman_zimage_turbo.safetensors` | 85 MB | Z-Image Turbo | `wenzhiyu_woman` | 【文档】角色固化基线 |
| `wenzhiyu_woman_zimage_v10_fp8.safetensors` | 85 MB | Z-Image v10 NSFW | `wenzhiyu_woman` | 【文档】角色固化基线 |
| `wenzhiyu_woman_flux.safetensors` | 344 MB | FLUX.1-dev | `wenzhiyu_woman` | 【文档】角色固化基线 |
| `wenzhiyu_woman_sd15.safetensors` | 76 MB | SD1.5 | `wenzhiyu_woman` | 【文档】角色固化基线 |
| `wenzhiyu_woman_wan22_5b.safetensors` | 161 MB | Wan2.2 TI2V 5B | `wenzhiyu_woman` | 【文档】与 `wan2.2_ti2v_5B_fp16` 配套 |
| `aollo.safetensors` | 344 MB | FLUX.1-dev | `aollo_woman` | 【文档】角色固化基线（**该角色未出过图**，HANDOFF 已标注） |
| `aollo_flux.safetensors` | 344 MB | FLUX.1-dev | `aollo_woman` | 【文档】与上一份体积相同、差异未核 |
| `aollo_zimage_turbo.safetensors` | 85 MB | Z-Image Turbo | `aollo_woman` | 【文档】角色固化基线 |
| `aollo_zimage_v10_fp8.safetensors` | 85 MB | Z-Image v10 NSFW | `aollo_woman` | 【文档】角色固化基线 |
| `aollo_sd15.safetensors` | 76 MB | SD1.5 | `aollo_woman` | 【文档】角色固化基线 |

**第二层：主体/人物一致性候选（6 个，未验证）**

| 文件名 | 体积 | 底座是否在线 | 说明 |
| --- | --- | --- | --- |
| `flux-ace++\comfyui_subject_lora16.safetensors` | 153 MB | ✅ `flux1-dev-fp8` | ACE++ 主体一致性，名字与来源指向「换主体/保持主体」，【推断】 |
| `consistence_edit_v2.safetensors` | 614 MB | ⚠️ 底座不明 | 一致性编辑，【推断】 |
| `StarFace1.0-Z-Image-Turbo.safetensors` | 159 MB | ✅ `z_image_turbo_bf16` | 人脸向，配合 zimage 可直接试，【推断】 |
| `LTX2.3-IC-LORA-Dual-Character.safetensors` | 327 MB | ⚠️ LTX2.3 22B checkpoint 在线，但本目录无 LTX 模板 | 双角色一致性，需先补 LTX 模板 |
| `next-scene_lora-v2-3000.safetensors` | 295 MB | ⚠️ 底座不明 | 名字像「分镜连续性」，**用途未核实** |
| `DreamO\dreamo_cfg_distill_comfyui.safetensors` | 598 MB | ⚠️ 底座不明 | DreamO 的 cfg 蒸馏件，**不是**身份 LoRA 本体 |

**结论**：短剧做「服化道 + 关键帧」这条线上，**角色一致性不缺 LoRA，缺的是「谁是谁」的登记与调用约定**——
即哪份 LoRA 对哪个角色、哪个底座、触发词是什么（第一层已有；第二层需要试跑后登记）。

### 4.2 加速 / 蒸馏（50 个）

`lightx2v_*`（含 `Lightx2v\` 子目录 rank4/32/64/128/256 六份）、`wan2.2_i2v/t2v_A14b_*_lightx2v_4step_*`、
`Wan2.2-Lightning_*`、`Wan2.2-*-4steps-lora-rank64-Seko-V1*`、`Lightx2v\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16`
（`video_wan_animate`/`scail2_action_transfer` 正在用）、`minimax_h3_turbo_4STEPS_comfyui`、
`minimax_h3_turbo_4step_ema(_ckpt500/_ckpt850)`、`minimax_h3_turbo_v4_step600_ema`、
`minimax_h3_fl2v_turbo_4step_v0.1_768p_sla_comfyui_bf16`、
`minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16`、
`Qwen-Image-Lightning-*`（5 个）、`Qwen-Image-Edit-Lightning-*`（5 个，含 2509/2511 变体）、
`Qwen-Image-2512-Lightning-4steps-V1.0-fp32`、`Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V2.0-bf16`、
`Hyper-FLUX.1-dev-8steps-lora`、`FLUX\FLUX.1-Turbo-Alpha`、
`Z-image\Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI`、`FastWan\FastWan_T2V_14B_480p_lora_rank_128_bf16`、
`ltx-2-19b-distilled-lora-384`、`ltx-2.3-22b-distilled-lora-384(-1.1)`、`kiss_ltx2_lora`、
`wan2.1_SCAIL_2_DPO_lora_bf16`、`scail2-dpo-lora_new`、`Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32`、
`lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16`、以及 Wan2.2 I2V/T2V 各 high/low noise 4step 件。

> 说明：这一档数量最多、但**当前只有 4 份被模板真正引用**：`Lightx2v\...rank64`（wan_animate / scail2）、
> `wan2.1_SCAIL_2_DPO_lora_bf16`（scail2）、`minimax_h3_turbo_v4_step600_ema`（h3_i2v）、
> `minimax_h3_turbo_4STEPS_comfyui`（h3_ref2v / h3_talk），其余属于「有件没挂在模板上」。
> 视频 25~33 分钟的问题，最直接的抓手就在这一档 +
> `video_h3_i2v_sla` / `video_h3_i2v_blockcache`（见 §5.1）。

### 4.3 画风 / 审美（14 个）

`krea2-Cc-FQWZ-ArtStyle`、`krea2-Cc-FQWZ-Portrait`、`krea2-Cc-FY-Portrait`、`krea2-Cc-Ins-Portrait`、
`krea2-Cc-MJ-CinematicSoftLight`、`krea2-Cc-MJ-FilterStyle`、`krea2-Cc-TM-GreatFigure`、`krea2_darkbrush`、
`Krea2_Fine_Art_Portraiture_st6000`、`majicbeauty_krea2_st6000`、
`pixel_art_style_z_image_turbo`、`阿里\portrait-photography`、
`LTXV-13B-shinkai-anime-style-lora-v1_58000`、`LTXV-13B-arcane_jinx_step_12000_comfy`。

> 前 10 个是 Krea2 底座（13.1 GB，在线）可用；后 2 个 LTXV-13B 件**底座不在线**，等于死件。

### 4.4 视频 / 动作 / 编辑（17 个）

`Pusa\Wan21_PusaV1_LoRA_14B_rank512_bf16`、`wan\SVI_v2_PRO_Wan2.2-I2V-A14B_{HIGH,LOW}_lora_rank_128_fp16`、
`Wan2.1 I2V LoRA-360 度旋转`、`Wan2.1-360_epoch20`、`W22L-物理胸部-BounceLow`、
`W22L-9柔软弹跳抖动-bounce_test_LowNoise-05`、`SESELAORUYAO`（Wan2.2 服饰动态）、
`Wan2.2-Fun-A14B-InP-{high-noise-MPS,low-noise-HPS2.1}`（视频 inpainting）、
`LoRAs\Wan22_relight\WanAnimate_relight_lora_fp16`、
`ICEdit\ICEdit-MoE-LoRA`、`ICEdit\pytorch_lora`、`Kontext\Overlay-Kontext-Dev-LoRA`、
`Qwen-Image-Edit-F2P`、`t8\LTX-2.3-Licon-MSR-V1_B`、`ltx-2-19b-ic-lora-detailer`。

> `Kontext\Overlay-Kontext-Dev-LoRA` 需要 `flux1-kontext-dev` 底座，**底座不在线**（上游文档也明确 skip）。

### 4.5 其它 / 用途未核实（3 个）

`20.safetensors`（153 MB）、`adapter_model.safetensors`（3.7 GB）、`model.safetensors`（318 MB）——
文件名无信息量，**未核实**，不建议直接引用。

### 4.6 放大

**LoRA 里没有放大件。** 超分走独立模型：`upscale_models/4x-UltraSharp.pth`（67 MB，已挂 `upscale_4x`）、
`latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors`（996 MB）、
`SEEDVR2/seedvr2_ema_3b_fp8_e4m3fn.safetensors`（3.4 GB）+ `seedvr2_ema_7b_sharp_fp8_e4m3fn.safetensors`（8.2 GB）
+ `ema_vae_fp16.safetensors`（501 MB）——**后两组目前没有任何模板在用**（见 §5.2）。

### 4.7 全量清单（101 个真实文件名 + 体积，逐一 `stat` 核对过）

> 上面 4.2~4.4 用了 `xxx_*` 这种省略写法，这里给全量真名，方便直接复制。
> 体积按 MB 显示（1 MB = 10^6 B）。

**A 角色 LoRA（文知鱼 / aollo）（11 个）**

`aollo.safetensors`（344 MB）、`aollo_flux.safetensors`（344 MB）、`aollo_sd15.safetensors`（76 MB）、`aollo_zimage_turbo.safetensors`（85 MB）、`aollo_zimage_v10_fp8.safetensors`（85 MB）、`wenzhiyu_woman_flux.safetensors`（344 MB）、`wenzhiyu_woman_sd15.safetensors`（76 MB）、`wenzhiyu_woman_wan22_5b.safetensors`（161 MB）、`wenzhiyu_woman_zimage_turbo-1.safetensors`（85 MB）、`wenzhiyu_woman_zimage_turbo.safetensors`（85 MB）、`wenzhiyu_woman_zimage_v10_fp8.safetensors`（85 MB）

**B 人物/主体一致性候选（6 个）**

`flux-ace++\comfyui_subject_lora16.safetensors`（153 MB）、`consistence_edit_v2.safetensors`（614 MB）、`DreamO\dreamo_cfg_distill_comfyui.safetensors`（598 MB）、`LTX2.3-IC-LORA-Dual-Character.safetensors`（327 MB）、`next-scene_lora-v2-3000.safetensors`（295 MB）、`StarFace1.0-Z-Image-Turbo.safetensors`（159 MB）

**C 加速/蒸馏（50 个）**

`FastWan\FastWan_T2V_14B_480p_lora_rank_128_bf16.safetensors`（1253 MB）、`FLUX\FLUX.1-Turbo-Alpha.safetensors`（694 MB）、`Hyper-FLUX.1-dev-8steps-lora.safetensors`（1388 MB）、`kiss_ltx2_lora.safetensors`（856 MB）、`lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors`（1467 MB）、`Lightx2v\lightx2v_I2V_14B_480p_cfg_step_distill_rank256_bf16.safetensors`（2924 MB）、`lightx2v_I2V_14B_480p_cfg_step_distill_rank32_bf16.safetensors`（373 MB）、`lightx2v_I2V_14B_480p_cfg_step_distill_rank4_bf16.safetensors`（54 MB）、`Lightx2v\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors`（738 MB）、`lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors`（631 MB）、`ltx-2-19b-distilled-lora-384.safetensors`（7675 MB）、`ltx-2.3-22b-distilled-lora-384-1.1.safetensors`（7606 MB）、`ltx-2.3-22b-distilled-lora-384.safetensors`（7606 MB）、`minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors`（315 MB）、`minimax_h3_fl2v_turbo_4step_v0.1_768p_sla_comfyui_bf16.safetensors`（1956 MB）、`minimax_h3_turbo_4step_ema.safetensors`（780 MB）、`minimax_h3_turbo_4step_ema_ckpt500.safetensors`（780 MB）、`minimax_h3_turbo_4step_ema_ckpt850.safetensors`（780 MB）、`minimax_h3_turbo_4STEPS_comfyui.safetensors`（780 MB）、`minimax_h3_turbo_v4_step600_ema.safetensors`（780 MB）、`Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors`（1699 MB）、`Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors`（850 MB）、`Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`（850 MB）、`Qwen\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors`（1699 MB）、`Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors`（850 MB）、`Qwen-Image-Edit-Lightning-8steps-V1.0.safetensors`（1699 MB）、`Qwen-Image-Lightning-4steps-V1.0.safetensors`（1699 MB）、`Qwen-Image\Qwen-Image-Lightning-4steps-V2.0-bf16.safetensors`（850 MB）、`Qwen-Image-Lightning-8steps-V1.1.safetensors`（1699 MB）、`Qwen-Image-Lightning-8steps-V2.0-bf16.safetensors`（850 MB）、`Qwen-Image-Lightning-8steps-V2.0.safetensors`（1699 MB）、`scail2-dpo-lora_new.safetensors`（1227 MB）、`wan2.1_SCAIL_2_DPO_lora_bf16.safetensors`（1227 MB）、`wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors`（635 MB）、`wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors`（739 MB）、`wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022_modified.safetensors`（739 MB）、`wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`（1227 MB）、`wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`（1227 MB）、`wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors`（614 MB）、`wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors`（614 MB）、`wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors`（1227 MB）、`wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors`（1227 MB）、`Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-high_noise_model-comfy.safetensors`（1227 MB）、`Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-low_noise_model-comfy.safetensors`（1227 MB）、`Wan2.2-Lightning_I2V-A14B-4steps-lora_HIGH_fp16.safetensors`（614 MB）、`LoRAs\Wan22-Lightning\old\Wan2.2-Lightning_I2V-A14B-4steps-lora_LOW_fp16.safetensors`（614 MB）、`Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1-high_noise_model.safetensors`（1227 MB）、`Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors`（317 MB）、`Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V2.0-bf16.safetensors`（1180 MB）、`Z-image\Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI.safetensors`（568 MB）

**D 画风/审美（14 个）**

`krea2-Cc-FQWZ-ArtStyle.safetensors`（230 MB）、`krea2-Cc-FQWZ-Portrait.safetensors`（343 MB）、`krea2-Cc-FY-Portrait.safetensors`（229 MB）、`krea2-Cc-Ins-Portrait.safetensors`（343 MB）、`krea2-Cc-MJ-CinematicSoftLight.safetensors`（229 MB）、`krea2-Cc-MJ-FilterStyle.safetensors`（343 MB）、`krea2-Cc-TM-GreatFigure.safetensors`（229 MB）、`krea2_darkbrush.safetensors`（469 MB）、`Krea2_Fine_Art_Portraiture_st6000.safetensors`（235 MB）、`LTXV-13B-arcane_jinx_step_12000_comfy.safetensors`（805 MB）、`LTXV-13B-shinkai-anime-style-lora-v1_58000.safetensors`（805 MB）、`majicbeauty_krea2_st6000.safetensors`（235 MB）、`pixel_art_style_z_image_turbo.safetensors`（170 MB）、`阿里\portrait-photography.safetensors`（613 MB）

**E 视频/动作/编辑（17 个）**

`ICEdit\ICEdit-MoE-LoRA.safetensors`（429 MB）、`ltx-2-19b-ic-lora-detailer.safetensors`（2617 MB）、`t8\LTX-2.3-Licon-MSR-V1_B.safetensors`（654 MB）、`Kontext\Overlay-Kontext-Dev-LoRA.safetensors`（307 MB）、`ICEdit\pytorch_lora.safetensors`（232 MB）、`Qwen-Image-Edit-F2P.safetensors`（472 MB）、`SESELAORUYAO.safetensors`（359 MB）、`wan\SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors`（1227 MB）、`wan\SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors`（1227 MB）、`W22L-9柔软弹跳抖动-bounce_test_LowNoise-05.safetensors`（307 MB）、`W22L-物理胸部-BounceLow.safetensors`（307 MB）、`Wan2.1 I2V LoRA-360 度旋转.safetensors`（359 MB）、`Wan2.1-360_epoch20.safetensors`（359 MB）、`Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors`（858 MB）、`Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors`（858 MB）、`Pusa\Wan21_PusaV1_LoRA_14B_rank512_bf16.safetensors`（4907 MB）、`LoRAs\Wan22_relight\WanAnimate_relight_lora_fp16.safetensors`（1437 MB）

**F 其它/用途未核实（3 个）**

`20.safetensors`（153 MB）、`adapter_model.safetensors`（3735 MB）、`model.safetensors`（318 MB）

> 合计 **101** 个。4.2~4.4 的分组计数（50 / 14 / 17）与这里一致，另加 A 11 + B 6 + F 3。

## 5. 缺口与建议

对照五段式流水线（剧本 → 分镜 → 服化道 → 关键帧 → 片段合成）逐段给结论。

### 5.1 最痛：视频速度（关键帧 → 片段合成）

- **做不到/做得差**：H3 一次 5 秒镜头是 25~33 分钟【文档，旧节点图】。一部 3 分钟短剧按 30 个镜头算，
  本地跑要十几小时，无法量产。
- **候选补齐**（都在 5060 上已落盘，**均未实测**）：
  1. `video_h3_i2v_sla.json`（上游 API 模板，已存在于 5060 `workflows_api/`）：用
     `minimax_h3_fl2v_turbo_4step_v0.1_768p_sla_comfyui_bf16`（2.0 GB，在线）换掉当前 turbo LoRA，
     属「换加速件」级别改动，**有现成 API 模板**。
  2. `video_h3_i2v_blockcache.json`（上游 API 模板）：同结构 + `MiniMaxH3BlockCache` 类节点做块缓存。
  3. 降分辨率跑草稿（480×864 / 544×960，注意必须 32 的倍数），定稿再出 768×1344：
     **零新增模型、零新增模板**，只需要调用时传 `WIDTH/HEIGHT`。
- **显存/体积**：以上都只复用现有 21 GB H3 unet + 15.7 GB Qwen3VL-32B 编码器，**不新增显存占用**。
- **建议**：先按方案 3 验证「草稿档能不能看」，再决定是否引入 SLA 模板（引入前必须实测）。

### 5.2 缺口：片段合成阶段只有「生成」，没有「后期」

- **做不到/做得差**：
  - **拼接 / 转场**：11 个模板里没有任何 concat / transition 模板；`pipeline.js` 的 `assembly`
    只写到 `{ order, transition: "cut", status: "queued" }`，**没有执行体**【实测，代码层】。
  - **视频超分**：`upscale_4x` 只处理单张图；视频超分的 SEEDVR2 3B/7B 权重在盘（3.4 GB / 8.2 GB，
    显存需求低），节点类 `SeedVR2LoadDiTModel/SeedVR2LoadVAEModel/SeedVR2VideoUpscaler` 也都在线
    【实测 `/object_info`】，但**没有对应模板**；本机 `~/sobey/ai/ComfyUI_Workflows/docs/verified_graphs/`
    里有一份**现成的 API 图** `seedvr2_3b_upscale_124f_verified.json`（【文档】124f≈5~10 分钟）。
  - **音轨混流 / 字幕**：无模板。H3 自带原生音轨，但要拼多段 + 配 BGM 就得在 ComfyUI 之外做。
- **建议**：
  - 拼接/转场不一定需要 ComfyUI 模板——本机（Mac 网关侧）已有 `ffmpeg`/`ffprobe`【实测 `which`】，
    在网关的 assembly 阶段用 ffmpeg 做 concat 更简单、也不抢 GPU。**推荐先做这个**。
  - 视频超分：`seedvr2_3b` 有现成 API 图 + 模型/节点齐全，是最容易补的一条；**但本轮未实测，不能算可用**。

### 5.3 缺口：编排器 → 模板的参数契约不完整（**实测**）

按 `pipeline.js` 当前的默认调用（`keyframe` 只传 `PROMPT`（+ `INPUT_IMAGE`），`assembly` 传
`PROMPT/LENGTH/FRAME_RATE`），直接调网关会**在渲染阶段报错**：

| 复现调用 | 结果 |
| --- | --- |
| `POST /api/generate/image` `{template: img_zimage_artistic, params:{PROMPT}}` | `error: 模板 img_zimage_artistic 缺少参数：WIDTH` |
| `POST /api/generate/image` `{template: img_boogu_outfit_edit, params:{PROMPT, INPUT_IMAGE}}` | `error: 模板 img_boogu_outfit_edit 缺少参数：PERSON_IMAGE` |
| `POST /api/generate/video` `{template: video_h3_i2v, params:{PROMPT, LENGTH}}` | `error: 模板 video_h3_i2v 缺少参数：INPUT_IMAGE` |

两个具体问题：

1. **默认参数没有兜底**：`WIDTH/HEIGHT/BATCH` 这类「一定有合理默认」的 token，必须在
   `options.image` / `options.video` 里显式传，否则整个阶段直接失败。
   （`pipeline.js` 的文档也写明 `options.image` 是「否」选填，但实际是必填。）
2. **`keyframe` 的 end 帧走错模板**：`def.id === "keyframe"` 且 `role === "end"` 时用
   `pipelineConfig.editTemplate`（默认 `img_boogu_outfit_edit`），却只传 `PROMPT + INPUT_IMAGE`。
   但 boogu 模板需要的是 `PERSON_IMAGE + CLOTHING_IMAGE`，**根本不认 `INPUT_IMAGE`**，
   因此 end 帧必然报错。要么改模板 token（不推荐，会破坏「换装」语义），要么改编排器传参。
   > 注：这属于 `canvas-server/src/**`，**不在本次写入范围**，只做记录，由对应负责人处理。

### 5.4 其它缺口

| 环节 | 现状 | 建议 | 显存/体积/现成模板 |
| --- | --- | --- | --- |
| 服化道（换装精确性） | `img_boogu_outfit_edit` 能换装，但**是整图重绘**：本次实测里裙子款式/材质跟得不错，但领口、下摆细节与参考图不完全一致，脸部有轻微漂移 | 上游文档已明确「不能当精确 VTON 用」，需要 `SAM3 遮罩 → 局部编辑 → 原图回贴 → QC`；SAM3（1.7 GB）与 `sams/sam_vit_b` 都在盘，但**没有遮罩编辑模板** | 不新增模型；需要新模板（未做） |
| 关键帧一致性 | `video_h3_ref2v` 的官方嵌套写法**已经是对的**：`ref_images.ref_image_0` + `ref_videos.ref_video_0`（不是平铺，实测核对过模板内容），但**只接了 1 张参考图**、而且 prompt 里没有 `<Picture N>` 指派 | 想「多参考图锁角色」（上游验证图用的是 3 张参考图 + `<Picture 1/2/3>` 句法）需要再加 `ref_image_1` / `ref_image_2` 节点；节点 schema 允许最多 9 张【实测 schema】 | 复用现有模型，只改模板 |
| 图生图 / 局部重绘 | 现有 11 个模板里**没有** `INPUT_IMAGE` 驱动的图生图（除 boogu 换装） | 上游 `img_qwen21_gguf.json` 可用：`qwen_image_2.1-Q4_K.gguf`（4.2 GB）+ `qwen3vl_8b_fp8_scaled` + `qwen_image_2.1_vae_bf16` 全在线，`UnetLoaderGGUF` 节点在线 | 有现成 API 模板；**未实测** |
| 写实向出图 | 有 `img_flux_artistic` / `img_krea2_artistic` | 上游 `img_zimage_beyond.json` 可补：`BEYOND_REALITY_3.0_BF16`（12.3 GB）+ `qwen_3_4b` + `ae` 全在线 | 有现成 API 模板；**未实测** |
| LTX 视频线 | `ltx-2.3-22b-dev/distilled-fp8` checkpoint（29 GB 级）在线，`gemma_3_12B` 编码器在线，`ltx-2.3-22b-distilled-lora-384` 在线 | 上游 `video_ltx25_t2v.json` **不可用**：它要的是 LTX 2.5 的 unet/两个 VAE/gemma4 编码器/latent upscaler，**5060 上都没有** | **缺模型**，不建议现在投入 |
| 对话/旁白配音 | 本地 TTS `Qwen3-TTS-12Hz-1.7B-CustomVoice`（3.8 GB）+ 7 个 `TDQwen3TTS*` 节点在线 | 已由本次新增的 `video_h3_talk` 用上 | 见 §6.3 |

## 6. 本次实测记录

所有实测都遵守「16GB 一次只跑一个任务」：提交前先看 `/queue`，串行等待。

### 6.1 `img_boogu_outfit_edit` 换装首跑（任务要求项）

- **输入**：`PERSON_IMAGE` = 团队冒烟产物 `data/artifacts/image-mupgvool-f6e6q/smoke-zimage_00001_.png`
  （768×1344，红色雨衣女性）；`CLOTHING_IMAGE` = `~/sobey/ai/ComfyUI_Workflows/pipeline_assets/Outfit_Design_00012_.png`
  （480×848，黑色亮片鱼尾裙设计图）。
- **参数**：`PROMPT="让图中的年轻女性穿上第二张图里的黑色亮片鱼尾长裙，保持人物面部特征、发型和站姿不变，全身照，干净的浅灰色影棚背景，柔和顶光，时尚大片质感"`，
  `NEGATIVE_PROMPT="低质量，模糊，变形，多余的手指，肢体扭曲，水印，字幕，文字"`，`WIDTH=768`、`HEIGHT=1344`、
  `SEED=12345`、`OUTPUT_PREFIX=lca/boogu-outfit`。
- **命令**：直连 ComfyUI（`POST http://127.0.0.1:18188/upload/image` 上传两张参考图 →
  用 `canvas-server/src/providers/comfy.js` 的 `renderTemplate` + `disableEmptyLoras` 渲染
  `workflows/img_boogu_outfit_edit.json` → `POST http://127.0.0.1:18188/prompt` → 轮询 `/history/<id>`
  → `/view` 取回产物）。等价地，也可以走网关：
  `POST http://127.0.0.1:8899/api/generate/image`，body
  `{"template":"img_boogu_outfit_edit","name":"lca-boogu","params":{"PERSON_IMAGE":"<本机路径>","CLOTHING_IMAGE":"<本机路径>","PROMPT":"…","NEGATIVE_PROMPT":"…","WIDTH":768,"HEIGHT":1344,"SEED":12345}}`。
- **结果**：`status=success`，**生成耗时 289.9s**（总墙钟 291.1s，含模型冷装载），
  产物 `boogu-outfit_00001_.png`，**871,363 B，768×1344**。
- **观感（实测目视）**：人物换上了参考图的黑色亮片鱼尾长裙，影棚背景，脸型/发型基本保持；
  长裙的亮片质感、鱼尾轮廓到位，但**领口（参考图是高领、出图是深 V）与袖型（参考图长袖、出图无袖）不一致**，
  属于「按提示语义重绘」而不是「像素级换装」。**结论：能用于服化道快速试装，不能当精确 VTON。**

### 6.2 `img_zimage_artistic` + 角色 LoRA（补验「角色一致性 LoRA 真能用」）

- **调用**：`POST /api/generate/image`，`template=img_zimage_artistic`，
  `params={PROMPT:"wenzhiyu_woman, …", WIDTH:768, HEIGHT:1344, BATCH:1, LORA_FILE:"wenzhiyu_woman_zimage_turbo-1.safetensors", LORA_STRENGTH:1}`。
- **结果**：`status=done`，**总耗时 60.1s**，产物 `lca-zimage-lora_00002_.png`，**1,219,086 B，768×1344**。
- **说明**：本轮只验证「模板 + 角色 LoRA 能加载并稳定出图」，**没有**做「与参考图比对还原度」
  （手上没有该角色的标准参考图），所以**不能**据此宣称身份还原度达标。

### 6.3 新增模板 `video_h3_talk`（TTS 台词 + 对口型）

- **来源**：5060 上游 `workflows_api/video_h3_talk.json` 原样拷入 `canvas-server/workflows/`
  （与既有 10 个模板同一作者、同一批文件），未改一个字节。
- **token**：`INPUT_IMAGE / PROMPT / TTS_TEXT / TTS_SPEAKER / TTS_VOICE_DESIGN / WIDTH / HEIGHT / LENGTH / SEED / OUTPUT_PREFIX`，
  与 `canvas-server/README.md` 里早就写明的 token 契约（`TTS_TEXT` `TTS_SPEAKER` `TTS_VOICE_DESIGN`）一致。
- **第一次失败（有价值的记录）**：`WIDTH=480, HEIGHT=848` → 节点 10
  `MiniMaxH3AudioConditioningT8` 报 `MiniMax H3 width and height must be divisible by 32`；
  **失败前 TTS 已成功执行**（执行序列里包含节点 1、18），说明 TTS 链路本身没问题，纯粹是尺寸约束。
- **第二次（通过）的完整参数**：`INPUT_IMAGE` = §6.1 的换装产物（768×1344 黑色长裙），
  `PROMPT="年轻女性站在浅灰色影棚背景前，穿黑色亮片鱼尾长裙，面对镜头自然说话，口型与台词同步，轻微头部动作，固定机位，半身镜头"`，
  `TTS_TEXT="你终于来了。"`，`TTS_SPEAKER="Serena"`，`TTS_VOICE_DESIGN=""`，
  `WIDTH=480`、`HEIGHT=864`、`LENGTH=56`、`SEED=777`。
- **结果**：`status=done`，**总耗时 490.5s（约 8.2 分钟）**；产物 `lca-h3-talk_00001-audio.mp4`，
  **480,339 B**；`ffprobe` 复核 **480×864 / h264 / 56 帧 / 2.333s + AAC 立体声 32 kHz / 2.304s**；
  `volumedetect` 复核音轨 `mean_volume=-18.9 dB, max_volume=-3.9 dB`（**确有声音，不是静音轨**）。
- **观感（实测目视 + 抽帧）**：首帧与输入图人物一致；第 40 帧出现明显**推镜**、嘴部张开，说明
  「TTS 音频 → 口型/动作」这条链真的通了；但画面下方多出一行**糊掉的在画文字**（H3 会把台词当字幕画进画面），
  美观度打折，正式出片需要裁掉或规避。【实测目视，未做主观听音验收】
- **对耗时的推断**：56 帧 × 480×864 ≈ 2320 万「像素·帧」用了 490s；按同一效率外推
  768×1344×124 帧（1.28 亿像素·帧）约 40 分钟以上【推断】——也就是说**新 T8 节点图大概率比旧图的
  33 分钟更慢**，这一点需要后续专门测速确认。**这里不给结论，只给已实测的那一个点。**

## 7. 新增 / 删除的模板

| 动作 | 模板 | 依据 | 实测 |
| --- | --- | --- | --- |
| **新增** | `video_h3_talk` | §5.4「对话/旁白配音」缺口；上游有现成 API 模板；TTS 模型 + 7 个 `TDQwen3TTS*` 节点 + H3 全套模型全部在线；token 已在 README 契约里 | 见 §6.3 |
| 未新增 | `video_h3_i2v_sla` / `video_h3_i2v_blockcache` | 能提速，属视频类，风险与 GPU 时间不可控 | 记录为候选（§5.1），**未跑** |
| 未新增 | SeedVR2 视频超分 | 缺口明确、模型/节点/现成 API 图都齐 | 记录为候选（§5.2），**未跑** |
| 未新增 | `img_qwen21_gguf` / `img_zimage_beyond` / `img_zimage_nsfw` | 属「锦上添花」，不解决主链路瓶颈 | 记录为候选（§5.4），**未跑** |
| 未删除 | 全部既有 10 个模板 | 依赖模型全在线；其中 2 个本轮实测通过 | — |

**没有改动既有 10 个模板的内容。** 也没有动 `canvas-server/src/**`、`web/**`、`skills/**`
与既有 3 个测试文件。

## 8. 未验证 / 推断事项清单（不要当已验证用）

1. **H3 25~33 分钟这个数字不能直接套到当前模板上。** 上游 `VERIFIED_REQUEST_GRAPHS` 记录的
   `h3_i2v_dance_124f_verified.json` 用的是 `MiniMaxH3ImageToVideo + SamplerCustomAdvanced +
   VAEDecodeAudio + CreateVideo/SaveVideo`；而 `canvas-server` 的 `video_h3_i2v` 用的是
   `MiniMaxH3AudioConditioningT8 + MiniMaxH3DualClockSamplerT8 + MiniMaxH3AVDecodeT8 + UniBlockSwap +
   ReservedVRAMSetter + MiniMaxH3MemoryEfficientSageAttentionPatch`。**节点集不同，耗时未实测。**
   同理 `video_wan_animate`（我们的是原生 `WanAnimate2ToVideo`，文档里那条是 WanVideoWrapper 图）。
   目前只有 `video_h3_talk` 那一个点（480×864×56f = 490.5s）是当前节点图上的真数据。
2. `img_flux_artistic`、`img_krea2_artistic`、`upscale_4x`、`video_minimax_h3_t2v`、
   `video_h3_i2v`、`video_h3_ref2v`、`video_wan_animate`、`scail2_action_transfer` 本轮**都没跑**，
   只核对了模型在线与节点存在。
3. §4 的 LoRA 分类全部是**按文件名推断**，除 `wenzhiyu_woman_zimage_turbo-1` 外**没有逐个试挂**。
4. §3 里所有「预计/量级」耗时都是推断；全文只有 §6 记录的那几个数字（290s / 60.1s / 490.5s）是实测。
5. 编排器参数契约问题（§5.3）是**网关 HTTP 层实测报错**，但「该怎么修」是建议，未改代码。
6. 本文件是 `.md`，**没有**加进 `docs/content/docs/progress/meta.json`（该文件不在本次写入范围），
   因此暂时不会出现在文档站导航里。

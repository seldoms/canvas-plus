# win147 ComfyUI 速度/质量优化方案调研

调研日期：2026-10-03。纯 web/文字调研，未在 147 跑任何模型。
硬件基线：RTX 5060 Ti 16G（Blackwell，sm_120）/ 32G RAM；生产实例 8188（v0.38.2，4485 节点），Qwen2.1 专用实例 8190（v0.37.0，971 节点），PyTorch 2.10.0+cu130。
模型清单见 [inventory-api.md](inventory-api.md)，本文所有「是否已有」判断均以该盘点为准。

---

## 一、速度优化

### 1.1 蒸馏 / 加速 LoRA（收益最大、落地成本最低的一类）

| 模型 | 加速方案 | 官方/社区 | 用法与参数 | 加速比 | 质量代价 | 147 是否已有 |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen-Image | Qwen-Image-Lightning 4/8 步 | 官方（Qwen 团队发） | 4 步版：4 steps / CFG 1.0 / euler / simple；8 步版同理 8 steps；肖像可 8 步 CFG 2.5。shift 用 ModelSamplingAuraFlow ≈3.1（编辑链官方模板做法） | 50 步→4/8 步，约 6-12× | 4 步版细节略软、偶有构图简化；8 步 V2.0 接近原版 | ✅ 全套（V1.0/V1.1/V2.0，4/8 步） |
| Qwen-Image-Edit 2509/2511 | Qwen-Image-Edit-Lightning 4/8 步 | 官方 | 同上，CFG 1.0 euler simple | ~10× | 小幅编辑一致性损失 | ✅ 2509/2511 各版本齐 |
| Qwen-Image 2.1 | p_qwen_image_2.1_8step、bfs_head 系列、Wuli-2512-Turbo-4steps | 社区 | 8 步 CFG 1 euler simple | ~4-6× | 待实测 | ✅ 均已在 loras |
| Wan2.1 14B | lightx2v cfg_step_distill LoRA（rank32/64/128/256） | 官方（ModelTC/lightx2v） | 4-6 步，CFG 1，euler/simple，shift 5-8；rank 越大质量越好越慢 | 50 步→4 步，配合去 CFG 约 10× | 运动幅度与细节略降；rank64 是性价比甜点 | ✅ T2V rank32/64、I2V rank4/32/64/128/256 |
| Wan2.2 A14B（高低噪双模型） | Wan2.2-Lightning 4steps HIGH/LOW、lightx2v 4step high/low（1022/1217 版）、Seko-V1/V1.1、SVI_v2_PRO | 混合（Lightning 为官方，lightx2v/Seko/SVI 为社区） | lightx2v 官方工作指南硬性要求：euler + simple + shift 5 + HIGH 2 步 + LOW 2 步 + CFG 1；社区也有人 HIGH 4 步 CFG 1.5-2 / LOW 3 步、dpmpp_2m_sde、shift 8 的质量档 | 标准 40 步（20+20）→ 4-8 步，4-10× | 4 步档动作复杂度下降；8 步档（4+4）社区反馈接近原版 | ✅ Lightning/ Seko / lightx2v（1022/1217/1.1）/ SVI 全套 |
| Wan2.1 14B T2V | FastWan_T2V_14B_480p rank128 | 社区 | 类 lightx2v，低步数 + CFG 1 | ~10× | 480p 限定 | ✅ |
| SCAIL-2 | 主干本身是 Wan2.1 14B 蒸馏版（LiteX2V 蒸馏） | 官方（zai-org） | 官方 ComfyUI 打包 fp8/int8/mxfp8/nvfp4 混合精度 + DPO LoRA | 相对原版 Wan2.1 14B 大幅提速 | 蒸馏带来轻微细节损失 | ✅ fp8_scaled 已在 diffusion_models |
| Wan2.2-Animate-14B | lightx2v cfg_step_distill LoRA（Wan2.1 I2V rank64 可直接复用） | 社区实践 | 6 步推理即可，Animate 任务不是从零生成，质量退化不明显 | ~8× | 很小（Animate 对蒸馏鲁棒） | ✅ Wan21_I2V_14B_lightx2v rank32 在库 |
| MiniMax H3 | Turbo LoRA 家族：fl2v lightx2v/larry 4 步、ref2v 8 步 v1.0 768p、turbo_4step_ema 系列 | 官方 ModelTC + 社区 | ModelTC/Minimax-H3-Turbo 官方推荐：**8 NFE，video shift 6，audio shift 3**；4 步 LoRA 配 MiniMaxH3TurboSampler/LoRA 节点 | 4-8 NFE vs 默认数十步 | 4 步档运动与口型略降；ref2v 8 步 768p 质量档更好 | ✅ 8 个 H3 加速 LoRA + Turbo 全家桶节点（仅 8188） |
| Krea2 Turbo | 主干即 8 步蒸馏版（官方 krea-ai）；另有社区 4 步 LoRA（lvladikov/Krea2-Turbo-Distill-4step-LoRA） | 官方+社区 | 官方：8 步、CFG 0（ComfyUI 里写 1.0）、mu=1.15、1K-2K；4 步 LoRA：4 steps / cfg 1.0 / euler / simple | 相对 RAW 52 步约 6.5× | Turbo 已是官方蒸馏，4 步 LoRA 再降细节 | ✅ krea2_turbo_fp8_scaled |
| Boogu | Boogu-Image-0.1-Turbo（4 步蒸馏）、Edit-Turbo | 官方（boogu-project） | 4 步 LCM 采样，配 Qwen3-VL 文本编码器 | ~10× | 轻微 | ✅ boogu_image_turbo_fp8_scaled |
| FLUX.1-dev | Hyper-FLUX.1-dev-8steps、FLUX.1-Turbo-Alpha | 社区（ByteDance/阿里） | 8 步 CFG 1 euler simple | 20+ 步→8 步 | 细节略降 | ✅ 两个都在 |
| Z-Image Turbo | 主干已蒸馏；Z-Image-Fun-Lora-Distill-8-Steps | 官方蒸馏+社区 LoRA | Turbo 默认 8-9 NFE CFG 1 | — | — | ✅ |
| LTX-2.3 22B | ltx-2.3-22b-distilled 主干 + distilled-lora-384（1.1） | 官方（Lightricks） | 蒸馏版 8 步 CFG 1；官方两段式工作流 15 步 res2s 质量档 | 20-50 步→8 步 | 轻微 | ✅ dev/distilled fp8 + LoRA 齐 |

要点结论：
- 147 的 LoRA 侧弹药已经非常充足，**缺的不是文件而是「按模型的固定参数配方」**（见 2.2 采样器表）。
- 视频侧最大单项收益 = lightx2v/Lightning 4 步 LoRA + CFG 1（去 CFG 本身再省一半算力）。
- 来源：[lightx2v/Wan2.2-Distill-Loras](https://huggingface.co/lightx2v/Wan2.2-Distill-Loras)、[Wan2.2 I2V 工作指南（HF discussion）](https://huggingface.co/lightx2v/Wan2.2-I2V-A14B-Moe-Distill-Lightx2v/discussions/3)、[Qwen Lightning 设置汇总](https://sbcode.net/genai/qwen-lighting-lora/)、[ModelTC/Minimax-H3-Turbo](https://github.com/ModelTC/Minimax-H3-Turbo)、[krea-2 README](https://github.com/krea-ai/krea-2)、[Boogu-Image](https://github.com/boogu-project/Boogu-Image)。

### 1.2 量化方案对比（fp8 / int8_convrot / GGUF / nvfp4 / int4）

社区共识（2026 年）：

| 方案 | 质量 | 速度 | 显存 | 适用与备注 |
| --- | --- | --- | --- | --- |
| fp8_scaled（e4m3fn） | 与 bf16 几乎无差（权重选择性量化时） | 40/50 系有原生 FP8 Tensor Core，通常**最快档** | 约为 bf16 一半 | 147 绝大多数模型已是 fp8_scaled，**默认首选** |
| int8_convrot | 与 fp8 同级甚至略好（旋转量化压低误差），文件名里的 int8 是存储类型不是精度含义 | 与 fp8 相当，部分卡上更快 | 同 fp8 | Comfy-Org 官方 repack 格式，需较新 ComfyUI；147 的 boogu/minimax_h3/qwen_image_2.1 已用 |
| GGUF Q8_0 | 近似无损（round-to-nearest 无损级别） | 比 fp8 慢（反量化开销），旧卡更明显 | ~8.5 bpw | 需要 CPU offload 或兼容性时的选择 |
| GGUF Q4_K_M | 可感知但很小的损失；学术基准上 Q4_K 是同体积 Pareto 最优 | 中等 | ~4.5 bpw | 显存不足时备选；147 的 Wan2.2-Animate/Qwen2.1/rapid-mega 有 Q4_K |
| nvfp4 | 4-bit，社区实测相对 fp16 有结构性偏移但很小；速度优势极大（Blackwell 原生 FP4 Tensor Core，实测比 GGUF Q8 快至 2× 以上） | **50 系上最快** | ~4 bpw | **5060 Ti 是 Blackwell（sm_120），可以用**；但要求较新 ComfyUI + comfy-kitchen CUDA 13 构建，147 的 torch 2.10+cu130 满足条件。目前 147 只有 minimax_h3_ref2va 的 int4_r128 和 qwen3vl_32b nvfp4_awq，DiT 侧 nvfp4 待补 |
| int4 / int8_convrot（QuantFunc） | QuantFunc 系模板配套 | — | — | 147 已装 ComfyUI-QuantFunc 全家桶与 12 个模板 |

结论：147 现状（fp8_scaled + int8_convrot 为主、GGUF 兜底）已经是 16G 卡的合理配置；**增量机会在 nvfp4**（Blackwell 原生加速），值得挑 1-2 个最常用模型（Qwen-Image 2.1 / Wan2.2）试验。
来源：[convert_to_quant](https://github.com/silveroxides/convert_to_quant)、[civitai NVFP4 说明](https://civitai.com/models/2566484/wan21-i2v-lightx2v-stepcfg-nvfp4)、[Ideogram 4.0 量化论文（Q4_K/Q8_0 基准）](https://arxiv.org/html/2606.12280v2)、[BF16 vs GGUF vs FP8 vs NVFP4 实测](https://dev.to/furkangozukara/bf16-vs-gguf-fp8-scaled-nvfp4-speed-quality-compared-comfyui-cuda-13-gains-flux-2-klein-9b-59k7)、[量化格式报错与误区](https://localaimaster.com/blog/comfyui-quantization-format-errors)。

### 1.3 注意力后端（sage / flash attention）

- 现状：147 启动参数未开 `--use-sage-attention`，属于**没吃到的免费加速**。
- sage attention：对长序列（视频、大图）收益最大，社区实测 Wan 系 1.2-1.5×，质量损失可忽略（量化注意力）。Windows 安装路径：先 `triton-windows`，再装 woct0rdho/SageAttention 预编译 wheel；用法可以是全局 `--use-sage-attention`，或 KJNodes 的 `PathchSageAttentionKJ` 节点按模型局部开（147 的 8188 已有 KJNodes）。
- flash attention：质量完全无损、加速略低于 sage；两者可以都装，视频用 sage、质量敏感图像用 flash。
- 注意：Krea2 直接开 sage 有 shape bug，需 SurrealByDesign/comfyui-krea2-sageattention-guard 补丁或不开。
- 来源：[Windows 安装指南（reddit）](https://www.reddit.com/r/StableDiffusion/comments/1n8umsd/updated_detailed_stepbystep_full_comfyui_with/)、[KJNodes PatchSageAttentionKJ](https://comfyui-wiki.com/zh/custom-nodes/ComfyUI-KJNodes/nodes/pathch-sage-attention-kj)、[Sage vs Flash 对比](https://www.locallabdigest.com/blog/sage-attention-vs-flash-attention-comfyui)、[krea2 sageattention guard](https://github.com/SurrealByDesign/comfyui-krea2-sageattention-guard)。

### 1.4 torch.compile

- 收益：绝对最好情况下 20-30%（KJ 原话），高度模型相关；首次编译慢，之后 kernel 缓存复用，**长时间批量跑同一工作流才值回票价**。
- 入口：官方 `TorchCompileModel` 节点；WanVideoWrapper 的 `WanVideoTorchCompileSettings`；8188 还有 `TorchCompileModelQwenImage`。
- 与 sage attention、蒸馏 LoRA 可叠加。
- 来源：[KJNodes issue #502](https://github.com/kijai/ComfyUI-KJNodes/issues/502)、[TorchCompileModel 官方文档](https://docs.comfy.org/built-in-nodes/TorchCompileModel)。

### 1.5 缓存加速（TeaCache / KV Cache / SmartCache）

| 手段 | 适用 | 加速比 | 质量代价 | 147 现状 |
| --- | --- | --- | --- | --- |
| TeaCache（ComfyUI-TeaCache / WanVideoWrapper 内置） | Wan2.1/2.2、FLUX、HunyuanVideo、LTX 等 | 官方口径 Wan2.1 14B 无损 2.1×、有损 2.5×；电压园实测 Wan2.2 每步 4.67s→1.5s（配合其他优化）；FLUX 3× | rel_l1_thresh 0.2-0.3 时视觉近似无损；WanVideoWrapper 里 `use_coefficients` 开=质量稳但几乎不加速，关=快但质量明显下降 | WanVideoWrapper 已装（8188），可直接用 |
| FBCache（Comfy-WaveSpeed） | FLUX 等 DiT | 显著 | 低 | 147 未确认安装 |
| QwenImage21Cache（官方节点） | Qwen-Image 2.1 多参考图编辑 | 不是通用加速：缓存参考图 KV prefix，同一批参考图反复编辑/改词时省掉重复编码 | 无损 | ✅ 官方节点（两实例都有），多大图场景必备 |
| MiniMaxH3TurboSmartCache | H3 Turbo 采样 | 随 Turbo 节点 | — | ✅ 8188 Turbo 全家桶内含 |
| TE-Speed-QwenImage21（社区节点） | Qwen-Image 2.1 | 输出预测策略，reuse_threshold=0.06（作者称测试最佳），speed 模式最多连猜 2 步 | 连猜步数越多画质偏差风险越大 | 未装，可评估 |

来源：[TeaCache 官方 OpenArt 说明](https://openart.ai/workflows/mole_cuddly_21/teacache-for-wan21-t2v-14b/z0e1ZncbbJk3vTxZk5Lv)、[WanVideoWrapper TeaCache issue #159](https://github.com/kijai/ComfyUI-WanVideoWrapper/issues/159)、[voltagepark Wan2.2 优化实测](https://www.voltagepark.com/blog/accelerating-wan2-2-from-4-67s-to-1-5s-per-denoising-step-through-targeted-optimizations)、[QwenImage21Cache 官方文档](https://docs.comfy.org/built-in-nodes/QwenImage21Cache)、[TE-Speed-QwenImage21](https://github.com/tl2012tl/TE-Speed-QwenImage21)。

### 1.6 低显存策略（启动参数复查）

147 现状：`--disable-smart-memory --disable-cuda-malloc`。社区共识：

- `--disable-cuda-malloc`：禁用 PyTorch 缓存分配器，专治 Windows 上 "Allocation on device" 崩溃，但会拖慢一切；**只在真的出现该报错时才需要**，否则建议去掉。
- `--disable-smart-memory`：ComfyUI 的 smart memory 本来就是为低显存卡设计的按需 offload 机制，禁用它对 16G 卡通常是**反优化**；建议先去掉这个 flag 观察。
- 替代/补充：`--lowvram`（激进 offload）在 16G 卡上一般不需要；优先用模型侧手段（fp8/int8/GGUF、BlockSwap、VAE tiling）而不是全局降级 flag。
- 建议的验证顺序：① 去掉两个 disable flag 跑基线 → ② 出现分配错误才加回 `--disable-cuda-malloc` → ③ 仍 OOM 再上 `--lowvram` 或模型降级。
- 来源：[ComfyUI 启动参数官方文档](https://docs.comfy.org/development/comfyui-server/startup-flags)、[disable-cuda-malloc 适用场景 issue](https://github.com/kijai/ComfyUI-DynamiCrafterWrapper/issues/67)、[性能问题官方讨论](https://github.com/Comfy-Org/ComfyUI/discussions/4457)。

---

## 二、质量优化

### 2.1 DPO / 质量 LoRA

- **SCAIL-2 DPO LoRA**（`wan2.1_SCAIL_2_DPO_lora_bf16.safetensors`、`scail2-dpo-lora_new.safetensors`，147 已有）：官方（zai-org）发布，**不只缓解手部畸变，还改善唇形与眼神同步**；Comfy-Org repack 自带。这是 SCAIL-2 链路必挂的质量 LoRA。
- `bfs_head_v1.1_qwen_2.1` / `bfs_head_v5_2511`（147 已有）：Qwen 2.1 头部/脸部质量 LoRA，社区方案。
- Krea2 人像系（Fine_Art_Portraiture、majicbeauty、Cc 系列）、wenzhiyu_woman 系列（zimage/flux/sd15/wan22_5b）：风格+人像质量 LoRA，147 已齐。
- 来源：[zai-org/SCAIL-2 README](https://github.com/zai-org/SCAIL-2)、[SCAIL-2 ComfyUI 说明](https://comfyui-wiki.com/en/news/2026-06-09-scail-2-character-animation)。

### 2.2 采样器 / 调度器 / shift 最佳组合（按模型速查表）

| 模型 | 官方/默认 | 社区公认质量档 | shift |
| --- | --- | --- | --- |
| Qwen-Image | 50 步 CFG 4 euler simple；官方蒸馏版 15 步 CFG 1（实测 10 步也行，euler 或 res_multistep 按图型选） | 30-50 步 CFG 4-4.5 euler simple（golden quality）；Lightning 档 4/8 步 CFG 1 euler simple | ModelSamplingAuraFlow ≈3.1 |
| Qwen-Image-Edit 2509/2511 | 同官方模板 | Lightning 4/8 步 CFG 1 euler simple；CFGNorm(strength=1) 稳定化 | 3.1 |
| Qwen-Image 2.1 | euler simple CFG 1 起步，官方模板为准 | 30 步 CFG 1 euler simple；加速节点需 ≥20 步 | — |
| Z-Image Turbo | 8-9 步 CFG 1；euler 或 res_multistep；simple/linear 调度 | 不要超过 ~12 步（蒸馏模型多步反而劣化），CFG 调高会过饱和烧图 | shift ≈3（AuraFlow） |
| Z-Image base | 25-50 步 CFG 3-6 euler/res_multistep simple | — | — |
| Krea2 Turbo | 8 步 CFG 0（ComfyUI 写 1.0）mu=1.15，1K-2K | 负面提示无效是蒸馏特性，要负面控制用 ComfyUI-Krea2-NAG | mu=1.15 |
| Boogu Turbo | 4 步 LCM | — | — |
| FLUX.1-dev | 20 步 euler simple guidance 3.5 | dpmpp_2m sgm_uniform 也被广泛用作质量档；加速：Hyper-FLUX 8 步 CFG 1 | — |
| Wan2.1 14B | 官方采样器 UniPC（diffusers 侧）；480p shift 8、720p shift 12 | lightx2v 档：euler simple shift 5-8 CFG 1，4-6 步 | 8 / 12 |
| Wan2.2 TI2V-5B | 官方：CFG 5.0、shift 5.0 | — | 5.0 |
| Wan2.2 A14B 双模型 | 40 步（HIGH 20 + LOW 20）CFG ~4-5，boundary_ratio 0.875 | 质量档社区配方：HIGH res_2m / LOW res_2s；加速档 euler simple shift 5 HIGH2+LOW2 CFG 1（lightx2v 硬性要求） | 5-8 |
| Wan2.2-Animate | 官方原生节点默认 | lightx2v LoRA 6 步档质量退化不明显 | — |
| MiniMax H3 Turbo | **官方推荐：8 NFE，video shift 6，audio shift 3** | 4 步 turbo LoRA 档；ref2v 8 步 768p | 6 / 3 |
| LTX-2.3 22B distilled | 8 步 CFG 1；官方两段式 15 步 res2s（distilled+dev 同跑）质量更好 | dev 版 20-50 步 CFG 3-3.5；质量向可 28-32 步 CFG ~4.5 | — |

来源：[Qwen-Image 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image)、[artokun comfyui-mcp qwen-txt2img 参数表](https://github.com/artokun/comfyui-mcp/blob/main/plugin/skills/qwen-txt2img/SKILL.md)、[Z-Image 参数指南](https://localaimaster.com/blog/z-image-turbo-comfyui)、[Civitai Z-Image 工作流 V7](https://civitai.com/models/2170134/z-image-turbo-and-base-workflow)、[Wan2.2 参数讨论](https://www.reddit.com/r/StableDiffusion/comments/1mfzvl5/debate_best_wan_22_t2v_settings_steps_sampler_cfg/)、[lightx2v 工作指南](https://huggingface.co/lightx2v/Wan2.2-I2V-A14B-Moe-Distill-Lightx2v/discussions/3)、[TensorSharp Wan 文档（UniPC 官方采样器对照）](https://github.com/SciSharp/TensorSharp2/blob/main/docs/models/wan.md)、[ModelTC/Minimax-H3-Turbo](https://github.com/ModelTC/Minimax-H3-Turbo)、[krea-2 官方设置](https://note.com/truenorthai/n/n7d7a5e2ced8c?hl=en)、[LTX-2.3 官方工作流建议](https://www.reddit.com/r/StableDiffusion/comments/1rz1u3j/psa_use_the_official_ltx_23_workflow_not_the/)。

### 2.3 高分辨率修复 / 放大链路

147 已有：4x-UltraSharp.pth（UpscaleModelLoader）、SeedVR2 全套节点（8188）、TTP Smart Tile、PixelKSampleUpscaler、SEGSUpscaler、impact-pack Detailer 系列。

- **图像链路（社区标准配方）**：4x-UltraSharp 直接放大（最快最省）→ 需要补细节时接 img2img 低 denoise 重采样：像素空间放大后 denoise **0.25-0.5** 足够，模型放大器（已锐化）则用更低 denoise（0.2-0.35）；大图用分块方案（UltimateSDUpscale / TTP Smart Tile）避免 OOM。denoise 低于 ~0.3 会糊、高于 0.5 会改图。
- **视频链路**：SeedVR2 是当前社区公认最优视频放大。16G 卡配置：**FP8 模型 + BlockSwap（blocks_to_swap 16 均衡档）或 VAE tiling**；8G 以下才需要 GGUF Q4_K_M。3B 快、7B 质量好。
- **Wan 长视频高清化备选**：ComfyUI-MiniMax-H3-PDD-Acc 的 `pdd_acc_t2v_latent_upscale`、`pdd_video_upscale_long` 模板（147 已装）。
- 来源：[cubiq upscale 配方](https://github.com/cubiq/ComfyUI_Workflows/blob/main/upscale/README.md)、[numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)、[SeedVR2 低显存指南](https://seedvr2.net/blog/tutorials/seedvr2-comfyui-low-vram-guide-2026)、[BlockSwap 参数表](https://www.nextdiffusion.ai/tutorials/high-quality-image-upscaling-with-seedvr2-in-comfyui)。

---

## 三、官方提示词改写器资产清单（重点）

这批是各模型官方仓库里现成的「策略层」资产：系统提示词 + 调用脚本，可以直接抄进我们自己的改写服务（策略与产物分离，符合项目内容创作规范；注意 Boogu/Qwen 的提示词里有合规改写条款，复用时按项目规范取舍——只提取改写规则，合规条款由用户决定是否保留）。

### 3.1 Wan2.1/2.2 官方 prompt_extend.py

- 文件：[Wan-Video/Wan2.1: wan/utils/prompt_extend.py](https://github.com/Wan-Video/Wan2.1/blob/main/wan/utils/prompt_extend.py)
- 后端：两种——DashScope API（`qwen-plus` 文本 / `qwen-vl-max` 图文）或本地 Qwen（`Qwen2.5-3B/7B/14B-Instruct`、`Qwen2.5-VL-3B/7B-Instruct`，脚本内注明 14B 约 29GB VRAM、AWQ 版约 10GB）。
- 内置 6 套系统提示词（中英 × 纯文本 LM / 单图 VL / 首尾帧双图 VL），按 `tar_lang` 和输入图片数自动选择。
- 改写规则要点：补全主体特征/风格/空间关系/景别；**强调运动信息与镜头运镜**；给主体加自然动作、用简单直接动词；保留引号书名号原文；古诗词强制中国古典元素；成品控制在 **80-100 字**；双图（首尾帧）版额外要求描述两帧之间的潜在变化（走进/出现/变身/镜头移动等）。
- 适用：Wan2.1/2.2 T2V、I2V、FLF2V，也可迁移给 SCAIL-2/WanAnimate。
- 147 复用点：本机已有 qwen_2.5_vl_7b_fp8_scaled 文本编码器权重（DiT 编码用），改写器可复用同族小模型或走 API。

### 3.2 Qwen-Image 官方改写器（T2I polish + Edit rewrite）

- 文件：[QwenLM/Qwen-Image: src/examples/tools/prompt_utils.py](https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils.py)（2512 版另有 `prompt_utils_2512.py`）
- 后端：DashScope `qwen-plus`（T2I）/ `qwen-vl-max-latest`（Edit，图文输入），输出后拼接 magic prompt「超清，4K，电影级构图 / Ultra HD, 4K, cinematic composition」。
- T2I 规则要点：补全主体特征/风格/空间关系/镜头景别；图内文字必须引号标注+指定位置风格、不翻译不改写；模糊文字改具体；无否定词；保留逻辑关系（如食物链箭头）；英文 <200 词。
- Edit 规则要点（EDIT_SYSTEM_PROMPT，输出 JSON `{"Rewritten": ...}`）：按任务类型分治——增删换任务补最小充分细节（类别/颜色/大小/朝向/位置）；文字编辑统一「Replace "xx" to "yy"」句式；人像编辑保持核心 ID 一致、表情/美颜改动必须自然微妙；风格转换用关键视觉特征简述；上色/老照片修复固定模板 "Restore and colorize the photo."；inpainting/outpainting 各有固定模板句；多图任务必须指明修改哪张图的哪个元素。
- 适用：Qwen-Image、Qwen-Image-Edit 2509/2511、Qwen-Image 2.1（2.1 另有官方 PE 模型，见 3.3）。

### 3.3 Qwen-Image 2.1 官方 PE 改写模型（PE-T2I / PE-I2I）

- 官方随 2.1 发布的**专用微调权重**（Qwen3.5-VL 9B 微调），官方 README 推荐为默认提示词准备方式；PE-T2I 把任意语言短句扩成英文长 prompt + 推荐宽高比，PE-I2I 处理编辑指令。
- ComfyUI 侧实现：[xiaowuapple-pixel/ComfyUI-Prompt-Enhancer](https://github.com/xiaowuapple-pixel/ComfyUI-Prompt-Enhancer)（safetensors 与 GGUF 加载器，GGUF 路径实测比 int8 快约 5×）；另一个实现 [benjiyaya/ComfyUI-Qwen-Image-2.1-Prompt-Enhancer](https://github.com/benjiyaya/ComfyUI-Qwen-Image-2.1-Prompt-Enhancer/)。
- 参考：[comfyui-wiki 报道](https://comfyui-wiki.com/en/news/2026-09-22-qwen-image-2-1-prompt-enhancer)、[Qwen-Image 2.1 官方教程](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1)。
- 147 现状：**未装**，8190 是 Qwen2.1 专用实例，落地优先级高。

### 3.4 Boogu 官方 Qwen3-VL 改写器

- 文件：[boogu-project/Boogu-Image: utils/t2i_external_prompt_rewriter.py](https://github.com/boogu-project/Boogu-Image/blob/main/utils/t2i_external_prompt_rewriter.py)
- 后端：本地 Qwen3-VL-Instruct（2B/4B/8B/32B，官方建议资源够就上 32B）；外挂脚本或 pipeline 内置两种用法。147 已有 `qwen3vl_32b_minimax_h3_int8_convrot` / `nvfp4_awq` 和 8B/4B fp8 权重（虽为 H3 文本编码打包，同族模型），可低成本复现。
- 系统提示词：`T2I_REWRITE_SYSTEM_PROMPT_ZH/EN`（改编自 Qwen-Image 官方 T2I 改写提示词，但更精细）。核心差异点：
  - **最小改写原则**：prompt 已清晰就几乎不改，只补一个风格词；去掉你要加的句子画面仍成立就别加；禁止堆砌「科技感/高级感/震撼」等空泛词；「留白」这类会被生图模型误解的词禁用。
  - **版式/图文类豁免**：流程图、信息图、海报、UI 必须反向极致详尽（每个节点文字、箭头、层级、版式位置全写出）。
  - 具名风格（吉卜力/像素风等）只保留名称不追加解释；不主动添加用户没写的相机参数（35mm、f/1.8、bokeh 等）。
  - 真实 IP/名人只用规范名称指代，禁止推断外观；名人给中英双名。
  - 数量/排列严格执行并逐一描述；无否定词；默认中国语境（未指定时）。
  - 含安全合规改写条款（第 14 条）——按项目内容创作规范，复用时该条只作风险提示、不改稿，交给用户决定。
- 适用：Boogu t2i/edit；其「最小改写原则」对所有生图模型都是好实践，值得作为通用改写器基线。

### 3.5 SCAIL-2 官方 prompt_enhancer.py

- 文件：[zai-org/SCAIL-2: prompt_enhancer.py](https://github.com/zai-org/SCAIL-2/blob/wan-scail2/prompt_enhancer.py)（wan-scail2 分支）
- 后端：**Gemini API**（默认 `gemini-3-flash-preview`，需 GEMINI_API_KEY，支持 GEMINI_BASE_URL 自定义端点），两段式：
  1. `VIDEO_CAPTION_PROMPT`：对源视频抽帧（默认 8 帧）写英文 caption——聚焦场景/光线/取景/背景、动作/运动/时序/运镜、被替换者的服装/姿态/交互物体；明确**不提替换目标图、不虚构目标身份**。
  2. `REPLACEMENT_PROMPT_TEMPLATE`：结合用户指令 + caption + few-shot 示例文件（`prompt_examples.txt`，最多 4000 字符）+ 替换角色参考图，产出最终正向 prompt。
- 改写规则要点：输出**描述替换已完成后的视频**（禁止出现 "replace/swap/edit" 字样）；抹除源主体身份外观、只保留其动作/姿态/时序/空间位置/场景交互；详细描述替换角色的服装外观（以参考图为身份来源）；保留环境、光线、镜头角度、景别、背景物体、运动轨迹；用具体动词的自然视频语言；**一段英文 90-140 词**。
- 适用：SCAIL-2 角色替换/动作迁移；官方 issue 也确认 SCAIL-2 训练时使用长而详细的 prompt，长提示能提升角色一致性。
- 147 复用点：Gemini 可换成任意 OpenAI 兼容 VLM（项目前端已有直连 OpenAI 兼容接口的模式）；两段式「caption → 合成」结构本身是最值得抄的设计。

### 3.6 资产清单总表

| 资产 | 来源文件 | 后端模型 | 输出语言/长度 | 147 落地方式 |
| --- | --- | --- | --- | --- |
| Wan prompt_extend | Wan2.1 repo `wan/utils/prompt_extend.py` | qwen-plus / qwen-vl-max / 本地 Qwen2.5(VL) | 中或英，80-100 字 | 抄 6 套系统提示词 + 选模型逻辑，接自有 LLM |
| Qwen-Image T2I/Edit 改写 | Qwen-Image repo `src/examples/tools/prompt_utils.py` | qwen-plus / qwen-vl-max | 中英，<200 词 + magic prompt | 抄系统提示词 + Edit JSON 输出协议 |
| Qwen-Image 2.1 PE 权重 | 官方 PE-T2I/PE-I2I（Qwen3.5-VL 9B 微调） | 专用权重 | 英文长 prompt + 宽高比建议 | 装 ComfyUI-Prompt-Enhancer 节点（GGUF 路径）到 8190 |
| Boogu rewriter | Boogu-Image repo `utils/t2i_external_prompt_rewriter.py` | Qwen3-VL 2B-32B | 中英 | 抄最小改写原则；可复用 147 已有 qwen3vl 权重 |
| SCAIL-2 enhancer | SCAIL-2 repo `prompt_enhancer.py` | Gemini（可换兼容 VLM） | 英文一段 90-140 词 | 抄两段式 caption→合成结构与两个提示词 |

---

## 四、落地优先级总表

| 优先级 | 事项 | 类别 | 预期收益 | 成本 | 备注 |
| --- | --- | --- | --- | --- | --- |
| P0 | 按模型固化采样参数配方（2.2 表），尤其 lightx2v euler/simple/shift5/2+2、H3 8NFE shift6/3 | 速度+质量 | 最大 | 零（文件全有） | 先建立每模型「速度档/质量档」两套模板 |
| P0 | SCAIL-2 链路必挂 DPO LoRA | 质量 | 手部/唇眼同步 | 零 | 官方推荐 |
| P0 | 抄 5 个官方改写器系统提示词到策略层 | 质量 | 提示词质量系统性提升 | 低（纯文本） | 见 3.6 表 |
| P1 | 装 sage attention（8188），视频工作流全开 | 速度 | 1.2-1.5× 视频 | 低（triton-windows + wheel） | Krea2 需 guard 补丁或豁免 |
| P1 | 复查启动参数：去掉 --disable-smart-memory，--disable-cuda-malloc 按需 | 速度/稳定 | 视情况 | 零 | 会改变行为边界，改前需向用户确认并实测 |
| P1 | WanVideoWrapper TeaCache rel_l1_thresh 0.2-0.3 接入 Wan 长视频 | 速度 | 1.5-2.5× | 低 | 注意 use_coefficients 的加速/质量权衡 |
| P1 | 8190 装 Qwen-Image 2.1 PE 改写节点 | 质量 | 官方推荐默认路径 | 中（下载 9B 权重/GGUF） | 8190 是 Qwen2.1 专用实例 |
| P2 | Wan2.2-Animate 挂 lightx2v 6 步档 | 速度 | ~8× | 零（LoRA 已有） | Animate 对蒸馏鲁棒 |
| P2 | SeedVR2 视频放大定档 FP8+BlockSwap16 | 质量 | 视频高清化 | 低（首次自动下载模型） | 16G 卡官方推荐档 |
| P2 | 图像放大链路标准化：4x-UltraSharp → img2img denoise 0.25-0.35 | 质量 | 细节补全 | 零 | 大图走 TTP Smart Tile 分块 |
| P3 | nvfp4 DiT 试点（Qwen-Image 2.1 或 Wan2.2） | 速度 | 50 系原生 FP4，潜力最大 | 中 | 需 comfy-kitchen/CUDA13 配合，147 torch 已满足 |
| P3 | torch.compile 接入批量重复工作流 | 速度 | 10-30% | 中（首跑编译慢） | 只给长跑批处理用 |
| P3 | 评估 TE-Speed-QwenImage21 / FBCache | 速度 | 待实测 | 低 | 社区新节点，先观望 |

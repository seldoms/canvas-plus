# win147 ComfyUI 资产盘点（HTTP API 只读枚举）

数据来源：`/object_info`、`/system_stats`、`/workflow_templates` 只读 API，未提交任何生成任务。

## 一、实例信息

| 项目 | 生产实例 8188 | Qwen-Image 专用实例 8190 |
| --- | --- | --- |
| 地址 | http://192.168.123.147:8188 | http://192.168.123.147:8190 |
| ComfyUI 版本 | 0.38.2 | 0.37.0 |
| 前端包 | comfyui-frontend-package 1.53.6 | 同左 |
| 模板包 | comfyui-workflow-templates 0.11.74 | 0.11.74（要求 0.11.70） |
| Python / PyTorch | 3.12.10 / 2.10.0+cu130 | 同左 |
| GPU | NVIDIA GeForce RTX 5060 Ti（cuda:0，native） | 同一块卡 |
| VRAM | 17102864384 B（约 15.93 GiB） | 同左 |
| 系统内存 | 34055479296 B（约 31.7 GiB） | 同左 |
| 启动参数要点 | `--listen --dont-upcast-attention --preview-method auto --disable-smart-memory --disable-cuda-malloc` | `--port 8190 --listen 0.0.0.0`，output/input 指向 `D:\Comfyui-WF-2026.8.8\ComfyUI\`，temp 指向 `D:\Comfyui-Qwen21\temp`，其余同上 |
| 节点总数（object_info） | 4485 | 971 |

两实例通过 extra_model_paths.yaml 共享模型目录，下列模型文件清单在两实例的 loader 下拉中**完全一致**。

## 二、按模型目录分类的文件清单

### diffusion_models（21 个 safetensors + 6 个 GGUF，UNETLoader / UnetLoaderGGUF）

- BEYOND_REALITY_3.0_BF16.safetensors
- Wan22Animate\Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors
- boogu_image_edit_int8_convrot.safetensors
- boogu_image_turbo_fp8_scaled.safetensors
- flux1-dev-fp8.safetensors
- krea2_turbo_fp8_scaled.safetensors
- minimax_h3_fl2va_int8_convrot.safetensors
- minimax_h3_fl2va_pruned_fp8_scaled.safetensors
- minimax_h3_fl2va_pruned_int8_convrot.safetensors
- minimax_h3_ref2va_8steps_quantfunc_int4_r128.safetensors
- minimax_h3_ref2va_pruned_fp8_scaled.safetensors
- minimax_h3_ref2va_pruned_int8_convrot.safetensors
- qwen_image_2.1_int8_convrot.safetensors
- qwen_image_edit_2509_fp8_e4m3fn.safetensors
- qwen_image_fp8_e4m3fn.safetensors
- wan2.1_14B_SCAIL_2_fp8_scaled.safetensors
- wan2.2_ti2v_5B_fp16.safetensors
- wan_1.3B_exp_e14.safetensors
- zImageTurboNSFW_v10_fp8.safetensors
- z_image_bf16.safetensors
- z_image_turbo_bf16.safetensors

GGUF（UnetLoaderGGUF / UnetLoaderGGUFAdvanced / GGUFLoaderKJ，同目录）：

- Wan2_2_Animate_14B_Q4_K_M.gguf
- nsfw_wan_14b_e15_q4_k.gguf
- qwen_image_2.1-Q4_K.gguf
- qwen_image_2.1-Q8_0.gguf
- wan2.2-rapid-mega-aio-nsfw-v12.1-Q4_K.gguf
- wan2.2-rapid-mega-aio-nsfw-v12.1-Q5_K.gguf

### checkpoints（7 个，CheckpointLoaderSimple）

- flux1-dev-fp8.safetensors
- ltx-2.3-22b-dev-fp8.safetensors
- ltx-2.3-22b-distilled-fp8.safetensors
- sam3.1-multiplex-fp16.safetensors
- sam3.1_multiplex_fp16.safetensors
- sdpose_wholebody_fp16.safetensors
- v1-5-pruned-emaonly.safetensors

### text_encoders / clip（13 个，CLIPLoader / DualCLIPLoader / TripleCLIPLoader / QuadrupleCLIPLoader 及其 GGUF 变体共用）

- clip_l.safetensors
- gemma_3_12B_it_fp4_mixed.safetensors
- nsfw_wan_umt5-xxl_fp8_scaled.safetensors
- qwen3vl_32b_minimax_h3_int8_convrot.safetensors
- qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
- qwen3vl_4b_fp8_scaled.safetensors
- qwen3vl_8b_fp8_scaled.safetensors
- qwen_2.5_vl_7b_fp8_scaled.safetensors
- qwen_3_4b.safetensors
- t5xxl_fp8_e4m3fn.safetensors
- umt5-xxl-enc-fp8_e4m3fn.safetensors
- umt5_xxl_fp8_e4m3fn_scaled.safetensors
- umt5_xxl_fp8_e4m3fn_scaled_comfyorg.safetensors

注：CLIPLoader 的 `type` 枚举含 `qwen_image`、`boogu`、`krea2`、`minimax`、`wan`、`flux2` 等 29 种模型类型。

### vae（12 个模型 + `pixel_space` 伪选项，VAELoader / WanVideoVAELoader）

- Wan2.1_VAE.safetensors
- Wan2_1_VAE_bf16.safetensors
- Wan2_1_VAE_fp32.safetensors
- ae.safetensors（FLUX）
- ltx-2.3-22b-dev_video_vae.safetensors
- minimax_h3_audio_vae_fp32.safetensors
- minimax_h3_video_vae_fp16.safetensors
- qwen_image_2.1_vae_bf16.safetensors
- qwen_image_vae.safetensors
- wan2.2_vae.safetensors
- wan_2.1_vae.safetensors
- wan_2.1_vae_Comfy-Org.safetensors

### loras（105 个，LoraLoader / LoraLoaderModelOnly）

按用途浓缩（完整 105 条见文末附录）：

- Qwen 系（14）：Qwen-Image Lightning 4/8 步系列（V1.0/V1.1/V2.0）、Qwen-Image-Edit Lightning 系列（2509/2511）、Qwen-Image-Edit-F2P、Wuli-Qwen-Image-2512-Turbo-4steps、p_qwen_image_2.1_8step_v0.1、bfs_head_v1.1_qwen_2.1、bfs_head_v5_2511
- MiniMax H3 系（8）：minimax_h3_turbo_4STEPS、turbo_4step_ema（含 ckpt500/ckpt850）、turbo_v4_step600_ema、fl2v_lightx2v_turbo_4step_v0.1、fl2v_turbo_4step_v0.1_768p_sla、ref2v_turbo_8step_v1.0_768p
- Wan 系（约 30）：Wan2.2-Lightning I2V-A14B 4steps HIGH/LOW、Seko-V1 系列（I2V/T2V high/low noise）、lightx2v 加速系列（T2V/I2V rank4/32/64/128/256）、Wan2.2-Fun-A14B-InP high/low noise、FastWan_T2V_14B、Pusa V1、SVI_v2_PRO I2V HIGH/LOW、WanAnimate_relight、Wan2.1 360 度旋转、scail2-dpo-lora_new、wan2.1_SCAIL_2_DPO 等
- LTX 系（7）：ltx-2-19b-distilled-lora-384、ltx-2.3-22b-distilled-lora-384（含 1.1）、ltx-2-19b-ic-lora-detailer、LTX2.3-IC-LORA-Dual-Character、LTXV-13B-arcane_jinx、LTXV-13B-shinkai-anime-style、kiss_ltx2_lora
- Z-Image 系（6）：StarFace1.0-Z-Image-Turbo、Z-Image-Fun-Lora-Distill-8-Steps-2603、pixel_art_style_z_image_turbo、aollo_zimage_turbo、aollo_zimage_v10_fp8、wenzhiyu_woman_zimage_turbo(-1) / zimage_v10_fp8
- Krea2 系（8）：Krea2_Fine_Art_Portraiture_st6000、majicbeauty_krea2_st6000、krea2-Cc- 系列 5 个（FQWZ-ArtStyle / FQWZ-Portrait / FY-Portrait / Ins-Portrait / MJ-CinematicSoftLight / MJ-FilterStyle / TM-GreatFigure）、krea2_darkbrush
- FLUX / SD1.5 系：FLUX.1-Turbo-Alpha、Hyper-FLUX.1-dev-8steps、aollo_flux、aollo_sd15、wenzhiyu_woman_flux、wenzhiyu_woman_sd15、flux-ace++\comfyui_subject_lora16、阿里\portrait-photography
- 其他：DreamO cfg_distill、ICEdit-MoE-LoRA（+pytorch_lora）、Kontext Overlay、next-scene_lora-v2-3000、consistence_edit_v2、SESELAORUYAO、aollo、adapter_model、model、20、t8\LTX-2.3-Licon-MSR-V1_B、W22L 物理抖动系列 2 个、Wan2.1 I2V LoRA-360 度旋转 等

### upscale_models（1 个，UpscaleModelLoader）

- 4x-UltraSharp.pth

另有 SeedVR2 插件自带下载式模型选项（非本地目录枚举）：seedvr2_ema_3b / 7b 系列（fp8/fp16/GGUF），VAE 为 ema_vae_fp16.safetensors（首次使用自动下载）。

### 其他目录

- clip_vision（2 个，CLIPVisionLoader）：CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors、clip_vision_h.safetensors
- controlnet（2 个，ControlNetLoader / DiffControlNetLoader）：Wan21_Uni3C_controlnet_fp16.safetensors、control_v11p_sd15_openpose.pth
- style_models：空（StyleModelLoader 无选项）
- photomaker：空（PhotoMakerLoader 无选项）
- instantid：空（InstantIDModelLoader 无选项）
- model_patches：空（ModelPatchLoader 无选项）
- gligen：空（GLIGENLoader 无选项）

## 三、8188 与 8190 的差异

- 节点总数：8188 = 4485，8190 = 971；仅 8190 独有的节点只有 1 个：`OpenAIVideoSora2`（云端 API 节点）。8190 缺少的 3515 个节点基本全部是 8188 上安装的第三方自定义节点包。
- 模型文件清单两实例完全一致（共享模型目录），8190 的「专用」体现在节点与输出目录配置，而不是模型。
- 8190 缺少的关键套件（均仅存在于 8188）：
  - WanVideoWrapper（KJ）：WanVideoModelLoader、WanVideoVAELoader 等整套
  - WanAnimatePlus 全家桶（ModelLoader / Sampler / Embeds / SCAIL_2 等约 40 个节点）
  - MiniMax H3 全家桶：MiniMaxH3Director、MiniMaxH3TurboSampler/LoRA、T8 音频系列（约 20 个）、QuantFunc H3 系列（QuantFuncH3Loader / ImageToVideoStage2 / ReferenceToVideoStage2）
  - QuantFunc 量化加载器：QuantFuncQwenImage21Loader、QuantFuncKrea2Loader（8190 无）
  - Qwen 编辑链：QwenEditAny2Image/Latent、TextEncodeQwenImageEditPlus 的 lrzjason 变体、QwenMultiangleCamera、TDQwen3TTS 系列、LayerUtility QWenImage2Prompt
  - Krea2 工具链：Krea2StyleTransfer、ConditioningKrea2Rebalance、VRGDG Krea2 训练系列
  - SeedVR2 视频放大（SeedVR2VideoUpscaler / SeedVR2LoadDiTModel / SeedVR2LoadVAEModel）
  - DiffusionModelLoaderKJ、GGUFLoaderKJ、DiffControlNetLoader、InstantIDFaceAnalysis、SAMLoader/SAMDetectorSegmented（impact pack）、大量采样器/放大器供应商节点
- 8190 保留的核心能力：基础 loader（UNET/CLIP/DualCLIP/TripleCLIP/QuadrupleCLIP/VAE/LoRA/GGUF 系列）、Qwen-Image 官方节点（TextEncodeQwenImageEdit(Plus)、QwenImageDiffsynthControlnet、ModelMergeQwenImage、QwenImage21Cache）、Z-Image（ComfyCloudZImageTurboNode、TextEncodeZImageOmni、ZImageFunControlnet）、Krea2ImageNode、MiniMax H3 基础节点（ImageToVideo/ReferenceToVideo/SigmaShift 等 9 个）、WanSCAILToVideo、WanAnimateToVideo/WanAnimate2ToVideo、SAM3 系列（Detect/VideoTrack/TrackPreview/TrackToMask/SAM3DBody）、基础 UpscaleModelLoader/ImageUpscaleWithModel。
- 工作流模板：8188 的 `/workflow_templates` 与 `/api/workflow_templates` 均返回 36 组共 337 个模板（来自各插件包）；8190 返回空对象 `{}`（未装带模板的插件）。

## 四、关键专用节点清单（按关键词）

计数格式为 `8188 / 8190`。

- **qwen**（45 / 9）：8190 有 TextEncodeQwenImage21、TextEncodeQwenImageEdit(Plus)、QwenImageDiffsynthControlnet、ModelMergeQwenImage、QwenImage21Cache、EmptyQwenImageLayeredLatentImage、QwenImageEditApi、QwenImageTextToImageApi；8188 另有 QwenLoader、QuantFuncQwenImage21Loader、QwenEdit 系列、TDQwen3TTS 系列、TTP QwenVL 系列、QwenMultiangleCamera 系列、TorchCompileModelQwenImage 等
- **krea**（17 / 3）：8190 仅 Krea2ImageNode、Krea2StyleReferenceNode、ModelMergeKrea2；8188 另有 QuantFuncKrea2Loader、Krea2StyleTransfer/TwoStyleTransfer、ConditioningKrea2Rebalance、Krea2PromptWeight、Krea2SizePreset、VRGDG Krea2 训练系列
- **boogu**（1 / 1）：TextEncodeBooguEdit（两实例都有）
- **zimage**（9 / 5）：两实例共有的核心：ComfyCloudZImageTurboNode、TextEncodeZImageOmni、ZImageFunControlnet、TopazImageEnhance(V2)；8188 另有 VRGDG Z-Image 训练/工作流节点
- **flux**（46 / 26）：基础 FluxGuidance/FluxKontext 等官方节点两边都有；8188 另有 FluxVideoUpscaleNode、大量 RES4LYF/LanPaint/impact 相关
- **wan**（226 / 44）：8190 保留官方 WanImageToVideo/WanSCAILToVideo/WanAnimateToVideo 等原生节点；8188 另有 WanVideoWrapper 全套、WanAnimatePlus 全套、WanMoeKSampler、Wan22FMLF/SVI 等
- **minimax / h3**（52/20 与 43/9）：8190 保留 EmptyMiniMaxH3LatentAV、MiniMaxH3ImageToVideo、MiniMaxH3AddGuide、MiniMaxH3ReferenceToVideo、MiniMaxH3SigmaShift、MiniMaxH3FunControlNetApply 及 ComfyCloud H3 API 节点；8188 另有 MiniMaxH3Director、Turbo（Sampler/LoRA/SmartCache）、T8 音频全套、PDDAcc、QuantFunc H3 系列
- **scail**（9 / 2）：两实例都有 WanSCAILToVideo、SCAIL2ColoredMask；8188 另有 SCAIL2ColoredMaskV2、WanAnimatePlus SCAIL_2 系列、WanVideoAddSCAILPoseEmbeds/ReferenceEmbeds
- **sam**（核心模型相关）：两实例都有 SAM3_Detect、SAM3_VideoTrack、SAM3_TrackPreview、SAM3_TrackToMask、SAM3DBody_Loader/Predict/FaceExpression/Smooth/Render；sam3.1 权重文件在 checkpoints 目录（见上）。8188 另有 SAMLoader/SAMDetectorSegmented（impact pack）、easy samLoaderPipe
- **animate**（47 / 6）：8190 有 WanAnimateToVideo、WanAnimate2ToVideo、WanAnimate2Cache、SaveAnimatedPNG/WEBP；8188 另有 WanAnimatePlus 全套（约 40 个）
- **upscale**（43 / 14）：两实例都有 UpscaleModelLoader、ImageUpscaleWithModel、LatentUpscale(By)、LatentUpscaleModelLoader；8188 另有 SeedVR2 全套、ImageUpscaleWithModelBatched、PixelKSampleUpscaler 系列、SEGSUpscaler、TTP Smart Tile Upscale 等
- **gguf**（9 / 6）：两实例都有 UnetLoaderGGUF(Advanced)、CLIPLoaderGGUF、DualCLIPLoaderGGUF、TripleCLIPLoaderGGUF、QuadrupleCLIPLoaderGGUF；8188 另有 GGUFLoaderKJ、VRGDG_GeneralGGUF、VRGDG_SuperGemmaGGUFChat

## 五、官方/插件工作流模板（8188，共 36 组 337 个；8190 为空）

与已装模型直接相关的模板（按插件组）：

- ComfyUI-QuantFunc（12 个）：QuantFunc-QwenImage21-t2i / -edit / -edit-multi-reference / -edit-remove-background / -t2i-transparent、QuantFunc-Krea2-t2i(-double-sampling)、QuantFunc-MiniMaxH3-fl2va(-double-sampling)、QuantFunc-MiniMaxH3-ref2va(-double-sampling)、QuantFunc-LTX25-t2v
- ComfyUI-MiniMax-H3-Turbo：minimax_h3_t2v_turbo
- ComfyUI-MiniMax-H3-PDD-Acc：pdd_acc_t2v_latent_upscale、pdd_video_upscale_long
- comfyui-minimax-h3-audio-T8：H3_Turbo_Stable_4V4A（AV各4步）
- ComfyUI-DaSiWa-Nodes：DaSiWa MiniMaxH3 MythicAlchemy C-MMH3-13 / C-MMH3-16
- ComfyUI-WanVideoWrapper（43 个）：wanvideo_2_1_14B 系列（T2V/I2V/FLF2V/Fun_control/SCAIL/pusa/InfiniteTalk/FantasyPortrait/HuMo/Stand-In 等）、wanvideo_2_2 系列（5B I2V/T2V、A14B、Ovi 音频）、wanvideo_1_3B 系列（control_lora/EchoShot/FlashVSR_upscale/ReCamMaster/UniLumos/VACE）、wanvideo_WanAnimate 示例
- ComfyUI-WanAnimatePlus：example_workflow_scail2
- ComfyUI-WanAnimatePreprocess：WanAnimate_native_example_01
- ComfyUI-Wan22FMLF（4 个）：SVI pro / SVI pro boost、Wan22FMLF-1109update、长视频-SVI-shot+三图
- ComfyUI-WanMoeKSampler（4 个）：Wan MoE I2V / T2V（含 custom）
- ComfyUI-SCAIL-Pose：SCAIL_preprocess_example_01
- ComfyUI-SeedVR2_VideoUpscaler（3 个）：SeedVR2_4K_image_upscale、SeedVR2_HD_video_upscale、SeedVR2_simple_image_upscale
- LanPaint（13 个）：Qwen_Image_Inpaint/Outpaint、Masked_Qwen_Image_Edit(_2509)、Z_image_(base_)Inpaint、Krea2_LanPaint_Inpaint、Flux/Flux2 inpaint、wan2_2_T2I_(Partial_)Inpaint、Hunyuan_Inpaint
- ComfyUI-ConditioningKrea2Rebalance：Krea 2 Edit (Full Context)、krea2_image_edit_workflow (3)
- ComfyUI-Krea2-StyleTransfer：Krea2 Style Transfer、Krea2 Two Style Transfer
- ComfyUI-qwenmultiangle：image_qwen_image_edit_2511_multiangle_camera
- ComfyUI-TD-Qwen3TTS：Qwen3-TD-TTS、qwen3tts-多人对话
- WhatDreamsCost-ComfyUI（LTX 工作流 5 个）：LTX I2V FFLF Custom Audio V3、First Last Frame 2/3 Stage v6、LTX_Director_2（Distilled/GGUF）
- Comfyui_TTP_Toolset：8mega_pixel_super_upscale_for_flux_ver2、LTX_2 首末帧系列、smart_tile_qwen_sam_loop_example_v2、ttp_smart_tile_example_Krea2_edit 等
- RES4LYF（30+ 个）：flux inpaint/regional/style/upscale 系列、hidream 系列、wan txt2img/img2vid/vid2vid
- comfyui-impact-pack：1-FaceDetailer、2-MaskDetailer、3-SEGSDetailer、4-MakeTileSEGS-Upscale 等
- comfyui-inpaint-cropandstitch：inpaint_flux、inpaint_sd15
- 其余分组：audio-separation、kjnodes、alekpet、UniBlockSwap、instantid、pulid、mixlab、layerstyle(_advance)、GeometryPack、inpaint-nodes、Sharp、masquerade 等（与当前主力模型关联较弱，未逐一列出）

## 附录：loras 完整清单（105 个）

```
20.safetensors
DreamO\dreamo_cfg_distill_comfyui.safetensors
FLUX\FLUX.1-Turbo-Alpha.safetensors
FastWan\FastWan_T2V_14B_480p_lora_rank_128_bf16.safetensors
Hyper-FLUX.1-dev-8steps-lora.safetensors
ICEdit\ICEdit-MoE-LoRA.safetensors
ICEdit\pytorch_lora.safetensors
Kontext\Overlay-Kontext-Dev-LoRA.safetensors
Krea2_Fine_Art_Portraiture_st6000.safetensors
LTX2.3-IC-LORA-Dual-Character.safetensors
LTXV-13B-arcane_jinx_step_12000_comfy.safetensors
LTXV-13B-shinkai-anime-style-lora-v1_58000.safetensors
Lightx2v\lightx2v_I2V_14B_480p_cfg_step_distill_rank256_bf16.safetensors
Lightx2v\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors
LoRAs\Wan22-Lightning\old\Wan2.2-Lightning_I2V-A14B-4steps-lora_LOW_fp16.safetensors
LoRAs\Wan22_relight\WanAnimate_relight_lora_fp16.safetensors
Pusa\Wan21_PusaV1_LoRA_14B_rank512_bf16.safetensors
Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors
Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors
Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors
Qwen-Image-Edit-F2P.safetensors
Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors
Qwen-Image-Edit-Lightning-8steps-V1.0.safetensors
Qwen-Image-Lightning-4steps-V1.0.safetensors
Qwen-Image-Lightning-8steps-V1.1.safetensors
Qwen-Image-Lightning-8steps-V2.0-bf16.safetensors
Qwen-Image-Lightning-8steps-V2.0.safetensors
Qwen-Image\Qwen-Image-Lightning-4steps-V2.0-bf16.safetensors
Qwen\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors
SESELAORUYAO.safetensors
StarFace1.0-Z-Image-Turbo.safetensors
W22L-9柔软弹跳抖动-bounce_test_LowNoise-05.safetensors
W22L-物理胸部-BounceLow.safetensors
Wan2.1 I2V LoRA-360 度旋转.safetensors
Wan2.1-360_epoch20.safetensors
Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors
Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors
Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-high_noise_model-comfy.safetensors
Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-low_noise_model-comfy.safetensors
Wan2.2-Lightning_I2V-A14B-4steps-lora_HIGH_fp16.safetensors
Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1-high_noise_model.safetensors
Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors
Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V2.0-bf16.safetensors
Z-image\Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI.safetensors
adapter_model.safetensors
aollo.safetensors
aollo_flux.safetensors
aollo_sd15.safetensors
aollo_zimage_turbo.safetensors
aollo_zimage_v10_fp8.safetensors
bfs_head_v1.1_qwen_2.1.safetensors
bfs_head_v5_2511.safetensors
consistence_edit_v2.safetensors
flux-ace++\comfyui_subject_lora16.safetensors
kiss_ltx2_lora.safetensors
krea2-Cc-FQWZ-ArtStyle.safetensors
krea2-Cc-FQWZ-Portrait.safetensors
krea2-Cc-FY-Portrait.safetensors
krea2-Cc-Ins-Portrait.safetensors
krea2-Cc-MJ-CinematicSoftLight.safetensors
krea2-Cc-MJ-FilterStyle.safetensors
krea2-Cc-TM-GreatFigure.safetensors
krea2_darkbrush.safetensors
lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors
lightx2v_I2V_14B_480p_cfg_step_distill_rank32_bf16.safetensors
lightx2v_I2V_14B_480p_cfg_step_distill_rank4_bf16.safetensors
lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors
ltx-2-19b-distilled-lora-384.safetensors
ltx-2-19b-ic-lora-detailer.safetensors
ltx-2.3-22b-distilled-lora-384-1.1.safetensors
ltx-2.3-22b-distilled-lora-384.safetensors
majicbeauty_krea2_st6000.safetensors
minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors
minimax_h3_fl2v_turbo_4step_v0.1_768p_sla_comfyui_bf16.safetensors
minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_20_bf16.safetensors
minimax_h3_turbo_4STEPS_comfyui.safetensors
minimax_h3_turbo_4step_ema.safetensors
minimax_h3_turbo_4step_ema_ckpt500.safetensors
minimax_h3_turbo_4step_ema_ckpt850.safetensors
minimax_h3_turbo_v4_step600_ema.safetensors
model.safetensors
next-scene_lora-v2-3000.safetensors
p_qwen_image_2.1_8step_v0.1.safetensors
pixel_art_style_z_image_turbo.safetensors
scail2-dpo-lora_new.safetensors
t8\LTX-2.3-Licon-MSR-V1_B.safetensors
wan2.1_SCAIL_2_DPO_lora_bf16.safetensors
wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors
wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors
wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022_modified.safetensors
wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors
wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors
wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors
wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors
wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors
wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors
wan\SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors
wan\SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors
wenzhiyu_woman_flux.safetensors
wenzhiyu_woman_sd15.safetensors
wenzhiyu_woman_wan22_5b.safetensors
wenzhiyu_woman_zimage_turbo-1.safetensors
wenzhiyu_woman_zimage_turbo.safetensors
wenzhiyu_woman_zimage_v10_fp8.safetensors
阿里\portrait-photography.safetensors
```

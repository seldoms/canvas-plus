# win147 ComfyUI 模型家族版本调研与升级建议

调研时间基准：2026-10-03。硬件约束：RTX 5060 Ti 16G VRAM / 32G RAM；生产实例 8188（ComfyUI 0.38.2，89+ 第三方节点包，不轻易升级主版本），Qwen-Image 2.1 专用实例 8190（ComfyUI 0.37.0，节点少、升级风险低）。结论先行，依据来源逐条标注 URL；查不到的写「未找到官方依据」。

## 总体结论

| 家族 | 已装 | 最新（2026-10-03） | 建议 |
| --- | --- | --- | --- |
| Qwen-Image 20B 线 | Qwen-Image fp8（2025-08）+ Edit-2509 | Qwen-Image-2512（2025-12-31）/ Edit-2511（2025-12-23） | 可选补装 2512 fp8（本地已有 2512 Lightning LoRA 但缺底座） |
| Qwen-Image 2.1（7B 统一） | 已装（GGUF Q4_K/Q8_0 + int8_convrot） | 2.1（2026-09-20）即最新 | 已是最新；8190 可升 ComfyUI 0.38.x 拿 tiny VAE / union controlnet |
| Z-Image | Turbo + base bf16 | Turbo（2025-11-26）+ base（2026-01-27）；Edit 未发布 | 已是最新，观望 Z-Image-Edit |
| Krea | Krea2 Turbo fp8 | Krea 2（2026-06-22）Raw+Turbo；无 Krea 3 | 已是最新 |
| FLUX | FLUX.1-dev fp8 | FLUX.2 dev 32B（开权重非商用）/ klein 4B·9B（2026-01-15）；FLUX 3 仅早期访问 | dev 不升级（16G 跑不动结论仍成立）；可选装 klein-4B |
| Boogu | 0.1 Turbo fp8 + Edit int8_convrot | 0.1 系列（2026-06-16）；Turbo-2K / Edit-Turbo 已宣布 | 观望，正式权重放出后轻量替换 |
| Wan 主线 | Wan2.1 / Wan2.2 全家 | Wan 2.5 / 2.6 / 3.0 全部 API-only 无权重 | 观望（无权重可升），Wan2.2 仍是最新开源主线 |
| Wan-Animate | Wan2.2-Animate-14B（2025-09） | Wan2.2-Animate-2-14B（2026-08，开源） | **建议升级**（同 14B 规模，ComfyUI ≥0.31 原生支持） |
| SCAIL | SCAIL-2（Wan2.1 14B 底座） | SCAIL-2（2026-06）即最新 | 已是最新 |
| MiniMax H3 | H3 本地 6 量化变体 + turbo LoRA | H3（2026-07-31 发布 / 08-03 开权重）即最新；H3 Max 系为 fal 托管 API | 已是最新，观望 H3 Max 是否放权重 |
| LTX | LTX-2.3 22B dev/distilled fp8 | LTX-2.5（2026-08-11，22B 视频+同步音频，4K） | **建议升级**（GGUF 量化可在 16G 跑，ComfyUI ≥0.32 原生支持） |
| SAM | SAM 3.1 multiplex ×2（重复文件） | SAM 3.1（2026-03-27）即最新 | 已是最新；删一个重复权重 |
| 4x-UltraSharp | 4x-UltraSharp.pth（2023 老模型） | 无更新 | 不升级；逐步用已装的 SeedVR2 替代 |
| 社区 merge（NSFW_Wan、rapid-mega-aio、zImageTurboNSFW、BEYOND_REALITY 等） | 各有版本 | 无官方升级线 | 未找到官方依据，按 Civitai/HF 作者页手动跟踪 |

---

## 一、文生图

### Qwen-Image（20B 线）

- **已装**：`qwen_image_fp8_e4m3fn.safetensors`（2025-08 初版）、`qwen_image_edit_2509_fp8_e4m3fn.safetensors`；另有 2512 Lightning 4 步 LoRA、Wuli 2512 Turbo LoRA（**底座 2512 未装，这些 LoRA 当前无法发挥**）。
- **最新**：
  - Qwen-Image-2512，2025-12-31 发布，20B，Apache 2.0，AI Arena 开源第一；官方 GitHub 已释出权重（[QwenLM/Qwen-Image](https://github.com/QwenLM/Qwen-Image)、[The AI Bench 模型页](https://theaibench.ai/models/qwen-image/)）。
  - Qwen-Image-Edit-2511，2025-12-23 发布（同上来源；[rundiffusion 报道](https://www.rundiffusion.com/qwen-image-2512-edit-2511-layers)）。
  - 未发现 Edit-2512；20B 线止于 2512/2511，后续演进转入 7B 的 Qwen-Image 2.x（2.0 于 2026-02 发布，[The AI Bench](https://theaibench.ai/models/qwen-image/)）。
- **能力增量**：2512 相对初版大幅提升人像真实感（减少 AI 味、面部细节、年龄与姿态遵循）与自然纹理；文字渲染（中/英/阿）仍是同级最强（[naga.ac 对比](https://naga.ac/compare/qwen-image-2512/qwen-image-edit-2511)）。
- **硬件可行性**：官方/Comfy-Org 提供 fp8（`qwen_image_2512_fp8_e4m3fn.safetensors`），与现有 fp8 工作流同级，16G 可跑（[掘金工作流指南](https://juejin.cn/post/7590676494924202022)）。ComfyUI 版本无额外要求。
- **升级建议**：**可选升级**。2.1（7B）已装且更新，但 20B 2512 在文字渲染与画质上仍有差异价值；且本地已有 2512 Lightning/Turbo LoRA，装上底座即可 4 步出图。只动模型文件，不动 8188 的 ComfyUI。

### Qwen-Image 2.1（7B 统一生成+编辑）

- **已装**：`qwen_image_2.1-Q4_K/Q8_0.gguf` + `qwen_image_2.1_int8_convrot.safetensors`（8190 专用实例）。
- **最新**：2.1 即最新，2026-09-20/21 发布，7B 32 层单流 DiT，单 checkpoint 同时做生成与编辑（[QwenLM/Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1)、[发布周报道](https://www.tutorial3d.it/news/ai-della-settimana-24-settembre-2026/)）。
- **能力增量**（相对 2.0 与 20B 线）：原生 2K 输出、原生 RGBA 透明 PNG、最多 10 张参考图、混合粒度注意力 + prefix KV cache（[cldnavi 指南](https://cldnavi.com/en/blog/qwen-image-2-1-guide-2026/)）。
- **硬件可行性**：INT8 约 7.3GB、GGUF Q4 更小，16G 宽裕（[AlphaLab 教程](https://www.alphalab.site/qwen-image-2-1-comfyui-guide)）。ComfyUI 原生支持自 **v0.37.0** 起（[ComfyUI v0.37.0 release](https://github.com/comfy-org/ComfyUI/releases)，CORE-423）——这正是 8190 用 0.37.0 的原因；v0.38.0 追加 tiny VAE、union fun controlnet、transformer 编译加速。
- **升级建议**：**已是最新**。可选：8190 实例节点少（971 个），从 0.37.0 升到 0.38.x 风险低，能拿 tiny VAE / controlnet / 编译优化；8188 保持不动。

### Z-Image

- **已装**：`z_image_turbo_bf16` + `z_image_bf16`（+ Turbo NSFW merge、若干 LoRA）。
- **最新**：Turbo 2025-11-26 发布（6B S3-DiT，Apache 2.0），base 2026-01-27 释出权重（[Tongyi-MAI/Z-Image](https://github.com/Tongyi-MAI/Z-Image)）。**Z-Image-Edit 与 Z-Image-Omni-Base 截至 2026-08 仍标注「to be released」，无公开权重**（[localaimaster](https://localaimaster.com/blog/z-image-base-edit-guide)）。
- **升级建议**：**已是最新，观望 Edit**。图编需求已由 Qwen 2.1 / Boogu 覆盖，Z-Image-Edit 放出后再评估。

### Krea

- **已装**：`krea2_turbo_fp8_scaled`。
- **最新**：Krea 2（12B DiT）2026-06-22 发布、次日开源 Raw + Turbo 权重（自定义许可），Day-0 ComfyUI 支持，社区有 fp8→nvfp4 量化；平台另有 Medium/Large 档但未开放权重。**未发现 Krea 3 或 2.x 后续版本**（[kompozy 评测](https://kompozy.io/reviews/krea-2)、[braindetox 汇总](https://braindetox.kr/en/posts/krea2_open_image_model_2026.html)、[nevercodealone](https://nevercodealone.de/de/glossare/ki-tools-2026/krea-2)）。
- **升级建议**：**已是最新**。

### FLUX

- **已装**：`flux1-dev-fp8`（12B）。
- **最新**：FLUX.2 家族——pro/flex 为 API-only；**dev（32B）开放权重但非商用**；klein 4B（Apache 2.0、4 步蒸馏、约 8–13GB VRAM）与 klein 9B（许可更严）于 2026-01-15 发布。FLUX 3 于 2026-09 公布，仅早期访问（图像/视频未放权重；另有机器人用 FLUX 3 Action 7B 预告开源）（[iotdigitaltwinplm 分层解析](https://iotdigitaltwinplm.com/flux-image-generation-model-architecture-benchmarks-2026/)、[chatimg 对比](https://chatimg.ai/en/blog/flux-2-vs-gpt-image-2-vs-seedream-vs-nano-banana)、[tutorial3d 周报](https://www.tutorial3d.it/news/ai-della-settimana-24-settembre-2026/)）。
- **硬件可行性**：FLUX.2 dev 32B——BF16 约 64GB、fp8 约 32–35GB、GGUF Q4 约 19GB（[localaimaster](https://localaimaster.com/blog/flux-2-local-setup-guide)、[willitrunai](https://willitrunai.com/blog/flux-2-klein-9b-vram-requirements)）。**「fp8 35G 跑不动」的结论仍成立**；Q4 19GB 也超过 16G VRAM，需 CPU offload，32G RAM 下勉强且慢。klein-4B/9B 则可轻松跑。
- **升级建议**：**不升级 dev**（硬件不够且非商用许可）；如想体验 FLUX.2 管线，可装 klein-4B（Apache 2.0 可商用，8GB 级）。FLUX.1-dev 保留作旧工作流兼容。

### Boogu（华为香港小艺实验室，Apache 2.0）

- **已装**：`boogu_image_turbo_fp8_scaled`、`boogu_image_edit_int8_convrot`（0.1 家族，10B）。
- **最新**：0.1 Base/Edit/Turbo 于 2026-06-16 发布；**Turbo-2K（文生图 2K）与 Edit-Turbo 已宣布**，官方页标注 coming（[boogu-project/Boogu-Image](https://github.com/boogu-project/Boogu-Image)、[reddit 公告贴](https://www.reddit.com/r/StableDiffusion/comments/1u9281p/booguimageeditturbo_announced_plus_a_turbo2k/)）。官方推荐 16G 显存用 fp8 + CPU offload（[smzdm 实测](https://post.smzdm.com/p/avgqvon7)）。
- **升级建议**：**观望→轻量升级**。当前 0.1 即最新正式权重；Turbo-2K / Edit-Turbo 放出后直接换文件即可（10B 规模，16G 可行），无需动 ComfyUI。

### BEYOND_REALITY 3.0（社区 checkpoint）

- Civitai 社区写实 checkpoint，无官方 GitHub/博客版本线。**未找到官方依据**判断是否有 3.0 之后的新版；建议按 Civitai 模型页手动跟踪，升级成本为零（替换文件）。

---

## 二、图编

图编已装：Qwen-Image-Edit-2509（fp8）、Boogu edit、Qwen-Image 2.1（生成+编辑一体）。

- Qwen-Image-Edit 最新为 **2511**（2025-12-23），未发现 2512 Edit；更实质性的升级已由 Qwen-Image 2.1 覆盖（多参考 10 图、透明 PNG、局部编辑）。来源见第一节。
- **升级建议**：**已是最新**（2.1 在装）。可选补 Edit-2511 fp8 替换 2509，配合本地已有的 2511 Lightning LoRA；优先级低。

---

## 三、视频

### Wan 主线（T2V/I2V/TI2V）

- **已装**：Wan2.1 T2V 1.3B/14B、Wan2.2 ti2v 5B fp16。
- **最新动态**：Wan 2.5（2026 春）、Wan 2.6、Wan 3.0（2026-08 beta 后 GA）**全部为 API-only，未开放权重**；官方 GitHub org 仍只有 Wan2.1 / Wan2.2 两个主仓库（[github.com/Wan-Video](https://github.com/Wan-Video)、[wan27.org 核实](https://wan27.org/blog/wan-2-5-open-source-guide)、[atlascloud 核实 Wan3.0](https://www.atlascloud.ai/blog/tips/is-wan-3.0-open-source)、[reddit 讨论](https://www.reddit.com/r/StableDiffusion/comments/1s0ic9l/opensourcing_new_qwen_and_wan_models/)）。仅 Wan2.5-VAE 单独开源（2026-03，[HF 引用](https://huggingface.co/wangkanai/wan25-vae)）。ComfyUI 的 Wan 3.0 节点是云端 partner API 节点（v0.34.0）。
- **升级建议**：**观望**。无权重可升，Wan2.2 仍是最新开源主线；本地 8188 已有整套 Wan2.2 加速 LoRA 生态（Lightning/Seko/lightx2v/SVI），继续服役。

### Wan-Animate

- **已装**：Wan2.2-Animate-14B（2025-09-19 发布，fp8 KJ + GGUF Q4_K_M）。
- **最新**：**Wan2.2-Animate-2-14B，2026-08 发布，开放权重**，端到端、跳过骨架中间阶段；注意命名陷阱（`Animate-14B` 是一代，`Animate-2-14B` 是二代）（[OrcaRouter 解析](https://www.orcarouter.ai/fr/blog/wan-2-2-animate-2-14b-open-weights)）。ComfyUI **v0.31.0** 起原生支持 Wan-Animate2（[release 日志](https://github.com/comfy-org/ComfyUI/releases)，CORE-358），8190 实例已出现 `WanAnimate2ToVideo` 节点。
- **硬件可行性**：同 14B 规模，fp8/GGUF 量化路径与一代相同，16G 可跑（需 offload，与现状一致）。
- **升级建议**：**建议升级**。同规模同生态位的直接换代，官方原生节点已就位；只加模型文件，不动 8188 的 ComfyUI 与节点包。

### SCAIL（角色动画，zai-org）

- **已装**：SCAIL-2（Wan2.1 14B 底座 fp8）+ DPO LoRA。
- **最新**：SCAIL-2（arXiv 2026-06-09，端到端 in-context conditioning + MotionPair-60K）即最新；SCAIL-1 为 CVPR 2026 Findings。**未发现 SCAIL-3**（[zai-org/SCAIL](https://github.com/zai-org/SCAIL)、[arXiv SCAIL-2](https://arxiv.org/html/2606.10804v1)）。
- **升级建议**：**已是最新**。

### MiniMax H3

- **已装**：H3 本地版 fl2va/ref2va 共 6 个量化变体 + 全套 turbo 4/8 步 LoRA（H3：33B，2026-07-31 发布，2026-08-03 开放权重，原生 2K + 同步音频，ComfyUI v0.30 起原生支持）。
- **最新动态**：H3 即最新开源底座。H3 Max / H3 Max Turbo 是 fal 托管的 API 模型（Max Turbo 2026-09 预览），**非 MiniMax 官方新权重、不可本地部署**；未发现 H4（[morphic](https://morphic.com/resources/models/minimax-h3-max-turbo)、[jxp 澄清](https://www.jxp.com/minimax/blog/minimax-h3-max-vs-minimax-h3)、[criticatv 对比](https://www.criticatv.com/ltx-2-5-vs-minimax-h3-comfyui-image-to-video/)）。注意 H3 社区许可不覆盖美/欧/英/韩（[fuser.studio](https://fuser.studio/articles/best-open-source-video-models)）。
- **升级建议**：**已是最新，观望**。若 H3 Max 日后放权重再评估（33B 以上规模对 16G 压力会更大）。

### LTX（Lightricks）

- **已装**：LTX-2.3 22B dev/distilled fp8 + 对应 VAE + 7 个 LoRA/IC-LoRA。
- **最新**：**LTX-2.5，2026-08-11 发布**，22B 非对称双流 DiT，单模型出视频+同步音频，720p–4K HDR，6–20 秒，Gemma 4 12B 文本编码器，HF gated（LTX-2.x Community License，年收入 <\$10M 免费商用）；官方仓库自述「LTX-2.5 is the recommended model」（[clore.ai 指南](https://docs.clore.ai/guides/video-generation/ltx-video-2-5)、[kie.ai](https://kie.ai/blog/what-is-ltx-2-5)、[fuser.studio](https://fuser.studio/articles/best-open-source-video-models)）。ComfyUI **v0.32.0** 起原生支持（[release 日志](https://github.com/comfy-org/ComfyUI/releases)），本机 0.38.2 满足。
- **硬件可行性**：fp8 全质量约需 32GB VRAM（[versely](https://www.versely.studio/blog/open-weights-wave)）；16G 需走社区 GGUF Q4 量化 + CPU offload（本地 2.3 已有 GGUF 工作流先例：WhatDreamsCost `LTX_Director_2 GGUF` 模板），distilled 变体 + 低分辨率可行但偏慢。2026-09 官方又补发了一批 2.5 用 LoRA/IC-LoRA（[localmodelwatch](https://localmodelwatch.tsuchitsuchi.com/en/2026/09/11/lightricks-releases-lora-ic-lora-for-ltx-25/)）。
- **升级建议**：**建议升级**。同步音频 + 4K 是实质代际增量，ComfyUI 原生支持已就位；用 GGUF Q4 + distilled 起步，与 2.3 并存（VAE/encoder 不通用，需新增约 20–30GB 磁盘，D 盘余量充足）。

### 社区 merge 视频模型（NSFW_Wan 1.3B/14B、wan2.2-rapid-mega-aio v12.1、zImageTurboNSFW v10、wan_1.3B_exp）

- 均为 Civitai/HF 个人作者的 merge/微调，无官方升级线。rapid-mega-aio 作者（Phr00t）在 HF 有持续迭代记录（如 mega v9 讨论串），**具体最新版号未找到官方依据**，以作者页为准手动跟踪；升级零成本（换文件），但建议非生产优先验证再替换。

---

## 四、其他

### SAM 3.1（Meta）

- **已装**：`sam3.1-multiplex-fp16.safetensors` 与 `sam3.1_multiplex_fp16.safetensors`（**文件名不同、疑似同权重重复**）。
- **最新**：SAM 3.1（2026-03-27）即最新——Object Multiplex 共享内存多目标跟踪，约 7× 推理加速、显存减半；未发现 SAM 4（[facebookresearch/sam3](https://github.com/facebookresearch/sam3)、[Meta 官方博客](https://ai.meta.com/blog/segment-anything-model-3/)、[Ultralytics 文档](https://docs.ultralytics.com/models/sam-3)）。
- **升级建议**：**已是最新**。建议核对两个文件的哈希，删除重复副本释放磁盘。

### 4x-UltraSharp

- 2023 年的 ESRGAN 系 4× 放大模型，多年无更新，**未找到官方依据**有新版。本机已装 SeedVR2 视频/图像放大插件（自带 3B/7B 下载式模型）。
- **升级建议**：**不升级**；新工作流优先用 SeedVR2，4x-UltraSharp 保留兼容旧工作流即可。

### ComfyUI 本体

- 最新正式版 **v0.38.0**（[GitHub Releases](https://github.com/comfy-org/ComfyUI/releases)）；本机 8188 报 0.38.2、8190 报 0.37.0，均已 ≥ 所有在装模型的版本要求。
- **建议**：8188（4485 节点、89+ 第三方包）**保持现状不动**——所有建议升级的模型（2512 fp8、Animate-2、LTX-2.5）要求的最低版本分别为：无额外要求 / ≥0.31 / ≥0.32，8188 均已满足，零升级必要。8190 可从 0.37.0 升 0.38.x 拿 Qwen 2.1 的 tiny VAE / union controlnet / 编译优化，节点少、风险低，可择期执行。

## 五、升级行动清单（按优先级）

1. **Wan2.2-Animate-2-14B**：下载 fp8/GGUF 权重（可直连 modelscope.cn），与一代并存；8188/8190 均无需动版本。
2. **LTX-2.5**：HF 接受 gated 许可后下载 distilled + GGUF Q4 + Gemma 4 12B encoder + 新 VAE；8188 直接可用（0.38.2 ≥ 0.32）。
3. **（可选）Qwen-Image-2512 fp8**：补齐底座让已有 2512 Lightning/Turbo LoRA 生效；Edit-2511 可顺带换 2509。
4. **（可选）FLUX.2 klein-4B**：Apache 2.0，8GB 级，体验 FLUX.2 管线。
5. **8190 ComfyUI 0.37.0 → 0.38.x**：择期，非必须。
6. **清理**：SAM 3.1 重复权重核对去重。
7. **观望项**：Wan 2.5/2.6/3.0（等权重）、Z-Image-Edit、Boogu Turbo-2K/Edit-Turbo、MiniMax H3 Max（等权重）、FLUX 3（等权重与许可）、Krea 后续版本。

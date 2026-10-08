# H3 多段续接 POC 报告（win147 ComfyUI）

> 日期：2026-10-06。执行环境：http://192.0.2.147:8188（RTX 5060 Ti 16GB）。
> 性质：本机能力探测，只报告观察事实，不构成「无限续接已支持」结论。
> 本目录文件：`driver.py`（提交/轮询/下载驱动）、`seam_qc.py`（接缝量化）、`runs/`（每段元数据 + 渲染后 API 工作流）、`seam_frames/`（接缝抽帧小图）。

## 一、结论摘要

**「上一段尾帧 → 下一段 first_frame（I2VA）」的续接机制在 147 上成立**，实测一条 4 段链（T2VA + 3×I2VA）加一条中间分叉链全部生成成功：

- **画面接缝**：4 个接缝的边界帧 SSIM 0.929~0.952、PSNR 32.0~33.9 dB，人物/服装/场景/姿态连续，无冻结帧、无重复帧、无硬跳变（见 seam_frames/ 抽帧与 §四指标表）。
- **音频接缝是主要短板**：每段开头 RMS 比上一段结尾低 17~26 dB（seg3 开头近静音 -92 dB），原生音频存在明显的「段首淡入」式响度断层。多段拼接成片必须做音频接缝处理（交叉淡化或响度归一），否则每个接缝都有可闻的音量塌陷。
- **中断恢复成立**：运行中 POST /interrupt 可即时中断（execution_interrupted，无产物）；从最近已完成段恢复只重跑中断段，已完成段产物 md5 不变。
- **中间分叉成立**：从 chainA/seg1 尾帧另起 chainB 生成成功，chainA 全部产物 md5 不变。
- **未验证「无限」**：本 POC 只验证到 4 段 + 1 分叉。长链的色彩/人脸漂移是否逐段累积，需要更长的链（8+ 段）才能下结论。

## 二、续接机制与工作流

复用 canvas-server 已 GPU 实测的 T8 节点配方（`canvas-server/workflows/video_h3_i2v.json` 同结构，不改产品代码，POC 侧自建 API 格式工作流）：

- 模型栈：`minimax_h3_fl2va_pruned_int8_convrot.safetensors`（UNet）+ `qwen3vl_32b_minimax_h3_nvfp4_awq`（CLIP）+ `minimax_h3_video_vae_fp16` + `minimax_h3_audio_vae_fp32`。
- 加速：`minimax_h3_turbo_v4_step600_ema` LoRA（strength 1.0）+ `MiniMaxH3DualClockSamplerT8`（steps=6, shift_video=12, shift_audio=3）+ SageAttention patch + UniBlockSwap + ReservedVRAMSetter。
- 规格：480×832 竖屏、73 帧（17n+5 网格，3.04s @24fps）、h264-mp4、原生立体声（`audio_mode=native`）。
- **seg0（基线）**：`MiniMaxH3AudioConditioningT8` task_type=`T2VA`，无 first_frame。
- **seg1+（续接）**：ffmpeg 从上一段 mp4 抽最后一帧（`-sseof -0.042 -frames:v 1`）→ POST /upload/image 上传到 147 → `LoadImage` 接 `first_frame`，task_type=`I2VA`。每段新 seed。
- 渲染后的完整 API 工作流存于 `runs/workflow_t2va_seg0.json` / `runs/workflow_i2va_seg1.json`（15/16 个节点，无 token 残留，提交前已校验）。
- 备选未测：147 另有原生 `MiniMaxH3AddGuide`（任意帧/音频锚定）与官方 `video_minimax_h3_i2v_continuation` 模板（subgraph，需展平），以及 `ref_videos` 参考视频输入（可带上段声轨做 Ref2VA 式续接，可能改善音频接缝）——均未在本次验证范围内。

## 三、链元数据（每段完整 JSON 在 runs/ 下，示例为 seg1）

```json
{
  "continuationChainId": "poc-chainA",
  "segmentIndex": 1,
  "parentArtifactId": "poc-chainA/seg0#e6786985-8523-4cfd-81b1-70348233f770",
  "seed": 910002,
  "output_prefix": "h3poc/chainA_seg1",
  "width": 480, "height": 832, "length": 73, "steps": 6,
  "first_frame": "h3poc_chainA_seg0_tail.png",
  "prompt": "integrated_multimodal_description: [Shot 1] A woman in her late twenties ... bends down and picks up a small seashell ...\n\noverall_soundscape: ocean waves ... non_diegetic_music: N/A.",
  "prompt_id": "7bd568e3-0e1d-434d-bee6-6cc01454bc1e",
  "submitted_at": "2026-10-06T06:25:00",
  "artifact": {"file": "chainA_seg1_00001-audio.mp4", "local_copy": "/tmp/h3-poc/videos/chainA_seg1.mp4", "has_audio": true},
  "elapsed_s": 698.4
}
```

| 段 | prompt_id | seed | 耗时 | 产物（147 output/ 下） | md5 |
|---|---|---|---|---|---|
| chainA seg0 (T2VA) | e6786985-8523-4cfd-81b1-70348233f770 | 910001 | 96.8s | h3poc/chainA_seg0_00001-audio.mp4 | 15f3f315760d6e5ff4f4eae93c5d11d0 |
| chainA seg1 (I2VA) | 7bd568e3-0e1d-434d-bee6-6cc01454bc1e | 910002 | 698.4s¹ | h3poc/chainA_seg1_00001-audio.mp4 | c2085f12892e97ddbeda00ce915a6469 |
| chainA seg2 (I2VA，恢复重跑) | be965c90-d084-4ff2-a968-5be3c0f53233 | 910003 | 99.1s | h3poc/chainA_seg2_00002-audio.mp4² | 6120341907336092f4f03cccbbfc1fd7 |
| chainA seg3 (I2VA) | 0215068a-06d8-40c5-a3c0-5439064be2da | 910004 | 111.6s | h3poc/chainA_seg3_00001-audio.mp4 | 2f2f63d8c92dc8b421be4d67d8a52d2b |
| chainB seg1 (分叉自 chainA/seg1) | b3e20f6e-99e5-4e6a-ba16-65b3461de8d5 | 920002 | 90.1s | h3poc/chainB_seg1_00001-audio.mp4 | （本机 /tmp/h3-poc/videos/chainB_seg1.mp4） |

¹ seg1 异常慢的根因见 §六失败模式（低内存换页），非续接本身开销。
² 注意文件名是 `_00002`：被中断的第一次尝试已占掉 `_00001` 计数。**产物定位不能假设编号恒为 00001**，应以 /history/{prompt_id} 的 outputs 字段为准。

视频本体：147 `output/h3poc/*.mp4`（每段 0.6~1.1 MB）；本机副本 `/tmp/h3-poc/videos/`（tmp 目录，会过期，权威副本在 147）。

## 四、接缝 QC 指标

方法（`seam_qc.py`）：边界帧 PSNR/SSIM（父段末帧 vs 子段首帧）、接缝 ±1s 窗口 freezedetect（阈值 -55dB/0.25s）、scdet 场景切变检测、父段末 0.5s vs 子段首 0.5s 的 RMS（astats）、接缝窗口 ebur128 积分响度与真峰值。原始 JSON 在 `seam_frames/*_seam.json`。

| 接缝 | 边界 SSIM | 边界 PSNR(dB) | 冻结帧 | 父尾 RMS(dB) | 子首 RMS(dB) | 音频落差(dB) | 接缝 LUFS / 峰值 |
|---|---|---|---|---|---|---|---|
| A0→A1 | 0.929 | 32.0 | 无 | -19.5 | -45.6 | **26.0** | -16.5 / -3.5 dBFS |
| A1→A2 | 0.949 | 33.0 | 无 | -24.0 | -40.6 | **16.6** | -21.9 / -9.8 dBFS |
| A2→A3 | 0.945 | 32.9 | 无 | -34.3 | -92.0 | **57.7（近静音）** | -31.9 / -17.8 dBFS |
| A1→B1（分叉） | 0.952 | 33.9 | 无 | -24.0 | -47.9 | 23.9 | -20.4 / -9.8 dBFS |

读数说明：
- SSIM 0.93~0.95 属于「同场景连续运动」区间（完全重复帧会 >0.99），目视抽帧（seam_frames/）确认人物、服装、光线、构图连续且无姿态跳变。
- scdet 未报出分数（窗口内无达到阈值的场景切变），与目视一致。
- **每个接缝音频都有 17dB 以上的响度塌陷**，呈「段首从低音量爬升」形态；seg3 段首接近静音。波形层面无爆音（真峰值均 ≤ -3.5 dBFS）。

### 人工复核清单（机器指标覆盖不到的项）

1. 目看每个接缝前后各 3 帧（`seam_frames/{label}_parent_tail_*.png` / `{label}_child_head_*.png`）：人脸是否同一人、发型/服装细节是否漂移、背景地平线是否跳位。
2. 播放接缝 ±1s 窗口视频（`seam_frames/{label}_seam_window.mp4`）：运动方向/速度是否接续自然，有无「动作倒带」或姿态瞬移。
3. 戴耳机听接缝窗口：海浪声场是否中断、段首淡入是否可接受，对白类内容（本 POC 无台词）需另测语音接续。
4. 长链（>4 段）累积漂移：本 POC 未覆盖，建议 M3.5 前补一条 8 段链只做人眼 + SSIM 趋势复核。
5. 分叉段与主链的同帧起点是否「同一人同一瞬间」（A1→B1 抽帧已过目，成立）。

## 五、中断恢复与分叉观察

- **中断**：seg2 首次提交（6e0ecc27-ed41-49fb-b018-0b1e94fe4e90）运行 75s 时 POST /interrupt → 1~2s 内 history 出现 `execution_interrupted`，`completed=false`，无产物输出（VHS 未执行到写出）。
- **恢复**：以同一份段元数据（同 seed、同 first_frame）重新提交即完成，耗时 99.1s；恢复过程不触碰 seg0/seg1（恢复前后 md5 逐一比对一致）。「不重复生成已完成段」在 POC 层是靠**驱动侧按 segmentIndex 跳过已有产物的段**实现的，ComfyUI 本身无此概念，M3.5 需在流水线层落这个跳过逻辑。
- **分叉**：chainB/seg1 以 chainA/seg1 的尾帧为 first_frame、不同 prompt/seed 生成成功；生成前后 chainA 四段产物 md5 全部不变。分叉只需记录「parentArtifactId 指向他链的段」，无额外机制要求。
- **副作用**：被中断尝试占用了输出文件名计数器（chainA_seg2 实际落盘为 `_00002`）。若以文件名推断产物存在性会误判，必须以 prompt_id 的 history 为准。

## 六、失败模式与资源记录

| 现象 | 观察 | 处置/建议 |
|---|---|---|
| 低内存急剧拖慢 | seg1 运行期间 ram_free 跌至 2.7GB（<4GB 阈值），耗时 698s，是同规格段的 7 倍；未 OOM、未卡死，最终成功 | 提交前 POST /free + 确认 ram_free≥4GB（本次恢复后 seg2/seg3/B1 均 90~112s）；长链跑批必须每段前做 preflight 清理 |
| 显存常驻 | 任务运行中 torch_vram_free ≈0.9GB（模型占满属预期），全程无 VBAR OOM | 480×832×73帧×6步在 16GB 卡是稳档 |
| 他人任务插排 | POC 期间队列 2 次出现其他用户/agent 的任务（H3 与 Qwen 图像），等待 6~11 分钟 | 串行纪律有效：只观察等待，未并行提交、未清理他人任务 |
| 文件名计数器漂移 | 中断重跑后产物为 _00002 | 产物定位只信 history.outputs，不信文件名猜测 |
| 段首音频近静音 | 见 §四，4/4 接缝复现 | M3.5 拼接层必须处理音频接缝 |

## 七、对 M3.5 契约字段的落地建议

1. **continuationChainId / segmentIndex / parentArtifactId**：POC 验证够用。`parentArtifactId` 建议格式化为 `<chainId>/seg<N>#<comfyPromptId>`（本 POC 用法），既指段又指具体一次生成，重跑同段时不歧义。
2. **continuation.seam 建议填充的量化子字段**：`boundarySsim`、`boundaryPsnrDb`、`freezeDetected`(bool)、`parentTailRmsDb`、`childHeadRmsDb`、`audioSeamDeltaDb`、`seamIntegratedLufs`、`seamTruePeakDbfs` + `reviewStatus`(pending/approved)。**门槛建议（基于本次 4 接缝样本）**：SSIM<0.85 或 freezeDetected=true 或 audioSeamDeltaDb>12dB 时标记需人工复核；音频落差在当前生成参数下是常态，不应作为阻断项，只作为拼接后处理依据。
3. **音频接缝必须在拼接层处理**：交叉淡化 ≥100ms 或按接缝 LUFS 做响度归一；否则每接缝都有可闻塌陷。若要从源头改善，可另做一轮 POC 验证 `ref_videos`（带上段声轨）或 `MiniMaxH3AddGuide` 的音频锚定。
4. **恢复语义**：流水线层按 (chainId, segmentIndex) 判定产物已存在即跳过；提交前 preflight（/free + ram_free≥4GB）是 Cheap 且必要的；中断重跑后产物文件名可能递增，产物登记必须以 history.outputs 返回的文件名为准。
5. **尾帧提取**：ffmpeg `-sseof -1/fps` 抽最后一帧 PNG 上传即可，无需在 ComfyUI 内做视频解码；建议把「抽尾帧+上传」封装为流水线内部步骤，用户无感（符合转写内部化约束）。
6. **不宜宣称的能力**：>4 段长链的漂移累积、台词/口型的跨段接续、Ref2VA 续接路线，均未验证，M3.5 设计文档中应列为待验证项。

## 八、复现方式

```bash
cd research/win147-comfyui/h3-continuation-poc
python3 driver.py wait-idle                                  # 等 147 队列空
python3 driver.py submit runs/poc-chainA_seg0.json           # 基线段
python3 driver.py download <prompt_id> /tmp/seg0.mp4
ffmpeg -y -sseof -0.042 -i /tmp/seg0.mp4 -frames:v 1 tail.png
python3 driver.py upload tail.png h3poc_seg0_tail.png        # 下一段 first_frame
python3 seam_qc.py parent.mp4 child.mp4 out_dir label        # 接缝 QC
```

GPU 队列状态：本报告完成时 `queue_running=[] queue_pending=[]`，POC 任务全部结束，无遗留。

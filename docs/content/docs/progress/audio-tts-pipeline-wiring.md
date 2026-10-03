# TTS 接线设计（audio_qwen3_tts → pipeline）

> 状态：**设计稿，尚未接线**。本次只交付「TTS 能出音 + 音色可按角色固定」，
> `pipeline.js` / `audio.js` / `audio-track.js` / `gates.js` / `projects.js` / `index.js`
> **一行未改**（见边界说明）。本文说明后续怎么挂、挂在哪、要改哪些文件。
>
> 本次为「让新模板能过现有测试」另有两处**最小**改动：
> `src/providers/comfy.js` 的 `TITLES` 增 `audio_qwen3_tts: "Qwen3-TTS 语音合成"`
> （`comfy.test.mjs` 强制「新增模板必须登记中文标题」）、
> `test/tool-adapter.test.mjs` 的全模板数断言改为与目录 `*.json` 数对齐。
>
> 一手事实来源：147 `GET /object_info`（Qwen3TTS 节点组真实入参）、
> `canvas-server/workflows/audio_qwen3_tts.json`（本次新增并实跑通过）、
> `src/audio.js` / `src/audio-track.js`（已交付的纯逻辑层）、
> `src/delivery.js` `buildAssemblyPlan/buildConcatArgs`、`src/pipeline.js` `executeAssemble`、
> `src/gates.js` `GATE_STAGES`、`src/index.js` 模板注册与 `impactView`。

---

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| TTS 挂在哪？ | **新增一个生成型阶段 `audio`，插在 `keyframe` 与 `assembly` 之间**；不要塞进 assembly |
| 为什么不能挂 assembly 后面？ | `delivery.buildConcatArgs` 的混音发生在**拼接时**（`-i audioPaths` + `amix`），音频必须**先于** assembly 就绪 |
| 为什么不做成 assembly 的子步骤？ | assembly 已经背了「拼接 + 转场 + 字幕 + 封面」，再塞逐条 TTS 任务会让阶段产物语义混乱、重试粒度变粗；独立阶段可复用 `GENERATIVE_STAGES` 现成的「建 job → 回写产物」机制 |
| 音色怎么固定？ | `VoiceProfile.speaker` → 模板 `{{SPEAKER}}`（Qwen3-TTS 命名音色枚举）；`VoiceProfile.design` → `{{INSTRUCT}}`。**同一角色跨镜头喂同一对 (speaker, instruct)**，音色即固定 |
| Cue 怎么变入参？ | 逐条 AudioCue 建一个 `kind:"audio"` 的 job，`params` 由 Cue + VoiceProfile 映射（见 §3 映射表） |
| SEED 的作用 | 只为复现/追踪；Qwen3-TTS `CustomVoice` 路径是确定性的（同文本+音色+指令出同音色），seed 不改变音色 |

---

## 1. 现状（接线前的一手盘点）

### 1.1 已有资产

- **模板**：`workflows/audio_qwen3_tts.json`（本次新增）
  `TDQwen3TTSModelLoader → TDQwen3TTSCustomVoice → SaveAudio`
  占位符：`{{TEXT}} {{SPEAKER}} {{INSTRUCT}} {{LANGUAGE}} {{DEVICE}} {{SEED}} {{OUTPUT_PREFIX}}`
- **纯逻辑层**（已交付，零 IO、可单测）：
  - `src/audio.js`：`buildTtsRequest` / `cuesFromShots` / `validateCues` / `buildMixInput`
  - `src/audio-track.js`：`projectVoiceProfiles` / `projectAudioCues` / `alignmentReport` / `applyAudioProjection`
- **投递层**：`delivery.js` 的 `buildAssemblyPlan({ audio })` → `plan.audio[]` →
  `buildConcatArgs` 对每条 `audioPaths` 加 `-i`，再 `aresample=44100` → `amix=inputs=N:duration=longest:normalize=0` → `-c:a aac 192k`。
- **执行入口**：`pipeline.js` `executeAssemble()` 把 `options.audio` 透传给 `assemble(...)`；`options.audio` 是**外部注入的**。

### 1.2 关键缺口（本次不改，接线时改）

1. `audio.js` / `audio-track.js` **目前没有任何调用方**——`grep -rn "audio-track\|buildMixInput\|buildTtsRequest" src/` 在 `src/audio*.js` 之外零命中。纯逻辑已就位，缺的是编排接线。
2. `generate.js` 的 `ASSET_TOKENS` 不含音频素材槽；`resolveAsset` 只处理图像。TTS 不需要上传素材，本模板天然满足。
3. `index.js` 启动时把 `workflows/*.json` 全量登记为 Tool，能力由**文件名前缀**推断：
   `familyOf("audio_qwen3_tts")` → 都不是 `upscale`/`video`/`img` → 落到 **`edit`** → 登记为 `GPU_IMAGE`。
   → 语义不对（音频任务不该占 GPU_IMAGE 通道），且 `registry.canRun` 需要它被登记。
4. `/api/generate/*` 只有 `image` / `video` 两条路由，没有 `audio`。
5. `buildConcatArgs` **忽略每条音频的 `startSec/delayMs`**：所有音频都从 0 秒叠上去。要做「第 3 镜才说话」必须补 `adelay`（见 §5）。

---

## 2. 接线方案：新增 `audio` 生成型阶段

### 2.1 阶段位置

```
plan → script → storyboard → design → keyframe → [ audio ] → assembly → post
                                                     ▲
                                            新增，逐条 AudioCue 出音
```

- `requires: ["storyboard", "design"]`（`audio-track.js` 需要角色音色 + 分镜台词；
  与 `keyframe` 同上游，可并行，互不依赖）
- 产物：每条对白 Cue 一个音频 artifact，回填 `AudioCue.artifactId / artifactUrl`；
  并投影 `project.voiceProfiles` / `project.audioCues`（`applyAudioProjection`）
- 出阶段前跑 `alignmentReport({cues, shots, voiceProfiles})`：`block > 0` 即阶段 `partial`，
  **不进入 assembly**（沿用现有「上游 partial 不放行」的门禁语义）

### 2.2 为什么是「生成型阶段」而不是普通阶段

`pipeline.js` 已有现成机制，`audio` 直接复用即可，不需要新造轮子：

```js
// pipeline.js:16
const GENERATIVE_STAGES = new Set(["keyframe", "assembly"]);          // ← 加 "audio"
const STAGE_TEMPLATE_FAMILY = { keyframe: "image", assembly: "video" }; // ← 加 audio: "audio"
const GENERATIVE_STAGE_ASSET_ROLE = { keyframe: ASSET_ROLE.KEYFRAME, assembly: ASSET_ROLE.CLIP };
```

`ASSET_ROLE` 目前没有音频角色。建议**新增 `ASSET_ROLE.VOICE = "voice"`**（`contracts.js`），
或暂用 `CLIP` 兜底——**推荐新增**，否则 `impact.js` 会把音频当成片段参与重跑分析。

### 2.3 为什么不挂在 assembly 里 / assembly 后

- **assembly 后不行**：`buildConcatArgs` 的混音在拼接时完成，组装完再贴音频等于二次封装视频。
- **塞进 assembly 的子步骤不行**：`executeAssemble` 是同步编排 `assemble()`；逐条 TTS 是**异步 job**，
  job 的生命周期回写（`bindJobs` 的 `meta:{runId,stageId,itemId}`）需要 `stageId` 有独立定义，
  混用会让「assembly 的产物到底是片段还是音频」讲不清，且重试粒度从「单条 Cue」退化到「整段」。

---

## 3. AudioCue / VoiceProfile → 模板入参映射

模板入参（`renderTemplate` 的 params 键）：

| 模板占位符 | 取值来源 | 说明 |
| --- | --- | --- |
| `{{TEXT}}` | `AudioCue.text` | 台词正文（`cuesFromShots` 已按句切分） |
| `{{SPEAKER}}` | `VoiceProfile.speaker` | **音色锚点**：Qwen3-TTS 命名音色枚举 `Aiden/Dylan/Eric/Ono_anna/Ryan/Serena/Sohee/Uncle_fu/Vivian` |
| `{{INSTRUCT}}` | `VoiceProfile.design`（`audio-track.js` 的 `design` 超集字段） | 音色设计提示，如「中年男性，沙哑低沉，语速慢」 |
| `{{LANGUAGE}}` | `VoiceProfile.language`，`zh-CN` → `"Chinese"` | 需做 `zh-CN → Chinese` 的 BCP-47 → Qwen 枚举映射 |
| `{{DEVICE}}` | 配置项（默认 `"cuda"`） | 16GB 卡与视频作业抢显存时可切 `"cpu"`（注意 CPU 需要 ~4GB 空闲内存） |
| `{{SEED}}` | `stableSeed(runId, cue.shotId, vp.version)`（`reference-lock.js`） | 固定可复现；`CustomVoice` 路径下不影响音色 |
| `{{OUTPUT_PREFIX}}` | 由 `generate.js` 自动补 `canvas/<jobName>` | 建议在阶段编排里显式传 `canvas/<runId>/<cueId>` 便于归集 |

映射伪码（接线时落地在 pipeline 的 audio 阶段）：

```js
const profileById = new Map(profiles.map((p) => [p.id, p]));
for (const cue of cues.filter((c) => DIALOGUE_TYPES.has(c.type))) {
    const vp = profileById.get(cue.voiceProfileId);           // validateCues 已保证存在
    jobs.enqueue({
        id, kind: "audio", template: "audio_qwen3_tts", name: cue.id,
        params: {
            TEXT: cue.text,
            SPEAKER: vp.speaker,                                // ← 跨镜头固定
            INSTRUCT: vp.design,                                // ← 跨镜头固定
            LANGUAGE: toQwenLanguage(vp.language),              // zh-CN → Chinese
            DEVICE: config.audio?.device ?? "cuda",
            SEED: stableSeed(run.id, cue.shotId, vp.version),
            OUTPUT_PREFIX: `canvas/${run.id}/${cue.id}`,
        },
        meta: { runId: run.id, stageId: "audio", itemId: cue.id },
    }, runJob);
}
```

`kind:"audio"` 需要一个 `runJob`——直接用 `generate.js` 的 `createLocalRunner().runJob` 即可，
它不关心 kind，只要模板 JSON + params 齐全。

### 3.1 「音色对得上」的保证链

1. **锚点唯一**：`projectVoiceProfiles` 从 `script.characters[].voice` 归一，**每角色一条 VoiceProfile**（`vp_<characterId>`）。
2. **跨镜头复用**：`projectAudioCues` 按 `voiceProfileId` 把同角色的所有 Cue 指向**同一条** VoiceProfile。
3. **同参同音色**：`renderTemplate` 把同一 `(SPEAKER, INSTRUCT)` 原样写进每个 job → Qwen3-TTS 同音色输出。
4. **缺音色即阻断**：`validateCues` 对「对白 Cue 未挂 VoiceProfile」判 `block`，stage `partial`，不会静默随机。

---

## 4. assembly 侧怎么用这批音频产物

`executeAssemble` 已经把 `options.audio` 透传给 `assemble`，接线只需**在调用方组装 options.audio**：

```js
const { audio } = buildMixInput({
    clips,                                   // assembly 的 clips
    cues: project.audioCues,                 // 已回填 artifactId
    tracks: [{ id: "dialogue", type: "dialogue", gainDb: 0, muted: false }],
});
// options.audio = audio  → 每条 { ref, cueId, shotId, startSec, delayMs, gainDb }
```

`buildMixInput` 输出与 `delivery` 的 `plan.audio[].ref` **同构**（`audio.js` 注释即为此设计），
所以 `resolveMediaPath(config, item.ref)` 能直接解析 `/api/artifacts/<jobId>/xxx.flac`。

---

## 5. 已知缺口与对应改动（接线时的文件清单）

| # | 文件 | 改动 | 风险 |
| --- | --- | --- | --- |
| 1 | `src/contracts.js` | 新增 `ASSET_ROLE.VOICE = "voice"` | 低（追加枚举） |
| 2 | `src/pipeline.js` | `GENERATIVE_STAGES` 加 `"audio"`；`STAGE_TEMPLATE_FAMILY` 加 `audio:"audio"`；`GENERATIVE_STAGE_ASSET_ROLE` 加 `audio: ASSET_ROLE.VOICE`；新增 `executeAudio` 编排（建 job + 回写 Cue.artifactId）+ `runStage` 分支 | **高**（热点文件，需回归 427+ 测试） |
| 3 | `src/gates.js` | `GATE_STAGES` 在 `keyframe` 与 `assembly` 之间插 `{ id:"audio", title:"配音", requires:["storyboard","design"] }`；`hasOutput` 加 `case "audio"`（判 `project.audioCues` 是否都有 artifactId） | 中（会改变 assembly 的 `requires`，影响 `deriveGates` 输出，需同步前端门禁展示） |
| 4 | `src/registry.js` 或 `src/index.js` | 模板能力前缀：`familyOf` 增加 `audio` 族，避免 audio 模板落成 `edit/GPU_IMAGE`；`RESOURCE_CLASS` 可复用 `GPU_IMAGE` 或新增 `GPU_AUDIO` | 低—中（`registry.js` 是纯模块，`index.js` 是热点） |
| 5 | `src/index.js` | 新增 `POST /api/generate/audio` 路由（与 image/video 同构，`submitGeneration("audio", body)`） | 中（热点） |
| 6 | `src/delivery.js` | `buildConcatArgs` 支持逐条 `adelay`：`[N:a]adelay=<ms>\|<ms>,aresample=44100[aN]`，让 `buildMixInput` 的 `delayMs` 真正生效 | 中（改 ffmpeg 滤镜图；需补单测覆盖 delay=0 与非 0） |
| 7 | `src/index.js` | `impactView` 已把 `project.audioCues → cues`；需在 `impact.js` 让 `changed.type==="voice"` 能把相关 Cue 判 stale | 低 |
| 8 | 配置 | `config.json` 增 `audio: { template, device, model }`（`config.js` DEFAULTS + `.example.json`） | 低 |
| 9 | 前端 | 画布/工作台增「音频」族入口与试听（若需要手工触发） | 低（本次不涉及） |

**不做的事**：不动 `audio.js` / `audio-track.js`（纯逻辑已够用，映射写在编排层）；
不改已有 workflows 模板。

---

## 6. 验收口径（接线后应满足）

1. `node --test test/*.test.mjs` 全绿，基线不低于本次的 427 + 新增用例数。
2. 真实 run 跑完 `audio` 阶段后：`project.audioCues[].artifactId` 全部非空；
   `alignmentReport().block === 0`。
3. 同角色跨镜头产出的音频，`speaker`/`instruct` 完全相同（可在 job.params 里比对），
   主观听感一致（产品负责人「音色对得上」的判据）。
4. assembly 成片里对白可闻且与镜头时间轴对齐（依赖 §5-6 的 `adelay`）。

---

## 7. 运行时风险清单（本次实跑观察到）

- **显存**：Qwen3-TTS 1.7B（bf16）权重约 3.4GB。147 是单张 16GB 卡、`--disable-smart-memory`
  且正跑 H3 视频作业（实测 `torch_vram_free` 只剩 ~5.7GB）。TTS 与视频**串行排队**（ComfyUI 单 worker），
  实测可共存；但若视频作业把显存吃满，把 `{{DEVICE}}` 切 `"cpu"`——注意 147 空闲内存实测仅 ~1GB，
  CPU 加载 1.7B 会失败，**切 CPU 前先确认内存**。
- **模型下载**：`auto_download:true` + `download_source:"ModelScope"`，首次运行下载 1.7B（数分钟起）。
  ComfyUI 按「节点类 + 输入」缓存模型，同一 loader 配置的**后续 job 不重复下载/加载**。
- **不要中断视频作业**：147 上正在跑的 H3 片段是产品负责人的验收物，TTS 只排队不抢占。
- **format**：模板用 `SaveAudio` → **FLAC**（无损）；`delivery` 侧统一 `aac 192k` 输出，
  无需中间 mp3。若要省磁盘可换 `SaveAudioMP3`（`quality` 枚举 `V0/128k/320k`）。

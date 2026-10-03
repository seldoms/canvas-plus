# win147 ComfyUI 模型能力与提示词规范调研

> 调研日期：2026-10-03。本目录是「视频提示词强化 skill / 提示词自动改写策略层」的规则来源。

## 这个调研解决什么问题

短剧生产链路里，用户和前序流程只负责产出镜头分镜内容（剧情、画面描述）。选定模型、点提交之后，后端按**选中模型的提示词标准**自动完成分析与增强，用户无感：

1. **语言适配** —— 该模型适合中文还是英文，需不需要先翻译（如 FLUX/Krea2 仅英文有官方依据，Qwen/Z-Image/Boogu/Wan 双语）。
2. **提示词策略** —— 强提示词前置、负面提示词写不写（蒸馏 turbo 模型 cfg=1 时负面无效；Wan 系必须写官方中文负面串）、长度上限（Qwen 512 token 截断丢尾）。
3. **内容细节强化** —— 画面里有标语、指示牌、海报文字时，按模型规则强化（Qwen 系双引号逐字包裹 + magic suffix；Krea2/FLUX 只有引号包裹有官方依据）。
4. **参数与工作流** —— 按速度档/质量档自动选择 steps/cfg/sampler，套用官方工作流模板提交。

## 文件结构

| 文件 | 内容 | 谁消费 |
|---|---|---|
| `model-registry.md` | **主登记表**：场景→选型表、每模型改写规则/参数双档/官方工作流/版本状态/坑 | 人 + skill 作者 |
| `registry.json` | 机器可读规则表（13 个模型的 prompt 规则/限制/参数档），策略层直接 import | 策略层代码 |
| `sources/inventory-api.md` | 147 实装资产盘点（API 实测：模型文件、节点、双实例差异、337 个官方模板清单） | 运维 |
| `sources/qwen-family.md` | Qwen-Image / Edit-2509 / **2.1（多图 10 张、原生 2K、限制）** 提示词规范 | 调研依据 |
| `sources/image-models.md` | Krea2 / FLUX.1-dev / Z-Image / Boogu 提示词规范 | 调研依据 |
| `sources/video-models.md` | Wan2.1 / Wan2.2-Animate / MiniMax H3 / SCAIL-2 / 放大 提示词规范 | 调研依据 |
| `sources/version-upgrades.md` | 各家族最新版本与升级建议（Wan2.2-Animate-2、LTX-2.5 建议升级；FLUX.2 16G 跑不动） | 运维 |
| `sources/optimization.md` | 速度/质量优化手段 + **官方提示词改写器资产清单**（策略层可直接复用的系统提示词） | 策略层 |
| `workflows/*.json` | 16 份官方/Comfy-Org demo 工作流（含采样参数实测值），提交任务的模板底稿 | 策略层 |

## 接入要点（给策略层开发者）

- **查规则**：按 `registry.json` 的 `models.<key>.prompt` 执行改写：先判断 `input_language` 决定是否翻译，再按 `negative` 策略处理负面词，再按 `text_in_image` 规则强化画面内文字，最后套 `presets.speed|quality` 参数。
- **改写器不必自研**：Qwen/Wan/Boogu/SCAIL-2 官方都发布了改写器系统提示词（`sources/optimization.md` 第 3 节，原文已抓取），策略层应优先复用这些官方资产，只叠加项目自己的分镜规范。
- **合规注意**：Boogu 官方改写器第 14 条是「安全改写」条款，与本项目「风险只提示、不改稿」规范冲突，接入时必须显式剔除（见 `model-registry.md` 第四节）。
- **多图与分辨率硬限制**：Qwen-Image 2.1 官方保证 10 张参考图（节点 16 槽）、原生 2K 七档比例、超 2K 掉 prompt adherence；Edit-2509 官方甜蜜点 1~3 张。这些是选型时的硬约束，已写进 `limits` 字段。
- **提交前检查**：client_id 与 filename_prefix 必须全 ASCII；提交前 GET `/queue` 确认队列；含 subgraph 的官方模板需展平后才能 POST /prompt（见 `sources/video-models.md`）。

## 维护

- 模型/版本信息以 `sources/version-upgrades.md` 为准，建议每次给 147 加装模型后回写 `sources/inventory-api.md` 与两份登记表。
- 147 实战踩坑记录仍在技能库 `comfyui-t2i-bench` / `comfyui-server-ops` 的 references 中，本目录引用而非复制。

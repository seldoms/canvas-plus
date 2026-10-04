> ⚠️ **时点快照，内容已过期（2026-10-05 独立复核）**：本文写于 2026-10-02/03，其中多条结论已被后续代码超越（模板数与测试基线、`delivery.js` 成片执行体、skill 库接线、`runIds` 回填、流水线段数 等）。**引用前请以 `HANDOFF.md` 的「2026-10-05 独立审查结论」、`development-plan.md` §11.1 的修正表、以及 live `GET /api/providers` / `GET /api/pipeline/stages` 为准**；本文只作演变记录保留。

# 本地化能力资产盘点（CTO 视角）

> 内部研究文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 盘点日期：2026-10-02。口径：**每条结论都在代码或真机实测中核实过**，附 `file:line` 或任务 id；
> 不采信文档自述。分级：【实测】跑过并有产物/日志、【核实】读过代码确认、【推断】未验证。
>
> 姊妹文档：`gateway-api-benchmark.md`（对外对标 LiblibAI 的能力差距）、
> `local-capability-audit.md`（本地 ComfyUI 实测数据）。本文是**对内**的资产盘点。

## 0. 结论速览

资产结构健康，但护城河有一个缺口：

- **A 类（本地化结构性优势）扎实且已验证**，与「本地优先」路线互为因果。
- **B 类（可外提复用的工程资产）质量高**，其中 B1、B2 具备独立开源价值。
- **D4（`assembly` 缺拼接执行体）让「端到端生产管线」这条唯一该守的第一护城河名不副实** —— 五段流水线名义五段，末段产物永远停在 `status:"queued"`。
- 本轮已修掉三个会静默吃掉能力的缺陷（探测超时误用、`family`/`kind` 不一致、一键接入跳过模板），并收紧了密钥文件权限。

投资顺序见 §5。

---

## A 类：结构性护城河 —— 云平台不会做或做不到

| # | 能力 | 证据 | 为什么云平台做不到 |
| --- | --- | --- | --- |
| A1 | **素材寻址 4 通道，阶段间不依赖公网 URL** | 【核实】`generate.js:28-47` | http(s) 下载 / `/api/artifacts/` 相对路径**直读本地文件** / `comfy:` 与裸名透传 / 本机任意路径。对标平台只接受「可公网访问的完整 URL」或走 OSS+STS。代码注释写明「避免依赖 publicUrl 配绝对地址」——**流水线阶段间回填天然可移植**，换机器、换端口、离线都不坏。`safeJoin`（`files.js:16-21`）挡住 `../` 越权 |
| A2 | **产物稳定不过期，溯源到 job** | 【核实】`/api/artifacts/:jobId/:filename` | 对标平台产物 URL **7 天时效**。短剧生产要跨周反复重剪，这是硬需求不是便利 |
| A3 | **取消是一等能力，且真打断 GPU** | 【核实】`index.js:237`、`generate.js:106`、`jobs.js` AbortController | 对标平台文档里**没有取消接口**，官方 demo 是「提交→sleep→轮询」。单卡串行、视频 8~40 分钟的环境下，**取消 = 释放唯一产能**，属产能治理而非体验功能 |
| A4 | **把硬件约束显式建模进契约** | 【核实】`jobs.js:119`、`concurrency:1` | 对标平台把「并发 5」写进契约；我们必须把「**不能**并发」写进契约。重启后悬挂中间态收敛为明确 `error`，不会永远「运行中」 |
| A5 | **RGBA 透明直出** | 【实测】`image-muqquoup-elupj` 透明 60.3%、四角 alpha `[1,1,1,0]`；对照组（不包 RGBA 话术）透明 0% | Qwen-Image 2.1 能力，LibTV 与 LiblibAI 都没有。对无限画布是杀手级：贴纸、图标、图层素材直接可用，不需要后处理抠图 |
| A6 | 零边际成本 + 私有资产不出机器 | 路线选择 | A1~A5 存在的前提。角色 LoRA、素材、成片全在本地盘 |

## B 类：可直接外提复用的工程资产

| # | 资产 | 证据 | 复用价值 |
| --- | --- | --- | --- |
| B1 | **ComfyUI 模板 token 契约三件套**：`extractTokens` / `renderTemplate` / `disableEmptyLoras`（+ 本轮新增 `disableEmptyImageRefs`） | 【核实】`providers/comfy.js`；【实测】坑 #1 回归测试 | ⭐ **全仓最高**。① `{{TOKEN}}` 白名单 + 缺参早失败（错误列出全部缺失名）；② `toNumberTree` **只转 dict 直接字符串值、绝不转数组内字符串**（`["10",0]` 是节点引用，数字化会让 ComfyUI 抛 `KeyError: prompt_outputs_failed_validation`）；③ LoRA 缺省时自动摘节点**并把下游重连到上游**，调用方永不感知 LoRA；`LoraLoader` 双输出无法安全重连时**抛中文错误而不是静默出错图**；④ 参考图槽位同机制，**一个模板服务 1~10 张参考图**。任何要把 ComfyUI 暴露成 API 的项目都会撞上这几个坑 |
| B2 | **中文长文切块纯函数** | 【核实】`chunk-novel.js` + 7 个单测 | ⭐ 可独立发包。优先级：【文件名】标记 → 中文章节标题（`第N章/节/回/卷/部`）→ 定长窗口（段落边界 > 换行 > 硬切）；超阈值二次切带 `（i/N）`；相邻小节贪心合并；每块保留来源 label。配合 map-reduce 后**产物契约与单次调用完全同构** —— 这个「分块但对下游透明」的性质才是关键设计 |
| B3 | **零依赖 Node ESM 网关骨架** | 【核实】`http.js` + `files.js` + SPA fallback | 无运行时依赖，`node>=20` 直接跑，部署 = 拷目录 + systemd，前后端同体单端口 |
| B4 | **插件节点 SDK 的能力面设计** | 【核实】`plugin-node-context.ts:8-32` | host 注入：图遍历（`getUpstream`/`getDownstream`/`getConnections`）、变更（`updateNode`/`applyOps`）、事件总线、**AI（`ai: host.ai`，插件零密钥管理）**、面板、按插件命名空间隔离的 `storage`、主题对象而非硬编码色值。`storyboard-studio` 是第一个真实用户，已证明够用 |
| B5 | **Agent 画布 op 批量语义** | 【核实】`lib/canvas/canvas-agent-ops.ts` | 8 个 op（`add_node`/`update_node`/`delete_node`/`connect_nodes`/`delete_connections`/`set_viewport`/`select_nodes`/`run_generation`），`applyCanvasAgentOps(snapshot, ops[])` 本身即批量 —— **等价于对标产品的 `nodes_connections_batch`，这块不落后** |
| B6 | **部署双通道** | 【核实】`scripts/deploy.sh` / `sync-remote.sh:31-36` | 「可带未提交改动调试」与「要求工作区干净发布」分离，排除 `node_modules/dist/data/config.json` → **永不覆盖远端数据与配置** |

## C 类：设计纪律，值得在项目内推广

| # | 模式 | 证据 | 推广到 |
| --- | --- | --- | --- |
| C1 | **契约回归测试用真实模板**，不用 mock | 【核实】`pipeline.test.mjs` 契约回归 | 拿 `workflows/*.json` 真渲染编排器产出的参数、断言零缺失 token。这条纪律直接防住了坑 #11。任何「一端产参数、另一端消费参数」的边界都该有 |
| C2 | **不采信模型编造的元数据** | 【核实】`pipeline.js` `attachGeneration` | 模型只写提示词与清单；`template`/`jobId`/`artifactUrl`/`status` 全由编排器回填。测试里专门让模型填「假的」验证被覆盖。**LLM 编排的核心安全模式** |
| C3 | **未知占位原样保留** | 【核实】`pipeline.js:56-62` | `{{a.b}}` 找不到值返回原样而非空串 → 写错的 key 在产物里显形，不静默变空洞 |
| C4 | **纯函数 + 依赖注入的可测性** | 【核实】`createPipeline({...,runJob})` | 没有 `runJob` 时生成型阶段只标 `queued`、**不伪造产物**。整条流水线可在无 GPU 环境单测（68/68 全绿就是这么来的） |
| C5 | **密钥临时透传不落盘** | 【核实】`pipeline.js` `runStage` 的 `provider`；【实测】`GET /api/llm/providers` 只回 `hasKey` | 只校验形状、仅本次调用生效、绝不写入 `run`/`options` → 浏览器侧 SK 不进明文且会被同步的 `data/runs/*/run.json` |
| C6 | **文档三件套 + HANDOFF 坑位库** | CHANGELOG / pending-test / todo / HANDOFF | 本轮能 30 秒接上一个被限额中断的会话，全靠这套。研究类 `.md` 放同目录但**有意不登记进 `meta.json`** |
| C7 | **探活/列资源类接口不复用长任务超时，不串行探测第三方** | 【实测】本轮修复，见 D7 | 新增：`llm.probeTimeoutMs`（8s）与 `timeoutMs`（600s）分离 + 并行探测。**任何要遍历外部依赖的接口都适用** |

## D 类：看着像资产、其实是债

| # | 问题 | 证据 | 状态 |
| --- | --- | --- | --- |
| D4 | **`assembly` 没有执行体**，产物永远停在 `status:"queued"` | 【核实】`pipeline.js:358-370`，全仓零 ffmpeg 引用；本机 ffmpeg 8.0.1 在盘 | 🔴 **未修**。让 A 类护城河名不副实 |
| D1 | `comfy.maxQueue: 16` **死配置** | 【核实】`config.js:28` 有，`src/` 从未读取 | 🟡 未修。契约里承诺做不到的事 —— 正是我们批评对标产品 `percentCompleted`「暂未实现」的同一个毛病 |
| D2 | job 的 `progress` **只填 0/0**，未接 ComfyUI WebSocket | 【核实】`jobs.js` | 🟡 未修。同 D1 |
| D6 | skill 库已导入**未接线** | 【核实】`skills/libraries/` | 🟡 未修。资产未变现：两个库躺着，五个阶段还在用骨架期默认提示词 |
| D5 | 画布 4 套 hover 写法并存 | 【核实】主写法 `hover:bg-black/5 dark:hover:bg-white/10` 21 处/9 文件（19 处正确配对），另有 `hover:bg-black/10` 3 处、`theme.toolbar.itemHover` 4 处、`theme.toolbar.activeBg` 13 处；`canvas-create-menus.tsx:38` 漏配对 | 🟢 未修。轻度。AGENTS.md 用一条规则在补令牌缺失（缺通用 `overlay/overlayHover/overlayActive` 三阶） |
| D3 | 网关零鉴权 + `0.0.0.0` + CORS `*` + 明文付费 Key | 【实测】 | 🟡 **最小档已修**：`data/llm-providers.json` 收紧到 `0600`（原 `0644`），非回环绑定时打启动告警。**风险已降级**：公网入口 `canvas.wbsyb.cloud:16601` 实测有 **HTTP Basic Auth**（`www-authenticate: Basic realm="Authorization Required"`），不是裸奔。剩余：局域网内 `0.0.0.0:8788` 无鉴权。**正经档未做** —— `auth.mode: none\|bearer\|hmac` 的设计已写在 `gateway-api-benchmark.md` §6.6 |
| D7 | ~~`/api/health` 被死渠道挂住~~ | 【实测】修前 >40s 无响应（单个死渠道可达 20 分钟）；修后 **8.07s 返回 200** | ✅ **本轮已修**（见 C7） |
| D8 | ~~`family`/`kind` 不一致导致 4 个模板调不通~~ | 【实测】`POST /api/generate/edit` → **404**；一键接入按 `family !== image && !== video` 直接 `continue` 跳过 | ✅ **本轮已修**。受影响的是 `img_qwen21_edit`、`img_boogu_outfit_edit`、`scail2_action_transfer`、`upscale_4x` —— 修前它们**根本不会成为渠道模型**。修后 16 个模板全部接入（image 8 + video 8） |
| D9 | ~~3 个连不上的外部 LLM 渠道~~ | 【实测】`gpt`(`ai.input.im` TCP 连上不回包)、`kimi`(401)、`本地网关`(被边缘 Basic Auth 挡住，且是网关自己的公网地址，自指无意义) | ✅ **本轮已清理**，只留 `deepseek`（Key 完好）；原注册表备份在 `data/llm-providers.pre-cleanup.json`（0600）。`/api/health` **8.07s → 0.207s（39×）**，新调用不再产生任何渠道告警 |
| D10 | `img_` 模板不做 32 倍数吸附 | 【核实】`generate.js` 只对 `video_` 前缀吸附 | 🟡 未修。Qwen-Image 2.1 官方明确「尺寸建议 32 的倍数」 |

---

## 5. 投资顺序

1. **D4 `assembly` 执行体** —— 补护城河缺口。本机 ffmpeg 8.0.1 在盘、不占 GPU、不需要新 ComfyUI 模板。顺手把 B4 的插件批量能力收编成画布通用的「整组执行」：**打组已有**（`CanvasNodeType.Group`、`nodes[].groupId`，29 处引用），**整组执行没有**（全仓无 `runGroup`/`batchRun`/`executeGroup`）。做成「整组执行 + 组内产物按序拼接」可一次补三处（`storyboard-studio` 的批量出图/出视频目前只在该插件面板内可用）
2. **B1 → Schema 化** —— 让「拷一个工作流 JSON 就自动可用」成立。`gateway-api-benchmark.md` §6.1 与对标产品的设计**独立收敛到同一方案**（`TemplateInfo.schema`：type/required/default/min/max/multipleOf/enum/frameGrid/assetKind）。D8 就是硬编码分支的直接代价
3. **D6 skill 库接线** —— 内容质量，资产变现
4. **D3 正经档** —— 给网关加 `auth.mode: none|bearer|hmac`（设计见 `gateway-api-benchmark.md` §6.6），堵住局域网内 `0.0.0.0:8788` 无鉴权这一条
5. **D1/D2/D10 顺手清掉** —— 要么实现，要么从契约删掉。**不要留着承诺做不到的字段**

**明确不投**：实时协作与跟随模式（无 Yjs/CRDT，画布自研无 React Flow，与本地优先路线冲突）、商业化外壳、模型生态。

## 6. 已验证的基线（复核用）

```bash
cd canvas-server && node --test test/*.test.mjs   # 68/68
cd web && npx tsc --noEmit                        # 退出码 0
curl -s http://127.0.0.1:8788/api/health          # llm.ok / comfy.ok 均 true，ComfyUI 0.38.2
curl -s http://127.0.0.1:8788/api/providers       # 16 个模板：image 4 / video 8 / edit 3 / upscale 1
```

147 的 ComfyUI：**0.38.2**（`comfy-aimdo` 0.5.5，H3 主力管线已复测通过 `video-muqp3s3h-26kei`）。
Qwen-Image 2.1：`qwen_image_2.1_int8_convrot.safetensors` 6.76GB 已就位，t2i / 指令改图 / 抠背景 / 透明直出 / 多图参考**五项实测通过**。
**GGUF 路线是死路**（上游 ComfyUI-GGUF 的 `detect_arch` 无任何 qwen 架构，master 与本地逐字相同），细节见 `HANDOFF.md` 坑位。

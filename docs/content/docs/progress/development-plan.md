# 开发计划 —— Project 一等实体与模块联动

> 内部文档，**有意不登记进 `meta.json`**，不进文档站导航。
> 版本：v1（2026-10-02）。来源：一次三视角并行调研（资产复用 / 数据流断点 / 用户成本）+ CTO 复核。
> 上位文档：`prd.md`（产品需求）。本文是**执行计划**，PRD 是**产品意图**。
>
> **证据分级**：每条结论标注
> **【已复核】**= 我亲自 grep/读码/真机验证过；**【调研】**= 子代理报告、未逐条复核，落地前需再确认。

---

## 0. 一句话结论

**Project 不是第一优先级。** 调研挖出一条更靠前的致命断链：五段流水线目前**结构性到不了成片**。
先修断链与 run 丢失（两者都是小改动、且是 Project 与「活扣」的共同地基），再立 Project。

## 1. 致命断链：`artifactUrl` 从不回写 【已复核】

```js
// canvas-server/src/pipeline.js:474  attachGeneration 内
item.artifactUrl = null;
```

全仓**再无任何对 `item.artifactUrl` 的赋值**（`grep -rn artifactUrl canvas-server/src/` 其余命中全是读取或
`files.js` 的 URL 构造函数）；且 `grep -rn "jobs.on|events.on|subscribe" src/index.js src/pipeline.js` **零命中**
—— 任务队列完成时没有任何回调进流水线。`jobs.js` 有 `events.emit("change", job)`，只是没人监听。

三处连锁失效：

| 位置 | 后果 |
| --- | --- |
| `pipeline.js:483` | `if (item.role === "end" && start?.artifactUrl)` 恒假 → **尾帧永远拿不到首帧当参考图** |
| `pipeline.js:497-498` | `if (start?.artifactUrl) params.INPUT_IMAGE = …` 恒假 → `if (canEnqueue && params.INPUT_IMAGE)` 恒假 → **assembly 永不入队，clips 永远 `queued` / `jobId:null`** |
| `pipeline.js:513` | `stage.artifacts = items.filter(i => i.artifactUrl)` → **恒为 `[]`** |

第 497 行注释写的是「等关键帧阶段产出后再跑」—— **意图正确，但没有任何东西把产出写回来**，
所以手工重跑 assembly 也无效（`start.artifactUrl` 仍是 null）。唯一现存通路是用
`POST .../steps/:stage/input` 手工把 artifactUrl 填进产物 JSON，不可用。

**为什么一直没被发现**：关键帧图片**确实生成了**（job 跑了、产物落盘了），前端
`use-pipeline-run.ts` 绕过 run、直接轮询 jobs 渲染 `job.outputs`，所以图看得见。
但 **run 自己永远不知道**，下游拿不到。HANDOFF 记的「端到端跑通到 keyframe」是真的，
「五段式流水线」是假的 —— 实际是**四段半**。

**修法（小）**：`index.js` 订阅 `jobs` 的 change 事件，job 落终态时把 `outputs[0].url` 回写到
对应 item 的 `artifactUrl`/`status`，并重算 `stage.artifacts` 与 `saveRun`。
需要一个 `jobId → (runId, stageId, itemId)` 的反查；`enqueueItem` 已经在 `job.meta` 里存了
`{runId, stageId, itemId}`（`pipeline.js:439-445`），**反查所需的信息已经在了**。

**与「活扣」的关系**：活扣的 `candidates[]` 本质就是同一条「job 完成 → 回写 item」通路，
只是从单值变数组。**修断链不是绕路，是活扣的前置。**

## 2. run 丢失：唯一会造成不可逆金钱损失的缺陷

| 事实 | 证据 | 分级 |
| --- | --- | --- |
| `run` 是裸 `useState`，刷新即丢 | `web/src/pages/pipeline/use-pipeline-run.ts:64` | 【已复核】 |
| 服务端**早就有** `GET /api/pipeline/runs`，前端**没有对应客户端函数** | `canvas-server/src/index.js:268`；`web/src/services/api/gateway.ts` 只有 create/get/runStage/progress/cancel/input | 【已复核】 |
| 全站无 `beforeunload` 拦截 | — | 【调研】 |
| 创建 run 时前端不传 title，服务端一律落「未命名流水线」，UI 也无改名入口 | `use-pipeline-run.ts` `createPipelineRun({ novel })`；`pipeline.js:239` | 【已复核】 |

后果：一部 222 万字的书跑 83 分钟，用户一刷新就再也拿不回那个 run，**而后端仍在跑、仍在烧 LLM 额度**，
且因为 run 无名、磁盘上已有 7 个同名 run，事后也无法辨认。

> 注：本轮已完成的服务端改造（202 异步 + `progress.json` + `cancel` + `resume`）让**后端**具备了
> 可恢复性；缺的是**前端**把 runId 持久化并接上已有的列表接口。

## 3. Project 的定位

**不是文件夹，不是画布，不是标签。Project 是一组标识符的宿主，也是三个世界唯一的联动中枢。**

现状是三个互不相通的世界（`grep -rn "runId|pipelineRun"` 在 `web/src/stores/canvas/`、
`web/src/pages/canvas/`、`web/src/lib/canvas/` **零命中**【已复核】）：

| 世界 | 存储 | 实体 | 缺 |
| --- | --- | --- | --- |
| 画布项目 | 浏览器 localforage | `CanvasProject`（`use-canvas-store.ts:10-22`） | 只是画布容器：无剧本、无主线、无资产作用域、无 run 关联 |
| 素材库 | 浏览器 localforage | `Asset`（`use-asset-store.ts:15-26`） | **无 `projectId`**（全局一锅）、**无 `bindingId`**（绑不到角色/场景） |
| 流水线 run | 服务端 `data/runs/<id>/` | novel + 5 阶段 + artifacts + estimate | **无 projectId、无画布引用** → 跑完即孤儿 |

Project 的价值不在于多一个层级，而在于让
**「这张图是第几集第几镜、用了哪个提示词、参考了哪张定妆图」在系统里可回答**。
现在这句话只活在用户脑子里。

### 3.1 要补的标识符（按层）

| 层级 | 现状 | 要补 | 分级 |
| --- | --- | --- | --- |
| run | 无 projectId | `projectId`（**可先塞 `run.options`，零服务端改动** —— `create()` 原样落盘 options，`beginStage` 已在拿它当扩展袋） | 【已复核】 |
| episode | `episodes[]` 在契约与提示词里存在、**代码零消费** | 提为分区键，scene/shot/frame/clip 全带 `episodeId` | 【已复核】（`grep episodes canvas-server/src` 只命中提示词串） |
| scene | `shots[].sceneId` 由 LLM 自由书写，代码从不校验从不 join；`design.locations` 靠 **name 字符串**对齐场景 | 改代码校验 + 用 `sceneId`/`locationId` 对齐 | 【调研】 |
| shot | 插件 `reindex()` 把 id 一律重写成 `sh1..shN`，外部引用一次增删调序即失效 | shotId 定为不可重排的稳定 id，reindex 只改 `index` | 【调研】 |
| job | `meta:{runId,stageId,itemId}`，无语义 id | 补 `{projectId,episodeId,sceneId,shotId}`；**服务端已透传 `body.meta`（`generate.js:143`），画布侧 `GatewayGenerateBody` 只是没这个字段** | 【调研】 |
| 节点 | `CanvasNodeMetadata` 无 jobId/template/seed/shotId | 增 `jobId/template/seed` + `origin:{projectId,runId,stageId,shotId}` | 【调研】 |
| 角色 | `characters[].appearance` 产出了、SKILL 也要求 prompt 与之一致，但**只能当 JSON 看** | 升格为项目级资产（`bindingId`） | 【已复核】（契约见 `skills/01-novel-to-script/SKILL.md`） |

## 4. 用户成本：调研量化出的代价

| 摩擦 | 代价 | 分级 |
| --- | --- | --- |
| 刷新即丢 run | 83 分钟 + 全部 LLM 费用不可逆 | 【已复核】 |
| 流水线产物是死胡同：`pages/pipeline/` 对 `useAssetStore`/`useCanvasStore`/`navigate` 引用数 = **0** | 30 镜 × 2 帧 ≈ **60 次「另存为 + 重新上传 + 2 次页面切换」**（画布只支持文件上传，不支持从 URL 导入） | 【调研】 |
| 分镜 schema 同构却无导入通道（插件 `Shot` 与服务端 02 契约 **11 字段同名同义**） | 想把流水线分镜搬进画布，只能复制 JSON → 建文本节点 → 让 LLM **再付费重跑一遍** | 【调研】 |
| 角色一致性只靠 LLM 把外观描述重复写进每个 shot 的 prompt；LoRA 在 `model-plugin.ts:485` 存在但 **UI 零暴露** | N 镜 = N 次手工连参考图，或接受脸崩重 roll | 【调研】 |
| 插件设置跨项目串台（`ctx.storage` 只按 pluginId 命名空间） | 改第 2 集的模型，第 1 集静默跟着变，无提示 | 【调研】（两个子代理独立佐证同一条） |
| 出图尺寸/模板 UI 不可控（取服务端 `config.pipeline.imageWidth`，`/config` 页对 `pipeline` 引用 = 0） | 做竖屏短剧必须**手改服务器 config.json 并重启** | 【调研】 |
| 5 阶段无「一键跑完」，且每阶段各选一次模型 | 5 次点击 + 5 次选择，且必须守着页面 | 【已复核】 |
| 重复实现：文本文件导入 2 份逐字重复、`type="file"` 11 处、模型下拉 3 套、「渠道::模型」2 种编码、尺寸 3 套词汇、「存进素材库」7 处各写一遍 | 学习与维护成本同步上升 | 【调研】 |

## 5. 复用盘点

### 5.1 白捡（照抄即可）

- **服务端 `data/projects/<id>/` 全套**：`pipeline.js:71-181` 那 6 个目录/读写函数 +
  `files.js`（`safeJoin`/`ensureDir`/`sanitizeName`）+ `http.js` router + `jobs.js` 的重启收敛，
  与 `data/runs/<id>/` **完全同构**【已复核】
- **`run.options` 今天就能带 projectId，零服务端改动**【已复核】
- **`applyCanvasAgentOps` + 8 个 op** = 「run 产物铺到画布」的现成底座，不需要新机制【已复核】
- `pages/canvas/index.tsx` 列表骨架（网格 + 批量选择 + 导入导出 + 回收站）、
  `canvas-side-panel.tsx:157-172` 组树、`pages/assets/index.tsx` 过滤分页网格、`stage-card.tsx`、
  `lib/zip.ts`、`app-sync.ts` 的通用 `syncDomain<T>`、长任务 202+轮询+取消三件套【调研】

### 5.2 要改造

- `Asset` 加 `projectId` + `bindingId`：`updateAsset` 接受 `Partial<Omit<…>>`，**现有 CRUD 与 persist 全不用改**【调研】
- `CanvasProjectCard` 解绑 store 与导航；`use-pipeline-run` 提成 store（现在 run 在组件里，没有 store 能给 Project 订阅）【已复核后半】
- `cleanupUnusedImages`/`cleanupUnusedMedia` **必须知道服务端引用**，否则删画布会误删项目产物【调研】
- `GatewayGenerateBody` 加 `meta`【调研】

### 5.3 必须新建

Project 服务端模块与路由；`Project`/`Episode`/`AssetRef`/`GenerationSlot` 类型
（**`episodes[]` 在 TS 侧完全不存在**【已复核】）；项目页与路由/导航项；插件 storage 的项目命名空间。

## 6. 落地当天就会踩的四个陷阱

1. **`useCanvasStore` 是「单 key 存全部项目」**，每次写都 `JSON.stringify` 全量 →
   项目元数据塞进去会让**每次画布拖动都重写全库**【调研】
2. **事件总线是全局单例、无 scope** → 项目页与画布页同时挂载会互相收到事件【调研】
3. **插件 storage 只按 pluginId、不按 projectId** → 项目间串台【调研，双代理佐证】
4. **全局媒体 GC 的扫描范围只有浏览器数据** → 删画布会误删服务端 `assetRefs` 仍指向的图【调研】

## 7. 决策登记

以下两条是 CTO 建议，用户要求「把意见登记进开发计划」。**按建议执行，若否决请在本文批注后回退。**

### D1 命名：Project = 剧，Canvas = 画布 【建议】

新实体叫 `Project`（项目 = 一部剧），现有 `CanvasProject` 重命名为 `Canvas`（画布），
一个 Project 可包含多个 Canvas。

- **理由**：语义最清，且与「多集共享资产」的心智一致（一部剧可以有多个画布：角色设定板、场景板、每集分镜板）。
- **代价**：`CanvasProject` 在 `use-canvas-store.ts`、`canvas-project-card.tsx`、`pages/canvas/index.tsx`、
  `canvas-export.ts`、`app-sync.ts` 等多处被引用，是一次纯改名重构。
- **不改的代价更大**：`CanvasProject.title` 已在用「项目」指画布容器，
  `CanvasAgentSnapshot.projectId`（`canvas-agent-ops.ts:18`）填的也是**画布 id**。
  不先定名，后续所有 `projectId` 引用都会歧义。
- **可逆性**：改名是机械重构，可逆；但**必须在 P0-c 之前完成**，否则新代码会带着歧义扩散。

### D2 产物存储：默认引用服务端产物，不下载不复制 【建议】

`Asset` 允许直接引用 `/api/artifacts/<jobId>/<file>`，入素材库时**不复制像素**。

- **理由**：消除第三份副本（现状：画布节点 ↔ 素材库共享 storageKey 是同一份，
  流水线 artifacts 是独立第三份，与浏览器 GC 完全隔离、无引用机制）。
  短剧一部 30 镜 × 2 帧 × 多候选，复制会迅速吃掉浏览器配额。
- **代价**：图在网关磁盘上，**离线或换机器时浏览器拿不到**；且必须同时改 GC（陷阱 4），
  否则删画布会误删项目产物。
- **兜底**：WebDAV 同步与「导出 zip」时把被引用的 artifacts 一并打包（`canvas-export.ts` 的
  `collectStorageKeys` 递归机制可扩展成也收集 artifact URL）。
- **未选「下载存浏览器」**：同一张图存两份，且 6.4MB 级的 run 已经证明服务端才是大件的正确归属。
- **未选「默认引用 + 可手动转存」**：多一个概念、多一套状态，且用户不会主动转存，
  等价于默认引用 + 一个几乎没人用的按钮。**若后续确有离线需求再加，属加法不属返工。**

## 8. 工作包与顺序

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **P0-a** | 修 `artifactUrl` 回写断链：订阅 job change，回写 item + 重算 `stage.artifacts` + `saveRun` | — | 真机跑 script→…→keyframe→assembly，**clips 真的入队并产出视频**，`stage.artifacts` 非空 |
| **P0-b** | run 可恢复：持久化 runId、封 `listPipelineRuns`、run 可命名、`beforeunload` 拦截、run 列表页 | — | 跑到一半刷新页面，能从列表找回那个 run 并继续看进度/取消 |
| **P0-c** | D1 改名重构 + Project 服务端实体与 CRUD + `run.options.projectId` | P0-a、P0-b、D1 | 创建项目、把 run 归属到项目、项目页能列出它的 run |
| **P1-a** | 打通流水线出口：产物一键入素材库（按 D2 引用 URL）+ `shots[]` 一键导入分镜板节点 | P0-a、P0-c | 关键帧一键进素材库；流水线分镜导入插件**不需要重跑 LLM** |
| **P1-b** | 活扣：`GenerationSlot.candidates[]` + `POST .../regenerate` + 并排对比 UI + 模型下拉 | P0-a | 同一镜头用两个模板各出一张、并排对比、点选采用；重跑**不再摧毁**上次结果 |
| **P1-c** | 六阶段方法论吸收 + 阶段 0 规划 + 接线 `skills/libraries/` 两个库 | P0-c | 受 `AGENTS.md` 内容创作规范约束（忠于原著、风险只提示不改稿）；风格锚点成为项目级字段 |
| **P2** | 项目页完整化、标识符贯通（episodeId/sceneId/shotId）、角色资产升格、assembly ffmpeg 拼接 | P1 | 见 PRD §6 |

## 9. 明确不做

- **不给 WebDAV 加同步域**：服务端已是权威副本，且域清单是四处硬编码的闭合集合
  （`app-sync.ts:14`、`:88-127`、`domainLabel:377-382`、`AppSyncResult:53-65`），加域要改四处【调研】
- **不动 `exportCanvasProjects` 的 zip 契约**：`version:3` 闭合，复用会破坏现有 zip 的向后兼容读取【调研】
- 不做实时协作、商业化外壳、模型市场、云端生成后端（见 `prd.md` §9）

## 10. 仍待确认

1. Project 服务端 CRUD 与浏览器画布之间的冲突策略（同项目两设备同时改画布）——
   倾向「后写覆盖 + 版本号提示」，画布域已有墓碑机制可复用【调研】
2. 阶段 0 的规划参数（比例、单集时长、剧作基调）是项目级一次锁定，还是允许逐集覆盖？
3. `reviewNotes[]`（审核风险提示）的粒度：按项目、按集、还是按镜头？
4. 活扣的候选保留上限（防止一个镜头攒几十个候选撑爆磁盘）？
5. 「一键跑完五阶段」要不要做？做了就必须配套**全局取消**与**逐阶段确认门禁**的取舍
   （外部方法论强调每阶段停下等确认，与一键跑完冲突）

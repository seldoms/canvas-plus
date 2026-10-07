# LibTV（liblib.tv）竞品拆解：页面功能 / 设计系统 / 按钮设计 / 技术实现

> ⚠️ **已归档（2026-10-07）**：过程性文档，内容定格于写作时点，可能滞后于代码。现行权威文档见 `../development-plan.md`、`../project-centric-skeleton.md`、`../domain-contract.md`；本区说明见 `README.md`。


> 分析对象：<https://www.liblib.tv/> —— LiblibAI 旗下 **LibTV**，定位「专业视频创作工具」，官方口号是「首个同时面向人与 Agent 的专业视频创作平台」。
> 采样时间：2026-10-02（Asia/Shanghai）。
> 置信度标注：**【已确认】** = 有抓取到的真实 DOM / CSS / JS 字面量 / 响应头直接证据；**【推测】** = 由间接线索推断；**【未确认】** = 需要登录或真实交互才能看到。

---

## 0. 这次是怎么看的（方法与能力边界）

用户要求「用浏览器插件看」。**实测结论：本会话没有可编程驱动的浏览器工具可用。**

- DSH 客户端确实装有浏览器侧边栏插件（`@deepseek-ai/dsh-client-ui-sidebar-browser`），Host 侧也有 `browserUse` 服务，但它只暴露了 `register(name)` 一个方法，**没有注册任何可被我调用的 provider / Tool**。我的工具集里也不存在 browser / playwright / computer_use 类工具。
- 因此本报告改用以下三条可复现通道，**全程没有触碰用户已打开的 Chrome 窗口**（使用独立 `--user-data-dir` + 独立 headless 实例）：

| 手段 | 用途 |
|---|---|
| `curl --compressed` + 浏览器 UA | 抓 SSR HTML、响应头、`robots.txt` / `sitemap.xml`，批量探测路由状态码 |
| 独立 headless Chrome（`--headless=new --screenshot`） | 拿到 JS 执行后的**真实渲染界面**与截图（深色主题默认） |
| 下载并解压 6 个 CSS chunk（1.19 MB）+ 81 个 JS chunk（7.9 MB） | 提取设计令牌、按钮 class、库指纹、接口清单、i18n 词典 |
| Next.js RSC / flight 数据解析 | 从 `self.__next_f.push` 解出**权威路由树**、模板配置 JSON、模型参数 Schema、9000+ 条 i18n 文案 |

⚠️ 两点方法论提醒（踩过的坑）：
1. **sitemap 不可信**。`sitemap.xml` 列了 604 条 URL，其中 `/explore`、`/community`、`/plugins`、`/agent`、`/changelog`、`/events/*` **实测全是 404**。真实路由要从 RSC flight 里的路由树拿。
2. 别在下载目录里执行 `cat *.css > all.css` 这类自匹配重定向（输出文件会被自己匹配进去，无限增长）。用具体文件名。

---

## 1. 一句话结论

LibTV 不是「网页版的视频生成器」，而是**「无限画布 + Agent」双入口的影视制作工作台**：左侧导航 6 个入口最终全部收束到同一个 React Flow 画布上；人类用画布和面板操作，Agent（以及外部 Claude / ChatGPT / Codex）通过同一套工具协议操作同一张画布。它的商业化外壳（会员、积分、算力、挑战赛、学院）围绕这个内核展开。

差异化最强的三件事：
1. **模板即入口**——首页「最近上新」的每张卡不是广告图，而是一个**带 `sourceProjectUuid` 的模板项目**，点开就把官方做好的工作流复制成你的画布。
2. **Agent 优先的路由设计**——每个入口链接都带 `forceAgent=1&agent_mode=...`，进入画布时直接把 Agent 面板切到对应「导演模式」。
3. **面向外部 Agent 的开放接入**——官方提供 Plugin / MCP / CLI 三种方式，让 Claude、ChatGPT、Codex 等直接调用 LibTV 生成图片视频（`https://mcp.liblib.tv/mcp`）。

---

## 2. 信息架构与真实页面地图

### 2.1 左侧一级导航（全站共用外壳）**【已确认】**

```
LibTV
├── ＋ 新建项目                      主按钮，高亮
├── LibTV Agent                     → /skill
├── LibTV 3D-BOX                    → /3d-box
├── 首页                            → /
├── 项目                            → /project
├── 资产                            → /assets
├── 插件与扩展  ▾ aria-haspopup=menu  → /plugin、/blender、CLI、Skills
├── 社区（分组标题，本身不是路由）
│   ├── 学院          [角标 大师开讲] → /academy
│   ├── TV Show       [角标 全网爆款] → /show
│   └── 创作者挑战赛   [角标 王者大赛] → /activity
└── 版本更新记录 v1.5                浮层卡片；独立路由 /feature-updates 也存在
```

补充：**只有「插件与扩展」是下拉菜单**，其余一级项都是普通 `button` + 程序化路由。全站几乎没有 `<a href>`。

### 2.2 实测存在（HTTP 200）的页面

| 路由 | 页面 | 定位 |
|---|---|---|
| `/` | 首页 | 创作总台：新建画布 + 模型入口 + 最近上新 + TV Show 流 |
| `/project` | 项目 | 项目/画布文件管理器 |
| `/assets` | 资产 | 生成历史 + 个人资产库 + 可灵资产库（**未登录=登录墙**） |
| `/canvas` | 画布 | **核心**：React Flow 无限画布编辑器（需登录+项目上下文） |
| `/skill` | LibTV Agent | Skill 市场 + Agent 对话创作入口 |
| `/show` | TV Show | 作品发现社区 |
| `/academy` | 学院 | 课程、图文教程、AI 跟练室 |
| `/activity`、`/activity/{id}` | 创作者挑战赛 | 赛事列表与详情（ `去创作` 跳画布） |
| `/plugin` | 插件与扩展 | 把 LibTV 接入 Claude / ChatGPT / Codex 等 Agent |
| `/detail/{id}` | 作品详情 | 播放器 + 作者 + 描述 + 精选推荐 |
| `/3d-box` | LibTV 3D-BOX | 文字/参考图让 Agent 搭 3D 场景并预演运镜 |
| `/director-studio` | Director Studio | 叙事/视觉/拍摄三维度的导演参数台 |
| `/feature-updates` | 版本更新记录 | 版本日志（理解全量能力最有价值的一页） |
| `/wappro` | 营销落地页 | 「新一代全能 AI 创作平台」 |
| `/seedance-verify` | Seedance 任务核验 | 输入 Task ID 走火山方舟只读接口核验 |
| `/blender` | Blender 插件 | 「在 Blender 内完成白模视频，一键导出到 LibTV」 |
| `/visual-check-success`、`/animation-preview`、`/team`、`/profile` | 辅助页 | 真人检测完成页、打开失败兜底页、团队邀请、个人主页 |

RSC 路由树中还出现 `corporate-pay`、`statement`、`worldcamera`、`director-vcam`、`forbidden`、`mcp`，未逐一验证。

### 2.3 实测 404（**不要当成功能页**）

`/explore`、`/community`、`/plugins`、`/agent`、`/changelog`、`/events`、`/events/ai-video-festival`、`/events/director-challenge`、`/events/anime-contest`、`/mcp`、`/worldcamera`、`/ai-video`、`/lp`、`/statement`、`/corporate-pay`。

> 「社区」不是路由，是侧边栏的一个分组；`/mcp` 虽然 404，但 MCP 服务端点在 `mcp.liblib.tv`，且 OAuth 授权页 i18n 已存在。

---

## 3. 各页面主要功能（核心交付内容）

### 3.1 首页 `/` —— 创作总台

**主区结构（自上而下）：**

1. **新建画布创作**：一整块 160px 高的大卡（0.5px 描边 + 12px 圆角），中间是发光 `＋` 方块，下方文案「新建画布创作」。
   - 背景是自研 `CreateCanvasDotGrid` 点阵组件（`--dot-gap:18px; --dot-core:.345px; --dot-color:color-mix(in srgb, var(--nt-icon-default) 17.5%, transparent)`），带 **ripple / rippleDelay2 / spotlight 三层动效**；hover 时 `＋` 方块 `scale-[1.05]`。
2. **模型快捷入口行**（横向可滚动）：`Minimax H3 Max`、`Wan 3.0`、`Seedance 2.5`。
3. **功能快捷入口行**：`视频生成`、`图片生成`、`音频生成`、`剧本生成`、`智能剪辑`、`更多功能`。
   - 实现上是 `data-canvas-entry-key` 驱动的配置数组，每个入口 `{id,title,iconUrl,action}`，全部指向 `/canvas?...`。
4. **最近上新**（5 张卡）：`「X小时之后」AI短片黑客松`（角标 `已颁奖`）、`剧本原创与改编`、`导演执导`、`角色造型室`、`创意片头`（各带 `独家` 角标）。
   - **每张卡有 `coverUrl` + `hoverVideoUrl`（webm）**，hover 直接播放功能演示视频。
5. **TV Show 作品流**（与 `/show` 同组件）：分类 Tab + 搜索框 + 4 列作品卡网格。

**按钮与行为清单：**

| 按钮 | 行为 |
|---|---|
| `＋ 新建项目` | 创建项目/画布 |
| `LibTV Agent` / `LibTV 3D-BOX` | 进 `/skill` / `/3d-box` |
| `首页` / `项目` / `资产` | 路由切换 |
| `插件与扩展` | 展开下拉菜单 |
| `学院` / `TV Show` / `创作者挑战赛` | 路由切换 |
| `版本更新记录 v1.5` | 打开版本浮层 |
| `积分超市` / `开通会员 限时45折` / `注册/登录` | 商业化与账号 |
| 模型/功能入口 | 以对应模型或能力开新画布 |
| `查看全部` | 展开最近上新 |
| 作品卡 `查看创作过程`（aria-label） | 打开该作品的创作过程回放 |
| `限时抢购` / `×` | 弹付费墙 / 关活动条 |
| 右下 `新人限时红包` + `注册新用户`、`?` 帮助 | 增长与帮助浮标 |

### 3.2 项目 `/project`

- **顶栏**：`‹ 返回`、面包屑 `全部项目`；右侧 `搜索项目` 输入框、`回收站`、`新建文件夹`。
- **主区**：项目卡片网格；空态是 `＋ 开始创作` + 副文案 `创建新的视频项目`。
- **回收站**：`仅显示最近 30 天内删除的内容`、`剩余 {days} 天`、`恢复`、`仅团队管理员或所有者可恢复`。
- **项目级操作**：`打开`、复制（生成 `{name} - 副本`，完成后提示「是否立即打开？」）、删除。
- **未登录**：直接弹 `登录失败 / 登录失败，请重新登录` + `登录` 按钮。

### 3.3 资产 `/assets`

- 顶部三标签：**`生成历史` / `个人资产库` / `可灵资产库`**（Kling 资产库——说明接入了可灵的资产体系）。
- **未登录直接是登录墙**：左半屏是作品大图 + 「LibTV 热门作品 / 全网创作者都在用 LibTV｜登录开启你的创意大片」，右半屏是 **微信一键登录二维码**，底部三种备选：`手机号登录`、`团队邮箱登录`、`QQ 登录`。
- 能力（i18n 证据）：`上传资产`、`从个人资产中导入`、素材分类 `待分类资产`、上限 `您最多只能保存 2000 条素材`、审核态 `· 审核中` / `· 审核未通过`、合规提示 `素材内容已合规，可用于Seedance视频生成`。
- 移动端明确不支持：`资产管理暂不支持移动端`。

### 3.4 画布 `/canvas` —— 全站内核

**入口机制【已确认，重要】**：裸 `/canvas` 未登录会回落首页；真实入口永远带参数，形如：

```
/canvas?sourceSpaceId=9389264
      &sourceProjectUuid=14977fa6a1934c839ba78481d4a7b389
      &guideSeenKey=createScript
      &guideConfig=project
      &hideDirectorGuides=1
      &forceAgent=1
      &agent_mode=script_original
```

- `sourceSpaceId` + `sourceProjectUuid` → **复制一份官方模板项目**到你的空间。
- `guideSeenKey` + `guideConfig=project` → 只弹一次的新手引导（按 key 记忆）。
- `forceAgent=1` + `agent_mode=script_original|directing` → **强制打开 Agent 面板并切到指定导演模式**。

**新手引导 4 步（真实文案）**：① 双击或右键创建新节点 ② 图片上方工具栏有高清、抠图、九宫格等功能 ③ 拖拽一个或多个节点 + 进行连接 ④ 把多个作品打组，打组后可排序和整组执行。

**节点体系**：`文本` / `图片` / `视频` / `音频` / `脚本`（新旧两版）/ `智能剪辑` / `视频组` / `参考节点` / `自定义`，以及生成器系列：`文本生成器`、`图片生成器`、`视频生成器`、`音频生成器`、`角色生成器`、`脚本生成器`。

**图像能力**（`canvasStore*`）：扩图、重绘、擦除、抠图、裁剪、旋转、旋转镜像、标注、高清放大、增强、补光、打光、多角度。

**Slash 快速画面能力**（`/` 唤起）：分镜叙事、空间与机位、质感调节、设定图；具体场景有 **故事板、720 全景、多机位九宫格（含 4K）、角色脸部三视图、场景三视图、产品三视图**。

**导演级能力**：`导演级提示词`、`选择导演风格`、提示词 `优化前/优化后/差异对比` + `填充到输入框`；风格预设 `动画剧情 / TVC 广告 / 卡点 MV / 纪录片 / 口播带货 / 悬疑短剧`。

**动画与骨骼**：动画时间轴、时间轴缩放、自动帧、循环播放、新建/移除轨道；关键帧分 `变换/姿态/道具/分组/机位`；`SAM 骨骼姿势`（头颈、左右臂、左右腿、根骨骼、腰部、脊柱、胸腔、颈部、头部、锁骨、上臂、前臂、手腕、大腿、小腿、脚掌）、`地面吸附`、`重新检测地面`。

**批量生产**：`分镜组`（仅图片节点，≤25 个）+ `批量生视频` → `确认并创建视频生成器组 ({count})` → 整组执行；带资产锚定（角色/场景/道具参考图）与上限校验（`超出当前模型上限（最多 {max} 张）`）。

**全景**：全景预览、当前视角截图、4 大视角截图、12 大视角截图、构图参考线、重置视角，以及 `全景转 3D`（WebGL 不支持时有明确降级文案）。

**协作**【已确认】：实时增量同步（`协作画布会实时同步，无需手动全量保存`）、**跟随模式**（开始跟随 / 停止跟随 / 正在定位）、协作会话过期检测（`此协作画布已在其他标签页打开`）、节点级编辑锁（`其他成员正在编辑该节点，无法复制`）。

### 3.5 LibTV Agent / Skills `/skill`

- 顶部 **Agent 输入卡**：Hero 标题轮播（「从 Skill 出发，抵达成片」「说个想法。或者，选个 Skill」「一个 Skill，一部作品」），多行输入框（占位「请输入你的创作灵感，或从下方挑选一个 Skill 开始」）、`添加附件`、`选择模型`、`Skill`、`发送`。
- **分类导航**：`收藏 / 我的 / 推荐 / 专业影视 / 商业广告 / 短剧漫剧 / 动漫游戏 / 音乐MV / 自媒体创作 / 通用技能 / 发现` + `搜索 Skill`。
- **Skill 卡片**：类型角标（`视频`）、英文 slug（如 `/xianxia-drama-planner`、`/wong-kar-wai-film-aesthetic`、`/shunji-iwai-cinematic-aesthetic`、`/dreamcore-generator`）、中文名与简介、作者、使用量、`使用` 按钮。
- **Skill 生命周期**：`创建Skill`、`编辑 Skill`、`另存为新 Skill`、`删除`（`非本人创建Skill，无权限删除`）、`收藏/已收藏`；**「将本次对话转化为 Skill」**——把一次成功的 Agent 对话固化成可复用技能。
- 卡片还标注 `该作品消耗 {power} 积分`。

### 3.6 TV Show `/show`

- 分类 Tab（11 个）：`全部`、`LibTV·「X小时之后」AI短片黑客松`、`全网爆款`、`王者无界剧场计划`、`精选画布`、`专业影视`、`短剧漫剧`、`商业广告`、`动漫游戏`、`教育生活`、`TV工具箱`。
- 搜索框 + 4 列作品卡网格：封面、标题、作者头像昵称、点赞数；运营角标 `全网点赞100万+` / `30万+` / `10万+` / `全网爆款`；获奖卡直接标 `AI重制那头牛大赛 - 🏆特等奖🏆`。
- 每张卡都有 `查看创作过程` 按钮——**作品可以回放创作过程**，这是它社区的核心差异点。

### 3.7 学院 `/academy`

- **AI 大师公开课 Banner**：`LibTV x 抖音联合出品「AI大师公开课」` + `查看课程`；另一处运营位是罗永浩大师课。
- **学习广场**两个 Tab：`图文教程` / `亮点功能`；每篇教程标注 `阅读 15min` + `涉及功能：...`（覆盖画布节点、打组、资产管理、智能引用、故事板、多机位、设定图、全景、打光、九宫格、深度动作捕捉、音色克隆、3D导演台、Blender插件、Seedance 2.5 等）。
- **我的课程**（未登录 `登录后可查看课程`，且提示要用购课手机号登录）、**课程广场**（`立即购买` / `立即学习` / `{count} 课时`）、**AI 跟练室**（`立即跟练`，移动端提示去 PC）。
- **课程兑换弹窗**：渠道单选 `抖音 / 小红书 / b站 / 快手 / 视频号` + 手机号 + 订单号 + 兑换密码；错误态区分「兑换码无效 / 已被使用 / 该订单已兑换过」。
- 团队账号限制：`团队版暂不支持课程兑换`。

### 3.8 创作者挑战赛 `/activity`、`/activity/{id}`

- **列表页**：活动卡（状态角标 + 一句话宣传语 + 活动名）。状态枚举：`预报名 / 进行中 / 评审中 / 已颁奖 / 已结束`。
  - 例：`已颁奖`「🎬大咖云集，500,000+现金奖池」→ LibTV·「X小时之后」AI短片黑客松；`进行中`「👑 150万现金奖池」→ LibTV x 王者荣耀；`评审中` → LibTV x 北京电影学院文学系。
- **详情页**：`去创作` 主按钮、活动时间、`展开全部`、**获奖作品列表**（奖项名 + 作品 + 作者 + 点赞）。

### 3.9 作品详情 `/detail/{id}`【已确认，可完整渲染】

- 顶部：`‹ TV Show` 返回 + `注册/登录`。
- 主体：**大播放器**（占据上方大部分）、标题 `《铁兵小队》一键出片工作流+角色裂变`。
- 播放器下方操作条：`查看制作过程`、`♡ 2.3k`（点赞）、`↗`（分享，纯图标圆形）。
- 作者行：头像 + `YOUNG` + 认证角标 + `247 粉丝数 0 关注` + `＋ 关注` 胶囊按钮。
- `作品描述` 折叠块 + `更新时间: 2026年06月06日 17:02` + 右侧 `含 AI 生成内容` 声明标签。
- **右侧栏 `精选推荐`**：可滚动的作品列表（缩略图 + 标题 + 作者 + 点赞）。

### 3.10 LibTV 3D-BOX `/3d-box`

- Hero：「LibTV 3D-BOX · 你的专业影视空间」+「Agent 轻松搭景，精准调度站位，手绘轨迹实现大片级运镜」。
- 输入卡：文本域（占位「描述场景、人物动作和镜头怎么动，AI 帮你生成 3D 动画预演」）+ `添加附件` + 选择器 `3D-BOX Model Pro` / `16:9` / `时长自动` + **品牌青色 `生成` 按钮**。
- 三条可点击示例提示词（警匪追车 / 香水瓶运镜 / 古装庭院对峙）。
- `我的 3D-BOX` + `新建空白 3D-BOX`；项目级 `保存 / 分享 / 复制链接 / 删除`；分享是**快照分享**（后续修改需点「同步最新内容」）。
- 模型精度档：粗糙 / 标准 / 高精度 / 超高精度（限免）。

### 3.11 版本更新记录 `/feature-updates`

v1.5（2026-09-20）与 v1.0（2026-09-11）两组，每条功能 = 名称 + 说明 + `去体验`。

- **v1.5 五大独家**：剧本原创与改编、导演执导（可选预设导演或导入自己的方法论生成「导演分身」）、角色造型室、创意片头、LibTV 3D-BOX。
- v1.5 其他优化：`【TV Director】支持新建、更新、运行画布节点`、`支持 Agent 运行过程中切换自动/手动模式`、`画布打开速度显著提升`、`优化大量节点卡顿`、`修复画布偶尔丢失节点`。
- **v1.0**：深度动作捕捉、宫格切分、图层分离、智能剪辑、视频智能续写、Blender 插件、Seedance 2.5 超 5min 直出、逐帧拉片、**智能引用 AutoLink**、片段重拍。

### 3.12 Director Studio `/director-studio`

`参考素材 0/15`、`选择文件上传`；三个维度分组各带「自动」：**叙事 / 视觉 / 拍摄**；`视频` / `图像` 切换；提示词输入 `描述你想要的场景，输入 @ 引用素材`；参数 `16:9 · 720P · 5s · 1×`；`生成`。

- 叙事：通用 / 成长故事 / 纪录片 / 黑色电影 / 韦斯·安德森；节奏：舒缓 / 渐进 / 动感 / 律动。
- 拍摄：机身 / 镜头 / 焦段 / 光圈 / 运镜 / 色卡 / 光感（黄金时刻、蓝调时刻、夜间外景、阴天外景、雨夜反光、地铁荧光灯、夜间车内、审讯室）。
- 另有 `应用此组合`、`全部重置`、`从素材库选择`、`从历史记录选择`。

### 3.13 插件与扩展 `/plugin` —— 「面向 Agent」的落地页

- 主标题：**「LibTV Plugin，让你的 Agent 开始创作」**。
- **接入方式** Tab：`Plugin` / `CLI` / `MCP`（i18n 三种齐全）。
- **目标 Agent 单选**：`OpenAI`、`Claude`、`Claude Code`、`OpenClaw`、`Hermes`、`CodeBuddy`。
- 两步安装引导，第 1 步给一段可直接粘给 Agent 的提示词：
  ```
  帮我安装 LibTV Plugin，让我可以在这里创作影像。
  1. 添加插件目录：codex plugin marketplace add https://github.com/liblib-ai/marketplace.git --ref main
  2. 安装插件：codex plugin add libtv@libtv
  3. 新建任务后完成 LibTV 账户授权
  ```
- MCP 连接地址：**`https://mcp.liblib.tv/mcp`**；CLI 方式则下载安装包 → 安装 CLI 与配套 Skill → `libtv login`。
- 能力演示区三条案例：`全模型调用生成`、`多资产管理提案`、`可控多场景生成`（演示里直接展示对话气泡 + 工具调用 + 模型参数 `Seedance 2.5 / 全能参考 / 16:9·1080P·25s`）。

---

## 4. 设计系统

### 4.1 四层样式体系并存（这是它最真实的工程现状）

| 层 | 内容 | 状态 |
|---|---|---|
| ① **`--nt-*` 自研令牌（212 个）+ Tailwind v4** | 最新主体系 | **活跃，主力** |
| ② 旧语义层 `--bg-* / --fg-* / --btn-* / --Surface-* / --Stroke-*` | 上一代 | 基本废弃（`--Surface-*` 仅 7 处引用） |
| ③ **Mantine** | 通用组件库（`m_*` 哈希类 395 个） | 活跃，承担 Modal/Drawer/Tabs 等 |
| ④ **antd 5.27.5** | 仅 Table / Modal / Select / Input / Form / Pagination | 局部使用，**全 CSS 无 `.ant-btn`** |
| ⑤ 页面级 SCSS Modules（48 个模块） | 画布、支付、登录、资产等专有页面 | 活跃 |

### 4.2 `--nt-*` 令牌体系（建议重点参考）

**主题切换机制**【已确认】：`<html>` 上切 `.dark` / `.light` / `.canvas-light` 三个类，同时同步 `data-mantine-color-scheme`；持久化在 `localStorage: canvas:theme` + `cookie: __color_mode`；**默认深色**，**没有** `prefers-color-scheme` 分支。令牌定义在 `129_y89ca9lu0.css` 的 `:root`（浅色）与 `.dark`（深色）两处。

**品牌色**：`--nt-bg-brand: #13d5ff`（青），hover `#5ddcff`，active `#05a3c5`；品牌淡底 `#13d5ff14`。

**关键语义令牌对照（浅色 / 深色）：**

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--nt-bg-body` | `--nt-neutral-100` | `--nt-neutral-1000` |
| `--nt-bg-float` | `--nt-neutral-100` | `#242424` |
| `--nt-bg-float-glass-l1` | `#fffffff2` | `#1f1f1ff2` |
| `--nt-bg-float-glass-l2` | `#ffffffbf` | `#1f1f1fbf` |
| `--nt-bg-overlay` | `#0000000a` | `#ffffff0f` |
| `--nt-bg-overlay-hover` | `#0000000f` | `#ffffff14` |
| `--nt-bg-overlay-active` | `#00000014` | `#ffffff1a` |
| `--nt-bg-invert` | `#fff` | `--nt-neutral-900` |
| `--nt-text-default` | `#000000e5` | `#fff` |
| `--nt-text-secondary` | `#0000008c` | `#fff9` |
| `--nt-text-tertiary` | `#0000004d` | `#ffffff4d` |
| `--nt-text-onbrand` | `#000` | `#fff` |
| `--nt-border-neutral-l1` | `#00000012` | `#ffffff14` |
| `--nt-border-neutral-l2` | `#0000001a` | `#ffffff1f` |
| `--nt-border-neutral-l3` | `#00000026` | `#ffffff29` |
| `--nt-modal-backdrop` | `#0006` | `#0009` |
| `--nt-danger-surface-l1` | `#e74c3c1f` | 同 |
| `--nt-success-surface-l1` | `#22b35f1f` / `#25b9651f` | 同 |

**Accent 色系**（每色一组 `xxx` + `xxx-surface`）：`amber #f2a93a`、`blue #7b8fff`、`coral #ff8a7a`、`cyan #4ccbff`、`lime #a3e05a`、`rose #f06a9b`、`slate #c3cce0`、`teal #3bc7b8`、`violet #bfa5ff`。

**规格档位：**
- 圆角：`4 / 6 / 8 / 12 / 16 / 9999px`（`--radius-sm/md/lg/xl/2xl/full`）。
- 字号：`11 / 12 / 13 / 14 / 16 / 18px`，正文主力 **13–14px**。
- 高度：`h-7`=28（密集工具条）、**`h-8`=32（主档）**、`h-9`=36、`h-10`=40、`h-12`=48。
- 字重：400 / 500 / 600 / 700；字体栈以 `-apple-system, BlinkMacSystemFont, "PingFang SC", "Inter", "Noto Sans SC"` 为主，标题有 `--font-hero`（Helvetica Neue Condensed Italic）。
- 响应式两套并存：Tailwind v4 `--breakpoint-b640:640px`、`--breakpoint-b992:992px`、`--breakpoint-desk:600px`，与手写 `@media (min-width:1024/1280/1440/1600/1920/2240px)` 混用。
- 图标：**Iconify**（`class="iconify iconify--libtv"`，自有 `libtv:` 集 + 远程 `lucide:`），主力尺寸 18px，内联 SVG，**不是 lucide-react**。

### 4.3 画布专用令牌（`--canvas-*`，对我们项目最有参考价值）

```css
/* 深色（:root / .dark） */
--canvas-bg:#141414;              --canvas-bg-dot:#474747;
--canvas-node-bg:#191e26;         --canvas-node-border:#363636;
--canvas-node-border-selected:#a8a8a8;
--canvas-handle:#86909c;          --canvas-handle-bg:#1e1e1ee6;
--canvas-edge:#86909c;            --canvas-edge-hover:#c0c8d0;   --canvas-edge-selected:#e0e4e8;
--canvas-controls-bg:#262626;     --canvas-controls-border:#363636;
--canvas-controls-text:#fff;      --canvas-controls-text-muted:#919191;
--canvas-controls-hover:#ffffff1a;--canvas-controls-active:#ffffff26;
--canvas-minimap-bg:#1f1f1fe6;    --canvas-minimap-node:#525252;
--canvas-primary-btn-bg:#ffffffe6;--canvas-primary-btn-icon:#141414;
--canvas-selection-bg:#ffffff0f;  --canvas-group-bg:#ffffff1a;
--canvas-shadow-panel:0px 2px 5px #00000026;
--canvas-shadow-dropdown:0px 4px 10px #00000040,0px 2px 4px #0000004d;
--canvas-shadow-menu:0 8px 32px #00000026,0 2px 8px #0000001a;

/* 浅色（.canvas-light） */
--canvas-bg:#f5f5f5;              --canvas-bg-dot:#dedede;
--canvas-node-bg:#fff;            --canvas-node-border:#e3e3e3;
--canvas-controls-bg:#fff;        --canvas-controls-text:#262626;
--canvas-controls-hover:#0000000d;--canvas-controls-active:#00000014;
--canvas-shadow-panel:0px 2px 5px #00000014;
```

React Flow 桥接（浅色显式映射，深色靠 JS 加 `.dark-theme`）：

```css
.canvas-light .react-flow{
  --xy-background-color:var(--canvas-bg);
  --xy-background-pattern-color:var(--canvas-bg-dot);
  --xy-node-background-color:var(--canvas-node-bg);
  --xy-node-border-color:var(--canvas-node-border);
  --xy-edge-stroke:var(--canvas-edge);
  --xy-selection-background-color:var(--canvas-selection-bg)}
```

节点/分组：`.react-flow__node-group{border-radius:20px}`，故事板分组改 4px；节点 `:focus{outline:none!important}`。

> ⚠️ **它自己踩的坑**：`--bg-canvas`(#f2f3f5/#171717)、`--canvas-bg`(#f5f5f5/#141414)、`--nt-bg-canvas`(#f5f5f5/#1a1a1a) 是**同一语义的三套不同值**。新代码极易取错。

---

## 5. 按钮设计（用户重点关注）

### 5.1 总体结论

**主力按钮不是 antd，也不是 Mantine，而是「Tailwind 工具类 + `nt-*` 语义令牌」手写组合。** 全 CSS 里没有一条 `.ant-btn` 规则。

### 5.2 真实按钮 class（直接摘录自 SSR DOM）

**① 侧边栏一级导航行（幽灵按钮）**
```
group/row data-[expanded]:bg-nt-bg-overlay-active dark:data-[expanded]:bg-nt-bg-float-glass-l1
cursor-pointer hover:bg-nt-bg-overlay dark:hover:bg-nt-bg-float-glass-l2
flex h-8 w-full items-center gap-2 rounded-[6px] px-2
```
→ 无底色，**32px 高 / 6px 圆角 / 8px 内边距**；hover 浅 `#0000000a`、深 `#1f1f1fbf`；展开态用 `data-[expanded]` 属性选择器。

**② 侧边栏主 CTA「新建项目」（品牌按钮，深浅自动反相）**
```
bg-nt-invert dark:bg-nt-bg-brand
hover:bg-nt-bg-invert-hover dark:hover:bg-nt-bg-brand-hover
shrink-0 cursor-pointer transition-colors duration-150 ease-out
flex h-8 w-full items-center gap-2 rounded-[6px] px-2
```
→ 浅色 = 黑底白字；深色 = **青底 `#13d5ff` 黑字**；过渡统一 `150ms ease-out`。

**③ 通用主按钮（invert 风格，带按压缩放）**
```
bg-nt-bg-invert text-nt-text-onbrand hover:bg-nt-bg-invert-hover active:bg-nt-bg-invert-active
flex h-9 w-full cursor-pointer items-center justify-center rounded-[10px] px-3
transition-colors duration-150 ease-out active:scale-[0.97]
motion-reduce:transition-none motion-reduce:active:scale-100
```
→ 36px 高 / 10px 圆角；**按下缩到 0.97**，且用 `motion-reduce:` 尊重系统减弱动效偏好。

**④ 胶囊主按钮（关注 / 提交）**
```
bg-nt-bg-invert text-nt-text-onbrand hover:bg-nt-bg-invert-hover
flex h-8 min-w-[60px] cursor-pointer items-center justify-center
rounded-full px-2.5 text-[13px] leading-5 backdrop-blur-[2px]
disabled:cursor-default disabled:opacity-60
```

**⑤ 次级胶囊（点赞）**
```
flex h-9 min-w-20 shrink-0 cursor-pointer items-center justify-center gap-0.5
rounded-full px-3 text-sm leading-[22px] transition-colors
bg-nt-bg-overlay text-nt-text-default hover:bg-nt-bg-overlay-hover
```

**⑥ 纯图标按钮（分享）**
```
flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center gap-0.5
rounded-full text-sm transition-colors bg-nt-bg-overlay hover:bg-nt-bg-overlay-hover
```

**⑦ 带描边图标按钮（展开侧边栏）**
```
border border-nt-border-neutral-l1 hover:bg-nt-bg-overlay text-fg-default
flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg
```

**⑧ 完全无底色的内联按钮（「查看创作过程」）**
```
inline-flex cursor-pointer border-0 bg-transparent p-0 text-inherit
```

**⑨ 大型入口卡（新建画布创作）**
```
text-fg-default dark:border-nt-border-neutral-l3 bg-nt-bg-overlay-hover dark:bg-nt-bg-overlay
dark:hover:bg-nt-bg-overlay-hover hover:bg-nt-bg-overlay-active
h-[160px] w-full overflow-hidden rounded-xl border-[0.5px] text-[18px]
transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-55
```

**⑩ 画布工具条按钮（SCSS Module，`pictureEdit`）**
```css
.toolBtn{width:32px;height:32px;color:var(--canvas-controls-text);border-radius:8px;
  display:flex;align-items:center;justify-content:center;transition:background-color .15s}
.toolBtn:hover,.toolBtnActive{background:var(--canvas-controls-hover)}
.toolBtn:disabled{opacity:.4;pointer-events:none}

/* 画布主按钮用「文字色做底、控件底色做字」，深浅自动反相 */
.confirmBtn{background:var(--canvas-controls-text);color:var(--canvas-controls-bg);
  width:32px;height:32px;border-radius:8px;transition:opacity .15s}
```

### 5.3 变体速查表

| 变体 | 底色 | 文字 | 尺寸 |
|---|---|---|---|
| Primary（品牌 CTA） | 浅 `#2c2c2c` / 深 `#13d5ff` | `--nt-text-onbrand` | h-8 / h-9 / r6 / r10 |
| Primary（品牌淡底） | `#13d5ff14` | `#13d5ff` | 同 |
| Secondary（胶囊） | `bg-nt-bg-overlay` | `--nt-text-default` | h-9 / r-full / px-3 |
| Ghost（导航行 / 工具条） | 透明 | `--nt-text-default` | h-8 / r6 / px-2 |
| Icon-only | 透明或 `overlay` | `--nt-icon-default` | 32×32 或 36×36 |
| Outline（画布） | 透明 + 1px 边框 | `--canvas-controls-text` | h-8 / r-full |
| Danger | `#E74C3C]/[0.12]` | `#E74C3C` | h-8 / r-lg |
| Card 入口 | `overlay` 系 | `--nt-text-default` | h-160 / r-xl |

### 5.4 状态与交互约定

- **hover 值一共 4 套，用哪套取决于所在区域**：`--nt-bg-overlay`、`--nt-bg-overlay-hover`、`--canvas-controls-hover`、以及 `hover:bg-black/5 dark:hover:bg-white/10`。
- **禁用**：统一 `opacity:.4 ~ .55` +（SCSS 侧）`pointer-events:none` / `cursor-not-allowed`。
- **另一套约定（支付/弹窗模块）**：hover **不换色**，而是 `opacity:.7~.9` 或 `filter:brightness(1.15)`。
- **过渡**：`transition-colors duration-150 ease-out`（Tailwind 侧）/ `transition:background-color .15s`（SCSS 侧）——**统一 150ms**。
- ⚠️ **可访问性缺口**：全局存在 `button:focus-visible{outline:none!important}`，把 Mantine 的焦点环也一起压掉了。仅少数页面（如画布打开失败页）自己补了 `outline:2px solid #fff`。

---

## 6. 功能是怎么实现的

### 6.1 技术栈指纹【已确认】

| 维度 | 结论 |
|---|---|
| 框架 | **Next.js 16.3.4**（App Router + RSC + Server Actions），构建器 **Turbopack** |
| 运行时 | React 19 形态（`react.transitional.element`、`useEffectEvent`）；另有 1 份 React 18 形态副本并存 |
| 语言/工程 | TypeScript、pnpm（`node_modules/.pnpm/`） |
| UI 库 | **antd 5.27.5** + **Mantine** |
| 样式 | **Tailwind CSS v4** + SCSS Modules + tailwind-merge/clsx |
| 状态 | **zustand 4.5.7 + immer 10.2.0** |
| 请求 | **axios** + 自研 `SDService`（`baseURL: /api/www`） |
| i18n | 自研 `translate("ns:key")`（**冒号命名空间**），已备 zh/en/ko/ja，**仅启用 zh**；`canvas` 命名空间 5511 条、`common` 2642 条 |
| 画布引擎 | **@xyflow/react（React Flow v12）**；**无** konva/fabric/pixi/leafer |
| 富文本 | **TipTap + ProseMirror + Yjs**（多人协同编辑） |
| 视频 | **Media Chrome**（Web Components）+ **hls.js 1.6.15** + 原生 `<video>` |
| Agent | **CopilotKit + AG-UI 协议** + 自研 **`wss://im.liblib.tv/ws`** |
| 监控 | 阿里云 ARMS RUM + 火山引擎采集 + 自研 `insight.liblib.art`（无 Sentry） |
| 部署 | K8s（`china-liblibtv-prod-*:3000`，≥3 副本）+ **Istio/Envoy** + 阿里云 WAF |
| PWA | `/manifest.json` + 图片缓存 SW `/image-cache-sw.js`（非离线 App SW） |

### 6.2 画布：React Flow + 业务域化节点

- 引擎 `@xyflow/react`：JS 里可命中 `HandleConfigProvider`、`MiniMap`、`Controls`、`BezierEdge`、`EdgeRenderer`、`NodeRenderer`；CSS 有 `.react-flow__node`、`.react-flow__node-group`。
- 节点不是通用组件，而是**业务域化**的：生成器节点（文本/图片/视频/音频/角色/脚本）、组节点（视频组、分镜组）、参考节点。
- **打组 → 整组执行**是核心生产力设计：分镜组（≤25 张图）一键批量生视频，生成「视频生成器组」后整组跑。

### 6.3 AI 生成：Schema 驱动的模型参数表单【重要发现】

模型参数不是硬编码表单，而是一份可声明的 JSON Schema，前端按 `component` 字段渲染控件：

```json
{"displayName":"生成时长",
 "enum":[{"value":5,"displayName":"5s"},{"value":8,"displayName":"8s"}],
 "default":5,"originalField":"duration","component":"singleButton"}

{"displayName":"自动校验素材",
 "tips":"开启后自动校验素材合规性，提升真人视频生成成功率；非真人生成可关闭，跳过检测节省耗时。",
 "default":1,"component":"switch"}

{"displayName":"风格",
 "enum":[{"value":"general","displayName":"通用"},{"value":"anime","displayName":"动漫"}],
 "component":"singleButton"}
```

**含义**：新增一个模型 = 后端下发一份 Schema，前端无需改代码。这是它模型数量能快速膨胀（`50+ 顶尖模型聚合`）的工程前提。

已知模型：`Seedance 2.5`、`Seedance 2.0`、`Wan 3.0`、`Minimax H3 Max`、`3D-BOX Model Pro`；能力标记如 `全能参考`、`多镜头`、`高品质模式`、`动作控制`。

**Seedance 专属合规链路**（值得注意的产品设计）：真人素材必须先过审 —— `complianceCheckPassed` / `未检测到真人，可用于Seedance视频生成` / `核验已过期，请重新核验`；还有独立路由 `/seedance-verify`（输入 Task ID 走火山方舟官方只读接口核验，明确声明「不重新生成、不消耗算力、不产生任何费用」）。

### 6.4 Agent：协议、通道与工具集

- **框架**：CopilotKit 客户端（`CopilotKit`、`CopilotKitCore`、`AgentRegistry`、`ProxiedCopilotRuntimeAgent`），runtime 自报 `version: 1.52.0`，注册了 `canvasAgent`（`className: "CanvasAgent"`）。
- **协议**：**AG-UI**（`RUN_STARTED / RUN_FINISHED / RUN_ERROR / TEXT_MESSAGE_* / TOOL_CALL_* / CUSTOM`），支持 SSE 文本与 **protobuf**（`application/vnd.ag-ui.event+proto`）两种序列化。
- **主通道**：自研 WebSocket `wss://im.liblib.tv/ws?projectId=...&agent_name=...`，封装 `ChatWebSocket`（`onReconnecting / onReconnected`，重连后 `initSessions()` 做断线补偿）。**全站 0 处 `EventSource`**，SSE 仅作 fetch + ReadableStream 兜底。
- **Agent 工具集**（成功判定表里可见）：`ask_human`、`request_feedback`、`write_file`、`analyze_media`、`nodes_connections_batch`。
  - `ask_human` / `request_feedback` → 会话内反问用户，支持单问题与 `questions[]` 多问题、`multiple` 多选、`allowCustom`、`imagePicker`、`approval`。
  - `write_file` → 操作项目虚拟文件系统（`/api/canvas/folder/vfs/read`、`vfs/script/write`、`vfs/script/diff`、`vfs/draft/push`）。
  - `nodes_connections_batch` → **批量在画布上建节点和连线**（Agent 直接「画」画布）。
- **Agent 路由提示词**（产品设计亮点）：每个入口链接都带一段写给模型的「能力路由」指令。例如「剧本原创与改编」入口注入的提示词大意是：
  > 「用户希望创作原创剧本……本环节只做剧本文本创作。**请路由到剧本创编能力，仅产出剧本，不要触发分镜画面或视频生成。**」

  这样同一个 Agent 在不同入口表现出不同「人格」和边界，而不需要多个模型。
- **对外接入**：Remote MCP `https://mcp.liblib.tv/mcp`，OAuth 回调白名单里出现 `claude.ai` / `claude.com` / `chatgpt.com`；另有 CLI 与 Blender 插件。
- **Agent 专用算力**：`/api/task/generation/power/calculator4agent`、`/api/task/agent-task/{budget,modes,yield/release}` —— 给 Agent 单独设计了**算力预算**与**让出（yield）**机制。
- 人工确认模式：`POST /api/canvas/session/approval-mode/update`（对应版本日志里的「Agent 运行过程中切换自动/手动模式」）。

### 6.5 资产与上传

阿里云 OSS 直传（STS v3 + 分片预签名）：
```
POST /gateway/oss-server-api/oss-service/api/sts/v3
POST /gateway/oss-server-api/oss-service/api/oss/pre-sign/multipart/init
POST /gateway/oss-server-api/oss-service/api/oss/pre-sign/multipart/complete
```
图片走 OSS 处理参数：`?x-oss-process=image/resize,w_400,m_lfit/format,webp` —— **自动转 WebP + 限宽**。

### 6.6 接口与域名

- 业务 API：`https://api2.liblib.art`；网关前缀 **`/api/`（475 条去重字面量）** 与 **`/gateway/<service>/...`**（微服务聚合）。
- Agent 通道：`wss://im.liblib.tv`；MCP：`https://mcp.liblib.tv/mcp`。
- 静态/CDN：`liblibai-web-static.liblib.cloud`；图片：`liblibai-online.liblib.cloud`、`libtv-res.liblib.art`。

### 6.7 性能与首屏

- SSR + 流式渲染（RSC flight），`x-middleware-rewrite: /zh` 做 locale 重写。
- 79 个 JS chunk（未压缩合计 7.9 MB），按路由/功能强拆分。
- 字体：Inter variable + Pretendard variable，`font-display:swap` + `unicode-range` 分片。

---

## 7. 对我们项目的可借鉴点

结合本项目 `AGENTS.md` 的画布 UI 规范，以下几条最值得直接借用：

1. **语义令牌 + 明暗成对定义**。它把 `bg-/text-/icon-/border-/overlay-/glass-` 都做成成对令牌（212 个），业务代码只写 `bg-nt-bg-overlay hover:bg-nt-bg-overlay-hover`，绝不出现 `dark ? A : B`。这正是我们「不要硬编码黑白、不要写 `dark ? ...` 分支」的目标形态。
2. **画布控件 hover 用极低透明度叠加**：`--canvas-controls-hover: #0000000d / #ffffff1a`，且**禁用态用 `opacity:.4 + pointer-events:none`**，不换色。与我们「扁平无底色 + 轻微 hover 反馈」的规范一致，可以直接对齐数值。
3. **hover 值的「四套体系」是反面教材**。同一个站点并存 `--nt-bg-overlay`、`--canvas-controls-hover`、`hover:bg-black/5` 四种写法，加上 `--bg-canvas`/`--canvas-bg`/`--nt-bg-canvas` 三个同义不同值的令牌，是明显的历史债。我们应坚持单一来源。
4. **模板即入口**：把「最近上新」做成带 `sourceProjectUuid` 的模板复制入口，而不是静态 Banner。这是低成本把官方最佳实践分发出去的办法。
5. **Schema 驱动的模型参数面板**：模型参数下发为 JSON（`component: switch | singleButton | enum`），前端零改动接入新模型。如果我们后续要接多个模型，这个结构值得抄。
6. **按下反馈用 `active:scale-[0.97]` + `motion-reduce:`** —— 小成本提升质感，且尊重无障碍偏好。
7. **必须避开它的可访问性坑**：不要写全局 `button:focus-visible{outline:none!important}`。
8. **协作跟随模式**（跟随某人视角、正在定位、已停止跟随）是画布协作里体验很好的小功能，实现成本不高。
9. **Agent 入场路由提示词**：与其做多个 Agent 人格，不如在入口 URL 里带 `agent_mode` + 一段边界说明，让同一个 Agent 收敛行为。

---

## 8. 风险与注意事项

1. **⚠️ 公开 JS 包里存在明文密钥**（第三方站点问题，仅作提示，未做任何利用）：
   - `.../chunks/1_k4whmuzjive.js` 中可直接搜到 `clientSecret:"FSW3jGFOde0u7omrLVhKFbhJc8NOjBgX"` 与 `jwtSecret:"a1b9c4..."`。
   - 打包进前端等于已公开，建议对方尽快轮换。**我们自己的项目不要犯同样的错**：本项目的 AI API Key 也存在浏览器本地（见 `AGENTS.md`），需要在文档里持续写清安全边界。
2. **sitemap 严重过期**，若做竞品监控不要依赖它。
3. **未确认项**（需登录/交互才能看）：`/canvas` 内部真实布局与完整工具栏、`插件与扩展` 下拉菜单项、`/blender` 正文、Mantine 与 `@xyflow/react` 的精确版本、3D 高斯泼溅的具体实现。
4. 本报告所有页面均为**未登录**视角；登录后可能还有个人中心、团队空间、算力订单等未覆盖页面（`/team`、`/profile`、`corporate-pay`、`statement` 等路由存在但未展开）。

---

## 9. 界面截图

图片存放在 `docs/reference/libtv-shots/`（均未登录状态、深色默认主题，宽度已压到 1200px）。

| 文件 | 页面 |
|---|---|
| [libtv-home.jpg](./libtv-shots/libtv-home.jpg) | 首页：新建画布创作 + 模型/功能入口行 + 最近上新 + TV Show 流 |
| [libtv-project.jpg](./libtv-shots/libtv-project.jpg) | 项目：顶栏操作 + 空态 + 登录失败弹窗 |
| [libtv-assets.jpg](./libtv-shots/libtv-assets.jpg) | 资产：微信扫码登录墙 |
| [libtv-show.jpg](./libtv-shots/libtv-show.jpg) | TV Show：11 个分类 Tab + 作品网格 |
| [libtv-academy.jpg](./libtv-shots/libtv-academy.jpg) | 学院：大师公开课 + 学习广场 |
| [libtv-box3d.jpg](./libtv-shots/libtv-box3d.jpg) | 3D-BOX：输入卡与品牌色「生成」按钮 |
| [libtv-detail.jpg](./libtv-shots/libtv-detail.jpg) | 作品详情：播放器 + 作者 + 描述 + 精选推荐 |

---

## 10. 复现方法

```bash
# 1) 首页 SSR HTML
curl -sS --compressed -A "Mozilla/5.0 ... Chrome/154.0.0.0 Safari/537.36" \
  https://www.liblib.tv/ -o raw.html

# 2) 提取并下载 CSS / JS chunk（务必 --compressed，服务端强制 gzip）
grep -o 'href="https://[^"]*\.css"' raw.html | sed 's/href="//;s/"$//' | sort -u > css.list
while read -r u; do curl -sS --compressed "$u" -o "css/$(basename "$u")"; done < css.list

# 3) 独立无头浏览器渲染 + 截图（独立 profile，不影响已开窗口）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir=/tmp/probe/p --window-size=1440,2600 \
  --virtual-time-budget=12000 --screenshot=out.png "https://www.liblib.tv/show"

# 4) 路由状态码批量探测
for u in project assets canvas skill plugin; do
  echo "$(curl -sS -o /dev/null -w '%{http_code}' https://www.liblib.tv/$u)  /$u"
done
```

调研原始产物（临时目录，可能被清理）：`/tmp/liblib-probe/`（`raw.html`、`css/`、`js/`、`shots/`、`i18n.json`、三份分项报告 `findings/*.md`）。

---

## 11. LibTV 1.5 实测与「往上靠」对齐清单（2026-10-03 追加）

### 11.1 目标定调（产品负责人原话）

> 「我认为**同是网页工具，libtv 能做到的，我们应该也能往上靠**」

即：**LibTV 的能力面就是我们的对齐目标**。下列清单按「1.5 版已实测存在」逐条对照，作为后续工作包的输入。

### 11.2 LibTV 1.5（2026-09-20 更新）五大功能 —— 一手摘录与我们的差距

| LibTV 1.5 功能 | 官方描述（摘录） | 我们的对应 | 差距 |
| --- | --- | --- | --- |
| **剧本原创与改编** | 按题材/人设/背景辅助创作；对台词、冲突等**局部改写、对比确认**；**关联修改可提示对大纲、钩子与伏笔的影响**，由你决定是否同步调整 | 三段式剧本 `analyze→outline→script` | **无「改动影响提示」**（我们有 `impact.js` 但只覆盖生成链，不覆盖剧本层） |
| **导演执导** | 可选**预设导演**，或**导入自己的创作方法与提示词模板 → 生成「导演分身」**；辅助拆镜、创建节点、批量优化提示词；手动模式下**先审核计划、确认后再生成** | `skills/` + 编排器 | **无「导演分身」产品概念**（我们的技能是文件，不是可选/可导入的"导演"） |
| **角色造型室** ★ | 从人设、参考图或已有角色出发，**可视化调整五官、发型、服装**，细化痣/雀斑/疤痕等特征；**可关联音色、保存角色卡，在后续项目中继续调用** | 服化道自动出特写/三视图 + 自动绑定 AssetRef | **完全没有**：参考图是 LLM 一次生成后自动绑定，**不能人工调、不能跨项目复用、未关联音色** |
| **创意片头** ★ | 选一帧设计片名 + **文字动效** + **字幕识别与样式调整**；**口播视频支持自动粗剪、画中画、B-Roll 匹配、音效配乐**，并可继续修改 | `delivery.js`：concat/xfade + `amix` + 字幕烧录 + 封面 | **无片头/片名/文字动效**；**无自动粗剪**；**无画中画/B-Roll/音效配乐**；字幕只能烧录不能"识别+调样式" |
| **LibTV 3D-BOX** | 文字/参考图让 Agent 搭 3D 场景、安排角色动作与机位、完成多分镜预演；**手绘轨迹预演运镜** | — | 完全没有（最贵，最后做） |

其它实测（v1.0）：**深度动作捕捉**（一键提取视频深度信息做动作/运镜参考）、**宫格切分**（自定义分割线位置）。

### 11.3 「全流程在网页里做不做得到」—— 行业口径（关键结论）

**结论：网页工具做到「粗剪 + 自动装配 + 导出」就到位了；精剪交给剪映/达芬奇，这是行业通行分工，不是能力不足。**

三条独立证据：
1. **LibTV 官方教程**（B 站）标题即「手把手 **LibTV + Seedance2.5 + 即梦 + 剪映**」——标杆产品自己的流程也以剪映收尾。
2. **MiniMax Design 对比评测**的能力分档：「**Agent 自动完成剪辑、字幕、成片组装**」「画布内置剪辑链路，**可粗剪后导出达芬奇**」= 达标；「视频生成后需自行处理，**无自动成片装配**」= 未达标。
3. LibTV 自身页面地图（§2.2）**没有任何一条剪辑/时间线路由** —— 它的"剪辑"能力收敛为 1.5 的「自动粗剪（口播场景）+ 字幕 + 片头」，**没有精剪器**。

**因此边界应这样划**：

| 网页该做（可自动化） | 剪映该做（人的审美） |
| --- | --- |
| ① 片段生成（✅ 已有） | ① 卡点、节奏微调 |
| ② **自动粗剪 + 拼接转场**（❌ 缺） | ② 多轨混音精调 |
| ③ 字幕识别 + 烧录（部分有） | ③ 复杂转场/特效 |
| ④ **片头/片名/文字动效**（❌ 缺） | ④ 调色、风格统一 |
| ⑤ 封面 + 分集打包（✅ 有） | ⑤ 反复试看找感觉 |
| ⑥ **导出剪映素材包**（❌ 缺） | |

⚠️ **要点**：我们缺的**不是「剪映」**，而是**②④⑥ 这三段「把东西做到能被剪映接手」**。跳过它们直接把 17 个片段丢给剪辑师，等于让人手工对顺序/时长/字幕 —— 那才是真痛苦。

### 11.4 对齐优先级（建议，待产品负责人确认）

| 优先 | 做什么 | 理由 |
| --- | --- | --- |
| **1** | **自动粗剪 + 导出剪映素材包**（分集成片 + 分片原片 + SRT + FCPXML/EDL + 清单 JSON） | 成本最低、立刻消掉"手工对片段"的痛；补齐全流程的最后一棒 |
| **2** | **角色造型室**（参考图可视化改五官/发型/服装 + 角色卡跨项目复用 + 关联音色） | "同一个人"问题只解决了**自动锁**，没解决**可调整**；LibTV 差异化最强的一条 |
| **3** | **创意片头 + 字幕样式调整**（片名、文字动效、字幕样式） | 出片质感关键，成本不高 |
| **4** | 3D-BOX 预演运镜 / 深度动作捕捉 | 最贵，最后再说 |

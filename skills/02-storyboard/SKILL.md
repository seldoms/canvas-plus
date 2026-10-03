---
name: storyboard
description: |
  把剧本拆成可生成的分镜表。用于分镜拆解、镜头设计、景别与运镜规划、生图/生视频提示词编写，输出严格 JSON（shots）。当已有剧本产物、需要逐镜头的时长、景别、运镜、动作与提示词时使用。这是五段式流水线的第二段：分镜。
---

# 分镜：剧本 → 分镜表

每个镜头都要能被一次生成任务承接：一条主运镜、一个连续空间、一个明确的动作落点。不写"镜头愿望清单"。

> 方法论接管自 `skills/libraries/script-writing-studio`（04 AI 视频分镜 / 04b 运镜与动作戏），已做本地化接线：只吸收分镜字段方法、摄影机行为锁与连续性规则，剥离 Seedance 2.0 / 豆包等云端平台参数与国内平台专属条款，遵守 `AGENTS.md`「内容创作规范」。逐条对照见 `skills/libraries/script-writing-studio-接线说明.md`。

## 内容创作红线（硬约束）

- **忠于剧本、不重写剧情**：分镜只做视听转译，不得改动剧本的人物动机、情节走向、结局、台词或尺度；不新增原著/剧本没有的人物、地点、事件。
- **不注入教化式结构**：不为了「更正向」而添加惩罚、和解、升华或情感落点镜头；结局形态由剧本决定。
- **风险只提示、不改稿**：可以识别政策、平台规则、年龄分级、IP 授权等风险，但只能作为独立提示（项目层 `reviewNotes[]`）交给用户，**绝不写进本阶段 JSON、绝不为规避风险改稿**。
- **质量校验照做**：镜头能否被一次生成接住、`prompt` 能否直接生图、连续性是否成立，属工艺要求，照常校验，与内容审查无关。

## 输入

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `script` | 是 | 上游剧本产物（对象，编排器会序列化后填入模板） |
| `novel` | 否 | 小说原文，用于补充剧本丢失的细节 |
| `title` | 否 | 项目标题 |

## 输出契约

只返回一个 JSON 对象，字段名固定：

```json
{
  "episodes": [
    { "id": "ep1", "sceneIds": ["sc1"] }
  ],
  "shots": [
    {
      "id": "sh1",
      "episodeId": "ep1",
      "sceneId": "sc1",
      "index": 1,
      "durationSec": 4,
      "shotSize": "中景",
      "camera": "固定机位，平视，人物居中偏左",
      "cameraSpec": {
        "position": "subject-front-right",
        "height": "chest",
        "angle": "15deg-up",
        "lens": "50mm",
        "aperture": "f2.8",
        "focus": { "from": "door", "to": "face", "atSec": 2.2 },
        "movement": { "type": "dolly", "direction": "forward", "speed": "slow", "stabilization": "steady" }
      },
      "action": "人物推门进屋，停在桌边",
      "dialogue": "本镜实际说出的台词（有人开口必填）；确无对白为空字符串",
      "audio": "环境音与配乐说明（无对白时在此说明原因）",
      "textOverlays": [
        { "text": "本镜画面上要渲染的确切文字（中文原样）", "kind": "sign", "position": "文字在画面里的位置与载体", "style": "字体/颜色/材质/新旧" }
      ],
      "prompt": "英文生图提示词（画上文字用引号原样夹进来）",
      "negativePrompt": "英文负向提示词"
    }
  ]
}
```

- `sceneId` 必须引用剧本里已存在的场次 id。
- `episodeId`：**本镜所属的集 id**，必须原样来自剧本阶段 `episodes[].id`（如 `ep1`），**不得自造、不得写 `第1集` / `1` 这类自造序号**；剧本侧写得越准越好（服务端在绑项目时会把 `ep1` 归一到项目权威 id `ep_0001`，但源头写对才不靠兜底）。每个镜头都必须带 `episodeId`；剧本只有一集或未分集时，写剧本给出的那一个集 id，不得留空。
- `episodes[]`（顶层，随产物回带「集 → 场次」映射）：`{ "id": <剧本 episodes[].id>, "sceneIds": [<剧本 scenes[].id>...] }`，必须与剧本 `episodes[].sceneIds` 一致，不得新增剧本没有的场次；这是服务端把镜头归位到集、并回填 `episodes[].shotIds` 的依据。
- `prompt` / `negativePrompt` 用英文，供生图与生视频模板的 `PROMPT` token 直接使用。
- `textOverlays`：本镜画面上**要渲染的确切文字**清单，逐条列明中文原样字样；每条含 `text` / `kind` / `position` / `style` 四键，`kind` 取 `sign` | `ticket` | `screen` | `logo` | `subtitle` | `none`。**画面里任何文字都必须逐字列明，绝不允许留空让模型自行发挥**；确无文字时显式写 `[{"text":"","kind":"none","position":"","style":""}]`。详见「提示词模板 → 八」。
- `dialogue`：**镜头里有人开口说话就必须填**（哪怕听不见声音也要逐字记下，声画对齐与口型都依赖它）；确无对白写空字符串并在 `audio` 里说明。
- 单镜时长默认 3~6 秒；超过 8 秒的镜头要拆成两条。
- `camera`（字符串，**旧字段，继续可读**）：给人工阅读与旧下游兼容的机位长描述，保留不变。
- `cameraSpec`（对象，**新写入目标**）：结构化机位，字段固定为 `position / height / angle / lens / aperture / focus{from,to,atSec} / movement{type,direction,speed,stabilization}`；字段语义与取值风格见「七、结构化摄影机」。
- **硬规则**：`cameraSpec` 缺失或不完整时，**不得宣称机位已被工具可靠执行**，只能作为风险提示（QC warning）上报；结构化字段不得静默丢失。旧 `camera` 字符串与 `cameraSpec` 冲突时以 `cameraSpec` 为准。

## 提示词模板

你是分镜师。把下面的剧本拆成逐个镜头的分镜表；产物会逐级喂给本地短剧流水线（服化道、关键帧、片段合成），每个字段都要能被直接消费。

项目标题：{{title}}

剧本 JSON：
<script>
{{script}}
</script>

### 一、创作底线（不可违反）

1. 忠于剧本：分镜只做视听转译，不重写剧情主线、不改台词、不新增原著/剧本没有的人物、地点、事件或结局；剧本写什么就拍什么。
2. 不注入教化式结构：不为了「更正向」「更完整」而添加惩罚、和解、升华或情感落点镜头；结局形态由剧本决定。
3. 风险只提示、不改稿：识别到的审核、IP、年龄分级风险不得写进任何字段，也不得为规避风险改稿；本阶段只输出下面的 JSON。
4. 只转译、不创作：遇到剧本的情绪断点或信息缺口，不得自行编造剧情，只能用可见的调度与细节补齐「怎么拍」，不改变「发生了什么」。

### 二、镜头切分（每镜 = 一个可独立生成的单元）

1. 一个镜头只承接一次生成任务：一条主运镜、一个连续空间、一个明确的动作落点；不写「镜头愿望清单」。
2. 按场次顺序拆镜头，`sceneId` 必须来自剧本中的 `scenes[].id`；`index` 从 1 起全局递增。
3. 切点落在情绪转折点或动作完成点；一个完整情绪转折 / 完整戏剧动作 = 一组可独立生成的镜头，对应剧本 `scenes[].beats`。
4. 抽象必须转译成可拍：心理、时间、决心、暧昧等抽象描述一律变成摄影机拍得到的具象动作或细节（如「内心崩溃」→「指节发白、杯沿出现细裂、环境声渐弱」），不允许抽象、文学、心理描写直接进入字段。
5. 镜头密度服务基调：平实对白戏密度低、动作 / 高张力戏密度高；每个节拍至少一个能承担情绪的镜头，不为凑数加无功能镜头（删掉后情绪 / 动作仍成立 → 删除）。

### 三、字段落位（库的分镜字段如何折进本阶段契约）

库里的分镜强调「机位 / 运镜 / 景深 / 光影 / 限制 / 衔接」等要素，但本阶段 JSON 契约固定，**除结构化对象 `cameraSpec`、分集锚点 `episodeId`（以及顶层 `episodes[]` 集→场映射）外不得再新增字段**。按下列落位把方法论写进去：

1. `shotSize`：景别（远景 / 全景 / 中景 / 近景 / 特写 / 超特写）。
2. `camera`：**旧字段，继续可读**，给人工阅读的机位长描述。写「机位 + 运镜行为锁 + 焦段 / 光圈 / 景深焦点」。机位禁止只写「仰拍近景」这类抽象术语，必须写清摄影机在哪、离谁多远、高度在哪、拍谁（如「摄影机位于女主正前方偏右 15°，胸口高度，向上仰拍她抬头的脸，近景」）。运镜写清方向、速度、稳定度与起止状态，固定镜头也写「固定在哪里、看向哪里、禁止推拉摇移」。同字段内一并写清焦段（长焦 / 标准 / 广角 / 微距）、光圈与景深、焦点起点与落点。
2b. `cameraSpec`：**新写入目标**，把 `camera` 里的同一台机位拆成可校验的结构化字段（见「七、结构化摄影机」）；`camera` 与 `cameraSpec` 必须描述同一台机位，冲突时以 `cameraSpec` 为准。
3. `action`：主体动作 / 表情，写可见的表演过程（眼神、眨眼、嘴部、呼吸、肩颈、手部、身体重心的变化），不写情绪标签；情绪要有阶梯，强情绪不能第一帧直接满格，除非剧本明确爆发；动作戏写「起手 → 接触点 → 受力结果 → 反应 → 段末状态」。
4. `dialogue`：只放本镜头实际说出的台词，并带语气 / 音量 / 语速线索。**镜头里只要有人开口说话就必须填，不得留空**——哪怕这一镜听不见声音（隔窗 / 远景 / 只做口型）也要逐字记下，声画对齐与口型一致性都依赖它；确无对白（如空镜、纯动作镜）才写空字符串，并在 `audio` 里说明「本镜无对白」。**台词正文与括号表演注解分开写**：正文是纯台词，`（）`（或 `()【】[]`）里的是**给人看的表演提示**（语气 / 音量 / 语速 / 情绪），**括号注解不参与生产参数**——音色与语速由显式配置决定，TTS 只消费正文；例如 `去哪儿？（低声、语速慢）` 只会合成「去哪儿？」，「语速慢」只作人工 / 口型参考的线索，不得指望它把语音真的拖慢。
4b. `textOverlays`：本镜画面上**要渲染的确切文字**清单（见「八、画上文字与对白」）；这是分镜阶段的职责，必须在本阶段就逐字给出，不得留给关键帧阶段自行发挥。
5. `audio`：只写本镜的环境音与关键同步音效（不写 BGM 编排，BGM 交给后期）；当 `dialogue` 为空时要在此说明无对白的原因。
6. `prompt`：英文，结构为 主体外观 + 服装 + 场景 + 动作 + 构图景别 + 光线氛围 + 画质词；人物外观必须与剧本 `characters[].appearance` 一致；不写 Midjourney 尾参（`--ar/--style/--s/--no`）、不写 Seedance / 豆包参数、不写画幅与分辨率（尺寸由流水线模板的 `WIDTH/HEIGHT` 决定）。
7. `negativePrompt`：英文，覆盖 多手多指、面部畸变、文字水印、低清、过曝，以及本镜的空间 / 连续穿帮禁止项。
8. `id` / `episodeId` / `sceneId` / `index` / `durationSec`：结构字段，规则见下方校验规则。

### 四、光影（可执行，不写形容词）

`camera` 与 `prompt` 里的光影必须可执行：写清光源来源与方向（窗光 / 台灯 / 霓虹 / 路灯 / 屏幕光 / 门缝光，从左前 / 右后 / 顶部 / 背后 / 侧面进入）、亮区与暗区、脸部受光、轮廓光 / 背景分离、色温与明暗反差；不写「电影感 / 高级光影 / 氛围感」。如剧本时段与项目风格光影冲突，以剧本真实光源为准。

### 五、限制与人群（双向写清）

1. `negativePrompt` 承载禁止项；`camera` / `action` 对必须保持的角色外观、道具、光线、姿态做正向锁定（保持什么 + 禁止什么）。
2. 私密空间或剧本没有第三人：明确禁止出现额外人物、路人、群演。
3. 公共空间启用群众：写清路人不看镜头、不挡主角脸和关键动作、不同脸复制；不要把「空无一人」当作默认状态覆盖剧本。

### 六、时长与连续性（对齐本地生成约束）

1. `durationSec` 取 3~6；动作复杂或含台词的镜头可到 8，超过 8 必须拆镜。本流水线视频 `LENGTH` 走 `17n+5` 帧 @24fps 网格（5s≈124 帧），按上述整数秒写即可，不要写云端配额（如 15s 单段、单批 2 段）。
2. 相邻镜头要连续：轴线、视线、动作、物件、景别跳跃不要错乱；同一场次内人物位置、道具状态、光线方向要能对上上一镜。
3. 每个镜头在 `action` 收尾写一句「段末可见状态」（本镜结束时角色姿态 / 视线 / 道具 / 镜头方向），供下一镜承接；跨场次要能看出场景与时间的变化。

4. **每镜时长必须从模型档位里取（D1 硬约束，2026-10-03 产品拍板）**：`durationSec` 不是自由数字，必须属于**当前视频模型（模板清单里的时长档位）**。H3 系只有 `5 / 10 / 15` 三档（模型声明的档位帧数 `24×秒+3` 见模板清单 `durationMeta.frameCounts`；**实际提交 ComfyUI 的 `LENGTH` 仍按本条第 1 款的帧网格吸附**，两者口径不同）。**先定每集骨架（= 某档位值，如 15s），再往槽位里填内容**：同一集所有镜头 `durationSec` 之和**必须恰好等于该集骨架**；缺一段 / 超一段都要显式报出「还缺/超出多少秒」（由编排器 `validateSkeleton` 落到分镜阶段 `warnings` 与 `skeleton` 字段），**严禁先写内容、再让时长随意膨胀**。档位从后端接口动态取（`GET /api/providers` 的模板 `durations` 字段，或 `GET /api/durations?template=<视频模型>`），**不在前端或本技能里硬编码**；档位为 `null` 表示该模型未查证，此时按 3~6 秒经验值写并标注「档位待查证」。

### 七、结构化摄影机（cameraSpec，新写入目标）

除保留给人工阅读的 `camera` 字符串外，每个镜头都要同时输出结构化机位对象 `cameraSpec`，把「机位 / 高度 / 角度 / 焦段 / 光圈 / 焦点 / 运镜」翻译成可校验的独立字段，供视频 Tool 逐项映射；取值风格为小写英文 token，角度带 `deg` 后缀（对齐 §11.5.2 的 `shotCamera` 示例）：

1. `position`：摄影机相对主体的方位（如 `subject-front-right`、`behind-left`、`over-shoulder-right`），禁止抽象术语。
2. `height`：摄影机高度（`ground` / `waist` / `chest` / `eye` / `overhead`）。
3. `angle`：俯仰角（平视写 `level`，其余如 `15deg-up` / `30deg-down`）。
4. `lens`：焦段（`24mm` 广角 / `50mm` 标准 / `85mm` 长焦 / `macro`）。
5. `aperture`：光圈（如 `f1.8` / `f2.8` / `f8`）。
6. `focus`：焦点对象，含起点 `from`、落点 `to`、切换时间 `atSec`（秒）；不需要跟焦时 `from` = `to`。
7. `movement`：运镜对象，含 `type`（固定 `static` / `dolly` / `pan` / `tilt` / `crane` / `handheld`）、`direction`（`forward` / `backward` / `left` / `right` / `none`）、`speed`（`slow` / `medium` / `fast`）、`stabilization`（`steady` / `subtle` / `handheld`）；固定镜头写 `type: "static"` 且 `direction: "none"`。

硬约束：

1. `cameraSpec` 与 `camera` 必须描述同一台机位，不得互相矛盾；有冲突时以 `cameraSpec` 为准。
2. **结构化字段缺失时，不得宣称机位已被工具可靠执行**：只能作为风险提示（项目层 `reviewNotes[]` / QC warning）上报，不得静默丢失，也不得用「已按机位生成」一类措辞掩盖。
3. 服务端目前尚未把这些字段拆分、校验并映射到视频 Tool 的独立参数；在其完成映射或明确「不支持」之前，任何「机位已生效」的结论都只能标记为风险，不得当作已验证事实。

### 八、画上文字（textOverlays）与对白（dialogue）（硬规则）

**这一镜画面上该出现什么字，必须在本阶段就定死**——关键帧阶段只会逐字照抄，不会替你补字。你不给确切字样，出图里的站牌 / 车牌 / 车票 / 屏幕就会变成「MH 00 000」这类伪文字与乱码。因此每个镜头都必须输出 `textOverlays` 数组。

**字段形状**：`textOverlays: [{ text, kind, position, style }]`，每条四个键一个都不能少：

- `text`：**要渲染的确切文字**，中文原样给出、用引号包住（如 `"老城南路公交站"`、`"3路"`、`"末班车"`）。**不得翻译、不得改写、不得只写 `a sign` / `站名` / `一块招牌`**；同一屏有多行文字就分条列清，或把多行写进同一条 `text`。
- `kind`：`sign` | `ticket` | `screen` | `logo` | `subtitle` | `none`。站牌 / 招牌 / 路牌 = `sign`；车票 = `ticket`；显示屏 / 手机屏 = `screen`；商标 = `logo`；字幕 = `subtitle`；**确无文字 = `none`**。
- `position`：文字在画面里的位置与载体（如「画面左上方的公交站牌主标题」）。
- `style`：字体 / 颜色 / 材质 / 新旧（如「白底黑体、边缘轻微锈蚀」）。

**硬规则（不可违反）**：

1. 这一镜画面上任何要出现的文字——公交站牌名、车票字样、线路号、目的地显示屏、店铺招牌、路牌、手机屏幕内容、字幕——都**必须逐条列明要渲染的确切文字**，中文原样给出、用引号包住。
2. **绝不允许留空让模型自行发挥**：不得翻译 / 改写 / 只写「a sign」「一块招牌」这类泛指，不得只写「站名」「有块牌子」。
3. 确实没有任何文字的镜头（如空镜、纯风景），必须**显式写 `kind: "none"`** 并在 `audio`（或 `action`）里说明原因（如「空镜，画面无任何文字载体」），**不得省略 `textOverlays` 字段**。
4. `textOverlays` 里每一条 `text` 都要在 `prompt` 里用引号原样引用（中文原样保留、**不翻成英文**）；「写什么」和「画在哪、什么字体」都要给全。

**对白硬规则**：镜头里只要**有人开口说话**，就必须填 `dialogue`（逐字台词 + 语气 / 音量 / 语速线索），**不得留空**——哪怕这一镜听不见声音（隔窗 / 远景 / 只做口型），声画对齐与口型一致性都依赖它；确无对白（空镜、纯动作镜）才写空字符串，并在 `audio` 里说明「本镜无对白」。**括号注解是给人看的表演提示，不参与生产参数**：台词正文与括号注解分开写（正文 = 纯台词，`（）`/`()【】[]` 内 = 语气 / 音量 / 语速 / 情绪提示），生产链只消费正文、注解仅作人工 / 口型参考；语速、音色一律由显式配置决定，注解里的「语速慢 / 快」不得当作 TTS 参数。

**完整示例（有站牌的镜头）**：

```json
{
  "id": "sh7",
  "sceneId": "sc3",
  "index": 7,
  "durationSec": 4,
  "shotSize": "中景",
  "camera": "摄影机位于女主正前方偏右 15°，胸口高度，平视，固定机位，看向站牌与人脸",
  "cameraSpec": {
    "position": "subject-front-right",
    "height": "chest",
    "angle": "level",
    "lens": "50mm",
    "aperture": "f2.8",
    "focus": { "from": "sign", "to": "face", "atSec": 2.0 },
    "movement": { "type": "static", "direction": "none", "speed": "slow", "stabilization": "steady" }
  },
  "action": "她把车票捏在指尖、抬头看向站牌，嘴唇轻动念出站名",
  "dialogue": "老城南路……等着我。（低声、略带鼻音、语速偏慢）",
  "audio": "环境音：远处车流与站台广播底噪；本镜有对白",
  "textOverlays": [
    { "text": "老城南路公交站", "kind": "sign", "position": "画面左上方的蓝白公交站牌主标题", "style": "白底黑体、边缘轻微锈蚀" },
    { "text": "3路", "kind": "sign", "position": "站牌右下角的线路号", "style": "红底白字、略褪色" },
    { "text": "3路 末班车", "kind": "ticket", "position": "她手里捏着的纸质车票票面", "style": "白底黑字、针式打印字体" }
  ],
  "prompt": "统一视觉方向，自然光，干净画面。Exactly one person, a young woman in a faded denim jacket standing beside an old city bus stop, a worn bus stop sign reading \"老城南路公交站\" with route number \"3路\" printed in its lower right corner, a paper bus ticket in her hand showing \"3路 末班车\", overcast afternoon light, medium shot.",
  "negativePrompt": "extra fingers, deformed face, text watermark, lowres, overexposed"
}
```

**拼法要点**：`prompt` 里用 `a worn bus stop sign reading "老城南路公交站" with route number "3路" printed in its lower right corner`、`a paper bus ticket in her hand showing "3路 末班车"` 把 `textOverlays` 的三条字样**原样夹进画面描述**；中文原样保留、不要翻成英文。确无文字的镜头写 `[{"text":"","kind":"none","position":"","style":""}]`。

### 九、输出

1. 按场次顺序输出，`index` 全局递增，`id` 只允许 `[A-Za-z0-9_-]`。
2. 只输出下面结构的 JSON 本体，字段名不得改动，不要 Markdown 代码块、不要解释文字：

{"episodes":[{"id":"ep1","sceneIds":["sc1"]}],"shots":[{"id":"sh1","episodeId":"ep1","sceneId":"sc1","index":1,"durationSec":4,"shotSize":"中景","camera":"","cameraSpec":{"position":"","height":"","angle":"","lens":"","aperture":"","focus":{"from":"","to":"","atSec":0},"movement":{"type":"","direction":"","speed":"","stabilization":""}},"action":"","dialogue":"","audio":"","textOverlays":[{"text":"","kind":"none","position":"","style":""}],"prompt":"","negativePrompt":""}]}

### 十、分集锚点（episodeId 与 episode.sceneIds）（硬规则）

1. 剧本阶段已经给出 `episodes[]`（每集有 `id` 与 `sceneIds`）。**每个镜头都必须带 `episodeId`**，值原样取自剧本 `episodes[].id`——脚本写 `ep1` 就写 `ep1`，**不得自造**（不得写 `第1集` / `1` / `episode1` 这类别名，也不得留空）。服务端会在绑项目时把剧本侧集号归一到项目权威 id（`ep1` → `ep_0001`），但源头写对才不依赖兜底。
2. 顶层同时回带 `episodes[]`（`{ "id": <剧本集 id>, "sceneIds": [<该集场次 id>...] }`），必须与剧本 `episodes[].sceneIds` 一致：**只准搬运，不准新增 / 删减场次**。这是服务端把镜头归位到集、并回填 `episodes[].shotIds` 的唯一依据。
3. 归位自检：每个镜头的 `sceneId` 必须落在其 `episodeId` 对应集的 `sceneIds` 里；同一场次的镜头必须落在同一集，**不允许跨集漂移**。剧本只有一集或未分集时，全部镜头归属那一个（唯一）集。
4. 集号缺失或与剧本不一致**不阻断本阶段产出，但必须产生 QC warning**（服务端会按镜头顺位兜底，绝不静默丢弃）；自检发现的错位要在 `stage.warnings` 里可追。

## 校验规则

- 顶层必须是对象且含 `shots` 数组，`shots` 至少 1 条。
- `shots[].id` 唯一且只允许 `[A-Za-z0-9_-]`；`sceneId` 必须存在于上游 `script.scenes`。
- 每个 shot 必须含 `episodeId`，且其值必须命中上游 `script.episodes[].id`；缺失 / 自造（`第1集` / `1` / `episode1`）一律 QC warning，不得静默丢弃（服务端会按镜头顺位兜底归一到真实集 id，`ep1` → 项目侧 `ep_0001`）。
- 顶层建议含 `episodes[]`（每集 `{ id, sceneIds }`），必须是上游 `script.episodes[]` 的忠实搬运（不新增 / 不删减场次）；缺 `episodes` 或与剧本不一致时产生 QC warning。
- `index` 为正整数且严格递增，不允许跳号导致排序歧义。
- `durationSec` 为 1~8 的数字；`shotSize`、`camera`、`action` 非空。
- `camera`（旧字符串）保留可读且非空；`cameraSpec`（新写入目标）应含 `position` / `height` / `angle` / `lens` / `aperture` / `focus` / `movement` 七项，`focus` 至少含 `from` / `to`，`movement` 至少含 `type`。
- `cameraSpec` 缺失或不完整**不阻断本阶段产出，但必须产生 QC warning**：不得宣称机位已被工具可靠执行，不得静默丢失。
- 每镜必须含 `textOverlays` 数组；每条含 `text` / `kind` / `position` / `style` 键，`kind` 取 `sign` / `ticket` / `screen` / `logo` / `subtitle` / `none`。画面里出现的文字（站牌、车票、线路号、招牌、路牌、屏幕、字幕等）必须逐条列出**确切文字**（中文原样）；缺键 / 为 `null` / 画面有文字却写成 `kind: "none"` 一律 QC warning，不得静默丢失；确无文字时必须显式 `kind: "none"` 并在 `audio` 说明原因。
- 镜头里有人开口说话时 `dialogue` 不得为空（确无对白写空字符串并在 `audio` 说明），否则产生 QC warning。
- `prompt` 非空且为英文；`negativePrompt` 允许为空但建议填写。
- 只输出 JSON 本体。解析失败由编排器重试一次，再失败整步标记 `error`。

## 工具

| 接口 | 用途 |
| --- | --- |
| `POST /api/pipeline/runs/:id/steps/storyboard/run` | 由编排器执行本阶段 |
| `POST /api/pipeline/runs/:id/steps/storyboard/input` | 人工修订分镜产物，body `{ "output": { "shots": [...] } }` |
| `POST /api/generate/image` | 用单条镜头的 `prompt` 试拍，模板 `img_*`，参数 `PROMPT` `WIDTH` `HEIGHT` `SEED` |
| `GET /api/jobs/:id` | 轮询试拍任务 |
| `ANY /v1/*` | 透传内网 LLM，用于人工改写单条镜头 |

产物落盘：`data/runs/<runId>/storyboard.json`。

## 已知边界（编排器行为，勿踩）

- 编排器（`canvas-server/src/pipeline.js` 的 `readPromptTemplate` → `extractSection`）只把本文的 **`## 提示词模板`** 一节发给模型；其余章节是给人 / Agent 看的，不会进模型上下文。所以**新方法论必须写进「提示词模板」**（用 `###` 子标题，不会被 `^##\s` 截断），写在外面的章节约等于没写。
- 本阶段由 `pipeline.js` 的 `composeWithLlm` **单次调用**（不分块）；`## 内容创作红线（硬约束）` 目前仅 01 剧本阶段的分块路径会抽取注入，本阶段该节主要供人 / Agent 阅读，硬约束同时逐条写进了「提示词模板 → 一、创作底线」。
- 产出契约（`shots[]` 的文字 / 结构字段（含 `textOverlays` 与本次新增的分集锚点 `episodeId`）+ 结构化对象 `cameraSpec` + 顶层 `episodes[]` 集→场映射）与校验规则由 `pipeline.js` 与 `registry.json`（`produces: "storyboard"`）共同执行。**旧 `camera` 字符串继续保留可读，`shots[]` 的既有字段名与结构不得改动**（下游 `04-keyframes` 读 `storyboard.shots[]`，`05-clip-assembly` 也依赖 `shots[].prompt` / `shots[].action`，改动会连挂）；`cameraSpec` 为本次新增的结构化写入目标，服务端尚未拆分、校验或映射到视频 Tool 的独立参数——在映射完成或明确「不支持」之前，缺失字段只能产生 QC warning，不得宣称机位已被可靠执行、不得静默丢失。`textOverlays` 为本次新增的**画上文字契约字段**，`04-keyframes` 已改为从 `storyboard.shots[].textOverlays` 逐字消费拼进生图 `prompt`；服务端解析 / 校验尚未接线，在映射完成前该字段缺失或不合规只能产生 QC warning，不得静默丢弃、也不得在关键帧阶段自行编字。
- 本阶段方法论只影响内容与结构；`prompt` / `negativePrompt` 已按本地 ComfyUI 文生图 / 文生视频模板的 `PROMPT` token 形态书写，不引入 Midjourney 尾参、Seedance 参数或任何云端平台专属格式；尺寸与帧数由模板参数（`WIDTH/HEIGHT/LENGTH`，H3 宽高为 32 的倍数）统一决定，不写进 prompt。

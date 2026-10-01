# 踩坑清单（调试期逐条验证）

按默认锚点规则执行时注意以下陷阱。用户显式指定人物/场景设定时以其为准，但陷阱本身仍然成立。

## 人数失控
场景未声明人数时 AI 自行加人（海滩多出第三人）。→ 场景先声明空无一人/只有两人，再写 exactly two people 锁定；动物入镜把动物写进人数声明。

## 表情跑偏
裸写「喊/叫」（shouting/crying）被画成痛苦迷茫。→ 必须写反锁表述：laughing, mouth open, eyes squeezed shut with joy。

## 日式场景不像日本
只写 Japanese / Japan 无效，出美式街景。→ 必须给实物锚点：noren with kanji "湯" / vintage vending machine / utility poles and wires silhouetted / narrow Kyoto alley。

## 性别混排易糊
男女同框时性别特征互相污染。→ 女生写 short shoulder-length hair，男生写 clearly male short-haired，双锚点同时给。

## 动作母题用滥
并肩漫步、回眸、骑车、打盹是大众母题，出片同质化。→ 母题必须自研：从「两个人之间一件具体的小事」里造（如分食喂猫、递水壶不看人、裙摆兜花瓣）。

## 否定式措辞失效
正文里的 no / not / without 权重异常，常反向生效。→ 否定只放 --no 尾参；正文全部用肯定式表述（如「双脚穿鞋」而不是「没有光脚」）。

## 动态模糊污染主体
慢门/拖影类描述会把人物也糊掉。→ 明确写 1/100s shutter + subject tack-sharp，动态模糊只点名给环境元素（motion blur only in the grass / petals soft）。

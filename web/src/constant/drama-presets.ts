/**
 * 规划参数（Plan）预置选项 —— 单一来源。
 *
 * 这些文案会作为创作上下文注入剧本 / 分镜 / 资产阶段的提示词，因此 `value` 一律写成
 * **可直接进提示词的中文短语**（如「治愈温情」「二维动画」），不做 i18n 翻译——翻译会破坏下游提示词。
 * 组件只负责渲染，禁止在组件里内联选项数组。
 *
 * 维度对应契约 §3.1 的 Plan：genre / tone / visualStyle / dramaMode / audience / ratio。
 */

/** 预置项：value 直接进提示词；hint 是给用户看的一句可选提示，不作为值下发。 */
export type DramaPresetOption = {
    value: string;
    hint?: string;
};

/** 带 i18n 标签的预置项（比例这类固定值没有中文提示词含义，标签走 i18n）。 */
export type LabelledPresetOption = {
    value: string;
    labelKey: string;
};

/** 题材分组：labelKey 走 i18n，options 是分组内的预置项。 */
export type DramaPresetGroup = {
    labelKey: string;
    options: DramaPresetOption[];
};

/** 题材 genre：按现实向 / 幻想向 / 古风向 / 动画与偶戏分组，覆盖常见与新兴题材。 */
export const GENRE_PRESET_GROUPS: DramaPresetGroup[] = [
    {
        labelKey: "genreGroupRealistic",
        options: [
            { value: "都市", hint: "当代都市生活与情感" },
            { value: "家庭", hint: "家庭伦理与亲情" },
            { value: "职场", hint: "职场生存与商战" },
            { value: "校园", hint: "青春校园成长" },
            { value: "年代", hint: "特定年代的怀旧与变迁" },
            { value: "民国", hint: "民国乱世与家国情仇" },
            { value: "军事", hint: "军旅、战场与家国热血" },
            { value: "悬疑", hint: "悬念铺设与反转" },
            { value: "推理", hint: "本格推理与逻辑解谜" },
            { value: "犯罪", hint: "罪案、警匪与犯罪心理" },
            { value: "医疗", hint: "医疗行业与人性考验" },
            { value: "体育", hint: "竞技逆袭与团队成长" },
            { value: "乡土", hint: "乡村生活与地方风物" },
        ],
    },
    {
        labelKey: "genreGroupFantasy",
        options: [
            { value: "玄幻", hint: "东方玄幻与修炼体系" },
            { value: "奇幻", hint: "西式奇幻与冒险" },
            { value: "科幻", hint: "科幻未来与硬核设定" },
            { value: "末世", hint: "末世废土求生" },
            { value: "穿越", hint: "穿越时空的错位叙事" },
            { value: "重生", hint: "重生逆袭与改写命运" },
            { value: "异能", hint: "超能力与都市异能" },
            { value: "系统", hint: "系统流爽感与任务" },
            { value: "无限流", hint: "无限世界闯关" },
            { value: "游戏", hint: "游戏世界与电竞" },
        ],
    },
    {
        labelKey: "genreGroupHistorical",
        options: [
            { value: "古装", hint: "古装权谋与市井人情" },
            { value: "武侠", hint: "江湖侠义与恩怨" },
            { value: "仙侠", hint: "修仙问道与仙魔之争" },
            { value: "宫斗", hint: "宫廷权谋与后宫争斗" },
            { value: "宅斗", hint: "宅门内宅的明争暗斗" },
            { value: "历史", hint: "历史正剧与演义" },
            { value: "神话", hint: "神话传说与上古世界" },
        ],
    },
    {
        labelKey: "genreGroupAnimation",
        options: [
            { value: "动画", hint: "以动画形式讲述的故事" },
            { value: "儿童", hint: "面向儿童的成长故事" },
            { value: "童话", hint: "童话改编与寓言" },
            { value: "俳偶戏", hint: "以偶戏/人偶演绎的题材" },
        ],
    },
];

/** 主基调 tone：情绪与叙事质感，尽量全面。 */
export const TONE_PRESETS: DramaPresetOption[] = [
    { value: "热血", hint: "激情澎湃、节奏紧凑" },
    { value: "燃", hint: "高燃爆点与情绪点燃" },
    { value: "励志", hint: "逆境成长、正向鼓舞" },
    { value: "甜宠", hint: "甜蜜宠溺的情感线" },
    { value: "浪漫", hint: "细腻浪漫的情感氛围" },
    { value: "治愈", hint: "温暖抚慰、情绪安抚" },
    { value: "温情", hint: "真挚动人的情感" },
    { value: "温馨", hint: "轻松温暖的生活气息" },
    { value: "搞笑", hint: "喜剧节奏与笑点" },
    { value: "逗比", hint: "夸张搞怪的人物气质" },
    { value: "沙雕", hint: "无厘头式的荒诞搞笑" },
    { value: "无厘头", hint: "跳脱逻辑的喜剧风格" },
    { value: "轻松", hint: "低压、易看的下饭感" },
    { value: "爽感", hint: "打脸逆袭的爽点密集" },
    { value: "狗血", hint: "强冲突、强戏剧性" },
    { value: "虐心", hint: "情感拉扯与揪心" },
    { value: "悲情", hint: "悲剧色彩与宿命感" },
    { value: "暗黑", hint: "阴郁黑暗的底色" },
    { value: "压抑", hint: "沉重窒息的氛围" },
    { value: "压迫感", hint: "强张力、让人喘不过气" },
    { value: "紧张", hint: "高悬念与危机感" },
    { value: "悬疑", hint: "扑朔迷离、层层反转" },
    { value: "冷峻", hint: "克制、疏离的高级感" },
    { value: "神秘", hint: "未知与诡秘的氛围" },
    { value: "史诗", hint: "宏大叙事与厚重感" },
    { value: "荒诞", hint: "荒诞派与黑色幽默" },
    { value: "沉郁", hint: "低沉克制的情绪" },
];

/** 视觉呈现形式：与 genre 并列的独立维度，决定画面质感与生成方式。 */
export const VISUAL_STYLE_PRESETS: DramaPresetOption[] = [
    { value: "写实真人", hint: "真人实拍质感" },
    { value: "二维动画", hint: "2D 手绘/赛璐璐动画" },
    { value: "三维动画", hint: "3D 渲染动画" },
    { value: "定格动画", hint: "逐帧拍摄的停格质感" },
    { value: "俳偶戏", hint: "人偶/偶戏演绎" },
    { value: "像素风", hint: "复古像素画面" },
    { value: "水墨风", hint: "东方水墨写意" },
    { value: "剪纸", hint: "剪纸/皮影式的平面造型" },
    { value: "黏土", hint: "黏土/橡皮泥定格质感" },
    { value: "赛璐璐", hint: "日式赛璐璐上色" },
    { value: "手绘插画", hint: "手绘插画质感" },
    { value: "漫画分镜", hint: "漫画分格与线稿" },
    { value: "厚涂", hint: "厚涂笔触与质感" },
    { value: "日式动画", hint: "日系动画演出风格" },
    { value: "美式卡通", hint: "迪士尼/皮克斯式卡通" },
    { value: "低多边形", hint: "Low-Poly 几何块面" },
    { value: "仿胶片", hint: "胶片颗粒与复古色调" },
    { value: "黑白默片", hint: "黑白无声电影质感" },
];

/** 叙事取向 dramaMode：成片形态与镜头密度取向。 */
export const DRAMA_MODE_PRESETS: DramaPresetOption[] = [
    { value: "短剧向", hint: "竖屏短剧节奏，强钩子、快反转" },
    { value: "微电影向", hint: "单集完整叙事，不追求强节奏" },
    { value: "单元剧", hint: "每集独立成篇、可跳看" },
    { value: "连续剧", hint: "多集连续铺陈、长线叙事" },
];

/** 目标受众 audience：中性描述，不用平台价值观标签。 */
export const AUDIENCE_PRESETS: DramaPresetOption[] = [
    { value: "男性向", hint: "偏男性审美与叙事偏好" },
    { value: "女性向", hint: "偏女性审美与情感偏好" },
    { value: "全年龄", hint: "无特定年龄倾向" },
    { value: "青少年", hint: "面向青少年群体" },
    { value: "中老年", hint: "面向中老年受众" },
    { value: "儿童", hint: "面向儿童受众" },
    { value: "合家欢", hint: "适合全家共赏" },
    { value: "二次元向", hint: "面向二次元/ACG 受众" },
];

/** 画幅比例：弹窗与项目详情共用同一份清单。 */
export const RATIO_PRESETS: LabelledPresetOption[] = [
    { value: "9:16", labelKey: "ratioVertical" },
    { value: "16:9", labelKey: "ratioHorizontal" },
    { value: "1:1", labelKey: "ratioSquare" },
    { value: "4:3", labelKey: "ratioFourThree" },
    { value: "3:4", labelKey: "ratioThreeFour" },
    { value: "21:9", labelKey: "ratioWide" },
];

/**
 * 风格锚点范例（styleAnchor 保留自由输入，这几条只是一键填入的起点）。
 * 契约要求 styleAnchor 是全项目生图/生视频提示词首句、一字不差，因此写成完整短句。
 */
export const STYLE_ANCHOR_EXAMPLES: string[] = [
    "冷调赛博朋克，霓虹夜景，电影质感",
    "治愈系暖调，柔光，日系胶片",
    "东方水墨，留白写意，青绿山水",
    "暗黑哥特，强对比，冷峻阴郁",
    "二次元赛璐璐，明快高饱和，干净线条",
    "复古港风，暖黄霓虹，胶片颗粒",
];

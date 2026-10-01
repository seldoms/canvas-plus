/**
 * RunningHub 标准模型目录种子。
 *
 * 只保留本地 ComfyUI 跑不动或需要特定云模型的少量 endpoint，不做全量市场同步。
 * `id` 直接取 endpoint，这样 `config.runninghub.model.image` / `video` 里填的值可以直接匹配。
 * priceLabel 是定性档位，实际计费以 RunningHub 控制台为准。
 */
export const RUNNINGHUB_MODELS = {
    image: [
        {
            id: "z-image/turbo",
            name: "Z-Image Turbo 文生图",
            endpoint: "z-image/turbo",
            outputType: "image",
            priceLabel: "低价快速",
            description: "秒级出图，适合批量草稿与快速试色。",
        },
        {
            id: "seedream-v4.5/text-to-image",
            name: "Seedream 4.5 文生图",
            endpoint: "seedream-v4.5/text-to-image",
            outputType: "image",
            priceLabel: "标准价",
            description: "中文语义与画面细节较好，适合成品出图。",
        },
        {
            id: "rhart-image-v1/text-to-image",
            name: "RHart Image V1 文生图",
            endpoint: "rhart-image-v1/text-to-image",
            outputType: "image",
            priceLabel: "按次计费",
        },
        {
            id: "rhart-image-n-pro/text-to-image",
            name: "RHart Image N Pro 文生图",
            endpoint: "rhart-image-n-pro/text-to-image",
            outputType: "image",
            priceLabel: "按次计费",
        },
    ],
    video: [
        {
            id: "alibaba/wan-2.7/image-to-video",
            name: "Wan 2.7 图生视频",
            endpoint: "alibaba/wan-2.7/image-to-video",
            outputType: "video",
            priceLabel: "按秒计费",
            description: "首帧一致性好，常用图生视频。",
        },
        {
            id: "alibaba/wan-2.6/image-to-video-flash",
            name: "Wan 2.6 Flash 图生视频",
            endpoint: "alibaba/wan-2.6/image-to-video-flash",
            outputType: "video",
            priceLabel: "按秒计费（低价档）",
        },
        {
            id: "seedance-2.0-global-mini/image-to-video",
            name: "Seedance 2.0 Mini 图生视频",
            endpoint: "seedance-2.0-global-mini/image-to-video",
            outputType: "video",
            priceLabel: "按秒计费（低价档）",
        },
        {
            id: "rhart-video-g/image-to-video",
            name: "RHart Video G 图生视频",
            endpoint: "rhart-video-g/image-to-video",
            outputType: "video",
            priceLabel: "按秒计费",
        },
    ],
};

/**
 * 产物缩略图 URL —— 列表 / 卡片一律用小图，预览 / 下载仍用原图。
 *
 * 背景（一手实测）：`/api/artifacts/<jobId>/<filename>` 返回的是**原图**，
 * 单张 PNG 实测 **1,774,840 字节（1.7MB）**、一页 149 张 ≈ 250MB；
 * 产品负责人远程访问（4Mbps）时**第一张可见图要 23.9s** 才出现。
 *
 * 服务端 `?variant=thumb` 用机器上已有的 ffmpeg 生成 320px WebP 并落盘缓存
 * （同图实测 1,774,840 B → **4,644 B**，省 99.74%）。生成不了时服务端**回退原图**，
 * 所以这里失败也不会裂图。
 *
 * 只对**本网关产物 URL** 生效：非产物（本地 blob / dataUrl / 静态封面）原样返回，
 * 因此可以放心地在任何缩略图位置使用。
 */
const VARIANT = "variant=thumb";

export function isArtifactSrc(src?: string): boolean {
    return typeof src === "string" && src.includes("/api/artifacts/");
}

/**
 * 产物缩略图地址。非产物 URL / 空值原样返回；已是缩略图的不重复叠加。
 * @param src 产物地址（相对或已 resolve 的绝对地址均可）
 * @param width 可选宽度（服务端夹在 64–640，默认 320）；不传则用服务端默认
 */
export function artifactThumbSrc(src?: string, width?: number): string {
    if (!src || !isArtifactSrc(src) || src.includes(VARIANT)) return src ?? "";
    const [path, hash] = src.split("#");
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}${VARIANT}${width ? `&w=${width}` : ""}${hash ? `#${hash}` : ""}`;
}

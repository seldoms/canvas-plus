import { ImageOff } from "lucide-react";
import { useTranslation } from "react-i18next";

/** 「取不到图」的显式降级：不渲染 1×1 空白骗人，直接给出可读原因。 */
export function UnavailableImage({ reason, className }: { reason: string; className: string }) {
    const { t } = useTranslation();
    return (
        <div className={`flex flex-col items-center justify-center gap-1.5 bg-stone-100 px-3 text-center text-stone-500 dark:bg-stone-900 dark:text-stone-400 ${className}`}>
            <ImageOff className="size-6" />
            <span className="text-sm font-medium">{t("imageWorkbench.imageUnavailable")}</span>
            <span className="text-sm">{reason}</span>
        </div>
    );
}

/** 列表里的小缩略图：没有可用原图/缩略图时给图标占位，不再渲染 `src=""` 的破图。 */
export function ImageThumb({ src, alt, className }: { src?: string; alt: string; className: string }) {
    if (!src) {
        return (
            <span className={`flex items-center justify-center bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-500 ${className}`}>
                <ImageOff className="size-3.5" />
            </span>
        );
    }
    return <img src={src} alt={alt} className={className} />;
}

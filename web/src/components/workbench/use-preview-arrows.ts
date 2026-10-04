import { useEffect } from "react";

/**
 * 预览里 ↑/↓ 也切换同一个任务的其他素材（生图 / 视频共用）。
 *
 * antd `Image.PreviewGroup` 原生只认 ←/→（要成组才有），所以把 ↑/↓ 映射成一次等价的
 * ArrowLeft/ArrowRight 键盘事件派发给预览根节点（React 在根上做事件委托，冒泡即可命中它的处理函数）。
 * 预览没开时**不拦**，避免影响页面正常滚动。Esc 关闭由 antd 自带。
 */
export function usePreviewVerticalArrows() {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            const preview = document.querySelector(".ant-image-preview-wrap");
            if (!preview) return;
            event.preventDefault();
            preview.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: event.key === "ArrowUp" ? "ArrowLeft" : "ArrowRight",
                    bubbles: true,
                    cancelable: true,
                }),
            );
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, []);
}

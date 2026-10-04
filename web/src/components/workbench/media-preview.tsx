import { Modal } from "antd";
import { AudioLines, ChevronLeft, ChevronRight, Play } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/** 缩略图承载的素材类型：图片 / 视频 / 音频。 */
export type PreviewMediaKind = "image" | "video" | "audio";

export type PreviewMediaItem = {
    /** 组内唯一 id；同一素材重复渲染只注册一次。 */
    id: string;
    kind: PreviewMediaKind;
    src: string;
    /** 预览弹窗标题（一般是素材名 / 文件名）。 */
    title?: string;
};

type MediaPreviewGroupValue = {
    register: (item: PreviewMediaItem) => void;
    unregister: (id: string) => void;
    open: (id: string) => void;
};

const MediaPreviewGroupContext = createContext<MediaPreviewGroupValue | null>(null);

/**
 * 「同组素材」预览容器：把**同一项目 / 同一栏目（环节）**里输出的缩略图归为一组，
 * 点任意一张站内弹窗看大图 / 播视频 / 听音频；弹窗里 ←→↑↓ 切组内其它素材（↑↓ 是 ←→ 的别名），
 * Esc / 点遮罩关闭。分组粒度由调用方决定（一个工作区 / 一个角色分组 / 一条候选条 …）。
 *
 * 组件不渲染任何缩略图，只提供上下文 + 唯一的预览弹窗；缩略图由 `PreviewableMedia` 渲染。
 */
export function MediaPreviewGroup({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<PreviewMediaItem[]>([]);
    const [openId, setOpenId] = useState<string | null>(null);

    const register = useCallback((item: PreviewMediaItem) => {
        setItems((current) => {
            const index = current.findIndex((entry) => entry.id === item.id);
            if (index < 0) return [...current, item];
            const prev = current[index];
            if (prev.src === item.src && prev.kind === item.kind && prev.title === item.title) return current;
            const next = current.slice();
            next[index] = item;
            return next;
        });
    }, []);
    const unregister = useCallback(
        (id: string) => setItems((current) => (current.some((entry) => entry.id === id) ? current.filter((entry) => entry.id !== id) : current)),
        [],
    );
    const open = useCallback((id: string) => setOpenId(id), []);

    const value = useMemo<MediaPreviewGroupValue>(() => ({ register, unregister, open }), [register, unregister, open]);
    const index = openId ? items.findIndex((entry) => entry.id === openId) : -1;

    return (
        <MediaPreviewGroupContext.Provider value={value}>
            {children}
            <MediaPreviewModal items={items} index={index < 0 ? null : index} onSelect={setOpenId} onClose={() => setOpenId(null)} />
        </MediaPreviewGroupContext.Provider>
    );
}

/**
 * 可预览缩略图：**凡有 src 就能点开**（图片 / 视频 / 音频都支持）。
 * 放进 `MediaPreviewGroup` 时归入该组（←→↑↓ 切同组）；未放进分组时退化为自带单张预览弹窗。
 * 默认按 kind 渲染缩略图（图 <img> / 视频 <video muted> / 音频图标）；需要自定义外观时传 children。
 */
export function PreviewableMedia({
    id,
    kind,
    src,
    thumbSrc,
    title,
    className,
    children,
}: {
    id: string;
    kind: PreviewMediaKind;
    src?: string;
    /** 列表里显示的小图（服务端缩略图）；预览弹窗仍用 `src`（原图）。不传则用 `src`。 */
    thumbSrc?: string;
    title?: string;
    className?: string;
    children?: ReactNode;
}) {
    const group = useContext(MediaPreviewGroupContext);
    const [selfOpen, setSelfOpen] = useState(false);
    const item = useMemo<PreviewMediaItem | null>(() => (src ? { id, kind, src, title } : null), [id, kind, src, title]);

    useEffect(() => {
        if (!group || !item) return;
        group.register(item);
        return () => group.unregister(item.id);
    }, [group, item]);

    if (!item) return <>{children ?? null}</>;

    const trigger = () => (group ? group.open(item.id) : setSelfOpen(true));
    return (
        <>
            <button
                type="button"
                className={cn("block cursor-zoom-in", className)}
                onClick={trigger}
                title={item.title}
                aria-label={item.title}
            >
                {children ?? <DefaultThumb item={item} thumbSrc={thumbSrc} />}
            </button>
            {!group ? <MediaPreviewModal items={[item]} index={selfOpen ? 0 : null} onSelect={() => undefined} onClose={() => setSelfOpen(false)} /> : null}
        </>
    );
}

function DefaultThumb({ item, thumbSrc }: { item: PreviewMediaItem; thumbSrc?: string }) {
    const poster = thumbSrc || item.src;
    if (item.kind === "video") {
        // 列表里视频也用**静帧封面**（有缩略图就用图），不再让浏览器为一张卡去拉整段视频元数据；播放交给预览弹窗。
        return (
            <span className="relative block h-full w-full">
                {thumbSrc ? (
                    <img src={poster} alt={item.title || ""} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                    <video src={item.src} muted preload="metadata" playsInline className="h-full w-full object-cover" />
                )}
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
                    <Play className="size-1/4 min-h-4 min-w-4 text-white" fill="currentColor" />
                </span>
            </span>
        );
    }
    if (item.kind === "audio") {
        return (
            <span className="flex h-full w-full items-center justify-center bg-black/5 text-stone-400 dark:bg-white/5 dark:text-stone-500">
                <AudioLines className="size-1/3" />
            </span>
        );
    }
    return <img src={poster} alt={item.title || ""} loading="lazy" className="h-full w-full object-cover" />;
}

/**
 * 预览弹窗：站内 Modal（禁跳新页），图片自适应、视频/音频带原生控件。
 * ←→↑↓ 在组内循环切换，Esc / 点遮罩关闭；标题显示当前素材名，底部显示 序号/总数。
 */
function MediaPreviewModal({
    items,
    index,
    onSelect,
    onClose,
}: {
    items: PreviewMediaItem[];
    index: number | null;
    onSelect: (id: string) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const open = index !== null && index >= 0 && items.length > 0;
    const current = open ? items[index] : null;

    // 键盘：←→↑↓ 切同组（↑↓ 为别名）；用 ref 保住最新游标，监听器只挂一次。
    const stateRef = useRef({ items, index, onSelect });
    stateRef.current = { items, index, onSelect };
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const { items: list, index: cursor, onSelect: select } = stateRef.current;
            if (cursor === null || cursor < 0 || !list.length) return;
            const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
            const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
            if (!forward && !backward) return;
            event.preventDefault();
            const step = forward ? 1 : -1;
            const next = (cursor + step + list.length) % list.length;
            select(list[next].id);
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [open]);

    const go = (step: number) => {
        if (index === null) return;
        onSelect(items[(index + step + items.length) % items.length].id);
    };
    const many = items.length > 1;

    return (
        <Modal
            open={open}
            title={current?.title || undefined}
            footer={null}
            centered
            closable={false}
            destroyOnHidden
            width="min(960px, calc(100vw - 96px))"
            onCancel={onClose}
            styles={{ body: { padding: 0, background: "transparent" } }}
        >
            {current ? (
                <div className="relative flex items-center justify-center">
                    {current.kind === "image" ? (
                        // 响应式小窗（规范 §1.3）：长边留边距、按原始宽高比 contain 完整显示，绝不铺满整屏。
                        // 之前写死 max-h-[76vh] + 固定 960 宽，大图几乎占满屏；现在长边 70vh、宽不超视口−96px。
                        <img src={current.src} alt={current.title || ""} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain" />
                    ) : current.kind === "video" ? (
                        <video src={current.src} controls autoPlay playsInline className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md bg-black object-contain" />
                    ) : (
                        <audio src={current.src} controls autoPlay className="w-full max-w-md" />
                    )}
                    {many ? (
                        <>
                            <button
                                type="button"
                                className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white transition hover:bg-black/70"
                                aria-label={t("workbench.mediaPreview.previous")}
                                onClick={() => go(-1)}
                            >
                                <ChevronLeft className="size-5" />
                            </button>
                            <button
                                type="button"
                                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white transition hover:bg-black/70"
                                aria-label={t("workbench.mediaPreview.next")}
                                onClick={() => go(1)}
                            >
                                <ChevronRight className="size-5" />
                            </button>
                            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-0.5 text-xs text-white">
                                {(index ?? 0) + 1} / {items.length}
                            </span>
                        </>
                    ) : null}
                </div>
            ) : null}
        </Modal>
    );
}

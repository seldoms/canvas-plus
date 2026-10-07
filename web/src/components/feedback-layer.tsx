import { Button, Input, Tooltip } from "antd";
import { Copy, GripHorizontal, MessageSquarePlus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";

/**
 * 全局页面标注工具（调试用）：挂在 UserLayout，所有页面可用。
 * 右下角悬浮按钮 → 点开悬浮窗（可拖动）→ 开启标注模式后点击页面任意元素钉标记写意见；
 * 标注模式下**再点一次已钉位置（或编号钉）即取消该标记**。
 * 数据按页面路径分开存 localStorage；一键导出 Markdown 贴回对话。
 */

interface Pin {
    id: number;
    /** 元素描述：标签 + 关键类名 + 文本片段，够人和 AI 定位即可 */
    target: string;
    textSnippet: string;
    x: number;
    y: number;
    comment: string;
}

/** 点已钉位置多少像素内视为「再点一次取消」。 */
const TOGGLE_OFF_PX = 16;

function storageKey(pathname: string) {
    return `feedback-pins-v1:${pathname}`;
}

function describeElement(el: Element): { target: string; textSnippet: string } {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter((c) => c && !c.startsWith("dark:")).slice(0, 3).join(".");
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return { target: cls ? `${tag}.${cls}` : tag, textSnippet: text };
}

/** 从元素向上找一段可读路径（最多 4 层），用于导出时定位 */
function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && parts.length < 4 && node !== document.body) {
        const { target } = describeElement(node);
        parts.unshift(target);
        node = node.parentElement;
    }
    return parts.join(" > ");
}

function loadPins(pathname: string): Pin[] {
    try {
        const raw = localStorage.getItem(storageKey(pathname));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function FeedbackLayer() {
    const { pathname } = useLocation();
    const [open, setOpen] = useState(false);
    const [marking, setMarking] = useState(false);
    const [pins, setPins] = useState<Pin[]>(() => loadPins(window.location.pathname));
    const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
    const [draftId, setDraftId] = useState<number | null>(null);
    const [copied, setCopied] = useState(false);
    /** 悬浮窗位置（fixed 定位）；null = 默认右下角 */
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const dragRef = useRef<{ dx: number; dy: number } | null>(null);

    // 路由切换：载入该页面的标注，并退出标注模式
    useEffect(() => {
        setPins(loadPins(pathname));
        setMarking(false);
        setDraftId(null);
    }, [pathname]);

    useEffect(() => {
        try {
            localStorage.setItem(storageKey(pathname), JSON.stringify(pins));
        } catch {
            /* 忽略持久化失败 */
        }
    }, [pins, pathname]);

    const inLayer = useCallback((el: EventTarget | null) => el instanceof Element && Boolean(el.closest("[data-feedback-ui]")), []);

    const removePin = useCallback(
        (id: number) => {
            setPins((current) => current.filter((pin) => pin.id !== id));
            setDraftId((current) => (current === id ? null : current));
        },
        [],
    );

    useEffect(() => {
        if (!marking) {
            setHoverRect(null);
            return;
        }
        const onMove = (event: MouseEvent) => {
            if (inLayer(event.target)) {
                setHoverRect(null);
                return;
            }
            const el = event.target instanceof Element ? event.target : null;
            setHoverRect(el ? el.getBoundingClientRect() : null);
        };
        const onClick = (event: MouseEvent) => {
            if (inLayer(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            // 再点一次已钉位置 → 取消该标记（取距离最近的钉）
            let nearest: Pin | null = null;
            let nearestDist = Infinity;
            for (const pin of pins) {
                const dist = Math.hypot(pin.x - event.pageX, pin.y - event.pageY);
                if (dist < nearestDist) {
                    nearest = pin;
                    nearestDist = dist;
                }
            }
            if (nearest && nearestDist <= TOGGLE_OFF_PX) {
                removePin(nearest.id);
                return;
            }
            const el = event.target instanceof Element ? event.target : document.body;
            const { textSnippet } = describeElement(el);
            const pin: Pin = {
                id: Date.now(),
                target: cssPath(el),
                textSnippet,
                x: event.pageX,
                y: event.pageY,
                comment: "",
            };
            setPins((current) => [...current, pin]);
            setDraftId(pin.id);
            setOpen(true);
        };
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("click", onClick, true);
        return () => {
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("click", onClick, true);
        };
    }, [marking, pins, inLayer, removePin]);

    const updateComment = (id: number, comment: string) => {
        setPins((current) => current.map((pin) => (pin.id === id ? { ...pin, comment } : pin)));
    };

    const exportMarkdown = async () => {
        const lines = pins.map((pin, i) => {
            const comment = pin.comment.trim() || "（未填写）";
            return `${i + 1}. **${pin.textSnippet || pin.target}**\n   - 位置：\`${pin.target}\`\n   - 意见：${comment}`;
        });
        const text = `页面反馈（${pathname}，${pins.length} 条）：\n\n${lines.join("\n")}`;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            window.prompt("复制失败，请手动复制：", text);
        }
    };

    // 悬浮窗拖动（抓头部把手）
    const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
        const panel = (event.currentTarget as HTMLElement).closest("[data-feedback-panel]") as HTMLElement | null;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        const left = Math.min(Math.max(event.clientX - dragRef.current.dx, 0), window.innerWidth - 120);
        const top = Math.min(Math.max(event.clientY - dragRef.current.dy, 0), window.innerHeight - 60);
        setPos({ left, top });
    };
    const onDragEnd = () => {
        dragRef.current = null;
    };

    const pinMarkers = useMemo(
        () =>
            pins.map((pin, i) => (
                <button
                    key={pin.id}
                    type="button"
                    title={marking ? "再点一次取消这个标记" : pin.comment || pin.textSnippet || pin.target}
                    onClick={() => {
                        if (marking) {
                            removePin(pin.id);
                        } else {
                            setDraftId(pin.id);
                            setOpen(true);
                        }
                    }}
                    className={`absolute z-[9997] flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow ring-2 ring-white ${
                        marking ? "bg-red-500 hover:bg-red-600" : "bg-sky-600"
                    }`}
                    style={{ left: pin.x - 10, top: pin.y - 10 }}
                >
                    {i + 1}
                </button>
            )),
        [pins, marking, removePin],
    );

    return createPortal(
        <div data-feedback-ui>
            {/* 悬停高亮框 */}
            {marking && hoverRect ? (
                <div
                    className="pointer-events-none fixed z-[9998] rounded border-2 border-sky-500 bg-sky-400/10"
                    style={{ left: hoverRect.left - 2, top: hoverRect.top - 2, width: hoverRect.width + 4, height: hoverRect.height + 4 }}
                />
            ) : null}

            {/* 页面上的编号钉 */}
            {pinMarkers}

            {/* 悬浮按钮 */}
            <div className="fixed bottom-5 right-5 z-[9999]">
                <Tooltip title={open ? "收起标注工具" : "打开标注工具"}>
                    <button
                        type="button"
                        onClick={() => setOpen(!open)}
                        className={`relative flex size-11 items-center justify-center rounded-full shadow-lg transition-colors ${
                            marking ? "bg-red-500 text-white hover:bg-red-600" : "bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900"
                        }`}
                    >
                        <MessageSquarePlus className="size-5" />
                        {pins.length ? (
                            <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-sky-600 text-[10px] font-bold text-white ring-2 ring-white">
                                {pins.length}
                            </span>
                        ) : null}
                    </button>
                </Tooltip>
            </div>

            {/* 悬浮窗 */}
            {open ? (
                <div
                    data-feedback-panel
                    className="fixed z-[9999] flex max-h-[65vh] w-80 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900"
                    style={pos ? { left: pos.left, top: pos.top } : { right: 76, bottom: 20 }}
                >
                    <div
                        className="flex cursor-move items-center gap-2 border-b border-stone-200 px-3 py-2.5 dark:border-stone-700"
                        onPointerDown={onDragStart}
                        onPointerMove={onDragMove}
                        onPointerUp={onDragEnd}
                    >
                        <GripHorizontal className="size-4 shrink-0 text-stone-300" />
                        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">页面标注（{pins.length}）</span>
                        <button
                            type="button"
                            className="ml-auto shrink-0 text-stone-400 hover:text-stone-600"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => {
                                setOpen(false);
                                setMarking(false);
                            }}
                        >
                            <X className="size-4" />
                        </button>
                    </div>

                    <div className="border-b border-stone-100 px-3 py-2 dark:border-stone-800">
                        <Button
                            block
                            size="small"
                            type={marking ? "primary" : "default"}
                            danger={marking}
                            onClick={() => setMarking(!marking)}
                        >
                            {marking ? "退出标注模式" : "开始标注"}
                        </Button>
                        <p className="mt-1.5 text-center text-[10px] leading-4 text-stone-400">
                            {marking ? "点击元素钉标记；再点一次已钉位置取消" : "开启后点击页面任意元素写意见"}
                        </p>
                    </div>

                    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
                        {!pins.length ? <p className="mt-4 text-center text-xs leading-6 text-stone-400">还没有标记</p> : null}
                        {pins.map((pin, i) => (
                            <div key={pin.id} className="rounded-lg border border-stone-200 p-2.5 dark:border-stone-700">
                                <div className="flex items-center gap-2">
                                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-[10px] font-bold text-white">{i + 1}</span>
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700 dark:text-stone-200" title={pin.target}>
                                        {pin.textSnippet || pin.target}
                                    </span>
                                    <button type="button" className="shrink-0 text-stone-300 hover:text-red-500" onClick={() => removePin(pin.id)}>
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </div>
                                <div className="mt-1 truncate text-[10px] text-stone-400" title={pin.target}>{pin.target}</div>
                                <Input.TextArea
                                    size="small"
                                    autoSize={{ minRows: 2, maxRows: 5 }}
                                    placeholder="这里应该怎么改？"
                                    value={pin.comment}
                                    autoFocus={draftId === pin.id}
                                    onChange={(event) => updateComment(pin.id, event.target.value)}
                                    className="mt-2 text-xs"
                                />
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-2 border-t border-stone-200 p-2.5 dark:border-stone-700">
                        <Button block size="small" type="primary" disabled={!pins.length} icon={<Copy className="size-3.5" />} onClick={() => void exportMarkdown()}>
                            {copied ? "已复制，贴给 AI 即可" : "导出反馈"}
                        </Button>
                        <Button
                            size="small"
                            danger
                            disabled={!pins.length}
                            onClick={() => {
                                setPins([]);
                                setDraftId(null);
                            }}
                        >
                            清空
                        </Button>
                    </div>
                </div>
            ) : null}
        </div>,
        document.body,
    );
}

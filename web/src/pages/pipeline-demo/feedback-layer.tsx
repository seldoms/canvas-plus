import { Button, Input, Tooltip } from "antd";
import { Copy, MessageSquarePlus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 页面标注层（仅 demo 用）：开启后悬停高亮元素、点击钉标记写意见，
 * 侧边栏汇总，一键导出 Markdown 贴回对话。数据只存 localStorage。
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

const STORAGE_KEY = "pipeline-demo-feedback-v1";

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

function loadPins(): Pin[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function FeedbackLayer() {
    const [active, setActive] = useState(false);
    const [pins, setPins] = useState<Pin[]>(loadPins);
    const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
    const [draftId, setDraftId] = useState<number | null>(null);
    const [copied, setCopied] = useState(false);
    const layerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
        } catch {
            /* 忽略持久化失败 */
        }
    }, [pins]);

    const inLayer = useCallback((el: EventTarget | null) => el instanceof Element && Boolean(el.closest("[data-feedback-ui]")), []);

    useEffect(() => {
        if (!active) {
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
        };
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("click", onClick, true);
        return () => {
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("click", onClick, true);
        };
    }, [active, inLayer]);

    const updateComment = (id: number, comment: string) => {
        setPins((current) => current.map((pin) => (pin.id === id ? { ...pin, comment } : pin)));
    };
    const removePin = (id: number) => {
        setPins((current) => current.filter((pin) => pin.id !== id));
        if (draftId === id) setDraftId(null);
    };

    const exportMarkdown = async () => {
        const lines = pins.map((pin, i) => {
            const comment = pin.comment.trim() || "（未填写）";
            return `${i + 1}. **${pin.textSnippet || pin.target}**\n   - 位置：\`${pin.target}\`\n   - 意见：${comment}`;
        });
        const text = `流水线 demo 页面反馈（${pins.length} 条）：\n\n${lines.join("\n")}`;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            window.prompt("复制失败，请手动复制：", text);
        }
    };

    return createPortal(
        <div data-feedback-ui>
            {/* 悬停高亮框 */}
            {active && hoverRect ? (
                <div
                    className="pointer-events-none fixed z-[9998] rounded border-2 border-sky-500 bg-sky-400/10"
                    style={{ left: hoverRect.left - 2, top: hoverRect.top - 2, width: hoverRect.width + 4, height: hoverRect.height + 4 }}
                />
            ) : null}

            {/* 页面上的编号钉 */}
            {pins.map((pin, i) => (
                <button
                    key={pin.id}
                    type="button"
                    onClick={() => setDraftId(pin.id)}
                    className="absolute z-[9997] flex size-5 items-center justify-center rounded-full bg-sky-600 text-[10px] font-bold text-white shadow ring-2 ring-white"
                    style={{ left: pin.x - 10, top: pin.y - 10 }}
                >
                    {i + 1}
                </button>
            ))}

            {/* 开关按钮 */}
            <div className="fixed bottom-5 right-5 z-[9999]">
                <Tooltip title={active ? "退出标注模式" : "进入标注模式：点击页面任意元素写意见"}>
                    <Button
                        type={active ? "primary" : "default"}
                        icon={<MessageSquarePlus className="size-4" />}
                        onClick={() => setActive(!active)}
                    >
                        {active ? "标注中…" : `标注${pins.length ? `（${pins.length}）` : ""}`}
                    </Button>
                </Tooltip>
            </div>

            {/* 侧边栏 */}
            {active ? (
                <div ref={layerRef} className="fixed inset-y-0 right-0 z-[9999] flex w-80 flex-col border-l border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900">
                    <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-700">
                        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">页面反馈（{pins.length}）</span>
                        <button type="button" className="ml-auto text-stone-400 hover:text-stone-600" onClick={() => setActive(false)}>
                            <X className="size-4" />
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                        {!pins.length ? (
                            <p className="mt-6 text-center text-xs leading-6 text-stone-400">
                                点击页面上的任何元素钉一个标记，<br />然后在这里写修改意见。
                            </p>
                        ) : null}
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
                    <div className="border-t border-stone-200 p-3 dark:border-stone-700">
                        <Button block type="primary" disabled={!pins.length} icon={<Copy className="size-3.5" />} onClick={() => void exportMarkdown()}>
                            {copied ? "已复制，贴给 AI 即可" : "导出全部反馈"}
                        </Button>
                    </div>
                </div>
            ) : null}
        </div>,
        document.body,
    );
}

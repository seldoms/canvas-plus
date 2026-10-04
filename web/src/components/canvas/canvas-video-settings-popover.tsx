import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoModeLabel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultSizeFor, findTemplate, loadTemplateCatalog, sizeNoteFor, sizeOptionsFor, type GatewayTemplateInfo, type TemplateSizeOption } from "@/services/api/template-sizes";
import { useThemeStore } from "@/stores/use-theme-store";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

type CanvasVideoSizePicker = { options: TemplateSizeOption[]; value: string; pending?: boolean; note?: string } | null;

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    // 画布的视频尺寸**必须来自 GET /api/providers 的该模型 sizes**（禁硬编码、禁自由填）；
    // 网关不可达时保持空 → 退回旧控件，不阻塞画布。
    const [videoTemplates, setVideoTemplates] = useState<GatewayTemplateInfo[]>([]);
    useEffect(() => {
        let alive = true;
        void loadTemplateCatalog("video")
            .then((templates) => {
                if (alive) setVideoTemplates(templates);
            })
            .catch(() => {
                if (alive) setVideoTemplates([]);
            });
        return () => {
            alive = false;
        };
    }, []);

    const templateName = modelOptionName(config.model || config.videoModel || "");
    const template = useMemo(() => findTemplate(videoTemplates, templateName), [videoTemplates, templateName]);
    const sizeOptions = useMemo(() => sizeOptionsFor(template), [template]);
    const defaultSize = defaultSizeFor(template);
    // 当前 size 不在官方档内（含历史 auto / 超限档）→ 一次性落回该模型默认档，保证提交的是合法档。
    const committedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!sizeOptions?.length) return;
        if (sizeOptions.some((option) => option.value === config.size)) return;
        const target = defaultSize && sizeOptions.some((option) => option.value === defaultSize) ? defaultSize : sizeOptions[0].value;
        const key = `${templateName}:${target}`;
        if (committedRef.current === key) return;
        committedRef.current = key;
        onConfigChange("size", target);
    }, [sizeOptions, defaultSize, config.size, onConfigChange, templateName]);

    const sizePicker: CanvasVideoSizePicker = template
        ? { options: sizeOptions ?? [], value: sizeOptions?.some((option) => option.value === config.size) ? config.size : defaultSize ?? "", pending: !sizeOptions, note: sizeNoteFor(template) }
        : null;

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} sizePicker={sizePicker} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[220px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {videoResolutionLabel(config.vquality)} · {videoSizeLabel(config.size)} · {videoSecondsLabel(config.videoSeconds)} · {videoModeLabel(config.videoMode)}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
    sizePicker,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    sizePicker: CanvasVideoSizePicker;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" sizePicker={sizePicker} />
        </div>,
        document.body,
    );
}

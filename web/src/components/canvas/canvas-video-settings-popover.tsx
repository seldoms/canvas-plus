import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2, TriangleAlert } from "lucide-react";
import { Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { VideoSettingsPanel, videoModeLabel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultSizeFor, findTemplate, loadTemplateCatalog, adaptSizeForTemplate, sizeNoteFor, sizeOptionsFor, type GatewayTemplateInfo, type TemplateSizeAdjustment, type TemplateSizeOption } from "@/services/api/template-sizes";
import { useThemeStore } from "@/stores/use-theme-store";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

type CanvasVideoSizePicker = { options: TemplateSizeOption[]; value: string; pending?: boolean; note?: string; adjust?: TemplateSizeAdjustment | null } | null;

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    /**
     * 该视频节点**已连接的参考图真实像素**（来自上游图片节点的 naturalWidth/Height）。
     * 用于「画布比例 vs 参考图比例」不符时给出提示：147 的 first_frame 是**不保持比例直接拉伸**，
     * 比例不符必然变形。缺省（无参考图）→ 不提示，行为与旧版一致。
     */
    referenceSize?: { width: number; height: number } | null;
};

/** W×H → 最简画幅（"1024x768" → "4:3"）；非法返回 ""。 */
function aspectRatioLabel(width: number, height: number): string {
    if (!(width > 0) || !(height > 0)) return "";
    let a = Math.round(width);
    let b = Math.round(height);
    while (b) [a, b] = [b, a % b];
    const unit = a || 1;
    return `${Math.round(width / unit)}:${Math.round(height / unit)}`;
}

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft", referenceSize }: CanvasVideoSettingsPopoverProps) {
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
    // 旧的超限 / 非官方尺寸 → 按「同比例、上限内像素最大」自适应到合法档（与后端同口径）：
    // 提交前就把配置落成合法档；界面只展示最终值（规格下拉里选中它），调整明细用 Tooltip 表现，不堆解释性小字。
    const [sizeAdjust, setSizeAdjust] = useState<TemplateSizeAdjustment | null>(null);
    const committedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!sizeOptions?.length) return;
        if (sizeOptions.some((option) => option.value === config.size)) return;
        const adapted = adaptSizeForTemplate(template, config.size);
        const target = adapted && sizeOptions.some((option) => option.value === adapted.to) ? adapted.to : defaultSize && sizeOptions.some((option) => option.value === defaultSize) ? defaultSize : sizeOptions[0].value;
        const key = `${templateName}:${config.size}->${target}`;
        if (committedRef.current === key) return;
        committedRef.current = key;
        setSizeAdjust(adapted ? { ...adapted, to: target } : null);
        onConfigChange("size", target);
    }, [sizeOptions, defaultSize, config.size, onConfigChange, templateName, template]);

    const sizePicker: CanvasVideoSizePicker = template
        ? { options: sizeOptions ?? [], value: sizeOptions?.some((option) => option.value === config.size) ? config.size : defaultSize ?? "", pending: !sizeOptions, note: sizeNoteFor(template), adjust: sizeAdjust }
        : null;

    // 用户手动改规格 → 清掉「自动调整」提示（那是针对旧值的，改完就不适用了）。
    const changeConfig = (key: keyof AiConfig, value: string) => {
        if (key === "size") setSizeAdjust(null);
        onConfigChange(key, value);
    };

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

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={changeConfig} sizePicker={sizePicker} /> : null;

    // 画布比例 vs 参考图比例不符（>2%）→ 用现有 Tooltip 提示（147 first_frame 不保持比例直接拉伸，必变形）；
    // 不自动改用户明确选的档（避免与用户手动选择打架）——真正以图为准的吸附与留痕在后端提交时完成、任务记录里可见。
    const { t } = useTranslation();
    const referenceMismatch = useMemo(() => {
        if (!referenceSize || !(referenceSize.width > 0) || !(referenceSize.height > 0)) return null;
        const match = /^(\d+)\s*x\s*(\d+)$/.exec(String(config.size ?? "").trim());
        if (!match) return null;
        const canvasWidth = Number(match[1]);
        const canvasHeight = Number(match[2]);
        const canvasAspect = canvasWidth / canvasHeight;
        const referenceAspect = referenceSize.width / referenceSize.height;
        if (Math.abs(canvasAspect - referenceAspect) / Math.max(canvasAspect, referenceAspect) <= 0.02) return null;
        return { canvas: aspectRatioLabel(canvasWidth, canvasHeight), reference: aspectRatioLabel(referenceSize.width, referenceSize.height) };
    }, [referenceSize, config.size]);

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                {(() => {
                    const trigger = (
                        <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[220px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                            {referenceMismatch ? <TriangleAlert className="size-3.5 shrink-0" style={{ color: theme.node.text }} /> : null}
                            <span className="truncate">
                                {videoResolutionLabel(config.vquality)} · {videoSizeLabel(config.size)} · {videoSecondsLabel(config.videoSeconds)} · {videoModeLabel(config.videoMode)}
                            </span>
                        </Button>
                    );
                    return referenceMismatch ? <Tooltip title={t("settingsPanels.video.referenceMismatch", referenceMismatch)}>{trigger}</Tooltip> : trigger;
                })()}
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

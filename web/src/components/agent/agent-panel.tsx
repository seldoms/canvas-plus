import { lazy, Suspense, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_AGENT_PANEL_MOTION_MS, useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 智能体面板正文按需加载：面板默认「挂载但收起」（panelMounted=true / panelOpen=false），
 * 之前正文里整棵 agent-chat（含 streamdown + react-markdown 约 287KB）被静态打进入口包，
 * 首屏白等。改成仅当面板真正打开（或收起动画中）才 import，把这块从关键路径挪走。
 */
const LocalAgentPanel = lazy(() => import("./local-agent-panel").then((module) => ({ default: module.LocalAgentPanel })));

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;

export function AgentPanel() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = useAgentStore((state) => state.width);
    const [resizing, setResizing] = useState(false);
    const panelMounted = useAgentStore((state) => state.panelMounted);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const panelClosing = useAgentStore((state) => state.panelClosing);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(760, Math.max(360, startWidth + startX - moveEvent.clientX));
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted) return null;

    return (
        <motion.div
            className="relative z-[70] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? width + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: panelOpen && !panelClosing ? undefined : "none" }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col border-l"
                data-canvas-shortcuts-ignore
                initial={{ x: 48 }}
                animate={{ x: panelClosing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("agent.panel.resize")} />
                {panelOpen || panelClosing ? (
                    <Suspense fallback={null}>
                        <LocalAgentPanel embedded />
                    </Suspense>
                ) : null}
            </motion.aside>
        </motion.div>
    );
}

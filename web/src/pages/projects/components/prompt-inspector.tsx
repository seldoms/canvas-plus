import { App, Button, Empty, Input, Modal, Space, Tag, Tooltip } from "antd";
import { ChevronDown, ChevronRight, PencilLine, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { regeneratePipelineItem } from "@/services/api/gateway";

import type { KeyframeFrame, KeyframeShot } from "../keyframes-model";

/**
 * 镜头提示词检视器：**看得见 → 改得动 → 重跑**，人工质量兜底的第一环（2026-10-06）。
 *
 * 设计取舍（页面已有70 镜，不能越做越重）：
 *   - **默认折叠**，折叠头一行提示词摘要 + 字数。70 行还能扫，改完再展开。
 *   - 只有**可重跑**的帧给「改词重跑」按钮：被门禁挡住的（blocked）不给，
 *     因为后端会拒，用户点了只会看到一句「前置产物还没就绪」，不如不给。
 *   - 编辑在**弹窗**里做，不做行内 textarea：行内多行编辑会把整张卡片撑开，
 *     70 镜时页面节奏全乱。
 *   - 「按原提示词重跑」与「改词重跑」是**两个明确分开的按钮**，不合并：
 *     前者是「同条件再抽一次」，后者是「我改了主意」。合并成一个按钮
 *     会让人搞不清到底跑的是哪个版本。
 *
 * 重跑走后端 `regenerate`（202 异步），新候选追加到历史里，旧的不会被覆盖——
 * 所以「改坏了退回旧版」天然可行，这也是敢让人工改词的前提。
 */
export function PromptInspector({ shot, runId, onRegenerated }: { shot: KeyframeShot; runId: string; onRegenerated: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState<string>("");

    const prompt = shot.prompt || "";
    // 有 prompt 且至少一帧具备重跑条件（未阻断）才给人工介入入口。
    const rerunnable = useMemo(() => shot.frames.filter((frame) => frame.status !== "blocked"), [shot.frames]);

    if (!prompt) {
        return (
            <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t("projects.keyframes.promptMissing")}
            </div>
        );
    }

    const rerun = async (frame: KeyframeFrame, override?: string) => {
        setBusy(frame.id);
        try {
            await regeneratePipelineItem(runId, "keyframe", {
                itemId: frame.id,
                ...(override !== undefined ? { promptOverride: override } : {}),
            });
            message.success(override !== undefined ? t("projects.keyframes.rerunWithPromptDone") : t("projects.keyframes.rerunDone"));
            setEditing(false);
            onRegenerated();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    const header = (
        <button
            type="button"
            className="mt-1 flex w-full items-start gap-1 text-left text-xs text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            onClick={() => setOpen((value) => !value)}
        >
            {open ? <ChevronDown className="mt-0.5 size-3 shrink-0" /> : <ChevronRight className="mt-0.5 size-3 shrink-0" />}
            <span className="shrink-0 font-medium">{t("projects.keyframes.promptLabel")}</span>
            <span className={open ? "line-clamp-none whitespace-pre-wrap break-words" : "truncate"}>{prompt}</span>
        </button>
    );

    return (
        <div>
            {header}
            {open ? (
                <div className="mt-1 space-y-1.5 rounded border border-stone-200/80 bg-stone-50/60 p-2 text-xs dark:border-stone-700/80 dark:bg-white/5">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-stone-500 dark:text-stone-400">{t("projects.keyframes.promptChars", { count: prompt.length })}</span>
                        <span className="text-stone-400 dark:text-stone-500">{t("projects.keyframes.promptRerunHint")}</span>
                    </div>
                    {!rerunnable.length ? (
                        <div className="text-amber-600 dark:text-amber-400">{t("projects.keyframes.promptBlocked")}</div>
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {rerunnable.map((frame) => (
                                <Space key={frame.id} size={4}>
                                    {frame.role ? <Tag className="!mr-0">{frame.role}</Tag> : null}
                                    <Tooltip title={t("projects.keyframes.rerunSame")}>
                                        <Button
                                            size="small"
                                            icon={<RotateCw className="size-3" />}
                                            loading={busy === frame.id}
                                            onClick={() => void rerun(frame)}
                                        >
                                            {t("projects.keyframes.rerunSame")}
                                        </Button>
                                    </Tooltip>
                                    <Button
                                        size="small"
                                        type="primary"
                                        icon={<PencilLine className="size-3" />}
                                        disabled={Boolean(busy)}
                                        onClick={() => {
                                            setDraft(prompt);
                                            setEditing(true);
                                        }}
                                    >
                                        {t("projects.keyframes.editPrompt")}
                                    </Button>
                                </Space>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}

            <Modal
                open={editing}
                title={t("projects.keyframes.editPromptTitle")}
                okText={t("projects.keyframes.rerunWithPrompt")}
                cancelText={t("projects.keyframes.cancel")}
                confirmLoading={Boolean(busy)}
                onCancel={() => setEditing(false)}
                onOk={() => {
                    const text = draft.trim();
                    if (!text) {
                        message.warning(t("projects.keyframes.promptEmpty"));
                        return;
                    }
                    const frame = rerunnable[0];
                    if (frame) void rerun(frame, text);
                }}
            >
                <Input.TextArea value={draft} onChange={(event) => setDraft(event.target.value)} rows={8} className="font-mono text-xs" />
                <div className="mt-1 text-xs text-stone-500">{t("projects.keyframes.promptOverrideNote")}</div>
                {rerunnable.length > 1 ? (
                    <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                        {t("projects.keyframes.promptFirstFrameOnly", { count: rerunnable.length })}
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
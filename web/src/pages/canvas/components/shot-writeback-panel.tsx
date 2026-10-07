import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Input, InputNumber, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { getEpisode, updateShot } from "@/services/api/projects";
import { patchPipelineStageShot } from "@/services/api/gateway";
import { readShotContent, shotPatchFromNode, shotRefOf } from "@/lib/canvas/shot-bridge";
import type { CanvasNodeData } from "@/types/canvas";
import type { Shot } from "@/types/domain";

/**
 * 「回写分镜」面板（P2-B5）：画布上选中一个镜头节点后，改内容 → 写回流水线/项目分镜。
 *
 * 断点 B5 的另一半。`patchShot` 一直只有 API、没有画布入口，于是画布只能当草稿纸；
 * 这里给一个**显式**回写动作 —— 不用「画布保存即回写」那种自动同步：
 * 画布是自由试验表面（P2 底线之一），自动同步会毁掉「随便画、试一下」这件事。
 *
 * 两套命名空间各走各的端点（不可混用）：
 *  - source="project" → PATCH /api/projects/:id/shots/:shotId（服务端把平铺字段并进 storyboard）
 *  - source="run"     → PATCH /api/pipeline/runs/:id/steps/storyboard/shots/:shotId
 * 后者会返回 downstreamStale：改了 prompt/durationSec 之类，关键帧/配音/合成的既有产物
 * 已经对不上，面板必须把「要重跑哪些阶段」讲清楚，不能显示一句「已保存」了事。
 *
 * 面板本体不做绝对定位（画布页负责），见 project.tsx 的包裹层。
 */
export function ShotWritebackPanel({
    node,
    projectId,
    boundProjectId,
    onClose,
    onNodeChange,
}: {
    node: CanvasNodeData | null;
    projectId: string;
    boundProjectId: string | null;
    onClose: () => void;
    onNodeChange?: (nodeId: string, patch: { shot?: Record<string, unknown> }) => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const ref = shotRefOf(node);
    const isRunSource = ref?.source === "run";

    // 项目侧镜头从服务端读（run 侧只能从节点读：服务端没有按 shotId 反查 storyboard 的读接口）。
    const [baseline, setBaseline] = useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // 表单初值只在「换镜头 / 换来源」时从 baseline 重置，之后完全由用户输入驱动。
    const [prompt, setPrompt] = useState("");
    const [action, setAction] = useState("");
    const [dialogue, setDialogue] = useState("");
    const [durationSec, setDurationSec] = useState<number | null>(null);
    const [shotSize, setShotSize] = useState("");

    // ⚠️ 依赖只能是 primitive（shotId / 来源 / 项目 id）。
    // 之前依赖了 `node` 对象 —— 用户每敲一个字就写回节点 → nodes 变 → node 新引用 →
    // effect 重跑 → getEpisode 重新拉取 → 把刚输入的内容覆盖成服务端旧值，面板基本不可用。
    const shotId = ref?.shotId || "";
    const refProjectId = ref?.projectId || "";
    const episodeId = ref?.episodeId || "";

    const fillForm = useCallback((source: Record<string, unknown>) => {
        setPrompt(String(source.prompt ?? ""));
        setAction(String(source.action ?? ""));
        setDialogue(String(source.dialogue ?? ""));
        setDurationSec(typeof source.durationSec === "number" ? source.durationSec : null);
        setShotSize(String(source.shotSize ?? ""));
    }, []);

    useEffect(() => {
        if (!shotId) return;
        if (isRunSource) {
            setBaseline(null);
            fillForm(node?.metadata?.shot || {});
            return;
        }
        const projectRef = refProjectId || boundProjectId;
        if (!projectRef || !episodeId) return;
        let alive = true;
        setLoading(true);
        getEpisode(projectRef, episodeId)
            .then((detail) => {
                if (!alive || !detail) return;
                const found = (detail.scenes || []).flatMap((scene) => scene.shots || []).find((item) => item.id === shotId) as Shot | undefined;
                if (!found) return;
                // 项目侧镜头字段在 storyboard 嵌套里；顶层同名字段兜底（readShotContent 与工作区同口径）。
                const content = readShotContent(found as never);
                setBaseline(content);
                fillForm(content);
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [boundProjectId, episodeId, fillForm, isRunSource, message, refProjectId, shotId]);

    /**
     * 组装 patch：与原值相同的字段不提交，避免服务端无谓地判为「改动」。
     *
     * 比对逻辑走 `shotPatchFromNode`（shot-bridge.ts）—— 它持有与**服务端同一份**的白名单
     * 与「键序无关」的相等判断。这里原先自己手写：字段名靠 `Object.keys(current).find()` 反查，
     * 两个字段值相同时会取到第一个匹配的 key，语义脆弱；且白名单与 shot-bridge 漂移
     * （面板只暴露 5 个字段，桥里有 11 个）—— 多一份清单就多一处会漏的地方。
     */
    const patch = useMemo(() => {
        const original = baseline || {};
        const current: Record<string, unknown> = { prompt, action, dialogue, durationSec, shotSize };
        if (!node) return {};
        const merged: Record<string, unknown> = { ...original };
        for (const [key, value] of Object.entries(current)) if (value !== null && value !== "") merged[key] = value;
        return shotPatchFromNode({ ...node, metadata: { ...node.metadata, shot: merged as never } } as CanvasNodeData, original);
    }, [action, baseline, dialogue, durationSec, node, prompt, shotSize]);

    const save = useCallback(async () => {
        if (!ref || !node) return;
        if (!Object.keys(patch).length) {
            message.info(t("shotBridge.noChange"));
            return;
        }
        setSaving(true);
        try {
            if (isRunSource) {
                if (!ref.runId) throw new Error(t("shotBridge.noRunAnchor"));
                const result = await patchPipelineStageShot(ref.runId, ref.stageId || "storyboard", ref.shotId, patch);
                const stale = result.downstreamStale || [];
                if (stale.length) {
                    // 不吞掉 stale：关键帧已与新分镜对不上，用户必须知道要重跑哪几步。
                    message.warning(t("shotBridge.savedStale", { stages: stale.join(" / ") }));
                } else {
                    message.success(t("shotBridge.saved"));
                }
            } else {
                const projectRef = refProjectId || boundProjectId || projectId;
                // 平铺字段提交（服务端 episodes.js 已按 SHOT_STORYBOARD_FIELDS 合并进 storyboard）。
                await updateShot(projectRef, ref.shotId, patch as never);
                message.success(t("shotBridge.saved"));
            }
            onClose();
        } catch (error) {
            message.error(t("shotBridge.saveFailed", { message: error instanceof Error ? error.message : String(error) }));
        } finally {
            setSaving(false);
        }
    }, [boundProjectId, isRunSource, message, node, onClose, patch, projectId, ref, refProjectId, t]);

    /** 字段改动即刻写回节点：画布上的镜头节点就是这份数据的视图，两个面板必须看到同一份。 */
    const applyField = useCallback(
        (key: string, value: string | number | null) => {
            if (!node || !onNodeChange) return;
            const next = { ...(node.metadata?.shot || {}) } as Record<string, unknown>;
            if (value === null || value === "") delete next[key];
            else next[key] = value;
            onNodeChange(node.id, { shot: next });
        },
        [node, onNodeChange],
    );

    if (!ref || !node) return null;

    return (
        <div className="absolute right-4 top-20 z-[95] w-[320px] space-y-3 rounded-lg border border-stone-200 bg-card p-3 shadow-lg dark:border-stone-800">
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{node.title}</div>
                    <div className="flex flex-wrap gap-1 pt-1">
                        <Tag className="!m-0">{isRunSource ? t("shotBridge.sourceRun") : t("shotBridge.sourceProject")}</Tag>
                        <Tag className="!m-0">{ref.shotId}</Tag>
                    </div>
                </div>
                <Button size="small" type="text" onClick={onClose}>
                    {t("common.done")}
                </Button>
            </div>

            {loading ? <p className="text-xs opacity-60">{t("common.loading")}</p> : null}

            <label className="block">
                <span className="mb-1 block text-xs opacity-60">{t("shotBridge.fieldPrompt")}</span>
                <Input.TextArea rows={3} value={prompt} onChange={(event) => { setPrompt(event.target.value); applyField("prompt", event.target.value); }} placeholder={t("shotBridge.fieldPromptPlaceholder")} />
            </label>
            <div className="grid grid-cols-2 gap-2">
                <label className="block">
                    <span className="mb-1 block text-xs opacity-60">{t("shotBridge.fieldAction")}</span>
                    <Input value={action} onChange={(event) => { setAction(event.target.value); applyField("action", event.target.value); }} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs opacity-60">{t("shotBridge.fieldShotSize")}</span>
                    <Input value={shotSize} onChange={(event) => { setShotSize(event.target.value); applyField("shotSize", event.target.value); }} />
                </label>
            </div>
            <label className="block">
                <span className="mb-1 block text-xs opacity-60">{t("shotBridge.fieldDialogue")}</span>
                <Input.TextArea rows={2} value={dialogue} onChange={(event) => { setDialogue(event.target.value); applyField("dialogue", event.target.value); }} />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs opacity-60">{t("shotBridge.fieldDuration")}</span>
                <InputNumber className="w-full" min={1} max={8} value={durationSec ?? undefined} onChange={(value) => { const next = typeof value === "number" ? value : null; setDurationSec(next); applyField("durationSec", next); }} />
            </label>

            <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-xs opacity-60">{t("shotBridge.pendingFields", { count: Object.keys(patch).length })}</span>
                <Button type="primary" size="small" loading={saving} disabled={!Object.keys(patch).length} onClick={() => void save()}>
                    {t("shotBridge.writeback")}
                </Button>
            </div>
        </div>
    );
}
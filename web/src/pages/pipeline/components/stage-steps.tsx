import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { GatewayProgressStep, GatewayRunStep, GatewayStageStepStatus } from "@/services/api/gateway";

/**
 * 01 剧本阶段的「多步可见」步骤条：analyze → outline → script。
 * 纯只读展示——步骤状态来自 progress.steps（轮询轻量进度），中间产物来自 run.stages.script.steps（拉全量 run 后才有）。
 * 两处入口共用：pipeline 的 StageCard 与 projects 的 WorkspaceRunPanel；没有 steps 的旧 run / 其余阶段一律不渲染。
 */
const STEP_ORDER = ["analyze", "outline", "script"];
const MAX_LIST = 6;

const DOT_CLASS: Record<GatewayStageStepStatus, string> = {
    pending: "bg-stone-300 dark:bg-stone-600",
    running: "bg-amber-500 animate-pulse",
    done: "bg-emerald-500",
    error: "bg-red-500",
};

const TEXT_CLASS: Record<GatewayStageStepStatus, string> = {
    pending: "text-stone-400 dark:text-stone-500",
    running: "text-amber-600 dark:text-amber-400",
    done: "text-stone-700 dark:text-stone-200",
    error: "text-red-600 dark:text-red-400",
};

type TFn = ReturnType<typeof useTranslation>["t"];

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** 把 stage.steps（对象）还原成与 progress.steps 同形的有序列表，供阶段跑完后继续展示。 */
export function stepsFromRunStage(runSteps: Record<string, GatewayRunStep> | undefined): GatewayProgressStep[] {
    if (!runSteps || typeof runSteps !== "object") return [];
    const list = Object.values(runSteps)
        .filter((step) => step && typeof step.id === "string")
        .map((step) => ({ id: step.id, title: step.title || step.id, status: step.status || "pending", ...(step.detail ? { detail: step.detail } : {}) }));
    return orderSteps(list);
}

/** 按 analyze → outline → script 固定顺序排；未知 id 排到最后，保证稳定。 */
function orderSteps<T extends { id: string }>(steps: T[]): T[] {
    return [...steps].sort((a, b) => {
        const ai = STEP_ORDER.indexOf(a.id);
        const bi = STEP_ORDER.indexOf(b.id);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
}

/** 折叠态的一行要点：analyze 给「主线 + 角色/场景数」，outline/script 给集数。 */
function stepSummary(id: string, output: unknown, t: TFn): string {
    const data = asRecord(output);
    if (!data) return "";
    if (id === "analyze") {
        const parts: string[] = [];
        const logline = text(data.logline);
        if (logline) parts.push(`${t("pipeline.steps.logline")}：${logline}`);
        const characters = asArray(data.characters);
        if (characters.length) parts.push(t("pipeline.steps.characters", { count: characters.length }));
        const scenes = asArray(data.scenes);
        if (scenes.length) parts.push(t("pipeline.steps.scenes", { count: scenes.length }));
        return parts.join(" · ");
    }
    const episodes = asArray(data.episodes);
    if (!episodes.length) return "";
    if (id === "outline") return t("pipeline.steps.episodes", { count: episodes.length });
    if (id === "script") return t("pipeline.steps.scriptDone", { count: episodes.length });
    return "";
}

/** 展开态的逐条要点（只读，字段缺失就跳过，绝不臆造）。 */
function stepHighlights(id: string, output: unknown, t: TFn): string[] {
    const data = asRecord(output);
    if (!data) return [];
    if (id === "analyze") {
        const lines: string[] = [];
        const logline = text(data.logline);
        if (logline) lines.push(`${t("pipeline.steps.logline")}：${logline}`);
        const synopsis = text(data.synopsis);
        if (synopsis) lines.push(`${t("pipeline.steps.synopsis")}：${synopsis}`);
        const names = asArray(data.characters).map((item) => text(asRecord(item)?.name)).filter(Boolean);
        if (names.length) {
            const rest = names.length > MAX_LIST ? t("pipeline.steps.more", { count: names.length - MAX_LIST }) : "";
            lines.push(`${t("pipeline.steps.characters", { count: names.length })}：${names.slice(0, MAX_LIST).join("、")}${rest}`);
        }
        const titles = asArray(data.scenes).map((item) => text(asRecord(item)?.title)).filter(Boolean);
        if (titles.length) {
            const rest = titles.length > MAX_LIST ? t("pipeline.steps.more", { count: titles.length - MAX_LIST }) : "";
            lines.push(`${t("pipeline.steps.scenes", { count: titles.length })}：${titles.slice(0, MAX_LIST).join("、")}${rest}`);
        }
        return lines;
    }
    const episodes = asArray(data.episodes).slice(0, MAX_LIST);
    if (id === "outline") {
        return episodes.map((item) => {
            const episode = asRecord(item) ?? {};
            const index = num(episode.index);
            const duration = num(episode.durationSec);
            return t("pipeline.steps.episode", {
                index,
                duration: duration > 0 ? t("pipeline.steps.seconds", { value: duration }) : t("pipeline.steps.noDuration"),
                title: text(episode.title) || t("pipeline.steps.episodeTitle", { index }),
            });
        });
    }
    if (id === "script") {
        return episodes.map((item, position) => {
            const episode = asRecord(item) ?? {};
            return t("pipeline.steps.scriptEpisode", { index: num(episode.index) || position + 1, scenes: asArray(episode.scenes).length });
        });
    }
    return [];
}

export function StageSteps({ steps, outputs }: { steps: GatewayProgressStep[]; outputs?: Record<string, GatewayRunStep> | null }) {
    const { t } = useTranslation();
    const ordered = orderSteps(steps);
    const done = steps.filter((step) => outputs?.[step.id]?.output != null);
    if (!ordered.length) return null;

    return (
        <div className="mt-2 rounded-md border border-stone-200/70 px-2 py-1.5 dark:border-stone-700/70">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {ordered.map((step, position) => (
                    <span key={step.id} className="inline-flex items-center gap-1.5">
                        {position > 0 ? <span className="text-stone-300 dark:text-stone-600">→</span> : null}
                        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[step.status])} />
                        <span className={cn("font-medium", TEXT_CLASS[step.status])}>{step.title}</span>
                        <span className={TEXT_CLASS[step.status]}>{t(`pipeline.status.${step.status}`)}</span>
                        {step.detail ? <span className="text-stone-400 dark:text-stone-500">{step.detail}</span> : null}
                    </span>
                ))}
            </div>

            {done.length ? (
                <div className="mt-1 border-t border-stone-200/60 pt-1 dark:border-stone-700/60">
                    {done.map((step) => (
                        <div key={step.id} className="text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                            <span className="font-medium text-stone-500 dark:text-stone-400">{step.title}：</span>
                            <span className="break-words">{stepHighlights(step.id, outputs?.[step.id]?.output, t).join("　") || stepSummary(step.id, outputs?.[step.id]?.output, t) || t("pipeline.steps.empty")}</span>
                            {outputs?.[step.id]?.error ? <span className="ml-1 text-red-600 dark:text-red-400">{outputs?.[step.id]?.error}</span> : null}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

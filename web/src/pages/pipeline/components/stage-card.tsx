import { Button } from "antd";
import { ChevronDown, ChevronUp, Pencil, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl, type GatewayArtifact, type GatewayStageStatus } from "@/services/api/gateway";
import { isVideoArtifact } from "../pipeline-utils";
import type { PipelineStageView } from "../use-pipeline-run";

const STATUS_CLASS: Record<GatewayStageStatus, string> = {
    pending: "text-stone-500 dark:text-stone-400",
    running: "text-amber-600 dark:text-amber-400",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
};

export function StageCard({ index, view, busy, disabledReason, onRun, onRerun, onEdit }: { index: number; view: PipelineStageView; busy: boolean; disabledReason: string; onRun: () => void; onRerun: () => void; onEdit: () => void }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const output = view.stage?.output;

    return (
        <section className="px-1 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">
                    {index + 1}. {view.title}
                </span>
                <span className={cn("inline-flex items-center gap-1 text-xs", STATUS_CLASS[view.status])}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {t(`pipeline.status.${view.status}`)}
                </span>
                {view.generating ? <span className="text-xs text-stone-500 dark:text-stone-400">{t("pipeline.generating")}</span> : null}
                <div className="ml-auto flex items-center gap-1">
                    <Button type="text" size="small" icon={<Play className="size-3.5" />} loading={busy} disabled={Boolean(disabledReason)} onClick={onRun}>
                        {t("pipeline.runStage")}
                    </Button>
                    <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} disabled={Boolean(disabledReason) || view.status === "pending"} onClick={onRerun}>
                        {t("pipeline.rerun")}
                    </Button>
                    <Button type="text" size="small" icon={<Pencil className="size-3.5" />} disabled={!view.stage || output === undefined} onClick={onEdit}>
                        {t("pipeline.editOutput")}
                    </Button>
                    <Button type="text" size="small" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((current) => !current)}>
                        {t(expanded ? "pipeline.hideJson" : "pipeline.viewJson")}
                    </Button>
                </div>
            </div>
            {disabledReason ? <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{disabledReason}</div> : null}
            {view.stage?.error ? <div className="mt-1 text-xs text-red-600 dark:text-red-400">{view.stage.error}</div> : null}
            {expanded ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600 dark:text-stone-300">{output === undefined ? t("pipeline.noOutput") : JSON.stringify(output, null, 2)}</pre> : null}
            {view.artifacts.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                    {view.artifacts.map((artifact) => (
                        <StageArtifact key={artifact.url} artifact={artifact} />
                    ))}
                </div>
            ) : null}
        </section>
    );
}

function StageArtifact({ artifact }: { artifact: GatewayArtifact }) {
    const src = resolveGatewayUrl(artifact.url);
    if (isVideoArtifact(artifact)) return <video src={src} controls preload="metadata" className="h-28 max-w-52 rounded-md" />;
    if (artifact.type === "image") return <img src={src} alt={artifact.filename} className="h-28 max-w-52 rounded-md object-cover" />;
    return (
        <a href={src} target="_blank" rel="noreferrer" className="self-center text-xs text-stone-500 underline dark:text-stone-400">
            {artifact.filename}
        </a>
    );
}

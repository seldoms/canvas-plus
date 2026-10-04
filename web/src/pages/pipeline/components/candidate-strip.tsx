import { Button, Dropdown, Tooltip, type MenuProps } from "antd";
import { Repeat } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { resolveGatewayUrl, type GatewayGenerationItem, type GatewayJobStatus, type GatewayTemplateInfo } from "@/services/api/gateway";
import { PreviewableMedia } from "@/components/workbench";
import { candidateViews, type CandidateView } from "../pipeline-utils";
import { artifactThumbSrc } from "@/lib/artifact-thumb";

const CANDIDATE_STATUS_CLASS: Record<GatewayJobStatus, string> = {
    queued: "text-stone-400 dark:text-stone-500",
    running: "text-amber-600 dark:text-amber-400",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    canceled: "text-stone-400 dark:text-stone-500",
};

/**
 * 生成型阶段（关键帧 / 片段合成）里一个条目的候选条：横向铺开该条目的全部候选缩略图，
 * 末尾挂「换个模型再出一张」下拉（只列本阶段同 family 的网关模板）。候选为空时整条不渲染，不占竖向空间。
 */
export function CandidateStrip({
    item,
    index,
    kind,
    templates,
    busy,
    stageRunning,
    onRegenerate,
}: {
    item: GatewayGenerationItem;
    index: number;
    kind: "image" | "video";
    templates: GatewayTemplateInfo[];
    busy: boolean;
    stageRunning: boolean;
    onRegenerate: (itemId: string, template: string) => Promise<string>;
}) {
    const { t } = useTranslation();
    const [error, setError] = useState("");
    const candidates = candidateViews(item);
    if (!candidates.length) return null;

    const role = item.role || "";
    const label = role ? t(`pipeline.candidates.role.${role}`, { defaultValue: role }) : `#${index + 1}`;
    // 阶段整体在跑时后端会拒绝逐条重跑（409），这里直接禁用，避免无意义请求
    const blocked = busy || stageRunning;

    const regenerate = async (template: string) => {
        setError("");
        const message = await onRegenerate(item.id, template);
        if (message) setError(message);
    };

    const menu: MenuProps = {
        items: templates.map((template) => ({ key: template.name, label: template.title || template.name })),
        onClick: ({ key }) => void regenerate(key),
    };

    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5">
            <span className="shrink-0 text-[11px] text-stone-400 dark:text-stone-500">{label}</span>
            <div className="flex flex-wrap items-center gap-1">
                {candidates.map((candidate) => (
                    <CandidateThumb key={candidate.jobId} candidate={candidate} kind={kind} />
                ))}
            </div>
            <Dropdown menu={menu} trigger={["click"]} placement="bottomLeft" disabled={blocked || !templates.length}>
                <Button type="text" size="small" loading={busy} disabled={blocked || !templates.length} icon={<Repeat className="size-3.5" />} className="!h-6 !px-1 text-xs">
                    {t("pipeline.candidates.regenerate")}
                </Button>
            </Dropdown>
            {!templates.length ? <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("pipeline.candidates.noTemplates")}</span> : null}
            {candidates.length > 1 ? <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("pipeline.candidates.selectPending")}</span> : null}
            {error ? <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span> : null}
        </div>
    );
}

function CandidateThumb({ candidate, kind }: { candidate: CandidateView; kind: "image" | "video" }) {
    const { t } = useTranslation();
    const [failed, setFailed] = useState(false);
    const src = candidate.artifactUrl ? resolveGatewayUrl(candidate.artifactUrl) : "";
    const thumbSrc = artifactThumbSrc(src);
    const tone = CANDIDATE_STATUS_CLASS[candidate.status];
    const status = t(`pipeline.candidates.status.${candidate.status}`);
    const title = [candidate.template, status, candidate.selected ? t("pipeline.candidates.selected") : ""].filter(Boolean).join(" · ");
    const box = cn("relative size-14 shrink-0 overflow-hidden rounded bg-black/5 dark:bg-white/10", candidate.selected && "ring-2 ring-stone-400 dark:ring-stone-500");

    // 有产物就能点开：站内弹窗看大图 / 播视频，同阶段其它候选可 ←→↑↓ 切换。
    if (!src || failed) {
        return (
            <Tooltip title={title}>
                <div className={box}>
                    <span className={cn("flex size-full items-center justify-center px-1 text-center text-[10px] leading-tight", tone)}>{status}</span>
                    <span className={cn("absolute left-1 top-1 size-1.5 rounded-full bg-current", tone)} />
                </div>
            </Tooltip>
        );
    }

    return (
        <Tooltip title={title}>
            <div className={box}>
                <PreviewableMedia id={candidate.jobId} kind={kind} src={src} thumbSrc={thumbSrc} title={title} className="size-full">
                    {kind === "video" ? (
                        <video src={src} poster={thumbSrc} muted preload="none" className="size-full object-cover" onError={() => setFailed(true)} />
                    ) : (
                        <img src={thumbSrc} alt={candidate.template} className="size-full object-cover" onError={() => setFailed(true)} />
                    )}
                </PreviewableMedia>
                <span className={cn("absolute left-1 top-1 size-1.5 rounded-full bg-current", tone)} />
            </div>
        </Tooltip>
    );
}

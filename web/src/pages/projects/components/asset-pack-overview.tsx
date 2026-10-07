import { Card, Empty, Progress, Tag, Tooltip, Typography } from "antd";
import { ImageOff, PackageCheck, PackageOpen } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { artifactThumbSrc } from "@/lib/artifact-thumb";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { PreviewableMedia } from "@/components/workbench";
import type { AssetRef } from "@/types/domain";

import { buildAssetPacks, type AssetPack, type PackEntry, type PackStatus } from "../asset-ref-model";

/**
 * 资料包总览（P1）—— **以剧本实体为主轴**回答一个问题：
 * 「这部戏的角色/场景/道具，各自锁了参考图没有，还差谁？」
 *
 * 与下面那张 AssetRefPanel（按引用条目列）并存，不是替代：
 * 前者管「缺什么」（缺口可见），后者管「怎么改」（逐条改绑定、切采用）。
 * 之所以两都要：条目视角适合编辑，实体视角适合判断能不能进下一阶段。
 */
export function AssetPackOverview({ refs, script, loading }: { refs: AssetRef[]; script: unknown; loading: boolean }) {
    const { t } = useTranslation();
    const packs = useMemo(() => buildAssetPacks(refs, script), [refs, script]);

    if (loading && !packs.length) return null;
    if (!packs.length) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-10" description={t("projects.pack.empty")} />;
    }

    return (
        <section className="mb-5">
            <div className="mb-2 flex items-baseline justify-between gap-2">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.pack.title")}
                </Typography.Title>
                <Typography.Text type="secondary" className="text-xs">
                    {t("projects.pack.hint")}
                </Typography.Text>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
                {packs.map((pack) => (
                    <PackCard key={pack.role} pack={pack} />
                ))}
            </div>
        </section>
    );
}

function PackCard({ pack }: { pack: AssetPack }) {
    const { t } = useTranslation();
    const percent = pack.expected > 0 ? Math.round((pack.adopted / pack.expected) * 100) : pack.entries.length ? 100 : 0;
    return (
        <Card size="small" title={<span className="text-sm">{t(`projects.assetsView.roles.${pack.role}`)}</span>} className="!border-stone-200 dark:!border-stone-800">
            {/* 进度条只在剧本有清单时才有意义（道具类 expected=0，用条目数直接说事）。 */}
            {pack.expected > 0 ? (
                <div className="mb-2">
                    <Progress
                        percent={percent}
                        size="small"
                        status={pack.missing > 0 ? "active" : "success"}
                        format={() => t("projects.pack.progress", { adopted: pack.adopted, expected: pack.expected })}
                    />
                </div>
            ) : (
                <div className="mb-2 text-xs text-stone-500 dark:text-stone-400">{t("projects.pack.countOnly", { count: pack.entries.length })}</div>
            )}
            <div className="space-y-1">
                {pack.entries.map((entry) => (
                    <PackRow key={entry.bindingId} entry={entry} />
                ))}
            </div>
        </Card>
    );
}

/** 单个实体一行：缩略图 + 名称 + 状态。缺图的一眼能看出来（图位是空的）。 */
function PackRow({ entry }: { entry: PackEntry }) {
    const { t } = useTranslation();
    const statusTag: Record<PackStatus, { color?: string; label: string }> = {
        adopted: { color: "green", label: t("projects.pack.status.adopted") },
        candidates: { color: "gold", label: t("projects.pack.status.candidates") },
        missing: { label: t("projects.pack.status.missing") },
    };
    const tag = statusTag[entry.status];
    return (
        <div className="flex items-center gap-2.5 rounded-md border border-stone-200 px-2 py-1.5 dark:border-stone-800">
            {entry.url ? (
                <PreviewableMedia id={entry.refId ?? entry.bindingId} kind="image" src={resolveGatewayUrl(entry.url)} thumbSrc={artifactThumbSrc(resolveGatewayUrl(entry.url))} title={entry.name} className="block size-11 shrink-0 cursor-zoom-in overflow-hidden rounded bg-black/5 dark:bg-white/5">
                    <img src={artifactThumbSrc(resolveGatewayUrl(entry.url))} alt={entry.name} loading="lazy" className="size-11 object-cover" />
                </PreviewableMedia>
            ) : (
                <span className="flex size-11 shrink-0 items-center justify-center rounded border border-dashed border-stone-300 text-stone-400 dark:border-stone-700 dark:text-stone-500" title={t("projects.pack.noArtifact")}>
                    <ImageOff className="size-4" />
                </span>
            )}
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-stone-900 dark:text-stone-100" title={entry.name}>
                    {entry.name}
                </div>
                <div className="truncate text-xs text-stone-500 dark:text-stone-400">
                    {entry.candidateCount > 0 ? t("projects.pack.candidates", { count: entry.candidateCount }) : t("projects.pack.noCandidates")}
                    {entry.source ? ` · ${entry.source}` : ""}
                </div>
            </div>
            <Tooltip title={tag.label}>
                <Tag color={tag.color} className="!mr-0 shrink-0">
                    {entry.status === "adopted" ? <PackageCheck className="size-3" /> : entry.status === "candidates" ? <PackageOpen className="size-3" /> : <ImageOff className="size-3" />}
                </Tag>
            </Tooltip>
        </div>
    );
}
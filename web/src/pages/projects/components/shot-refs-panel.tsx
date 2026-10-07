import { Alert, Spin, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getShotRefs, type ShotRefs } from "@/services/api/projects";

import { buildRefRows, canShowNumbering, missingReasonText, numberingWarning } from "../shot-refs-model";

/** 参考类型 → i18n key 后缀。与后端 REF_KINDS 同名，改一处要同步。 */
const KIND_KEY: Record<string, string> = { character: "kindCharacter", scene: "kindScene", prop: "kindProp", voice: "kindVoice" };

/**
 * 单镜参考清单（只读派生视图）。
 *
 * 为什么是只读展示：引用关系由后端从角色名 / 显式 token 推导（单一事实源），
 * 这里若做成可编辑就等于承认「声明」与「推导」两个真相，锁脸与 QC 都要开始对账。
 * 要改引用，改的是角色名 / token 那些真源（走镜头编辑），本面板随之刷新。
 *
 * 三条展示纪律：
 *   1. **编号只在后端核对通过时显示**（canShowNumbering）。错位时宁可只列清单——
 *      一个指向另一张图的编号比没有编号更糟，且用户无从察觉。
 *   2. **没有图就不渲染 img**，不用占位图冒充「已生成」。
 *   3. **查不到这一镜**与**这一镜没有参考**分开显示，两者都是 200 + found 不同。
 */
export function ShotRefsPanel({ projectId, shotId }: { projectId: string; shotId: string }) {
    const { t } = useTranslation();
    const [data, setData] = useState<ShotRefs | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!projectId || !shotId) {
            setData(null);
            return;
        }
        let alive = true;
        setLoading(true);
        setError("");
        getShotRefs(projectId, shotId)
            .then((next) => {
                if (alive) setData(next);
            })
            .catch((loadError: unknown) => {
                if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError));
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [projectId, shotId]);

    const rows = useMemo(() => buildRefRows(data?.refs ?? [], data?.missingRefs ?? []), [data]);
    const showNumbering = canShowNumbering(data?.alignment);
    const warning = numberingWarning(data?.alignment);

    return (
        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
            <Typography.Text type="secondary" className="!text-xs">
                {t("projects.storyboardView.shotRefs.title")}
            </Typography.Text>
            <div className="mt-1 text-[11px] text-stone-400">{t("projects.storyboardView.shotRefs.subtitle")}</div>

            {loading ? (
                <div className="mt-2 flex items-center gap-2 text-xs text-stone-500">
                    <Spin size="small" />
                </div>
            ) : error ? (
                <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {t("projects.storyboardView.shotRefs.loadFailed", { message: error })}
                </div>
            ) : data && !data.found ? (
                <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">{t("projects.storyboardView.shotRefs.notFound")}</div>
            ) : !rows.length ? (
                <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">{t("projects.storyboardView.shotRefs.empty")}</div>
            ) : (
                <>
                    {warning ? (
                        <Alert type="warning"showIcon className="!mt-2 !text-[11px]" message={warning} />
                    ) : (
                        <div className="mt-1 text-[11px] text-stone-400">{t("projects.storyboardView.shotRefs.numberingAligned")}</div>
                    )}
                    <ul className="mt-2 space-y-1.5">
                        {rows.map((row) => (
                            <li key={row.key} className="flex items-center gap-2">
                                {row.thumbUrl ? (
                                    <img src={row.thumbUrl} alt={row.label} className="h-9 w-9 shrink-0 rounded object-cover" />
                                ) : (
                                    // 没图就留一个明确的空位，而不是放张占位图让人以为「图丢了」。
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-dashed border-stone-300 text-[10px] text-stone-400 dark:border-stone-600">
                                        {t(`projects.storyboardView.shotRefs.${KIND_KEY[row.ref.kind] ?? "kindCharacter"}`, { defaultValue: row.ref.kind })}
                                    </span>
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-baseline gap-x-2">
                                        {showNumbering && row.tag ? <span className="font-mono text-[11px] text-stone-400">{row.tag}</span> : null}
                                        <span className="truncate text-xs font-medium text-stone-900 dark:text-stone-100">{row.label}</span>
                                        <span className="text-[11px] text-stone-400">{row.role}</span>
                                    </div>
                                    {row.missingReason ? (
                                        <div className="text-[11px] text-amber-600 dark:text-amber-400">
                                            {t("projects.storyboardView.shotRefs.missingReason", { reason: missingReasonText(row.missingReason) })}
                                        </div>
                                    ) : null}
                                </div>
                            </li>
                        ))}
                    </ul>
                    {data?.gaps.length ? (
                        <div className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
                            {t("projects.storyboardView.shotRefs.gapsTitle")}：{data.gaps.join("、")}
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}

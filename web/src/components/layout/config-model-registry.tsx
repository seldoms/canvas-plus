import { App, Button, Input, Switch, Tag } from "antd";
import { ArrowRightLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { invalidateRegistryModelCache } from "@/hooks/use-model-registry";
import {
    fetchAvailableModels,
    fetchModelRegistry,
    patchModelRegistryEntry,
    syncModelRegistry,
    type ModelCategory,
    type ModelRegistryAvailable,
    type ModelRegistryCounts,
    type ModelRegistryEntry,
    type ModelRegistryPatchInput,
} from "@/services/api/model-registry";

/** 分栏顺序只是展示偏好；实际出现哪几组、组名是什么都由接口 category 决定（不硬编码）。 */
const CATEGORY_ORDER: ModelCategory[] = ["text", "image", "video", "audio"];

export function ConfigModelRegistry() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [entries, setEntries] = useState<ModelRegistryEntry[]>([]);
    const [counts, setCounts] = useState<ModelRegistryCounts | null>(null);
    const [available, setAvailable] = useState<ModelRegistryAvailable | null>(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [registry, availableResult] = await Promise.all([fetchModelRegistry(), fetchAvailableModels()]);
            setEntries(registry.models);
            setCounts(registry.counts);
            setAvailable(availableResult);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.modelRegistry.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const sync = async () => {
        setSyncing(true);
        try {
            const result = await syncModelRegistry();
            await load();
            invalidateRegistryModelCache();
            message.success(t("config.modelRegistry.synced", { count: result.added.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.modelRegistry.syncFailed"));
        } finally {
            setSyncing(false);
        }
    };

    const patchEntry = useCallback(
        async (entry: ModelRegistryEntry, patch: ModelRegistryPatchInput) => {
            try {
                const updated = await patchModelRegistryEntry(entry.id, patch);
                setEntries((current) => current.map((item) => (item.id === entry.id ? { ...item, ...(updated && typeof updated === "object" ? updated : {}), ...patch } : item)));
                invalidateRegistryModelCache();
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("config.modelRegistry.saveFailed"));
            }
        },
        [message, t],
    );

    const categories = useMemo(() => {
        const seen = new Set(entries.map((entry) => entry.category));
        return [...CATEGORY_ORDER.filter((category) => seen.has(category)), ...[...seen].filter((category) => !CATEGORY_ORDER.includes(category))];
    }, [entries]);

    const grouped = useMemo(() => {
        const map = new Map<string, ModelRegistryEntry[]>();
        for (const entry of entries) {
            const list = map.get(entry.category) || [];
            list.push(entry);
            map.set(entry.category, list);
        }
        return map;
    }, [entries]);

    const availableCount = available?.available.length ?? counts?.total ?? 0;
    const registeredCount = available?.registered ?? entries.length;

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-stone-600 dark:text-stone-300">{t("config.modelRegistry.summary", { available: availableCount, registered: registeredCount })}</div>
                <Button type="primary" icon={<ArrowRightLeft className="size-4" />} loading={syncing || loading} onClick={() => void sync()}>
                    {t("config.modelRegistry.sync")}
                </Button>
            </div>
            <div className="grid items-start gap-3 lg:grid-cols-2 xl:grid-cols-4">
                {categories.map((category) => {
                    const list = grouped.get(category) || [];
                    return (
                        <section key={category} className="rounded-lg border border-stone-200 dark:border-stone-800">
                            <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
                                <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">{categoryLabel(t, category)}</span>
                                <span className="text-xs text-stone-400">{list.length}</span>
                            </div>
                            <div className="space-y-1.5 p-2">
                                {list.map((entry) => (
                                    <ModelRegistryRow key={entry.id} entry={entry} onPatch={patchEntry} />
                                ))}
                            </div>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}

/** 组名跟着接口 category 走；i18n 有对应词条就用中文，没有就原样显示 category，避免漏组。 */
function categoryLabel(t: TFunction, category: string) {
    return t(`config.modelRegistry.categories.${category}`, { defaultValue: category });
}

function ModelRegistryRow({ entry, onPatch }: { entry: ModelRegistryEntry; onPatch: (entry: ModelRegistryEntry, patch: ModelRegistryPatchInput) => void }) {
    const { t } = useTranslation();
    const [alias, setAlias] = useState(entry.alias ?? "");

    useEffect(() => {
        setAlias(entry.alias ?? "");
    }, [entry.alias, entry.id]);

    const commit = () => {
        const next = alias.trim();
        if (next === (entry.alias ?? "").trim()) return;
        onPatch(entry, { alias: next });
    };

    const source = entry.channelName?.trim() || entry.provider?.trim() || entry.source?.trim() || "";
    const placeholder = entry.meta?.title?.trim() || entry.name;

    return (
        <div className="rounded-md border border-stone-200 px-2 py-1.5 dark:border-stone-800">
            <div className="flex items-center gap-2">
                {entry.runtime === "cloud" ? <span aria-hidden className="shrink-0 text-sm leading-none">☁️</span> : null}
                <Input size="small" value={alias} placeholder={placeholder} onChange={(event) => setAlias(event.target.value)} onBlur={commit} onPressEnter={commit} />
                <Switch size="small" checked={entry.enabled} onChange={(enabled) => onPatch(entry, { enabled })} />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-400">
                <span className="min-w-0 truncate font-mono">{entry.name}</span>
                {source ? <span className="shrink-0 max-w-[45%] truncate">· {source}</span> : null}
                {entry.stale ? <Tag className="m-0 shrink-0" bordered={false}>{t("config.modelRegistry.stale")}</Tag> : null}
            </div>
        </div>
    );
}

import { App, Button, Input, Switch, Tag } from "antd";
import { ArrowRightLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { invalidateRegistryModelCache } from "@/hooks/use-model-registry";
import {
    fetchAvailableModels,
    fetchModelRegistry,
    modelRegistryBase,
    modelRegistryTask,
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

type BaseGroup = { base: string; entries: ModelRegistryEntry[] };

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

    /** 组头改名 = 该组所有条目一起改 base（同一基座名只出现一次，改就整体改）。 */
    const patchBase = useCallback(
        async (group: BaseGroup, base: string) => {
            await Promise.all(group.entries.map((entry) => patchEntry(entry, { base })));
        },
        [patchEntry],
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

    /**
     * 栏内按 base 分组：**保持接口返回顺序**（后端按默认表顺序给），组内顺序同理。
     * 单条目的组也照样成组 —— 纵向一致，不出现「有的有组头有的没有」的参差。
     */
    const groupsByCategory = useMemo(() => {
        const map = new Map<string, BaseGroup[]>();
        for (const [category, list] of grouped) {
            const groups = new Map<string, BaseGroup>();
            for (const entry of list) {
                const base = modelRegistryBase(entry);
                const group = groups.get(base) || { base, entries: [] };
                group.entries.push(entry);
                groups.set(base, group);
            }
            map.set(category, [...groups.values()]);
        }
        return map;
    }, [grouped]);

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
                    const groups = groupsByCategory.get(category) || [];
                    return (
                        <section key={category} className="rounded-lg border border-stone-200 dark:border-stone-800">
                            <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
                                <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">{categoryLabel(t, category)}</span>
                                <span className="text-xs text-stone-400">{groups.reduce((sum, group) => sum + group.entries.length, 0)}</span>
                            </div>
                            <div className="space-y-2 p-2">
                                {groups.map((group) => (
                                    <ModelBaseGroup key={`${category}:${group.base}`} group={group} onPatchEntry={patchEntry} onPatchBase={patchBase} />
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

/**
 * base 组：**上方窄条做组头**（不用左侧列 —— 分栏是四列网格、单栏本来就窄，左侧列会挤出大片空白），
 * 组头只写一次 base（可就地改），组内每行只写 task。
 */
function ModelBaseGroup({
    group,
    onPatchEntry,
    onPatchBase,
}: {
    group: BaseGroup;
    onPatchEntry: (entry: ModelRegistryEntry, patch: ModelRegistryPatchInput) => void;
    onPatchBase: (group: BaseGroup, base: string) => void;
}) {
    const { t } = useTranslation();
    const [base, setBase] = useState(group.base);

    useEffect(() => {
        setBase(group.base);
    }, [group.base]);

    const commitBase = () => {
        const next = base.trim();
        if (!next || next === group.base.trim()) {
            setBase(group.base);
            return;
        }
        onPatchBase(group, next);
    };

    return (
        <div className="overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
            <div className="flex items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-1.5 py-1 dark:border-stone-800 dark:bg-stone-900/50">
                <Input
                    size="small"
                    value={base}
                    className="font-semibold"
                    placeholder={t("config.modelRegistry.basePlaceholder")}
                    onChange={(event) => setBase(event.target.value)}
                    onBlur={commitBase}
                    onPressEnter={commitBase}
                />
                <span className="shrink-0 text-[11px] text-stone-400">{group.entries.length}</span>
            </div>
            <div className="divide-y divide-stone-100 dark:divide-stone-900">
                {group.entries.map((entry) => (
                    <ModelRegistryRow key={entry.id} entry={entry} onPatch={onPatchEntry} />
                ))}
            </div>
        </div>
    );
}

function ModelRegistryRow({ entry, onPatch }: { entry: ModelRegistryEntry; onPatch: (entry: ModelRegistryEntry, patch: ModelRegistryPatchInput) => void }) {
    const { t } = useTranslation();
    const resolvedTask = modelRegistryTask(entry);
    const [task, setTask] = useState(resolvedTask);

    useEffect(() => {
        setTask(resolvedTask);
    }, [resolvedTask]);

    const commit = () => {
        const next = task.trim();
        if (next === resolvedTask) return;
        onPatch(entry, { task: next });
    };

    const source = entry.channelName?.trim() || entry.provider?.trim() || entry.source?.trim() || "";

    return (
        <div className="px-2 py-1.5">
            <div className="flex items-center gap-2">
                {entry.runtime === "cloud" ? <span aria-hidden className="shrink-0 text-sm leading-none">☁️</span> : null}
                <Input
                    size="small"
                    value={task}
                    placeholder={t("config.modelRegistry.taskPlaceholder")}
                    onChange={(event) => setTask(event.target.value)}
                    onBlur={commit}
                    onPressEnter={commit}
                />
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

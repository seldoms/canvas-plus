/**
 * 流水线页的模型选择器 —— 数据源是**服务端模型注册表**（`GET /api/model-registry?enabled=true&category=<能力>`，
 * 经 `useRegistryModelOptions` 带缓存读取），不再用 mock 列表。
 *
 * 视觉与生产组件 `@/components/model-picker.tsx` 保持一致的口径：
 * - 分组键取后端 `base` 字段（**不硬编码任何模型名单**），组头写一次 base，整组云端时 ☁️ 提到组头；
 * - 组内行的标题取后端 `task`（能力名）；展示名 alias → meta.title → name；
 * - 条目下的能力标签来自 `meta`（本地/云端运行时、支持参考图、参考图上限、时长档位）。
 *
 * 与生产组件的差别只有两点，都是刻意的：
 * 1. 不用 Radix Select，改为 Popover —— 流水线页的触发器在紧凑的步骤条行里，需要 `min-w-40` 这类自定义宽度；
 * 2. 注册表不可用（网关未就绪 / 尚无条目）时**如实显示「注册表不可用」并禁用**，不做 mock 回退 ——
 *    流水线要拿这个值真的去跑生成，给一个假清单比不给更糟。
 */
import { Popover } from "antd";
import { Check, ChevronDown, Cloud, Cpu, FileText, Image as ImageIcon, Loader2, Video } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useRegistryModelOptions } from "@/hooks/use-model-registry";
import { modelRegistryBase, modelRegistryDisplayName, modelRegistryTask } from "@/services/api/model-registry";
import type { ModelCapability } from "@/stores/use-config-store";
import { cn } from "@/lib/utils";

const DOMAIN_ICON: Record<ModelCapability, ReactNode> = {
    text: <FileText className="size-4 shrink-0 opacity-70" />,
    image: <ImageIcon className="size-4 shrink-0 opacity-70" />,
    video: <Video className="size-4 shrink-0 opacity-70" />,
    audio: <FileText className="size-4 shrink-0 opacity-70" />,
};

type Props = {
    /** 能力域；对应注册表的 category，也是请求侧要发的能力分类。 */
    capability: ModelCapability;
    /** 当前选中的模型 name（请求侧真实标识）；空表示未选。 */
    value?: string;
    onChange?: (value: string) => void;
    className?: string;
    /** 无选中项时的占位文案。 */
    placeholder?: string;
};

export function PipelineModelPicker({ capability, value, onChange, className, placeholder }: Props) {
    const registry = useRegistryModelOptions(capability);
    const [open, setOpen] = useState(false);
    const [localValue, setLocalValue] = useState(value || "");

    // 外部（切阶段/切 run）给了新值就跟随；否则保留用户在本地选的那个。
    useEffect(() => {
        if (value) setLocalValue(value);
    }, [value]);

    const entries = useMemo(() => registry.models.filter((entry) => entry.enabled), [registry.models]);

    /** 按 base 归组，保持接口返回顺序（与生产 model-picker 同一口径）。 */
    const groups = useMemo(() => {
        const list: { base: string; cloud: boolean; items: typeof entries }[] = [];
        for (const entry of entries) {
            const base = modelRegistryBase(entry);
            let group = list.find((item) => item.base === base);
            if (!group) {
                group = { base, cloud: true, items: [] };
                list.push(group);
            }
            group.items.push(entry);
            if (entry.runtime !== "cloud") group.cloud = false;
        }
        return list;
    }, [entries]);

    const selected = entries.find((entry) => entry.name === localValue);
    const loading = registry.status === "loading" || registry.status === "idle";
    const unavailable = registry.status === "error" || (registry.status === "ready" && !entries.length);

    const pick = (name: string) => {
        setLocalValue(name);
        onChange?.(name);
        setOpen(false);
    };

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            styles={{ container: { padding: 4, width: 340 } }}
            content={
                <div className="max-h-80 overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center gap-2 px-2 py-3 text-sm text-stone-500">
                            <Loader2 className="size-3.5 animate-spin" />
                            正在读取模型注册表…
                        </div>
                    ) : unavailable ? (
                        <div className="px-2 py-3 text-sm leading-6 text-stone-500">
                            模型注册表暂不可用（网关未就绪或该能力下没有已启用模型）。这里不做假清单兜底 —— 流水线要拿这个值真的去跑生成。
                        </div>
                    ) : (
                        groups.map((group) => (
                            <div key={group.base}>
                                <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-medium text-stone-400">
                                    {group.cloud ? <Cloud className="size-3" /> : null}
                                    {group.base}
                                </div>
                                {group.items.map((entry) => {
                                    const active = entry.name === localValue;
                                    const chips = modelChips(entry);
                                    return (
                                        <button
                                            key={entry.id || entry.name}
                                            type="button"
                                            onClick={() => pick(entry.name)}
                                            className={cn(
                                                "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-stone-100 dark:hover:bg-white/10",
                                                active && "bg-stone-100 dark:bg-white/10",
                                            )}
                                        >
                                            <span className="mt-0.5 w-4 shrink-0">{active ? <Check className="size-3.5 text-stone-700 dark:text-stone-200" /> : null}</span>
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-center gap-1.5 text-sm text-stone-800 dark:text-stone-200">
                                                    {entry.runtime === "cloud" && !group.cloud ? <Cloud className="size-3 shrink-0 text-stone-400" /> : null}
                                                    {modelRegistryTask(entry) || modelRegistryDisplayName(entry)}
                                                </span>
                                                {chips.length ? (
                                                    <span className="mt-1 flex flex-wrap gap-1">
                                                        {chips.map((chip) => (
                                                            <span key={chip} className="rounded border border-stone-200 px-1 py-px text-[10px] leading-3 text-stone-400 dark:border-stone-700">
                                                                {chip}
                                                            </span>
                                                        ))}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>
            }
        >
            <button
                type="button"
                disabled={unavailable}
                className={cn(
                    "flex h-8 min-w-40 max-w-full items-center gap-2 rounded-full border px-3 text-sm shadow-sm transition-colors",
                    "border-stone-300 hover:border-stone-400 data-[open=true]:border-stone-500 data-[open=true]:ring-2 data-[open=true]:ring-stone-300/40",
                    "dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-500",
                    unavailable && "cursor-not-allowed opacity-60",
                    className,
                )}
                data-open={open}
                title={selected?.name || undefined}
                data-model={localValue || undefined}
                data-capability={capability}
            >
                {DOMAIN_ICON[capability]}
                <span className="min-w-0 flex-1 truncate text-left">{selected ? modelRegistryDisplayName(selected) : placeholder || "选择模型"}</span>
                <ChevronDown className={cn("size-3.5 shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
            </button>
        </Popover>
    );
}

/** 条目下的能力标签：只列注册表真有的字段，不编造。 */
function modelChips(entry: { runtime?: string; template?: string | null; meta?: { supportsReference?: boolean; referenceLimit?: number; durations?: number[] } | null }) {
    const chips: string[] = [entry.runtime === "cloud" ? "云端" : "本地"];
    if (entry.template) chips.push(entry.template);
    if (entry.meta?.supportsReference) chips.push(entry.meta.referenceLimit ? `参考×${entry.meta.referenceLimit}` : "支持参考图");
    if (entry.meta?.durations?.length) chips.push(`${entry.meta.durations.join("/")}s`);
    return chips;
}

/** 触发器左侧的小图标：能力域标识，避免每个调用点重复写。 */
export function ModelPickerIcon({ capability }: { capability: ModelCapability }) {
    return <>{DOMAIN_ICON[capability]}</>;
}

export { Cpu };

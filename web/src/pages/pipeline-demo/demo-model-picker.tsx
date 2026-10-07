/**
 * 演示版模型选择器 —— 视觉对齐生产组件 @/components/model-picker.tsx：
 * 胶囊触发器（图标 + 展示名）、下拉按 base 分组（组头写一次，整组云端带 ☁️）、
 * 组内只列 task 能力名，并在条目下展示能力标签（本地/耗时/分辨率等）。
 * 正式接线时直接替换为生产 ModelPicker（registry 模式读 /api/model-registry）。
 */
import { Popover } from "antd";
import { Check, ChevronDown, Cloud, Cpu, FileText, Image as ImageIcon, Video } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { MODEL_GROUPS, type MockModel } from "./mock-data";

type Domain = keyof typeof MODEL_GROUPS;

const DOMAIN_ICON: Record<Domain, ReactNode> = {
    text: <FileText className="size-4 shrink-0 opacity-70" />,
    image: <ImageIcon className="size-4 shrink-0 opacity-70" />,
    video: <Video className="size-4 shrink-0 opacity-70" />,
};

export function DemoModelPicker({ domain, value, onChange, className }: { domain: Domain; value?: string; onChange?: (value: string) => void; className?: string }) {
    const models = MODEL_GROUPS[domain];
    const [current, setCurrent] = useState(value || models[0].value);
    const [open, setOpen] = useState(false);
    const selected = models.find((model) => model.value === current) || models[0];

    // 按 base 归组，保持声明顺序；整组云端时 ☁️ 提到组头
    const groups: { base: string; cloud: boolean; items: MockModel[] }[] = [];
    for (const model of models) {
        let group = groups.find((item) => item.base === model.base);
        if (!group) {
            group = { base: model.base, cloud: true, items: [] };
            groups.push(group);
        }
        group.items.push(model);
        if (!model.cloud) group.cloud = false;
    }

    const pick = (model: MockModel) => {
        setCurrent(model.value);
        onChange?.(model.value);
        setOpen(false);
    };

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            styles={{ container: { padding: 4, width: 320 } }}
            content={
                <div className="max-h-80 overflow-y-auto">
                    {groups.map((group) => (
                        <div key={group.base}>
                            <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-medium text-stone-400">
                                {group.cloud ? <Cloud className="size-3" /> : null}
                                {group.base}
                            </div>
                            {group.items.map((model) => {
                                const active = model.value === selected.value;
                                return (
                                    <button
                                        key={model.value}
                                        type="button"
                                        onClick={() => pick(model)}
                                        className={cn(
                                            "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-stone-100 dark:hover:bg-white/10",
                                            active && "bg-stone-100 dark:bg-white/10",
                                        )}
                                    >
                                        <span className="mt-0.5 w-4 shrink-0">{active ? <Check className="size-3.5 text-stone-700 dark:text-stone-200" /> : null}</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-1.5 text-sm text-stone-800 dark:text-stone-200">
                                                {model.cloud && !group.cloud ? <Cloud className="size-3 shrink-0 text-stone-400" /> : null}
                                                {model.task}
                                            </span>
                                            <span className="mt-1 flex flex-wrap gap-1">
                                                {model.chips.map((chip) => (
                                                    <span key={chip} className="rounded border border-stone-200 px-1 py-px text-[10px] leading-3 text-stone-400 dark:border-stone-700">
                                                        {chip}
                                                    </span>
                                                ))}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            }
        >
            <button
                type="button"
                className={cn(
                    "flex h-8 min-w-56 max-w-full items-center gap-2 rounded-full border border-stone-300 bg-transparent px-3 text-sm shadow-sm transition-colors",
                    "hover:border-stone-400 data-[open=true]:border-stone-500 data-[open=true]:ring-2 data-[open=true]:ring-stone-300/40",
                    "dark:border-stone-700 dark:text-stone-200 dark:hover:border-stone-500",
                    className,
                )}
                data-open={open}
                title={selected.value}
            >
                {DOMAIN_ICON[domain]}
                <span className="min-w-0 flex-1 truncate text-left">{selected.label}</span>
                <ChevronDown className={cn("size-3.5 shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
            </button>
        </Popover>
    );
}

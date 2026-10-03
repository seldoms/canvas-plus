import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useRegistryModelOptions } from "@/hooks/use-model-registry";
import { modelRegistryBase, modelRegistryDisplayName, modelRegistryTask } from "@/services/api/model-registry";
import { modelOptionFullLabel, modelOptionLabel, modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

/**
 * 统一的选项形状：value 是**请求侧发出去的值**（注册表用 name、渠道模式用 channelId::name）。
 * - `label`：触发器（已选项）的展示 —— 注册表模式下是完整展示名（base+task 别名），保证选中后知道自己选了啥；
 * - `task`：下拉列表内的展示 —— 注册表模式下**只写能力名 task**（base 已由分组标题承担，不再重复）；
 * - `fullLabel`：title 提示，注册表模式下是原始 `name`（排查用）。
 */
type PickerOption = { value: string; label: string; task: string; fullLabel: string; cloud?: boolean };
/** 一组 = 一个 base；`base` 为空串表示「无分组」（渠道模式的自有清单，保持扁平原样）。 */
type PickerGroup = { base: string; cloud: boolean; options: PickerOption[] };

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    /**
     * 打开后从服务端模型注册表读清单（`GET /api/model-registry?enabled=true&category=<capability>`，只读）。
     * 展示名回落 alias → meta.title → name；runtime=cloud 前置 ☁️。onChange 仍回传真实 name，请求侧不受别名影响。
     * registry 模式下下拉**按 base 分组**（标题=base、组内只列 task）。
     * 接口未就绪（网关回落 SPA / 后端未上线）时自动回退浏览器渠道，保持既有行为。
     */
    registry?: boolean;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, onMissingConfig, registry = false }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const registryState = useRegistryModelOptions(registry ? capability : undefined);
    // 仅当注册表「已就绪」才以它为准；loading/error 时回退浏览器渠道，避免接口未就绪时下拉清空。
    const usingRegistry = Boolean(registry && capability && registryState.status === "ready");
    /**
     * 分组由接口字段驱动：**按 base 归组、保持接口返回顺序**（不硬编码任何 base 名单）。
     * 组内只列 task；一组全是云端 → ☁️ 提到分组标题上，混合时 ☁️ 落到各条。
     * value 始终是真实 `name`（请求侧不变）。
     */
    const groups = useMemo<PickerGroup[]>(() => {
        if (usingRegistry) {
            const map = new Map<string, PickerGroup>();
            for (const entry of registryState.models) {
                const base = modelRegistryBase(entry);
                const group = map.get(base) || { base, cloud: true, options: [] };
                if (entry.runtime !== "cloud") group.cloud = false;
                group.options.push({
                    value: entry.name,
                    label: entry.runtime === "cloud" ? `☁️ ${modelRegistryDisplayName(entry)}` : modelRegistryDisplayName(entry),
                    task: modelRegistryTask(entry) || modelRegistryDisplayName(entry),
                    fullLabel: entry.name,
                    cloud: entry.runtime === "cloud",
                });
                map.set(base, group);
            }
            return [...map.values()];
        }
        const values = Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model))));
        return [{ base: "", cloud: false, options: values.map((model) => ({ value: model, label: modelOptionLabel(config, model), task: modelOptionLabel(config, model), fullLabel: modelOptionFullLabel(config, model) })) }];
    }, [usingRegistry, registryState.models, capability, config, value]);
    const options = useMemo(() => groups.flatMap((group) => group.options), [groups]);
    const current = value || "";
    const currentOption = options.find((option) => option.value === current) || null;
    // 命中选项就用选项展示名；否则回退旧逻辑的展示名 —— 兼容历史 channelId::name 值，避免露出原始编码。
    const currentLabel = currentOption?.label ?? (current ? modelOptionLabel(config, current) : "");
    const currentFullLabel = currentOption?.fullLabel ?? (current ? modelOptionFullLabel(config, current) : "");
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? currentFullLabel : pickerPlaceholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? currentLabel : pickerPlaceholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    groups.map((group) => {
                        const listLabel = (option: PickerOption) => (option.cloud && !group.cloud ? `☁️ ${option.task}` : option.task);
                        const items = group.options.map((option) => (
                            <SelectItem key={option.value} value={option.value} textValue={option.label}>
                                <ModelLabel model={option.value} label={listLabel(option)} fullLabel={option.fullLabel} />
                            </SelectItem>
                        ));
                        // 渠道模式（无 base）保持扁平原样；注册表模式每组建一个分组，标题只写 base 一次。
                        if (!group.base) return <Fragment key="__flat__">{items}</Fragment>;
                        return (
                            <SelectGroup key={group.base}>
                                <SelectLabel className="font-medium">{group.cloud ? `☁️ ${group.base}` : group.base}</SelectLabel>
                                {items}
                            </SelectGroup>
                        );
                    })
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ model, label, fullLabel }: { model: string; label: string; fullLabel: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2" title={fullLabel}>
            <ModelIcon model={model} />
            <span className="truncate">{label}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}

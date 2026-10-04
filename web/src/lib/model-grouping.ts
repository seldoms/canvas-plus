/**
 * 模型清单的**统一分组口径**（平台「最新研究样式」的唯一实现）。
 *
 * 规则（`model-picker.tsx` / `config-model-registry.tsx` 同款）：
 * - 按 `base` 分组，**组头只写一次 base**，组内只列能力名 / 短名 `task`；
 * - **保持输入顺序**（接口返回顺序），**不硬编码任何 base 名单**；
 * - 一组**全是云端 → ☁️ 提到组头**，组内各条不再重复 ☁️；**混合时 ☁️ 落到各条**；
 * - `base` 为空串表示「无分组」（渠道模式的自有清单，保持扁平原样，不显示组头）。
 */
export type GroupableModel = {
    /** 请求侧真实值（注册表用 name、渠道模式用 channelId::name）。 */
    value: string;
    /** 分组键：一般 = 注册表 base，或渠道名；空串 = 不分组。 */
    base: string;
    /** 组内只写的「能力名 / 短名」。 */
    task: string;
    /** 触发器（已选项）展示的完整名；缺省回落 task。 */
    label?: string;
    /** hover 完整原始名（排查用）。 */
    fullLabel?: string;
    /** 该条是否云端。 */
    cloud?: boolean;
};

/** 组内单条：附带按「整组是否全云端」算好的列表展示名 `listLabel`。 */
export type GroupedModel = GroupableModel & { listLabel: string };
export type ModelBaseGroup = { base: string; cloud: boolean; options: GroupedModel[] };

export function groupModelsByBase(models: GroupableModel[]): ModelBaseGroup[] {
    const map = new Map<string, ModelBaseGroup>();
    for (const model of models) {
        const group = map.get(model.base) || { base: model.base, cloud: true, options: [] };
        if (!model.cloud) group.cloud = false;
        group.options.push({ ...model, listLabel: model.task });
        map.set(model.base, group);
    }
    // 整组全云端 → 组内不再逐条加 ☁️（☁️ 已提到组头）；混合时才落到各条。
    return [...map.values()].map((group) => ({
        ...group,
        options: group.options.map((option) => ({ ...option, listLabel: option.cloud && !group.cloud ? `☁️ ${option.task}` : option.task })),
    }));
}

/** 组头文案：整组云端加 ☁️ 前缀；无分组（空 base）不产组头。 */
export function modelGroupHeaderLabel(group: Pick<ModelBaseGroup, "base" | "cloud">) {
    if (!group.base) return "";
    return group.cloud ? `☁️ ${group.base}` : group.base;
}

/** antd `Select` 可吃的选项形状：叶子项（有 value）或分组项（有 options）。 */
export type SelectModelOption = { value: string; label: string; title?: string };
export type SelectModelGroup = { label: string; options: SelectModelOption[] };
export type SelectModelItem = SelectModelOption | SelectModelGroup;

/**
 * 把分组结果转成 antd `Select` 的 options：有 base → 分组项（组头写一次 base），无 base → 拍平的叶子项。
 * 叶子 `label` = 组内能力名（整组云端不再逐条带 ☁️）；`title` = 完整名（base · task），配合 `optionLabelProp="title"`
 * 让触发器显示完整名 —— 同 `model-picker.tsx` 的「选中后知道自己选了啥」口径。
 */
export function toSelectModelOptions(groups: ModelBaseGroup[]): SelectModelItem[] {
    const out: SelectModelItem[] = [];
    for (const group of groups) {
        const options: SelectModelOption[] = group.options.map((option) => ({
            value: option.value,
            label: option.listLabel ?? option.task,
            title: option.label || (group.base ? `${group.base} · ${option.task}` : option.task),
        }));
        if (!group.base) out.push(...options);
        else out.push({ label: modelGroupHeaderLabel(group), options });
    }
    return out;
}

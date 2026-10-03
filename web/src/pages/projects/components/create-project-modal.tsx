import { App, Form, Input, InputNumber, Modal, Select, Tag } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    AUDIENCE_PRESETS,
    DRAMA_MODE_PRESETS,
    GENRE_PRESET_GROUPS,
    RATIO_PRESETS,
    STYLE_ANCHOR_EXAMPLES,
    TONE_PRESETS,
    VISUAL_STYLE_PRESETS,
    type DramaPresetOption,
} from "@/constant/drama-presets";
import type { ProjectCreateInput } from "@/services/api/projects";

import { EMPTY_SOURCE_DRAFT, SourceInput, type ProjectSourceDraft, type ProjectSourceSubmit } from "./source-input";

/** 新建项目弹窗的表单值；规划参数平铺，提交时收进 plan。预置维度为标签数组，可多选也可自定义。 */
export type CreateProjectFormValues = {
    title: string;
    styleAnchor?: string;
    genre?: string[];
    tone?: string[];
    visualStyle?: string[];
    ratio?: string;
    episodeDurationSec?: number;
    dramaMode?: string[];
    audience?: string[];
    episodeCount?: number;
};

/** 预置项 → Select option；hint 作为下拉里的次要提示，选中后标签只显示 value。 */
function presetOptions(items: DramaPresetOption[]) {
    return items.map((item) => ({
        value: item.value,
        label: item.hint ? (
            <span>
                {item.value}
                <span className="ml-2 text-xs text-stone-400">{item.hint}</span>
            </span>
        ) : (
            item.value
        ),
    }));
}

/** 标签数组 → 规划参数里的单个字符串；多个用顿号连接，空则不下发。 */
function joinPresets(values?: string[]) {
    return (values ?? []).map((item) => item.trim()).filter(Boolean).join("、");
}

/** 空字符串不下发，交给服务端按 Plan 默认值补齐。 */
function toCreateInput(values: CreateProjectFormValues): ProjectCreateInput {
    return {
        title: values.title.trim(),
        styleAnchor: values.styleAnchor?.trim() || undefined,
        plan: {
            genre: joinPresets(values.genre),
            tone: joinPresets(values.tone),
            visualStyle: joinPresets(values.visualStyle),
            ratio: values.ratio || "9:16",
            episodeDurationSec: values.episodeDurationSec || 60,
            dramaMode: joinPresets(values.dramaMode) || "短剧向",
            audience: joinPresets(values.audience),
            episodeCount: values.episodeCount || 1,
        },
    };
}

/** 新建项目弹窗：剧名 + 原文导入（可选）+ 风格锚点 + 基础规划参数（预置可选、也可自定义）。 */
export function CreateProjectModal({
    open,
    submitting,
    onCancel,
    onSubmit,
}: {
    open: boolean;
    submitting: boolean;
    onCancel: () => void;
    onSubmit: (input: ProjectCreateInput, source: ProjectSourceSubmit | null) => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [form] = Form.useForm<CreateProjectFormValues>();
    const [source, setSource] = useState<ProjectSourceDraft>(EMPTY_SOURCE_DRAFT);

    // 每次打开重置原文草稿，避免上次的文件内容带到下一次新建。
    useEffect(() => {
        if (open) setSource(EMPTY_SOURCE_DRAFT);
    }, [open]);

    const genreOptions = GENRE_PRESET_GROUPS.map((group) => ({ label: t(`projects.form.${group.labelKey}`), options: presetOptions(group.options) }));
    const multiPlaceholder = t("projects.form.multiOrCustom");

    /** 原文可选；空内容不阻塞建项目（之后可在工作区补录）。 */
    const handleFinish = (values: CreateProjectFormValues) => {
        const input = toCreateInput(values);
        if (source.reading) {
            message.error(t("projects.source.reading"));
            return;
        }
        if (source.mode === "file" && source.fileName && !source.text.trim()) {
            message.error(t("projects.source.empty"));
            return;
        }
        const text = source.text.trim();
        const payload: ProjectSourceSubmit | null = text ? { text: source.text, title: source.title.trim() || input.title, kind: "novel", from: source.mode === "file" ? "upload" : "paste" } : null;
        onSubmit(input, payload);
    };

    return (
        <Modal
            title={t("projects.createTitle")}
            open={open}
            width={720}
            confirmLoading={submitting}
            okText={t("projects.create")}
            cancelText={t("common.cancel")}
            onCancel={onCancel}
            onOk={() => void form.submit()}
            destroyOnHidden
        >
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ ratio: "9:16", episodeDurationSec: 60, dramaMode: ["短剧向"], episodeCount: 1 }} onFinish={handleFinish}>
                <Form.Item name="title" label={t("projects.form.title")} rules={[{ required: true, message: t("projects.form.titleRequired") }]}>
                    <Input size="large" placeholder={t("projects.form.titlePlaceholder")} />
                </Form.Item>
                <Form.Item label={t("projects.form.source")} extra={t("projects.form.sourceHelp")}>
                    <SourceInput draft={source} onChange={setSource} disabled={submitting} />
                </Form.Item>
                <Form.Item name="styleAnchor" label={t("projects.form.styleAnchor")} extra={t("projects.form.styleAnchorHelp")}>
                    <Input placeholder={t("projects.form.styleAnchorPlaceholder")} />
                </Form.Item>
                <div className="-mt-2 mb-4 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-stone-500 dark:text-stone-400">{t("projects.form.styleAnchorExamples")}</span>
                    {STYLE_ANCHOR_EXAMPLES.map((example) => (
                        <Tag key={example} className="cursor-pointer" onClick={() => form.setFieldValue("styleAnchor", example)}>
                            {example}
                        </Tag>
                    ))}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <Form.Item name="genre" label={t("projects.form.genre")} className="sm:col-span-2">
                        <Select mode="tags" optionLabelProp="value" allowClear placeholder={multiPlaceholder} options={genreOptions} />
                    </Form.Item>
                    <Form.Item name="tone" label={t("projects.form.tone")}>
                        <Select mode="tags" optionLabelProp="value" allowClear placeholder={multiPlaceholder} options={presetOptions(TONE_PRESETS)} />
                    </Form.Item>
                    <Form.Item name="visualStyle" label={t("projects.form.visualStyle")}>
                        <Select mode="tags" optionLabelProp="value" allowClear placeholder={multiPlaceholder} options={presetOptions(VISUAL_STYLE_PRESETS)} />
                    </Form.Item>
                    <Form.Item name="ratio" label={t("projects.form.ratio")}>
                        <Select options={RATIO_PRESETS.map((option) => ({ value: option.value, label: t(`projects.form.${option.labelKey}`) }))} />
                    </Form.Item>
                    <Form.Item name="dramaMode" label={t("projects.form.dramaMode")}>
                        <Select mode="tags" optionLabelProp="value" allowClear maxCount={1} placeholder={multiPlaceholder} options={presetOptions(DRAMA_MODE_PRESETS)} />
                    </Form.Item>
                    <Form.Item name="episodeDurationSec" label={t("projects.form.episodeDurationSec")}>
                        <InputNumber min={1} max={3600} className="w-full" />
                    </Form.Item>
                    <Form.Item name="episodeCount" label={t("projects.form.episodeCount")}>
                        <InputNumber min={1} max={999} className="w-full" />
                    </Form.Item>
                    <Form.Item name="audience" label={t("projects.form.audience")} className="sm:col-span-2">
                        <Select mode="tags" optionLabelProp="value" allowClear placeholder={multiPlaceholder} options={presetOptions(AUDIENCE_PRESETS)} />
                    </Form.Item>
                </div>
            </Form>
        </Modal>
    );
}

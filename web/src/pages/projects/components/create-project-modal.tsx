import { App, Form, Input, InputNumber, Modal, Segmented, Select, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
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
import type { AudioMode } from "@/types/domain";
import type { ProjectCreateInput } from "@/services/api/projects";
import { fetchGatewayProviders, probeGatewayBaseUrl, type GatewayTemplateInfo } from "@/services/api/gateway";

import { EMPTY_SOURCE_DRAFT, SourceInput, type ProjectSourceDraft, type ProjectSourceSubmit } from "./source-input";

/** 新建项目弹窗的表单值；规划参数平铺，提交时收进 plan。预置维度为标签数组，可多选也可自定义。 */
export type CreateProjectFormValues = {
    title: string;
    styleAnchor?: string;
    genre?: string[];
    tone?: string[];
    visualStyle?: string[];
    ratio?: string;
    /** 单集时长（**分钟**，作品规格；默认 2、最小 1）；提交时 ×60 存进 plan.episodeDurationSec（秒）。 */
    episodeDurationMinutes?: number;
    /** 视频模型（来自 /api/providers 的 video family 模板）：决定可选画幅范围；单镜时长跟模型走，不由用户选。 */
    videoModel?: string;
    dramaMode?: string[];
    audience?: string[];
    episodeCount?: number;
    /** 配音方式：separate_dialogue_track（独立配音，默认）/ embedded（原声）。 */
    audioMode?: AudioMode;
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

/** 空字符串不下发，交给服务端按 Plan 默认值补齐。单集时长按【分钟】采集，×60 存成秒。 */
function toCreateInput(values: CreateProjectFormValues): ProjectCreateInput {
    const minutes = Number(values.episodeDurationMinutes);
    return {
        title: values.title.trim(),
        styleAnchor: values.styleAnchor?.trim() || undefined,
        plan: {
            genre: joinPresets(values.genre),
            tone: joinPresets(values.tone),
            visualStyle: joinPresets(values.visualStyle),
            ratio: values.ratio || "9:16",
            episodeDurationSec: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 120,
            dramaMode: joinPresets(values.dramaMode) || "短剧向",
            audience: joinPresets(values.audience),
            episodeCount: values.episodeCount || 1,
            audioMode: values.audioMode || "separate_dialogue_track",
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
    // 视频模型清单来自后端 /api/providers（video family）；画幅预设按该模型的官方规格收敛，前端不硬编码。
    // ⚠️ 单镜时长跟模型走、不由用户选；项目参数里的「单集时长」是分钟级作品规格，两者不是一回事。
    const [videoTemplates, setVideoTemplates] = useState<GatewayTemplateInfo[]>([]);
    const videoModel = Form.useWatch("videoModel", form) as string | undefined;
    const selectedVideoTemplate = useMemo(() => videoTemplates.find((template) => template.name === videoModel) || null, [videoTemplates, videoModel]);
    // 画幅口径跟模型建议尺寸走：视频模型有官方规格时，预设画幅收敛到它支持的画幅（后端下发，前端不硬编码）；
    // 无规格（未查证/未加载）保持全部预设。
    const ratioOptions = useMemo(() => {
        const ratios = new Set((selectedVideoTemplate?.sizes ?? []).map((size) => size.ratio));
        if (!ratios.size) return RATIO_PRESETS;
        const filtered = RATIO_PRESETS.filter((option) => ratios.has(option.value));
        return filtered.length ? filtered : RATIO_PRESETS;
    }, [selectedVideoTemplate]);

    // 每次打开重置原文草稿，并拉取视频模型清单（供画幅预设收敛）；网关不可达时退化回全量预设，不阻塞建项目。
    useEffect(() => {
        if (!open) return;
        setSource(EMPTY_SOURCE_DRAFT);
        let alive = true;
        void probeGatewayBaseUrl()
            .then((base) => fetchGatewayProviders(base))
            .then((providers) => {
                if (!alive) return;
                const models = (providers.comfy?.templates || []).filter((template) => template.family === "video");
                setVideoTemplates(models);
                if (!models.length) return;
                form.setFieldsValue({ videoModel: models[0].name });
            })
            .catch(() => {
                if (alive) setVideoTemplates([]);
            });
        return () => {
            alive = false;
        };
    }, [open, form]);

    // 换模型 → 画幅跟着变：当前画幅不在该模型官方规格支持的画幅里就落到第一个可选画幅（预设收敛后的）。
    useEffect(() => {
        if (ratioOptions === RATIO_PRESETS) return;
        const current = String(form.getFieldValue("ratio") || "");
        if (!ratioOptions.some((option) => option.value === current)) form.setFieldsValue({ ratio: ratioOptions[0].value });
    }, [ratioOptions, form]);

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
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ ratio: "9:16", episodeDurationMinutes: 2, dramaMode: ["短剧向"], episodeCount: 1, audioMode: "separate_dialogue_track" }} onFinish={handleFinish}>
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
                        <Select options={ratioOptions.map((option) => ({ value: option.value, label: t(`projects.form.${option.labelKey}`) }))} />
                    </Form.Item>
                    <Form.Item name="audioMode" label={t("projects.form.audioMode")}>
                        {/* 二选一：独立配音（视频归 H3、台词归独立 TTS）/ 原声（保留片段内嵌音频）。 */}
                        <Segmented
                            options={[
                                { value: "separate_dialogue_track", label: t("projects.form.audioModeSeparate") },
                                { value: "embedded", label: t("projects.form.audioModeEmbedded") },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="dramaMode" label={t("projects.form.dramaMode")}>
                        <Select mode="tags" optionLabelProp="value" allowClear maxCount={1} placeholder={multiPlaceholder} options={presetOptions(DRAMA_MODE_PRESETS)} />
                    </Form.Item>
                    <Form.Item name="videoModel" label={t("projects.form.videoModel")}>
                        {/* 视频模型来自后端 /api/providers（video family）；换它 → 可选画幅跟着收敛。单镜时长跟模型走，不由用户选。 */}
                        <Select
                            options={videoTemplates.map((template) => ({ value: template.name, label: template.title || template.name }))}
                            placeholder={t("projects.form.optional")}
                            disabled={submitting || !videoTemplates.length}
                            showSearch
                            optionFilterProp="label"
                        />
                    </Form.Item>
                    <Form.Item name="episodeDurationMinutes" label={t("projects.form.episodeDurationMinutes")}>
                        {/* 单集时长是作品规格（分钟）；单镜时长由分镜阶段 + 所选视频模型档位决定，用户无需确认。 */}
                        <InputNumber min={1} max={60} className="w-full" disabled={submitting} />
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

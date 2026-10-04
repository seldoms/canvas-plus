import { App, Form, Input, InputNumber, Modal, Select, Tag } from "antd";
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
    episodeDurationSec?: number;
    /** 视频模型（时长档位来源）：来自 /api/providers 的 video family 模板；D1「时长跟着模型走」。 */
    videoModel?: string;
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
    // D1：视频模型清单来自后端 /api/providers —— 时长档位 `durations` 随之而来，前端不硬编码。
    const [videoTemplates, setVideoTemplates] = useState<GatewayTemplateInfo[]>([]);
    const videoModel = Form.useWatch("videoModel", form) as string | undefined;
    const selectedVideoTemplate = useMemo(() => videoTemplates.find((template) => template.name === videoModel) || null, [videoTemplates, videoModel]);
    // 选定视频模型 → 可选时长档位集合（空 = 该模型档位待查证 / 网关不可达）。
    const durationTiers = useMemo(() => {
        const tiers = selectedVideoTemplate?.durations;
        return Array.isArray(tiers) && tiers.length ? tiers : null;
    }, [selectedVideoTemplate]);
    // 画幅口径跟模型建议尺寸走：视频模型有官方规格时，预设画幅收敛到它支持的画幅（后端下发，前端不硬编码）；
    // 无规格（未查证/未加载）保持全部预设。
    const ratioOptions = useMemo(() => {
        const ratios = new Set((selectedVideoTemplate?.sizes ?? []).map((size) => size.ratio));
        if (!ratios.size) return RATIO_PRESETS;
        const filtered = RATIO_PRESETS.filter((option) => ratios.has(option.value));
        return filtered.length ? filtered : RATIO_PRESETS;
    }, [selectedVideoTemplate]);

    // 每次打开重置原文草稿，并拉取视频模型清单（含时长档位）；网关不可达时退化回自由输入，不阻塞建项目。
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
                // 默认优先选一个「有档位」的视频模型（H3 系），让档位选择器一打开就可用。
                const preferred = models.find((template) => Array.isArray(template.durations) && template.durations.length) || models[0];
                if (!preferred) return;
                const tiers = Array.isArray(preferred.durations) ? preferred.durations : null;
                form.setFieldsValue({
                    videoModel: preferred.name,
                    ...(tiers?.length ? { episodeDurationSec: tiers.includes(15) ? 15 : tiers[0] } : {}),
                });
            })
            .catch(() => {
                if (alive) setVideoTemplates([]);
            });
        return () => {
            alive = false;
        };
    }, [open, form]);

    // 换模型 → 档位跟着变：当前时长不在新档位里就落到该模型第一个档位。
    useEffect(() => {
        if (!durationTiers) return;
        const current = Number(form.getFieldValue("episodeDurationSec"));
        if (!durationTiers.includes(current)) form.setFieldsValue({ episodeDurationSec: durationTiers[0] });
    }, [durationTiers, form]);

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
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ ratio: "9:16", episodeDurationSec: 15, dramaMode: ["短剧向"], episodeCount: 1 }} onFinish={handleFinish}>
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
                    <Form.Item name="dramaMode" label={t("projects.form.dramaMode")}>
                        <Select mode="tags" optionLabelProp="value" allowClear maxCount={1} placeholder={multiPlaceholder} options={presetOptions(DRAMA_MODE_PRESETS)} />
                    </Form.Item>
                    <Form.Item name="videoModel" label={t("projects.form.videoModel")}>
                        {/* 视频模型来自后端 /api/providers（video family）；换它 → 时长档位跟着变。 */}
                        <Select
                            options={videoTemplates.map((template) => ({ value: template.name, label: template.title || template.name }))}
                            placeholder={t("projects.form.optional")}
                            disabled={submitting || !videoTemplates.length}
                            showSearch
                            optionFilterProp="label"
                        />
                    </Form.Item>
                    <Form.Item name="episodeDurationSec" label={durationTiers ? t("projects.form.durationTier") : t("projects.form.episodeDurationSec")} extra={selectedVideoTemplate?.durations ? t("projects.form.durationTierHelp") : t("projects.form.durationTierPending")}>
                        {durationTiers ? (
                            // D1：时长只能从「当前视频模型」的档位里选；换模型 → 档位跟着变。
                            <Select options={durationTiers.map((sec) => ({ value: sec, label: `${sec} s` }))} disabled={submitting} />
                        ) : (
                            <InputNumber min={1} max={3600} className="w-full" disabled={submitting} />
                        )}
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

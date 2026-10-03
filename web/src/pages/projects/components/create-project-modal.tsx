import { Form, Input, InputNumber, Modal, Select } from "antd";
import { useTranslation } from "react-i18next";

import type { ProjectCreateInput } from "@/services/api/projects";

/** 新建项目弹窗的表单值；规划参数平铺，提交时收进 plan。 */
export type CreateProjectFormValues = {
    title: string;
    styleAnchor?: string;
    genre?: string;
    tone?: string;
    ratio?: string;
    episodeDurationSec?: number;
    dramaMode?: string;
    audience?: string;
    episodeCount?: number;
};

const RATIO_OPTIONS = [
    { value: "9:16", labelKey: "ratioVertical" },
    { value: "16:9", labelKey: "ratioHorizontal" },
    { value: "1:1", labelKey: "ratioSquare" },
];

const DRAMA_MODE_OPTIONS = [
    { value: "短剧向", labelKey: "dramaShort" },
    { value: "微电影", labelKey: "dramaMicro" },
];

/** 空字符串不下发，交给服务端按 Plan 默认值补齐。 */
function toCreateInput(values: CreateProjectFormValues): ProjectCreateInput {
    return {
        title: values.title.trim(),
        styleAnchor: values.styleAnchor?.trim() || undefined,
        plan: {
            genre: values.genre?.trim() || "",
            tone: values.tone?.trim() || "",
            ratio: values.ratio || "9:16",
            episodeDurationSec: values.episodeDurationSec || 60,
            dramaMode: values.dramaMode || "短剧向",
            audience: values.audience?.trim() || "",
            episodeCount: values.episodeCount || 1,
        },
    };
}

/** 新建项目弹窗：剧名 + 风格锚点 + 基础规划参数。 */
export function CreateProjectModal({
    open,
    submitting,
    onCancel,
    onSubmit,
}: {
    open: boolean;
    submitting: boolean;
    onCancel: () => void;
    onSubmit: (input: ProjectCreateInput) => void;
}) {
    const { t } = useTranslation();
    const [form] = Form.useForm<CreateProjectFormValues>();

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
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ ratio: "9:16", episodeDurationSec: 60, dramaMode: "短剧向", episodeCount: 1 }} onFinish={(values) => onSubmit(toCreateInput(values))}>
                <Form.Item name="title" label={t("projects.form.title")} rules={[{ required: true, message: t("projects.form.titleRequired") }]}>
                    <Input size="large" placeholder={t("projects.form.titlePlaceholder")} />
                </Form.Item>
                <Form.Item name="styleAnchor" label={t("projects.form.styleAnchor")} extra={t("projects.form.styleAnchorHelp")}>
                    <Input placeholder={t("projects.form.styleAnchorPlaceholder")} />
                </Form.Item>
                <div className="grid gap-4 sm:grid-cols-2">
                    <Form.Item name="genre" label={t("projects.form.genre")}>
                        <Input placeholder={t("projects.form.optional")} />
                    </Form.Item>
                    <Form.Item name="tone" label={t("projects.form.tone")}>
                        <Input placeholder={t("projects.form.optional")} />
                    </Form.Item>
                    <Form.Item name="ratio" label={t("projects.form.ratio")}>
                        <Select options={RATIO_OPTIONS.map((option) => ({ value: option.value, label: t(`projects.form.${option.labelKey}`) }))} />
                    </Form.Item>
                    <Form.Item name="dramaMode" label={t("projects.form.dramaMode")}>
                        <Select options={DRAMA_MODE_OPTIONS.map((option) => ({ value: option.value, label: t(`projects.form.${option.labelKey}`) }))} />
                    </Form.Item>
                    <Form.Item name="episodeDurationSec" label={t("projects.form.episodeDurationSec")}>
                        <InputNumber min={1} max={3600} className="w-full" />
                    </Form.Item>
                    <Form.Item name="episodeCount" label={t("projects.form.episodeCount")}>
                        <InputNumber min={1} max={999} className="w-full" />
                    </Form.Item>
                    <Form.Item name="audience" label={t("projects.form.audience")} className="sm:col-span-2">
                        <Input placeholder={t("projects.form.optional")} />
                    </Form.Item>
                </div>
            </Form>
        </Modal>
    );
}

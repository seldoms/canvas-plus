import { App, Button, Drawer, Input, InputNumber, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AssetRef, Scene, Shot } from "@/types/domain";

import type { ShotPatchInput } from "@/services/api/projects";

import { buildShotPatch, readCameraSpec, readShotFields, readTextOverlays, sceneLabel, SHOT_DURATION_MAX, SHOT_DURATION_MIN, SHOT_SIZES, shotRelation, type ShotFields } from "../storyboard-model";

const EMPTY_FIELDS: ShotFields = { durationSec: 0, shotSize: "", camera: "", action: "", dialogue: "", audio: "", prompt: "", negativePrompt: "" };

/**
 * 镜级就地编辑抽屉：右侧抽屉承载 6 个可编辑字段 + 关系摘要。
 * 选抽屉而非行内编辑的理由：字段多且要并列展示关系摘要，行内铺开会把三层列表撑高、破坏「一屏不滚动、列表内滚动」；
 * 抽屉只占右侧、选择某镜即打开，保存/失败提示集中在底部，失败时保留用户已输入内容、不自动关闭。
 */
export function ShotEditorDrawer({
    open,
    shot,
    scene,
    assets,
    saving,
    onClose,
    onSave,
}: {
    open: boolean;
    shot: Shot | null;
    scene: Scene | null;
    assets: AssetRef[];
    saving: boolean;
    onClose: () => void;
    onSave: (patch: ShotPatchInput) => Promise<unknown>;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [fields, setFields] = useState<ShotFields>(EMPTY_FIELDS);
    const shotId = shot?.id ?? "";

    // 打开或换镜时用该镜当前数据重置表单；保存失败不关闭，输入保留。
    useEffect(() => {
        setFields(shot ? readShotFields(shot) : EMPTY_FIELDS);
    }, [open, shotId]);

    const relation = useMemo(() => (shot ? shotRelation(shot, scene ?? undefined, assets) : null), [shot, scene, assets]);
    // 只读详情：结构化机位与画上文字（不属可编辑字段，缺失留空）。
    const cameraSpec = useMemo(() => (shot ? readCameraSpec(shot) : null), [shot]);
    const textOverlays = useMemo(() => (shot ? readTextOverlays(shot) : []), [shot]);
    const shotSizeOptions = useMemo(() => {
        const base = SHOT_SIZES.map((size) => ({ value: size, label: size }));
        return fields.shotSize && !SHOT_SIZES.includes(fields.shotSize) ? [...base, { value: fields.shotSize, label: fields.shotSize }] : base;
    }, [fields.shotSize]);

    const patch = (next: Partial<ShotFields>) => setFields((current) => ({ ...current, ...next }));
    const none = t("projects.storyboardView.none");

    const handleSave = async () => {
        try {
            await onSave(buildShotPatch(fields));
            message.success(t("projects.storyboardView.saved"));
            onClose();
        } catch (saveError) {
            message.error(t("projects.storyboardView.saveFailed", { message: saveError instanceof Error ? saveError.message : String(saveError) }));
        }
    };

    return (
        <Drawer
            open={open}
            width={420}
            onClose={onClose}
            title={shot ? t("projects.storyboardView.editShotTitle", { index: shot.index }) : t("projects.storyboardView.editShot")}
            footer={
                <Space className="flex justify-end">
                    <Button onClick={onClose}>{t("projects.storyboardView.cancel")}</Button>
                    <Button type="primary" loading={saving} disabled={!shot} onClick={handleSave}>
                        {t("projects.storyboardView.save")}
                    </Button>
                </Space>
            }
        >
            <Space direction="vertical" size={12} className="w-full">
                <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-xs text-stone-500 dark:text-stone-400">
                        <span className="block">{t("projects.storyboardView.fieldDurationSec")}</span>
                        <InputNumber className="w-full" size="small" min={SHOT_DURATION_MIN} max={SHOT_DURATION_MAX} value={fields.durationSec || undefined} onChange={(value) => patch({ durationSec: Number(value) || 0 })} />
                    </label>
                    <label className="space-y-1 text-xs text-stone-500 dark:text-stone-400">
                        <span className="block">{t("projects.storyboardView.fieldShotSize")}</span>
                        <Select className="w-full" size="small" value={fields.shotSize || undefined} options={shotSizeOptions} onChange={(value) => patch({ shotSize: value })} />
                    </label>
                </div>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("projects.storyboardView.fieldCamera")}</span>
                    <Input size="small" value={fields.camera} onChange={(event) => patch({ camera: event.target.value })} />
                </label>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("projects.storyboardView.fieldAction")}</span>
                    <Input.TextArea rows={2} value={fields.action} onChange={(event) => patch({ action: event.target.value })} />
                </label>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("projects.storyboardView.fieldDialogue")}</span>
                    <Input size="small" value={fields.dialogue} onChange={(event) => patch({ dialogue: event.target.value })} />
                </label>
                <label className="block space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span className="block">{t("projects.storyboardView.fieldPrompt")}</span>
                    <Input.TextArea rows={3} value={fields.prompt} onChange={(event) => patch({ prompt: event.target.value })} />
                </label>

                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                    <Typography.Text type="secondary" className="!text-xs">
                        {t("projects.storyboardView.relationTitle")}
                    </Typography.Text>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-stone-400">{t("projects.storyboardView.relationScene")}</dt>
                        <dd className="min-w-0 truncate">{scene && sceneLabel(scene) ? sceneLabel(scene) : none}</dd>
                        <dt className="text-stone-400">{t("projects.storyboardView.relationDuration")}</dt>
                        <dd>{fields.durationSec ? t("common.durationSeconds", { seconds: fields.durationSec }) : none}</dd>
                        <dt className="text-stone-400">{t("projects.storyboardView.relationShotSize")}</dt>
                        <dd>{fields.shotSize || none}</dd>
                        <dt className="text-stone-400">{t("projects.storyboardView.relationAssets")}</dt>
                        <dd className="min-w-0 truncate">{relation?.assetRefs.length ? relation.assetRefs.map((ref) => ref.bindingId).join("、") : none}</dd>
                        <dt className="text-stone-400">{t("projects.storyboardView.relationKeyframe")}</dt>
                        <dd>{relation?.keyframeSlots ? relation.keyframeSlots : none}</dd>
                        <dt className="text-stone-400">{t("projects.storyboardView.relationClip")}</dt>
                        <dd>{relation?.clipSlots ? relation.clipSlots : none}</dd>
                    </dl>
                </div>

                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                    <Typography.Text type="secondary" className="!text-xs">
                        {t("projects.rhythmBar.cameraSpecTitle")}
                    </Typography.Text>
                    {cameraSpec ? (
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecPosition")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.position || none}</dd>
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecHeight")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.height || none}</dd>
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecAngle")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.angle || none}</dd>
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecLens")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.lens || none}</dd>
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecAperture")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.aperture || none}</dd>
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecMovement")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.movement || none}</dd>
                            <dt className="text-stone-400">{t("projects.rhythmBar.cameraSpecFocus")}</dt>
                            <dd className="min-w-0 break-words">{cameraSpec.focus || none}</dd>
                        </dl>
                    ) : (
                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{none}</div>
                    )}
                </div>

                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                    <Typography.Text type="secondary" className="!text-xs">
                        {t("projects.rhythmBar.textOverlaysTitle")}
                    </Typography.Text>
                    {textOverlays.length ? (
                        <ul className="mt-2 space-y-1.5 text-xs">
                            {textOverlays.map((overlay, index) => (
                                <li key={`${overlay.text}-${index}`} className="space-y-0.5">
                                    <div className="flex flex-wrap items-baseline gap-x-2">
                                        <span className="font-medium text-stone-900 dark:text-stone-100">{overlay.text}</span>
                                        <span className="text-stone-400">{t(`projects.rhythmBar.textOverlaysKind.${overlay.kind}`, { defaultValue: overlay.kind })}</span>
                                    </div>
                                    {overlay.position ? <div className="text-stone-500 dark:text-stone-400">{overlay.position}</div> : null}
                                    {overlay.style ? <div className="text-stone-400">{overlay.style}</div> : null}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("projects.rhythmBar.noText")}</div>
                    )}
                </div>
            </Space>
        </Drawer>
    );
}

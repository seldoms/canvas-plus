import { Alert, Modal, Spin } from "antd";
import { useTranslation } from "react-i18next";

/**
 * 音色试听弹窗：站内播放，不跳新页。
 * 播放中显示加载态；失败给可读原因。点遮罩 / 按 Esc 关闭（closable=false，不留 × 按钮）。
 */
export function VoicePreviewModal({
    open,
    speaker,
    loading,
    error,
    url,
    onClose,
}: {
    open: boolean;
    speaker: string;
    loading: boolean;
    error: string;
    url: string;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Modal open={open} title={speaker} footer={null} centered closable={false} destroyOnHidden onCancel={onClose} width={420}>
            {loading ? (
                <div className="flex justify-center py-10">
                    <Spin />
                </div>
            ) : error ? (
                <Alert type="error" showIcon message={t("projects.casting.previewFailed")} description={error} />
            ) : url ? (
                <audio src={url} controls autoPlay className="w-full" />
            ) : null}
        </Modal>
    );
}

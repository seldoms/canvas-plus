import { useEffect, useRef, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";

import { srtToVtt } from "@/lib/subtitles";
import { fetchArtifactText } from "@/services/api/delivery";
import { resolveGatewayUrl } from "@/services/api/gateway";

/**
 * 成片预览（站内弹窗播放，禁跳新页）：成片 mp4 本身**不含字幕**（要过剪映精剪），
 * 预览时自动把该项目/run 的**独立 SRT** 拉下来转成 WebVTT（blob）挂成 `<track>`，
 * 让人看到「带字幕的效果」。无 SRT / 拉取失败 → **静默不挂**（不报错、不留空壳控件）。
 */
export function FilmPreviewModal({
    open,
    filmUrl,
    subtitlesUrl,
    onClose,
}: {
    open: boolean;
    filmUrl?: string;
    subtitlesUrl?: string | null;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [vttUrl, setVttUrl] = useState("");

    // 打开时把该 run 的独立 SRT 拉下来转成 WebVTT（blob）自动挂上；无 SRT / 失败 → 静默不挂。
    useEffect(() => {
        if (!open || !subtitlesUrl) {
            setVttUrl("");
            return;
        }
        let alive = true;
        let objectUrl = "";
        void fetchArtifactText(subtitlesUrl)
            .then((result) => {
                if (!alive || !result.ok) return;
                const vtt = srtToVtt(result.text);
                if (!vtt) return;
                objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
                setVttUrl(objectUrl);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            setVttUrl("");
        };
    }, [open, subtitlesUrl]);

    // 挂上后再兜一层强制显示字幕轨（`default` 之外，确保一打开就显示）。
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !vttUrl) return;
        const show = () => {
            const track = video.textTracks?.[0];
            if (track) track.mode = "showing";
        };
        show();
        video.addEventListener("loadedmetadata", show);
        return () => video.removeEventListener("loadedmetadata", show);
    }, [vttUrl]);

    if (!filmUrl) return null;
    return (
        <Modal open={open} footer={null} centered closable={false} destroyOnHidden width={880} onCancel={onClose}>
            {/* 站内弹窗播放，禁跳新页；无 SRT 时不渲染 `<track>`，不留空壳。 */}
            <video ref={videoRef} src={resolveGatewayUrl(filmUrl)} controls autoPlay playsInline className="mx-auto block max-h-[70vh] w-auto max-w-full rounded-md bg-black object-contain">
                {vttUrl ? <track kind="subtitles" src={vttUrl} srcLang="zh" label={t("projects.assembly.subtitleTrackLabel")} default /> : null}
            </video>
        </Modal>
    );
}

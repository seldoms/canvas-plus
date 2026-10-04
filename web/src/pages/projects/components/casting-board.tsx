import { Alert, Button, Card, Empty, Image, Spin, Typography } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CastingScope, CastingVoice } from "@/services/api/casting";
import type { TtsPreviewResult } from "@/services/api/tts";

import { castingBlockers, type CastingCharacterView } from "../casting-model";
import { IdentityCard } from "./identity-card";
import { VoicePreviewModal } from "./voice-preview-modal";

type PreviewState = { open: boolean; speaker: string; loading: boolean; error: string; url: string };

/**
 * 「角色定妆」工作区正文：每个角色一张身份卡（定脸 + 定声音），站内弹窗试听音色。
 *
 * 「拦住要可见」：casting 未完成或存在未确认角色时，关键帧 / 配音两个下游环节显示为「已阻断」
 * 并逐角色写清缺脸还是缺声 —— 复用既有 blocked 文案键（projects.workspace.gate.blockedStages
 * + pipeline.blockedItem），不另造一套。
 */
export function CastingBoard({
    views,
    voices,
    labels,
    loading,
    error,
    voicesError,
    saving,
    actionError,
    onConfirm,
    onModify,
    onVoiceChange,
    onGenerateFace,
    onPreview,
    onRetry,
}: {
    views: CastingCharacterView[];
    voices: string[];
    labels: Record<string, string>;
    loading: boolean;
    error: string;
    voicesError: string;
    saving: boolean;
    actionError: string;
    onConfirm: (characterId: string, scope: CastingScope) => void;
    onModify: (characterId: string, scope: CastingScope) => void;
    onVoiceChange: (characterId: string, patch: Partial<Pick<CastingVoice, "speaker" | "design" | "speed" | "language">>) => void;
    onGenerateFace: () => void;
    onPreview: (input: { speaker: string; design?: string; language?: string; speed?: number }) => Promise<TtsPreviewResult>;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    const [preview, setPreview] = useState<PreviewState>({ open: false, speaker: "", loading: false, error: "", url: "" });
    const separator = t("projects.casting.listSeparator");

    const blockers = useMemo(() => castingBlockers(views), [views]);
    const blocked = views.length === 0 || blockers.length > 0;

    const openPreview = async (character: CastingCharacterView) => {
        const speaker = character.voice.speaker;
        if (!speaker) return;
        setPreview({ open: true, speaker, loading: true, error: "", url: "" });
        try {
            const result = await onPreview({ speaker, design: character.voice.design, language: character.voice.language, speed: character.voice.speed });
            setPreview({ open: true, speaker, loading: false, error: "", url: result.url });
        } catch (caught) {
            setPreview({ open: true, speaker, loading: false, error: caught instanceof Error ? caught.message : String(caught), url: "" });
        }
    };

    if (error) {
        return (
            <Alert
                type="error"
                showIcon
                message={t("projects.casting.loadFailed")}
                description={error}
                action={
                    <Button size="small" onClick={onRetry}>
                        {t("projects.retry")}
                    </Button>
                }
            />
        );
    }

    if (loading && !views.length) {
        return (
            <div className="flex justify-center py-12">
                <Spin />
            </div>
        );
    }

    return (
        <section>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Typography.Title level={5} className="!mb-0">
                    {t("projects.casting.title")}
                </Typography.Title>
                <Typography.Text type="secondary" className="!text-xs">
                    {t("projects.casting.summary", { characters: views.length, confirmed: views.filter((view) => view.confirmed).length })}
                </Typography.Text>
            </div>

            {voicesError ? <Alert className="mb-2" type="warning" showIcon message={t("projects.casting.voicesFailed")} description={voicesError} /> : null}
            {actionError ? <Alert className="mb-2" type="error" showIcon message={t("projects.casting.saveFailed")} description={actionError} /> : null}

            {blocked ? (
                <Alert
                    className="mb-3"
                    type="warning"
                    showIcon
                    message={t("projects.workspace.gate.blockedStages", { stages: [t("pipeline.stages.keyframe"), t("pipeline.stages.audio")].join(separator) })}
                    description={
                        blockers.length ? (
                            <ul className="list-disc pl-4">
                                {blockers.map((blocker) => (
                                    <li key={blocker.characterId}>
                                        {t("pipeline.blockedItem", {
                                            itemId: blocker.name,
                                            reason: blocker.missing.map((scope) => t(scope === "face" ? "projects.casting.missingFace" : "projects.casting.missingVoice")).join(separator),
                                        })}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            t("projects.casting.empty")
                        )
                    }
                />
            ) : null}

            {views.length ? (
                <Image.PreviewGroup preview={{ closeIcon: false }}>
                    <div className="grid gap-3 lg:grid-cols-2">
                        {views.map((character) => (
                            <IdentityCard
                                key={character.characterId}
                                character={character}
                                voices={voices}
                                labels={labels}
                                saving={saving}
                                onConfirm={(scope) => onConfirm(character.characterId, scope)}
                                onModify={(scope) => onModify(character.characterId, scope)}
                                onVoiceChange={(patch) => onVoiceChange(character.characterId, patch)}
                                onGenerateFace={onGenerateFace}
                                onPreview={() => void openPreview(character)}
                            />
                        ))}
                    </div>
                </Image.PreviewGroup>
            ) : (
                <Card size="small">
                    <Empty className="py-8" description={t("projects.casting.empty")} />
                </Card>
            )}

            <VoicePreviewModal
                open={preview.open}
                speaker={preview.speaker}
                loading={preview.loading}
                error={preview.error}
                url={preview.url}
                onClose={() => setPreview((state) => ({ ...state, open: false }))}
            />
        </section>
    );
}

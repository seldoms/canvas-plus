import { Button, Card, Input, Select, Tag, Tooltip } from "antd";
import { Play, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { PreviewableMedia } from "@/components/workbench";
import type { CastingScope, CastingVoice } from "@/services/api/casting";

import type { CastingCharacterView } from "../casting-model";
import { artifactThumbSrc } from "@/lib/artifact-thumb";

/**
 * 一张「身份卡」：只做两件事 —— 定脸（正脸特写 + 三视图，可生成 / 确认）与定声音（音色库选音色 + 试听 + 确认）。
 * 脸 / 声各一个确认态，角色再加一个总确认；已确认后可「修改」（version+1，需重新确认）。
 * 无解释性小字：字段靠标签与按钮自解释，音色选项名直接用平台枚举原名。
 */
export function IdentityCard({
    character,
    voices,
    labels,
    saving,
    onConfirm,
    onModify,
    onVoiceChange,
    onGenerateFace,
    onPreview,
}: {
    character: CastingCharacterView;
    voices: string[];
    labels: Record<string, string>;
    saving: boolean;
    onConfirm: (scope: CastingScope) => void;
    onModify: (scope: CastingScope) => void;
    onVoiceChange: (patch: Partial<Pick<CastingVoice, "speaker" | "design" | "speed" | "language">>) => void;
    onGenerateFace: () => void;
    onPreview: () => void;
}) {
    const { t } = useTranslation();
    const [design, setDesign] = useState(character.voice.design);
    useEffect(() => setDesign(character.voice.design), [character.voice.design]);

    const confirmedTag = (ok: boolean) => <Tag color={ok ? "success" : "default"}>{t(ok ? "projects.casting.confirmed" : "projects.casting.unconfirmed")}</Tag>;
    const faceReady = character.hasFace;
    const voiceReady = Boolean(character.voice.speaker);

    const commitDesign = () => {
        if (design !== character.voice.design) onVoiceChange({ design });
    };

    return (
        <Card size="small">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-stone-950 dark:text-stone-100">{character.name}</span>
                {confirmedTag(character.confirmed)}
                <span className="text-xs text-stone-400 dark:text-stone-500">v{character.version}</span>
                <span className="ml-auto flex items-center gap-2">
                    {character.confirmed ? (
                        <Button size="small" disabled={saving} onClick={() => onModify("all")}>
                            {t("projects.casting.modify")}
                        </Button>
                    ) : (
                        <Button size="small" type="primary" disabled={!faceReady || !voiceReady || saving} onClick={() => onConfirm("all")}>
                            {t("projects.casting.confirmAll")}
                        </Button>
                    )}
                </span>
            </div>

            <div className="mt-2 grid gap-3 md:grid-cols-2">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-stone-500 dark:text-stone-400">{t("projects.casting.face")}</span>
                        {confirmedTag(character.face.confirmed)}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                        {character.closeupUrl ? (
                            <PreviewableMedia
                                id={`${character.characterId}:closeup`}
                                kind="image"
                                src={character.closeupUrl}
                                thumbSrc={artifactThumbSrc(character.closeupUrl)}
                                title={character.name}
                                className="block size-20 overflow-hidden rounded border border-stone-200/80 bg-black/5 dark:border-stone-700/80 dark:bg-white/5"
                            >
                                <img src={artifactThumbSrc(character.closeupUrl)} alt={character.name} className="h-full w-full object-cover" />
                            </PreviewableMedia>
                        ) : null}
                        {character.turnaroundUrls.map((url) => (
                            <PreviewableMedia
                                key={url}
                                id={`${character.characterId}:turnaround:${url}`}
                                kind="image"
                                src={url}
                                thumbSrc={artifactThumbSrc(url)}
                                title={character.name}
                                className="block size-20 overflow-hidden rounded border border-stone-200/80 bg-black/5 dark:border-stone-700/80 dark:bg-white/5"
                            >
                                <img src={artifactThumbSrc(url)} alt={character.name} className="h-full w-full object-cover" />
                            </PreviewableMedia>
                        ))}
                        <Button size="small" icon={<Sparkles className="size-4" />} onClick={onGenerateFace}>
                            {t(faceReady ? "projects.casting.regenerate" : "projects.casting.generate")}
                        </Button>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                        {character.face.confirmed ? (
                            <Button size="small" disabled={saving} onClick={() => onModify("face")}>
                                {t("projects.casting.modify")}
                            </Button>
                        ) : (
                            <Button size="small" type="primary" disabled={!faceReady || saving} onClick={() => onConfirm("face")}>
                                {t("projects.casting.confirmFace")}
                            </Button>
                        )}
                    </div>
                </div>

                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-stone-500 dark:text-stone-400">{t("projects.casting.voice")}</span>
                        {confirmedTag(character.voice.confirmed)}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                        <Select
                            size="small"
                            className="min-w-32 flex-1"
                            showSearch
                            value={character.voice.speaker || undefined}
                            placeholder={t("projects.casting.voicePlaceholder")}
                            aria-label={t("projects.casting.voice")}
                            options={voices.map((voice) => ({ value: voice, label: voice, title: labels[voice] || voice }))}
                            onChange={(speaker: string) => onVoiceChange({ speaker })}
                        />
                        <Tooltip title={t("projects.casting.preview")}>
                            <Button size="small" icon={<Play className="size-4" />} disabled={!voiceReady} onClick={onPreview} aria-label={t("projects.casting.preview")} />
                        </Tooltip>
                    </div>
                    <Input
                        size="small"
                        className="mt-1"
                        value={design}
                        placeholder={t("projects.casting.designPlaceholder")}
                        onChange={(event) => setDesign(event.target.value)}
                        onBlur={commitDesign}
                        onPressEnter={commitDesign}
                    />
                    <div className="mt-1 flex items-center gap-2">
                        {character.voice.confirmed ? (
                            <Button size="small" disabled={saving} onClick={() => onModify("voice")}>
                                {t("projects.casting.modify")}
                            </Button>
                        ) : (
                            <Button size="small" type="primary" disabled={!voiceReady || saving} onClick={() => onConfirm("voice")}>
                                {t("projects.casting.confirmVoice")}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </Card>
    );
}

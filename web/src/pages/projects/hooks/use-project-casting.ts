import { useCallback, useEffect, useMemo, useState } from "react";

import { getPipelineRun, runPipelineStage, type GatewayPipelineRun } from "@/services/api/gateway";
import { saveCastingOutput, type CastingScope, type CastingVoice } from "@/services/api/casting";
import { listTtsVoices, previewTtsVoice, type TtsPreviewResult } from "@/services/api/tts";

import { buildCastingViews, castingCharacters, castingComplete, setConfirmation, updateVoice } from "../casting-model";

/**
 * 「角色定妆」工作区私有 hook：取 run 的 casting 产物 + 平台音色榜，并集中确认 / 修改 / 试听动作。
 *
 * 职责边界：请求全部经 services/api（tts / casting / gateway）；纯数据整理在 casting-model.ts；
 * 页面只编排、组件只渲染。run 详情内嵌整本小说，故只在 runId 或阶段状态变化时拉一次，不轮询。
 */
export function useProjectCasting({ runId, stageStatus }: { runId: string; stageStatus: string }) {
    const [run, setRun] = useState<GatewayPipelineRun | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [voices, setVoices] = useState<string[]>([]);
    const [labels, setLabels] = useState<Record<string, string>>({});
    const [languages, setLanguages] = useState<string[]>([]);
    const [voicesError, setVoicesError] = useState("");
    const [voicesLoading, setVoicesLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [actionError, setActionError] = useState("");

    const loadRun = useCallback(async () => {
        if (!runId) {
            setRun(null);
            setError("");
            return;
        }
        setLoading(true);
        try {
            setRun(await getPipelineRun(runId));
            setError("");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [runId]);

    const loadVoices = useCallback(async () => {
        setVoicesLoading(true);
        try {
            const data = await listTtsVoices();
            setVoices(data.voices);
            setLabels(data.labels);
            setLanguages(data.languages);
            setVoicesError("");
        } catch (caught) {
            setVoices([]);
            setLabels({});
            setLanguages([]);
            setVoicesError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setVoicesLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadRun();
    }, [loadRun, stageStatus]);

    useEffect(() => {
        void loadVoices();
    }, [loadVoices]);

    const characters = useMemo(() => castingCharacters(run), [run]);
    const views = useMemo(() => buildCastingViews(run), [run]);
    const complete = useMemo(() => castingComplete(run), [run]);

    /** 落盘 casting 产物（复用阶段 input 端点）：成功即以服务端返回的 run 覆盖本地。 */
    const save = useCallback(
        async (nextCharacters: ReturnType<typeof setConfirmation>) => {
            if (!runId) return;
            setSaving(true);
            setActionError("");
            try {
                const updated = await saveCastingOutput(runId, { characters: nextCharacters });
                setRun(updated);
            } catch (caught) {
                setActionError(caught instanceof Error ? caught.message : String(caught));
            } finally {
                setSaving(false);
            }
        },
        [runId],
    );

    const confirm = useCallback((characterId: string, scope: CastingScope) => void save(setConfirmation(characters, characterId, scope, true)), [characters, save]);
    const modify = useCallback((characterId: string, scope: CastingScope) => void save(setConfirmation(characters, characterId, scope, false)), [characters, save]);
    const changeVoice = useCallback(
        (characterId: string, patch: Partial<Pick<CastingVoice, "speaker" | "design" | "speed" | "language">>) => void save(updateVoice(characters, characterId, patch)),
        [characters, save],
    );

    /** 生成定妆脸：跑 casting 阶段（后端按缺脸角色生成正脸特写 + 三视图）。完成后由工作区 refresh 触发重取。 */
    const generateFace = useCallback(async () => {
        if (!runId) return;
        setActionError("");
        try {
            await runPipelineStage(runId, "casting");
        } catch (caught) {
            setActionError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [runId]);

    const preview = useCallback(
        (input: { speaker: string; design?: string; language?: string; speed?: number }): Promise<TtsPreviewResult> =>
            previewTtsVoice({ speaker: input.speaker, design: input.design, language: input.language, speed: input.speed }),
        [],
    );

    const refresh = useCallback(async () => {
        await Promise.all([loadRun(), loadVoices()]);
    }, [loadRun, loadVoices]);

    return { run, loading, error, characters, views, complete, voices, labels, languages, voicesError, voicesLoading, saving, actionError, confirm, modify, changeVoice, generateFace, preview, refresh };
}

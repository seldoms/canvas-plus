import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPipelineQualityCheck, runPipelineQualityCheck, type GatewayQualityReport } from "@/services/api/gateway";

/** 项目后期私有质检状态；切换 run 后忽略旧请求，报告以服务端落盘为准。 */
export function usePipelineQualityCheck(runId: string, filmUrl?: string) {
    const [report, setReport] = useState<GatewayQualityReport | null>(null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState("");
    const generation = useRef(0);

    useEffect(() => {
        generation.current += 1;
        const request = generation.current;
        setReport(null);
        setError("");
        setChecking(false);
        if (runId && filmUrl) {
            void fetchPipelineQualityCheck(runId)
                .then((value) => {
                    if (request === generation.current) setReport(value?.stage === "assembly" || value?.stage === null ? value : null);
                })
                .catch((caught) => {
                    if (request === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
                });
        }
        return () => { generation.current += 1; };
    }, [runId, filmUrl]);

    const check = useCallback(async () => {
        if (!runId || checking) return;
        const request = ++generation.current;
        setChecking(true);
        setError("");
        try {
            const value = await runPipelineQualityCheck(runId, "assembly");
            if (request === generation.current) setReport(value);
        } catch (caught) {
            if (request === generation.current) setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            if (request === generation.current) setChecking(false);
        }
    }, [runId, checking]);

    return { report, checking, error, check };
}

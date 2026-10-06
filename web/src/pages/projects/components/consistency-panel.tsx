import { Alert, Button, Card, Collapse, Space, Tag, Typography } from "antd";
import { Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveGatewayUrl } from "@/services/api/gateway";

/** 体检返回的一条问题（与后端 asset-consistency.js 的 ConsistencyIssue 对齐）。 */
type ConsistencyIssue = {
    severity: "error" | "warn";
    kind: string;
    message: string;
    refIds: string[];
    shotIds: string[];
};

type ConsistencyResult = { ok: boolean; errors: number; warnings: number; text: string; runId: string | null; issues: ConsistencyIssue[] };

/**
 * 素材口径体检面板 —— **只读的人工保险**。
 *
 * 为什么放在资产页顶部而不是做成独立页面：素材出问题的根因九成在
 * 「资产引用 ↔ 剧本场次 ↔ 设计锚点 ↔ 镜头」这四层的口径上，而资产页正是
 * 这几层的交汇处。放在这里，用户在改资产之前就能看见「现在改会踩到什么」。
 *
 * 刻意做到很轻：
 *   - **默认折叠**。没问题时不占版面；有问题时一行摘要 + 展开看清单。
 *   - **只读**。不提供「一键修复」——诊断与处置必须分开，这个工具一旦能改数据，
 *     它自己就成了新的写入源，下次别的 Agent 照样会乱，且失去可追溯性。
 *   - **可复制**。清单是可复制的纯文本，方便贴给 Agent 或记进交接文档。
 */
export function ConsistencyPanel({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const [data, setData] = useState<ConsistencyResult | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        if (!projectId) return;
        setLoading(true);
        setError("");
        try {
            const response = await fetch(resolveGatewayUrl(`/api/projects/${encodeURIComponent(projectId)}/asset-consistency`));
            const payload = await response.json().catch(() => null);
            if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
            setData(payload as ConsistencyResult);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (error) {
        return (
            <Alert
                type="warning"
                showIcon
                className="mb-2"
                message={t("projects.consistency.loadFailed")}
                description={error}
                action={
                    <Button size="small" onClick={() => void load()}>
                        {t("projects.retry")}
                    </Button>
                }
            />
        );
    }

    // 还没加载出结果时不占版面，避免每次进页面先闪一个空卡片。
    if (!data) return null;

    if (data.ok) {
        return (
            <Alert
                type="success"
                showIcon
                icon={<ShieldCheck className="size-3.5" />}
                className="mb-2"
                message={t("projects.consistency.ok")}
                action={
                    <Button size="small" icon={<RefreshCw className="size-3" />} onClick={() => void load()} loading={loading}>
                        {t("projects.consistency.recheck")}
                    </Button>
                }
            />
        );
    }

    const plain = data.issues.map((issue) => `[${issue.severity === "error" ? "错误" : "提醒"}] ${issue.kind}: ${issue.message}`).join("\n");

    return (
        <Card size="small" className="mb-2">
            <div className="mb-1 flex flex-wrap items-center gap-2">
                <Typography.Text strong className="!text-sm">
                    {t("projects.consistency.title")}
                </Typography.Text>
                <Space size={4}>
                    {data.errors ? <Tag color="error">{t("projects.consistency.errors", { count: data.errors })}</Tag> : null}
                    {data.warnings ? <Tag color="warning">{t("projects.consistency.warnings", { count: data.warnings })}</Tag> : null}
                </Space>
                <span className="text-xs text-stone-500 dark:text-stone-400">{data.text}</span>
                <span className="grow" />
                <Button
                    size="small"
                    icon={<Copy className="size-3.5" />}
                    onClick={() => {
                        void navigator.clipboard?.writeText(plain).then(
                            () => undefined,
                            () => undefined,
                        );
                    }}
                >
                    {t("projects.consistency.copy")}
                </Button>
                <Button size="small" icon={<RefreshCw className="size-3" />} onClick={() => void load()} loading={loading}>
                    {t("projects.consistency.recheck")}
                </Button>
            </div>
            <Collapse
                size="small"
                ghost
                items={[
                    {
                        key: "issues",
                        label: t("projects.consistency.expand"),
                        children: (
                            <ul className="m-0 list-disc space-y-1 pl-4 text-xs">
                                {data.issues.map((issue, index) => (
                                    <li key={`${issue.kind}:${index}`}>
                                        <Tag color={issue.severity === "error" ? "error" : "warning"} className="!mr-1">
                                            {t(`projects.consistency.kinds.${issue.kind}`, { defaultValue: issue.kind })}
                                        </Tag>
                                        <span className="break-words">{issue.message}</span>
                                    </li>
                                ))}
                            </ul>
                        ),
                    },
                ]}
            />
            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("projects.consistency.readonlyHint")}</div>
        </Card>
    );
}
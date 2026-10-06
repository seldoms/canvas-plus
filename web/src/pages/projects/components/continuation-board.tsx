import { useState } from "react";
import { App, Alert, Button, Card, Empty, Input, InputNumber, Modal, Spin, Tag, Tooltip, Typography } from "antd";
import { GitBranch, RotateCw, ShieldCheck, ShieldX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ProjectSlotCascadeSelects, useProjectSlotCascade } from "@/components/project-slot-cascade";
import { MediaPreviewGroup, PreviewableMedia } from "@/components/workbench";
import { artifactThumbSrc } from "@/lib/artifact-thumb";
import { cn } from "@/lib/utils";
import { resolveGatewayUrl } from "@/services/api/gateway";
import { selectSlotCandidate, type ContinuationChain, type ContinuationSegment } from "@/services/api/projects";

import { adoptableJobId, branchOrigin, canAdopt, canBranchFrom, canResume, needsSeamReview, seamMetrics, seamReviewState } from "../continuation-model";
import { useContinuationChains } from "../hooks/use-continuation-chains";

/** 段状态 → Tag 颜色（候选状态口径：pending/queued/running/done/failed/canceled）。 */
const SEGMENT_STATUS_COLOR: Record<string, string> = { pending: "default", queued: "default", running: "processing", done: "success", failed: "error", canceled: "default" };
/** 链状态 → Tag 颜色（服务端派生的四种：running/done/failed/in_progress）。 */
const CHAIN_STATUS_COLOR: Record<string, string> = { running: "processing", done: "success", failed: "error", in_progress: "default" };
/** 采用状态 → Tag 颜色。 */
const APPROVAL_COLOR: Record<string, string> = { pending: "default", approved: "success", rejected: "error", superseded: "default" };

/** 链上动作集合：一路从页面透传到段行，避免每层各拆一套 props。 */
type ChainActions = {
    /** 当前 busy 动作键（hook 的 busy）。 */
    busy: string;
    /** 正在采用/撤销的候选 jobId。 */
    adopting: string;
    onResume: (chainId: string) => void;
    onAdopt: (jobId: string | null) => void;
    onBranch: (segment: ContinuationSegment) => void;
    onReview: (segment: ContinuationSegment) => void;
};

/**
 * 视频·后期工作区的 H3 续接链面板（M3.5-D2）：
 * 集/镜头级联选择（复用共用选择器，槽位角色 clip）→ 开新链 → 按链铺开各段（状态 / 产物预览 / 接缝指标）
 * → 续跑、分叉、接缝复核、采用整条 take。
 *
 * **只读事实 + 动作**：链与段全部来自服务端派生视图（段在跑时轮询），本地不做乐观更新；
 * 不做时间线编辑器（D35-8）。提示词编译是后端内部机制，界面上不出现编译结果与「已强化」类痕迹。
 */
export function ContinuationBoard({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const cascade = useProjectSlotCascade({ active: true, projectId, slotRole: "clip" });
    const chains = useContinuationChains({ projectId, shotId: cascade.shotId });
    const [adopting, setAdopting] = useState("");
    const [branchFrom, setBranchFrom] = useState<ContinuationSegment | null>(null);
    const [reviewTarget, setReviewTarget] = useState<ContinuationSegment | null>(null);
    const adoptedJobId = cascade.slot?.selected ?? null;

    /** 采用 / 撤销采用：写 slot.selected（jobId 传 null 撤销），随后刷新链视图（服务端会改整链采用状态）。 */
    const handleSelect = async (jobId: string | null) => {
        if (!cascade.target) return;
        setAdopting(jobId ?? "revoke");
        try {
            const next = await selectSlotCandidate(cascade.target.projectId, cascade.target.shotId, cascade.target.slotId, jobId);
            cascade.setSlot(next);
            await chains.refresh();
            message.success(jobId ? t("projects.continuation.chain.adoptSuccess") : t("projects.continuation.chain.revokeSuccess"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setAdopting("");
        }
    };

    const actions: ChainActions = {
        busy: chains.busy,
        adopting,
        onResume: (chainId) => void chains.resumeChain(chainId),
        onAdopt: (jobId) => void handleSelect(jobId),
        onBranch: setBranchFrom,
        onReview: setReviewTarget,
    };

    return (
        <section className="space-y-4">
            <Card size="small">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Typography.Title level={5} className="!mb-0">
                        {t("projects.continuation.title")}
                    </Typography.Title>
                    <Typography.Text type="secondary" className="!text-xs">
                        {t("projects.continuation.subtitle")}
                    </Typography.Text>
                </div>
                <ProjectSlotCascadeSelects cascade={cascade} />
                <StartChainForm disabled={!cascade.shotId} busy={chains.busy === "start"} onStart={chains.startChain} />
            </Card>

            {chains.error ? (
                <Alert
                    type="error"
                    showIcon
                    message={t("projects.continuation.loadFailed")}
                    description={chains.error}
                    action={
                        <Button size="small" onClick={() => void chains.refresh()}>
                            {t("projects.retry")}
                        </Button>
                    }
                />
            ) : null}

            {chains.loading && !chains.chains.length ? (
                <div className="flex justify-center py-12">
                    <Spin />
                </div>
            ) : null}

            {!chains.loading && !chains.chains.length ? <Empty className="py-12" description={t("projects.continuation.empty")} /> : null}

            {chains.chains.length ? (
                <MediaPreviewGroup>
                    <div className="space-y-3">
                        {chains.chains.map((chain) => (
                            <ChainCard key={chain.chainId} chain={chain} allChains={chains.chains} adoptedJobId={adoptedJobId} actions={actions} />
                        ))}
                    </div>
                </MediaPreviewGroup>
            ) : null}

            <BranchModal
                projectId={projectId}
                shotId={cascade.shotId}
                target={branchFrom}
                busy={branchFrom ? chains.busy === `branch:${branchFrom.jobId}` : false}
                onSubmit={async (input) => {
                    const ok = await chains.startBranch({ parentCandidateId: branchFrom?.jobId ?? "", ...input });
                    if (ok) setBranchFrom(null);
                }}
                onClose={() => setBranchFrom(null)}
            />

            <ReviewModal
                target={reviewTarget}
                busy={reviewTarget ? chains.busy === `review:${reviewTarget.jobId}:approved` || chains.busy === `review:${reviewTarget.jobId}:rejected` : false}
                onSubmit={async (reviewed, note) => {
                    const ok = await chains.reviewSeam(reviewTarget?.jobId ?? "", reviewed, note);
                    if (ok) setReviewTarget(null);
                }}
                onClose={() => setReviewTarget(null)}
            />
        </section>
    );
}

/** 开新链表单：提示词 + 段数（1..8）+ 可选种子；成功后清空，方便连着开下一条。 */
function StartChainForm({ disabled, busy, onStart }: { disabled: boolean; busy: boolean; onStart: (input: { prompt: string; segments: number; seed?: number | null }) => Promise<boolean> }) {
    const { t } = useTranslation();
    const [prompt, setPrompt] = useState("");
    const [segments, setSegments] = useState<number>(2);
    const [seed, setSeed] = useState<number | null>(null);

    const submit = async () => {
        if (!prompt.trim() || !segments) return;
        const ok = await onStart({ prompt: prompt.trim(), segments, seed });
        if (ok) {
            setPrompt("");
            setSegments(2);
            setSeed(null);
        }
    };

    return (
        <div className="mt-3 space-y-2 border-t border-stone-200 pt-3 dark:border-stone-700">
            <Input.TextArea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                placeholder={t("projects.continuation.start.promptPlaceholder")}
                aria-label={t("projects.continuation.start.prompt")}
            />
            <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                    <span className="mb-1 block text-xs opacity-60">{t("projects.continuation.start.segments")}</span>
                    <InputNumber className="w-24" min={1} max={8} value={segments} onChange={(value) => setSegments(Number(value) || 1)} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs opacity-60">{t("projects.continuation.start.seed")}</span>
                    <InputNumber className="w-32" min={0} value={seed} placeholder={t("projects.continuation.start.seedAuto")} onChange={(value) => setSeed(value === null ? null : Number(value))} />
                </label>
                <Button type="primary" className="ml-auto" loading={busy} disabled={disabled || !prompt.trim()} onClick={() => void submit()}>
                    {t("projects.continuation.start.submit")}
                </Button>
            </div>
        </div>
    );
}

/** 一条链：链头（状态 / 分叉来源 / 续跑 / 采用）+ 各段行。 */
function ChainCard({ chain, allChains, adoptedJobId, actions }: { chain: ContinuationChain; allChains: ContinuationChain[]; adoptedJobId: string | null; actions: ChainActions }) {
    const { t } = useTranslation();
    const origin = branchOrigin(allChains, chain);
    const target = adoptableJobId(chain);
    const adopted = target !== null && adoptedJobId === target;
    const resuming = actions.busy === `resume:${chain.chainId}`;
    const adopting = actions.adopting === target || actions.adopting === "revoke";

    return (
        <Card size="small">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Tooltip title={t("projects.continuation.chain.takeTooltip", { takeId: chain.takeId })}>
                    <span className="font-mono text-xs text-stone-500 dark:text-stone-400">{chain.chainId}</span>
                </Tooltip>
                <Tag color={CHAIN_STATUS_COLOR[chain.status] ?? "default"} className="m-0">
                    {t(`projects.continuation.chain.status.${chain.status}`, { defaultValue: chain.status })}
                </Tag>
                {origin ? (
                    <span className="text-xs text-stone-400 dark:text-stone-500">
                        {t("projects.continuation.chain.branchFrom", { chain: origin.chainId, index: origin.segmentIndex })}
                    </span>
                ) : null}
                <span className="text-xs text-stone-400 dark:text-stone-500">{t("projects.continuation.chain.segmentCount", { count: chain.segments.length })}</span>

                <div className="ml-auto flex items-center gap-1.5">
                    {canResume(chain) ? (
                        <Button size="small" icon={<RotateCw className="size-3.5" />} loading={resuming} disabled={Boolean(actions.busy) && !resuming} onClick={() => actions.onResume(chain.chainId)}>
                            {t("projects.continuation.chain.resume")}
                        </Button>
                    ) : null}
                    {adopted ? (
                        <>
                            <span className="text-xs font-medium">{t("projects.continuation.chain.adopted")}</span>
                            <Button size="small" type="text" loading={adopting} onClick={() => actions.onAdopt(null)}>
                                {t("projects.continuation.chain.revoke")}
                            </Button>
                        </>
                    ) : (
                        <Tooltip title={t("projects.continuation.chain.adoptHint")}>
                            <Button size="small" loading={adopting} disabled={!canAdopt(chain)} onClick={() => actions.onAdopt(target)}>
                                {t("projects.continuation.chain.adopt")}
                            </Button>
                        </Tooltip>
                    )}
                </div>
            </div>

            <div className="mt-2 space-y-1.5">
                {chain.segments.map((segment) => (
                    <SegmentRow key={segment.jobId} segment={segment} actions={actions} />
                ))}
            </div>
        </Card>
    );
}

/** 一段：段序 / 状态 / 产物预览 / 采用状态 / 接缝指标与复核动作 / 分叉入口。 */
function SegmentRow({ segment, actions }: { segment: ContinuationSegment; actions: ChainActions }) {
    const { t } = useTranslation();
    const metrics = seamMetrics(segment.seam);
    const review = seamReviewState(segment);
    const src = resolveGatewayUrl(segment.artifactUrl || "");
    const reviewBusy = actions.busy === `review:${segment.jobId}:approved` || actions.busy === `review:${segment.jobId}:rejected`;
    const branching = actions.busy === `branch:${segment.jobId}`;

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-stone-200/80 px-2 py-1.5 dark:border-stone-700/80">
            <span className="w-14 shrink-0 text-xs font-medium">{t("projects.continuation.segment.label", { index: segment.segmentIndex })}</span>
            <Tag color={SEGMENT_STATUS_COLOR[segment.status] ?? "default"} className="m-0">
                {t(`projects.continuation.segment.status.${segment.status}`, { defaultValue: segment.status })}
            </Tag>

            {segment.artifactUrl ? (
                <PreviewableMedia
                    id={`continuation:${segment.jobId}`}
                    kind="video"
                    src={src}
                    thumbSrc={artifactThumbSrc(src)}
                    title={`${segment.jobId}`}
                    className={cn("block h-20 shrink-0 overflow-hidden rounded border border-stone-200/80 bg-black/5 dark:border-stone-700/80 dark:bg-white/5")}
                />
            ) : (
                <span className="flex h-20 w-12 shrink-0 items-center justify-center rounded border border-dashed border-stone-200 text-[10px] text-stone-400 dark:border-stone-700 dark:text-stone-500">
                    {t("projects.continuation.segment.noArtifact")}
                </span>
            )}

            {segment.approvalStatus ? (
                <Tag color={APPROVAL_COLOR[segment.approvalStatus] ?? "default"} className="m-0">
                    {t(`projects.continuation.approval.${segment.approvalStatus}`, { defaultValue: segment.approvalStatus })}
                </Tag>
            ) : null}

            {metrics.length ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    {metrics.map((metric) => (
                        <span key={metric.key} className={cn(metric.warn ? "font-medium text-amber-600 dark:text-amber-400" : "text-stone-500 dark:text-stone-400")}>
                            {t(`projects.continuation.seam.${metric.key}`)}
                            {metric.value ? <span className="ml-1 font-mono">{metric.value}</span> : null}
                        </span>
                    ))}
                </span>
            ) : (
                <span className="text-xs text-stone-400 dark:text-stone-500">{t("projects.continuation.seam.none")}</span>
            )}

            {needsSeamReview(segment) ? (
                <span className="flex items-center gap-1">
                    <Tag color="warning" className="m-0">
                        {t("projects.continuation.segment.needsReview")}
                    </Tag>
                    <Button size="small" type="text" icon={<ShieldCheck className="size-3.5" />} loading={reviewBusy} onClick={() => actions.onReview(segment)}>
                        {t("projects.continuation.segment.review")}
                    </Button>
                </span>
            ) : review === "approved" || review === "rejected" ? (
                <span className={cn("flex items-center gap-1 text-xs", review === "approved" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {review === "approved" ? <ShieldCheck className="size-3.5" /> : <ShieldX className="size-3.5" />}
                    {t(`projects.continuation.segment.reviewed.${review}`)}
                </span>
            ) : null}

            {canBranchFrom(segment) ? (
                <Button size="small" type="text" className="ml-auto" icon={<GitBranch className="size-3.5" />} loading={branching} onClick={() => actions.onBranch(segment)}>
                    {t("projects.continuation.segment.branch")}
                </Button>
            ) : null}
        </div>
    );
}

/** 分叉表单：从某段之后另起一条链（父段尾帧续接），原链不改写。 */
function BranchModal({
    projectId,
    shotId,
    target,
    busy,
    onSubmit,
    onClose,
}: {
    projectId: string;
    shotId: string;
    target: ContinuationSegment | null;
    busy: boolean;
    onSubmit: (input: { prompt: string; segments: number; seed?: number | null }) => Promise<void>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [prompt, setPrompt] = useState("");
    const [segments, setSegments] = useState<number>(2);
    const [seed, setSeed] = useState<number | null>(null);

    const close = () => {
        setPrompt("");
        setSegments(2);
        setSeed(null);
        onClose();
    };

    return (
        <Modal
            title={t("projects.continuation.branch.title", { index: target?.segmentIndex ?? 0 })}
            open={Boolean(target)}
            onCancel={close}
            centered
            width={560}
            okText={t("projects.continuation.branch.submit")}
            cancelText={t("common.cancel")}
            okButtonProps={{ loading: busy, disabled: !prompt.trim() || !shotId || !projectId }}
            onOk={() => void onSubmit({ prompt: prompt.trim(), segments, seed })}
        >
            <div className="space-y-3 pt-2">
                <div className="text-xs opacity-60">{t("projects.continuation.branch.hint")}</div>
                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder={t("projects.continuation.start.promptPlaceholder")} />
                <div className="flex flex-wrap gap-3">
                    <label className="block">
                        <span className="mb-1 block text-xs opacity-60">{t("projects.continuation.start.segments")}</span>
                        <InputNumber className="w-24" min={1} max={8} value={segments} onChange={(value) => setSegments(Number(value) || 1)} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-xs opacity-60">{t("projects.continuation.start.seed")}</span>
                        <InputNumber className="w-32" min={0} value={seed} placeholder={t("projects.continuation.start.seedAuto")} onChange={(value) => setSeed(value === null ? null : Number(value))} />
                    </label>
                </div>
            </div>
        </Modal>
    );
}

/** 接缝复核：判定通过 / 驳回，可带备注（驳回应写清原因，便于他人接手）。 */
function ReviewModal({ target, busy, onSubmit, onClose }: { target: ContinuationSegment | null; busy: boolean; onSubmit: (reviewed: "approved" | "rejected", note?: string) => Promise<void>; onClose: () => void }) {
    const { t } = useTranslation();
    const [note, setNote] = useState("");
    const metrics = seamMetrics(target?.seam ?? null);

    const close = () => {
        setNote("");
        onClose();
    };
    const submit = (reviewed: "approved" | "rejected") => void onSubmit(reviewed, note.trim() || undefined);

    return (
        <Modal
            title={t("projects.continuation.review.title", { index: target?.segmentIndex ?? 0 })}
            open={Boolean(target)}
            onCancel={close}
            centered
            width={520}
            footer={[
                <Button key="cancel" onClick={close}>
                    {t("common.cancel")}
                </Button>,
                <Button key="reject" danger loading={busy} onClick={() => submit("rejected")}>
                    {t("projects.continuation.review.reject")}
                </Button>,
                <Button key="approve" type="primary" loading={busy} onClick={() => submit("approved")}>
                    {t("projects.continuation.review.approve")}
                </Button>,
            ]}
        >
            <div className="space-y-3 pt-2">
                {metrics.length ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {metrics.map((metric) => (
                            <span key={metric.key} className={cn(metric.warn ? "font-medium text-amber-600 dark:text-amber-400" : "opacity-70")}>
                                {t(`projects.continuation.seam.${metric.key}`)}
                                {metric.value ? <span className="ml-1 font-mono">{metric.value}</span> : null}
                            </span>
                        ))}
                    </div>
                ) : null}
                <div className="text-xs opacity-60">{t("projects.continuation.review.hint")}</div>
                <Input.TextArea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder={t("projects.continuation.review.note")} maxLength={200} showCount />
            </div>
        </Modal>
    );
}

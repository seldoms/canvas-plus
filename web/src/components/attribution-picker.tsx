import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ProjectSlotCascadeSelects, useProjectSlotCascade, type ProjectSlotCascade, type SlotCascadeTarget } from "@/components/project-slot-cascade";

/**
 * 生成归因选择器（P2-B4）：生图 / 生视频工作台里选「这张图属于哪一集的哪一镜」。
 *
 * 为什么放在工作台而不是只让流水线内部写归因：产物归因是**粘合剂**（产品骨架 §1）——
 * 用户手工作品不回项目，资料包就永远缺料，定妆/服化道阶段只能干等。
 *
 * 三个必须守住的约束（否则选了等于没选，且**静默**失效）：
 *  1. `projectId + shotId + slotId` 三者齐全，缺一个任务终态就不会投影为项目槽位候选
 *     （服务端 slot-candidates.js 的三元组判定）。级联 hook 只在三者齐时给出 target。
 *  2. **绝不写 runId / stageId**：服务端 `|| meta.runId` 会直接跳过画布投影分支。
 *     所以这里刻意不提供 run 维度——工作台产物不属于任何一次流水线运行。
 *  3. projectId 非空时服务端会校验项目真实存在（generation-intent.js），归档项目会 409。
 *     归因始终是**可选**的：不选照样能生成（不绑死项目的底线）。
 */
export function AttributionPicker({
    active,
    value,
    onChange,
    projectId,
    slotRole = "key",
}: {
    /** 是否加载级联数据（弹窗展开时才拉，避免无谓请求）。 */
    active: boolean;
    value: SlotCascadeTarget | null;
    onChange: (next: SlotCascadeTarget | null) => void;
    /** 固定项目（从项目页/画布进入时）；不传则让用户选项目。 */
    projectId?: string;
    /** 槽位角色：生图/生视频默认关键帧槽位（与工作台现有「加入项目候选」一致）。 */
    slotRole?: string;
}) {
    const { t } = useTranslation();
    const cascade = useProjectSlotCascade({ active, projectId, slotRole });
    const target = cascade.target;
    const targetKey = target ? `${target.projectId}|${target.episodeId}|${target.shotId}|${target.slotId}` : "";
    const valueKey = value ? `${value.projectId}|${value.episodeId}|${value.shotId}|${value.slotId}` : "";

    /**
     * 只有用户**动过**选择器才回传，不能「级联数据一到达就写归因」。
     *
     * 为什么：modal 展开即拉级联，拉回来就自动 onChange(target) —— 用户点「取消」关闭时，
     * 归因已经写进 state 了，下一次提交就带上它。这是**静默归因**：
     * 界面上看不到「已归因」，产物却归到了某一集的某一镜，比不选更糟（用户无法察觉、也无法撤销）。
     * 项目内既有的 attach-asset-modal 同样是「确认才提交」，这里跟同一口径。
     */
    const touchedRef = useRef(false);
    // 每次打开弹窗重新计数（active 由 false 变 true 即视为新一轮）。
    useEffect(() => {
        if (active) touchedRef.current = false;
    }, [active]);
    // 级联数据是异步到达的，用 effect 回传而不是渲染期 setState（否则 React 警告且易成环）。
    useEffect(() => {
        if (!touchedRef.current) return;
        if (targetKey && targetKey !== valueKey && target) onChange(target);
    }, [targetKey, valueKey]);

    /** 透传级联，但把「用户动过」这件事记下来 —— 只包一层 setter，语义不变。 */
    // 按 setter 的真实签名包一层（Dispatch<SetStateAction<string>>）：
    // 不能窄化成 (next: string) => void —— antd Select 会传函数式更新，写窄了运行时会丢更新。
    const guarded = useMemo<ProjectSlotCascade>(
        () => ({
            ...cascade,
            setProjectId: (value) => {
                touchedRef.current = true;
                cascade.setProjectId(value);
            },
            selectEpisode: (value) => {
                touchedRef.current = true;
                cascade.selectEpisode(value);
            },
            setShotId: (value) => {
                touchedRef.current = true;
                cascade.setShotId(value);
            },
        }),
        [cascade],
    );

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs opacity-60">{t("attribution.hint")}</span>
                {value ? (
                    <button
                        type="button"
                        className="text-xs underline opacity-70 hover:opacity-100"
                        onClick={() => {
                            touchedRef.current = true;
                            onChange(null);
                        }}
                    >
                        {t("attribution.clear")}
                    </button>
                ) : null}
            </div>
            {active ? <ProjectSlotCascadeSelects cascade={guarded} projectTitle={projectId} /> : null}
        </div>
    );
}

/**
 * 归因 → 生成提交体的公共字段（P2-B4）。
 *
 * 两条提交链读的位置不同（生图读请求体顶层，视频读 `meta`），但字段集合与「绝不写 runId」
 * 这条口径必须只有一份 —— 分头写迟早又漂移出「选了归因却不生效」的问题。
 */
export function attributionFields(target: SlotCascadeTarget | null): { projectId?: string; episodeId?: string; sceneId?: string; shotId?: string; slotId?: string } {
    if (!target) return {};
    return { projectId: target.projectId, episodeId: target.episodeId, sceneId: target.sceneId, shotId: target.shotId, slotId: target.slotId };
}
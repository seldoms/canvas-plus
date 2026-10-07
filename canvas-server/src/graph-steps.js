/**
 * 从**提交前已知的 graph** 推出总步数，让进度分母从一开始就是可信的常量。
 *
 * ## 为什么必须从 graph 算，而不是用 ComfyUI 的 nodes 字典
 *   真机实测（2026-10-08，视频模板 video_h3_ref2v_image_turbo）拿到的 progress_state 是：
 *     节点 14 SamplerCustomAdvanced：value/max = 5/13，sigmas 长度=2 → max 极小、瞬间跑完
 *     节点 11 MiniMaxH3DualClockSamplerT8：steps = 8 → 真正耗时最长的采样
 *   `nodes` 是**累计字典**，分母会随新节点加入一路增长（实测 2 → 3 → 5 → 13），
 *   而先跑完的小权重节点会瞬间把比值顶到 100%。
 *   → 于是「已完成步数 / 已知总步数」这个比值既会倒退，又会虚高。全程100% 就是这么来的。
 *
 *## 口径
 *   只认**真正消耗算力的采样节点**，按各自步数加权：
 *     - SamplerCustomAdvanced：steps = max(0, sigmas.length - 1)
 *     - 任何带 `steps` 输入的采样节点（KSampler / MiniMaxH3*Sampler 等）：steps = inputs.steps
 *   提交前 graph 就在手上，所以这个分母是**开局确定、不会变化**的常量。
 *
 * ## 拿不到就返回 null
 *   模板里没有可识别采样节点时如实说拿不到，调用方退回「不显示百分比」的原有文案，
 *   绝不拿 0% 或 100% 冒充真实进度 —— 与本项目「缺料是事实不是失败」一致。
 */

/** 采样节点判定：`sigmas` 数组（CustomAdvanced 系）或显式 `steps` 输入。 */
function samplingSteps(node) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== "object") return null;
    // SamplerCustomAdvanced 系：真实步数 = sigmas 数 - 1（sigmas 比步数多一个起点）。
    if (Array.isArray(inputs.sigmas) && inputs.sigmas.length >= 2) {
        return inputs.sigmas.length - 1;
    }
    // 显式 steps 的采样节点（KSampler / MiniMaxH3DualClockSamplerT8 等）。
    const steps = Number(inputs.steps);
    if (Number.isFinite(steps) && steps > 0) return Math.floor(steps);
    return null;
}

/**
 * 统计 graph 里所有采样节点的总步数。
 *
 * @param {object} graph renderTemplate() 的产物
 * @returns {{totalSteps: number, samplingNodes: Array<{id: string, classType: string, steps: number}>}|null}
 *   没有任何可识别采样节点时返回 null
 */
export function totalSamplingSteps(graph) {
    if (!graph || typeof graph !== "object") return null;
    const samplingNodes = [];
    for (const [id, node] of Object.entries(graph)) {
        const classType = String(node?.class_type || "");
        if (!/sampler/i.test(classType)) continue; // 只认采样节点：加载/保存/解码节点不算算力
        const steps = samplingSteps(node);
        if (steps === null || steps <= 0) continue;
        samplingNodes.push({ id: String(id), classType, steps });
    }
    if (!samplingNodes.length) return null;
    return {
        totalSteps: samplingNodes.reduce((sum, item) => sum + item.steps, 0),
        samplingNodes,
    };
}
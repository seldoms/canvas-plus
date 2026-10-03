/** Hide the obsolete prompt-length suffix persisted by older pipeline runs. */
export function displayProgressLabel(label: string) {
    return /^模型生成中（提示词\s*[\d,]+\s*字）$/.test(label) ? "模型生成中" : label;
}

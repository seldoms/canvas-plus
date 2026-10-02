/** 前端导入多文件时的分节标记：单独一行的【文件名】。 */
const FILE_MARK_RE = /^【([^】\n]{1,80})】[ \t]*$/;
/** 中文章节标题：第 1 章 / 第十二章 / 第三回 / 卷二 等开头的整行。 */
const CHAPTER_RE = /^第[0-9一二三四五六七八九十百千零两]+[章节回卷部][^\n]*$/;

/** 定长窗口切分：优先在窗口内最后一个段落边界截断，其次换行，再硬切。 */
function splitByWindows(text, maxChars) {
    const pieces = [];
    let rest = text;
    while (rest.length > maxChars) {
        let cut = rest.lastIndexOf("\n\n", maxChars);
        if (cut < maxChars / 2) cut = rest.lastIndexOf("\n", maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
    return pieces.filter(Boolean);
}

/** 按行首标记（【文件名】或章节标题）切成若干节，每节带 label。 */
function splitByMarkers(text, markRe) {
    const sections = [];
    let current = null;
    for (const line of text.split("\n")) {
        const match = markRe.exec(line.trim());
        if (match) {
            if (current) sections.push(current);
            current = { label: match[1] || line.trim(), lines: [line] };
        } else if (current) {
            current.lines.push(line);
        } else {
            current = { label: "", lines: [line] };
        }
    }
    if (current) sections.push(current);
    return sections.map((section) => ({ label: section.label, text: section.lines.join("\n").trim() })).filter((section) => section.text);
}

/**
 * 把长篇小说切成不超过 maxChunkChars 的若干块（纯函数，便于单测）：
 * 优先按【文件名】分节，其次按中文章节标题，都没有就按定长窗口在段落边界附近切；
 * 仍超阈值的大块再按窗口二次切。每块保留来源标记（文件名/章节号）便于追溯。
 */
export function splitNovelIntoChunks(text, maxChunkChars = 16000) {
    const source = String(text ?? "").trim();
    if (!source) return [];
    if (source.length <= maxChunkChars) return [{ index: 1, label: "", text: source }];

    const byFile = splitByMarkers(source, FILE_MARK_RE);
    const byChapter = splitByMarkers(source, CHAPTER_RE);
    let sections;
    if (byFile.length >= 2) sections = byFile;
    else if (byChapter.length >= 2) sections = byChapter;
    // 只切出一节但带来了源标记（超大单文件/单章节）时保留它，二次切后仍能追溯来源
    else if (byFile[0]?.label) sections = byFile;
    else if (byChapter[0]?.label) sections = byChapter;
    else sections = [{ label: "", text: source }];

    // 超阈值的大节先按窗口二次切，保证后面贪心打包时不会再出现超标块。
    const small = [];
    for (const section of sections) {
        if (section.text.length <= maxChunkChars) {
            small.push(section);
            continue;
        }
        const pieces = splitByWindows(section.text, maxChunkChars);
        pieces.forEach((piece, index) => {
            small.push({ label: section.label ? `${section.label}（${index + 1}/${pieces.length}）` : "", text: piece });
        });
    }

    // 贪心打包：相邻小节合并进同一块，直到逼近阈值。
    const packed = [];
    let current = null;
    for (const section of small) {
        if (!current) {
            current = { labels: section.label ? [section.label] : [], text: section.text };
            continue;
        }
        const candidate = `${current.text}\n\n${section.text}`;
        if (candidate.length > maxChunkChars) {
            packed.push(current);
            current = { labels: section.label ? [section.label] : [], text: section.text };
        } else {
            current = { labels: [...current.labels, ...(section.label ? [section.label] : [])], text: candidate };
        }
    }
    if (current) packed.push(current);

    return packed.map((chunk, index) => ({
        index: index + 1,
        label: chunk.labels.join("、") || `第${index + 1}块`,
        text: chunk.text,
    }));
}

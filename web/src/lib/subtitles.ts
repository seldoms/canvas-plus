/**
 * 字幕格式转换：SRT → WebVTT。
 *
 * 浏览器 `<track>` 只吃 WebVTT，后端交付的是剪映可导入的 SRT，故前端预览时即时转换：
 *   ① 去掉 SRT 序号行；② 时间码 `,` → `.`；③ 补 `WEBVTT` 头；
 *   ④ 给每条 cue 追加 `align:middle line:90%`，让字幕落在画面底部居中（像正经播放器）。
 * 空文本 / 无有效 cue 时返回空串（调用方据此**静默不挂**字幕轨，不报错、不留空壳）。
 */
export function srtToVtt(srt: string): string {
    const body = String(srt || "")
        .replace(/\r+/g, "")
        .replace(/^\uFEFF/, "")
        .trim();
    if (!body) return "";

    const cues = body
        .split(/\n{2,}/)
        .map((block) => {
            const lines = block.split("\n").filter((line, index) => !(index === 0 && /^\d+$/.test(line.trim())));
            const timeIndex = lines.findIndex((line) => line.includes("-->"));
            if (timeIndex < 0) return "";
            lines[timeIndex] = `${lines[timeIndex].replace(/,/g, ".").trim()} align:middle line:90%`;
            return lines.join("\n").trim();
        })
        .filter(Boolean);

    if (!cues.length) return "";
    return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

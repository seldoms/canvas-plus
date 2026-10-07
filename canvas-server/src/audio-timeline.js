/** 以实际媒体时长安排对白；不截断台词、不变速、不改变镜头顺序。 */
export function buildAudioTimeline({ clips, audio, durations, sequential = false, transitionDurationSec = 0 }) {
    const byShot = new Map(clips.map((clip) => [String(clip.shotId), clip]));
    const cursors = new Map();
    const issues = [];
    const timeline = audio.map((item, index) => {
        const durationSec = Number(durations[index]);
        const speech = item.type === "dialogue" || item.type === "narration";
        const shotId = String(item.shotId ?? "");
        if (!speech) return { ...item, durationSec: durationSec > 0 ? durationSec : null };
        if (!(durationSec > 0)) {
            issues.push({ code: "audio_duration_unknown", cueId: item.cueId, shotId, message: `镜头 ${shotId} 的配音时长无法读取，请检查音频产物` });
            return { ...item, durationSec: null };
        }
        const startSec = sequential ? (cursors.get(shotId) || 0) : Number(item.startSec) || 0;
        const endSec = startSec + durationSec;
        cursors.set(shotId, endSec);
        const clip = byShot.get(shotId);
        const overlap = clip && clips.indexOf(clip) < clips.length - 1 ? transitionDurationSec : 0;
        if (!clip || !(Number(clip.durationSec) > 0)) {
            issues.push({ code: "shot_duration_unknown", cueId: item.cueId, shotId, message: `配音引用的镜头 ${shotId} 缺少可读取的视频时长` });
        } else if (endSec > Number(clip.durationSec) - overlap) {
            issues.push({ code: "dialogue_overflow", cueId: item.cueId, shotId, message: `镜头 ${shotId} 的对白结束于 ${endSec.toFixed(3)} 秒，超过可用画面 ${(Number(clip.durationSec) - overlap).toFixed(3)} 秒；请调整分镜时长或重新配音` });
        }
        return { ...item, startSec, endSec, durationSec };
    });
    // 显式时间轴也必须检查实际重叠；背景声与配乐不参与对白轮次检查。
    for (const shotId of new Set(timeline.filter((item) => item.type === "dialogue" || item.type === "narration").map((item) => item.shotId))) {
        const lines = timeline.filter((item) => item.shotId === shotId && (item.type === "dialogue" || item.type === "narration") && item.durationSec > 0).sort((a, b) => a.startSec - b.startSec);
        let end = 0;
        for (const line of lines) {
            if (line.startSec < end) issues.push({ code: "dialogue_overlap", cueId: line.cueId, shotId, message: `镜头 ${shotId} 的对白在 ${line.startSec.toFixed(3)} 秒发生重叠，请检查说话轮次` });
            end = Math.max(end, line.endSec);
        }
    }
    return { audio: timeline, issues };
}

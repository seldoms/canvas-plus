import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** 读媒体流的客观信息（分辨率/时长/是否有音轨），用来判定「成片」真的能被解析。任意 ffprobe 失败都返回 null 由调用方决定。 */
export async function probeMedia(filePath, ffprobePath = "ffprobe") {
    let output;
    try {
        ({ stdout: output } = await execute(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath]));
    } catch {
        return null;
    }
    let data;
    try {
        data = JSON.parse(output);
    } catch {
        return null;
    }
    const streams = data.streams || [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    return {
        durationSec: Number(video?.duration) || Number(data.format?.duration) || Number(audio?.duration) || null,
        width: video ? Number(video.width) : null,
        height: video ? Number(video.height) : null,
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
        sampleRate: audio ? Number(audio.sample_rate) || null : null,
        channels: audio ? Number(audio.channels) || null : null,
    };
}


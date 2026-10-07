import { resolveDialogueLines } from "./audio.js";
import { qwen3Language, qwen3Speaker } from "./voices.js";

/** H3 Talk 模板只有一个 TTS 驱动声音，必须先确认一镜一位说话人。 */
export function buildH3TalkParams({ shot, characters, cast, profiles } = {}) {
    const { lines, warnings } = resolveDialogueLines(shot || {}, characters || [], cast || []);
    const spoken = lines.filter((line) => !line.onlyAnnotation && String(line.text || "").trim());
    if (!spoken.length) throw new Error("H3 Talk 需要有明确台词的镜头；无对白镜头请使用普通视频模型");
    if (shot?.voiceover === true || spoken.some((line) => line.voiceover === true)) throw new Error("H3 Talk 会驱动画面人物口型，画外音镜头请使用普通视频模型和独立配音");
    if (warnings.some((warning) => /^speaker_/.test(warning.code))) throw new Error("H3 Talk 的台词说话人不明确，请先确认分镜台词归属");
    const speakers = new Set(spoken.map((line) => line.speaker?.characterId).filter(Boolean));
    if (speakers.size !== 1 || spoken.some((line) => !line.speaker?.characterId)) throw new Error("当前 H3 Talk 模板仅支持一个驱动音色，请把不同角色的台词拆成轮流说话的镜头");
    const characterId = spoken[0].speaker.characterId;
    const profile = (profiles || []).find((value) => String(value.characterId) === String(characterId));
    if (!profile) throw new Error(`角色 ${characterId} 缺少 VoiceProfile，无法驱动 H3 Talk`);
    return {
        TTS_TEXT: spoken.map((line) => line.text).join(" "),
        TTS_SPEAKER: qwen3Speaker(profile, spoken[0].speaker),
        TTS_VOICE_DESIGN: [...new Set([profile.design, profile.timbre].filter(Boolean))].join("，"),
        TTS_LANGUAGE: qwen3Language(profile.language),
    };
}

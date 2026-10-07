import assert from "node:assert/strict";
import { test } from "node:test";
import { buildH3TalkParams } from "../src/h3-talk.js";

const cast = [{ id: "c1", name: "林舟" }, { id: "c2", name: "苏晚" }];
const profiles = [{ id: "vp_c1", characterId: "c1", speaker: "Ryan", language: "en-US", design: "calm", timbre: "calm" }];

test("H3 Talk 消费固定 VoiceProfile，保留台词并剥除表演注解", () => {
    const params = buildH3TalkParams({ shot: { dialogueLines: [{ speaker: "林舟", text: "Listen.（低声）", performance: "慢" }] }, cast, characters: cast, profiles });
    assert.deepEqual(params, { TTS_TEXT: "Listen.", TTS_SPEAKER: "Ryan", TTS_VOICE_DESIGN: "calm", TTS_LANGUAGE: "English" });
});

test("H3 Talk 不把两角色对白错误绑定到同一个驱动音色", () => {
    assert.throws(() => buildH3TalkParams({ shot: { dialogueLines: [{ speaker: "林舟", text: "听我说。" }, { speaker: "苏晚", text: "好。" }] }, cast, characters: cast, profiles }), /一个驱动音色/);
    assert.throws(() => buildH3TalkParams({ shot: { dialogue: "喂。" }, cast, characters: cast, profiles }), /说话人不明确/);
    assert.throws(() => buildH3TalkParams({ shot: {}, cast, profiles }), /明确台词/);
    assert.throws(() => buildH3TalkParams({ shot: { dialogueLines: [{ speaker: "林舟", text: "听我说。", voiceover: true }] }, cast, characters: cast, profiles }), /画外音/);
});

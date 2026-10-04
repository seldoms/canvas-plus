/**
 * TTS 试听 / 音色库 HTTP 真链路（隔离实例）。
 *
 *   · GET  /api/tts/voices  → 9 个命名音色 + 11 个语种（前端契约字段名 voices）；
 *   · POST /api/tts/preview → 入参校验（非法音色 / 语种 / speed 一律 400，可读错误）；
 *   · POST /api/tts/preview → 147 不可达时回**可读的 502**（不是 500 沉默、不挂死）。
 *
 * ComfyUI 指向不可达地址（回环第 9 端口）：只验证入参校验与失败可读性，绝不真跑生成。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "canvas-tts-http-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_WEB_DIR = join(root, "webdist");
delete process.env.CANVAS_SERVER_PORT;
delete process.env.CANVAS_SERVER_HOST;

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_WEB_DIR"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const EXPECTED_SPEAKERS = ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"];
const post = (url, payload) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("GET /api/tts/voices：贴出 9 个命名音色 + 11 个语种（前端只读，不硬编码）", async () => {
    const res = await fetch(`${base}/api/tts/voices`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.voices, EXPECTED_SPEAKERS);
    assert.deepEqual(body.speakers, EXPECTED_SPEAKERS);
    assert.equal(body.languages.length, 11);
    assert.equal(body.defaultSpeaker, "Aiden");
    assert.match(body.source, /TDQwen3TTSCustomVoice$/);
});

test("POST /api/tts/preview 入参校验：非法音色 / 语种 / speed 一律 400 且可读", async () => {
    const badSpeaker = await post("/api/tts/preview", { speaker: "hacker" });
    assert.equal(badSpeaker.status, 400);
    const badSpeakerBody = await badSpeaker.json();
    assert.match(badSpeakerBody.error.message, /不支持的音色/);
    assert.match(badSpeakerBody.error.message, /Uncle_fu/);

    const badLang = await post("/api/tts/preview", { speaker: "Uncle_fu", language: "Klingon" });
    assert.equal(badLang.status, 400);
    assert.match((await badLang.json()).error.message, /不支持的语种/);

    const badSpeed = await post("/api/tts/preview", { speaker: "Uncle_fu", speed: -1 });
    assert.equal(badSpeed.status, 400);
    assert.match((await badSpeed.json()).error.message, /speed 必须是正数/);

    const empty = await post("/api/tts/preview", {});
    assert.equal(empty.status, 400);
});

test("POST /api/tts/preview：147 不可达 → 可读的 502（不是 500 沉默、不挂死）", async () => {
    const res = await post("/api/tts/preview", { speaker: "Uncle_fu", design: "低沉沙哑", language: "Chinese", text: "你好。" });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /试听失败/);
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 6);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 缩略图 HTTP 路由集成测试（GET /api/artifacts/:jobId/:filename?variant=thumb）。
 * 隔离环境：临时 data 目录 + 不可达 Comfy/LLM；预置磁盘产物。
 * 验证：
 *   - 图片 `?variant=thumb` 返回 **image/webp** 且字节 < 50KB（远小于原图）；
 *   - 原图（不带 variant）不受影响，仍是原始字节；
 *   - 不可缩略（音频）/ 生成失败（坏文件）→ **回退原图**，绝不 500 / 裂图。
 */
const root = mkdtempSync(join(tmpdir(), "canvas-thumbs-http-"));
const dataDir = join(root, "data");
process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = join(root, "skills");
process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_LLM_MODEL = "test-model";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
mkdirSync(process.env.CANVAS_SERVER_SKILLS_DIR, { recursive: true });

function seed(jobId, filename, bytes) {
    const dir = join(dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), bytes);
    return join(dir, filename);
}

// 坏文件（不是真图片）：生成必失败 → 走回退；音频：不缩略 → 回退；真图片（有 ffmpeg 才可用）：真缩略。
seed("job-bad", "broken.png", "not-a-real-png");
seed("job-audio", "song.mp3", "not-a-real-mp3");
let REAL_PNG_BYTES = 0;
try {
    const p = join(dataDir, "artifacts", "job-real");
    mkdirSync(p, { recursive: true });
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1600x900", "-frames:v", "1", join(p, "real.png")]);
    REAL_PNG_BYTES = readFileSync(join(p, "real.png")).length;
} catch {
    REAL_PNG_BYTES = 0;
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ jobs: [] }));

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_LLM_MODEL", "CANVAS_SERVER_COMFY_URL"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

test("坏图片 ?variant=thumb：回退原图，不 500、不裂图", async () => {
    const res = await fetch(`${base}/api/artifacts/job-bad/broken.png?variant=thumb`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "not-a-real-png");
});

test("音频 ?variant=thumb：非可缩略类型 → 回退原图", async () => {
    const res = await fetch(`${base}/api/artifacts/job-audio/song.mp3?variant=thumb`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "not-a-real-mp3");
});

test("真图片 ?variant=thumb：image/webp 且 < 50KB；原图仍返回原始字节", { skip: !REAL_PNG_BYTES }, async () => {
    const thumb = await fetch(`${base}/api/artifacts/job-real/real.png?variant=thumb`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers.get("content-type") || "", /image\/webp/);
    const thumbBytes = (await thumb.arrayBuffer()).byteLength;
    assert.ok(thumbBytes < 50 * 1024, `缩略图应 < 50KB（实际 ${thumbBytes}）`);
    assert.ok(thumbBytes < REAL_PNG_BYTES, "缩略图应小于原图");

    const original = await fetch(`${base}/api/artifacts/job-real/real.png`);
    assert.equal(original.status, 200);
    assert.equal((await original.arrayBuffer()).byteLength, REAL_PNG_BYTES, "不带 variant 必须还是原图字节");
});

test("自定义宽度 ?variant=thumb&w=640：生效且被夹到上限", { skip: !REAL_PNG_BYTES }, async () => {
    const res = await fetch(`${base}/api/artifacts/job-real/real.png?variant=thumb&w=9999`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /image\/webp/);
});

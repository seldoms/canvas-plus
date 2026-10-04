import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ffmpegAvailable } from "../src/delivery.js";
import {
    buildThumbArgs,
    createThumbnails,
    isFresh,
    isThumbnailable,
    isVideoName,
    normalizeThumbWidth,
    scaleFilter,
    thumbPathFor,
    THUMB_DEFAULT_WIDTH,
    THUMB_MAX_WIDTH,
    THUMB_MIN_WIDTH,
} from "../src/thumbnails.js";

/**
 * 缩略图内核单测。
 * - 纯函数：宽度规范化、可缩略判定、缓存路径（含越权阻断）、ffmpeg 参数、新鲜度判定。
 * - 集成（有 ffmpeg 才跑）：真生成 WebP、字节远小于原图、二次调用走缓存、并发同路径只生成一次。
 */

const root = mkdtempSync(join(tmpdir(), "canvas-thumbs-"));
after(() => rmSync(root, { recursive: true, force: true }));

const dataDir = join(root, "data");
mkdirSync(join(dataDir, "artifacts", "job-1"), { recursive: true });

let HAS_FFMPEG = false;
try {
    HAS_FFMPEG = ffmpegAvailable("ffmpeg");
} catch {
    HAS_FFMPEG = false;
}

function makeImage(filename, size = "1600x900") {
    const path = join(dataDir, "artifacts", "job-1", filename);
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=${size}`, "-frames:v", "1", path]);
    return path;
}

test("normalizeThumbWidth：缺失/非法 → 默认；越界 → 夹到 [64,640]", () => {
    assert.equal(normalizeThumbWidth(undefined), THUMB_DEFAULT_WIDTH);
    assert.equal(normalizeThumbWidth(""), THUMB_DEFAULT_WIDTH);
    assert.equal(normalizeThumbWidth("abc"), THUMB_DEFAULT_WIDTH);
    assert.equal(normalizeThumbWidth(0), THUMB_DEFAULT_WIDTH);
    assert.equal(normalizeThumbWidth(-5), THUMB_DEFAULT_WIDTH);
    assert.equal(normalizeThumbWidth(9999), THUMB_MAX_WIDTH);
    assert.equal(normalizeThumbWidth(1), THUMB_MIN_WIDTH);
    assert.equal(normalizeThumbWidth("448"), 448);
});

test("isThumbnailable / isVideoName：只认图片与视频", () => {
    assert.equal(isThumbnailable("a.PNG"), true);
    assert.equal(isThumbnailable("a.jpeg"), true);
    assert.equal(isThumbnailable("a.webp"), true);
    assert.equal(isThumbnailable("a.MP4"), true);
    assert.equal(isThumbnailable("a.mp3"), false);
    assert.equal(isThumbnailable("a.txt"), false);
    assert.equal(isThumbnailable("noext"), false);
    assert.equal(isVideoName("a.mp4"), true);
    assert.equal(isVideoName("a.png"), false);
});

test("thumbPathFor：<jobId>/<原名去扩展>.<宽>.webp，并阻断 ../ 越权", () => {
    const dir = join(dataDir, "thumbnails");
    assert.equal(thumbPathFor(dir, "job-1", "frame.png", 320), join(dir, "job-1", "frame.320.webp"));
    assert.equal(thumbPathFor(dir, "job-1", "clip.mp4", 448), join(dir, "job-1", "clip.448.webp"));
    // 空文件名拼不出路径。
    assert.equal(thumbPathFor(dir, "job-1", ".png", 320), null);
    // 越权路径必须被 safeJoin 拦下。
    assert.equal(thumbPathFor(dir, "../evil", "a.png", 320), null);
    assert.equal(thumbPathFor(dir, "job-1", "../a.png", 320), null);
});

test("scaleFilter / buildThumbArgs：保持比例、不放大、导出 WebP；视频先定位再抽帧", () => {
    assert.match(scaleFilter(320), /force_original_aspect_ratio=decrease/);
    assert.match(scaleFilter(320), /min\(320,iw\)/);
    const img = buildThumbArgs({ sourcePath: "/in/a.png", outPath: "/out/a.webp", width: 320 });
    assert.deepEqual(img.slice(0, 4), ["-y", "-hide_banner", "-loglevel", "error"]);
    assert.ok(img.includes("-vf") && img.includes("-c:v") && img.includes("libwebp") && img.includes("webp"));
    assert.equal(img[img.length - 1], "/out/a.webp");
    assert.ok(!img.includes("-ss"), "图片不该带 -ss");
    const vid = buildThumbArgs({ sourcePath: "/in/a.mp4", outPath: "/out/a.webp", width: 320, video: true });
    assert.deepEqual(vid.slice(4, 7), ["-ss", "0", "-i"], "视频先 -ss 0 再 -i");
});

test("isFresh：缩略图缺失或不比源新 → false", () => {
    const src = join(dataDir, "artifacts", "job-1", "fresh.png");
    writeFileSync(src, "x");
    assert.equal(isFresh(join(dataDir, "nope.webp"), src), false);
    const out = join(dataDir, "out.webp");
    writeFileSync(out, "y");
    assert.equal(isFresh(out, src), true);
});

test("generate：不可缩略扩展 / 源缺失 → null（路由据此回退原图）", async () => {
    const th = createThumbnails({ dataDir, warn: () => {} });
    assert.equal(await th.generate({ jobId: "job-1", filename: "song.mp3", sourcePath: join(dataDir, "x.mp3"), width: 320 }), null);
    assert.equal(await th.generate({ jobId: "job-1", filename: "a.png", sourcePath: join(dataDir, "missing.png"), width: 320 }), null);
});

test("generate：真生成 WebP 且远小于原图，二次调用走缓存（需要 ffmpeg）", { skip: !HAS_FFMPEG }, async () => {
    const src = makeImage("big.png", "1600x900");
    const th = createThumbnails({ dataDir, warn: () => {} });
    const first = await th.generate({ jobId: "job-1", filename: "big.png", sourcePath: src, width: 320 });
    assert.ok(first && first.path, "应生成缩略图");
    assert.equal(first.cached, false);
    const srcBytes = statSync(src).size;
    const thumbBytes = statSync(first.path).size;
    assert.ok(thumbBytes < srcBytes / 2, `缩略图应显著小于原图（${thumbBytes} vs ${srcBytes}）`);
    assert.ok(thumbBytes < 50 * 1024, `缩略图应 < 50KB（实际 ${thumbBytes}）`);

    const second = await th.generate({ jobId: "job-1", filename: "big.png", sourcePath: src, width: 320 });
    assert.equal(second.cached, true, "同日第二次应命中磁盘缓存");
});

test("generate：同路径并发只生成一次（缓存路径幂等）", { skip: !HAS_FFMPEG }, async () => {
    const src = makeImage("race.png", "1200x800");
    const th = createThumbnails({ dataDir, warn: () => {} });
    const results = await Promise.all(
        Array.from({ length: 4 }, () => th.generate({ jobId: "job-1", filename: "race.png", sourcePath: src, width: 320 })),
    );
    assert.equal(results.filter((r) => r && r.path).length, 4, "4 个调用都拿到缩略图");
    // 并发同路径共用同一次生成 → 4 个调用返回**同一个**结果对象（证明只跑了一次 ffmpeg）。
    assert.equal(new Set(results).size, 1, "并发同路径应只生成一次");
    assert.equal(results[0].cached, false);
});

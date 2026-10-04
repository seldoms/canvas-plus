/**
 * image-dims.js 行为锁定：从**真实编码器产出的字节**解析真实像素宽高（不臆造）。
 * 每个 PNG/JPEG/GIF/WebP 夹具都是 Pillow 真编出来的最小图；BMP 用真头字段构造。
 * 头截断 / 未知格式 / 空 → null（调用方按「无图」处理）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { bufferFromDataUrl, imageDimensions } from "../src/image-dims.js";

// Pillow 真实产出（见测试说明）；尺寸已核对。
const FIXTURES = {
    png: { b64: "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAU0lEQVR4nO3PQQ3AIADAQEAIOpGIrIngcVnSU9DOe/b4s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaB9aAYBvtkCYLMAAAAASUVORK5CYII=", width: 64, height: 48 },
    jpeg: { b64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAA8AFADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCaiiiviz6oKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z", width: 80, height: 60 },
    gif: { b64: "R0lGODdhKAAeAIEAAMh4HgAAAAAAAAAAACwAAAAAKAAeAEAIOgABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzAxBgQAOw==", width: 40, height: 30 },
    webp: { b64: "UklGRkYAAABXRUJQVlA4IDoAAABQAwCdASogABgAPm00lkekIyIhKAgAgA2JZQB2APwAAMSUEAD7jv//z8zu3F/Vb//5Z7zG72oAAAAA", width: 32, height: 24 },
};

test("imageDimensions：真实 PNG/JPEG/GIF/WebP 字节 → 真实宽高（Pillow 编码）", () => {
    for (const [type, fixture] of Object.entries(FIXTURES)) {
        const buffer = Buffer.from(fixture.b64, "base64");
        const dims = imageDimensions(buffer);
        assert.ok(dims, `${type} 应解析出尺寸`);
        assert.deepEqual({ width: dims.width, height: dims.height }, { width: fixture.width, height: fixture.height }, `${type} 宽高不符`);
        assert.equal(dims.type, type);
    }
});

test("imageDimensions：BMP 头字段解析（含自上而下负高度取绝对值）", () => {
    const header = Buffer.alloc(54);
    header.write("BM", 0, "latin1");
    header.writeUInt32LE(24, 18); // width
    header.writeUInt32LE(18, 22); // height
    assert.deepEqual(imageDimensions(header), { width: 24, height: 18, type: "bmp" });
    // 负高度（0xFFFFFFEE = -18）→ 取绝对值 18。
    const topDown = Buffer.from(header);
    topDown.writeUInt32LE(0xffffffee, 22);
    assert.deepEqual(imageDimensions(topDown), { width: 24, height: 18, type: "bmp" });
});

test("imageDimensions：头截断 / 未知格式 / 空 → null（绝不臆造尺寸）", () => {
    const png = Buffer.from(FIXTURES.png.b64, "base64");
    assert.equal(imageDimensions(png.subarray(0, 12)), null, "PNG 头被截断应判失败");
    assert.equal(imageDimensions(Buffer.from("not an image at all!!")), null);
    assert.equal(imageDimensions(Buffer.alloc(0)), null);
    assert.equal(imageDimensions(null), null);
    // JPEG 在 SOS/EOI 之前找不到 SOF → null。
    assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

test("bufferFromDataUrl：base64 data URL → Buffer；非 data URL → null", () => {
    const dataUrl = `data:image/png;base64,${FIXTURES.png.b64}`;
    const buffer = bufferFromDataUrl(dataUrl);
    assert.equal(buffer.length, Buffer.from(FIXTURES.png.b64, "base64").length);
    assert.deepEqual(imageDimensions(buffer), { width: 64, height: 48, type: "png" });
    assert.equal(bufferFromDataUrl("/api/artifacts/x/y.png"), null);
    assert.equal(bufferFromDataUrl(""), null);
});

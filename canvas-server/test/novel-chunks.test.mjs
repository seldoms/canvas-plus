import assert from "node:assert/strict";
import { test } from "node:test";

import { splitNovelIntoChunks } from "../src/chunk-novel.js";

/** 造一段 length 长的填充文本，按 paragraph 切段并以空行连接。 */
function makeText(paragraph, count) {
    return Array.from({ length: count }, () => paragraph).join("\n\n");
}

test("短于阈值的原文原样返回单块", () => {
    const text = "很久以前有一个村子。";
    assert.deepEqual(splitNovelIntoChunks(text, 60000), [{ index: 1, label: "", text }]);
    assert.deepEqual(splitNovelIntoChunks("", 100), []);
});

test("按【文件名】分节标记切块，保留文件名来源", () => {
    const a = makeText("甲文件的段落。", 6);
    const b = makeText("乙文件的段落。", 6);
    const text = `【甲.txt】\n${a}\n\n【乙.txt】\n${b}`;
    const chunks = splitNovelIntoChunks(text, a.length + 20);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk) => chunk.label), ["甲.txt", "乙.txt"]);
    assert.ok(chunks[0].text.includes("甲文件的段落。"));
    assert.ok(!chunks[0].text.includes("乙文件的段落。"));
    assert.ok(chunks[1].text.includes("乙文件的段落。"));
    for (const chunk of chunks) assert.ok(chunk.text.length <= a.length + 20, `块超阈值：${chunk.text.length}`);
});

test("相邻小节在阈值内会合并进同一块", () => {
    const text = "【一.txt】\n第一段。\n\n【二.txt】\n第二段。\n\n【三.txt】\n第三段。";
    const chunks = splitNovelIntoChunks(text, 30);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].label, "一.txt、二.txt");
    assert.equal(chunks[1].label, "三.txt");
});

test("没有【文件名】时按中文章节标题切块", () => {
    const body = makeText("本章正文内容。", 5);
    const text = `第一章 风起\n${body}\n\n第十二章 云涌\n${body}`;
    const chunks = splitNovelIntoChunks(text, body.length + 20);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk) => chunk.label), ["第一章 风起", "第十二章 云涌"]);
    assert.ok(chunks[0].text.startsWith("第一章 风起"));
    assert.ok(chunks[1].text.startsWith("第十二章 云涌"));
});

test("没有任何标记时按定长窗口切，并在段落边界附近截断", () => {
    const paragraph = "这一段有二十个字左右的正文内容，用来填充。";
    const text = makeText(paragraph, 10);
    const chunks = splitNovelIntoChunks(text, paragraph.length * 3);
    assert.ok(chunks.length >= 3, `应切出多块，实际 ${chunks.length}`);
    for (const chunk of chunks) {
        assert.ok(chunk.text.length <= paragraph.length * 3, `块超阈值：${chunk.text.length}`);
        // 段落边界截断：除最后一块外，块尾不应是半个段落（段落里没有换行，断点必在空行处）
        assert.ok(!chunk.text.endsWith("，"), `块尾截在段落中间：${chunk.text.slice(-10)}`);
    }
    // 切完拼回应覆盖原文全部段落
    assert.equal(chunks.flatMap((chunk) => chunk.text.split("\n\n")).length, 10);
});

test("单节超大时按窗口二次切，来源标记带序号", () => {
    const paragraph = "超长文件里的一段正文内容，用于填充窗口。";
    const text = `【大文件.txt】\n${makeText(paragraph, 12)}`;
    const max = paragraph.length * 3;
    const chunks = splitNovelIntoChunks(text, max);
    assert.ok(chunks.length >= 3, `应二次切出多块，实际 ${chunks.length}`);
    for (const chunk of chunks) {
        assert.ok(chunk.text.length <= max, `块超阈值：${chunk.text.length}`);
        assert.match(chunk.label, /^大文件\.txt（\d+\/\d+）$/);
    }
});

test("章节内单节超大也会二次切", () => {
    const paragraph = "章内正文段落，持续不断地往下写。";
    const text = `第三回 夜袭\n${makeText(paragraph, 10)}`;
    const max = paragraph.length * 2;
    const chunks = splitNovelIntoChunks(text, max);
    assert.ok(chunks.length >= 4);
    for (const chunk of chunks) assert.ok(chunk.text.length <= max);
    assert.match(chunks[0].label, /^第三回 夜袭（1\/\d+）$/);
});

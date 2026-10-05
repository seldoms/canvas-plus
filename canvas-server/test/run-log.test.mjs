import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendRunLog, readRunLog, runLogPath } from "../src/run-log.js";

function makeDir(t) {
    const root = mkdtempSync(join(tmpdir(), "canvas-run-log-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

test("appendRunLog：一行一条、追加式、带 at 与默认 actor", (t) => {
    const root = makeDir(t);
    assert.equal(appendRunLog(root, "run_1", { op: "run.create", message: "创建" }), true);
    assert.equal(appendRunLog(root, "run_1", { op: "stage.output", stage: "script", revision: 1, ok: true }), true);

    const lines = readFileSync(runLogPath(root, "run_1"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.op, "run.create");
    assert.equal(first.actor, "local");
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
    // 追加：第二次写入不覆盖第一次
    assert.equal(JSON.parse(lines[1]).stage, "script");
});

test("appendRunLog：actor 可覆盖，errors/message 原样保留", (t) => {
    const root = makeDir(t);
    appendRunLog(root, "run_2", { op: "stage.output", actor: "agent:codex", stage: "storyboard", ok: false, errors: ["storyboard.scene_ref"], message: "引用断裂" });

    const [entry] = readRunLog(root, "run_2");
    assert.equal(entry.actor, "agent:codex");
    assert.deepEqual(entry.errors, ["storyboard.scene_ref"]);
    assert.equal(entry.message, "引用断裂");
    assert.equal(entry.ok, false);
});

test("readRunLog：时间正序、按 limit 取尾部、limit 越界被夹住", (t) => {
    const root = makeDir(t);
    for (let index = 1; index <= 5; index += 1) appendRunLog(root, "run_3", { op: "stage.begin", revision: index });

    assert.deepEqual(readRunLog(root, "run_3").map((entry) => entry.revision), [1, 2, 3, 4, 5]);
    assert.deepEqual(readRunLog(root, "run_3", 2).map((entry) => entry.revision), [4, 5]);
    assert.equal(readRunLog(root, "run_3", 0).length, 5, "0 按默认值处理");
    assert.equal(readRunLog(root, "run_3", 99999).length, 5);
});

test("readRunLog：坏行跳过、文件不存在返回空数组", (t) => {
    const root = makeDir(t);
    assert.deepEqual(readRunLog(root, "run_missing"), []);

    appendRunLog(root, "run_4", { op: "stage.begin" });
    writeFileSync(runLogPath(root, "run_4"), `${readFileSync(runLogPath(root, "run_4"), "utf8")}{ 坏行\n`);
    assert.equal(readRunLog(root, "run_4").length, 1, "坏行被跳过而不是整份读失败");
});

test("appendRunLog：写不进去只 warn 不抛（审计不阻断生产）", (t) => {
    const root = makeDir(t);
    // 用同名文件占住 run 目录的位置，制造 ENOTDIR。
    writeFileSync(join(root, "run_5"), "not a dir");

    const warn = console.warn;
    let warned = "";
    console.warn = (message) => {
        warned = String(message);
    };
    try {
        assert.equal(appendRunLog(root, "run_5", { op: "stage.output" }), false);
    } finally {
        console.warn = warn;
    }
    assert.match(warned, /\[run-log\] 写入失败/);
});

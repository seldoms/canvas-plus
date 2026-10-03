#!/usr/bin/env node
/**
 * 一次性数据修复：把被「warning 自我放大」写坏的字段收回去。
 *
 * 背景：`enqueueReady` 无条件把 `plan.warning.reason` 追加进 `item.warning`，而 reason 又取自
 * `item.warning` 本身 → `bindJobs()` 每次启动重放都翻倍，实测把单个 warning 撑到 2.77 亿字符、
 * run.json 从 6.4MB 涨到 529MB，并让服务端启动即 `RangeError: Invalid string length`。
 * 代码侧已改为按段去重（`appendWarning`），本脚本只负责修复已落盘的数据。
 *
 * 只做**收缩**，不改语义：`warning` / `promptWarning` 按「；」分段去重保序；仍超长则截断并标注。
 * 其它字段（PROMPT、rawPrompt 等）一律不碰。默认 dry-run，加 --write 才落盘（先备份 .bak-bloated）。
 *
 * 用法：node scripts/repair-bloated-warnings.mjs [--write] [文件或目录 ...]
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEGMENT_LIMIT = 1000;
const TARGET_KEYS = new Set(["warning", "promptWarning"]);

function shrink(text) {
    const parts = [...new Set(String(text).split("；").map((part) => part.trim()).filter(Boolean))];
    const joined = parts.join("；");
    return joined.length > SEGMENT_LIMIT ? `${joined.slice(0, SEGMENT_LIMIT)}…（重复段已去重并截断）` : joined;
}

function walk(node, path, hits) {
    if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${path}[${index}]`, hits));
        return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
        if (typeof value === "string") {
            if (!TARGET_KEYS.has(key) || value.length <= SEGMENT_LIMIT) continue;
            const next = shrink(value);
            if (next.length >= value.length) continue;
            hits.push({ path: `${path}.${key}`, before: value.length, after: next.length });
            node[key] = next;
        } else {
            walk(value, `${path}.${key}`, hits);
        }
    }
}

function collectFiles(target) {
    if (!existsSync(target)) return [];
    if (statSync(target).isFile()) return [target];
    const out = [];
    for (const entry of readdirSync(target, { withFileTypes: true })) {
        const full = join(target, entry.name);
        if (entry.isDirectory()) out.push(...collectFiles(full));
        else if (entry.name.endsWith(".json")) out.push(full);
    }
    return out;
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const targets = args.filter((arg) => arg !== "--write");
const files = (targets.length ? targets : ["data"]).flatMap(collectFiles);

let touched = 0;
for (const file of files) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        console.warn(`跳过（不是合法 JSON）：${file}（${error.message}）`);
        continue;
    }
    const hits = [];
    walk(doc, "$", hits);
    if (!hits.length) continue;
    touched += 1;
    console.log(`\n${file}`);
    for (const hit of hits) console.log(`  ${hit.path}: ${hit.before} → ${hit.after} 字符`);
    if (!write) continue;
    const backup = `${file}.bak-bloated`;
    renameSync(file, backup);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(doc));
    renameSync(temp, file);
    console.log(`  已写回；原文件备份为 ${backup}`);
}
console.log(`\n${write ? "已修复" : "待修复（dry-run，加 --write 落盘）"}文件数：${touched}／扫描 ${files.length}`);

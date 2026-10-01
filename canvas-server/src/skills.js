import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { safeJoin } from "./files.js";

/** 去掉 YAML 标量两端的引号。 */
function stripQuotes(value) {
    const text = String(value ?? "").trim();
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
        return text.slice(1, -1);
    }
    return text;
}

/**
 * 解析 SKILL.md 顶部的 YAML 头，只支持 `key: value` 与 `|` / `>` 多行块。
 * 不做完整 YAML 实现，够用即可；解析不出头部返回 null。
 */
function parseHeader(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(String(text ?? ""));
    if (!match) return null;
    const lines = match[1].split(/\r?\n/);
    const header = {};
    for (let index = 0; index < lines.length; index += 1) {
        const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
        if (!pair) continue;
        const key = pair[1];
        let value = pair[2].trim();
        if (value === "|" || value === "|-" || value === ">" || value === ">-") {
            const block = [];
            const folded = value.startsWith(">");
            while (index + 1 < lines.length) {
                const next = lines[index + 1];
                if (!/^\s+\S/.test(next) && !(next.trim() === "" && /^\s+\S/.test(lines[index + 2] || ""))) break;
                block.push(next.trim());
                index += 1;
            }
            value = block.join(folded ? " " : "\n").trim();
        }
        header[key] = stripQuotes(value);
    }
    return header;
}

/** 扫描 skills/*\/SKILL.md 的 YAML 头；解析不到 name 的目录直接跳过并告警。 */
export function loadSkills(skillsDir) {
    const skills = [];
    if (!existsSync(skillsDir)) {
        console.warn(`[skills] 技能目录不存在：${skillsDir}`);
        return skills;
    }
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(file)) continue;
        const header = parseHeader(readFileSync(file, "utf8"));
        if (!header?.name) {
            console.warn(`[skills] 跳过 ${entry.name}：SKILL.md 缺少可解析的 YAML 头（name）`);
            continue;
        }
        skills.push({ id: entry.name, name: header.name, description: header.description || "", path: file });
    }
    return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/** 读取某个技能的 SKILL.md 全文。 */
export function readSkill(skillsDir, id) {
    const file = safeJoin(skillsDir, String(id), "SKILL.md");
    if (!file || !existsSync(file)) throw new Error(`找不到技能：${id}`);
    return readFileSync(file, "utf8");
}

/** registry.json 里 requires / produces 允许写字符串或数组，统一规整成数组。 */
function toList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
    return value === undefined || value === null || value === "" ? [] : [String(value)];
}

/** 读取 skills/registry.json，返回五个阶段的编排顺序与依赖。 */
export function loadRegistry(skillsDir) {
    const file = join(skillsDir, "registry.json");
    if (!existsSync(file)) {
        console.warn(`[skills] 缺少 registry.json：${file}`);
        return { version: 1, stages: [] };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        console.warn(`[skills] registry.json 解析失败，按空处理：${error.message}`);
        return { version: 1, stages: [] };
    }
    const stages = [];
    for (const item of Array.isArray(raw?.stages) ? raw.stages : []) {
        if (!item?.id || !item?.skill) {
            console.warn(`[skills] 跳过非法阶段定义：${JSON.stringify(item)}`);
            continue;
        }
        stages.push({
            id: String(item.id),
            title: String(item.title || item.id),
            skill: String(item.skill),
            requires: toList(item.requires),
            produces: toList(item.produces),
        });
    }
    return { version: Number(raw?.version) || 1, stages };
}

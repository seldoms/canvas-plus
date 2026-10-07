import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROJECT_TOOL_NAMES } from "../canvas/project-tools.js";
import { toolNames } from "../canvas/schemas.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

/**
 * 工具数量口径：多处引导文案都写着「N 个工具」，加工具后极易漂。
 * 实测 2026-10-08（MCP tools/list 握手）：**54 个**，其中 project_* 20 个。
 *
 * 这条测试的价值不在于「记住 54」，而在于让**文案与代码**绑在一起：
 * 改了 toolNames 却没改文案 → 立刻变红，而不是等工友来说「装完工具怎么还是旧的」。
 */
const DECLARED_TOOL_COUNT = 54;

/** 文案里声明工具数的位置：改文案时这些文件都要一起看。 */
const COPY_SITES = [
  "web/src/i18n/locales/zh-CN.ts",
  "web/src/i18n/locales/en-US.ts",
  "ONBOARDING.md",
  "plugins/infinite-canvas/README.md",
];

test("toolNames 是 MCP 实际暴露的清单，且与文案声明的数量一致", () => {
    assert.ok(Array.isArray(toolNames) && toolNames.length > 0, "toolNames 必须是真实清单");
    assert.equal(
        toolNames.length,
        DECLARED_TOOL_COUNT,
        `实际工具数是 ${toolNames.length}，文案里写的是 ${DECLARED_TOOL_COUNT} —— 以代码为准，两处都要改`,
    );
    assert.equal(
        toolNames.length,
        new Set(toolNames).size,
        "工具名不能重复：重复项在 MCP 里只注册一次，清单却会让人数错",
    );
});

test("project_* 工具已并入主清单（不是只挂在项目工具表里）", () => {
    // 反过来漏掉会更隐蔽：项目工具全在 PROJECT_TOOL_NAMES 里但没进 toolNames，
    // 那么装完插件后 Agent 看得见「project_」的名字却调不到 —— 少 20 个工具且不报错。
    for (const name of PROJECT_TOOL_NAMES) {
        assert.ok(
            (toolNames as readonly string[]).includes(name),
            `${name} 在 project-tools 里注册但不在 toolNames 里：Agent 调不到它`,
        );
    }
});

test("引导文案里的工具数与代码一致（防止工友按旧数字判断装没装对）", () => {
    const stale: string[] = [];
    for (const rel of COPY_SITES) {
        const file = path.join(REPO_ROOT, rel);
        let text: string;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue; // 文件不在当前分发范围内时跳过，不因此报假红
        }
        // 匹配「N 个工具」/「N tools」，排除工具清单里的枚举行
        for (const match of text.matchAll(/(\d+)\s*(?:个工具|tools)/g)) {
            const n = Number(match[1]);
            if (n !== DECLARED_TOOL_COUNT) {
                stale.push(`${rel}: 写着「${match[0]}」`);
            }
        }
    }
    assert.deepEqual(stale, [], `这些地方还写着旧的工具数：\n${stale.join("\n")}`);
});

test("插件注册名是 canvas-plus：照 infinite-canvas 装必然失败", async () => {
    // 这条是真实踩过的坑：marketplace.json 注册名已是 canvas-plus，
    // 而插件 README 仍让工友敲 `plugin add infinite-canvas@...`，报「找不到插件」。
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, ".agents/plugins/marketplace.json"), "utf8")) as {
        name: string;
        plugins: Array<{ name: string; source: { source: string; path: string } }>;
    };
    assert.ok(manifest.plugins.length > 0, "marketplace 必须至少有一个插件");
    const names = manifest.plugins.map((item) => item.name);
    assert.ok(
        names.every((name) => name === "canvas-plus"),
        `marketplace 注册名应全为 canvas-plus，实际 ${names.join(", ")}`,
    );
    // source.path 相对 marketplace 根（仓库根），不是 .agents/plugins/ —— 官方口径。
    for (const item of manifest.plugins) {
        const dir = path.join(REPO_ROOT, item.source.path);
        assert.ok(readdirSync(dir).length > 0, `source.path 指向的目录不存在或为空：${item.source.path}`);
    }
    // 插件 README 里的安装命令必须与注册名一致。
    const readme = readFileSync(path.join(REPO_ROOT, "plugins/infinite-canvas/README.md"), "utf8");
    assert.ok(
        /codex plugin add canvas-plus@/.test(readme),
        "插件 README 仍让工友装 infinite-canvas（上游名），照做会报找不到插件",
    );
    assert.ok(
        !/codex plugin add infinite-canvas@/.test(readme),
        "README 里仍有上游注册名的安装命令",
    );
});

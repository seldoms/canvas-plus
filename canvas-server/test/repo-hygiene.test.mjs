/**
 * 仓库卫生：测试文件不能落在 test/ 之外。
 *
 * 背景（这不是洁癖，是真实故障）：
 *   2026-10-08 发现 `canvas-server/casting.test.mjs` 与 `casting-pack.test.mjs`
 *   两份测试躺在包根目录，内容是 test/ 下同名文件的**早期快照**（少一条真机踩坑的用例）。
 *   它们 `import from "../src/..."` —— 这个路径只有在 test/ 里才解析得对，
 *   所以两份都跑不过（ERR_MODULE_NOT_FOUND），而 `node --test test/*.test.mjs`
 *   又扫不到它们。**结果是两份僵尸文件在仓库里躺了很久，没人发现。**
 *
 * 判据：文件在 git 里被跟踪、以 .test.* 结尾、但不在 test/ 目录里，且用 `../` 相对导入。
 * 只用「测试文件必须在 test/ 下」会误伤（如 web/tests/、canvas-agent 的 src 下的 .test.ts），
 * 所以再加一条「且引用 ../ 」把范围收紧到「确实是错位的副本」。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..");

function gitTrackedFiles(cwd, args) {
    const out = execFileSync("git", ["ls-files", ...args], { cwd, encoding: "utf8" });
    return out.split("\n").filter(Boolean);
}

test("canvas-server 里没有落在 test/ 之外的测试文件（僵尸副本防线）", () => {
    const misplaced = [];
    for (const file of gitTrackedFiles(PKG_ROOT, ["*.test.mjs", "*.test.js"])) {
        if (file.startsWith("test/")) continue;
        const text = readFileSync(path.join(PKG_ROOT, file), "utf8");
        // ../ 相对导入只有在 test/ 下才成立 → 说明它本该在 test/ 里。
        if (!/\.\.\/src\//.test(text)) continue;
        misplaced.push(file);
    }
    assert.deepEqual(
        misplaced,
        [],
        `这些测试文件在包根目录，用的是 test/ 的相对导入，跑也跑不起来、test glob 也扫不到：\n${misplaced.join("\n")}\n` +
            `若内容与 test/ 下同名文件重复，直接删；若test/ 下是旧版，把内容搬进 test/ 再删。`,
    );
});

test("测试 glob 能扫到 canvas-server 的全部测试文件（没有扫不到的孤儿）", () => {
    // 上一条的互补检查：光看「引用 ../src」可能漏掉那些用绝对路径或相对路径写法的孤儿。
    // 真实判据是 glob：node --test test/*.test.mjs 跑不到的文件等于白写。
    const tracked = gitTrackedFiles(PKG_ROOT, ["*.test.mjs"]).filter((f) => !f.includes("/"));
    const orphan = tracked.filter((f) => !f.startsWith("test/"));
    assert.deepEqual(
        orphan,
        [],
        `这些测试文件不被 \`node --test test/*.test.mjs\` 扫到，等于没写：\n${orphan.join("\n")}`,
    );
});

test("仓库根 README 是项目说明，不是插件说明（rsync 串写防线）", () => {
    // 2026-10-08 同一批操作里，一次多路径 rsync 把 plugins/infinite-canvas/README.md
    // 的内容写进了仓库根 README.md，50 行项目说明被覆盖 —— 提交前靠 git diff 才发现。
    // 这条把「根 README 开头该是什么」固定下来，让串写在下一次提交前就变红。
    const head = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").split("\n").slice(0, 3).join("\n");
    assert.ok(
        /canvas-plus|短剧|Infinite Canvas/.test(head),
        `仓库根 README.md 开头不像项目说明（疑似被别的 README 覆盖）：${JSON.stringify(head)}`,
    );
    assert.ok(
        !/注册名是\s*`?canvas-plus/.test(head),
        "根 README 疑似被插件 README 覆盖（这段文字属于 plugins/infinite-canvas/README.md）",
    );
});

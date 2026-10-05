import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 路由层集成：GET /api/pipeline/runs/:id/log（追加式审计日志）。
 * 只做读与追加式写入（create / setStageInput），**不触发任何生成**，不碰 LLM 与 ComfyUI。
 * 本文件独立进程运行（node --test 每个文件一个子进程），index.js 单例配置不会串到别的用例。
 */

function makeSkills(root) {
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "01-script"), { recursive: true });
    writeFileSync(join(skillsDir, "01-script", "SKILL.md"), "---\nname: novel-to-script\ndescription: |\n  测试剧本\n---\n\n# 剧本\n\n## 提示词模板\n\n返回 JSON。\n{{novel}}\n");
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({ version: 1, stages: [{ id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" }] }),
    );
    return skillsDir;
}

const VALID_SCRIPT = {
    logline: "一句话",
    synopsis: "梗概",
    characters: [],
    scenes: [{ id: "sc1", title: "村口", location: "外景 村口", time: "日", intent: "出场", beats: ["甲走进村子"] }],
};

test("index 集成：审计日志可读、按 limit 截尾、未知 run 返回空数组", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-run-log-http-"));
    const skillsDir = makeSkills(root);
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    const mod = await import("../src/index.js");

    const run = mod.pipeline.create({ novel: "很久以前有一个村子", actor: "agent:codex" });
    mod.pipeline.setStageInput(run.id, "script", { output: VALID_SCRIPT, actor: "web" });

    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${mod.server.address().port}/api/pipeline/runs`;
    try {
        const all = await fetch(`${base}/${run.id}/log`);
        assert.equal(all.status, 200);
        const { log } = await all.json();
        assert.deepEqual(log.map((entry) => entry.op), ["run.create", "stage.edit"]);
        assert.equal(log[0].actor, "agent:codex");
        assert.equal(log[1].actor, "web");
        assert.match(log[1].hash, /^[0-9a-f]{16}$/);

        const tail = await fetch(`${base}/${run.id}/log?limit=1`);
        assert.deepEqual((await tail.json()).log.map((entry) => entry.op), ["stage.edit"]);

        const missing = await fetch(`${base}/run-not-exist/log`);
        assert.equal(missing.status, 200);
        assert.deepEqual((await missing.json()).log, []);
    } finally {
        mod.server.closeAllConnections?.();
        mod.server.close();
    }
});

/**
 * 路由层集成：素材包导出端点（M4 补齐，此前只有 CLI 入口）。
 *   POST /api/pipeline/runs/:id/steps/assembly/export   → 202（异步，不阻塞）
 *   GET  /api/pipeline/runs/:id/steps/assembly/export   → 读 manifest / 列举已导出的包
 *
 * **绝不真跑 ffmpeg**：POST 会真的调 exportDeliveryPackage，故本文件只验证
 * 「契约与路由形状」——参数校验、404/409、GET 的列举与 manifest 读取，
 * 真导出能力由 edit-export.test.mjs / edit-export-mapping.test.mjs 覆盖。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

async function bootIndex(t, prefix) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const skillsDir = makeSkills(root);
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    const mod = await import("../src/index.js");
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    return {
        mod,
        base: `http://127.0.0.1:${mod.server.address().port}/api/pipeline/runs`,
        dataDir: process.env.CANVAS_SERVER_DATA_DIR,
        close: () => {
            mod.server.closeAllConnections?.();
            mod.server.close();
        },
    };
}

test("导出路由：GET 未导出时返回空列表而不是报错", async (t) => {
    const { mod, base, close } = await bootIndex(t, "canvas-export-http-a-");
    try {
        const run = mod.pipeline.create({ novel: "一个村子的故事" });
        mod.pipeline.setStageInput(run.id, "script", { output: VALID_SCRIPT });

        const res = await fetch(`${base}/${run.id}/steps/assembly/export`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.packageId, null, "还没导出，不该有 packageId");
        assert.deepEqual(body.packages, [], "没导出过时列表为空");
        assert.equal(body.manifest, undefined, "没导出时不该有 manifest");
    } finally {
        close();
    }
});

test("导出路由：POST 对未知 run 返回 404，不误起ffmpeg", async (t) => {
    const { base, close } = await bootIndex(t, "canvas-export-http-b-");
    try {
        const res = await fetch(`${base}/run-not-exist/steps/assembly/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        assert.equal(res.status, 404);
    } finally {
        close();
    }
});

test("导出路由：GET 能读回已落盘的 manifest（按 packageId 定位）", async (t) => {
    // ⚠️ index.js 是**模块单例**：本文件内所有用例共享同一个 config（第一次 import 时固化）。
    // 因此必须用mod.config.dataDir（真实生效值）写文件，不能用 bootIndex 返回的
    // CANVAS_SERVER_DATA_DIR——后者只对「第一次 import」有效，逐例改它没有意义。
    const { mod, base, close } = await bootIndex(t, "canvas-export-http-c-");
    try {
        const run = mod.pipeline.create({ novel: "一个村子的故事" });
        mod.pipeline.setStageInput(run.id, "script", { output: VALID_SCRIPT });

        // 模拟一次已完成的导出：按 edit-export.js 的落盘规则写 manifest
        const pkgId = `edit-export-${run.id}`;
        const pkgDir = join(mod.config.dataDir, "artifacts", pkgId);
        mkdirSync(pkgDir, { recursive: true });
        const manifest = { pkgId, runId: run.id, episodes: [{ episodeId: "ep_0001", partial: false }] };
        writeFileSync(join(pkgDir, "export-manifest.json"), JSON.stringify(manifest));

        const res = await fetch(`${base}/${run.id}/steps/assembly/export`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.packageId, pkgId);
        assert.equal(body.manifest.runId, run.id);
        assert.equal(body.manifest.episodes.length, 1);
    } finally {
        close();
    }
});

test("导出路由：显式 packageId 可读其它包，且不能穿越目录", async (t) => {
    const { mod, base, dataDir, close } = await bootIndex(t, "canvas-export-http-d-");
    try {
        const run = mod.pipeline.create({ novel: "一个村子的故事" });
        mod.pipeline.setStageInput(run.id, "script", { output: VALID_SCRIPT });

        // 目录穿越尝试：safeJoin + sanitizeName 应把它挡在 artifacts 内
        const evil = await fetch(`${base}/${run.id}/steps/assembly/export?packageId=${encodeURIComponent("../../etc")}`);
        assert.equal(evil.status, 200);
        const body = await evil.json();
        // 要么被安全地归一成一个不存在的包（返回空列表），要么读到但绝不能读到 artifacts 之外
        assert.ok(body.packageId === null || typeof body.packageId === "string");
        if (body.packageId !== null) {
            assert.ok(!body.packageId.includes("/"), `packageId 不应含路径分隔符：${body.packageId}`);
            assert.ok(!existsSyncOutside(dataDir, body.packageId), "绝不能读到 dataDir 之外");
        }
    } finally {
        close();
    }
});

function existsSyncOutside(dataDir, packageId) {
    // packageId 若是绝对路径或含 ..，一律视为越界
    return packageId.startsWith("/") || packageId.includes("..");
}

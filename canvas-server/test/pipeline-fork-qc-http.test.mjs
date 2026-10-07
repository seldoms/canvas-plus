import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("HTTP 分支与 QC：项目归属、父 run 隔离、报告持久化/过期与参数拒绝", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-fork-qc-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [
        { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
        { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
    ] }));
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    process.env.CANVAS_SERVER_LLM_URL = "http://127.0.0.1:9";
    process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
    const mod = await import("../src/index.js");
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        mod.server.closeAllConnections?.();
        mod.server.close();
        for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_COMFY_URL"]) delete process.env[key];
        rmSync(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${mod.server.address().port}`;
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const project = mod.projects.create({ title: "电话场景" });
    const parent = mod.pipeline.create({ novel: "一通电话", options: { projectId: project.id } });
    const script = { scenes: [{ id: "sc1", beats: ["来电"] }], characters: [], episodes: [{ id: "ep1", sceneIds: ["sc1"] }] };
    mod.pipeline.setStageInput(parent.id, "script", { output: script });
    mod.pipeline.setStageInput(parent.id, "storyboard", { output: { shots: [{ id: "sh1", sceneId: "sc1" }] } });
    const path = `/api/pipeline/runs/${parent.id}`;
    const response = await post(path + "/fork", { fromStage: "storyboard" });
    assert.equal(response.status, 201);
    const branch = (await response.json()).run;
    assert.equal(branch.branchOf, parent.id);
    assert.equal(branch.stages.script.status, "done");
    assert.equal(branch.stages.storyboard.status, "pending");
    assert.deepEqual(mod.pipeline.get(parent.id).stages.storyboard.output.shots, [{ id: "sh1", sceneId: "sc1" }]);
    assert.ok(mod.projects.get(project.id).runIds.includes(branch.id));

    const checked = await post(path + "/qc", { stage: "script" });
    assert.equal(checked.status, 201);
    const report = (await checked.json()).report;
    assert.equal(report.status, "pass");
    const read = (await (await fetch(base + path + "/qc")).json()).report;
    assert.equal(read.id, report.id);
    assert.equal(read.stale, false);
    mod.pipeline.setStageInput(parent.id, "script", { output: { ...script, synopsis: "改稿" } });
    assert.equal((await (await fetch(base + path + "/qc")).json()).report.stale, true);

    assert.equal((await post(path + "/qc", { stage: "unknown" })).status, 400);
    assert.equal((await post(path + "/fork", { fromStage: "unknown" })).status, 400);
    assert.equal((await post("/api/pipeline/runs/run-missing/fork", {})).status, 404);
    assert.equal((await post("/api/pipeline/runs/run-missing/qc", {})).status, 404);
    const invalid = await fetch(base + path + "/fork", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(invalid.status, 400);
});

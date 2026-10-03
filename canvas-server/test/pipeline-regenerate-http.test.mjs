import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 路由层集成：POST /api/pipeline/runs/:id/steps/:stage/regenerate 的门禁与状态码。
 * 只测拒绝路径（400/409）——**绝不触发成功入队**，避免向真实 ComfyUI 提交生成任务；
 * 成功追加候选（202）的语义由 pipeline.test.mjs 的单元用例覆盖。
 * 本文件独立进程运行（node --test 每个文件一个子进程），index.js 单例配置不会串到别的用例。
 */

/** 最小 skills 环境：4 个阶段 + registry（regenerate 只依赖阶段类型，不真正调模型）。 */
function makeSkills(root) {
    const skillsDir = join(root, "skills");
    const skills = {
        "01-script": ["novel-to-script", "测试剧本", "返回 JSON。\n{{novel}}"],
        "02-storyboard": ["storyboard", "测试分镜", "返回 shots。\n{{script}}"],
        "04-keyframes": ["keyframes", "测试关键帧", "返回 frames。\n{{storyboard}}"],
        "05-clip-assembly": ["clip-assembly", "测试片段", "返回 clips。\n{{storyboard}}"],
    };
    for (const [id, [name, description, prompt]] of Object.entries(skills)) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}\n`);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜拆解", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
                { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
            ],
        }),
    );
    return skillsDir;
}

test("index 集成：regenerate 路由——文本阶段/缺失条目/非法模板 400，运行中阶段 409", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "canvas-regen-http-"));
    const skillsDir = makeSkills(root);
    t.after(() => {
        delete process.env.CANVAS_SERVER_DATA_DIR;
        delete process.env.CANVAS_SERVER_SKILLS_DIR;
        rmSync(root, { recursive: true, force: true });
    });
    process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
    process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
    const mod = await import("../src/index.js");

    const run = mod.pipeline.create({ novel: "很久以前有一个村子" });
    await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
    const port = mod.server.address().port;
    const url = (runId, stage) => `http://127.0.0.1:${port}/api/pipeline/runs/${runId}/steps/${stage}/regenerate`;
    const post = (runId, stage, body) => fetch(url(runId, stage), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    try {
        // 文本阶段（script）没有候选活扣 → 400
        const text = await post(run.id, "script", { itemId: "sh1-start" });
        assert.equal(text.status, 400);
        assert.match((await text.json()).error.message, /不是生成型阶段/);

        // 生成型阶段但还没有产物条目 → 400
        const empty = await post(run.id, "keyframe", { itemId: "sh1-start", template: "img_zimage_artistic" });
        assert.equal(empty.status, 400);
        assert.match((await empty.json()).error.message, /没有条目/);

        // 未知 run → 400（与 /run 路由一致）
        const missing = await post("run-nope", "keyframe", { itemId: "sh1-start" });
        assert.equal(missing.status, 400);
        assert.match((await missing.json()).error.message, /流水线不存在/);

        // 造一个已就绪的 keyframe 条目（阶段保持 done，不触发入队）
        mod.pipeline.setStageInput(run.id, "storyboard", { output: { shots: [] } });
        mod.pipeline.setStageInput(run.id, "keyframe", {
            output: { frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "x", candidates: [], jobId: null, status: "pending", artifactUrl: null }] },
        });

        // 模板不存在 → 400
        const noTemplate = await post(run.id, "keyframe", { itemId: "sh1-start", template: "no_such_template" });
        assert.equal(noTemplate.status, 400);
        assert.match((await noTemplate.json()).error.message, /模板不存在/);

        // 模板 family 不符（视频模板塞进关键帧）→ 400
        const wrongFamily = await post(run.id, "keyframe", { itemId: "sh1-start", template: "video_h3_i2v" });
        assert.equal(wrongFamily.status, 400);
        assert.match((await wrongFamily.json()).error.message, /不能用于/);

        // 把阶段标成 running（beginStage 只标记状态，不真正执行、不入队）→ 409
        mod.pipeline.beginStage(run.id, "keyframe", {});
        assert.equal(mod.pipeline.get(run.id).stages.keyframe.status, "running");
        const busy = await post(run.id, "keyframe", { itemId: "sh1-start", template: "img_zimage_artistic" });
        assert.equal(busy.status, 409);
        assert.match((await busy.json()).error.message, /正在运行中/);
    } finally {
        await new Promise((resolve) => mod.server.close(resolve));
    }
});

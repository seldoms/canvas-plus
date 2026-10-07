/**
 * 路由层集成：分镜定点编辑端点必须把 changedFields / downstreamStale 回传（P2）。
 *
 * 为什么单开一个 HTTP 测试：这次真机验证抓到的正是**路由层丢字段** ——
 * patchStageShot 内部算对了 stale 并写进 run，但路由只回 `{ run, shot }`，
 * 前端与 Agent 拿到的就是 `undefined`，等于整个 P2 的失效提示在最后一米失效。
 * 单测直接打 pipeline 函数抓不到这类问题（上一轮就是这样「单测全绿、功能不对」）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT_OUTPUT = {
    logline: "末班车",
    synopsis: "深夜末班车上的相遇。",
    characters: [{ id: "c1", name: "老周", profile: "司机" }],
    scenes: [{ id: "sc1", title: "车上", location: "内景 公交车内", time: "夜", intent: "相遇", beats: ["上车"] }],
    episodes: [{ id: "ep1", index: 1, title: "末班车", durationSec: 30, synopsis: "相遇", sceneIds: ["sc1"] }],
};
const STORYBOARD_OUTPUT = {
    shots: [{ id: "sh1", episodeId: "ep1", sceneId: "sc1", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "上车", dialogue: "", audio: "", prompt: "a" }],
};

function fakeLlm() {
    return {
        async chat(options) {
            const content = String(options.messages.at(-1)?.content ?? "");
            const value = content.includes("分镜师") ? STORYBOARD_OUTPUT : content.includes("分集规划师") ? { episodes: SCRIPT_OUTPUT.episodes } : SCRIPT_OUTPUT;
            return { choices: [{ message: { content: JSON.stringify(value) } }] };
        },
    };
}

function makeSkills(root) {
    const skillsDir = join(root, "skills");
    for (const [id, name, description, prompt] of [
        ["01-script", "novel-to-script", "测试剧本", "你是编剧，返回 JSON。\n{{novel}}\n"],
        ["02-storyboard", "storyboard", "测试分镜", "你是分镜师，返回 shots。\n{{script}}\n"],
    ]) {
        mkdirSync(join(skillsDir, id), { recursive: true });
        writeFileSync(join(skillsDir, id, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## 提示词模板\n\n${prompt}`);
    }
    writeFileSync(
        join(skillsDir, "registry.json"),
        JSON.stringify({
            version: 1,
            stages: [
                { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
                { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
                { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard"], produces: "keyframes" },
            ],
        }),
    );
    return skillsDir;
}

async function boot(t, prefix) {
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
        base: `http://127.0.0.1:${mod.server.address().port}`,
        close: () => {
            mod.server.closeAllConnections?.();
            mod.server.close();
        },
    };
}

test("PATCH 镜头：路由回传 changedFields 与 downstreamStale（关键帧已失效这件事必须出得了 HTTP）", async (t) => {
    const { mod, base, close } = await boot(t, "canvas-shot-patch-http-");
try {
        const run = mod.pipeline.create({ novel: "很久以前有一个村口", title: "短篇" });
        // 直接用 pipeline 的 setStageInput 落分镜产物（跳过 LLM —— 这里验证的是路由形状，不是 LLM 产出）。
        mod.pipeline.setStageInput(run.id, "storyboard", { output: STORYBOARD_OUTPUT });
        // 造一个有关键帧产物的下游（stale 判定前提）。
        mod.pipeline.setStageInput(run.id, "keyframe", { output: { frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "a", artifactUrl: "/api/artifacts/j1/a.png" }] } });

        const url = `${base}/api/pipeline/runs/${run.id}/steps/storyboard/shots/sh1`;
        const res = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "changed prompt" }) });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.changedFields, ["prompt"], "changedFields 必须出 HTTP");
        assert.deepEqual(body.downstreamStale, ["keyframe"], "downstreamStale 必须出 HTTP");
        assert.equal(body.shot.prompt, "changed prompt");

        // 同值再改一次：字段在但不报 stale（且不能是 undefined）
        const again = await (await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "changed prompt" }) })).json();
        assert.deepEqual(again.changedFields, [], "同值 changedFields 为空数组而非 undefined");
        assert.deepEqual(again.downstreamStale, [], "无失效时为空数组");
    } finally {
        close();
    }
});

test("PATCH 镜头：结构位字段被拒（400），且错误信息可读", async (t) => {
    const { mod, base, close } = await boot(t, "canvas-shot-struct-http-");
    try {
        const run = mod.pipeline.create({ novel: "很久以前有一个村口", title: "短篇" });
        mod.pipeline.setStageInput(run.id, "storyboard", { output: STORYBOARD_OUTPUT });
        const res = await fetch(`${base}/api/pipeline/runs/${run.id}/steps/storyboard/shots/sh1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sceneId: "sc9" }) });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.match(body.error.message, /不可定点改/);
    } finally {
        close();
    }
});
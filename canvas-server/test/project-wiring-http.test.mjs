import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// —— 隔离环境：临时 data/skills、假 LLM，ComfyUI 指向不可达地址（绝不碰 147 的 ComfyUI）——
const root = mkdtempSync(join(tmpdir(), "canvas-wiring-"));
const skillsDir = join(root, "skills");
mkdirSync(skillsDir, { recursive: true });
// 最小 stage 环境：与 skills/registry.json 同名的 run 阶段 + 01 剧本技能模板（回填测试要读「## 提示词模板」）
writeFileSync(
    join(skillsDir, "registry.json"),
    JSON.stringify({
        version: 1,
        stages: [
            { id: "script", title: "剧本", skill: "01-script", requires: [], produces: "script" },
            { id: "storyboard", title: "分镜", skill: "02-storyboard", requires: ["script"], produces: "storyboard" },
            { id: "design", title: "服化道", skill: "03-design", requires: ["script"], produces: "design" },
            { id: "keyframe", title: "关键帧", skill: "04-keyframes", requires: ["storyboard", "design"], produces: "keyframes" },
            { id: "assembly", title: "片段合成", skill: "05-clip-assembly", requires: ["keyframe"], produces: "clips" },
        ],
    }),
);
mkdirSync(join(skillsDir, "01-script"), { recursive: true });
writeFileSync(join(skillsDir, "01-script", "SKILL.md"), "---\nname: novel-to-script\ndescription: 测试用剧本技能\n---\n\n# 剧本\n\n## 输入\n\n- novel\n\n## 提示词模板\n\n把下面小说改编成剧本：{{novel}}\n");

const SCRIPT_REPLY = { logline: "一句话", synopsis: "梗概", characters: [], scenes: [{ id: "sc1" }] };
let llmReply = SCRIPT_REPLY;
const llmServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmReply) } }] }));
    });
});
await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
const llmUrl = `http://127.0.0.1:${llmServer.address().port}`;

process.env.CANVAS_SERVER_DATA_DIR = join(root, "data");
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_LLM_URL = llmUrl;
// 显式绑一个本地模型名：否则会继承 config.json 的 llm.defaultModel（可能是「渠道::模型」的外部路由），
// 在本隔离环境里未注册该渠道，脚本阶段会因「未注册的外部 LLM 渠道」直接失败。
process.env.CANVAS_SERVER_LLM_MODEL = "test-model";
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9"; // 不可达：任何生成任务都会立刻失败，绝不真跑
const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    await new Promise((resolve) => {
        llmServer.closeAllConnections?.();
        llmServer.close(resolve);
    });
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_LLM_MODEL", "CANVAS_SERVER_COMFY_URL"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const asJson = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const makeProject = async (input) => (await (await fetch(`${base}/api/projects`, asJson(input))).json()).project;
const getProject = async (id) => (await (await fetch(`${base}/api/projects/${id}`)).json()).project;
const archive = (id) => fetch(`${base}/api/projects/${id}/archive`, { method: "POST" });

test("index 集成：/asset-refs 四条路由与 /gates 真实返回 JSON（不是 SPA HTML）", async () => {
    const project = await makeProject({ title: "资产端到端", script: { logline: "一句话" } });

    const listRes = await fetch(`${base}/api/projects/${project.id}/asset-refs`);
    assert.equal(listRes.status, 200);
    assert.match(listRes.headers.get("content-type"), /application\/json/);
    assert.deepEqual((await listRes.json()).assetRefs, []);

    const createRes = await fetch(`${base}/api/projects/${project.id}/asset-refs`, asJson({ role: "character", bindingId: "char_1", artifactIds: ["a1", "a2"] }));
    assert.equal(createRes.status, 201);
    assert.match(createRes.headers.get("content-type"), /application\/json/);
    const ref = (await createRes.json()).assetRef;
    assert.equal(ref.bindingId, "char_1");

    const patchRes = await fetch(`${base}/api/projects/${project.id}/asset-refs/${ref.id}`, asJson({ bindingId: "char_2" }, "PATCH"));
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).assetRef.bindingId, "char_2", "前端走 PATCH");
    const postRes = await fetch(`${base}/api/projects/${project.id}/asset-refs/${ref.id}`, asJson({ bindingId: "char_3" }));
    assert.equal(postRes.status, 200);
    assert.equal((await postRes.json()).assetRef.bindingId, "char_3", "契约走 POST");

    const selectRes = await fetch(`${base}/api/projects/${project.id}/asset-refs/${ref.id}/select`, asJson({ artifactId: "a2" }));
    assert.equal(selectRes.status, 200);
    assert.equal((await selectRes.json()).assetRef.selectedArtifactId, "a2");

    const filtered = (await (await fetch(`${base}/api/projects/${project.id}/asset-refs?role=character`)).json()).assetRefs;
    assert.equal(filtered.length, 1, "role 过滤生效");

    const gatesRes = await fetch(`${base}/api/projects/${project.id}/gates`);
    assert.equal(gatesRes.status, 200);
    assert.match(gatesRes.headers.get("content-type"), /application\/json/);
    const gates = (await gatesRes.json()).gates;
    assert.deepEqual(gates.map((gate) => gate.stageId), ["plan", "script", "storyboard", "design", "keyframe", "assembly", "post"]);
    assert.ok(gates.some((gate) => gate.stageId === "design" && gate.done === true), "有 assetRefs → design 阶段 done");

    await archive(project.id);
});

test("index 集成：注入 getProject 后 plan.ratio=16:9 的 run 产出 1376×768（不跑 ComfyUI）", async () => {
    const project = await makeProject({ title: "画幅", plan: { ratio: "16:9" } });
    const run = mod.pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    mod.pipeline.setStageInput(run.id, "keyframe", { output: { frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "少女走进老屋，中景" }] } });
    const begun = mod.pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" });
    assert.equal(begun.plan.params.WIDTH, 1376, "16:9 长边 768*16/9≈1365.33 吸附到 32 倍数");
    assert.equal(begun.plan.params.HEIGHT, 768);
    assert.equal(begun.plan.params.WIDTH % 32, 0);
    assert.equal(begun.plan.params.HEIGHT % 32, 0);
    await archive(project.id);
});

test("index 集成：script 阶段完成后回填 planSuggestion（只填空字段、幂等）", async () => {
    const project = await makeProject({ title: "回填", styleAnchor: "冷调", plan: { genre: "都市" } });
    const before = await getProject(project.id);
    llmReply = {
        ...SCRIPT_REPLY,
        planSuggestion: { genre: "悬疑", tone: "冷硬", visualStyle: "写实真人", dramaMode: "微电影向", audience: "年轻女性", episodeCount: 24, episodeDurationSec: 90 },
    };
    const run = mod.pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    await mod.pipeline.runStage(run.id, "script");

    const after = await getProject(project.id);
    assert.equal(after.plan.genre, "都市", "用户已填 genre 不覆盖");
    assert.equal(after.plan.tone, "冷硬");
    assert.equal(after.plan.visualStyle, "写实真人");
    assert.equal(after.plan.dramaMode, "微电影向");
    assert.equal(after.plan.audience, "年轻女性");
    assert.equal(after.plan.episodeCount, 24);
    assert.equal(after.plan.episodeDurationSec, 90);
    assert.equal(after.plan.ratio, "9:16", "ratio 不在建议范围");
    assert.equal(after.styleAnchor, "冷调", "styleAnchor 不在建议范围");
    assert.equal(after.version, before.version + 1, "回填经 projects.update：version 自增一次");

    await mod.pipeline.runStage(run.id, "script");
    assert.equal((await getProject(project.id)).version, after.version, "重复投递幂等：不再写盘");
    await archive(project.id);
});

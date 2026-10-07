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

// 显式指定配置文件，**不让它读 canvas-server/config.json**（那是被 gitignore 的开发机真配置，
// 里面有真实 API key 与内网地址，绝不能提交）。
// 不隔离的后果很具体：本文件要断言「16:9 取 qwen_image_2_1 官方档 2752x1536」，
// 依赖 config.pipeline.imageTemplate=img_qwen21_t2i；开发机上碰巧配了它所以全绿，
// 干净 clone / CI 上落到config.js 默认值 img_zimage_artistic → 断言拿到 1024 !== 2752 失败。
// 2026-10-08 首次上 CI 才暴露这条，本地 1120 全绿把它掩盖了。
// 注意：pipeline.imageTemplate **没有**对应环境变量（config.js 只给 llm/comfy/generation/runninghub 暴露了），
// 所以只能靠 CANVAS_SERVER_CONFIG 换整份配置文件。
const configFile = join(root, "config.json");
writeFileSync(
    configFile,
    JSON.stringify({
        llm: { baseUrl: llmUrl, apiKey: "test-key", defaultModel: "test-model" },
        comfy: { baseUrl: "http://127.0.0.1:9" },
        pipeline: { imageTemplate: "img_qwen21_t2i" },
    }),
);
process.env.CANVAS_SERVER_CONFIG = configFile;
const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    await new Promise((resolve) => {
        llmServer.closeAllConnections?.();
        llmServer.close(resolve);
    });
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_LLM_URL", "CANVAS_SERVER_LLM_MODEL", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_CONFIG"]) delete process.env[key];
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

test("index 集成：注入 getProject 后 plan.ratio=16:9 的 run 取该生图模型的官方 16:9 规格（不跑 ComfyUI）", async () => {
    const project = await makeProject({ title: "画幅", plan: { ratio: "16:9" } });
    const run = mod.pipeline.create({ novel: "很久以前", title: "短篇", options: { projectId: project.id } });
    mod.pipeline.setStageInput(run.id, "keyframe", { output: { frames: [{ id: "sh1-start", shotId: "sh1", role: "start", prompt: "少女走进老屋，中景" }] } });
    const begun = mod.pipeline.beginRegenerate(run.id, "keyframe", { itemId: "sh1-start" });
    // 尺寸从「该生图模型的官方规格登记表」取（config imageTemplate=img_qwen21_t2i → registry qwen_image_2_1）；
    // 16:9 官方档 = 2752x1536（不再实时按比例推导出官方没有的 1376）。
    assert.equal(begun.plan.params.WIDTH, 2752, "qwen_image_2_1 官方 16:9 档 = 2752x1536");
    assert.equal(begun.plan.params.HEIGHT, 1536);
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

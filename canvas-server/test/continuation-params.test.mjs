/**
 * 续接链段参数 vs 真实模板 token 的**端到端**契约测试（防「缺少参数」回归）。
 *
 * 背景（M3.5 真机实测发现）：首版开链返回 HTTP 201，但 Job 立刻 error
 * 「模板 video_minimax_h3_t2v 缺少参数：STEPS」——而当时单测 1002/1002 全绿，
 * 因为老测试把 submitIntent 换成假实现、从不渲染模板，**测不出缺参**。
 *
 * 本测试走真实 `createContinuation` + 真实 workflows 目录，捕获 submitIntent
 * 收到的 params，断言其覆盖段模板声明的每个 token。**回退生产代码即变红。**
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProjects } from "../src/projects.js";
import { createContinuation } from "../src/continuation.js";
import { loadRegistry } from "../src/skills.js";
import { scanTemplateDir } from "../src/tool-adapter.js";

const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const catalog = scanTemplateDir(WORKFLOWS_DIR);
const T2V = "video_minimax_h3_t2v";
const I2V = "video_h3_i2v";

const STORYBOARD_MD = `---
name: storyboard
description: 测试分镜
---

# 分镜

## 提示词模板

你是分镜师。
`;

/** 建带真实 workflows 目录的环境，并捕获 submitIntent 的 params。 */
function makeEnv(t) {
    const root = mkdtempSync(join(tmpdir(), "canvas-cont-e2e-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "02-storyboard"), { recursive: true });
    writeFileSync(join(skillsDir, "02-storyboard", "SKILL.md"), STORYBOARD_MD);
    writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));
    // ⚠️ 必须指真实 workflows 目录：本测试的全部价值就是用真实模板做校验
    const config = { dataDir: join(root, "data"), workflowsDir: WORKFLOWS_DIR };
    mkdirSync(config.dataDir, { recursive: true });
    const projects = createProjects({ dataDir: config.dataDir, stages: loadRegistry(skillsDir).stages });
    const project = projects.create({ title: "续接参数契约" });
    const { episode } = projects.episodes.save(project.id, { title: "第一集" });
    const { scene } = projects.episodes.addScene(project.id, episode.id, { locationId: "内景 街道", time: "夜", intent: "冷清" });
    const { shot } = projects.episodes.addShot(project.id, scene.id, { index: 1, storyboard: { prompt: "a man walks alone" } });

    const captured = [];
    const continuation = createContinuation({
        config,
        episodes: projects.episodes,
        jobs: { get: () => null, list: () => [] },
        submitIntent: async (intent) => {
            captured.push({ template: intent.template, params: intent.params });
            return { id: `fake-${captured.length}`, status: "queued", outputs: [] };
        },
        preflight: async () => {},
        extractTailFrame: async ({ outputPath }) => {
            mkdirSync(dirname(outputPath), { recursive: true });
            writeFileSync(outputPath, "png");
        },
        runSeamQc: async () => ({}),
    });
    return { project, shotId: shot.id, captured, continuation };
}

/**
 * PROMPT 由 M1 编译链从 facts.prompt 注入（不在 params 里），故不计入缺参。
 * 其余 token 必须由默认规格 / 调用方 / 规则表参数档覆盖。
 */
const NOT_IN_PARAMS = new Set(["PROMPT"]);

function missingTokens(params, template) {
    const tokens = catalog[template]?.tokens ?? [];
    return tokens.filter((token) => !NOT_IN_PARAMS.has(token) && params[token] === undefined);
}

test("真实模板目录能扫出两个段模板", () => {
    assert.ok(catalog[T2V], `缺少 seg0 模板 ${T2V}`);
    assert.ok(catalog[I2V], `缺少 seg≥1 模板 ${I2V}`);
});

test("回归锁定：seg0 模板声明 STEPS（缺它必报「缺少参数」）", () => {
    assert.ok(catalog[T2V].tokens.includes("STEPS"));
});

test("开链：seg0 产出的参数覆盖真实 T2VA 模板全部 token", async (t) => {
    const { project, shotId, captured, continuation } = makeEnv(t);
    await continuation.startChain({ projectId: project.id, shotId, prompt: "p", segments: 2, seed: 7 });
    assert.equal(captured.length, 1, "开链应只提交首段");
    assert.equal(captured[0].template, T2V);
    const missing = missingTokens(captured[0].params, T2V);
    assert.deepEqual(missing, [], `seg0 参数缺项：${missing.join(", ")}（HTTP 201 但 Job 会立刻 error）`);
    assert.equal(captured[0].params.STEPS, 8, "STEPS 应由规则表 speed 档回填为 8");
});

test("调用方显式给 STEPS 时不被参数档覆盖", async (t) => {
    const { project, shotId, captured, continuation } = makeEnv(t);
    await continuation.startChain({ projectId: project.id, shotId, prompt: "p", segments: 1, seed: 7, params: { STEPS: 30 } });
    assert.equal(captured[0].params.STEPS, 30);
});

test("seg≥1（I2VA）所需 token 由调用方 INPUT_IMAGE + 默认规格覆盖", async (t) => {
    const { project, shotId, captured, continuation } = makeEnv(t);
    await continuation.startChain({ projectId: project.id, shotId, prompt: "p", segments: 2, seed: 7 });
    const i2vTokens = catalog[I2V].tokens;
    // 段1 走 I2VA：INPUT_IMAGE 由抽尾帧注入，故此处只校验其余 token 已由默认规格/调用方覆盖
    const rest = i2vTokens.filter((token) => token !== "INPUT_IMAGE" && !NOT_IN_PARAMS.has(token));
    const params = captured[0].params;
    const missing = rest.filter((token) => params[token] === undefined);
    assert.deepEqual(missing, [], `I2VA 非抽帧参数缺项：${missing.join(", ")}`);
    assert.ok(i2vTokens.includes("INPUT_IMAGE"), "I2VA 模板需要 INPUT_IMAGE，由 extractTailFrame 注入");
});

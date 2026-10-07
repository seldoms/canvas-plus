/**
 * 路由层集成：单镜参考清单端点（GET /api/projects/:id/shots/:shotId/refs）。
 *
 * 为什么单开一个 HTTP 测试：这轮踩的坑正是「单测全绿、功能不对」的又一例 ——
 * shot-refs 纯函数测得再对，路由少回一个字段、前端拿不到编号，整条链就是失效的。
 * 参考 shot-patch-http 的理由：P2 的 stale 就是这么在最后一米丢的。
 *
 * 数据用**生产真实形状**：design 产物的 characters/locations/props、episodes 里的镜头
 * （顶层字段，非嵌套 storyboard），不是照着自己想的形状造。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const DESIGN_OUTPUT = {
    characters: [
        { id: "c_ling", name: "林灵", voiceProfileId: "vp_female_warm" },
        { id: "c_mother", name: "母亲" },
    ],
    locations: [{ id: "sc_stop", name: "老城南路公交站" }],
    props: [{ id: "pr_ticket", name: "末班车票" }],
};
const SCRIPT_OUTPUT = {
    logline: "末班车",
    synopsis: "深夜末班车。",
    characters: [{ id: "c_ling", name: "林灵" }],
    scenes: [{ id: "sc_0001", title: "公交站", location: "老城南路公交站", time: "夜", intent: "等待", beats: ["等车"] }],
    episodes: [{ id: "ep1", index: 1, title: "第一集", durationSec: 30, synopsis: "等待", sceneIds: ["sc_0001"] }],
};
/**
 * 场次必须带 locationId —— reference-lock.resolveLocationId 按 shot.locationId / scene.locationId /
 * scene.location 逐个试，只有 title/id 不够（这坑在 shot-refs 单测里已经踩过一次）。
 */
const STORYBOARD_OUTPUT = {
    scenes: [{ id: "sc_0001", sceneId: "sc_0001", locationId: "sc_stop", title: "公交站" }],
    shots: [
        { id: "sh1", episodeId: "ep1", sceneId: "sc_0001", index: 1, durationSec: 4, shotSize: "中景", camera: "固定", action: "林灵攥着末班车票站在站牌下", dialogue: "", audio: "", prompt: "a" },
    ],
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
                { id: "design", title: "服化道", skill: "03-design", requires: ["script"], produces: "design" },
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

/** 建项目 + run，并挂上 design 产物与 assetRefs（selectedArtifactId 决定参考图能不能解析出来）。 */
async function seed(mod, { withAssetRefs = true } = {}) {
    const run = mod.pipeline.create({ novel: "很久以前有一个村口", title: "短篇" });
    // 走真实 projects 接口建项目（attach/select 的签名照assets.js 真实契约，不照猜）。
    const project = await mod.projects.create({ title: "短篇" });
    const pid = project.id ?? project.project?.id;
    // design / storyboard 产物直接落盘（这里验证路由形状，不验证 LLM 产出）。
    mod.pipeline.setStageInput(run.id, "design", { output: DESIGN_OUTPUT });
    mod.pipeline.setStageInput(run.id, "storyboard", { output: STORYBOARD_OUTPUT });
    if (withAssetRefs) {
        for (const input of [
            { role: "character", bindingId: "c_ling", artifactId: "j1/a_ling.png" },
            { role: "character", bindingId: "c_mother", artifactId: "j1/a_mother.png" },
            { role: "scene", bindingId: "sc_stop", artifactId: "j1/a_stop.png" },
            { role: "prop", bindingId: "pr_ticket", artifactId: "j1/a_ticket.png" },
        ]) {
            const { assetRef } = mod.projects.assets.attach(pid, input);
            mod.projects.assets.select(pid, assetRef.id, { artifactId: input.artifactId });
        }
    }
    // run 要绑到项目，refs 端点才找得到 design/storyboard 产物。
    mod.projects.attachRun(pid, run.id);
    return { pid, run };
}

test("refs 端点：返回带编号的参考清单，且编号与模型实收顺序一致", async (t) => {
    const { mod, base, close } = await boot(t, "canvas-shot-refs-http-");
    try {
        const { pid } = await seed(mod);
        const res = await fetch(`${base}/api/projects/${pid}/shots/sh1/refs`);
        assert.equal(res.status, 200);
        const body = await res.json();

        assert.equal(body.found, true, "查得到这一镜");
        const byKind = (kind) => body.refs.filter((ref) => ref.kind === kind);

        // 角色：名字文本兜底推导出林灵（她在 action 里）；母亲不在文本里也不该被硬塞进来。
        const characters = byKind("character");
        assert.deepEqual(characters.map((ref) => ref.bindingId), ["c_ling"], "只有 action 里出现的角色才算引用");
        assert.equal(characters[0].label, "林灵", "要中文名");

        // 场景由 sceneId→locationId 归位；道具只认显式 token（本镜没写 propIds，故不该有）。
        assert.deepEqual(byKind("scene").map((ref) => ref.bindingId), ["sc_stop"], "场次带 locationId 才归位得到");
        assert.deepEqual(byKind("prop"), [], "道具不做文本兜底，本镜没显式声明就没有");

        // 音色在清单里，但不占图位编号（模型那边没有这张图）。
        const voices = byKind("voice");
        assert.equal(voices.length, 1, "林灵带音色 → 一条音色参考");
        assert.equal(voices[0].tag, null, "音色不给 @image#N —— 那个号在模型那边不存在");

        // 编号与实收顺序：这是 refs 唯一正确性判据，必须由后端判定并回传。
        assert.ok(body.alignment, "alignment 必须回传，前端要靠它决定能不能显示对应关系");
        assert.equal(body.alignment.aligned, true, `编号与模型实收顺序应对齐：${JSON.stringify(body.alignment.mismatches)}`);

        // 缩略图地址：artifactId 与网关产物路径都要带得出。
        const ling = characters[0];
        assert.equal(ling.artifactId, "j1/a_ling.png", "要带出模型实收的那张产物");
        assert.match(ling.url ?? "", /\/api\/artifacts\/j1\/a_ling\.png$/, "前端缩略图需要可访问地址");

        // 同一个响应里 refs[] 与 images[] 的地址必须一致 —— 真机验证踩到过：
        // 只给 refs 补了兜底，images[] 的 url 仍是 null，前端改读哪边都会踩空。
        const byKey = new Map(body.images.map((image) => [`${image.kind}:${image.bindingId}`, image]));
        for (const ref of body.refs.filter((row) => row.url)) {
            const image = byKey.get(`${ref.kind}:${ref.bindingId}`);
            assert.ok(image, `images[] 应有与 refs 同名的条目：${ref.kind}:${ref.bindingId}`);
            assert.equal(image.url, ref.url, `${ref.kind}:${ref.bindingId} 在 refs[] 与 images[] 里的地址必须一致`);
        }
    } finally {
        close();
    }
});

test("refs 端点：查不到镜头与「这一镜没有参考」必须能分开（都 200，但 found 不同）", async (t) => {
    const { mod, base, close } = await boot(t, "canvas-shot-refs-missing-");
    try {
        const { pid } = await seed(mod, { withAssetRefs: false });
        // 不存在的镜头 → found=false
        const missing = await (await fetch(`${base}/api/projects/${pid}/shots/shNOPE/refs`)).json();
        assert.equal(missing.found, false, "镜头不存在要如实说找不到");
        assert.deepEqual(missing.refs, [], "找不到镜头不给假清单");

        // 存在但没有任何资产引用 → found=true 且 complete=false（缺参考是事实，不是「没有这一镜」）
        const noRefs = await (await fetch(`${base}/api/projects/${pid}/shots/sh1/refs`)).json();
        assert.equal(noRefs.found, true, "这一镜存在");
        assert.equal(noRefs.complete, false, "没有 assetRefs 就没锁脸，不能报 complete");
        assert.ok(noRefs.missingRefs.length, "缺哪些要列出来，供门禁与面板如实提示");
    } finally {
        close();
    }
});

test("refs 端点：alignment=false 时必须回传错位项（前端据此警示，不能照着编号显示对应关系）", async (t) => {
    const { mod, base, close } = await boot(t, "canvas-shot-refs-align-");
    try {
        const { pid } = await seed(mod);
        // 直接打生产函数验证错位能被判定：把注入顺序换掉，refs 编号就该报不对齐。
        const refs = [
            { kind: "character", bindingId: "c_ling", index: 1 },
            { kind: "character", bindingId: "c_mother", index: 2 },
        ];
        const swapped = { character: [{ bindingId: "c_ling" }, { bindingId: "c_stranger" }], scene: [], prop: [] };
        const { checkRefNumbering } = await import("../src/shot-refs.js");
        const result = checkRefNumbering(refs, swapped);
        assert.equal(result.aligned, false);
        assert.equal(result.mismatches.length, 1, "错位项要具体到第几号，前端才能提示对不上哪张");
        // 端点本身在编号一致时必须回 aligned=true（真实链路）。
        const body = await (await fetch(`${base}/api/projects/${pid}/shots/sh1/refs`)).json();
        assert.equal(body.alignment.aligned, true);
    } finally {
        close();
    }
});

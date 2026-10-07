/**
 * project_* 工具的 HTTP 行为测试（M5）。
 *
 * 起一个**假网关**（真 HTTP、真 fetch、真JSON），验证工具的请求形状与响应处理：
 *   - 路径与查询参数拼装正确；
 *   - 业务错误（4xx）转成可读 Error，**不吞掉**；
 *   - 连不上网关时显式报错，Agent 能区分「工具不可用」与「成功但无结果」；
 *   - `project_adopt_candidate` 的 jobId=null 走**撤销采用**而非「什么都不做」。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { callProjectTool, gatewayBaseUrl, isProjectTool, PROJECT_TOOL_NAMES } from "./project-tools.js";

type Recorded = { method: string; url: string; body: unknown };

let server: ReturnType<typeof createServer>;
let base = "";
const recorded: Recorded[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
};

before(async () => {
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk as Buffer));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            recorded.push({ method: req.method || "GET", url: req.url || "", body: raw ? JSON.parse(raw) : undefined });
            respond(req, res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.CANVAS_GATEWAY_URL = base;
});

after(async () => {
    delete process.env.CANVAS_GATEWAY_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function lastRequest() {
    return recorded[recorded.length - 1];
}

describe("project_* 工具", () => {
    it("二十个工具都在 PROJECT_TOOL_NAMES 里且能被识别", () => {
        assert.equal(PROJECT_TOOL_NAMES.length, 20);
        for (const name of PROJECT_TOOL_NAMES) assert.equal(isProjectTool(name), true);
        assert.equal(isProjectTool("canvas_get_state"), false, "画布工具不该被认成 project 工具");
    });

    it("gatewayBaseUrl 默认 8788，可用环境变量覆盖，去掉尾部斜杠", () => {
        assert.equal(gatewayBaseUrl(), base);
        process.env.CANVAS_GATEWAY_URL = "http://example.test:9000/";
        assert.equal(gatewayBaseUrl(), "http://example.test:9000");
        process.env.CANVAS_GATEWAY_URL = base;
    });

    it("project_context 读 /context 并裁掉大字段（不返回剧本正文）", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({ project: { id: "prj_1", title: "喜宴之外", script: "很长的剧本".repeat(500), episodes: [{}, {}], runIds: ["run_1"], assetRefs: [{}], canvasIds: [] } }),
            );
        const result = (await callProjectTool("project_context", { projectId: "prj_1" })) as Record<string, unknown>;
        assert.equal(lastRequest().url, "/api/projects/prj_1/context");
        assert.equal(result.title, "喜宴之外");
        assert.equal(result.episodeCount, 2);
        assert.equal("script" in result, false, "剧本正文不该返回给 Agent");
    });

    it("project_context 缺 projectId 时本地报错，不发请求", async () => {
        const before = recorded.length;
        await assert.rejects(() => callProjectTool("project_context", {}), /缺少 projectId/);
        assert.equal(recorded.length, before, "缺参时不该打网关");
    });

    it("project_gates 归一化 stageId 并保留 blockedBy", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({ gates: [{ stageId: "script", status: "done", blockedBy: [] }, { id: "keyframe", status: "blocked", blockedBy: [{ type: "upstream", stageId: "casting" }] }] }),
            );
        const result = (await callProjectTool("project_gates", { projectId: "prj_1" })) as { gates: Array<Record<string, unknown>> };
        assert.equal(result.gates.length, 2);
        assert.equal(result.gates[1].stageId, "keyframe", "缺 stageId 时应回退用 id");
        assert.deepEqual(result.gates[1].blockedBy, [{ type: "upstream", stageId: "casting" }]);
    });

    it("project_list_jobs 拼查询参数并裁字段", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({ jobs: [{ id: "job_1", kind: "video", status: "done", template: "t", outputs: [{}, {}], secret: "不该出现" }] }),
            );
        const result = (await callProjectTool("project_list_jobs", { status: "done", kind: "video", limit: 5 })) as { jobs: Array<Record<string, unknown>> };
        const url = lastRequest().url;
        assert.ok(url.includes("status=done"), url);
        assert.ok(url.includes("kind=video"), url);
        assert.ok(url.includes("limit=5"), url);
        assert.equal(result.jobs[0].outputs, 2);
        assert.equal("secret" in result.jobs[0], false, "不该把整条 job 原样返回");
    });

    it("project_run_stage 走 POST 且透传 options", async () => {
        respond = (_req, res) => res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ inflight: true }));
        const result = (await callProjectTool("project_run_stage", { runId: "run_1", stage: "storyboard", options: { model: "qwen" } })) as Record<string, unknown>;
        const req = lastRequest();
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/api/pipeline/runs/run_1/steps/storyboard/run");
        assert.deepEqual(req.body, { model: "qwen" });
        assert.equal(result.inflight, true);
    });

    it("project_cancel_stage 走 POST cancel 端点", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ canceled: true }));
        await callProjectTool("project_cancel_stage", { runId: "run_1", stage: "keyframe" });
        const req = lastRequest();
        assert.equal(req.method, "POST");
        assert.ok(req.url.endsWith("/steps/keyframe/cancel"), req.url);
    });

    it("project_adopt_candidate 采用时传字符串 jobId", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        const result = (await callProjectTool("project_adopt_candidate", { projectId: "prj_1", shotId: "sh_1", slotId: "slot_x", jobId: "job_9" })) as Record<string, unknown>;
        assert.deepEqual(lastRequest().body, { jobId: "job_9" });
        assert.equal(result.cleared, false);
        assert.equal(result.adopted, "job_9");
    });

    it("project_adopt_candidate 撤销采用时传 null（不是 undefined、不是空串）", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        const result = (await callProjectTool("project_adopt_candidate", { projectId: "prj_1", shotId: "sh_1", slotId: "slot_x", jobId: null })) as Record<string, unknown>;
        const body = lastRequest().body as Record<string, unknown>;
        assert.ok("jobId" in body, "body 必须显式带 jobId 键");
        assert.equal(body.jobId, null, "撤销采用必须传 null");
        assert.equal(result.cleared, true);
    });

    it("业务错误 4xx 转成可读 Error，不静默", async () => {
        respond = (_req, res) => res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "片段未全部完成" } }));
        await assert.rejects(() => callProjectTool("project_run_stage", { runId: "run_1", stage: "assembly" }), /片段未全部完成/);
    });

    it("project_export_package 只在显式为 true 时传 allowPartial", async () => {
        respond = (_req, res) => res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ inflight: true }));
        await callProjectTool("project_export_package", { runId: "run_1", episodeId: "ep_0001" });
        assert.deepEqual(lastRequest().body, { episodeId: "ep_0001" });
        await callProjectTool("project_export_package", { runId: "run_1", allowPartial: true, steps: ["plan", "package"] });
        assert.deepEqual(lastRequest().body, { allowPartial: true, steps: ["plan", "package"] });
    });

    it("project_list_runs 裁掉 novel 并按 projectId 过滤", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    runs: [
                        { id: "run_1", title: "喜宴之外", novel: "整本小说".repeat(1000), options: { projectId: "prj_1" }, stages: { script: { status: "done" }, storyboard: { status: "error", error: "模型超时" } } },
                        { id: "run_2", title: "别的项目", options: { projectId: "prj_2" }, stages: {} },
                    ],
                }),
            );
        const result = (await callProjectTool("project_list_runs", { projectId: "prj_1" })) as { total: number; runs: Array<Record<string, unknown>> };
        assert.equal(lastRequest().url, "/api/pipeline/runs");
        assert.equal(result.total, 1, "应按 projectId 过滤");
        const run = result.runs[0];
        assert.equal(run.id, "run_1");
        assert.equal("novel" in run, false, "绝不该把整本小说回给 Agent");
        const stages = run.stages as Record<string, Record<string, unknown>>;
        assert.equal(stages.script.status, "done");
        assert.equal(stages.storyboard.error, "模型超时");
    });

    it("project_run_status 走轻量 progress 端点", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ inflight: true, progress: { stage: "keyframe", done: 3, total: 10 } }));
        const result = (await callProjectTool("project_run_status", { runId: "run_1" })) as Record<string, unknown>;
        assert.equal(lastRequest().url, "/api/pipeline/runs/run_1/progress");
        assert.equal(result.inflight, true);
        assert.equal((result.progress as Record<string, unknown>).done, 3);
    });

    it("project_run_qc 透传质检报告", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ report: { needsReview: true, seams: [] } }));
        const result = (await callProjectTool("project_run_qc", { runId: "run_1" })) as Record<string, unknown>;
        assert.ok(lastRequest().url.endsWith("/qc"), lastRequest().url);
        assert.equal((result.report as Record<string, unknown>).needsReview, true);
    });

    it("project_asset_pack 把 AssetRef 归成三态，并裁掉 artifactIds 全量与 metadata 全文", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    assetRefs: [
                        { id: "as_1", role: "character", bindingId: "c1", artifactIds: ["/api/a1", "/api/a2"], selectedArtifactId: "/api/a2", metadata: { name: "阿海", stageId: "casting", sourceJobId: "run-x", prompt: "很长".repeat(200) } },
                        { id: "as_2", role: "character", bindingId: "c2", artifactIds: ["/api/b1"], selectedArtifactId: null, metadata: { name: "小满" } },
                        { id: "as_3", role: "character", bindingId: "c3", artifactIds: [], selectedArtifactId: null, metadata: {} },
                    ],
                }),
            );
        const result = (await callProjectTool("project_asset_pack", { projectId: "prj_1" })) as { packs: Array<Record<string, unknown>> };
        assert.equal(lastRequest().url, "/api/projects/prj_1/asset-refs");
        assert.equal(result.packs.length, 3);
        assert.equal(result.packs[0].status, "adopted");
        assert.equal(result.packs[0].candidateCount, 2);
        assert.equal(result.packs[0].stageId, "casting", "归因必须带回来，否则查不清这张图哪来的");
        assert.equal(result.packs[0].sourceJobId, "run-x");
        assert.equal(result.packs[1].status, "candidates");
        assert.equal(result.packs[2].status, "missing");
        // 三态语义与前端 asset-ref-model 一致：selected 才算 adopted。
        assert.equal("artifactIds" in result.packs[0], false, "不该把候选全量塞进上下文");
        assert.equal("metadata" in result.packs[0], false, "不该把 metadata 全文塞进上下文");
    });

    it("project_asset_pack 带 runId 时走 casting/pack 盘点：回当前脸+来源+候选，且带换脸提示", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    characters: [
                        { characterId: "c1", name: "阿海", currentCloseupArtifactId: "/api/p1.png", source: "pack", confirmed: false, hasPackRef: true, packSelectedArtifactId: "/api/p1.png", candidates: ["/api/p1.png", "/api/p2.png"] },
                        { characterId: "c2", name: "小满", currentCloseupArtifactId: "/api/d1.png", source: "design", confirmed: true, hasPackRef: false, packSelectedArtifactId: null, candidates: [] },
                    ],
                }),
            );
        const result = (await callProjectTool("project_asset_pack", { runId: "run_1" })) as { castingFaces: Array<Record<string, unknown>>; hint: string };
        assert.ok(lastRequest().url.endsWith("/steps/casting/pack"), lastRequest().url);
        assert.equal(result.castingFaces.length, 2);
        assert.equal(result.castingFaces[0].source, "pack");
        assert.deepEqual(result.castingFaces[0].candidates, ["/api/p1.png", "/api/p2.png"]);
        assert.equal(result.castingFaces[1].source, "design");
        assert.deepEqual(result.castingFaces[1].candidates, [], "资料包没候选就必须回空数组，不能拿 design 的图冒充");
        assert.match(result.hint, /closeupArtifactId/);
    });

    it("project_asset_pack 既没 projectId 也没 runId 时报错（不静默打错接口）", async () => {
        await assert.rejects(() => callProjectTool("project_asset_pack", {}), /projectId/);
    });

    it("project_confirm_casting 支持 closeupArtifactId 换脸，并原样透传给网关", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run: { id: "run_1" } }));
        await callProjectTool("project_confirm_casting", { runId: "run_1", characterId: "c1", face: true, closeupArtifactId: "/api/p2.png" });
        assert.ok(lastRequest().url.endsWith("/steps/casting/confirm"), lastRequest().url);
        const body = lastRequest().body as Record<string, unknown>;
        assert.equal(body.closeupArtifactId, "/api/p2.png", "换脸必须真的发到后端，否则选了等于没选");
        assert.equal(body.face, true);
        assert.equal(body.characterId, "c1");
    });

    it("project_asset_pack 带 role 时走查询参数过滤", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ assetRefs: [] }));
        await callProjectTool("project_asset_pack", { projectId: "prj_1", role: "scene" });
        assert.equal(lastRequest().url, "/api/projects/prj_1/asset-refs?role=scene");
    });

    it("project_attach_asset 打 POST /asset-refs/attach 并回传幂等结果", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({ assetRef: { id: "as_1", role: "character", bindingId: "c1", artifactIds: ["/api/a1", "/api/a2"], selectedArtifactId: "/api/a1" }, created: false, addedArtifactIds: 1 }),
            );
        const result = (await callProjectTool("project_attach_asset", { projectId: "prj_1", role: "character", bindingId: "c1", artifactId: "/api/a2", sourceJobId: "run-x", stageId: "casting" })) as Record<string, unknown>;
        assert.equal(lastRequest().method, "POST");
        assert.equal(lastRequest().url, "/api/projects/prj_1/asset-refs/attach");
        assert.deepEqual(lastRequest().body, { role: "character", bindingId: "c1", artifactId: "/api/a2", sourceJobId: "run-x", stageId: "casting" });
        // created=false 必须原样带回：Agent 要靠它区分「新建条目」与「追加候选」。
        assert.equal(result.created, false);
        assert.equal(result.addedArtifactIds, 1);
        assert.equal(result.candidateCount, 2);
        assert.equal(result.refId, "as_1");
    });

    it("project_attach_asset 缺 artifactId 时本地就报错，不去打网关", async () => {
        const before = recorded.length;
        await assert.rejects(() => callProjectTool("project_attach_asset", { projectId: "prj_1", role: "character", bindingId: "c1" }), /缺少 artifactId/);
        assert.equal(recorded.length, before, "入参校验不过就不该产生 HTTP 请求");
    });

    it("project_attach_asset 的 select:false 原样透传（只进候选池）", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ assetRef: { id: "as_1", artifactIds: ["/api/a1"], selectedArtifactId: null }, created: true, addedArtifactIds: 1 }));
        await callProjectTool("project_attach_asset", { projectId: "prj_1", role: "prop", bindingId: "p1", artifactId: "/api/a1", select: false });
        assert.equal((lastRequest().body as Record<string, unknown>).select, false);
    });

    it("project_stage_items 从整个 run 里只抽出镜头清单（不带 novel）", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    run: {
                        id: "run_1",
                        novel: "整本小说".repeat(1000),
                        stages: {
                            storyboard: {
                                status: "done",
                                output: { shots: [{ id: "sh_1", index: 1, shotSize: "特写", action: "新娘转身", dialogue: "我不嫁了", durationSec: 4 }] },
                            },
                        },
                    },
                }),
            );
        const result = (await callProjectTool("project_stage_items", { runId: "run_1", stage: "storyboard" })) as { status: string; items: Array<Record<string, unknown>> };
        assert.equal(lastRequest().url, "/api/pipeline/runs/run_1");
        assert.equal(result.status, "done");
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].shotId, "sh_1");
        assert.equal(result.items[0].dialogue, "我不嫁了");
        assert.equal("novel" in result, false, "产物清单不该夹带小说");
    });

    it("project_stage_items 读 casting 时归一化脸/声确认态", async () => {
        respond = (_req, res) =>
            res.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({
                    run: {
                        id: "run_1",
                        stages: {
                            casting: { status: "done", output: { characters: [{ characterId: "ch_1", name: "林晚", face: { confirmed: true }, voice: { speaker: "zh_female_1", confirmed: false } }] } },
                        },
                    },
                }),
            );
        const result = (await callProjectTool("project_stage_items", { runId: "run_1", stage: "casting" })) as { items: Array<Record<string, unknown>> };
        assert.equal(result.items[0].characterId, "ch_1");
        assert.equal(result.items[0].faceConfirmed, true);
        assert.equal(result.items[0].voiceConfirmed, false);
    });

    it("project_retry_failed 走 POST retry-failed", async () => {
        respond = (_req, res) => res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({}));
        const result = (await callProjectTool("project_retry_failed", { runId: "run_1", stage: "keyframe" })) as Record<string, unknown>;
        const req = lastRequest();
        assert.equal(req.method, "POST");
        assert.ok(req.url.endsWith("/steps/keyframe/retry-failed"), req.url);
        assert.equal(result.retried, true);
    });

    it("project_update_stage_input 透传 patch，空 patch 本地拒绝", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({}));
        await callProjectTool("project_update_stage_input", { runId: "run_1", stage: "keyframe", patch: { model: "flux" } });
        const req = lastRequest();
        assert.equal(req.method, "POST");
        assert.ok(req.url.endsWith("/steps/keyframe/input"), req.url);
        assert.deepEqual(req.body, { model: "flux" });
        await assert.rejects(() => callProjectTool("project_update_stage_input", { runId: "run_1", stage: "keyframe", patch: {} }), /patch 不能为空/);
    });

    it("project_regenerate_item 只在非空时传 promptOverride", async () => {
        respond = (_req, res) => res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ run: {} }));
        await callProjectTool("project_regenerate_item", { runId: "run_1", stage: "keyframe", itemId: "fr_1", promptOverride: "换成夜景" });
        assert.deepEqual(lastRequest().body, { itemId: "fr_1", promptOverride: "换成夜景" });
        await callProjectTool("project_regenerate_item", { runId: "run_1", stage: "keyframe", itemId: "fr_1", promptOverride: "  " });
        assert.deepEqual(lastRequest().body, { itemId: "fr_1" }, "空白改词不该发给后端（会 400）");
    });

    it("project_patch_shot 默认 storyboard 阶段，走 PATCH", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ shot: { id: "sh_1" } }));
        await callProjectTool("project_patch_shot", { runId: "run_1", shotId: "sh_1", patch: { dialogue: "我嫁" } });
        const req = lastRequest();
        assert.equal(req.method, "PATCH");
        assert.equal(req.url, "/api/pipeline/runs/run_1/steps/storyboard/shots/sh_1");
        assert.deepEqual(req.body, { dialogue: "我嫁" });
    });

    it("project_patch_shot 回传 downstreamStale：改了被下游消费的字段必须报出要重跑哪些阶段", async () => {
        respond = (_req, res) =>
            res
                .writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify({ shot: { id: "sh_1", prompt: "new" }, changedFields: ["prompt"], downstreamStale: ["keyframe"] }));
        const result = (await callProjectTool("project_patch_shot", { runId: "run_1", shotId: "sh_1", patch: { prompt: "new" } })) as Record<string, unknown>;
        assert.deepEqual(result.downstreamStale, ["keyframe"]);
        assert.deepEqual(result.changedFields, ["prompt"]);
        assert.match(String(result.hint), /stale/, "必须提示需要重跑，否则 Agent 会误以为改完就好了");
    });

    it("project_patch_shot 无下游失效时只回空数组，不给假提示", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ shot: { id: "sh_1" }, changedFields: [], downstreamStale: [] }));
        const result = (await callProjectTool("project_patch_shot", { runId: "run_1", shotId: "sh_1", patch: { dialogue: "x" } })) as Record<string, unknown>;
        assert.deepEqual(result.downstreamStale, []);
        assert.equal(result.hint, undefined, "没 stale 就不该报 stale 提示");
    });

    it("project_shots_to_canvas 取分镜镜头并明说画布要靠前端写入（Agent 不得声称已发到画布）", async () => {
        respond = (_req, res) =>
            res
                .writeHead(200, { "Content-Type": "application/json" })
                .end(
                    // 真实响应形状：单个 run 走 GET /runs/:id，包一层 { run: … }（与 index.js 路由一致）。
                    JSON.stringify({
                        run: {
                            stages: {
                                storyboard: {
                                    output: {
                                        shots: [
                                            { id: "sh_1", index: 1, episodeId: "ep_0001", sceneId: "sc_0001", shotSize: "中景", durationSec: 4, action: "上车", dialogue: "", prompt: "a" },
                                            { id: "sh_2", index: 2, episodeId: "ep_0001", sceneId: "sc_0001", shotSize: "近景", durationSec: 5, action: "回头", dialogue: "你等谁", prompt: "b" },
                                        ],
                                    },
                                },
                            },
                        },
                    }),
                );
        const result = (await callProjectTool("project_shots_to_canvas", { runId: "run_1", projectId: "prj_1", shotIds: ["sh_2"] })) as Record<string, unknown>;
        assert.equal(lastRequest().url, "/api/pipeline/runs/run_1");
        assert.equal(result.ready, true);
        assert.deepEqual((result.shots as Array<{ id: string }>).map((shot) => shot.id), ["sh_2"], "只取点名的镜头");
        assert.match(String(result.nextStep), /无法直接写/, "必须说明画布要靠网页侧写入");
    });

    it("project_shots_to_canvas 分镜没产物时据实报错，不返回空成功", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run: { stages: { storyboard: { output: null } } } }));
        await assert.rejects(() => callProjectTool("project_shots_to_canvas", { runId: "run_1", projectId: "prj_1", shotIds: ["sh_1"] }), /还没有镜头产物/);
    });

    it("project_confirm_casting 必须至少确认 face 或 voice", async () => {
        respond = (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({}));
        await callProjectTool("project_confirm_casting", { runId: "run_1", characterId: "ch_1", face: true, speaker: "zh_female_1" });
        const req = lastRequest();
        assert.ok(req.url.endsWith("/steps/casting/confirm"), req.url);
        assert.deepEqual(req.body, { characterId: "ch_1", face: true, speaker: "zh_female_1" });
        await assert.rejects(() => callProjectTool("project_confirm_casting", { runId: "run_1", characterId: "ch_1" }), /至少确认一个/);
    });

    it("project_assemble 走 assembly/assemble 并提示后续动作", async () => {
        respond = (_req, res) => res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ inflight: true }));
        const result = (await callProjectTool("project_assemble", { runId: "run_1" })) as Record<string, unknown>;
        assert.ok(lastRequest().url.endsWith("/steps/assembly/assemble"), lastRequest().url);
        assert.equal(result.inflight, true);
        assert.ok(String(result.hint).includes("project_export_package"));
    });

    it("网关连不上时显式报错（Agent 能区分「工具不可用」）", async () => {
        const saved = process.env.CANVAS_GATEWAY_URL;
        process.env.CANVAS_GATEWAY_URL = "http://127.0.0.1:1"; // 必然连不上
        await assert.rejects(() => callProjectTool("project_context", { projectId: "prj_1" }), /连不上本地网关/);
        process.env.CANVAS_GATEWAY_URL = saved;
    });
});

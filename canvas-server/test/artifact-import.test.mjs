import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * M2 产物导入 HTTP 真链路（隔离实例，ComfyUI 指向不可达地址，绝不真跑生成）：
 *   · POST /api/artifacts/import：合成 status="done"、kind="import" 的 Job，
 *     字节落 data/artifacts/<jobId>/<filename>，artifact.url 可取；
 *   · 幂等：同 idempotencyKey 重复提交返回同一 job + 同一 artifact；
 *   · fields 带 projectId+shotId+slotId → 终态自动投影为槽位候选（selected 不动）；
 *   · 悬空 projectId → 409 PROJECT_NOT_FOUND；
 *   · 候选端点：追加幂等（同 jobId 不重复）、select 候选不存在 404、PROJECT_MISMATCH 409。
 */

const root = mkdtempSync(join(tmpdir(), "canvas-import-"));
const dataDir = join(root, "data");
const skillsDir = join(root, "skills");
mkdirSync(dataDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
writeFileSync(join(skillsDir, "registry.json"), JSON.stringify({ version: 1, stages: [] }));

process.env.CANVAS_SERVER_DATA_DIR = dataDir;
process.env.CANVAS_SERVER_SKILLS_DIR = skillsDir;
process.env.CANVAS_SERVER_COMFY_URL = "http://127.0.0.1:9";
process.env.CANVAS_SERVER_WEB_DIR = join(root, "webdist");
delete process.env.CANVAS_SERVER_PORT;
delete process.env.CANVAS_SERVER_HOST;

const mod = await import("../src/index.js");
await new Promise((resolve) => mod.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mod.server.address().port}`;

after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    for (const key of ["CANVAS_SERVER_DATA_DIR", "CANVAS_SERVER_SKILLS_DIR", "CANVAS_SERVER_COMFY_URL", "CANVAS_SERVER_WEB_DIR"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
});

const post = (url, payload) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

/** multipart 导入：1x1 PNG 字节 + fields。 */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex");
function importFile(fields = {}, filename = "frame.png") {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), filename);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return fetch(`${base}/api/artifacts/import`, { method: "POST", body: form });
}

/** 建项目 + 一集一场一镜，返回 { projectId, episodeId, shotId, slotId }。 */
async function seedProjectShot(title) {
    const project = (await (await post("/api/projects", { title })).json()).project;
    const episode = (await (await post(`/api/projects/${project.id}/episodes`, { title: "第一集" })).json()).episode;
    const scene = (await (await post(`/api/projects/${project.id}/episodes/${episode.id}/scenes`, { locationId: "内景", time: "夜", intent: "相遇" })).json()).scene;
    const shot = (await (await post(`/api/projects/${project.id}/scenes/${scene.id}/shots`, { index: 1 })).json()).shot;
    return { projectId: project.id, episodeId: episode.id, shotId: shot.id, slotId: `slot_${shot.id}_key` };
}

const getSlot = async ({ projectId, episodeId, shotId, slotId }) => {
    const episode = (await (await fetch(`${base}/api/projects/${projectId}/episodes/${episodeId}`)).json()).episode;
    const shot = (episode.shots || []).find((row) => row.id === shotId);
    return (shot?.generationSlots || []).find((row) => row.id === slotId) || null;
};

test("import：合成 done/import Job，字节落盘，artifact 形状与 URL 正确", async () => {
    const res = await importFile({ source: "canvas" });
    assert.equal(res.status, 200);
    const { job, artifact } = await res.json();
    assert.equal(job.status, "done");
    assert.equal(job.kind, "import");
    assert.equal(job.meta.source, "canvas");
    assert.match(artifact.id, /^import-[^/]+\/frame\.png$/);
    assert.equal(artifact.url, `/api/artifacts/${job.id}/frame.png`);
    assert.equal(artifact.bytes, PNG.length);
    assert.equal(artifact.kind, "image");
    assert.ok(existsSync(join(dataDir, "artifacts", job.id, "frame.png")), "字节落 data/artifacts/<jobId>/<filename>");

    // artifact URL 真可取（与生成产物同一条静态链路）。
    const fetched = await fetch(`${base}${artifact.url}`);
    assert.equal(fetched.status, 200);
    assert.equal(Number(fetched.headers.get("content-length")), PNG.length);

    // 懒索引拾取：GET /api/artifacts 能列到这条导入产物。
    const listed = (await (await fetch(`${base}/api/artifacts?limit=500`)).json()).items;
    assert.ok(listed.some((item) => item.id === artifact.id), "导入产物进 artifacts 懒索引");
});

test("import 幂等：同 idempotencyKey 返回同一 job + 同一 artifact，不重复落盘", async () => {
    const fields = { source: "canvas", idempotencyKey: "m2-import-key-1" };
    const first = await (await importFile(fields)).json();
    const second = await (await importFile(fields)).json();
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.artifact.id, first.artifact.id);
    const jobs = (await (await fetch(`${base}/api/jobs?kind=import`)).json()).jobs;
    assert.equal(jobs.filter((job) => job.meta?.idempotencyKey === "m2-import-key-1").length, 1, "同 key 不新增 Job");
});

test("import：fields 带归属 → 终态自动投影为槽位候选；select 后再次投影 selected 不动", async () => {
    const ctx = await seedProjectShot("M2 自动投影");

    // 存量画布图片导入：fields 带 projectId/shotId/slotId → 自动投影追加候选（不经候选端点）。
    const first = await (await importFile({ source: "canvas", ...ctx })).json();
    let slot = await getSlot(ctx);
    assert.ok(slot, "槽位壳按规则自动创建");
    assert.deepEqual(slot.candidates.map((candidate) => candidate.jobId), [first.job.id]);
    assert.equal(slot.candidates[0].source, "canvas");
    assert.equal(slot.candidates[0].status, "done");
    assert.equal(slot.selected, null, "自动投影绝不采用");

    // 显式采用第一条。
    const select = await post(`/api/projects/${ctx.projectId}/shots/${ctx.shotId}/slots/${ctx.slotId}/select`, { jobId: first.job.id });
    assert.equal(select.status, 200);
    assert.equal((await select.json()).slot.selected, first.job.id);

    // 第二条导入自动投影：只追加候选，selected 不动。
    const second = await (await importFile({ source: "canvas", ...ctx })).json();
    slot = await getSlot(ctx);
    assert.equal(slot.candidates.length, 2);
    assert.equal(slot.selected, first.job.id, "自动投影不覆盖已有 selected");
    assert.ok(second.job.id !== first.job.id);
});

test("import：悬空 projectId → 409 PROJECT_NOT_FOUND，不产生 Job", async () => {
    const before = (await (await fetch(`${base}/api/jobs?kind=import`)).json()).jobs.length;
    const res = await importFile({ projectId: "prj_nope", shotId: "sh_x", slotId: "slot_sh_x_key" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "PROJECT_NOT_FOUND");
    const after = (await (await fetch(`${base}/api/jobs?kind=import`)).json()).jobs.length;
    assert.equal(after, before);
});

test("候选端点：追加幂等；404 JOB_NOT_FOUND / CANDIDATE_NOT_FOUND；409 PROJECT_MISMATCH", async () => {
    const ctx = await seedProjectShot("M2 候选端点");
    const candidatesUrl = `/api/projects/${ctx.projectId}/shots/${ctx.shotId}/slots/${ctx.slotId}/candidates`;
    const selectUrl = `/api/projects/${ctx.projectId}/shots/${ctx.shotId}/slots/${ctx.slotId}/select`;

    // 不带归属的导入产物：可追加到任意项目槽位。
    const imported = await (await importFile({ source: "canvas" })).json();
    const first = await post(candidatesUrl, { jobId: imported.job.id });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).slot.candidates.length, 1);
    const dup = await post(candidatesUrl, { jobId: imported.job.id });
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).slot.candidates.length, 1, "同 jobId 重复 POST 不产生重复候选");

    // JOB_NOT_FOUND。
    const missing = await post(candidatesUrl, { jobId: "import-nope" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "JOB_NOT_FOUND");

    // CANDIDATE_NOT_FOUND：job 存在但不是该槽位候选。
    const other = await (await importFile({ source: "canvas" })).json();
    const notCandidate = await post(selectUrl, { jobId: other.job.id });
    assert.equal(notCandidate.status, 404);
    assert.equal((await notCandidate.json()).error.code, "CANDIDATE_NOT_FOUND");

    // PROJECT_MISMATCH：job.meta.projectId 归属别的项目。
    const foreign = await (await importFile({ source: "canvas", projectId: ctx.projectId })).json();
    const otherCtx = await seedProjectShot("M2 候选端点-另一项目");
    const mismatch = await post(`/api/projects/${otherCtx.projectId}/shots/${otherCtx.shotId}/slots/${otherCtx.slotId}/candidates`, { jobId: foreign.job.id });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).error.code, "PROJECT_MISMATCH");
});

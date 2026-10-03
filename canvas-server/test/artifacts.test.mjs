import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { canonicalArtifactId, createArtifacts } from "../src/artifacts.js";

/**
 * 产物归档 / 彻底删除内核单测（纯模块，注入假的 jobs / runs / assetRefs）。
 * 覆盖：索引懒构建、归档/恢复、confirm 校验、被引用拒删（流水线候选 + 项目 AssetRef）、真删=删文件+标 deleted+写审计。
 */

const root = mkdtempSync(join(tmpdir(), "canvas-artifacts-"));
after(() => rmSync(root, { recursive: true, force: true }));

function seedFile(dataDir, jobId, filename) {
    const dir = join(dataDir, "artifacts", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), "x");
    return join(dir, filename);
}

/** 一份可控的 jobs / runs / assetRefs，覆盖「工作台产物」与「流水线关键帧产物」。 */
function makeFixture() {
    const dataDir = join(root, `data-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dataDir, { recursive: true });
    const jobs = [
        {
            id: "img-work-1",
            kind: "image",
            template: "img_zimage_artistic",
            status: "done",
            meta: {},
            outputs: [{ filename: "work.png", url: "/api/artifacts/img-work-1/work.png", type: "image", bytes: 111 }],
            createdAt: "2026-01-02T00:00:00.000Z",
            finishedAt: "2026-01-02T00:01:00.000Z",
        },
        {
            id: "img-pipe-1",
            kind: "image",
            template: "img_zimage_artistic",
            status: "done",
            meta: { runId: "run-1", stageId: "keyframe", itemId: "sh_0001" },
            outputs: [{ filename: "frame.png", url: "/api/artifacts/img-pipe-1/frame.png", type: "image", bytes: 222 }],
            createdAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:01:00.000Z",
        },
    ];
    const runs = [
        {
            id: "run-1",
            title: "测试 run",
            options: { projectId: "prj_A" },
            stages: {
                keyframe: {
                    output: {
                        frames: [
                            {
                                id: "sh_0001",
                                shotId: "sh_0001",
                                role: "keyframe",
                                candidates: [{ jobId: "img-pipe-1", artifactUrl: "/api/artifacts/img-pipe-1/frame.png" }],
                            },
                        ],
                    },
                },
            },
        },
    ];
    const assetRefs = [
        { id: "as_1", projectId: "prj_B", projectName: "项目B", role: "character", bindingId: "c1", artifactIds: ["/api/artifacts/img-work-1/work.png"], selectedArtifactId: null, metadata: {} },
    ];
    seedFile(dataDir, "img-work-1", "work.png");
    seedFile(dataDir, "img-pipe-1", "frame.png");
    const artifacts = createArtifacts({
        dataDir,
        listJobs: () => jobs,
        listRuns: () => runs,
        listAssetRefs: () => assetRefs,
        resolveProjectName: (id) => (id === "prj_A" ? "项目A" : null),
    });
    return { dataDir, artifacts };
}

test("canonicalArtifactId：id / 相对 URL / 绝对 URL 都归一到 <jobId>/<filename>", () => {
    assert.equal(canonicalArtifactId("img-1/a.png"), "img-1/a.png");
    assert.equal(canonicalArtifactId("/api/artifacts/img-1/a.png"), "img-1/a.png");
    assert.equal(canonicalArtifactId("http://127.0.0.1:8788/api/artifacts/img-1/a%20b.png?download=1"), "img-1/a b.png");
    assert.equal(canonicalArtifactId("nonsense"), "");
    assert.equal(canonicalArtifactId(""), "");
});

test("索引懒构建：从 jobs.outputs[] 补录，来源区分工作台/流水线并写入索引文件", () => {
    const { dataDir, artifacts } = makeFixture();
    const result = artifacts.list({ state: "all" });
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.counts, { active: 2, archived: 0 });

    const work = result.items.find((item) => item.jobId === "img-work-1");
    assert.equal(work.source.origin, "workbench");
    assert.equal(work.state, "active");
    assert.equal(work.kind, "image");
    assert.equal(work.bytes, 111);
    // 被项目 AssetRef 引用 → 有引用方
    assert.deepEqual(work.refs, [{ projectId: "prj_B", projectName: "项目B", shotId: null, role: "character" }]);

    const pipe = result.items.find((item) => item.jobId === "img-pipe-1");
    assert.equal(pipe.source.origin, "pipeline");
    assert.equal(pipe.source.runId, "run-1");
    assert.equal(pipe.source.projectId, "prj_A");
    // 关键帧候选引用 → 引用方含项目名与镜头
    assert.deepEqual(pipe.refs, [{ projectId: "prj_A", projectName: "项目A", shotId: "sh_0001", role: "keyframe" }]);

    // 索引落盘且可读
    const onDisk = JSON.parse(readFileSync(join(dataDir, "artifacts-index.json"), "utf8"));
    assert.equal(onDisk.items.length, 2);
});

test("默认只列 active；归档后 state=archived 可见、state=active 不可见、counts 变化", () => {
    const { artifacts } = makeFixture();
    const archived = artifacts.archive({ ids: ["img-work-1/work.png"] });
    assert.deepEqual(archived.archived, ["img-work-1/work.png"]);
    assert.deepEqual(archived.missing, []);

    assert.deepEqual(artifacts.list({ state: "active" }).items.map((i) => i.id), ["img-pipe-1/frame.png"]);
    assert.deepEqual(artifacts.list({ state: "archived" }).items.map((i) => i.id), ["img-work-1/work.png"]);
    assert.deepEqual(artifacts.list().counts, { active: 1, archived: 1 });
    assert.equal(artifacts.list({ state: "all" }).items.length, 2);
});

test("恢复归档：archived → active", () => {
    const { artifacts } = makeFixture();
    artifacts.archive({ ids: ["img-work-1/work.png"] });
    const restored = artifacts.restore({ ids: ["/api/artifacts/img-work-1/work.png"] });
    assert.deepEqual(restored.restored, ["img-work-1/work.png"]);
    assert.equal(artifacts.list({ state: "archived" }).items.length, 0);
    assert.equal(artifacts.list({ state: "active" }).items.length, 2);
});

test("彻底删除：缺 confirm → 400；带 confirm 真删=删文件 + 标 deleted + 写审计", () => {
    const clean = join(root, `clean-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(clean, { recursive: true });
    seedFile(clean, "img-solo", "solo.png");
    const solo = createArtifacts({
        dataDir: clean,
        listJobs: () => [
            { id: "img-solo", kind: "image", template: "t", status: "done", meta: {}, outputs: [{ filename: "solo.png", url: "/api/artifacts/img-solo/solo.png", type: "image", bytes: 5 }], createdAt: "2026-01-03T00:00:00.000Z" },
        ],
        listRuns: () => [],
        listAssetRefs: () => [],
    });

    assert.throws(() => solo.remove({ ids: ["img-solo/solo.png"] }), (error) => error.status === 400);

    const out = solo.remove({ ids: ["img-solo/solo.png"], confirm: true, actor: "tester" });
    assert.deepEqual(out.deleted, ["img-solo/solo.png"]);
    assert.deepEqual(out.blocked, []);
    assert.equal(existsSync(join(clean, "artifacts", "img-solo", "solo.png")), false);
    assert.equal(solo.list({ state: "all" }).items.length, 0);

    const index = JSON.parse(readFileSync(join(clean, "artifacts-index.json"), "utf8"));
    assert.equal(index.items[0].state, "deleted");
    assert.equal(index.deletions.length, 1);
    assert.equal(index.deletions[0].actor, "tester");
    assert.equal(index.deletions[0].items[0].id, "img-solo/solo.png");
});

test("被引用拒删：项目 AssetRef 引用 → blocked 且回引用方；未引用的同一批照删（partial success）", () => {
    const { artifacts } = makeFixture();
    const out = artifacts.remove({ ids: ["img-work-1/work.png", "img-pipe-1/frame.png"], confirm: true });
    assert.deepEqual(out.deleted, []);
    assert.equal(out.blocked.length, 2);
    const work = out.blocked.find((item) => item.id === "img-work-1/work.png");
    assert.deepEqual(work.refs, [{ projectId: "prj_B", projectName: "项目B", shotId: null, role: "character" }]);
    const pipe = out.blocked.find((item) => item.id === "img-pipe-1/frame.png");
    assert.deepEqual(pipe.refs, [{ projectId: "prj_A", projectName: "项目A", shotId: "sh_0001", role: "keyframe" }]);
});

test("查询筛选：kind / origin / projectId 生效；limit 截断并给 nextCursor", () => {
    const { artifacts } = makeFixture();
    assert.equal(artifacts.list({ state: "all", origin: "workbench" }).items.length, 1);
    assert.equal(artifacts.list({ state: "all", origin: "pipeline" }).items.length, 1);
    assert.equal(artifacts.list({ state: "all", projectId: "prj_A" }).items.length, 1);
    assert.equal(artifacts.list({ state: "all", kind: "video" }).items.length, 0);

    const page1 = artifacts.list({ state: "all", limit: 1 });
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = artifacts.list({ state: "all", limit: 1, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0].id, page1.items[0].id);
});

test("归档状态以索引为准：重建（重新读索引）不丢归档", () => {
    const { dataDir, artifacts } = makeFixture();
    artifacts.archive({ ids: ["img-work-1/work.png"] });
    // 新实例读同一个索引目录：归档状态应保留
    const again = createArtifacts({ dataDir, listJobs: () => [], listRuns: () => [], listAssetRefs: () => [] });
    assert.equal(again.list({ state: "archived" }).items.length, 1);
});

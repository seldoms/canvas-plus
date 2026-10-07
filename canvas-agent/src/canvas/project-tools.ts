import type { ToolName } from "./schemas.js";

/**
 * project_* 工具的服务端实现（M5）：**走网关 HTTP，不依赖网页画布连接**。
 *
 * 与 canvas_* 的分工：
 *   - `canvas_*`：操作「浏览器里打开的那块画布」，走 WebSocket 到前端页面；
 *   - `project_*`：操作「服务端的项目与流水线」，走 HTTP 到 canvas-server。
 * 因此 Agent 在**没有前端页面打开**时也能读项目、跑阶段、看任务、采用候选、取交付包。
 *
 * 网关地址取 `CANVAS_GATEWAY_URL`（默认 `http://127.0.0.1:8788`，与网关默认端口一致）。
 * 未配置时**显式报错**而不是静默失败——Agent 需要知道「工具不可用」和「调用成功但无结果」的区别。
 */

const DEFAULT_GATEWAY = "http://127.0.0.1:8788";

export function gatewayBaseUrl() {
    const raw = String(process.env.CANVAS_GATEWAY_URL || "").trim();
    return (raw || DEFAULT_GATEWAY).replace(/\/+$/, "");
}

type Json = Record<string, unknown>;

async function gateway(path: string, init?: { method?: string; body?: unknown }) {
    const url = `${gatewayBaseUrl()}${path}`;
    const method = init?.method ?? "GET";
    let response: Response;
    try {
        response = await fetch(url, {
            method,
            headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
            body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
    } catch (error) {
        throw new Error(`连不上本地网关（${url}）：${error instanceof Error ? error.message : String(error)}。确认网关已启动，或设置 CANVAS_GATEWAY_URL。`);
    }
    const payload = (await response.json().catch(() => null)) as Json | null;
    if (!response.ok) {
        const message = typeof payload?.message === "string" ? payload.message
            : typeof (payload?.error as Json | undefined)?.message === "string" ? String((payload?.error as Json).message)
            : `HTTP ${response.status}`;
        throw new Error(message);
    }
    return payload ?? {};
}

/** 任务列表响应里可能包一层 { jobs: [...] }；统一成数组。 */
function jobsOf(payload: Json): unknown[] {
    const jobs = payload.jobs;
    return Array.isArray(jobs) ? jobs : [];
}

/** 裁剪长文本，避免撑爆 Agent 上下文。 */
function cut(value: unknown, max = 120): string | null {
    if (typeof value !== "string" || !value) return null;
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** run.stages 映射成 { stageId: status } 的速览。 */
function stageStatusMap(stages: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!stages || typeof stages !== "object") return out;
    for (const [id, stage] of Object.entries(stages as Json)) {
        const s = stage as Json;
        out[id] = { status: s?.status ?? null, error: cut(s?.error, 200) };
    }
    return out;
}

/** 数组字段安全取值。 */
function listOf(obj: Json | null, key: string): Json[] {
    const value = obj?.[key];
    return Array.isArray(value) ? (value as Json[]) : [];
}

/**
 * 从整个 run 里抽出某阶段的**条目清单**（精调定位用）。
 * run 内嵌整本小说（MB 级），这里只回 Agent 决策所需字段。
 */
function stageItemsSummary(run: Json, stage: string): Json {
    const stages = (run.stages ?? {}) as Json;
    const s = stages[stage] as Json | undefined;
    if (!s) return { stage, found: false, items: [], note: `run 里没有阶段 ${stage}` };
    const output = (s.output ?? null) as Json | null;
    const base: Json = { stage, status: s.status ?? null, error: cut(s.error, 300) };
    if (!output || typeof output !== "object") return { ...base, items: [], note: "阶段尚无产物" };
    switch (stage) {
        case "script":
            return {
                ...base,
                logline: cut(output.logline, 200),
                characters: listOf(output, "characters").map((c) => ({ id: c.id, name: c.name })),
                scenes: listOf(output, "scenes").map((sc) => ({ id: sc.id, title: sc.title ?? null })),
                episodes: listOf(output, "episodes").map((e) => ({ id: e.id, index: e.index ?? null, title: e.title ?? null, durationSec: e.durationSec ?? null })),
            };
        case "storyboard":
            return {
                ...base,
                items: listOf(output, "shots").map((shot) => ({
                    shotId: shot.id,
                    episodeId: shot.episodeId ?? null,
                    sceneId: shot.sceneId ?? null,
                    index: shot.index ?? null,
                    shotSize: shot.shotSize ?? null,
                    camera: shot.camera ?? null,
                    action: cut(shot.action),
                    dialogue: cut(shot.dialogue),
                    durationSec: shot.durationSec ?? null,
                })),
            };
        case "design":
            return {
                ...base,
                characters: listOf(output, "characters").map((c) => ({ id: c.id, name: c.name ?? null })),
                locations: listOf(output, "locations").map((l) => ({ id: l.id, name: l.name ?? null })),
                items: listOf(output, "references").map((r) => ({ itemId: r.id, role: r.role ?? null, kind: r.kind ?? null, name: r.name ?? null })),
            };
        case "casting":
            return {
                ...base,
                items: listOf(output, "characters").map((c) => {
                    const face = (c.face ?? {}) as Json;
                    const voice = (c.voice ?? {}) as Json;
                    return {
                        characterId: c.characterId,
                        name: c.name ?? null,
                        faceConfirmed: face.confirmed === true,
                        voiceConfirmed: voice.confirmed === true,
                        speaker: voice.speaker ?? null,
                        confirmed: c.confirmed === true,
                    };
                }),
            };
        case "keyframe":
            return {
                ...base,
                items: listOf(output, "frames").map((f) => ({
                    itemId: f.id,
                    shotId: f.shotId ?? null,
                    role: f.role ?? null,
                    status: f.status ?? null,
                    candidateCount: Array.isArray(f.candidates) ? f.candidates.length : 0,
                    selected: f.selected ?? null,
                    artifactUrl: f.artifactUrl ?? null,
                })),
            };
        case "audio":
            return {
                ...base,
                items: listOf(output, "audio").map((a) => ({
                    itemId: a.id,
                    shotId: a.shotId ?? null,
                    characterId: a.characterId ?? null,
                    type: a.type ?? null,
                    text: cut(a.text, 80),
                    speed: a.speed ?? null,
                    status: a.status ?? null,
                    durationSec: a.durationSec ?? null,
                    candidateCount: Array.isArray(a.candidates) ? a.candidates.length : 0,
                })),
            };
        case "assembly": {
            const assembly = (output.assembly ?? {}) as Json;
            return {
                ...base,
                items: listOf(output, "clips").map((c) => ({ itemId: c.id, shotId: c.shotId ?? null, status: c.status ?? null, durationSec: c.durationSec ?? null })),
                assembly: { transition: assembly.transition ?? null, status: assembly.status ?? null, url: assembly.url ?? null, orderCount: Array.isArray(assembly.order) ? assembly.order.length : 0 },
            };
        }
        default:
            return { ...base, note: "未特化的阶段，只回产物键名", outputKeys: Object.keys(output) };
    }
}

export async function callProjectTool(name: ToolName, input: Json) {
    switch (name) {
        case "project_context": {
            const projectId = String(input.projectId || "").trim();
            if (!projectId) throw new Error("缺少 projectId");
            const payload = await gateway(`/api/projects/${encodeURIComponent(projectId)}/context`);
            // context 很大，裁掉剧本正文等大字段，避免撑爆 Agent 上下文
            const project = (payload.project ?? payload) as Json;
            return {
                id: project.id,
                title: project.title,
                styleAnchor: project.styleAnchor ?? null,
                plan: project.plan ?? null,
                completion: project.completion ?? null,
                episodeCount: Array.isArray(project.episodes) ? project.episodes.length : 0,
                runIds: project.runIds ?? [],
                canvasIds: project.canvasIds ?? [],
                assetRefCount: Array.isArray(project.assetRefs) ? project.assetRefs.length : 0,
            };
        }
        case "project_gates": {
            const projectId = String(input.projectId || "").trim();
            if (!projectId) throw new Error("缺少 projectId");
            const payload = await gateway(`/api/projects/${encodeURIComponent(projectId)}/gates`);
            const gates = Array.isArray(payload.gates) ? payload.gates : [];
            return {
                gates: gates.map((gate) => {
                    const g = gate as Json;
                    return { stageId: g.stageId ?? g.id, status: g.status ?? null, blockedBy: g.blockedBy ?? [] };
                }),
            };
        }
        case "project_list_jobs": {
            const query = new URLSearchParams();
            if (input.status) query.set("status", String(input.status));
            if (input.kind) query.set("kind", String(input.kind));
            query.set("limit", String(Number(input.limit) || 20));
            const payload = await gateway(`/api/jobs?${query.toString()}`);
            return {
                jobs: jobsOf(payload).map((job) => {
                    const j = job as Json;
                    return {
                        id: j.id,
                        kind: j.kind ?? null,
                        status: j.status,
                        template: j.template ?? null,
                        error: j.error ?? null,
                        createdAt: j.createdAt ?? null,
                        outputs: Array.isArray(j.outputs) ? j.outputs.length : 0,
                    };
                }),
            };
        }
        case "project_list_runs": {
            const payload = await gateway("/api/pipeline/runs");
            const runs = Array.isArray(payload.runs) ? payload.runs : [];
            const projectId = input.projectId ? String(input.projectId) : "";
            const limit = Math.max(1, Number(input.limit) || 50);
            const trimmed = runs
                .map((r) => {
                    const run = r as Json;
                    const options = (run.options ?? {}) as Json;
                    return {
                        id: run.id,
                        title: run.title ?? null,
                        projectId: options.projectId ?? null,
                        createdAt: run.createdAt ?? null,
                        updatedAt: run.updatedAt ?? null,
                        stages: stageStatusMap(run.stages),
                    };
                })
                .filter((run) => !projectId || run.projectId === projectId);
            return { total: trimmed.length, runs: trimmed.slice(0, limit) };
        }
        case "project_run_status": {
            const runId = String(input.runId || "").trim();
            if (!runId) throw new Error("缺少 runId");
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/progress`);
            return { runId, inflight: payload.inflight === true, progress: payload.progress ?? null };
        }
        case "project_run_qc": {
            const runId = String(input.runId || "").trim();
            if (!runId) throw new Error("缺少 runId");
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/qc`);
            return { runId, report: payload.report ?? null };
        }
        case "project_stage_items": {
            const runId = String(input.runId || "").trim();
            const stage = String(input.stage || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!stage) throw new Error("缺少 stage");
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}`);
            const run = (payload.run ?? payload) as Json;
            return { runId, ...stageItemsSummary(run, stage) };
        }
        case "project_run_stage": {
            const runId = String(input.runId || "").trim();
            const stage = String(input.stage || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!stage) throw new Error("缺少 stage");
            const body = input.options && typeof input.options === "object" ? input.options : {};
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stage)}/run`, { method: "POST", body });
            return { runId, stage, inflight: payload.inflight === true };
        }
        case "project_cancel_stage": {
            const runId = String(input.runId || "").trim();
            const stage = String(input.stage || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!stage) throw new Error("缺少 stage");
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stage)}/cancel`, { method: "POST", body: {} });
            return { runId, stage, canceled: payload.canceled !== false };
        }
        case "project_retry_failed": {
            const runId = String(input.runId || "").trim();
            const stage = String(input.stage || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!stage) throw new Error("缺少 stage");
            await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stage)}/retry-failed`, { method: "POST", body: {} });
            return { runId, stage, retried: true };
        }
        case "project_update_stage_input": {
            const runId = String(input.runId || "").trim();
            const stage = String(input.stage || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!stage) throw new Error("缺少 stage");
            const patch = input.patch && typeof input.patch === "object" ? (input.patch as Json) : {};
            if (!Object.keys(patch).length) throw new Error("patch 不能为空");
            await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stage)}/input`, { method: "POST", body: patch });
            return { runId, stage, patched: Object.keys(patch), hint: "输入已更新；调 project_run_stage 重跑该阶段才生效" };
        }
        case "project_regenerate_item": {
            const runId = String(input.runId || "").trim();
            const stage = String(input.stage || "").trim();
            const itemId = String(input.itemId || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!stage) throw new Error("缺少 stage");
            if (!itemId) throw new Error("缺少 itemId（先用 project_stage_items 拿）");
            const body: Json = { itemId };
            if (input.template) body.template = String(input.template);
            if (input.params && typeof input.params === "object") body.params = input.params;
            if (typeof input.promptOverride === "string" && input.promptOverride.trim()) body.promptOverride = input.promptOverride;
            await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stage)}/regenerate`, { method: "POST", body });
            return { runId, stage, itemId, regenerating: true, hint: "202 已受理，新候选自动选中；用 project_run_status 等终态" };
        }
        case "project_patch_shot": {
            const runId = String(input.runId || "").trim();
            const shotId = String(input.shotId || "").trim();
            const stage = String(input.stage || "storyboard").trim() || "storyboard";
            if (!runId) throw new Error("缺少 runId");
            if (!shotId) throw new Error("缺少 shotId（先用 project_stage_items 拿）");
            const patch = input.patch && typeof input.patch === "object" ? (input.patch as Json) : {};
            if (!Object.keys(patch).length) throw new Error("patch 不能为空");
            const payload = (await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stage)}/shots/${encodeURIComponent(shotId)}`, { method: "PATCH", body: patch })) as {
                shot?: Json;
                changedFields?: string[];
                downstreamStale?: string[];
            };
            // downstreamStale 必须回给 Agent：改了 prompt/durationSec 之类被下游消费的字段后，
            // 关键帧/配音/合成的既有产物已经对上了「旧分镜」，不报出来等于骗它说改完就好了。
            const stale = payload.downstreamStale || [];
            return { runId, stage, shotId, patched: Object.keys(patch), shot: payload.shot ?? null, changedFields: payload.changedFields || [], downstreamStale: stale, ...(stale.length ? { hint: "上述阶段已标 stale，需要重跑才与新分镜一致" } : {}) };
        }
        case "project_shots_to_canvas": {
            const runId = String(input.runId || "").trim();
            const projectId = String(input.projectId || "").trim();
            const stage = String(input.stage || "storyboard").trim() || "storyboard";
            if (!runId) throw new Error("缺少 runId");
            if (!projectId) throw new Error("缺少 projectId");
            const shotIds = Array.isArray(input.shotIds) ? input.shotIds.map((id) => String(id).trim()).filter(Boolean) : [];
            if (!shotIds.length) throw new Error("缺少 shotIds（先用 project_stage_items 拿）");
            // 投递单要落到浏览器 IndexedDB 里的画布，服务端没有对应存储 ——
            // 因此这一工具只负责「把镜头内容 + 归因」取出来交给前端，网页侧由前端落到画布。
            // 不在这里假装已经"发到画布"：那是前端节点数据，Agent 无权声称已写入。
            const envelope = (await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}`, {})) as { run?: { stages?: Record<string, { output?: { shots?: unknown } }> } };
            const output = envelope?.run?.stages?.[stage]?.output;
            const shots = output && typeof output === "object" && Array.isArray((output as { shots?: unknown }).shots) ? ((output as { shots: Array<Record<string, Json>> }).shots) : [];
            if (!shots.length) throw new Error("分镜阶段还没有镜头产物，先跑分镜阶段");
            const picked = shotIds.length === shots.length ? shots : shots.filter((shot) => shotIds.includes(String(shot.id)));
            if (!picked.length) throw new Error(`分镜里没有这些镜头：${shotIds.join("、")}`);
            return {
                runId,
                stage,
                projectId,
                ready: true,
                shots: picked.map((shot) => ({ id: shot.id, index: shot.index, episodeId: shot.episodeId, sceneId: shot.sceneId, shotSize: shot.shotSize, durationSec: shot.durationSec, action: shot.action, dialogue: shot.dialogue, prompt: shot.prompt })),
                nextStep: "在网页的分镜页选这些镜头点「发到画布」，或在画布上调整后回写 project_patch_shot；Agent 无法直接写浏览器本地画布",
            };
        }
        case "project_confirm_casting": {
            const runId = String(input.runId || "").trim();
            const characterId = String(input.characterId || "").trim();
            if (!runId) throw new Error("缺少 runId");
            if (!characterId) throw new Error("缺少 characterId（先用 project_stage_items 拿）");
            const body: Json = { characterId };
            // closeupArtifactId = 显式选用候选脸（先看 project_asset_pack 的 candidates 再传）；
            // 带上 face: true 即「换这张脸并锁它」。不带 closeupArtifactId 时行为逐字不变。
            for (const key of ["face", "voice", "speaker", "design", "language", "speed", "previewArtifactId", "closeupArtifactId"] as const) {
                if (input[key] !== undefined) body[key] = input[key];
            }
            if (input.face !== true && input.voice !== true) throw new Error("face / voice 至少确认一个");
            await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/casting/confirm`, { method: "POST", body });
            return { runId, characterId, face: input.face === true, voice: input.voice === true, confirmed: true };
        }
        case "project_assemble": {
            const runId = String(input.runId || "").trim();
            if (!runId) throw new Error("缺少 runId");
            const body = input.options && typeof input.options === "object" ? input.options : {};
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/assembly/assemble`, { method: "POST", body });
            return { runId, inflight: payload.inflight !== false, hint: "ffmpeg 是分钟级；用 project_run_status 等终态，完成后 project_export_package 取交付包" };
        }
        case "project_adopt_candidate": {
            const projectId = String(input.projectId || "").trim();
            const shotId = String(input.shotId || "").trim();
            const slotId = String(input.slotId || "").trim();
            if (!projectId || !shotId || !slotId) throw new Error("缺少 projectId / shotId / slotId");
            // jobId 显式区分「撤销采用(null)」与「采用(字符串)」——不能用 truthy 判断。
            const jobId = input.jobId === null || input.jobId === undefined ? null : String(input.jobId);
            const payload = await gateway(`/api/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/slots/${encodeURIComponent(slotId)}/select`, {
                method: "POST",
                body: { jobId },
            });
            return { slotId, adopted: jobId, cleared: jobId === null, payload };
        }
        case "project_export_package": {
            const runId = String(input.runId || "").trim();
            if (!runId) throw new Error("缺少 runId");
            const body: Json = {};
            if (input.episodeId) body.episodeId = String(input.episodeId);
            if (input.allowPartial === true) body.allowPartial = true;
            if (Array.isArray(input.steps) && input.steps.length) body.steps = input.steps.map(String);
            const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/assembly/export`, { method: "POST", body });
            return { runId, inflight: payload.inflight === true, packageId: payload.packageId ?? null };
        }
        case "project_asset_pack": {
            const projectId = String(input.projectId || "").trim();
            if (!projectId && !input.runId) throw new Error("缺少 projectId（或给 runId 走定妆取料盘点）");
            const query = input.role ? `?role=${encodeURIComponent(String(input.role))}` : "";
            // 带 runId 时额外返回「定妆取料盘点」：每张脸当前用哪张、从哪来、还有哪些候选可换。
            // 换脸需要的就是这份清单，避免 Agent 为了换一张脸去翻整本 run。
            if (input.runId) {
                const runId = String(input.runId || "").trim();
                const payload = await gateway(`/api/pipeline/runs/${encodeURIComponent(runId)}/steps/casting/pack`);
                const rows = Array.isArray(payload.characters) ? (payload.characters as Json[]) : [];
                return {
                    runId,
                    castingFaces: rows.map((row) => ({
                        characterId: row.characterId ?? null,
                        name: row.name ?? null,
                        currentCloseupArtifactId: row.currentCloseupArtifactId ?? null,
                        // pack=人工选用/归入，design=服化道自动绑定，prev=沿用上次，none=未取到
                        source: row.source ?? null,
                        confirmed: row.confirmed === true,
                        candidates: Array.isArray(row.candidates) ? row.candidates.map(String) : [],
                    })),
                    hint: "换脸：project_confirm_casting 传 characterId + closeupArtifactId（从 candidates 里选）+ face:true",
                };
            }
            const payload = await gateway(`/api/projects/${encodeURIComponent(projectId)}/asset-refs${query}`);
            const refs = Array.isArray(payload.assetRefs) ? payload.assetRefs : [];
            // 只回「够判断下一步」的三件事：谁还没锁参考图、有几个候选、采用的是哪张。
            // 不回 artifactIds 全量与 metadata 全文 —— 几十条引用就能把上下文撑爆。
            return {
                projectId,
                packs: refs.map((item) => {
                    const ref = item as Json;
                    const ids = Array.isArray(ref.artifactIds) ? (ref.artifactIds as Json[]).map(String) : [];
                    const selected = ref.selectedArtifactId ? String(ref.selectedArtifactId) : "";
                    const meta = (ref.metadata ?? {}) as Json;
                    return {
                        refId: ref.id ?? null,
                        role: ref.role ?? null,
                        bindingId: ref.bindingId ?? null,
                        name: (meta.name as string) ?? ref.bindingId ?? null,
                        stageId: (meta.stageId as string) ?? null,
                        sourceJobId: (meta.sourceJobId as string) ?? null,
                        candidateCount: ids.length,
                        selectedArtifactId: selected || null,
                        // 与前端 asset-ref-model 的三态一致：selected 才算锁定。
                        status: selected ? "adopted" : ids.length ? "candidates" : "missing",
                    };
                }),
            };
        }
        case "project_attach_asset": {
            const projectId = String(input.projectId || "").trim();
            const role = String(input.role || "").trim();
            const bindingId = String(input.bindingId || "").trim();
            const artifactId = String(input.artifactId || "").trim();
            if (!projectId) throw new Error("缺少 projectId");
            if (!role) throw new Error("缺少 role（character/scene/prop/keyframe/clip）");
            if (!bindingId) throw new Error("缺少 bindingId（先用 project_asset_pack 查现有绑定；剧本实体用其 id）");
            if (!artifactId) throw new Error("缺少 artifactId（形如 /api/artifacts/<jobId>/<file>，不是本地 data:/blob: 地址）");
            const body: Json = { role, bindingId, artifactId };
            if (input.artifactIds !== undefined) body.artifactIds = input.artifactIds;
            if (input.selectedArtifactId !== undefined) body.selectedArtifactId = input.selectedArtifactId;
            if (typeof input.select === "boolean") body.select = input.select;
            for (const key of ["sourceJobId", "stageId", "name"] as const) if (input[key]) body[key] = String(input[key]);
            if (input.episodeId) body.episodeId = String(input.episodeId);
            if (input.sceneId) body.sceneId = String(input.sceneId);
            if (input.shotId) body.shotId = String(input.shotId);
            const payload = await gateway(`/api/projects/${encodeURIComponent(projectId)}/asset-refs/attach`, { method: "POST", body });
            const ref = (payload.assetRef ?? {}) as Json;
            return {
                projectId,
                refId: ref.id ?? null,
                role,
                bindingId,
                // created=false 表示命中已有引用并追加了候选 —— 这正是期望的幂等行为。
                created: payload.created === true,
                addedArtifactIds: Number(payload.addedArtifactIds) || 0,
                candidateCount: Array.isArray(ref.artifactIds) ? ref.artifactIds.length : 0,
                selectedArtifactId: ref.selectedArtifactId ?? null,
            };
        }
        default:
            throw new Error(`project_* 工具未实现：${String(name)}`);
    }
}

export const PROJECT_TOOL_NAMES: readonly ToolName[] = [
    "project_context",
    "project_gates",
    "project_list_jobs",
    "project_list_runs",
    "project_run_status",
    "project_run_qc",
    "project_stage_items",
    "project_run_stage",
    "project_cancel_stage",
    "project_retry_failed",
    "project_update_stage_input",
    "project_regenerate_item",
    "project_patch_shot",
    "project_shots_to_canvas",
    "project_confirm_casting",
    "project_assemble",
    "project_adopt_candidate",
    "project_asset_pack",
    "project_attach_asset",
    "project_export_package",
];

/** 该工具是否走网关 HTTP（而非 WebSocket 到网页）。 */
export function isProjectTool(name: ToolName) {
    return PROJECT_TOOL_NAMES.includes(name);
}

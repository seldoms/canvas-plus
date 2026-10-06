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
        default:
            throw new Error(`project_* 工具未实现：${String(name)}`);
    }
}

export const PROJECT_TOOL_NAMES: readonly ToolName[] = [
    "project_context",
    "project_gates",
    "project_list_jobs",
    "project_run_stage",
    "project_cancel_stage",
    "project_adopt_candidate",
    "project_export_package",
];

/** 该工具是否走网关 HTTP（而非 WebSocket 到网页）。 */
export function isProjectTool(name: ToolName) {
    return PROJECT_TOOL_NAMES.includes(name);
}

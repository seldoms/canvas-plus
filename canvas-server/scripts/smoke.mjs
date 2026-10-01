#!/usr/bin/env node
/**
 * 端到端冒烟：打真实 HTTP 接口，验证内网 LLM 与 ComfyUI 是否真的可用。
 * 需要网关已经在跑（node src/index.js）。
 *
 *   node scripts/smoke.mjs                    # 健康检查 + 真实生图 + 流水线剧本阶段
 *   node scripts/smoke.mjs --video            # 额外跑一段视频（约 5~15 分钟）
 *   node scripts/smoke.mjs --llm gemma3:4b    # 指定流水线用的模型
 *   node scripts/smoke.mjs --url http://192.168.123.139:8788
 *
 * 这是人工自检工具，不进 node --test，因为它依赖真实后端与真实 GPU 时间。
 */
const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const withVideo = args.includes("--video");
const llmModel = flag("--llm") || "gemma3:4b";
const base = (flag("--url") || process.env.CANVAS_SERVER_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");

async function api(path, init) {
    const response = await fetch(base + path, {
        ...init,
        headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    const text = await response.text();
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error(`${path} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    if (!response.ok) throw new Error(`${path} 失败（HTTP ${response.status}）：${payload?.error?.message || text.slice(0, 200)}`);
    return payload;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitJob(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { job } = await api(`/api/jobs/${id}`);
        if (job.status === "done") return job;
        if (job.status === "error" || job.status === "canceled") throw new Error(`${id} ${job.status}：${job.error || ""}`);
        if (Date.now() > deadline) throw new Error(`${id} 超时未完成`);
        await sleep(5000);
    }
}

async function generate(kind, template, name, params, timeoutMs) {
    const { job } = await api(`/api/generate/${kind}`, { method: "POST", body: JSON.stringify({ template, name, params }) });
    process.stdout.write(`  提交 ${template} → ${job.id}\n`);
    const done = await waitJob(job.id, timeoutMs);
    console.log(`  ✅ ${done.outputs.map((item) => `${item.url}（${item.bytes} B）`).join(", ")}`);
    return done;
}

function step(title) {
    console.log(`\n=== ${title} ===`);
}

step(`后端连通性（${base}）`);
const health = await api("/api/health");
console.log("  LLM  :", health.llm.ok ? `✅ ${health.llm.baseUrl}（${health.llm.models?.length ?? 0} 个模型）` : `❌ ${health.llm.error}`);
console.log("  Comfy:", health.comfy.ok ? `✅ ${health.comfy.baseUrl} v${health.comfy.version}` : `❌ ${health.comfy.error}`);
if (!health.llm.ok && !health.comfy.ok) process.exit(1);

if (health.comfy.ok) {
    step("生图（Z-Image，验证未指定 LoRA 时自动摘除节点）");
    await generate("image", "img_zimage_artistic", "smoke-zimage", {
        PROMPT: "cinematic portrait of a young woman in a red raincoat, rainy neon street at night, film grain",
        WIDTH: 768,
        HEIGHT: 1344,
        BATCH: 1,
    }, 20 * 60_000);

    if (withVideo) {
        step("生视频（MiniMax H3 文生视频）");
        await generate("video", "video_minimax_h3_t2v", "smoke-h3", {
            PROMPT: "a young woman in a red raincoat walks slowly through a rainy neon street at night, cinematic, slow camera push in",
            WIDTH: 768,
            HEIGHT: 1344,
            LENGTH: 123,
            STEPS: 8,
        }, 2 * 3600_000);
    }
}

if (health.llm.ok) {
    step("流水线：小说 → 剧本");
    const { run } = await api("/api/pipeline/runs", {
        method: "POST",
        body: JSON.stringify({
            title: "雨夜巷口",
            novel: "雨夜，老城的巷子里，摄影师林晚在等一场雨停。她看见对面屋檐下蹲着一只湿透的黑猫，猫的脖子上挂着一枚铜牌。她举起相机，取景框里却出现了另一个人——一个穿着红色雨衣的女孩，正对着她笑。林晚放下相机，巷子里空无一人。",
            options: { llmModel },
        }),
    });
    const started = Date.now();
    const result = await api(`/api/pipeline/runs/${run.id}/steps/script/run`, { method: "POST" });
    const stage = result.run.stages.script;
    console.log(`  状态: ${stage.status}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
    if (stage.error) console.log("  错误:", String(stage.error).slice(0, 300));
    else console.log("  产出:", JSON.stringify(stage.output).slice(0, 400));
}

console.log("\n冒烟结束。");

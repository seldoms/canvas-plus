import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { collectOutputs, createComfyClient, disableEmptyImageRefs, disableEmptyLoras, extractTokens, listComfyCapabilities, listTemplates, probeComfy, renderTemplate } from "../src/providers/comfy.js";

const workflowsDir = fileURLToPath(new URL("../workflows/", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "comfy-test-"));

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function writeTemplate(name, body) {
    const path = join(tmp, name);
    writeFileSync(path, body, "utf8");
    return path;
}

test("renderTemplate 替换 token 并把纯数字字符串转成 number", () => {
    const path = writeTemplate("basic.json", '{"seed":"{{SEED}}","width":"{{WIDTH}}","strength":"{{LORA_STRENGTH}}","prompt":"{{PROMPT}}"}');
    const graph = renderTemplate(path, { SEED: 42, WIDTH: "1024", LORA_STRENGTH: "0.75", PROMPT: "一只猫" });
    assert.deepEqual(graph, { seed: 42, width: 1024, strength: 0.75, prompt: "一只猫" });
    assert.equal(typeof graph.seed, "number");
    assert.equal(typeof graph.strength, "number");
});

test("renderTemplate 对值做 JSON 转义，引号/换行/反斜杠不会破坏结构", () => {
    const path = writeTemplate("escape.json", '{"text":"{{PROMPT}}","negative":"{{NEGATIVE_PROMPT}}"}');
    const prompt = '他说"你好"\n第二行\\结尾';
    const graph = renderTemplate(path, { PROMPT: prompt, NEGATIVE_PROMPT: "" });
    assert.equal(graph.text, prompt);
    assert.equal(graph.negative, "");
});

test("renderTemplate 缺 token 时抛错并列出全部缺失名", () => {
    const path = writeTemplate("missing.json", '{"a":"{{PROMPT}}","b":"{{SEED}}","c":"{{WIDTH}}"}');
    assert.throws(
        () => renderTemplate(path, { PROMPT: "x" }),
        (error) => {
            assert.match(error.message, /缺少参数/);
            assert.match(error.message, /SEED/);
            assert.match(error.message, /WIDTH/);
            assert.doesNotMatch(error.message, /PROMPT/);
            return true;
        },
    );
});

test("extractTokens 去重并保持出现顺序", () => {
    const path = writeTemplate("tokens.json", '{"a":"{{SEED}}","b":"{{PROMPT}}","c":"{{SEED}}","d":"{{WIDTH}}"}');
    assert.deepEqual(extractTokens(path), ["SEED", "PROMPT", "WIDTH"]);
});

test("listTemplates 扫描到全部模板并正确提取 tokens", () => {
    const templates = listTemplates(workflowsDir);
    const names = templates.map((item) => item.name);
    for (const required of [
        "img_zimage_artistic",
        "img_flux_artistic",
        "img_krea2_artistic",
        "img_boogu_outfit_edit",
        "upscale_4x",
        "video_h3_i2v",
        "video_h3_ref2v",
        "video_h3_ref2v_image",
        "video_h3_ref2v_image_turbo",
        "video_h3_quantfunc_ref2v",
        "video_h3_talk",
        "video_minimax_h3_t2v",
        "video_wan_animate",
        "scail2_action_transfer",
    ]) {
        assert.ok(names.includes(required), `缺少模板 ${required}`);
    }
    assert.ok(!names.some((name) => name.includes(".bak") || name.includes("_deprecated")), "不应保留备份/废弃模板");
    assert.ok(templates.every((item) => item.tokens.length > 0), "每个模板都应至少含一个 token");
    // listTemplates 的 title 兜底是裸模板名（TITLES[name] || name），漏登记会把 `video_h3_talk`
    // 这种内部名直接显示到前端「一键接入」的模型列表里。新增模板必须同时登记 TITLES。
    assert.deepEqual(templates.filter((item) => item.title === item.name).map((item) => item.name), [], "以下模板未在 comfy.js 的 TITLES 登记中文标题");

    const tokensOf = (name) => templates.find((item) => item.name === name).tokens.slice().sort();
    assert.deepEqual(tokensOf("video_h3_i2v"), ["HEIGHT", "INPUT_IMAGE", "LENGTH", "OUTPUT_PREFIX", "PROMPT", "SEED", "WIDTH"]);
    assert.deepEqual(tokensOf("video_minimax_h3_t2v"), ["HEIGHT", "LENGTH", "OUTPUT_PREFIX", "PROMPT", "SEED", "STEPS", "WIDTH"]);
    assert.deepEqual(tokensOf("video_h3_ref2v_image"), ["HEIGHT", "INPUT_IMAGE", "LENGTH", "OUTPUT_PREFIX", "PROMPT", "SEED", "WIDTH"]);
    // 加速版与 QuantFunc 版是同一契约的引擎变体，前端与分镜工作台按「只换模板名」直接调用；
    // token 一旦漂移，调用方就会在渲染阶段报「缺少参数」。
    for (const variant of ["video_h3_ref2v_image_turbo", "video_h3_quantfunc_ref2v"]) {
        assert.deepEqual(tokensOf(variant), tokensOf("video_h3_ref2v_image"), `${variant} 的 token 必须与 video_h3_ref2v_image 完全一致`);
    }

    assert.equal(templates.find((item) => item.name === "img_zimage_artistic").family, "image");
    assert.equal(templates.find((item) => item.name === "img_boogu_outfit_edit").family, "edit");
    assert.equal(templates.find((item) => item.name === "video_h3_i2v").family, "video");
    assert.equal(templates.find((item) => item.name === "upscale_4x").family, "upscale");
    assert.equal(templates.find((item) => item.name === "video_h3_ref2v_image").title, "H3 参考图生视频");
});

// 纯参考图变体：video_h3_ref2v 的节点 17（VHS_LoadVideo）已摘除，节点 10 的 length 改由 {{LENGTH}} 提供；
// 渲染后不得残留任何对节点 17 的引用（坑 #2：摘除节点后悬空引用会让 ComfyUI 校验失败）。
test("renderTemplate 渲染 video_h3_ref2v_image 无参考视频节点与悬空引用", () => {
    const graph = renderTemplate(join(workflowsDir, "video_h3_ref2v_image.json"), {
        PROMPT: "角色转身看向镜头",
        INPUT_IMAGE: "keyframe.png",
        WIDTH: 768,
        HEIGHT: 1344,
        LENGTH: 124,
        SEED: 7,
        OUTPUT_PREFIX: "canvas/test",
    });
    assert.equal(graph["17"], undefined, "节点 17（VHS_LoadVideo）应已摘除");
    const conditioning = graph["10"];
    assert.equal(conditioning.class_type, "MiniMaxH3AudioConditioningT8");
    assert.equal(conditioning.inputs.length, 124, "length 应来自 LENGTH 参数且数字化");
    assert.equal(typeof conditioning.inputs.length, "number");
    assert.deepEqual(conditioning.inputs["ref_images.ref_image_0"], ["9", 0]);
    assert.equal(conditioning.inputs["ref_videos.ref_video_0"], undefined, "不应再有参考视频输入");
    for (const [id, node] of Object.entries(graph)) {
        for (const [key, value] of Object.entries(node.inputs || {})) {
            assert.notEqual(Array.isArray(value) ? String(value[0]) : undefined, "17", `节点 ${id}.${key} 不应引用已摘除的节点 17`);
        }
    }
});

test("renderTemplate 渲染真实模板产出合法 API 图", () => {
    const graph = renderTemplate(join(workflowsDir, "img_zimage_artistic.json"), {
        PROMPT: '海边"日落"',
        WIDTH: 1024,
        HEIGHT: 768,
        BATCH: 1,
        SEED: 7,
        OUTPUT_PREFIX: "canvas/test",
        LORA_FILE: "none.safetensors",
        LORA_STRENGTH: 0.8,
    });
    const nodes = Object.values(graph);
    assert.ok(nodes.length > 0);
    assert.ok(nodes.every((node) => typeof node.class_type === "string" && typeof node.inputs === "object"));
    const latent = nodes.find((node) => node.inputs.width !== undefined && node.inputs.height !== undefined);
    assert.equal(latent.inputs.width, 1024);
    assert.equal(latent.inputs.height, 768);
    assert.equal(typeof latent.inputs.width, "number");
});

test("renderTemplate 保留数组内的节点引用为字符串（ComfyUI 会用它当 prompt 字典键）", () => {
    const graph = renderTemplate(join(workflowsDir, "img_zimage_artistic.json"), {
        PROMPT: "a cat",
        WIDTH: 768,
        HEIGHT: 1344,
        BATCH: 1,
        SEED: 1,
        OUTPUT_PREFIX: "canvas/test",
        LORA_FILE: "none.safetensors",
        LORA_STRENGTH: 1,
    });
    // 标量参数要数字化，节点引用必须保持字符串，否则 ComfyUI 校验 prompt[o_id] 会抛 KeyError。
    assert.equal(graph["8"].inputs.width, 768);
    assert.equal(typeof graph["8"].inputs.width, "number");
    assert.deepEqual(graph["11"].inputs.images, ["10", 0]);
    assert.equal(typeof graph["11"].inputs.images[0], "string");
    assert.deepEqual(graph["3"].inputs.model, ["2", 0]);
    assert.equal(typeof graph["3"].inputs.model[0], "string");
});

test("collectOutputs 落盘产物并生成 artifactUrl", async () => {
    const dataDir = join(tmp, "data");
    const client = { view: async () => Buffer.from("PNGDATA") };
    const entry = {
        outputs: {
            9: {
                images: [{ filename: "a.png", subfolder: "", type: "output" }],
                gifs: [{ filename: "d.gif" }],
                videos: [{ filename: "b.mp4", width: 1280, height: 720 }],
                audio: [{ filename: "c.wav" }],
            },
        },
    };

    const artifacts = await collectOutputs(entry, "job1", { dataDir, publicUrl: "" }, client);
    assert.deepEqual(artifacts.map((item) => item.filename), ["a.png", "d.gif", "b.mp4", "c.wav"]);
    assert.deepEqual(artifacts.map((item) => item.type), ["image", "image", "video", "audio"]);
    assert.equal(artifacts[0].url, "/api/artifacts/job1/a.png");
    assert.equal(artifacts[0].bytes, 7);
    assert.equal(artifacts[2].width, 1280);
    assert.ok(existsSync(join(dataDir, "artifacts", "job1", "a.png")));

    const absolute = await collectOutputs(entry, "job2", { dataDir, publicUrl: "http://localhost:8788/" }, client);
    assert.equal(absolute[0].url, "http://localhost:8788/api/artifacts/job2/a.png");
});

test("disableEmptyLoras 摘除空 LoRA 节点并把下游重连到上游", () => {
    const graph = {
        1: { class_type: "UNETLoader", inputs: { unet_name: "z.safetensors" } },
        2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "" } },
        3: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["2", 0], shift: 1.7 } },
    };
    const removed = disableEmptyLoras(graph);
    assert.deepEqual(removed, ["2"]);
    assert.equal(graph["2"], undefined);
    assert.deepEqual(graph["3"].inputs.model, ["1", 0]);
});

test("disableEmptyLoras 摘除链式空 LoRA", () => {
    const graph = {
        1: { class_type: "UNETLoader", inputs: {} },
        2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "  " } },
        3: { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: "" } },
        4: { class_type: "KSampler", inputs: { model: ["3", 0] } },
    };
    assert.deepEqual(disableEmptyLoras(graph), ["2", "3"]);
    assert.deepEqual(graph["4"].inputs.model, ["1", 0]);
});

test("disableEmptyLoras 保留 lora_name 非空的节点", () => {
    const graph = {
        1: { class_type: "UNETLoader", inputs: {} },
        2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "x.safetensors" } },
        3: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["2", 0] } },
    };
    assert.deepEqual(disableEmptyLoras(graph), []);
    assert.ok(graph["2"], "非空 LoRA 不应被摘除");
    assert.deepEqual(graph["3"].inputs.model, ["2", 0]);
});

test("disableEmptyLoras 对 LoraLoader 空 lora_name 抛中文错误", () => {
    const graph = {
        1: { class_type: "UNETLoader", inputs: {} },
        5: { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: "   " } },
    };
    assert.throws(() => disableEmptyLoras(graph), /LoRA 节点 5 缺少 lora_name/);
    assert.ok(graph["5"], "抛错时不应摘除节点");
});

test("disableEmptyImageRefs 摘除空 LoadImage 并删掉引用它的输入键", () => {
    const graph = {
        4: { class_type: "LoadImage", inputs: { image: "a.png" } },
        10: { class_type: "LoadImage", inputs: { image: "" } },
        11: { class_type: "LoadImage", inputs: { image: "   " } },
        5: { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["4", 0], "images.image_2": ["10", 0], "images.image_3": ["11", 0], prompt: "x" } },
    };
    assert.deepEqual(disableEmptyImageRefs(graph), ["10", "11"]);
    assert.equal(graph["10"], undefined);
    assert.equal(graph["11"], undefined);
    assert.deepEqual(Object.keys(graph["5"].inputs).sort(), ["images.image_1", "prompt"]);
    assert.deepEqual(graph["5"].inputs["images.image_1"], ["4", 0], "非空槽位的引用不应被动");
});

test("disableEmptyImageRefs 全部非空时不摘除任何节点", () => {
    const graph = {
        4: { class_type: "LoadImage", inputs: { image: "a.png" } },
        5: { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["4", 0] } },
    };
    assert.deepEqual(disableEmptyImageRefs(graph), []);
    assert.deepEqual(graph["5"].inputs["images.image_1"], ["4", 0]);
});

// 回归：Qwen-Image 2.1 编辑模板给了 10 个图槽位，只传 INPUT_IMAGE 时必须把其余 9 个 LoadImage
// 连同 images.image_2..10 一起摘干净，否则会把引用了不存在节点的图提交给 ComfyUI。
test("img_qwen21_edit 只传 INPUT_IMAGE 时摘掉 9 个空参考图槽位", () => {
    const params = { INPUT_IMAGE: "target.png", PROMPT: "把背景换成雪地", SEED: 7, OUTPUT_PREFIX: "canvas/x" };
    for (let index = 1; index <= 9; index++) params[`REF_IMAGE_${index}`] = "";
    const graph = renderTemplate(join(workflowsDir, "img_qwen21_edit.json"), params);
    assert.deepEqual(disableEmptyImageRefs(graph), ["10", "11", "12", "13", "14", "15", "16", "17", "18"]);
    const encode = graph["5"].inputs;
    assert.deepEqual(encode["images.image_1"], ["4", 0]);
    for (let slot = 2; slot <= 10; slot++) assert.equal(encode[`images.image_${slot}`], undefined, `images.image_${slot} 应已被删除`);
    // latent 必须取 TextEncodeQwenImage21 的第 3 个输出：官方源码注明用别的尺寸会让编辑偏移
    assert.deepEqual(graph["7"].inputs.latent_image, ["5", 2]);
});

test("img_qwen21_edit 的 token 顺序保证前端按位映射时 INPUT_IMAGE 落在第一个图槽", () => {
    const tokens = extractTokens(join(workflowsDir, "img_qwen21_edit.json"));
    const imageTokens = tokens.filter((token) => token === "INPUT_IMAGE" || /^REF_IMAGE_\d+$/.test(token));
    assert.equal(imageTokens[0], "INPUT_IMAGE", "INPUT_IMAGE 必须排在所有 REF_IMAGE_N 之前");
    assert.deepEqual(imageTokens.slice(1), Array.from({ length: 9 }, (_, i) => `REF_IMAGE_${i + 1}`));
});

// 回归：真实模板路径下，renderTemplate 产出的节点引用要保持字符串，摘除 LoRA 后下游必须正确重连，
// 否则会把引用了已删除节点的图提交给 ComfyUI，报 prompt_outputs_failed_validation。
test("disableEmptyLoras 在真实模板上摘除 LoRA 后下游重连到上游", () => {
    const graph = renderTemplate(join(workflowsDir, "img_zimage_artistic.json"), {
        PROMPT: "a cat",
        WIDTH: 768,
        HEIGHT: 1344,
        BATCH: 1,
        SEED: 1,
        OUTPUT_PREFIX: "canvas/test",
        LORA_FILE: "",
        LORA_STRENGTH: 1,
    });
    assert.ok(graph["2"], "渲染后应存在 LoRA 节点");
    assert.deepEqual(disableEmptyLoras(graph), ["2"]);
    assert.equal(graph["2"], undefined);
    assert.deepEqual(graph["3"].inputs.model, ["1", 0], "节点 3 应重连到节点 1，而不是悬空引用已删除的节点 2");
});

// 防御性回归：节点引用被数字化时（例如用户在画布里粘贴了数字 id 的模板）也要能正确重连。
test("disableEmptyLoras 对数字化的节点引用同样能重连", () => {
    const graph = {
        1: { class_type: "UNETLoader", inputs: {} },
        2: { class_type: "LoraLoaderModelOnly", inputs: { model: [1, 0], lora_name: "" } },
        3: { class_type: "ModelSamplingAuraFlow", inputs: { model: [2, 0] } },
    };
    assert.deepEqual(disableEmptyLoras(graph), ["2"]);
    assert.deepEqual(graph["3"].inputs.model, [1, 0]);
});

test("disableEmptyLoras 跳过缺少 inputs.model 的异常节点", () => {
    const graph = { 2: { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "" } } };
    const warnings = [];
    const original = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
        assert.deepEqual(disableEmptyLoras(graph), []);
    } finally {
        console.warn = original;
    }
    assert.ok(graph["2"], "异常节点应保留");
    assert.match(warnings.join("\n"), /缺少 inputs.model/);
});

test("disableEmptyLoras 在真实模板上摘除空 LoRA", () => {
    const graph = renderTemplate(join(workflowsDir, "img_zimage_artistic.json"), {
        PROMPT: "海边日落",
        WIDTH: 1024,
        HEIGHT: 1024,
        BATCH: 1,
        SEED: 7,
        OUTPUT_PREFIX: "canvas/test",
        LORA_FILE: "",
        LORA_STRENGTH: 0.8,
    });
    assert.equal(graph["2"].class_type, "LoraLoaderModelOnly");
    assert.deepEqual(disableEmptyLoras(graph), ["2"]);
    assert.equal(graph["2"], undefined);
    for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs)) {
            assert.notEqual(Array.isArray(value) ? value[0] : undefined, "2", "不应残留对已摘除节点的引用");
        }
    }
});

test("集成：真实 ComfyUI 的 probe / 队列计数 / 节点信息", async (t) => {
    const config = loadConfig();
    // 真机联调用这条。CI / 干净 clone 里没有 config.json，baseUrl 会回落到
    // 127.0.0.1:8188 这个默认值 —— 如果开发机恰好有 ComfyUI 跑在 8188，
    // probe 会「成功」，然后拿别人机器的实例状态去断言 checkpoint，必然红。
    // 所以这里判的是「配的是不是一台真实可达的 ComfyUI」，而���只是「能不能连上」。
    const baseUrl = String(config?.comfy?.baseUrl || "");
    const isDefaultLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(baseUrl);
    if (!baseUrl || isDefaultLoopback) {
        t.skip(`未配置真实 ComfyUI（baseUrl=${baseUrl || "<空>"}，多为本机默认回环）；本条仅用于真机联调`);
        return;
    }
    const probe = await probeComfy(config);
    if (!probe.ok) {
        t.skip(`ComfyUI 不可达（${probe.baseUrl}）：${probe.error}`);
        return;
    }
    assert.equal(probe.ok, true);
    assert.ok(probe.version, "应返回 ComfyUI 版本");

    const client = createComfyClient(config);
    const counts = await client.queueCounts();
    assert.ok(Number.isInteger(counts.running) && Number.isInteger(counts.pending));

    const stats = await client.systemStats();
    assert.ok(stats.system, "system_stats 应含 system 字段");

    const info = await client.objectInfo("CheckpointLoaderSimple");
    assert.ok(info.CheckpointLoaderSimple.input.required, "object_info 应含输入定义");

    const capabilities = await listComfyCapabilities(config);
    assert.ok(capabilities.templates.length > 0, "应返回模板列表");
    assert.ok(capabilities.models.checkpoints.length > 0, "应能列出 checkpoint");
    assert.ok(capabilities.models.loras.length > 0, "应能列出 lora");
    assert.ok(capabilities.models.vae.length > 0, "应能列出 vae");
});

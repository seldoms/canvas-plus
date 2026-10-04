import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
    host: "0.0.0.0",
    port: 8788,
    publicUrl: "",
    dataDir: "data",
    workflowsDir: "workflows",
    skillsDir: "../skills",
    webDir: "../web/dist",
    llm: {
        baseUrl: "http://127.0.0.1:11434",
        apiKey: "",
        timeoutMs: 600000,
        defaultModel: "",
        fallbacks: [],
        // 本地 Ollama 原生 /api/chat 的上下文窗口。Modelfile 默认只有 8192，
        // 关键帧/剧本阶段提示词一超就被硬截断成残缺 JSON；实测 16384/32768/65536/131072 均不 OOM，
        // 取 32768 与本项目「单块 16000 字 + 模板 + 输出」的 32k 设计假设对齐，且占用已 GPU 驻留、留有余量。
        // 仅对本地 Ollama 生效；外部 OpenAI 兼容渠道不受影响。
        numCtx: 32768,
    },
    comfy: {
        baseUrl: "http://127.0.0.1:8188",
        timeoutMs: 7200000,
        pollIntervalMs: 3000,
        username: "",
        password: "",
        maxQueue: 16,
        // 设备标识与并发上限：一台 16GB 卡同时承担生图/生视频。默认 1 与现有全局单 worker 行为一致。
        deviceLabel: "本地 ComfyUI",
        maxConcurrency: 1,
    },
    // 本地优先：生图/生视频默认且必须走本地 ComfyUI；RunningHub 是保留的可选云端后端。
    generation: {
        defaultBackend: "local",
        allowRunningHub: true,
    },
    runninghub: {
        baseUrl: "https://www.runninghub.ai/openapi/v2",
        apiKey: "",
        pollIntervalMs: 5000,
        timeoutMs: 1800000,
        // 仅用于 /api/health 的连通性探测，避免健康检查被任务级超时（30 分钟）拖住。
        probeTimeoutMs: 8000,
        model: {
            image: "z-image/turbo",
            video: "alibaba/wan-2.7/image-to-video",
        },
    },
    pipeline: {
        llmModel: "",
        imageTemplate: "img_zimage_artistic",
        // 需要锁角色的镜头（按 ShotBinding 注入 REF_IMAGE_*）改用的参考图模板。
        // 必须是同血统、带 LoadImage/REF_IMAGE 槽的模板；tool-adapter 会按真实节点能力复核，
        // 不满足则镜头显式 blocked（绝不假装已锁定角色）。留空则自动选一个能力达标的参考图模板。
        referenceImageTemplate: "img_qwen21_edit",
        editTemplate: "img_boogu_outfit_edit",
        videoTemplate: "video_h3_i2v",
        upscaleTemplate: "upscale_4x",
        // 配音阶段（audio）用的 TTS 工作流模板与设备：任何带 {{TEXT}}/{{SPEAKER}}/{{INSTRUCT}}/{{LANGUAGE}} 的
        // 文本→音频模板都可用；默认 Qwen3-TTS 命名音色。DEVICE 默认 cuda，显存/内存紧张时可切 cpu。
        audioTemplate: "audio_qwen3_tts",
        audioDevice: "cuda",
        // 对口型（lipsync）阶段用的工作流模板（服务端注册表项）：输入=已有片段 + 该镜 TTS 音频，输出=另存的新片段。
        // 留空则「对口型」阶段不产任务（显式 blocked + 可读原因），成片仍按原片段产出。模型/采样参数都写在模板里，
        // 内容层与前端不得出现模型专属参数。
        lipsyncTemplate: "video_lipsync",
        // 关键帧/片段生成时补进模板的尺寸参数；模板要求的 token 缺一个就会在渲染阶段报错。
        imageWidth: 768,
        imageHeight: 1344,
        imageBatch: 1,
        videoWidth: 768,
        videoHeight: 1344,
        videoSeconds: 5,
        videoFps: 24,
        // D3：单镜一次入队 ≥4 个关键帧候选（不达标由 retryFailedItem 自动重生成，预算见 maxItemRetries）。
        // 同时也是 04-keyframes 提示词里的单镜帧数上限。
        maxKeyframesPerShot: 4,
        // 「01 剧本」阶段填入小说后的完整 prompt 超过该字符数时，自动分块改编（map-reduce）；
        // 小于等于阈值维持单次调用。针对整本长篇超出模型上下文的场景（如 156 万 token 超 DeepSeek 104 万上限）。
        // 默认 16000：对齐剧本工作室 skill 的「每批 8000 字以内」注意力策略并放宽一倍兼顾吞吐；
        // 本地 27B（32k 上下文）也能容纳单块 + 模板 + 输出。
        maxNovelChunkChars: 16000,
        // 分块改编的单块耗时估值（秒），只用于创建 run 时给出的预估，不影响实际执行。
        // 默认 31：实测 222 万字 → 163 块 → 83 分钟 ≈ 30.5s/块（deepseek-flash）。
        // 换本地 27B 思考型模型会慢得多，按实际情况调这个值即可，预估会跟着变。
        estSecondsPerChunk: 31,
    },
};

function envValue(name) {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? undefined : raw;
}

function envNumber(name) {
    const raw = envValue(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function envList(name) {
    const raw = envValue(name);
    if (raw === undefined) return undefined;
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

/** 相对路径按 canvas-server 根目录解析，便于任意工作目录下启动。 */
function resolvePath(value, base) {
    return isAbsolute(value) ? value : resolve(base, value);
}

export function loadConfig(overrides = {}) {
    const configPath = envValue("CANVAS_SERVER_CONFIG") || resolve(serverRoot, "config.json");
    let fileConfig = {};
    if (existsSync(configPath)) {
        fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
    }

    const merged = {
        ...DEFAULTS,
        ...fileConfig,
        ...overrides,
        llm: { ...DEFAULTS.llm, ...fileConfig.llm, ...overrides.llm },
        comfy: { ...DEFAULTS.comfy, ...fileConfig.comfy, ...overrides.comfy },
        generation: { ...DEFAULTS.generation, ...fileConfig.generation, ...overrides.generation },
        runninghub: { ...DEFAULTS.runninghub, ...fileConfig.runninghub, ...overrides.runninghub },
        pipeline: { ...DEFAULTS.pipeline, ...fileConfig.pipeline, ...overrides.pipeline },
    };

    merged.host = envValue("CANVAS_SERVER_HOST") ?? merged.host;
    merged.port = envNumber("CANVAS_SERVER_PORT") ?? merged.port;
    merged.publicUrl = envValue("CANVAS_SERVER_PUBLIC_URL") ?? merged.publicUrl;
    merged.dataDir = envValue("CANVAS_SERVER_DATA_DIR") ?? merged.dataDir;
    merged.workflowsDir = envValue("CANVAS_SERVER_WORKFLOWS_DIR") ?? merged.workflowsDir;
    merged.skillsDir = envValue("CANVAS_SERVER_SKILLS_DIR") ?? merged.skillsDir;
    merged.webDir = envValue("CANVAS_SERVER_WEB_DIR") ?? merged.webDir;
    merged.llm.baseUrl = envValue("CANVAS_SERVER_LLM_URL") ?? merged.llm.baseUrl;
    merged.llm.apiKey = envValue("CANVAS_SERVER_LLM_KEY") ?? merged.llm.apiKey;
    merged.llm.defaultModel = envValue("CANVAS_SERVER_LLM_MODEL") ?? merged.llm.defaultModel;
    merged.llm.fallbacks = envList("CANVAS_SERVER_LLM_FALLBACKS") ?? merged.llm.fallbacks;
    merged.comfy.baseUrl = envValue("CANVAS_SERVER_COMFY_URL") ?? merged.comfy.baseUrl;
    merged.comfy.username = envValue("CANVAS_SERVER_COMFY_USER") ?? merged.comfy.username;
    merged.comfy.password = envValue("CANVAS_SERVER_COMFY_PASSWORD") ?? merged.comfy.password;
    merged.generation.defaultBackend = envValue("CANVAS_SERVER_DEFAULT_BACKEND") ?? merged.generation.defaultBackend;
    merged.runninghub.baseUrl = envValue("CANVAS_SERVER_RH_URL") ?? merged.runninghub.baseUrl;
    merged.runninghub.apiKey = envValue("CANVAS_SERVER_RH_KEY") ?? merged.runninghub.apiKey;

    merged.dataDir = resolvePath(merged.dataDir, serverRoot);
    merged.workflowsDir = resolvePath(merged.workflowsDir, serverRoot);
    merged.skillsDir = resolvePath(merged.skillsDir, serverRoot);
    merged.configPath = configPath;

    mkdirSync(merged.dataDir, { recursive: true });
    mkdirSync(resolve(merged.dataDir, "artifacts"), { recursive: true });
    mkdirSync(resolve(merged.dataDir, "runs"), { recursive: true });
    mkdirSync(resolve(merged.dataDir, "uploads"), { recursive: true });

    return merged;
}

export const config = loadConfig();

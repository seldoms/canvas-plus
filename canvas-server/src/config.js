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
    },
    comfy: {
        baseUrl: "http://127.0.0.1:8188",
        timeoutMs: 7200000,
        pollIntervalMs: 3000,
        username: "",
        password: "",
        maxQueue: 16,
    },
    pipeline: {
        llmModel: "",
        imageTemplate: "img_zimage_artistic",
        editTemplate: "img_boogu_outfit_edit",
        videoTemplate: "video_h3_i2v",
        upscaleTemplate: "upscale_4x",
        videoSeconds: 5,
        videoFps: 24,
        maxKeyframesPerShot: 2,
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

import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { gatewayBaseUrl } from "./gateway";

/**
 * 提示词编译器接口客户端（契约见 docs/content/docs/progress/pilot-issues.md §54「提示词编译器」）。
 *
 * 立身之本：内容层只给「模型无关的内容事实」，**后端在发起生成请求那一刻按所选模型的标准编译**，
 * 前端只负责把当前内容事实递过去、拿回 `prompt` 再发模型 —— 请求侧（鉴权/渠道/参数）一概不动。
 *
 * 传输沿用 model-registry.ts 的写法：axios + gatewayBaseUrl（同源 `/api/*`），错误收敛成 Error。
 * ⚠️ 编译器失败/超时**不得阻断生成**：调用方负责静默回退到原提示词，本模块只如实抛错。
 */

/** 生成家族（与后端 pipeline 的 family 一致：出图 / 出视频）。 */
export type PromptCompileFamily = "image" | "video";

/** 内容语言（编译器按目标模型分派是否英文化）。 */
export type PromptCompileLanguage = "zh" | "en";

/** 本次实际注入的素材槽（编译器据此生成「参考素材说明」段）。 */
export type PromptCompileSlotImage = {
    /** 素材地址 / 槽位标识；编译器只用它做编号，不会拉取内容。 */
    url: string;
    kind: "first_frame" | "last_frame" | "input_image" | "reference";
    role?: string;
    name?: string;
};

export type PromptCompileSlots = {
    images?: PromptCompileSlotImage[];
    /** 仅 Qwen 系：需要透明背景。 */
    transparent?: boolean;
};

/** 图上的文字（逐字进提示词）。 */
export type PromptCompileOverlay = {
    text: string;
    kind?: string;
    position?: string;
    style?: string;
};

/** 镜头级内容事实（模型无关）；工作台只有一段文字，塞进 `prompt` 即可。 */
export type PromptCompileShot = {
    prompt?: string;
    action?: string;
    dialogue?: string;
    shotSize?: string;
    durationSec?: number;
    textOverlays?: PromptCompileOverlay[];
};

/** 场景事实（可选）。 */
export type PromptCompileScene = {
    name?: string;
    location?: string;
};

/** 角色事实（可选）。 */
export type PromptCompileCharacter = {
    name?: string;
    outfit?: string;
};

/** 风格锚点（可选）：字符串等价于 `{ anchor }`，与后端 readStyleFields 口径一致。 */
export type PromptCompileStyle = string | { anchor?: string; context?: string; filmLayer?: string };

/** POST /api/prompt/compile 请求体（契约已冻结）。 */
export type PromptCompileRequest = {
    /** 所选模型的模板名（取自模型注册表的 `name`）。 */
    template: string;
    family: PromptCompileFamily;
    shot: PromptCompileShot;
    scene?: PromptCompileScene;
    characters?: PromptCompileCharacter[];
    style?: PromptCompileStyle;
    slots?: PromptCompileSlots;
    overlays?: PromptCompileOverlay[];
    durationSec?: number;
    /** 语言适配：交由后端按模型标准决定是否英文化/改写。 */
    rewrite?: boolean;
};

export type PromptCompileApplied = {
    structure: boolean;
    negative: boolean;
    textInImage: boolean;
};

export type PromptCompileLlm = {
    model: string;
    finishReason: string;
    chars: number;
};

export type PromptCompileMeta = {
    template: string;
    modelKey: string;
    language: PromptCompileLanguage;
    rewriterId?: string | null;
    untranslated?: boolean;
    applied: PromptCompileApplied;
    llm?: PromptCompileLlm | null;
    notes?: string[];
};

/** POST /api/prompt/compile 响应体：`prompt` 就是最终要发给模型的提示词。 */
export type PromptCompileResult = {
    prompt: string;
    meta: PromptCompileMeta;
};

export type PromptCompileOptions = {
    signal?: AbortSignal;
    /** 编译器可能内含 LLM 改写，给一个上界，超时即由调用方静默降级。 */
    timeoutMs?: number;
};

/** 默认编译超时：超过即视为编译器不可用，回退原提示词继续生成。 */
export const PROMPT_COMPILE_TIMEOUT_MS = 20_000;

type PromptCompileApiError = Error & { status: number };

function compileError(message: string, status: number): PromptCompileApiError {
    return Object.assign(new Error(message), { status });
}

async function promptCompileRequest<T>(config: AxiosRequestConfig): Promise<T> {
    try {
        const response = await axios.request<T>({ ...config, baseURL: gatewayBaseUrl() });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status ?? 0;
            const payload = error.response?.data as { error?: { message?: string } } | undefined;
            if (payload?.error?.message) throw compileError(i18n.t("gateway.failed", { message: payload.error.message }), status);
            if (error.response) throw compileError(i18n.t("gateway.httpFailed", { status }), status);
            throw compileError(i18n.t("gateway.unreachable"), 0);
        }
        throw error instanceof Error ? error : compileError(i18n.t("gateway.unreachable"), 0);
    }
}

/**
 * POST /api/prompt/compile：把内容事编译成所选模型要的提示词。
 * 返回 `{ prompt, meta }`；接口未就绪 / 超时 / 响应缺 `prompt` 时抛错，由调用方降级。
 */
export async function compilePrompt(input: PromptCompileRequest, options?: PromptCompileOptions): Promise<PromptCompileResult> {
    const data = await promptCompileRequest<unknown>({
        method: "post",
        url: "/api/prompt/compile",
        data: input,
        timeout: options?.timeoutMs ?? PROMPT_COMPILE_TIMEOUT_MS,
        signal: options?.signal,
    });
    if (!data || typeof data !== "object") throw compileError(i18n.t("gateway.unreachable"), 0);
    const result = data as Partial<PromptCompileResult>;
    if (typeof result.prompt !== "string") throw compileError(i18n.t("gateway.unreachable"), 0);
    return { prompt: result.prompt, meta: (result.meta as PromptCompileMeta) ?? ({} as PromptCompileMeta) };
}

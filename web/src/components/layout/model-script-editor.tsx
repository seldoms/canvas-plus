import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import { Button, Modal } from "antd";
import { Copy, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { buildGatewayTemplateScript, fetchGatewayProviders, isBuiltinGatewayTemplate, type GatewayTemplateInfo } from "@/services/api/gateway";
import { getPluginAuthoringPrompt, getPluginReturn, getPluginTemplates, getPluginVariables } from "@/services/api/model-plugin";
import type { ModelCapability } from "@/stores/use-config-store";

function isDarkMode() {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function StepHeading({ index, title }: { index: number; title: string }) {
    return (
        <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[11px] font-medium text-white dark:bg-stone-100 dark:text-stone-900">{index}</span>
            <span className="text-sm font-medium text-stone-800 dark:text-stone-100">{title}</span>
        </div>
    );
}

function StepBlock({ index, title, children }: { index: number; title: string; children: ReactNode }) {
    return (
        <section className="border-b border-stone-200/70 px-5 py-4 dark:border-stone-800/70">
            <StepHeading index={index} title={title} />
            {children}
        </section>
    );
}

export function ModelScriptEditor({ open, capability, modelName, value, onSave, onClose }: { open: boolean; capability: ModelCapability; modelName: string; value: string; onSave: (script: string) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [draft, setDraft] = useState(value);
    const [gatewayTemplates, setGatewayTemplates] = useState<GatewayTemplateInfo[] | null>(null);
    const [gatewayLoading, setGatewayLoading] = useState(false);
    const [gatewayError, setGatewayError] = useState("");
    useEffect(() => {
        if (open) setDraft(value);
    }, [open, value]);
    // 每次打开或切换能力时清空网关模板结果，避免展示上一个能力/上次会话的残留。
    useEffect(() => {
        setGatewayTemplates(null);
        setGatewayError("");
        setGatewayLoading(false);
    }, [open, capability]);

    const variables = getPluginVariables().filter((variable) => !variable.capabilities || variable.capabilities.includes(capability));
    const templates = getPluginTemplates()[capability];
    const capabilityLabel = t(`config.channelEditor.capabilities.${capability}`);
    const hasScript = Boolean(draft.trim());
    const gatewayGroup = capability === "image" || capability === "video";

    // 从网关 /api/providers 拉取当前能力匹配、且未在精选里出现过的模板；失败时明确提示而不静默留空。
    const loadGatewayTemplates = async () => {
        setGatewayLoading(true);
        setGatewayError("");
        try {
            const providers = await fetchGatewayProviders();
            const list = (providers.comfy?.templates || []).filter((template) => {
                const mapped = template.family === "video" ? "video" : "image";
                return mapped === capability && !isBuiltinGatewayTemplate(template.name, mapped);
            });
            setGatewayTemplates(list);
        } catch (error) {
            setGatewayTemplates(null);
            setGatewayError(error instanceof Error ? error.message : String(error));
        } finally {
            setGatewayLoading(false);
        }
    };

    return (
        <Modal
            open={open}
            title={null}
            footer={null}
            width="100vw"
            centered={false}
            onCancel={onClose}
            wrapClassName="[&_.ant-modal]:!inset-0 [&_.ant-modal]:!top-0 [&_.ant-modal]:!m-0 [&_.ant-modal]:!max-w-none [&_.ant-modal]:!h-dvh [&_.ant-modal]:!w-full [&_.ant-modal]:!p-0 [&_.ant-modal-container]:!h-dvh [&_.ant-modal-container]:!p-0 [&_.ant-modal-content]:!h-dvh [&_.ant-modal-content]:!max-h-dvh [&_.ant-modal-content]:!rounded-none [&_.ant-modal-content]:!overflow-hidden [&_.ant-modal-body]:!h-full [&_.ant-modal-body]:!max-h-full [&_.ant-modal-body]:!overflow-hidden [&_.ant-modal-body]:!p-0"
            styles={{
                wrapper: { overflow: "hidden" },
                body: { height: "100dvh", maxHeight: "100dvh", padding: 0, overflow: "hidden" },
            }}
            style={{ top: 0, margin: 0, paddingBottom: 0, maxWidth: "100vw" }}
        >
            <div className="flex h-dvh max-h-dvh flex-col overflow-hidden">
                <header className="shrink-0 border-b border-stone-200 px-6 py-3 pr-12 dark:border-stone-800">
                    <div className="text-base font-semibold">
                        {t("config.scriptEditor.title", { capability: capabilityLabel })}
                        {modelName ? ` · ${modelName}` : ""}
                    </div>
                    <div className="mt-1 text-xs text-stone-500">{t("config.scriptEditor.description")}</div>
                </header>
                <div className="flex min-h-0 flex-1 overflow-hidden">
                    <aside className="flex h-full w-[420px] shrink-0 flex-col border-r border-stone-200 bg-stone-50/80 dark:border-stone-800 dark:bg-stone-900/40">
                        <div className="flex shrink-0 gap-2 border-b border-stone-200/70 px-5 py-3 text-xs text-stone-500 dark:border-stone-800/70 dark:text-stone-400">
                            <span>1. {t("config.scriptEditor.stepRule")}</span>
                            <span>→</span>
                            <span>2. {t("config.scriptEditor.stepAi")}</span>
                            <span>→</span>
                            <span>3. {t("config.scriptEditor.stepEdit")}</span>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-scroll overscroll-contain p-0">
                            <StepBlock index={1} title={t("config.scriptEditor.stepRule")}>
                                <p className="text-xs leading-5 text-stone-600 dark:text-stone-300">{t("config.scriptEditor.stepRuleHint")}</p>
                                <div className="mt-3">
                                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t("config.scriptEditor.returnRequirements")}</div>
                                    <div className="text-xs leading-6 text-stone-600 dark:text-stone-300">{getPluginReturn(capability)}</div>
                                </div>
                            </StepBlock>
                            <StepBlock index={2} title={t("config.scriptEditor.stepAi")}>
                                <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-5 text-stone-600 dark:text-stone-300">
                                    <li>{t("config.scriptEditor.stepAiCopy")}</li>
                                    <li>{t("config.scriptEditor.stepAiAsk")}</li>
                                    <li>{t("config.scriptEditor.stepAiPaste")}</li>
                                </ol>
                                <p className="mt-2 text-[11px] leading-5 text-stone-400">{t("config.scriptEditor.stepAiIncludes")}</p>
                                <Button
                                    type="primary"
                                    className="mt-3"
                                    icon={<Copy className="size-3.5" />}
                                    onClick={() => copyText(getPluginAuthoringPrompt(capability, modelName, draft), t("config.scriptEditor.briefCopied"))}
                                >
                                    {t("config.scriptEditor.copyBrief")}
                                </Button>
                            </StepBlock>
                            <section className="px-5 py-4">
                                <StepHeading index={3} title={t("config.scriptEditor.variables")} />
                                <div className="mb-2 flex items-center justify-between">
                                    <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                                        {t("config.scriptEditor.variablesHint")}
                                        {capability === "video" ? ` ${t("config.scriptEditor.variablesHintVideo")}` : ""}
                                    </p>
                                    <span className="shrink-0 text-[10px] text-stone-400">{t("config.scriptEditor.insert")}</span>
                                </div>
                                <div className="space-y-1.5">
                                    {variables.map((variable) => (
                                        <button
                                            key={variable.name}
                                            type="button"
                                            onClick={() => setDraft((current) => (current ? `${current}\n${variable.name}` : variable.name))}
                                            className="group block w-full rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-stone-200 hover:bg-white dark:hover:border-stone-700 dark:hover:bg-stone-800/60"
                                        >
                                            <div className="flex flex-wrap items-baseline gap-1.5">
                                                <code className="rounded bg-stone-200/80 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-stone-800 group-hover:bg-blue-100 group-hover:text-blue-700 dark:bg-stone-800 dark:text-stone-100 dark:group-hover:bg-blue-950 dark:group-hover:text-blue-300">
                                                    {variable.name}
                                                </code>
                                                <span className="font-mono text-[10px] text-stone-400">{variable.type}</span>
                                            </div>
                                            <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{variable.desc}</div>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        </div>
                    </aside>
                    <div className="flex h-full min-w-0 flex-1 flex-col bg-white dark:bg-stone-950">
                        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 px-4 py-2.5 dark:border-stone-800">
                            <div>
                                <div className="text-sm font-medium text-stone-800 dark:text-stone-100">{t("config.scriptEditor.editorTitle")}</div>
                                <div className="text-xs text-stone-500">{t("config.scriptEditor.editorHint")}</div>
                            </div>
                            <span className="shrink-0 text-[11px] text-stone-400">{hasScript ? t("config.scriptEditor.editorFilled") : t("config.scriptEditor.editorEmpty")}</span>
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden">
                            <CodeMirror
                                value={draft}
                                onChange={setDraft}
                                height="100%"
                                theme={isDarkMode() ? "dark" : "light"}
                                extensions={[javascript()]}
                                placeholder={t("config.scriptEditor.placeholder")}
                                style={{ height: "100%", fontSize: 13 }}
                                className="h-full [&_.cm-editor]:h-full [&_.cm-gutters]:border-none [&_.cm-scroller]:overflow-auto"
                            />
                        </div>
                    </div>
                </div>
                <footer className="flex shrink-0 items-start justify-between gap-3 border-t border-stone-200 px-6 py-3 dark:border-stone-800">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 whitespace-nowrap text-xs text-stone-400">{t("config.scriptEditor.startFromTemplate")}</span>
                            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                                {templates.map((template) => (
                                    <Button key={template.label} size="small" className="shrink-0" onClick={() => setDraft(template.script)}>
                                        {t("config.scriptEditor.insertTemplate", { name: template.label })}
                                    </Button>
                                ))}
                                <Button size="small" danger className="shrink-0" onClick={() => setDraft("")}>
                                    {t("config.scriptEditor.restoreDefault")}
                                </Button>
                            </div>
                        </div>
                        {gatewayGroup ? (
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 whitespace-nowrap text-xs text-stone-400">{t("config.scriptEditor.gatewayTemplates")}</span>
                                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                                    {gatewayLoading ? (
                                        <span className="shrink-0 text-xs text-stone-400">{t("config.scriptEditor.gatewayLoading")}</span>
                                    ) : gatewayError ? (
                                        <span className="min-w-0 truncate text-xs text-red-500" title={gatewayError}>
                                            {t("config.scriptEditor.gatewayError", { message: gatewayError })}
                                        </span>
                                    ) : gatewayTemplates === null ? (
                                        <span className="shrink-0 text-xs text-stone-400">{t("config.scriptEditor.gatewayIdle")}</span>
                                    ) : gatewayTemplates.length === 0 ? (
                                        <span className="shrink-0 text-xs text-stone-400">{t("config.scriptEditor.gatewayAllIncluded")}</span>
                                    ) : (
                                        gatewayTemplates.map((template) => (
                                            <Button key={template.name} size="small" className="shrink-0" onClick={() => setDraft(buildGatewayTemplateScript(template))}>
                                                {t("config.scriptEditor.insertTemplate", { name: template.title || template.name })}
                                            </Button>
                                        ))
                                    )}
                                </div>
                                <Button size="small" className="shrink-0" icon={<RefreshCw className="size-3.5" />} loading={gatewayLoading} onClick={() => void loadGatewayTemplates()}>
                                    {t("config.scriptEditor.gatewayFetch")}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button onClick={onClose}>{t("common.cancel")}</Button>
                        <Button
                            type="primary"
                            onClick={() => {
                                onSave(draft.trim());
                                onClose();
                            }}
                        >
                            {t("common.save")}
                        </Button>
                    </div>
                </footer>
            </div>
        </Modal>
    );
}

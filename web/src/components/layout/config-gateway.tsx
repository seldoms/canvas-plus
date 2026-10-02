import { App, Button, Form, Input } from "antd";
import type { TFunction } from "i18next";
import { Server, Wifi, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchGatewayHealth, fetchGatewayProviders, gatewayDefaultModels, planGatewayChannel, upsertGatewayChannel, type GatewayHealth } from "@/services/api/gateway";
import { defaultGatewayUrl, encodeChannelModel, modelOptionsFromChannels, normalizeGatewayUrl, useConfigStore } from "@/stores/use-config-store";

export function ConfigGateway() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const [testing, setTesting] = useState(false);
    const [onboarding, setOnboarding] = useState(false);
    const [health, setHealth] = useState<GatewayHealth | null>(null);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);

    const testGateway = async () => {
        setTesting(true);
        try {
            setHealth(await fetchGatewayHealth(config.gatewayUrl));
        } catch (error) {
            setHealth(null);
            message.error(error instanceof Error ? error.message : t("config.gateway.unreachable"));
        } finally {
            setTesting(false);
        }
    };

    const onboardGateway = async () => {
        setOnboarding(true);
        try {
            const plan = planGatewayChannel(await fetchGatewayProviders(config.gatewayUrl));
            if (!plan.models.length) {
                message.warning(t("config.gateway.onboardEmpty"));
                return;
            }
            modal.confirm({
                title: t("config.gateway.onboardTitle"),
                content: (
                    <div className="space-y-1 text-xs">
                        <div>{t("config.gateway.onboardSummary", plan.counts)}</div>
                        <div className="text-stone-500">{t("config.gateway.onboardHint")}</div>
                    </div>
                ),
                okText: t("config.gateway.onboard"),
                cancelText: t("common.cancel"),
                onOk: () => {
                    const state = useConfigStore.getState();
                    const { channels, channel } = upsertGatewayChannel(state.config.channels, state.config.gatewayUrl, plan.models);
                    updateConfig("channels", channels);
                    updateConfig("models", modelOptionsFromChannels(channels));
                    const defaults = gatewayDefaultModels(channel.models);
                    if (defaults.text) updateConfig("textModel", encodeChannelModel(channel.id, defaults.text));
                    if (defaults.image) updateConfig("imageModel", encodeChannelModel(channel.id, defaults.image));
                    if (defaults.video) updateConfig("videoModel", encodeChannelModel(channel.id, defaults.video));
                    message.success(t("config.gateway.onboardDone", plan.counts));
                },
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.gateway.unreachable"));
        } finally {
            setOnboarding(false);
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <Server className="size-4" />
                    {t("config.gateway.title")}
                </div>
                <div className="mt-1 text-xs text-stone-500">{t("config.gateway.description")}</div>
                <Form.Item label={t("config.gateway.address")} extra={t("config.gateway.addressDescription")} className="mt-3 mb-0">
                    <Input
                        value={config.gatewayUrl}
                        placeholder={defaultGatewayUrl()}
                        onChange={(event) => {
                            setHealth(null);
                            updateConfig("gatewayUrl", event.target.value);
                        }}
                        onBlur={(event) => updateConfig("gatewayUrl", normalizeGatewayUrl(event.target.value) || defaultGatewayUrl())}
                    />
                </Form.Item>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button icon={<Wifi className="size-4" />} loading={testing} onClick={() => void testGateway()}>
                        {t("config.gateway.test")}
                    </Button>
                    <Button type="primary" icon={<Zap className="size-4" />} loading={onboarding} onClick={() => void onboardGateway()}>
                        {t("config.gateway.onboard")}
                    </Button>
                </div>
                {health ? (
                    <div className="mt-3 space-y-1 text-xs">
                        <GatewayStatusRow label="LLM" ok={health.llm.ok} address={health.llm.baseUrl} error={health.llm.error} t={t} />
                        <GatewayStatusRow label="ComfyUI" ok={health.comfy.ok} address={health.comfy.baseUrl} error={health.comfy.error} t={t} />
                        <div className="text-stone-500">{t("config.gateway.queue", { running: health.queue.running, pending: health.queue.pending })}</div>
                    </div>
                ) : null}
                <div className="mt-3 text-xs text-stone-500">{t("config.gateway.channelHint")}</div>
            </section>
        </Form>
    );
}

function GatewayStatusRow({ label, ok, address, error, t }: { label: string; ok: boolean; address: string; error?: string; t: TFunction }) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-stone-700 dark:text-stone-200">{label}</span>
            <span className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{t(ok ? "config.gateway.connected" : "config.gateway.disconnected")}</span>
            <span className="min-w-0 truncate text-stone-500">{ok ? address : error || address}</span>
        </div>
    );
}

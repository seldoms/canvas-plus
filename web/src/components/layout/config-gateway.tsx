import { App, Button, Form, Input } from "antd";
import type { TFunction } from "i18next";
import { Server, Wifi } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchGatewayHealth, type GatewayHealth } from "@/services/api/gateway";
import { DEFAULT_GATEWAY_URL, normalizeGatewayUrl, useConfigStore } from "@/stores/use-config-store";

export function ConfigGateway() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [testing, setTesting] = useState(false);
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
                        placeholder={DEFAULT_GATEWAY_URL}
                        onChange={(event) => {
                            setHealth(null);
                            updateConfig("gatewayUrl", event.target.value);
                        }}
                        onBlur={(event) => updateConfig("gatewayUrl", normalizeGatewayUrl(event.target.value) || DEFAULT_GATEWAY_URL)}
                    />
                </Form.Item>
                <Button className="mt-3" icon={<Wifi className="size-4" />} loading={testing} onClick={() => void testGateway()}>
                    {t("config.gateway.test")}
                </Button>
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

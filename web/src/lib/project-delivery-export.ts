import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { buildDeliveryManifestMarkdown, buildDeliveryPackage, deliveryManifestFileName, deliveryZipName, type DeliveryEpisode, type DeliveryFile } from "@/lib/project-delivery";
import { createZip } from "@/lib/zip";
import { downloadArtifactBlob, fetchArtifactText, type ProjectDeliverySource } from "@/services/api/delivery";

/**
 * 交付包导出编排：把成片 / 封面 / 字幕（有则带）/ 拼接清单 + 一份可读交付清单打成 zip 下载。
 *
 * 单一实现，不做「导出器插件体系」。IO 全部委托 services/api/delivery（下载）与 lib/zip（打包），
 * 本文件只负责「按计划取字节 → 标记缺失 → 生成清单 → 打包」。
 * 大文件超限或下载失败只在清单里标记缺失，绝不静默丢弃。
 */

/** 单文件下载上限；超过则不读进内存，在清单里标记「文件过大」。 */
export const MAX_DELIVERY_FILE_BYTES = 512 * 1024 * 1024;

export type DeliveryProgress = { phase: "build" | "download" | "package"; label: string; done: number; total: number };

export type DeliveryExportResult = { episodes: number; files: number; missing: number; zipName: string };

export async function exportProjectDelivery(source: ProjectDeliverySource, options: { onProgress?: (progress: DeliveryProgress) => void } = {}): Promise<DeliveryExportResult> {
    const { onProgress } = options;
    const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string;

    onProgress?.({ phase: "build", label: t("projects.delivery.phaseBuild"), done: 0, total: 0 });
    const pkg = buildDeliveryPackage({ project: source.context.project, runs: source.runs }, new Date().toISOString());
    if (!pkg.episodes.length) throw new Error(t("projects.delivery.noFilm"));

    const entries: { name: string; data: BlobPart }[] = [];
    let total = pkg.episodes.reduce((sum, episode) => sum + episode.files.length, 0);
    let done = 0;

    for (const episode of pkg.episodes) {
        // 索引循环：处理拼接清单时可能追加「字幕」文件，追加后同轮继续取。
        for (let index = 0; index < episode.files.length; index += 1) {
            const file = episode.files[index];
            onProgress?.({ phase: "download", label: t("projects.delivery.phaseDownload", { name: baseName(file.slot) }), done, total });
            if (file.kind === "manifest") {
                await collectManifest(file, episode, entries, (added) => (total += added ? 1 : 0), t);
            } else {
                await collectBlob(file, entries, t);
            }
            done += 1;
        }
    }

    onProgress?.({ phase: "package", label: t("projects.delivery.phasePackage"), done: total, total });
    entries.unshift({ name: deliveryManifestFileName(), data: buildDeliveryManifestMarkdown(pkg) });
    const zip = await createZip(entries);
    const zipName = deliveryZipName(pkg);
    saveAs(zip, zipName);

    const files = pkg.episodes.reduce((sum, episode) => sum + episode.files.length, 0) + 1;
    const missing = pkg.episodes.reduce((sum, episode) => sum + episode.files.filter((item) => !item.included).length, 0);
    return { episodes: pkg.episodes.length, files, missing, zipName };
}

/** 下载拼接清单原文件；顺带从清单里发现字幕，追加为待下载的交付文件。 */
async function collectManifest(file: DeliveryFile, episode: DeliveryEpisode, entries: { name: string; data: BlobPart }[], bump: (added: boolean) => void, t: (key: string, opts?: Record<string, unknown>) => string) {
    const result = await fetchArtifactText(file.sourceUrl || "");
    if (!result.ok) {
        file.included = false;
        file.reason = result.reason;
        return;
    }
    entries.push({ name: file.slot, data: result.text });
    file.included = true;
    file.bytes = result.text.length;
    const subtitle = discoverSubtitle(result.text, episode, t);
    if (subtitle) {
        episode.files.push(subtitle);
        bump(true);
    }
}

/** 从拼接清单的 `subtitles` 字段推导字幕产物地址（与成片同在交付目录下）。 */
function discoverSubtitle(manifestText: string, episode: DeliveryEpisode, t: (key: string, opts?: Record<string, unknown>) => string): DeliveryFile | null {
    let subtitles = "";
    try {
        const parsed = JSON.parse(manifestText) as { subtitles?: unknown };
        subtitles = typeof parsed?.subtitles === "string" ? parsed.subtitles : "";
    } catch {
        return null;
    }
    const name = subtitles.split(/[\\/]/).pop() || "";
    if (!name) return null;
    const dot = name.lastIndexOf(".");
    const ext = dot > -1 ? name.slice(dot + 1).toLowerCase() : "srt";
    const sourceUrl = episode.deliverableId ? `/api/artifacts/${encodeURIComponent(episode.deliverableId)}/${encodeURIComponent(name)}` : "";
    return {
        kind: "subtitle",
        slot: `${episode.slotPrefix}-subtitles.${ext}`,
        sourceUrl,
        included: false,
        reason: sourceUrl ? undefined : t("projects.delivery.manifest.subtitleUnresolved"),
    };
}

async function collectBlob(file: DeliveryFile, entries: { name: string; data: BlobPart }[], t: (key: string, opts?: Record<string, unknown>) => string) {
    const result = await downloadArtifactBlob(file.sourceUrl || "", MAX_DELIVERY_FILE_BYTES);
    if (!result.ok) {
        file.included = false;
        file.reason = result.reason || t("projects.delivery.unreachable");
        return;
    }
    entries.push({ name: file.slot, data: result.blob });
    file.included = true;
    file.bytes = result.bytes;
}

function baseName(path: string) {
    return path.split("/").pop() || path;
}

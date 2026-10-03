import i18n from "@/i18n";
import type { Plan } from "@/types/domain";

/**
 * 「交付包」纯逻辑：把项目上下文 + 关联 run 的产物信息整理成一份可读交付清单（Markdown），
 * 并给出每个文件的打包计划（zip 内路径 + 来源 URL）。
 *
 * 本模块零 IO、零 React：只读传入的数据、只产出数据结构与字符串，便于单测。
 * 产物字节下载与打包在 `lib/project-delivery-export.ts`，请求在 `services/api/delivery.ts`。
 *
 * 数据只来自现有接口：`/api/projects/:id/context`（project.title/styleAnchor/plan/episodes）
 * 与 `/api/pipeline/runs/:id` 的阶段输出（storyboard.shots / keyframe.frames / assembly）。
 */

/** 只声明用到的字段子集，避免 lib 依赖 services 的具体类型。 */
export type DeliverySourceProject = { id: string; title: string; styleAnchor: string; plan: Plan };
export type DeliverySourceRun = {
    id: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    stages?: Record<string, { output?: unknown } | undefined>;
};
export type DeliverySource = { project: DeliverySourceProject; runs: DeliverySourceRun[] };

export type DeliveryFileKind = "film" | "cover" | "subtitle" | "manifest";

/** 打包计划里的一个文件；included/reason 由导出过程回填（缺失也要留在清单里）。 */
export type DeliveryFile = {
    kind: DeliveryFileKind;
    /** zip 内相对路径。 */
    slot: string;
    /** 产物来源 URL（`/api/artifacts/...`）；缺失时为 undefined。 */
    sourceUrl?: string;
    bytes?: number;
    included: boolean;
    reason?: string;
};

/** 一镜所用的参考图（关键帧产物，图生视频的 INPUT_IMAGE）。 */
export type DeliveryReferenceImage = { role: string; url: string; status: string };

export type DeliveryShot = {
    index: number;
    shotId: string;
    durationSec: number;
    prompt: string;
    referenceImages: DeliveryReferenceImage[];
};

export type DeliveryEpisode = {
    runId: string;
    label: string;
    /** zip 内文件名的公共前缀（含集号），如 `成片/01-第1集`。 */
    slotPrefix: string;
    durationSec: number;
    generatedAt: string;
    deliverableId: string;
    shots: DeliveryShot[];
    files: DeliveryFile[];
};

export type DeliveryPackage = {
    projectId: string;
    projectTitle: string;
    styleAnchor: string;
    plan: Plan;
    plannedEpisodeCount: number;
    exportedAt: string;
    episodes: DeliveryEpisode[];
};

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** zip 内文件名安全化：替换 Windows/Unix 非法字符。 */
export function safeName(value: string) {
    const cleaned = value.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim();
    return cleaned || i18n.t("projects.delivery.untitled");
}

/** 从产物 URL 取扩展名，取不到用 fallback。 */
function extFromUrl(url: string, fallback: string) {
    const base = url.split("?")[0].split("#")[0].split("/").pop() || "";
    const dot = base.lastIndexOf(".");
    return dot > -1 ? base.slice(dot + 1).toLowerCase() : fallback;
}

/** 把完成成片的 run 整理成交付包；缺成片的 run 直接跳过。 */
export function buildDeliveryPackage(source: DeliverySource, now: string): DeliveryPackage {
    const project = source.project;
    const episodes: DeliveryEpisode[] = [];
    const seen = new Set<string>();

    for (const run of source.runs) {
        const assembly = readAssembly(run);
        if (!assembly) continue;
        const key = assembly.deliverableId || run.id;
        if (seen.has(key)) continue;
        seen.add(key);
        episodes.push(buildEpisode(run, assembly, episodes.length + 1));
    }

    return {
        projectId: project.id,
        projectTitle: project.title || i18n.t("projects.delivery.untitled"),
        styleAnchor: project.styleAnchor || "",
        plan: project.plan,
        plannedEpisodeCount: number(project.plan?.episodeCount, 0),
        exportedAt: now,
        episodes,
    };
}

type AssemblyInfo = { url: string; coverUrl: string | null; manifestUrl: string | null; deliverableId: string; durationSec: number; generatedAt: string; clips: unknown[] };

/** 只有拿到可访问成片地址才算交付物；`status !== "done"` 或没 url 的 run 不出包。 */
function readAssembly(run: DeliverySourceRun): AssemblyInfo | null {
    const stage = run.stages?.assembly;
    const output = record(stage?.output);
    const assembly = record(output?.assembly);
    if (!assembly || assembly.status !== "done") return null;
    const url = text(assembly.url);
    if (!url) return null;
    const info = record(assembly.info);
    const clips = list(output?.clips);
    const clipSeconds = clips.reduce<number>((sum, clip) => sum + number(record(clip)?.durationSec, 0), 0);
    return {
        url,
        coverUrl: text(assembly.coverUrl) || null,
        manifestUrl: text(assembly.manifestUrl) || null,
        deliverableId: text(assembly.deliverableId) || run.id,
        durationSec: number(info?.durationSec, clipSeconds),
        generatedAt: text(assembly.finishedAt) || run.updatedAt || run.createdAt || "",
        clips,
    };
}

function buildEpisode(run: DeliverySourceRun, assembly: AssemblyInfo, order: number): DeliveryEpisode {
    const frames = list(record(run.stages?.keyframe?.output)?.frames);
    const prefix = `${i18n.t("projects.delivery.filmDir")}/${String(order).padStart(2, "0")}-${safeName(run.title || run.id)}`;
    const files: DeliveryFile[] = [{ kind: "film", slot: `${prefix}.${extFromUrl(assembly.url, "mp4")}`, sourceUrl: assembly.url, included: false }];
    if (assembly.coverUrl) files.push({ kind: "cover", slot: `${prefix}-cover.${extFromUrl(assembly.coverUrl, "jpg")}`, sourceUrl: assembly.coverUrl, included: false });
    if (assembly.manifestUrl) files.push({ kind: "manifest", slot: `${prefix}-assembly-manifest.json`, sourceUrl: assembly.manifestUrl, included: false });

    return {
        runId: run.id,
        label: run.title || run.id,
        slotPrefix: prefix,
        durationSec: assembly.durationSec,
        generatedAt: assembly.generatedAt,
        deliverableId: assembly.deliverableId,
        shots: collectShots(run, frames, assembly.clips),
        files,
    };
}

/** 逐镜数据优先取分镜阶段产物；缺失时退回片段清单，提示词从关键帧补齐。 */
function collectShots(run: DeliverySourceRun, frames: unknown[], clips: unknown[]): DeliveryShot[] {
    const framesByShot = new Map<string, unknown[]>();
    for (const frame of frames) {
        const shotId = text(record(frame)?.shotId);
        if (!shotId) continue;
        framesByShot.set(shotId, [...(framesByShot.get(shotId) ?? []), frame]);
    }

    const storyboardShots = list(record(run.stages?.storyboard?.output)?.shots);
    if (storyboardShots.length) {
        return storyboardShots.map((shot, position) => {
            const item = record(shot) ?? {};
            const shotId = text(item.id);
            return {
                index: number(item.index, position + 1),
                shotId,
                durationSec: number(item.durationSec, 0),
                prompt: text(item.prompt),
                referenceImages: referenceImages(framesByShot.get(shotId) ?? []),
            };
        });
    }

    // 兜底：分镜阶段缺产物时用片段清单的 shotId，提示词取该镜首帧的 prompt。
    return clips.map((clip, position) => {
        const item = record(clip) ?? {};
        const shotId = text(item.shotId);
        const shotFrames = framesByShot.get(shotId) ?? [];
        return {
            index: position + 1,
            shotId,
            durationSec: number(item.durationSec, 0),
            prompt: text(record(shotFrames[0])?.prompt),
            referenceImages: referenceImages(shotFrames),
        };
    });
}

/** 一镜的参考图 = 该镜已有关键帧产物（图生视频的输入图）。未出图的关键帧不算参考图。 */
function referenceImages(frames: unknown[]): DeliveryReferenceImage[] {
    const images: DeliveryReferenceImage[] = [];
    for (const frame of frames) {
        const item = record(frame) ?? {};
        const url = text(item.artifactUrl);
        if (!url) continue;
        images.push({ role: text(item.role) || text(item.id), url, status: text(item.status) });
    }
    return images;
}

/** 生成可读交付清单（Markdown）：剧名、集数、每集时长、风格锚点与规划参数、生成时间、逐镜提示词与参考图、缺失文件。 */
export function buildDeliveryManifestMarkdown(pkg: DeliveryPackage): string {
    const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
    const lines: string[] = [];
    const plan = pkg.plan;

    lines.push(`# ${t("projects.delivery.manifest.title")} · ${pkg.projectTitle}`, "");
    lines.push(`- ${t("projects.delivery.manifest.projectId")}: ${pkg.projectId}`);
    lines.push(`- ${t("projects.delivery.manifest.projectTitle")}: ${pkg.projectTitle}`);
    lines.push(`- ${t("projects.delivery.manifest.plannedEpisodes")}: ${pkg.plannedEpisodeCount}`);
    lines.push(`- ${t("projects.delivery.manifest.deliveredEpisodes")}: ${pkg.episodes.length}`);
    lines.push(`- ${t("projects.delivery.manifest.styleAnchor")}: ${pkg.styleAnchor || t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.exportedAt")}: ${pkg.exportedAt}`);
    lines.push("", `### ${t("projects.delivery.manifest.plan")}`, "");
    lines.push(`- ${t("projects.delivery.manifest.genre")}: ${plan?.genre || t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.tone")}: ${plan?.tone || t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.visualStyle")}: ${plan?.visualStyle || t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.ratio")}: ${plan?.ratio || t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.episodeDurationSec")}: ${plan?.episodeDurationSec ?? t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.dramaMode")}: ${plan?.dramaMode || t("projects.delivery.manifest.none")}`);
    lines.push(`- ${t("projects.delivery.manifest.audience")}: ${plan?.audience || t("projects.delivery.manifest.none")}`);

    lines.push("", `## ${t("projects.delivery.manifest.sectionFiles")}`, "");
    lines.push(
        `| ${t("projects.delivery.manifest.colIndex")} | ${t("projects.delivery.manifest.colRunId")} | ${t("projects.delivery.manifest.colDuration")} | ${t("projects.delivery.manifest.generatedAt")} | ${t("projects.delivery.manifest.colStatus")} |`,
        "| --- | --- | --- | --- | --- |",
    );
    pkg.episodes.forEach((episode, position) => {
        lines.push(`| ${position + 1} | ${episode.runId} | ${duration(episode.durationSec, t)} | ${episode.generatedAt || t("projects.delivery.manifest.none")} | ${fileStatuses(episode, t)} |`);
    });

    for (const [position, episode] of pkg.episodes.entries()) {
        lines.push("", `## ${t("projects.delivery.manifest.episodeLabel", { index: position + 1 })} · ${episode.label}`, "");
        lines.push(`- ${t("projects.delivery.manifest.colRunId")}: ${episode.runId}`);
        lines.push(`- ${t("projects.delivery.manifest.colDuration")}: ${duration(episode.durationSec, t)}`);
        lines.push(`- ${t("projects.delivery.manifest.generatedAt")}: ${episode.generatedAt || t("projects.delivery.manifest.none")}`);
        lines.push(`- ${t("projects.delivery.manifest.sectionShots")}:`);
        if (!episode.shots.length) {
            lines.push(`  ${t("projects.delivery.manifest.none")}`);
            continue;
        }
        lines.push(
            "",
            `| ${t("projects.delivery.manifest.colShotIndex")} | ${t("projects.delivery.manifest.colShotId")} | ${t("projects.delivery.manifest.colDuration")} | ${t("projects.delivery.manifest.colPrompt")} | ${t("projects.delivery.manifest.colRefs")} |`,
            "| --- | --- | --- | --- | --- |",
        );
        for (const shot of episode.shots) {
            const refs = shot.referenceImages.length ? shot.referenceImages.map((image) => `${image.role}: ${image.url}${image.status ? ` (${image.status})` : ""}`).join("<br>") : t("projects.delivery.manifest.none");
            lines.push(`| ${shot.index} | ${shot.shotId} | ${duration(shot.durationSec, t)} | ${escapeCell(shot.prompt)} | ${escapeCell(refs)} |`);
        }
    }

    const missing = pkg.episodes.flatMap((episode) => episode.files.filter((file) => !file.included));
    lines.push("", `## ${t("projects.delivery.manifest.sectionMissing")}`, "");
    if (!missing.length) {
        lines.push(`- ${t("projects.delivery.manifest.missingNone")}`);
    } else {
        for (const file of missing) lines.push(`- \`${file.slot}\`: ${file.reason || t("projects.delivery.manifest.none")}`);
    }

    return `${lines.join("\n")}\n`;
}

export function deliveryZipName(pkg: DeliveryPackage) {
    return `${safeName(pkg.projectTitle)}-${i18n.t("projects.delivery.packageName")}.zip`;
}

export function deliveryManifestFileName() {
    return `${i18n.t("projects.delivery.manifestFile")}.md`;
}

function duration(seconds: number, t: (key: string, options?: Record<string, unknown>) => string) {
    return seconds > 0 ? t("projects.delivery.manifest.seconds", { value: Math.round(seconds) }) : t("projects.delivery.manifest.none");
}

/** 每集一行里的「成片/封面/字幕/清单」状态串。 */
function fileStatuses(episode: DeliveryEpisode, t: (key: string, options?: Record<string, unknown>) => string) {
    const labels: Array<[DeliveryFileKind, string]> = [
        ["film", t("projects.delivery.manifest.colFilm")],
        ["cover", t("projects.delivery.manifest.colCover")],
        ["subtitle", t("projects.delivery.manifest.colSubtitles")],
        ["manifest", t("projects.delivery.manifest.colManifest")],
    ];
    return labels
        .map(([kind, label]) => {
            const file = episode.files.find((item) => item.kind === kind);
            if (!file) return `${label}: —`;
            return `${label}: ${file.included ? "✓" : "✗"}`;
        })
        .join(" / ");
}

/** Markdown 表格单元格转义：换行折成空格、竖线转义。 */
function escapeCell(value: string) {
    return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

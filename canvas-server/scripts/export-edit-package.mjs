#!/usr/bin/env node
/**
 * 自动粗剪 + 导出「剪映/达芬奇素材包」独立脚本（不改任何服务代码、不需要网关在跑）。
 *
 *   node scripts/export-edit-package.mjs --run run-murvf1vq-aqyqm [--allow-partial]
 *   node scripts/export-edit-package.mjs --run <id> --episode ep1 --transition fade
 *   node scripts/export-edit-package.mjs --run <id> --from package        # 后期失败后只重打包
 *   node scripts/export-edit-package.mjs --run <id> --json                 # 机器可读输出
 *
 * 缺片段的镜头默认直接报错并列出「缺第几段、缺多长」；--allow-partial 才允许出半条片（manifest 会显式标注）。
 * 产物：<dataDir>/artifacts/edit-export-<runId>/ 下：plan.json、package/、<pkgId>.zip、export.log、export-manifest.json。
 * 单步重跑：--from plan|assemble|package 只跑该步及之后，前序结果从磁盘读回，中间产物与日志原地保留。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { exportDeliveryPackage, MissingClipsError } from "../src/edit-export.js";
import { safeJoin } from "../src/files.js";

const STEP_ORDER = ["plan", "assemble", "package"];
const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);

const runId = flag("--run");
if (!runId) {
    console.error("用法：node scripts/export-edit-package.mjs --run <runId> [--episode <id>] [--allow-partial] [--from plan|assemble|package]");
    process.exit(2);
}

const config = loadConfig();
const runPath = safeJoin(config.dataDir, "runs", runId, "run.json");
if (!runPath || !existsSync(runPath)) {
    console.error(`找不到 run：${runPath || runId}`);
    process.exit(2);
}
const run = JSON.parse(readFileSync(runPath, "utf8"));

const from = flag("--from");
const steps = from ? STEP_ORDER.slice(Math.max(0, STEP_ORDER.indexOf(from))) : STEP_ORDER;
const quality = flag("--quality") || "standard";
const transition = flag("--transition");

try {
    const result = await exportDeliveryPackage({
        config,
        run,
        episodeId: flag("--episode") || null,
        allowPartial: has("--allow-partial"),
        transition: transition || null,
        options: {
            quality,
            cover: !has("--no-cover"),
            burnSubtitles: !has("--no-burn"),
            id: flag("--id") || undefined,
        },
        steps,
    });

    if (has("--json")) {
        console.log(
            JSON.stringify(
                {
                    status: result.status,
                    pkgId: result.pkgId,
                    zipPath: result.zipPath,
                    zipBytes: result.zipBytes,
                    entries: result.entries?.map((entry) => entry.name) || [],
                    missing: result.missing,
                    episodes: (result.episodes || []).map((episode) => ({
                        episodeId: episode.episodeId,
                        finalFile: episode.finalFile || null,
                        segments: episode.segments?.length ?? 0,
                        missing: episode.missing?.length ?? 0,
                        durationSec: episode.durationSec ?? null,
                    })),
                },
                null,
                2,
            ),
        );
    } else {
        console.log(`✅ 导出完成：${result.zipPath}（${result.zipBytes} 字节，${result.entries?.length || 0} 个条目）`);
        for (const episode of result.episodes || []) {
            console.log(`   - ${episode.episodeId}：成片 ${episode.finalFile || "(无)"}，片段 ${episode.segments?.length ?? 0} 段，缺 ${episode.missing?.length ?? 0} 段`);
        }
        if (result.missing?.length) {
            console.log(`⚠️  partial：缺 ${result.missing.length} 段（见 manifest.json 的 missing）`);
        }
        console.log(`   工作目录：${result.workDir}`);
        if (result.logPath) console.log(`   日志：${result.logPath}`);
    }
} catch (error) {
    if (error instanceof MissingClipsError || error?.code === "MISSING_CLIPS") {
        console.error(`❌ ${error.message}`);
        console.error("   如需强出行半条片（会显式标注 partial），加 --allow-partial。");
        process.exit(3);
    }
    console.error(`❌ 导出失败：${error?.message || error}`);
    process.exit(1);
}

/**
 * 运行审计日志（追加式）。
 *
 * 依据 `docs/content/docs/progress/spec-kit-adoption-plan.md`（P1：给 run 加 `state.json` + `log.jsonl` 追加式审计）
 * 与 `development-plan.md` §13.8/§13.9（发布包要能回答"这个版本由哪一版脚本、哪一版角色设定、哪一套模型产生"）。
 *
 * 只追加、不重写：run.json 内嵌整本小说，逐次全量重写代价高（同 pipeline.js 把进度写到独立小文件的理由）。
 * 一行一个 JSON，字段固定；读取时只取尾部若干行。审计写入失败**绝不阻断生产**，只落 console.warn。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUN_LOG_FILE = "log.jsonl";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

export function runLogPath(runsDir, runId) {
    return join(String(runsDir), String(runId), RUN_LOG_FILE);
}

/**
 * 追加一条审计记录。
 * @param {string} runsDir
 * @param {string} runId
 * @param {{ op: string, actor?: string, stage?: string, revision?: number, ok?: boolean, message?: string, errors?: string[] }} entry
 */
export function appendRunLog(runsDir, runId, entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), actor: "local", ...entry });
    const file = runLogPath(runsDir, runId);
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${line}\n`);
        return true;
    } catch (error) {
        console.warn(`[run-log] 写入失败（不影响生成）：${error.message}`);
        return false;
    }
}

/** 读最近 limit 条（时间正序）；坏行跳过，文件不存在返回空数组。 */
export function readRunLog(runsDir, runId, limit = DEFAULT_LIMIT) {
    const file = runLogPath(runsDir, runId);
    if (!existsSync(file)) return [];
    const size = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const lines = String(readFileSync(file, "utf8")).split("\n").filter(Boolean);
    return lines.slice(-size).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
}

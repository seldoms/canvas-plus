// 分镜工作台主面板:动作条 + 设置条 + 镜头卡片列表。
// 编辑采用本地 state 先行、停顿 500ms 后提交 metadata 的模式,避免每次按键都全画布重渲染。
import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CSSProperties } from "react";
import type { CanvasNodeContext, CanvasNodePanelProps, ModelCapability, ModelOption } from "@infinite-canvas/plugin-sdk";
import { REWRITE_PROMPT, SHOT_SIZES, STORYBOARD_PROMPT, checkShot, emptyShot, parseStoryboard, readStoryboard, reindex, stripCodeFence, type Shot, type ShotIssue, type Storyboard } from "./storyboard";

type Settings = { textModel: string; imageModel: string; videoModel: string; count: number; size: string };
const SETTINGS_KEY = "settings";
const SIZE_OPTIONS = ["auto", "1024x1024", "768x1344", "864x1536", "1536x864"];
const ERROR_COLOR = "#ef4444";
const WARN_COLOR = "#f59e0b";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function safeListModels(ctx: CanvasNodeContext, capability: ModelCapability): ModelOption[] {
    try {
        return ctx.ai.listModels(capability);
    } catch {
        return [];
    }
}

function safeDefaultModel(ctx: CanvasNodeContext, capability: ModelCapability): string {
    try {
        return ctx.ai.defaultModel(capability);
    } catch {
        return "";
    }
}

export function StoryboardPanel({ ctx, onClose }: CanvasNodePanelProps) {
    const theme = ctx.theme;
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;

    // ---- 分镜数据:本地 draft 先行,停顿后提交;无 pending 提交时跟随宿主(撤销/重做) ----
    const committedJson = JSON.stringify(ctx.node.metadata?.storyboard ?? null);
    const committed = readStoryboard(ctx.node.metadata?.storyboard);
    const [draft, setDraft] = useState<Storyboard | null>(null);
    const board = draft ?? committed;
    const commitTimer = useRef<number | null>(null);
    const draftRef = useRef<Storyboard | null>(null);
    draftRef.current = draft;

    const commitNow = (next: Storyboard) => {
        if (commitTimer.current) {
            clearTimeout(commitTimer.current);
            commitTimer.current = null;
        }
        setDraft(null);
        ctxRef.current.updateMetadata({ storyboard: next as unknown as Record<string, unknown> });
    };
    const scheduleCommit = (next: Storyboard) => {
        setDraft(next);
        if (commitTimer.current) clearTimeout(commitTimer.current);
        commitTimer.current = window.setTimeout(() => {
            commitTimer.current = null;
            ctxRef.current.updateMetadata({ storyboard: next as unknown as Record<string, unknown> });
            setDraft(null);
        }, 500);
    };
    // 卸载(关闭面板)时把未提交的编辑立即写入
    useEffect(
        () => () => {
            if (commitTimer.current) {
                clearTimeout(commitTimer.current);
                commitTimer.current = null;
                if (draftRef.current) ctxRef.current.updateMetadata({ storyboard: draftRef.current as unknown as Record<string, unknown> });
            }
        },
        [],
    );
    useEffect(() => {
        if (!commitTimer.current) setDraft(null);
    }, [committedJson]);

    // ---- 设置(插件私有持久化) ----
    const [settings, setSettings] = useState<Settings>({ textModel: "", imageModel: "", videoModel: "", count: 2, size: "auto" });
    useEffect(() => {
        let alive = true;
        void ctx.storage
            .get<Partial<Settings>>(SETTINGS_KEY)
            .catch(() => null)
            .then((saved) => {
                if (!alive) return;
                const next: Settings = { textModel: "", imageModel: "", videoModel: "", count: 2, size: "auto", ...(saved || {}) };
                if (!next.textModel) next.textModel = safeDefaultModel(ctxRef.current, "text");
                if (!next.imageModel) next.imageModel = safeDefaultModel(ctxRef.current, "image");
                // 生视频默认优先选 H3 参考图生视频（只有关键帧图片），再退回参考视频模板，最后退回宿主默认视频模型
                if (!next.videoModel)
                    next.videoModel =
                        safeListModels(ctxRef.current, "video").find((m) => m.value.includes("video_h3_ref2v_image"))?.value ||
                        safeListModels(ctxRef.current, "video").find((m) => m.value.includes("video_h3_ref2v"))?.value ||
                        safeDefaultModel(ctxRef.current, "video");
                setSettings(next);
            });
        return () => {
            alive = false;
        };
    }, []);
    const updateSettings = (patch: Partial<Settings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            void ctxRef.current.storage.set(SETTINGS_KEY, next);
            return next;
        });
    };

    // ---- 动作条状态 ----
    const [generating, setGenerating] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [rawOutput, setRawOutput] = useState<string | null>(null);
    const [issueMap, setIssueMap] = useState<Record<string, ShotIssue[]>>({});
    const issueCount = Object.keys(issueMap).length;

    // ---- 镜头结构操作(增删调序后重排 id/index) ----
    const mutateShots = (fn: (shots: Shot[]) => Shot[]) => scheduleCommit({ ...board, shots: reindex(fn(board.shots)) });
    const updateShot = (id: string, patch: Partial<Shot>) => mutateShots((shots) => shots.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const moveShot = (id: string, dir: -1 | 1) =>
        mutateShots((shots) => {
            const i = shots.findIndex((s) => s.id === id);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= shots.length) return shots;
            const next = [...shots];
            [next[i], next[j]] = [next[j], next[i]];
            return next;
        });
    const insertShot = (id: string) =>
        mutateShots((shots) => {
            const i = shots.findIndex((s) => s.id === id);
            const shot: Shot = { ...emptyShot(), id: "", index: 0 };
            return [...shots.slice(0, i + 1), shot, ...shots.slice(i + 1)];
        });
    const removeShot = (id: string) => mutateShots((shots) => shots.filter((s) => s.id !== id));

    // ---- 原文文件导入(拖入/点选多个文本文件,按文件名自然排序拼接) ----
    const TEXT_FILE_RE = /\.(txt|md|markdown|srt|ass|csv|json|text)$/i;
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);
    const [dragOver, setDragOver] = useState(false);

    const importFiles = async (files: File[]) => {
        const accepted = files.filter((f) => TEXT_FILE_RE.test(f.name) || f.type.startsWith("text/"));
        const rejected = files.length - accepted.length;
        if (!accepted.length) {
            setError("没有可导入的文本文件(支持 txt/md/srt 等文本格式)");
            return;
        }
        setImporting(true);
        setError(null);
        try {
            const sorted = [...accepted].sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
            const parts = await Promise.all(sorted.map(async (f) => `【${f.name}】\n${(await f.text()).trim()}`));
            commitNow({ ...board, sourceFiles: sorted.map((f) => f.name), sourceText: parts.join("\n\n") });
            setNotice(`已导入 ${sorted.length} 个文件(按文件名排序)${rejected ? `，忽略 ${rejected} 个非文本文件` : ""}，将作为分镜原文`);
        } catch (e) {
            setError(`读取文件失败：${errorText(e)}`);
        }
        setImporting(false);
    };
    const clearSourceFiles = () => {
        commitNow({ ...board, sourceFiles: undefined, sourceText: undefined });
        setNotice("已清除导入的文件，改回使用上游连接节点的文本");
    };

    // ---- 生成分镜(LLM) ----
    const generateStoryboard = async () => {
        const upstreamText = ctx
            .getUpstream()
            .map((node) => {
                const meta = node.metadata || {};
                // 与宿主内置文本节点 resource 口径一致：正文 content 优先，提示词面板 prompt 兜底
                return (meta.content as string | undefined) || (meta.prompt as string | undefined) || "";
            })
            .filter((text) => text.trim())
            .join("\n\n");
        // 导入的文件原文优先于上游连接节点
        const sourceText = board.sourceText?.trim() ? board.sourceText : upstreamText;
        if (!sourceText.trim()) {
            setError("请先拖入剧本/小说文件，或把包含剧本/小说的文本节点连接到本节点");
            return;
        }
        setGenerating(true);
        setProgress(0);
        setError(null);
        setNotice(null);
        setRawOutput(null);
        let text = "";
        try {
            const result = await ctx.ai.generateText(STORYBOARD_PROMPT.replace("{{上游文本}}", sourceText), {
                model: settings.textModel || undefined,
                onDelta: (t) => setProgress(t.length),
            });
            text = result.text;
        } catch (e) {
            setError(`生成分镜失败：${errorText(e)}`);
            setGenerating(false);
            return;
        }
        try {
            const next = parseStoryboard(text);
            if (!next.shots.length) throw new Error("模型没有返回任何镜头");
            commitNow(next);
            setNotice(`已生成 ${next.shots.length} 个镜头`);
        } catch {
            setRawOutput(text);
            setError("解析分镜 JSON 失败,可查看原始输出后重试");
        }
        setGenerating(false);
    };

    // ---- 体检 ----
    const runCheck = () => {
        const map: Record<string, ShotIssue[]> = {};
        board.shots.forEach((shot) => {
            const list = checkShot(shot);
            if (list.length) map[shot.id] = list;
        });
        setIssueMap(map);
        setNotice(Object.keys(map).length ? `${Object.keys(map).length} 个镜头有问题` : "全部镜头通过体检");
        setError(null);
    };

    // ---- 试拍 / 批量关键帧 ----
    const gridPosition = (i: number) => ({ x: ctx.node.position.x + ctx.node.width + 96 + (i % 3) * 364, y: ctx.node.position.y + Math.floor(i / 3) * 264 });
    const shotImageMetadata = (shot: Shot) => ({ model: settings.imageModel || undefined, size: settings.size, count: settings.count, prompt: shot.prompt });
    const linkedImageNode = (shot: Shot) => {
        const node = shot.imageNodeId ? ctx.getNode(shot.imageNodeId) : null;
        return node && node.type === "image" ? node : null;
    };
    const linkShot = (shotId: string, nodeId: string) => commitNow({ ...board, shots: board.shots.map((s) => (s.id === shotId ? { ...s, imageNodeId: nodeId } : s)) });

    const testShot = (shot: Shot) => {
        if (!shot.prompt.trim()) {
            setError(`镜头 ${shot.index} 还没有英文 prompt,无法试拍`);
            return;
        }
        setError(null);
        const linked = linkedImageNode(shot);
        if (linked) {
            // 宿主对已有内容的图片节点做 run_generation 会走图生图;先清空内容使其在原地重新生成
            ctx.applyOps([
                { type: "update_node", id: linked.id, metadata: { content: "", images: [], primaryImageId: undefined, storageKey: undefined, status: "idle", errorDetails: undefined, ...shotImageMetadata(shot) } },
                { type: "run_generation", nodeId: linked.id, mode: "image", prompt: shot.prompt },
            ]);
            setNotice(`镜头 ${shot.index} 已重新提交试拍`);
            return;
        }
        let id = `sb-${ctx.node.id}-${shot.id}`;
        if (ctx.getNode(id)) id = `${id}-${Date.now()}`;
        const pos = gridPosition(shot.index - 1);
        ctx.applyOps([
            { type: "add_node", id, nodeType: "image", title: `镜 ${shot.index} 关键帧`, x: pos.x, y: pos.y, metadata: { status: "idle", ...shotImageMetadata(shot) } },
            { type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: id },
            { type: "run_generation", nodeId: id, mode: "image", prompt: shot.prompt },
        ]);
        linkShot(shot.id, id);
        setNotice(`镜头 ${shot.index} 已提交试拍`);
    };

    const batchGenerate = () => {
        const ops: Parameters<CanvasNodeContext["applyOps"]>[0] = [];
        const links: Record<string, string> = {};
        let skippedExisting = 0;
        let skippedIssue = 0;
        board.shots.forEach((shot, i) => {
            if (linkedImageNode(shot)) {
                skippedExisting++;
                return;
            }
            if (checkShot(shot).length) {
                skippedIssue++;
                return;
            }
            let id = `sb-${ctx.node.id}-${shot.id}`;
            if (ctx.getNode(id)) id = `${id}-${Date.now()}`;
            const pos = gridPosition(i);
            ops.push(
                { type: "add_node", id, nodeType: "image", title: `镜 ${shot.index} 关键帧`, x: pos.x, y: pos.y, metadata: { status: "idle", ...shotImageMetadata(shot) } },
                { type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: id },
                { type: "run_generation", nodeId: id, mode: "image", prompt: shot.prompt },
            );
            links[shot.id] = id;
        });
        const created = Object.keys(links).length;
        if (created) {
            ctx.applyOps(ops);
            commitNow({ ...board, shots: board.shots.map((s) => (links[s.id] ? { ...s, imageNodeId: links[s.id] } : s)) });
        }
        const parts = [`已提交 ${created} 个镜头的关键帧生成`];
        if (skippedIssue) parts.push(`跳过 ${skippedIssue} 个体检未通过`);
        if (skippedExisting) parts.push(`跳过 ${skippedExisting} 个已有关键帧`);
        setNotice(parts.join("，"));
        setError(null);
    };

    // ---- 单镜/批量生视频(宿主 generateNode 会把上游连接的图片节点作为首帧/参考图) ----
    const linkedVideoNode = (shot: Shot) => {
        const node = shot.videoNodeId ? ctx.getNode(shot.videoNodeId) : null;
        return node && node.type === "video" ? node : null;
    };
    const shotVideoPrompt = (shot: Shot) => [shot.action.trim(), shot.camera.trim()].filter(Boolean).join("；");
    const shotVideoMetadata = (shot: Shot) => ({ model: settings.videoModel || undefined, seconds: String(shot.durationSec), prompt: shotVideoPrompt(shot) });
    const videoOpsForShot = (shot: Shot): { ops: Parameters<CanvasNodeContext["applyOps"]>[0]; createdId?: string } | null => {
        const image = linkedImageNode(shot);
        if (!image?.metadata?.content) return null;
        const prompt = shotVideoPrompt(shot);
        const metadata = shotVideoMetadata(shot);
        const existing = linkedVideoNode(shot);
        if (existing) {
            // 与试拍同理:宿主只对「空视频节点」原地重新生成,先清空内容/任务再 run_generation
            return {
                ops: [
                    { type: "update_node", id: existing.id, metadata: { content: "", storageKey: undefined, videoTaskId: undefined, status: "idle", errorDetails: undefined, ...metadata } },
                    { type: "connect_nodes", fromNodeId: image.id, toNodeId: existing.id },
                    { type: "run_generation", nodeId: existing.id, mode: "video", prompt },
                ],
            };
        }
        let id = `sbv-${ctx.node.id}-${shot.id}`;
        if (ctx.getNode(id)) id = `${id}-${Date.now()}`;
        // 放在该镜关键帧节点右侧并错开,避免与关键帧行重叠
        return {
            ops: [
                { type: "add_node", id, nodeType: "video", title: `镜 ${shot.index} 视频`, x: image.position.x + image.width + 96, y: image.position.y + 48, metadata: { status: "idle", ...metadata } },
                { type: "connect_nodes", fromNodeId: image.id, toNodeId: id },
                { type: "run_generation", nodeId: id, mode: "video", prompt },
            ],
            createdId: id,
        };
    };
    const makeVideo = (shot: Shot) => {
        const result = videoOpsForShot(shot);
        if (!result) {
            setError(`镜头 ${shot.index} 还没有关键帧,先试拍出关键帧`);
            return;
        }
        setError(null);
        ctx.applyOps(result.ops);
        if (result.createdId) commitNow({ ...board, shots: board.shots.map((s) => (s.id === shot.id ? { ...s, videoNodeId: result.createdId } : s)) });
        setNotice(`镜头 ${shot.index} 已${linkedVideoNode(shot) ? "重新" : ""}提交生视频`);
    };
    const batchMakeVideo = () => {
        const ops: Parameters<CanvasNodeContext["applyOps"]>[0] = [];
        const links: Record<string, string> = {};
        let skipped = 0;
        board.shots.forEach((shot) => {
            if (!shot.approved) {
                skipped++;
                return;
            }
            const result = videoOpsForShot(shot);
            if (!result) {
                skipped++;
                return;
            }
            ops.push(...result.ops);
            if (result.createdId) links[shot.id] = result.createdId;
        });
        if (ops.length) ctx.applyOps(ops);
        if (Object.keys(links).length) commitNow({ ...board, shots: board.shots.map((s) => (links[s.id] ? { ...s, videoNodeId: links[s.id] } : s)) });
        const created = ops.length / 3;
        const parts = [`已提交 ${created} 个镜头的视频生成`];
        if (skipped) parts.push(`已跳过 ${skipped} 镜(未通过审核或无关键帧)`);
        setNotice(parts.join("，"));
        setError(null);
    };

    // ---- 单镜重写 ----
    const [rewriteId, setRewriteId] = useState<string | null>(null);
    const [rewriteText, setRewriteText] = useState("");
    const [rewriting, setRewriting] = useState(false);
    const doRewrite = async (shot: Shot) => {
        if (!rewriteText.trim() || rewriting) return;
        setRewriting(true);
        setError(null);
        try {
            const prompt = REWRITE_PROMPT.replace("{{指令}}", rewriteText.trim())
                .replace("{{镜头}}", JSON.stringify(shot))
                .replace("{{镜号}}", board.shots.map((s) => s.id).join(", "));
            const { text } = await ctx.ai.generateText(prompt, { model: settings.textModel || undefined });
            const parsed = readStoryboard({ shots: [JSON.parse(stripCodeFence(text))] }).shots[0];
            if (!parsed) throw new Error("返回内容不是有效的镜头 JSON");
            scheduleCommit({ ...board, shots: board.shots.map((s) => (s.id === shot.id ? { ...parsed, id: shot.id, index: shot.index, imageNodeId: shot.imageNodeId, videoNodeId: shot.videoNodeId, approved: shot.approved } : s)) });
            setRewriteId(null);
            setRewriteText("");
            setNotice(`镜头 ${shot.index} 已重写`);
        } catch (e) {
            setError(`重写失败：${errorText(e)}`);
        }
        setRewriting(false);
    };

    // ---- 样式 ----
    const field: CSSProperties = { width: "100%", background: "transparent", border: `1px solid ${theme.node.stroke}`, borderRadius: 8, padding: "6px 8px", color: theme.node.text, fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };
    const label: CSSProperties = { display: "block", fontSize: 11, color: theme.node.muted, marginBottom: 3 };
    const textModels = safeListModels(ctx, "text");
    const imageModels = safeListModels(ctx, "image");
    const videoModels = safeListModels(ctx, "video");
    const approvedCount = board.shots.filter((s) => s.approved).length;

    return (
        <div data-canvas-no-zoom onMouseDown={stop} onWheel={stop} onDoubleClick={stop} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 16, background: theme.node.panel, border: `1px solid ${theme.node.stroke}`, color: theme.node.text, fontSize: 12, maxHeight: 640, boxSizing: "border-box" }}>
            {/* 标题行 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>🎬</span>
                <input value={board.title || ""} placeholder="分镜标题(可选)" onChange={(e) => scheduleCommit({ ...board, title: e.target.value })} style={{ ...field, flex: 1, border: "none", fontSize: 13, fontWeight: 600, padding: "2px 0" }} />
                <button type="button" className="sb-btn" title="关闭工作台" onClick={onClose} style={{ color: theme.node.muted }}>
                    ✕
                </button>
            </div>

            {/* 设置条 */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                <label style={{ minWidth: 140, flex: 1 }}>
                    <span style={label}>文本模型</span>
                    <select value={settings.textModel} onChange={(e) => updateSettings({ textModel: e.target.value })} style={field}>
                        {!settings.textModel ? <option value="">默认</option> : null}
                        {textModels.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                        {settings.textModel && !textModels.some((m) => m.value === settings.textModel) ? <option value={settings.textModel}>{settings.textModel}</option> : null}
                    </select>
                </label>
                <label style={{ minWidth: 140, flex: 1 }}>
                    <span style={label}>图像模型</span>
                    <select value={settings.imageModel} onChange={(e) => updateSettings({ imageModel: e.target.value })} style={field}>
                        {!settings.imageModel ? <option value="">默认</option> : null}
                        {imageModels.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                        {settings.imageModel && !imageModels.some((m) => m.value === settings.imageModel) ? <option value={settings.imageModel}>{settings.imageModel}</option> : null}
                    </select>
                </label>
                <label style={{ minWidth: 140, flex: 1 }}>
                    <span style={label}>视频模型</span>
                    <select value={settings.videoModel} onChange={(e) => updateSettings({ videoModel: e.target.value })} style={field}>
                        {!settings.videoModel ? <option value="">默认</option> : null}
                        {videoModels.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.label}
                            </option>
                        ))}
                        {settings.videoModel && !videoModels.some((m) => m.value === settings.videoModel) ? <option value={settings.videoModel}>{settings.videoModel}</option> : null}
                    </select>
                </label>
                <label style={{ width: 72 }}>
                    <span style={label}>每镜张数</span>
                    <input type="number" min={1} max={4} value={settings.count} onChange={(e) => updateSettings({ count: Math.min(4, Math.max(1, Math.round(Number(e.target.value) || 1))) })} style={field} />
                </label>
                <label style={{ width: 116 }}>
                    <span style={label}>尺寸</span>
                    <select value={settings.size} onChange={(e) => updateSettings({ size: e.target.value })} style={field}>
                        {SIZE_OPTIONS.map((s) => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {/* 原文导入：拖入或点选多个文本文件，按文件名排序拼接；优先级高于上游连接节点 */}
            <div
                onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(true);
                }}
                onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(false);
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(false);
                    void importFiles(Array.from(e.dataTransfer.files));
                }}
                onClick={() => fileInputRef.current?.click()}
                style={{ border: `1px dashed ${dragOver ? theme.node.text : theme.node.stroke}`, borderRadius: 10, padding: "8px 10px", cursor: "pointer", color: theme.node.muted, display: "flex", flexDirection: "column", gap: 4 }}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.markdown,.srt,.ass,.csv,.json,.text,text/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                        void importFiles(Array.from(e.target.files || []));
                        e.target.value = "";
                    }}
                />
                {importing ? (
                    <span>读取文件中…</span>
                ) : board.sourceFiles?.length ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ color: theme.node.text }}>📄 {board.sourceFiles.length} 个文件：{board.sourceFiles.join("、")}</span>
                        <button
                            type="button"
                            className="sb-btn"
                            style={{ color: theme.node.muted, padding: "0 4px" }}
                            onClick={(e) => {
                                e.stopPropagation();
                                clearSourceFiles();
                            }}
                        >
                            ✕ 清除
                        </button>
                    </span>
                ) : (
                    <span>拖入剧本/小说文件（txt/md/srt 等，可多个，按文件名排序），或点击选择；不导入则使用上游连接节点</span>
                )}
            </div>

            {/* 动作条 */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                <button type="button" className="sb-btn" disabled={generating} onClick={() => void generateStoryboard()}>
                    {generating ? `生成中… ${progress} 字` : "✨ 生成分镜"}
                </button>
                <button type="button" className="sb-btn" disabled={!board.shots.length} onClick={runCheck}>
                    🩺 体检
                </button>
                <button type="button" className="sb-btn" disabled={!board.shots.length} onClick={batchGenerate}>
                    🖼 批量出关键帧
                </button>
                <button type="button" className="sb-btn" disabled={!approvedCount} onClick={batchMakeVideo} title="只为已通过审核且有关键帧的镜头生视频">
                    🎞 批量出视频
                </button>
                <span style={{ marginLeft: "auto", color: theme.node.muted }}>
                    共 {board.shots.length} 镜 · 已通过 {approvedCount}{issueCount ? ` · ${issueCount} 镜有问题` : ""}
                </span>
            </div>

            {/* 提示 / 错误 / 原始输出 */}
            {notice ? <div style={{ color: theme.node.muted }}>{notice}</div> : null}
            {error ? (
                <div style={{ color: ERROR_COLOR, display: "flex", flexDirection: "column", gap: 6 }}>
                    <span>{error}</span>
                    {rawOutput !== null ? (
                        <>
                            <textarea readOnly value={rawOutput} onWheel={stop} style={{ ...field, minHeight: 96, resize: "vertical", color: theme.node.muted }} />
                            <div>
                                <button type="button" className="sb-btn" disabled={generating} onClick={() => void generateStoryboard()}>
                                    🔁 重试
                                </button>
                            </div>
                        </>
                    ) : null}
                </div>
            ) : null}

            {/* 镜头卡片列表 */}
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
                {board.shots.length ? (
                    board.shots.map((shot, i) => (
                        <ShotCard
                            key={shot.id}
                            shot={shot}
                            first={i === 0}
                            last={i === board.shots.length - 1}
                            issues={issueMap[shot.id] || []}
                            linked={Boolean(linkedImageNode(shot))}
                            hasKeyframe={Boolean(linkedImageNode(shot)?.metadata?.content)}
                            rewriting={rewriting}
                            rewriteOpen={rewriteId === shot.id}
                            rewriteText={rewriteText}
                            field={field}
                            label={label}
                            mutedColor={theme.node.muted}
                            strokeColor={theme.node.stroke}
                            activeBg={theme.toolbar.activeBg}
                            activeText={theme.toolbar.activeText}
                            onPatch={(patch) => updateShot(shot.id, patch)}
                            onMove={(dir) => moveShot(shot.id, dir)}
                            onInsert={() => insertShot(shot.id)}
                            onRemove={() => removeShot(shot.id)}
                            onTest={() => testShot(shot)}
                            onMakeVideo={() => makeVideo(shot)}
                            onToggleRewrite={() => {
                                setRewriteId(rewriteId === shot.id ? null : shot.id);
                                setRewriteText("");
                            }}
                            onRewriteText={setRewriteText}
                            onRewrite={() => void doRewrite(shot)}
                        />
                    ))
                ) : (
                    <div style={{ color: theme.node.placeholder, textAlign: "center", padding: "24px 0" }}>还没有镜头。拖入剧本/小说文件或连接上游文本节点后点「生成分镜」,或点卡片上的 ＋ 手动添加。</div>
                )}
                <div>
                    <button type="button" className="sb-btn" onClick={() => mutateShots((shots) => [...shots, { ...emptyShot(), id: "", index: 0 } as Shot])}>
                        ＋ 添加镜头
                    </button>
                </div>
            </div>
        </div>
    );
}

type ShotCardProps = {
    shot: Shot;
    first: boolean;
    last: boolean;
    issues: ShotIssue[];
    linked: boolean;
    hasKeyframe: boolean;
    rewriting: boolean;
    rewriteOpen: boolean;
    rewriteText: string;
    field: CSSProperties;
    label: CSSProperties;
    mutedColor: string;
    strokeColor: string;
    activeBg: string;
    activeText: string;
    onPatch: (patch: Partial<Shot>) => void;
    onMove: (dir: -1 | 1) => void;
    onInsert: () => void;
    onRemove: () => void;
    onTest: () => void;
    onMakeVideo: () => void;
    onToggleRewrite: () => void;
    onRewriteText: (text: string) => void;
    onRewrite: () => void;
};

function ShotCard(props: ShotCardProps) {
    const { shot, issues, field, label } = props;
    const [showNegative, setShowNegative] = useState(false);
    const hasError = issues.some((issue) => issue.level === "error");
    const borderColor = issues.length ? (hasError ? ERROR_COLOR : WARN_COLOR) : props.strokeColor;

    return (
        <div style={{ border: `1px solid ${props.strokeColor}`, borderLeft: `3px solid ${borderColor}`, borderRadius: 12, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {/* 卡片头:镜号 + 时长 + 景别 + 操作 */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>#{shot.index}</strong>
                <label style={{ display: "flex", alignItems: "center", gap: 4, color: props.mutedColor }}>
                    时长
                    <input type="number" min={1} max={8} value={shot.durationSec} onChange={(e) => props.onPatch({ durationSec: Math.min(8, Math.max(1, Math.round(Number(e.target.value) || 1))) })} style={{ ...field, width: 56, padding: "3px 6px" }} />
                    秒
                </label>
                <select value={shot.shotSize} onChange={(e) => props.onPatch({ shotSize: e.target.value })} style={{ ...field, width: 84, padding: "3px 6px" }}>
                    {SHOT_SIZES.map((s) => (
                        <option key={s} value={s}>
                            {s}
                        </option>
                    ))}
                    {!SHOT_SIZES.includes(shot.shotSize) ? <option value={shot.shotSize}>{shot.shotSize}</option> : null}
                </select>
                <span style={{ marginLeft: "auto", display: "flex", gap: 2, alignItems: "center" }}>
                    <button
                        type="button"
                        className="sb-btn"
                        title={shot.approved ? "已通过审核,点击改回待审" : "标记该镜通过审核"}
                        onClick={() => props.onPatch({ approved: !shot.approved })}
                        style={shot.approved ? { background: props.activeBg, color: props.activeText } : { color: props.mutedColor }}
                    >
                        {shot.approved ? "✓ 通过" : "○ 待审"}
                    </button>
                    <button type="button" className="sb-btn" title="上移" disabled={props.first} onClick={() => props.onMove(-1)}>
                        ↑
                    </button>
                    <button type="button" className="sb-btn" title="下移" disabled={props.last} onClick={() => props.onMove(1)}>
                        ↓
                    </button>
                    <button type="button" className="sb-btn" title="在下方插入新镜" onClick={props.onInsert}>
                        ＋
                    </button>
                    <button type="button" className="sb-btn" title="单镜重写" onClick={props.onToggleRewrite}>
                        ✎
                    </button>
                    <button type="button" className="sb-btn" title={props.linked ? "重新试拍" : "试拍"} onClick={props.onTest}>
                        {props.linked ? "🔄" : "🎥"}
                    </button>
                    <button type="button" className="sb-btn" title={props.hasKeyframe ? "生视频" : "先试拍出关键帧"} disabled={!props.hasKeyframe} onClick={props.onMakeVideo}>
                        🎞
                    </button>
                    <button type="button" className="sb-btn" title="删除该镜" onClick={props.onRemove}>
                        🗑
                    </button>
                </span>
            </div>

            {/* 体检问题 */}
            {issues.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {issues.map((issue, i) => (
                        <span key={i} style={{ color: issue.level === "error" ? ERROR_COLOR : WARN_COLOR }}>
                            {issue.level === "error" ? "⛔" : "⚠️"} {issue.text}
                        </span>
                    ))}
                </div>
            ) : null}

            {/* 单镜重写输入 */}
            {props.rewriteOpen ? (
                <div style={{ display: "flex", gap: 6 }}>
                    <input autoFocus value={props.rewriteText} placeholder="修改指令,如「改成特写」「节奏加快」" onChange={(e) => props.onRewriteText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && props.onRewrite()} style={{ ...field, flex: 1 }} />
                    <button type="button" className="sb-btn" disabled={props.rewriting || !props.rewriteText.trim()} onClick={props.onRewrite}>
                        {props.rewriting ? "重写中…" : "重写"}
                    </button>
                    <button type="button" className="sb-btn" onClick={props.onToggleRewrite}>
                        取消
                    </button>
                </div>
            ) : null}

            {/* 字段 */}
            <label>
                <span style={label}>运镜</span>
                <input value={shot.camera} placeholder="固定机位，平视，人物居中偏左" onChange={(e) => props.onPatch({ camera: e.target.value })} style={field} />
            </label>
            <label>
                <span style={label}>动作 / 表情</span>
                <textarea value={shot.action} rows={2} onChange={(e) => props.onPatch({ action: e.target.value })} style={{ ...field, resize: "vertical" }} />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
                <label style={{ flex: 1 }}>
                    <span style={label}>台词</span>
                    <input value={shot.dialogue} onChange={(e) => props.onPatch({ dialogue: e.target.value })} style={field} />
                </label>
                <label style={{ flex: 1 }}>
                    <span style={label}>声音</span>
                    <input value={shot.audio} placeholder="环境音 / 配乐" onChange={(e) => props.onPatch({ audio: e.target.value })} style={field} />
                </label>
            </div>
            <label>
                <span style={label}>生图 prompt(英文)</span>
                <textarea value={shot.prompt} rows={3} onChange={(e) => props.onPatch({ prompt: e.target.value })} style={{ ...field, resize: "vertical", fontFamily: "monospace" }} />
            </label>
            <div>
                <button type="button" className="sb-btn" style={{ color: props.mutedColor, padding: "2px 6px" }} onClick={() => setShowNegative((v) => !v)}>
                    {showNegative ? "▾" : "▸"} negativePrompt
                </button>
                {showNegative ? <textarea value={shot.negativePrompt || ""} rows={2} onChange={(e) => props.onPatch({ negativePrompt: e.target.value })} style={{ ...field, resize: "vertical", fontFamily: "monospace" }} /> : null}
            </div>

            <div style={{ color: props.mutedColor }}>
                {props.linked ? "已关联关键帧节点，点 🔄 重新试拍" : "点 🎥 试拍该镜关键帧"}
                {props.hasKeyframe ? "；点 🎞 用关键帧生视频" : ""}
            </div>
        </div>
    );
}

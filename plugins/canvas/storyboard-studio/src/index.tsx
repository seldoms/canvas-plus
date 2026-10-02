// 分镜工作台节点:Content 只显示摘要与「打开工作台」入口,主工作区在 Panel。
import { definePlugin } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";

import css from "./styles.css";
import { StoryboardPanel } from "./panel";
import { readStoryboard } from "./storyboard";

function BoardContent({ ctx }: CanvasNodeContentProps) {
    const board = readStoryboard(ctx.node.metadata?.storyboard);
    const total = board.shots.length;
    const shot = board.shots.filter((s) => s.imageNodeId).length;
    const approved = board.shots.filter((s) => s.approved).length;
    const theme = ctx.theme;

    return (
        <div data-canvas-no-zoom onMouseDown={(e) => e.stopPropagation()} style={{ height: "100%", width: "100%", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", gap: 6, color: theme.node.text, fontSize: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🎬 {board.title || "分镜工作台"}</div>
            <div style={{ color: theme.node.muted, flex: 1 }}>
                {total ? `共 ${total} 镜 · 待生成 ${total - shot} · 已试拍 ${shot} · 已通过 ${approved}` : "拖入剧本/小说文件或连接文本节点,生成你的分镜表"}
                {board.sourceFiles?.length ? <div>📄 原文:{board.sourceFiles.length} 个文件</div> : null}
            </div>
            <div>
                <button type="button" className="sb-btn" onClick={() => ctx.openPanel()}>
                    打开工作台 →
                </button>
            </div>
        </div>
    );
}

export default definePlugin({
    id: "storyboard-studio",
    name: "分镜工作台",
    version: "1.0.0",
    description: "从剧本/小说生成分镜表:逐镜编辑、体检、试拍关键帧、人工审核与参考生视频",
    css,
    nodes: [
        {
            type: "storyboard-studio:board",
            title: "分镜工作台",
            icon: "🎬",
            description: "剧本拆分镜、逐镜编辑、体检、关键帧试拍与视频生成",
            defaultSize: { width: 320, height: 120 },
            defaultMetadata: { storyboard: { shots: [] } },
            minimapColor: "#f59e0b",
            // 不提供 resource:避免作为上游时把文本混入下游图片节点的生图 prompt
            autoOpenPanel: true,
            hidePanel: false,
            Content: BoardContent,
            Panel: StoryboardPanel,
        },
    ],
});

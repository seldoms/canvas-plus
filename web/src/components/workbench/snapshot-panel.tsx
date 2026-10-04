import { useSyncExternalStore } from "react";
import { Tag } from "antd";

import { previewUrlFor, subscribeImagePreviews, getImagePreviewRevision } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

import { ImageThumb } from "./media";
import type { WorkbenchSnapshotTag } from "./types";

/**
 * 本次提交的参数快照（历史事实）：模型 / 规格 / 数量 / seed … + 提示词 + 参考图。
 *
 * ⚠️ **快照 ≠ 当前表单**：这里渲染的一切都来自提交那一刻冻结的数据，
 * 与页面上的「当前表单」完全隔离 —— 这是「无脑连发」的前提（看记录不会污染输入）。
 */
export function SnapshotPanel({ prompt, tags, references }: { prompt: string; tags: WorkbenchSnapshotTag[]; references: ReferenceImage[] }) {
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
            {tags.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                    {tags.map((tag, index) => (
                        <Tag key={tag.key || `${tag.label}-${index}`} className="m-0" color={tag.color}>
                            {tag.label}
                        </Tag>
                    ))}
                </div>
            ) : null}
            <div className="whitespace-pre-wrap break-words text-sm text-stone-700 dark:text-stone-300">{prompt}</div>
            {references.length ? (
                <div className="hover-scrollbar flex gap-2 overflow-x-auto">
                    {references.map((item) => (
                        <ImageThumb key={item.id} src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-14 shrink-0 rounded-md border border-stone-200 object-cover dark:border-stone-800" />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

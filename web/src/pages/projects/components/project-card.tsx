import { Archive, ArrowRight } from "lucide-react";
import { Button, Progress } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { ProjectSummary } from "@/services/api/projects";

/** 项目卡片：标题、完成度、更新时间，以及「打开 / 归档」两个动作。视觉沿用画布项目卡片。 */
export function ProjectCard({ project, onArchive }: { project: ProjectSummary; onArchive: (project: ProjectSummary) => void }) {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const { episodes, episodesDone, checklistTotal, checklistDone } = project.completion;
    const percent = checklistTotal ? Math.round((checklistDone / checklistTotal) * 100) : 0;
    const open = () => navigate(`/projects/${project.id}`);

    return (
        <article className="group flex min-h-44 flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10">
            <button type="button" className="min-w-0 cursor-pointer text-left" onClick={open}>
                <h2 className="truncate text-xl font-semibold">{project.title}</h2>
                <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">{t("projects.card.episodes", { done: episodesDone, total: episodes })}</p>
                <div className="mt-3">
                    <Progress percent={percent} size="small" showInfo={false} />
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        {t("projects.card.checklist", { done: checklistDone, total: checklistTotal })}
                    </p>
                </div>
            </button>

            <div className="mt-6 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">
                    {t("projects.card.updated", {
                        date: new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
                    })}
                </p>
                <div className="flex items-center gap-1">
                    <Button size="small" icon={<ArrowRight className="size-3.5" />} onClick={open}>
                        {t("projects.open")}
                    </Button>
                    <Button size="small" danger icon={<Archive className="size-3.5" />} onClick={() => onArchive(project)}>
                        {t("projects.archive")}
                    </Button>
                </div>
            </div>
        </article>
    );
}

import { Clapperboard, FileText, FolderKanban, ImagePlus, Images, ListChecks, Maximize2, Settings2, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "projects",
        icon: FolderKanban,
    },
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "pipeline",
        icon: Clapperboard,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "tasks",
        icon: ListChecks,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

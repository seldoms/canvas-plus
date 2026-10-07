import { Clapperboard, FileText, FolderKanban, ImagePlus, Images, ListChecks, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "projects",
        icon: FolderKanban,
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
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

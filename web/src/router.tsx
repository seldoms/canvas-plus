import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PipelinePage from "@/pages/pipeline";
import ProjectsPage from "@/pages/projects";
import ProjectOverviewPage from "@/pages/projects/project";
import ProjectAssetsWorkspacePage from "@/pages/projects/assets";
import ProjectCanvasWorkspacePage from "@/pages/projects/canvas";
import ProjectKeyframesWorkspacePage from "@/pages/projects/keyframes";
import ProjectPlanWorkspacePage from "@/pages/projects/plan";
import ProjectStoryboardWorkspacePage from "@/pages/projects/storyboard";
import ProjectVideoWorkspacePage from "@/pages/projects/video";
import PromptsPage from "@/pages/prompts";
import TasksPage from "@/pages/tasks";
import VideoPage from "@/pages/video";

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/projects", element: <ProjectsPage /> },
            { path: "/projects/:projectId", element: <ProjectOverviewPage /> },
            { path: "/projects/:projectId/plan", element: <ProjectPlanWorkspacePage /> },
            { path: "/projects/:projectId/storyboard", element: <ProjectStoryboardWorkspacePage /> },
            { path: "/projects/:projectId/assets", element: <ProjectAssetsWorkspacePage /> },
            { path: "/projects/:projectId/keyframes", element: <ProjectKeyframesWorkspacePage /> },
            { path: "/projects/:projectId/video", element: <ProjectVideoWorkspacePage /> },
            { path: "/projects/:projectId/canvas", element: <ProjectCanvasWorkspacePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/tasks", element: <TasksPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/pipeline", element: <PipelinePage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);

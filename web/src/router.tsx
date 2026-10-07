import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import NotFound from "@/pages/not-found";

/**
 * 路由级代码分割：每个页面独立 chunk，首屏只加载「布局 + 当前路由」的代码。
 *
 * 之前 15 个页面 + 编辑器/导出/画布等重依赖全被静态 import 进同一个入口 bundle
 * （dist 实测单文件 4.1MB），首屏必须等整包下载完才渲染 —— 弱网下就是「转半天」。
 * 改成 React.lazy 后，Vite 在动态 import 边界自动切分，首屏只付「当前页」的字节。
 *
 * 关键路径刻意保持静态 import（不引入额外 waterfall）：
 *   - UserLayout（顶栏）、AnalyticsTracker —— 首帧就要用；
 *   - React / react-dom / antd / i18n / app-providers —— 在 main.tsx 侧，仍在入口 chunk。
 */
const HomePage = lazy(() => import("@/pages/home"));
const ProjectsPage = lazy(() => import("@/pages/projects"));
const ProjectOverviewPage = lazy(() => import("@/pages/projects/project"));
const ProjectPlanWorkspacePage = lazy(() => import("@/pages/projects/plan"));
const ProjectStoryboardWorkspacePage = lazy(() => import("@/pages/projects/storyboard"));
const ProjectAssetsWorkspacePage = lazy(() => import("@/pages/projects/assets"));
const ProjectCastingWorkspacePage = lazy(() => import("@/pages/projects/casting"));
const ProjectKeyframesWorkspacePage = lazy(() => import("@/pages/projects/keyframes"));
const ProjectVideoWorkspacePage = lazy(() => import("@/pages/projects/video"));
const ProjectCanvasWorkspacePage = lazy(() => import("@/pages/projects/canvas"));
const ImagePage = lazy(() => import("@/pages/image"));
const VideoPage = lazy(() => import("@/pages/video"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const PipelinePage = lazy(() => import("@/pages/pipeline"));
const PipelineDemoPage = lazy(() => import("@/pages/pipeline-demo"));
const ConfigPage = lazy(() => import("@/pages/config"));

/** 路由切换/懒加载期间的占位：纯 CSS 转圈，不依赖任何库，避免 fallback 自己再触发加载。 */
function RouteFallback() {
    return (
        <div className="flex h-full w-full items-center justify-center" role="status" aria-label="loading">
            <span className="size-6 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600 dark:border-stone-700 dark:border-t-stone-300" />
        </div>
    );
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Suspense fallback={<RouteFallback />}>
                    <Outlet />
                </Suspense>
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/projects", element: <ProjectsPage /> },
            { path: "/projects/:projectId", element: <ProjectOverviewPage /> },
            { path: "/projects/:projectId/plan", element: <ProjectPlanWorkspacePage /> },
            { path: "/projects/:projectId/storyboard", element: <ProjectStoryboardWorkspacePage /> },
            { path: "/projects/:projectId/assets", element: <ProjectAssetsWorkspacePage /> },
            { path: "/projects/:projectId/casting", element: <ProjectCastingWorkspacePage /> },
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
            { path: "/pipeline-demo", element: <PipelineDemoPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);

# 分镜工作台(storyboard-studio)

画布节点插件:把上游文本节点里的剧本/小说,用 LLM 拆成逐镜头分镜表,在节点下方面板里逐镜编辑、本地体检、单镜重写,并一键试拍/批量生成关键帧图片节点。

- 节点类型:`storyboard-studio:board`,单击节点自动打开工作台面板。
- 分镜数据存节点 `metadata.storyboard`;文本/图像模型、每镜张数、尺寸存插件私有 `storage`。
- 试拍/关键帧会在分镜节点右侧按网格创建图片节点并连线,复用宿主生成队列。

## 开发

```bash
npm install
npm run dev        # watch,产物同步到 web/public/plugins/storyboard-studio.js
npm run typecheck
```

在 `web/.env.local` 加 `VITE_DEV_PLUGINS=/plugins/storyboard-studio.js` 后刷新画布即可自动激活。

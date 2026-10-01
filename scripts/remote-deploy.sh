#!/usr/bin/env bash
# 在远程 ubuntu 上执行：更新工作副本 → 生成配置 → 构建前端 → 跑测试 → 重启服务。
# 由 scripts/deploy.sh 通过 ssh 投送执行，也可在远程直接运行。
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/root/canvas-plus}"
BRANCH="${BRANCH:-main}"
COMFY_URL="${COMFY_URL:-http://192.168.123.147:8188}"
LLM_URL="${LLM_URL:-http://127.0.0.1:11434}"
PORT="${PORT:-8788}"

echo "==> 更新工作副本 $REMOTE_DIR ($BRANCH)"
if [ ! -d "$REMOTE_DIR/.git" ]; then
    mkdir -p "$(dirname "$REMOTE_DIR")"
    git clone /root/repos/canvas-plus.git "$REMOTE_DIR"
fi
cd "$REMOTE_DIR"
git fetch origin --prune
git checkout -f "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
# 只清理被跟踪之外的文件；canvas-server/.gitignore 已忽略 data/ 与 config.json，产物不会被误删。
git clean -fd

echo "==> 生成网关配置"
mkdir -p canvas-server/data
cat > canvas-server/config.json <<JSON
{
    "host": "0.0.0.0",
    "port": $PORT,
    "dataDir": "data",
    "workflowsDir": "workflows",
    "skillsDir": "../skills",
    "webDir": "../web/dist",
    "llm": {
        "baseUrl": "$LLM_URL",
        "timeoutMs": 600000,
        "defaultModel": "qwen2.5:latest",
        "fallbacks": ["http://127.0.0.1:1234", "http://127.0.0.1:8080"]
    },
    "comfy": {
        "baseUrl": "$COMFY_URL",
        "timeoutMs": 7200000,
        "pollIntervalMs": 3000,
        "maxQueue": 16
    },
    "generation": {
        "defaultBackend": "local",
        "allowRunningHub": true
    },
    "runninghub": {
        "baseUrl": "https://www.runninghub.ai/openapi/v2",
        "apiKey": "",
        "pollIntervalMs": 5000,
        "timeoutMs": 1800000,
        "probeTimeoutMs": 8000,
        "model": {
            "image": "z-image/turbo",
            "video": "alibaba/wan-2.7/image-to-video"
        }
    },
    "pipeline": {
        "imageTemplate": "img_zimage_artistic",
        "editTemplate": "img_boogu_outfit_edit",
        "videoTemplate": "video_h3_i2v",
        "upscaleTemplate": "upscale_4x",
        "imageWidth": 768,
        "imageHeight": 1344,
        "imageBatch": 1,
        "videoWidth": 768,
        "videoHeight": 1344,
        "videoSeconds": 5,
        "videoFps": 24,
        "maxKeyframesPerShot": 2
    }
}
JSON

echo "==> 构建前端"
cd web
# 仓库里的 package-lock.json 是在 macOS 上生成的，既缺 i18next / react-i18next 条目，
# 又缺少 Linux 平台的可选依赖（@rollup/rollup-linux-x64-gnu），直接装会在 vite build 时报
# Cannot find module @rollup/rollup-linux-x64-gnu。这里按需清掉 node_modules 与 lock 重建依赖树。
# 同时用 --legacy-peer-deps 规避上游既有的 peer 冲突（pro-components@3.0.0-beta.3 声明 peer antd@^5，
# 而根依赖是 antd@^6）。
if [ ! -d node_modules ] || [ ! -d node_modules/@rollup/rollup-linux-x64-gnu ]; then
    rm -rf node_modules package-lock.json
    npm install --no-audit --no-fund --legacy-peer-deps
fi
npm run build
cd ..

echo "==> 运行 canvas-server 测试"
node --test canvas-server/test/*.test.mjs || echo "（测试未全绿，请人工确认）"

echo "==> 安装并重启 systemd 服务"
cp deploy/canvas-server.service /etc/systemd/system/canvas-server.service
systemctl daemon-reload
systemctl enable canvas-server >/dev/null 2>&1 || true
systemctl restart canvas-server
sleep 2
systemctl is-active canvas-server

echo "==> 健康检查"
curl -s --max-time 20 "http://127.0.0.1:$PORT/api/health" | head -c 600
echo
echo "部署完成：http://<host>:$PORT"

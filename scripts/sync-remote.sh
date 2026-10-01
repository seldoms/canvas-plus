#!/usr/bin/env bash
# 把本地工作区直接同步到远程 /sobey/canvas-plus，用于在远程直接部署和调试。
#
# 用法：
#   ./scripts/sync-remote.sh              # 同步 + 构建前端 + 重启服务 + 健康检查
#   ./scripts/sync-remote.sh --no-build   # 只同步源码并重启网关（前端未变时用，快很多）
#   ./scripts/sync-remote.sh --no-restart # 只同步，不动服务
#
# 与 scripts/deploy.sh 的区别：deploy.sh 走 git 推送（要求工作区干净、要提交）；
# 本脚本走 rsync 直接同步工作区，适合边改边调。
set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE_HOST="${REMOTE_HOST:-ubuntu}"
REMOTE_DIR="${REMOTE_DIR:-/sobey/canvas-plus}"
DO_BUILD=1
DO_RESTART=1
for arg in "$@"; do
    case "$arg" in
        --no-build) DO_BUILD=0 ;;
        --no-restart) DO_RESTART=0 ;;
        *) echo "未知参数：$arg"; exit 1 ;;
    esac
done

echo "==> 同步工作区到 ${REMOTE_HOST}:${REMOTE_DIR}"
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
# 排除依赖、构建产物与运行时数据；config.json 由远程自己维护，不要被本地覆盖。
rsync -a --delete \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'data' \
    --exclude 'config.json' \
    --exclude '.DS_Store' \
    --exclude '*.log' \
    ./ "${REMOTE_HOST}:${REMOTE_DIR}/"

if [ "$DO_BUILD" = 1 ]; then
    echo "==> 远程构建前端"
    ssh "$REMOTE_HOST" "cd '$REMOTE_DIR/web' && npm run build" | tail -3
fi

if [ "$DO_RESTART" = 1 ]; then
    echo "==> 重启 canvas-server"
    ssh "$REMOTE_HOST" 'systemctl restart canvas-server && sleep 2 && systemctl is-active canvas-server'
    echo "==> 健康检查"
    ssh "$REMOTE_HOST" 'curl -s --max-time 20 http://127.0.0.1:8788/api/health | head -c 500'
    echo
fi

echo "==> 完成：http://${REMOTE_HOST}:8788"

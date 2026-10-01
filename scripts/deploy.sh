#!/usr/bin/env bash
# 把本地改动推送到远程裸仓库，并在远程 ubuntu 上完成部署。
#
# 用法：
#   ./scripts/deploy.sh                 # 推送当前分支到 canvas-plus，并远程部署
#   REMOTE_DIR=/root/canvas-plus ./scripts/deploy.sh
#
# 前置：本地已添加远程 canvas-plus（见 README 的「推送到远程环境」）。
set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE_HOST="${REMOTE_HOST:-ubuntu}"
BRANCH="${BRANCH:-main}"

echo "==> 本地检查"
if ! git remote get-url canvas-plus >/dev/null 2>&1; then
    echo "缺少远程 canvas-plus。请先执行："
    echo "  git remote add canvas-plus ssh://root@route.wbsyb.cloud:12550/root/repos/canvas-plus.git"
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "工作区有未提交改动，请先提交："
    git status --short
    exit 1
fi

echo "==> 本地测试"
if compgen -G "canvas-server/test/*.test.mjs" >/dev/null; then
    (cd canvas-server && node --test test/*.test.mjs)
else
    echo "（无测试文件，跳过）"
fi

echo "==> 推送 $BRANCH 到 canvas-plus"
git push canvas-plus "HEAD:refs/heads/$BRANCH"

echo "==> 远程部署（$REMOTE_HOST）"
ssh "$REMOTE_HOST" "REMOTE_DIR='${REMOTE_DIR:-/root/canvas-plus}' BRANCH='$BRANCH' bash -s" < scripts/remote-deploy.sh

echo "==> 完成"

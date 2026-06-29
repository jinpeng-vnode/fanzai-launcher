#!/bin/bash
# 饭仔 · 9Router 一键启动（macOS GUI 客户端）
# 用 open --env 传入启动包根目录，解决打包后 .app 内部无法向上定位 vendor/runtime 的问题

# 兜底标准 PATH —— 某些用户的 .zshrc 会覆盖 PATH 导致双击运行时找不到 dirname/open 等系统命令
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# 切到脚本所在目录（bash 内置，不依赖外部 dirname）
SELF="${BASH_SOURCE[0]}"
case "$SELF" in
    */*) cd "${SELF%/*}" || exit 1 ;;   # 含路径：切到其目录
    *)   : ;;                           # 无路径（同目录调用）：留在当前目录
esac
ROOT="$(pwd)"

# 1. 优先启动已构建的 GUI 客户端（.app）—— 用 bash glob，不依赖 ls/head
APP=""
for cand in runtime/electron-app/*/*.app runtime/electron-app/*.app; do
    if [ -d "$cand" ]; then APP="$cand"; break; fi
done

if [ -n "$APP" ] && [ -d "$APP" ]; then
    open --env FANZAI_LAUNCHER_ROOT="$ROOT" "$APP"
    exit 0
fi

# 2. 回退：dev 模式用 electron 直接跑源码
if [ -x "./client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
    cd client
    FANZAI_LAUNCHER_ROOT="$ROOT" ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . &
    exit 0
fi

# 3. 都没有：提示先构建
echo "[错误] 未找到 GUI 客户端，请先构建："
echo "       cd client && npm install && npm run pack"
echo "       （构建产物在 runtime/electron-app/ 下）"
exit 1

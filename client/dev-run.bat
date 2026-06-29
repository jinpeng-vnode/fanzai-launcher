@echo off
chcp 65001 >nul
title 饭仔客户端 - 开发启动
cd /d "%~dp0"

rem 清掉 VS Code 宿主注入的 ELECTRON_RUN_AS_NODE，否则 electron 退化成纯 node 起不来
set "ELECTRON_RUN_AS_NODE="

echo [*] 启动饭仔客户端（日志写入 runtime\client.log）...
".\node_modules\.bin\electron.cmd" .

echo.
echo [*] 客户端已退出。日志在 ..\runtime\client.log
pause

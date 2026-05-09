@echo off
title 灵犀AI - WPS 文字
cd /d "%~dp0"
echo 启动灵犀AI（WPS 文字）...
echo （按 Ctrl-C 退出，关闭窗口也会停止服务）
echo.
call npm run dev:wps
pause

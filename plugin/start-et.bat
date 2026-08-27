@echo off
title Anthony AI - WPS 表格
cd /d "%~dp0"
echo 启动Anthony AI（WPS 表格）...
echo （按 Ctrl-C 退出，关闭窗口也会停止服务）
echo.
call npm run dev:et
pause

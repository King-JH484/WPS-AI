@echo off
setlocal enabledelayedexpansion
title 灵犀AI 永久卸载（Windows）

echo ============================================
echo   灵犀AI 永久卸载
echo ============================================
echo.

set "TARGET=%USERPROFILE%\.lingxi-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1. 删计划任务
schtasks /Query /TN "LingxiAI" >nul 2>&1
if not errorlevel 1 (
  schtasks /Delete /TN "LingxiAI" /F >nul 2>&1
  echo [OK] 已删除计划任务 LingxiAI
)

REM 2. 杀掉运行中的 node 进程（serve-permanent.js / proxy-server.js）
echo [..] 停止后台服务进程...
for /f "tokens=2" %%P in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| findstr "PID:"') do (
  REM 简单粗暴地终止；如果你机器上还有别的 Node 进程，请改成精确查找
  taskkill /PID %%P /F >nul 2>&1
)
echo [OK] node 进程已尝试结束

REM 3. 删 publish.xml
if exist "%PUBLISH%" (
  del /F /Q "%PUBLISH%"
  echo [OK] 已删除 %PUBLISH%
)

REM 4. 删目标目录
if exist "%TARGET%" (
  rmdir /S /Q "%TARGET%"
  echo [OK] 已删除 %TARGET%
)

echo.
echo 卸载完成。重启 WPS 后插件不再加载。
pause
